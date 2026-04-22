import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { cancelAnyActiveFixPreview } from "./preview/fixInEditorPreview";

export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  registerCommands(context);
}

export async function deactivate(): Promise<void> {
  try {
    await cancelAnyActiveFixPreview();
  } catch {
    // best-effort cleanup on host reload/dispose
  }
}
