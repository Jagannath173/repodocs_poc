import * as vscode from "vscode";
import { diffLines } from "diff";
import { revealAndHighlightAppliedFix } from "../review/postApplyHighlight";

export type FixInEditorChoice = "accept" | "reject";

/** CodeLens uses these ids (declared in package.json) with `arguments: [chunkIndex]`. */
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
  /** Populated on each CodeLens refresh: map editor line → chunk id when args are missing. */
  getChunkIdForLine: (line: number) => number | undefined;
};

let activeFixPreviewSession: FixPreviewSessionHandlers | undefined;
let activeFixPreviewCancellation:
  | {
      documentUri: string;
      cancel: () => Promise<void>;
    }
  | undefined;

export async function cancelFixPreviewForDocumentUri(documentUri: string): Promise<boolean> {
  const active = activeFixPreviewCancellation;
  if (!active || active.documentUri !== documentUri) {
    return false;
  }
  await active.cancel();
  return true;
}

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

/** Some hosts omit or nest CodeLens `arguments`; pull the first chunk id from any depth. */
function extractChunkIdFromArgs(args: unknown[]): number | undefined {
  const scan: unknown[] = [...args];
  while (scan.length) {
    const v = scan.shift();
    const id = coerceChunkId(v);
    if (id !== undefined) {
      return id;
    }
    if (Array.isArray(v)) {
      scan.push(...v);
    }
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
      let id = extractChunkIdFromArgs(flat) ?? extractChunkIdFromArgs(args);
      const editor = vscode.window.activeTextEditor;
      if (id === undefined && editor) {
        id = s.getChunkIdForLine(editor.selection.active.line);
      }
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
      let id = extractChunkIdFromArgs(flat) ?? extractChunkIdFromArgs(args);
      const editor = vscode.window.activeTextEditor;
      if (id === undefined && editor) {
        id = s.getChunkIdForLine(editor.selection.active.line);
      }
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

  /** Single provider for all sessions — avoids stacked duplicate CodeLens when preview runs again. */
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "untitled" }], {
      onDidChangeCodeLenses: fixPreviewCodeLensChangeEmitter.event,
      provideCodeLenses: (document) => provideFixPreviewCodeLenses(document),
    })
  );
  context.subscriptions.push(fixPreviewCodeLensChangeEmitter);
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

/**
 * Exactly one CodeLens provider is registered (see registerFixPreviewCommands).
 * Lens content comes from here so we never stack duplicate providers per preview session.
 */
type FixPreviewLensState = {
  docUri: string;
  mergeParts: DiffPart[];
  chunks: FixChunk[];
  decisions: boolean[];
  chunkDiffDismissed: boolean[];
  chunkLineIndex: Map<number, number>;
};

let fixPreviewLensState: FixPreviewLensState | undefined;

const fixPreviewCodeLensChangeEmitter = new vscode.EventEmitter<void>();

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

/** After an edit, show the updated buffer so CodeLens and decorations use the latest document. */
async function revealEditorForUri(docUri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(docUri);
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
}

/**
 * Preferred line for a chunk's Accept/Reject: last line of the chunk in the merged document
 * (avoids stacking multiple chunks on the same start line).
 */
function preferredChunkLensLine(
  r: { startLine: number; endLineExclusive: number } | undefined,
  anchorLine: number,
  lineCount: number
): number {
  if (r && r.endLineExclusive > r.startLine) {
    return Math.max(r.startLine, Math.min(r.endLineExclusive - 1, lineCount - 1));
  }
  return Math.min(Math.max(0, anchorLine), Math.max(0, lineCount - 1));
}

/** Ensures each chunk's CodeLens sits on its own line when possible (no duplicate rows). */
function allocateUniqueLensLine(
  preferred: number,
  used: Set<number>,
  lineCount: number,
  maxLineInclusive: number
): number {
  const cap = Math.max(0, Math.min(maxLineInclusive, lineCount - 1));
  let L = Math.max(0, Math.min(preferred, cap));
  let guard = 0;
  while (used.has(L) && guard < lineCount + 8) {
    L = Math.min(L + 1, cap);
    guard++;
  }
  used.add(L);
  return L;
}

type FixPreviewLensLayout = {
  chunkLineIndex: Map<number, number>;
  chunkLensLines: Array<{ chunkId: number; lensLine: number }>;
  globalLine: number | undefined;
};

function computeFixPreviewLensLayout(st: FixPreviewLensState, document: vscode.TextDocument): FixPreviewLensLayout {
  const { mergeParts, chunks, decisions, chunkDiffDismissed } = st;
  const rangeMap = getChunkMergedLineRanges(mergeParts, chunks, decisions);
  const lineCount = document.lineCount;
  const pendingGlobal = chunks.some((_, i) => !chunkDiffDismissed[i]);
  const maxChunkLineInclusive = pendingGlobal ? Math.max(0, lineCount - 2) : Math.max(0, lineCount - 1);
  const usedLines = new Set<number>();
  const chunkLineIndex = new Map<number, number>();
  const chunkLensLines: Array<{ chunkId: number; lensLine: number }> = [];

  for (const c of chunks) {
    if (chunkDiffDismissed[c.id]) {
      continue;
    }
    const r = rangeMap.get(c.id);
    const preferred = preferredChunkLensLine(r, c.anchorLine, lineCount);
    const clampedPreferred = Math.min(preferred, maxChunkLineInclusive);
    const lensLine = allocateUniqueLensLine(clampedPreferred, usedLines, lineCount, maxChunkLineInclusive);
    chunkLensLines.push({ chunkId: c.id, lensLine });
    chunkLineIndex.set(lensLine, c.id);
    if (r && r.endLineExclusive > r.startLine) {
      for (let li = r.startLine; li < r.endLineExclusive; li++) {
        chunkLineIndex.set(li, c.id);
      }
    }
  }

  const globalLine = pendingGlobal && lineCount >= 1 ? lineCount - 1 : undefined;
  return { chunkLineIndex, chunkLensLines, globalLine };
}

function provideFixPreviewCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
  const st = fixPreviewLensState;
  if (!st || document.uri.toString() !== st.docUri) {
    return [];
  }
  const { chunks } = st;
  if (!chunks.length) {
    return [];
  }

  st.chunkLineIndex.clear();
  const layout = computeFixPreviewLensLayout(st, document);
  layout.chunkLineIndex.forEach((v, k) => st.chunkLineIndex.set(k, v));

  const lenses: vscode.CodeLens[] = [];

  for (const { chunkId, lensLine } of layout.chunkLensLines) {
    const c = chunks[chunkId];
    if (!c) {
      continue;
    }
    const range = new vscode.Range(new vscode.Position(lensLine, 0), new vscode.Position(lensLine, 0));
    lenses.push(
      new vscode.CodeLens(range, {
        title: "✅ Accept",
        command: CMD_ACCEPT_CHUNK,
        arguments: [c.id],
        tooltip: `Accept this change for this block.\nAdded: ${c.addedPreview}\nRemoved: ${c.removedPreview}`,
      })
    );
    lenses.push(
      new vscode.CodeLens(range, {
        title: "❌ Reject",
        command: CMD_REJECT_CHUNK,
        arguments: [c.id],
        tooltip: `Reject this block (keep original).\nKeep: ${c.removedPreview}\nDiscard: ${c.addedPreview}`,
      })
    );
  }

  if (layout.globalLine !== undefined) {
    const globalLine = layout.globalLine;
    const bottomRange = new vscode.Range(new vscode.Position(globalLine, 0), new vscode.Position(globalLine, 0));
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
  }

  return lenses;
}

/**
 * Per-chunk ✓ Accept / ✕ Reject on each block’s line (typically last line of the block),
 * whole-file actions on the last line of the buffer (padding lines keep that row separate).
 */
export async function previewFixInEditorAndWait(
  baseDoc: vscode.TextDocument,
  baseText: string,
  afterText: string,
  _title: string
): Promise<FixInEditorChoice> {
  const chunks = computeFixChunks(baseText, afterText, baseDoc);

  // No diff: nothing to accept/reject. Treat as "accept" so fix flow can continue.
  if (!chunks.length) {
    return "accept";
  }

  /** Extra trailing newlines so each chunk’s CodeLens can land on its own line (short files). */
  const padTailNewlines = Math.max(2, chunks.length + 1);
  const appendFixPreviewPad = (merged: string): string =>
    merged.replace(/\r\n/g, "\n") + "\n".repeat(padTailNewlines);
  const stripFixPreviewPad = (docText: string): string => {
    const t = docText.replace(/\r\n/g, "\n");
    const suffix = "\n".repeat(padTailNewlines);
    return t.endsWith(suffix) ? t.slice(0, -padTailNewlines) : t;
  };

  const decisions = chunks.map(() => true); // default: accept all chunks
  /** After Accept/Reject on a block, stop highlighting that block (user confirmed). */
  const chunkDiffDismissed = chunks.map(() => false);

  const mergeParts = diffLines(baseText, afterText) as unknown as DiffPart[];

  const docUri = baseDoc.uri;
  const baseNorm = normalizeReviewText(baseText);

  // Green = pending diff vs original snapshot (dismissed per chunk after that block is accepted/rejected).
  const decorationDiffAdded = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(63, 185, 80, 0.2)",
    border: "1px solid rgba(63, 185, 80, 0.45)",
  });
  // Red = chunk includes removed/changed content from the original snapshot.
  const decorationDiffRemoved = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(248, 81, 73, 0.16)",
    border: "1px solid rgba(248, 81, 73, 0.4)",
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

    const current = normalizeReviewText(stripFixPreviewPad(currentEditor.document.getText()));
    const rangeMap = getChunkMergedLineRanges(mergeParts, chunks, decisions);
    const lineToChunk = new Map<number, number>();
    for (const c of chunks) {
      const r = rangeMap.get(c.id);
      if (!r) {
        continue;
      }
      for (let li = r.startLine; li < r.endLineExclusive; li++) {
        lineToChunk.set(li, c.id);
      }
    }

    const addedLines = lineNumbersForAddedInMerged(baseNorm, current);
    const toHighlight = addedLines.filter((line) => {
      const cid = lineToChunk.get(line);
      if (cid === undefined) {
        return false;
      }
      return !chunkDiffDismissed[cid];
    });
    const removedLikeLines: number[] = [];
    for (const c of chunks) {
      if (chunkDiffDismissed[c.id]) {
        continue;
      }
      if (!c.removedLineNumbers.length) {
        continue;
      }
      const r = rangeMap.get(c.id);
      if (!r) {
        continue;
      }
      for (let li = r.startLine; li < r.endLineExclusive; li++) {
        removedLikeLines.push(li);
      }
    }
    const addedSet = new Set(toHighlight);
    const removedLikeUnique = Array.from(new Set(removedLikeLines)).filter((line) => !addedSet.has(line));
    currentEditor.setDecorations(decorationDiffAdded, buildRangesForLines(toHighlight));
    currentEditor.setDecorations(decorationDiffRemoved, buildRangesForLines(removedLikeUnique));
  };

  const applyCurrentPreviewToEditor = async (): Promise<boolean> => {
    const mergedText = appendFixPreviewPad(buildCurrentMergedText());
    const ok = await applyWholeDocumentReplace(docUri, mergedText);
    if (ok) {
      await revealEditorForUri(docUri);
    }
    return ok;
  };

  let finalChoiceResolver!: (c: FixInEditorChoice) => void;
  const finalChoicePromise = new Promise<FixInEditorChoice>((resolve) => {
    finalChoiceResolver = resolve;
  });
  let resolved = false;

  const cleanupCallbacks: Array<() => void> = [];
  const cleanup = () => {
    if (resolved) return;
    resolved = true;
    activeFixPreviewSession = undefined;
    if (activeFixPreviewCancellation?.documentUri === docUri.toString()) {
      activeFixPreviewCancellation = undefined;
    }
    fixPreviewLensState = undefined;
    fixPreviewCodeLensChangeEmitter.fire();
    for (const fn of cleanupCallbacks) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    decorationDiffAdded.dispose();
    decorationDiffRemoved.dispose();
  };

  const finishWhenAllChunksDismissed = async (): Promise<void> => {
    if (!chunks.every((_, i) => chunkDiffDismissed[i])) {
      return;
    }
    if (resolved) {
      return;
    }
    const mergedText = buildCurrentMergedText();
    const ok = await applyWholeDocumentReplace(docUri, mergedText);
    if (ok) {
      await revealEditorForUri(docUri);
    } else {
      void vscode.window.showWarningMessage(
        "Could not write the file after reviewing all blocks. Check if the document is read-only or locked."
      );
      finalChoiceResolver("reject");
      cleanup();
      return;
    }
    const allRejected = decisions.every((d) => !d);
    finalChoiceResolver(allRejected ? "reject" : "accept");
    cleanup();
  };

  const refreshLenses = (): void => {
    try {
      void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    } catch {
      // ignore
    }
  };

  const chunkLineIndex = new Map<number, number>();
  fixPreviewLensState = {
    docUri: baseDoc.uri.toString(),
    mergeParts,
    chunks,
    decisions,
    chunkDiffDismissed,
    chunkLineIndex,
  };

  activeFixPreviewSession = {
    getChunkCount: () => chunks.length,
    getChunkIdForLine: (line: number) => fixPreviewLensState?.chunkLineIndex.get(line),
    acceptChunk: async (chunkId: number) => {
      if (resolved) return;
      if (chunkId < 0 || chunkId >= decisions.length) return;
      decisions[chunkId] = true;
      chunkDiffDismissed[chunkId] = true;
      const beforeDoc = await vscode.workspace.openTextDocument(docUri);
      const beforeNorm = normalizeReviewText(stripFixPreviewPad(beforeDoc.getText()));
      const ok = await applyCurrentPreviewToEditor();
      if (!ok) {
        chunkDiffDismissed[chunkId] = false;
        void vscode.window.showWarningMessage(
          "Could not write the file for this preview. Check if the document is read-only or locked."
        );
        return;
      }
      const afterDoc = await vscode.workspace.openTextDocument(docUri);
      const afterNorm = normalizeReviewText(stripFixPreviewPad(afterDoc.getText()));
      await revealAndHighlightAppliedFix(docUri, beforeNorm, afterNorm);
      updateDecorations();
      fixPreviewCodeLensChangeEmitter.fire();
      refreshLenses();
      await finishWhenAllChunksDismissed();
    },
    rejectChunk: async (chunkId: number) => {
      if (resolved) return;
      if (chunkId < 0 || chunkId >= decisions.length) return;
      decisions[chunkId] = false;
      chunkDiffDismissed[chunkId] = true;
      const ok = await applyCurrentPreviewToEditor();
      if (!ok) {
        chunkDiffDismissed[chunkId] = false;
        void vscode.window.showWarningMessage(
          "Could not write the file for this preview. Check if the document is read-only or locked."
        );
        return;
      }
      updateDecorations();
      fixPreviewCodeLensChangeEmitter.fire();
      refreshLenses();
      await finishWhenAllChunksDismissed();
    },
    acceptAll: async () => {
      if (resolved) return;
      try {
        for (let i = 0; i < decisions.length; i++) {
          decisions[i] = true;
          chunkDiffDismissed[i] = true;
        }
        const mergedText = buildCurrentMergedText();
        const ok = await applyWholeDocumentReplace(docUri, mergedText);
        if (ok) {
          await revealEditorForUri(docUri);
          await revealAndHighlightAppliedFix(docUri, baseText, mergedText);
        }
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
        if (ok) {
          await revealEditorForUri(docUri);
        }
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
  activeFixPreviewCancellation = {
    documentUri: docUri.toString(),
    cancel: async () => {
      if (resolved) {
        return;
      }
      try {
        const ok = await applyWholeDocumentReplace(docUri, baseText);
        if (ok) {
          await revealEditorForUri(docUri);
        }
      } finally {
        finalChoiceResolver("reject");
        cleanup();
      }
    },
  };

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

  const initialOk = await applyWholeDocumentReplace(docUri, appendFixPreviewPad(buildCurrentMergedText()));
  if (initialOk) {
    await revealEditorForUri(docUri);
    /** Scroll/center on the proposed changes as soon as the preview buffer is written (Fix / fix-all steps). */
    const snapDoc = await vscode.workspace.openTextDocument(docUri);
    const proposedNorm = normalizeReviewText(stripFixPreviewPad(snapDoc.getText()));
    await revealAndHighlightAppliedFix(docUri, baseText, proposedNorm);
  } else {
    void vscode.window.showWarningMessage(
      "Could not open fix preview in the editor. Check if the document is read-only or locked."
    );
    finalChoiceResolver("reject");
    cleanup();
    return finalChoicePromise;
  }
  updateDecorations();

  // Ensure lenses are refreshed immediately (important when code lenses are registered dynamically).
  refreshLenses();

  return finalChoicePromise.finally(() => {
    cleanup();
  });
}

