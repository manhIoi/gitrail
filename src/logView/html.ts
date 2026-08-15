import * as vscode from 'vscode';
import { extensionUri } from './extensionHome';
import type { ViewState } from './types';

export function renderHtml(webview: vscode.Webview, state: ViewState): string {
  const nonce = getNonce();
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  const styleUri = mediaUri(webview, 'logView.css');
  const scriptUri = mediaUri(webview, 'logView.js');

  // The nonce carries over to the external stylesheet and script, so the CSP needs no
  // host source and stays as tight as it was when both were inlined.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Git Log</title>
  <link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gitrailState = ${json};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
export function mediaUri(webview: vscode.Webview, name: string): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri(), 'media', name));
}
export function renderErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
  </style>
</head>
<body>${escapeHtml(message)}</body>
</html>`;
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char));
}
export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
