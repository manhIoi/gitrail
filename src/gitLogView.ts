import * as vscode from 'vscode';
import { GitRunner, shellQuote } from './gitRunner';
import { registerBranchDiffView, showBranchDiffInScm } from './logView/branchDiff';
import { setExtensionHome } from './logView/extensionHome';
import { GitLogViewProvider } from './logView/provider';

const gitLogViewId = 'giPro.logView';
const gitLogPanelId = 'giProPanel';

let currentProvider: GitLogViewProvider | undefined;

export function registerGitLogView(context: vscode.ExtensionContext, git: GitRunner): void {
  setExtensionHome(context.extensionUri);
  currentProvider = new GitLogViewProvider(git);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(gitLogViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
  registerBranchDiffView(context, git);
}

export async function showGitLogView(_context: vscode.ExtensionContext, _git: GitRunner): Promise<void> {
  await openGitLogPanel();
  await vscode.commands.executeCommand(`${gitLogViewId}.focus`);
  await currentProvider?.render();
}

export async function showBranchDiffWithWorkingTree(_context: vscode.ExtensionContext, _git: GitRunner, branch: string): Promise<void> {
  await showBranchDiffInScm({ ref: branch, label: `${branch} ↔ Working Tree` });
}

async function openGitLogPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${gitLogPanelId}`);
  } catch {
    // Older cached manifests or VS Code builds may not expose a container focus command.
  }
}

export class GitProContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitRunner) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref, path } = JSON.parse(uri.query) as { ref: string; path: string };
    try {
      return await this.git.exec(`git show ${shellQuote(ref + ':' + path)}`);
    } catch {
      return '';
    }
  }
}
