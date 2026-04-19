import * as vscode from "vscode";
import { registerReviewPanel, unregisterReviewPanel } from "../../../review/reviewBridge";
import { AssistantResultPanel } from "../../../assistant";

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
  /** Stable keys for fixes already applied on this file across reruns. */
  appliedFindingKeys?: string[];
  /** Stable keys for findings whose fix preview was rejected — persist across reruns like appliedFindingKeys. */
  rejectedFindingKeys?: string[];
  /** Row indices (0-based) where the user rejected the fix preview (can Retry). */
  rejectedIndices?: number[];
  /** Stable count of findings from the review (for Genie metrics when rows are filtered). */
  reviewFindingCount?: number;
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
  appliedFindingKeys?: string[];
  rejectedFindingKeys?: string[];
  rejectedIndices?: number[];
  /** SHA-256 of `document.getText()` when this payload was saved; stale when the buffer differs. */
  reviewedDocumentHash?: string;
  /** How many findings the review originally reported (never decreases; drives webview totals). */
  reviewFindingCount?: number;
}

export class ReviewWebviewSession {
  private readonly panel: AssistantResultPanel;
  private disposed = false;
  private choiceResolver?: (v: "accept" | "reject") => void;
  private latestSections: ReviewSectionPayload[] = [];
  /** Preserved so showFixDiff does not wipe applied/rejected indices in the Genie UI. */
  private lastReviewStructuredData: Record<string, unknown> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    title: string,
    private readonly documentUri: string | undefined
  ) {
    void title;
    registerReviewPanel(this);
    this.panel = new AssistantResultPanel(context, "Review", "review");
    this.panel.setMode("codeReview");
    this.subscriptions.push(
      this.panel.onFixDecisionRequested((value) => {
        const r = this.choiceResolver;
        this.choiceResolver = undefined;
        r?.(value);
      })
    );
  }

  getDocumentUri(): string | undefined {
    return this.documentUri;
  }

  setLoading(message?: string): void {
    if (this.disposed) return;
    this.panel.setBusy(true);
    this.panel.setStreamText("");
    this.panel.setStreamLive(true);
    this.panel.setStatus(message ?? "Generating structured review…");
    this.panel.setProgressStep("Review started");
  }

  addReviewLog(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    if (this.disposed) return;
    this.panel.setProgressStep(`[${level}] ${message}`);
  }

  setReviewStream(text: string): void {
    if (this.disposed) return;
    this.panel.setStreamText(text);
    if (text.trim().length > 0) {
      this.panel.setStreamLive(true);
    }
  }

  /** Clear buffer and show “waiting for tokens” before each review stage streams. */
  beginReviewStreamStage(): void {
    if (this.disposed) return;
    this.panel.setStreamText("");
    this.panel.setStreamLive(true);
  }

  setReview(payload: ReviewPayload): void {
    if (this.disposed) return;
    this.latestSections = payload.sections ?? [];
    const formattedFindings = (payload.findings ?? [])
      .map((f, i) => {
        return `${i + 1}. [${f.severity || "info"}] ${f.title || "Issue"}\nCategory: ${f.category || "-"}\nDetail: ${f.detail || "-"}\nSuggestion: ${f.suggestion || "-"}`;
      })
      .join("\n\n");
    const totalFindingsCount =
      typeof payload.reviewFindingCount === "number"
        ? Math.max(0, payload.reviewFindingCount)
        : payload.findings?.length ?? 0;
    const structuredData = {
      summary: payload.summary,
      findings: payload.findings,
      sections: payload.sections ?? [],
      appliedIndices: payload.appliedIndices ?? [],
      appliedFindingKeys: payload.appliedFindingKeys ?? [],
      rejectedFindingKeys: payload.rejectedFindingKeys ?? [],
      rejectedIndices: payload.rejectedIndices ?? [],
      totalFindingsCount,
      reviewFindingCount: totalFindingsCount,
    } as unknown as Record<string, unknown>;
    this.lastReviewStructuredData = structuredData;
    this.panel.setStreamText("");
    this.panel.setStreamLive(false);
    this.panel.setResult({
      remarks: payload.summary || "Review completed.",
      displayText: formattedFindings || "No findings.",
      endpoint: "codeReview",
      reviewMode: false,
      diffParts: [],
      applyCode: "",
      structuredData,
    });
    this.panel.setStatus("Review completed.");
    this.panel.setBusy(false);
    this.panel.setProgressStep("Done.");
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
    const reviewFindingCount =
      typeof stored.reviewFindingCount === "number"
        ? stored.reviewFindingCount
        : stored.findings?.length ?? 0;
    this.setReview({
      summary: stored.summary,
      findings: stored.findings,
      sections: mappedSections,
      appliedIndices: stored.appliedIndices ?? [],
      appliedFindingKeys: stored.appliedFindingKeys ?? [],
      rejectedFindingKeys: stored.rejectedFindingKeys ?? [],
      rejectedIndices: stored.rejectedIndices ?? [],
      reviewFindingCount,
    });
  }

  onDispose(callback: () => void): void {
    void callback;
  }

  setError(message: string, raw?: string, streamedText?: string): void {
    if (this.disposed) return;
    const text = [message, raw, streamedText].filter(Boolean).join("\n\n");
    this.panel.setStreamText("");
    this.panel.setStreamLive(false);
    this.panel.setError(text);
    this.panel.setBusy(false);
  }

  startFixStep(step: number, total: number, findingTitle: string): void {
    if (this.disposed) return;
    this.panel.setBusy(true);
    this.panel.setStatus(`Apply fix (${step}/${total})`);
    this.panel.setProgressStep(findingTitle || `Fix step ${step}`);
  }

  addFixLog(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    if (this.disposed) return;
    this.panel.setProgressStep(`[${level}] ${message}`);
  }

  showFixDiff(parts: Array<{ kind: "add" | "remove" | "same"; text: string }>): void {
    if (this.disposed) return;
    this.panel.setResult({
      remarks: "Review diff and accept or reject.",
      displayText: "",
      endpoint: "codeReview",
      reviewMode: true,
      diffParts: parts,
      applyCode: "pending",
      structuredData: this.lastReviewStructuredData ?? {},
    });
    this.panel.setBusy(false);
  }

  showFixError(message: string): void {
    if (this.disposed) return;
    this.panel.setError(message);
    this.panel.setBusy(false);
  }

  waitForFixChoice(): Promise<"accept" | "reject"> {
    return new Promise((resolve) => {
      this.choiceResolver = resolve;
    });
  }

  setApplyingFixIndex(index: number | null): void {
    if (this.disposed) return;
    this.panel.setApplyingFixIndex(index);
  }

  setApplyingFixAll(value: boolean): void {
    if (this.disposed) return;
    this.panel.setApplyingFixAll(value);
  }

  beginGuidedApplyStream(): void {
    if (this.disposed) return;
    this.panel.setStreamText("");
    this.panel.setStreamLive(true);
    this.panel.setBusy(true);
    this.panel.setStatus("Applying your extra instructions…");
  }

  setGuidedApplyStream(text: string): void {
    if (this.disposed) return;
    this.panel.setStreamText(text);
    this.panel.setStreamLive(true);
  }

  endGuidedApplyStream(): void {
    if (this.disposed) return;
    this.panel.setStreamLive(false);
    this.panel.setBusy(false);
  }

  registerOnMessage(handler: (msg: unknown) => void): vscode.Disposable {
    return this.panel.onMessage(handler);
  }

  dispose(): void {
    this.disposed = true;
    unregisterReviewPanel(this);
    this.choiceResolver?.("reject");
    while (this.subscriptions.length) {
      const d = this.subscriptions.pop();
      d?.dispose();
    }
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
