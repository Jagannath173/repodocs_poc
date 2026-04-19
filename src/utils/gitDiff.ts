import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

const execFileAsync = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        stdout: stdout === undefined ? "" : String(stdout),
        stderr: stderr === undefined ? "" : String(stderr),
      });
    });
  });

/** Legacy minimum diff hint (review mode now uses any non-empty git diff). */
export const GIT_DIFF_INCREMENTAL_THRESHOLD = 24;

/**
 * Working-tree diff for a single file vs HEAD (committed + staged + unstaged rolled into comparison with HEAD).
 * Returns undefined if Git is unavailable, path is outside the workspace folder, or the command fails.
 */
export async function tryGetGitDiffVsHead(uri: vscode.Uri): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const cwd = folder.uri.fsPath;
  let relPath: string;
  try {
    relPath = path.relative(cwd, uri.fsPath).replace(/\\/g, "/");
    if (relPath.startsWith("..") || relPath === "") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--", relPath],
      {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    const t = stdout.trim();
    return t.length > 0 ? stdout : "";
  } catch {
    return undefined;
  }
}
