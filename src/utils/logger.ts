import * as vscode from "vscode";

const CHANNEL_NAME = "Code Review";

let channel: vscode.OutputChannel | null = null;
let subscriptionRegistered = false;

/**
 * Call from `activate()` so the output channel is disposed with the extension.
 * Safe to call multiple times; the channel is only added to subscriptions once.
 */
export function initExtensionLogger(context: vscode.ExtensionContext): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  if (!subscriptionRegistered && channel) {
    context.subscriptions.push(channel);
    subscriptionRegistered = true;
  }
}

/** Focuses the Output panel and selects this extension's log channel. */
export function showExtensionLogs(): void {
  out().show(true);
}

function out(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return channel;
}

export type LogFields = Record<string, string | number | boolean | undefined>;

function formatLine(level: string, scope: string, message: string, fields?: LogFields): string {
  const ts = new Date().toISOString();
  let extra = "";
  if (fields) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        parts.push(`${k}=${String(v)}`);
      }
    }
    if (parts.length) {
      extra = ` | ${parts.join(" ")}`;
    }
  }
  return `[${ts}] [${level}] [${scope}] ${message}${extra}`;
}

function appendLine(level: string, scope: string, message: string, fields?: LogFields): void {
  out().appendLine(formatLine(level, scope, message, fields));
}

/** Redacts path-like segments and long token-like strings for safe diagnostics. */
export function sanitizeForLog(s: string, maxLen = 400): string {
  return s
    .slice(0, maxLen)
    .replace(/([A-Za-z]:)?[\\/][^\s"'[\]]{2,}/g, "<path>")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "<redacted>");
}

/**
 * Logs lines from the Copilot Python helper: never logs SSE JSON bodies, session id values,
 * or device-flow URL/code lines in full.
 */
function appendProxyLine(scope: string, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.startsWith("AUTH_REQUIRED|")) {
    appendLine("INFO", scope, "Device authorization required (URL and user code not logged)");
    return;
  }
  if (trimmed.startsWith("POLLING_STATUS|")) {
    const status = trimmed.slice("POLLING_STATUS|".length).trim().slice(0, 160);
    appendLine("DEBUG", scope, "Auth polling status", { status: status || "(empty)" });
    return;
  }
  if (trimmed.includes("SESSION_ID|")) {
    appendLine("INFO", scope, "Copilot session id stored (value not logged)");
    return;
  }
  if (trimmed.startsWith("data: ")) {
    appendLine("DEBUG", scope, "SSE data line", { chars: trimmed.length });
    return;
  }
  if (trimmed.includes("Error: No active Copilot session")) {
    appendLine("WARN", scope, "No active Copilot session");
    return;
  }
  if (trimmed.startsWith("[Python Error]")) {
    const rest = trimmed.slice("[Python Error]".length).trim();
    appendLine("ERROR", scope, "Python stderr (Copilot proxy)", { detail: sanitizeForLog(rest) });
    return;
  }
  if (trimmed.startsWith("[Python Auth]")) {
    const rest = trimmed.slice("[Python Auth]".length).trim();
    appendLine("ERROR", scope, "Python stderr (auth)", { detail: sanitizeForLog(rest) });
    return;
  }
  if (trimmed.startsWith(">>> ")) {
    appendLine("INFO", scope, "Proxy status", { msg: trimmed.slice(4).slice(0, 300) });
    return;
  }
  if (trimmed.startsWith("AUTH_ERROR|")) {
    const err = trimmed.slice("AUTH_ERROR|".length).trim().slice(0, 300);
    appendLine("ERROR", scope, "Auth error reported by proxy", { detail: sanitizeForLog(err) });
    return;
  }
  if (trimmed.length > 800) {
    appendLine("INFO", scope, "Proxy line omitted (length only)", { chars: trimmed.length });
    return;
  }
  appendLine("INFO", scope, "Proxy output", { detail: trimmed.slice(0, 500) });
}

export const log = {
  info(scope: string, message: string, fields?: LogFields): void {
    appendLine("INFO", scope, message, fields);
  },
  warn(scope: string, message: string, fields?: LogFields): void {
    appendLine("WARN", scope, message, fields);
  },
  debug(scope: string, message: string, fields?: LogFields): void {
    appendLine("DEBUG", scope, message, fields);
  },
  error(scope: string, message: string, fields?: LogFields): void {
    appendLine("ERROR", scope, message, fields);
  },
  proxyLine(scope: string, raw: string): void {
    appendProxyLine(scope, raw);
  },
};
