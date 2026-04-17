/**
 * Drop review findings whose suggested fix (or fenced code in detail) already appears
 * in the current file, so the Genie table only lists actionable changes.
 */

function normalizeForCompare(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

/**
 * Returns true if `text` is long enough and a stable prefix already exists in the file
 * (normalized whitespace), so it should not be reported as a needed fix.
 */
export function isSuggestionAlreadyInFile(fileText: string, suggestion: string): boolean {
  const raw = (suggestion || "").trim();
  if (raw.length < 24) {
    return false;
  }
  const sNorm = normalizeForCompare(raw);
  if (sNorm.length < 32) {
    return false;
  }
  const fNorm = normalizeForCompare(fileText);
  const needleLen = Math.min(260, sNorm.length);
  const needle = sNorm.slice(0, needleLen);
  return fNorm.includes(needle);
}

/** Extract ```fenced``` code blocks from review detail text. */
function codeBlocksFromDetail(detail: string): string[] {
  const out: string[] = [];
  const fence = /```(?:[\w-]+)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(detail)) !== null) {
    const block = m[1].trim();
    if (block.length >= 20) {
      out.push(block);
    }
  }
  return out;
}

export type ReviewFindingLike = { suggestion?: string; detail?: string };

/**
 * True if this finding does not need a code change relative to the current file
 * (suggestion already present, or fenced code in detail already present).
 */
export function isFindingAlreadySatisfiedByFile(fileText: string, finding: ReviewFindingLike): boolean {
  if (isSuggestionAlreadyInFile(fileText, finding.suggestion || "")) {
    return true;
  }
  const detail = finding.detail || "";
  for (const block of codeBlocksFromDetail(detail)) {
    if (isSuggestionAlreadyInFile(fileText, block)) {
      return true;
    }
  }
  return false;
}
