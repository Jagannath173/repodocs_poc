/**
 * Parsed assistant model output passed from action layer into the Genie webview.
 */
export interface AssistantRenderPayload {
  remarks: string;
  displayText: string;
  jsonText?: string;
  structuredData?: Record<string, unknown>;
  reviewMode?: boolean;
  diffParts?: Array<{ kind: "add" | "remove" | "same"; text: string }>;
  endpoint?: string;
  applyCode?: string;
  /** Code generation only: whether to edit the open buffer or create a new file. */
  codeGenDelivery?: "modifyCurrent" | "newFile";
  /** Code generation + newFile: path relative to workspace root. */
  newFileRelativePath?: string;
  /** Code generation only: optional list when multiple files are generated. */
  generatedFiles?: Array<{ relativePath: string; code: string }>;
}