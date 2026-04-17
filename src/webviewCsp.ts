import * as vscode from "vscode";

/**
 * CSP for extension webviews (VS Code / Cursor). Allows themed styles, nonced inline scripts,
 * and common resource types so the panel does not render as a blank/black screen.
 */
export function buildWebviewCsp(webview: vscode.Webview, nonce: string): string {
  const src = webview.cspSource;
  return [
    "default-src 'none'",
    `style-src ${src} 'unsafe-inline'`,
    `script-src ${src} 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval'`,
    `font-src ${src}`,
    `img-src ${src} https: data: blob:`,
    `connect-src ${src}`,
  ].join("; ");
}
