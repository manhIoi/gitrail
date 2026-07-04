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

  async exec(command: string): Promise<string> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace folder is open.');
    }

    return new Promise((resolve, reject) => {
      cp.exec(command, { cwd: root.fsPath, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
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
    const name = config.get<string>('terminalName', 'GI Pro');
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
