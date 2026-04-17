import * as vscode from "vscode";
import { diffLines } from "diff";

export type FixInEditorChoice = "accept" | "reject";

/** CodeLens invokes these command ids (declared in package.json) so chunk actions work in all hosts. */
const CMD_ACCEPT_CHUNK = "codeReview.fixPreview.acceptChunk";
const CMD_REJECT_CHUNK = "codeReview.fixPreview.rejectChunk";
const CMD_ACCEPT_ALL = "codeReview.fixPreview.acceptAllChanges";
const CMD_REJECT_ALL = "codeReview.fixPreview.rejectAllChanges";

type FixPreviewSessionHandlers = {
  acceptChunk: (id: number) => Promise<void>;
  rejectChunk: (id: number) => Promise<void>;
  acceptAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
  getChunkCount: () => number;
};

let activeFixPreviewSession: FixPreviewSessionHandlers | undefined;

function flattenArgs(args: unknown[]): unknown[] {
  let a = [...args];
  while (a.length === 1 && Array.isArray(a[0])) {
    a = [...(a[0] as unknown[])];
  }
  return a;
}

function coerceChunkId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  return undefined;
}

/**
 * Register once from extension activate. Preview sessions assign `activeFixPreviewSession` while open.
 */
export function registerFixPreviewCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_ACCEPT_CHUNK, async (...args: unknown[]) => {
      const s = activeFixPreviewSession;
      if (!s) {
        return;
      }
      const n = s.getChunkCount();
      if (n === 0) {
        return;
      }
      const flat = flattenArgs(args);
      let id = coerceChunkId(flat[0]);
      if (id === undefined && n === 1) {
        id = 0;
      }
      if (id === undefined || id < 0 || id >= n) {
        void vscode.window.showWarningMessage(
          "Fix preview: could not determine which block to accept. Use Accept All Changes at the bottom if this persists."
        );
        return;
      }
      await s.acceptChunk(id);
    }),
    vscode.commands.registerCommand(CMD_REJECT_CHUNK, async (...args: unknown[]) => {
      const s = activeFixPreviewSession;
      if (!s) {
        return;
      }
      const n = s.getChunkCount();
      if (n === 0) {
        return;
      }
      const flat = flattenArgs(args);
      let id = coerceChunkId(flat[0]);
      if (id === undefined && n === 1) {
        id = 0;
      }
      if (id === undefined || id < 0 || id >= n) {
        void vscode.window.showWarningMessage(
          "Fix preview: could not determine which block to reject. Use Reject All Changes at the bottom if this persists."
        );
        return;
      }
      await s.rejectChunk(id);
    }),
    vscode.commands.registerCommand(CMD_ACCEPT_ALL, async () => {
      await activeFixPreviewSession?.acceptAll();
    }),
    vscode.commands.registerCommand(CMD_REJECT_ALL, async () => {
      await activeFixPreviewSession?.rejectAll();
    })
  );
}

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

function countVisualLines(s: string): number {
  if (s === "") {
    return 0;
  }
  return s.split("\n").length;
}

function getChunkMergedLineRanges(
  parts: DiffPart[],
  chunks: FixChunk[],
  decisions: boolean[]
): Map<number, { startLine: number; endLineExclusive: number }> {
  const startToChunk = new Map<number, FixChunk>();
  for (const c of chunks) {
    startToChunk.set(c.startPartIndex, c);
  }
  const map = new Map<number, { startLine: number; endLineExclusive: number }>();
  let line = 0;
  let i = 0;
  while (i < parts.length) {
    const c = startToChunk.get(i);
    if (c) {
      const text = decisions[c.id] ? c.afterRegionText : c.beforeRegionText;
      const startLine = line;
      const lineCount = countVisualLines(text);
      map.set(c.id, { startLine, endLineExclusive: startLine + lineCount });
      line += lineCount;
      i = c.endPartIndex;
      continue;
    }
    line += countVisualLines(parts[i].value);
    i += 1;
  }
  return map;
}

function lineNumbersForAddedInMerged(baseText: string, mergedText: string): number[] {
  const parts = diffLines(baseText, mergedText) as unknown as DiffPart[];
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

function normalizeReviewText(s: string): string {
  return s.replace(/\r\n/g, "\n");
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

async function applyWholeDocumentReplace(docUri: vscode.Uri, newText: string): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(docUri);
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

  const mergeParts = diffLines(baseText, afterText) as unknown as DiffPart[];

  const docUri = baseDoc.uri;
  const baseNorm = normalizeReviewText(baseText);

  // Green = lines added vs the original snapshot (follows the live buffer so undo updates highlights).
  const decorationDiffAdded = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(63, 185, 80, 0.2)",
    border: "1px solid rgba(63, 185, 80, 0.45)",
  });

  const buildRangesForLines = (lines: number[]): vscode.Range[] =>
    lines.map((l) => new vscode.Range(new vscode.Position(l, 0), new vscode.Position(l, 0)));

  const buildCurrentMergedText = (): string => {
    return buildMergedText(mergeParts, chunks, decisions);
  };

  const updateDecorations = (): void => {
    const currentEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === baseDoc.uri.toString());
    if (!currentEditor) {
      return;
    }

    const current = normalizeReviewText(currentEditor.document.getText());
    const addedLines = lineNumbersForAddedInMerged(baseNorm, current);
    currentEditor.setDecorations(decorationDiffAdded, buildRangesForLines(addedLines));
  };

  const applyCurrentPreviewToEditor = async (): Promise<boolean> => {
    const mergedText = buildCurrentMergedText();
    return applyWholeDocumentReplace(docUri, mergedText);
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
    activeFixPreviewSession = undefined;
    for (const fn of cleanupCallbacks) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    decorationDiffAdded.dispose();
  };

  const finalizePreviewChoice = (choice: FixInEditorChoice): void => {
    if (resolved) {
      return;
    }
    finalChoiceResolver(choice);
    cleanup();
  };

  const codeLensChangeEmitter = new vscode.EventEmitter<void>();

  const refreshLenses = (): void => {
    try {
      void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    } catch {
      // ignore
    }
  };

  activeFixPreviewSession = {
    getChunkCount: () => chunks.length,
    acceptChunk: async (chunkId: number) => {
      if (resolved) return;
      if (chunkId < 0 || chunkId >= decisions.length) return;
      decisions[chunkId] = true;
      const ok = await applyCurrentPreviewToEditor();
      if (!ok) {
        void vscode.window.showWarningMessage(
          "Could not write the file for this preview. Check if the document is read-only or locked."
        );
        return;
      }
      updateDecorations();
      codeLensChangeEmitter.fire();
      refreshLenses();
    },
    rejectChunk: async (chunkId: number) => {
      if (resolved) return;
      if (chunkId < 0 || chunkId >= decisions.length) return;
      decisions[chunkId] = false;
      const ok = await applyCurrentPreviewToEditor();
      if (!ok) {
        void vscode.window.showWarningMessage(
          "Could not write the file for this preview. Check if the document is read-only or locked."
        );
        return;
      }
      updateDecorations();
      codeLensChangeEmitter.fire();
      refreshLenses();
    },
    acceptAll: async () => {
      if (resolved) return;
      try {
        for (let i = 0; i < decisions.length; i++) {
          decisions[i] = true;
        }
        const mergedText = buildCurrentMergedText();
        const ok = await applyWholeDocumentReplace(docUri, mergedText);
        if (!ok) {
          finalChoiceResolver("reject");
        } else {
          finalChoiceResolver("accept");
        }
      } finally {
        cleanup();
      }
    },
    rejectAll: async () => {
      if (resolved) return;
      try {
        const ok = await applyWholeDocumentReplace(docUri, baseText);
        if (!ok) {
          finalChoiceResolver("reject");
        } else {
          finalChoiceResolver("reject");
        }
      } finally {
        cleanup();
      }
    },
  };

  cleanupCallbacks.push(() => codeLensChangeEmitter.dispose());

  // CodeLens provider (only for this document)
  class FixCodeLensProvider implements vscode.CodeLensProvider {
    readonly onDidChangeCodeLenses = codeLensChangeEmitter.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (document.uri.toString() !== baseDoc.uri.toString()) return [];
      if (!chunks.length) return [];

      const rangeMap = getChunkMergedLineRanges(mergeParts, chunks, decisions);
      const lenses: vscode.CodeLens[] = [];
      for (const c of chunks) {
        const r = rangeMap.get(c.id);
        const lensLine =
          r && r.endLineExclusive > r.startLine
            ? r.startLine
            : Math.min(Math.max(0, c.anchorLine), Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(new vscode.Position(lensLine, 0), new vscode.Position(lensLine, 0));
        const isAccepted = decisions[c.id];
        lenses.push(
          new vscode.CodeLens(range, {
            title: isAccepted ? "✅ Accept (selected)" : "✅ Accept",
            command: CMD_ACCEPT_CHUNK,
            arguments: [c.id],
            tooltip: `Accept this change for this block.\nAdded: ${c.addedPreview}\nRemoved: ${c.removedPreview}`,
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: !isAccepted ? "❌ Reject (selected)" : "❌ Reject",
            command: CMD_REJECT_CHUNK,
            arguments: [c.id],
            tooltip: `Reject this block (keep original).\nKeep: ${c.removedPreview}\nDiscard: ${c.addedPreview}`,
          })
        );
      }

      const bottomLine = Math.max(0, document.lineCount - 1);
      const bottomRange = new vscode.Range(new vscode.Position(bottomLine, 0), new vscode.Position(bottomLine, 0));
      lenses.push(
        new vscode.CodeLens(bottomRange, {
          title: "✅ Accept All Changes",
          command: CMD_ACCEPT_ALL,
          arguments: [],
        })
      );
      lenses.push(
        new vscode.CodeLens(bottomRange, {
          title: "❌ Reject All Changes",
          command: CMD_REJECT_ALL,
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

  const docChangeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (resolved) {
      return;
    }
    if (e.document.uri.toString() !== docUri.toString()) {
      return;
    }
    updateDecorations();
  });
  cleanupCallbacks.push(() => docChangeSub.dispose());

  // Reveal the target file so the lenses are visible.
  const existingEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === baseDoc.uri.toString());
  const preferredColumn =
    existingEditor?.viewColumn ??
    vscode.window.visibleTextEditors[0]?.viewColumn ??
    vscode.window.activeTextEditor?.viewColumn ??
    vscode.ViewColumn.One;
  await vscode.window.showTextDocument(baseDoc.uri, {
    viewColumn: preferredColumn,
    preview: false,
    preserveFocus: false,
  });

  await applyWholeDocumentReplace(docUri, buildCurrentMergedText());
  updateDecorations();

  // Ensure lenses are refreshed immediately (important when code lenses are registered dynamically).
  refreshLenses();

  return finalChoicePromise.finally(() => {
    cleanup();
  });
}

