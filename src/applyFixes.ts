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
    ? `\n\nAdditional instructions from the developer: ${extraInstruction.trim()}`
    : "";
  return `File name: ${fileName}

Current file:
\`\`\`
${fileContent}
\`\`\`

Review summary: ${summary}

Apply ONLY the following single finding next (do not address other issues):
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
  const applied = new Set(s.appliedIndices ?? []);
  applied.add(originalIndex);
  const next: StoredReview = {
    ...s,
    appliedIndices: Array.from(applied).sort((a, b) => a - b),
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

  const uri = vscode.Uri.parse(stored.documentUri);
  let doc = await vscode.workspace.openTextDocument(uri);
  let targetIndices: number[];
  if (mode === "one") {
    if (typeof index !== "number" || index < 0 || index >= stored.findings.length) {
      void vscode.window.showWarningMessage("Invalid finding index for Apply fix.");
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
    targetIndices = stored.findings.map((_, i) => i);
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

  const hasQueuedWork = fixOperationQueues.has(stored.documentUri);
  if (hasQueuedWork) {
    panel.addFixLog("Another fix run is in progress for this file. Your request is queued.", "warn");
  }

  await runWithDocumentFixQueue(stored.documentUri, async () => {
    try {
      let currentText = doc.getText();
      const initialText = currentText;

      for (let step = 0; step < targetIndices.length; step++) {
        const originalIndex = targetIndices[step];
        const finding = stored.findings[originalIndex];
        panel.startFixStep(step + 1, total, finding.title);
        panel.addFixLog("Sending fix request to model.", "info");

        const prompt = buildFixPrompt(stored.fileName, currentText, stored.summary, finding, extra);
        const state = { text: "" };
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
          panel.showFixError(`Copilot request failed: ${msg}`);
          void vscode.window.showInformationMessage("Apply fixes stopped.");
          return;
        }

        try {
          currentText = parseFixFileContent(state.text);
          panel.addFixLog("Parsed model JSON successfully.", "success");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Could not parse JSON.";
          log.error("applyFixes", "Could not parse fix JSON", { step: step + 1, error: sanitizeForLog(msg) });
          panel.showFixError(`Could not parse AI response as fix JSON: ${msg}`);
          void vscode.window.showInformationMessage("Apply fixes stopped.");
          return;
        }
      }

      const previewTitle =
        mode === "one"
          ? stored.findings[targetIndices[0]]?.title || "Fix"
          : `Combined fixes (${targetIndices.length})`;
      const choice = await previewFixInEditorAndWait(doc, initialText, currentText, previewTitle);
      if (choice === "reject") {
        void vscode.window.showInformationMessage("Fix preview rejected. No changes were finalized.");
        return;
      }

      for (const originalIndex of targetIndices) {
        await markFindingApplied(originalIndex);
        appliedCount += 1;
      }
      doc = await vscode.workspace.openTextDocument(uri);

      log.info("applyFixes", "Apply fixes completed", { appliedCount, total });
      void vscode.window.showInformationMessage(`Accepted and applied ${appliedCount} fix step(s). Save the file if needed (${stored.fileName}).`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("applyFixes", "applyFixesFromReview failed", { error: sanitizeForLog(msg) });
      panel.showFixError(`Apply fixes failed: ${msg}`);
      void vscode.window.showErrorMessage(`Apply fixes: ${msg}`);
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
  };
}
