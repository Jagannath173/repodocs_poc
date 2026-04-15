import { runBenchmark, authenticateCopilot } from "./pythonRunner";
import { RepoDocProvider } from "./repoDocProvider";
import { generateDocumentation, generateFullRepoDocumentation } from "./docGenerator";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";


export let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
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
      } else if (message.command === "authenticate") {
        vscode.commands.executeCommand("internalPythonRunner.authenticateCopilot");
      } else if (message.command === "saveManualToken") {
        context.globalState.update("copilot_access_token_override", message.token);
        vscode.window.showInformationMessage("✅ Access Token saved to context override!");
      }
    });
  };

  // 2. Sidebar Registration
  vscode.window.registerTreeDataProvider("repo-doc-view", new RepoDocProvider());

  // 3. Command Registration
  context.subscriptions.push(
    vscode.commands.registerCommand("internalPythonRunner.showDashboard", showDashboard),
    vscode.commands.registerCommand("internalPythonRunner.runInternalPythonScript", () => triggerBenchmark(context)),
    vscode.commands.registerCommand("internalPythonRunner.generateRepoDoc", generateDocumentation),
    vscode.commands.registerCommand("internalPythonRunner.generateFullRepoDoc", generateFullRepoDocumentation),
    vscode.commands.registerCommand("internalPythonRunner.authenticateCopilot", () => {
        const output = vscode.window.createOutputChannel("Internal Python Runner");
        output.show(true);
        authenticateCopilot(context, (m) => {
            output.appendLine(m);
            dashboardPanel?.webview.postMessage({ type: "log", text: m });
        });
    })
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
