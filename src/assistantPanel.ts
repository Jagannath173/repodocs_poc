import * as vscode from "vscode";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function panelHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 16px 20px 28px; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); }
    h1 { margin: 0 0 10px; font-size: 1.15em; }
    .status { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 10px; }
    .panel { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
    .head { padding: 8px 12px; font-size: 0.8em; text-transform: uppercase; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .meta { margin-bottom: 10px; }
    .remarks { padding: 10px 12px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; border: 1px solid var(--vscode-editorWidget-border); white-space: pre-wrap; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    button { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    pre { margin: 0; padding: 12px; max-height: 58vh; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; line-height: 1.45; }
    .err { color: var(--vscode-errorForeground); margin-top: 8px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1 id="title">Assistant result</h1>
  <div id="status" class="status"></div>
  <div id="meta" class="meta"></div>
  <div class="actions">
    <button id="btn-apply" class="primary" type="button" disabled>Apply to current file</button>
  </div>
  <div class="panel">
    <div class="head">Structured output</div>
    <pre id="out"></pre>
  </div>
  <div id="err" class="err"></div>
  <script nonce="${nonce}">
    var hasCode = false;
    document.getElementById("btn-apply").addEventListener("click", function () {
      if (!hasCode) return;
      vscode.postMessage({ command: "applyCurrent" });
    });

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "title") document.getElementById("title").textContent = m.text || "Assistant result";
      if (m.type === "status") document.getElementById("status").textContent = m.text || "";
      if (m.type === "result") {
        var meta = document.getElementById("meta");
        var out = document.getElementById("out");
        meta.innerHTML = "";
        if (m.remarks) {
          var r = document.createElement("div");
          r.className = "remarks";
          r.textContent = m.remarks;
          meta.appendChild(r);
        }
        out.textContent = m.displayText || "";
        hasCode = !!m.hasCode;
        document.getElementById("btn-apply").disabled = !hasCode;
      }
      if (m.type === "error") document.getElementById("err").textContent = m.text || "";
    });
  </script>
</body>
</html>`;
}

export interface AssistantRenderPayload {
  remarks: string;
  displayText: string;
  applyCode?: string;
}

export class AssistantResultPanel {
  private readonly panel: vscode.WebviewPanel;
  constructor(context: vscode.ExtensionContext, title: string) {
    this.panel = vscode.window.createWebviewPanel("assistantResult", title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const nonce = getNonce();
    this.panel.webview.html = panelHtml(this.panel.webview, nonce);
    void this.panel.webview.postMessage({ type: "title", text: title });
  }

  setStatus(text: string): void {
    void this.panel.webview.postMessage({ type: "status", text });
  }

  setResult(payload: AssistantRenderPayload): void {
    void this.panel.webview.postMessage({
      type: "result",
      remarks: payload.remarks,
      displayText: payload.displayText,
      hasCode: Boolean(payload.applyCode?.trim()),
    });
  }

  setError(text: string): void {
    void this.panel.webview.postMessage({ type: "error", text });
  }

  onApplyRequested(handler: () => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === "applyCurrent") {
        handler();
      }
    });
  }
}
