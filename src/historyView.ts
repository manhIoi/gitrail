import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRunner, shellQuote } from './gitRunner';

type HistoryEntry = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  refs: string[];
  subject: string;
  // Path of the tracked file at this commit (follows renames when known).
  path: string;
};

type HistoryMessage = {
  type?: string;
  hash?: string;
  path?: string;
};

type HistoryState = {
  file: string;
  range?: string;
  entries: HistoryEntry[];
};

const historyViewId = 'giPro.historyView';
let currentProvider: HistoryViewProvider | undefined;

export function registerHistoryView(context: vscode.ExtensionContext): void {
  currentProvider = new HistoryViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(historyViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
  // The history panel stays hidden until a history command is run.
  void vscode.commands.executeCommand('setContext', 'giPro.historyAvailable', false);
}

export async function showFileHistoryView(git: GitRunner, file: string): Promise<void> {
  const entries = await loadFileHistory(git, file);
  await revealHistory({ file, entries });
}

export async function showSelectionHistoryView(git: GitRunner, file: string, startLine: number, endLine: number): Promise<void> {
  const entries = await loadSelectionHistory(git, file, startLine, endLine);
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  await revealHistory({ file, range, entries });
}

async function revealHistory(state: HistoryState): Promise<void> {
  currentProvider?.setState(state);
  await vscode.commands.executeCommand('setContext', 'giPro.historyAvailable', true);
  await vscode.commands.executeCommand(`${historyViewId}.focus`);
  currentProvider?.render();
}

class HistoryViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: HistoryState | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((raw: unknown) => void handleMessage(raw as HistoryMessage));
    this.render();
  }

  setState(state: HistoryState): void {
    this.state = state;
  }

  render(): void {
    if (!this.view) {
      return;
    }
    if (!this.state) {
      this.view.description = undefined;
      this.view.webview.html = renderHistoryHtml(undefined);
      return;
    }
    const suffix = this.state.range ? ` (${this.state.range})` : '';
    this.view.description = `${path.basename(this.state.file)}${suffix}`;
    this.view.webview.html = renderHistoryHtml(this.state);
  }
}

async function loadFileHistory(git: GitRunner, file: string): Promise<HistoryEntry[]> {
  const format = '%x1f%H%x1f%an%x1f%ad%x1f%D%x1f%s';
  const raw = await git.exec(
    `git log --follow --name-status --date=iso-strict --pretty=format:${shellQuote(format)} -n 300 -- ${shellQuote(file)}`
  );

  const entries: HistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseHistoryLine(line, file);
    if (entry) {
      entries.push(entry);
      continue;
    }
    // Name-status line for the followed file: track the path valid at that commit.
    const current = entries[entries.length - 1];
    const match = line.match(/^([A-Z])\d*\t([^\t]+)(?:\t(.+))?$/);
    if (current && match) {
      current.path = match[1] === 'R' && match[3] ? match[3] : match[2];
    }
  }
  return entries;
}

async function loadSelectionHistory(git: GitRunner, file: string, startLine: number, endLine: number): Promise<HistoryEntry[]> {
  const format = '%x1f%H%x1f%an%x1f%ad%x1f%D%x1f%s';
  // -L always emits the tracked hunks; only the \x1f-marked header lines are parsed.
  const raw = await git.exec(
    `git log -L ${shellQuote(`${startLine},${endLine}:${file}`)} --date=iso-strict --pretty=format:${shellQuote(format)} -n 200`
  );

  const entries: HistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseHistoryLine(line, file);
    if (entry) {
      entries.push(entry);
      continue;
    }
    // "+++ b/<path>" inside the -L diff gives the file's path at that commit,
    // which keeps diffs working across renames.
    const current = entries[entries.length - 1];
    if (current && line.startsWith('+++ b/')) {
      current.path = line.slice('+++ b/'.length);
    }
  }
  return entries;
}

function parseHistoryLine(line: string, fallbackPath: string): HistoryEntry | undefined {
  const marker = line.indexOf('\x1f');
  if (marker < 0) {
    return undefined;
  }

  const [hash, author, date, refs, subject] = line.slice(marker + 1).split('\x1f');
  if (!hash || !/^[a-f0-9]{7,40}$/i.test(hash)) {
    return undefined;
  }

  return {
    hash,
    shortHash: hash.slice(0, 8),
    author,
    date,
    refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [],
    subject,
    path: fallbackPath
  };
}

async function handleMessage(message: HistoryMessage): Promise<void> {
  try {
    if (message.type === 'openDiff' && message.hash && message.path) {
      await openCommitFileDiff(message.hash, message.path);
      return;
    }
    if (message.type === 'copyHash' && message.hash) {
      await vscode.env.clipboard.writeText(message.hash);
      vscode.window.showInformationMessage('Commit hash copied.');
    }
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function openCommitFileDiff(hash: string, filePath: string): Promise<void> {
  const fileName = filePath.split('/').pop() || filePath;
  const query = (ref: string) => JSON.stringify({ ref, path: filePath });
  const beforeUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query: query(hash + '^') });
  const afterUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query: query(hash) });
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${fileName} (${hash.slice(0, 8)})`);
}

function renderHistoryHtml(state: HistoryState | undefined): string {
  const nonce = getNonce();
  const entries = state?.entries ?? [];
  const range = state?.range;
  const subtitle = state ? (range ? `${state.file} · ${range}` : state.file) : '';
  const rows = entries.map((entry) => (
    `<div class="row" data-hash="${esc(entry.hash)}" data-path="${esc(entry.path)}" title="${esc(entry.path)}">` +
      `<span class="subject">${esc(entry.subject)}${refLabels(entry.refs)}</span>` +
      `<span class="author">${esc(entry.author)}</span>` +
      `<span class="date">${esc(formatDate(entry.date))}</span>` +
      `<span class="hash">${esc(entry.shortHash)}</span>` +
    '</div>'
  )).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>History</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #15161a);
      --text: var(--vscode-editor-foreground, #d7dce8);
      --muted: var(--vscode-descriptionForeground, #8b92a3);
      --border: var(--vscode-panel-border, #343845);
      --hover-bg: var(--vscode-list-hoverBackground, #2f3b5e);
      --selected-bg: var(--vscode-list-activeSelectionBackground, #04568c);
      --selected-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
      --ref-color: var(--vscode-textLink-foreground, #8db5ff);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      /* VS Code's default webview stylesheet adds "padding: 0 20px". */
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .header {
      position: sticky;
      top: 0;
      padding: 10px 14px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    .header .title { font-weight: 700; }
    .header .sub { color: var(--muted); margin-top: 2px; }
    .row {
      display: grid;
      grid-template-columns: minmax(200px, 1fr) 160px 130px 80px;
      gap: 10px;
      align-items: center;
      height: 26px;
      padding: 0 14px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(255,255,255,0.04));
      overflow: hidden;
    }
    .row:hover { background: var(--hover-bg); }
    .row.active, .row.active:hover {
      background: var(--selected-bg);
      color: var(--selected-fg);
    }
    .row.active .author, .row.active .date, .row.active .hash { color: var(--selected-fg); }
    .subject {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    .refs { margin-left: 8px; color: var(--ref-color); font-weight: 600; font-size: 11px; }
    .author, .date, .hash {
      color: var(--muted);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .hash { font-family: var(--vscode-editor-font-family, monospace); }
    .empty { padding: 18px; color: var(--muted); }
  </style>
</head>
<body>
  ${state
    ? `<div class="header">
    <div class="title">${esc(range ? 'History for Selection' : 'File History')} <span class="sub">${entries.length} commit${entries.length === 1 ? '' : 's'}</span></div>
    <div class="sub">${esc(subtitle)}</div>
  </div>
  ${rows || '<div class="empty">No history found.</div>'}`
    : '<div class="empty">Run "Show File History" or "Show History for Selection" from the editor context menu.</div>'}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.row').forEach((row) => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.row').forEach((other) => other.classList.remove('active'));
        row.classList.add('active');
        vscode.postMessage({ type: 'openDiff', hash: row.dataset.hash, path: row.dataset.path });
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        vscode.postMessage({ type: 'copyHash', hash: row.dataset.hash });
      });
    });
  </script>
</body>
</html>`;
}

function refLabels(refs: string[]): string {
  if (!refs.length) {
    return '';
  }
  const names = refs.slice(0, 2).map((ref) => ref.replace('HEAD -> ', '').trim());
  return `<span class="refs">${names.map(esc).join(' ')}</span>`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return dateStr;
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)} ${hh}:${mm}`;
}

function esc(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char));
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
