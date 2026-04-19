import { createHash } from "node:crypto";

/** Stable fingerprint for comparing editor buffer with the snapshot from the last completed review. */
export function hashDocumentText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
