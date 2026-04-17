import * as vscode from "vscode";

/** When true, `runCopilotInference` uses local mock output instead of the Copilot proxy. */
export function useMockCopilotEnabled(): boolean {
  return vscode.workspace.getConfiguration("codeReview").get<boolean>("useMockCopilot") === true;
}

type MockKind = "review" | "fix" | "assistant";

function inferMockKind(systemRole?: string): MockKind {
  const s = systemRole ?? "";
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

export function resetMockReviewStage(): void {
  mockReviewStageCall = 0;
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

/** Echo file unchanged so preview has no diff and applies immediately (no banner lines in the editor). */
function mockFixBody(prompt: string): string {
  const file = extractCurrentFileFromFixPrompt(prompt) ?? "";
  return JSON.stringify({ fileContent: file });
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
    return JSON.stringify({
      quality: "good",
      remarks: "Mock refactor (codeReview.useMockCopilot is enabled).",
      summary: "Test output — real Copilot returns richer JSON.",
      details: "Disable mock in Settings for live refactors.",
      suggestedChanges: [
        {
          area: "mock",
          issue: "Local testing only",
          suggestion: "Use real API for production-quality refactors.",
          benefit: "Matches your codebase conventions",
        },
      ],
      risks: [],
      validationChecklist: ["Run your test suite after applying"],
      refactoredCode: code,
    });
  }
  return JSON.stringify({
    remarks: "Mock assistant response (codeReview.useMockCopilot is enabled).",
    details:
      "Open Settings, search for `codeReview.useMockCopilot`, and uncheck it (or remove the key) to use the real Copilot API.",
  });
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
    default:
      content = mockAssistantBody(prompt);
      break;
  }

  emitSseCompletion(content, onLog);
}
