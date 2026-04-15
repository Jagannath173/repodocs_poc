import * as vscode from "vscode";
import { extensionContext } from "./extension";
import { ensureCopilotSession } from "./session";
import { runCopilotInferenceCollectText } from "./pythonRunner";
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
  const language = editor?.document.languageId ?? "unknown";
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
  const code = editor ? selected || editor.document.getText() : "";
  const panel = new AssistantResultPanel(extensionContext, `Assistant: ${ASSISTANT_LABELS[endpoint]}`);
  panel.setStatus("Preparing prompt...");
  let applyCode = "";
  const sourceUri = editor?.document.uri;
  panel.onApplyRequested(() => {
    void applyAssistantOutput(applyCode, sourceUri);
  });

  try {
    const vars = await collectAssistantVars(endpoint, code, language);
    if (!vars) {
      panel.setStatus("Cancelled.");
      return;
    }
    const prompt = await renderPromptTemplate(extensionContext.extensionPath, ASSISTANT_PROMPT_FILES[endpoint], vars);
    panel.setStatus("Calling model...");
    const raw = await runCopilotInferenceCollectText(extensionContext, prompt, {
      systemRole: "Respond with valid JSON only.",
      stream: true,
    });
    panel.setStatus("Rendering output...");
    const rendered = buildAssistantRenderPayload(raw);
    applyCode = rendered.applyCode ?? "";
    panel.setResult(rendered);
    panel.setStatus("");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    panel.setError(msg);
    panel.setStatus("Failed.");
  }
}

async function collectAssistantVars(
  endpoint: AssistantEndpoint,
  code: string,
  language: string
): Promise<Record<string, string> | undefined> {
  const vars: Record<string, string> = { code, language };

  if (endpoint === "codeGeneration") {
    const prompt = await vscode.window.showInputBox({
      title: "Code generation",
      prompt: "What should be generated?",
      ignoreFocusOut: true,
    });
    if (!prompt?.trim()) {
      return undefined;
    }
    vars.prompt = prompt.trim();
  }

  if (!vars.code) {
    vars.code = "";
  }
  return vars;
}

function buildAssistantRenderPayload(raw: string): AssistantRenderPayload {
  try {
    const obj = JSON.parse(extractFirstJsonObject(raw)) as Record<string, unknown>;
    const remarks =
      (typeof obj.remarks === "string" && obj.remarks) ||
      (typeof obj.details === "string" && obj.details) ||
      "Assistant response generated.";

    const applyCode = extractApplyCode(obj);
    const displayText = buildDisplayText(obj);
    return { remarks, displayText, applyCode };
  } catch {
    return {
      remarks: "Assistant response generated.",
      displayText: raw.trim(),
      applyCode: undefined,
    };
  }
}

function extractApplyCode(obj: Record<string, unknown>): string | undefined {
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

  const tcRaw = obj.testcases;
  if (Array.isArray(tcRaw)) {
    const lines = tcRaw
      .map((x) => {
        const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
        return typeof o.testcase === "string" ? o.testcase : "";
      })
      .filter(Boolean);
    if (lines.length) {
      return lines.join("\n\n");
    }
  }

  const unitTests = obj.unitTests;
  if (Array.isArray(unitTests)) {
    const lines = unitTests
      .map((x) => {
        const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
        return typeof o.testCase === "string" ? o.testCase : "";
      })
      .filter(Boolean);
    if (lines.length) {
      return lines.join("\n\n");
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

async function applyAssistantOutput(applyCode: string, sourceUri: vscode.Uri | undefined): Promise<void> {
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
  const oldText = doc.getText();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(oldText.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange, applyCode);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    void vscode.window.showInformationMessage("Assistant output applied to current file.");
  } else {
    void vscode.window.showErrorMessage("Could not apply assistant output to current file.");
  }
}
