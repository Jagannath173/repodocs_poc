/**
 * Genie webview layer: document assembly, panel host, session facade, message types.
 * Webview shell assets live under `media/genie/` at the repo root (`panel.html`, `panel.css`, `panel.js`).
 */
export type { GenieCommand } from "./genieMessages";
export { buildGeniePanelHtml } from "./genieDocument";
export { GeniePanelHost } from "./geniePanelHost";
export { AssistantResultPanel } from "./assistantResultPanel";
