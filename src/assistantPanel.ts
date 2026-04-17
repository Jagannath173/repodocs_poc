import * as vscode from "vscode";
import { getOrCreateGeniePanel } from "./genieHost";
import { buildWebviewCsp } from "./webviewCsp";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function panelHtml(webview: vscode.Webview, nonce: string): string {
  const csp = buildWebviewCsp(webview, nonce);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    :root { color-scheme: light dark; }
    html, body {
      min-height: 100%;
      margin: 0;
      background-color: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #cccccc);
    }
    html { max-width: 100%; }
    body {
      padding: 16px 20px 28px;
      font-family: var(--vscode-font-family);
      overflow-x: hidden;
      overflow-y: auto;
      min-width: 0;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
    }
    h1 { margin: 0 0 10px; font-size: 1.15em; }
    .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; min-height: 20px; }
    .status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .wave { display: none; width: 44px; height: 8px; align-items: flex-end; gap: 2px; }
    .wave span { display: block; width: 6px; height: 100%; border-radius: 3px; background: var(--vscode-progressBar-background, #0e70c0); animation: wavePulse 0.9s ease-in-out infinite; }
    .wave span:nth-child(2) { animation-delay: 0.12s; }
    .wave span:nth-child(3) { animation-delay: 0.24s; }
    .wave span:nth-child(4) { animation-delay: 0.36s; }
    .busy .wave { display: inline-flex; }
    @keyframes wavePulse { 0%, 100% { transform: scaleY(0.35); opacity: 0.55; } 50% { transform: scaleY(1); opacity: 1; } }
    .panel { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
    .head { padding: 8px 12px; font-size: 0.8em; text-transform: uppercase; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .meta { margin-bottom: 10px; }
    .remarks { padding: 10px 12px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; border: 1px solid var(--vscode-editorWidget-border); white-space: pre-wrap; }
    .user-question {
      margin-bottom: 14px;
      padding: 12px 14px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      border-left: 3px solid var(--vscode-textLink-foreground);
    }
    .user-question .user-question-body {
      font-size: 0.92em;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .actions-shell {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
    }
    .actions-shell-head {
      padding: 8px 12px;
      font-size: 0.8em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .actions.in-shell { padding: 10px 12px; margin-bottom: 0; }
    .actions.align-right { justify-content: flex-end; }
    #btn-apply.is-applying {
      cursor: wait;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .prompt-box {
      margin-bottom: 12px;
      padding: 12px 14px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
    }
    .prompt-label {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    .prompt-input-row { display: flex; gap: 8px; align-items: stretch; }
    .prompt-send-icon {
      min-width: 38px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border));
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 10px;
      font-size: 1.05em;
      line-height: 1;
    }
    .prompt-send-icon:hover { filter: brightness(1.06); }
    .prompt-send-icon:disabled { opacity: 0.55; cursor: default; filter: none; }
    textarea.prompt-input {
      flex: 1;
      min-height: 64px;
      resize: vertical;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 0.92em;
      line-height: 1.35;
      box-sizing: border-box;
    }
    textarea.prompt-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .prompt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .auth-box { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 10px; margin-bottom: 12px; background: var(--vscode-editor-background); }
    .auth-row { margin-bottom: 10px; }
    .auth-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .auth-value-row {
      display: flex;
      align-items: stretch;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background);
      margin-bottom: 6px;
      overflow: hidden;
    }
    .auth-value {
      flex: 1;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .auth-copy-icon {
      min-width: 34px;
      border: none;
      border-left: 1px solid var(--vscode-editorWidget-border);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 0.95em;
      line-height: 1;
      padding: 0 8px;
    }
    .auth-copy-icon:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .auth-wait { font-size: 0.86em; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
    button { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    pre { margin: 0; padding: 12px; max-height: 58vh; overflow: auto; overflow-x: auto; overflow-y: auto; white-space: pre; word-break: normal; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; line-height: 1.45; }
    .content-wrap {
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .section { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; background: var(--vscode-editor-background); }
    .section h3 { margin: 0; padding: 8px 10px; font-size: 0.92em; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editor-inactiveSelectionBackground); }
    .section .body { padding: 10px; white-space: pre-wrap; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
    th, td { border: 1px solid var(--vscode-editorWidget-border); padding: 6px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }
    th { background: var(--vscode-editor-inactiveSelectionBackground); }
    .step-line { padding: 8px 10px; font-size: 0.87em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; margin-bottom: 10px; background: var(--vscode-editor-inactiveSelectionBackground); }
    details.collapse-panel {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 12px;
      background: var(--vscode-editor-background);
    }
    details.collapse-panel > summary {
      padding: 10px 12px;
      cursor: pointer;
      font-size: 0.82em;
      font-weight: 600;
      list-style: none;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom: 1px solid transparent;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .explanation-toggle {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }
    .explanation-toggle button {
      min-width: 26px;
      min-height: 22px;
      padding: 0 6px;
      font-size: 0.82em;
      line-height: 1;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border));
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .explanation-toggle button:hover {
      background: var(--vscode-list-hoverBackground);
    }
    details.collapse-panel[open] > summary { border-bottom-color: var(--vscode-editorWidget-border); }
    details.collapse-panel > summary::-webkit-details-marker { display: none; }
    .stream-wrap.streaming:not([open]) .stream-status::after { content: " (streaming…)"; font-weight: 400; color: var(--vscode-descriptionForeground); }
    .stream-wrap.streaming[open] #stream::after { content: "▋"; opacity: 0.85; margin-left: 2px; animation: streamCaret 1s steps(1, end) infinite; }
    @keyframes streamCaret { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
    #stream {
      margin: 0;
      padding: 10px 12px;
      max-height: 32vh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      line-height: 1.5;
    }
    .diff-wrap { max-height: 44vh; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.84em; line-height: 1.45; background: var(--vscode-editor-background); }
    .diff-line { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; padding: 4px 10px; border-left: 3px solid transparent; }
    .diff-line.del { background: rgba(255, 80, 80, 0.12); border-left-color: var(--vscode-charts-red, #f14c4c); }
    .diff-line.add { background: rgba(80, 200, 120, 0.12); border-left-color: var(--vscode-charts-green, #3fb950); }
    .diff-line.same { background: var(--vscode-editor-background); }
    [data-endpoint="codeRefactor"] .content-wrap { gap: 12px; }
    .refactor-hero {
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 4px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: linear-gradient(135deg, rgba(14, 112, 192, 0.1) 0%, var(--vscode-editor-inactiveSelectionBackground) 48%, var(--vscode-editor-background) 100%);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.14);
    }
    .refactor-hero-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-weight: 600; }
    .refactor-quality { font-size: 0.82em; color: var(--vscode-textLink-foreground); margin-bottom: 8px; }
    .refactor-hero-summary { font-size: 0.95em; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .refactor-body { font-size: 0.88em; line-height: 1.45; color: var(--vscode-descriptionForeground); white-space: pre-wrap; margin-top: 8px; padding-top: 10px; border-top: 1px solid rgba(128, 128, 128, 0.25); }
    .refactor-suggestions { margin: 10px 0 0; padding-left: 18px; font-size: 0.88em; line-height: 1.45; }
    .refactor-suggestions li { margin-bottom: 6px; }
    .refactor-remarks { margin-top: 12px; padding: 10px 12px; font-size: 0.86em; border-radius: 6px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-editorWidget-border); white-space: pre-wrap; word-break: break-word; }
    .refactor-checklist { margin: 8px 0 0; padding-left: 18px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .refactor-code-wrap { margin: 14px 0 18px; }
    .refactor-code-heading {
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 8px;
      font-weight: 600;
    }
    .refactor-code-pre {
      margin: 0;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-textCodeBlock-background);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.84em;
      line-height: 1.45;
      max-height: 52vh;
      overflow: auto;
    }
    #refactor-actions-anchor .actions {
      margin: 0 0 12px;
      padding: 0;
      border: none;
      background: transparent;
      box-shadow: none;
    }
    .generated-picker { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editor-inactiveSelectionBackground); }
    .generated-picker label { font-size: 0.8em; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
    .generated-picker select { flex: 1; min-width: 160px; }
    .generated-code-pre {
      margin: 0;
      padding: 12px;
      max-height: 48vh;
      overflow: auto;
      overflow-x: auto;
      overflow-y: auto;
      white-space: pre;
      word-break: normal;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.84em;
      line-height: 1.45;
      background: var(--vscode-editor-background);
    }
    .hidden { display: none !important; }
    .err { color: var(--vscode-errorForeground); margin-top: 8px; white-space: pre-wrap; }
    .hint.muted { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin: 0 0 10px; line-height: 1.4; }
    .review-complete-card {
      border: 1px solid var(--vscode-editorWidget-border);
      border-left: 4px solid var(--vscode-charts-green, #3fb950);
      border-radius: 8px;
      background:
        linear-gradient(
          135deg,
          rgba(63, 185, 80, 0.14) 0%,
          rgba(63, 185, 80, 0.06) 38%,
          rgba(0, 0, 0, 0) 100%
        ),
        var(--vscode-editor-inactiveSelectionBackground);
      box-shadow:
        0 0 0 1px rgba(63, 185, 80, 0.16),
        0 10px 24px rgba(0, 0, 0, 0.22);
      padding: 14px 16px;
      margin: 8px 0 10px;
      position: relative;
      overflow: hidden;
    }
    .review-complete-card::after {
      content: "";
      position: absolute;
      top: -22px;
      right: -22px;
      width: 86px;
      height: 86px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(63, 185, 80, 0.35) 0%, rgba(63, 185, 80, 0) 72%);
      pointer-events: none;
    }
    .review-complete-title {
      font-size: 1.02em;
      font-weight: 700;
      color: var(--vscode-charts-green, #3fb950);
      margin: 0 0 6px;
      letter-spacing: 0.01em;
      text-shadow: 0 0 10px rgba(63, 185, 80, 0.2);
    }
    .review-complete-sub {
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
      margin: 0;
      opacity: 0.95;
    }
    .review-complete-metrics {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 11px;
    }
    .review-complete-chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.78em;
      font-weight: 600;
      letter-spacing: 0.01em;
      border: 1px solid rgba(63, 185, 80, 0.3);
      background: rgba(63, 185, 80, 0.1);
      color: var(--vscode-foreground);
    }
    .review-complete-only-wrap {
      min-height: 34vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6vh 12px;
      box-sizing: border-box;
    }
    .review-complete-only-wrap .review-complete-card {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
    }
    .review-complete-only-text {
      font-size: 1.05em;
      font-weight: 700;
      color: var(--vscode-charts-green, #3fb950);
      text-align: center;
      letter-spacing: 0.01em;
    }
    #rendered-panel.complete-only {
      border: none;
      background: transparent;
    }
    #rendered-panel.complete-only > summary {
      display: none;
    }
    #rendered-panel.complete-only #out {
      padding: 0;
      gap: 0;
      background: transparent;
    }
    .session-tabs {
      display: flex;
      gap: 6px;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      padding-bottom: 4px;
      margin: 0 0 12px;
    }
    .session-tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 999px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      padding: 2px 4px 2px 10px;
    }
    .session-tab.active {
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .session-tab-label {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 2px 4px;
      font-size: 0.82em;
      cursor: pointer;
      border-radius: 999px;
      white-space: nowrap;
    }
    .session-tab.active .session-tab-label { color: var(--vscode-button-foreground); }
    .session-tab-close {
      min-width: 18px;
      height: 18px;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      padding: 0;
      line-height: 1;
      font-size: 14px;
      cursor: pointer;
    }
    .session-tab.active .session-tab-close { color: var(--vscode-button-foreground); }
    .session-tab-close:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .review-fix-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
    .review-metrics-bar {
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
      margin: -6px 0 14px;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-editorWidget-border);
      line-height: 1.45;
    }
    .review-table-wrap {
      overflow-x: auto;
      margin-bottom: 16px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
    }
    .review-findings-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.86em;
      min-width: 640px;
      table-layout: auto;
    }
    .review-findings-table th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      white-space: nowrap;
      text-align: left;
      vertical-align: bottom;
    }
    .review-findings-table td {
      padding: 8px 10px;
      border: 1px solid var(--vscode-editorWidget-border);
      vertical-align: top;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .review-findings-table tbody tr:nth-child(even) td { background: var(--vscode-editor-inactiveSelectionBackground); }
    .review-status-rejected {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      color: rgba(248, 113, 113, 0.95);
      background: rgba(220, 53, 69, 0.18);
    }
    .review-status-accepted {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      color: rgba(63, 185, 80, 0.95);
      background: rgba(63, 185, 80, 0.18);
    }
    .review-findings-table tr.row-applied td { background: rgba(63, 185, 80, 0.05) !important; }
    .review-findings-table .col-applied-muted {
      color: var(--vscode-descriptionForeground);
    }
    .review-findings-table .col-suggestion-applied-done {
      border-left: 3px solid rgba(63, 185, 80, 0.3) !important;
      background: rgba(63, 185, 80, 0.04) !important;
      color: var(--vscode-descriptionForeground);
    }
    .review-findings-table tr.row-rejected td { background: rgba(220, 53, 69, 0.05) !important; }
    .review-fix-cell-stack {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .review-findings-table .col-suggestion-rejected {
      font-style: normal;
      color: var(--vscode-foreground);
      border-left: 3px solid rgba(220, 53, 69, 0.45) !important;
      background: rgba(220, 53, 69, 0.06) !important;
    }
    .review-findings-table .col-num {
      width: 44px;
      text-align: right;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
      position: sticky;
      left: 0;
      z-index: 2;
      background: var(--vscode-editor-background);
      box-shadow: 2px 0 6px rgba(0, 0, 0, 0.08);
    }
    .review-findings-table thead th.col-num-h {
      position: sticky;
      left: 0;
      z-index: 4;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .review-findings-table .col-suggestion {
      font-size: 0.88em;
      line-height: 1.4;
      white-space: pre-wrap;
      max-width: 380px;
      border-left: 3px solid rgba(80, 200, 120, 0.45);
      background: rgba(80, 200, 120, 0.08);
    }
    .review-findings-table .col-fix {
      width: 120px;
      min-width: 120px;
      white-space: nowrap;
      text-align: center;
    }
    .review-findings-table tbody tr:nth-child(even) td.col-num,
    .review-findings-table tbody tr:nth-child(even) td.col-fix {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .review-fix-toolbar button.primary.is-applying {
      cursor: wait;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .sev-critical { color: var(--vscode-errorForeground); font-weight: 600; }
    .sev-high { color: var(--vscode-charts-red); font-weight: 600; }
    .sev-medium { color: var(--vscode-charts-orange); }
    .sev-low, .sev-info { color: var(--vscode-descriptionForeground); }
    button.review-fix-btn { min-width: 88px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
    button.review-fix-btn.is-applying { opacity: 0.95; cursor: wait; }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-button-border, var(--vscode-editorWidget-border));
      border-top-color: var(--vscode-button-foreground);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .review-section-heading {
      margin: 12px 0 8px;
      font-size: 0.95em;
      font-weight: 600;
      color: var(--vscode-editor-foreground);
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .review-section-heading:first-child { margin-top: 0; }
  </style>
</head>
<body>
  <div id="session-tabs" class="session-tabs"></div>
  <h1 id="title">Genie</h1>
  <div id="user-question" class="user-question hidden" aria-label="Prompt">
    <div id="user-question-body" class="user-question-body"></div>
  </div>
  <div id="prompt-box" class="prompt-box hidden" aria-label="Ask a question">
    <div class="prompt-label">Ask Genie</div>
    <div class="prompt-input-row">
      <textarea id="prompt-input" class="prompt-input" placeholder="Describe what should be generated... (Enter to send, Shift+Enter for new line)"></textarea>
      <button id="btn-send-prompt" class="prompt-send-icon" type="button" title="Send" aria-label="Send">➤</button>
    </div>
  </div>
  <div id="root">
    <div class="status-row">
      <div class="wave" id="wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div id="status" class="status"></div>
    </div>
  </div>
  <div id="step" class="step-line hidden"></div>
  <div id="meta" class="meta hidden"></div>
  <div id="actions-shell" class="actions-shell hidden">
    <div class="actions-shell-head">Actions</div>
  </div>
  <div id="actions" class="actions in-shell hidden">
    <button id="btn-apply" class="primary" type="button" disabled>Apply</button>
    <button id="btn-refine" class="secondary hidden" type="button">Refine output...</button>
    <button id="btn-accept" class="primary hidden" type="button" disabled>✓ Accept</button>
    <button id="btn-reject" class="secondary hidden" type="button" disabled>✕ Reject</button>
  </div>
  <div id="auth-box" class="auth-box hidden">
    <div class="auth-row">
      <div class="auth-label">Authentication URL</div>
      <div class="auth-value-row">
        <div id="auth-url" class="auth-value"></div>
        <button id="btn-copy-auth-url" class="auth-copy-icon" type="button" title="Copy URL" aria-label="Copy URL">⧉</button>
      </div>
    </div>
    <div class="auth-row">
      <div class="auth-label">Device code</div>
      <div class="auth-value-row">
        <div id="auth-code" class="auth-value"></div>
        <button id="btn-copy-auth-code" class="auth-copy-icon" type="button" title="Copy code" aria-label="Copy code">⧉</button>
      </div>
    </div>
    <div id="auth-wait" class="auth-wait"></div>
  </div>
  <details id="stream-wrap" class="stream-wrap collapse-panel hidden">
    <summary><span class="stream-status">Live response stream</span></summary>
    <pre id="stream" role="log" aria-live="polite"></pre>
  </details>
  <details id="diff-panel" class="collapse-panel hidden">
    <summary><span id="diff-panel-head">Diff preview</span></summary>
    <div id="diff" class="diff-wrap"></div>
  </details>
  <details id="rendered-panel" class="collapse-panel hidden">
    <summary>
      <span>Explanation</span>
      <span class="explanation-toggle" role="toolbar" aria-label="Toggle explanation">
        <button type="button" id="explain-toggle" title="Hide explanation">▲</button>
      </span>
    </summary>
    <div id="out" class="content-wrap"></div>
  </details>
  <div id="refactor-code-wrap" class="refactor-code-wrap hidden">
    <div class="refactor-code-heading" id="refactor-code-heading">Refactored code</div>
    <pre id="refactor-code-out" class="refactor-code-pre"></pre>
  </div>
  <div id="refactor-actions-anchor"></div>
  <div id="generated-code-panel" class="panel hidden">
    <div class="head">Generated code</div>
    <div id="generated-picker" class="generated-picker hidden">
      <label for="generated-file-select">File</label>
      <select id="generated-file-select"></select>
    </div>
    <pre id="generated-code" class="generated-code-pre"></pre>
  </div>
  <div id="err" class="err"></div>
  <script nonce="${nonce}">
(function () {
  'use strict';
  var vscode;
  try {
    vscode = acquireVsCodeApi();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:16px;font-family:system-ui;color:#f14c4c;">Genie could not start (webview API). Run <b>Developer: Reload Window</b>.</p>';
    return;
  }
  var sessions = {};
  var sessionOrder = [];
  var activeSessionId = "";
  var generatedFiles = [];
  var renderedPanelEl = document.getElementById("rendered-panel");
  var explainToggleBtn = document.getElementById("explain-toggle");
  var tabsEl = document.getElementById("session-tabs");
  if (!renderedPanelEl || !explainToggleBtn || !tabsEl) {
    document.body.innerHTML = '<p style="padding:16px;font-family:system-ui;color:#f14c4c;">Genie UI failed to load (missing DOM). Reload the window.</p>';
    return;
  }

    function newSession(title) {
      return {
        title: title || "Assistant result",
        status: "",
        busy: false,
        step: "",
        userQuestion: "",
        err: "",
        endpoint: "",
        hasCode: false,
        reviewMode: false,
        remarks: "",
        structuredData: null,
        displayText: "",
        generatedCode: "",
        generatedFiles: [],
        diffParts: [],
        explainOpen: true,
        streamOpen: false,
        streamLive: false,
        streamText: "",
        refinePromptMode: false,
        authUrl: "",
        authCode: "",
        fixApplyingIndex: null,
        fixApplyingAll: false,
        applyingCurrent: false,
        refactorCode: "",
      };
    }

    function clearEl(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }
    function formatHeadingLabel(text) {
      var raw = text == null ? "" : String(text);
      var normalized = raw
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "";
      return normalized
        .split(" ")
        .map(function (word) {
          if (!word) return "";
          if (/^[A-Z0-9]{2,5}$/.test(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(" ");
    }
    function addParagraph(root, title, text) {
      if (!text) return;
      var sec = document.createElement("section");
      sec.className = "section";
      var h = document.createElement("h3");
      h.textContent = formatHeadingLabel(title);
      var body = document.createElement("div");
      body.className = "body";
      body.textContent = String(text);
      sec.appendChild(h);
      sec.appendChild(body);
      root.appendChild(sec);
    }
    function renderTable(root, title, rows) {
      if (!Array.isArray(rows) || !rows.length) return false;
      var normalized = rows.filter(function (x) { return x && typeof x === "object"; });
      if (!normalized.length) return false;
      var headers = Object.keys(normalized[0]);
      if (!headers.length) return false;
      var sec = document.createElement("section");
      sec.className = "section";
      var h = document.createElement("h3");
      h.textContent = formatHeadingLabel(title);
      sec.appendChild(h);
      var body = document.createElement("div");
      body.className = "body";
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var trh = document.createElement("tr");
      headers.forEach(function (header) {
        var th = document.createElement("th");
        th.textContent = formatHeadingLabel(header);
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      normalized.forEach(function (rowObj) {
        var tr = document.createElement("tr");
        headers.forEach(function (header) {
          var td = document.createElement("td");
          var value = rowObj[header];
          td.textContent = value == null ? "" : (typeof value === "string" ? value : JSON.stringify(value));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      body.appendChild(table);
      sec.appendChild(body);
      root.appendChild(sec);
      return true;
    }
    function omitGeneratedCodeForExplanation(data, endpoint) {
      if (endpoint !== "codeGeneration" || !data || typeof data !== "object") return data;
      var skip = { generatedCode: 1, remarks: 1, summary: 1, delivery: 1 };
      var o = {};
      Object.keys(data).forEach(function (k) {
        if (!skip[k]) o[k] = data[k];
      });
      return o;
    }
    function omitRefactorApplyCode(data, endpoint) {
      if (endpoint !== "codeRefactor" || !data || typeof data !== "object") return data;
      var o = {};
      Object.keys(data).forEach(function (k) {
        if (k === "refactoredCode") return;
        o[k] = data[k];
      });
      return o;
    }
    function renderCodeRefactorExplanation(root, view, fallbackText) {
      var hero = document.createElement("div");
      hero.className = "refactor-hero";
      var ht = document.createElement("div");
      ht.className = "refactor-hero-title";
      ht.textContent = "Refactor overview";
      hero.appendChild(ht);
      if (view.quality) {
        var q = document.createElement("div");
        q.className = "refactor-quality";
        q.textContent = "Quality: " + view.quality;
        hero.appendChild(q);
      }
      var sum = document.createElement("div");
      sum.className = "refactor-hero-summary";
      sum.textContent = view.summary || fallbackText || "";
      hero.appendChild(sum);
      root.appendChild(hero);
      if (view.details && String(view.details).trim()) {
        var det = document.createElement("div");
        det.className = "refactor-body";
        det.textContent = String(view.details);
        root.appendChild(det);
      }
      if (Array.isArray(view.suggestedChanges) && view.suggestedChanges.length) {
        var ul = document.createElement("ul");
        ul.className = "refactor-suggestions";
        view.suggestedChanges.forEach(function (sc) {
          if (!sc || typeof sc !== "object") return;
          var li = document.createElement("li");
          var bits = [];
          if (sc.area) bits.push(String(sc.area));
          if (sc.issue) bits.push(String(sc.issue));
          if (sc.suggestion) bits.push(String(sc.suggestion));
          li.textContent = bits.filter(Boolean).join(" — ");
          ul.appendChild(li);
        });
        root.appendChild(ul);
      }
      var remarks = view.remarks || "";
      if (String(remarks).trim()) {
        var rm = document.createElement("div");
        rm.className = "refactor-remarks";
        rm.textContent = remarks;
        root.appendChild(rm);
      }
      if (Array.isArray(view.validationChecklist) && view.validationChecklist.length) {
        var vc = document.createElement("ul");
        vc.className = "refactor-checklist";
        view.validationChecklist.forEach(function (x) {
          var li = document.createElement("li");
          li.textContent = String(x);
          vc.appendChild(li);
        });
        root.appendChild(vc);
      }
    }
    function renderStructured(root, data, fallbackText, endpoint, session) {
      clearEl(root);
      var view = omitRefactorApplyCode(omitGeneratedCodeForExplanation(data, endpoint), endpoint);
      if (endpoint === "codeReview") {
        renderCodeReview(root, view, fallbackText, session);
        return;
      }
      if (endpoint === "codeRefactor" && view && typeof view === "object") {
        renderCodeRefactorExplanation(root, view, fallbackText);
        return;
      }
      if (!view || typeof view !== "object") {
        if (endpoint !== "codeGeneration" && fallbackText && String(fallbackText).trim()) {
          addParagraph(root, "Explanation", fallbackText);
        }
        return;
      }
      if (endpoint !== "codeGeneration") addParagraph(root, "Summary", view.summary || fallbackText || "");
      if (view.inputOutput && typeof view.inputOutput === "object") {
        var ioRows = [];
        ["inputs", "outputs", "sideEffects"].forEach(function (key) {
          var val = view.inputOutput[key];
          if (Array.isArray(val) && val.length) ioRows.push({ section: key, details: val.join("\\n") });
        });
        renderTable(root, "Input / Output", ioRows);
      }
      if (Array.isArray(view.explanation)) {
        view.explanation.forEach(function (item, idx) {
          if (!item || typeof item !== "object") return;
          var sectionTitle = item.section || ("Section " + (idx + 1));
          addParagraph(root, sectionTitle + " - Overview", item.overview || "");
          addParagraph(root, sectionTitle + " - Detailed explanation", item.detailedExplanation || "");
          renderTable(root, sectionTitle + " - Key components", item.keyComponents);
          renderTable(root, sectionTitle + " - Logic flow", item.logicFlow);
          renderTable(root, sectionTitle + " - Algorithms", item.algorithms);
          if (Array.isArray(item.edgeCases) && item.edgeCases.length) addParagraph(root, sectionTitle + " - Edge cases", item.edgeCases.join("\\n"));
          if (item.complexity) addParagraph(root, sectionTitle + " - Complexity", item.complexity);
        });
      }
      renderTable(root, "Examples", view.examples);
      renderTable(root, "Glossary", view.glossary);
      addParagraph(root, "Remarks", view.remarks || "");
      Object.keys(view).forEach(function (key) {
        if (["summary", "inputOutput", "explanation", "examples", "glossary", "remarks"].indexOf(key) >= 0) return;
        var value = view[key];
        if (Array.isArray(value)) {
          if (!renderTable(root, key, value) && value.length) addParagraph(root, key, value.map(function (x) { return String(x); }).join("\\n"));
          return;
        }
        if (typeof value === "string" && value.trim()) addParagraph(root, key, value);
      });
    }
    function issueDescriptionOnly(f) {
      var detail = String(f.detail || "");
      var head = detail.split(/\\n\\nCode:/i)[0].trim();
      return head || "—";
    }
    function sevClass(sev) {
      var x = String(sev || "").toLowerCase();
      if (x === "critical") return "sev-critical";
      if (x === "high") return "sev-high";
      if (x === "medium") return "sev-medium";
      if (x === "low") return "sev-low";
      return "sev-info";
    }
    /** Count findings from flat list or sections (whichever reflects the review). */
    function countFindingsInView(view) {
      if (!view || typeof view !== "object") return 0;
      var flat = Array.isArray(view.findings) ? view.findings.length : 0;
      var sections = Array.isArray(view.sections) ? view.sections : [];
      var fromSections = 0;
      for (var si = 0; si < sections.length; si++) {
        var sec = sections[si];
        var findings = sec && Array.isArray(sec.findings) ? sec.findings : [];
        fromSections += findings.length;
      }
      return Math.max(flat, fromSections);
    }
    /** Total / applied / rejected / pending — total is inferred when findings[] was cleared but indices remain. */
    function computeReviewMetrics(view) {
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var appliedOnly = applied.length;
      var rejectedOnly = rejected.length;
      var nFromView = countFindingsInView(view);
      var totalOnly = Math.max(nFromView, appliedOnly + rejectedOnly);
      var pendingOnly = Math.max(0, totalOnly - appliedOnly - rejectedOnly);
      return { total: totalOnly, applied: appliedOnly, rejected: rejectedOnly, pending: pendingOnly };
    }
    function isReviewCaughtUpOnly(view) {
      if (!view || typeof view !== "object") {
        return false;
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var sections = Array.isArray(view.sections) ? view.sections : [];
      var totalFindings = Array.isArray(view.findings) ? view.findings.length : 0;
      if (totalFindings > 0) {
        return false;
      }
      if (sections.length) {
        for (var si = 0; si < sections.length; si++) {
          var sec = sections[si];
          var findings = sec && Array.isArray(sec.findings) ? sec.findings : [];
          for (var fi = 0; fi < findings.length; fi++) {
            var f = findings[fi];
            var idx = typeof f.globalIndex === "number" ? f.globalIndex : fi;
            if (applied.indexOf(idx) < 0) {
              return false;
            }
          }
        }
        return true;
      }
      var flatFindings = Array.isArray(view.findings) ? view.findings : [];
      for (var i = 0; i < flatFindings.length; i++) {
        if (applied.indexOf(i) < 0) {
          return false;
        }
      }
      return true;
    }
    function renderCodeReview(root, view, fallbackText, session) {
      if (!view || typeof view !== "object") {
        return;
      }
      var applied = Array.isArray(view.appliedIndices) ? view.appliedIndices : [];
      var rejected = Array.isArray(view.rejectedIndices) ? view.rejectedIndices : [];
      var applyingIndex = session && session.fixApplyingIndex != null ? session.fixApplyingIndex : null;
      var applyingAll = !!(session && session.fixApplyingAll);
      var fixRunInProgress = applyingAll || applyingIndex !== null;
      if (isReviewCaughtUpOnly(view)) {
        clearEl(root);
        var m = computeReviewMetrics(view);

        var onlyWrap = document.createElement("div");
        onlyWrap.className = "review-complete-only-wrap";

        var doneCard = document.createElement("div");
        doneCard.className = "review-complete-card";

        var doneTitle = document.createElement("p");
        doneTitle.className = "review-complete-title";
        doneTitle.textContent = "All fixes are caught up for this file.";
        doneCard.appendChild(doneTitle);

        var doneSub = document.createElement("p");
        doneSub.className = "review-complete-sub";
        doneSub.textContent = "Accepted fixes are hidden to keep this view focused and fast.";
        doneCard.appendChild(doneSub);

        var chips = document.createElement("div");
        chips.className = "review-complete-metrics";
        [
          "Issues raised: " + m.total,
          "Applied: " + m.applied,
          "Rejected: " + m.rejected,
          "Pending: " + m.pending
        ].forEach(function (label) {
          var chip = document.createElement("span");
          chip.className = "review-complete-chip";
          chip.textContent = label;
          chips.appendChild(chip);
        });
        doneCard.appendChild(chips);

        onlyWrap.appendChild(doneCard);
        root.appendChild(onlyWrap);
        return;
      }

      var toolbar = document.createElement("div");
      toolbar.className = "review-fix-toolbar";
      var btnAll = document.createElement("button");
      btnAll.type = "button";
      btnAll.className = "primary" + (applyingAll ? " is-applying" : "");
      if (applyingAll) {
        btnAll.disabled = true;
        btnAll.innerHTML = "";
        var spAll = document.createElement("span");
        spAll.className = "spinner";
        btnAll.appendChild(spAll);
        btnAll.appendChild(document.createTextNode(" Applying..."));
      } else if (applyingIndex !== null) {
        btnAll.disabled = true;
        btnAll.textContent = "Fix All One by One";
      } else {
        btnAll.textContent = "Fix All One by One";
        btnAll.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "all", sessionId: activeSessionId }); };
      }
      var btnExtra = document.createElement("button");
      btnExtra.type = "button";
      btnExtra.className = "secondary";
      btnExtra.textContent = "Apply with extra instructions...";
      btnExtra.disabled = fixRunInProgress;
      if (!fixRunInProgress) {
        btnExtra.onclick = function () { vscode.postMessage({ command: "applyFixes", mode: "all", promptExtra: true, sessionId: activeSessionId }); };
      }
      toolbar.appendChild(btnAll);
      toolbar.appendChild(btnExtra);
      root.appendChild(toolbar);

      var rm = computeReviewMetrics(view);
      var metricsBar = document.createElement("div");
      metricsBar.className = "review-metrics-bar";
      metricsBar.setAttribute("role", "status");
      metricsBar.textContent =
        rm.total +
        " issue(s) in this review · " +
        rm.applied +
        " applied · " +
        rm.rejected +
        " rejected · " +
        rm.pending +
        " pending";
      root.appendChild(metricsBar);

      var overallSummary = "";
      if (typeof view.summary === "string" && view.summary.trim()) {
        overallSummary = view.summary.trim();
      } else if (fallbackText && String(fallbackText).trim()) {
        overallSummary = String(fallbackText).trim();
      }
      if (overallSummary) {
        addParagraph(root, "Summary", overallSummary);
      }

      var fallbackGlobalIndex = 0;
      function renderFindingTable(sectionLabel, findings) {
        if (!Array.isArray(findings) || !findings.length) return;
        var wrap = document.createElement("div");
        wrap.className = "review-table-wrap";
        var table = document.createElement("table");
        table.className = "review-findings-table";
        var thead = document.createElement("thead");
        var hr = document.createElement("tr");
        [["#", "col-num-h"], ["Severity", ""], ["Category", ""], ["Title", ""], ["Description", ""], ["Suggested fix", ""], ["Fix", ""]].forEach(function (pair) {
          var th = document.createElement("th");
          th.textContent = pair[0];
          if (pair[1]) th.className = pair[1];
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement("tbody");
        var rowNum = 0;
        findings.forEach(function (f) {
          var item = f && typeof f === "object" ? f : {};
          var globalIndex = typeof item.globalIndex === "number" ? item.globalIndex : fallbackGlobalIndex;
          fallbackGlobalIndex += 1;
          var isApplied = applied.indexOf(globalIndex) >= 0;
          var isRejected = !isApplied && rejected.indexOf(globalIndex) >= 0;
          rowNum += 1;
          var tr = document.createElement("tr");
          if (isApplied) {
            tr.className = "row-applied";
          } else if (isRejected) {
            tr.className = "row-rejected";
          }
          var tdNum = document.createElement("td");
          tdNum.className = "col-num";
          tdNum.textContent = String(rowNum);
          tr.appendChild(tdNum);
          var tdSev = document.createElement("td");
          var sevText = String(item.severity || "");
          tdSev.className = sevClass(sevText);
          tdSev.textContent = sevText || "—";
          tr.appendChild(tdSev);
          var tdCat = document.createElement("td");
          tdCat.textContent = String(item.category || "—");
          tr.appendChild(tdCat);
          var tdTitle = document.createElement("td");
          tdTitle.textContent = String(item.title || "Issue");
          tr.appendChild(tdTitle);
          var tdDesc = document.createElement("td");
          if (isApplied) {
            tdDesc.className = "col-applied-muted";
            tdDesc.textContent = "—";
          } else {
            tdDesc.textContent = issueDescriptionOnly(item);
          }
          tr.appendChild(tdDesc);
          var tdSug = document.createElement("td");
          var sugText = String(item.suggestion || "").trim();
          if (isApplied) {
            tdSug.className = "col-suggestion col-suggestion-applied-done";
            tdSug.textContent = "—";
          } else if (isRejected) {
            tdSug.className = "col-suggestion col-suggestion-rejected";
            tdSug.textContent = sugText || "—";
          } else {
            tdSug.className = "col-suggestion";
            tdSug.textContent = sugText || "—";
          }
          tr.appendChild(tdSug);
          var tdFix = document.createElement("td");
          tdFix.className = "col-fix";
          if (isApplied) {
            var spA = document.createElement("span");
            spA.className = "review-status-accepted";
            spA.textContent = "Accepted";
            tdFix.appendChild(spA);
          } else if (isRejected) {
            var spR = document.createElement("span");
            spR.className = "review-status-rejected";
            spR.textContent = "Rejected";
            tdFix.appendChild(spR);
          } else {
            var fixBtn = document.createElement("button");
            fixBtn.type = "button";
            fixBtn.className = "primary review-fix-btn";
            // Single fix: only that row shows Applying… (including editor preview). Bulk: every pending row shows Applying… while the run is active.
            var showApplying =
              !isApplied &&
              !isRejected &&
              (applyingAll ||
                (applyingIndex !== null && applyingIndex === globalIndex));
            var fixRowLocked =
              !isApplied &&
              !isRejected &&
              !applyingAll &&
              applyingIndex !== null &&
              applyingIndex !== globalIndex;
            if (showApplying) {
              fixBtn.className = "primary review-fix-btn is-applying";
              fixBtn.disabled = true;
              fixBtn.innerHTML = "";
              var sp = document.createElement("span");
              sp.className = "spinner";
              fixBtn.appendChild(sp);
              fixBtn.appendChild(document.createTextNode(" Applying..."));
            } else {
              fixBtn.textContent = "Fix";
              fixBtn.disabled = !!fixRowLocked;
              if (!fixRowLocked) {
                fixBtn.onclick = function () {
                  vscode.postMessage({ command: "applyFixes", mode: "one", index: globalIndex, sessionId: activeSessionId });
                };
              }
            }
            tdFix.appendChild(fixBtn);
          }
          tr.appendChild(tdFix);
          tbody.appendChild(tr);
        });
        if (!tbody.children.length) return;
        table.appendChild(tbody);
        wrap.appendChild(table);
        if (sectionLabel) {
          var sn = document.createElement("h3");
          sn.className = "review-section-heading";
          sn.textContent = sectionLabel;
          root.appendChild(sn);
        }
        root.appendChild(wrap);
      }

      var sections = Array.isArray(view.sections) ? view.sections : [];
      var renderedAnySection = false;
      sections.forEach(function (sec, idx) {
        if (!sec || typeof sec !== "object") return;
        var findings = Array.isArray(sec.findings) ? sec.findings : [];
        if (!findings.length) return;
        renderedAnySection = true;
        var sectionName = sec.name || ("Section " + (idx + 1));
        if (typeof sec.summary === "string" && sec.summary.trim()) {
          addParagraph(root, sectionName + " Summary", sec.summary.trim());
        }
        renderFindingTable(sectionName, findings);
      });

      if (!renderedAnySection) {
        var flatFindings = Array.isArray(view.findings) ? view.findings : [];
        var pendingFlat = [];
        for (var fi = 0; fi < flatFindings.length; fi++) {
          var raw = flatFindings[fi];
          var merged = Object.assign({ globalIndex: fi }, raw && typeof raw === "object" ? raw : {});
          pendingFlat.push(merged);
        }
        if (pendingFlat.length) {
          renderFindingTable("Open issues", pendingFlat);
        }
      }

      if (!root.querySelector(".review-findings-table")) {
        var mm = computeReviewMetrics(view);
        var totalFindings = mm.total;

        var doneCard = document.createElement("div");
        doneCard.className = "review-complete-card";

        var doneTitle = document.createElement("p");
        doneTitle.className = "review-complete-title";
        doneTitle.textContent = totalFindings > 0
          ? "All fixes are caught up for this file."
          : "No findings detected in this review.";
        doneCard.appendChild(doneTitle);

        var doneSub = document.createElement("p");
        doneSub.className = "review-complete-sub";
        doneSub.textContent = totalFindings > 0
          ? "Accepted fixes are hidden to keep this view focused and fast."
          : "Nothing to apply right now.";
        doneCard.appendChild(doneSub);
        root.appendChild(doneCard);
      }
    }
    function renderDiff(parts) {
      var diffRoot = document.getElementById("diff");
      diffRoot.innerHTML = "";
      if (!Array.isArray(parts) || !parts.length) return false;
      parts.forEach(function (p) {
        var line = document.createElement("div");
        var k = p.kind;
        line.className = "diff-line " + (k === "add" ? "add" : k === "remove" ? "del" : "same");
        line.textContent = p.text || "";
        diffRoot.appendChild(line);
      });
      return true;
    }
    function setDecisionButtons(enabled) {
      document.getElementById("btn-accept").disabled = !enabled;
      document.getElementById("btn-reject").disabled = !enabled;
    }
    function syncExplanationToggleIcon() {
      var s = sessions[activeSessionId];
      if (!s) return;
      var open = !!renderedPanelEl.open;
      s.explainOpen = open;
      explainToggleBtn.textContent = open ? "▲" : "▼";
      explainToggleBtn.title = open ? "Hide explanation" : "Show explanation";
      explainToggleBtn.setAttribute("aria-label", open ? "Hide explanation" : "Show explanation");
    }
    function renderTabs() {
      tabsEl.innerHTML = "";
      sessionOrder.forEach(function (id, idx) {
        var s = sessions[id];
        if (!s) return;
        var tab = document.createElement("div");
        tab.className = "session-tab" + (id === activeSessionId ? " active" : "");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "session-tab-label";
        btn.textContent = s.title || ("Run " + (idx + 1));
        btn.onclick = function () {
          activeSessionId = id;
          renderTabs();
          renderSession();
        };
        var close = document.createElement("button");
        close.type = "button";
        close.className = "session-tab-close";
        close.title = "Close tab";
        close.setAttribute("aria-label", "Close tab");
        close.textContent = "×";
        close.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          closeSession(id, true);
        };
        tab.appendChild(btn);
        tab.appendChild(close);
        tabsEl.appendChild(tab);
      });
    }
    function renderEmptyState() {
      document.documentElement.setAttribute("data-endpoint", "");
      document.getElementById("title").textContent = "Genie";
      document.getElementById("user-question").classList.add("hidden");
      document.getElementById("prompt-box").classList.add("hidden");
      var pi = document.getElementById("prompt-input");
      if (pi) pi.value = "";
      document.getElementById("status").textContent = "";
      document.getElementById("root").classList.remove("busy");
      document.getElementById("step").classList.add("hidden");
      document.getElementById("actions-shell").classList.add("hidden");
      document.getElementById("actions").classList.add("hidden");
      document.getElementById("stream-wrap").classList.add("hidden");
      document.getElementById("diff-panel").classList.add("hidden");
      document.getElementById("rendered-panel").classList.add("hidden");
      document.getElementById("generated-code-panel").classList.add("hidden");
      document.getElementById("meta").classList.add("hidden");
      document.getElementById("err").textContent = "";
    }
    function closeSession(id, notifyHost) {
      if (!sessions[id]) return;
      delete sessions[id];
      sessionOrder = sessionOrder.filter(function (sid) { return sid !== id; });
      if (notifyHost) {
        vscode.postMessage({ command: "closeSession", sessionId: id });
      }
      if (activeSessionId === id) {
        activeSessionId = sessionOrder.length ? sessionOrder[sessionOrder.length - 1] : "";
      }
      renderTabs();
      if (activeSessionId) renderSession(); else renderEmptyState();
    }
    function renderSession() {
      var s = sessions[activeSessionId];
      if (!s) return;
      var reviewCaughtUpOnly =
        s.endpoint === "codeReview" &&
        !s.busy &&
        !s.streamLive &&
        isReviewCaughtUpOnly(s.structuredData);
      document.documentElement.setAttribute("data-endpoint", s.endpoint || "");
      document.getElementById("title").textContent = s.title || "Genie";
      var promptBox = document.getElementById("prompt-box");
      var promptInput = document.getElementById("prompt-input");
      var sendPromptBtn = document.getElementById("btn-send-prompt");
      var uqb = document.getElementById("user-question-body");
      var uq = document.getElementById("user-question");
      if ((s.userQuestion || "").trim()) {
        uqb.textContent = s.userQuestion;
        uq.classList.remove("hidden");
      } else {
        uqb.textContent = "";
        uq.classList.add("hidden");
      }
      var needsPrompt =
        (s.endpoint === "codeGeneration" && !(s.userQuestion || "").trim() && !s.busy) ||
        (s.endpoint === "codeRefactor" && !!s.refinePromptMode && !(s.userQuestion || "").trim() && !s.busy);
      if (needsPrompt) {
        promptBox.classList.remove("hidden");
        sendPromptBtn.disabled = false;
        promptInput.disabled = false;
        if (promptInput) {
          promptInput.placeholder =
            s.endpoint === "codeRefactor"
              ? "How should the code be refactored? (e.g. extract functions, rename, add types, simplify…) — Enter to send, Shift+Enter for newline"
              : "Describe what should be generated… (Enter to send, Shift+Enter for newline)";
        }
      } else {
        promptBox.classList.add("hidden");
        sendPromptBtn.disabled = true;
        promptInput.disabled = true;
      }
      var hasAuthData = s.endpoint === "authenticate" && (s.authUrl || s.authCode);
      var statusEl = document.getElementById("status");
      var statusRow = statusEl ? statusEl.parentElement : null;
      statusEl.textContent = reviewCaughtUpOnly || hasAuthData ? "" : (s.status || "");
      if (statusRow) {
        if (reviewCaughtUpOnly) statusRow.classList.add("hidden");
        else statusRow.classList.remove("hidden");
      }
      var root = document.getElementById("root");
      if (s.busy) root.classList.add("busy"); else root.classList.remove("busy");
      var step = document.getElementById("step");
      var authWaitEl = document.getElementById("auth-wait");
      if (!reviewCaughtUpOnly && s.step) {
        step.textContent = "Step: " + s.step;
        if (!hasAuthData) {
          step.classList.remove("hidden");
        } else {
          step.classList.add("hidden");
        }
      } else {
        step.classList.add("hidden");
      }
      var sw = document.getElementById("stream-wrap");
      var st = document.getElementById("stream");
      var streamStatusEl = sw ? sw.querySelector(".stream-status") : null;
      if (streamStatusEl) {
        streamStatusEl.textContent =
          s.endpoint === "codeReview" ? "Live review response" : "Live response stream";
      }
      var streamHasText = s.streamText != null && String(s.streamText).length > 0;
      var showStream = !reviewCaughtUpOnly && (streamHasText || !!s.streamLive);
      if (showStream) {
        sw.classList.remove("hidden");
        st.textContent = streamHasText ? String(s.streamText) : (s.streamLive ? "Waiting for first tokens…" : "");
        if (s.busy || s.streamLive) sw.classList.add("streaming"); else sw.classList.remove("streaming");
        sw.open = !!s.streamLive || !!s.streamOpen;
      } else {
        st.textContent = "";
        sw.classList.add("hidden");
        sw.classList.remove("streaming");
      }
      var actions = document.getElementById("actions");
      var actionsShell = document.getElementById("actions-shell");
      var refactorActionsAnchor = document.getElementById("refactor-actions-anchor");
      if (s.endpoint === "codeRefactor") {
        actionsShell.classList.add("hidden");
        actions.classList.remove("in-shell");
        actions.classList.add("align-right");
        if (refactorActionsAnchor && actions.parentNode !== refactorActionsAnchor) {
          refactorActionsAnchor.appendChild(actions);
        }
      } else {
        actions.classList.remove("align-right");
        actions.classList.add("in-shell");
        if (actions.parentNode !== actionsShell) {
          actionsShell.appendChild(actions);
        }
        actionsShell.classList.remove("hidden");
      }
      actions.classList.remove("hidden");
      var btnApply = document.getElementById("btn-apply");
      var btnRefine = document.getElementById("btn-refine");
      var btnAccept = document.getElementById("btn-accept");
      var btnReject = document.getElementById("btn-reject");
      if (reviewCaughtUpOnly) {
        actionsShell.classList.add("hidden");
        actions.classList.add("hidden");
        btnApply.classList.add("hidden");
        btnRefine.classList.add("hidden");
        btnAccept.classList.add("hidden");
        btnReject.classList.add("hidden");
        setDecisionButtons(false);
      } else if (s.reviewMode) {
        btnApply.classList.add("hidden");
        if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") {
          btnRefine.classList.remove("hidden");
          btnAccept.textContent = "✓ Accept";
        } else {
          btnRefine.classList.add("hidden");
          btnAccept.textContent = "✓ Accept";
        }
        btnAccept.classList.remove("hidden");
        btnReject.classList.remove("hidden");
        btnReject.textContent = "✕ Reject";
        setDecisionButtons(!!s.hasCode);
      } else {
        var showApply = !!s.hasCode && !(s.endpoint === "codeRefactor" && (s.step || "").toLowerCase().indexOf("waiting for your prompt") >= 0);
        if (showApply) btnApply.classList.remove("hidden"); else btnApply.classList.add("hidden");
        if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") btnRefine.classList.remove("hidden");
        else btnRefine.classList.add("hidden");
        btnAccept.textContent = "✓ Accept";
        btnAccept.classList.add("hidden");
        btnReject.classList.add("hidden");
        btnApply.disabled = !s.hasCode || !!s.applyingCurrent || !!s.busy;
        if (s.applyingCurrent) {
          btnApply.classList.add("is-applying");
          btnApply.innerHTML = "";
          var applySpinner = document.createElement("span");
          applySpinner.className = "spinner";
          btnApply.appendChild(applySpinner);
          btnApply.appendChild(document.createTextNode(" Applying..."));
        } else {
          btnApply.classList.remove("is-applying");
          btnApply.textContent = "Apply";
        }
        setDecisionButtons(false);
      }
      var diffPanel = document.getElementById("diff-panel");
      var diffRendered = !reviewCaughtUpOnly && renderDiff(s.diffParts);
      var showDiffPanel = diffRendered && s.reviewMode;
      if (showDiffPanel) {
        diffPanel.classList.remove("hidden");
        diffPanel.open = true;
      } else {
        diffPanel.classList.add("hidden");
        diffPanel.open = false;
      }
      var meta = document.getElementById("meta");
      meta.innerHTML = "";
      if (!reviewCaughtUpOnly && s.remarks && s.endpoint !== "codeGeneration") {
        var r = document.createElement("div");
        r.className = "remarks";
        r.textContent = s.remarks;
        meta.appendChild(r);
        meta.classList.remove("hidden");
      } else {
        meta.classList.add("hidden");
      }
      var out = document.getElementById("out");
      var renderedPanel = document.getElementById("rendered-panel");
      var hasExplanationContent =
        !!((s.streamText && String(s.streamText).trim()) ||
          (s.displayText && String(s.displayText).trim()) ||
          (s.structuredData && typeof s.structuredData === "object" && Object.keys(s.structuredData).length));
      if (hasExplanationContent) {
        renderedPanel.classList.remove("hidden");
        if (reviewCaughtUpOnly) {
          renderedPanel.classList.add("complete-only");
        } else {
          renderedPanel.classList.remove("complete-only");
        }
        renderedPanel.open = s.explainOpen !== false;
        syncExplanationToggleIcon();
        renderStructured(out, s.structuredData, s.displayText || "", s.endpoint || "", s);
      } else {
        renderedPanel.classList.add("hidden");
        renderedPanel.classList.remove("complete-only");
        clearEl(out);
      }
      var rcw = document.getElementById("refactor-code-wrap");
      var rco = document.getElementById("refactor-code-out");
      var regenStreaming = !!(s.busy && s.streamLive);
      var rcText = s.refactorCode != null ? String(s.refactorCode) : "";
      if (rcw && rco && s.endpoint === "codeRefactor" && rcText.trim() && !regenStreaming) {
        rcw.classList.remove("hidden");
        rco.textContent = rcText;
      } else if (rcw && rco) {
        rcw.classList.add("hidden");
        rco.textContent = "";
      }
      var gcp = document.getElementById("generated-code-panel");
      var gpp = document.getElementById("generated-picker");
      var gfs = document.getElementById("generated-file-select");
      var gct = document.getElementById("generated-code");
      generatedFiles = Array.isArray(s.generatedFiles) ? s.generatedFiles : [];
      var genText = s.endpoint === "codeGeneration" && s.generatedCode && String(s.generatedCode).trim() ? String(s.generatedCode) : "";
      if (generatedFiles.length > 1) {
        gfs.innerHTML = "";
        generatedFiles.forEach(function (f, idx) {
          var opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = f.relativePath || ("file " + (idx + 1));
          gfs.appendChild(opt);
        });
        gpp.classList.remove("hidden");
        gct.textContent = String(generatedFiles[0].code || "");
      } else if (generatedFiles.length === 1) {
        gpp.classList.add("hidden");
        gct.textContent = String(generatedFiles[0].code || "");
      } else if (genText) {
        gpp.classList.add("hidden");
        gct.textContent = genText;
      } else {
        gpp.classList.add("hidden");
        gct.textContent = "";
      }
      gfs.onchange = function () {
        var idx = Number(gfs.value || 0);
        var selected = generatedFiles[idx];
        gct.textContent = selected && selected.code ? String(selected.code) : "";
      };
      var authBox = document.getElementById("auth-box");
      var authUrl = document.getElementById("auth-url");
      var authCode = document.getElementById("auth-code");
      if (s.endpoint === "authenticate" && (s.authUrl || s.authCode)) {
        authUrl.textContent = s.authUrl || "";
        authCode.textContent = s.authCode || "";
        authWaitEl.textContent = [s.status, s.step ? ("Step: " + s.step) : ""].filter(Boolean).join("  ");
        authBox.classList.remove("hidden");
      } else {
        authUrl.textContent = "";
        authCode.textContent = "";
        authWaitEl.textContent = "";
        authBox.classList.add("hidden");
      }
      document.getElementById("err").textContent = s.err || "";
    }

    function focusPromptComposerAndScrollTop() {
      setTimeout(function () {
        var docEl = document.scrollingElement || document.documentElement || document.body;
        var promptBox = document.getElementById("prompt-box");
        var promptInput = document.getElementById("prompt-input");
        if (docEl) {
          docEl.scrollTop = 0;
        }
        if (promptBox) {
          promptBox.classList.remove("hidden");
          promptBox.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
        if (promptInput && !promptInput.disabled) {
          promptInput.value = "";
          promptInput.disabled = false;
          promptInput.focus();
          promptInput.setSelectionRange(0, 0);
        }
      }, 10);
    }
    document.getElementById("btn-refine").addEventListener("click", function () {
      if (!activeSessionId) return;
      var s = sessions[activeSessionId];
      if (!s) return;
      if (s.endpoint === "codeGeneration" || s.endpoint === "codeRefactor") {
        // Reuse the in-panel prompt box for refinement instead of popup input.
        s.refinePromptMode = true;
        s.userQuestion = "";
        s.err = "";
        renderSession();
        focusPromptComposerAndScrollTop();
      }
      vscode.postMessage({ command: "refineRequest", sessionId: activeSessionId });
    });
    document.getElementById("btn-apply").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.hasCode) return;
      s.applyingCurrent = true;
      renderSession();
      vscode.postMessage({ command: "applyCurrent", sessionId: activeSessionId });
    });
    document.getElementById("btn-accept").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.reviewMode) return;
      setDecisionButtons(false);
      vscode.postMessage({ command: "fixDecision", value: "accept", sessionId: activeSessionId });
    });
    document.getElementById("btn-reject").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.reviewMode) return;
      setDecisionButtons(false);
      vscode.postMessage({ command: "fixDecision", value: "reject", sessionId: activeSessionId });
    });
    document.getElementById("btn-copy-auth-url").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.authUrl) return;
      vscode.postMessage({ command: "copyText", sessionId: activeSessionId, value: s.authUrl });
    });
    document.getElementById("btn-copy-auth-code").addEventListener("click", function () {
      var s = sessions[activeSessionId];
      if (!s || !s.authCode) return;
      vscode.postMessage({ command: "copyText", sessionId: activeSessionId, value: s.authCode });
    });
    function trySendPrompt() {
      if (!activeSessionId) return;
      var s = sessions[activeSessionId];
      if (!s || (s.endpoint !== "codeGeneration" && s.endpoint !== "codeRefactor")) return;
      var input = document.getElementById("prompt-input");
      var text = (input && input.value != null) ? String(input.value) : "";
      var q = text.trim();
      if (!q) return;
      s.userQuestion = q;
      s.refinePromptMode = false;
      renderSession();
      vscode.postMessage({ command: "submitPrompt", sessionId: activeSessionId, value: q });
    }
    document.getElementById("btn-send-prompt").addEventListener("click", trySendPrompt);
    document.getElementById("prompt-input").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      e.preventDefault();
      trySendPrompt();
    });
    explainToggleBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      renderedPanelEl.open = !renderedPanelEl.open;
      syncExplanationToggleIcon();
    });
    renderedPanelEl.addEventListener("toggle", syncExplanationToggleIcon);
    document.getElementById("stream-wrap").addEventListener("toggle", function () {
      var s = sessions[activeSessionId];
      if (!s) return;
      s.streamOpen = !!document.getElementById("stream-wrap").open;
    });

    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "createSession") {
        if (!m.sessionId) return;
        if (!sessions[m.sessionId]) {
          sessions[m.sessionId] = newSession(m.title || "Assistant result");
          sessionOrder.push(m.sessionId);
        }
        activeSessionId = m.sessionId;
        renderTabs();
        renderSession();
        return;
      }
      if (m.type === "closeSession") {
        if (m.sessionId) {
          closeSession(m.sessionId, false);
        }
        return;
      }
      var sid = m.sessionId;
      if (!sid || !sessions[sid]) return;
      var s = sessions[sid];
      if (m.type === "title") s.title = m.text || s.title;
      if (m.type === "mode") s.endpoint = m.endpoint || s.endpoint;
      if (m.type === "status") s.status = m.text || "";
      if (m.type === "busy") s.busy = !!m.value;
      if (m.type === "busy" && !m.value) s.applyingCurrent = false;
      if (m.type === "step") s.step = m.text || "";
      if (m.type === "stream") s.streamText = m.text || "";
      if (m.type === "streamLive") s.streamLive = !!m.value;
      if (m.type === "userQuestion") s.userQuestion = m.text != null ? String(m.text) : "";
      if (m.type === "result") {
        s.remarks = m.remarks || "";
        s.displayText = m.displayText || "";
        s.structuredData = m.structuredData || null;
        s.reviewMode = !!m.reviewMode && !!m.hasCode;
        s.hasCode = !!m.hasCode;
        s.endpoint = m.endpoint || s.endpoint;
        s.generatedCode = m.generatedCode || "";
        s.generatedFiles = Array.isArray(m.generatedFiles) ? m.generatedFiles : [];
        s.diffParts = Array.isArray(m.diffParts) ? m.diffParts : [];
        s.refactorCode = m.refactorCode != null ? String(m.refactorCode) : "";
        s.refinePromptMode = false;
        s.streamOpen = false;
        s.streamLive = false;
        s.streamText = "";
        s.applyingCurrent = false;
      }
      if (m.type === "authData") {
        s.endpoint = "authenticate";
        s.authUrl = m.url != null ? String(m.url) : "";
        s.authCode = m.code != null ? String(m.code) : "";
      }
      if (m.type === "error") {
        s.err = m.text || "";
        s.applyingCurrent = false;
        s.streamLive = false;
        s.streamText = "";
      }
      if (m.type === "fixApplying") {
        s.fixApplyingIndex = m.index === null || m.index === undefined ? null : m.index;
      }
      if (m.type === "fixApplyingAll") {
        s.fixApplyingAll = !!m.value;
      }
      if (sid === activeSessionId) {
        renderTabs();
        renderSession();
      } else {
        renderTabs();
      }
    });
})();
  </script>
</body>
</html>`;
}

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

type GenieCommand =
  | "applyCurrent"
  | "fixDecision"
  | "refineRequest"
  | "closeSession"
  | "copyText"
  | "applyFixes"
    | "authenticate"
    | "submitPrompt";

class GeniePanelHost {
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
    this.panel.webview.html = panelHtml(this.panel.webview, nonce);
    this.messageDisposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { command?: GenieCommand; sessionId?: string; value?: string | "accept" | "reject" }) => {
        // Run without requiring a registered session (fixes silent drops when target is missing).
        if (msg?.command === "applyFixes") {
          const m = msg as {
            mode?: string;
            index?: number;
            indices?: number[];
            promptExtra?: boolean;
          };
          const mode = m.mode === "one" || m.mode === "selected" ? m.mode : "all";
          const idx = typeof m.index === "number" ? m.index : undefined;
          const selectedIndices = Array.isArray(m.indices) ? m.indices.filter((n) => typeof n === "number") : undefined;
          if (m.promptExtra) {
            void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, undefined, selectedIndices);
          } else {
            void vscode.commands.executeCommand("codeReview.applyFixes", mode, idx, "", selectedIndices);
          }
          return;
        }
        if (msg?.command === "authenticate") {
          void vscode.commands.executeCommand("codeReview.authenticate");
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
    // Reset handlers for idempotent session reuse by action key.
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

  /** Shows the live stream panel while tokens arrive (before the first chunk). */
  setStreamLive(value: boolean): void {
    void this.host.postMessage({ type: "streamLive", sessionId: this.sessionId, value });
  }

  setMode(endpoint: string): void {
    void this.host.postMessage({ type: "mode", sessionId: this.sessionId, endpoint });
  }

  /** Shown at the top of the panel so the user can recall their question or code context. */
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
