import * as vscode from "vscode";

/**
 * Stable `file:` URI string for workspace lookups (encoding + drive letter casing on Windows).
 */
export function canonicalizeDocumentUriString(uriStr: string): string {
  try {
    const u = vscode.Uri.parse(uriStr);
    if (u.scheme === "file") {
      return vscode.Uri.file(u.fsPath).toString();
    }
    return u.toString();
  } catch {
    return uriStr;
  }
}

export function canonicalizeDocumentUri(uri: vscode.Uri): string {
  if (uri.scheme === "file") {
    return vscode.Uri.file(uri.fsPath).toString();
  }
  return uri.toString();
}
