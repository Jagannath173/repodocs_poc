(function () {
  'use strict';
  var vscode;
  try {
    vscode = acquireVsCodeApi();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:16px;font-family:system-ui;color:#f14c4c;">Genie could not start (webview API). Run <b>Developer: Reload Window</b>.</p>';
    return;
  }
  var sessions = {};
  var sessionOrder = [];
  var activeSessionId = "";
  var restoringState = false;
  var generatedFiles = [];
  var renderedPanelEl = document.getElementById("rendered-panel");
  var explainToggleBtn = document.getElementById("explain-toggle");
  var tabsEl = document.getElementById("session-tabs");
  if (!renderedPanelEl || !explainToggleBtn || !tabsEl) {
    document.body.innerHTML = '<p style="padding:16px;font-family:system-ui;color:#f14c4c;">Genie UI failed to load (missing DOM). Reload the window.</p>';
    return;
  }
  function resetReviewFixMenu(el) {
    if (!el) return;
    el.classList.remove("is-open");
    el.hidden = true;
    el.removeAttribute("style");
    var c = el.parentElement && el.parentElement.querySelector(".review-fix-pill-caret");
    if (c) c.setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest(".review-fix-unified-pill")) return;
    document.querySelectorAll(".review-fix-pill-menu.is-open").forEach(function (el) {
      resetReviewFixMenu(el);
    });
  });
  function closeAllReviewFixMenus() {
    document.querySelectorAll(".review-fix-pill-menu.is-open").forEach(function (el) {
      resetReviewFixMenu(el);
    });
  }
  window.addEventListener("scroll", closeAllReviewFixMenus, true);
  window.addEventListener("resize", closeAllReviewFixMenus);
  function persistUiState() {
    if (restoringState) return;
    try {
      vscode.setState({
        sessions: sessions,
        sessionOrder: sessionOrder,
        activeSessionId: activeSessionId,
      });
    } catch (e) {
      // ignore persistence errors
    }
  }
  function restoreUiStateIfAvailable() {
    try {
      var st = vscode.getState ? vscode.getState() : null;
      if (!st || typeof st !== "object") return false;
      var ss = st.sessions && typeof st.sessions === "object" ? st.sessions : null;
      var so = Array.isArray(st.sessionOrder) ? st.sessionOrder : [];
      var aid = typeof st.activeSessionId === "string" ? st.activeSessionId : "";
      if (!ss || !so.length) return false;
      restoringState = true;
      sessions = ss;
      sessionOrder = so.filter(function (id) { return !!sessions[id]; });
      activeSessionId = aid && sessions[aid] ? aid : (sessionOrder[sessionOrder.length - 1] || "");
      renderTabs();
      if (activeSessionId) renderSession();
      else renderEmptyState();
      restoringState = false;
      return true;
    } catch (e) {
      restoringState = false;
      return false;
    }
  }

    function newSession(title) {
      return {
        title: title || "Assistant result",
        status: "",
        busy: false,
        step: "",
        userQuestion: "",
        err: "",
        endpoint: "",
        hasCode: false,
        reviewMode: false,
        fixDecisionPhase: "pending",
        remarks: "",
        structuredData: null,
        displayText: "",
        generatedCode: "",
        generatedFiles: [],
        diffParts: [],
        explainOpen: true,
        streamOpen: false,
        streamLive: false,
        streamText: "",
        refinePromptMode: false,
        applyFixesExtraMode: false,
        extraFixInstructions: "",
        authUrl: "",
        authCode: "",
        fixApplyingIndex: null,
        fixApplyingAll: false,
        reviewFixDetailsOpen: false,
        reviewReportOnly: false,
        applyingCurrent: false,
        refactorCode: "",
      };
    }

    function clearEl(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }
    function formatHeadingLabel(text) {
      var raw = text == null ? "" : String(text);
      var normalized = raw
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "";
      return normalized
        .split(" ")
        .map(function (word) {
          if (!word) return "";
          if (/^[A-Z0-9]{2,5}$/.test(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(" ");
    }
    function addParagraph(root, title, text) {
      if (!text) return;
      var sec = document.createElement("section");
      sec.className = "section";
      var h = document.createElement("h3");
      h.textContent = formatHeadingLabel(title);
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
      h.textContent = formatHeadingLabel(title);
      sec.appendChild(h);
      var body = document.createElement("div");
      body.className = "body";
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var trh = document.createElement("tr");
      headers.forEach(function (header) {
        var th = document.createElement("th");
        th.textContent = formatHeadingLabel(header);
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
    function omitGeneratedCodeForExplanation(data, endpoint) {
      if (endpoint !== "codeGeneration" || !data || typeof data !== "object") return data;
      var skip = { generatedCode: 1, remarks: 1, summary: 1, delivery: 1 };
      var o = {};
      Object.keys(data).forEach(function (k) {
        if (!skip[k]) o[k] = data[k];
      });
      return o;
    }
    function omitRefactorApplyCode(data, endpoint) {
      if (endpoint !== "codeRefactor" || !data || typeof data !== "object") return data;
      var o = {};
      Object.keys(data).forEach(function (k) {
        if (k === "refactoredCode") return;
        o[k] = data[k];
      });
      return o;
    }
    function renderCodeRefactorExplanation(root, view, fallbackText) {
      var hero = document.createElement("div");
      hero.className = "refactor-hero";
      var ht = document.createElement("div");
      ht.className = "refactor-hero-title";
      ht.textContent = "Refactor overview";
      hero.appendChild(ht);
      if (view.quality) {
        var q = document.createElement("div");
        q.className = "refactor-quality";
        q.textContent = "Quality: " + view.quality;
        hero.appendChild(q);
      }
      var sum = document.createElement("div");
      sum.className = "refactor-hero-summary";
      sum.textContent = view.summary || fallbackText || "";
      hero.appendChild(sum);
      root.appendChild(hero);
      if (view.details && String(view.details).trim()) {
        var det = document.createElement("div");
        det.className = "refactor-body";
        det.textContent = String(view.details);
        root.appendChild(det);
      }
      if (Array.isArray(view.suggestedChanges) && view.suggestedChanges.length) {
        var ul = document.createElement("ul");
        ul.className = "refactor-suggestions";
        view.suggestedChanges.forEach(function (sc) {
          if (!sc || typeof sc !== "object") return;
          var li = document.createElement("li");
          var bits = [];
          if (sc.area) bits.push(String(sc.area));
          if (sc.issue) bits.push(String(sc.issue));
          if (sc.suggestion) bits.push(String(sc.suggestion));
          li.textContent = bits.filter(Boolean).join(" — ");
          ul.appendChild(li);
        });
        root.appendChild(ul);
      }
      var remarks = view.remarks || "";
      if (String(remarks).trim()) {
        var rm = document.createElement("div");
        rm.className = "refactor-remarks";
        rm.textContent = remarks;
        root.appendChild(rm);
      }
      if (Array.isArray(view.validationChecklist) && view.validationChecklist.length) {
        var vc = document.createElement("ul");
        vc.className = "refactor-checklist";
        view.validationChecklist.forEach(function (x) {
          var li = document.createElement("li");
          li.textContent = String(x);
          vc.appendChild(li);
        });
        root.appendChild(vc);
      }
    }
    function renderStructured(root, data, fallbackText, endpoint, session) {
      clearEl(root);
      var view = omitRefactorApplyCode(omitGeneratedCodeForExplanation(data, endpoint), endpoint);
      if (endpoint === "codeReview") {
        renderCodeReview(root, view, fallbackText, session);
        return;
      }
      if (endpoint === "codeRefactor" && view && typeof view === "object") {
        renderCodeRefactorExplanation(root, view, fallbackText);
        return;
      }
      if (!view || typeof view !== "object") {
        if (endpoint !== "codeGeneration" && fallbackText && String(fallbackText).trim()) {
          addParagraph(root, "Explanation", fallbackText);
        }
        return;
      }
      if (endpoint !== "codeGeneration") addParagraph(root, "Summary", view.summary || fallbackText || "");
      if (view.inputOutput && typeof view.inputOutput === "object") {
        var ioRows = [];
        ["inputs", "outputs", "sideEffects"].forEach(function (key) {
          var val = view.inputOutput[key];
          if (Array.isArray(val) && val.length) ioRows.push({ section: key, details: val.join("\\n") });
        });
        renderTable(root, "Input / Output", ioRows);
      }
      if (Array.isArray(view.explanation)) {
        view.explanation.forEach(function (item, idx) {
          if (!item || typeof item !== "object") return;
          var sectionTitle = item.section || ("Section " + (idx + 1));
          addParagraph(root, sectionTitle + " - Overview", item.overview || "");
          addParagraph(root, sectionTitle + " - Detailed explanation", item.detailedExplanation || "");
          renderTable(root, sectionTitle + " - Key components", item.keyComponents);
          renderTable(root, sectionTitle + " - Logic flow", item.logicFlow);
          renderTable(root, sectionTitle + " - Algorithms", item.algorithms);
          if (Array.isArray(item.edgeCases) && item.edgeCases.length) addParagraph(root, sectionTitle + " - Edge cases", item.edgeCases.join("\\n"));
          if (item.complexity) addParagraph(root, sectionTitle + " - Complexity", item.complexity);
        });
      }
      renderTable(root, "Examples", view.examples);
      renderTable(root, "Glossary", view.glossary);
      addParagraph(root, "Remarks", view.remarks || "");
      Object.keys(view).forEach(function (key) {
        if (["summary", "inputOutput", "explanation", "examples", "glossary", "remarks"].indexOf(key) >= 0) return;
        var value = view[key];
        if (Array.isArray(value)) {
          if (!renderTable(root, key, value) && value.length) addParagraph(root, key, value.map(function (x) { return String(x); }).join("\\n"));
          return;
        }
        if (typeof value === "string" && value.trim()) addParagraph(root, key, value);
      });
    }
    function issueDescriptionOnly(f) {
      var detail = String(f.detail || "");
      var head = detail.split(/\\n\\nCode:/i)[0].trim();
      return head || "—";
    }
    /** Turn JSON-looking strings into readable prose for the in-panel report (not monospace JSON dumps). */
    function humanizeReviewReportField(raw) {
      var s = String(raw == null ? "" : raw).trim();
      if (!s) {
        return "—";
      }
      var t = s.replace(/^\uFEFF/, "");
      if (
        (t.charAt(0) === "{" && t.charAt(t.length - 1) === "}") ||
        (t.charAt(0) === "[" && t.charAt(t.length - 1) === "]")
      ) {
        try {
          return jsonValueToReadableReportText(JSON.parse(t));
        } catch (err) {
          return s;
        }
      }
      return s;
    }
    function jsonValueToReadableReportText(v, depth) {
      depth = depth || 0;
      var pad = depth ? new Array(depth + 1).join("  ") : "";
      if (v === null || v === undefined) {
        return pad + "—";
      }
      if (typeof v === "string") {
        return pad + v;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        return pad + String(v);
      }
      if (Array.isArray(v)) {
        return v
          .map(function (item, i) {
            var inner = jsonValueToReadableReportText(item, depth + 1);
            return pad + (i + 1) + ") " + String(inner).replace(/^\s+/, "");
          })
          .join("\n\n");
      }
      if (typeof v === "object") {
        return Object.keys(v)
          .map(function (k) {
            var label = String(k).replace(/_/g, " ");
            var sub = v[k];
            if (sub !== null && typeof sub === "object") {
              return pad + label + ":\n" + jsonValueToReadableReportText(sub, depth + 1);
            }
            return pad + label + ": " + String(sub);
          })
          .join("\n\n");
      }
      return pad + String(v);
    }
    function appendReportFieldBody(block, labelText, rawText) {
      var sub = document.createElement("div");
      sub.className = "review-fix-detail-label";
      sub.textContent = labelText;
      block.appendChild(sub);
      var body = document.createElement("div");
      body.className = "review-fix-detail-body";
      var raw = String(rawText == null ? "" : rawText);
      body.textContent = humanizeReviewReportField(raw);
      if (
        labelText === "Suggested fix" &&
        (raw.indexOf("\n") >= 0 || /(^|\n)---\s/.test(raw) || /^\s*[\+\-]/.test(raw))
      ) {
        body.classList.add("review-fix-detail-body--mono");
      }
      block.appendChild(body);
    }
    function renderSuggestedFixContent(cell, text) {
      var raw = String(text || "").trim();
      if (!raw) {
        cell.textContent = "—";
        return;
      }
      var lines = raw.split(/\r?\n/);
      var hasDiffLike = lines.some(function (line) {
        var t = String(line || "").trimStart();
        return t.startsWith("+") || t.startsWith("-");
      });
      if (!hasDiffLike) {
        // Avoid false coloring when the model returns plain prose.
        // Only explicit +/- diff lines are colorized.
        cell.textContent = raw;
        return;
      }
      var pendingDelete = null;
      lines.forEach(function (line) {
        var t = String(line || "");
        var trimmed = t.trimStart();
        var isAdd = trimmed.startsWith("+");
        var isDel = trimmed.startsWith("-");
        if (isDel) {
          pendingDelete = t;
          return;
        }
        if (isAdd && pendingDelete != null) {
          var lnDel = document.createElement("div");
          lnDel.className = "suggestion-line del";
          lnDel.textContent = pendingDelete || " ";
          cell.appendChild(lnDel);
          var lnAdd = document.createElement("div");
          lnAdd.className = "suggestion-line add";
          lnAdd.textContent = t || " ";
          cell.appendChild(lnAdd);
          pendingDelete = null;
          return;
        }
        if (pendingDelete != null) {
          var loneDel = document.createElement("div");
          loneDel.className = "suggestion-line del";
          loneDel.textContent = pendingDelete || " ";
          cell.appendChild(loneDel);
          pendingDelete = null;
        }
        var ln = document.createElement("div");
        ln.className = "suggestion-line";
        if (isAdd) ln.classList.add("add");
        else ln.classList.add("same");
        ln.textContent = t || " ";
        cell.appendChild(ln);
      });
      if (pendingDelete != null) {
        var tailDel = document.createElement("div");
        tailDel.className = "suggestion-line del";
        tailDel.textContent = pendingDelete || " ";
        cell.appendChild(tailDel);
      }
    }
    function hasRenderableReviewContent(data) {
      if (!data || typeof data !== "object") return false;
      var findings = Array.isArray(data.findings) ? data.findings.length : 0;
      var sections = Array.isArray(data.sections) ? data.sections : [];
      var sectionFindings = 0;
      for (var i = 0; i < sections.length; i++) {
        var f = sections[i] && Array.isArray(sections[i].findings) ? sections[i].findings.length : 0;
        sectionFindings += f;
      }
      return findings > 0 || sectionFindings > 0;
    }
    function sevClass(sev) {
      var x = String(sev || "").toLowerCase();
      if (x === "critical") return "sev-critical";
      if (x === "high") return "sev-high";
      if (x === "medium") return "sev-medium";
      if (x === "low") return "sev-low";
      return "sev-info";
    }
    /** Count findings from flat list or sections (whichever reflects the review). */
    function countFindingsInView(view) {
      if (!view || typeof view !== "object") return 0;
      var flat = Array.isArray(view.findings) ? view.findings.length : 0;
      var sections = Array.isArray(view.sections) ? view.sections : [];
      var fromSections = 0;
      for (var si = 0; si < sections.length; si++) {
        var sec = sections[si];
        var findings = sec && Array.isArray(sec.findings) ? sec.findings : [];
        fromSections += findings.length;
      }
      return Math.max(flat, fromSections);
    }
    /** Unique finding indices represented by current response rows (sections first, then flat fallback). */
    function collectVisibleFindingIndices(view) {
      var out = [];
      if (!view || typeof view !== "object") return out;
      var seen = {};
      var sections = Array.isArray(view.sections) ? view.sections : [];
      var usedSections = false;
      for (var si = 0; si < sections.length; si++) {
        var sec = sections[si];
        var findings = sec && Array.isArray(sec.findings) ? sec.findings : [];
        if (!findings.length) continue;
        usedSections = true;
        for (var fi = 0; fi < findings.length; fi++) {
          var f = findings[fi] || {};
          var idx = typeof f.globalIndex === "number" ? f.globalIndex : fi;
          var key = String(idx);
          if (!seen[key]) {
            seen[key] = true;
            out.push(idx);
          }
        }
      }
      if (usedSections) return out;
      var flat = Array.isArray(view.findings) ? view.findings : [];
      for (var i = 0; i < flat.length; i++) {
        var key2 = String(i);
        if (!seen[key2]) {
          seen[key2] = true;
          out.push(i);
        }
      }
      return out;
    }
    /**
     * Total / applied / rejected / pending.
     * With visible findings rows, compute all values from those exact rows so the bar always matches
     * what's shown in the response tables. Key-count fallback is only for empty-row states.
     */
    function computeReviewMetrics(view) {
      if (!view || typeof view !== "object") {
        return { total: 0, applied: 0, rejected: 0, pending: 0 };
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var appliedKeys = Array.isArray(view.appliedFindingKeys) ? view.appliedFindingKeys : [];
      var rejectedKeys = Array.isArray(view.rejectedFindingKeys) ? view.rejectedFindingKeys : [];
      var visibleIndices = collectVisibleFindingIndices(view);
      if (visibleIndices.length > 0) {
        var appliedVisible = 0;
        var rejectedVisible = 0;
        for (var vi = 0; vi < visibleIndices.length; vi++) {
          var idx2 = visibleIndices[vi];
          if (applied.indexOf(idx2) >= 0) appliedVisible += 1;
          else if (rejected.indexOf(idx2) >= 0) rejectedVisible += 1;
        }
        return {
          total: visibleIndices.length,
          applied: appliedVisible,
          rejected: rejectedVisible,
          pending: Math.max(0, visibleIndices.length - appliedVisible - rejectedVisible),
        };
      }
      var appliedKeyCount = Array.isArray(view.appliedFindingKeys) ? view.appliedFindingKeys.length : 0;
      var rejectedKeyCount = Array.isArray(view.rejectedFindingKeys) ? view.rejectedFindingKeys.length : 0;
      var nFromView = countFindingsInView(view);
      var appliedOnly = Math.max(applied.length, appliedKeyCount);
      var rejectedOnly = Math.max(rejected.length, rejectedKeyCount);
      var declared =
        typeof view.totalFindingsCount === "number" && !isNaN(view.totalFindingsCount)
          ? Math.max(0, Math.floor(view.totalFindingsCount))
          : typeof view.reviewFindingCount === "number" && !isNaN(view.reviewFindingCount)
            ? Math.max(0, Math.floor(view.reviewFindingCount))
            : -1;
      var floorFromFixState = appliedOnly + rejectedOnly;
      var totalOnly =
        declared >= 0
          ? Math.max(declared, nFromView, floorFromFixState)
          : Math.max(nFromView, floorFromFixState);
      var pendingOnly = Math.max(0, totalOnly - appliedOnly - rejectedOnly);
      return { total: totalOnly, applied: appliedOnly, rejected: rejectedOnly, pending: pendingOnly };
    }
    function isReviewCaughtUpOnly(view) {
      if (!view || typeof view !== "object") {
        return false;
      }
      var m = computeReviewMetrics(view);
      // Enter "caught up only" mode whenever all tracked findings are accepted.
      // This keeps the green card stable when reopening the same file/tab.
      return m.total > 0 && m.pending === 0 && m.rejected === 0 && m.applied >= m.total;
    }
    function renderCodeReview(root, view, fallbackText, session) {
      if (!view || typeof view !== "object") {
        return;
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var appliedKeys = Array.isArray(view.appliedFindingKeys) ? view.appliedFindingKeys : [];
      var rejectedKeys = Array.isArray(view.rejectedFindingKeys) ? view.rejectedFindingKeys : [];
      var reviewStillRunning = !!(session && (session.busy || session.streamLive));
      var applyingIndex = session && session.fixApplyingIndex != null ? session.fixApplyingIndex : null;
      var applyingAll = !!(session && session.fixApplyingAll);
      var fixRunInProgress = applyingAll || applyingIndex !== null;
      function buildReportActions(options) {
        var includeViewFull = !!(options && options.includeViewFull);
        var alignRight = !!(options && options.alignRight);
        var row = document.createElement("div");
        row.className = "review-report-actions-btns";
        if (alignRight) {
          row.classList.add("review-report-actions-btns-corner");
        }
        if (includeViewFull) {
          var btnFull = document.createElement("button");
          btnFull.type = "button";
          btnFull.className = "primary";
          btnFull.textContent = "View full report";
          btnFull.title = "Open full report in a new Genie tab.";
          btnFull.onclick = function () {
            vscode.postMessage({
              command: "openReviewReportTab",
              sessionId: activeSessionId,
              view: view
            });
          };
          row.appendChild(btnFull);
        }
        var btnPdf = document.createElement("button");
        btnPdf.type = "button";
        btnPdf.className = "secondary";
        btnPdf.textContent = "Download PDF";
        btnPdf.title = "Save a PDF copy to disk.";
        btnPdf.onclick = function () {
          vscode.postMessage({ command: "exportReviewReport", format: "pdf" });
        };
        var btnXlsx = document.createElement("button");
        btnXlsx.type = "button";
        btnXlsx.className = "secondary";
        btnXlsx.textContent = "Download Excel";
        btnXlsx.title = "Save an Excel workbook to disk.";
        btnXlsx.onclick = function () {
          vscode.postMessage({ command: "exportReviewReport", format: "xlsx" });
        };
        row.appendChild(btnPdf);
        row.appendChild(btnXlsx);
        return row;
      }
      function buildReviewSummaryCard() {
        var box = document.createElement("div");
        box.className = "review-summary-card";
        var title = document.createElement("p");
        title.className = "review-summary-title";
        title.textContent = "Review summary";
        box.appendChild(title);
        var sub = document.createElement("p");
        sub.className = "review-summary-sub";
        sub.textContent =
          "Use View full report to open the complete tables and accepted fix details in a new Genie tab.";
        box.appendChild(sub);
        var m = computeReviewMetrics(view);
        var chips = document.createElement("div");
        chips.className = "review-complete-metrics";
        [
          "Total findings: " + m.total,
          "Fixed (Accepted): " + m.applied,
          "Rejected: " + m.rejected,
          "Still open: " + m.pending
        ].forEach(function (label) {
          var chip = document.createElement("span");
          chip.className = "review-complete-chip";
          chip.textContent = label;
          chips.appendChild(chip);
        });
        box.appendChild(chips);
        box.appendChild(buildReportActions({ includeViewFull: true, alignRight: true }));
        return box;
      }
      function buildCaughtUpDetails() {
        var details = document.createElement("div");
        details.className = "review-fix-details";
        var heading = document.createElement("h3");
        heading.className = "review-report-title";
        heading.textContent = "Review report";
        details.appendChild(heading);

        var summary = document.createElement("p");
        summary.className = "review-report-summary";
        summary.textContent = (typeof view.summary === "string" && view.summary.trim()) ? view.summary.trim() : "Combined review details.";
        details.appendChild(summary);

        var metrics = computeReviewMetrics(view);
        var bullets = document.createElement("ul");
        bullets.className = "review-report-bullets";
        [
          "Total findings: " + metrics.total,
          "Fixed (Accepted): " + metrics.applied,
          "Rejected: " + metrics.rejected,
          "Still open: " + metrics.pending
        ].forEach(function (txt) {
          var li = document.createElement("li");
          li.textContent = txt;
          bullets.appendChild(li);
        });
        details.appendChild(bullets);
        if (metrics.total === 0 && metrics.pending === 0) {
          var noneP = document.createElement("p");
          noneP.className = "review-report-summary";
          noneP.textContent =
            "The latest review did not report any open findings for this file. Use Download PDF/Excel if you need a file copy of this summary.";
          details.appendChild(noneP);
        }

        function statusForIndex(idx) {
          if (applied.indexOf(idx) >= 0) return "Accepted";
          if (rejected.indexOf(idx) >= 0) return "Rejected";
          return "Open";
        }
        function normalizeKeyPart(v) {
          return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
        }
        function legacyFindingKey(item) {
          return [
            normalizeKeyPart(item && item.title),
            normalizeKeyPart(item && item.category),
            normalizeKeyPart(item && item.severity),
            normalizeKeyPart(reportSuggestedFix(item)),
          ].join("|");
        }
        function stableFindingKey(item) {
          var base = legacyFindingKey(item);
          var d = normalizeKeyPart(item && item.detail).slice(0, 96);
          return d ? base + "|" + d : base;
        }
        function statusForItem(item, idx) {
          if (applied.indexOf(idx) >= 0) return "Accepted";
          if (rejected.indexOf(idx) >= 0) return "Rejected";
          var st = stableFindingKey(item || {});
          var lg = legacyFindingKey(item || {});
          if (appliedKeys.some(function (k) { return k === st || k === lg; })) return "Accepted";
          if (rejectedKeys.some(function (k) { return k === st || k === lg; })) return "Rejected";
          return "Open";
        }

        function reportSuggestedFix(item, fallback) {
          var it = item && typeof item === "object" ? item : {};
          var value =
            String(it.suggestion || "").trim() ||
            String(it.fix || "").trim() ||
            String(it.remediation || "").trim() ||
            String(it.recommendation || "").trim() ||
            String(it.unifiedDiff || "").trim() ||
            String(fallback || "").trim();
          return value || "—";
        }

        function compactTextForHeading(text) {
          return String(text || "")
            .replace(/```[\s\S]*?```/g, " ")
            .replace(/\s+/g, " ")
            .replace(/^[\s:;,\-]+|[\s:;,\-]+$/g, "")
            .trim();
        }

        function looksLikeCodeSnippet(s) {
          var t = String(s || "").trim();
          if (!t) return false;
          if (t.length > 110) return true;
          if (/[{}]/.test(t) && t.split(/\s+/).length < 14) return true;
          if (/\b(const|let|var|function|def|import|export|await|async|=>)\b/.test(t)) return true;
          if (/\.(on|stderr|stdout)\s*\(/.test(t)) return true;
          return false;
        }

        function proseBeforeCodeBlock(detail) {
          var head = String(detail || "").split(/\n\nCode:/i)[0].trim();
          return compactTextForHeading(head);
        }

        function truncateToWords(s, maxWords) {
          var words = String(s || "")
            .trim()
            .split(/\s+/)
            .filter(function (w) {
              return !!w;
            });
          if (!words.length) return "";
          if (words.length <= maxWords) return words.join(" ");
          return words.slice(0, maxWords).join(" ") + "…";
        }

        /** Short label for report cards (≤10 words): prefer finding title / prose, not raw code. */
        function shortHeadingFromRecord(r) {
          var title = compactTextForHeading(r && r.title);
          var detailProse = proseBeforeCodeBlock(r && r.detail);
          var sug = compactTextForHeading(r && r.suggestion);
          var cand = "";
          if (title && !looksLikeCodeSnippet(title)) {
            cand = title;
          } else if (detailProse && !looksLikeCodeSnippet(detailProse)) {
            cand = detailProse;
          } else if (title) {
            cand = title;
          } else if (detailProse) {
            cand = detailProse;
          } else if (sug && !looksLikeCodeSnippet(sug) && sug.length < 100) {
            cand = sug;
          } else if (sug) {
            cand = truncateToWords(sug.split(/[;{}]/)[0] || sug, 10);
          } else {
            cand = "Accepted fix";
          }
          cand = truncateToWords(cand, 10);
          return cand || "Accepted fix";
        }

        function pushSectionTable(title, findings, summaryText) {
          if (!Array.isArray(findings) || !findings.length) return;
          var h = document.createElement("h4");
          h.className = "review-report-section-title";
          h.textContent = title;
          details.appendChild(h);
          if (summaryText && String(summaryText).trim()) {
            var secSum = document.createElement("p");
            secSum.className = "review-report-section-summary";
            secSum.textContent = String(summaryText).trim();
            details.appendChild(secSum);
          }

          var wrap = document.createElement("div");
          wrap.className = "review-report-table-wrap";
          var table = document.createElement("table");
          table.className = "review-report-table";
          var thead = document.createElement("thead");
          var headRow = document.createElement("tr");
          ["#", "Severity", "Description", "Suggested fix", "Status"].forEach(function (label) {
            var th = document.createElement("th");
            th.textContent = label;
            headRow.appendChild(th);
          });
          thead.appendChild(headRow);
          table.appendChild(thead);
          var tbody = document.createElement("tbody");
          findings.forEach(function (f, i) {
            var item = f && typeof f === "object" ? f : {};
            var idx = typeof item.globalIndex === "number" ? item.globalIndex : i;
            var tr = document.createElement("tr");
            [
              String(i + 1),
              String(item.severity || "—"),
              humanizeReviewReportField(issueDescriptionOnly(item)),
              humanizeReviewReportField(reportSuggestedFix(item)),
              statusForItem(item, idx),
            ].forEach(function (text) {
              var td = document.createElement("td");
              td.textContent = text;
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          wrap.appendChild(table);
          details.appendChild(wrap);
        }

        var sections = Array.isArray(view.sections) ? view.sections : [];
        var renderedSection = false;
        sections.forEach(function (sec, si) {
          if (!sec || typeof sec !== "object") return;
          var findings = Array.isArray(sec.findings) ? sec.findings : [];
          if (!findings.length) return;
          renderedSection = true;
          pushSectionTable(sec.name || ("Section " + (si + 1)), findings, sec.summary || "");
        });
        if (!renderedSection) {
          var flat = Array.isArray(view.findings) ? view.findings : [];
          if (flat.length) {
            pushSectionTable("Findings", flat);
          }
        }
        if (!renderedSection) {
          var emptyActioned = document.createElement("p");
          emptyActioned.className = "review-report-summary";
          emptyActioned.textContent = "No actioned findings yet. Accepted/Rejected rows will appear here.";
          details.appendChild(emptyActioned);
        }

        var records = Array.isArray(view.appliedFixRecords) ? view.appliedFixRecords : [];
        if (records.length) {
          var acceptedHeading = document.createElement("h4");
          acceptedHeading.className = "review-report-section-title";
          acceptedHeading.textContent = "Accepted fix details";
          details.appendChild(acceptedHeading);
        }
        records.forEach(function (rec) {
          var r = rec && typeof rec === "object" ? rec : {};
          if (r.isDemo) {
            return;
          }
          var idx = typeof r.findingIndex === "number" ? r.findingIndex : -1;
          var fromTable = idx >= 0 && Array.isArray(view.findings) ? view.findings[idx] : null;
          var detailSrc =
            fromTable && fromTable.detail != null && String(fromTable.detail).trim()
              ? fromTable.detail
              : r.detail;
          var suggestionForTitle =
            fromTable && fromTable.suggestion != null && String(fromTable.suggestion).trim()
              ? String(fromTable.suggestion).trim()
              : String(r.suggestion || "").trim();
          var suggestedFixBody = reportSuggestedFix(
            { suggestion: suggestionForTitle, unifiedDiff: r.unifiedDiff },
            suggestionForTitle
          );
          var block = document.createElement("div");
          block.className = "review-fix-detail-block";
          var h2 = document.createElement("div");
          h2.className = "review-fix-detail-title";
          h2.textContent = shortHeadingFromRecord({
            title: (fromTable && fromTable.title) || r.title,
            detail: detailSrc,
            suggestion: suggestionForTitle,
          });
          block.appendChild(h2);
          appendReportFieldBody(block, "Description", issueDescriptionOnly({ detail: detailSrc }));
          appendReportFieldBody(block, "Suggested fix", suggestedFixBody);
          details.appendChild(block);
        });
        return details;
      }
      if (session && session.reviewReportOnly) {
        clearEl(root);
        var reportWrap = document.createElement("div");
        reportWrap.className = "review-complete-only-wrap";
        var reportCard = document.createElement("div");
        reportCard.className = "review-complete-card review-report-only-card";
        var reportTitle = document.createElement("p");
        reportTitle.className = "review-complete-title";
        reportTitle.textContent = "Full review report";
        reportCard.appendChild(reportTitle);
        var reportSub = document.createElement("p");
        reportSub.className = "review-complete-sub";
        reportSub.textContent = "Detailed report snapshot in this Genie tab.";
        reportCard.appendChild(reportSub);
        var reportDetails = buildCaughtUpDetails();
        if (reportDetails) {
          reportCard.appendChild(reportDetails);
        }
        reportCard.appendChild(buildReportActions({ includeViewFull: false, alignRight: true }));
        reportWrap.appendChild(reportCard);
        root.appendChild(reportWrap);
        return;
      }
      if (!reviewStillRunning && isReviewCaughtUpOnly(view)) {
        clearEl(root);

        var onlyWrap = document.createElement("div");
        onlyWrap.className = "review-complete-only-wrap";

        var doneCard = buildReviewSummaryCard();
        onlyWrap.appendChild(doneCard);
        root.appendChild(onlyWrap);
        return;
      }

      var rm = computeReviewMetrics(view);
      var visibleCount = collectVisibleFindingIndices(view).length;

      var toolbar = document.createElement("div");
      toolbar.className = "review-fix-toolbar";
      var btnAll = document.createElement("button");
      btnAll.type = "button";
      btnAll.className = "primary" + (applyingAll ? " is-applying" : "");
      if (applyingAll) {
        btnAll.disabled = true;
        btnAll.innerHTML = "";
        var spAll = document.createElement("span");
        spAll.className = "spinner";
        btnAll.appendChild(spAll);
        btnAll.appendChild(document.createTextNode(" Applying..."));
      } else if (applyingIndex !== null) {
        btnAll.disabled = true;
        btnAll.textContent = "Fix All One by One";
      } else {
        btnAll.textContent = "Fix All One by One";
        btnAll.onclick = function () {
          if (rm.pending <= 0) {
            vscode.postMessage({
              command: "showInfoToast",
              sessionId: activeSessionId,
              value: "All fixes are already applied."
            });
            return;
          }
          vscode.postMessage({ command: "applyFixes", mode: "all", sessionId: activeSessionId });
          var sess = sessions[activeSessionId];
          if (sess) {
            // Optimistic UI: mark all open rows as applying immediately for bulk run.
            sess.fixApplyingAll = true;
            sess.fixApplyingIndex = null;
            try {
              renderSession();
            } catch (e) {
              // do not block command dispatch
            }
          }
        };
      }
      var btnExtra = document.createElement("button");
      btnExtra.type = "button";
      btnExtra.className = "secondary";
      btnExtra.textContent = "Apply with extra instructions...";
      btnExtra.disabled = fixRunInProgress;
      if (!fixRunInProgress) {
        btnExtra.onclick = function () {
          var s = sessions[activeSessionId];
          if (!s) return;
          s.applyFixesExtraMode = true;
          s.err = "";
          renderSession();
          focusPromptComposerAndScrollTop();
        };
      }
      toolbar.appendChild(btnAll);
      toolbar.appendChild(btnExtra);
      var btnStopReview = document.createElement("button");
      btnStopReview.type = "button";
      btnStopReview.className = "secondary";
      btnStopReview.textContent = "⏹ Stop";
      var stopAvailable = reviewStillRunning || fixRunInProgress;
      btnStopReview.disabled = false;
      btnStopReview.onclick = function () {
        if (stopAvailable) {
          vscode.postMessage({ command: "stopReview", sessionId: activeSessionId });
          return;
        }
        vscode.postMessage({
          command: "showInfoToast",
          sessionId: activeSessionId,
          value: "All fixes are already applied."
        });
      };
      toolbar.appendChild(btnStopReview);
      root.appendChild(toolbar);

      var metricsBar = document.createElement("div");
      metricsBar.className = "review-metrics-bar";
      metricsBar.setAttribute("role", "status");
      if (reviewStillRunning && visibleCount === 0) {
        metricsBar.textContent = "Review in progress — findings will appear once each stage returns results.";
      } else {
        metricsBar.textContent =
          rm.total +
          " finding(s) in review · " +
          rm.applied +
          " fixed · " +
          rm.rejected +
          " rejected · " +
          rm.pending +
          " still open";
      }
      root.appendChild(metricsBar);
      var fallbackGlobalIndex = 0;
      function renderFindingTable(sectionLabel, findings) {
        if (!Array.isArray(findings) || !findings.length) return;
        var wrap = document.createElement("div");
        wrap.className = "review-table-wrap";
        var table = document.createElement("table");
        table.className = "review-findings-table";
        var thead = document.createElement("thead");
        var hr = document.createElement("tr");
        [["#", "col-num-h"], ["Severity", ""], ["Description", ""], ["Suggested fix", ""], ["Action", ""]].forEach(function (pair) {
          var th = document.createElement("th");
          th.textContent = pair[0];
          if (pair[1]) th.className = pair[1];
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement("tbody");
        var rowNum = 0;
        findings.forEach(function (f) {
          var item = f && typeof f === "object" ? f : {};
          var globalIndex = typeof item.globalIndex === "number" ? item.globalIndex : fallbackGlobalIndex;
          fallbackGlobalIndex += 1;
          var isApplied = applied.indexOf(globalIndex) >= 0;
          var isRejected = !isApplied && rejected.indexOf(globalIndex) >= 0;
          rowNum += 1;
          var tr = document.createElement("tr");
          tr.setAttribute("data-global-index", String(globalIndex));
          if (isApplied) {
            tr.className = "row-applied";
          } else if (isRejected) {
            tr.className = "row-rejected";
          }
          var tdNum = document.createElement("td");
          tdNum.className = "col-num";
          tdNum.textContent = String(rowNum);
          tr.appendChild(tdNum);
          var tdSev = document.createElement("td");
          var sevText = String(item.severity || "");
          tdSev.className = sevClass(sevText);
          tdSev.textContent = sevText || "—";
          tr.appendChild(tdSev);
          var tdDesc = document.createElement("td");
          tdDesc.className = isApplied ? "col-description col-description-applied" : "";
          tdDesc.textContent = humanizeReviewReportField(issueDescriptionOnly(item));
          tr.appendChild(tdDesc);
          var tdSug = document.createElement("td");
          var sugText = String(item.suggestion || "").trim();
          tdSug.className = isApplied ? "col-suggestion col-suggestion-applied" : "col-suggestion";
          renderSuggestedFixContent(tdSug, humanizeReviewReportField(sugText || "—"));
          tr.appendChild(tdSug);
          var tdFix = document.createElement("td");
          tdFix.className = "col-fix";
          if (isApplied) {
            var spA = document.createElement("span");
            spA.className = "review-status-accepted review-fix-status-pill";
            spA.textContent = "Accepted";
            tdFix.appendChild(spA);
          } else if (isRejected) {
            var spR = document.createElement("span");
            spR.className = "review-status-rejected review-fix-status-pill";
            spR.textContent = "Rejected";
            tdFix.appendChild(spR);
          } else {
            var rowPending = !isApplied && !isRejected;
            var showApplying = applyingAll
              ? rowPending
              : applyingIndex !== null && applyingIndex === globalIndex;
            var fixRowLocked = applyingAll
              ? rowPending
              : applyingIndex !== null && applyingIndex !== globalIndex;
            var primaryClasses = "primary review-fix-btn";
            if (showApplying) {
              tr.setAttribute("data-applying-row", "1");
              var fixBtn = document.createElement("button");
              fixBtn.type = "button";
              fixBtn.className = primaryClasses + " is-applying";
              fixBtn.disabled = true;
              fixBtn.innerHTML = "";
              var sp = document.createElement("span");
              sp.className = "spinner";
              fixBtn.appendChild(sp);
              fixBtn.appendChild(document.createTextNode(" Applying..."));
              tdFix.appendChild(fixBtn);
            } else {
              var disableRowFix = !!fixRowLocked;
              var wrap = document.createElement("div");
              wrap.className = "review-fix-unified-pill";
              wrap.setAttribute("role", "group");
              wrap.setAttribute("aria-label", "Accept or reject this finding");
              var btnMain = document.createElement("button");
              btnMain.type = "button";
              btnMain.className = "review-fix-pill-main";
              btnMain.textContent = "Accept";
              btnMain.title = "Apply this fix to the file";
              var btnCaret = document.createElement("button");
              btnCaret.type = "button";
              btnCaret.className = "review-fix-pill-caret";
              btnCaret.setAttribute("aria-label", "Open Accept or Reject menu");
              btnCaret.setAttribute("aria-haspopup", "menu");
              btnCaret.setAttribute("aria-expanded", "false");
              btnCaret.innerHTML =
                '<svg class="review-fix-pill-caret-svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4.25 6.5 8 10.25 11.75 6.5z"/></svg>';
              var menu = document.createElement("div");
              menu.className = "review-fix-pill-menu";
              menu.setAttribute("role", "menu");
              menu.hidden = true;
              var menuItemAcc = document.createElement("button");
              menuItemAcc.type = "button";
              menuItemAcc.className = "review-fix-pill-menu-item";
              menuItemAcc.setAttribute("role", "menuitem");
              menuItemAcc.textContent = "Accept";
              var menuItemRej = document.createElement("button");
              menuItemRej.type = "button";
              menuItemRej.className = "review-fix-pill-menu-item review-fix-pill-menu-item-reject";
              menuItemRej.setAttribute("role", "menuitem");
              menuItemRej.textContent = "Reject";
              menu.appendChild(menuItemAcc);
              menu.appendChild(menuItemRej);
              wrap.appendChild(btnMain);
              wrap.appendChild(btnCaret);
              wrap.appendChild(menu);
              if (disableRowFix) {
                btnMain.disabled = true;
                btnCaret.disabled = true;
                menuItemAcc.disabled = true;
                menuItemRej.disabled = true;
              }
              if (!disableRowFix) {
                (function (idx, menuEl, caretEl, wrapEl) {
                  function closeMenu() {
                    resetReviewFixMenu(menuEl);
                  }
                  function openMenu() {
                    document.querySelectorAll(".review-fix-pill-menu.is-open").forEach(function (el) {
                      if (el !== menuEl) {
                        resetReviewFixMenu(el);
                      }
                    });
                    menuEl.hidden = false;
                    menuEl.classList.add("is-open");
                    caretEl.setAttribute("aria-expanded", "true");
                    function place() {
                      var r = wrapEl.getBoundingClientRect();
                      var w = Math.max(r.width, 128);
                      menuEl.style.position = "fixed";
                      menuEl.style.left = r.left + "px";
                      menuEl.style.top = r.bottom + 4 + "px";
                      menuEl.style.width = w + "px";
                      menuEl.style.zIndex = "100000";
                      menuEl.style.boxSizing = "border-box";
                    }
                    place();
                    requestAnimationFrame(place);
                  }
                  function fireAccept() {
                    var docEl = document.scrollingElement || document.documentElement || document.body;
                    var prevTop = docEl ? docEl.scrollTop : 0;
                    var sess = sessions[activeSessionId];
                    vscode.postMessage({
                      command: "applyFixes",
                      mode: "one",
                      index: idx,
                      sessionId: activeSessionId,
                      extraInstructions: sess && sess.extraFixInstructions ? String(sess.extraFixInstructions) : ""
                    });
                    if (sess) {
                      sess.fixApplyingIndex = idx;
                      sess.fixApplyingAll = false;
                    }
                    try {
                      renderSession();
                      requestAnimationFrame(function () {
                        if (docEl) docEl.scrollTop = prevTop;
                      });
                    } catch (e) {
                      // do not block command dispatch
                    }
                  }
                  function fireReject() {
                    vscode.postMessage({
                      command: "rejectFinding",
                      index: idx,
                      sessionId: activeSessionId
                    });
                  }
                  btnMain.onclick = function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                    fireAccept();
                  };
                  caretEl.onclick = function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    if (menuEl.classList.contains("is-open")) {
                      closeMenu();
                    } else {
                      openMenu();
                    }
                  };
                  menuItemAcc.onclick = function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                    fireAccept();
                  };
                  menuItemRej.onclick = function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                    fireReject();
                  };
                })(globalIndex, menu, btnCaret, wrap);
              }
              tdFix.appendChild(wrap);
            }
          }
          tr.appendChild(tdFix);
          tbody.appendChild(tr);
        });
        if (!tbody.children.length) return;
        table.appendChild(tbody);
        wrap.appendChild(table);
        if (sectionLabel) {
          var sn = document.createElement("h3");
          sn.className = "review-section-heading";
          sn.textContent = sectionLabel;
          root.appendChild(sn);
        }
        root.appendChild(wrap);
      }

      var sections = Array.isArray(view.sections) ? view.sections : [];
      var renderedAnySection = false;
      sections.forEach(function (sec, idx) {
        if (!sec || typeof sec !== "object") return;
        var sectionName = sec.name || ("Section " + (idx + 1));
        if (String(sectionName).trim().toLowerCase() === "previously rejected") {
          return;
        }
        var findings = Array.isArray(sec.findings) ? sec.findings : [];
        if (!findings.length) return;
        renderedAnySection = true;
        if (typeof sec.summary === "string" && sec.summary.trim()) {
          addParagraph(root, sectionName + " Summary", sec.summary.trim());
        }
        renderFindingTable(sectionName, findings);
      });

      if (!renderedAnySection) {
        var flatFindings = Array.isArray(view.findings) ? view.findings : [];
        var pendingFlat = [];
        for (var fi = 0; fi < flatFindings.length; fi++) {
          var raw = flatFindings[fi];
          var merged = Object.assign({ globalIndex: fi }, raw && typeof raw === "object" ? raw : {});
          pendingFlat.push(merged);
        }
        if (pendingFlat.length) {
          renderFindingTable("Open issues", pendingFlat);
        }
      }

      if (!reviewStillRunning && !root.querySelector(".review-findings-table")) {
        var mm = computeReviewMetrics(view);
        var totalFindings = mm.total;

        var doneCard = document.createElement("div");
        doneCard.className = "review-complete-card";

        var doneTitle = document.createElement("p");
        doneTitle.className = "review-complete-title";
        doneTitle.textContent = totalFindings > 0
          ? "All fixes are caught up for this file."
          : "No findings detected in this review.";
        doneCard.appendChild(doneTitle);

        var doneSub = document.createElement("p");
        doneSub.className = "review-complete-sub";
        doneSub.textContent =
          totalFindings > 0
            ? "Export PDF or Excel from the command palette: “Code Review: Export review report (PDF or Excel from palette)”."
            : "Nothing to apply right now.";
        doneCard.appendChild(doneSub);

        var chips2 = document.createElement("div");
        chips2.className = "review-complete-metrics";
        [
          "Findings reviewed: " + mm.total,
          "Fixed (applied): " + mm.applied,
          "Rejected: " + mm.rejected,
          "Still pending: " + mm.pending
        ].forEach(function (label) {
          var chip = document.createElement("span");
          chip.className = "review-complete-chip";
          chip.textContent = label;
          chips2.appendChild(chip);
        });
        doneCard.appendChild(chips2);
        // Full in-panel report (summary, metrics, accepted diffs) — same as when rows exist; not a separate webview.
        var fallbackDetails = buildCaughtUpDetails();
        if (fallbackDetails) {
          doneCard.appendChild(fallbackDetails);
        }
        root.appendChild(doneCard);
      }
      if (root.querySelector(".review-findings-table")) {
        var actionsNearTable = buildReportActions({ includeViewFull: true, alignRight: true });
        actionsNearTable.classList.add("review-report-actions-near-table");
        root.appendChild(actionsNearTable);
      }
      if (applyingIndex !== null && applyingIndex !== undefined) {
        var scrollToApplyingRow = function () {
          var domApplyingRow = root.querySelector('.review-findings-table tbody tr[data-applying-row="1"]');
          var activeRow = domApplyingRow || root.querySelector(
            '.review-findings-table tbody tr[data-global-index="' + String(applyingIndex) + '"]'
          );
          if (!activeRow) {
            return;
          }
          var docEl = document.scrollingElement || document.documentElement || document.body;
          var rr = activeRow.getBoundingClientRect();
          var viewH = window.innerHeight || document.documentElement.clientHeight || 0;
          var targetTop = (docEl ? docEl.scrollTop : 0) + rr.top - Math.max(120, Math.floor(viewH * 0.3));
          if (docEl) {
            docEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
          }
          if (activeRow.scrollIntoView) {
            activeRow.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          }
        };
        requestAnimationFrame(scrollToApplyingRow);
        setTimeout(scrollToApplyingRow, 120);
      }
    }
    function renderDiff(parts) {
      var diffRoot = document.getElementById("diff");
      diffRoot.innerHTML = "";
      if (!Array.isArray(parts) || !parts.length) return false;
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
    function syncExplanationToggleIcon() {
      var s = sessions[activeSessionId];
      if (!s) return;
      var open = !!renderedPanelEl.open;
      s.explainOpen = open;
      explainToggleBtn.textContent = open ? "▲" : "▼";
      explainToggleBtn.title = open ? "Hide explanation" : "Show explanation";
      explainToggleBtn.setAttribute("aria-label", open ? "Hide explanation" : "Show explanation");
    }
    function renderTabs() {
      tabsEl.innerHTML = "";
      sessionOrder.forEach(function (id, idx) {
        var s = sessions[id];
        if (!s) return;
        var tab = document.createElement("div");
        tab.className = "session-tab" + (id === activeSessionId ? " active" : "");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "session-tab-label";
        btn.textContent = s.title || ("Run " + (idx + 1));
        btn.onclick = function () {
          activeSessionId = id;
          renderTabs();
          renderSession();
          persistUiState();
        };
        var close = document.createElement("button");
        close.type = "button";
        close.className = "session-tab-close";
        close.title = "Close tab";
        close.setAttribute("aria-label", "Close tab");
        close.textContent = "×";
        close.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          closeSession(id, true);
        };
        tab.appendChild(btn);
        tab.appendChild(close);
        tabsEl.appendChild(tab);
      });
    }
    function renderEmptyState() {
      document.documentElement.setAttribute("data-endpoint", "");
      document.getElementById("title").textContent = "Genie";
      document.getElementById("user-question").classList.add("hidden");
      document.getElementById("prompt-box").classList.add("hidden");
      var pi = document.getElementById("prompt-input");
      if (pi) pi.value = "";
      document.getElementById("status").textContent = "";
      document.getElementById("root").classList.remove("busy");
      document.getElementById("step").classList.add("hidden");
      document.getElementById("actions-shell").classList.add("hidden");
      document.getElementById("actions").classList.add("hidden");
      var pa = document.getElementById("panel-actions-anchor");
      if (pa) pa.classList.add("hidden");
      document.getElementById("stream-wrap").classList.add("hidden");
      document.getElementById("diff-panel").classList.add("hidden");
      document.getElementById("rendered-panel").classList.add("hidden");
      document.getElementById("generated-code-panel").classList.add("hidden");
      document.getElementById("meta").classList.add("hidden");
      document.getElementById("err").textContent = "";
      persistUiState();
    }
    function closeSession(id, notifyHost) {
      if (!sessions[id]) return;
      delete sessions[id];
      sessionOrder = sessionOrder.filter(function (sid) { return sid !== id; });
      if (notifyHost) {
        vscode.postMessage({ command: "closeSession", sessionId: id });
      }
      if (activeSessionId === id) {
        activeSessionId = sessionOrder.length ? sessionOrder[sessionOrder.length - 1] : "";
      }
      renderTabs();
      if (activeSessionId) renderSession(); else renderEmptyState();
      persistUiState();
    }
    function renderSession() {
      var s = sessions[activeSessionId];
      if (!s) return;
      var reviewCaughtUpOnly =
        s.endpoint === "codeReview" &&
        !s.busy &&
        !s.streamLive &&
        isReviewCaughtUpOnly(s.structuredData);
      document.documentElement.setAttribute("data-endpoint", s.endpoint || "");
      document.getElementById("title").textContent = s.title || "Genie";
      var renderedPanelLabel = document.getElementById("rendered-panel-label");
      if (renderedPanelLabel) {
        renderedPanelLabel.textContent = s.endpoint === "codeReview" ? "Review results" : "Explanation";
      }
      var promptBox = document.getElementById("prompt-box");
      var promptInput = document.getElementById("prompt-input");
      var sendPromptBtn = document.getElementById("btn-send-prompt");
      var uqb = document.getElementById("user-question-body");
      var uq = document.getElementById("user-question");
      if ((s.userQuestion || "").trim()) {
        uqb.textContent = s.userQuestion;
        uq.classList.remove("hidden");
      } else {
        uqb.textContent = "";
        uq.classList.add("hidden");
      }
      var needsPrompt =
        (s.endpoint === "codeGeneration" && !(s.userQuestion || "").trim() && !s.busy) ||
        (s.endpoint === "codeRefactor" && !!s.refinePromptMode && !(s.userQuestion || "").trim() && !s.busy) ||
        (s.endpoint === "codeReview" && !!s.applyFixesExtraMode && !s.busy);
      var promptLabelEl = document.querySelector("#prompt-box .prompt-label");
      if (promptLabelEl) {
        if (s.endpoint === "codeReview" && s.applyFixesExtraMode) {
          promptLabelEl.textContent = "Extra instructions for applying fixes";
        } else if (s.endpoint === "codeRefactor" && s.refinePromptMode) {
          promptLabelEl.textContent = "How should we refactor?";
        } else {
          promptLabelEl.textContent = "Ask Genie";
        }
      }
      if (needsPrompt) {
        promptBox.classList.remove("hidden");
        sendPromptBtn.disabled = false;
        promptInput.disabled = false;
        if (promptInput) {
          if (s.endpoint === "codeReview" && s.applyFixesExtraMode) {
            promptInput.placeholder =
              "Constraints, style, or how each fix should be applied — Enter to send, Shift+Enter for newline";
          } else if (s.endpoint === "codeRefactor") {
            promptInput.placeholder =
              "How should the code be refactored? (e.g. extract functions, rename, add types, simplify…) — Enter to send, Shift+Enter for newline";
          } else {
            promptInput.placeholder = "Describe what should be generated… (Enter to send, Shift+Enter for newline)";
          }
        }
      } else {
        promptBox.classList.add("hidden");
        sendPromptBtn.disabled = true;
        promptInput.disabled = true;
      }
      var hasAuthData = s.endpoint === "authenticate" && (s.authUrl || s.authCode);
      var statusEl = document.getElementById("status");
      var statusRow = statusEl ? statusEl.parentElement : null;
      statusEl.textContent = reviewCaughtUpOnly || hasAuthData ? "" : (s.status || "");
      if (statusRow) {
        var hasStatusText = !!(statusEl.textContent && String(statusEl.textContent).trim());
        var hasStepText = !!(s.step && String(s.step).trim());
        var shouldShowStatusRow = !reviewCaughtUpOnly && !hasAuthData && (hasStatusText || !!s.busy || hasStepText);
        if (shouldShowStatusRow) statusRow.classList.remove("hidden");
        else statusRow.classList.add("hidden");
      }
      var root = document.getElementById("root");
      if (s.busy) root.classList.add("busy"); else root.classList.remove("busy");
      var step = document.getElementById("step");
      var authWaitEl = document.getElementById("auth-wait");
      if (!reviewCaughtUpOnly && s.step) {
        step.textContent = "Step: " + s.step;
        if (!hasAuthData) {
          step.classList.remove("hidden");
        } else {
          step.classList.add("hidden");
        }
      } else {
        step.classList.add("hidden");
      }
      var sw = document.getElementById("stream-wrap");
      var st = document.getElementById("stream");
      var streamHasText = s.streamText != null && String(s.streamText).length > 0;
      var streamStatusEl = sw ? sw.querySelector(".stream-status") : null;
      if (streamStatusEl) {
        streamStatusEl.textContent =
          s.endpoint === "codeReview" ? "Live review response" : "Live response stream";
      }
      // Code review: keep the stream panel visible while the suite is busy so the UI does not "blink" empty between stages.
      var reviewStreamVisible =
        s.endpoint === "codeReview" &&
        (streamHasText || !!s.streamLive || !!s.busy);
      var showStream =
        !reviewCaughtUpOnly &&
        (s.endpoint === "codeReview" ? reviewStreamVisible : streamHasText || !!s.streamLive);
      if (showStream) {
        sw.classList.remove("hidden");
        if (streamHasText) {
          st.textContent = String(s.streamText);
        } else if (s.endpoint === "codeReview") {
          st.textContent = s.streamLive
            ? "Streaming model output — text will appear below as tokens arrive."
            : s.busy
              ? "Preparing the next review step… Model output will stream here when it starts."
              : "";
        } else {
          st.textContent = "";
        }
        if (s.busy || s.streamLive) sw.classList.add("streaming");
        else sw.classList.remove("streaming");
        sw.open = s.endpoint === "codeReview" || !!s.streamLive || !!s.streamOpen;
      } else {
        st.textContent = "";
        sw.classList.add("hidden");
        sw.classList.remove("streaming");
      }
      var actions = document.getElementById("actions");
      var actionsShell = document.getElementById("actions-shell");
      var refactorActionsAnchor = document.getElementById("refactor-actions-anchor");
      var panelActionsAnchor = document.getElementById("panel-actions-anchor");
      if (s.endpoint === "codeRefactor") {
        actionsShell.classList.add("hidden");
        if (panelActionsAnchor) panelActionsAnchor.classList.add("hidden");
        actions.classList.remove("in-shell");
        actions.classList.add("align-right");
        if (refactorActionsAnchor && actions.parentNode !== refactorActionsAnchor) {
          refactorActionsAnchor.appendChild(actions);
        }
      } else if (s.endpoint === "codeReview") {
        actionsShell.classList.add("hidden");
        actions.classList.remove("in-shell");
        actions.classList.remove("align-right");
        if (panelActionsAnchor && actions.parentNode !== panelActionsAnchor) {
          panelActionsAnchor.appendChild(actions);
        }
        if (panelActionsAnchor) panelActionsAnchor.classList.remove("hidden");
      } else {
        if (panelActionsAnchor) panelActionsAnchor.classList.add("hidden");
        actions.classList.remove("align-right");
        actions.classList.add("in-shell");
        if (actions.parentNode !== actionsShell) {
          actionsShell.appendChild(actions);
        }
        actionsShell.classList.remove("hidden");
      }
      actions.classList.remove("hidden");
      var btnApply = document.getElementById("btn-apply");
      var btnRefine = document.getElementById("btn-refine");
      var btnAccept = document.getElementById("btn-accept");
      var btnReject = document.getElementById("btn-reject");
      if (reviewCaughtUpOnly) {
        actionsShell.classList.add("hidden");
        if (panelActionsAnchor) panelActionsAnchor.classList.add("hidden");
        actions.classList.add("hidden");
        btnApply.classList.add("hidden");
        btnRefine.classList.add("hidden");
        btnAccept.classList.add("hidden");
        btnReject.classList.add("hidden");
        setDecisionButtons(false);
      } else if (s.reviewMode) {
        btnApply.classList.add("hidden");
        if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") {
          btnRefine.classList.remove("hidden");
        } else {
          btnRefine.classList.add("hidden");
        }
        btnAccept.classList.remove("hidden");
        btnReject.classList.remove("hidden");
        var fixPhase = s.fixDecisionPhase || "pending";
        if (fixPhase === "accepted") {
          btnAccept.textContent = "✓ Accepted";
          btnReject.textContent = "✕ Reject";
          btnAccept.disabled = true;
          btnReject.disabled = true;
        } else if (fixPhase === "rejected") {
          btnAccept.textContent = "✓ Accept";
          btnReject.textContent = "✕ Rejected";
          btnAccept.disabled = true;
          btnReject.disabled = true;
        } else {
          btnAccept.textContent = "✓ Accept";
          btnReject.textContent = "✕ Reject";
          setDecisionButtons(!!s.hasCode);
        }
      } else {
        var showApply = !!s.hasCode && !(s.endpoint === "codeRefactor" && (s.step || "").toLowerCase().indexOf("waiting for your prompt") >= 0);
        if (showApply) btnApply.classList.remove("hidden"); else btnApply.classList.add("hidden");
        if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") btnRefine.classList.remove("hidden");
        else btnRefine.classList.add("hidden");
        btnAccept.textContent = "✓ Accept";
        btnAccept.classList.add("hidden");
        btnReject.classList.add("hidden");
        btnApply.disabled = !s.hasCode || !!s.applyingCurrent || !!s.busy;
        if (s.applyingCurrent) {
          btnApply.classList.add("is-applying");
          btnApply.innerHTML = "";
          var applySpinner = document.createElement("span");
          applySpinner.className = "spinner";
          btnApply.appendChild(applySpinner);
          btnApply.appendChild(document.createTextNode(" Applying..."));
        } else {
          btnApply.classList.remove("is-applying");
          btnApply.textContent = "Apply";
        }
        setDecisionButtons(false);
      }
      var diffPanel = document.getElementById("diff-panel");
      var diffRendered = !reviewCaughtUpOnly && renderDiff(s.diffParts);
      var showDiffPanel = diffRendered && s.reviewMode;
      if (showDiffPanel) {
        diffPanel.classList.remove("hidden");
        diffPanel.open = true;
      } else {
        diffPanel.classList.add("hidden");
        diffPanel.open = false;
      }
      var meta = document.getElementById("meta");
      meta.innerHTML = "";
      if (!reviewCaughtUpOnly && s.remarks && s.endpoint !== "codeGeneration") {
        var r = document.createElement("div");
        r.className = "remarks";
        r.textContent = s.remarks;
        meta.appendChild(r);
        meta.classList.remove("hidden");
      } else {
        meta.classList.add("hidden");
      }
      var out = document.getElementById("out");
      var renderedPanel = document.getElementById("rendered-panel");
      var reviewHasRows = s.endpoint === "codeReview" ? hasRenderableReviewContent(s.structuredData) : true;
      var hasStreamOrText =
        !!(s.streamText && String(s.streamText).trim()) || !!(s.displayText && String(s.displayText).trim());
      var hasStructuredKeys =
        s.structuredData &&
        typeof s.structuredData === "object" &&
        Object.keys(s.structuredData).length > 0;
      // Code review: show the results panel whenever we have saved structured data (including zero findings),
      // so the green "caught up / no findings" card is not hidden behind an empty layout.
      var hasExplanationContent =
        s.endpoint === "codeReview"
          ? hasStructuredKeys
          : reviewHasRows && (hasStreamOrText || hasStructuredKeys);
      if (hasExplanationContent) {
        renderedPanel.classList.remove("hidden");
        if (reviewCaughtUpOnly) {
          renderedPanel.classList.add("complete-only");
        } else {
          renderedPanel.classList.remove("complete-only");
        }
        renderedPanel.open = s.explainOpen !== false;
        syncExplanationToggleIcon();
        renderStructured(out, s.structuredData, s.displayText || "", s.endpoint || "", s);
      } else {
        renderedPanel.classList.add("hidden");
        renderedPanel.classList.remove("complete-only");
        clearEl(out);
      }
      var rcw = document.getElementById("refactor-code-wrap");
      var rco = document.getElementById("refactor-code-out");
      var regenStreaming = !!(s.busy && s.streamLive);
      var rcText = s.refactorCode != null ? String(s.refactorCode) : "";
      if (rcw && rco && s.endpoint === "codeRefactor" && rcText.trim() && !regenStreaming) {
        rcw.classList.remove("hidden");
        rco.textContent = rcText;
      } else if (rcw && rco) {
        rcw.classList.add("hidden");
        rco.textContent = "";
      }
      var gcp = document.getElementById("generated-code-panel");
      var gpp = document.getElementById("generated-picker");
      var gfs = document.getElementById("generated-file-select");
      var gct = document.getElementById("generated-code");
      generatedFiles = Array.isArray(s.generatedFiles) ? s.generatedFiles : [];
      var genText = s.endpoint === "codeGeneration" && s.generatedCode && String(s.generatedCode).trim() ? String(s.generatedCode) : "";
      if (generatedFiles.length > 1) {
        gfs.innerHTML = "";
        generatedFiles.forEach(function (f, idx) {
          var opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = f.relativePath || ("file " + (idx + 1));
          gfs.appendChild(opt);
        });
        gpp.classList.remove("hidden");
        gct.textContent = String(generatedFiles[0].code || "");
      } else if (generatedFiles.length === 1) {
        gpp.classList.add("hidden");
        gct.textContent = String(generatedFiles[0].code || "");
      } else if (genText) {
        gpp.classList.add("hidden");
        gct.textContent = genText;
      } else {
        gpp.classList.add("hidden");
        gct.textContent = "";
      }
      gfs.onchange = function () {
        var idx = Number(gfs.value || 0);
        var selected = generatedFiles[idx];
        gct.textContent = selected && selected.code ? String(selected.code) : "";
      };
      var authBox = document.getElementById("auth-box");
      var authUrl = document.getElementById("auth-url");
      var authCode = document.getElementById("auth-code");
      if (s.endpoint === "authenticate" && (s.authUrl || s.authCode)) {
        authUrl.textContent = s.authUrl || "";
        authCode.textContent = s.authCode || "";
        authWaitEl.textContent = [s.status, s.step ? ("Step: " + s.step) : ""].filter(Boolean).join("  ");
        authBox.classList.remove("hidden");
      } else {
        authUrl.textContent = "";
        authCode.textContent = "";
        authWaitEl.textContent = "";
        authBox.classList.add("hidden");
      }
      document.getElementById("err").textContent = s.err || "";
      persistUiState();
    }

    function focusPromptComposerAndScrollTop() {
      setTimeout(function () {
        var docEl = document.scrollingElement || document.documentElement || document.body;
        var promptBox = document.getElementById("prompt-box");
        var promptInput = document.getElementById("prompt-input");
        if (docEl) {
          docEl.scrollTop = 0;
        }
        if (promptBox) {
          promptBox.classList.remove("hidden");
          promptBox.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
        if (promptInput && !promptInput.disabled) {
          promptInput.value = "";
          promptInput.disabled = false;
          promptInput.focus();
          promptInput.setSelectionRange(0, 0);
        }
      }, 10);
    }
    document.getElementById("btn-refine").addEventListener("click", function () {
      if (!activeSessionId) return;
      var s = sessions[activeSessionId];
      if (!s) return;
      if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") {
        // Reuse the in-panel prompt box for refinement instead of popup input.
        s.refinePromptMode = true;
        s.userQuestion = "";
        s.err = "";
        renderSession();
        focusPromptComposerAndScrollTop();
      }
      vscode.postMessage({ command: "refineRequest", sessionId: activeSessionId });
    });
    document.getElementById("btn-apply").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.hasCode) return;
      s.applyingCurrent = true;
      renderSession();
      vscode.postMessage({ command: "applyCurrent", sessionId: activeSessionId });
    });
    document.getElementById("btn-accept").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.reviewMode) return;
      if ((s.fixDecisionPhase || "pending") !== "pending") return;
      vscode.postMessage({ command: "fixDecision", value: "accept", sessionId: activeSessionId });
    });
    document.getElementById("btn-reject").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.reviewMode) return;
      if ((s.fixDecisionPhase || "pending") !== "pending") return;
      vscode.postMessage({ command: "fixDecision", value: "reject", sessionId: activeSessionId });
    });
    document.getElementById("btn-copy-auth-url").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.authUrl) return;
      vscode.postMessage({ command: "copyText", sessionId: activeSessionId, value: s.authUrl });
    });
    document.getElementById("btn-copy-auth-code").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.authCode) return;
      vscode.postMessage({ command: "copyText", sessionId: activeSessionId, value: s.authCode });
    });
    function trySendPrompt() {
      if (!activeSessionId) return;
      var s = sessions[activeSessionId];
      if (!s) return;
      var input = document.getElementById("prompt-input");
      var text = (input && input.value != null) ? String(input.value) : "";
      var q = text.trim();
      if (s.endpoint === "codeReview" && s.applyFixesExtraMode) {
        if (!q) return;
        s.extraFixInstructions = q;
        s.applyFixesExtraMode = false;
        if (input) input.value = "";
        renderSession();
        vscode.postMessage({
          command: "analyzeExtraInstruction",
          sessionId: activeSessionId,
          extraInstructions: q,
        });
        return;
      }
      if (s.endpoint !== "codeGeneration" && s.endpoint !== "codeRefactor") return;
      if (!q) return;
      s.userQuestion = q;
      s.refinePromptMode = false;
      renderSession();
      vscode.postMessage({ command: "submitPrompt", sessionId: activeSessionId, value: q });
    }
    document.getElementById("btn-send-prompt").addEventListener("click", trySendPrompt);
    document.getElementById("prompt-input").addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var s = sessions[activeSessionId];
        if (s && s.endpoint === "codeReview" && s.applyFixesExtraMode) {
          e.preventDefault();
          s.applyFixesExtraMode = false;
          renderSession();
        }
        return;
      }
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      e.preventDefault();
      trySendPrompt();
    });
    explainToggleBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      renderedPanelEl.open = !renderedPanelEl.open;
      syncExplanationToggleIcon();
    });
    renderedPanelEl.addEventListener("toggle", syncExplanationToggleIcon);
    document.getElementById("stream-wrap").addEventListener("toggle", function () {
      var s = sessions[activeSessionId];
      if (!s) return;
      s.streamOpen = !!document.getElementById("stream-wrap").open;
    });

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "createSession") {
        if (!m.sessionId) return;
        if (!sessions[m.sessionId]) {
          sessionOrder.push(m.sessionId);
        }
        // Keep restored content when available, but reset transient apply/run flags for a fresh run.
        var prev = sessions[m.sessionId] || null;
        var next = Object.assign(newSession(m.title || "Assistant result"), prev || {});
        next.title = m.title || next.title;
        // Do not keep previous review payload; it causes a "caught up" flash before the new run starts streaming.
        next.structuredData = null;
        next.displayText = "";
        next.remarks = "";
        next.reviewFixDetailsOpen = false;
        next.extraFixInstructions = "";
        next.busy = false;
        next.step = "";
        next.streamLive = false;
        next.streamText = "";
        next.fixApplyingIndex = null;
        next.fixApplyingAll = false;
        next.applyingCurrent = false;
        next.fixDecisionPhase = "pending";
        sessions[m.sessionId] = next;
        activeSessionId = m.sessionId;
        renderTabs();
        renderSession();
        persistUiState();
        return;
      }
      if (m.type === "closeSession") {
        if (m.sessionId) {
          closeSession(m.sessionId, false);
        }
        return;
      }
      var sid = m.sessionId;
      if (!sid || !sessions[sid]) return;
      var s = sessions[sid];
      if (m.type === "title") s.title = m.text || s.title;
      if (m.type === "mode") s.endpoint = m.endpoint || s.endpoint;
      if (m.type === "status") s.status = m.text || "";
      if (m.type === "busy") s.busy = !!m.value;
      if (m.type === "busy" && !m.value) s.applyingCurrent = false;
      if (m.type === "step") s.step = m.text || "";
      if (m.type === "stream") s.streamText = m.text || "";
      if (m.type === "streamLive") s.streamLive = !!m.value;
      if ((m.type === "stream" || m.type === "streamLive") && s.endpoint === "codeReview") {
        s.streamOpen = true;
      }
      if (m.type === "userQuestion") s.userQuestion = m.text != null ? String(m.text) : "";
      if (m.type === "reviewPatch") {
        if (m.displayText !== undefined && m.displayText !== null) {
          s.displayText = String(m.displayText);
        }
        if (m.structuredData !== undefined && m.structuredData !== null) {
          s.structuredData = m.structuredData;
        }
      }
      if (m.type === "result") {
        var preserveFixApplySpinners =
          m.endpoint === "codeReview" && !!m.reviewMode && !!m.hasCode;
        s.remarks = m.remarks || "";
        s.displayText = m.displayText || "";
        s.structuredData = m.structuredData || null;
        s.reviewReportOnly = !!m.reportOnly;
        s.reviewMode = !!m.reviewMode && !!m.hasCode;
        s.hasCode = !!m.hasCode;
        s.endpoint = m.endpoint || s.endpoint;
        s.generatedCode = m.generatedCode || "";
        s.generatedFiles = Array.isArray(m.generatedFiles) ? m.generatedFiles : [];
        s.diffParts = Array.isArray(m.diffParts) ? m.diffParts : [];
        s.refactorCode = m.refactorCode != null ? String(m.refactorCode) : "";
        s.refinePromptMode = false;
        s.applyFixesExtraMode = false;
        s.streamOpen = false;
        s.streamLive = false;
        s.streamText = "";
        s.applyingCurrent = false;
        if (!preserveFixApplySpinners) {
          s.fixApplyingIndex = null;
          s.fixApplyingAll = false;
        }
        s.fixDecisionPhase = "pending";
      }
      if (m.type === "fixDecisionPhase") {
        var ph = m.phase;
        if (ph === "pending" || ph === "accepted" || ph === "rejected") {
          s.fixDecisionPhase = ph;
        }
      }
      if (m.type === "authData") {
        s.endpoint = "authenticate";
        s.authUrl = m.url != null ? String(m.url) : "";
        s.authCode = m.code != null ? String(m.code) : "";
      }
      if (m.type === "error") {
        s.err = m.text || "";
        s.applyingCurrent = false;
        s.streamLive = false;
        s.streamText = "";
      }
      if (m.type === "fixApplying") {
        s.fixApplyingIndex = m.index === null || m.index === undefined ? null : m.index;
      }
      if (m.type === "fixApplyingAll") {
        s.fixApplyingAll = !!m.value;
      }
      if (sid === activeSessionId) {
        renderTabs();
        renderSession();
      } else {
        renderTabs();
      }
      persistUiState();
    });
    if (!restoreUiStateIfAvailable()) {
      renderEmptyState();
    }
})();
