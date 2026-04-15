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
    :root {
      color-scheme: light dark;
      --panel-radius: 8px;
      --spacing-xs: 6px;
      --spacing-sm: 10px;
      --spacing-md: 14px;
      --spacing-lg: 18px;
    }
    body {
      margin: 0;
      padding: 18px 22px 42px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      line-height: 1.45;
    }
    .wrap { max-width: 980px; margin: 0 auto; }
    h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 var(--spacing-md); }
    .tabs { display: flex; gap: var(--spacing-xs); margin-bottom: var(--spacing-md); }
    .tab-btn {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 7px 12px;
      cursor: pointer;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .tab-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .tab-panel.hidden { display: none !important; }
    .summary {
      margin-bottom: var(--spacing-lg);
      padding: 12px 14px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: var(--panel-radius);
      border: 1px solid var(--vscode-editorWidget-border);
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .section-title { margin: var(--spacing-md) 0 var(--spacing-xs); font-size: 1em; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
    th, td { border: 1px solid var(--vscode-editorWidget-border); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
    tr:nth-child(even) td { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.5; }
    .sev-critical { color: var(--vscode-errorForeground); font-weight: 600; }
    .sev-high { color: var(--vscode-charts-red); font-weight: 600; }
    .sev-medium { color: var(--vscode-charts-orange); }
    .sev-low, .sev-info { color: var(--vscode-descriptionForeground); }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; }
    .hidden { display: none !important; }
    #review-result { min-height: 8px; }
    .apply-toolbar { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); align-items: center; margin-bottom: var(--spacing-md); }
    button.btn-apply, button.btn-row-fix, button.primary, button.secondary {
      cursor: pointer; border: none; border-radius: 4px;
    }
    button.btn-apply, button.btn-row-fix, button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.btn-apply.secondary, button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.btn-apply { padding: 6px 12px; font-size: 0.92em; }
    button.btn-row-fix { padding: 4px 8px; font-size: 0.85em; }
    button.btn-row-fix:disabled, button:disabled { opacity: 0.55; cursor: default; }
    tr.finding-applied { box-shadow: inset 3px 0 0 var(--vscode-charts-green, #3fb950); }
    tr.finding-applied td { opacity: 0.95; }
    .badge-applied { display: inline-block; margin-left: 8px; padding: 1px 8px; font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: middle; }
    .err { color: var(--vscode-errorForeground); white-space: pre-wrap; margin-top: var(--spacing-sm); }
    pre.raw {
      margin-top: var(--spacing-md);
      padding: 12px;
      overflow: auto;
      max-height: 280px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: var(--panel-radius);
      font-size: 0.85em;
    }
    .log-panel {
      border-radius: var(--panel-radius);
      border: 1px solid var(--vscode-editorWidget-border);
      border-left: 3px solid var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground));
      background: var(--vscode-editor-inactiveSelectionBackground);
      overflow: hidden;
      margin-bottom: var(--spacing-sm);
    }
    .log-single {
      margin: 0;
      padding: 10px 12px;
      font-family: var(--vscode-font-family);
      font-size: 0.87em;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-single.info { color: var(--vscode-descriptionForeground); }
    .log-single.success { color: var(--vscode-charts-green, #3fb950); }
    .log-single.warn { color: var(--vscode-charts-orange, #d7ba7d); }
    .log-single.error { color: var(--vscode-errorForeground); }
    .fix-sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: var(--spacing-xs) 0 var(--spacing-sm); }
    .diff-wrap {
      max-height: 42vh;
      overflow: auto;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: var(--panel-radius);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      line-height: 1.35;
    }
    .diff-line { white-space: pre-wrap; word-break: break-word; padding: 1px 8px; border-left: 3px solid transparent; }
    .diff-line.del { background: rgba(255, 80, 80, 0.12); border-left-color: var(--vscode-charts-red, #f14c4c); }
    .diff-line.add { background: rgba(80, 200, 120, 0.12); border-left-color: var(--vscode-charts-green, #3fb950); }
    .diff-line.same { background: var(--vscode-editor-background); }
    .diff-legend { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin: var(--spacing-sm) 0 var(--spacing-xs); }
    .actions { display: flex; gap: var(--spacing-sm); flex-wrap: wrap; margin-top: var(--spacing-md); align-items: center; }
    button.primary, button.secondary { padding: 8px 16px; font-size: 0.95em; }
    .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: var(--spacing-xs); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Code review</h1>
    <div class="tabs">
      <button id="tab-review" class="tab-btn active" type="button">Review</button>
      <button id="tab-fixes" class="tab-btn" type="button">Fixes</button>
    </div>

    <div id="panel-review" class="tab-panel">
      <p id="status" class="loading">Generating structured review…</p>
      <div class="log-panel">
        <div id="review-logs" class="log-single info" role="status" aria-live="polite">Idle</div>
      </div>
      <div id="review-result" style="margin-top:12px"></div>
    </div>

    <div id="panel-fixes" class="tab-panel hidden">
      <div id="fix-header" class="loading">Run Apply fixes to start.</div>
      <div id="fix-sub" class="fix-sub"></div>
      <div class="log-panel">
        <div id="fix-logs" class="log-single info" role="status" aria-live="polite">Idle</div>
      </div>
      <div id="diff-section" class="hidden">
        <div id="diff" class="diff-wrap"></div>
      </div>
      <div id="fix-error" class="err hidden"></div>
      <div class="actions">
        <button type="button" class="primary" id="btn-accept" disabled>Accept &amp; apply to file</button>
        <button type="button" class="secondary" id="btn-reject" disabled>Reject</button>
      </div>
      <p class="hint" id="fix-hint">Diff will appear here before applying changes.</p>
    </div>
  </div>

  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var state = { review: null };
    var choicePending = false;

    function switchTab(tab) {
      var revBtn = document.getElementById("tab-review");
      var fixBtn = document.getElementById("tab-fixes");
      var revPanel = document.getElementById("panel-review");
      var fixPanel = document.getElementById("panel-fixes");
      if (tab === "fixes") {
        fixBtn.classList.add("active");
        revBtn.classList.remove("active");
        fixPanel.classList.remove("hidden");
        revPanel.classList.add("hidden");
      } else {
        revBtn.classList.add("active");
        fixBtn.classList.remove("active");
        revPanel.classList.remove("hidden");
        fixPanel.classList.add("hidden");
      }
    }

    document.getElementById("tab-review").addEventListener("click", function () { switchTab("review"); });
    document.getElementById("tab-fixes").addEventListener("click", function () { switchTab("fixes"); });

    function setStatusLine(id, level, text) {
      var el = document.getElementById(id);
      el.className = "log-single " + (level || "info");
      el.textContent = text || "";
      el.classList.remove("hidden");
    }

    function hideStatusLine(id) {
      document.getElementById(id).classList.add("hidden");
    }

    function sevClass(s) {
      var x = (s || "").toLowerCase();
      if (x === "critical") return "sev-critical";
      if (x === "high") return "sev-high";
      if (x === "medium") return "sev-medium";
      if (x === "low") return "sev-low";
      return "sev-info";
    }

    function renderReview(payload) {
      state.review = payload || { summary: "", findings: [], appliedIndices: [] };
      var data = state.review;
      var findings = Array.isArray(data.findings) ? data.findings : [];
      var applied = Array.isArray(data.appliedIndices) ? data.appliedIndices : [];
      var sections = Array.isArray(data.sections) ? data.sections : [];
      if (!sections.length) {
        sections = [{
          name: "Review",
          summary: data.summary || "(No summary)",
          findings: findings.map(function (f, i) { return Object.assign({ globalIndex: i }, f); })
        }];
      }
      var resultEl = document.getElementById("review-result");
      resultEl.innerHTML = "";

      var toolbar = document.createElement("div");
      toolbar.className = "apply-toolbar";
      var btnAll = document.createElement("button");
      btnAll.type = "button";
      btnAll.className = "btn-apply";
      btnAll.textContent = "Apply all fixes (sequential)";
      btnAll.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "all" }); };
      var btnCmd = document.createElement("button");
      btnCmd.type = "button";
      btnCmd.className = "btn-apply secondary";
      btnCmd.textContent = "Apply with extra instructions…";
      btnCmd.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "all", promptExtra: true }); };
      var btnAuth = document.createElement("button");
      btnAuth.type = "button";
      btnAuth.className = "btn-apply secondary";
      btnAuth.textContent = "Authenticate Copilot";
      btnAuth.title = "Open manual Copilot authentication flow.";
      btnAuth.onclick = function () { vscode.postMessage({ command: "authenticate" }); };
      toolbar.appendChild(btnAll);
      toolbar.appendChild(btnCmd);
      toolbar.appendChild(btnAuth);
      resultEl.appendChild(toolbar);

      sections.forEach(function (section) {
        var heading = document.createElement("h3");
        heading.className = "section-title";
        heading.textContent = section.name || "Review Section";
        resultEl.appendChild(heading);

        var sum = document.createElement("div");
        sum.className = "summary";
        sum.textContent = section.summary || "(No summary)";
        resultEl.appendChild(sum);

        var sectionFindings = Array.isArray(section.findings) ? section.findings : [];
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
        sectionFindings.forEach(function (f, rowIdx) {
          var globalIndex = typeof f.globalIndex === "number" ? f.globalIndex : rowIdx;
          var tr = document.createElement("tr");
          var isApplied = applied.indexOf(globalIndex) >= 0;
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
          bf.disabled = isApplied;
          if (!isApplied) {
            bf.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "one", index: globalIndex }); };
          }
          tdFix.appendChild(bf);
          tr.appendChild(tdFix);
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        resultEl.appendChild(tbl);
      });
    }

    function setFixButtons(enabled) {
      document.getElementById("btn-accept").disabled = !enabled;
      document.getElementById("btn-reject").disabled = !enabled;
      choicePending = enabled;
    }

    document.getElementById("btn-accept").addEventListener("click", function () {
      if (!choicePending) return;
      setFixButtons(false);
      setStatusLine("fix-logs", "success", "Accepted diff, applying edit to file.");
      vscode.postMessage({ command: "choice", value: "accept" });
    });
    document.getElementById("btn-reject").addEventListener("click", function () {
      if (!choicePending) return;
      setFixButtons(false);
      setStatusLine("fix-logs", "warn", "Rejected this fix step.");
      vscode.postMessage({ command: "choice", value: "reject" });
    });

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;

      if (m.type === "loading") {
        document.getElementById("status").classList.remove("hidden");
        document.getElementById("status").textContent = m.message || "Generating structured review…";
        document.getElementById("review-result").innerHTML = "";
        setStatusLine("review-logs", "info", "Review started.");
        switchTab("review");
        return;
      }
      if (m.type === "reviewLog") {
        setStatusLine("review-logs", m.level || "info", m.message || "");
        return;
      }
      if (m.type === "review") {
        document.getElementById("status").classList.add("hidden");
        hideStatusLine("review-logs");
        renderReview(m.payload || {});
        switchTab("review");
        return;
      }
      if (m.type === "error") {
        document.getElementById("status").classList.add("hidden");
        setStatusLine("review-logs", "error", m.message || "Review failed.");
        var resultEl = document.getElementById("review-result");
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

      if (m.type === "fixStart") {
        switchTab("fixes");
        document.getElementById("fix-header").classList.remove("loading");
        document.getElementById("fix-header").textContent = "Apply fix (" + m.step + " / " + m.total + ")";
        document.getElementById("fix-sub").textContent = m.findingTitle || "";
        setStatusLine("fix-logs", "info", "Preparing fix prompt.");
        document.getElementById("diff").innerHTML = "";
        document.getElementById("diff-section").classList.add("hidden");
        document.getElementById("fix-error").classList.add("hidden");
        document.getElementById("fix-error").textContent = "";
        document.getElementById("fix-hint").textContent = "Waiting for model response and diff...";
        setFixButtons(false);
        return;
      }
      if (m.type === "fixLog") {
        setStatusLine("fix-logs", m.level || "info", m.message || "");
        return;
      }
      if (m.type === "fixDiff") {
        var root = document.getElementById("diff");
        root.innerHTML = "";
        var parts = Array.isArray(m.parts) ? m.parts : [];
        parts.forEach(function (p) {
          var line = document.createElement("div");
          var k = p.kind;
          line.className = "diff-line " + (k === "add" ? "add" : k === "remove" ? "del" : "same");
          line.textContent = p.text || "";
          root.appendChild(line);
        });
        document.getElementById("diff-section").classList.remove("hidden");
        document.getElementById("fix-hint").textContent = "Review diff and Accept or Reject.";
        hideStatusLine("fix-logs");
        setFixButtons(true);
        return;
      }
      if (m.type === "fixError") {
        var errEl = document.getElementById("fix-error");
        errEl.textContent = m.message || "Fix failed.";
        errEl.classList.remove("hidden");
        setStatusLine("fix-logs", "error", m.message || "Fix failed.");
        document.getElementById("fix-hint").textContent = "Reject to stop the sequence.";
        setFixButtons(false);
        document.getElementById("btn-reject").disabled = false;
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
  sections?: ReviewSectionPayload[];
  /** Row indices (0-based) whose fixes were accepted and applied. */
  appliedIndices?: number[];
}

export interface ReviewSectionFinding extends ReviewFinding {
  globalIndex: number;
}

export interface ReviewSectionPayload {
  name: string;
  summary: string;
  findings: ReviewSectionFinding[];
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
  private choiceResolver?: (v: "accept" | "reject") => void;
  private latestSections: ReviewSectionPayload[] = [];

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
      this.choiceResolver?.("reject");
    });
  }

  getDocumentUri(): string | undefined {
    return this.documentUri;
  }

  setLoading(message?: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "loading", message: message ?? "Generating structured review…" });
  }

  addReviewLog(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "reviewLog", message, level });
  }

  setReview(payload: ReviewPayload): void {
    if (this.disposed) return;
    this.latestSections = payload.sections ?? [];
    void this.panel.webview.postMessage({
      type: "review",
      payload: {
        summary: payload.summary,
        findings: payload.findings,
        sections: payload.sections ?? [],
        appliedIndices: payload.appliedIndices ?? [],
      },
    });
  }

  /** Refresh the findings table after fixes are applied (badges, disabled Fix). */
  refreshFromStored(stored: ReviewTableState): void {
    if (this.disposed) return;
    const mappedSections = this.latestSections.map((section) => ({
      ...section,
      findings: section.findings.map((f) => {
        const nextFinding = stored.findings[f.globalIndex];
        return {
          ...(nextFinding ?? f),
          globalIndex: f.globalIndex,
        };
      }),
    }));
    void this.panel.webview.postMessage({
      type: "review",
      payload: {
        summary: stored.summary,
        findings: stored.findings,
        sections: mappedSections,
        appliedIndices: stored.appliedIndices ?? [],
      },
    });
  }

  onDispose(callback: () => void): void {
    this.panel.onDidDispose(callback);
  }

  setError(message: string, raw?: string, streamedText?: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "error", message, raw, text: streamedText ?? "" });
  }

  startFixStep(step: number, total: number, findingTitle: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "fixStart", step, total, findingTitle });
  }

  addFixLog(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "fixLog", message, level });
  }

  showFixDiff(parts: Array<{ kind: "add" | "remove" | "same"; text: string }>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "fixDiff", parts });
  }

  showFixError(message: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "fixError", message });
  }

  waitForFixChoice(): Promise<"accept" | "reject"> {
    return new Promise((resolve) => {
      this.choiceResolver = resolve;
    });
  }

  registerOnMessage(handler: (msg: unknown) => void): vscode.Disposable {
    const sub = this.panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { command?: string; value?: "accept" | "reject" };
      if (m?.command === "choice" && (m.value === "accept" || m.value === "reject")) {
        const r = this.choiceResolver;
        this.choiceResolver = undefined;
        r?.(m.value);
      }
      handler(msg);
    });
    this.panel.onDidDispose(() => sub.dispose());
    return sub;
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export function parseReviewJson(raw: string): ReviewPayload {
  const jsonStr = extractFirstJsonObject(raw);
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
      severity: typeof f.severity === "string" ? f.severity : "",
      category: typeof f.category === "string" ? f.category : "",
      title: typeof f.title === "string" ? f.title : "",
      detail: typeof f.detail === "string" ? f.detail : "",
      suggestion: typeof f.suggestion === "string" ? f.suggestion : "",
    };
  });
  return { summary, findings };
}

export function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Model output is empty.");
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const source = fence ? fence[1].trim() : trimmed;
  const start = source.indexOf("{");
  if (start < 0) {
    throw new Error("Could not find JSON object start in model output.");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
      continue;
    }
  }
  throw new Error("JSON object appears incomplete (missing closing brace).");
}
