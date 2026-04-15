import * as vscode from "vscode";

export class RepoDocProvider implements vscode.TreeDataProvider<RepoItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<RepoItem | undefined | void> = new vscode.EventEmitter<RepoItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RepoItem | undefined | void> = this._onDidChangeTreeData.event;

  getTreeItem(element: RepoItem): vscode.TreeItem {
    return element;
  }

  getChildren(): RepoItem[] {
    return [
      new RepoItem("Login to Copilot", vscode.TreeItemCollapsibleState.None, {
        command: "internalPythonRunner.authenticateCopilot",
        title: "Login"
      }, "key"),
      new RepoItem("Generate Script Overview", vscode.TreeItemCollapsibleState.None, {
        command: "internalPythonRunner.generateRepoDoc",
        title: "Generate Report"
      }, "book"),
      new RepoItem("Generate Full Repo Docs", vscode.TreeItemCollapsibleState.None, {
        command: "internalPythonRunner.generateFullRepoDoc",
        title: "Generate Full Repo"
      }, "repo"),
      new RepoItem("Analyze Script Latency", vscode.TreeItemCollapsibleState.None, {
        command: "internalPythonRunner.runInternalPythonScript",
        title: "Run"
      }, "pulse")
    ];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

export class RepoItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly iconName?: string
  ) {
    super(label, collapsibleState);
    if (iconName) {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }
  }
}
