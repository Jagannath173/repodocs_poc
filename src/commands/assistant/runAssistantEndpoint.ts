import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { extensionContext } from "../../extension";
import { ensureCopilotSession } from "../../utils/session";
import { runCopilotInference } from "../../utils/pythonRunner";
import type { AssistantRenderPayload } from "./assistantTypes";
import { AssistantResultPanel } from "../webview/assistant_webview/assistantResultPanel";
import { extractFirstJsonObject } from "../webview/review_Webview/reviewPanel";
import { renderPromptTemplate } from "../../utils/promptRenderer";
import { log, sanitizeForLog } from "../../utils/logger";
import { suppressReviewStaleFlushForUri } from "../../review/reviewStaleSuppress";
import { buildDiffParts } from "../../utils/buildDiffParts";
import { previewFixInEditorAndWait, type FixInEditorChoice } from "../../preview/fixInEditorPreview";

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

type GeneratedFile = {
  relativePath: string;
  code: string;
};

export async function runAssistantEndpoint(endpoint: AssistantEndpoint): Promise<void> {
  log.info("assistant", "Assistant action starting", { endpoint });
  if (!(await ensureCopilotSession())) {
    log.warn("assistant", "Aborted: no Copilot session", { endpoint });
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor && endpoint !== "codeGeneration") {
    log.warn("assistant", "Aborted: no active editor", { endpoint });
    void vscode.window.showWarningMessage("Open a code file and try again.");
    return;
  }

  const language = editor?.document.languageId ?? "unknown";
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
  const code = editor ? selected || editor.document.getText() : "";
  if (!code.trim() && endpoint !== "codeGeneration") {
    log.warn("assistant", "Aborted: empty code buffer", { endpoint });
    void vscode.window.showWarningMessage("Select code or open a non-empty file before running this action.");
    return;
  }
  const targetRange = editor && !editor.selection.isEmpty ? editor.selection : undefined;
  const panel = new AssistantResultPanel(
    extensionContext,
    `Assistant: ${ASSISTANT_LABELS[endpoint]}`,
    `assistant:${endpoint}`
  );
  panel.setMode(endpoint);
  if (endpoint === "codeGeneration") {
    panel.setBusy(false);
    panel.setStatus(
      "Type your question below, then click Send (Ctrl+Enter)."
    );
    panel.setProgressStep("Waiting for your prompt...");
  } else {
    panel.setBusy(true);
    panel.setStatus("Preparing prompt...");
    panel.setProgressStep("Preparing prompt template...");
  }
  let applyCode = "";
  const sourceUri = editor?.document.uri;
  let waitingForDecision = false;
  let running = false;
  let requestRefinementAndRegenerate: () => Promise<void> = async () => {};

  let lastCodeGenDelivery: "modifyCurrent" | "newFile" | undefined;
  let lastNewFileRelativePath = "";
  let lastGeneratedFiles: GeneratedFile[] = [];
  let fixDecisionDocWatcher: vscode.Disposable | undefined;

  const clearFixDecisionDocWatcher = (): void => {
    fixDecisionDocWatcher?.dispose();
    fixDecisionDocWatcher = undefined;
  };

  panel.onFixDecisionRequested((value) => {
    void handleFixDecision(value);
  });

  async function handleFixDecision(value: "accept" | "reject"): Promise<void> {
    if (!waitingForDecision) {
      return;
    }
    waitingForDecision = false;
    clearFixDecisionDocWatcher();

    if (value === "reject") {
      panel.setStatus("Suggestion rejected — no changes applied.");
      panel.setFixDecisionPhase("rejected");
      return;
    }

    if (endpoint === "codeGeneration" && lastCodeGenDelivery === "newFile") {
      await createGeneratedFilesInWorkspace(lastGeneratedFiles, lastNewFileRelativePath, applyCode);
      panel.setStatus("File(s) created.");
      panel.setFixDecisionPhase("accepted");
      return;
    }

    const uri = sourceUri;
    if (!uri) {
      panel.setFixDecisionPhase("pending");
      waitingForDecision = true;
      panel.setStatus("No file context — cannot apply.");
      return;
    }

    let preText: string;
    try {
      const preDoc = await vscode.workspace.openTextDocument(uri);
      preText = normalizeDocText(preDoc.getText());
    } catch {
      panel.setFixDecisionPhase("pending");
      waitingForDecision = true;
      panel.setStatus("Could not read the file to apply.");
      return;
    }

    const applied = await applyAssistantOutput(applyCode, sourceUri, targetRange);
    if (!applied) {
      panel.setFixDecisionPhase("pending");
      waitingForDecision = true;
      return;
    }

    let postText: string;
    try {
      const postDoc = await vscode.workspace.openTextDocument(uri);
      postText = normalizeDocText(postDoc.getText());
    } catch {
      panel.setFixDecisionPhase("pending");
      waitingForDecision = true;
      panel.setStatus("Applied, but could not re-read the file.");
      return;
    }

    panel.setStatus("Accepted and applied.");
    panel.setFixDecisionPhase("accepted");

    if (
      endpoint === "codeGeneration" &&
      lastCodeGenDelivery === "modifyCurrent" &&
      preText !== postText
    ) {
      fixDecisionDocWatcher = watchFixDecisionDocument(uri, preText, postText, (phase) => {
        panel.setFixDecisionPhase(phase);
        waitingForDecision = phase === "pending";
        panel.setStatus(
          phase === "pending"
            ? "Review the diff below, then use Accept or Reject here."
            : "Accepted and applied."
        );
      });
    }
  }

  extensionContext.subscriptions.push(
    panel.onMessage((msg) => {
      const m = msg as { command?: string };
      if (m?.command === "closeSession") {
        clearFixDecisionDocWatcher();
      }
    })
  );

  panel.onRefineRequested(() => {
    void requestRefinementAndRegenerate();
  });

  panel.onApplyRequested(() => {
    if (endpoint === "codeGeneration" && waitingForDecision) {
      panel.setStatus("Use Accept or Reject in the assistant panel after reviewing the editor diff.");
      return;
    }
    if (endpoint === "codeRefactor") {
      void applyRefactorWithEditorPreview(panel, applyCode, sourceUri, targetRange);
      return;
    }
    void applyAssistantOutput(applyCode, sourceUri, targetRange);
  });

  try {
    const generationQuestion = endpoint === "codeGeneration" ? await askGenerationQuestion(panel) : undefined;
    const baseVars = await collectAssistantVars(endpoint, code, language, generationQuestion);
    if (!baseVars) {
      log.info("assistant", "User cancelled or skipped variable collection", { endpoint });
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
        clearFixDecisionDocWatcher();
        lastCodeGenDelivery = undefined;
        lastNewFileRelativePath = "";
        lastGeneratedFiles = [];
        panel.setBusy(true);
        panel.setStreamText("");
        panel.setStreamLive(true);
        panel.setProgressStep("Preparing prompt template...");
        const vars: Record<string, string> = { ...baseVars };
        if (refinementNote?.trim()) {
          vars.refinement = refinementNote.trim();
          if (endpoint === "codeRefactor") {
            // For refactor, feed refinement directly into the main prompt field used by the template.
            vars.prompt = `${baseVars.prompt}\n\nAdditional refinement request:\n${refinementNote.trim()}`;
          }
        }

        panel.setUserQuestion(describeUserIntent(endpoint, vars));

        const prompt = await renderPromptTemplate(extensionContext.extensionPath, ASSISTANT_PROMPT_FILES[endpoint], vars);
        log.debug("assistant", "Prompt ready", { endpoint, promptChars: prompt.length });
        panel.setStatus("Calling model...");
        panel.setProgressStep("Calling model and streaming response...");
        const raw = await runInferenceWithStreaming(prompt, panel);
        log.debug("assistant", "Model response received", { endpoint, responseChars: raw.length });
        panel.setProgressStep("Parsing model response...");
        panel.setStatus("Rendering output...");
        const rendered = buildAssistantRenderPayload(raw, code, endpoint, {
          userPrompt: vars.prompt ?? "",
        });
        applyCode = rendered.applyCode ?? "";
        lastCodeGenDelivery = rendered.codeGenDelivery;
        lastNewFileRelativePath = rendered.newFileRelativePath?.trim() ?? "";
        lastGeneratedFiles = rendered.generatedFiles ?? [];
        panel.setResult(rendered);
        const needsDiffDecision = endpoint === "codeGeneration" && applyCode.trim() && rendered.reviewMode;
        if (needsDiffDecision) {
          waitingForDecision = true;
          panel.setStatus("Review the diff below, then use Accept or Reject here.");
        } else {
          waitingForDecision = false;
          if (endpoint === "codeRefactor" && applyCode.trim()) {
            panel.setStatus("Click Apply to preview changes in the editor, then accept/reject there.");
          } else {
            panel.setStatus("");
          }
        }
        panel.setProgressStep("Done.");
      } finally {
        running = false;
        panel.setStreamLive(false);
        panel.setBusy(false);
      }
    };

    requestRefinementAndRegenerate = async () => {
      if (endpoint !== "codeGeneration" && endpoint !== "codeRefactor") {
        return;
      }
      panel.setStatus(
        endpoint === "codeRefactor"
          ? "Enter refinement instructions in the prompt box, then click Send."
          : "Enter refinement instructions in the prompt box, then click Send."
      );
      panel.setProgressStep("Waiting for refinement prompt...");
      const refinement = await askGenerationQuestion(panel);
      if (!refinement?.trim()) {
        return;
      }
      panel.setProgressStep("Regenerating with refinement request...");
      await runOnce(refinement.trim());
    };

    await runOnce();
    log.info("assistant", "Assistant action completed", { endpoint });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    log.error("assistant", "Assistant action failed", { endpoint, error: sanitizeForLog(msg) });
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
      log.proxyLine("assistant", data);
      appendAssistantFromSseLine(data, state);
      if (state.chunkText) {
        panel.setStreamText(state.chunkText);
      }
    },
    {
      systemRole:
        "Answer directly in clear plain text/markdown. Use code fences for code when needed. Do not force JSON.",
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

/** Summary of what the user asked for — shown at the top of the assistant webview. */
function describeUserIntent(endpoint: AssistantEndpoint, vars: Record<string, string>): string {
  if (endpoint === "codeGeneration") {
    const main = vars.prompt?.trim() ?? "";
    const ref = vars.refinement?.trim();
    if (ref) {
      return [main, ref].filter(Boolean).join("\n\n");
    }
    return main || "(empty prompt)";
  }
  if (endpoint === "codeRefactor") {
    const ref = vars.refinement?.trim();
    if (ref) {
      return ref;
    }
  }
  const label = ASSISTANT_LABELS[endpoint];
  const lang = vars.language || "unknown";
  const code = vars.code ?? "";
  const n = code.length;
  if (n === 0) {
    return `${label} · ${lang}\n\nNo code was included.`;
  }
  if (n <= 2000) {
    return `${label} · ${lang}\n\n` + code;
  }
  return `${label} · ${lang}\n\n(${n} characters — see your editor for the full buffer.)`;
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

  if (endpoint === "codeRefactor") {
    vars.prompt =
      generationPrompt?.trim() ||
      "Refactor the code for readability and maintainability while preserving behavior.";
    vars.code = code.trim() ? code : "";
  }

  if (!vars.code) {
    vars.code = "";
  }
  return vars;
}

async function askGenerationQuestion(panel: AssistantResultPanel): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) {
        return;
      }
      done = true;
      disposable.dispose();
      resolve(value);
    };
    const disposable = panel.onMessage((raw) => {
      const msg = raw as { command?: string; value?: unknown };
      if (msg?.command === "submitPrompt" && typeof msg.value === "string") {
        const q = msg.value.trim();
        if (q) {
          finish(q);
        }
      }
      if (msg?.command === "closeSession") {
        finish(undefined);
      }
    });
  });
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

function defaultRemarksForEndpoint(endpoint: AssistantEndpoint): string {
  if (endpoint === "unitTest") {
    return "Unit test coverage and scenarios are summarized below.";
  }
  if (endpoint === "fileWiseUnitTest") {
    return "File-wise unit tests are listed below.";
  }
  return "Response ready.";
}

function buildAssistantRenderPayload(
  raw: string,
  beforeText: string,
  endpoint: AssistantEndpoint,
  opts?: { userPrompt?: string }
): AssistantRenderPayload {
  const text = raw.trim();
  const parsed = tryParseAssistantJson(text);
  const fromJson = parsed ?? undefined;
  const remarks =
    (fromJson && typeof fromJson.remarks === "string" && fromJson.remarks.trim()) ||
    (fromJson && typeof fromJson.details === "string" && fromJson.details.trim()) ||
    defaultRemarksForEndpoint(endpoint);
  const displayText = fromJson ? buildDisplayText(fromJson) : text;
  const generatedFiles = fromJson ? extractGeneratedFiles(fromJson, endpoint) : undefined;
  const fallbackCode = extractFirstCodeBlock(text);
  const applyCode = (fromJson ? extractApplyCode(fromJson, endpoint) : undefined) ?? fallbackCode;

  let codeGenDelivery: "modifyCurrent" | "newFile" | undefined;
  let newFileRelativePath: string | undefined;
  const primaryCode = applyCode ?? generatedFiles?.[0]?.code ?? "";
  if (endpoint === "codeGeneration" && primaryCode.trim()) {
    const parsedDelivery = fromJson ? parseCodeGenDelivery(fromJson) : undefined;
    const resolved = resolveCodeGenDelivery(opts?.userPrompt ?? "", beforeText, primaryCode, parsedDelivery);
    codeGenDelivery = resolved.mode;
    newFileRelativePath = resolved.newFilePath;
  }

  const isCodegen = endpoint === "codeGeneration" && Boolean(primaryCode.trim()) && codeGenDelivery;
  const reviewMode = Boolean(isCodegen);
  let diffParts: Array<{ kind: "add" | "remove" | "same"; text: string }> | undefined;
  if (endpoint === "codeRefactor" && primaryCode.trim()) {
    diffParts = buildDiffParts(beforeText, primaryCode);
  } else if (isCodegen && codeGenDelivery === "modifyCurrent" && primaryCode) {
    diffParts = buildDiffParts(beforeText, primaryCode);
  } else if (isCodegen && codeGenDelivery === "newFile" && primaryCode) {
    diffParts = buildNewFileOnlyDiff(primaryCode);
  }

  return {
    remarks,
    displayText,
    applyCode: primaryCode,
    jsonText: text,
    structuredData: fromJson,
    reviewMode,
    diffParts,
    endpoint,
    codeGenDelivery,
    newFileRelativePath,
    generatedFiles,
  };
}

function tryParseAssistantJson(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(extractFirstJsonObject(raw)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractFirstCodeBlock(raw: string): string | undefined {
  const m = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/m.exec(raw);
  const code = m?.[1]?.trim();
  return code ? code : undefined;
}

function parseCodeGenDelivery(obj: Record<string, unknown>): { mode: "modifyCurrent" | "newFile"; newFilePath?: string } | undefined {
  const d = obj.delivery;
  if (!d || typeof d !== "object") {
    return undefined;
  }
  const o = d as Record<string, unknown>;
  const m = typeof o.mode === "string" ? o.mode.toLowerCase().replace(/\s+/g, "_") : "";
  const pathRaw =
    (typeof o.newFileRelativePath === "string" && o.newFileRelativePath.trim()) ||
    (typeof o.newFilePath === "string" && o.newFilePath.trim()) ||
    "";
  if (m === "create_new_file" || m === "new_file" || m === "createfile") {
    return { mode: "newFile", newFilePath: pathRaw || undefined };
  }
  if (m === "create_multiple_files" || m === "multiple_files" || m === "multi_file") {
    return { mode: "newFile", newFilePath: pathRaw || undefined };
  }
  if (
    m === "modify_current_file" ||
    m === "modify_current" ||
    m === "replace_in_editor" ||
    m === "modify"
  ) {
    return { mode: "modifyCurrent" };
  }
  return undefined;
}

function extractGeneratedFiles(obj: Record<string, unknown>, endpoint: AssistantEndpoint): GeneratedFile[] | undefined {
  if (endpoint !== "codeGeneration") {
    return undefined;
  }
  const raw = obj.generatedFiles;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: GeneratedFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const relRaw =
      (typeof o.relativePath === "string" && o.relativePath) ||
      (typeof o.newFileRelativePath === "string" && o.newFileRelativePath) ||
      (typeof o.path === "string" && o.path) ||
      "";
    const codeRaw =
      (typeof o.code === "string" && o.code) ||
      (typeof o.generatedCode === "string" && o.generatedCode) ||
      "";
    const relativePath = sanitizeRelativeFilePath(relRaw);
    if (!relativePath || !codeRaw.trim()) {
      continue;
    }
    out.push({ relativePath, code: codeRaw });
  }
  return out.length ? out : undefined;
}

function sanitizeRelativeFilePath(p: string): string {
  const n = p.replace(/\\/g, "/").trim().replace(/^[/\\]+/, "");
  if (!n || n.includes("..")) {
    return "";
  }
  return n;
}

function guessNewFilePathFromPrompt(userPrompt: string): string | undefined {
  const tick = userPrompt.match(/`([^`\n]+\.[a-zA-Z0-9]{1,8})`/);
  if (tick) {
    const s = sanitizeRelativeFilePath(tick[1]);
    return s || undefined;
  }
  const q = userPrompt.match(/["']([\w./-]+\.[a-zA-Z0-9]{1,8})["']/);
  if (q) {
    const s = sanitizeRelativeFilePath(q[1]);
    return s || undefined;
  }
  return undefined;
}

function resolveCodeGenDelivery(
  userPrompt: string,
  editorCode: string,
  generatedCode: string,
  parsed?: { mode: "modifyCurrent" | "newFile"; newFilePath?: string }
): { mode: "modifyCurrent" | "newFile"; newFilePath?: string } {
  if (parsed?.mode === "newFile") {
    const p =
      sanitizeRelativeFilePath(parsed.newFilePath ?? "") ||
      guessNewFilePathFromPrompt(userPrompt) ||
      "generated_module.txt";
    return { mode: "newFile", newFilePath: p };
  }
  if (parsed?.mode === "modifyCurrent") {
    return { mode: "modifyCurrent" };
  }
  const hint =
    /\bnew file\b|\bcreate (a )?file\b|\bseparate file\b|\badd (a )?(new )?file\b|\banother file\b/i.test(userPrompt);
  if (hint) {
    const p = guessNewFilePathFromPrompt(userPrompt) || "generated_module.txt";
    return { mode: "newFile", newFilePath: p };
  }
  if (!editorCode.trim() && generatedCode.trim()) {
    const p = guessNewFilePathFromPrompt(userPrompt) || "generated_module.txt";
    return { mode: "newFile", newFilePath: p };
  }
  return { mode: "modifyCurrent" };
}

async function revealDocumentInEditor(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const preferredColumn =
    vscode.window.visibleTextEditors[0]?.viewColumn ??
    vscode.window.activeTextEditor?.viewColumn ??
    vscode.ViewColumn.One;
  await vscode.window.showTextDocument(doc, {
    viewColumn: preferredColumn,
    preview: false,
    preserveFocus: false,
  });
}

async function createGeneratedFileInWorkspace(relativePath: string, content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) {
    void vscode.window.showWarningMessage("No generated code to write.");
    return;
  }

  const baseName = path.basename(sanitizeRelativeFilePath(relativePath) || "generated_module.txt") || "generated_module.txt";
  const ws = vscode.workspace.workspaceFolders?.[0];

  let writtenUri: vscode.Uri | undefined;

  if (ws) {
    const rel = sanitizeRelativeFilePath(relativePath) || baseName;
    const abs = path.join(ws.uri.fsPath, rel);
    try {
      await ensureDirectoryForFile(abs);
      await fs.writeFile(abs, trimmed, "utf8");
      writtenUri = vscode.Uri.file(abs);
      void vscode.window.showInformationMessage(`Created ${rel}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Could not create file: ${msg}`);
      return;
    }
  } else {
    const picked = await vscode.window.showSaveDialog({
      title: "Save generated file",
      saveLabel: "Create file",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), baseName)),
    });
    if (!picked) {
      return;
    }
    const abs = picked.fsPath;
    try {
      await ensureDirectoryForFile(abs);
      await fs.writeFile(abs, trimmed, "utf8");
      writtenUri = vscode.Uri.file(abs);
      void vscode.window.showInformationMessage(`Saved ${path.basename(abs)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Could not create file: ${msg}`);
      return;
    }
  }

  if (writtenUri) {
    await revealDocumentInEditor(writtenUri);
  }
}

async function createGeneratedFilesInWorkspace(
  generatedFiles: GeneratedFile[] | undefined,
  fallbackRelativePath: string,
  fallbackCode: string
): Promise<void> {
  const files = generatedFiles?.length
    ? generatedFiles
    : [{ relativePath: fallbackRelativePath || "generated_module.txt", code: fallbackCode }];

  for (const file of files) {
    await createGeneratedFileInWorkspace(file.relativePath, file.code);
  }
}

/** Creates every missing parent directory. Safe when the file sits at the workspace root. */
async function ensureDirectoryForFile(absoluteFilePath: string): Promise<void> {
  const dir = path.dirname(absoluteFilePath);
  const normalizedDir = path.normalize(dir);
  const root = path.parse(absoluteFilePath).root;
  if (normalizedDir && normalizedDir !== root) {
    await fs.mkdir(normalizedDir, { recursive: true });
  }
}

/** New file on disk: show diff as additions only (green), no removals. */
function buildNewFileOnlyDiff(content: string): Array<{ kind: "add" | "remove" | "same"; text: string }> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  return lines.map((line, i) => ({
    kind: "add" as const,
    text: "+ " + line + (i < lines.length - 1 ? "\n" : ""),
  }));
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

  if (endpoint === "codeGeneration") {
    const files = extractGeneratedFiles(obj, endpoint);
    if (files?.length) {
      return files[0].code;
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
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const details = typeof obj.details === "string" ? obj.details.trim() : "";
  const quality = typeof obj.quality === "string" ? obj.quality.trim() : "";
  if (summary || details || quality || Array.isArray(obj.suggestedChanges)) {
    const lines: string[] = [];
    if (quality) lines.push(`Quality: ${quality}`);
    if (summary) lines.push(summary);
    if (details) lines.push(details);
    const sc = obj.suggestedChanges;
    if (Array.isArray(sc) && sc.length) {
      lines.push("Suggested changes:");
      for (let i = 0; i < sc.length; i++) {
        const row = sc[i];
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const area = typeof r.area === "string" ? r.area : "";
        const issue = typeof r.issue === "string" ? r.issue : "";
        const suggestion = typeof r.suggestion === "string" ? r.suggestion : "";
        const benefit = typeof r.benefit === "string" ? r.benefit : "";
        const bits = [area && `Area: ${area}`, issue && `Issue: ${issue}`, suggestion && `Change: ${suggestion}`, benefit && `Benefit: ${benefit}`]
          .filter(Boolean)
          .join("\n");
        if (bits) lines.push(`${i + 1}. ${bits}`);
      }
    }
    const risks = obj.risks;
    if (Array.isArray(risks) && risks.length) {
      lines.push("Risks:\n- " + risks.map((x) => String(x)).join("\n- "));
    }
    const vc = obj.validationChecklist;
    if (Array.isArray(vc) && vc.length) {
      lines.push("Validation:\n- " + vc.map((x) => String(x)).join("\n- "));
    }
    if (lines.length) {
      return lines.join("\n\n");
    }
  }
  return JSON.stringify(obj, null, 2);
}

async function applyAssistantOutput(
  applyCode: string,
  sourceUri: vscode.Uri | undefined,
  targetRange?: vscode.Range
): Promise<boolean> {
  if (!applyCode.trim()) {
    void vscode.window.showWarningMessage("No generated code available to apply.");
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  const targetUri = sourceUri ?? editor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage("Open a file to apply assistant output.");
    return false;
  }
  const doc = await vscode.workspace.openTextDocument(targetUri);
  const edit = new vscode.WorkspaceEdit();
  const range = targetRange ?? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, range, applyCode);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    await revealDocumentInEditor(targetUri);
    void vscode.window.showInformationMessage("Code applied in the editor.");
    return true;
  }
  void vscode.window.showErrorMessage("Could not apply assistant output to current file.");
  return false;
}

function normalizeDocText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * When the user undoes/redoes after Accept, move the Genie row between pending (pre-accept text) and accepted (post-accept text).
 */
function watchFixDecisionDocument(
  uri: vscode.Uri,
  preAcceptText: string,
  postAcceptText: string,
  onPhase: (phase: "pending" | "accepted") => void
): vscode.Disposable {
  const preN = normalizeDocText(preAcceptText);
  const postN = normalizeDocText(postAcceptText);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const flush = (doc: vscode.TextDocument): void => {
    const cur = normalizeDocText(doc.getText());
    if (cur === preN) {
      onPhase("pending");
    } else if (cur === postN) {
      onPhase("accepted");
    }
  };
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) {
      return;
    }
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = undefined;
      flush(e.document);
    }, 80);
  });
  return vscode.Disposable.from(
    sub,
    new vscode.Disposable(() => {
      if (debounce) {
        clearTimeout(debounce);
      }
    })
  );
}

async function applyRefactorWithEditorPreview(
  panel: AssistantResultPanel,
  applyCode: string,
  sourceUri: vscode.Uri | undefined,
  targetRange?: vscode.Range
): Promise<void> {
  if (!applyCode.trim()) {
    void vscode.window.showWarningMessage("No refactored code available to apply.");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const targetUri = sourceUri ?? editor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage("Open a file to apply refactored output.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(targetUri);
  const baseText = doc.getText();
  const range = targetRange ?? new vscode.Range(doc.positionAt(0), doc.positionAt(baseText.length));
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  const afterText = baseText.slice(0, start) + applyCode + baseText.slice(end);

  panel.setBusy(true);
  panel.setStatus("Applying in current file...");
  panel.setProgressStep("Streaming refactored lines into editor...");
  try {
    await revealDocumentInEditor(targetUri);
    await streamRefactorApplyInEditor(panel, targetUri, baseText, afterText, start, end, applyCode);
    panel.setStatus("Review block-wise changes in editor and choose Accept/Reject at the bottom.");
    panel.setProgressStep("Waiting for in-editor Accept/Reject...");
    const latestDoc = await vscode.workspace.openTextDocument(targetUri);
    const staleSuppress = suppressReviewStaleFlushForUri(targetUri);
    let choice: FixInEditorChoice;
    try {
      choice = await previewFixInEditorAndWait(latestDoc, baseText, afterText, "Refactor preview");
    } finally {
      staleSuppress.dispose();
    }
    if (choice === "accept") {
      panel.setStatus("Accepted and applied.");
    } else if (choice === "cancelled") {
      panel.setStatus("Stopped — no changes applied.");
    } else {
      panel.setStatus("Rejected — no changes applied.");
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    panel.setStatus("Failed to apply refactor.");
    panel.setError(msg);
    void vscode.window.showErrorMessage(`Could not apply refactor: ${msg}`);
  } finally {
    panel.setBusy(false);
    panel.setProgressStep("Done.");
  }
}

async function streamRefactorApplyInEditor(
  panel: AssistantResultPanel,
  targetUri: vscode.Uri,
  baseText: string,
  afterText: string,
  startOffset: number,
  endOffset: number,
  applyCode: string
): Promise<void> {
  const normalized = applyCode.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const total = Math.max(lines.length, 1);
  const batch = total > 600 ? 10 : total > 250 ? 6 : total > 120 ? 3 : 1;

  for (let i = batch; i <= total; i += batch) {
    const upto = Math.min(i, total);
    const partial = lines.slice(0, upto).join("\n");
    const partialText = baseText.slice(0, startOffset) + partial + baseText.slice(endOffset);
    const partialOk = await applyFullDocumentText(targetUri, partialText);
    if (!partialOk) {
      throw new Error("Editor rejected a partial streaming update.");
    }
    panel.setProgressStep(`Applying in editor... ${upto}/${total} lines`);
    if (upto < total) {
      await delay(10);
    }
  }
  // Ensure exact final content (also covers edge-cases around trailing newline joins).
  const finalOk = await applyFullDocumentText(targetUri, afterText);
  if (!finalOk) {
    throw new Error("Editor rejected the final refactor update.");
  }

  const verifyDoc = await vscode.workspace.openTextDocument(targetUri);
  if (verifyDoc.getText() !== afterText) {
    throw new Error("Final editor content does not match generated refactor output.");
  }
}

async function applyFullDocumentText(targetUri: vscode.Uri, text: string): Promise<boolean> {
  const liveDoc = await vscode.workspace.openTextDocument(targetUri);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(liveDoc.positionAt(0), liveDoc.positionAt(liveDoc.getText().length));
  edit.replace(liveDoc.uri, fullRange, text);
  return vscode.workspace.applyEdit(edit);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
