import * as vscode from "vscode";

const SCHEME = "repodocs-assistant-diff";

type Session = { original: string; modified: string };

const sessions = new Map<string, Session>();

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function newSessionId(): string {
  let s = "";
  for (let i = 0; i < 22; i++) {
    s += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return s;
}

function uriFor(sessionId: string, side: "original" | "modified"): vscode.Uri {
  const q = new URLSearchParams({ session: sessionId, side });
  return vscode.Uri.from({ scheme: SCHEME, path: "/diff", query: q.toString() });
}

let providerRegistered = false;

function ensureProviderRegistered(context: vscode.ExtensionContext): void {
  if (providerRegistered) {
    return;
  }
  providerRegistered = true;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const params = new URLSearchParams(uri.query);
      const id = params.get("session");
      const side = params.get("side") as "original" | "modified" | null;
      if (!id || (side !== "original" && side !== "modified")) {
        return "";
      }
      const sess = sessions.get(id);
      if (!sess) {
        return "";
      }
      return side === "original" ? sess.original : sess.modified;
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
}

function scheduleCleanup(id: string): void {
  setTimeout(() => {
    sessions.delete(id);
  }, 120_000);
}

/**
 * Opens the built-in side-by-side diff editor (same as file compare), using in-memory originals.
 */
export async function openAssistantNativeDiff(
  context: vscode.ExtensionContext,
  originalText: string,
  modifiedText: string,
  title: string
): Promise<void> {
  ensureProviderRegistered(context);
  const id = newSessionId();
  sessions.set(id, { original: originalText, modified: modifiedText });
  scheduleCleanup(id);

  const left = uriFor(id, "original");
  const right = uriFor(id, "modified");
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: false,
    preserveFocus: false,
  });
}
