import * as vscode from 'vscode';
import { mediaUri } from '../logView/html';
import { getNonce } from '../webviewUtil';
import type { ContributorsState } from './types';

/** The Contributors page. The state rides in an inline script that media/contributors.js reads first. */
export function renderContributorsHtml(webview: vscode.Webview, state: ContributorsState): string {
  const nonce = getNonce();
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  const styleUri = mediaUri(webview, 'contributors.css');
  const scriptUri = mediaUri(webview, 'contributors.js');

  // Same shape as the Log View shell: the nonce carries over to the external stylesheet and
  // script, so the CSP needs no host source. Avatars are initials, so no img-src either.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Contributors</title>
  <link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gitrailContributors = ${json};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
