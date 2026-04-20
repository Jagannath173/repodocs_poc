import * as vscode from "vscode";
import * as path from "node:path";
import { runCopilotInference } from "../../utils/pythonRunner";
import { extensionContext } from "../../extension";
import {
  extractFirstJsonObject,
  parseReviewJson,
  ReviewFinding,
  ReviewPayload,
  ReviewSectionFinding,
  ReviewSectionPayload,
  ReviewWebviewSession,
} from "../webview/review_Webview/reviewPanel";
import { ensureCopilotSession } from "../../utils/session";
import type { StoredReview } from "../../review/applyFixes";
import {
  findAppliedIndicesByKeys,
  findingMatchesStoredKey,
  getAppliedFindingKeysForDocumentUri,
  getRejectedFindingKeysForDocumentUri,
  getStoredReviewForDocumentUri,
  makeFindingKey,
  remapPriorAppliedIndicesToCombined,
  saveLastReview,
  toStoredReview,
} from "../../review/applyFixes";
import { disposeReviewPanelsForDocument } from "../../review/reviewBridge";
import { tryGetGitDiffVsHead } from "../../utils/gitDiff";
import { isFindingAlreadySatisfiedByFile } from "../../utils/reviewFilter";
import { openAuthWebviewAndAuthenticate } from "../webview/auth_webview/authPanel";
import { renderPromptTemplate } from "../../utils/promptRenderer";
import { log, sanitizeForLog } from "../../utils/logger";
import { resetMockReviewStage } from "../../utils/mockCopilot";

const REVIEW_SYSTEM_ROLE =
  "Respond with only a valid JSON object and no extra text. " +
  "Include only findings that still need a real code change in the submitted source: " +
  "omit issues that are already resolved by the current code, and do not suggest fixes that merely restate code already present. " +
  "Each suggestion must be concrete, minimal, and directly change the codebase to address the issue.";

const REVIEW_PROMPT_FILES = {
  quality: "review/quality_review.jinja",
  security: "review/security_review.jinja",
  performance: "review/performance_review.jinja",
  syntax: "review/syntax_review.jinja",
  cloud: "review/cloud_violations_review.jinja",
  orgStd: "review/org_std_review.jinja",
  ckDesign: "review/ck_std_review.jinja",
  bigquery: "review/bigquery_rules_review.jinja",
  commit: "review/commit_review.jinja",
} as const;

const REVIEW_ENDPOINT_LABELS: Record<ReviewEndpoint, string> = {
  quality: "Quality",
  security: "Security",
  performance: "Performance",
  syntax: "Syntax",
  cloud: "Cloud Violations",
  orgStd: "Org Standards",
  ckDesign: "CK Design",
  bigquery: "BigQuery Rules",
  commit: "Commit Review",
};

export type ReviewEndpoint = keyof typeof REVIEW_PROMPT_FILES;
const runningReviewUris = new Set<string>();

export function isCodeReviewRunningForDocument(documentUri: string): boolean {
  return runningReviewUris.has(documentUri);
}

const REVIEW_SEQUENCE: ReviewEndpoint[] = [
  "quality",
  "security",
  "performance",
  "syntax",
  "cloud",
  "orgStd",
  "ckDesign",
  "bigquery",
  "commit",
];

export async function runCodeReview(): Promise<void> {
  log.info("codeReview", "runCodeReview started");
  if (!(await ensureCopilotSession())) {
    log.warn("codeReview", "Aborted: Copilot session not available");
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    log.warn("codeReview", "Aborted: no active editor");
    void vscode.window.showWarningMessage("Open a file (or select code) to review.");
    return;
  }

  const fullText = editor.document.getText();
  const selectionText = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection);
  const primarySlice = selectionText.trim() ? selectionText : fullText;

  if (!primarySlice.trim()) {
    log.warn("codeReview", "Aborted: no content to review");
    void vscode.window.showWarningMessage("Open a file (or select code) to review.");
    return;
  }

  const rawGitDiff = selectionText.trim() ? undefined : await tryGetGitDiffVsHead(editor.document.uri);

  let reviewInputMode: "selection" | "incremental" | "full";
  let promptCode: string;
  let promptGitDiff: string;

  if (selectionText.trim()) {
    reviewInputMode = "selection";
    promptCode = selectionText;
    promptGitDiff = selectionText;
  } else if (rawGitDiff !== undefined && rawGitDiff.trim().length > 0) {
    reviewInputMode = "incremental";
    promptCode = rawGitDiff;
    promptGitDiff = rawGitDiff;
  } else {
    reviewInputMode = "full";
    promptCode = fullText;
    promptGitDiff =
      rawGitDiff !== undefined && rawGitDiff.trim().length > 0 ? rawGitDiff : fullText;
  }

  const systemRoleForReview =
    reviewInputMode === "incremental"
      ? REVIEW_SYSTEM_ROLE +
        " The primary input is a git diff versus HEAD: only report findings that relate to added or modified lines in that diff; do not require changes to unchanged parts of the file."
      : reviewInputMode === "selection"
        ? REVIEW_SYSTEM_ROLE +
          " Only analyze the supplied editor selection; do not assume defects in parts of the file not shown."
        : REVIEW_SYSTEM_ROLE;

  const fileName = path.basename(editor.document.fileName);
  const language = editor.document.languageId ?? "unknown";
  log.info("codeReview", "Review context", {
    fileName,
    language,
    reviewInputMode,
    promptChars: promptCode.length,
    fullFileChars: fullText.length,
  });

  const documentUri = editor.document.uri.toString();
  runningReviewUris.add(documentUri);
  disposeReviewPanelsForDocument(documentUri);
  const panel = new ReviewWebviewSession(extensionContext, `Review: ${fileName}`, documentUri);
  /** Snapshot before this run — used to re-inject dismissed rows when the model repeats the same finding keys. */
  const priorStoredBeforeRun = getStoredReviewForDocumentUri(editor.document.uri);
  /** Merge fix state by finding fingerprint — do not require `reviewedDocumentHash` match (fixes + reload change the buffer). */
  const priorAppliedKeys = getAppliedFindingKeysForDocumentUri(editor.document.uri);
  const priorRejectedKeys = getRejectedFindingKeysForDocumentUri(editor.document.uri);
  const priorAppliedKeySet = new Set(priorAppliedKeys);
  const priorRejectedKeySet = new Set(priorRejectedKeys);

  panel.setLoading("Running review suite…");
  let reviewRunDone = false;
  if (reviewInputMode === "incremental") {
    panel.addReviewLog("Scope: git diff vs HEAD — findings should target your local changes only.", "info");
  } else if (reviewInputMode === "selection") {
    panel.addReviewLog("Scope: editor selection only.", "info");
  } else {
    panel.addReviewLog(
      "Scope: full file (no qualifying git diff vs HEAD — stage changes or edit to enable incremental diff review).",
      "info"
    );
  }
  panel.registerOnMessage((msg: unknown) => {
    const m = msg as {
      command?: string;
      mode?: string;
      index?: number;
      indices?: number[];
      extraInstructions?: string;
    };
    if (m?.command === "applyFixes") {
      if (!reviewRunDone) {
        panel.addReviewLog("Review is still running. Apply fixes after all stages finish.", "warn");
        void vscode.window.showInformationMessage(
          "Code review is still running. Please wait for completion, then apply fixes."
        );
        return;
      }
      const mode = m.mode === "one" || m.mode === "selected" ? m.mode : "all";
      const idx = typeof m.index === "number" ? m.index : undefined;
      const selectedIndices = Array.isArray(m.indices) ? m.indices.filter((n) => typeof n === "number") : undefined;
      const extraPassThrough = typeof m.extraInstructions === "string" ? m.extraInstructions : "";
      void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, extraPassThrough, selectedIndices);
    } else if (m?.command === "authenticate") {
      void vscode.commands.executeCommand("codeReview.authenticate");
    }
  });

  const sections: ReviewSectionPayload[] = [];
  const combinedFindings: ReviewPayload["findings"] = [];

  try {
    resetMockReviewStage();
    for (let i = 0; i < REVIEW_SEQUENCE.length; i++) {
      const endpoint = REVIEW_SEQUENCE[i];
      const label = REVIEW_ENDPOINT_LABELS[endpoint];
      log.info("codeReview", "Review stage", { stage: `${i + 1}/${REVIEW_SEQUENCE.length}`, endpoint, label });
      const prompt = await renderReviewPrompt(endpoint, promptCode, promptGitDiff, language);
      log.debug("codeReview", "Prompt template rendered", { endpoint, promptChars: prompt.length });
      panel.addReviewLog(`Running ${label} review (${i + 1}/${REVIEW_SEQUENCE.length})…`, "info");
      panel.addReviewLog(`[${label}] Started`, "info");
      let assistantText = "";
      let authError = false;
      panel.beginReviewStreamStage();

      await runCopilotInference(
        extensionContext,
        prompt,
        (data) => {
          log.proxyLine("codeReview", data);
          const trimmed = data.trim();
          if (trimmed.includes("Error: No active Copilot session")) {
            authError = true;
          }
          if (!trimmed.startsWith("data: ")) {
            return;
          }
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === "[DONE]") {
            return;
          }
          try {
            const json = JSON.parse(jsonStr) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }>;
            };
            const text =
              json.choices?.[0]?.delta?.content ||
              json.choices?.[0]?.message?.content ||
              json.choices?.[0]?.text;
            if (text) {
              assistantText += text;
              panel.setReviewStream(assistantText);
              log.debug("codeReview", "SSE text delta added", {
                endpoint,
                deltaChars: text.length,
                totalChars: assistantText.length,
              });
              if (text.length > 0) {
                panel.addReviewLog(`[${label}] +${text.length} chars (total ${assistantText.length})`, "info");
              }
            }
          } catch {
            log.debug("codeReview", "Skipped non-JSON SSE payload", { endpoint, lineChars: trimmed.length });
          }
        },
        { systemRole: systemRoleForReview }
      );

      if (authError) {
        log.warn("codeReview", "Auth required mid-review; opening sign-in");
        panel.dispose();
        const ok = await openAuthWebviewAndAuthenticate(extensionContext);
        if (ok) {
          log.info("codeReview", "Re-running review after successful sign-in");
          await runCodeReview();
        }
        return;
      }

      log.debug("codeReview", "Inference complete for stage", { endpoint, assistantTextChars: assistantText.length });
      const review = parseEndpointReviewJson(assistantText, endpoint);
      const filtered = review.findings.filter((f) => !isFindingAlreadySatisfiedByFile(fullText, f));
      const skippedSatisfied = review.findings.length - filtered.length;
      if (skippedSatisfied > 0) {
        panel.addReviewLog(`[${label}] Skipped ${skippedSatisfied} finding(s) whose suggestions already match the file.`, "info");
      }
      let skippedApplied = 0;
      let skippedRejectedOnly = 0;
      for (const f of filtered) {
        if ([...priorAppliedKeySet].some((sk) => findingMatchesStoredKey(f, sk))) {
          skippedApplied += 1;
        } else if ([...priorRejectedKeySet].some((sk) => findingMatchesStoredKey(f, sk))) {
          skippedRejectedOnly += 1;
        }
      }
      const unseen = filtered.filter((f) => {
        const applied = [...priorAppliedKeySet].some((sk) => findingMatchesStoredKey(f, sk));
        return !applied;
      });
      if (skippedApplied > 0) {
        panel.addReviewLog(`[${label}] Skipped ${skippedApplied} previously applied finding(s).`, "info");
      }
      if (skippedRejectedOnly > 0) {
        panel.addReviewLog(`[${label}] Restored ${skippedRejectedOnly} previously rejected finding(s) as actionable Fix rows.`, "info");
      }
      if (unseen.length === 0) {
        if (review.findings.length > 0 || skippedApplied > 0 || skippedRejectedOnly > 0) {
          panel.addReviewLog(`[${label}] No new rows — all suggestions for this stage already appear in the file.`, "info");
        }
      } else {
        const sectionFindings = unseen.map((f) => {
          const globalIndex = combinedFindings.length;
          combinedFindings.push(f);
          return { ...f, globalIndex };
        });
        sections.push({
          name: label,
          summary: review.summary || `${label} review complete.`,
          findings: sectionFindings,
        });

        log.info("codeReview", "Stage findings parsed", { endpoint, count: sectionFindings.length });
        panel.addReviewLog(`[${label}] Added ${sectionFindings.length} findings`, "success");
      }

      appendMissingRejectedFindings(combinedFindings, priorStoredBeforeRun, priorRejectedKeys);

      const preferredApplied = remapPriorAppliedIndicesToCombined(
        priorStoredBeforeRun?.findings,
        priorStoredBeforeRun?.appliedIndices,
        combinedFindings
      );
      const stagePayload: ReviewPayload = {
        summary: `Completed ${i + 1}/${REVIEW_SEQUENCE.length} review stages.`,
        findings: combinedFindings,
        sections,
        appliedIndices: findAppliedIndicesByKeys(combinedFindings, priorAppliedKeys, preferredApplied),
        appliedFindingKeys: priorAppliedKeys,
        rejectedIndices: [],
        rejectedFindingKeys: [],
      };
      const mergedStagePayload = mergeLiveFixStateIntoPayload(
        editor.document.uri,
        combinedFindings,
        stagePayload
      );
      panel.setReview(mergedStagePayload);
      panel.setBusy(true);
      panel.setStatus(`Running review suite… (${i + 1}/${REVIEW_SEQUENCE.length})`);
      const latestStageText = (await vscode.workspace.openTextDocument(editor.document.uri)).getText();
      await saveLastReview(toStoredReview(editor.document.uri, fileName, mergedStagePayload, latestStageText));
    }

    const finalPreferredApplied = remapPriorAppliedIndicesToCombined(
      priorStoredBeforeRun?.findings,
      priorStoredBeforeRun?.appliedIndices,
      combinedFindings
    );
    const finalReview: ReviewPayload = {
      summary: "Combined review completed across all review endpoints.",
      findings: combinedFindings,
      sections,
      appliedIndices: findAppliedIndicesByKeys(combinedFindings, priorAppliedKeys, finalPreferredApplied),
      appliedFindingKeys: priorAppliedKeys,
      rejectedIndices: [],
      rejectedFindingKeys: [],
    };
    const mergedFinalReview = mergeLiveFixStateIntoPayload(editor.document.uri, combinedFindings, finalReview);
    log.info("codeReview", "All review stages completed", { findings: combinedFindings.length });
    panel.addReviewLog("All review stages completed.", "success");
    const latestFinalText = (await vscode.workspace.openTextDocument(editor.document.uri)).getText();
    await saveLastReview(toStoredReview(editor.document.uri, fileName, mergedFinalReview, latestFinalText));
    log.debug("codeReview", "Last review saved to workspace state", { fileName });
    panel.setReview(mergedFinalReview);
    reviewRunDone = true;
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    const msg = sanitizeForLog(raw);
    log.error("codeReview", "runCodeReview failed", { error: msg });
    panel.setError(raw, undefined, "");
    vscode.window.showErrorMessage(`Code review failed: ${raw}`);
  } finally {
    reviewRunDone = true;
    runningReviewUris.delete(documentUri);
  }
}

function mergeLiveFixStateIntoPayload(
  uri: vscode.Uri,
  combinedFindings: ReviewFinding[],
  payload: ReviewPayload
): ReviewPayload {
  const live = getStoredReviewForDocumentUri(uri);
  if (!live) {
    return payload;
  }
  const liveAppliedKeys = live.appliedFindingKeys ?? [];
  const preferredApplied = remapPriorAppliedIndicesToCombined(live.findings, live.appliedIndices, combinedFindings);
  const mergedAppliedIndices = findAppliedIndicesByKeys(combinedFindings, liveAppliedKeys, preferredApplied);
  return {
    ...payload,
    appliedIndices: mergedAppliedIndices,
    appliedFindingKeys: Array.from(new Set([...(payload.appliedFindingKeys ?? []), ...liveAppliedKeys])).sort(),
    rejectedIndices: payload.rejectedIndices ?? [],
    rejectedFindingKeys: payload.rejectedFindingKeys ?? [],
  };
}

/** Carry forward dismissed rows when the model would otherwise repeat the same fingerprint. */
function appendMissingRejectedFindings(
  combinedFindings: ReviewFinding[],
  priorStored: StoredReview | undefined,
  rejectedKeys: string[]
): void {
  for (const key of rejectedKeys) {
    if (combinedFindings.some((f) => findingMatchesStoredKey(f, key))) {
      continue;
    }
    const oldF = priorStored?.findings?.find((f) => findingMatchesStoredKey(f, key));
    if (!oldF) {
      continue;
    }
    combinedFindings.push(oldF);
  }
}

function normalizeSeverity(raw: unknown): string {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "critical" || s === "high" || s === "major") {
    return s === "major" ? "high" : s;
  }
  if (s === "medium" || s === "minor") {
    return "medium";
  }
  if (s === "low" || s === "cosmetic") {
    return "low";
  }
  return "info";
}

function parseEndpointReviewJson(raw: string, endpoint: ReviewEndpoint): ReviewPayload {
  try {
    const parsed = JSON.parse(extractFirstJsonObject(raw)) as Record<string, unknown>;
    if (Array.isArray(parsed.findings)) {
      return parseReviewJson(raw);
    }

    const summary = typeof parsed.remarks === "string" ? parsed.remarks : `Generated ${REVIEW_ENDPOINT_LABELS[endpoint]} review.`;
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const findings = issues.map((issue, idx) => {
      const it = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
      const snippet = typeof it.identification === "string" ? it.identification : "";
      const explanation = typeof it.explanation === "string" ? it.explanation : "";
      const detail = [explanation, snippet ? `Code:\n${snippet}` : ""].filter(Boolean).join("\n\n");
      const title =
        (typeof it.policyReference === "string" && it.policyReference) ||
        (typeof it.ruleReference === "string" && it.ruleReference) ||
        (typeof it.issueType === "string" && it.issueType) ||
        (typeof it.violationType === "string" && it.violationType) ||
        `Issue ${idx + 1}`;

      return {
        severity: normalizeSeverity(it.severity),
        category:
          (typeof it.issueType === "string" && it.issueType) ||
          (typeof it.violationType === "string" && it.violationType) ||
          endpoint,
        title,
        detail: detail || "No details provided.",
        suggestion: typeof it.fix === "string" && it.fix ? it.fix : "No fix provided.",
      };
    });
    return { summary, findings };
  } catch {
    try {
      return parseReviewJson(raw);
    } catch {
      const fallbackSummary = raw.trim()
        ? `Generated ${REVIEW_ENDPOINT_LABELS[endpoint]} response could not be parsed as JSON. Showing raw output summary.`
        : `Generated ${REVIEW_ENDPOINT_LABELS[endpoint]} response was empty.`;
      return {
        summary: fallbackSummary,
        findings: raw.trim()
          ? [
              {
                severity: "info",
                category: endpoint,
                title: "Unstructured model response",
                detail: raw.trim().slice(0, 4000),
                suggestion: "Retry review or adjust prompt/template to enforce JSON output.",
              },
            ]
          : [],
      };
    }
  }
}

async function renderReviewPrompt(
  endpoint: ReviewEndpoint,
  code: string,
  gitDiff: string,
  language: string
): Promise<string> {
  return renderPromptTemplate(extensionContext.extensionPath, REVIEW_PROMPT_FILES[endpoint], {
    code,
    git_diff: gitDiff,
    language,
  });
}
