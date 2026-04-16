import { ensurePythonEnvironment } from "./pythonRunner";
import { CodeReviewViewProvider } from "./codeReviewView";
import { runCodeReview } from "./codeReview";
import { applyFixesFromReview } from "./applyFixes";
import { openAuthWebviewAndAuthenticate } from "./authPanel";
import { runAssistantEndpoint, type AssistantEndpoint } from "./assistantActions";
import { initExtensionLogger, log, showExtensionLogs } from "./logger";
import * as vscode from "vscode";

export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  initExtensionLogger(context);
  log.info("extension", "Code Review extension activated");
  log.info(
    "extension",
    'View logs: menu View → Output, then in the Output dropdown select "Code Review". Or run command: Code Review: Show extension logs.'
  );
  const sidebarProvider = new CodeReviewViewProvider();

  void ensurePythonEnvironment(context).catch((e: Error) => {
    log.error("extension", "Python environment setup failed", { detail: e.message });
    void vscode.window.showErrorMessage(`Code Review: could not set up Python (${e.message}).`);
  });

  const registerAssistantEndpointCommand = (command: string, endpoint: AssistantEndpoint) =>
    vscode.commands.registerCommand(command, () => {
      log.info("command", "Command invoked", { commandId: command, endpoint });
      void runAssistantEndpoint(endpoint);
    });

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
      (mode?: "all" | "one" | "selected", index?: number, extra?: string, indices?: number[]) => {
        log.info("command", "Command invoked", {
          commandId: "codeReview.applyFixes",
          mode: mode ?? "all",
          index: index ?? "",
        });
        void applyFixesFromReview(mode ?? "all", index, extra, indices);
      }
    ),
    vscode.commands.registerCommand("codeReview.authenticate", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.authenticate" });
      void openAuthWebviewAndAuthenticate(context);
    }),
    vscode.commands.registerCommand("codeReview.showLogs", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.showLogs" });
      showExtensionLogs();
    }),
    vscode.commands.registerCommand("codeReview.sidebar.refresh", () => {
      log.info("command", "Command invoked", { commandId: "codeReview.sidebar.refresh" });
      sidebarProvider.refresh();
    })
  );
}

export function deactivate(): void {}
