import * as vscode from "vscode";
import { log } from "../../utils/logger";

/**
 * Sidebar tree for Code Review (Authenticate / Review / Assistant command shortcuts).
 * Mirrors the pattern used in Genie-vscode `sidebarCommandRegister` providers.
 */
export class CodeReviewSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly reviewNode = new vscode.TreeItem("Review", vscode.TreeItemCollapsibleState.Expanded);
  private readonly authNode = new vscode.TreeItem("Authenticate", vscode.TreeItemCollapsibleState.Expanded);
  private readonly assistantNode = new vscode.TreeItem("Assistant", vscode.TreeItemCollapsibleState.Expanded);

  private readonly reviewItems: vscode.TreeItem[] = [
    this.commandItem("Review", "Run structured repository review", "codeReview.runReview", "checklist"),
  ];

  private readonly authItems: vscode.TreeItem[] = [
    this.staticSidebarItem(
      "Login",
      "Placeholder — no action yet. Use Authenticate Copilot to sign in to GitHub Copilot.",
      "key"
    ),
    this.commandItem("Authenticate Copilot", "Sign in to GitHub Copilot (device flow)", "codeReview.authenticate", "account"),
  ];

  private readonly assistantItems: vscode.TreeItem[] = [
    this.commandItem("Code explanation", "Explain current selection", "codeReview.assistant.codeExplanation", "info"),
    this.commandItem("Code refactor", "Refactor selected code", "codeReview.assistant.codeRefactor", "symbol-method"),
    this.commandItem("Code generation", "Generate code from prompt", "codeReview.assistant.codeGeneration", "sparkle"),
    this.commandItem("Unit test", "Create unit tests", "codeReview.assistant.unitTest", "beaker"),
    this.commandItem("File-wise unit test", "Generate tests for current file", "codeReview.assistant.fileWiseUnitTest", "file-code"),
    this.commandItem("Docstring addition", "Add docstrings", "codeReview.assistant.docstringAddition", "symbol-string"),
    this.commandItem("Comment addition", "Add useful comments", "codeReview.assistant.commentAddition", "comment"),
    this.commandItem("Logging addition", "Add logging statements", "codeReview.assistant.loggingAddition", "output"),
    this.commandItem("Error handling", "Improve exception handling", "codeReview.assistant.errorHandling", "warning"),
    this.commandItem("Testscript self healing", "Repair fragile test scripts", "codeReview.assistant.testscriptSelfHealing", "tools"),
  ];

  constructor() {
    const groupIcon = new vscode.ThemeIcon("folder-opened");
    this.reviewNode.iconPath = groupIcon;
    this.authNode.iconPath = groupIcon;
    this.assistantNode.iconPath = groupIcon;
    this.reviewNode.contextValue = "codeReview.group";
    this.authNode.contextValue = "codeReview.group";
    this.assistantNode.contextValue = "codeReview.group";
  }

  refresh(): void {
    log.info("sidebar", "Sidebar tree refreshed");
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve([this.authNode, this.reviewNode, this.assistantNode]);
    }
    if (element === this.reviewNode) {
      return Promise.resolve(this.reviewItems);
    }
    if (element === this.authNode) {
      return Promise.resolve(this.authItems);
    }
    if (element === this.assistantNode) {
      return Promise.resolve(this.assistantItems);
    }
    return Promise.resolve([]);
  }

  private commandItem(label: string, description: string, commandId: string, iconId: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.tooltip = `${label}\n${description}`;
    item.command = { command: commandId, title: label };
    item.iconPath = new vscode.ThemeIcon(iconId);
    item.contextValue = "codeReview.action";
    return item;
  }

  private staticSidebarItem(label: string, description: string, iconId: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.tooltip = `${label}\n${description}`;
    item.iconPath = new vscode.ThemeIcon(iconId);
    item.contextValue = "codeReview.static";
    return item;
  }
}
