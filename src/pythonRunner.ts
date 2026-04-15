import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

export async function runBenchmark(context: vscode.ExtensionContext, onLog: (text: string, status?: string) => void, onResult: (latency: number) => void) {
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/F", "/IM", "python.exe", "/T"]); } catch {}
  }

  const pythonDir = path.join(context.extensionPath, "python");
  const scriptPath = path.join(pythonDir, "script.py");
  const venvDir = path.join(pythonDir, "venv");
  const isWin = process.platform === "win32";
  const pythonPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

  const startTime = Date.now();
  try {
    onLog("Starting Internal Python Benchmark...");
    if (!(await pathExists(pythonPath))) {
      onLog("Virtual environment not found; bootstrapping...", "info");
      const launcher = await detectSystemPython();
      await runProcess(launcher.command, [...launcher.baseArgs, "-m", "venv", "venv"], pythonDir);
    }

    try {
      onLog("Verifying Python packages...", "info");
      const pipPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "pip.exe" : "pip");
      await runProcess(pipPath, ["install", "-r", "requirements.txt"], pythonDir, (d: string) => onLog(d, "info"));
    } catch (e) {
      // Suppress noisy warnings during package check
    }

    await runProcess(pythonPath, [scriptPath], pythonDir, (data: string) => onLog(data, "info"));
    onResult(Date.now() - startTime);
  } catch (error: any) {
    onLog(`Error: ${error.message}`, "error");
    throw error;
  }
}

async function detectSystemPython() {
  const candidates = process.platform === "win32" 
    ? [{ command: "python", baseArgs: [] }, { command: "py", baseArgs: ["-3"] }]
    : [{ command: "python3", baseArgs: [] }, { command: "python", baseArgs: [] }];

  for (const cand of candidates) {
    try {
      await runProcess(cand.command, [...cand.baseArgs, "--version"]);
      return cand;
    } catch {}
  }
  throw new Error("Python not found on system.");
}

export async function runCopilotInference(context: vscode.ExtensionContext, prompt: string, onLog: (data: string) => void) {
  const pythonDir = path.join(context.extensionPath, "python");
  const scriptPath = path.join(pythonDir, "copilot_client.py");
  const venvDir = path.join(pythonDir, "venv");
  const isWin = process.platform === "win32";
  const pythonPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

  if (!(await pathExists(pythonPath))) {
    throw new Error("Local environment not ready. Please run Analyze Script Latency first to setup Python.");
  }

  return new Promise<void>((resolve, reject) => {
    onLog(">>> Calling local Copilot proxy...");
    
    // Inject the stored Session ID if it exists
    // CRITICAL: Only set env vars if values are defined — passing undefined becomes
    // the literal string "undefined" which Python reads as truthy and uses as a bad token.
    const storedSessionId = context.globalState.get<string>("copilot_session_id");
    const storedTokenOverride = context.globalState.get<string>("copilot_access_token_override");
    const env: NodeJS.ProcessEnv = { 
        ...process.env, 
        PYTHONUNBUFFERED: "1",
    };
    if (storedSessionId)    { env.GITHUB_COPILOT_SESSION_ID = storedSessionId; }
    if (storedTokenOverride){ env.GITHUB_COPILOT_ACCESS_TOKEN_OVERRIDE = storedTokenOverride; }
    onLog(`[Context] Using session: ${storedSessionId ? storedSessionId.substring(0, 20) + '...' : 'NONE (will use access token from cache)'}`);

    const child = spawn(pythonPath, [scriptPath], { cwd: pythonDir, env });
    
    // Send the prompt through stdin instead of args (Bypasses Windows command line limits)
    child.stdin.write(prompt);
    child.stdin.end();

    let lineBuffer = ""; // NEW: Buffer to handle fragmented chunks

    child.stdout.on("data", (d: Buffer) => {
      lineBuffer += d.toString();
      const lines = lineBuffer.split("\n");
      
      // Keep the last partial line in the buffer
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const msg = line.trim();
        if (msg) onLog(msg);

        // Store any fresh session ID emitted by the script
        if (msg.includes("SESSION_ID|")) {
          const parts = msg.split("|");
          if (parts.length > 1) {
            const sessionId = parts[1];
            context.globalState.update("copilot_session_id", sessionId);
            onLog(`[Context] Session ID verified and stored in state.`);
          }
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
        onLog(`[Python Error] ${d.toString()}`);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Copilot script failed with exit code ${code}`)));
  });
}

export async function authenticateCopilot(context: vscode.ExtensionContext, onLog: (data: string) => void) {
  const pythonDir = path.join(context.extensionPath, "python");
  const scriptPath = path.join(pythonDir, "copilot_client.py");
  const venvDir = path.join(pythonDir, "venv");
  const isWin = process.platform === "win32";
  const pythonPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

  if (!(await pathExists(pythonPath))) {
    onLog(">>> Virtual environment not found. Please click 'Analyze Script Latency' first.");
    return;
  }

  return new Promise<void>((resolve, reject) => {
    onLog(">>> Starting Device Auth Flow...");
    const child = spawn(pythonPath, [scriptPath, "--authenticate"], { cwd: pythonDir });

    // Line-buffer stdout so multi-line chunks don't break exact-match checks
    let authBuffer = "";
    child.stdout.on("data", (d: Buffer) => {
        authBuffer += d.toString();
        const lines = authBuffer.split("\n");
        authBuffer = lines.pop() || ""; // keep incomplete last line in buffer

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) { continue; }
            onLog(line);

            if (line.startsWith("AUTH_REQUIRED")) {
                const parts = line.split("|");
                const url  = parts[1];
                const code = parts[2];
                vscode.env.clipboard.writeText(code);
                vscode.window.showInformationMessage(
                    `Copilot Auth: Code ${code} copied! Click to open browser.`,
                    "Open Browser"
                ).then(sel => {
                    if (sel === "Open Browser") {
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                });
            } else if (line.startsWith("SESSION_ID|")) {
                // Store the raw session token so inference can use it immediately
                const sessionId = line.substring("SESSION_ID|".length);
                context.globalState.update("copilot_session_id", sessionId);
                onLog(`[Context] Session ID stored: ${sessionId.substring(0, 25)}...`);
            } else if (line === "AUTH_SUCCESS") {
                vscode.window.showInformationMessage("✅ Copilot Authentication Successful! You can now generate docs.");
                resolve();
            } else if (line.startsWith("AUTH_ERROR")) {
                const err = line.split("|")[1] || "Unknown error";
                vscode.window.showErrorMessage(`Auth Error: ${err}`);
                reject(new Error(err));
            }
        }
    });

    child.stderr.on("data", (d: Buffer) => {
        onLog(`[Python Auth Debug] ${d.toString()}`);
    });

    child.on("error", reject);
    child.on("close", (code) => code !== 0 && reject(new Error(`Auth failed (code ${code})`)));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function runProcess(command: string, args: string[], cwd?: string, onData?: (data: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    child.stdout.on("data", (d) => onData?.(d.toString().trim()));
    child.stderr.on("data", (d) => onData?.(d.toString().trim()));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Process failed with exit code ${code}`)));
  });
}
