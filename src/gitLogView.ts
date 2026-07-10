import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRunner, shellQuote } from './gitRunner';

type Branch = {
  name: string;
  type: 'local' | 'remote';
  current: boolean;
  upstream?: string;
  tracking?: BranchTrackingStatus;
};

type BranchTrackingStatus = {
  ahead: number;
  behind: number;
};

type Commit = {
  hash: string;
  shortHash: string;
  parents: string[];
  branches: string[];
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

type BranchDiff = {
  branch: string;
  files: ChangedFile[];
  selectedFile?: string;
};

type ViewState = {
  root: string;
  selectedBranch?: string;
  selectedCommit?: string;
  branches: Branch[];
  commits: Commit[];
  currentUser?: string;
  detail?: CommitDetail;
  branchDiff?: BranchDiff;
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
let currentBranchDiffProvider: BranchDiffTreeProvider | undefined;
const gitLogViewId = 'giPro.logView';
const branchDiffViewId = 'giPro.branchDiffView';
const gitLogPanelId = 'giProPanel';

export function registerGitLogView(context: vscode.ExtensionContext, git: GitRunner): void {
  currentProvider = new GitLogViewProvider(git);
  currentBranchDiffProvider = new BranchDiffTreeProvider(git);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(gitLogViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
  const branchDiffTree = vscode.window.createTreeView(branchDiffViewId, {
    treeDataProvider: currentBranchDiffProvider,
    showCollapseAll: true
  });
  currentBranchDiffProvider.attachTree(branchDiffTree);
  context.subscriptions.push(
    branchDiffTree,
    vscode.commands.registerCommand('giPro.branchDiff.refresh', () => currentBranchDiffProvider?.refresh()),
    vscode.commands.registerCommand('giPro.branchDiff.getAll', () => currentBranchDiffProvider?.getAll()),
    vscode.commands.registerCommand('giPro.branchDiff.openFile', (item?: BranchDiffTreeItem) => currentBranchDiffProvider?.openItem(item)),
    vscode.commands.registerCommand('giPro.branchDiff.getFile', (item?: BranchDiffTreeItem) => currentBranchDiffProvider?.getItem(item))
  );
}

export async function showGitLogView(context: vscode.ExtensionContext, git: GitRunner): Promise<void> {
  await openGitLogPanel();
  await vscode.commands.executeCommand(`${gitLogViewId}.focus`);
  await currentProvider?.render();
}

export async function showBranchDiffWithWorkingTree(_context: vscode.ExtensionContext, _git: GitRunner, branch: string): Promise<void> {
  await showBranchDiffInScm(branch);
}

async function openGitLogPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${gitLogPanelId}`);
  } catch {
    // Older cached manifests or VS Code builds may not expose a container focus command.
  }
}

async function openScmView(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.scm');
  } catch {
    // Older cached manifests or VS Code builds may not expose the SCM focus command.
  }
}

async function showBranchDiffInScm(branch: string): Promise<void> {
  await openScmView();
  await vscode.commands.executeCommand(`${branchDiffViewId}.focus`);
  await currentBranchDiffProvider?.showBranchDiff(branch);
}

class GitLogViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private controller: GitLogController | undefined;
  private pendingBranchDiff: string | undefined;
  private repoWatchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private needsRefresh = false;

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
    this.watchRepository(root.fsPath);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.needsRefresh) {
        this.needsRefresh = false;
        void this.controller?.render();
      }
    });
    webviewView.onDidDispose(() => this.stopWatching());
    if (this.pendingBranchDiff) {
      const branch = this.pendingBranchDiff;
      this.pendingBranchDiff = undefined;
      await this.controller.showBranchDiff(branch);
      return;
    }
    await this.controller.render();
  }

  async render(): Promise<void> {
    await this.controller?.render();
  }

  async showBranchDiff(branch: string): Promise<void> {
    if (!this.controller) {
      this.pendingBranchDiff = branch;
      return;
    }
    await this.controller.showBranchDiff(branch);
  }

  private watchRepository(rootPath: string): void {
    this.stopWatching();
    const gitDir = resolveGitDir(rootPath);
    const watchDirs = new Set([gitDir]);
    try {
      // Linked worktrees keep shared refs in the common git dir.
      const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      watchDirs.add(path.resolve(gitDir, commonDir));
    } catch {
      // No commondir file: regular repository layout.
    }

    for (const dir of watchDirs) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,packed-refs,FETCH_HEAD,MERGE_HEAD,ORIG_HEAD,refs/**}')
      );
      const schedule = () => this.scheduleRefresh();
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.repoWatchers.push(watcher);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.view?.visible) {
        void this.controller?.render();
      } else {
        this.needsRefresh = true;
      }
    }, 400);
  }

  private stopWatching(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const watcher of this.repoWatchers) {
      watcher.dispose();
    }
    this.repoWatchers = [];
  }
}

function resolveGitDir(rootPath: string): string {
  const dotGit = path.join(rootPath, '.git');
  try {
    // In worktrees and submodules .git is a file containing "gitdir: <path>".
    if (fs.statSync(dotGit).isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (match) {
        return path.resolve(rootPath, match[1].trim());
      }
    }
  } catch {
    // Fall through to the default .git directory.
  }
  return dotGit;
}

class BranchDiffTreeProvider implements vscode.TreeDataProvider<BranchDiffTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<BranchDiffTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private branch: string | undefined;
  private selectedFile: string | undefined;
  private rootPath: string | undefined;
  private diff: BranchDiff | undefined;
  private tree: vscode.TreeView<BranchDiffTreeItem> | undefined;

  constructor(private readonly git: GitRunner) {}

  attachTree(tree: vscode.TreeView<BranchDiffTreeItem>): void {
    this.tree = tree;
  }

  async showBranchDiff(branch: string): Promise<void> {
    this.branch = branch;
    this.selectedFile = undefined;
    await this.refresh();
  }

  getTreeItem(element: BranchDiffTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BranchDiffTreeItem): BranchDiffTreeItem[] {
    if (!this.branch) {
      return [new BranchDiffMessageItem('Run Show Diff with Working Tree from a branch.')];
    }
    if (!this.diff) {
      return [new BranchDiffMessageItem('Loading branch diff...')];
    }
    if (!this.diff.files.length) {
      return [new BranchDiffMessageItem('No changed files')];
    }
    if (element instanceof BranchDiffFolderItem) {
      return element.children;
    }
    return buildBranchDiffTree(this.diff.files);
  }

  async refresh(): Promise<void> {
    if (!this.branch) {
      this.diff = undefined;
      await vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', false);
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }

    try {
      const root = await this.git.getWorkspaceRoot();
      this.rootPath = root?.fsPath;
      if (!this.rootPath) {
        this.diff = undefined;
        vscode.window.showErrorMessage('Open a folder before opening branch diff.');
        return;
      }
      this.diff = await this.loadState(this.branch);
      this.tree && (this.tree.message = `${this.branch} · ${this.diff.files.length} file${this.diff.files.length === 1 ? '' : 's'}`);
      await vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', this.diff.files.length > 0);
      this.onDidChangeTreeDataEmitter.fire();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async openItem(item?: BranchDiffTreeItem): Promise<void> {
    if (!(item instanceof BranchDiffFileItem) || !this.branch) {
      return;
    }
    this.selectedFile = item.file.path;
    await this.openBranchDiffFile(this.branch, item.file.path);
  }

  async getItem(item?: BranchDiffTreeItem): Promise<void> {
    if (!(item instanceof BranchDiffFileItem) || !this.branch) {
      return;
    }
    await this.getFileFromBranch(this.branch, item.file.path);
    await this.refresh();
  }

  async getAll(): Promise<void> {
    if (!this.branch) {
      return;
    }
    await this.getAllDiffFilesFromBranch(this.branch);
    await this.refresh();
  }

  private async loadState(branch: string): Promise<BranchDiff> {
    const output = await this.git.exec(`git diff --name-status -M ${shellQuote(branch)} --`);
    const files = splitLines(output).map(parseChangedFile).filter((file): file is ChangedFile => Boolean(file));
    if (!this.selectedFile || !files.some((file) => file.path === this.selectedFile)) {
      this.selectedFile = files[0]?.path;
    }
    return { branch, files, selectedFile: this.selectedFile };
  }

  private async openBranchDiffFile(branch: string, filePath: string): Promise<void> {
    if (!this.rootPath) {
      return;
    }
    const fileName = filePath.split('/').pop() || filePath;
    const query = JSON.stringify({ ref: branch, path: filePath });
    const branchUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query });
    const workingTreeUri = vscode.Uri.file(path.join(this.rootPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', branchUri, workingTreeUri, `${fileName} (${branch} ↔ Working Tree)`);
  }

  private async getFileFromBranch(branch: string, filePath: string): Promise<void> {
    if (await pathExistsInRef(this.git, branch, filePath)) {
      await this.git.exec(`git checkout ${shellQuote(branch)} -- ${shellQuote(filePath)}`);
      vscode.window.showInformationMessage(`Got ${filePath} from ${branch}.`);
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `${filePath} does not exist in ${branch}. Remove it from the current working tree?`,
      { modal: true },
      'Remove'
    );
    if (answer === 'Remove') {
      await this.git.exec(`git rm -f -- ${shellQuote(filePath)}`);
      vscode.window.showInformationMessage(`Removed ${filePath}.`);
    }
  }

  private async getAllDiffFilesFromBranch(branch: string): Promise<void> {
    const diff = await this.loadState(branch);
    if (!diff.files.length) {
      vscode.window.showInformationMessage('No files to get from branch.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Get ${diff.files.length} file${diff.files.length === 1 ? '' : 's'} from ${branch} into the current working tree?`,
      { modal: true },
      'Get All'
    );
    if (answer !== 'Get All') {
      return;
    }

    const existing: string[] = [];
    const missing: string[] = [];
    for (const file of diff.files) {
      if (await pathExistsInRef(this.git, branch, file.path)) {
        existing.push(file.path);
      } else {
        missing.push(file.path);
      }
    }

    if (existing.length) {
      await this.git.exec(`git checkout ${shellQuote(branch)} -- ${existing.map((filePath) => shellQuote(filePath)).join(' ')}`);
    }
    if (missing.length) {
      await this.git.exec(`git rm -f -- ${missing.map((filePath) => shellQuote(filePath)).join(' ')}`);
    }
    vscode.window.showInformationMessage(`Got ${diff.files.length} file${diff.files.length === 1 ? '' : 's'} from ${branch}.`);
  }
}

type BranchDiffTreeItem = BranchDiffFolderItem | BranchDiffFileItem | BranchDiffMessageItem;

class BranchDiffFolderItem extends vscode.TreeItem {
  readonly children: BranchDiffTreeItem[] = [];

  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'giProBranchDiffFolder';
  }
}

class BranchDiffFileItem extends vscode.TreeItem {
  constructor(readonly file: ChangedFile) {
    super(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.description = file.status;
    this.tooltip = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
    this.resourceUri = vscode.Uri.file(file.path);
    this.contextValue = 'giProBranchDiffFile';
    this.command = {
      command: 'giPro.branchDiff.openFile',
      title: 'Open Diff',
      arguments: [this]
    };
  }
}

class BranchDiffMessageItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'giProBranchDiffMessage';
  }
}

function buildBranchDiffTree(files: ChangedFile[]): BranchDiffTreeItem[] {
  const root = new BranchDiffFolderItem('');
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let child = folder.children.find((item): item is BranchDiffFolderItem => item instanceof BranchDiffFolderItem && item.label === part);
      if (!child) {
        child = new BranchDiffFolderItem(part);
        folder.children.push(child);
      }
      folder = child;
    }
    folder.children.push(new BranchDiffFileItem(file));
  }
  sortBranchDiffItems(root.children);
  return root.children;
}

function sortBranchDiffItems(items: BranchDiffTreeItem[]): void {
  items.sort((a, b) => {
    const aFolder = a instanceof BranchDiffFolderItem;
    const bFolder = b instanceof BranchDiffFolderItem;
    if (aFolder !== bFolder) {
      return aFolder ? -1 : 1;
    }
    return String(a.label).localeCompare(String(b.label));
  });
  for (const item of items) {
    if (item instanceof BranchDiffFolderItem) {
      sortBranchDiffItems(item.children);
    }
  }
}

class GitLogController {
  private selectedBranch: string | undefined;
  private selectedCommit: string | undefined;
  private diffBranch: string | undefined;
  private selectedDiffFile: string | undefined;
  private readonly outputChannel = vscode.window.createOutputChannel('GI Pro Git');

  constructor(
    private readonly git: GitRunner,
    private readonly webview: vscode.Webview,
    private readonly rootPath: string
  ) {}

  async render(): Promise<void> {
    const state = await this.loadState();
    this.webview.html = renderHtml(this.webview, state);
  }

  async showBranchDiff(branch: string): Promise<void> {
    this.diffBranch = branch;
    this.selectedDiffFile = undefined;
    await this.render();
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
        return;
      }

      if (message.type === 'selectCommit' && isCommitHash(message.hash)) {
        this.selectedCommit = message.hash;
        this.diffBranch = undefined;
        this.selectedDiffFile = undefined;
        const detail = await this.loadCommitDetail(message.hash);
        await this.webview.postMessage({ type: 'commitDetail', detail });
        return;
      }

      if (message.type === 'openDiff' && isCommitHash(this.selectedCommit) && message.file) {
        await this.openFileDiff(this.selectedCommit, message.file);
        return;
      }

      if (message.type === 'openBranchDiffFile' && this.diffBranch && message.file) {
        this.selectedDiffFile = message.file;
        await this.openBranchDiffFile(this.diffBranch, message.file);
        await this.render();
        return;
      }

      if (message.type === 'getDiffFile' && this.diffBranch && message.file) {
        await this.getFileFromBranch(this.diffBranch, message.file);
        await this.render();
        return;
      }

      if (message.type === 'getDiffAll' && this.diffBranch) {
        await this.getAllDiffFilesFromBranch(this.diffBranch);
        await this.render();
        return;
      }

      if (message.type === 'closeBranchDiff') {
        this.diffBranch = undefined;
        this.selectedDiffFile = undefined;
        await this.render();
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

      if (message.type === 'newBranch') {
        if (isCommitHash(message.hash)) {
          await this.newBranchFromCommit(message.hash);
        } else {
          await this.newBranchFromHead();
        }
        await this.render();
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
        await showBranchDiffInScm(branch);
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

  private async newBranchFromHead(): Promise<void> {
    const currentBranch = await this.getCurrentBranch();
    const name = await vscode.window.showInputBox({
      prompt: currentBranch ? `New branch from ${currentBranch}` : 'New branch from HEAD',
      placeHolder: 'feature/my-branch',
      ignoreFocusOut: true,
      validateInput: validateBranchName
    });
    if (name) {
      await this.runGitAction(`git checkout -b ${shellQuote(name)}`, 'Branch created.');
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

    const currentBranch = await this.getCurrentBranch();
    if (currentBranch === branch) {
      await this.runGitAction('git pull --ff-only', 'Branch updated.');
    } else {
      const { remote, remoteBranch } = await this.resolveUpstream(branch);
      await this.runGitAction(`git fetch ${shellQuote(remote)} ${shellQuote(remoteBranch)}:${shellQuote(branch)}`, 'Branch updated.');
    }
    this.selectedBranch = branch;
  }

  private async resolveUpstream(branch: string): Promise<{ remote: string; remoteBranch: string }> {
    let upstream: string | undefined;
    try {
      upstream = (await this.git.exec(`git rev-parse --abbrev-ref ${shellQuote(branch)}@{upstream}`)).trim() || undefined;
    } catch {
      upstream = undefined;
    }

    const slashIndex = upstream?.indexOf('/') ?? -1;
    return slashIndex > 0
      ? { remote: upstream!.slice(0, slashIndex), remoteBranch: upstream!.slice(slashIndex + 1) }
      : { remote: 'origin', remoteBranch: branch };
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
    if (branchType === 'remote' && remote) {
      await this.runGitAction(`git push ${shellQuote(remote.remote)} --delete ${shellQuote(remote.name)}`, 'Branch deleted.');
    } else {
      try {
        await this.runGitAction(`git branch -d ${shellQuote(branch)}`, 'Branch deleted.');
      } catch (error) {
        if (!isBranchNotFullyMergedError(error)) {
          throw error;
        }

        const forceAnswer = await vscode.window.showWarningMessage(
          `Branch ${branch} is not fully merged. Delete it anyway?`,
          { modal: true },
          'Force Delete'
        );
        if (forceAnswer !== 'Force Delete') {
          return;
        }

        await this.runGitAction(`git branch -D ${shellQuote(branch)}`, 'Branch deleted.');
      }
    }
    if (this.selectedBranch === branch) {
      this.selectedBranch = undefined;
    }
  }

  private async runGitAction(command: string, successMessage?: string): Promise<string> {
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GI Pro: ${command}` },
      () => this.git.exec(command)
    );
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
    vscode.window.showInformationMessage(`${title} opened in GI Pro Git output.`);
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

  private async openBranchDiffFile(branch: string, filePath: string): Promise<void> {
    const fileName = filePath.split('/').pop() || filePath;
    const query = JSON.stringify({ ref: branch, path: filePath });
    const branchUri = vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query });
    const workingTreeUri = vscode.Uri.file(path.join(this.rootPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', branchUri, workingTreeUri, `${fileName} (${branch} ↔ Working Tree)`);
  }

  private async getFileFromBranch(branch: string, filePath: string): Promise<void> {
    if (await this.pathExistsInRef(branch, filePath)) {
      await this.runGitAction(`git checkout ${shellQuote(branch)} -- ${shellQuote(filePath)}`, `Got ${filePath} from ${branch}.`);
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `${filePath} does not exist in ${branch}. Remove it from the current working tree?`,
      { modal: true },
      'Remove'
    );
    if (answer === 'Remove') {
      await this.runGitAction(`git rm -f -- ${shellQuote(filePath)}`, `Removed ${filePath}.`);
    }
  }

  private async getAllDiffFilesFromBranch(branch: string): Promise<void> {
    const diff = await this.loadBranchDiff(branch);
    if (!diff.files.length) {
      vscode.window.showInformationMessage('No files to get from branch.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Get ${diff.files.length} file${diff.files.length === 1 ? '' : 's'} from ${branch} into the current working tree?`,
      { modal: true },
      'Get All'
    );
    if (answer !== 'Get All') {
      return;
    }

    const existing: string[] = [];
    const missing: string[] = [];
    for (const file of diff.files) {
      if (await this.pathExistsInRef(branch, file.path)) {
        existing.push(file.path);
      } else {
        missing.push(file.path);
      }
    }

    if (existing.length) {
      const paths = existing.map((filePath) => shellQuote(filePath)).join(' ');
      await this.runGitAction(`git checkout ${shellQuote(branch)} -- ${paths}`);
    }
    if (missing.length) {
      const paths = missing.map((filePath) => shellQuote(filePath)).join(' ');
      await this.runGitAction(`git rm -f -- ${paths}`);
    }
    vscode.window.showInformationMessage(`Got ${diff.files.length} file${diff.files.length === 1 ? '' : 's'} from ${branch}.`);
  }

  private async pathExistsInRef(ref: string, filePath: string): Promise<boolean> {
    try {
      await this.git.exec(`git cat-file -e ${shellQuote(ref + ':' + filePath)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async loadState(): Promise<ViewState> {
    const currentUser = await this.getCurrentUser();
    try {
      const branches = await this.loadBranches();
      const commits = await this.loadCommits(branches);
      const selectedCommit = this.selectVisibleCommit(commits);
      this.selectedCommit = selectedCommit;
      const branchDiff = this.diffBranch ? await this.loadBranchDiff(this.diffBranch) : undefined;
      const detail = !branchDiff && selectedCommit ? await this.loadCommitDetail(selectedCommit) : undefined;

      return {
        root: this.rootPath,
        selectedBranch: this.selectedBranch,
        selectedCommit,
        branches,
        commits,
        currentUser,
        detail,
        branchDiff
      };
    } catch (error) {
      return {
        root: this.rootPath,
        selectedBranch: this.selectedBranch,
        selectedCommit: this.selectedCommit,
        branches: [],
        commits: [],
        currentUser,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async getCurrentUser(): Promise<string | undefined> {
    try {
      const output = await this.git.exec('git config user.name');
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async loadBranches(): Promise<Branch[]> {
    const local = await this.git.exec("git for-each-ref --format='%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)' refs/heads");
    const remote = await this.git.exec('git branch -r --format="%(refname:short)"');
    const branches: Branch[] = [];

    for (const line of splitLines(local)) {
      const [name, head, upstream, trackingText] = line.split('\t');
      if (name) {
        branches.push({
          name,
          type: 'local',
          current: head === '*',
          upstream: upstream || undefined,
          tracking: parseTrackingStatus(trackingText)
        });
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

  private async loadBranchDiff(branch: string): Promise<BranchDiff> {
    const output = await this.git.exec(`git diff --name-status -M ${shellQuote(branch)} --`);
    const files = splitLines(output).map(parseChangedFile).filter((file): file is ChangedFile => Boolean(file));
    if (!this.selectedDiffFile || !files.some((file) => file.path === this.selectedDiffFile)) {
      this.selectedDiffFile = files[0]?.path;
    }
    return {
      branch,
      files,
      selectedFile: this.selectedDiffFile
    };
  }

  private selectVisibleCommit(commits: Commit[]): string | undefined {
    // Nothing is selected until the user clicks a commit.
    if (this.selectedCommit && commits.some((commit) => commit.hash === this.selectedCommit)) {
      return this.selectedCommit;
    }
    return undefined;
  }

  private async loadCommits(branches: Branch[]): Promise<Commit[]> {
    // --exclude only affects ref options that FOLLOW it, so it must precede --all.
    const target = '--exclude=refs/stash --all';
    const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
    const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -n 300 ${target}`);

    const commits: Commit[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const commit = parseCommitLine(line);
      if (commit) commits.push(commit);
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

  const [hash, parents, author, date, refs, subject] = line.slice(marker + 1).split('\x1f');
  if (!isCommitHash(hash)) {
    return undefined;
  }

  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    branches: [],
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

function isBranchNotFullyMergedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not fully merged/i.test(message);
}

function parseTrackingStatus(value: string | undefined): BranchTrackingStatus {
  const ahead = Number(value?.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(value?.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}

async function pathExistsInRef(git: GitRunner, ref: string, filePath: string): Promise<boolean> {
  try {
    await git.exec(`git cat-file -e ${shellQuote(ref + ':' + filePath)}`);
    return true;
  } catch {
    return false;
  }
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
      --selected-bg: var(--vscode-list-activeSelectionBackground, #04568c);
      --selected-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
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
      /* VS Code's default webview stylesheet adds "padding: 0 20px". */
      padding: 0;
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
      color: var(--muted);
    }
    .commit-search-icon svg {
      display: block;
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
      transform: translate(-50%, -68%) rotate(45deg);
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
    .filter-pinned .filter-option span {
      font-weight: 600;
    }
    .filter-menu-divider {
      height: 1px;
      margin: 4px 2px 6px;
      background: var(--context-border);
    }
    .toolbar-spacer {
      flex: 1 1 auto;
    }
    .icon-button {
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      display: grid;
      place-items: center;
      color: var(--text);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
    }
    .icon-button:hover {
      background: var(--panel-2);
      border-color: var(--border);
    }
    .icon-button svg {
      display: block;
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
    .tree-row:hover, .branch:hover, .commit-row:hover, .file-row:hover {
      background: var(--hover-bg);
    }
    .tree-row.active, .branch.active, .commit-row.active, .file-row.active,
    .tree-row.active:hover, .branch.active:hover, .commit-row.active:hover, .file-row.active:hover {
      background: var(--selected-bg);
      color: var(--selected-fg);
    }
    .commit-row.active .subject, .commit-row.active .author, .commit-row.active .date,
    .branch.active .tree-name, .file-row.active .tree-name {
      color: var(--selected-fg);
    }
    .commit-row.active.is-merge .subject {
      color: var(--selected-fg);
      opacity: 0.85;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--branch-icon);
    }
    .context-menu-icon svg {
      display: block;
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
      height: 16px;
      flex: 0 0 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      color: var(--muted);
    }
    .tree-icon svg {
      display: block;
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
      transform: translate(-50%, -70%) rotate(45deg);
      transform-origin: center;
    }
    .tree-row[data-collapsed="true"] > .tree-chevron::before {
      transform: translate(-70%, -50%) rotate(-45deg);
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
    .tree-icon.behind-icon {
      color: var(--orange);
      font-size: 15px;
    }
    .tree-icon.ahead-icon {
      color: var(--branch-icon);
      font-size: 15px;
    }
    .tree-icon.diverged-icon {
      color: var(--purple);
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
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .branch-status {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      flex: 0 0 auto;
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .track-behind { color: var(--orange); }
    .track-ahead { color: var(--branch-icon); }
    .track-diverged { color: var(--purple); }
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
      grid-template-columns: var(--graph-col, 48px) minmax(100px, 1fr) 150px 120px;
      gap: 8px;
      height: 24px;
      align-items: center;
      padding: 0 10px 0 0;
      cursor: pointer;
      border-bottom: 1px solid var(--row-border);
      overflow: hidden;
    }
    .graph-layer {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 2;
      overflow: hidden;
    }
    .graph-layer svg {
      display: block;
    }
    .graph-edge {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
    }
    .graph-dot {
      stroke-width: 0;
    }
    .graph-dot.merge {
      fill: var(--bg);
      stroke-width: 2;
    }
    :root {
      --gc-0: #f9c74f;
      --gc-1: #4fc1e9;
      --gc-2: #f06292;
      --gc-3: #7bd88f;
      --gc-4: #b48ead;
      --gc-5: #ffa657;
      --gc-6: #64b5f6;
      --gc-7: #26a69a;
    }
    body.vscode-light {
      --gc-0: #b8860b;
      --gc-1: #0277bd;
      --gc-2: #c2185b;
      --gc-3: #2e7d32;
      --gc-4: #6a1b9a;
      --gc-5: #e65100;
      --gc-6: #1565c0;
      --gc-7: #00695c;
    }
    .ge-0 { stroke: var(--gc-0); }
    .ge-1 { stroke: var(--gc-1); }
    .ge-2 { stroke: var(--gc-2); }
    .ge-3 { stroke: var(--gc-3); }
    .ge-4 { stroke: var(--gc-4); }
    .ge-5 { stroke: var(--gc-5); }
    .ge-6 { stroke: var(--gc-6); }
    .ge-7 { stroke: var(--gc-7); }
    .gd-0 { fill: var(--gc-0); stroke: var(--gc-0); }
    .gd-1 { fill: var(--gc-1); stroke: var(--gc-1); }
    .gd-2 { fill: var(--gc-2); stroke: var(--gc-2); }
    .gd-3 { fill: var(--gc-3); stroke: var(--gc-3); }
    .gd-4 { fill: var(--gc-4); stroke: var(--gc-4); }
    .gd-5 { fill: var(--gc-5); stroke: var(--gc-5); }
    .gd-6 { fill: var(--gc-6); stroke: var(--gc-6); }
    .gd-7 { fill: var(--gc-7); stroke: var(--gc-7); }
    .subject {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      font-weight: 600;
    }
    .subject-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .refs {
      display: inline-flex;
      flex: 0 1 auto;
      gap: 4px;
      min-width: 0;
      vertical-align: middle;
    }
    .ref {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--ref-color);
      font-size: 11px;
      font-weight: 600;
    }
    .branch-hint {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: 0 1 auto;
      min-width: 28px;
      max-width: 42%;
      margin-left: auto;
      color: var(--muted);
      opacity: 0.58;
      font-size: 11px;
      font-weight: 600;
      overflow: hidden;
    }
    .branch-hint svg {
      flex: 0 0 14px;
      opacity: 0.85;
    }
    .branch-hint-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .commit-row:hover .branch-hint,
    .commit-row.active .branch-hint {
      opacity: 0.82;
    }
    .ref.current-ref {
      color: var(--current-icon);
    }
    .ref.behind-ref {
      color: var(--orange);
    }
    .ref.ahead-ref {
      color: var(--branch-icon);
    }
    .ref.diverged-ref {
      color: var(--purple);
    }
    .ref-track {
      margin-left: 3px;
      font-size: 10px;
      font-weight: 700;
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
    .diff-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
    }
    .diff-title {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .diff-count {
      color: var(--muted);
      font-weight: 500;
      margin-left: 6px;
    }
    .mini-button {
      flex: 0 0 auto;
      height: 24px;
      padding: 0 8px;
      color: var(--text);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      line-height: 22px;
    }
    .mini-button:hover {
      background: var(--panel-2);
    }
    .file-row .mini-button {
      margin-left: auto;
      opacity: 0;
    }
    .file-row:hover .mini-button,
    .file-row.active .mini-button {
      opacity: 1;
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
      .commit-row { grid-template-columns: var(--graph-col, 48px) minmax(100px, 1fr) 130px 100px; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
	    const vscode = acquireVsCodeApi();
	    const state = ${json};
	    const currentBranch = state.branches.find((branch) => branch.current)?.name;
	    const branchesByName = new Map(state.branches.map((branch) => [branch.name, branch]));
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
	    const scrollTops = {
	      branches: persistedViewState.scrollTops?.branches || 0,
	      commits: persistedViewState.scrollTops?.commits || 0,
	      files: persistedViewState.scrollTops?.files || 0
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
	        paneSizes,
	        scrollTops
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
	      return '<span class="refs">' + refs.slice(0, 3).map(renderRefLabel).join('') + '</span>';
	    }

	    function renderRefLabel(ref) {
	      const name = refName(ref);
	      const branch = branchesByName.get(name);
	      const className = branch ? branchStatusClass(branch, 'ref') : 'ref';
	      const tracking = branch ? trackingText(branch.tracking, true) : '';
	      return '<span class="' + className + '">' + html(name) + (tracking ? '<span class="ref-track">' + html(tracking) + '</span>' : '') + '</span>';
	    }

	    function refName(ref) {
	      return String(ref || '').replace('HEAD -> ', '').trim();
	    }

	    function trackingText(tracking, compact) {
	      const ahead = Number(tracking?.ahead || 0);
	      const behind = Number(tracking?.behind || 0);
	      const parts = [];
	      if (behind) parts.push('↓' + (compact ? '' : ' ') + behind);
	      if (ahead) parts.push('↑' + (compact ? '' : ' ') + ahead);
	      return parts.join(compact ? ' ' : '  ');
	    }

	    function branchStatusClass(branch, target) {
	      const tracking = branch?.tracking || {};
	      const ahead = Number(tracking.ahead || 0);
	      const behind = Number(tracking.behind || 0);
	      if (target === 'status') {
	        if (ahead && behind) return 'track-diverged';
	        if (behind) return 'track-behind';
	        if (ahead) return 'track-ahead';
	        return '';
	      }
	      const prefix = target === 'ref' ? 'ref ' : 'tree-icon ';
	      if (branch?.current) return prefix + (target === 'ref' ? 'current-ref' : 'current-icon');
	      if (ahead && behind) return prefix + (target === 'ref' ? 'diverged-ref' : 'diverged-icon');
	      if (behind) return prefix + (target === 'ref' ? 'behind-ref' : 'behind-icon');
	      if (ahead) return prefix + (target === 'ref' ? 'ahead-ref' : 'ahead-icon');
	      return prefix + (target === 'ref' ? '' : 'branch-icon');
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

	    function renderFilterOption(kind, value, displayLabel, selected, searchable) {
	      const checked = selected.has(value) ? ' checked' : '';
	      const rowAttr = searchable ? ' data-filter-option-row="' + html(displayLabel.toLowerCase()) + '"' : '';
	      return '<label class="filter-option" title="' + html(displayLabel) + '"' + rowAttr + '>' +
	        '<input type="checkbox" data-filter-option="' + html(kind) + '" value="' + html(value) + '"' + checked + '>' +
	        '<span>' + html(displayLabel) + '</span>' +
	      '</label>';
	    }

	    function renderFilterDropdown(kind, label, pinned, options, selected) {
	      const active = selected.size > 0 ? ' active' : '';
	      const pinnedItems = pinned.map((option) => renderFilterOption(kind, option.value, option.display, selected, false)).join('');
	      const items = options.map((option) => renderFilterOption(kind, option, option, selected, true)).join('');
	      return '<div class="filter-dropdown" data-filter-dropdown="' + html(kind) + '">' +
	        '<button class="filter-dropdown-button' + active + '" type="button" data-filter-toggle="' + html(kind) + '">' + filterButtonLabel(label, selected.size) + '</button>' +
	        '<div class="filter-menu">' +
	          (pinnedItems ? '<div class="filter-pinned">' + pinnedItems + '</div><div class="filter-menu-divider"></div>' : '') +
	          '<input class="filter-menu-search" data-filter-menu-search="' + html(kind) + '" placeholder="Search ' + html(label.toLowerCase()) + '">' +
	          (items || '<div class="empty">No options</div>') +
	        '</div>' +
	      '</div>';
	    }

	    function renderCommitToolbar() {
	      return '<div class="toolbar commit-toolbar">' +
	        '<div class="commit-search-wrap">' +
	          '<span class="commit-search-icon">' + searchIcon() + '</span>' +
	          '<input id="commitSearch" class="commit-search" placeholder="Filter by commit message or hash">' +
	          '<button id="commitSearchClear" class="clear-button" type="button" title="Clear filter" hidden>×</button>' +
	          '<button class="filter-toggle" type="button" title="Match case" data-filter-flag="matchCase">Aa</button>' +
	          '<button class="filter-toggle" type="button" title="Match regex" data-filter-flag="regex">.*</button>' +
	        '</div>' +
	        renderFilterDropdown('branches', 'Branch', currentBranch ? [{ value: currentBranch, display: 'HEAD' }] : [], branchFilterOptions(), commitFilters.branches) +
	        renderFilterDropdown('users', 'User', state.currentUser ? [{ value: state.currentUser, display: 'Me' }] : [], userFilterOptions(), commitFilters.users) +
	        '<span class="toolbar-spacer"></span>' +
	        '<button id="goToHead" class="icon-button" type="button" title="Go to branch head (selected branch or current)">' + targetIcon() + '</button>' +
	        '</div>';
	    }

	    function searchIcon() {
	      return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.9 9.9 13.4 13.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
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
        const active = state.selectedBranch === branch.name;
        const isPrimary = branch.current || branch.displayName === 'main' || branch.displayName === 'master';
        const iconClass = isPrimary ? 'tree-icon current-icon' : branchStatusClass(branch, 'tree');
        const icon = isPrimary ? starIcon() : (branch.type === 'remote' ? remoteIcon() : branchIcon());
        const status = renderBranchStatus(branch);
        return '<div class="tree-row branch ' + treeLevel(depth) + ' ' + (active ? 'active' : '') + '" data-branch="' + html(branch.name) + '" data-branch-type="' + html(branch.type) + '" data-branch-current="' + String(Boolean(branch.current)) + '" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="' + iconClass + '">' + icon + '</span><span class="tree-name">' + html(branch.displayName) + '</span>' + status +
        '</div>';
      }).join('');
    }

    function renderBranchStatus(branch) {
      const tracking = trackingText(branch.tracking, false);
      if (!tracking) return '';
      const statusClass = branchStatusClass(branch, 'status');
      return '<span class="branch-status ' + statusClass + '">' +
        '<span>' + html(tracking) + '</span>' +
      '</span>';
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
        { label: multi ? 'Copy Revision Numbers' : 'Copy Revision Number', action: 'copyRevisionNumber', icon: copyIcon() },
        { label: 'Create Patch...', action: 'createPatch', icon: fileIcon() },
        { label: 'Cherry-Pick', action: 'cherryPick', icon: pickIcon() },
        { separator: true },
        { label: 'Checkout Revision', action: 'checkoutRevision', disabled: multi },
        { label: 'Show Repository at Revision', action: 'showRepositoryAtRevision', disabled: multi },
        { label: 'Compare with Local', action: 'compareWithLocal', disabled: multi },
        { separator: true },
        { label: 'Reset Current Branch to Here...', action: 'resetCurrentBranchHere', icon: undoIcon(), disabled: multi },
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
        { label: 'New Branch...', action: 'newBranch', icon: branchIcon(), disabled: multi },
        { label: 'New Tag...', action: 'newTag', icon: tagIcon(), disabled: multi },
        { separator: true },
        { label: 'Go to Child Commit', action: 'goChild', clientAction: true, disabled: multi },
        { label: 'Go to Parent Commit', action: 'goParent', clientAction: true, disabled: multi }
      ];
    }

    const GRAPH_ROW_H = 24;
    const GRAPH_LANE_W = 12;
    const GRAPH_PAD = 10;
    const GRAPH_COLOR_COUNT = 8;

    // Assigns each commit to a swim lane from hash/parent relationships (the
    // same model VS Code's SCM graph and IntelliJ use), instead of re-parsing
    // "git log --graph" ASCII art. Colors stick to a lane for the lifetime of
    // its branch line.
    function computeGraphLayout(commits) {
      const visible = new Set(commits.map((commit) => commit.hash));
      const lanes = []; // slot: { expected, colorIdx, branchedFrom? } | null
      const nodes = [];
      const edges = [];
      let colorCounter = 0;
      let maxLanes = 1;

      commits.forEach((commit, row) => {
        let commitLane = -1;
        lanes.forEach((lane, index) => {
          if (commitLane < 0 && lane && lane.expected === commit.hash) {
            commitLane = index;
          }
        });

        let colorIdx;
        if (commitLane >= 0) {
          colorIdx = lanes[commitLane].colorIdx;
        } else {
          commitLane = lanes.findIndex((lane) => !lane);
          if (commitLane < 0) {
            commitLane = lanes.length;
            lanes.push(null);
          }
          colorIdx = colorCounter % GRAPH_COLOR_COUNT;
          colorCounter += 1;
        }

        // Edges for the boundary between the previous row and this one.
        if (row > 0) {
          lanes.forEach((lane, index) => {
            if (!lane) return;
            const to = lane.expected === commit.hash ? commitLane : index;
            const from = lane.branchedFrom !== undefined ? lane.branchedFrom : index;
            edges.push({ row: row - 1, from, to, colorIdx: lane.colorIdx });
            (lane.joins || []).forEach((joinFrom) => {
              edges.push({ row: row - 1, from: joinFrom, to, colorIdx: lane.colorIdx });
            });
            delete lane.branchedFrom;
            delete lane.joins;
          });
        }

        // Lanes that merged into this commit (beyond the one it continues) end here.
        lanes.forEach((lane, index) => {
          if (lane && lane.expected === commit.hash && index !== commitLane) {
            lanes[index] = null;
          }
        });

        const parents = commit.parents.filter((parent) => visible.has(parent));
        if (!parents.length) {
          lanes[commitLane] = null;
        } else {
          lanes[commitLane] = { expected: parents[0], colorIdx };
          parents.slice(1).forEach((parent) => {
            const existing = lanes.findIndex((lane) => lane && lane.expected === parent);
            if (existing >= 0) {
              // The merge line joins a lane that already awaits this parent;
              // emit its edge at the next boundary so it follows that lane's path.
              lanes[existing].joins = (lanes[existing].joins || []).concat(commitLane);
              return;
            }
            let slot = lanes.findIndex((lane) => !lane);
            if (slot < 0) {
              slot = lanes.length;
              lanes.push(null);
            }
            lanes[slot] = { expected: parent, colorIdx: colorCounter % GRAPH_COLOR_COUNT, branchedFrom: commitLane };
            colorCounter += 1;
          });
        }

        while (lanes.length && !lanes[lanes.length - 1]) {
          lanes.pop();
        }
        maxLanes = Math.max(maxLanes, lanes.length, commitLane + 1);
        nodes.push({ lane: commitLane, colorIdx, merge: commit.parents.length > 1 });
      });

      return { nodes, edges, maxLanes };
    }

    function graphX(lane) {
      return GRAPH_PAD + lane * GRAPH_LANE_W;
    }

    function renderGraphSvg(commits, layout) {
      const width = Math.min(260, GRAPH_PAD * 2 + Math.max(0, layout.maxLanes - 1) * GRAPH_LANE_W + 8);
      const height = commits.length * GRAPH_ROW_H;
      const half = GRAPH_ROW_H / 2;
      const pieces = [];

      layout.edges.forEach((edge) => {
        const y1 = edge.row * GRAPH_ROW_H + half;
        const y2 = y1 + GRAPH_ROW_H;
        const x1 = graphX(edge.from);
        const x2 = graphX(edge.to);
        const cls = 'graph-edge ge-' + edge.colorIdx;
        if (x1 === x2) {
          pieces.push('<path class="' + cls + '" d="M' + x1 + ' ' + y1 + ' V' + y2 + '"/>');
        } else {
          const c1 = y1 + GRAPH_ROW_H * 0.5;
          const c2 = y2 - GRAPH_ROW_H * 0.5;
          pieces.push('<path class="' + cls + '" d="M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + c1 + ', ' + x2 + ' ' + c2 + ', ' + x2 + ' ' + y2 + '"/>');
        }
      });

      layout.nodes.forEach((node, row) => {
        const cy = row * GRAPH_ROW_H + half;
        const cls = 'graph-dot gd-' + node.colorIdx + (node.merge ? ' merge' : '');
        pieces.push('<circle class="' + cls + '" cx="' + graphX(node.lane) + '" cy="' + cy + '" r="' + (node.merge ? 3 : 4) + '"/>');
      });

      return {
        width,
        html: '<div class="graph-layer"><svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" aria-hidden="true">' + pieces.join('') + '</svg></div>'
      };
    }

    function commitTooltip(commit) {
      const branches = Array.from(new Set(commit.branches || [])).sort((a, b) => a.localeCompare(b));
      const branchText = branches.length ? branches.join(', ') : 'No containing branch';
      return 'Branches: ' + branchText + '\\n' +
        'Commit: ' + commit.shortHash + '\\n' +
        'Author: ' + (commit.author || '-') + '\\n' +
        'Date: ' + (formatDate(commit.date) || '-');
    }

    function commitBranchHint(commit) {
      const branch = pickCommitBranch(commit);
      if (!branch) return '';
      if ((commit.refs || []).map(refName).includes(branch)) return '';
      return '<span class="branch-hint" title="' + html(branch) + '">' +
        tagIcon() +
        '<span class="branch-hint-name">' + html(branch) + '</span>' +
      '</span>';
    }

    function pickCommitBranch(commit) {
      const branches = Array.from(new Set(commit.branches || []));
      if (!branches.length) return undefined;

      const refBranches = (commit.refs || [])
        .map(refName)
        .filter((name) => branches.includes(name));
      const preferred = [
        state.selectedBranch,
        currentBranch,
        ...refBranches,
        ...branches.filter((name) => branchesByName.get(name)?.type === 'local'),
        ...branches.filter((name) => branchesByName.get(name)?.type === 'remote'),
        ...branches
      ].filter(Boolean);

      return preferred.find((name, index) => preferred.indexOf(name) === index && branches.includes(name));
    }

	    function renderCommits(commits = state.commits) {
	      if (state.error) return { html: '<div class="error">' + html(state.error) + '</div>', graphWidth: 48 };
	      if (!commits.length) return { html: '<div class="empty">No commits found</div>', graphWidth: 48 };
	      const layout = computeGraphLayout(commits);
	      const graph = renderGraphSvg(commits, layout);
	      let rows = '';
	      commits.forEach((commit) => {
	        const active = selectedCommitHashes.has(commit.hash);
	        const isMerge = commit.parents.length > 1;
	        rows += '<div class="commit-row' + (isMerge ? ' is-merge' : '') + (active ? ' active' : '') + '" data-hash="' + html(commit.hash) + '" title="' + html(commitTooltip(commit)) + '">' +
          '<div class="graph-cell"></div>' +
          '<div class="subject"><span class="subject-text">' + html(commit.subject) + '</span>' + refLabels(commit.refs) + commitBranchHint(commit) + '</div>' +
          '<div class="author">' + html(commit.author) + '</div>' +
          '<div class="date">' + html(formatDate(commit.date)) + '</div>' +
	        '</div>';
	      });
	      return { html: graph.html + rows, graphWidth: graph.width };
	    }

    function renderDetail() {
      if (state.branchDiff) return renderBranchDiff();
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

    function renderBranchDiff() {
      const diff = state.branchDiff;
      const files = renderFileTree(buildFileTree(diff.files), { mode: 'branchDiff', selectedFile: diff.selectedFile });
      return '<div class="diff-toolbar">' +
        '<div class="diff-title">Diff with Working Tree <span class="diff-count">' + html(diff.files.length + ' file' + (diff.files.length === 1 ? '' : 's')) + '</span></div>' +
        '<button class="mini-button" type="button" data-action="getDiffAll"' + (diff.files.length ? '' : ' disabled') + '>Get All</button>' +
        '<button class="mini-button" type="button" data-action="closeBranchDiff">Close</button>' +
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

    function renderFileTree(node, options = {}, depth = 0) {
      const folders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
      const files = node.files.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return folders.map((folder) => (
        '<div class="tree-row folder ' + treeLevel(depth) + '" data-file-folder data-tree="file" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon folder-icon">' + folderIcon() + '</span><span class="tree-name">' + html(folder.name) + '</span>' +
        '</div>' + renderFileTree(folder, options, depth + 1)
      )).join('') + files.map((file) => {
        const key = file.status.charAt(0);
        const selected = options.selectedFile === file.path ? ' active' : '';
        const modeAttr = options.mode ? ' data-file-mode="' + html(options.mode) + '"' : '';
        const action = options.mode === 'branchDiff' ? '<button class="mini-button" type="button" data-get-file="' + html(file.path) + '">Get</button>' : '';
        return '<div class="tree-row file file-row ' + treeLevel(depth) + selected + '" data-file="' + html(file.path) + '"' + modeAttr + ' data-depth="' + depth + '">' +
          '<span class="status ' + html(key) + '">' + html(file.status) + '</span>' +
          '<span class="tree-name">' + html(file.previousPath ? file.previousPath + ' -> ' + file.displayName : file.displayName) + '</span>' + action +
        '</div>';
      }).join('');
    }

    function treeLevel(depth) {
      return 'tree-level-' + Math.min(depth, 10);
    }

    function svgIcon(inner, size) {
      const s = size || 16;
      return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    }

    function folderIcon() {
      return svgIcon('<path d="M1.75 12.75v-9h4.1l1.5 1.5h6.9v7.5z"/>');
    }

    function branchIcon() {
      return svgIcon('<circle cx="4.75" cy="3.75" r="1.6"/><circle cx="4.75" cy="12.25" r="1.6"/><circle cx="11.25" cy="5.75" r="1.6"/><path d="M4.75 5.45v5.2M11.25 7.45c0 2.3-2.5 2.8-4.8 3"/>');
    }

    function remoteIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.9 1.7 1.9 9.5 0 11.2M8 2.4c-1.9 1.7-1.9 9.5 0 11.2"/>');
    }

    function starIcon() {
      return svgIcon('<path fill="currentColor" stroke="none" d="M8 1.9l1.85 3.75 4.15.6-3 2.93.71 4.12L8 11.35l-3.71 1.95.71-4.12-3-2.93 4.15-.6z"/>');
    }

    function tagIcon() {
      return svgIcon('<path d="M2.75 2.75h4.9l5.6 5.6-4.9 4.9-5.6-5.6z"/><circle cx="5.9" cy="5.9" r="1.1" fill="currentColor" stroke="none"/>');
    }

    function targetIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/><path d="M8 1.2v2M8 12.8v2M1.2 8h2M12.8 8h2"/>');
    }

    function copyIcon() {
      return svgIcon('<rect x="5.25" y="5.25" width="8" height="8" rx="1"/><path d="M10.75 3.25h-7.5v7.5"/>', 14);
    }

    function fileIcon() {
      return svgIcon('<path d="M4.25 1.75h5l3 3v9.5h-8z"/><path d="M9.25 1.75v3h3"/>', 14);
    }

    function pickIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5.6" stroke-dasharray="2.4 2.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>', 14);
    }

    function undoIcon() {
      return svgIcon('<path d="M3.25 3.75v3.5h3.5"/><path d="M3.6 7.25a5 5 0 1 0 1.3-3.3"/>', 14);
    }

	  function render() {
	    const commitsView = renderCommits(filteredCommits());
	    document.getElementById('root').innerHTML =
	      '<main class="app">' +
		        '<aside class="sidebar">' +
		          '<div class="toolbar"><input id="branchSearch" class="search" placeholder="Search branches"></div>' +
		          '<div id="branches" class="branch-list">' + renderBranches() + '</div>' +
		        '</aside>' +
		        '<div class="pane-resizer" data-resize-pane="sidebar" title="Resize branches"></div>' +
		        '<section class="commits">' +
		          renderCommitToolbar() +
		          '<div id="commits" class="commit-list">' + commitsView.html + '</div>' +
		        '</section>' +
		        '<div class="pane-resizer" data-resize-pane="detail" title="Resize details"></div>' +
	        '<aside class="detail">' + renderDetail() + '</aside>' +
        '</main>' +
        renderBranchContextMenu() +
        renderCommitContextMenu();
      // The webview CSP (style-src 'nonce-...') blocks style="" attributes in
      // generated HTML, so sizing vars must be applied through the CSSOM.
      const app = document.querySelector('.app');
      app.style.setProperty('--sidebar-width', paneSizes.sidebar + 'px');
      app.style.setProperty('--detail-width', paneSizes.detail + 'px');
      document.getElementById('commits').style.setProperty('--graph-col', commitsView.graphWidth + 'px');
      wire();
      restoreScrollPositions();
    }

	    function wire() {
	      document.querySelectorAll('[data-branch]').forEach((node) => {
	        node.addEventListener('click', () => {
	          document.querySelectorAll('[data-branch]').forEach((other) => other.classList.remove('active'));
	          node.classList.add('active');
	          state.selectedBranch = node.dataset.branch;
	          send({ type: 'selectBranch', branch: node.dataset.branch });
	        });
	        node.addEventListener('dblclick', () => {
	          const branch = node.dataset.branch;
	          if (!branch) return;
	          // Double-click filters the log to this branch; again on the same branch clears it.
	          const alreadyOnly = commitFilters.branches.size === 1 && commitFilters.branches.has(branch);
	          commitFilters.branches = alreadyOnly ? new Set() : new Set([branch]);
	          persistViewState();
	          document.querySelectorAll('[data-filter-option="branches"]').forEach((input) => {
	            input.checked = commitFilters.branches.has(input.value);
	          });
	          updateCommitFilterIndicators();
	          applyCommitFilters();
	        });
		        node.addEventListener('contextmenu', (event) => openBranchContextMenu(event, node));
	      });
	      wireCommitRows();
	      wireDetailPane();
	      document.querySelectorAll('[data-branch-folder]').forEach((node) => {
	        node.addEventListener('click', () => toggleFolder(node));
	      });
	      wirePaneResizers();
	      document.getElementById('branchSearch').addEventListener('input', (event) => filterBranches(event.target.value));
	      document.getElementById('goToHead')?.addEventListener('click', goToBranchHead);
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
		      document.querySelectorAll('.branch-list, .commit-list').forEach((node) => {
		        node.addEventListener('scroll', () => {
		          updateScrollState(node);
		          closeBranchContextMenu();
		          closeCommitContextMenu();
		          closeFilterDropdowns();
		        });
		      });
	    }

	    function wireDetailPane() {
	      document.querySelectorAll('[data-file]').forEach((node) => {
	        node.addEventListener('click', () => {
	          document.querySelectorAll('[data-file]').forEach((n) => n.classList.remove('active'));
	          node.classList.add('active');
	          if (node.dataset.fileMode === 'branchDiff') {
	            send({ type: 'openBranchDiffFile', file: node.dataset.file });
	          } else {
	            send({ type: 'openDiff', file: node.dataset.file });
	          }
	        });
	      });
	      document.querySelectorAll('[data-get-file]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.preventDefault();
	          event.stopPropagation();
	          send({ type: 'getDiffFile', file: node.dataset.getFile });
	        });
	      });
	      document.querySelectorAll('[data-file-folder]').forEach((node) => {
	        node.addEventListener('click', () => toggleFolder(node));
	      });
	      document.querySelectorAll('.file-list').forEach((node) => {
	        node.addEventListener('scroll', () => {
	          updateScrollState(node);
	          closeBranchContextMenu();
	          closeCommitContextMenu();
	          closeFilterDropdowns();
	        });
	      });
	      wireActions();
	    }

	    function restoreScrollPositions() {
	      const branches = document.getElementById('branches');
	      const commits = document.getElementById('commits');
	      const files = document.querySelector('.file-list');
	      if (branches) branches.scrollTop = scrollTops.branches;
	      if (commits) commits.scrollTop = scrollTops.commits;
	      if (files) files.scrollTop = scrollTops.files;
	    }

	    function updateScrollState(node) {
	      if (node.id === 'branches') {
	        scrollTops.branches = node.scrollTop;
	      } else if (node.id === 'commits') {
	        scrollTops.commits = node.scrollTop;
	      } else if (node.classList.contains('file-list')) {
	        scrollTops.files = node.scrollTop;
	      }
	      persistViewState();
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
		      const commits = document.getElementById('commits');
		      if (commits) {
		        scrollTops.commits = commits.scrollTop;
		        persistViewState();
		      }
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
		          if (action === 'getDiffAll') send({ type: 'getDiffAll' });
		          if (action === 'closeBranchDiff') send({ type: 'closeBranchDiff' });
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
	        // Persist as we drag: mouseup can land outside the webview and never fire.
	        persistViewState();
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
	          document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((el) => {
	            el.checked = selected.has(el.value);
	          });
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
	      const commitsView = renderCommits(filteredCommits());
	      list.style.setProperty('--graph-col', commitsView.graphWidth + 'px');
	      list.innerHTML = commitsView.html;
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
	          '<span class="context-menu-icon">' + (item.icon || '') + '</span>' +
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

    function goToBranchHead() {
      const branchName = state.selectedBranch || currentBranch;
      if (!branchName) return;
      const target = state.commits.find((commit) => (commit.refs || []).some((ref) => refName(ref) === branchName));
      if (!target) return;
      if (!filteredCommits().some((commit) => commit.hash === target.hash)) {
        clearAllCommitFilters();
      }
      const row = document.querySelector('[data-hash="' + target.hash + '"]');
      const list = document.getElementById('commits');
      if (!row || !list) return;
      list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2 + 12);
      selectCommitRow(row, false);
    }

    function clearAllCommitFilters() {
      commitFilters.query = '';
      commitFilters.branches.clear();
      commitFilters.users.clear();
      const search = document.getElementById('commitSearch');
      if (search) search.value = '';
      document.querySelectorAll('[data-filter-option]').forEach((input) => {
        input.checked = false;
      });
      persistViewState();
      updateCommitSearchClear();
      updateCommitFilterIndicators();
      applyCommitFilters();
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'commitDetail' && message.detail) {
        state.detail = message.detail;
        state.branchDiff = null;
        state.selectedCommit = message.detail.hash;
        selectedCommitHashes.clear();
        selectedCommitHashes.add(message.detail.hash);
        lastSelectedCommitHash = message.detail.hash;
        updateCommitSelectionUi();
        const row = document.querySelector('[data-hash="' + message.detail.hash + '"]');
        if (row) row.scrollIntoView({ block: 'nearest' });
        const pane = document.querySelector('.detail');
        if (pane) {
          pane.innerHTML = renderDetail();
          wireDetailPane();
        }
      }
    });

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
