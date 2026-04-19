import * as vscode from "vscode";

/** URIs for which programmatic edits (fix preview, apply fixes) must not trigger review wipe. */
const suppressed = new Set<string>();

export function suppressReviewStaleFlushForUri(uri: vscode.Uri): vscode.Disposable {
  const key = uri.toString();
  suppressed.add(key);
  return new vscode.Disposable(() => suppressed.delete(key));
}

export function isReviewStaleFlushSuppressed(uri: vscode.Uri): boolean {
  return suppressed.has(uri.toString());
}
