import * as vscode from "vscode";
import { authenticateCopilot } from "../../../utils/pythonRunner";
import { log, sanitizeForLog } from "../../../utils/logger";
import { AssistantResultPanel } from "../../../assistant";

/**
 * Shows URL and device code in a webview; closes automatically on success. No toast banners.
 */
export function openAuthWebviewAndAuthenticate(context: vscode.ExtensionContext): Promise<boolean> {
  log.info("auth", "Opening Copilot sign-in webview");
  return new Promise((resolve) => {
    let finished = false;
    const panel = new AssistantResultPanel(context, "Authenticate", "authenticate");
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
