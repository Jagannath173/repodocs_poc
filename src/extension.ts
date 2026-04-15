import { ensurePythonEnvironment } from "./pythonRunner";
import { CodeReviewViewProvider } from "./codeReviewView";
import { runCodeReview } from "./codeReview";
import { applyFixesFromReview } from "./applyFixes";
import { openAuthWebviewAndAuthenticate } from "./authPanel";
import { runAssistantEndpoint, type AssistantEndpoint } from "./assistantActions";
import * as vscode from "vscode";

export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const sidebarProvider = new CodeReviewViewProvider();

  void ensurePythonEnvironment(context).catch((e: Error) => {
    void vscode.window.showErrorMessage(`Code Review: could not set up Python (${e.message}).`);
  });

  const registerAssistantEndpointCommand = (command: string, endpoint: AssistantEndpoint) =>
    vscode.commands.registerCommand(command, () => {
      void runAssistantEndpoint(endpoint);
    });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("code-review-main", sidebarProvider),
    vscode.commands.registerCommand("codeReview.runReview", () => {
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
      (mode?: "all" | "one", index?: number, extra?: string) => {
        void applyFixesFromReview(mode ?? "all", index, extra);
      }
    ),
    vscode.commands.registerCommand("codeReview.authenticate", () => {
      void openAuthWebviewAndAuthenticate(context);
    }),
    vscode.commands.registerCommand("codeReview.sidebar.refresh", () => {
      sidebarProvider.refresh();
    })
  );
}

export function deactivate(): void {}
