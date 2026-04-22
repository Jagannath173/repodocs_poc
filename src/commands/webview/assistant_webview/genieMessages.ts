/** Messages from Genie webview → extension host (`GeniePanelHost`). */
export type GenieCommand =
  | "applyCurrent"
  | "fixDecision"
  | "refineRequest"
  | "closeSession"
  | "copyText"
  | "applyFixes"
  | "analyzeExtraInstruction"
  | "rejectFinding"
  | "authenticate"
  | "submitPrompt"
  | "exportReviewReport"
  | "openReviewReportTab"
  | "showInfoToast";
