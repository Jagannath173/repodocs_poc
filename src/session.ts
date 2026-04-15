import { extensionContext } from "./extension";
import { openAuthWebviewAndAuthenticate } from "./authPanel";

export async function ensureCopilotSession(): Promise<boolean> {
  const storedSessionId = extensionContext.globalState.get<string>("copilot_session_id");
  const storedAccessToken = extensionContext.globalState.get<string>("copilot_access_token_override");
  if (storedSessionId || storedAccessToken) {
    return true;
  }
  return openAuthWebviewAndAuthenticate(extensionContext);
}
