import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildWebviewCsp } from "../../../utils/webviewCsp";

/**
 * Loads the Genie webview shell from `media/genie/panel.html` and wires CSP + extension asset URIs.
 * Styles and script live as real files under `media/genie/` (packaged with the extension), similar to
 * typical VS Code extensions such as [Genie-vscode](https://github.com/Bilvantis-NeoAI/Genie-vscode/tree/hsbc/poc/jp_08102025/genie-vscode).
 */
export function buildGeniePanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "genie", "panel.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "genie", "panel.js"));
  const htmlPath = path.join(extensionUri.fsPath, "media", "genie", "panel.html");
  const template = fs.readFileSync(htmlPath, "utf8");
  const csp = buildWebviewCsp(webview, nonce);
  return template
    .replace(/__CSP__/g, csp)
    .replace(/__NONCE__/g, nonce)
    .replace(/__CSS_URI__/g, cssUri.toString())
    .replace(/__JS_URI__/g, jsUri.toString());
}
