import type { ReviewTableState } from "./reviewPanel";

export type { ReviewTableState } from "./reviewPanel";

/** Panels that can refresh when workspace-stored review state changes (e.g. after a fix). */
export interface ReviewPanelLike {
  refreshFromStored(stored: ReviewTableState): void;
  getDocumentUri(): string | undefined;
  startFixStep(step: number, total: number, findingTitle: string): void;
  addFixLog(message: string, level?: "info" | "warn" | "error" | "success"): void;
  showFixDiff(parts: Array<{ kind: "add" | "remove" | "same"; text: string }>): void;
  showFixError(message: string): void;
  waitForFixChoice(): Promise<"accept" | "reject">;
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
