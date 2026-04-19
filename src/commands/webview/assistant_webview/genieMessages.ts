/** Messages from Genie webview → extension host (`GeniePanelHost`). */
export type GenieCommand =
  | "applyCurrent"
  | "fixDecision"
  | "refineRequest"
  | "closeSession"
  | "copyText"
  | "applyFixes"
  | "authenticate"
  | "submitPrompt";
