import * as vscode from "vscode";

/** Empty tree so the sidebar shows only the welcome content with the single Review action. */
export class CodeReviewViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<vscode.TreeItem[]> {
    return Promise.resolve([]);
  }
}
