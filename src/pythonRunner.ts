import * as vscode from "vscode";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

export async function runBenchmark(context: vscode.ExtensionContext, onLog: (text: string, status?: string) => void, onResult: (latency: number) => void) {
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

    await runProcess(pythonPath, [scriptPath], pythonDir, (data) => onLog(data, "info"));
    
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

async function runProcess(command: string, args: string[], cwd?: string, onData?: (data: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    child.stdout.on("data", (d) => onData?.(d.toString().trim()));
    child.stderr.on("data", (d) => onData?.(d.toString().trim()));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Process failed with exit code ${code}`)));
  });
}

async function pathExists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}
