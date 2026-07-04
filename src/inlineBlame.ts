import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

type BlameInfo = {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
};

type FileBlame = Map<number, BlameInfo>;

export function registerInlineBlame(context: vscode.ExtensionContext): void {
  const controller = new InlineBlameController();
  context.subscriptions.push(controller);
}

class InlineBlameController implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2.5em',
      color: 'rgba(128, 128, 128, 0.48)',
      fontStyle: 'italic'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private readonly disposables: vscode.Disposable[] = [];
  private readonly blameCache = new Map<string, FileBlame>();
  private readonly pendingBlame = new Map<string, Promise<FileBlame>>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private requestVersion = 0;

  constructor() {
    this.disposables.push(
      this.decorationType,
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh(0)),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) {
          this.blameCache.delete(document.uri.fsPath);
          this.scheduleRefresh(0);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('giPro.inlineBlame')) {
          this.scheduleRefresh(0);
        }
      })
    );

    this.scheduleRefresh(0);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(delay = this.getDelay()): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    const version = ++this.requestVersion;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.isEnabled() || editor.document.uri.scheme !== 'file') {
      this.clear(editor);
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
      this.clear(editor);
      return;
    }

    const line = editor.selection.active.line;
    if (line < 0 || line >= editor.document.lineCount) {
      this.clear(editor);
      return;
    }

    try {
      const relativePath = path.relative(folder.uri.fsPath, editor.document.uri.fsPath);
      const cachedBlame = this.blameCache.get(editor.document.uri.fsPath)?.get(line);
      if (cachedBlame) {
        this.render(editor, line, cachedBlame);
        return;
      }

      const fileBlame = await this.getFileBlame(folder.uri.fsPath, editor.document.uri.fsPath, relativePath);
      if (version !== this.requestVersion) {
        return;
      }

      const blame = fileBlame.get(line);
      if (!blame) {
        this.clear(editor);
        return;
      }

      this.render(editor, line, blame);
    } catch {
      if (version === this.requestVersion) {
        this.clear(editor);
      }
    }
  }

  private clear(editor = vscode.window.activeTextEditor): void {
    editor?.setDecorations(this.decorationType, []);
  }

  private render(editor: vscode.TextEditor, line: number, blame: BlameInfo): void {
    const text = formatBlame(blame);
    const lineText = editor.document.lineAt(line);
    const range = new vscode.Range(lineText.range.end, lineText.range.end);
    editor.setDecorations(this.decorationType, [
      {
        range,
        hoverMessage: formatHover(blame),
        renderOptions: {
          after: {
            contentText: text
          }
        }
      }
    ]);
  }

  private async getFileBlame(root: string, filePath: string, relativePath: string): Promise<FileBlame> {
    const cached = this.blameCache.get(filePath);
    if (cached) {
      return cached;
    }

    const pending = this.pendingBlame.get(filePath);
    if (pending) {
      return pending;
    }

    const request = getFileBlame(root, relativePath)
      .then((blame) => {
        this.blameCache.set(filePath, blame);
        this.pendingBlame.delete(filePath);
        return blame;
      })
      .catch((error) => {
        this.pendingBlame.delete(filePath);
        throw error;
      });

    this.pendingBlame.set(filePath, request);
    return request;
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('giPro.inlineBlame').get<boolean>('enabled', true);
  }

  private getDelay(): number {
    const delay = vscode.workspace.getConfiguration('giPro.inlineBlame').get<number>('delayMs', 50);
    return Math.max(0, delay);
  }
}

async function getFileBlame(root: string, file: string): Promise<FileBlame> {
  const output = await execGit(root, ['blame', '--line-porcelain', '--', file]);
  if (!output.trim()) {
    return new Map();
  }

  return parseFileBlame(output);
}

function execGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

function parseFileBlame(output: string): FileBlame {
  const blameByLine: FileBlame = new Map();
  const lines = output.split(/\r?\n/);
  let currentLine: number | undefined;
  let current: BlameInfo | undefined;

  for (const line of lines) {
    const header = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/);
    if (header) {
      currentLine = Number(header[2]) - 1;
      current = {
        hash: header[1],
        author: 'Unknown',
        authorTime: 0,
        summary: ''
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('\t')) {
      if (currentLine !== undefined) {
        blameByLine.set(currentLine, current);
      }
      current = undefined;
      currentLine = undefined;
    } else if (line.startsWith('author ')) {
      current.author = line.slice('author '.length).trim() || current.author;
    } else if (line.startsWith('author-time ')) {
      current.authorTime = Number(line.slice('author-time '.length).trim()) || 0;
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length).trim();
    }
  }

  return blameByLine;
}

function formatBlame(blame: BlameInfo): string {
  const time = blame.authorTime ? formatRelativeTime(blame.authorTime) : 'unknown date';
  const summary = truncate(blame.summary, 72);
  const suffix = summary ? ` - ${summary}` : '';
  return `${blame.author}, ${time}${suffix}`;
}

function formatHover(blame: BlameInfo): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  const date = blame.authorTime
    ? new Date(blame.authorTime * 1000).toLocaleString()
    : 'Unknown date';
  markdown.appendMarkdown(`**${escapeMarkdown(blame.author)}**  \n`);
  markdown.appendMarkdown(`${escapeMarkdown(date)}  \n`);
  markdown.appendMarkdown(`\`${escapeMarkdown(blame.hash)}\``);
  if (blame.summary) {
    markdown.appendMarkdown(`  \n${escapeMarkdown(blame.summary)}`);
  }
  return markdown;
}

function formatRelativeTime(seconds: number): string {
  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const month = day * 30;
  const year = day * 365;

  if (diffSeconds < minute) {
    return 'just now';
  }
  if (diffSeconds < hour) {
    return `${Math.floor(diffSeconds / minute)}m ago`;
  }
  if (diffSeconds < day) {
    return `${Math.floor(diffSeconds / hour)}h ago`;
  }
  if (diffSeconds < month) {
    return `${Math.floor(diffSeconds / day)}d ago`;
  }
  if (diffSeconds < year) {
    return `${Math.floor(diffSeconds / month)}mo ago`;
  }
  return `${Math.floor(diffSeconds / year)}y ago`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
