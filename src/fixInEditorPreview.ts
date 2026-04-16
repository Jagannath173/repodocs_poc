import * as vscode from "vscode";
import { diffLines } from "diff";

export type FixInEditorChoice = "accept" | "reject";

type DiffPart = { value: string; added?: boolean; removed?: boolean };

type FixChunk = {
  id: number;
  startPartIndex: number;
  endPartIndex: number; // exclusive
  anchorLine: number; // 0-based
  removedLineNumbers: number[]; // lines to decorate (from base doc)
  beforeRegionText: string; // base-side of this region
  afterRegionText: string; // updated-side of this region
  addedPreview: string;
  removedPreview: string;
};

function kindOf(p: DiffPart): "add" | "remove" | "same" {
  if (p.added) return "add";
  if (p.removed) return "remove";
  return "same";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizePreview(s: string, maxChars: number): string {
  const t = s.replace(/\r\n/g, "\n").replace(/\n/g, " \\n ");
  return t.length > maxChars ? t.slice(0, maxChars - 3) + "..." : t;
}

function extractRegionText(parts: DiffPart[], start: number, end: number, include: { add: boolean; remove: boolean }): string {
  return parts
    .slice(start, end)
    .map((p) => kindOf(p))
    .map((k, i) => ({ k, p: parts[start + i] }))
    .filter(({ k }) => (k === "add" ? include.add : k === "remove" ? include.remove : true))
    .map(({ p }) => p.value)
    .join("");
}

function buildMergedText(parts: DiffPart[], chunks: FixChunk[], decisions: boolean[]): string {
  const startToChunk = new Map<number, number>();
  for (const c of chunks) startToChunk.set(c.startPartIndex, c.id);
  const idToChunk = new Map<number, FixChunk>();
  for (const c of chunks) idToChunk.set(c.id, c);

  let out = "";
  let i = 0;
  while (i < parts.length) {
    const chunkId = startToChunk.get(i);
    if (chunkId !== undefined) {
      const c = idToChunk.get(chunkId);
      if (!c) throw new Error("Internal error: chunk missing");
      out += decisions[c.id] ? c.afterRegionText : c.beforeRegionText;
      i = c.endPartIndex;
      continue;
    }
    out += parts[i].value;
    i += 1;
  }
  return out;
}

function computeFixChunks(baseText: string, afterText: string, baseDoc: vscode.TextDocument): FixChunk[] {
  const diffParts = diffLines(baseText, afterText) as unknown as DiffPart[];

  const kinds = diffParts.map((p) => kindOf(p));

  // baseOffsetAtPartIndex: offset in baseText right *before* this part's value is consumed.
  // Note: "added" parts do not exist in baseText, so we do not advance the offset for them.
  const baseOffsetAtPartIndex: number[] = new Array(diffParts.length);
  let baseOffset = 0;
  for (let i = 0; i < diffParts.length; i++) {
    baseOffsetAtPartIndex[i] = baseOffset;
    if (!diffParts[i].added) {
      baseOffset += diffParts[i].value.length;
    }
  }

  // Build regions: maximal ranges starting at a non-same part and ending before trailing "same" context.
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < diffParts.length) {
    while (i < diffParts.length && kinds[i] === "same") i++;
    if (i >= diffParts.length) break;

    const start = i;
    let j = i;
    while (j < diffParts.length) {
      const k = kinds[j];
      const nextIsSame = j === diffParts.length - 1 ? true : kinds[j + 1] === "same";
      if (k === "same" && nextIsSame) break;
      j++;
    }
    const end = j; // exclusive
    if (end > start) spans.push({ start, end });
    i = end;
  }

  const chunks: FixChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < spans.length; chunkIndex++) {
    const span = spans[chunkIndex];
    const start = span.start;
    const end = span.end;

    const anchorOffset = baseOffsetAtPartIndex[start] ?? 0;
    const anchorPos = baseDoc.positionAt(anchorOffset);

    const removedLineNumbers: number[] = [];
    for (let pi = start; pi < end; pi++) {
      if (kindOf(diffParts[pi]) !== "remove") continue;
      const partStartOffset = baseOffsetAtPartIndex[pi];
      const partEndOffset = partStartOffset + diffParts[pi].value.length;
      const startPos = baseDoc.positionAt(partStartOffset);
      const endPos = baseDoc.positionAt(partEndOffset);
      const lastLineToDecorate = endPos.character === 0 ? endPos.line - 1 : endPos.line;
      for (let line = startPos.line; line <= lastLineToDecorate; line++) {
        if (line >= 0 && line < baseDoc.lineCount) removedLineNumbers.push(line);
      }
    }
    // de-dupe while preserving order
    const removedLineNumbersDeduped = Array.from(new Set(removedLineNumbers));

    const anchorLine =
      removedLineNumbersDeduped.length > 0 ? Math.min(...removedLineNumbersDeduped) : clamp(anchorPos.line, 0, Math.max(0, baseDoc.lineCount - 1));

    const beforeRegionText = extractRegionText(diffParts, start, end, { add: false, remove: true });
    const afterRegionText = extractRegionText(diffParts, start, end, { add: true, remove: false });

    const removedPreview = normalizePreview(
      diffParts
        .slice(start, end)
        .filter((p) => kindOf(p) === "remove")
        .map((p) => p.value)
        .join(""),
      110
    );
    const addedPreview = normalizePreview(
      diffParts
        .slice(start, end)
        .filter((p) => kindOf(p) === "add")
        .map((p) => p.value)
        .join(""),
      110
    );

    chunks.push({
      id: chunkIndex,
      startPartIndex: start,
      endPartIndex: end,
      anchorLine,
      removedLineNumbers: removedLineNumbersDeduped,
      beforeRegionText,
      afterRegionText,
      addedPreview,
      removedPreview,
    });
  }

  return chunks;
}

function applyWholeDocumentReplace(doc: vscode.TextDocument, newText: string): Thenable<boolean> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, fullRange, newText);
  return vscode.workspace.applyEdit(edit);
}

/**
 * Shows per-chunk Accept/Reject using CodeLens + highlights directly in the editor,
 * then waits for the bottom Accept/Reject to resolve.
 */
export async function previewFixInEditorAndWait(
  baseDoc: vscode.TextDocument,
  baseText: string,
  afterText: string,
  title: string
): Promise<FixInEditorChoice> {
  const chunks = computeFixChunks(baseText, afterText, baseDoc);

  // No diff: nothing to accept/reject. Treat as "accept" so fix flow can continue.
  if (!chunks.length) {
    return "accept";
  }

  const decisions = chunks.map(() => true); // default: accept all chunks

  const sessionId = Math.random().toString(36).slice(2);
  const acceptChunkCommand = `codeReview.fixPreview.${sessionId}.acceptChunk`;
  const rejectChunkCommand = `codeReview.fixPreview.${sessionId}.rejectChunk`;
  const acceptAllCommand = `codeReview.fixPreview.${sessionId}.acceptAll`;
  const rejectAllCommand = `codeReview.fixPreview.${sessionId}.rejectAll`;

  // Selection visualization:
  // - When a chunk is selected to ACCEPT: highlight its affected (removed-side) lines in GREEN.
  // - When selected to REJECT: highlight its affected (removed-side) lines in RED.
  const decorationAccepted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(80, 200, 120, 0.22)", // green-ish
  });
  const decorationRejected = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(241, 76, 76, 0.22)", // red-ish
  });

  const buildRangesForLines = (lines: number[]): vscode.Range[] =>
    lines.map((l) => new vscode.Range(new vscode.Position(l, 0), new vscode.Position(l, 0)));

  const updateDecorations = (): void => {
    const currentEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === baseDoc.uri.toString());
    if (!currentEditor) return;

    const acceptedLines: number[] = [];
    const rejectedLines: number[] = [];

    for (const c of chunks) {
      const targetLines = c.removedLineNumbers.length ? c.removedLineNumbers : [c.anchorLine];
      if (decisions[c.id]) acceptedLines.push(...targetLines);
      else rejectedLines.push(...targetLines);
    }

    currentEditor.setDecorations(decorationAccepted, buildRangesForLines(Array.from(new Set(acceptedLines))));
    currentEditor.setDecorations(decorationRejected, buildRangesForLines(Array.from(new Set(rejectedLines))));
  };

  updateDecorations();

  const buildCurrentMergedText = (): string => {
    // Use the original diff parts between baseText and afterText so chunk boundaries match.
    const parts = diffLines(baseText, afterText) as unknown as DiffPart[];
    return buildMergedText(parts, chunks, decisions);
  };

  const applyCurrentPreviewToEditor = async (): Promise<boolean> => {
    const mergedText = buildCurrentMergedText();
    return applyWholeDocumentReplace(baseDoc, mergedText);
  };

  let finalChoiceResolver: (c: FixInEditorChoice) => void;
  const finalChoicePromise = new Promise<FixInEditorChoice>((resolve) => {
    finalChoiceResolver = resolve;
  });
  let resolved = false;

  const cleanupCallbacks: Array<() => void> = [];
  const cleanup = () => {
    if (resolved) return;
    resolved = true;
    for (const fn of cleanupCallbacks) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    decorationAccepted.dispose();
    decorationRejected.dispose();
  };

  const codeLensChangeEmitter = new vscode.EventEmitter<void>();

  const cmdAcceptChunk = vscode.commands.registerCommand(acceptChunkCommand, async (chunkId: number) => {
    if (resolved) return;
    if (typeof chunkId !== "number" || chunkId < 0 || chunkId >= decisions.length) return;
    decisions[chunkId] = true;
    updateDecorations();
    await applyCurrentPreviewToEditor();
    codeLensChangeEmitter.fire();
    try {
      void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    } catch {
      // ignore
    }
  });
  const cmdRejectChunk = vscode.commands.registerCommand(rejectChunkCommand, async (chunkId: number) => {
    if (resolved) return;
    if (typeof chunkId !== "number" || chunkId < 0 || chunkId >= decisions.length) return;
    decisions[chunkId] = false;
    updateDecorations();
    await applyCurrentPreviewToEditor();
    codeLensChangeEmitter.fire();
    try {
      void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    } catch {
      // ignore
    }
  });

  const cmdAcceptAll = vscode.commands.registerCommand(acceptAllCommand, async () => {
    if (resolved) return;
    try {
      const mergedText = buildCurrentMergedText();
      const ok = await applyWholeDocumentReplace(baseDoc, mergedText);
      if (!ok) {
        // If edit failed, still resolve reject to avoid continuing with a potentially stale doc.
        finalChoiceResolver("reject");
      } else {
        finalChoiceResolver("accept");
      }
    } finally {
      cleanup();
    }
  });

  const cmdRejectAll = vscode.commands.registerCommand(rejectAllCommand, async () => {
    if (resolved) return;
    try {
      // Reject => revert all hunks back to the base snapshot.
      const ok = await applyWholeDocumentReplace(baseDoc, baseText);
      if (!ok) {
        finalChoiceResolver("reject");
      } else {
        finalChoiceResolver("reject");
      }
    } finally {
      cleanup();
    }
  });

  cleanupCallbacks.push(() => cmdAcceptChunk.dispose());
  cleanupCallbacks.push(() => cmdRejectChunk.dispose());
  cleanupCallbacks.push(() => cmdAcceptAll.dispose());
  cleanupCallbacks.push(() => cmdRejectAll.dispose());
  cleanupCallbacks.push(() => codeLensChangeEmitter.dispose());

  // CodeLens provider (only for this document)
  class FixCodeLensProvider implements vscode.CodeLensProvider {
    readonly onDidChangeCodeLenses = codeLensChangeEmitter.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (document.uri.toString() !== baseDoc.uri.toString()) return [];
      if (!chunks.length) return [];

      const lenses: vscode.CodeLens[] = [];
      for (const c of chunks) {
        const uniqRemoved = Array.from(new Set(c.removedLineNumbers)).sort((a, b) => a - b);
        const lensLines = uniqRemoved.length >= 2 ? [uniqRemoved[0], uniqRemoved[uniqRemoved.length - 1]] : [uniqRemoved[0] ?? c.anchorLine];
        for (const lensLine of lensLines) {
          const range = new vscode.Range(new vscode.Position(lensLine, 0), new vscode.Position(lensLine, 0));
          const isAccepted = decisions[c.id];
          lenses.push(
            new vscode.CodeLens(range, {
              title: isAccepted ? "✓ Accept (selected)" : "✓ Accept",
              command: acceptChunkCommand,
              arguments: [c.id],
            })
          );
          lenses.push(
            new vscode.CodeLens(range, {
              title: !isAccepted ? "✕ Reject (selected)" : "✕ Reject",
              command: rejectChunkCommand,
              arguments: [c.id],
            })
          );
        }
        // Tooltip is optional; use it if available in types at compile-time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lenses[lenses.length - 2] as any).tooltip = `Added: ${c.addedPreview}\nRemoved: ${c.removedPreview}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lenses[lenses.length - 1] as any).tooltip = `Keep original: ${c.removedPreview}\nDiscard added: ${c.addedPreview}`;
      }

      const bottomLine = Math.max(0, document.lineCount - 1);
      const bottomRange = new vscode.Range(new vscode.Position(bottomLine, 0), new vscode.Position(bottomLine, 0));
      lenses.push(
        new vscode.CodeLens(bottomRange, {
          title: "✓ Accept (apply selection)",
          command: acceptAllCommand,
          arguments: [],
        })
      );
      lenses.push(
        new vscode.CodeLens(bottomRange, {
          title: "✕ Reject (discard all)",
          command: rejectAllCommand,
          arguments: [],
        })
      );
      return lenses;
    }
  }

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { scheme: baseDoc.uri.scheme, language: baseDoc.languageId, pattern: "**/*" },
    new FixCodeLensProvider()
  );
  cleanupCallbacks.push(() => codeLensProvider.dispose());

  // Reveal the target file so the lenses are visible.
  const activeViewColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
  const existingEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === baseDoc.uri.toString());
  await vscode.window.showTextDocument(baseDoc.uri, {
    viewColumn: existingEditor ? existingEditor.viewColumn : activeViewColumn,
    preview: false,
    preserveFocus: true,
  });

  // Ensure lenses are refreshed immediately (important when code lenses are registered dynamically).
  try {
    void vscode.commands.executeCommand("editor.action.codeLens.refresh");
  } catch {
    // ignore
  }

  return finalChoicePromise.finally(() => {
    cleanup();
  });
}

