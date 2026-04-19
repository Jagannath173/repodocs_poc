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
  var generatedFiles = [];
  var renderedPanelEl = document.getElementById("rendered-panel");
  var explainToggleBtn = document.getElementById("explain-toggle");
  var tabsEl = document.getElementById("session-tabs");
  if (!renderedPanelEl || !explainToggleBtn || !tabsEl) {
    document.body.innerHTML = '<p style="padding:16px;font-family:system-ui;color:#f14c4c;">Genie UI failed to load (missing DOM). Reload the window.</p>';
    return;
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
        authUrl: "",
        authCode: "",
        fixApplyingIndex: null,
        fixApplyingAll: false,
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
    /** Total / applied / rejected / pending — prefers host `totalFindingsCount` so metrics stay correct when findings[] is empty. */
    function computeReviewMetrics(view) {
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var appliedOnly = applied.length;
      var rejectedOnly = rejected.length;
      var nFromView = countFindingsInView(view);
      var declared =
        typeof view.totalFindingsCount === "number" && !isNaN(view.totalFindingsCount)
          ? Math.max(0, Math.floor(view.totalFindingsCount))
          : typeof view.reviewFindingCount === "number" && !isNaN(view.reviewFindingCount)
            ? Math.max(0, Math.floor(view.reviewFindingCount))
            : -1;
      var totalOnly =
        declared >= 0 ? declared : Math.max(nFromView, appliedOnly + rejectedOnly);
      var pendingOnly = Math.max(0, totalOnly - appliedOnly - rejectedOnly);
      return { total: totalOnly, applied: appliedOnly, rejected: rejectedOnly, pending: pendingOnly };
    }
    function isReviewCaughtUpOnly(view) {
      if (!view || typeof view !== "object") {
        return false;
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var sections = Array.isArray(view.sections) ? view.sections : [];
      var totalFindings = Array.isArray(view.findings) ? view.findings.length : 0;
      if (totalFindings > 0) {
        return false;
      }
      if (sections.length) {
        for (var si = 0; si < sections.length; si++) {
          var sec = sections[si];
          var findings = sec && Array.isArray(sec.findings) ? sec.findings : [];
          for (var fi = 0; fi < findings.length; fi++) {
            var f = findings[fi];
            var idx = typeof f.globalIndex === "number" ? f.globalIndex : fi;
            if (applied.indexOf(idx) < 0) {
              return false;
            }
          }
        }
        return true;
      }
      var flatFindings = Array.isArray(view.findings) ? view.findings : [];
      for (var i = 0; i < flatFindings.length; i++) {
        if (applied.indexOf(i) < 0) {
          return false;
        }
      }
      return true;
    }
    function renderCodeReview(root, view, fallbackText, session) {
      if (!view || typeof view !== "object") {
        return;
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var applyingIndex = session && session.fixApplyingIndex != null ? session.fixApplyingIndex : null;
      var applyingAll = !!(session && session.fixApplyingAll);
      var fixRunInProgress = applyingAll || applyingIndex !== null;
      if (isReviewCaughtUpOnly(view)) {
        clearEl(root);
        var m = computeReviewMetrics(view);

        var onlyWrap = document.createElement("div");
        onlyWrap.className = "review-complete-only-wrap";

        var doneCard = document.createElement("div");
        doneCard.className = "review-complete-card";

        var doneTitle = document.createElement("p");
        doneTitle.className = "review-complete-title";
        doneTitle.textContent = "All fixes are caught up for this file.";
        doneCard.appendChild(doneTitle);

        var doneSub = document.createElement("p");
        doneSub.className = "review-complete-sub";
        doneSub.textContent = "Accepted fixes are hidden to keep this view focused and fast.";
        doneCard.appendChild(doneSub);

        var chips = document.createElement("div");
        chips.className = "review-complete-metrics";
        [
          "Findings reviewed: " + m.total,
          "Fixed (applied): " + m.applied,
          "Rejected: " + m.rejected,
          "Still pending: " + m.pending
        ].forEach(function (label) {
          var chip = document.createElement("span");
          chip.className = "review-complete-chip";
          chip.textContent = label;
          chips.appendChild(chip);
        });
        doneCard.appendChild(chips);

        onlyWrap.appendChild(doneCard);
        root.appendChild(onlyWrap);
        return;
      }

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
        btnAll.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "all", sessionId: activeSessionId }); };
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
      root.appendChild(toolbar);

      var rm = computeReviewMetrics(view);
      var metricsBar = document.createElement("div");
      metricsBar.className = "review-metrics-bar";
      metricsBar.setAttribute("role", "status");
      metricsBar.textContent =
        rm.total +
        " finding(s) in review · " +
        rm.applied +
        " fixed · " +
        rm.rejected +
        " rejected · " +
        rm.pending +
        " still open";
      root.appendChild(metricsBar);

      var overallSummary = "";
      if (typeof view.summary === "string" && view.summary.trim()) {
        overallSummary = view.summary.trim();
      } else if (fallbackText && String(fallbackText).trim()) {
        overallSummary = String(fallbackText).trim();
      }
      if (overallSummary) {
        addParagraph(root, "Summary", overallSummary);
      }

      var fallbackGlobalIndex = 0;
      function renderFindingTable(sectionLabel, findings) {
        if (!Array.isArray(findings) || !findings.length) return;
        var wrap = document.createElement("div");
        wrap.className = "review-table-wrap";
        var table = document.createElement("table");
        table.className = "review-findings-table";
        var thead = document.createElement("thead");
        var hr = document.createElement("tr");
        [["#", "col-num-h"], ["Severity", ""], ["Description", ""], ["Suggested fix", ""], ["Fix", ""]].forEach(function (pair) {
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
          if (isApplied) {
            tdDesc.className = "col-applied-muted";
            tdDesc.textContent = "—";
          } else {
            tdDesc.textContent = issueDescriptionOnly(item);
          }
          tr.appendChild(tdDesc);
          var tdSug = document.createElement("td");
          var sugText = String(item.suggestion || "").trim();
          if (isApplied) {
            tdSug.className = "col-suggestion col-suggestion-applied-done";
            tdSug.textContent = "—";
          } else {
            tdSug.className = "col-suggestion";
            tdSug.textContent = sugText || "—";
          }
          tr.appendChild(tdSug);
          var tdFix = document.createElement("td");
          tdFix.className = "col-fix";
          if (isApplied) {
            var spA = document.createElement("span");
            spA.className = "review-status-accepted review-fix-status-pill";
            spA.textContent = "Accepted";
            tdFix.appendChild(spA);
          } else {
            var showApplying =
              applyingAll || (applyingIndex !== null && applyingIndex === globalIndex);
            var fixRowLocked =
              !applyingAll &&
              applyingIndex !== null &&
              applyingIndex !== globalIndex;
            var primaryClasses = "primary review-fix-btn";
            if (showApplying) {
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
            } else if (isRejected) {
              var spR = document.createElement("span");
              spR.className = "review-status-rejected review-fix-status-pill";
              spR.textContent = "Rejected";
              tdFix.appendChild(spR);
            } else {
              var fixBtn = document.createElement("button");
              fixBtn.type = "button";
              fixBtn.className = primaryClasses;
              fixBtn.textContent = "Fix";
              fixBtn.disabled = !!fixRowLocked;
              if (!fixRowLocked) {
                fixBtn.onclick = function () {
                  vscode.postMessage({ command: "applyFixes", mode: "one", index: globalIndex, sessionId: activeSessionId });
                };
              }
              tdFix.appendChild(fixBtn);
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
        var findings = Array.isArray(sec.findings) ? sec.findings : [];
        if (!findings.length) return;
        renderedAnySection = true;
        var sectionName = sec.name || ("Section " + (idx + 1));
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

      if (!root.querySelector(".review-findings-table")) {
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
        doneSub.textContent = totalFindings > 0
          ? "Accepted fixes are hidden to keep this view focused and fast."
          : "Nothing to apply right now.";
        doneCard.appendChild(doneSub);

        if (totalFindings > 0 || mm.applied > 0 || mm.rejected > 0 || mm.pending > 0) {
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
        }
        root.appendChild(doneCard);
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
        if (reviewCaughtUpOnly) statusRow.classList.add("hidden");
        else statusRow.classList.remove("hidden");
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
      var streamStatusEl = sw ? sw.querySelector(".stream-status") : null;
      if (streamStatusEl) {
        streamStatusEl.textContent =
          s.endpoint === "codeReview" ? "Live review response" : "Live response stream";
      }
      var streamHasText = s.streamText != null && String(s.streamText).length > 0;
      var showStream = !reviewCaughtUpOnly && (streamHasText || !!s.streamLive);
      if (showStream) {
        sw.classList.remove("hidden");
        st.textContent = streamHasText ? String(s.streamText) : (s.streamLive ? "Waiting for first tokens…" : "");
        if (s.busy || s.streamLive) sw.classList.add("streaming"); else sw.classList.remove("streaming");
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
          btnAccept.textContent = "✓ Accept";
        } else {
          btnRefine.classList.add("hidden");
          btnAccept.textContent = "✓ Accept";
        }
        btnAccept.classList.remove("hidden");
        btnReject.classList.remove("hidden");
        btnReject.textContent = "✕ Reject";
        setDecisionButtons(!!s.hasCode);
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
      var hasExplanationContent =
        !!((s.streamText && String(s.streamText).trim()) ||
          (s.displayText && String(s.displayText).trim()) ||
          (s.structuredData && typeof s.structuredData === "object" && Object.keys(s.structuredData).length));
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
      setDecisionButtons(false);
      vscode.postMessage({ command: "fixDecision", value: "accept", sessionId: activeSessionId });
    });
    document.getElementById("btn-reject").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.reviewMode) return;
      setDecisionButtons(false);
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
        s.applyFixesExtraMode = false;
        if (input) input.value = "";
        renderSession();
        vscode.postMessage({
          command: "applyFixes",
          mode: "all",
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
          sessions[m.sessionId] = newSession(m.title || "Assistant result");
          sessionOrder.push(m.sessionId);
        }
        activeSessionId = m.sessionId;
        renderTabs();
        renderSession();
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
      if (m.type === "result") {
        s.remarks = m.remarks || "";
        s.displayText = m.displayText || "";
        s.structuredData = m.structuredData || null;
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
    });
})();
