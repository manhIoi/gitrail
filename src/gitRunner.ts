import * as cp from 'node:child_process';
import * as vscode from 'vscode';

export class GitRunner {
  private terminal: vscode.Terminal | undefined;

  async run(command: string): Promise<void> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const terminal = this.getTerminal(root);
    terminal.show(true);
    terminal.sendText(command);
  }

  // `env` is merged over the inherited environment; history-rewriting callers use it to
  // point GIT_SEQUENCE_EDITOR at the bundled rebase editor.
  async exec(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace folder is open.');
    }

    const options: cp.ExecOptionsWithStringEncoding = {
      cwd: root.fsPath,
      maxBuffer: 1024 * 1024 * 10,
      encoding: 'utf8',
      ...(env ? { env: { ...process.env, ...env } } : {})
    };

    return new Promise((resolve, reject) => {
      cp.exec(command, options, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async getWorkspaceRoot(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('Open a folder before running Git commands.');
      return undefined;
    }

    if (folders.length === 1) {
      return folders[0].uri;
    }

    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder
      })),
      { placeHolder: 'Select workspace folder' }
    );

    return selected?.folder.uri;
  }

  private getTerminal(root: vscode.Uri): vscode.Terminal {
    if (this.terminal) {
      return this.terminal;
    }

    const config = vscode.workspace.getConfiguration('giPro');
    const name = config.get<string>('terminalName', 'Gitrail');
    this.terminal = vscode.window.createTerminal({
      name,
      cwd: root.fsPath
    });

    return this.terminal;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Branches that exist to be branched off, so their own names say nothing about how the
// new branch should be named.
const LONG_LIVED_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'dev', 'trunk']);

/**
 * Prefill for a "New Branch" prompt, derived from the ref the branch starts at so the
 * naming convention is already in the box and only the parts that differ need editing.
 * A remote ref drops its remote (`origin/feature/login` → `feature/login`), which is the
 * local name it would get anyway. A long-lived base branch prefills nothing.
 */
export function suggestBranchName(base: string | undefined, branchType: 'local' | 'remote' = 'local'): string {
  const trimmed = (base ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (branchType === 'remote') {
    return trimmed.split('/').slice(1).join('/');
  }
  return LONG_LIVED_BRANCHES.has(trimmed.toLowerCase()) ? '' : trimmed;
}
