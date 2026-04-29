import * as vscode from "vscode";
import type { CopilotInferenceOptions } from "./pythonRunner";

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
async function emitSseDeltaStream(content: string, onLog: (data: string) => void, delayMs = 18): Promise<void> {
  const chunks = content.match(/[^\n]*\n?|[^\n]+$/g) ?? [content];
  for (const piece of chunks) {
    if (!piece) continue;
    const line = JSON.stringify({
      choices: [{ delta: { content: piece } }],
    });
    onLog(`data: ${line}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Emit a tool_event SSE line identical to what python/agents/streaming.py sends. */
function emitMockToolEvent(
  onLog: (data: string) => void,
  evt: { type: "call" | "result"; name: string; icon: string; message: string; preview?: string }
): void {
  const line = JSON.stringify({ tool_event: evt });
  onLog(`data: ${line}`);
}

/** A short scripted tool-use sequence per review type, mirroring the real agent's behavior. */
type MockToolStep = { name: string; icon: string; callMsg: string; resultMsg: string };

const MOCK_TOOL_SCRIPTS: Record<string, MockToolStep[]> = {
  quality: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for repeated patterns", resultMsg: "3 matches; first: src/utils/sample.ts:14" },
    { name: "mcp_lint_check", icon: "🔧", callMsg: "MCP Linter is checking the active file", resultMsg: "2 warnings: unused-var, no-console" },
    { name: "mcp_sonar_check", icon: "📊", callMsg: "MCP SonarQube-style rules checking the active file", resultMsg: "1 finding: S1541 (cognitive complexity)" },
    { name: "find_similar_patterns", icon: "🧩", callMsg: "Finding similar function shapes in the repo", resultMsg: "2 similar functions found" },
  ],
  security: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for secret/API-key patterns", resultMsg: "no matches" },
    { name: "semgrep_scan", icon: "🛡️", callMsg: "MCP Semgrep scanning the active file with ruleset 'auto'", resultMsg: "no semgrep findings" },
    { name: "mcp_lint_check", icon: "🔧", callMsg: "MCP Linter is checking the active file", resultMsg: "no issues" },
    { name: "get_git_blame", icon: "🔎", callMsg: "Checking git blame for the modified region", resultMsg: "last touched 2026-04-21 by you" },
  ],
  performance: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for hot-path callers", resultMsg: "4 callers found" },
    { name: "list_imports_and_usages", icon: "🔗", callMsg: "Tracing imports and usages of key symbols", resultMsg: "imported in 2 files" },
    { name: "get_recent_commits", icon: "📜", callMsg: "Reviewing recent commits touching this file", resultMsg: "5 commits in last 30 days" },
    { name: "mcp_sonar_check", icon: "📊", callMsg: "MCP SonarQube-style rules checking the active file", resultMsg: "0 findings" },
  ],
  syntax: [
    { name: "mcp_lint_check", icon: "🔧", callMsg: "MCP Linter is checking the active file", resultMsg: "0 issues" },
    { name: "read_file", icon: "📖", callMsg: "Reading the full file for syntactic context", resultMsg: "200 lines read" },
  ],
  cloud: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for cloud SDK imports", resultMsg: "2 imports of aws-sdk" },
    { name: "list_imports_and_usages", icon: "🔗", callMsg: "Tracing cloud-client usage across the repo", resultMsg: "used in 3 files" },
  ],
  orgStd: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for organisational conventions", resultMsg: "5 reference files" },
    { name: "find_similar_patterns", icon: "🧩", callMsg: "Finding similar implementations in sibling modules", resultMsg: "3 similar patterns" },
    { name: "mcp_sonar_check", icon: "📊", callMsg: "MCP SonarQube-style rules checking the active file", resultMsg: "1 finding: S117 (short name)" },
  ],
  ckDesign: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for CK design references", resultMsg: "2 matches" },
    { name: "find_similar_patterns", icon: "🧩", callMsg: "Finding reference CK designs", resultMsg: "1 related component" },
    { name: "mcp_sonar_check", icon: "📊", callMsg: "MCP SonarQube-style rules checking the active file", resultMsg: "0 findings" },
  ],
  bigquery: [
    { name: "grep_codebase", icon: "🔍", callMsg: "Searching codebase for BigQuery dataset usage", resultMsg: "no matches" },
    { name: "read_file", icon: "📖", callMsg: "Reading the active file for BigQuery contexts", resultMsg: "200 lines read" },
  ],
};

async function emitMockToolActivity(
  reviewType: string | undefined,
  onLog: (data: string) => void
): Promise<void> {
  const steps = (reviewType && MOCK_TOOL_SCRIPTS[reviewType]) || MOCK_TOOL_SCRIPTS.quality;
  for (const s of steps) {
    emitMockToolEvent(onLog, { type: "call", name: s.name, icon: s.icon, message: s.callMsg });
    await new Promise((r) => setTimeout(r, 350));
    emitMockToolEvent(onLog, { type: "result", name: s.name, icon: "↳", message: s.resultMsg });
    await new Promise((r) => setTimeout(r, 180));
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
 * When agentMode is on for a review, also emits `tool_event` SSE lines with the same
 * icon + message fields the real Python agent emits — so the webview renders the
 * Claude-style tool-use activity identically to the live path.
 */
export async function runMockCopilotInference(
  prompt: string,
  onLog: (data: string) => void,
  options?: CopilotInferenceOptions
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

  if (kind === "review" && options?.agentMode) {
    await emitMockToolActivity(options.reviewType, onLog);
  }

  if (options?.stream === false) {
    emitSseCompletion(content, onLog);
    return;
  }
  await emitSseDeltaStream(content, onLog);
}
