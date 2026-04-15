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
    .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; min-height: 20px; }
    .status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .wave { display: none; width: 44px; height: 8px; align-items: flex-end; gap: 2px; }
    .wave span { display: block; width: 6px; height: 100%; border-radius: 3px; background: var(--vscode-progressBar-background, #0e70c0); animation: wavePulse 0.9s ease-in-out infinite; }
    .wave span:nth-child(2) { animation-delay: 0.12s; }
    .wave span:nth-child(3) { animation-delay: 0.24s; }
    .wave span:nth-child(4) { animation-delay: 0.36s; }
    .busy .wave { display: inline-flex; }
    @keyframes wavePulse { 0%, 100% { transform: scaleY(0.35); opacity: 0.55; } 50% { transform: scaleY(1); opacity: 1; } }
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
    .content-wrap { padding: 12px; display: grid; gap: 10px; }
    .section { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; background: var(--vscode-editor-background); }
    .section h3 { margin: 0; padding: 8px 10px; font-size: 0.92em; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editor-inactiveSelectionBackground); }
    .section .body { padding: 10px; white-space: pre-wrap; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
    th, td { border: 1px solid var(--vscode-editorWidget-border); padding: 6px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }
    th { background: var(--vscode-editor-inactiveSelectionBackground); }
    .json-pre { max-height: 40vh; }
    .step-line { padding: 8px 10px; font-size: 0.87em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; margin-bottom: 10px; background: var(--vscode-editor-inactiveSelectionBackground); }
    .stream-panel { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
    .stream-panel-head { padding: 8px 12px; font-size: 0.8em; text-transform: uppercase; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .stream-wrap.streaming #stream::after { content: "▋"; opacity: 0.85; margin-left: 2px; animation: streamCaret 1s steps(1, end) infinite; }
    @keyframes streamCaret { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
    #stream { margin: 0; padding: 10px 12px; max-height: 24vh; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; line-height: 1.45; }
    .diff-wrap { max-height: 44vh; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.84em; line-height: 1.35; background: var(--vscode-editor-background); }
    .diff-line { white-space: pre-wrap; word-break: break-word; padding: 1px 8px; border-left: 3px solid transparent; }
    .diff-line.del { background: rgba(255, 80, 80, 0.12); border-left-color: var(--vscode-charts-red, #f14c4c); }
    .diff-line.add { background: rgba(80, 200, 120, 0.12); border-left-color: var(--vscode-charts-green, #3fb950); }
    .diff-line.same { background: var(--vscode-editor-background); }
    .hidden { display: none !important; }
    .err { color: var(--vscode-errorForeground); margin-top: 8px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1 id="title">Assistant result</h1>
  <div id="root">
    <div class="status-row">
      <div class="wave" id="wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div id="status" class="status"></div>
    </div>
  </div>
  <div id="step" class="step-line hidden"></div>
  <div id="meta" class="meta hidden"></div>
  <div id="actions" class="actions hidden">
    <button id="btn-apply" class="primary" type="button" disabled>Apply to current file</button>
    <button id="btn-refine" class="secondary hidden" type="button">Refine output...</button>
    <button id="btn-accept" class="primary hidden" type="button" disabled>Accept refactor</button>
    <button id="btn-reject" class="secondary hidden" type="button" disabled>Reject</button>
  </div>
  <div id="stream-wrap" class="stream-wrap hidden">
    <div class="stream-panel">
      <div class="stream-panel-head">Live response stream</div>
      <pre id="stream" role="log" aria-live="polite"></pre>
    </div>
  </div>
  <div id="diff-panel" class="panel hidden">
    <div class="head">Suggested git diff</div>
    <div id="diff" class="diff-wrap"></div>
  </div>
  <div id="rendered-panel" class="panel hidden">
    <div class="head">Rendered explanation</div>
    <div id="out" class="content-wrap"></div>
  </div>
  <div id="json-panel" class="panel hidden">
    <div class="head">JSON output</div>
    <pre id="json" class="json-pre"></pre>
  </div>
  <div id="err" class="err"></div>
  <script nonce="${nonce}">
    var hasCode = false;
    var reviewMode = false;
    var vscode = acquireVsCodeApi();
    document.getElementById("btn-refine").addEventListener("click", function () {
      vscode.postMessage({ command: "refineRequest" });
    });
    document.getElementById("btn-apply").addEventListener("click", function () {
      if (!hasCode) return;
      vscode.postMessage({ command: "applyCurrent" });
    });
    document.getElementById("btn-accept").addEventListener("click", function () {
      if (!reviewMode) return;
      setDecisionButtons(false);
      vscode.postMessage({ command: "fixDecision", value: "accept" });
    });
    document.getElementById("btn-reject").addEventListener("click", function () {
      if (!reviewMode) return;
      setDecisionButtons(false);
      vscode.postMessage({ command: "fixDecision", value: "reject" });
    });

    function clearEl(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    }

    function addParagraph(root, title, text) {
      if (!text) return;
      var sec = document.createElement("section");
      sec.className = "section";
      var h = document.createElement("h3");
      h.textContent = title;
      var body = document.createElement("div");
      body.className = "body";
      body.textContent = String(text);
      sec.appendChild(h);
      sec.appendChild(body);
      root.appendChild(sec);
    }

    function renderTable(root, title, rows) {
      if (!Array.isArray(rows) || !rows.length) return false;
      var normalized = rows.filter(function (x) { return x && typeof x === "object"; });
      if (!normalized.length) return false;
      var headers = Object.keys(normalized[0]);
      if (!headers.length) return false;

      var sec = document.createElement("section");
      sec.className = "section";
      var h = document.createElement("h3");
      h.textContent = title;
      sec.appendChild(h);

      var body = document.createElement("div");
      body.className = "body";
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var trh = document.createElement("tr");
      headers.forEach(function (header) {
        var th = document.createElement("th");
        th.textContent = header;
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      normalized.forEach(function (rowObj) {
        var tr = document.createElement("tr");
        headers.forEach(function (header) {
          var td = document.createElement("td");
          var value = rowObj[header];
          td.textContent = value == null ? "" : (typeof value === "string" ? value : JSON.stringify(value));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      body.appendChild(table);
      sec.appendChild(body);
      root.appendChild(sec);
      return true;
    }

    function renderStructured(root, data, fallbackText) {
      clearEl(root);
      if (!data || typeof data !== "object") {
        addParagraph(root, "Explanation", fallbackText || "No structured explanation available.");
        return;
      }
      addParagraph(root, "Summary", data.summary || fallbackText || "");

      if (data.inputOutput && typeof data.inputOutput === "object") {
        var ioRows = [];
        ["inputs", "outputs", "sideEffects"].forEach(function (key) {
          var val = data.inputOutput[key];
          if (Array.isArray(val) && val.length) {
            ioRows.push({ section: key, details: val.join("\\n") });
          }
        });
        renderTable(root, "Input / Output", ioRows);
      }

      if (Array.isArray(data.explanation)) {
        data.explanation.forEach(function (item, idx) {
          if (!item || typeof item !== "object") return;
          var sectionTitle = item.section || ("Section " + (idx + 1));
          addParagraph(root, sectionTitle + " - Overview", item.overview || "");
          addParagraph(root, sectionTitle + " - Detailed explanation", item.detailedExplanation || "");
          renderTable(root, sectionTitle + " - Key components", item.keyComponents);
          renderTable(root, sectionTitle + " - Logic flow", item.logicFlow);
          renderTable(root, sectionTitle + " - Algorithms", item.algorithms);
          if (Array.isArray(item.edgeCases) && item.edgeCases.length) {
            addParagraph(root, sectionTitle + " - Edge cases", item.edgeCases.join("\\n"));
          }
          if (item.complexity) {
            addParagraph(root, sectionTitle + " - Complexity", item.complexity);
          }
        });
      }

      renderTable(root, "Examples", data.examples);
      renderTable(root, "Glossary", data.glossary);
      addParagraph(root, "Remarks", data.remarks || "");

      Object.keys(data).forEach(function (key) {
        if (["summary", "inputOutput", "explanation", "examples", "glossary", "remarks"].indexOf(key) >= 0) {
          return;
        }
        var value = data[key];
        if (Array.isArray(value)) {
          if (!renderTable(root, key, value) && value.length) {
            addParagraph(root, key, value.map(function (x) { return String(x); }).join("\\n"));
          }
          return;
        }
        if (typeof value === "string" && value.trim()) {
          addParagraph(root, key, value);
        }
      });
    }

    function renderDiff(parts) {
      var diffRoot = document.getElementById("diff");
      diffRoot.innerHTML = "";
      var hasParts = Array.isArray(parts) && parts.length > 0;
      if (!hasParts) return false;
      parts.forEach(function (p) {
        var line = document.createElement("div");
        var k = p.kind;
        line.className = "diff-line " + (k === "add" ? "add" : k === "remove" ? "del" : "same");
        line.textContent = p.text || "";
        diffRoot.appendChild(line);
      });
      return true;
    }

    function setDecisionButtons(enabled) {
      document.getElementById("btn-accept").disabled = !enabled;
      document.getElementById("btn-reject").disabled = !enabled;
    }

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "title") document.getElementById("title").textContent = m.text || "Assistant result";
      if (m.type === "status") document.getElementById("status").textContent = m.text || "";
      if (m.type === "busy") {
        var root = document.getElementById("root");
        if (m.value) root.classList.add("busy"); else root.classList.remove("busy");
      }
      if (m.type === "step") {
        var step = document.getElementById("step");
        if (m.text) {
          step.textContent = "Step: " + m.text;
          step.classList.remove("hidden");
        } else {
          step.classList.add("hidden");
        }
      }
      if (m.type === "stream") {
        var sw = document.getElementById("stream-wrap");
        var st = document.getElementById("stream");
        if (m.text) {
          sw.classList.remove("hidden");
          sw.classList.add("streaming");
          st.textContent = m.text;
          st.scrollTop = st.scrollHeight;
        } else {
          st.textContent = "";
          sw.classList.add("hidden");
          sw.classList.remove("streaming");
        }
      }
      if (m.type === "result") {
        var meta = document.getElementById("meta");
        var out = document.getElementById("out");
        var json = document.getElementById("json");
        var actions = document.getElementById("actions");
        var renderedPanel = document.getElementById("rendered-panel");
        var jsonPanel = document.getElementById("json-panel");
        var diffPanel = document.getElementById("diff-panel");
        var btnApply = document.getElementById("btn-apply");
        var btnAccept = document.getElementById("btn-accept");
        var btnReject = document.getElementById("btn-reject");
        var btnRefine = document.getElementById("btn-refine");
        var canApply = !!m.hasCode;
        actions.classList.remove("hidden");
        renderedPanel.classList.remove("hidden");
        jsonPanel.classList.remove("hidden");
        meta.innerHTML = "";
        if (m.remarks) {
          var r = document.createElement("div");
          r.className = "remarks";
          r.textContent = m.remarks;
          meta.appendChild(r);
          meta.classList.remove("hidden");
        } else {
          meta.classList.add("hidden");
        }
        renderStructured(out, m.structuredData, m.displayText || "");
        json.textContent = m.jsonText || m.displayText || "";
        hasCode = canApply;
        reviewMode = !!m.reviewMode && hasCode;
        if (reviewMode) {
          btnApply.classList.add("hidden");
          btnRefine.classList.add("hidden");
          btnAccept.classList.remove("hidden");
          btnReject.classList.remove("hidden");
          var hasDiff = renderDiff(m.diffParts);
          if (hasDiff) {
            diffPanel.classList.remove("hidden");
          } else {
            diffPanel.classList.add("hidden");
          }
          setDecisionButtons(hasCode);
        } else {
          if (canApply) {
            btnApply.classList.remove("hidden");
          } else {
            btnApply.classList.add("hidden");
          }
          if (m.endpoint === "codeGeneration") {
            btnRefine.classList.remove("hidden");
          } else {
            btnRefine.classList.add("hidden");
          }
          btnAccept.classList.add("hidden");
          btnReject.classList.add("hidden");
          btnApply.disabled = !canApply;
          setDecisionButtons(false);
          diffPanel.classList.add("hidden");
        }
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
  jsonText?: string;
  structuredData?: Record<string, unknown>;
  reviewMode?: boolean;
  diffParts?: Array<{ kind: "add" | "remove" | "same"; text: string }>;
  endpoint?: string;
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

  setBusy(value: boolean): void {
    void this.panel.webview.postMessage({ type: "busy", value });
  }

  setProgressStep(text: string): void {
    void this.panel.webview.postMessage({ type: "step", text });
  }

  setStreamText(text: string): void {
    void this.panel.webview.postMessage({ type: "stream", text });
  }

  setMode(endpoint: string): void {
    void this.panel.webview.postMessage({ type: "mode", endpoint });
  }

  setResult(payload: AssistantRenderPayload): void {
    void this.panel.webview.postMessage({
      type: "result",
      remarks: payload.remarks,
      displayText: payload.displayText,
      jsonText: payload.jsonText ?? payload.displayText,
      structuredData: payload.structuredData,
      reviewMode: Boolean(payload.reviewMode),
      diffParts: payload.diffParts ?? [],
      endpoint: payload.endpoint,
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

  onFixDecisionRequested(handler: (value: "accept" | "reject") => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((msg: { command?: string; value?: "accept" | "reject" }) => {
      if (msg?.command === "fixDecision" && (msg.value === "accept" || msg.value === "reject")) {
        handler(msg.value);
      }
    });
  }

  onRefineRequested(handler: () => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === "refineRequest") {
        handler();
      }
    });
  }
}
