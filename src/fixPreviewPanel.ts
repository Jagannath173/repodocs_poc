import * as vscode from "vscode";
import { diffLines } from "diff";
import { buildWebviewCsp } from "./webviewCsp";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function buildHtml(webview: vscode.Webview, nonce: string): string {
  const csp = buildWebviewCsp(webview, nonce);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    :root { color-scheme: light dark; }
    html, body {
      min-height: 100%;
      background-color: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #cccccc);
    }
    body {
      margin: 0;
      padding: 16px 20px 32px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      max-width: 920px;
      margin-left: auto;
      margin-right: auto;
    }
    h1 { font-size: 1.15em; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.02em; }
    .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; line-height: 1.4; }
    section { margin-bottom: 20px; }
    section h2 {
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 10px;
    }
    .stream-panel {
      border-radius: 10px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-left: 3px solid var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground));
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    .stream-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      font-size: 0.78em;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .stream-panel-head span:last-child { opacity: 0.75; font-weight: 500; }
    .json-stream {
      margin: 0;
      padding: 14px 16px;
      max-height: 30vh;
      min-height: 120px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 0.85em;
      line-height: 1.6;
      letter-spacing: 0.01em;
      tab-size: 2;
    }
    .stream-wrap.streaming .json-stream::after {
      content: "";
      display: inline-block;
      width: 0.5ch;
      height: 1.15em;
      margin-left: 2px;
      vertical-align: text-bottom;
      background: var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground));
      animation: streamCaret 1s steps(1, end) infinite;
    }
    @keyframes streamCaret {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    .json-stream .jk { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .json-stream .js { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .json-stream .jn { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
    .json-stream .jb { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
    .json-stream .jp { color: var(--vscode-debugTokenExpression-name, #d4d4d4); }
    .diff-wrap {
      max-height: 42vh;
      overflow: auto;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      line-height: 1.35;
    }
    .diff-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 1px 8px;
      border-left: 3px solid transparent;
    }
    .diff-line.del {
      background: rgba(255, 80, 80, 0.12);
      border-left-color: var(--vscode-charts-red, #f14c4c);
    }
    .diff-line.add {
      background: rgba(80, 200, 120, 0.12);
      border-left-color: var(--vscode-charts-green, #3fb950);
    }
    .diff-line.same {
      background: var(--vscode-editor-background);
    }
    .diff-legend { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
      align-items: center;
    }
    button {
      padding: 8px 16px;
      font-size: 0.95em;
      cursor: pointer;
      border: none;
      border-radius: 4px;
    }
    button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .err { color: var(--vscode-errorForeground); white-space: pre-wrap; margin-top: 8px; }
    .hidden { display: none !important; }
    .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  </style>
</head>
<body>
  <h1 id="hdr">Apply fix</h1>
  <div class="sub" id="sub"></div>

  <section>
    <h2>Live model output</h2>
    <div id="stream-wrap" class="stream-wrap">
      <div class="stream-panel">
        <div class="stream-panel-head">
          <span>Response stream</span>
          <span style="opacity:0.75;font-weight:500">Live · JSON</span>
        </div>
        <div id="stream" class="json-stream" role="log" aria-live="polite"></div>
      </div>
    </div>
  </section>

  <section id="diff-section" class="hidden">
    <h2>Change preview</h2>
    <div class="diff-legend">Red = removed · Green = added · Unmarked = unchanged context</div>
    <div id="diff" class="diff-wrap"></div>
  </section>

  <div id="err" class="err hidden"></div>

  <div class="actions">
    <button type="button" class="primary" id="btn-accept" disabled>Accept &amp; apply to file</button>
    <button type="button" class="secondary" id="btn-reject" disabled>Reject</button>
  </div>
  <p class="hint" id="hint">Wait for the diff to appear, then accept or reject.</p>

  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var btnAccept = document.getElementById("btn-accept");
    var btnReject = document.getElementById("btn-reject");
    var hint = document.getElementById("hint");

    function escapeHtml(t) {
      return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }
    function highlightJson(text) {
      if (!text) return "";
      var s = escapeHtml(text);
      s = s.replace(/"((?:[^"\\\\]|\\\\.)*)"\s*:/g, '<span class="jk">"$1"</span><span class="jp">:</span>');
      s = s.replace(/:\s*"((?:[^"\\\\]|\\\\.)*)"/g, ': <span class="js">"$1"</span>');
      s = s.replace(/:\s*(true|false|null)\b/g, ': <span class="jb">$1</span>');
      s = s.replace(/:\s*(-?\\d+\\.?\\d*(?:[eE][+\\-]?\\d+)?)/g, ': <span class="jn">$1</span>');
      return s;
    }

    function setButtons(enabled) {
      btnAccept.disabled = !enabled;
      btnReject.disabled = !enabled;
      hint.textContent = enabled
        ? "Accept applies this change to the file. Reject skips this fix."
        : "Wait for the diff to appear, then accept or reject.";
    }

    btnAccept.addEventListener("click", function () {
      setButtons(false);
      vscode.postMessage({ command: "choice", value: "accept" });
    });
    btnReject.addEventListener("click", function () {
      setButtons(false);
      vscode.postMessage({ command: "choice", value: "reject" });
    });

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;

      if (m.type === "step") {
        document.getElementById("hdr").textContent = "Apply fix (" + m.step + " / " + m.total + ")";
        document.getElementById("sub").textContent = m.findingTitle || "";
        document.getElementById("stream-wrap").classList.remove("streaming");
        document.getElementById("stream").innerHTML = "";
        document.getElementById("diff").innerHTML = "";
        document.getElementById("diff-section").classList.add("hidden");
        document.getElementById("err").classList.add("hidden");
        document.getElementById("err").textContent = "";
        setButtons(false);
        return;
      }
      if (m.type === "stream") {
        document.getElementById("stream-wrap").classList.add("streaming");
        var el = document.getElementById("stream");
        el.innerHTML = highlightJson(m.text || "");
        el.scrollTop = el.scrollHeight;
        return;
      }
      if (m.type === "diff") {
        var root = document.getElementById("diff");
        root.innerHTML = "";
        var parts = m.parts || [];
        parts.forEach(function (p) {
          var line = document.createElement("div");
          var k = p.kind;
          line.className = "diff-line " + (k === "add" ? "add" : k === "remove" ? "del" : "same");
          line.textContent = p.text || "";
          root.appendChild(line);
        });
        document.getElementById("diff-section").classList.remove("hidden");
        document.getElementById("stream-wrap").classList.remove("streaming");
        setButtons(true);
        return;
      }
      if (m.type === "error") {
        document.getElementById("stream-wrap").classList.remove("streaming");
        var errEl = document.getElementById("err");
        errEl.textContent = m.message || "Error";
        errEl.classList.remove("hidden");
        btnAccept.disabled = true;
        btnReject.disabled = false;
        hint.textContent = "Reject stops the fix sequence. Fix the issue and run Apply fixes again if needed.";
        return;
      }
    });
  </script>
</body>
</html>`;
}

export type FixChoice = "accept" | "reject";

export class FixPreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private streamDebounce: ReturnType<typeof setTimeout> | undefined;
  private latestStream = "";
  private choiceResolver?: (v: FixChoice) => void;

  constructor(context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      "codeReviewFixPreview",
      "Apply fix — preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );
    const nonce = getNonce();
    this.panel.webview.html = buildHtml(this.panel.webview, nonce);
    this.panel.webview.onDidReceiveMessage((msg: { command?: string; value?: FixChoice }) => {
      if (msg?.command === "choice" && (msg.value === "accept" || msg.value === "reject")) {
        const r = this.choiceResolver;
        this.choiceResolver = undefined;
        r?.(msg.value);
      }
    });
    this.panel.onDidDispose(() => {
      if (this.streamDebounce !== undefined) {
        clearTimeout(this.streamDebounce);
      }
      this.choiceResolver?.("reject");
    });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  startStep(step: number, total: number, findingTitle: string): void {
    void this.panel.webview.postMessage({ type: "step", step, total, findingTitle });
    this.latestStream = "";
  }

  scheduleStreamText(fullText: string): void {
    this.latestStream = fullText;
    if (this.streamDebounce !== undefined) {
      clearTimeout(this.streamDebounce);
    }
    this.streamDebounce = setTimeout(() => this.flushStream(), 32);
  }

  flushStream(): void {
    if (this.streamDebounce !== undefined) {
      clearTimeout(this.streamDebounce);
      this.streamDebounce = undefined;
    }
    void this.panel.webview.postMessage({ type: "stream", text: this.latestStream });
  }

  showDiff(before: string, after: string): void {
    const parts = diffLines(before, after);
    const serialized: { kind: "add" | "remove" | "same"; text: string }[] = [];
    for (const p of parts) {
      const kind: "add" | "remove" | "same" = p.added ? "add" : p.removed ? "remove" : "same";
      const value = p.value;
      const lines = value.split(/\r?\n/);
      const last = lines.length - 1;
      for (let i = 0; i <= last; i++) {
        const segment = i < last ? `${lines[i]}\n` : lines[i];
        const prefix = kind === "add" ? "+ " : kind === "remove" ? "- " : "  ";
        serialized.push({ kind, text: prefix + segment });
      }
    }
    void this.panel.webview.postMessage({ type: "diff", parts: serialized });
  }

  showError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  /** After showing diff or error (with reject-only path). */
  waitForChoice(): Promise<FixChoice> {
    return new Promise((resolve) => {
      this.choiceResolver = resolve;
    });
  }

  dispose(): void {
    this.panel.dispose();
  }
}
