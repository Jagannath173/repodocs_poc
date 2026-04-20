import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { runMockCopilotInference, useMockCopilotEnabled } from "./mockCopilot";

const pythonRelDir = "python";
const venvBin = (root: string, isWin: boolean) =>
  path.join(root, pythonRelDir, "venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
const pipBin = (root: string, isWin: boolean) =>
  path.join(root, pythonRelDir, "venv", isWin ? "Scripts" : "bin", isWin ? "pip.exe" : "pip");

let ensurePythonPromise: Promise<void> | null = null;

/** Create venv (if needed) and install requirements. Idempotent; concurrent callers share one run. */
export async function ensurePythonEnvironment(
  context: vscode.ExtensionContext,
  onProgress?: (message: string) => void
): Promise<void> {
  if (!ensurePythonPromise) {
    ensurePythonPromise = (async () => {
      const pythonDir = path.join(context.extensionPath, pythonRelDir);
      const isWin = process.platform === "win32";
      const pythonPath = venvBin(context.extensionPath, isWin);

      if (!(await pathExists(pythonPath))) {
        onProgress?.("Creating Python virtual environment…");
        const launcher = await detectSystemPython();
        await runProcess(launcher.command, [...launcher.baseArgs, "-m", "venv", "venv"], pythonDir);
      }

      onProgress?.("Installing Python dependencies…");
      const pipPath = pipBin(context.extensionPath, isWin);
      await runProcess(pipPath, ["install", "-r", "requirements.txt"], pythonDir);
    })().catch((e) => {
      ensurePythonPromise = null;
      throw e;
    });
  }
  return ensurePythonPromise;
}

async function detectSystemPython() {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "python", baseArgs: [] as string[] },
          { command: "py", baseArgs: ["-3"] },
        ]
      : [
          { command: "python3", baseArgs: [] as string[] },
          { command: "python", baseArgs: [] as string[] },
        ];

  for (const cand of candidates) {
    try {
      await runProcess(cand.command, [...cand.baseArgs, "--version"]);
      return cand;
    } catch {
      /* try next */
    }
  }
  throw new Error("Python not found on system.");
}

export interface CopilotInferenceOptions {
  /** Overrides COPILOT_SYSTEM_ROLE for the Copilot proxy process. */
  systemRole?: string;
  /** When false, sets COPILOT_STREAM=0 so the proxy returns one non-streaming completion (better for JSON edits). */
  stream?: boolean;
}

export async function runCopilotInference(
  context: vscode.ExtensionContext,
  prompt: string,
  onLog: (data: string) => void,
  options?: CopilotInferenceOptions
): Promise<void> {
  if (useMockCopilotEnabled()) {
    await runMockCopilotInference(prompt, onLog, options);
    return;
  }

  await ensurePythonEnvironment(context).catch((e: Error) => {
    throw new Error(`Python environment setup failed: ${e.message}`);
  });

  const pythonDir = path.join(context.extensionPath, pythonRelDir);
  const scriptPath = path.join(pythonDir, "copilot_client.py");
  const isWin = process.platform === "win32";
  const pythonPath = venvBin(context.extensionPath, isWin);

  return new Promise<void>((resolve, reject) => {
    onLog(">>> Calling local Copilot proxy…");

    const storedSessionId = context.globalState.get<string>("copilot_session_id");
    const storedTokenOverride = context.globalState.get<string>("copilot_access_token_override");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    };
    if (storedSessionId) {
      env.GITHUB_COPILOT_SESSION_ID = storedSessionId;
    }
    if (storedTokenOverride) {
      env.GITHUB_COPILOT_ACCESS_TOKEN_OVERRIDE = storedTokenOverride;
    }
    if (options?.systemRole) {
      env.COPILOT_SYSTEM_ROLE = options.systemRole;
    }
    if (options?.stream === false) {
      env.COPILOT_STREAM = "0";
    } else if (options?.stream === true) {
      env.COPILOT_STREAM = "1";
    }

    const child = spawn(pythonPath, [scriptPath], { cwd: pythonDir, env });

    child.stdin.write(prompt);
    child.stdin.end();

    let lineBuffer = "";
    let authFailureDetected = false;
    let authFailureMessage = "";
    const markAuthFailure = (msg: string) => {
      if (authFailureDetected) {
        return;
      }
      authFailureDetected = true;
      authFailureMessage = msg;
    };

    child.stdout.on("data", (d: Buffer) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const msg = line.trim();
        if (msg) {
          onLog(msg);
          if (
            /No active Copilot session/i.test(msg) ||
            /status code\s*101/i.test(msg) ||
            /\b101\b.*(unauthoriz|auth|session)/i.test(msg)
          ) {
            markAuthFailure(msg);
          }
        }

        if (msg.includes("SESSION_ID|")) {
          const parts = msg.split("|");
          if (parts.length > 1) {
            const sessionId = parts[1];
            void context.globalState.update("copilot_session_id", sessionId);
            onLog("[Context] Session ID stored.");
          }
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      onLog(`[Python Error] ${s}`);
      if (
        /No active Copilot session/i.test(s) ||
        /status code\s*101/i.test(s) ||
        /\b101\b.*(unauthoriz|auth|session)/i.test(s)
      ) {
        markAuthFailure(s.trim());
      }
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (authFailureDetected) {
        await context.globalState.update("copilot_session_id", undefined);
        await context.globalState.update("copilot_access_token_override", undefined);
        reject(
          new Error(
            `Copilot authentication failed (${authFailureMessage || "session expired"}). Please run "Code Review: Authenticate Copilot" and try again.`
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Copilot script failed with exit code ${code}`));
    });
  });
}

/** Runs Copilot and returns the concatenated assistant text from SSE `data:` lines. */
export async function runCopilotInferenceCollectText(
  context: vscode.ExtensionContext,
  prompt: string,
  options?: CopilotInferenceOptions
): Promise<string> {
  let assistantText = "";
  await runCopilotInference(
    context,
    prompt,
    (data) => {
      const trimmed = data.trim();
      if (!trimmed.startsWith("data: ")) {
        return;
      }
      const jsonStr = trimmed.substring(6).trim();
      if (jsonStr === "[DONE]") {
        return;
      }
      try {
        const json = JSON.parse(jsonStr) as {
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }>;
        };
        const piece =
          json.choices?.[0]?.delta?.content ||
          json.choices?.[0]?.message?.content ||
          json.choices?.[0]?.text;
        if (piece) {
          assistantText += piece;
        }
      } catch {
        /* ignore */
      }
    },
    options
  );
  return assistantText;
}

export interface AuthFlowCallbacks {
  onAuthRequired: (verificationUrl: string, userCode: string) => void;
  onPollingStatus?: (status: string) => void;
  onSessionStored?: () => void;
  onAuthSuccess: () => void;
}

/**
 * Device-code flow for Copilot. UI (webview) is driven exclusively via callbacks — no notification banners.
 */
export async function authenticateCopilot(
  context: vscode.ExtensionContext,
  onLog: (data: string) => void,
  callbacks: AuthFlowCallbacks
): Promise<void> {
  await ensurePythonEnvironment(context).catch((e: Error) => {
    throw new Error(`Python environment setup failed: ${e.message}`);
  });

  const pythonDir = path.join(context.extensionPath, pythonRelDir);
  const scriptPath = path.join(pythonDir, "copilot_client.py");
  const isWin = process.platform === "win32";
  const pythonPath = venvBin(context.extensionPath, isWin);

  return new Promise<void>((resolve, reject) => {
    onLog(">>> Starting device sign-in…");
    const child = spawn(pythonPath, [scriptPath, "--authenticate"], { cwd: pythonDir });

    let authBuffer = "";
    let settled = false;

    const succeedAuth = () => {
      if (settled) {
        return;
      }
      settled = true;
      callbacks.onAuthSuccess();
      resolve();
    };

    const failAuth = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(message));
    };

    child.stdout.on("data", (d: Buffer) => {
      authBuffer += d.toString();
      const lines = authBuffer.split("\n");
      authBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        onLog(line);

        if (line.startsWith("AUTH_REQUIRED|")) {
          const parts = line.split("|");
          const url = parts[1] || "";
          const code = parts[2] || "";
          callbacks.onAuthRequired(url, code);
        } else if (line.startsWith("POLLING_STATUS|")) {
          const status = line.slice("POLLING_STATUS|".length);
          callbacks.onPollingStatus?.(status);
        } else if (line.startsWith("SESSION_ID|")) {
          const sessionId = line.substring("SESSION_ID|".length);
          void context.globalState.update("copilot_session_id", sessionId);
          callbacks.onSessionStored?.();
        } else if (line === "AUTH_SUCCESS") {
          succeedAuth();
        } else if (line.startsWith("AUTH_ERROR|")) {
          const err = line.split("|")[1] || "Unknown error";
          failAuth(err);
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      onLog(`[Python Auth] ${d.toString()}`);
    });

    child.on("error", (e) => failAuth(String(e)));
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        failAuth(`Sign-in process exited with code ${code}`);
      } else {
        resolve();
      }
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(command: string, args: string[], cwd?: string, onData?: (data: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    child.stdout.on("data", (d) => onData?.(d.toString().trim()));
    child.stderr.on("data", (d) => onData?.(d.toString().trim()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Process failed with exit code ${code}`))));
  });
}
