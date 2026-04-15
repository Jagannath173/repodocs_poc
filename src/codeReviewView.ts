import * as vscode from "vscode";

export class CodeReviewViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly coreNode = new vscode.TreeItem("Core Actions", vscode.TreeItemCollapsibleState.Expanded);
  private readonly assistantNode = new vscode.TreeItem("Assistant Actions", vscode.TreeItemCollapsibleState.Expanded);

  private readonly coreItems: vscode.TreeItem[] = [
    this.commandItem("Review", "Run structured repository review", "codeReview.runReview", "checklist"),
    this.commandItem("Apply fixes", "Apply generated fixes to file", "codeReview.applyFixes", "wand"),
    this.commandItem("Authenticate Copilot", "Sign in and refresh token", "codeReview.authenticate", "account"),
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
    this.coreNode.iconPath = new vscode.ThemeIcon("folder-opened");
    this.assistantNode.iconPath = new vscode.ThemeIcon("folder-opened");
    this.coreNode.contextValue = "codeReview.group";
    this.assistantNode.contextValue = "codeReview.group";
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve([this.coreNode, this.assistantNode]);
    }
    if (element === this.coreNode) {
      return Promise.resolve(this.coreItems);
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
}
