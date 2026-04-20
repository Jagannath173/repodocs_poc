import * as vscode from "vscode";
import { registerReviewPanel, unregisterReviewPanel } from "../../../review/reviewBridge";
import { AssistantResultPanel } from "../../../assistant";
import { basenameFromUriString, resolveAppliedFixRecordsForUi } from "../../../review/reviewReportDemo";

export interface ReviewFinding {
  severity: string;
  category: string;
  title: string;
  detail: string;
  suggestion: string;
}

/** One accepted fix: text fields + unified diff for reports. */
export interface AppliedFixRecord {
  findingIndex: number;
  title: string;
  detail: string;
  suggestion: string;
  severity: string;
  category: string;
  /** Unified diff snippet (before → after for this fix). */
  unifiedDiff: string;
  appliedAt?: string;
  /** True when this row is generated sample data (no real fix recorded yet). */
  isDemo?: boolean;
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
  /** Per-accepted-fix diffs for export / “Review fix” panel. */
  appliedFixRecords?: AppliedFixRecord[];
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
  appliedFixRecords?: AppliedFixRecord[];
}

export class ReviewWebviewSession {
  private readonly panel: AssistantResultPanel;
  private disposed = false;
  private choiceResolver?: (v: "accept" | "reject") => void;
  private latestSections: ReviewSectionPayload[] = [];
  /** Preserved so showFixDiff does not wipe applied/rejected indices in the Genie UI. */
  private lastReviewStructuredData: Record<string, unknown> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly disposeCallbacks = new Set<() => void>();

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

  isDisposed(): boolean {
    return this.disposed;
  }

  setLoading(message?: string): void {
    if (this.disposed) return;
    this.panel.setBusy(true);
    this.panel.setStreamText("");
    this.panel.setStreamLive(true);
    this.panel.setStatus(message ?? "Generating structured review…");
    this.panel.setProgressStep("Review started");
  }

  setBusy(value: boolean): void {
    if (this.disposed) return;
    this.panel.setBusy(value);
  }

  setStatus(message: string): void {
    if (this.disposed) return;
    this.panel.setStatus(message);
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
    const findingsLen = payload.findings?.length ?? 0;
    const appliedKeyCount = payload.appliedFindingKeys?.length ?? 0;
    const rejectedKeyCount = payload.rejectedFindingKeys?.length ?? 0;
    const declaredCount =
      typeof payload.reviewFindingCount === "number" && !Number.isNaN(payload.reviewFindingCount)
        ? Math.max(0, payload.reviewFindingCount)
        : findingsLen;
    /** Keep totals truthful when `findings` is empty but fingerprint fix state persists (re-review, cleared table). */
    const totalFindingsCount = Math.max(declaredCount, findingsLen, appliedKeyCount + rejectedKeyCount);
    const reportLabel = basenameFromUriString(this.documentUri);
    const resolved = resolveAppliedFixRecordsForUi(payload.appliedFixRecords, reportLabel);
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
      appliedFixRecords: resolved.records,
      usingDemoFixRecords: resolved.usingDemo,
      reportFileLabel: reportLabel,
    } as unknown as Record<string, unknown>;
    this.lastReviewStructuredData = structuredData;
    this.panel.setStreamText("");
    this.panel.setStreamLive(false);
    this.panel.setResult({
      remarks: "",
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
    const storedDeclared =
      typeof stored.reviewFindingCount === "number" && !Number.isNaN(stored.reviewFindingCount)
        ? stored.reviewFindingCount
        : 0;
    const storedFindingsLen = stored.findings?.length ?? 0;
    const storedAppliedK = stored.appliedFindingKeys?.length ?? 0;
    const storedRejectedK = stored.rejectedFindingKeys?.length ?? 0;
    const reviewFindingCount = Math.max(
      storedDeclared,
      storedFindingsLen,
      storedAppliedK + storedRejectedK
    );
    this.setReview({
      summary: stored.summary,
      findings: stored.findings,
      sections: mappedSections,
      appliedIndices: stored.appliedIndices ?? [],
      appliedFindingKeys: stored.appliedFindingKeys ?? [],
      rejectedFindingKeys: stored.rejectedFindingKeys ?? [],
      rejectedIndices: stored.rejectedIndices ?? [],
      reviewFindingCount,
      appliedFixRecords: stored.appliedFixRecords,
    });
  }

  onDispose(callback: () => void): void {
    if (this.disposed) {
      callback();
      return;
    }
    this.disposeCallbacks.add(callback);
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cb of this.disposeCallbacks) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
    this.disposeCallbacks.clear();
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
