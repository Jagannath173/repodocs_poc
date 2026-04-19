import * as vscode from "vscode";
import { hashDocumentText } from "../utils/documentHash";
import { notifyReviewUpdated } from "./reviewBridge";
import { getStoredReview, saveLastReview } from "./applyFixes";
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
  const stored = getStoredReview();
  if (!stored?.reviewedDocumentHash || stored.documentUri !== document.uri.toString()) {
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
  const stored = getStoredReview();
  if (!stored?.reviewedDocumentHash || stored.documentUri !== uri.toString()) {
    return;
  }
  const now = hashDocumentText(latestText);
  if (now === stored.reviewedDocumentHash) {
    return;
  }

  await saveLastReview({
    documentUri: stored.documentUri,
    fileName: stored.fileName,
    summary:
      "This file was edited after the last review. Run **Code Review: Review** again — with local git changes you will only review the diff vs HEAD.",
    findings: [],
    appliedIndices: [],
    appliedFindingKeys: [],
    rejectedIndices: [],
    reviewedDocumentHash: now,
    reviewFindingCount: 0,
  });
  notifyReviewUpdated({
    documentUri: stored.documentUri,
    fileName: stored.fileName,
    summary:
      "This file was edited after the last review. Run Code Review again to analyze your current changes (incremental diff when available).",
    findings: [],
    appliedIndices: [],
    appliedFindingKeys: [],
    rejectedIndices: [],
    reviewedDocumentHash: now,
    reviewFindingCount: 0,
  });
}
