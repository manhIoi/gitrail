import * as vscode from 'vscode';

let extensionHome: vscode.Uri | undefined;

export function setExtensionHome(uri: vscode.Uri): void {
  extensionHome = uri;
}

/** Where the extension is installed - the root the webview loads media/ from. */
export function extensionUri(): vscode.Uri {
  if (!extensionHome) {
    throw new Error('The extension path is unavailable.');
  }
  return extensionHome;
}
