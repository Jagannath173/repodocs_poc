import * as vscode from "vscode";
import { registerReviewPanel, unregisterReviewPanel } from "./reviewBridge";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function reviewTableHtml(webview: vscode.Webview, nonce: string): string {
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
    body {
      margin: 0;
      padding: 16px 20px 40px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
    }
    .wrap { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 8px; }
    .summary {
      margin-bottom: 20px;
      padding: 12px 14px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border);
      line-height: 1.5;
      white-space: pre-wrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92em;
    }
    th, td {
      border: 1px solid var(--vscode-editorWidget-border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: 600;
    }
    tr:nth-child(even) td { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.5; }
    .sev-critical { color: var(--vscode-errorForeground); font-weight: 600; }
    .sev-high { color: var(--vscode-charts-red); font-weight: 600; }
    .sev-medium { color: var(--vscode-charts-orange); }
    .sev-low, .sev-info { color: var(--vscode-descriptionForeground); }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; }
    .hidden { display: none !important; }
    .stream-wrap { margin-bottom: 16px; }
    .stream-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .stream-panel {
      border-radius: 10px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-left: 3px solid var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground));
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      box-shadow: 0 2px 12px rgba(0,0,0,0.07);
      overflow: hidden;
    }
    .stream-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      font-size: 0.8em;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    pre.stream-pre,
    .json-stream {
      margin: 0;
      padding: 14px 16px;
      max-height: 52vh;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 0.87em;
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
    #result { min-height: 8px; }
    .apply-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 14px;
    }
    button.btn-apply {
      padding: 6px 12px;
      font-size: 0.92em;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 4px;
    }
    button.btn-apply.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.btn-row-fix {
      padding: 4px 8px;
      font-size: 0.85em;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 3px;
    }
    button.btn-row-fix:disabled {
      opacity: 0.55;
      cursor: default;
    }
    tr.finding-applied {
      box-shadow: inset 3px 0 0 var(--vscode-charts-green, #3fb950);
    }
    tr.finding-applied td {
      opacity: 0.95;
    }
    .badge-applied {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 8px;
      font-size: 0.78em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      vertical-align: middle;
    }
    .err { color: var(--vscode-errorForeground); white-space: pre-wrap; margin-top: 12px; }
    pre.raw { margin-top: 16px; padding: 12px; overflow: auto; max-height: 280px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 id="title">Code review</h1>
    <div id="main">
      <p id="status" class="loading">Generating structured review…</p>
      <div id="stream-wrap" class="stream-wrap hidden">
        <div class="stream-panel">
          <div class="stream-panel-head">
            <span>Structured output</span>
            <span style="opacity:0.75;font-weight:500">Live · JSON</span>
          </div>
          <div id="stream" class="json-stream" role="log" aria-live="polite" aria-relevant="additions text"></div>
        </div>
      </div>
      <div id="result"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
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
    function sevClass(s) {
      var x = (s || "").toLowerCase();
      if (x === "critical") return "sev-critical";
      if (x === "high") return "sev-high";
      if (x === "medium") return "sev-medium";
      if (x === "low") return "sev-low";
      return "sev-info";
    }
    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;
      var statusEl = document.getElementById("status");
      var streamWrap = document.getElementById("stream-wrap");
      var streamPre = document.getElementById("stream");
      var resultEl = document.getElementById("result");
      if (m.type === "loading") {
        statusEl.classList.remove("hidden");
        statusEl.classList.add("loading");
        statusEl.textContent = m.message || "Generating structured review…";
        streamWrap.classList.add("hidden");
        streamWrap.classList.remove("streaming");
        streamPre.innerHTML = "";
        resultEl.innerHTML = "";
        return;
      }
      if (m.type === "stream") {
        statusEl.classList.add("hidden");
        streamWrap.classList.remove("hidden");
        streamWrap.classList.add("streaming");
        streamPre.innerHTML = highlightJson(m.text || "");
        streamPre.scrollTop = streamPre.scrollHeight;
        return;
      }
      if (m.type === "error") {
        statusEl.classList.add("hidden");
        streamWrap.classList.remove("hidden");
        streamWrap.classList.remove("streaming");
        if (m.text) streamPre.innerHTML = highlightJson(m.text);
        resultEl.innerHTML = "";
        var errDiv = document.createElement("div");
        errDiv.className = "err";
        errDiv.textContent = m.message || "Review failed.";
        resultEl.appendChild(errDiv);
        if (m.raw) {
          var pre = document.createElement("pre");
          pre.className = "raw";
          pre.textContent = m.raw;
          resultEl.appendChild(pre);
        }
        return;
      }
      if (m.type === "review") {
        statusEl.classList.add("hidden");
        streamWrap.classList.add("hidden");
        streamWrap.classList.remove("streaming");
        streamPre.innerHTML = "";
        var data = m.payload || {};
        var findings = Array.isArray(data.findings) ? data.findings : [];
        var applied = Array.isArray(data.appliedIndices) ? data.appliedIndices : [];
        resultEl.innerHTML = "";
        var toolbar = document.createElement("div");
        toolbar.className = "apply-toolbar";
        var btnAll = document.createElement("button");
        btnAll.type = "button";
        btnAll.className = "btn-apply";
        btnAll.textContent = "Apply all fixes (sequential)";
        btnAll.title = "Runs the AI once per finding, in order, updating the file each time.";
        btnAll.onclick = function () {
          vscode.postMessage({ command: "applyFixes", mode: "all" });
        };
        var btnCmd = document.createElement("button");
        btnCmd.type = "button";
        btnCmd.className = "btn-apply secondary";
        btnCmd.textContent = "Apply with extra instructions…";
        btnCmd.onclick = function () {
          vscode.postMessage({ command: "applyFixes", mode: "all", promptExtra: true });
        };
        toolbar.appendChild(btnAll);
        toolbar.appendChild(btnCmd);
        resultEl.appendChild(toolbar);
        var sum = document.createElement("div");
        sum.className = "summary";
        sum.textContent = data.summary || "(No summary)";
        resultEl.appendChild(sum);
        var tbl = document.createElement("table");
        var thead = document.createElement("thead");
        var hr = document.createElement("tr");
        ["Severity", "Category", "Title", "Detail", "Suggestion", "Fix"].forEach(function (h) {
          var th = document.createElement("th");
          th.textContent = h;
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        tbl.appendChild(thead);
        var tb = document.createElement("tbody");
        findings.forEach(function (f, rowIdx) {
          var tr = document.createElement("tr");
          var isApplied = applied.indexOf(rowIdx) >= 0;
          if (isApplied) tr.className = "finding-applied";
          ["severity", "category", "title", "detail", "suggestion"].forEach(function (key) {
            var td = document.createElement("td");
            var v = (f && f[key]) != null ? String(f[key]) : "";
            if (key === "severity") td.className = sevClass(v);
            if (key === "title" && isApplied) {
              td.appendChild(document.createTextNode(v + " "));
              var badge = document.createElement("span");
              badge.className = "badge-applied";
              badge.textContent = "Applied";
              td.appendChild(badge);
            } else {
              td.textContent = v;
            }
            tr.appendChild(td);
          });
          var tdFix = document.createElement("td");
          var bf = document.createElement("button");
          bf.type = "button";
          bf.className = "btn-row-fix";
          bf.textContent = isApplied ? "Applied" : "Fix";
          bf.title = isApplied ? "This suggestion was applied to the file" : "Apply this suggestion only (AI edit)";
          bf.disabled = isApplied;
          if (!isApplied) {
            bf.onclick = function () {
              vscode.postMessage({ command: "applyFixes", mode: "one", index: rowIdx });
            };
          }
          tdFix.appendChild(bf);
          tr.appendChild(tdFix);
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        resultEl.appendChild(tbl);
        if (findings.length === 0) {
          var empty = document.createElement("p");
          empty.className = "loading";
          empty.textContent = "No findings returned.";
          resultEl.appendChild(empty);
        }
      }
    });
  </script>
</body>
</html>`;
}

export interface ReviewFinding {
  severity: string;
  category: string;
  title: string;
  detail: string;
  suggestion: string;
}

export interface ReviewPayload {
  summary: string;
  findings: ReviewFinding[];
  /** Row indices (0-based) whose fixes were accepted and applied. */
  appliedIndices?: number[];
}

/** Persisted review + applied-fix tracking (same shape as workspace state). */
export interface ReviewTableState {
  documentUri: string;
  fileName: string;
  summary: string;
  findings: ReviewFinding[];
  appliedIndices?: number[];
}

export class ReviewWebviewSession {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private streamDebounce: ReturnType<typeof setTimeout> | undefined;
  private latestStreamText = "";

  constructor(
    context: vscode.ExtensionContext,
    title: string,
    private readonly documentUri: string | undefined
  ) {
    registerReviewPanel(this);
    this.panel = vscode.window.createWebviewPanel(
      "codeReviewResult",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    const nonce = getNonce();
    this.panel.webview.html = reviewTableHtml(this.panel.webview, nonce);
    this.panel.onDidDispose(() => {
      unregisterReviewPanel(this);
      this.disposed = true;
      if (this.streamDebounce !== undefined) {
        clearTimeout(this.streamDebounce);
        this.streamDebounce = undefined;
      }
    });
  }

  getDocumentUri(): string | undefined {
    return this.documentUri;
  }

  setLoading(message?: string): void {
    if (this.disposed) {
      return;
    }
    if (this.streamDebounce !== undefined) {
      clearTimeout(this.streamDebounce);
      this.streamDebounce = undefined;
    }
    this.latestStreamText = "";
    void this.panel.webview.postMessage({ type: "loading", message: message ?? "Generating structured review…" });
  }

  /** Push streamed assistant text to the webview (debounced so the UI stays responsive). */
  scheduleStreamText(fullText: string): void {
    this.latestStreamText = fullText;
    if (this.disposed) {
      return;
    }
    if (this.streamDebounce !== undefined) {
      clearTimeout(this.streamDebounce);
    }
    this.streamDebounce = setTimeout(() => this.flushStream(), 28);
  }

  flushStream(): void {
    if (this.streamDebounce !== undefined) {
      clearTimeout(this.streamDebounce);
      this.streamDebounce = undefined;
    }
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({ type: "stream", text: this.latestStreamText });
  }

  setReview(payload: ReviewPayload): void {
    if (this.disposed) {
      return;
    }
    this.flushStream();
    void this.panel.webview.postMessage({
      type: "review",
      payload: {
        summary: payload.summary,
        findings: payload.findings,
        appliedIndices: payload.appliedIndices ?? [],
      },
    });
  }

  /** Refresh the findings table after fixes are applied (badges, disabled Fix). */
  refreshFromStored(stored: ReviewTableState): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({
      type: "review",
      payload: {
        summary: stored.summary,
        findings: stored.findings,
        appliedIndices: stored.appliedIndices ?? [],
      },
    });
  }

  onDispose(callback: () => void): void {
    this.panel.onDidDispose(callback);
  }

  setError(message: string, raw?: string, streamedText?: string): void {
    if (this.disposed) {
      return;
    }
    this.flushStream();
    void this.panel.webview.postMessage({ type: "error", message, raw, text: streamedText ?? this.latestStreamText });
  }

  /** Handle buttons from the review webview (e.g. Apply fixes). */
  registerOnMessage(handler: (msg: unknown) => void): vscode.Disposable {
    const sub = this.panel.webview.onDidReceiveMessage(handler);
    this.panel.onDidDispose(() => sub.dispose());
    return sub;
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export function parseReviewJson(raw: string): ReviewPayload {
  const trimmed = raw.trim();
  const fence = /^[\s\S]*?```(?:json)?\s*([\s\S]*?)```[\s\S]*$/m.exec(trimmed);
  const jsonStr = fence ? fence[1].trim() : trimmed;
  const data = JSON.parse(jsonStr) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Review JSON must be an object.");
  }
  const o = data as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary : "";
  const rawFindings = Array.isArray(o.findings) ? o.findings : [];
  const findings: ReviewFinding[] = rawFindings.map((item) => {
    const f = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      severity: String(f.severity ?? ""),
      category: String(f.category ?? ""),
      title: String(f.title ?? ""),
      detail: String(f.detail ?? ""),
      suggestion: String(f.suggestion ?? ""),
    };
  });
  return { summary, findings };
}
