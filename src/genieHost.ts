import * as vscode from "vscode";

const sharedPanels = new Map<string, vscode.WebviewPanel>();

/**
 * Single shared Genie webview host across assistant, review, and auth.
 * Content can be replaced by feature-specific HTML, but editor tab stays one.
 */
export function getOrCreateGeniePanel(
  key = "default",
  viewType = "genieHost",
  column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  options: vscode.WebviewPanelOptions & vscode.WebviewOptions = {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  }
): vscode.WebviewPanel {
  const existing = sharedPanels.get(key);
  if (existing) {
    existing.title = "Genie";
    existing.reveal(column, false);
    return existing;
  }

  const panel = vscode.window.createWebviewPanel(viewType, "Genie", column, options);
  sharedPanels.set(key, panel);
  panel.onDidDispose(() => {
    const current = sharedPanels.get(key);
    if (current === panel) {
      sharedPanels.delete(key);
    }
  });
  return panel;
}

