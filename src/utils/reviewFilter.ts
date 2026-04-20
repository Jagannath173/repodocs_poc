/**
 * Drop review findings whose suggested fix (or fenced code in detail) already appears
 * in the current file, so the Genie table only lists actionable changes.
 */

function normalizeForCompare(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLineForCompare(line: string): string {
  return line
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractBacktickSpans(text: string): string[] {
  const spans: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = (m[1] || "").trim();
    if (v.length >= 10) {
      spans.push(v);
    }
  }
  return spans;
}

/**
 * Returns true if `text` is long enough and a stable prefix already exists in the file
 * (normalized whitespace), so it should not be reported as a needed fix.
 */
export function isSuggestionAlreadyInFile(fileText: string, suggestion: string): boolean {
  const raw = (suggestion || "").trim();
  if (raw.length < 10) {
    return false;
  }
  const sNorm = normalizeForCompare(raw);
  if (sNorm.length < 16) {
    return false;
  }
  const fNorm = normalizeForCompare(fileText);
  const needleLen = Math.min(220, sNorm.length);
  const needle = sNorm.slice(0, needleLen);
  if (needle.length >= 24 && fNorm.includes(needle)) {
    return true;
  }

  const candidates: string[] = [];
  const lines = raw.split(/\r?\n/).map(normalizeLineForCompare);
  for (const line of lines) {
    if (line.length >= 14) {
      candidates.push(line);
    }
  }
  for (const block of codeBlocksFromDetail(raw)) {
    const b = normalizeForCompare(block);
    if (b.length >= 14) {
      candidates.push(b);
    }
  }
  for (const span of extractBacktickSpans(raw)) {
    const b = normalizeForCompare(span);
    if (b.length >= 14) {
      candidates.push(b);
    }
  }

  let matched = 0;
  for (const c of candidates) {
    if (fNorm.includes(c)) {
      if (c.length >= 40) {
        return true;
      }
      matched += 1;
      if (matched >= 2) {
        return true;
      }
    }
  }
  return false;
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
