import * as vscode from "vscode";
import { extensionContext } from "../extension";
import { ensureCopilotSession } from "../utils/session";
import { runCopilotInference } from "../utils/pythonRunner";
import { createTwoFilesPatch } from "diff";
import {
  extractFirstJsonObject,
  type AppliedFixRecord,
  type ReviewFinding,
  type ReviewPayload,
} from "../commands/webview/review_Webview/reviewPanel";
import {
  getReviewPanelForDocument,
  notifyReviewUpdated,
  type ReviewPanelLike,
  type ReviewTableState,
} from "./reviewBridge";
import { suppressReviewStaleFlushForUri } from "./reviewStaleSuppress";
import { log, sanitizeForLog } from "../utils/logger";
import { hashDocumentText } from "../utils/documentHash";
import { previewFixInEditorAndWait } from "../preview/fixInEditorPreview";
import { revealAndHighlightAppliedFix } from "./postApplyHighlight";

export const LAST_REVIEW_STATE_KEY = "codeReview.lastReview";
const REVIEW_STATE_BY_URI_KEY = "codeReview.reviewByUri";

export type StoredReview = ReviewTableState;
type ReviewStateByUri = {
  lastDocumentUri?: string;
  byDocumentUri: Record<string, StoredReview>;
};

const FIX_SYSTEM_ROLE = `You apply a single code-review suggestion to an entire source file.
Respond with ONLY valid JSON (no markdown outside JSON) in this exact shape:
{"fileContent":"<the complete file contents after applying the change>"}
Rules:
- "fileContent" must be the full file text after the edit, not a diff and not a fragment.
- Preserve the file's style, imports, and formatting unless the suggestion requires changing them.
- Follow "Additional instructions from the developer" when present (they were already verified as related to this task).
- Do not add commentary outside the JSON object.`;

/** Pre-flight when the user types optional extra instructions: reject clearly off-topic prompts before spending a full fix call. */
const EXTRA_INSTRUCTION_GATE_SYSTEM_ROLE = `strict relevance gate — reply with JSON only, no markdown fences.
You decide whether the user's "Developer additional instruction" is meaningfully related to the review finding and the code excerpt (same task, file, language, security/style intent, or a plausible way to implement that finding).
Set relevant to false only when the instruction is clearly unrelated (wrong domain, nonsense, unrelated product, jokes, personal topics, or asks for changes that cannot apply to this file/finding).
If the connection is weak but still about code, tests, style, or this finding, set relevant to true.
Output shape: {"relevant": true} or {"relevant": false, "briefReason": "<one short sentence>"}`;

const GATE_CODE_EXCERPT_MAX_CHARS = 28_000;

function buildCodeExcerptForGate(fileContent: string, maxChars: number): string {
  if (fileContent.length <= maxChars) {
    return fileContent;
  }
  const headLen = Math.floor(maxChars * 0.62);
  const tailLen = maxChars - headLen - 100;
  const omitted = fileContent.length - headLen - tailLen;
  return (
    fileContent.slice(0, headLen) +
    `\n\n/* … ${omitted} characters omitted … */\n\n` +
    fileContent.slice(fileContent.length - tailLen)
  );
}

function buildExtraInstructionGatePrompt(
  fileName: string,
  reviewSummary: string,
  finding: ReviewFinding,
  codeExcerpt: string,
  extraInstruction: string
): string {
  return `File name: ${fileName}

Review summary:
${reviewSummary}

Finding to fix (one row from the review table):
- Title: ${finding.title}
- Severity: ${finding.severity} | Category: ${finding.category}
- Detail: ${finding.detail}
- Suggestion: ${finding.suggestion}

Source excerpt (truncated if long; judge fit against this code):
\`\`\`
${codeExcerpt}
\`\`\`

Developer additional instruction:
${extraInstruction}

Return only JSON: {"relevant": true} or {"relevant": false, "briefReason": "..."}`;
}

function parseRelevanceGateResponse(raw: string): { relevant: boolean; briefReason?: string } {
  const jsonStr = extractFirstJsonObject(raw);
  const data = JSON.parse(jsonStr) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Gate response must be a JSON object.");
  }
  const o = data as Record<string, unknown>;
  const r = o.relevant;
  if (typeof r !== "boolean") {
    throw new Error('Gate JSON must include boolean "relevant".');
  }
  const br = o.briefReason;
  return {
    relevant: r,
    briefReason: typeof br === "string" ? br : undefined,
  };
}

function parseFixFileContent(raw: string): string {
  const jsonStr = extractFirstJsonObject(raw);
  const data = JSON.parse(jsonStr) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Fix response must be a JSON object.");
  }
  const o = data as Record<string, unknown>;
  const fc = o.fileContent;
  if (typeof fc !== "string") {
    throw new TypeError('Expected JSON with a string "fileContent" property.');
  }
  return fc;
}

function buildFixPrompt(
  fileName: string,
  fileContent: string,
  summary: string,
  finding: ReviewFinding,
  extraInstruction?: string
): string {
  const extra = extraInstruction?.trim()
    ? `\n\nAdditional instructions from the developer (must follow these while implementing this finding): ${extraInstruction.trim()}`
    : "";
  return `File name: ${fileName}

Current file:
\`\`\`
${fileContent}
\`\`\`

Review summary: ${summary}

Apply ONLY the following single finding next (do not address other issues unless required by the additional instructions):
- Title: ${finding.title}
- Severity: ${finding.severity} | Category: ${finding.category}
- Detail: ${finding.detail}
- Suggestion: ${finding.suggestion}
${extra}

Return JSON: {"fileContent": "..."} with the full updated file.`;
}

function appendAssistantFromSseLine(line: string, state: { text: string }): void {
  const trimmed = line.trim();
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
      state.text += piece;
    }
  } catch {
    /* ignore */
  }
}

function readReviewStateByUri(): ReviewStateByUri {
  const state = extensionContext.workspaceState.get<ReviewStateByUri>(REVIEW_STATE_BY_URI_KEY);
  if (!state || typeof state !== "object") {
    return { byDocumentUri: {} };
  }
  const byDocumentUri =
    state.byDocumentUri && typeof state.byDocumentUri === "object" ? state.byDocumentUri : {};
  return {
    lastDocumentUri: typeof state.lastDocumentUri === "string" ? state.lastDocumentUri : undefined,
    byDocumentUri,
  };
}

export async function saveLastReview(payload: StoredReview): Promise<void> {
  const state = readReviewStateByUri();
  state.byDocumentUri[payload.documentUri] = payload;
  state.lastDocumentUri = payload.documentUri;
  await extensionContext.workspaceState.update(REVIEW_STATE_BY_URI_KEY, state);
  // Keep legacy key for backward compatibility with already persisted data.
  await extensionContext.workspaceState.update(LAST_REVIEW_STATE_KEY, payload);
}

export function getStoredReview(): StoredReview | undefined {
  const state = readReviewStateByUri();
  const activeUri = vscode.window.activeTextEditor?.document?.uri?.toString();
  if (activeUri && state.byDocumentUri[activeUri]) {
    return state.byDocumentUri[activeUri];
  }
  if (state.lastDocumentUri && state.byDocumentUri[state.lastDocumentUri]) {
    return state.byDocumentUri[state.lastDocumentUri];
  }
  return extensionContext.workspaceState.get<StoredReview>(LAST_REVIEW_STATE_KEY);
}

/** Workspace review state only if it belongs to this document and matches the reviewed buffer snapshot. */
export function getStoredReviewMatchingDocument(uri: vscode.Uri, documentText: string): StoredReview | undefined {
  const s = getStoredReview();
  if (!s || s.documentUri !== uri.toString()) {
    return undefined;
  }
  if (!s.reviewedDocumentHash) {
    return s;
  }
  return s.reviewedDocumentHash === hashDocumentText(documentText) ? s : undefined;
}

/** Latest workspace review row when it targets this file (hash need not match — used to merge fix state after edits/reload). */
export function getStoredReviewForDocumentUri(uri: vscode.Uri): StoredReview | undefined {
  const state = readReviewStateByUri();
  const byUri = state.byDocumentUri[uri.toString()];
  if (byUri) {
    return byUri;
  }
  const legacy = extensionContext.workspaceState.get<StoredReview>(LAST_REVIEW_STATE_KEY);
  if (legacy && legacy.documentUri === uri.toString()) {
    return legacy;
  }
  return undefined;
}

/** Persisted applied-fix fingerprints for this file (same URI as workspace-stored review). */
export function getAppliedFindingKeysForDocumentUri(uri: vscode.Uri): string[] {
  const s = getStoredReviewForDocumentUri(uri);
  return s?.appliedFindingKeys?.length ? [...s.appliedFindingKeys] : [];
}

/** Fingerprints for rows the user rejected on the last stored review, for merging after Re-run Code Review. */
export function getRejectedFindingKeysForDocumentUri(uri: vscode.Uri): string[] {
  const s = getStoredReviewForDocumentUri(uri);
  if (!s) {
    return [];
  }
  if (s.rejectedFindingKeys?.length) {
    return [...s.rejectedFindingKeys];
  }
  /** Legacy workspace state: derive keys from rejected row indices before `rejectedFindingKeys` existed. */
  if (!s.findings?.length || !s.rejectedIndices?.length) {
    return [];
  }
  const keys: string[] = [];
  for (const idx of s.rejectedIndices) {
    const f = s.findings[idx];
    if (f) {
      keys.push(makeFindingKey(f));
    }
  }
  return keys;
}

const normKeyPart = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, " ");

/** Legacy fingerprint (title|category|severity|suggestion) for matching older workspace state. */
export function legacyFindingKey(finding: ReviewFinding): string {
  return [
    normKeyPart(finding.title || ""),
    normKeyPart(finding.category || ""),
    normKeyPart(finding.severity || ""),
    normKeyPart(finding.suggestion || ""),
  ].join("|");
}

/**
 * Stable fingerprint for a finding; includes a trimmed detail prefix so distinct rows
 * rarely share the same key (fixes wrong-row Accepted/Rejected when keys collided).
 */
export function makeFindingKey(finding: ReviewFinding): string {
  const base = legacyFindingKey(finding);
  const d = normKeyPart((finding.detail || "").slice(0, 96));
  return d.length > 0 ? `${base}|${d}` : base;
}

/** True if persisted key refers to this finding (supports pre-detail keys). */
export function findingMatchesStoredKey(finding: ReviewFinding, storedKey: string): boolean {
  if (makeFindingKey(finding) === storedKey) {
    return true;
  }
  return legacyFindingKey(finding) === storedKey;
}

/**
 * Map applied row indices from a key list. Each stored key matches at most one row.
 * When `preferredIndices` is set (usually `stored.appliedIndices`), those rows win first so
 * duplicate keys do not mark the wrong row after a fix.
 */
export function findAppliedIndicesByKeys(
  findings: ReviewFinding[],
  appliedKeys: string[],
  preferredIndices?: number[]
): number[] {
  if (!appliedKeys.length) {
    return [];
  }
  const matched = new Set<number>();
  const keysConsumed = new Set<string>();

  if (preferredIndices?.length) {
    for (const idx of preferredIndices) {
      if (idx < 0 || idx >= findings.length) {
        continue;
      }
      const f = findings[idx];
      let hitKey: string | undefined;
      for (const sk of appliedKeys) {
        if (keysConsumed.has(sk)) {
          continue;
        }
        if (findingMatchesStoredKey(f, sk)) {
          hitKey = sk;
          break;
        }
      }
      if (hitKey === undefined) {
        continue;
      }
      matched.add(idx);
      keysConsumed.add(hitKey);
    }
  }

  for (let i = 0; i < findings.length; i++) {
    if (matched.has(i)) {
      continue;
    }
    for (const sk of appliedKeys) {
      if (keysConsumed.has(sk)) {
        continue;
      }
      if (!findingMatchesStoredKey(findings[i], sk)) {
        continue;
      }
      matched.add(i);
      keysConsumed.add(sk);
      break;
    }
  }

  return Array.from(matched).sort((a, b) => a - b);
}

/** After findings are merged/reordered, map a prior review’s `appliedIndices` onto `combined`. */
export function remapPriorAppliedIndicesToCombined(
  priorFindings: ReviewFinding[] | undefined,
  priorAppliedIndices: number[] | undefined,
  combined: ReviewFinding[]
): number[] | undefined {
  if (!priorFindings?.length || !priorAppliedIndices?.length) {
    return undefined;
  }
  const out: number[] = [];
  for (const idx of priorAppliedIndices) {
    if (idx < 0 || idx >= priorFindings.length) {
      continue;
    }
    const pf = priorFindings[idx];
    const j = combined.findIndex(
      (cf) =>
        makeFindingKey(cf) === makeFindingKey(pf) || legacyFindingKey(cf) === legacyFindingKey(pf)
    );
    if (j >= 0) {
      out.push(j);
    }
  }
  return out.length ? Array.from(new Set(out)).sort((a, b) => a - b) : undefined;
}

const fixOperationQueues = new Map<string, Promise<void>>();

/**
 * Runs fix operations concurrently across different files, but serializes operations
 * for the same document to avoid edit races and conflicting writes.
 */
async function runWithDocumentFixQueue(documentUri: string, task: () => Promise<void>): Promise<void> {
  const previous = fixOperationQueues.get(documentUri) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous
    .catch(() => {
      /* previous failure should not block queue */
    })
    .then(() => gate);
  fixOperationQueues.set(documentUri, current);

  await previous.catch(() => {
    /* previous failure already handled */
  });
  try {
    await task();
  } finally {
    release();
    if (fixOperationQueues.get(documentUri) === current) {
      fixOperationQueues.delete(documentUri);
    }
  }
}

async function withBufferHashSnapshot(base: StoredReview): Promise<StoredReview> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(base.documentUri));
    return { ...base, reviewedDocumentHash: hashDocumentText(doc.getText()) };
  } catch {
    return base;
  }
}

const MAX_STORED_DIFF_CHARS = 120_000;

function buildAppliedFixRecord(
  originalIndex: number,
  finding: ReviewFinding | undefined,
  baseText: string,
  afterText: string
): AppliedFixRecord {
  const b = baseText.replace(/\r\n/g, "\n");
  const a = afterText.replace(/\r\n/g, "\n");
  let unifiedDiff = "";
  try {
    unifiedDiff = createTwoFilesPatch(
      `${finding?.title ?? "finding"} (before)`,
      `${finding?.title ?? "finding"} (after)`,
      b,
      a,
      "snapshot",
      "snapshot"
    );
  } catch {
    unifiedDiff = "(could not build diff)";
  }
  if (unifiedDiff.length > MAX_STORED_DIFF_CHARS) {
    unifiedDiff = unifiedDiff.slice(0, MAX_STORED_DIFF_CHARS) + "\n… [truncated]";
  }
  return {
    findingIndex: originalIndex,
    title: finding?.title ?? "",
    detail: finding?.detail ?? "",
    suggestion: finding?.suggestion ?? "",
    severity: finding?.severity ?? "",
    category: finding?.category ?? "",
    unifiedDiff,
    appliedAt: new Date().toISOString(),
  };
}

async function markFindingApplied(originalIndex: number, fixRecord?: AppliedFixRecord): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const finding = s.findings[originalIndex];
  const findingKey = finding ? makeFindingKey(finding) : "";
  const applied = new Set(s.appliedIndices ?? []);
  applied.add(originalIndex);
  const appliedKeys = new Set(s.appliedFindingKeys ?? []);
  if (findingKey) {
    appliedKeys.add(findingKey);
  }
  const rejected = new Set(s.rejectedIndices ?? []);
  rejected.delete(originalIndex);
  const rejectedKeys = new Set(s.rejectedFindingKeys ?? []);
  if (findingKey) {
    rejectedKeys.delete(findingKey);
  }
  let nextRecords = s.appliedFixRecords ? [...s.appliedFixRecords] : [];
  if (fixRecord) {
    nextRecords = nextRecords.filter((r) => r.findingIndex !== originalIndex);
    nextRecords.push(fixRecord);
    nextRecords.sort((x, y) => x.findingIndex - y.findingIndex);
  }
  let next: StoredReview = {
    ...s,
    appliedIndices: Array.from(applied).sort((a, b) => a - b),
    appliedFindingKeys: Array.from(appliedKeys).sort(),
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
    rejectedFindingKeys: Array.from(rejectedKeys).sort(),
    appliedFixRecords: nextRecords,
  };
  next = await withBufferHashSnapshot(next);
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

async function markFindingRejected(originalIndex: number): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const finding = s.findings[originalIndex];
  const findingKey = finding ? makeFindingKey(finding) : "";
  const rejectedKeys = new Set(s.rejectedFindingKeys ?? []);
  if (findingKey) {
    rejectedKeys.add(findingKey);
  }
  const rejected = new Set(s.rejectedIndices ?? []);
  rejected.add(originalIndex);
  const applied = new Set(s.appliedIndices ?? []);
  applied.delete(originalIndex);
  const appliedKeys = new Set(s.appliedFindingKeys ?? []);
  if (findingKey) {
    appliedKeys.delete(findingKey);
  }
  const next: StoredReview = {
    ...s,
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
    appliedIndices: Array.from(applied).sort((a, b) => a - b),
    rejectedFindingKeys: Array.from(rejectedKeys).sort(),
    appliedFindingKeys: Array.from(appliedKeys).sort(),
  };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

/** Clears rejected status when the user starts a new fix attempt for that finding. */
async function clearFindingRejectedForIndex(originalIndex: number): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const finding = s.findings[originalIndex];
  const findingKey = finding ? makeFindingKey(finding) : "";
  const hadRejectedIndex = s.rejectedIndices?.includes(originalIndex) ?? false;
  const hadRejectedKey =
    Boolean(findingKey) && Boolean(s.rejectedFindingKeys?.includes(findingKey));
  if (!hadRejectedIndex && !hadRejectedKey) {
    return;
  }
  const rejected = new Set(s.rejectedIndices ?? []);
  rejected.delete(originalIndex);
  const rejectedKeys = new Set(s.rejectedFindingKeys ?? []);
  if (findingKey) {
    rejectedKeys.delete(findingKey);
  }
  const next: StoredReview = {
    ...s,
    rejectedIndices: Array.from(rejected).sort((a, b) => a - b),
    rejectedFindingKeys: Array.from(rejectedKeys).sort(),
  };
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

async function persistStoredReviewHashOnly(): Promise<void> {
  const s = getStoredReview();
  if (!s) {
    return;
  }
  const next = await withBufferHashSnapshot({ ...s });
  await saveLastReview(next);
  notifyReviewUpdated(next);
}

function holisticGateFinding(extra: string): ReviewFinding {
  return {
    severity: "info",
    category: "guided",
    title: "Whole-file guidance from developer",
    detail:
      "The developer asked for additional edits on this file after prior review fixes. Judge whether their instruction relates to this project, language, or file.",
    suggestion: extra.trim(),
  };
}

function buildHolisticExtraPrompt(stored: StoredReview, baseText: string, extra: string): string {
  const bullets = stored.findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}\n   Suggestion: ${f.suggestion}`)
    .join("\n\n");
  return `You improve an entire source file according to explicit developer instructions. Prior review findings are context only — prioritize the developer instructions below.

File: ${stored.fileName}

Review summary: ${stored.summary}

Review findings (context — many may already be addressed):
${bullets}

Developer instructions (PRIMARY — implement these in the full file):
${extra.trim()}

Current file:
\`\`\`
${baseText}
\`\`\`

Respond with ONLY valid JSON: {"fileContent":"<complete file contents after edits>"}`;
}

async function runHolisticApplyWithExtra(params: {
  stored: StoredReview;
  uri: vscode.Uri;
  panel: ReviewPanelLike;
  extra: string;
}): Promise<void> {
  const { stored, uri, panel, extra } = params;
  const baseText = (await vscode.workspace.openTextDocument(uri)).getText();
  const excerpt = buildCodeExcerptForGate(baseText, GATE_CODE_EXCERPT_MAX_CHARS);
  const gateFinding = holisticGateFinding(extra);

  panel.startFixStep(1, 1, "Apply with extra instructions");
  panel.addFixLog("Analyzing extra instructions vs this file…", "info");

  const gateState = { text: "" };
  try {
    await runCopilotInference(
      extensionContext,
      buildExtraInstructionGatePrompt(stored.fileName, stored.summary, gateFinding, excerpt, extra.trim()),
      (line) => {
        log.proxyLine("applyFixesGateHolistic", line);
        appendAssistantFromSseLine(line, gateState);
      },
      { systemRole: EXTRA_INSTRUCTION_GATE_SYSTEM_ROLE, stream: false }
    );
    const gate = parseRelevanceGateResponse(gateState.text);
    if (!gate.relevant) {
      const why = gate.briefReason ?? "Instruction does not appear related to this file.";
      panel.addFixLog(`Not run: ${why}`, "warn");
      void vscode.window.showWarningMessage(`Extra instructions were not applied — ${why}`);
      return;
    }
    panel.addFixLog("Instructions look relevant; streaming model response below…", "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    panel.addFixLog(`Could not analyze instructions (${msg}).`, "warn");
    void vscode.window.showWarningMessage("Could not verify extra instructions. Try again or shorten the prompt.");
    return;
  }

  panel.beginGuidedApplyStream();
  const state = { text: "" };
  try {
    await runCopilotInference(
      extensionContext,
      buildHolisticExtraPrompt(stored, baseText, extra),
      (line) => {
        log.proxyLine("applyFixesHolistic", line);
        appendAssistantFromSseLine(line, state);
        panel.setGuidedApplyStream(state.text);
      },
      { systemRole: FIX_SYSTEM_ROLE, stream: true }
    );
  } finally {
    panel.endGuidedApplyStream();
  }

  let afterText: string;
  try {
    afterText = parseFixFileContent(state.text);
    panel.addFixLog("Parsed model JSON.", "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    panel.addFixLog(`Could not parse JSON: ${msg}`, "error");
    panel.showFixError(`Could not parse guided edit JSON: ${msg}`);
    return;
  }

  const latestBase = (await vscode.workspace.openTextDocument(uri)).getText();
  const normalizedBase = latestBase.replace(/\r\n/g, "\n");
  const normalizedAfter = afterText.replace(/\r\n/g, "\n");
  if (normalizedBase === normalizedAfter) {
    panel.addFixLog("No file changes suggested.", "info");
    void vscode.window.showInformationMessage("Model returned no changes for your instructions.");
    return;
  }

  const freshDoc = await vscode.workspace.openTextDocument(uri);
  const choice = await previewFixInEditorAndWait(freshDoc, latestBase, afterText, "Apply with extra instructions");
  if (choice === "reject") {
    panel.addFixLog("Preview rejected — file unchanged.", "warn");
    void vscode.window.showInformationMessage("Guided edit rejected — no changes saved.");
    return;
  }

  await persistStoredReviewHashOnly();
  panel.addFixLog("Accepted — file updated. Review snapshot refreshed.", "success");
  void vscode.window.showInformationMessage(`Guided edit applied for ${stored.fileName}. Save if needed.`);
}

/**
 * Apply AI fixes from the last review: all findings in order, or one by index.
 * Each step shows an in-editor diff preview on the source file (CodeLens Accept / Reject), not in the Genie webview.
 */
export async function applyFixesFromReview(
  mode: "all" | "one" | "selected" = "all",
  index?: number,
  /** Pass "" from the webview to skip the optional input box; omit (undefined) to prompt. */
  extraUserInstruction?: string,
  selectedIndices?: number[]
): Promise<void> {
  log.info("applyFixes", "applyFixesFromReview started", { mode, index: index ?? "all" });
  if (!(await ensureCopilotSession())) {
    log.warn("applyFixes", "Aborted: no Copilot session");
    return;
  }

  const stored = getStoredReview();
  if (!stored || !stored.findings?.length) {
    log.warn("applyFixes", "No stored review findings");
    void vscode.window.showWarningMessage("Run Code Review on a file first, then use Apply fixes.");
    return;
  }

  const uriCheck = vscode.Uri.parse(stored.documentUri);
  const docCheck = await vscode.workspace.openTextDocument(uriCheck);
  if (stored.reviewedDocumentHash && hashDocumentText(docCheck.getText()) !== stored.reviewedDocumentHash) {
    log.warn("applyFixes", "Stored review does not match current file buffer");
    void vscode.window.showWarningMessage(
      "This file changed since the last review. Run Code Review again before applying fixes."
    );
    return;
  }

  const persistedAppliedByKey = findAppliedIndicesByKeys(
    stored.findings,
    stored.appliedFindingKeys ?? [],
    stored.appliedIndices
  );
  if (persistedAppliedByKey.length) {
    const mergedApplied = new Set([...(stored.appliedIndices ?? []), ...persistedAppliedByKey]);
    const nextStored: StoredReview = {
      ...stored,
      appliedIndices: Array.from(mergedApplied).sort((a, b) => a - b),
    };
    await saveLastReview(nextStored);
    notifyReviewUpdated(nextStored);
    stored.appliedIndices = nextStored.appliedIndices;
  }

  const uri = uriCheck;
  let doc = docCheck;
  let targetIndices: number[];
  if (mode === "one") {
    if (typeof index !== "number" || index < 0 || index >= stored.findings.length) {
      void vscode.window.showWarningMessage("Invalid finding index for Apply fix.");
      return;
    }
    if (stored.appliedIndices?.includes(index)) {
      void vscode.window.showWarningMessage("This finding was already applied.");
      return;
    }
    targetIndices = [index];
  } else if (mode === "selected") {
    const normalized = Array.from(new Set((selectedIndices ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < stored.findings.length)));
    if (!normalized.length) {
      void vscode.window.showWarningMessage("Select one or more findings to apply.");
      return;
    }
    targetIndices = normalized.sort((a, b) => a - b);
  } else {
    const appliedSet = new Set(stored.appliedIndices ?? []);
    const rejectedSet = new Set(stored.rejectedIndices ?? []);
    targetIndices = stored.findings
      .map((_, i) => i)
      .filter((i) => !appliedSet.has(i) && !rejectedSet.has(i));
  }

  let extra: string | undefined;
  if (extraUserInstruction === undefined) {
    const r = await vscode.window.showInputBox({
      title: "Apply fixes (optional)",
      prompt: "Extra instructions for the AI (optional). Leave empty to use only review suggestions.",
      ignoreFocusOut: true,
    });
    extra = r?.trim() || undefined;
  } else {
    extra = extraUserInstruction.trim() || undefined;
  }

  /** Whole-file guided edit when every row is already applied/rejected but the user typed extra instructions (e.g. Genie composer). */
  const holisticApply =
    mode === "all" &&
    stored.findings.length > 0 &&
    targetIndices.length === 0 &&
    !!extra?.trim();

  if (mode === "all" && targetIndices.length === 0 && !holisticApply) {
    void vscode.window.showInformationMessage(
      "No fixes to run — all findings are already applied or marked rejected. Use Retry on a rejected row to try again, or use Apply with extra instructions… to guided-edit the file."
    );
    return;
  }

  const panel = getReviewPanelForDocument(stored.documentUri);
  if (!panel) {
    log.warn("applyFixes", "Review panel not open for document");
    void vscode.window.showWarningMessage("Open the review tab for this file and run Apply fixes again.");
    return;
  }

  const total = targetIndices.length;
  let appliedCount = 0;
  let rejectedCount = 0;
  let failedCount = 0;
  let skippedIrrelevantInstructionCount = 0;

  const hasQueuedWork = fixOperationQueues.has(stored.documentUri);
  if (hasQueuedWork) {
    panel.addFixLog("Another fix run is in progress for this file. Your request is queued.", "warn");
  }

  const isBulkRun = mode !== "one";
  if (isBulkRun) {
    panel.setApplyingFixAll(true);
  }
  if (mode === "one" && typeof targetIndices[0] === "number") {
    panel.setApplyingFixIndex(targetIndices[0]);
  }

  await runWithDocumentFixQueue(stored.documentUri, async () => {
    const staleSuppress = suppressReviewStaleFlushForUri(uriCheck);
    try {
      if (holisticApply && extra?.trim()) {
        panel.addFixLog(
          "All review rows are already applied or rejected — running a whole-file pass from your instructions.",
          "info"
        );
        await runHolisticApplyWithExtra({
          stored,
          uri,
          panel,
          extra: extra.trim(),
        });
        return;
      }

      if (extra) {
        panel.addFixLog("Applying fixes with your extra instructions.", "info");
      }
      for (let step = 0; step < targetIndices.length; step++) {
        const originalIndex = targetIndices[step];
        const live = getStoredReview();
        if (!live?.findings?.length || originalIndex < 0 || originalIndex >= live.findings.length) {
          panel.addFixLog("Review data is missing or out of date; stopping fix run. Run Code Review again if needed.", "warn");
          break;
        }
        if (live.appliedIndices?.includes(originalIndex)) {
          panel.addFixLog(`Row ${originalIndex + 1} is already applied — skipping.`, "info");
          continue;
        }

        await clearFindingRejectedForIndex(originalIndex);
        const finding = live.findings[originalIndex];
        panel.startFixStep(step + 1, total, finding.title);
        panel.addFixLog("Sending fix request to model.", "info");

        doc = await vscode.workspace.openTextDocument(uri);
        const baseText = doc.getText();

        if (extra?.trim()) {
          panel.addFixLog("Analyzing your extra instruction against this finding and code…", "info");
          const gateState = { text: "" };
          const excerpt = buildCodeExcerptForGate(baseText, GATE_CODE_EXCERPT_MAX_CHARS);
          const gatePrompt = buildExtraInstructionGatePrompt(
            live.fileName,
            live.summary,
            finding,
            excerpt,
            extra.trim()
          );
          try {
            await runCopilotInference(
              extensionContext,
              gatePrompt,
              (line) => {
                log.proxyLine("applyFixesGate", line);
                appendAssistantFromSseLine(line, gateState);
              },
              { systemRole: EXTRA_INSTRUCTION_GATE_SYSTEM_ROLE, stream: false }
            );
            const gate = parseRelevanceGateResponse(gateState.text);
            if (!gate.relevant) {
              skippedIrrelevantInstructionCount += 1;
              const why = gate.briefReason ?? "Instruction does not appear related to this finding or file.";
              log.info("applyFixes", "Extra instruction rejected by relevance gate", { step: step + 1, why });
              panel.addFixLog(`Skipped: extra instruction not related (${why})`, "warn");
              panel.setApplyingFixIndex(null);
              if (!isBulkRun) {
                void vscode.window.showWarningMessage(
                  `Extra instruction was not applied — it does not fit this finding or file. ${why}`
                );
                return;
              }
              continue;
            }
            panel.addFixLog("Extra instruction fits this step; generating fix.", "success");
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            log.warn("applyFixes", "Relevance gate failed", { step: step + 1, error: sanitizeForLog(msg) });
            skippedIrrelevantInstructionCount += 1;
            panel.addFixLog(`Skipped: could not analyze extra instruction (${msg})`, "warn");
            panel.setApplyingFixIndex(null);
            if (!isBulkRun) {
              void vscode.window.showWarningMessage(
                "Could not verify your extra instruction against the code. Leave it empty or try a shorter note."
              );
              return;
            }
            continue;
          }
        }

        const prompt = buildFixPrompt(live.fileName, baseText, live.summary, finding, extra);
        const state = { text: "" };

        panel.setApplyingFixIndex(originalIndex);
        try {
          log.debug("applyFixes", "Sending fix prompt", { step: step + 1, total, promptChars: prompt.length });
          await runCopilotInference(
            extensionContext,
            prompt,
            (line) => {
              log.proxyLine("applyFixes", line);
              appendAssistantFromSseLine(line, state);
            },
            { systemRole: FIX_SYSTEM_ROLE, stream: true }
          );
          log.info("applyFixes", "Fix inference finished", { step: step + 1, responseChars: state.text.length });
          panel.addFixLog("Model response received.", "success");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error("applyFixes", "Copilot request failed for fix step", { step: step + 1, error: sanitizeForLog(msg) });
          failedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} failed (request): ${msg}`, "error");
          panel.setApplyingFixIndex(null);
          if (!isBulkRun) {
            panel.showFixError(`Copilot request failed: ${msg}`);
            void vscode.window.showInformationMessage("Apply fixes stopped.");
            return;
          }
          continue;
        }

        let afterText: string;
        try {
          afterText = parseFixFileContent(state.text);
          panel.addFixLog("Parsed model JSON successfully.", "success");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Could not parse JSON.";
          log.error("applyFixes", "Could not parse fix JSON", { step: step + 1, error: sanitizeForLog(msg) });
          failedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} failed (parse): ${msg}`, "error");
          panel.setApplyingFixIndex(null);
          if (!isBulkRun) {
            panel.showFixError(`Could not parse AI response as fix JSON: ${msg}`);
            void vscode.window.showInformationMessage("Apply fixes stopped.");
            return;
          }
          continue;
        }

        const normalizedBase = baseText.replace(/\r\n/g, "\n");
        const normalizedAfter = afterText.replace(/\r\n/g, "\n");
        if (normalizedBase === normalizedAfter) {
          panel.setApplyingFixIndex(null);
          const fixRec = buildAppliedFixRecord(originalIndex, finding, baseText, afterText);
          await markFindingApplied(originalIndex, fixRec);
          appliedCount += 1;
          doc = await vscode.workspace.openTextDocument(uri);
          await revealAndHighlightAppliedFix(uri, baseText, afterText);
          continue;
        }

        const previewTitle = finding.title || `Fix (${step + 1}/${total})`;
        const choice = await previewFixInEditorAndWait(doc, baseText, afterText, previewTitle);
        if (choice === "reject") {
          panel.setApplyingFixIndex(null);
          await markFindingRejected(originalIndex);
          rejectedCount += 1;
          panel.addFixLog(`Step ${step + 1}/${total} rejected. Continuing with next finding.`, "warn");
          if (!isBulkRun) {
            void vscode.window.showInformationMessage("Fix preview rejected. This finding is marked Rejected in Genie.");
            return;
          }
          continue;
        }

        panel.setApplyingFixIndex(null);
        const fixRec = buildAppliedFixRecord(originalIndex, finding, baseText, afterText);
        await markFindingApplied(originalIndex, fixRec);
        appliedCount += 1;
        doc = await vscode.workspace.openTextDocument(uri);
        await revealAndHighlightAppliedFix(uri, baseText, afterText);
      }

      log.info("applyFixes", "Apply fixes completed", { appliedCount, total });
      if (isBulkRun) {
        const skipPart =
          skippedIrrelevantInstructionCount > 0
            ? `, skipped (unrelated extra instruction) ${skippedIrrelevantInstructionCount}`
            : "";
        void vscode.window.showInformationMessage(
          `Fix-all completed: applied ${appliedCount}/${total}, rejected ${rejectedCount}, failed ${failedCount}${skipPart}.`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Accepted and applied ${appliedCount} fix step(s). Save the file if needed (${stored.fileName}).`
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("applyFixes", "applyFixesFromReview failed", { error: sanitizeForLog(msg) });
      panel.showFixError(`Apply fixes failed: ${msg}`);
      void vscode.window.showErrorMessage(`Apply fixes: ${msg}`);
    } finally {
      setTimeout(() => {
        staleSuppress.dispose();
      }, 550);
      panel.setApplyingFixIndex(null);
      if (isBulkRun) {
        panel.setApplyingFixAll(false);
      }
    }
  });
}

/** Map ReviewPayload + editor uri to stored shape (used from codeReview). */
export function toStoredReview(
  uri: vscode.Uri,
  fileName: string,
  payload: ReviewPayload,
  documentText: string
): StoredReview {
  const prior = getStoredReview();
  const sameDoc = prior?.documentUri === uri.toString();
  const n = payload.findings?.length ?? 0;
  const keyApplied = payload.appliedFindingKeys?.length ?? 0;
  const keyRejected = payload.rejectedFindingKeys?.length ?? 0;
  const floorFromKeys = keyApplied + keyRejected;
  const reviewFindingCount = sameDoc
    ? Math.max(prior?.reviewFindingCount ?? 0, n, floorFromKeys)
    : Math.max(n, floorFromKeys);
  const rejectedFindingKeys =
    payload.rejectedFindingKeys ??
    (sameDoc ? prior?.rejectedFindingKeys : undefined) ??
    [];
  return {
    documentUri: uri.toString(),
    fileName,
    summary: payload.summary,
    findings: payload.findings,
    appliedIndices: payload.appliedIndices ?? [],
    appliedFindingKeys: payload.appliedFindingKeys ?? [],
    rejectedIndices: payload.rejectedIndices ?? [],
    rejectedFindingKeys,
    reviewedDocumentHash: hashDocumentText(documentText),
    reviewFindingCount,
    appliedFixRecords: payload.appliedFixRecords ?? (sameDoc ? prior?.appliedFixRecords : undefined),
  };
}
