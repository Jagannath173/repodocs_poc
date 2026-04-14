import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { runBenchmark } from "./pythonRunner";
import { RepoDocProvider } from "./repoDocProvider";
import { generateDocumentation } from "./docGenerator";

export function activate(context: vscode.ExtensionContext): void {
  let dashboardPanel: vscode.WebviewPanel | undefined = undefined;

  // 1. Dashboard Management
  const showDashboard = () => {
    if (dashboardPanel) {
      dashboardPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    dashboardPanel = vscode.window.createWebviewPanel("pythonPocDashboard", "Python POC Dashboard", vscode.ViewColumn.One, { enableScripts: true });
    dashboardPanel.webview.html = fs.readFileSync(path.join(context.extensionPath, "media", "dashboard.html"), "utf8");
    dashboardPanel.onDidDispose(() => { dashboardPanel = undefined; });
    dashboardPanel.webview.onDidReceiveMessage(message => {
      if (message.command === "runInternal") { 
        triggerBenchmark(context, dashboardPanel); 
      }
    });
  };

  // 2. Sidebar Registration
  vscode.window.registerTreeDataProvider("repo-doc-view", new RepoDocProvider());

  // 3. Command Registration
  context.subscriptions.push(
    vscode.commands.registerCommand("internalPythonRunner.showDashboard", showDashboard),
    vscode.commands.registerCommand("internalPythonRunner.runInternalPythonScript", () => triggerBenchmark(context)),
    vscode.commands.registerCommand("internalPythonRunner.generateRepoDoc", generateDocumentation)
  );
}

async function triggerBenchmark(context: vscode.ExtensionContext, panel?: vscode.WebviewPanel) {
  const output = vscode.window.createOutputChannel("Internal Python Runner");
  output.show(true);

  try {
    await runBenchmark(context, 
      (text, status) => {
        output.appendLine(text);
        panel?.webview.postMessage({ type: "log", text, status });
      },
      (latency) => {
        panel?.webview.postMessage({ type: "result", latency });
        vscode.window.showInformationMessage(`Benchmark completed in ${latency}ms`);
      }
    );
  } catch (err: any) {
    panel?.webview.postMessage({ type: "error", text: err.message });
  }
}

export function deactivate() {}
