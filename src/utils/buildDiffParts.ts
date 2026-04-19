import { diffLines } from "diff";

/** Serialize `diff` output for Genie webview (`renderDiff`) — same shape as refactor preview. */
export function buildDiffParts(before: string, after: string): Array<{ kind: "add" | "remove" | "same"; text: string }> {
  const parts = diffLines(before, after);
  const serialized: Array<{ kind: "add" | "remove" | "same"; text: string }> = [];
  for (const p of parts) {
    const kind: "add" | "remove" | "same" = p.added ? "add" : p.removed ? "remove" : "same";
    const lines = p.value.split(/\r?\n/);
    const last = lines.length - 1;
    for (let i = 0; i <= last; i++) {
      const segment = i < last ? `${lines[i]}\n` : lines[i];
      const prefix = kind === "add" ? "+ " : kind === "remove" ? "- " : "  ";
      serialized.push({ kind, text: prefix + segment });
    }
  }
  return serialized;
}
