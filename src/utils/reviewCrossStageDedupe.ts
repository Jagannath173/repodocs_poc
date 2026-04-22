import type { ReviewFinding } from "../commands/webview/review_Webview/reviewPanel";

function normalizeKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 900);
}

/**
 * Fingerprint of the "bad" code the model identified (Cloud / Org / Security often
 * re-report the same line). Used with normalized suggestion to drop cross-stage duplicates.
 */
export function extractIdentifiedCodeFingerprint(detail: string): string {
  const d = detail.replace(/\r\n/g, "\n");
  const afterCodeLabel = /(?:^|\n)\s*Code:\s*\n?([\s\S]*?)(?:\n\n|$)/i.exec(d);
  if (afterCodeLabel) {
    return normalizeKeyPart(afterCodeLabel[1]);
  }
  const inline = /Code:\s*`([^`]+)`/i.exec(d);
  if (inline) {
    return normalizeKeyPart(inline[1]);
  }
  const hits: string[] = [];
  const bt = /`([^`\n]{10,})`/g;
  let m: RegExpExecArray | null;
  while ((m = bt.exec(d)) !== null) {
    hits.push(m[1]);
  }
  if (hits.length) {
    return normalizeKeyPart(hits.join("|"));
  }
  return normalizeKeyPart(d.slice(0, 240));
}

/** Same underlying defect + same remedial change → one row across review suite stages. */
export function makeCrossStageDedupeKey(finding: ReviewFinding): string {
  const sug = normalizeKeyPart(finding.suggestion || "");
  const codeFp = extractIdentifiedCodeFingerprint(finding.detail || "");
  return `${sug}|${codeFp}`;
}
