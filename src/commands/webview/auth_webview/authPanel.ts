import * as vscode from "vscode";
import { authenticateCopilot } from "../../../utils/pythonRunner";
import { log, sanitizeForLog } from "../../../utils/logger";
import { AssistantResultPanel } from "../../../assistant";
import { useMockCopilotEnabled } from "../../../utils/mockCopilot";

function hasStoredCopilotCredentials(context: vscode.ExtensionContext): boolean {
  const storedSessionId = context.globalState.get<string>("copilot_session_id");
  const storedAccessToken = context.globalState.get<string>("copilot_access_token_override");
  return Boolean(storedSessionId || storedAccessToken);
}

/**
 * Device-code sign-in without opening the Genie "Authenticate" tab — used from apply-fix so the review UI stays visible.
 */
export async function authenticateCopilotWithToastUi(context: vscode.ExtensionContext): Promise<boolean> {
  if (useMockCopilotEnabled()) {
    return true;
  }
  if (hasStoredCopilotCredentials(context)) {
    return true;
  }
  log.info("auth", "Apply fixes: starting compact Copilot sign-in (no Genie auth tab)");
  try {
    await authenticateCopilot(context, (line) => log.proxyLine("auth", line), {
      onAuthRequired: (url, code) => {
        void vscode.env.openExternal(vscode.Uri.parse(url));
        void vscode.env.clipboard.writeText(code);
        void vscode.window.showInformationMessage(
          `GitHub Copilot: complete sign-in in the browser. Device code copied to clipboard (${code}).`,
          "OK"
        );
      },
      onPollingStatus: (status) => {
        if (status) {
          void vscode.window.setStatusBarMessage(`Copilot: ${status}`, 4000);
        }
      },
      onAuthSuccess: () => {},
    });
    return hasStoredCopilotCredentials(context);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("auth", "Compact sign-in failed", { error: sanitizeForLog(msg) });
    void vscode.window.showWarningMessage(`Copilot sign-in failed or was cancelled: ${msg}`);
    return false;
  }
}

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
