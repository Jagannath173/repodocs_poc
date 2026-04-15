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
import { saveLastReview, toStoredReview } from "./applyFixes";
import { openAuthWebviewAndAuthenticate } from "./authPanel";
import { renderPromptTemplate } from "./promptRenderer";

const REVIEW_SYSTEM_ROLE = "Respond with only a valid JSON object and no extra text.";

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
  if (!(await ensureCopilotSession())) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  let content = "";
  if (editor) {
    content = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  }

  if (!content.trim()) {
    vscode.window.showWarningMessage("Open a file (or select code) to review.");
    return;
  }

  const fileName = editor ? path.basename(editor.document.fileName) : "snippet";
  const language = editor?.document.languageId ?? "unknown";

  const documentUri = editor ? editor.document.uri.toString() : undefined;
  const panel = new ReviewWebviewSession(extensionContext, `Review: ${fileName}`, documentUri);
  panel.setLoading("Running review suite…");
  panel.registerOnMessage((msg: unknown) => {
    const m = msg as { command?: string; mode?: string; index?: number; promptExtra?: boolean };
    if (m?.command === "applyFixes") {
      const mode = m.mode === "one" ? "one" : "all";
      const idx = typeof m.index === "number" ? m.index : undefined;
      if (m.promptExtra) {
        void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx);
      } else {
        void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, "");
      }
    } else if (m?.command === "authenticate") {
      void vscode.commands.executeCommand("codeReview.authenticate");
    }
  });

  const output = vscode.window.createOutputChannel("Code Review");
  const sections: ReviewSectionPayload[] = [];
  const combinedFindings: ReviewPayload["findings"] = [];

  try {
    for (let i = 0; i < REVIEW_SEQUENCE.length; i++) {
      const endpoint = REVIEW_SEQUENCE[i];
      const label = REVIEW_ENDPOINT_LABELS[endpoint];
      const prompt = await renderReviewPrompt(endpoint, content, language);
      panel.addReviewLog(`Running ${label} review (${i + 1}/${REVIEW_SEQUENCE.length})…`, "info");
      panel.addReviewLog(`[${label}] Started`, "info");
      let assistantText = "";
      let authError = false;

      await runCopilotInference(
        extensionContext,
        prompt,
        (data) => {
          output.append(data);
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
              const chunkPreview = text.replace(/\s+/g, " ").trim();
              if (chunkPreview) {
                panel.addReviewLog(`[${label}] ${chunkPreview}`, "info");
              }
            }
          } catch {
            /* non-JSON SSE line */
          }
        },
        { systemRole: REVIEW_SYSTEM_ROLE }
      );

      if (authError) {
        panel.dispose();
        const ok = await openAuthWebviewAndAuthenticate(extensionContext);
        if (ok) {
          await runCodeReview();
        }
        return;
      }

      const review = parseEndpointReviewJson(assistantText, endpoint);
      const sectionFindings = review.findings.map((f) => {
        const globalIndex = combinedFindings.length;
        combinedFindings.push(f);
        return { ...f, globalIndex };
      });
      sections.push({
        name: label,
        summary: review.summary || `${label} review complete.`,
        findings: sectionFindings,
      });

      panel.addReviewLog(`[${label}] Added ${sectionFindings.length} findings`, "success");
      panel.setReview({
        summary: `Completed ${i + 1}/${REVIEW_SEQUENCE.length} review stages.`,
        findings: combinedFindings,
        sections,
        appliedIndices: [],
      });
    }

    const finalReview: ReviewPayload = {
      summary: "Combined review completed across all review endpoints.",
      findings: combinedFindings,
      sections,
      appliedIndices: [],
    };
    panel.addReviewLog("All review stages completed.", "success");
    if (editor) {
      await saveLastReview(toStoredReview(editor.document.uri, fileName, finalReview));
    }
    panel.setReview(finalReview);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
    panel.setError(msg, undefined, "");
    vscode.window.showErrorMessage(`Code review failed: ${msg}`);
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
    return parseReviewJson(raw);
  }
}

async function renderReviewPrompt(endpoint: ReviewEndpoint, code: string, language: string): Promise<string> {
  return renderPromptTemplate(extensionContext.extensionPath, REVIEW_PROMPT_FILES[endpoint], {
    code,
    git_diff: code,
    language,
  });
}
