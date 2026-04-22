import * as vscode from "vscode";
import { diffLines } from "diff";
import { revealAndHighlightAppliedFix } from "../review/postApplyHighlight";

export type FixInEditorChoice = "accept" | "reject" | "cancelled";

/** CodeLens uses these ids (declared in package.json) with `arguments: [chunkIndex]`. */
const CMD_ACCEPT_CHUNK = "codeReview.fixPreview.acceptChunk";
const CMD_REJECT_CHUNK = "codeReview.fixPreview.rejectChunk";
const CMD_ACCEPT_ALL = "codeReview.fixPreview.acceptAllChanges";
const CMD_REJECT_ALL = "codeReview.fixPreview.rejectAllChanges";
const CMD_PREVIEW_PREV_BLOCK = "codeReview.fixPreview.prevBlock";
const CMD_PREVIEW_NEXT_BLOCK = "codeReview.fixPreview.nextBlock";
const CMD_PREVIEW_ACCEPT_CURRENT = "codeReview.fixPreview.acceptCurrentBlock";
const CMD_PREVIEW_REJECT_CURRENT = "codeReview.fixPreview.rejectCurrentBlock";
const CMD_PREVIEW_UNDO = "codeReview.fixPreview.undo";
const CMD_PREVIEW_REDO = "codeReview.fixPreview.redo";

type FixPreviewSessionHandlers = {
  acceptChunk: (id: number) => Promise<void>;
  rejectChunk: (id: number) => Promise<void>;
  acceptCurrentChunk: () => Promise<void>;
  rejectCurrentChunk: () => Promise<void>;
  acceptAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
  focusPrevPendingChunk: () => Promise<void>;
  focusNextPendingChunk: () => Promise<void>;
  undoInPreview: () => Promise<void>;
  redoInPreview: () => Promise<void>;
  getChunkCount: () => number;
  getFirstPendingChunkId: () => number | undefined;
  getPendingSummary: () => { current: number; total: number } | undefined;
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

/** Best-effort cleanup for extension reload/deactivate: cancel active preview and restore base text. */
export async function cancelAnyActiveFixPreview(): Promise<boolean> {
  const active = activeFixPreviewCancellation;
  if (!active) {
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
  const warnNoActivePreview = (): void => {
    void vscode.window.showWarningMessage("Fix preview is no longer active. Start Apply again to open a fresh preview.");
    fixPreviewCodeLensChangeEmitter.fire();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_ACCEPT_CHUNK, async (...args: unknown[]) => {
      const s = activeFixPreviewSession;
      if (!s) {
        warnNoActivePreview();
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
      if (id === undefined) {
        id = s.getFirstPendingChunkId();
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
        warnNoActivePreview();
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
      if (id === undefined) {
        id = s.getFirstPendingChunkId();
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
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_PREV_BLOCK, async () => {
      await activeFixPreviewSession?.focusPrevPendingChunk();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_NEXT_BLOCK, async () => {
      await activeFixPreviewSession?.focusNextPendingChunk();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_ACCEPT_CURRENT, async () => {
      const s = activeFixPreviewSession;
      if (!s) {
        warnNoActivePreview();
        return;
      }
      await s.acceptCurrentChunk();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_REJECT_CURRENT, async () => {
      const s = activeFixPreviewSession;
      if (!s) {
        warnNoActivePreview();
        return;
      }
      await s.rejectCurrentChunk();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_UNDO, async () => {
      await activeFixPreviewSession?.undoInPreview();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_REDO, async () => {
      await activeFixPreviewSession?.redoInPreview();
    })
  );

  /** Single provider for all sessions — avoids stacked duplicate CodeLens when preview runs again. */
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file" },
        { scheme: "untitled" },
        { scheme: "vscode-remote" },
        { scheme: "vscode-vfs" },
        /** Catch uncommon host schemes (e.g. some dev containers) while still returning [] for unrelated files. */
        { pattern: "**/*" },
      ],
      {
        onDidChangeCodeLenses: fixPreviewCodeLensChangeEmitter.event,
        provideCodeLenses: (document) => provideFixPreviewCodeLenses(document),
      }
    )
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

/** Avoid missing the editor on Windows when drive-letter casing or path normalization differs. */
function documentUrisEqual(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme) {
    return false;
  }
  if (a.scheme === "file" && b.scheme === "file") {
    return a.fsPath.replace(/\\/g, "/").toLowerCase() === b.fsPath.replace(/\\/g, "/").toLowerCase();
  }
  return a.toString() === b.toString();
}

function findTextEditorForUri(uri: vscode.Uri): vscode.TextEditor | undefined {
  const fromVisible = vscode.window.visibleTextEditors.find((e) => documentUrisEqual(e.document.uri, uri));
  if (fromVisible) {
    return fromVisible;
  }
  const active = vscode.window.activeTextEditor;
  if (active && documentUrisEqual(active.document.uri, uri)) {
    return active;
  }
  return undefined;
}

/** Same file open in split editor / diff column — decorate every visible instance. */
function findAllTextEditorsForUri(uri: vscode.Uri): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter((e) => documentUrisEqual(e.document.uri, uri));
}

/** Match workspace document to stored preview URI (encoding / casing can differ from baseDoc.toString()). */
function documentMatchesFixPreviewLensDoc(document: vscode.TextDocument, uriString: string): boolean {
  if (!uriString) {
    return false;
  }
  if (document.uri.toString() === uriString) {
    return true;
  }
  try {
    const parsed = vscode.Uri.parse(uriString);
    if (parsed.scheme === "file") {
      if (documentUrisEqual(document.uri, vscode.Uri.file(parsed.fsPath))) {
        return true;
      }
    } else if (documentUrisEqual(document.uri, parsed)) {
      return true;
    }
    if (document.uri.scheme === parsed.scheme && document.uri.authority === parsed.authority) {
      const a = document.uri.path.replace(/\\/g, "/");
      const b = parsed.path.replace(/\\/g, "/");
      if (a === b) {
        return true;
      }
      if (document.uri.scheme !== "file" && a.toLowerCase() === b.toLowerCase()) {
        return true;
      }
    }
    if (parsed.scheme === "file" && document.uri.scheme === "file") {
      const a = document.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      const b = parsed.fsPath.replace(/\\/g, "/").toLowerCase();
      return a.length > 0 && a === b;
    }
  } catch {
    return false;
  }
  return false;
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

function normalizeReviewText(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function normalizeForMeaningfulCompare(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Stacked diff preview: full-line red for old text, full-line green for new text below it
 * (same order as `buildStackedPreviewMergedText`). Pure insert = green only; pure delete = red only.
 */
function computeLineBlockChunkDecorations(
  mergeParts: DiffPart[],
  chunks: FixChunk[],
  decisions: boolean[],
  chunkDiffDismissed: boolean[],
  doc: vscode.TextDocument
): { greenRanges: vscode.Range[]; removedBeforeOptions: vscode.DecorationOptions[]; removedAnchorLines: vscode.Range[] } {
  const stacked = getChunkStackedVisualRanges(mergeParts, chunks, decisions, chunkDiffDismissed);
  const greenRanges: vscode.Range[] = [];
  const removedBeforeOptions: vscode.DecorationOptions[] = [];
  const removedAnchorLines: vscode.Range[] = [];

  for (const c of chunks) {
    if (chunkDiffDismissed[c.id]) {
      continue;
    }
    const vis = stacked.get(c.id);
    if (!vis) {
      continue;
    }
    for (let li = vis.removedStartLine; li < vis.removedEndExclusive && li < doc.lineCount; li++) {
      const len = doc.lineAt(li).text.length;
      removedAnchorLines.push(new vscode.Range(li, 0, li, len));
    }
    for (let li = vis.addedStartLine; li < vis.addedEndExclusive && li < doc.lineCount; li++) {
      const len = doc.lineAt(li).text.length;
      greenRanges.push(new vscode.Range(li, 0, li, len));
    }
  }

  return { greenRanges, removedBeforeOptions, removedAnchorLines };
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

/** When old and new would glue without a newline, insert one in the preview so red sits above green (like VS Code’s stacked diff). */
function stackChunkPreviewSegment(before: string, after: string): { segment: string; before: string; after: string } {
  if (!before) {
    return { segment: after, before: "", after };
  }
  if (!after) {
    return { segment: before, before, after: "" };
  }
  let sep = "";
  if (!before.endsWith("\n") && !after.startsWith("\n")) {
    sep = "\n";
  }
  return { segment: before + sep + after, before, after };
}

/**
 * Editor preview buffer only: for pending chunks, show removed text then added text (red/green blocks).
 * Dismissed chunks use a single region like the real merge. On Accept All / finish, use `buildMergedText`, not this.
 */
function buildStackedPreviewMergedText(
  parts: DiffPart[],
  chunks: FixChunk[],
  decisions: boolean[],
  chunkDiffDismissed: boolean[]
): string {
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
      if (chunkDiffDismissed[c.id]) {
        out += decisions[c.id] ? c.afterRegionText : c.beforeRegionText;
      } else {
        const { segment } = stackChunkPreviewSegment(c.beforeRegionText, c.afterRegionText);
        out += segment;
      }
      i = c.endPartIndex;
      continue;
    }
    out += parts[i].value;
    i += 1;
  }
  return out;
}

type StackedChunkVisual = {
  removedStartLine: number;
  removedEndExclusive: number;
  addedStartLine: number;
  addedEndExclusive: number;
};

function getChunkStackedVisualRanges(
  parts: DiffPart[],
  chunks: FixChunk[],
  decisions: boolean[],
  chunkDiffDismissed: boolean[]
): Map<number, StackedChunkVisual> {
  const startToChunk = new Map<number, number>();
  for (const c of chunks) startToChunk.set(c.startPartIndex, c.id);
  const idToChunk = new Map<number, FixChunk>();
  for (const c of chunks) idToChunk.set(c.id, c);

  const map = new Map<number, StackedChunkVisual>();
  let line = 0;
  let i = 0;
  while (i < parts.length) {
    const chunkId = startToChunk.get(i);
    if (chunkId !== undefined) {
      const c = idToChunk.get(chunkId)!;
      if (chunkDiffDismissed[c.id]) {
        const text = decisions[c.id] ? c.afterRegionText : c.beforeRegionText;
        line += countVisualLines(text);
      } else {
        const { segment, before } = stackChunkPreviewSegment(c.beforeRegionText, c.afterRegionText);
        const nb = countVisualLines(before);
        const total = countVisualLines(segment);
        const remStart = line;
        const remEnd = remStart + nb;
        const addStart = remEnd;
        const addEnd = remStart + total;
        map.set(c.id, {
          removedStartLine: remStart,
          removedEndExclusive: remEnd,
          addedStartLine: addStart,
          addedEndExclusive: addEnd,
        });
        line = addEnd;
      }
      i = c.endPartIndex;
      continue;
    }
    line += countVisualLines(parts[i].value);
    i += 1;
  }
  return map;
}

function computeFixChunks(baseText: string, afterText: string, baseDoc: vscode.TextDocument): FixChunk[] {
  // Ignore no-op diffs caused by trailing spaces/newline noise.
  if (normalizeForMeaningfulCompare(baseText) === normalizeForMeaningfulCompare(afterText)) {
    return [];
  }

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

  // Build regions: contiguous changed ranges only.
  // Splitting at every "same" part keeps Accept/Reject controls near each changed block.
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < diffParts.length) {
    while (i < diffParts.length && kinds[i] === "same") i++;
    if (i >= diffParts.length) break;

    const start = i;
    let j = i;
    while (j < diffParts.length && kinds[j] !== "same") j++;
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
    if (normalizeForMeaningfulCompare(beforeRegionText) === normalizeForMeaningfulCompare(afterRegionText)) {
      continue;
    }

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

    // Sequential ids (0..n-1) must match `decisions` / `chunkDiffDismissed` array slots — span index can skip
    // when a region is a no-op, so using `chunkIndex` here caused mis-indexing and false "all rejected" finishes.
    chunks.push({
      id: chunks.length,
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
  const fullDocumentRange = (doc: vscode.TextDocument): vscode.Range => {
    if (doc.lineCount === 0) {
      return new vscode.Range(0, 0, 0, 0);
    }
    const last = doc.lineCount - 1;
    return new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await vscode.workspace.openTextDocument(docUri);
    const visible = vscode.window.visibleTextEditors.find((e) => documentUrisEqual(e.document.uri, docUri));
    if (visible && documentUrisEqual(visible.document.uri, doc.uri)) {
      const rangeEd = fullDocumentRange(visible.document);
      const edited = await visible.edit((eb) => eb.replace(rangeEd, newText));
      if (edited) {
        return true;
      }
    }
    const range = fullDocumentRange(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, newText);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      return true;
    }
    const backoff = 20 * Math.pow(2, Math.min(attempt, 5));
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  return false;
}

/** After an edit, show the updated buffer so CodeLens and decorations use the latest document. */
async function revealEditorForUri(docUri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(docUri);
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
}

/** CodeLens on first “new” line when possible, else first removed line (delete-only). */
function preferredStackedLensLine(vis: StackedChunkVisual | undefined, anchorLine: number, lineCount: number): number {
  if (!vis) {
    return Math.min(Math.max(0, anchorLine), Math.max(0, lineCount - 1));
  }
  if (vis.addedEndExclusive > vis.addedStartLine) {
    return Math.max(0, Math.min(vis.addedStartLine, lineCount - 1));
  }
  if (vis.removedEndExclusive > vis.removedStartLine) {
    return Math.max(0, Math.min(vis.removedStartLine, lineCount - 1));
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
  const stackedMap = getChunkStackedVisualRanges(mergeParts, chunks, decisions, chunkDiffDismissed);
  const lineCount = document.lineCount;
  const pendingGlobal = chunks.some((c) => !chunkDiffDismissed[c.id]);
  const maxChunkLineInclusive = pendingGlobal ? Math.max(0, lineCount - 2) : Math.max(0, lineCount - 1);
  const usedLines = new Set<number>();
  const chunkLineIndex = new Map<number, number>();
  const chunkLensLines: Array<{ chunkId: number; lensLine: number }> = [];

  for (const c of chunks) {
    if (chunkDiffDismissed[c.id]) {
      continue;
    }
    const vis = stackedMap.get(c.id);
    const preferred = preferredStackedLensLine(vis, c.anchorLine, lineCount);
    const clampedPreferred = Math.min(preferred, maxChunkLineInclusive);
    const lensLine = allocateUniqueLensLine(clampedPreferred, usedLines, lineCount, maxChunkLineInclusive);
    chunkLensLines.push({ chunkId: c.id, lensLine });
    chunkLineIndex.set(lensLine, c.id);
    if (vis) {
      for (let li = vis.removedStartLine; li < vis.removedEndExclusive; li++) {
        chunkLineIndex.set(li, c.id);
      }
      for (let li = vis.addedStartLine; li < vis.addedEndExclusive; li++) {
        chunkLineIndex.set(li, c.id);
      }
    }
  }

  const globalLine = pendingGlobal && lineCount >= 1 ? lineCount - 1 : undefined;
  return { chunkLineIndex, chunkLensLines, globalLine };
}

/** Keep `chunkLineIndex` in sync with the buffer so Accept/Reject fallbacks work before CodeLens refresh finishes. */
function syncFixPreviewChunkLineIndexFromDocument(document: vscode.TextDocument): FixPreviewLensLayout | undefined {
  const st = fixPreviewLensState;
  if (!st || !documentMatchesFixPreviewLensDoc(document, st.docUri)) {
    return undefined;
  }
  if (!st.chunks.length) {
    return undefined;
  }
  st.chunkLineIndex.clear();
  const layout = computeFixPreviewLensLayout(st, document);
  layout.chunkLineIndex.forEach((v, k) => st.chunkLineIndex.set(k, v));
  return layout;
}

function provideFixPreviewCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
  const st = fixPreviewLensState;
  if (!st || !documentMatchesFixPreviewLensDoc(document, st.docUri)) {
    return [];
  }
  const { chunks } = st;
  if (!chunks.length) {
    return [];
  }

  const layout = syncFixPreviewChunkLineIndexFromDocument(document);
  if (!layout) {
    return [];
  }

  const lenses: vscode.CodeLens[] = [];
  const totalBlocks = chunks.length;

  for (const { chunkId, lensLine } of layout.chunkLensLines) {
    const c = chunks[chunkId];
    if (!c) {
      continue;
    }
    const blockLabel = `${chunkId + 1}/${totalBlocks}`;
    const range = new vscode.Range(new vscode.Position(lensLine, 0), new vscode.Position(lensLine, 0));
    lenses.push(
      new vscode.CodeLens(range, {
        title: `✅ Accept (${blockLabel})`,
        command: CMD_ACCEPT_CHUNK,
        arguments: [c.id],
        tooltip: `Accept change block ${blockLabel}.\nAdded: ${c.addedPreview}\nRemoved: ${c.removedPreview}`,
      })
    );
    lenses.push(
      new vscode.CodeLens(range, {
        title: `❌ Reject (${blockLabel})`,
        command: CMD_REJECT_CHUNK,
        arguments: [c.id],
        tooltip: `Reject block ${blockLabel} (keep original).\nKeep: ${c.removedPreview}\nDiscard: ${c.addedPreview}`,
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

  const appendFixPreviewPad = (merged: string): string => merged.replace(/\r\n/g, "\n");

  const decisions = chunks.map(() => true); // default: accept all chunks
  /** After Accept/Reject on a block, stop highlighting that block (user confirmed). */
  const chunkDiffDismissed = chunks.map(() => false);

  const mergeParts = diffLines(baseText, afterText) as unknown as DiffPart[];

  const docUri = baseDoc.uri;

  // Stacked diff: dark green = new lines, dark red = old lines (similar to VS Code inline diff).
  const decorationAddedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(30, 120, 55, 0.42)",
    border: "1px solid rgba(56, 170, 95, 0.78)",
    overviewRulerColor: "#238636",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  /** Removed / old lines in stacked preview (full line above the green addition). */
  const decorationRemovedAnchorLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(110, 22, 32, 0.52)",
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    borderColor: "rgba(200, 65, 75, 0.88)",
    overviewRulerColor: "#da3633",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  /** Red strikethrough block + overview-ruler marker (left lane) for each removal anchor line. */
  const decorationRemovedBefore = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: "#f85149",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  /** Final on-disk / accepted file content (not the stacked preview). */
  const buildCurrentMergedText = (): string => {
    return buildMergedText(mergeParts, chunks, decisions);
  };

  /** What the editor shows: old lines then new lines per pending chunk (red / green). */
  const buildCurrentStackedPreviewText = (): string => {
    return buildStackedPreviewMergedText(mergeParts, chunks, decisions, chunkDiffDismissed);
  };

  let focusedPendingChunkId: number | undefined = chunks[0]?.id;

  const getPendingChunkIds = (): number[] => chunks.filter((c) => !chunkDiffDismissed[c.id]).map((c) => c.id);

  const ensureFocusedPendingChunk = (): number | undefined => {
    const pending = getPendingChunkIds();
    if (!pending.length) {
      focusedPendingChunkId = undefined;
      return undefined;
    }
    if (focusedPendingChunkId !== undefined && pending.includes(focusedPendingChunkId)) {
      return focusedPendingChunkId;
    }
    focusedPendingChunkId = pending[0];
    return focusedPendingChunkId;
  };

  /** Text + per-chunk state after each successful full-buffer apply; undo/redo restores these so lenses/decorations match. */
  type PreviewHistorySnapshot = {
    text: string;
    decisions: boolean[];
    chunkDiffDismissed: boolean[];
  };
  const previewHistory: PreviewHistorySnapshot[] = [];
  let previewHistoryCursor = -1;

  const normalizeSnapshotText = (s: string): string => s.replace(/\r\n/g, "\n");

  const applySnapshotToSession = (snap: PreviewHistorySnapshot): void => {
    for (let i = 0; i < chunks.length; i++) {
      decisions[i] = snap.decisions[i] ?? true;
      chunkDiffDismissed[i] = snap.chunkDiffDismissed[i] ?? false;
    }
    focusedPendingChunkId = ensureFocusedPendingChunk();
  };

  const recordPreviewHistorySnapshot = async (): Promise<void> => {
    const d = await vscode.workspace.openTextDocument(docUri);
    const text = normalizeSnapshotText(d.getText());
    if (previewHistoryCursor >= 0 && previewHistoryCursor < previewHistory.length - 1) {
      previewHistory.splice(previewHistoryCursor + 1);
    }
    previewHistory.push({
      text,
      decisions: [...decisions],
      chunkDiffDismissed: [...chunkDiffDismissed],
    });
    previewHistoryCursor = previewHistory.length - 1;
  };

  const reconcilePreviewHistoryFromDocument = (document: vscode.TextDocument): boolean => {
    if (!previewHistory.length) {
      return false;
    }
    const norm = normalizeSnapshotText(document.getText());
    if (previewHistoryCursor > 0) {
      const prev = previewHistory[previewHistoryCursor - 1];
      if (prev.text === norm) {
        previewHistoryCursor -= 1;
        applySnapshotToSession(prev);
        return true;
      }
    }
    if (previewHistoryCursor >= 0 && previewHistoryCursor < previewHistory.length - 1) {
      const next = previewHistory[previewHistoryCursor + 1];
      if (next.text === norm) {
        previewHistoryCursor += 1;
        applySnapshotToSession(next);
        return true;
      }
    }
    for (let i = previewHistory.length - 1; i >= 0; i--) {
      if (previewHistory[i].text === norm) {
        previewHistoryCursor = i;
        applySnapshotToSession(previewHistory[i]);
        return true;
      }
    }
    return false;
  };

  const getPendingSummary = (): { current: number; total: number } | undefined => {
    const pending = getPendingChunkIds();
    if (!pending.length) {
      return undefined;
    }
    const focused = ensureFocusedPendingChunk();
    if (focused === undefined) {
      return undefined;
    }
    const idx = pending.indexOf(focused);
    if (idx < 0) {
      return undefined;
    }
    return { current: idx + 1, total: pending.length };
  };

  const revealPendingChunk = async (chunkId: number | undefined): Promise<void> => {
    if (chunkId === undefined) {
      return;
    }
    const currentDoc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(currentDoc, { preview: false, preserveFocus: false });
    const stackedMap = getChunkStackedVisualRanges(mergeParts, chunks, decisions, chunkDiffDismissed);
    const vis = stackedMap.get(chunkId);
    if (!vis) {
      return;
    }
    const hasRem = vis.removedEndExclusive > vis.removedStartLine;
    const hasAdd = vis.addedEndExclusive > vis.addedStartLine;
    if (!hasRem && !hasAdd) {
      return;
    }
    const startLine = clamp(
      hasRem ? vis.removedStartLine : vis.addedStartLine,
      0,
      Math.max(0, editor.document.lineCount - 1)
    );
    const endLine = clamp(
      Math.max(
        hasRem ? vis.removedEndExclusive - 1 : vis.addedStartLine,
        hasAdd ? vis.addedEndExclusive - 1 : vis.removedStartLine
      ),
      startLine,
      Math.max(0, editor.document.lineCount - 1)
    );
    const endChar = editor.document.lineAt(endLine).text.length;
    const range = new vscode.Range(startLine, 0, endLine, endChar);
    editor.selection = new vscode.Selection(startLine, 0, startLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  };

  const statusPager = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusPager.command = CMD_PREVIEW_NEXT_BLOCK;
  const statusPrev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  statusPrev.text = "$(chevron-left) Fix Prev";
  statusPrev.tooltip = "Focus previous pending fix block";
  statusPrev.command = CMD_PREVIEW_PREV_BLOCK;
  const statusNext = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
  statusNext.text = "$(chevron-right) Fix Next";
  statusNext.tooltip = "Focus next pending fix block";
  statusNext.command = CMD_PREVIEW_NEXT_BLOCK;
  const statusAccept = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
  statusAccept.text = "$(check) Fix Accept";
  statusAccept.tooltip = "Accept focused fix block";
  statusAccept.command = CMD_PREVIEW_ACCEPT_CURRENT;
  const statusReject = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 86);
  statusReject.text = "$(close) Fix Reject";
  statusReject.tooltip = "Reject focused fix block";
  statusReject.command = CMD_PREVIEW_REJECT_CURRENT;
  const statusUndo = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 85);
  statusUndo.text = "$(discard) Fix Undo";
  statusUndo.tooltip = "Undo inside fix preview";
  statusUndo.command = CMD_PREVIEW_UNDO;
  const statusRedo = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 84);
  statusRedo.text = "$(redo) Fix Redo";
  statusRedo.tooltip = "Redo inside fix preview";
  statusRedo.command = CMD_PREVIEW_REDO;

  const updateStatusUi = (): void => {
    const pending = getPendingSummary();
    if (!pending) {
      statusPager.hide();
      statusPrev.hide();
      statusNext.hide();
      statusAccept.hide();
      statusReject.hide();
      statusUndo.hide();
      statusRedo.hide();
      return;
    }
    statusPager.text = `$(diff) Fix ${pending.current}/${pending.total}`;
    statusPager.tooltip = "Focused pending change block";
    statusPager.show();
    statusPrev.show();
    statusNext.show();
    statusAccept.show();
    statusReject.show();
    statusUndo.show();
    statusRedo.show();
  };

  const applyDecorationsToEditor = (currentEditor: vscode.TextEditor): void => {
    const { greenRanges, removedBeforeOptions, removedAnchorLines } = computeLineBlockChunkDecorations(
      mergeParts,
      chunks,
      decisions,
      chunkDiffDismissed,
      currentEditor.document
    );
    currentEditor.setDecorations(decorationAddedLine, greenRanges);
    currentEditor.setDecorations(decorationRemovedAnchorLine, removedAnchorLines);
    currentEditor.setDecorations(decorationRemovedBefore, removedBeforeOptions);
    updateStatusUi();
  };

  const updateDecorationsAsync = async (): Promise<void> => {
    const matching = findAllTextEditorsForUri(docUri);
    if (matching.length > 0) {
      for (const ed of matching) {
        applyDecorationsToEditor(ed);
      }
      return;
    }
    try {
      const d = await vscode.workspace.openTextDocument(docUri);
      const currentEditor = await vscode.window.showTextDocument(d, { preview: false, preserveFocus: true });
      applyDecorationsToEditor(currentEditor);
    } catch {
      updateStatusUi();
    }
  };

  let decorationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleUpdateDecorations = (): void => {
    if (decorationRefreshTimer !== undefined) {
      clearTimeout(decorationRefreshTimer);
    }
    decorationRefreshTimer = setTimeout(() => {
      decorationRefreshTimer = undefined;
      void updateDecorationsAsync();
    }, 0);
  };

  /** First paint after preview opens can miss the editor; retry a few times so green/red + CodeLens stay in sync. */
  const runInitialDecorationPasses = (): void => {
    void updateDecorationsAsync();
    refreshLenses();
    setTimeout(() => {
      void updateDecorationsAsync();
      refreshLenses();
    }, 50);
    setTimeout(() => {
      void updateDecorationsAsync();
      refreshLenses();
    }, 200);
  };

  const applyCurrentPreviewToEditor = async (): Promise<boolean> => {
    const mergedText = appendFixPreviewPad(buildCurrentStackedPreviewText());
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
  /** Serialize preview actions so rapid CodeLens clicks queue instead of being dropped. */
  let previewOpQueue: Promise<void> = Promise.resolve();

  const enqueuePreviewOp = (fn: () => Promise<void>): Promise<void> => {
    const task = previewOpQueue.then(() => fn());
    previewOpQueue = task.catch(() => {});
    return task;
  };

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
    decorationAddedLine.dispose();
    decorationRemovedAnchorLine.dispose();
    decorationRemovedBefore.dispose();
    statusPager.dispose();
    statusPrev.dispose();
    statusNext.dispose();
    statusAccept.dispose();
    statusReject.dispose();
    statusUndo.dispose();
    statusRedo.dispose();
  };

  const finishWhenAllChunksDismissed = async (): Promise<void> => {
    if (!chunks.every((c) => chunkDiffDismissed[c.id])) {
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
      finalChoiceResolver("cancelled");
      cleanup();
      return;
    }
    const allRejected =
      chunks.length > 0 && chunks.every((c) => decisions[c.id] === false);
    finalChoiceResolver(allRejected ? "reject" : "accept");
    cleanup();
  };

  /** CodeLens providers must signal `onDidChangeCodeLenses`; the editor refresh alone is not always enough after undo/redo. */
  const refreshLenses = (): void => {
    fixPreviewCodeLensChangeEmitter.fire();
    try {
      void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    } catch {
      // ignore
    }
  };

  let lensRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefreshLensesDebounced = (): void => {
    if (lensRefreshTimer !== undefined) {
      clearTimeout(lensRefreshTimer);
    }
    lensRefreshTimer = setTimeout(() => {
      lensRefreshTimer = undefined;
      refreshLenses();
    }, 45);
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
    getFirstPendingChunkId: () => {
      for (const c of chunks) {
        if (!chunkDiffDismissed[c.id]) {
          return c.id;
        }
      }
      return undefined;
    },
    getPendingSummary: () => getPendingSummary(),
    getChunkIdForLine: (line: number) => fixPreviewLensState?.chunkLineIndex.get(line),
    focusPrevPendingChunk: async () => {
      const pending = getPendingChunkIds();
      if (!pending.length) {
        return;
      }
      const focused = ensureFocusedPendingChunk();
      const idx = Math.max(0, pending.indexOf(focused ?? pending[0]));
      focusedPendingChunkId = pending[(idx - 1 + pending.length) % pending.length];
      updateStatusUi();
      await revealPendingChunk(focusedPendingChunkId);
    },
    focusNextPendingChunk: async () => {
      const pending = getPendingChunkIds();
      if (!pending.length) {
        return;
      }
      const focused = ensureFocusedPendingChunk();
      const idx = Math.max(0, pending.indexOf(focused ?? pending[0]));
      focusedPendingChunkId = pending[(idx + 1) % pending.length];
      updateStatusUi();
      await revealPendingChunk(focusedPendingChunkId);
    },
    acceptCurrentChunk: async () => {
      const id = ensureFocusedPendingChunk();
      if (id === undefined) {
        return;
      }
      const session = activeFixPreviewSession;
      if (session) {
        await session.acceptChunk(id);
      }
    },
    rejectCurrentChunk: async () => {
      const id = ensureFocusedPendingChunk();
      if (id === undefined) {
        return;
      }
      const session = activeFixPreviewSession;
      if (session) {
        await session.rejectChunk(id);
      }
    },
    undoInPreview: async () => {
      let ed = findTextEditorForUri(docUri);
      if (!ed) {
        try {
          const d = await vscode.workspace.openTextDocument(docUri);
          ed = await vscode.window.showTextDocument(d, { preview: false, preserveFocus: false });
        } catch {
          return;
        }
      } else {
        await vscode.window.showTextDocument(ed.document, {
          viewColumn: ed.viewColumn ?? vscode.ViewColumn.Active,
          preview: false,
          preserveFocus: false,
        });
      }
      await vscode.commands.executeCommand("undo");
      const docAfter = await vscode.workspace.openTextDocument(docUri);
      if (fixPreviewLensState) {
        fixPreviewLensState.docUri = docAfter.uri.toString();
      }
      reconcilePreviewHistoryFromDocument(docAfter);
      syncFixPreviewChunkLineIndexFromDocument(docAfter);
      scheduleUpdateDecorations();
      refreshLenses();
      setTimeout(() => {
        void updateDecorationsAsync();
        refreshLenses();
      }, 50);
      setTimeout(() => {
        void updateDecorationsAsync();
        refreshLenses();
      }, 160);
    },
    redoInPreview: async () => {
      let ed = findTextEditorForUri(docUri);
      if (!ed) {
        try {
          const d = await vscode.workspace.openTextDocument(docUri);
          ed = await vscode.window.showTextDocument(d, { preview: false, preserveFocus: false });
        } catch {
          return;
        }
      } else {
        await vscode.window.showTextDocument(ed.document, {
          viewColumn: ed.viewColumn ?? vscode.ViewColumn.Active,
          preview: false,
          preserveFocus: false,
        });
      }
      await vscode.commands.executeCommand("redo");
      const docAfter = await vscode.workspace.openTextDocument(docUri);
      if (fixPreviewLensState) {
        fixPreviewLensState.docUri = docAfter.uri.toString();
      }
      reconcilePreviewHistoryFromDocument(docAfter);
      syncFixPreviewChunkLineIndexFromDocument(docAfter);
      scheduleUpdateDecorations();
      refreshLenses();
      setTimeout(() => {
        void updateDecorationsAsync();
        refreshLenses();
      }, 50);
      setTimeout(() => {
        void updateDecorationsAsync();
        refreshLenses();
      }, 160);
    },
    acceptChunk: async (chunkId: number) => {
      await enqueuePreviewOp(async () => {
        if (resolved) return;
        if (chunkId < 0 || chunkId >= decisions.length) return;
        if (chunkDiffDismissed[chunkId]) {
          const pending = getPendingChunkIds();
          if (!pending.length) {
            await finishWhenAllChunksDismissed();
            return;
          }
          chunkId = pending[0];
        }
        decisions[chunkId] = true;
        chunkDiffDismissed[chunkId] = true;
        focusedPendingChunkId = ensureFocusedPendingChunk();
        const ok = await applyCurrentPreviewToEditor();
        if (!ok) {
          chunkDiffDismissed[chunkId] = false;
          void vscode.window.showWarningMessage(
            "Could not write the file for this preview. Check if the document is read-only or locked."
          );
          return;
        }
        const docAfter = await vscode.workspace.openTextDocument(docUri);
        syncFixPreviewChunkLineIndexFromDocument(docAfter);
        await recordPreviewHistorySnapshot();
        scheduleUpdateDecorations();
        refreshLenses();
        await finishWhenAllChunksDismissed();
      });
    },
    rejectChunk: async (chunkId: number) => {
      await enqueuePreviewOp(async () => {
        if (resolved) return;
        if (chunkId < 0 || chunkId >= decisions.length) return;
        if (chunkDiffDismissed[chunkId]) {
          const pending = getPendingChunkIds();
          if (!pending.length) {
            await finishWhenAllChunksDismissed();
            return;
          }
          chunkId = pending[0];
        }
        decisions[chunkId] = false;
        chunkDiffDismissed[chunkId] = true;
        focusedPendingChunkId = ensureFocusedPendingChunk();
        const ok = await applyCurrentPreviewToEditor();
        if (!ok) {
          chunkDiffDismissed[chunkId] = false;
          void vscode.window.showWarningMessage(
            "Could not write the file for this preview. Check if the document is read-only or locked."
          );
          return;
        }
        const docAfter = await vscode.workspace.openTextDocument(docUri);
        syncFixPreviewChunkLineIndexFromDocument(docAfter);
        await recordPreviewHistorySnapshot();
        scheduleUpdateDecorations();
        refreshLenses();
        await finishWhenAllChunksDismissed();
      });
    },
    acceptAll: async () => {
      await enqueuePreviewOp(async () => {
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
            finalChoiceResolver("cancelled");
          } else {
            finalChoiceResolver("accept");
          }
        } finally {
          cleanup();
        }
      });
    },
    rejectAll: async () => {
      await enqueuePreviewOp(async () => {
        if (resolved) return;
        try {
          const ok = await applyWholeDocumentReplace(docUri, baseText);
          if (ok) {
            await revealEditorForUri(docUri);
          }
          if (!ok) {
            finalChoiceResolver("cancelled");
          } else {
            finalChoiceResolver("reject");
          }
        } finally {
          cleanup();
        }
      });
    },
  };
  activeFixPreviewCancellation = {
    documentUri: docUri.toString(),
    cancel: async () => {
      if (resolved) {
        return;
      }
      try {
        await applyWholeDocumentReplace(docUri, baseText);
      } finally {
        finalChoiceResolver("cancelled");
        cleanup();
      }
    },
  };

  const docChangeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (resolved) {
      return;
    }
    if (!documentUrisEqual(e.document.uri, docUri)) {
      return;
    }
    if (fixPreviewLensState) {
      fixPreviewLensState.docUri = e.document.uri.toString();
    }
    const isUndoRedo =
      e.reason === vscode.TextDocumentChangeReason.Undo ||
      e.reason === vscode.TextDocumentChangeReason.Redo;
    const historyRestored = isUndoRedo ? reconcilePreviewHistoryFromDocument(e.document) : false;
    syncFixPreviewChunkLineIndexFromDocument(e.document);
    scheduleUpdateDecorations();
    if (historyRestored || isUndoRedo) {
      refreshLenses();
      void updateDecorationsAsync();
    } else {
      scheduleRefreshLensesDebounced();
    }
  });
  cleanupCallbacks.push(() => docChangeSub.dispose());
  cleanupCallbacks.push(() => updateStatusUi());
  cleanupCallbacks.push(() => {
    if (decorationRefreshTimer !== undefined) {
      clearTimeout(decorationRefreshTimer);
      decorationRefreshTimer = undefined;
    }
    if (lensRefreshTimer !== undefined) {
      clearTimeout(lensRefreshTimer);
      lensRefreshTimer = undefined;
    }
  });

  // Reveal the target file so the lenses are visible.
  const existingEditor = findTextEditorForUri(docUri);
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

  const initialOk = await applyWholeDocumentReplace(docUri, appendFixPreviewPad(buildCurrentStackedPreviewText()));
  if (initialOk) {
    await revealEditorForUri(docUri);
    /** Scroll/center on the proposed changes as soon as the preview buffer is written (Fix / fix-all steps). */
    const snapDoc = await vscode.workspace.openTextDocument(docUri);
    if (fixPreviewLensState) {
      fixPreviewLensState.docUri = snapDoc.uri.toString();
    }
    syncFixPreviewChunkLineIndexFromDocument(snapDoc);
    await recordPreviewHistorySnapshot();
    const proposedNorm = normalizeReviewText(buildCurrentMergedText());
    await revealAndHighlightAppliedFix(docUri, baseText, proposedNorm);
  } else {
    void vscode.window.showWarningMessage(
      "Could not open fix preview in the editor. Check if the document is read-only or locked."
    );
    finalChoiceResolver("cancelled");
    cleanup();
    return finalChoicePromise;
  }
  runInitialDecorationPasses();
  await revealPendingChunk(ensureFocusedPendingChunk());
  scheduleUpdateDecorations();

  // Ensure lenses are refreshed immediately (important when code lenses are registered dynamically).
  refreshLenses();

  return finalChoicePromise.finally(() => {
    cleanup();
  });
}

