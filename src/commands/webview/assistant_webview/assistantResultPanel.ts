import * as vscode from "vscode";
import type { AssistantRenderPayload } from "../../assistant/assistantTypes";
import { GeniePanelHost } from "./geniePanelHost";

/**
 * Facade for one assistant session in the Genie webview.
 * Action code (`actions/runAssistantEndpoint`, `reviewPanel`, `authPanel`) uses this, not raw HTML.
 */
export class AssistantResultPanel {
  private readonly host: GeniePanelHost;
  private readonly sessionId: string;

  constructor(context: vscode.ExtensionContext, title: string, stableSessionKey?: string) {
    this.host = GeniePanelHost.getOrCreate(context);
    const normalizedKey = stableSessionKey?.trim();
    this.sessionId = normalizedKey
      ? `stable:${normalizedKey.replace(/[^a-zA-Z0-9:_-]/g, "_")}`
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.host.createSession(this.sessionId, title);
  }

  setStatus(text: string): void {
    void this.host.postMessage({ type: "status", sessionId: this.sessionId, text });
  }

  setBusy(value: boolean): void {
    void this.host.postMessage({ type: "busy", sessionId: this.sessionId, value });
  }

  setProgressStep(text: string): void {
    void this.host.postMessage({ type: "step", sessionId: this.sessionId, text });
  }

  setStreamText(text: string): void {
    void this.host.postMessage({ type: "stream", sessionId: this.sessionId, text });
  }

  setStreamLive(value: boolean): void {
    void this.host.postMessage({ type: "streamLive", sessionId: this.sessionId, value });
  }

  setMode(endpoint: string): void {
    void this.host.postMessage({ type: "mode", sessionId: this.sessionId, endpoint });
  }

  setUserQuestion(text: string): void {
    void this.host.postMessage({ type: "userQuestion", sessionId: this.sessionId, text });
  }

  setAuthData(url: string, code: string): void {
    void this.host.postMessage({ type: "authData", sessionId: this.sessionId, url, code });
  }

  setResult(payload: AssistantRenderPayload): void {
    const apply = payload.applyCode?.trim() ?? "";
    void this.host.postMessage({
      type: "result",
      sessionId: this.sessionId,
      remarks: payload.remarks,
      displayText: payload.displayText,
      jsonText: payload.jsonText ?? payload.displayText,
      structuredData: payload.structuredData,
      reviewMode: Boolean(payload.reviewMode),
      diffParts: payload.diffParts ?? [],
      endpoint: payload.endpoint,
      hasCode: Boolean(apply),
      generatedCode: payload.endpoint === "codeGeneration" ? apply : "",
      refactorCode: payload.endpoint === "codeRefactor" ? apply : "",
      codeGenDelivery: payload.codeGenDelivery ?? "",
      newFileRelativePath: payload.newFileRelativePath ?? "",
      generatedFiles: payload.generatedFiles ?? [],
    });
  }

  setError(text: string): void {
    void this.host.postMessage({ type: "error", sessionId: this.sessionId, text });
  }

  onApplyRequested(handler: () => void): vscode.Disposable {
    return this.host.onApplyRequested(this.sessionId, handler);
  }

  onFixDecisionRequested(handler: (value: "accept" | "reject") => void): vscode.Disposable {
    return this.host.onFixDecisionRequested(this.sessionId, handler);
  }

  onRefineRequested(handler: () => void): vscode.Disposable {
    return this.host.onRefineRequested(this.sessionId, handler);
  }

  onMessage(handler: (msg: unknown) => void): vscode.Disposable {
    return this.host.onMessage(this.sessionId, handler);
  }

  reveal(): void {
    this.host.reveal();
  }

  close(): void {
    this.host.closeSession(this.sessionId);
  }

  setApplyingFixIndex(index: number | null): void {
    void this.host.postMessage({ type: "fixApplying", sessionId: this.sessionId, index });
  }

  setApplyingFixAll(value: boolean): void {
    void this.host.postMessage({ type: "fixApplyingAll", sessionId: this.sessionId, value });
  }
}
