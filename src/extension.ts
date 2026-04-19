import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";

export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  registerCommands(context);
}

export function deactivate(): void {}
