import * as vscode from "vscode";
import { extensionContext } from "./extension";
import { ensureCopilotSession } from "./session";
import { runCopilotInference } from "./pythonRunner";
import type { ReviewFinding, ReviewPayload } from "./reviewPanel";
import { FixPreviewPanel } from "./fixPreviewPanel";
import { notifyReviewUpdated, type ReviewTableState } from "./reviewBridge";

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
  const trimmed = raw.trim();
  const fence = /^[\s\S]*?```(?:json)?\s*([\s\S]*?)```[\s\S]*$/m.exec(trimmed);
  const jsonStr = fence ? fence[1].trim() : trimmed;
  const data = JSON.parse(jsonStr) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Fix response must be a JSON object.");
  }
  const o = data as Record<string, unknown>;
  const fc = o.fileContent;
  if (typeof fc !== "string") {
    throw new Error('Expected JSON with a string "fileContent" property.');
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
  mode: "all" | "one" = "all",
  index?: number,
  /** Pass "" from the webview to skip the optional input box; omit (undefined) to prompt. */
  extraUserInstruction?: string
): Promise<void> {
  if (!(await ensureCopilotSession())) {
    return;
  }

  const stored = getStoredReview();
  if (!stored || !stored.findings?.length) {
    void vscode.window.showWarningMessage("Run Code Review on a file first, then use Apply fixes.");
    return;
  }

  const uri = vscode.Uri.parse(stored.documentUri);
  let doc = await vscode.workspace.openTextDocument(uri);
  const findings =
    mode === "one" && typeof index === "number" && index >= 0 && index < stored.findings.length
      ? [stored.findings[index]]
      : [...stored.findings];

  if (mode === "one" && findings.length === 0) {
    void vscode.window.showWarningMessage("Invalid finding index for Apply fix.");
    return;
  }

  const output = vscode.window.createOutputChannel("Code Review");
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

  const preview = new FixPreviewPanel(extensionContext);
  preview.reveal();

  const total = findings.length;
  let appliedCount = 0;

  try {
    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];
      const originalIndex =
        mode === "one" && typeof index === "number" && index >= 0 ? index : i;
      const step = i + 1;
      let currentText = doc.getText();

      preview.startStep(step, total, finding.title);

      const prompt = buildFixPrompt(stored.fileName, currentText, stored.summary, finding, extra);
      const state = { text: "" };

      try {
        await runCopilotInference(
          extensionContext,
          prompt,
          (line) => {
            output.appendLine(line);
            appendAssistantFromSseLine(line, state);
            preview.scheduleStreamText(state.text);
          },
          { systemRole: FIX_SYSTEM_ROLE, stream: true }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const choicePromise = preview.waitForChoice();
        preview.showError(`Copilot request failed: ${msg}`);
        await choicePromise;
        preview.dispose();
        void vscode.window.showInformationMessage("Apply fixes stopped.");
        return;
      }

      preview.flushStream();

      let newContent: string;
      try {
        newContent = parseFixFileContent(state.text);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Could not parse JSON.";
        const choicePromise = preview.waitForChoice();
        preview.showError(`Could not parse AI response as fix JSON: ${msg}`);
        await choicePromise;
        preview.dispose();
        void vscode.window.showInformationMessage("Apply fixes stopped.");
        return;
      }

      const choicePromise = preview.waitForChoice();
      preview.showDiff(currentText, newContent);
      const choice = await choicePromise;

      if (choice === "reject") {
        void vscode.window.showInformationMessage(
          `Fix ${step}/${total} rejected. Remaining fixes were not applied.`
        );
        preview.dispose();
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(currentText.length));
      edit.replace(doc.uri, fullRange, newContent);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        void vscode.window.showErrorMessage("Editor rejected the change.");
        preview.dispose();
        return;
      }

      appliedCount += 1;
      await markFindingApplied(originalIndex);
      doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    preview.dispose();
    void vscode.window.showInformationMessage(
      `Accepted and applied ${appliedCount} fix step(s). Save the file if needed (${stored.fileName}).`
    );
  } catch (e: unknown) {
    preview.dispose();
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Apply fixes: ${msg}`);
  }
}

/** Map ReviewPayload + editor uri to stored shape (used from codeReview). */
export function toStoredReview(uri: vscode.Uri, fileName: string, payload: ReviewPayload): StoredReview {
  return {
    documentUri: uri.toString(),
    fileName,
    summary: payload.summary,
    findings: payload.findings,
    appliedIndices: [],
  };
}
