import type { ReviewTableState } from "../commands/webview/review_Webview/reviewPanel";

export type { ReviewTableState } from "../commands/webview/review_Webview/reviewPanel";

/** Panels that can refresh when workspace-stored review state changes (e.g. after a fix). */
export interface ReviewPanelLike {
  refreshFromStored(stored: ReviewTableState): void;
  getDocumentUri(): string | undefined;
  isDisposed?(): boolean;
  /** When present, called before a new review session for the same file so stale panels do not steal extension messages. */
  dispose?(): void;
  startFixStep(step: number, total: number, findingTitle: string): void;
  addFixLog(message: string, level?: "info" | "warn" | "error" | "success"): void;
  showFixDiff(parts: Array<{ kind: "add" | "remove" | "same"; text: string }>): void;
  showFixError(message: string): void;
  waitForFixChoice(): Promise<"accept" | "reject">;
  /** Highlights which finding row is currently running a fix (spinner in UI). */
  setApplyingFixIndex(index: number | null): void;
  /** "Fix All One by One" is running — toolbar button shows Applying… and row Fixes are gated. */
  setApplyingFixAll(value: boolean): void;
  /** Stream model output in Genie when running apply-with-extra with no pending findings (holistic pass). */
  beginGuidedApplyStream(): void;
  setGuidedApplyStream(text: string): void;
  endGuidedApplyStream(): void;
  /** Bring the review webview to foreground when needed (e.g. stop requested). */
  reveal?(): void;
}

const registered = new Set<ReviewPanelLike>();

export function registerReviewPanel(panel: ReviewPanelLike): void {
  registered.add(panel);
}

export function unregisterReviewPanel(panel: ReviewPanelLike): void {
  registered.delete(panel);
}

/** Notify every open review webview that matches the stored file (not only a single "active" pointer). */
export function notifyReviewUpdated(stored: ReviewTableState): void {
  for (const p of registered) {
    const uri = p.getDocumentUri();
    if (uri !== undefined && uri === stored.documentUri) {
      p.refreshFromStored(stored);
    }
  }
}

export function getReviewPanelForDocument(documentUri: string): ReviewPanelLike | undefined {
  for (const p of registered) {
    if (p.getDocumentUri() === documentUri) {
      return p;
    }
  }
  return undefined;
}

/** Drop every open review panel for this document so the next session is the sole handler (stable Genie session id overwrites listeners). */
export function disposeReviewPanelsForDocument(documentUri: string): void {
  const snapshot = [...registered];
  for (const p of snapshot) {
    if (p.getDocumentUri() === documentUri) {
      p.dispose?.();
    }
  }
}
