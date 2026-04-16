import * as vscode from "vscode";
import { authenticateCopilot } from "./pythonRunner";
import { log, sanitizeForLog } from "./logger";
import { AssistantResultPanel } from "./assistantPanel";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function authWebviewHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      padding: 20px 24px 32px;
      max-width: 520px;
      margin: 0 auto;
    }
    h1 { font-size: 1.15em; font-weight: 600; margin: 0 0 12px; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-bottom: 20px; }
    .url-box {
      word-break: break-all;
      padding: 10px 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border);
      margin-bottom: 16px;
      font-size: 0.95em;
    }
    .otp {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 1.75em;
      letter-spacing: 0.12em;
      font-weight: 600;
      padding: 14px 16px;
      text-align: center;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      margin: 12px 0 16px;
      user-select: all;
    }
    button {
      display: inline-block;
      margin-right: 8px;
      margin-bottom: 8px;
      padding: 8px 14px;
      font-size: 1em;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 4px;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    #status { margin-top: 16px; font-size: 0.9em; color: var(--vscode-descriptionForeground); min-height: 1.2em; }
    #error { margin-top: 16px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>Sign in to GitHub Copilot</h1>
  <p class="muted">Complete sign-in in your browser using the one-time code below. This tab closes automatically when sign-in succeeds.</p>
  <div id="waiting" class="muted">Starting sign-in…</div>
  <div id="auth-block" class="hidden">
    <div><strong>Step 1 — Open this URL</strong></div>
    <div class="url-box" id="url-text"></div>
    <button type="button" id="btn-open">Open in browser</button>
    <div><strong>Step 2 — Enter this code</strong></div>
    <div class="otp" id="otp-text"></div>
    <button type="button" class="secondary" id="btn-copy">Copy code</button>
  </div>
  <div id="status"></div>
  <div id="error" class="hidden"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const waiting = document.getElementById("waiting");
    const authBlock = document.getElementById("auth-block");
    const urlText = document.getElementById("url-text");
    const otpText = document.getElementById("otp-text");
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");

    document.getElementById("btn-open").addEventListener("click", () => {
      const url = urlText.textContent || "";
      vscode.postMessage({ type: "openUrl", url });
    });
    document.getElementById("btn-copy").addEventListener("click", () => {
      const code = otpText.textContent || "";
      vscode.postMessage({ type: "copyCode", code });
    });

    window.addEventListener("message", (event) => {
      const m = event.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "auth") {
        waiting.classList.add("hidden");
        authBlock.classList.remove("hidden");
        urlText.textContent = m.url || "";
        otpText.textContent = m.code || "";
        statusEl.textContent = "Waiting for you to authorize in the browser…";
      }
      if (m.type === "poll") {
        statusEl.textContent = m.status || "";
      }
      if (m.type === "error") {
        errorEl.classList.remove("hidden");
        errorEl.textContent = m.message || "Sign-in failed.";
        waiting.classList.add("hidden");
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Shows URL and device code in a webview; closes automatically on success. No toast banners.
 */
export function openAuthWebviewAndAuthenticate(context: vscode.ExtensionContext): Promise<boolean> {
  log.info("auth", "Opening Copilot sign-in webview");
  return new Promise((resolve) => {
    let finished = false;
    const panel = new AssistantResultPanel(context, "Authenticate");
    panel.setMode("authenticate");
    panel.setBusy(true);
    panel.setStatus("Starting sign-in...");
    panel.setProgressStep("Requesting device code...");
    panel.setUserQuestion("Authenticate GitHub Copilot");

    const done = (success: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      if (success) {
        log.info("auth", "Copilot sign-in finished successfully");
        panel.setStatus("Authentication successful.");
      } else {
        log.debug("auth", "Sign-in finished without success");
        panel.setStatus("Authentication ended.");
      }
      resolve(success);
    };

    authenticateCopilot(
      context,
      (line) => log.proxyLine("auth", line),
      {
        onAuthRequired: (url, code) => {
          void vscode.env.openExternal(vscode.Uri.parse(url));
          void vscode.env.clipboard.writeText(code);
          panel.setAuthData(url, code);
          panel.setStatus("Waiting for user authentication...");
          panel.setProgressStep("Waiting for browser authorization...");
        },
        onPollingStatus: (status) => {
          panel.setStatus(status || "Waiting for authorization...");
        },
        onAuthSuccess: () => {
          panel.close();
          done(true);
        },
      }
    )
      .then(() => {
        if (!finished) {
          done(true);
        }
      })
      .catch((e: Error) => {
        log.error("auth", "authenticateCopilot failed", { error: sanitizeForLog(e.message || String(e)) });
        if (!finished) {
          panel.setError(e.message || String(e));
          finished = true;
          resolve(false);
        }
      });
  });
}
