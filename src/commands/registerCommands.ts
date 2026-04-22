import * as vscode from "vscode";
import { ensurePythonEnvironment } from "../utils/pythonRunner";
import { runCodeReview } from "./review/codeReview";
import { applyFixesFromReview } from "../review/applyFixes";
import { registerFixPreviewCommands } from "../preview/fixInEditorPreview";
import { openAuthWebviewAndAuthenticate } from "./webview/auth_webview/authPanel";
import { runAssistantEndpoint, type AssistantEndpoint } from "./assistant/runAssistantEndpoint";
import { initExtensionLogger, log, showExtensionLogs } from "../utils/logger";
import { CodeReviewSidebarProvider } from "./sidebarCommandRegister/CodeReviewSidebarProvider";
import { registerReviewStaleWatcher } from "../review/reviewStaleWatcher";
import { exportReviewReportToPdf, exportReviewReportToXlsx } from "../review/exportReviewReport";
import { analyzeExtraInstructionForReview, getStoredReview, rejectFindingFromReview } from "../review/applyFixes";
import { getGithubUserProfile } from "../utils/githubUserState";

/**
 * Registers all extension commands, sidebar, and fix-preview handlers.
 * Keeps `extension.ts` as a thin activation entry (similar to Genie-vscode command registration).
 */
export function registerCommands(context: vscode.ExtensionContext): void {
  registerReviewStaleWatcher(context);
  initExtensionLogger(context);
  log.info("extension", "Code Review extension activated");
  log.info(
    "extension",
    'View logs: menu View → Output, then in the Output dropdown select "Code Review". Or run command: Code Review: Show extension logs.'
  );

  const sidebarProvider = new CodeReviewSidebarProvider();

  void ensurePythonEnvironment(context).catch((e: Error) => {
    log.error("extension", "Python environment setup failed", { detail: e.message });
    void vscode.window.showErrorMessage(`Code Review: could not set up Python (${e.message}).`);
  });

  const registerAssistantEndpointCommand = (command: string, endpoint: AssistantEndpoint) =>
    vscode.commands.registerCommand(command, () => {
      log.info("command", "Command invoked", { commandId: command, endpoint });
      void runAssistantEndpoint(endpoint);
    });

  registerFixPreviewCommands(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("code-review-main", sidebarProvider),
    vscode.commands.registerCommand("codeReview.runReview", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.runReview" });
      void runCodeReview();
    }),
    registerAssistantEndpointCommand("codeReview.assistant.codeExplanation", "codeExplanation"),
    registerAssistantEndpointCommand("codeReview.assistant.codeRefactor", "codeRefactor"),
    registerAssistantEndpointCommand("codeReview.assistant.codeGeneration", "codeGeneration"),
    registerAssistantEndpointCommand("codeReview.assistant.unitTest", "unitTest"),
    registerAssistantEndpointCommand("codeReview.assistant.fileWiseUnitTest", "fileWiseUnitTest"),
    registerAssistantEndpointCommand("codeReview.assistant.docstringAddition", "docstringAddition"),
    registerAssistantEndpointCommand("codeReview.assistant.commentAddition", "commentAddition"),
    registerAssistantEndpointCommand("codeReview.assistant.loggingAddition", "loggingAddition"),
    registerAssistantEndpointCommand("codeReview.assistant.errorHandling", "errorHandling"),
    registerAssistantEndpointCommand("codeReview.assistant.testscriptSelfHealing", "testscriptSelfHealing"),
    vscode.commands.registerCommand(
      "codeReview.applyFixes",
      async (mode?: "all" | "one" | "selected", index?: number, extra?: string, indices?: number[]) => {
        log.info("command", "Command invoked", {
          commandId: "codeReview.applyFixes",
          mode: mode ?? "all",
          index: index ?? "",
        });
        return applyFixesFromReview(mode ?? "all", index, extra, indices);
      }
    ),
    vscode.commands.registerCommand("codeReview.analyzeExtraInstruction", (extra?: string) => {
      const text = typeof extra === "string" ? extra : "";
      log.info("command", "Command invoked", {
        commandId: "codeReview.analyzeExtraInstruction",
        extraChars: text.length,
      });
      void analyzeExtraInstructionForReview(text);
    }),
    vscode.commands.registerCommand("codeReview.authenticate", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.authenticate" });
      void openAuthWebviewAndAuthenticate(context);
    }),
    vscode.commands.registerCommand("codeReview.rejectFinding", (index?: number) => {
      if (typeof index !== "number" || index < 0) {
        return;
      }
      log.info("command", "Command invoked", { commandId: "codeReview.rejectFinding", index });
      void rejectFindingFromReview(index);
    }),
    vscode.commands.registerCommand("codeReview.showLogs", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.showLogs" });
      showExtensionLogs();
    }),
    vscode.commands.registerCommand("codeReview.showGithubUser", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.showGithubUser" });
      const p = getGithubUserProfile(context);
      if (!p?.login && !p?.id) {
        void vscode.window.showInformationMessage(
          "No GitHub profile is saved yet. Run “Code Review: Authenticate Copilot”, finish browser sign-in, then run this command again."
        );
        return;
      }
      const bits = [
        p.login ? `@${p.login}` : "",
        p.id ? `id ${p.id}` : "",
        p.name ? p.name : "",
        p.email ? p.email : "",
      ].filter(Boolean);
      void vscode.window.showInformationMessage(`Saved GitHub user: ${bits.join(" · ")}`);
      log.info("command", "showGithubUser profile", { id: p.id, login: p.login, hasName: !!p.name, hasEmail: !!p.email });
    }),
    vscode.commands.registerCommand("codeReview.sidebar.refresh", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.sidebar.refresh" });
      sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("codeReview.exportReviewReport", async (format?: "pdf" | "xlsx") => {
      const stored = getStoredReview();
      if (!stored?.fileName) {
        void vscode.window.showWarningMessage("No review data to export. Run Code Review and apply fixes first.");
        return;
      }
      const f = format === "xlsx" ? "xlsx" : "pdf";
      log.info("command", "exportReviewReport", { format: f });
      if (f === "xlsx") {
        await exportReviewReportToXlsx(stored);
      } else {
        await exportReviewReportToPdf(stored);
      }
    })
  );
}
