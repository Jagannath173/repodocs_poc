import * as vscode from "vscode";
import { getOrCreateGeniePanel } from "./genieHost";
import { buildGeniePanelHtml } from "./genieDocument";
import { getNonce } from "./genieNonce";
import type { GenieCommand } from "./genieMessages";

/**
 * Singleton mediator for the shared Genie `WebviewPanel`.
 * Routes webview messages to VS Code commands and per-session callbacks (command → action bridge).
 */
export class GeniePanelHost {
  private static instance: GeniePanelHost | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly messageDisposables: vscode.Disposable[] = [];
  private readonly listeners = new Map<
    string,
    {
      apply: Set<() => void>;
      refine: Set<() => void>;
      fixDecision: Set<(value: "accept" | "reject") => void>;
      messages: Set<(msg: unknown) => void>;
    }
  >();

  private constructor(context: vscode.ExtensionContext) {
    this.panel = getOrCreateGeniePanel("genie", "genieHost", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    });
    const nonce = getNonce();
    this.panel.webview.html = buildGeniePanelHtml(this.panel.webview, context.extensionUri, nonce);
    this.messageDisposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { command?: GenieCommand; sessionId?: string; value?: string | "accept" | "reject" }) => {
        if (msg?.command === "applyFixes") {
          const m = msg as {
            mode?: string;
            index?: number;
            indices?: number[];
            sessionId?: string;
            /** Set by the in-panel composer when applying with extra developer instructions (skips VS Code input box). */
            extraInstructions?: string;
          };
          const mode = m.mode === "one" || m.mode === "selected" ? m.mode : "all";
          const idx = typeof m.index === "number" ? m.index : undefined;
          const selectedIndices = Array.isArray(m.indices) ? m.indices.filter((n) => typeof n === "number") : undefined;
          const extraPassThrough =
            typeof m.extraInstructions === "string" ? m.extraInstructions : "";
          const sid = typeof m.sessionId === "string" ? m.sessionId : undefined;
          const clearRowSpinner = () => {
            if (sid) {
              void this.panel.webview.postMessage({ type: "fixApplying", sessionId: sid, index: null });
            }
          };
          void vscode.commands
            .executeCommand("codeReview.applyFixes", mode, idx, extraPassThrough, selectedIndices)
            .then(clearRowSpinner, clearRowSpinner);
          return;
        }
        if (msg?.command === "analyzeExtraInstruction") {
          const text =
            typeof (msg as { extraInstructions?: string }).extraInstructions === "string"
              ? (msg as { extraInstructions: string }).extraInstructions
              : "";
          void vscode.commands.executeCommand("codeReview.analyzeExtraInstruction", text);
          return;
        }
        if (msg?.command === "rejectFinding") {
          const idx = typeof (msg as { index?: number }).index === "number" ? (msg as { index: number }).index : undefined;
          if (idx !== undefined) {
            void vscode.commands.executeCommand("codeReview.rejectFinding", idx);
          }
          return;
        }
        if (msg?.command === "authenticate") {
          void vscode.commands.executeCommand("codeReview.authenticate");
          return;
        }
        if (msg?.command === "exportReviewReport") {
          const m = msg as { format?: string };
          const fmt = m.format === "xlsx" ? "xlsx" : "pdf";
          void vscode.commands.executeCommand("codeReview.exportReviewReport", fmt);
          return;
        }
        const sessionId = msg?.sessionId;
        if (!sessionId) {
          return;
        }
        if (msg.command === "copyText" && typeof msg.value === "string") {
          void vscode.env.clipboard.writeText(msg.value);
          return;
        }
        if (msg.command === "closeSession") {
          const target = this.listeners.get(sessionId);
          if (target) {
            target.messages.forEach((handler) => handler(msg));
          }
          if (this.listeners.size <= 1) {
            this.panel.dispose();
          } else {
            this.listeners.delete(sessionId);
          }
          return;
        }
        const target = this.listeners.get(sessionId);
        if (!target) {
          return;
        }
        target.messages.forEach((handler) => handler(msg));
        if (msg.command === "applyCurrent") {
          target.apply.forEach((handler) => handler());
        } else if (msg.command === "refineRequest") {
          target.refine.forEach((handler) => handler());
        } else if (msg.command === "fixDecision") {
          const decision = msg.value;
          if (decision === "accept" || decision === "reject") {
            target.fixDecision.forEach((handler) => handler(decision));
          }
        }
      })
    );
    this.panel.onDidDispose(() => {
      this.messageDisposables.forEach((d) => d.dispose());
      this.listeners.clear();
      GeniePanelHost.instance = undefined;
    });
  }

  static getOrCreate(context: vscode.ExtensionContext): GeniePanelHost {
    if (!GeniePanelHost.instance) {
      GeniePanelHost.instance = new GeniePanelHost(context);
    } else {
      GeniePanelHost.instance.panel.reveal(vscode.ViewColumn.Beside, false);
    }
    return GeniePanelHost.instance;
  }

  createSession(sessionId: string, title: string): void {
    this.listeners.set(sessionId, { apply: new Set(), refine: new Set(), fixDecision: new Set(), messages: new Set() });
    void this.postMessage({ type: "createSession", sessionId, title });
  }

  hasSession(sessionId: string): boolean {
    return this.listeners.has(sessionId);
  }

  onApplyRequested(sessionId: string, handler: () => void): vscode.Disposable {
    const session = this.listeners.get(sessionId);
    if (!session) {
      return new vscode.Disposable(() => undefined);
    }
    session.apply.add(handler);
    return new vscode.Disposable(() => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.apply.delete(handler);
      this.cleanupSession(sessionId);
    });
  }

  onRefineRequested(sessionId: string, handler: () => void): vscode.Disposable {
    const session = this.listeners.get(sessionId);
    if (!session) {
      return new vscode.Disposable(() => undefined);
    }
    session.refine.add(handler);
    return new vscode.Disposable(() => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.refine.delete(handler);
      this.cleanupSession(sessionId);
    });
  }

  onFixDecisionRequested(sessionId: string, handler: (value: "accept" | "reject") => void): vscode.Disposable {
    const session = this.listeners.get(sessionId);
    if (!session) {
      return new vscode.Disposable(() => undefined);
    }
    session.fixDecision.add(handler);
    return new vscode.Disposable(() => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.fixDecision.delete(handler);
      this.cleanupSession(sessionId);
    });
  }

  onMessage(sessionId: string, handler: (msg: unknown) => void): vscode.Disposable {
    const session = this.listeners.get(sessionId);
    if (!session) {
      return new vscode.Disposable(() => undefined);
    }
    session.messages.add(handler);
    return new vscode.Disposable(() => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.messages.delete(handler);
      this.cleanupSession(sessionId);
    });
  }

  postMessage(message: Record<string, unknown>): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, false);
  }

  closeSession(sessionId: string): void {
    if (this.listeners.size <= 1) {
      this.panel.dispose();
      return;
    }
    this.listeners.delete(sessionId);
    void this.postMessage({ type: "closeSession", sessionId });
  }

  private cleanupSession(sessionId: string): void {
    const s = this.listeners.get(sessionId);
    if (!s) return;
    if (!s.apply.size && !s.refine.size && !s.fixDecision.size && !s.messages.size) {
      this.listeners.delete(sessionId);
    }
  }
}
