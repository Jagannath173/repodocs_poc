import * as vscode from "vscode";

/** When true, `runCopilotInference` uses local mock output instead of the Copilot proxy. */
export function useMockCopilotEnabled(): boolean {
  return vscode.workspace.getConfiguration("codeReview").get<boolean>("useMockCopilot") === true;
}

type MockKind = "review" | "fix" | "gate" | "assistant";

function inferMockKind(systemRole?: string): MockKind {
  const s = systemRole ?? "";
  if (s.includes("relevance gate")) {
    return "gate";
  }
  if (s.includes("You apply a single code-review suggestion")) {
    return "fix";
  }
  if (s.startsWith("Respond with only a valid JSON object")) {
    return "review";
  }
  return "assistant";
}

function extractCurrentFileFromFixPrompt(prompt: string): string | undefined {
  const m = /Current file:\s*\r?\n```\s*\r?\n([\s\S]*?)```/m.exec(prompt);
  return m?.[1];
}

function emitSseCompletion(content: string, onLog: (data: string) => void): void {
  const line = JSON.stringify({
    choices: [{ message: { content } }],
  });
  onLog(`data: ${line}`);
}

/** Simulates SSE token streaming (`delta.content`) so the Genie webview updates incrementally. */
async function emitSseDeltaStream(content: string, onLog: (data: string) => void): Promise<void> {
  const chunks = content.match(/[^\n]*\n?|[^\n]+$/g) ?? [content];
  for (const piece of chunks) {
    if (!piece) continue;
    const line = JSON.stringify({
      choices: [{ delta: { content: piece } }],
    });
    onLog(`data: ${line}`);
    await new Promise((r) => setTimeout(r, 18));
  }
}

/** Matches `REVIEW_SEQUENCE` / labels in `codeReview.ts` — one distinct mock finding per stage. */
const MOCK_REVIEW_STAGE_LABELS = [
  "Quality",
  "Security",
  "Performance",
  "Syntax",
  "Cloud Violations",
  "Org Standards",
  "CK Design",
  "BigQuery Rules",
  "Commit Review",
];

let mockReviewStageCall = 0;

let mockFixStepCall = 0;

/** Reset with each new Code Review run (`resetMockReviewStage`). */
export function resetMockFixStep(): void {
  mockFixStepCall = 0;
}

export function resetMockReviewStage(): void {
  mockReviewStageCall = 0;
  resetMockFixStep();
}

function mockReviewBody(): string {
  mockReviewStageCall += 1;
  const label = MOCK_REVIEW_STAGE_LABELS[mockReviewStageCall - 1] ?? `Stage ${mockReviewStageCall}`;
  return JSON.stringify({
    summary: `Mock ${label} review (disable codeReview.useMockCopilot for live Copilot).`,
    findings: [
      {
        severity: "medium",
        category: "sample",
        title: `${label}: sample finding (mock)`,
        detail: `Placeholder for ${label} in mock mode.`,
        suggestion: "// Mock: replace with model output when mock is off.",
      },
    ],
  });
}

/**
 * Returns a slightly modified file so each fix has a real diff (preview + scroll-to-highlight work).
 * Without this, every mock fix echoed the same buffer and sequential “one by one” flows looked broken.
 */
function mockFixBody(prompt: string): string {
  const file = extractCurrentFileFromFixPrompt(prompt) ?? "";
  mockFixStepCall += 1;
  const base = file.replace(/\r\n/g, "\n");
  const nl = base.endsWith("\n") || base.length === 0 ? "" : "\n";
  const marker = `${nl}// [code-review mock] fix step ${mockFixStepCall}\n`;
  return JSON.stringify({ fileContent: base + marker });
}

/** Extra-instruction relevance gate (include `MOCK_GATE_IRRELEVANT` in the instruction to simulate off-topic). */
function mockGateBody(prompt: string): string {
  if (/MOCK_GATE_IRRELEVANT/i.test(prompt)) {
    return JSON.stringify({
      relevant: false,
      briefReason: "Mock: instruction marked unrelated (MOCK_GATE_IRRELEVANT).",
    });
  }
  return JSON.stringify({ relevant: true });
}

function mockAssistantBody(prompt: string): string {
  const looksLikeRefactorPrompt =
    /code refactoring assistant/i.test(prompt) ||
    prompt.includes("refactoredCode") ||
    prompt.includes("suggestedChanges");
  if (looksLikeRefactorPrompt) {
    let code = "// mock";
    const m = /<code>\s*([\s\S]*?)<\/code>/i.exec(prompt);
    if (m?.[1]?.trim()) {
      code = m[1].trim();
    }
    // Two edit regions so editor preview shows multiple Accept/Reject blocks (diff hunks).
    const refactoredCode =
      code +
      "\n\n// [mock] extracted helper — block 2\nfunction __mockRefactorChunk2() {\n  return 42;\n}\n";
    return [
      "### Mock refactor response",
      "",
      "Streaming plain-text mode is active (mock).",
      "Use real Copilot by disabling `codeReview.useMockCopilot`.",
      "",
      "```ts",
      refactoredCode,
      "```",
    ].join("\n");
  }
  return [
    "### Mock assistant response",
    "",
    "Streaming plain-text mode is active (mock).",
    "Open Settings and disable `codeReview.useMockCopilot` to use live Copilot output.",
  ].join("\n");
}

/**
 * Simulates one Copilot completion: same `data: {...}` shape the Python proxy streams.
 * Does not require Python or network.
 */
export async function runMockCopilotInference(
  prompt: string,
  onLog: (data: string) => void,
  options?: { systemRole?: string; stream?: boolean }
): Promise<void> {
  await Promise.resolve();
  onLog(">>> Mock Copilot — no Python proxy, no network.");

  const kind = inferMockKind(options?.systemRole);
  let content: string;
  switch (kind) {
    case "review":
      content = mockReviewBody();
      break;
    case "fix":
      content = mockFixBody(prompt);
      break;
    case "gate":
      content = mockGateBody(prompt);
      break;
    default:
      content = mockAssistantBody(prompt);
      break;
  }

  if (options?.stream === false) {
    emitSseCompletion(content, onLog);
    return;
  }
  await emitSseDeltaStream(content, onLog);
}
