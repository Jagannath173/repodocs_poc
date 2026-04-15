import type { ReviewTableState } from "./reviewPanel";

export type { ReviewTableState } from "./reviewPanel";

/** Panels that can refresh when workspace-stored review state changes (e.g. after a fix). */
export interface ReviewPanelLike {
  refreshFromStored(stored: ReviewTableState): void;
  getDocumentUri(): string | undefined;
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
