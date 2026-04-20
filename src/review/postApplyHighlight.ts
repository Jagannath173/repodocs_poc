import * as vscode from "vscode";
import { diffLines } from "diff";

type DiffPart = { value: string; added?: boolean; removed?: boolean };

function countVisualLines(s: string): number {
  if (s === "") {
    return 0;
  }
  return s.split("\n").length;
}

/** Line numbers in `newText` that were added vs `baseText` (0-based). */
export function lineNumbersAddedInNewFile(baseText: string, newText: string): number[] {
  const base = baseText.replace(/\r\n/g, "\n");
  const merged = newText.replace(/\r\n/g, "\n");
  const parts = diffLines(base, merged) as unknown as DiffPart[];
  const nums: number[] = [];
  let line = 0;
  for (const p of parts) {
    if (p.removed) {
      continue;
    }
    if (p.added) {
      const n = countVisualLines(p.value);
      for (let k = 0; k < n; k++) {
        nums.push(line + k);
      }
      line += n;
      continue;
    }
    line += countVisualLines(p.value);
  }
  return nums;
}

/** When edits are mostly replacements (not extra “added” diff hunks), still land the caret on the first changed line. */
function firstChangedLineIndex(baseText: string, newText: string): number | undefined {
  const b = baseText.replace(/\r\n/g, "\n").split("\n");
  const n = newText.replace(/\r\n/g, "\n").split("\n");
  const max = Math.max(b.length, n.length);
  for (let i = 0; i < max; i++) {
    if ((b[i] ?? "") !== (n[i] ?? "")) {
      return i;
    }
  }
  return undefined;
}

function trimTrailingBlankLines(editor: vscode.TextEditor, firstLine: number, lastLine: number): number {
  let end = lastLine;
  while (end > firstLine && end >= 0 && end < editor.document.lineCount) {
    if (editor.document.lineAt(end).text.trim() !== "") {
      break;
    }
    end -= 1;
  }
  return Math.max(firstLine, end);
}

/**
 * Focus the editor and scroll so the applied change is centered. No background tint — that looked like a
 * “stuck diff” after Accept/Reject in the fix preview flow.
 */
export async function revealAndHighlightAppliedFix(
  uri: vscode.Uri,
  baseText: string,
  newText: string
): Promise<void> {
  let lines = lineNumbersAddedInNewFile(baseText, newText);
  if (!lines.length) {
    const first = firstChangedLineIndex(baseText, newText);
    if (first === undefined) {
      return;
    }
    lines = [first];
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const preferredColumn =
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn ??
    vscode.window.activeTextEditor?.viewColumn ??
    vscode.ViewColumn.One;

  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: preferredColumn,
    preview: false,
    preserveFocus: false,
  });

  const firstLine = Math.min(Math.max(0, lines[0]), editor.document.lineCount - 1);
  let lastLine = Math.min(Math.max(firstLine, lines[lines.length - 1]), editor.document.lineCount - 1);
  lastLine = trimTrailingBlankLines(editor, firstLine, lastLine);

  const endChar = editor.document.lineAt(lastLine).text.length;
  const revealRange = new vscode.Range(
    new vscode.Position(firstLine, 0),
    new vscode.Position(lastLine, endChar)
  );

  const scrollChangesIntoView = (ed: vscode.TextEditor): void => {
    ed.selection = new vscode.Selection(firstLine, 0, firstLine, 0);
    ed.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
  };

  scrollChangesIntoView(editor);

  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 48);
  });
  const editor2 =
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? editor;
  scrollChangesIntoView(editor2);

  try {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  } catch {
    /* ignore */
  }
}
