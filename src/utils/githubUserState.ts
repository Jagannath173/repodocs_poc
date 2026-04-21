import type { ExtensionContext } from "vscode";

/** Single JSON blob in `globalState` after successful Copilot device sign-in. */
export const GITHUB_USER_PROFILE_KEY = "github_user_profile";

export interface GithubUserProfile {
  /** GitHub numeric user id as string */
  id: string;
  login: string;
  name: string;
  email: string;
}

export function getGithubUserProfile(context: ExtensionContext): GithubUserProfile | undefined {
  const raw = context.globalState.get<string>(GITHUB_USER_PROFILE_KEY);
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") {
      return undefined;
    }
    const o = data as Record<string, unknown>;
    const id = o.id != null ? String(o.id) : "";
    return {
      id,
      login: typeof o.login === "string" ? o.login : "",
      name: typeof o.name === "string" ? o.name : "",
      email: typeof o.email === "string" ? o.email : "",
    };
  } catch {
    return undefined;
  }
}

export async function clearGithubUserProfile(context: ExtensionContext): Promise<void> {
  await context.globalState.update(GITHUB_USER_PROFILE_KEY, undefined);
}

export async function setGithubUserProfile(
  context: ExtensionContext,
  profile: GithubUserProfile
): Promise<void> {
  await context.globalState.update(GITHUB_USER_PROFILE_KEY, JSON.stringify(profile));
}
