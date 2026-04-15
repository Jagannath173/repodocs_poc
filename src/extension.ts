import { ensurePythonEnvironment } from "./pythonRunner";
import { CodeReviewViewProvider } from "./codeReviewView";
import { runCodeReview } from "./codeReview";
import { applyFixesFromReview } from "./applyFixes";
import * as vscode from "vscode";

export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  void ensurePythonEnvironment(context).catch((e: Error) => {
    void vscode.window.showErrorMessage(`Code Review: could not set up Python (${e.message}).`);
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("code-review-main", new CodeReviewViewProvider()),
    vscode.commands.registerCommand("codeReview.runReview", () => {
      void runCodeReview();
    }),
    vscode.commands.registerCommand(
      "codeReview.applyFixes",
      (mode?: "all" | "one", index?: number, extra?: string) => {
        void applyFixesFromReview(mode ?? "all", index, extra);
      }
    )
  );
}

export function deactivate(): void {}
