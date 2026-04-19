import { extensionContext } from "../extension";
import { openAuthWebviewAndAuthenticate } from "../commands/webview/auth_webview/authPanel";
import { log } from "./logger";
import { useMockCopilotEnabled } from "./mockCopilot";

export async function ensureCopilotSession(): Promise<boolean> {
  if (useMockCopilotEnabled()) {
    log.debug("session", "Mock Copilot enabled — skipping sign-in");
    return true;
  }
  const storedSessionId = extensionContext.globalState.get<string>("copilot_session_id");
  const storedAccessToken = extensionContext.globalState.get<string>("copilot_access_token_override");
  if (storedSessionId || storedAccessToken) {
    log.debug("session", "Using stored Copilot session credentials");
    return true;
  }
  log.info("session", "No Copilot session in storage; opening sign-in");
  return openAuthWebviewAndAuthenticate(extensionContext);
}
