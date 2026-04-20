import * as vscode from "vscode";
import { hashDocumentText } from "../utils/documentHash";
import { notifyReviewUpdated } from "./reviewBridge";
import { getStoredReviewForDocumentUri, saveLastReview } from "./applyFixes";
import { isReviewStaleFlushSuppressed } from "./reviewStaleSuppress";

let debounceTimer: NodeJS.Timeout | undefined;

/** When the reviewed file buffer changes vs the snapshot taken at save time, clear stale findings so Genie stops showing outdated rows. */
export function registerReviewStaleWatcher(context: vscode.ExtensionContext): void {
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== "file") {
      return;
    }
    void handleMaybeStale(e.document);
  });
  context.subscriptions.push(sub);
}

async function handleMaybeStale(document: vscode.TextDocument): Promise<void> {
  if (isReviewStaleFlushSuppressed(document.uri)) {
    return;
  }
  const stored = getStoredReviewForDocumentUri(document.uri);
  if (!stored?.reviewedDocumentHash) {
    return;
  }
  if (!stored.findings?.length && !stored.appliedIndices?.length && !stored.rejectedIndices?.length) {
    return;
  }

  const now = hashDocumentText(document.getText());
  if (now === stored.reviewedDocumentHash) {
    return;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    void flushStaleReview(document.uri, document.getText());
  }, 450);
}

async function flushStaleReview(uri: vscode.Uri, latestText: string): Promise<void> {
  if (isReviewStaleFlushSuppressed(uri)) {
    return;
  }
  const stored = getStoredReviewForDocumentUri(uri);
  if (!stored?.reviewedDocumentHash) {
    return;
  }
  const now = hashDocumentText(latestText);
  if (now === stored.reviewedDocumentHash) {
    return;
  }

  /**
   * Only advance the snapshot hash to match the current buffer.
   * Clearing findings/applied state here made Apply fixes fail with “Run Code Review first”
   * after any edit (including successful fix applies once the suppress window ended).
   */
  const next = { ...stored, reviewedDocumentHash: now };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}
