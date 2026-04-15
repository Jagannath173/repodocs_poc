import * as vscode from "vscode";
import * as path from "node:path";
import { runCopilotInference } from "./pythonRunner";
import { extensionContext } from "./extension";
import { parseReviewJson, ReviewWebviewSession } from "./reviewPanel";
import { ensureCopilotSession } from "./session";
import { saveLastReview, toStoredReview } from "./applyFixes";
import { openAuthWebviewAndAuthenticate } from "./authPanel";

const REVIEW_SYSTEM_ROLE = `You are a senior staff engineer doing code review.
You must respond with ONLY valid JSON (no markdown prose outside JSON). Use this exact shape:
{
  "summary": "2-4 sentences overall assessment.",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "category": "security|correctness|performance|maintainability|style|testing|other",
      "title": "short label",
      "detail": "what you observed in the code",
      "suggestion": "concrete improvement or fix"
    }
  ]
}
Rules: findings must be evidence-based from the code provided; use severity "info" for minor nits; prefer 3–12 findings unless the change is trivial; do not wrap the JSON in markdown fences.`;

const REVIEW_PROMPT = `Perform a structured code review of the file below.
Return ONLY the JSON object as specified in your instructions.`;

export async function runCodeReview(): Promise<void> {
  if (!(await ensureCopilotSession())) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  let content = "";
  if (editor) {
    content = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  }

  if (!content.trim()) {
    vscode.window.showWarningMessage("Open a file (or select code) to review.");
    return;
  }

  const fileName = editor ? path.basename(editor.document.fileName) : "snippet";
  const finalPrompt = `${REVIEW_PROMPT}\n\n### File: ${fileName}\n\`\`\`\n${content}\n\`\`\``;

  const documentUri = editor ? editor.document.uri.toString() : undefined;
  const panel = new ReviewWebviewSession(extensionContext, `Review: ${fileName}`, documentUri);
  panel.setLoading();

  const output = vscode.window.createOutputChannel("Code Review");
  let assistantText = "";
  let authError = false;

  try {
    await runCopilotInference(
      extensionContext,
      finalPrompt,
      (data) => {
        output.append(data);
        const trimmed = data.trim();
        if (trimmed.includes("Error: No active Copilot session")) {
          authError = true;
        }
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
          const text =
            json.choices?.[0]?.delta?.content ||
            json.choices?.[0]?.message?.content ||
            json.choices?.[0]?.text;
          if (text) {
            assistantText += text;
            const chunkPreview = text.replace(/\s+/g, " ").trim();
            if (chunkPreview) {
              panel.addReviewLog(chunkPreview, "info");
            }
          }
        } catch {
          /* non-JSON SSE line */
        }
      },
      { systemRole: REVIEW_SYSTEM_ROLE }
    );

    panel.addReviewLog("Model response finished. Parsing JSON payload.", "info");

    if (authError) {
      panel.dispose();
      const ok = await openAuthWebviewAndAuthenticate(extensionContext);
      if (ok) {
        await runCodeReview();
      }
      return;
    }

    const review = parseReviewJson(assistantText);
    panel.addReviewLog(`Parsed ${review.findings.length} findings. Rendering report.`, "success");
    if (editor) {
      await saveLastReview(toStoredReview(editor.document.uri, fileName, review));
    }
    panel.setReview({ ...review, appliedIndices: [] });
    panel.registerOnMessage((msg: unknown) => {
      const m = msg as { command?: string; mode?: string; index?: number; promptExtra?: boolean };
      if (m?.command === "applyFixes") {
        const mode = m.mode === "one" ? "one" : "all";
        const idx = typeof m.index === "number" ? m.index : undefined;
        if (m.promptExtra) {
          void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx);
        } else {
          void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, "");
        }
      } else if (m?.command === "authenticate") {
        void vscode.commands.executeCommand("codeReview.authenticate");
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    panel.setError(msg, undefined, assistantText);
    vscode.window.showErrorMessage(`Code review failed: ${msg}`);
  }
}
