import * as vscode from 'vscode';
import { GitRunner, shellQuote } from './gitRunner';

type Branch = {
  name: string;
  type: 'local' | 'remote';
  current: boolean;
  upstream?: string;
};

type Commit = {
  hash: string;
  shortHash: string;
  parents: string[];
  branches: string[];
  graph: string;
  postLines: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
};

type ChangedFile = {
  status: string;
  path: string;
  previousPath?: string;
};

type CommitDetail = {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  refs: string[];
  message: string;
  files: ChangedFile[];
};

type ViewState = {
  root: string;
  selectedBranch?: string;
  selectedCommit?: string;
  branches: Branch[];
  commits: Commit[];
  detail?: CommitDetail;
  error?: string;
};

type WebviewMessage = {
  type?: string;
  branch?: string;
  branchType?: Branch['type'];
  hash?: string;
  hashes?: string[];
  file?: string;
  action?: string;
};

let currentController: GitLogController | undefined;
let currentProvider: GitLogViewProvider | undefined;
const gitLogViewId = 'intellijGit.logView';
const gitLogPanelId = 'intellijGitPanel';

export function registerGitLogView(context: vscode.ExtensionContext, git: GitRunner): void {
  currentProvider = new GitLogViewProvider(git);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(gitLogViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
}

export async function showGitLogView(context: vscode.ExtensionContext, git: GitRunner): Promise<void> {
  await openGitLogPanel();
  await vscode.commands.executeCommand(`${gitLogViewId}.focus`);
  await currentProvider?.render();
}

async function openGitLogPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${gitLogPanelId}`);
  } catch {
    // Older cached manifests or VS Code builds may not expose a container focus command.
  }
}

class GitLogViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private controller: GitLogController | undefined;

  constructor(private readonly git: GitRunner) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const root = await this.git.getWorkspaceRoot();
    if (!root) {
      webviewView.webview.html = renderErrorHtml('Open a folder before opening Git Log.');
      return;
    }

    this.controller = new GitLogController(this.git, webviewView.webview, root.fsPath);
    currentController = this.controller;
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.controller?.handleMessage(message));
    await this.controller.render();
  }

  async render(): Promise<void> {
    await this.controller?.render();
  }
}

class GitLogController {
  private selectedBranch: string | undefined;
  private selectedCommit: string | undefined;
  private readonly outputChannel = vscode.window.createOutputChannel('GI pro Git');

  constructor(
    private readonly git: GitRunner,
    private readonly webview: vscode.Webview,
    private readonly rootPath: string
  ) {}

  async render(): Promise<void> {
    const state = await this.loadState();
    this.webview.html = renderHtml(this.webview, state);
  }

  async handleMessage(raw: unknown): Promise<void> {
    const message = raw as WebviewMessage;
    try {
      if (message.type === 'refresh') {
        await this.render();
        return;
      }

      if (message.type === 'selectBranch') {
        this.selectedBranch = message.branch || undefined;
        this.selectedCommit = undefined;
        await this.render();
        return;
      }

      if (message.type === 'selectCommit' && isCommitHash(message.hash)) {
        this.selectedCommit = message.hash;
        await this.render();
        return;
      }

      if (message.type === 'openDiff' && isCommitHash(this.selectedCommit) && message.file) {
        await this.openFileDiff(this.selectedCommit, message.file);
        return;
      }

      if (message.type === 'checkout' && message.branch) {
        await this.checkoutBranch(message.branch, message.branchType);
        this.selectedBranch = message.branch;
        await this.render();
        return;
      }

      if (message.type === 'branchAction' && message.branch && message.action) {
        await this.runBranchAction(message.action, message.branch, message.branchType);
        await this.render();
        return;
      }

      if (message.type === 'commitAction' && message.action) {
        const hashes = (message.hashes?.length ? message.hashes : message.hash ? [message.hash] : []).filter(isCommitHash);
        if (!hashes.length) {
          return;
        }

        await this.runCommitAction(message.action, hashes);
        if (message.action !== 'copyRevisionNumber') {
          await this.render();
        }
        return;
      }

      if (message.type === 'cherryPick' && isCommitHash(this.selectedCommit)) {
        await this.runGitAction(`git cherry-pick ${this.selectedCommit}`, 'Cherry-pick completed.');
        return;
      }

      if (message.type === 'copyHash' && isCommitHash(this.selectedCommit)) {
        await vscode.env.clipboard.writeText(this.selectedCommit);
        vscode.window.showInformationMessage('Commit hash copied.');
      }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async runCommitAction(action: string, hashes: string[]): Promise<void> {
    const hash = hashes[0];
    const hashArgs = hashes.join(' ');
    switch (action) {
      case 'copyRevisionNumber':
        await vscode.env.clipboard.writeText(hashes.join('\n'));
        vscode.window.showInformationMessage(hashes.length === 1 ? 'Commit hash copied.' : 'Commit hashes copied.');
        return;
      case 'createPatch':
        await this.runGitAction(hashes.map((commit) => `git format-patch -1 ${commit}`).join(' && '), 'Patch created.');
        return;
      case 'cherryPick':
        await this.runGitAction(`git cherry-pick ${hashArgs}`, 'Cherry-pick completed.');
        return;
      case 'checkoutRevision':
        await this.runGitAction(`git checkout ${hash}`, 'Revision checked out.');
        return;
      case 'showRepositoryAtRevision':
        await this.showGitOutput(`git show --stat --decorate ${hash}`, `Repository at ${hash.slice(0, 8)}`);
        return;
      case 'compareWithLocal':
        await this.showGitOutput(`git diff ${hash}`, `Diff with ${hash.slice(0, 8)}`);
        return;
      case 'resetCurrentBranchHere': {
        const answer = await vscode.window.showWarningMessage(`Reset current branch to ${hash.slice(0, 8)}?`, { modal: true }, 'Reset');
        if (answer === 'Reset') {
          await this.runGitAction(`git reset --hard ${hash}`, 'Current branch reset.');
        }
        return;
      }
      case 'revertCommit':
        await this.runGitAction(`git revert ${hashArgs}`, 'Revert completed.');
        return;
      case 'pushAllUpToHere':
        await this.runGitAction('git push', 'Push completed.');
        return;
      case 'rebaseCurrentOnto':
        await this.runGitAction(`git rebase ${hash}`, 'Rebase completed.');
        return;
      case 'newBranch':
        await this.newBranchFromCommit(hash);
        return;
      case 'newTag':
        await this.newTagAtCommit(hash);
        return;
      default:
        return;
    }
  }

  private async runBranchAction(action: string, branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    const currentBranch = await this.getCurrentBranch();
    switch (action) {
      case 'checkout':
        await this.checkoutBranch(branch, branchType);
        this.selectedBranch = branch;
        return;
      case 'newBranchFrom':
        await this.newBranchFrom(branch);
        return;
      case 'checkoutRebaseOnto':
        if (currentBranch) {
          await this.runGitAction(`git checkout ${shellQuote(branch)} && git rebase ${shellQuote(currentBranch)}`, 'Checkout and rebase completed.');
        }
        return;
      case 'compareWithCurrent':
        if (currentBranch) {
          await this.showGitOutput(`git log --left-right --cherry-pick --oneline ${shellQuote(currentBranch)}...${shellQuote(branch)}`, `Compare ${currentBranch}...${branch}`);
        }
        return;
      case 'diffWithWorkingTree':
        await this.showGitOutput(`git diff ${shellQuote(branch)}`, `Diff with ${branch}`);
        return;
      case 'rebaseCurrentOnto':
        await this.runGitAction(`git rebase ${shellQuote(branch)}`, 'Rebase completed.');
        return;
      case 'mergeIntoCurrent':
        await this.runGitAction(`git merge --no-ff ${shellQuote(branch)}`, 'Merge completed.');
        return;
      case 'update':
        await this.updateBranch(branch, branchType);
        return;
      case 'push':
        await this.pushBranch(branch, branchType);
        return;
      case 'rename':
        await this.renameBranch(branch, branchType);
        return;
      case 'delete':
        await this.deleteBranch(branch, branchType);
        return;
      default:
        return;
    }
  }

  private async checkoutBranch(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    const command = branchType === 'remote'
      ? `git checkout -t ${shellQuote(branch)}`
      : `git checkout ${shellQuote(branch)}`;
    await this.runGitAction(command, 'Branch checked out.');
  }

  private async newBranchFrom(branch: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${branch}`,
      placeHolder: 'feature/my-branch',
      ignoreFocusOut: true,
      validateInput: validateBranchName
    });
    if (name) {
      await this.runGitAction(`git checkout -b ${shellQuote(name)} ${shellQuote(branch)}`, 'Branch created.');
      this.selectedBranch = name;
    }
  }

  private async newBranchFromCommit(hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${hash.slice(0, 8)}`,
      placeHolder: 'feature/my-branch',
      ignoreFocusOut: true,
      validateInput: validateBranchName
    });
    if (name) {
      await this.runGitAction(`git checkout -b ${shellQuote(name)} ${hash}`, 'Branch created.');
      this.selectedBranch = name;
    }
  }

  private async newTagAtCommit(hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New tag at ${hash.slice(0, 8)}`,
      placeHolder: 'v1.0.0',
      ignoreFocusOut: true,
      validateInput: validateRefName
    });
    if (name) {
      await this.runGitAction(`git tag ${shellQuote(name)} ${hash}`, 'Tag created.');
    }
  }

  private async updateBranch(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    if (branchType === 'remote') {
      await this.runGitAction('git fetch --all --prune', 'Remote branches updated.');
      return;
    }

    await this.runGitAction(`git checkout ${shellQuote(branch)} && git pull --ff-only`, 'Branch updated.');
    this.selectedBranch = branch;
  }

  private async pushBranch(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    if (branchType === 'remote') {
      vscode.window.showInformationMessage('Remote branches cannot be pushed directly. Checkout a local branch first.');
      return;
    }

    await this.runGitAction(`git push -u origin ${shellQuote(branch)}`, 'Branch pushed.');
  }

  private async renameBranch(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    if (branchType === 'remote') {
      vscode.window.showInformationMessage('Remote branches cannot be renamed directly.');
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: `Rename ${branch}`,
      value: branch,
      ignoreFocusOut: true,
      validateInput: validateBranchName
    });
    if (name && name !== branch) {
      await this.runGitAction(`git branch -m ${shellQuote(branch)} ${shellQuote(name)}`, 'Branch renamed.');
      this.selectedBranch = name;
    }
  }

  private async deleteBranch(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    const currentBranch = await this.getCurrentBranch();
    if (branch === currentBranch) {
      vscode.window.showInformationMessage('The current branch cannot be deleted.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(`Delete branch ${branch}?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') {
      return;
    }

    const remote = remoteBranchParts(branch);
    const command = branchType === 'remote' && remote
      ? `git push ${shellQuote(remote.remote)} --delete ${shellQuote(remote.name)}`
      : `git branch -d ${shellQuote(branch)}`;
    await this.runGitAction(command, 'Branch deleted.');
    if (this.selectedBranch === branch) {
      this.selectedBranch = undefined;
    }
  }

  private async runGitAction(command: string, successMessage?: string): Promise<string> {
    const output = await this.git.exec(command);
    if (successMessage) {
      vscode.window.showInformationMessage(successMessage);
    }
    return output;
  }

  private async showGitOutput(command: string, title: string): Promise<void> {
    const output = await this.git.exec(command);
    this.outputChannel.clear();
    this.outputChannel.appendLine(`$ ${command}`);
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine(output || '(no output)');
    this.outputChannel.show(true);
    vscode.window.showInformationMessage(`${title} opened in GI pro Git output.`);
  }

  private async getCurrentBranch(): Promise<string | undefined> {
    const output = await this.git.exec('git branch --show-current');
    return output.trim() || undefined;
  }

  private async openFileDiff(hash: string, filePath: string): Promise<void> {
    const fileName = filePath.split('/').pop() || filePath;
    const query = (ref: string) => JSON.stringify({ ref, path: filePath });
    const beforeUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query: query(hash + '^') });
    const afterUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query: query(hash) });
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${fileName} (${hash.slice(0, 8)})`);
  }

  private async loadState(): Promise<ViewState> {
    try {
      const branches = await this.loadBranches();
      const commits = await this.loadCommits(branches);
      const selectedCommit = this.selectVisibleCommit(commits);
      this.selectedCommit = selectedCommit;
      const detail = selectedCommit ? await this.loadCommitDetail(selectedCommit) : undefined;

      return {
        root: this.rootPath,
        selectedBranch: this.selectedBranch,
        selectedCommit,
        branches,
        commits,
        detail
      };
    } catch (error) {
      return {
        root: this.rootPath,
        selectedBranch: this.selectedBranch,
        selectedCommit: this.selectedCommit,
        branches: [],
        commits: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async loadBranches(): Promise<Branch[]> {
    const local = await this.git.exec('git branch --format="%(refname:short)%09%(HEAD)"');
    const remote = await this.git.exec('git branch -r --format="%(refname:short)"');
    const branches: Branch[] = [];

    for (const line of splitLines(local)) {
      const [name, head] = line.split('\t');
      if (name) {
        branches.push({ name, type: 'local', current: head === '*' });
      }
    }

    for (const line of splitLines(remote)) {
      const name = line.trim();
      if (name && !name.includes('HEAD ->')) {
        branches.push({ name, type: 'remote', current: false });
      }
    }

    return branches;
  }

  private selectVisibleCommit(commits: Commit[]): string | undefined {
    if (this.selectedCommit && commits.some((commit) => commit.hash === this.selectedCommit)) {
      return this.selectedCommit;
    }

    if (this.selectedBranch) {
      const branchCommit = commits.find((commit) => commit.branches.includes(this.selectedBranch!));
      if (branchCommit) {
        return branchCommit.hash;
      }
    }

    return commits[0]?.hash;
  }

  private async loadCommits(branches: Branch[]): Promise<Commit[]> {
    const target = '--all --exclude=refs/stash';
    const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
    const raw = await this.git.exec(`git log --graph --date-order --decorate --date=iso-strict --pretty=format:${shellQuote(format)} -n 300 ${target}`);

    const commits: Commit[] = [];
    for (const line of raw.split(/\r?\n/).map((l) => l.trimEnd())) {
      if (line.includes('\x1f')) {
        const commit = parseCommitLine(line);
        if (commit) commits.push(commit);
      } else if (line && commits.length > 0) {
        commits[commits.length - 1].postLines.push(line);
      }
    }
    await this.assignCommitBranches(commits, branches);
    return commits;
  }

  private async assignCommitBranches(commits: Commit[], branches: Branch[]): Promise<void> {
    const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
    if (!commitsByHash.size) {
      return;
    }

    await Promise.all(branches.map(async (branch) => {
      try {
        const output = await this.git.exec(`git rev-list -n 1000 ${shellQuote(branch.name)}`);
        for (const hash of splitLines(output)) {
          const commit = commitsByHash.get(hash);
          if (commit) {
            commit.branches.push(branch.name);
          }
        }
      } catch {
        // Ignore deleted or otherwise unreadable refs during a refresh.
      }
    }));
  }

  private async loadCommitDetail(hash: string): Promise<CommitDetail> {
    const summary = await this.git.exec(`git show -s --date=iso-strict --format=${shellQuote('%H%n%P%n%an%n%ae%n%ad%n%cn%n%ce%n%cd%n%D%n%B')} ${hash}`);
    const filesOutput = await this.git.exec(`git diff-tree --no-commit-id --name-status -r -M ${hash}`);
    const files = splitLines(filesOutput).map(parseChangedFile).filter((file): file is ChangedFile => Boolean(file));

    const [fullHash, parents, author, authorEmail, authorDate, committer, committerEmail, committerDate, refs, ...message] = summary.split('\n');
    return {
      hash: fullHash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      authorEmail,
      authorDate,
      committer,
      committerEmail,
      committerDate,
      refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [],
      message: message.join('\n').trim(),
      files
    };
  }
}

function parseCommitLine(line: string): Commit | undefined {
  const marker = line.indexOf('\x1f');
  if (marker < 0) {
    return undefined;
  }

  const graph = line.slice(0, marker).trimEnd();
  const [hash, parents, author, date, refs, subject] = line.slice(marker + 1).split('\x1f');
  if (!isCommitHash(hash)) {
    return undefined;
  }

  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    branches: [],
    graph,
    postLines: [],
    subject,
    author,
    date,
    refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : []
  };
}

function parseChangedFile(line: string): ChangedFile | undefined {
  const [status, first, second] = line.split('\t');
  if (!status || !first) {
    return undefined;
  }

  if (status.startsWith('R') && second) {
    return { status, previousPath: first, path: second };
  }

  return { status, path: first };
}

function renderHtml(webview: vscode.Webview, state: ViewState): string {
  const nonce = getNonce();
  const json = JSON.stringify(state).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Git Log</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #15161a);
      --panel: var(--vscode-sideBar-background, var(--vscode-editor-background, #1c1e24));
      --panel-2: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #232631));
      --border: var(--vscode-panel-border, var(--vscode-editorGroup-border, #343845));
      --text: var(--vscode-editor-foreground, #d7dce8);
      --muted: var(--vscode-descriptionForeground, #8b92a3);
      --accent: var(--vscode-textLink-foreground, #6ea8fe);
      --green: #62c073;
      --orange: #d9a441;
      --red: #ef6b73;
      --purple: #b18cff;
      --toolbar-bg: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #181a20));
      --search-bg: var(--vscode-input-background, #101116);
      --hover-bg: var(--vscode-list-hoverBackground, #2f3b5e);
      --context-bg: var(--vscode-menu-background, var(--vscode-editor-background, #242630));
      --context-border: var(--vscode-menu-border, var(--vscode-panel-border, #4a5060));
      --context-hover: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #3a4771));
      --card-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #191b20));
      --commit-title: var(--vscode-textLink-foreground, #8db5ff);
      --folder-fg: var(--vscode-editor-foreground, #cfd5e3);
      --dot-stroke: var(--vscode-editor-background, #15161a);
      --ref-color: #c7b7ff;
      --add-color: #88d38f;
      --del-color: #ff8b91;
      --hunk-color: #91b4ff;
      --row-border: var(--vscode-editorGroup-border, rgba(255,255,255,0.04));
      --branch-icon: #69b8f5;
      --current-icon: #f4c542;
      --tag-icon: #8dc9c3;
    }
    body.vscode-dark { color-scheme: dark; }
    body.vscode-light {
      color-scheme: light;
      --green: #1e7a1e;
      --orange: #8a6000;
      --red: #bc2929;
      --purple: #5c2d91;
      --ref-color: #5c2d91;
      --add-color: #1e7a1e;
      --del-color: #bc2929;
      --hunk-color: #0066bb;
      --branch-icon: #0066bb;
      --current-icon: #a06000;
      --tag-icon: #1a7a80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      font-size: 11px;
      overflow: hidden;
    }
    button, input {
      font: inherit;
    }
    .app {
      display: grid;
      grid-template-columns: var(--sidebar-width, 280px) 6px minmax(460px, 1fr) 6px var(--detail-width, 420px);
      height: 100vh;
      min-width: 980px;
    }
    .sidebar, .commits, .detail {
      min-height: 0;
      background: var(--panel);
    }
    .pane-resizer {
      position: relative;
      min-width: 6px;
      background: var(--panel);
      cursor: col-resize;
      user-select: none;
      z-index: 20;
    }
    .pane-resizer::before {
      content: '';
      position: absolute;
      inset: 0 2px;
      background: var(--border);
    }
    .pane-resizer:hover::before,
    .pane-resizer.dragging::before {
      inset: 0 1px;
      background: var(--accent);
    }
    body.resizing-pane {
      cursor: col-resize;
      user-select: none;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      height: 42px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--toolbar-bg);
    }
    .commit-toolbar {
      gap: 10px;
      overflow: visible;
    }
    .search {
      width: 100%;
      min-width: 0;
      padding: 6px 8px;
      color: var(--text);
      background: var(--search-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      outline: none;
    }
    .commit-search-wrap {
      display: flex;
      align-items: center;
      flex: 0 1 340px;
      min-width: 220px;
      height: 30px;
      color: var(--text);
      background: var(--search-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .commit-search-icon {
      width: 30px;
      flex: 0 0 30px;
      display: grid;
      place-items: center;
      color: var(--text);
      font-size: 18px;
    }
    .commit-search {
      min-width: 0;
      flex: 1 1 auto;
      padding: 6px 4px;
      color: var(--text);
      background: transparent;
      border: 0;
      outline: none;
    }
    .clear-button {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      flex: 0 0 24px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
    }
    .clear-button:hover {
      color: var(--text);
      background: var(--panel-2);
    }
    .clear-button[hidden] {
      display: none;
    }
    .filter-toggle {
      width: 30px;
      height: 28px;
      display: grid;
      place-items: center;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-left: 1px solid transparent;
      cursor: pointer;
      font-weight: 700;
    }
    .filter-toggle:hover,
    .filter-toggle.active {
      color: var(--text);
      background: var(--panel-2);
    }
    .filter-dropdown {
      position: relative;
      flex: 0 0 auto;
    }
    .filter-dropdown-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 30px;
      padding: 0 6px;
      color: var(--muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 700;
      white-space: nowrap;
      line-height: 1;
    }
    .filter-label {
      display: inline-flex;
      align-items: center;
      line-height: 1;
    }
    .filter-dropdown-button:hover,
    .filter-dropdown.open .filter-dropdown-button,
    .filter-dropdown-button.active {
      color: var(--text);
      background: var(--panel-2);
      border-color: var(--border);
    }
    .filter-chevron {
      position: relative;
      display: inline-block;
      width: 14px;
      height: 14px;
      color: inherit;
      font-size: 0;
      line-height: 0;
    }
    .filter-chevron::before {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: translate(-50%, -50%) rotate(45deg);
      transform-origin: center;
    }
    .filter-clear {
      width: 16px;
      height: 16px;
      display: inline-grid;
      place-items: center;
      margin-left: 1px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
    }
    .filter-clear:hover {
      background: var(--panel);
    }
    .filter-menu {
      position: absolute;
      top: calc(100% + 5px);
      left: 0;
      z-index: 40;
      width: 260px;
      max-height: 340px;
      display: none;
      padding: 6px;
      color: var(--text);
      background: var(--context-bg);
      border: 1px solid var(--context-border);
      border-radius: 6px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
      overflow: auto;
    }
    .filter-menu-search {
      width: 100%;
      margin-bottom: 6px;
      padding: 6px 8px;
      color: var(--text);
      background: var(--search-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      outline: none;
    }
    .filter-dropdown.open .filter-menu {
      display: block;
    }
    .filter-option {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    .filter-option:hover {
      background: var(--context-hover);
    }
    .filter-option input {
      margin: 0;
    }
    .filter-option span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .icon-button {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      color: var(--text);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
    }
    .icon-button:hover, .text-button:hover {
      background: var(--panel-2);
      border-color: var(--border);
    }
    .text-button {
      color: var(--text);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .section-title {
      padding: 12px 14px 6px;
      color: var(--muted);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 11px;
    }
    .branch-list, .commit-list, .file-list {
      overflow: auto;
      min-height: 0;
    }
    .branch-list { height: calc(100vh - 42px); }
    .tree-row, .branch {
      display: flex;
      gap: 8px;
      align-items: center;
      min-height: 30px;
      padding: 5px 12px;
      cursor: pointer;
      color: var(--text);
    }
    .tree-row:hover, .tree-row.active, .branch:hover, .branch.active, .commit-row:hover, .commit-row.active, .file-row:hover, .file-row.active {
      background: var(--hover-bg);
    }
    .tree-row.folder {
      color: var(--folder-fg);
      font-weight: 700;
    }
    .tree-row.file {
      font-weight: 500;
    }
    .tree-row.hidden-by-search {
      display: none;
    }
    .context-menu {
      position: fixed;
      z-index: 50;
      min-width: 320px;
      max-width: min(560px, calc(100vw - 16px));
      padding: 4px 0;
      color: var(--text);
      background: var(--context-bg);
      border: 1px solid var(--context-border);
      border-radius: 6px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
    }
    .context-menu[hidden] {
      display: none;
    }
    .context-menu-item {
      width: 100%;
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 30px;
      padding: 5px 14px;
      color: inherit;
      background: transparent;
      border: 0;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .context-menu-icon {
      width: 18px;
      text-align: center;
      color: var(--branch-icon);
    }
    .context-menu-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .context-menu-shortcut {
      color: var(--muted);
    }
    .context-menu-item:hover,
    .context-menu-item:focus {
      background: var(--context-hover);
      outline: none;
    }
    .context-menu-item:disabled {
      color: var(--muted);
      cursor: default;
      opacity: 0.62;
    }
    .context-menu-item:disabled:hover,
    .context-menu-item:disabled:focus {
      background: transparent;
    }
    .context-menu-separator {
      height: 1px;
      margin: 4px 0;
      background: var(--border);
    }
    .tree-icon {
      width: 16px;
      flex: 0 0 16px;
      text-align: center;
      color: var(--muted);
    }
    .tree-chevron {
      width: 14px;
      flex: 0 0 14px;
      position: relative;
      display: block;
      color: var(--text);
      font-weight: 700;
      font-size: 0;
      line-height: 0;
      align-self: stretch;
    }
    .tree-chevron::before {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: translate(-50%, -50%) rotate(45deg);
      transform-origin: center;
    }
    .tree-row[data-collapsed="true"] > .tree-chevron::before {
      transform: translate(-50%, -50%) rotate(-45deg);
    }
    .branch > .tree-chevron::before,
    .file > .tree-chevron::before {
      display: none;
    }
    .tree-icon.folder-icon {
      width: 18px;
      flex-basis: 18px;
      color: var(--folder-fg);
    }
    .tree-icon.branch-icon {
      color: var(--branch-icon);
      font-size: 15px;
    }
    .tree-icon.current-icon {
      color: var(--current-icon);
      font-size: 15px;
    }
    .tree-icon.tag-icon {
      color: var(--tag-icon);
      font-size: 15px;
    }
    .tree-level-0 { padding-left: 12px; }
    .tree-level-1 { padding-left: 24px; }
    .tree-level-2 { padding-left: 36px; }
    .tree-level-3 { padding-left: 48px; }
    .tree-level-4 { padding-left: 60px; }
    .tree-level-5 { padding-left: 72px; }
    .tree-level-6 { padding-left: 84px; }
    .tree-level-7 { padding-left: 96px; }
    .tree-level-8 { padding-left: 108px; }
    .tree-level-9 { padding-left: 120px; }
    .tree-level-10 { padding-left: 132px; }
    .tree-name, .branch .name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .branch .meta {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
    }
    .commit-list {
      height: calc(100vh - 42px);
      position: relative;
    }
    .commit-row {
      display: grid;
      grid-template-columns: 150px minmax(100px, 1fr) 150px 120px;
      gap: 8px;
      height: 22px;
      align-items: center;
      padding: 0 10px 0 0;
      cursor: pointer;
      border-bottom: 1px solid var(--row-border);
      overflow: hidden;
    }
    .graph-row {
      display: none;
      height: 0;
      overflow: hidden;
    }
    .graph-row.angled {
      height: 0;
    }
    .graph {
      width: 150px;
      height: 22px;
    }
    .graph-layer {
      position: absolute;
      inset: 0 auto auto 0;
      width: 150px;
      pointer-events: none;
      z-index: 2;
      overflow: hidden;
    }
    .graph-layer svg {
      display: block;
      width: 150px;
    }
    .graph-line {
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.95;
    }
    .graph-dot {
      stroke: var(--dot-stroke);
      stroke-width: 2;
    }
    .subject {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    .refs {
      display: inline-flex;
      gap: 4px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .ref {
      color: var(--ref-color);
      font-size: 11px;
      font-weight: 600;
    }
    .author, .date {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .commit-row.is-merge .subject {
      color: var(--muted);
      font-weight: 400;
      font-style: italic;
    }
    .detail {
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .commit-card {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
    }
    .commit-title {
      margin-bottom: 10px;
      color: var(--commit-title);
      font-weight: 700;
      line-height: 1.35;
    }
    .kv {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 5px 10px;
      color: var(--muted);
      line-height: 1.35;
    }
    .kv span:nth-child(even) {
      color: var(--text);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-row {
      display: flex;
      gap: 8px;
      align-items: center;
      min-height: 30px;
      cursor: pointer;
    }
    .status {
      width: 38px;
      flex: 0 0 38px;
      font-weight: 700;
      color: var(--accent);
    }
    .status.A { color: var(--green); }
    .status.D { color: var(--red); }
    .status.M { color: var(--orange); }
    .status.R { color: var(--purple); }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty, .error {
      padding: 18px;
      color: var(--muted);
    }
    .error {
      color: var(--red);
    }
    @media (max-width: 1180px) {
      .app {
        grid-template-columns: var(--sidebar-width, 220px) 6px minmax(320px, 1fr) 6px var(--detail-width, 340px);
      }
      .commit-row { grid-template-columns: 120px minmax(100px, 1fr) 130px 100px; }
      .graph, .graph-layer, .graph-layer svg { width: 120px; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
	    const vscode = acquireVsCodeApi();
	    const state = ${json};
	    const currentBranch = state.branches.find((branch) => branch.current)?.name;
	    const persistedViewState = vscode.getState() || {};
	    const commitFilters = {
	      query: persistedViewState.commitFilters?.query || '',
	      matchCase: Boolean(persistedViewState.commitFilters?.matchCase),
	      regex: Boolean(persistedViewState.commitFilters?.regex),
	      branches: new Set(persistedViewState.commitFilters?.branches || []),
	      users: new Set(persistedViewState.commitFilters?.users || [])
	    };
	    const paneSizes = {
	      sidebar: persistedViewState.paneSizes?.sidebar || 280,
	      detail: persistedViewState.paneSizes?.detail || 420
	    };
	    const selectedCommitHashes = new Set(state.selectedCommit ? [state.selectedCommit] : []);
	    let lastSelectedCommitHash = state.selectedCommit;

	    function send(message) {
	      vscode.postMessage(message);
	    }

	    function persistViewState() {
	      vscode.setState({
	        commitFilters: {
	          query: commitFilters.query,
	          matchCase: commitFilters.matchCase,
	          regex: commitFilters.regex,
	          branches: Array.from(commitFilters.branches),
	          users: Array.from(commitFilters.users)
	        },
	        paneSizes
	      });
	    }

    function html(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const now = new Date();
      // Use Date.UTC with local components on both sides to avoid DST arithmetic errors
      const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const commitMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((todayMs - commitMs) / 86400000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const time = hh + ':' + mm;
      if (diff <= 0) return time;
      if (diff === 1) return 'yesterday ' + time;
      if (diff <= 3) return diff + ' days ' + time;
      return d.getDate() + '/' + (d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' ' + time;
    }

    function formatDetailDate(isoStr) {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return d.getDate() + '/' + (d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' at ' + hh + ':' + mm;
    }

	    function refLabels(refs) {
	      if (!refs || refs.length === 0) return '';
	      return '<span class="refs">' + refs.slice(0, 3).map((ref) => '<span class="ref">' + html(ref.replace('HEAD -> ', '')) + '</span>').join('') + '</span>';
	    }

	    function refName(ref) {
	      return String(ref || '').replace('HEAD -> ', '').trim();
	    }

	    function branchFilterOptions() {
	      return state.branches.map((branch) => branch.name).sort((a, b) => a.localeCompare(b));
	    }

	    function userFilterOptions() {
	      return Array.from(new Set(state.commits.map((commit) => commit.author).filter(Boolean))).sort((a, b) => a.localeCompare(b));
	    }

	    function filterButtonLabel(label, selectedCount) {
	      return '<span class="filter-label">' + html(label + (selectedCount ? ' ' + selectedCount : '')) + '</span>' +
	        (selectedCount ? '<span class="filter-clear" role="button" title="Clear ' + html(label.toLowerCase()) + '" data-filter-clear="' + html(label.toLowerCase()) + '">×</span>' : '') +
	        '<span class="filter-chevron" aria-hidden="true"></span>';
	    }

	    function renderFilterDropdown(kind, label, options, selected) {
	      const active = selected.size > 0 ? ' active' : '';
	      const items = options.map((option) => {
	        const checked = selected.has(option) ? ' checked' : '';
	        return '<label class="filter-option" title="' + html(option) + '" data-filter-option-row="' + html(option.toLowerCase()) + '">' +
	          '<input type="checkbox" data-filter-option="' + html(kind) + '" value="' + html(option) + '"' + checked + '>' +
	          '<span>' + html(option) + '</span>' +
	        '</label>';
	      }).join('');
	      return '<div class="filter-dropdown" data-filter-dropdown="' + html(kind) + '">' +
	        '<button class="filter-dropdown-button' + active + '" type="button" data-filter-toggle="' + html(kind) + '">' + filterButtonLabel(label, selected.size) + '</button>' +
	        '<div class="filter-menu">' +
	          '<input class="filter-menu-search" data-filter-menu-search="' + html(kind) + '" placeholder="Search ' + html(label.toLowerCase()) + '">' +
	          (items || '<div class="empty">No options</div>') +
	        '</div>' +
	      '</div>';
	    }

	    function renderCommitToolbar() {
	      return '<div class="toolbar commit-toolbar">' +
	        '<div class="commit-search-wrap">' +
	          '<span class="commit-search-icon">⌕</span>' +
	          '<input id="commitSearch" class="commit-search" placeholder="Filter by commit message or hash">' +
	          '<button id="commitSearchClear" class="clear-button" type="button" title="Clear filter" hidden>×</button>' +
	          '<button class="filter-toggle" type="button" title="Match case" data-filter-flag="matchCase">Aa</button>' +
	          '<button class="filter-toggle" type="button" title="Match regex" data-filter-flag="regex">.*</button>' +
	        '</div>' +
	        renderFilterDropdown('branches', 'Branch', branchFilterOptions(), commitFilters.branches) +
	        renderFilterDropdown('users', 'User', userFilterOptions(), commitFilters.users) +
	        '<button class="icon-button" title="Refresh" data-action="refresh">↻</button>' +
	        '</div>';
	    }

    function renderBranches() {
      const groups = [
        ['HEAD', state.branches.filter((branch) => branch.current)],
        ['Local', state.branches.filter((branch) => branch.type === 'local' && !branch.current)],
        ['Remote', state.branches.filter((branch) => branch.type === 'remote')]
      ];
      return groups.map(([title, branches]) => {
        const rows = renderBranchTree(buildBranchTree(branches));
        return '<div class="section-title">' + title + '</div>' + (rows || '<div class="empty">No branches</div>');
      }).join('');
    }

    function buildBranchTree(branches) {
      const root = { folders: new Map(), branches: [] };
      branches.forEach((branch) => {
        const parts = branch.name.split('/').filter(Boolean);
        let node = root;
        parts.slice(0, -1).forEach((part) => {
          if (!node.folders.has(part)) {
            node.folders.set(part, { name: part, folders: new Map(), branches: [] });
          }
          node = node.folders.get(part);
        });
        node.branches.push({ ...branch, displayName: parts.at(-1) || branch.name });
      });
      return root;
    }

    function renderBranchTree(node, depth = 0) {
      const entries = [
        ...Array.from(node.folders.values()).map((folder) => ({ kind: 'folder', name: folder.name, folder })),
        ...node.branches.map((branch) => ({ kind: 'branch', name: branch.displayName, branch }))
      ].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));

      return entries.map((entry) => {
        if (entry.kind === 'folder') {
          const folder = entry.folder;
          return '<div class="tree-row folder ' + treeLevel(depth) + '" data-branch-folder data-tree="branch" data-depth="' + depth + '">' +
            '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon folder-icon">' + folderIcon() + '</span><span class="tree-name">' + html(folder.name) + '</span>' +
          '</div>' + renderBranchTree(folder, depth + 1);
        }

        const branch = entry.branch;
        const active = state.selectedBranch === branch.name || (!state.selectedBranch && branch.current);
        const iconClass = branch.current || branch.displayName === 'main' || branch.displayName === 'master' ? 'current-icon' : branch.displayName.includes('responsive') ? 'tag-icon' : 'branch-icon';
        const icon = branch.current || branch.displayName === 'main' || branch.displayName === 'master' ? '★' : branch.displayName.includes('responsive') ? tagIcon() : branchIcon();
        return '<div class="tree-row branch ' + treeLevel(depth) + ' ' + (active ? 'active' : '') + '" data-branch="' + html(branch.name) + '" data-branch-type="' + html(branch.type) + '" data-branch-current="' + String(Boolean(branch.current)) + '" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon ' + iconClass + '">' + icon + '</span><span class="tree-name">' + html(branch.displayName) + '</span>' +
        '</div>';
      }).join('');
    }

    function renderBranchContextMenu() {
      return '<div id="branchContextMenu" class="context-menu" hidden></div>';
    }

    function renderCommitContextMenu() {
      return '<div id="commitContextMenu" class="context-menu" hidden></div>';
    }

    function branchContextItems(branch, branchType, isCurrent) {
      const selected = "'" + branch + "'";
      const current = currentBranch ? "'" + currentBranch + "'" : 'current branch';
      const noCurrent = !currentBranch;
      const isRemote = branchType === 'remote';
      return [
        { label: 'Checkout', action: 'checkout', disabled: isCurrent },
        { label: 'New Branch from ' + selected + '...', action: 'newBranchFrom' },
        { label: 'Checkout and Rebase onto ' + current, action: 'checkoutRebaseOnto', disabled: isCurrent || isRemote || noCurrent },
        { separator: true },
        { label: 'Compare with ' + current, action: 'compareWithCurrent', disabled: noCurrent || branch === currentBranch },
        { label: 'Show Diff with Working Tree', action: 'diffWithWorkingTree' },
        { separator: true },
        { label: 'Rebase ' + current + ' onto ' + selected, action: 'rebaseCurrentOnto', disabled: noCurrent || branch === currentBranch },
        { label: 'Merge ' + selected + ' into ' + current, action: 'mergeIntoCurrent', disabled: noCurrent || branch === currentBranch },
        { separator: true },
        { label: 'Update', action: 'update' },
        { label: 'Push...', action: 'push', disabled: isRemote },
        { separator: true },
        { label: 'Rename...', action: 'rename', disabled: isRemote },
        { label: 'Delete', action: 'delete', disabled: isCurrent }
      ];
    }

    function commitContextItems(hashes) {
      const current = currentBranch || 'current branch';
      const multi = hashes.length > 1;
      return [
        { label: multi ? 'Copy Revision Numbers' : 'Copy Revision Number', action: 'copyRevisionNumber', icon: '⧉' },
        { label: 'Create Patch...', action: 'createPatch', icon: '⌘' },
        { label: 'Cherry-Pick', action: 'cherryPick', icon: '●' },
        { separator: true },
        { label: 'Checkout Revision', action: 'checkoutRevision', disabled: multi },
        { label: 'Show Repository at Revision', action: 'showRepositoryAtRevision', disabled: multi },
        { label: 'Compare with Local', action: 'compareWithLocal', disabled: multi },
        { separator: true },
        { label: 'Reset Current Branch to Here...', action: 'resetCurrentBranchHere', icon: '↶', disabled: multi },
        { label: multi ? 'Revert Commits' : 'Revert Commit', action: 'revertCommit' },
        { label: 'Undo Commit...', action: 'undoCommit', disabled: true },
        { separator: true },
        { label: 'Edit Commit Message...', action: 'editCommitMessage', disabled: true, shortcut: 'F2' },
        { label: 'Fixup...', action: 'fixup', disabled: true },
        { label: 'Squash Into...', action: 'squashInto', disabled: true },
        { label: 'Drop Commits', action: 'dropCommits', disabled: true },
        { label: 'Squash Commits...', action: 'squashCommits', disabled: true },
        { label: 'Interactively Rebase from Here...', action: 'interactiveRebaseFromHere', disabled: true },
        { label: 'Push All up to Here...', action: 'pushAllUpToHere', disabled: multi },
        { separator: true },
        { label: "Rebase '" + current + "' onto Selected Commit", action: 'rebaseCurrentOnto', disabled: multi },
        { label: 'New Branch...', action: 'newBranch', disabled: multi },
        { label: 'New Tag...', action: 'newTag', disabled: multi },
        { separator: true },
        { label: 'Go to Child Commit', action: 'goChild', clientAction: true, disabled: multi },
        { label: 'Go to Parent Commit', action: 'goParent', clientAction: true, disabled: multi }
      ];
    }

	    function renderCommits(commits = state.commits) {
	      if (state.error) return '<div class="error">' + html(state.error) + '</div>';
	      if (!commits.length) return '<div class="empty">No commits found</div>';
	      let rows = '';
	      commits.forEach((commit) => {
	        const active = selectedCommitHashes.has(commit.hash);
	        const isMerge = commit.parents.length > 1;
	        rows += '<div class="commit-row' + (isMerge ? ' is-merge' : '') + (active ? ' active' : '') + '" data-hash="' + html(commit.hash) + '">' +
          '<div class="graph"></div>' +
          '<div class="subject">' + html(commit.subject) + refLabels(commit.refs) + '</div>' +
          '<div class="author">' + html(commit.author) + '</div>' +
          '<div class="date">' + html(formatDate(commit.date)) + '</div>' +
	        '</div>';
	      });
	      return '<div class="graph-layer">' + renderGraphLayer(commits) + '</div>' + rows;
	    }

    function renderGraphLayer(commits) {
      if (!commits.length) {
        return '';
      }

      const colors = ['#9aa640', '#c34f65', '#4fa06f', '#9446ad', '#b88445', '#54a0a8', '#4f6fc7', '#d0a13d'];
      const lane = 16;
      const commitRowH = 22;
      const width = 150;
      const height = commits.length * commitRowH;
      const pieces = [];
      const colorAt = (index) => colors[Math.floor(index / 2) % colors.length];
      const xAt = (index) => 10 + index * (lane / 2);
      const nodeForCommit = (commit, index) => {
        const dotIndex = Math.max(0, (commit.graph || '*').split('').indexOf('*'));
        return {
          hash: commit.hash,
          x: xAt(dotIndex),
          y: index * commitRowH + commitRowH / 2,
          color: colorAt(dotIndex)
        };
      };
      const line = (fromX, fromY, toX, toY, color) => {
        pieces.push('<path class="graph-line" d="M' + fromX + ' ' + fromY + ' L' + toX + ' ' + toY + '" stroke="' + color + '"/>');
      };

      const nodes = commits.map(nodeForCommit);
      const nodesByHash = new Map(nodes.map((node) => [node.hash, node]));

      commits.forEach((commit, index) => {
        const node = nodes[index];
        commit.parents.forEach((parentHash) => {
          const parent = nodesByHash.get(parentHash);
          if (parent) {
            line(node.x, node.y, parent.x, parent.y, node.color);
          }
        });
      });

      nodes.forEach((node) => {
        pieces.push('<circle class="graph-dot" cx="' + node.x + '" cy="' + node.y + '" r="5" fill="' + node.color + '"/>');
      });

      return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" overflow="hidden" aria-hidden="true">' + pieces.join('') + '</svg>';
    }

    function renderDetail() {
      const detail = state.detail;
      if (!detail) return '<div class="empty">Select a commit</div>';
      const files = renderFileTree(buildFileTree(detail.files));
      return '<div class="commit-card">' +
        '<div class="commit-title">' + html(detail.message.split('\\n')[0] || detail.hash) + '</div>' +
        '<div class="kv">' +
          '<span>Hash</span><span>' + html(detail.hash) + '</span>' +
          '<span>Author</span><span>' + html(detail.author + ' <' + detail.authorEmail + '>') + '</span>' +
          '<span>Date</span><span>' + html(formatDetailDate(detail.authorDate)) + '</span>' +
          '<span>Refs</span><span>' + html(detail.refs.join(', ') || '-') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="file-list">' + (files || '<div class="empty">No changed files</div>') + '</div>';
    }

    function buildFileTree(files) {
      const root = { folders: new Map(), files: [] };
      files.forEach((file) => {
        const parts = file.path.split('/').filter(Boolean);
        let node = root;
        parts.slice(0, -1).forEach((part) => {
          if (!node.folders.has(part)) {
            node.folders.set(part, { name: part, folders: new Map(), files: [] });
          }
          node = node.folders.get(part);
        });
        node.files.push({ ...file, displayName: parts.at(-1) || file.path });
      });
      return root;
    }

    function renderFileTree(node, depth = 0) {
      const folders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
      const files = node.files.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return folders.map((folder) => (
        '<div class="tree-row folder ' + treeLevel(depth) + '" data-file-folder data-tree="file" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon folder-icon">' + folderIcon() + '</span><span class="tree-name">' + html(folder.name) + '</span>' +
        '</div>' + renderFileTree(folder, depth + 1)
      )).join('') + files.map((file) => {
        const key = file.status.charAt(0);
        return '<div class="tree-row file file-row ' + treeLevel(depth) + '" data-file="' + html(file.path) + '" data-depth="' + depth + '">' +
          '<span class="status ' + html(key) + '">' + html(file.status) + '</span>' +
          '<span class="tree-name">' + html(file.previousPath ? file.previousPath + ' -> ' + file.displayName : file.displayName) + '</span>' +
        '</div>';
      }).join('');
    }

    function treeLevel(depth) {
      return 'tree-level-' + Math.min(depth, 10);
    }

    function folderIcon() {
      return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.5l1.3 1.4h5.8c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2V4.2z"/></svg>';
    }

    function branchIcon() {
      return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M5 3v7.2A2.8 2.8 0 0 0 7.8 13H11"/><circle cx="5" cy="3" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="13" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    }

    function tagIcon() {
      return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2.5 2.5h5.4c.3 0 .6.1.8.3l5 5c.4.4.4 1 0 1.4l-4.5 4.5c-.4.4-1 .4-1.4 0l-5-5a1 1 0 0 1-.3-.8V2.5z"/><circle cx="5.4" cy="5.4" r="1.1" style="fill: var(--bg)"/></svg>';
    }

	  function render() {
	    document.getElementById('root').innerHTML =
	      '<main class="app" style="--sidebar-width: ' + paneSizes.sidebar + 'px; --detail-width: ' + paneSizes.detail + 'px;">' +
		        '<aside class="sidebar">' +
		          '<div class="toolbar"><input id="branchSearch" class="search" placeholder="Search branches"></div>' +
		          '<div id="branches" class="branch-list">' + renderBranches() + '</div>' +
		        '</aside>' +
		        '<div class="pane-resizer" data-resize-pane="sidebar" title="Resize branches"></div>' +
		        '<section class="commits">' +
		          renderCommitToolbar() +
		          '<div id="commits" class="commit-list">' + renderCommits(filteredCommits()) + '</div>' +
		        '</section>' +
		        '<div class="pane-resizer" data-resize-pane="detail" title="Resize details"></div>' +
	        '<aside class="detail">' + renderDetail() + '</aside>' +
        '</main>' +
        renderBranchContextMenu() +
        renderCommitContextMenu();
      wire();
    }

	    function wire() {
	      document.querySelectorAll('[data-branch]').forEach((node) => {
	        node.addEventListener('click', () => {
	          commitFilters.branches = new Set(node.dataset.branch ? [node.dataset.branch] : []);
	          persistViewState();
	          send({ type: 'selectBranch', branch: node.dataset.branch });
	        });
		        node.addEventListener('contextmenu', (event) => openBranchContextMenu(event, node));
	      });
	      wireCommitRows();
      document.querySelectorAll('[data-file]').forEach((node) => {
        node.addEventListener('click', () => {
          document.querySelectorAll('[data-file]').forEach((n) => n.classList.remove('active'));
          node.classList.add('active');
          send({ type: 'openDiff', file: node.dataset.file });
        });
      });
	      document.querySelectorAll('[data-branch-folder], [data-file-folder]').forEach((node) => {
	        node.addEventListener('click', () => toggleFolder(node));
	      });
	      wirePaneResizers();
		      wireActions();
	      document.getElementById('branchSearch').addEventListener('input', (event) => filterBranches(event.target.value));
	      wireCommitFilters();
		      document.addEventListener('click', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      document.addEventListener('keydown', (event) => {
		        if (event.key === 'Escape') {
		          closeBranchContextMenu();
		          closeCommitContextMenu();
		          closeFilterDropdowns();
		        }
		      });
		      window.addEventListener('blur', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      window.addEventListener('resize', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      document.querySelectorAll('.branch-list, .commit-list, .file-list, .patch').forEach((node) => {
		        node.addEventListener('scroll', () => {
		          closeBranchContextMenu();
		          closeCommitContextMenu();
		          closeFilterDropdowns();
		        });
		      });
	    }

	    function wireCommitRows() {
		      document.querySelectorAll('[data-hash]').forEach((node) => {
		        node.addEventListener('click', (event) => selectCommitRow(node, event.shiftKey));
		        node.addEventListener('contextmenu', (event) => openCommitContextMenu(event, node));
		      });
		    }

		    function selectCommitRow(node, extendRange) {
		      const hash = node.dataset.hash;
		      if (!hash) return;

		      if (extendRange && lastSelectedCommitHash) {
		        selectCommitRange(lastSelectedCommitHash, hash);
		        lastSelectedCommitHash = hash;
		        updateCommitSelectionUi();
		        return;
		      }

		      selectedCommitHashes.clear();
		      selectedCommitHashes.add(hash);
		      lastSelectedCommitHash = hash;
		      updateCommitSelectionUi();
		      send({ type: 'selectCommit', hash });
		    }

		    function selectCommitRange(fromHash, toHash) {
		      const commits = filteredCommits();
		      const fromIndex = commits.findIndex((commit) => commit.hash === fromHash);
		      const toIndex = commits.findIndex((commit) => commit.hash === toHash);
		      if (fromIndex < 0 || toIndex < 0) {
		        selectedCommitHashes.clear();
		        selectedCommitHashes.add(toHash);
		        return;
		      }

		      selectedCommitHashes.clear();
		      const start = Math.min(fromIndex, toIndex);
		      const end = Math.max(fromIndex, toIndex);
		      commits.slice(start, end + 1).forEach((commit) => selectedCommitHashes.add(commit.hash));
		    }

		    function updateCommitSelectionUi() {
		      document.querySelectorAll('[data-hash]').forEach((node) => {
		        node.classList.toggle('active', selectedCommitHashes.has(node.dataset.hash));
		      });
		    }

	    function wireActions() {
	      document.querySelectorAll('[data-action]').forEach((node) => {
		        node.addEventListener('click', () => {
		          const action = node.dataset.action;
		          if (action === 'refresh') send({ type: 'refresh' });
		        });
	      });
	    }

	    function wirePaneResizers() {
	      document.querySelectorAll('[data-resize-pane]').forEach((handle) => {
	        handle.addEventListener('mousedown', (event) => startPaneResize(event, handle));
	      });
	    }

	    function startPaneResize(event, handle) {
	      event.preventDefault();
	      const pane = handle.dataset.resizePane;
	      const app = document.querySelector('.app');
	      const startX = event.clientX;
	      const startSize = pane === 'sidebar' ? paneSizes.sidebar : paneSizes.detail;
	      const minSize = pane === 'sidebar' ? 180 : 280;
	      const maxSize = pane === 'sidebar' ? 520 : 720;
	      handle.classList.add('dragging');
	      document.body.classList.add('resizing-pane');

	      const onMove = (moveEvent) => {
	        const delta = moveEvent.clientX - startX;
	        const nextSize = pane === 'sidebar'
	          ? clamp(startSize + delta, minSize, maxSize)
	          : clamp(startSize - delta, minSize, maxSize);
	        paneSizes[pane] = nextSize;
	        app.style.setProperty(pane === 'sidebar' ? '--sidebar-width' : '--detail-width', nextSize + 'px');
	      };

	      const onUp = () => {
	        handle.classList.remove('dragging');
	        document.body.classList.remove('resizing-pane');
	        persistViewState();
	        window.removeEventListener('mousemove', onMove);
	        window.removeEventListener('mouseup', onUp);
	      };

	      window.addEventListener('mousemove', onMove);
	      window.addEventListener('mouseup', onUp);
	    }

	    function clamp(value, min, max) {
	      return Math.min(max, Math.max(min, value));
	    }

	    function wireCommitFilters() {
	      const search = document.getElementById('commitSearch');
	      if (search) {
	        search.value = commitFilters.query;
	        search.addEventListener('input', (event) => {
	          commitFilters.query = event.target.value;
	          persistViewState();
	          updateCommitSearchClear();
	          applyCommitFilters();
	        });
	      }

	      const searchClear = document.getElementById('commitSearchClear');
	      if (searchClear) {
	        updateCommitSearchClear();
	        searchClear.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters.query = '';
	          if (search) search.value = '';
	          persistViewState();
	          updateCommitSearchClear();
	          applyCommitFilters();
	        });
	      }

	      document.querySelectorAll('[data-filter-flag]').forEach((node) => {
	        const key = node.dataset.filterFlag;
	        node.classList.toggle('active', Boolean(commitFilters[key]));
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters[key] = !commitFilters[key];
	          persistViewState();
	          node.classList.toggle('active', Boolean(commitFilters[key]));
	          applyCommitFilters();
	        });
	      });

	      document.querySelectorAll('[data-filter-toggle]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          const clear = event.target.closest('[data-filter-clear]');
	          if (clear) {
	            event.preventDefault();
	            clearCommitFilter(clear.dataset.filterClear);
	            return;
	          }
	          const dropdown = node.closest('[data-filter-dropdown]');
	          const wasOpen = dropdown.classList.contains('open');
	          closeFilterDropdowns();
	          dropdown.classList.toggle('open', !wasOpen);
	        });
	      });

	      document.querySelectorAll('[data-filter-dropdown]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          const clear = event.target.closest('[data-filter-clear]');
	          if (clear) {
	            event.preventDefault();
	            event.stopPropagation();
	            clearCommitFilter(clear.dataset.filterClear);
	            return;
	          }
	          event.stopPropagation();
	        });
	      });

	      document.querySelectorAll('[data-filter-clear]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.preventDefault();
	          event.stopPropagation();
	          clearCommitFilter(node.dataset.filterClear);
	        });
	      });

	      document.querySelectorAll('[data-filter-menu-search]').forEach((node) => {
	        node.addEventListener('input', () => filterDropdownOptions(node));
	        node.addEventListener('keydown', (event) => {
	          if (event.key === 'Escape') {
	            closeFilterDropdowns();
	          }
	        });
	      });

	      document.querySelectorAll('[data-filter-option]').forEach((node) => {
	        node.addEventListener('click', (event) => event.stopPropagation());
	        node.addEventListener('change', () => {
	          const key = node.dataset.filterOption;
	          const selected = commitFilters[key];
	          if (node.checked) {
	            selected.add(node.value);
	          } else {
	            selected.delete(node.value);
	          }
	          persistViewState();
	          updateCommitFilterIndicators();
	          applyCommitFilters();
	        });
	      });
	    }

	    function closeFilterDropdowns() {
	      document.querySelectorAll('[data-filter-dropdown]').forEach((node) => node.classList.remove('open'));
	    }

	    function filterDropdownOptions(input) {
	      const menu = input.closest('.filter-menu');
	      const query = input.value.trim().toLowerCase();
	      menu.querySelectorAll('[data-filter-option-row]').forEach((row) => {
	        row.style.display = row.dataset.filterOptionRow.includes(query) ? '' : 'none';
	      });
	    }

	    function updateCommitSearchClear() {
	      const button = document.getElementById('commitSearchClear');
	      if (button) {
	        button.hidden = !commitFilters.query;
	      }
	    }

	    function clearCommitFilter(kind) {
	      const key = kind === 'branch' ? 'branches' : 'users';
	      commitFilters[key].clear();
	      document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((input) => {
	        input.checked = false;
	      });
	      persistViewState();
	      updateCommitFilterIndicators();
	      applyCommitFilters();
	    }

	    function updateCommitFilterIndicators() {
	      document.querySelectorAll('[data-filter-dropdown]').forEach((dropdown) => {
	        const key = dropdown.dataset.filterDropdown;
	        const button = dropdown.querySelector('[data-filter-toggle]');
	        const label = key === 'branches' ? 'Branch' : 'User';
	        if (button) {
	          button.classList.toggle('active', commitFilters[key].size > 0);
	          button.innerHTML = filterButtonLabel(label, commitFilters[key].size);
	        }
	      });
	    }

	    function applyCommitFilters() {
	      const list = document.getElementById('commits');
	      if (!list) return;
	      list.innerHTML = renderCommits(filteredCommits());
	      wireCommitRows();
	    }

	    function filteredCommits() {
	      const query = commitFilters.query || '';
	      const queryMatcher = createCommitQueryMatcher(query);
	      return state.commits.filter((commit) => {
	        if (queryMatcher && !queryMatcher(commit.subject, commit.hash, commit.shortHash)) {
	          return false;
	        }
	        if (commitFilters.users.size > 0 && !commitFilters.users.has(commit.author)) {
	          return false;
	        }
	        if (commitFilters.branches.size > 0) {
	          const commitBranches = new Set(commit.branches || []);
	          const hasBranch = Array.from(commitFilters.branches).some((branch) => commitBranches.has(branch));
	          if (!hasBranch) {
	            return false;
	          }
	        }
	        return true;
	      });
	    }

	    function createCommitQueryMatcher(query) {
	      if (!query.trim()) return undefined;
	      if (commitFilters.regex) {
	        try {
	          const flags = commitFilters.matchCase ? '' : 'i';
	          const pattern = new RegExp(query, flags);
	          return (subject, hash, shortHash) => pattern.test(subject || '') || pattern.test(hash || '') || pattern.test(shortHash || '');
	        } catch (_error) {
	          return () => false;
	        }
	      }

	      const needle = commitFilters.matchCase ? query : query.toLowerCase();
	      return (subject, hash, shortHash) => {
	        const values = [subject || '', hash || '', shortHash || ''];
	        return values.some((value) => (commitFilters.matchCase ? value : value.toLowerCase()).includes(needle));
	      };
	    }

	    function openBranchContextMenu(event, branchNode) {
	      event.preventDefault();
	      event.stopPropagation();
	      closeCommitContextMenu();
	      document.querySelectorAll('[data-branch]').forEach((node) => node.classList.remove('active'));
	      branchNode.classList.add('active');

      const menu = document.getElementById('branchContextMenu');
      const branch = branchNode.dataset.branch;
      const branchType = branchNode.dataset.branchType;
      const isCurrent = branchNode.dataset.branchCurrent === 'true';
      menu.innerHTML = branchContextItems(branch, branchType, isCurrent).map((item) => {
        if (item.separator) return '<div class="context-menu-separator" role="separator"></div>';
        return '<button class="context-menu-item" type="button" data-branch-action="' + html(item.action) + '" ' + (item.disabled ? 'disabled' : '') + ' title="' + html(item.label) + '">' + html(item.label) + '</button>';
      }).join('');

      menu.querySelectorAll('[data-branch-action]').forEach((item) => {
        item.addEventListener('click', (clickEvent) => {
          clickEvent.stopPropagation();
          const action = item.dataset.branchAction;
          closeBranchContextMenu();
          send({ type: 'branchAction', action, branch, branchType });
        });
      });

      menu.hidden = false;
	      positionContextMenu(menu, event.clientX, event.clientY);
	    }

		    function openCommitContextMenu(event, commitNode) {
		      event.preventDefault();
		      event.stopPropagation();
		      closeBranchContextMenu();
		      const clickedHash = commitNode.dataset.hash;
		      if (!selectedCommitHashes.has(clickedHash)) {
		        selectedCommitHashes.clear();
		        selectedCommitHashes.add(clickedHash);
		        lastSelectedCommitHash = clickedHash;
		        updateCommitSelectionUi();
		      }

		      const menu = document.getElementById('commitContextMenu');
		      const hashes = selectedHashesInView();
		      const hash = hashes[0];
		      menu.innerHTML = commitContextItems(hashes).map((item) => {
		        if (item.separator) return '<div class="context-menu-separator" role="separator"></div>';
		        return '<button class="context-menu-item" type="button" data-commit-action="' + html(item.action) + '" ' + (item.disabled ? 'disabled' : '') + ' title="' + html(item.label) + '">' +
	          '<span class="context-menu-icon">' + html(item.icon || '') + '</span>' +
	          '<span class="context-menu-label">' + html(item.label) + '</span>' +
	          '<span class="context-menu-shortcut">' + html(item.shortcut || '') + '</span>' +
	        '</button>';
	      }).join('');

	      menu.querySelectorAll('[data-commit-action]').forEach((item) => {
	        item.addEventListener('click', (clickEvent) => {
	          clickEvent.stopPropagation();
	          const action = item.dataset.commitAction;
	          closeCommitContextMenu();
	          if (action === 'goParent') {
	            selectRelatedCommit(hash, 'parent');
	            return;
	          }
	          if (action === 'goChild') {
	            selectRelatedCommit(hash, 'child');
	            return;
		          }
		          send({ type: 'commitAction', action, hash, hashes });
		        });
		      });

	      menu.hidden = false;
		      positionContextMenu(menu, event.clientX, event.clientY);
		    }

		    function selectedHashesInView() {
		      const visible = filteredCommits().map((commit) => commit.hash);
		      return visible.filter((hash) => selectedCommitHashes.has(hash));
		    }

	    function selectRelatedCommit(hash, direction) {
	      const commits = filteredCommits();
	      const current = commits.find((commit) => commit.hash === hash);
	      if (!current) return;
	      const target = direction === 'parent'
	        ? commits.find((commit) => current.parents.includes(commit.hash))
	        : commits.find((commit) => commit.parents.includes(hash));
	      if (target) {
	        send({ type: 'selectCommit', hash: target.hash });
	      }
	    }

    function positionContextMenu(menu, x, y) {
      menu.style.left = '0px';
      menu.style.top = '0px';
      const rect = menu.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - rect.width - 8);
      const top = Math.min(y, window.innerHeight - rect.height - 8);
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
    }

	    function closeBranchContextMenu() {
	      const menu = document.getElementById('branchContextMenu');
	      if (menu) {
	        menu.hidden = true;
	        menu.innerHTML = '';
	      }
	    }

	    function closeCommitContextMenu() {
	      const menu = document.getElementById('commitContextMenu');
	      if (menu) {
	        menu.hidden = true;
	        menu.innerHTML = '';
	      }
	    }

    function toggleFolder(folder) {
      const depth = Number(folder.dataset.depth || '0');
      const collapsed = folder.dataset.collapsed !== 'true';
      folder.dataset.collapsed = String(collapsed);

      let row = folder.nextElementSibling;
      while (row && Number(row.dataset.depth || '0') > depth) {
        row.style.display = collapsed ? 'none' : '';
        row = row.nextElementSibling;
      }
    }

    function filterBranches(query) {
      const normalized = query.trim().toLowerCase();
      const branchRows = Array.from(document.querySelectorAll('[data-branch]'));
      branchRows.forEach((node) => {
        node.style.display = node.textContent.toLowerCase().includes(normalized) ? '' : 'none';
      });

      const folderRows = Array.from(document.querySelectorAll('[data-branch-folder]')).reverse();
      folderRows.forEach((folder) => {
        if (!normalized) {
          folder.style.display = '';
          return;
        }

        const depth = Number(folder.dataset.depth || '0');
        let hasVisibleChild = false;
        let row = folder.nextElementSibling;
        while (row && Number(row.dataset.depth || '0') > depth) {
          if (row.matches('[data-branch]') && row.style.display !== 'none') {
            hasVisibleChild = true;
            break;
          }
          row = row.nextElementSibling;
        }
        folder.style.display = hasVisibleChild ? '' : 'none';
      });
    }

    render();
  </script>
</body>
</html>`;
}

function renderErrorHtml(message: string): string {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char));
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function isCommitHash(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{7,40}$/i.test(value));
}

function validateBranchName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Branch name is required.';
  }
  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('..') || /[\s~^:?*[\\]/.test(trimmed)) {
    return 'Enter a valid Git branch name.';
  }
  if (trimmed.endsWith('.lock') || trimmed.endsWith('.')) {
    return 'Enter a valid Git branch name.';
  }
  return undefined;
}

function validateRefName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Name is required.';
  }
  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('..') || /[\s~^:?*[\\]/.test(trimmed)) {
    return 'Enter a valid Git ref name.';
  }
  if (trimmed.endsWith('.lock') || trimmed.endsWith('.')) {
    return 'Enter a valid Git ref name.';
  }
  return undefined;
}

function remoteBranchParts(branch: string): { remote: string; name: string } | undefined {
  const [remote, ...parts] = branch.split('/');
  const name = parts.join('/');
  if (!remote || !name) {
    return undefined;
  }
  return { remote, name };
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
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
