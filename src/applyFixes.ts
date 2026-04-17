import * as vscode from "vscode";
import { extensionContext } from "./extension";
import { ensureCopilotSession } from "./session";
import { runCopilotInference } from "./pythonRunner";
import { extractFirstJsonObject, type ReviewFinding, type ReviewPayload } from "./reviewPanel";
import { getReviewPanelForDocument, notifyReviewUpdated, type ReviewTableState } from "./reviewBridge";
import { log, sanitizeForLog } from "./logger";
import { previewFixInEditorAndWait } from "./fixInEditorPreview";

export const LAST_REVIEW_STATE_KEY = "codeReview.lastReview";

export type StoredReview = ReviewTableState;

const FIX_SYSTEM_ROLE = `You apply a single code-review suggestion to an entire source file.
Respond with ONLY valid JSON (no markdown outside JSON) in this exact shape:
{"fileContent":"<the complete file contents after applying the change>"}
Rules:
- "fileContent" must be the full file text after the edit, not a diff and not a fragment.
- Preserve the file's style, imports, and formatting unless the suggestion requires changing them.
- Follow "Additional instructions from the developer" when present.
- Do not add commentary outside the JSON object.`;

function parseFixFileContent(raw: string): string {
  const jsonStr = extractFirstJsonObject(raw);
  const data = JSON.parse(jsonStr) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Fix response must be a JSON object.");
  }
  const o = data as Record<string, unknown>;
  const fc = o.fileContent;
  if (typeof fc !== "string") {
    throw new TypeError('Expected JSON with a string "fileContent" property.');
  }
  return fc;
}

function buildFixPrompt(
  fileName: string,
  fileContent: string,
  summary: string,
  finding: ReviewFinding,
  extraInstruction?: string
): string {
  const extra = extraInstruction?.trim()
    ? `\n\nAdditional instructions from the developer (must follow these while implementing this finding): ${extraInstruction.trim()}`
    : "";
  return `File name: ${fileName}

Current file:
\`\`\`
${fileContent}
\`\`\`

Review summary: ${summary}

Apply ONLY the following single finding next (do not address other issues unless required by the additional instructions):
- Title: ${finding.title}
- Severity: ${finding.severity} | Category: ${finding.category}
- Detail: ${finding.detail}
- Suggestion: ${finding.suggestion}
${extra}

Return JSON: {"fileContent": "..."} with the full updated file.`;
}

function appendAssistantFromSseLine(line: string, state: { text: string }): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) {
    return;
  }
  const jsonStr = trimmed.substring(6).trim();
  if (jsonStr === "[DONE]") {
    return;
  }
  try {
    const json = JSON.parse(jsonStr) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }>;
    };
    const piece =
      json.choices?.[0]?.delta?.content ||
      json.choices?.[0]?.message?.content ||
      json.choices?.[0]?.text;
    if (piece) {
      state.text += piece;
    }
  } catch {
    /* ignore */
  }
}

export async function saveLastReview(payload: StoredReview): Promise<void> {
  await extensionContext.workspaceState.update(LAST_REVIEW_STATE_KEY, payload);
}

export function getStoredReview(): StoredReview | undefined {
  return extensionContext.workspaceState.get<StoredReview>(LAST_REVIEW_STATE_KEY);
}

export function makeFindingKey(finding: ReviewFinding): string {
  const norm = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    norm(finding.title || ""),
    norm(finding.category || ""),
    norm(finding.severity || ""),
    norm(finding.suggestion || ""),
  ].join("|");
}

export function findAppliedIndicesByKeys(findings: ReviewFinding[], appliedKeys: string[]): number[] {
  if (!appliedKeys.length) {
    return [];
  }
  const keySet = new Set(appliedKeys);
  const matched: number[] = [];
  for (let i = 0; i < findings.length; i++) {
    if (keySet.has(makeFindingKey(findings[i]))) {
      matched.push(i);
    }
  }
  return matched;
}

const fixOperationQueues = new Map<string, Promise<void>>();

/**
 * Runs fix operations concurrently across different files, but serializes operations
 * for the same document to avoid edit races and conflicting writes.
 */
async function runWithDocumentFixQueue(documentUri: string, task: () => Promise<void>): Promise<void> {
  const previous = fixOperationQueues.get(documentUri) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous
    .catch(() => {
      /* previous failure should not block queue */
    })
    .then(() => gate);
  fixOperationQueues.set(documentUri, current);

  await previous.catch(() => {
    /* previous failure already handled */
  });
  try {
    await task();
  } finally {
    release();
    if (fixOperationQueues.get(documentUri) === current) {
      fixOperationQueues.delete(documentUri);
    }
  }
}

async function markFindingApplied(originalIndex: number): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const finding = s.findings[originalIndex];
  const findingKey = finding ? makeFindingKey(finding) : "";
  const applied = new Set(s.appliedIndices ?? []);
  applied.add(originalIndex);
  const appliedKeys = new Set(s.appliedFindingKeys ?? []);
  if (findingKey) {
    appliedKeys.add(findingKey);
  }
  const rejected = new Set(s.rejectedIndices ?? []);
  rejected.delete(originalIndex);
  const next: StoredReview = {
    ...s,
    appliedIndices: Array.from(applied).sort((a, b) => a - b),
    appliedFindingKeys: Array.from(appliedKeys).sort(),
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
  };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

async function markFindingRejected(originalIndex: number): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const rejected = new Set(s.rejectedIndices ?? []);
  rejected.add(originalIndex);
  const applied = new Set(s.appliedIndices ?? []);
  applied.delete(originalIndex);
  const next: StoredReview = {
    ...s,
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
    appliedIndices: Array.from(applied).sort((a, b) => a - b),
  };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

/** Clears rejected status when the user starts a new fix attempt for that finding. */
async function clearFindingRejectedForIndex(originalIndex: number): Promise<void> {
  const s = getStoredReview();
  if (!s?.rejectedIndices?.length) {
    return;
  }
  if (!s.rejectedIndices.includes(originalIndex)) {
    return;
  }
  const rejected = new Set(s.rejectedIndices);
  rejected.delete(originalIndex);
  const next: StoredReview = {
    ...s,
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
  };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

/**
 * Apply AI fixes from the last review: all findings in order, or one by index.
 * Each step opens a preview with streaming output, a diff, then Accept / Reject.
 */
export async function applyFixesFromReview(
  mode: "all" | "one" | "selected" = "all",
  index?: number,
  /** Pass "" from the webview to skip the optional input box; omit (undefined) to prompt. */
  extraUserInstruction?: string,
  selectedIndices?: number[]
): Promise<void> {
  log.info("applyFixes", "applyFixesFromReview started", { mode, index: index ?? "all" });
  if (!(await ensureCopilotSession())) {
    log.warn("applyFixes", "Aborted: no Copilot session");
    return;
  }

  const stored = getStoredReview();
  if (!stored || !stored.findings?.length) {
    log.warn("applyFixes", "No stored review findings");
    void vscode.window.showWarningMessage("Run Code Review on a file first, then use Apply fixes.");
    return;
  }

  const persistedAppliedByKey = findAppliedIndicesByKeys(stored.findings, stored.appliedFindingKeys ?? []);
  if (persistedAppliedByKey.length) {
    const mergedApplied = new Set([...(stored.appliedIndices ?? []), ...persistedAppliedByKey]);
    const nextStored: StoredReview = {
      ...stored,
      appliedIndices: Array.from(mergedApplied).sort((a, b) => a - b),
    };
    await saveLastReview(nextStored);
    notifyReviewUpdated(nextStored);
    stored.appliedIndices = nextStored.appliedIndices;
  }

  const uri = vscode.Uri.parse(stored.documentUri);
  let doc = await vscode.workspace.openTextDocument(uri);
  let targetIndices: number[];
  if (mode === "one") {
    if (typeof index !== "number" || index < 0 || index >= stored.findings.length) {
      void vscode.window.showWarningMessage("Invalid finding index for Apply fix.");
      return;
    }
    if (stored.appliedIndices?.includes(index)) {
      void vscode.window.showWarningMessage("This finding was already applied.");
      return;
    }
    targetIndices = [index];
  } else if (mode === "selected") {
    const normalized = Array.from(new Set((selectedIndices ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < stored.findings.length)));
    if (!normalized.length) {
      void vscode.window.showWarningMessage("Select one or more findings to apply.");
      return;
    }
    targetIndices = normalized.sort((a, b) => a - b);
  } else {
    const appliedSet = new Set(stored.appliedIndices ?? []);
    const rejectedSet = new Set(stored.rejectedIndices ?? []);
    targetIndices = stored.findings
      .map((_, i) => i)
      .filter((i) => !appliedSet.has(i) && !rejectedSet.has(i));
  }

  if (mode === "all" && targetIndices.length === 0) {
    void vscode.window.showInformationMessage(
      "No fixes to run — all findings are already applied or marked rejected. Use Retry on a rejected row to try again."
    );
    return;
  }

  let extra: string | undefined;
  if (extraUserInstruction === undefined) {
    const r = await vscode.window.showInputBox({
      title: "Apply fixes (optional)",
      prompt: "Extra instructions for the AI (optional). Leave empty to use only review suggestions.",
      ignoreFocusOut: true,
    });
    extra = r?.trim() || undefined;
  } else {
    extra = extraUserInstruction.trim() || undefined;
  }

  const panel = getReviewPanelForDocument(stored.documentUri);
  if (!panel) {
    log.warn("applyFixes", "Review panel not open for document");
    void vscode.window.showWarningMessage("Open the review tab for this file and run Apply fixes again.");
    return;
  }

  const total = targetIndices.length;
  let appliedCount = 0;
  let rejectedCount = 0;
  let failedCount = 0;

  const hasQueuedWork = fixOperationQueues.has(stored.documentUri);
  if (hasQueuedWork) {
    panel.addFixLog("Another fix run is in progress for this file. Your request is queued.", "warn");
  }

  const isBulkRun = mode !== "one";
  if (isBulkRun) {
    panel.setApplyingFixAll(true);
  }
  if (mode === "one" && typeof targetIndices[0] === "number") {
    panel.setApplyingFixIndex(targetIndices[0]);
  }

  await runWithDocumentFixQueue(stored.documentUri, async () => {
    try {
      if (extra) {
        panel.addFixLog("Applying fixes with your extra instructions.", "info");
      }
      for (let step = 0; step < targetIndices.length; step++) {
        const originalIndex = targetIndices[step];
        await clearFindingRejectedForIndex(originalIndex);
        const finding = stored.findings[originalIndex];
        panel.startFixStep(step + 1, total, finding.title);
        panel.addFixLog("Sending fix request to model.", "info");

        doc = await vscode.workspace.openTextDocument(uri);
        const baseText = doc.getText();
        const prompt = buildFixPrompt(stored.fileName, baseText, stored.summary, finding, extra);
        const state = { text: "" };

        panel.setApplyingFixIndex(originalIndex);
        try {
          log.debug("applyFixes", "Sending fix prompt", { step: step + 1, total, promptChars: prompt.length });
          await runCopilotInference(
            extensionContext,
            prompt,
            (line) => {
              log.proxyLine("applyFixes", line);
              appendAssistantFromSseLine(line, state);
            },
            { systemRole: FIX_SYSTEM_ROLE, stream: true }
          );
          log.info("applyFixes", "Fix inference finished", { step: step + 1, responseChars: state.text.length });
          panel.addFixLog("Model response received.", "success");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error("applyFixes", "Copilot request failed for fix step", { step: step + 1, error: sanitizeForLog(msg) });
          failedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} failed (request): ${msg}`, "error");
          panel.setApplyingFixIndex(null);
          if (!isBulkRun) {
            panel.showFixError(`Copilot request failed: ${msg}`);
            void vscode.window.showInformationMessage("Apply fixes stopped.");
            return;
          }
          continue;
        }

        let afterText: string;
        try {
          afterText = parseFixFileContent(state.text);
          panel.addFixLog("Parsed model JSON successfully.", "success");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Could not parse JSON.";
          log.error("applyFixes", "Could not parse fix JSON", { step: step + 1, error: sanitizeForLog(msg) });
          failedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} failed (parse): ${msg}`, "error");
          panel.setApplyingFixIndex(null);
          if (!isBulkRun) {
            panel.showFixError(`Could not parse AI response as fix JSON: ${msg}`);
            void vscode.window.showInformationMessage("Apply fixes stopped.");
            return;
          }
          continue;
        }

        const previewTitle = finding.title || `Fix (${step + 1}/${total})`;
        const choice = await previewFixInEditorAndWait(doc, baseText, afterText, previewTitle);
        if (choice === "reject") {
          panel.setApplyingFixIndex(null);
          await markFindingRejected(originalIndex);
          rejectedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} rejected. Continuing with next finding.`, "warn");
          if (!isBulkRun) {
            void vscode.window.showInformationMessage("Fix preview rejected. This finding is marked Rejected in Genie.");
            return;
          }
          continue;
        }

        panel.setApplyingFixIndex(null);
        await markFindingApplied(originalIndex);
        appliedCount += 1;
        doc = await vscode.workspace.openTextDocument(uri);
      }

      log.info("applyFixes", "Apply fixes completed", { appliedCount, total });
      if (isBulkRun) {
        void vscode.window.showInformationMessage(
          `Fix-all completed: applied ${appliedCount}/${total}, rejected ${rejectedCount}, failed ${failedCount}.`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Accepted and applied ${appliedCount} fix step(s). Save the file if needed (${stored.fileName}).`
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("applyFixes", "applyFixesFromReview failed", { error: sanitizeForLog(msg) });
      panel.showFixError(`Apply fixes failed: ${msg}`);
      void vscode.window.showErrorMessage(`Apply fixes: ${msg}`);
    } finally {
      panel.setApplyingFixIndex(null);
      if (isBulkRun) {
        panel.setApplyingFixAll(false);
      }
    }
  });
}

/** Map ReviewPayload + editor uri to stored shape (used from codeReview). */
export function toStoredReview(uri: vscode.Uri, fileName: string, payload: ReviewPayload): StoredReview {
  return {
    documentUri: uri.toString(),
    fileName,
    summary: payload.summary,
    findings: payload.findings,
    appliedIndices: payload.appliedIndices ?? [],
    appliedFindingKeys: payload.appliedFindingKeys ?? [],
    rejectedIndices: payload.rejectedIndices ?? [],
  };
}
