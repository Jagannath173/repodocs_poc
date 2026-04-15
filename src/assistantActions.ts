import * as vscode from "vscode";
import { diffLines } from "diff";
import { extensionContext } from "./extension";
import { ensureCopilotSession } from "./session";
import { runCopilotInference } from "./pythonRunner";
import { AssistantRenderPayload, AssistantResultPanel } from "./assistantPanel";
import { extractFirstJsonObject } from "./reviewPanel";
import { renderPromptTemplate } from "./promptRenderer";

const ASSISTANT_PROMPT_FILES = {
  codeExplanation: "assistant/code_explanation.jinja",
  codeRefactor: "assistant/code_refactor.jinja",
  codeGeneration: "assistant/code_generation.jinja",
  unitTest: "assistant/unit_test.jinja",
  fileWiseUnitTest: "assistant/file-wise_unittest.jinja",
  docstringAddition: "assistant/docstring_addition.jinja",
  commentAddition: "assistant/comment_addition.jinja",
  loggingAddition: "assistant/logging_addition.jinja",
  errorHandling: "assistant/error_handling.jinja",
  testscriptSelfHealing: "assistant/testscript_self_healing.jinja",
} as const;

const ASSISTANT_LABELS: Record<AssistantEndpoint, string> = {
  codeExplanation: "Code Explanation",
  codeRefactor: "Code Refactor",
  codeGeneration: "Code Generation",
  unitTest: "Unit Test",
  fileWiseUnitTest: "File-wise Unit Test",
  docstringAddition: "Docstring Addition",
  commentAddition: "Comment Addition",
  loggingAddition: "Logging Addition",
  errorHandling: "Error Handling",
  testscriptSelfHealing: "Testscript Self Healing",
};

export type AssistantEndpoint = keyof typeof ASSISTANT_PROMPT_FILES;

export async function runAssistantEndpoint(endpoint: AssistantEndpoint): Promise<void> {
  if (!(await ensureCopilotSession())) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor && endpoint !== "codeGeneration") {
    void vscode.window.showWarningMessage("Open a code file and try again.");
    return;
  }

  const language = editor?.document.languageId ?? "unknown";
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
  const code = editor ? selected || editor.document.getText() : "";
  if (!code.trim() && endpoint !== "codeGeneration") {
    void vscode.window.showWarningMessage("Select code or open a non-empty file before running this action.");
    return;
  }
  const targetRange = editor && !editor.selection.isEmpty ? editor.selection : undefined;
  const panel = new AssistantResultPanel(extensionContext, `Assistant: ${ASSISTANT_LABELS[endpoint]}`);
  panel.setMode(endpoint);
  panel.setBusy(true);
  panel.setStatus("Preparing prompt...");
  panel.setProgressStep("Preparing prompt template...");
  let applyCode = "";
  const sourceUri = editor?.document.uri;
  let waitingForDecision = false;
  let running = false;
  let requestRefinementAndRegenerate: () => Promise<void> = async () => {};

  panel.onFixDecisionRequested((value) => {
    if (!waitingForDecision) {
      return;
    }
    if (value === "accept") {
      void applyAssistantOutput(applyCode, sourceUri, targetRange);
      panel.setStatus("Accepted and applied.");
    } else {
      panel.setStatus("Refactor suggestion rejected.");
    }
    waitingForDecision = false;
  });

  panel.onRefineRequested(() => {
    void requestRefinementAndRegenerate();
  });

  panel.onApplyRequested(() => {
    if (endpoint === "codeRefactor") {
      panel.setStatus("Use Accept or Reject in diff preview.");
      return;
    }
    void applyAssistantOutput(applyCode, sourceUri, targetRange);
  });

  try {
    const generationQuestion = endpoint === "codeGeneration" ? await askGenerationQuestion() : undefined;
    const baseVars = await collectAssistantVars(endpoint, code, language, generationQuestion);
    if (!baseVars) {
      panel.setStatus("Cancelled.");
      panel.setBusy(false);
      return;
    }

    const runOnce = async (refinementNote?: string) => {
      if (running) {
        return;
      }
      running = true;
      try {
        panel.setBusy(true);
        panel.setStreamText("");
        panel.setProgressStep("Preparing prompt template...");
        const vars: Record<string, string> = { ...baseVars };
        if (refinementNote?.trim()) {
          vars.refinement = refinementNote.trim();
        }

        const prompt = await renderPromptTemplate(extensionContext.extensionPath, ASSISTANT_PROMPT_FILES[endpoint], vars);
        panel.setStatus("Calling model...");
        panel.setProgressStep("Calling model and streaming response...");
        const raw = await runInferenceWithStreaming(prompt, panel);
        panel.setProgressStep("Parsing model response...");
        panel.setStatus("Rendering output...");
        const rendered = buildAssistantRenderPayload(raw, code, endpoint);
        applyCode = rendered.applyCode ?? "";
        panel.setResult(rendered);
        if (endpoint === "codeRefactor" && applyCode.trim()) {
          waitingForDecision = true;
          panel.setStatus("Review the diff, then Accept or Reject.");
        } else {
          waitingForDecision = false;
          panel.setStatus("");
        }
        panel.setProgressStep("Done.");
      } finally {
        running = false;
        panel.setBusy(false);
      }
    };

    requestRefinementAndRegenerate = async () => {
      if (endpoint !== "codeGeneration") {
        return;
      }
      const refinement = await vscode.window.showInputBox({
        title: "Refine code generation",
        prompt: "What should be improved? (security, compliance, architecture, edge cases, etc.)",
        ignoreFocusOut: true,
      });
      if (!refinement?.trim()) {
        return;
      }
      panel.setProgressStep("Regenerating with refinement request...");
      await runOnce(refinement.trim());
    };

    await runOnce();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    panel.setError(msg);
    panel.setStatus("Failed.");
    panel.setBusy(false);
  }
}

async function runInferenceWithStreaming(panelPrompt: string, panel: AssistantResultPanel): Promise<string> {
  const state = { text: "", chunkText: "" };
  await runCopilotInference(
    extensionContext,
    panelPrompt,
    (data) => {
      appendAssistantFromSseLine(data, state);
      if (state.chunkText) {
        panel.setStreamText(state.chunkText);
      }
    },
    {
      systemRole: "Respond with valid JSON only.",
      stream: true,
    }
  );
  panel.setStreamText(state.text);
  return state.text;
}

function appendAssistantFromSseLine(line: string, state: { text: string; chunkText: string }): void {
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
    const piece = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || json.choices?.[0]?.text;
    if (piece) {
      state.text += piece;
      state.chunkText = state.text;
    }
  } catch {
    /* ignore */
  }
}

async function collectAssistantVars(
  endpoint: AssistantEndpoint,
  code: string,
  language: string,
  generationPrompt?: string
): Promise<Record<string, string> | undefined> {
  const vars: Record<string, string> = { code, language };

  if (endpoint === "codeGeneration") {
    if (!generationPrompt?.trim()) {
      return undefined;
    }
    vars.prompt = generationPrompt.trim();
    vars.code = code.trim() ? code : "";
    vars.repo_context = await collectRepositoryContext();
  }

  if (!vars.code) {
    vars.code = "";
  }
  return vars;
}

async function askGenerationQuestion(): Promise<string | undefined> {
  const question = await vscode.window.showInputBox({
    title: "Code generation",
    prompt: "Write your question",
    placeHolder: "Describe what should be generated...",
    ignoreFocusOut: true,
  });
  return question?.trim() ? question.trim() : undefined;
}

async function collectRepositoryContext(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "No workspace folder detected.";
  }
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,out,.git,python/venv,__pycache__,.cursor}/**",
    120
  );
  const relPaths = files
    .map((f) => vscode.workspace.asRelativePath(f, false))
    .filter((p) => p.length > 0)
    .slice(0, 80);
  const header = `Workspace root: ${folder.uri.fsPath}`;
  if (!relPaths.length) {
    return `${header}\nNo repository files indexed.`;
  }
  return `${header}\nRepository files (sample):\n- ${relPaths.join("\n- ")}`;
}

function buildAssistantRenderPayload(raw: string, beforeText: string, endpoint: AssistantEndpoint): AssistantRenderPayload {
  try {
    const obj = JSON.parse(extractFirstJsonObject(raw)) as Record<string, unknown>;
    const remarks =
      (typeof obj.remarks === "string" && obj.remarks) ||
      (typeof obj.details === "string" && obj.details) ||
      "Assistant response generated.";

    const applyCode = extractApplyCode(obj, endpoint);
    const displayText = buildDisplayText(obj);
    const jsonText = JSON.stringify(obj, null, 2);
    const reviewMode = endpoint === "codeRefactor";
    const diffParts = reviewMode && applyCode ? buildDiffParts(beforeText, applyCode) : undefined;
    return { remarks, displayText, applyCode, jsonText, structuredData: obj, reviewMode, diffParts, endpoint };
  } catch {
    return {
      remarks: "Assistant response generated.",
      displayText: raw.trim(),
      jsonText: raw.trim(),
      structuredData: undefined,
      reviewMode: endpoint === "codeRefactor",
      diffParts: undefined,
      endpoint,
      applyCode: undefined,
    };
  }
}

function buildDiffParts(before: string, after: string): Array<{ kind: "add" | "remove" | "same"; text: string }> {
  const parts = diffLines(before, after);
  const serialized: Array<{ kind: "add" | "remove" | "same"; text: string }> = [];
  for (const p of parts) {
    const kind: "add" | "remove" | "same" = p.added ? "add" : p.removed ? "remove" : "same";
    const lines = p.value.split(/\r?\n/);
    const last = lines.length - 1;
    for (let i = 0; i <= last; i++) {
      const segment = i < last ? `${lines[i]}\n` : lines[i];
      const prefix = kind === "add" ? "+ " : kind === "remove" ? "- " : "  ";
      serialized.push({ kind, text: prefix + segment });
    }
  }
  return serialized;
}

function extractApplyCode(obj: Record<string, unknown>, endpoint: AssistantEndpoint): string | undefined {
  const applyEnabledEndpoints = new Set<AssistantEndpoint>([
    "codeRefactor",
    "codeGeneration",
    "docstringAddition",
    "commentAddition",
    "loggingAddition",
    "errorHandling",
    "testscriptSelfHealing",
  ]);
  if (!applyEnabledEndpoints.has(endpoint)) {
    return undefined;
  }

  const directFields = [
    "refactoredCode",
    "generatedCode",
    "documentationAdded",
    "commentedCode",
    "loggedCode",
    "exceptionHandlingAdded",
  ];
  for (const key of directFields) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function buildDisplayText(obj: Record<string, unknown>): string {
  if (Array.isArray(obj.explanation)) {
    const blocks = obj.explanation
      .map((e) => {
        const ex = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
        const overview = typeof ex.overview === "string" ? ex.overview : "";
        const detail = typeof ex.detailedExplanation === "string" ? ex.detailedExplanation : "";
        return [overview, detail].filter(Boolean).join("\n\n");
      })
      .filter(Boolean);
    if (blocks.length) {
      return blocks.join("\n\n---\n\n");
    }
  }
  return JSON.stringify(obj, null, 2);
}

async function applyAssistantOutput(
  applyCode: string,
  sourceUri: vscode.Uri | undefined,
  targetRange?: vscode.Range
): Promise<void> {
  if (!applyCode.trim()) {
    void vscode.window.showWarningMessage("No generated code available to apply.");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const targetUri = sourceUri ?? editor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage("Open a file to apply assistant output.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(targetUri);
  const edit = new vscode.WorkspaceEdit();
  const range = targetRange ?? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, range, applyCode);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    void vscode.window.showInformationMessage("Assistant output applied to current file.");
  } else {
    void vscode.window.showErrorMessage("Could not apply assistant output to current file.");
  }
}
