import * as vscode from "vscode";
import * as path from "node:path";
import { runCopilotInference } from "./pythonRunner";
import { extensionContext } from "./extension";
import {
  extractFirstJsonObject,
  parseReviewJson,
  ReviewPayload,
  ReviewSectionPayload,
  ReviewWebviewSession,
} from "./reviewPanel";
import { ensureCopilotSession } from "./session";
import { findAppliedIndicesByKeys, getStoredReview, makeFindingKey, saveLastReview, toStoredReview } from "./applyFixes";
import { isFindingAlreadySatisfiedByFile } from "./reviewFilter";
import { openAuthWebviewAndAuthenticate } from "./authPanel";
import { renderPromptTemplate } from "./promptRenderer";
import { log, sanitizeForLog } from "./logger";
import { resetMockReviewStage } from "./mockCopilot";

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
  let content = "";
  if (editor) {
    content = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  }

  if (!content.trim()) {
    log.warn("codeReview", "Aborted: no content to review");
    vscode.window.showWarningMessage("Open a file (or select code) to review.");
    return;
  }

  const fileName = editor ? path.basename(editor.document.fileName) : "snippet";
  const language = editor?.document.languageId ?? "unknown";
  const selectionMode = editor && !editor.selection.isEmpty ? "selection" : "fullDocument";
  log.info("codeReview", "Review context", {
    fileName,
    language,
    selectionMode,
    charCount: content.length,
  });

  const documentUri = editor ? editor.document.uri.toString() : undefined;
  const panel = new ReviewWebviewSession(extensionContext, `Review: ${fileName}`, documentUri);
  const priorStored = documentUri ? getStoredReview() : undefined;
  const priorAppliedKeys =
    priorStored?.documentUri === documentUri ? (priorStored?.appliedFindingKeys ?? []) : [];
  const priorAppliedKeySet = new Set(priorAppliedKeys);

  panel.setLoading("Running review suite…");
  panel.registerOnMessage((msg: unknown) => {
    const m = msg as { command?: string; mode?: string; index?: number; indices?: number[]; promptExtra?: boolean };
    if (m?.command === "applyFixes") {
      const mode = m.mode === "one" || m.mode === "selected" ? m.mode : "all";
      const idx = typeof m.index === "number" ? m.index : undefined;
      const selectedIndices = Array.isArray(m.indices) ? m.indices.filter((n) => typeof n === "number") : undefined;
      if (m.promptExtra) {
        void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, undefined, selectedIndices);
      } else {
        void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, "", selectedIndices);
      }
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
      const prompt = await renderReviewPrompt(endpoint, content, language);
      log.debug("codeReview", "Prompt template rendered", { endpoint, promptChars: prompt.length });
      panel.addReviewLog(`Running ${label} review (${i + 1}/${REVIEW_SEQUENCE.length})…`, "info");
      panel.addReviewLog(`[${label}] Started`, "info");
      let assistantText = "";
      let authError = false;
      panel.setReviewStream("");

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
        { systemRole: REVIEW_SYSTEM_ROLE }
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
      const filtered = review.findings.filter((f) => !isFindingAlreadySatisfiedByFile(content, f));
      const skippedSatisfied = review.findings.length - filtered.length;
      if (skippedSatisfied > 0) {
        panel.addReviewLog(`[${label}] Skipped ${skippedSatisfied} finding(s) whose suggestions already match the file.`, "info");
      }
      const unseen = filtered.filter((f) => !priorAppliedKeySet.has(makeFindingKey(f)));
      const skippedApplied = filtered.length - unseen.length;
      if (skippedApplied > 0) {
        panel.addReviewLog(`[${label}] Skipped ${skippedApplied} previously applied finding(s).`, "info");
      }
      if (unseen.length === 0) {
        if (review.findings.length > 0 || skippedApplied > 0) {
          panel.addReviewLog(`[${label}] No new rows — all suggestions for this stage already appear in the file.`, "info");
        }
        continue;
      }
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
      const stagePayload: ReviewPayload = {
        summary: `Completed ${i + 1}/${REVIEW_SEQUENCE.length} review stages.`,
        findings: combinedFindings,
        sections,
        appliedIndices: findAppliedIndicesByKeys(combinedFindings, priorAppliedKeys),
        appliedFindingKeys: priorAppliedKeys,
        rejectedIndices: [],
      };
      panel.setReview(stagePayload);
      if (editor) {
        await saveLastReview(toStoredReview(editor.document.uri, fileName, stagePayload));
      }
    }

    const finalReview: ReviewPayload = {
      summary: "Combined review completed across all review endpoints.",
      findings: combinedFindings,
      sections,
      appliedIndices: findAppliedIndicesByKeys(combinedFindings, priorAppliedKeys),
      appliedFindingKeys: priorAppliedKeys,
      rejectedIndices: [],
    };
    log.info("codeReview", "All review stages completed", { findings: combinedFindings.length });
    panel.addReviewLog("All review stages completed.", "success");
    if (editor) {
      await saveLastReview(toStoredReview(editor.document.uri, fileName, finalReview));
      log.debug("codeReview", "Last review saved to workspace state", { fileName });
    }
    panel.setReview(finalReview);
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    const msg = sanitizeForLog(raw);
    log.error("codeReview", "runCodeReview failed", { error: msg });
    panel.setError(raw, undefined, "");
    vscode.window.showErrorMessage(`Code review failed: ${raw}`);
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

async function renderReviewPrompt(endpoint: ReviewEndpoint, code: string, language: string): Promise<string> {
  return renderPromptTemplate(extensionContext.extensionPath, REVIEW_PROMPT_FILES[endpoint], {
    code,
    git_diff: code,
    language,
  });
}
