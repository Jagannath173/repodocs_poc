import type { AppliedFixRecord, ReviewTableState } from "../commands/webview/review_Webview/reviewPanel";

export function basenameFromUriString(uriStr: string | undefined): string {
  if (!uriStr || typeof uriStr !== "string") {
    return "file";
  }
  const cleaned = uriStr.replace(/^file:\/\//, "").replace(/\\/g, "/");
  const parts = cleaned.split("/");
  const last = parts[parts.length - 1]?.trim();
  return last || "file";
}

/**
 * Sample rows + small unified diffs so Genie and exports never look empty before real fixes are recorded.
 */
export function buildDemoAppliedFixRecords(fileName: string): AppliedFixRecord[] {
  const ts = new Date().toISOString();
  const safeName = fileName.replace(/[<>"|?*]/g, "_");
  return [
    {
      findingIndex: 0,
      title: "[Sample] Guard optional access",
      detail: "A nested property may be undefined; the current path can throw at runtime.",
      suggestion: "Use optional chaining or an early return when the parent object is missing.",
      severity: "medium",
      category: "quality",
      isDemo: true,
      appliedAt: ts,
      unifiedDiff: [
        `--- ${safeName} (before)`,
        `+++ ${safeName} (after)`,
        `@@ -1,4 +1,4 @@`,
        ` function load(cfg) {`,
        `-  return cfg.settings.theme.color;`,
        `+  return cfg?.settings?.theme?.color ?? "default";`,
        ` }`,
      ].join("\n"),
    },
    {
      findingIndex: 1,
      title: "[Sample] Log failures",
      detail: "Errors in this path are ignored, which makes production issues hard to trace.",
      suggestion: "Log the error (or rethrow) in the catch block.",
      severity: "low",
      category: "reliability",
      isDemo: true,
      appliedAt: ts,
      unifiedDiff: [
        `--- ${safeName} (before)`,
        `+++ ${safeName} (after)`,
        `@@ -12,3 +12,4 @@`,
        `   } catch (e) {`,
        `+    console.error("${safeName}: failed", e);`,
        `     return null;`,
        `   }`,
      ].join("\n"),
    },
  ];
}

export function resolveAppliedFixRecordsForUi(
  real: AppliedFixRecord[] | undefined,
  fileName: string
): { records: AppliedFixRecord[]; usingDemo: boolean } {
  if (Array.isArray(real) && real.length > 0) {
    return { records: real, usingDemo: false };
  }
  return { records: buildDemoAppliedFixRecords(fileName), usingDemo: true };
}

/** Same resolution for workspace export (PDF/Excel) when stored state has no records yet. */
export function getEffectiveRecordsForExport(stored: ReviewTableState): {
  records: AppliedFixRecord[];
  usingDemo: boolean;
} {
  return resolveAppliedFixRecordsForUi(stored.appliedFixRecords, stored.fileName || "file");
}
