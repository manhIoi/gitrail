import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRunner, shellQuote, suggestBranchName } from './gitRunner';
import { mergeCommand } from './mergeOptions';

type Branch = {
  name: string;
  type: 'local' | 'remote';
  current: boolean;
  // Tip commit. Only used to key the branch-membership cache; absent if the ref could not be
  // read, which disables that cache rather than risking a stale answer.
  tip?: string;
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
  // Nearest ancestors that survived the filter, so the graph stays joined up when a filter
  // hides the commits in between. Absent when nothing is filtered, where it would equal
  // parents. Never used for "is this a merge" or for Go to Parent - those want the real ones.
  graphParents?: string[];
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

// What the Gitrail Diff view is showing. `ref` is the side files are taken from when you
// Get them. Without `against` the comparison is ref against the working tree; with it the
// two refs are compared directly, which is what Compare with <branch> needs.
type DiffTarget = {
  ref: string;
  label: string;
  against?: string;
};

type ViewState = {
  root: string;
  selectedBranch?: string;
  selectedCommit?: string;
  branches: Branch[];
  commits: Commit[];
  hasMoreCommits: boolean;
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
  query?: string;
  matchCase?: boolean;
  regex?: boolean;
  users?: string[];
  branches?: string[];
  noMerges?: boolean;
  focused?: boolean;
  open?: boolean;
};

const RESET_MODES = [
  { mode: 'soft', label: 'Soft', detail: "Files won't change, differences will be staged for commit." },
  { mode: 'mixed', label: 'Mixed', detail: "Files won't change, differences won't be staged." },
  { mode: 'hard', label: 'Hard', detail: 'Files will be reverted to the state of the selected commit. Any local changes will be lost.' },
  { mode: 'keep', label: 'Keep', detail: 'Files will be reverted to the state of the selected commit, but local changes will be kept intact.' }
] as const;

let extensionHome: vscode.Uri | undefined;
let currentController: GitLogController | undefined;
let currentProvider: GitLogViewProvider | undefined;
let currentBranchDiffProvider: BranchDiffTreeProvider | undefined;
const gitLogViewId = 'giPro.logView';
const branchDiffViewId = 'giPro.branchDiffView';
const gitLogPanelId = 'giProPanel';

/** Where the extension is installed - the root the webview loads media/ from. */
function extensionUri(): vscode.Uri {
  if (!extensionHome) {
    throw new Error('The extension path is unavailable.');
  }
  return extensionHome;
}

export function registerGitLogView(context: vscode.ExtensionContext, git: GitRunner): void {
  extensionHome = context.extensionUri;
  void vscode.commands.executeCommand('setContext', 'giPro.branchDiffVisible', false);
  void vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', false);
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
    vscode.commands.registerCommand('giPro.branchDiff.close', () => currentBranchDiffProvider?.close()),
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
  await showBranchDiffInScm({ ref: branch, label: `${branch} ↔ Working Tree` });
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

async function showBranchDiffInScm(target: DiffTarget): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'giPro.branchDiffVisible', true);
  await openScmView();
  await currentBranchDiffProvider?.showDiff(target);
  await vscode.commands.executeCommand(`${branchDiffViewId}.focus`);
}

class GitLogViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private controller: GitLogController | undefined;
  private pendingBranchDiff: string | undefined;
  private repoWatchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private needsRefresh = false;
  private inputFocused = false;
  private overlayOpen = false;
  private blurTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly git: GitRunner) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri(), 'media')]
    };
    const root = await this.git.getWorkspaceRoot();
    if (!root) {
      webviewView.webview.html = renderErrorHtml('Open a folder before opening Git Log.');
      return;
    }

    this.controller = new GitLogController(this.git, webviewView.webview, root.fsPath);
    currentController = this.controller;
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (this.handleInteraction(message)) {
        return;
      }
      void this.controller?.handleMessage(message);
    });
    this.watchRepository(root.fsPath);
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        // A hidden view holds neither focus nor an open menu; clear both so a deferred
        // refresh is never stranded waiting for a close that will not arrive.
        this.inputFocused = false;
        this.overlayOpen = false;
        return;
      }
      if (this.needsRefresh) {
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

  // Anything the user is in the middle of that a re-render would throw away. render()
  // replaces webview.html outright, so every one of these lives only in the DOM.
  private get interactionActive(): boolean {
    return this.inputFocused || this.overlayOpen;
  }

  // Returns true when the message was an interaction notification and needs no further handling.
  private handleInteraction(raw: unknown): boolean {
    const message = raw as WebviewMessage;
    if (message?.type === 'inputFocus') {
      this.inputFocused = Boolean(message.focused);
    } else if (message?.type === 'overlayState') {
      this.overlayOpen = Boolean(message.open);
    } else {
      return false;
    }

    this.flushWhenIdle();
    return true;
  }

  private flushWhenIdle(): void {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = undefined;
    }

    if (this.interactionActive || !this.needsRefresh) {
      return;
    }

    // Tabbing between two inputs fires focusout before the next focusin, and closing one
    // menu to open another reports closed before open, so wait a beat before flushing -
    // otherwise the deferred render lands mid-hop and destroys the DOM anyway.
    this.blurTimer = setTimeout(() => {
      this.blurTimer = undefined;
      if (!this.interactionActive && this.needsRefresh) {
        this.needsRefresh = false;
        void this.controller?.render();
      }
    }, 150);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // render() replaces webview.html outright, which destroys the DOM: focus goes
      // mid-keystroke, an open context menu vanishes, a multi-commit selection collapses.
      // git.autofetch rewrites FETCH_HEAD on a short interval, so this watcher fires
      // constantly - hold the refresh until the user is not in the middle of something.
      if (this.view?.visible && !this.interactionActive) {
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
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = undefined;
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
  private target: DiffTarget | undefined;
  private selectedFile: string | undefined;
  private rootPath: string | undefined;
  private diff: BranchDiff | undefined;
  private tree: vscode.TreeView<BranchDiffTreeItem> | undefined;

  constructor(private readonly git: GitRunner) {}

  attachTree(tree: vscode.TreeView<BranchDiffTreeItem>): void {
    this.tree = tree;
  }

  async showDiff(target: DiffTarget): Promise<void> {
    this.target = target;
    this.selectedFile = undefined;
    await this.refresh();
  }

  async close(): Promise<void> {
    this.target = undefined;
    this.selectedFile = undefined;
    this.rootPath = undefined;
    this.diff = undefined;
    if (this.tree) {
      this.tree.message = undefined;
    }
    await vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', false);
    await vscode.commands.executeCommand('setContext', 'giPro.branchDiffVisible', false);
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: BranchDiffTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BranchDiffTreeItem): BranchDiffTreeItem[] {
    if (!this.target) {
      return [new BranchDiffMessageItem('Run a Show Diff or Compare action from the Log View.')];
    }
    if (!this.diff) {
      return [new BranchDiffMessageItem('Loading diff...')];
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
    if (!this.target) {
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
        vscode.window.showErrorMessage('Open a folder before opening a diff.');
        return;
      }
      this.diff = await this.loadState(this.target);
      this.tree && (this.tree.message = `${this.target.label} · ${this.diff.files.length} file${this.diff.files.length === 1 ? '' : 's'}`);
      await vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', this.diff.files.length > 0);
      this.onDidChangeTreeDataEmitter.fire();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async openItem(item?: BranchDiffTreeItem): Promise<void> {
    if (!(item instanceof BranchDiffFileItem) || !this.target) {
      return;
    }
    this.selectedFile = item.file.path;
    await this.openDiffFile(this.target, item.file.path);
  }

  async getItem(item?: BranchDiffTreeItem): Promise<void> {
    if (!(item instanceof BranchDiffFileItem) || !this.target) {
      return;
    }
    await this.getFileFromBranch(this.target.ref, item.file.path);
    await this.refresh();
  }

  async getAll(): Promise<void> {
    if (!this.target) {
      return;
    }
    await this.getAllDiffFilesFromBranch(this.target);
    await this.refresh();
  }

  private async loadState(target: DiffTarget): Promise<BranchDiff> {
    // `git diff A B` reports what changes going from A to B, so the ref files are taken from
    // goes last. That makes A/D read the same way Get applies them to the working tree.
    const range = target.against
      ? `${shellQuote(target.against)} ${shellQuote(target.ref)}`
      : shellQuote(target.ref);
    const output = await this.git.exec(`git diff --name-status -M ${range} --`);
    const files = splitLines(output).map(parseChangedFile).filter((file): file is ChangedFile => Boolean(file));
    if (!this.selectedFile || !files.some((file) => file.path === this.selectedFile)) {
      this.selectedFile = files[0]?.path;
    }
    return { branch: target.ref, files, selectedFile: this.selectedFile };
  }

  private async openDiffFile(target: DiffTarget, filePath: string): Promise<void> {
    if (!this.rootPath) {
      return;
    }
    const fileName = filePath.split('/').pop() || filePath;
    const refUri = (ref: string) =>
      vscode.Uri.from({ scheme: 'gitpro', path: '/' + fileName, query: JSON.stringify({ ref, path: filePath }) });
    // Left is the side being compared from, mirroring the argument order given to git diff.
    const left = target.against ? refUri(target.against) : refUri(target.ref);
    const right = target.against ? refUri(target.ref) : vscode.Uri.file(path.join(this.rootPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${fileName} (${target.label})`);
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

  private async getAllDiffFilesFromBranch(target: DiffTarget): Promise<void> {
    const branch = target.ref;
    const diff = await this.loadState(target);
    if (!diff.files.length) {
      vscode.window.showInformationMessage(`No files to get from ${branch}.`);
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
  private static readonly commitPageSize = 300;
  private static readonly maxSelectedCommitDepth = 5000;
  private branchMembershipCache: { key: string; depth: number; map: Map<string, string[]> } | undefined;
  private commitsUpdateSeq = 0;
  private selectedBranch: string | undefined;
  private selectedCommit: string | undefined;
  private diffBranch: string | undefined;
  private selectedDiffFile: string | undefined;
  private commitLimit = GitLogController.commitPageSize;
  private loadingMoreCommits = false;
  private commitFilterQuery = '';
  private commitFilterMatchCase = false;
  private commitFilterRegex = false;
  private commitFilterUsers = new Set<string>();
  private commitFilterBranches = new Set<string>();
  private commitFilterNoMerges = false;
  private readonly outputChannel = vscode.window.createOutputChannel('Gitrail Git');

  constructor(
    private readonly git: GitRunner,
    private readonly webview: vscode.Webview,
    private readonly rootPath: string
  ) {}

  async render(): Promise<void> {
    const state = await this.loadState();
    this.webview.html = renderHtml(this.webview, state);
  }

  // Used for commit-list-only changes (pagination, filter updates) so the webview can
  // patch just the commit list instead of a full HTML replace, which would drop input
  // focus and flicker the whole panel on every search keystroke. `reason` tells the
  // webview whether to keep the current scroll position (loadMore, appending further
  // down the list) or reset it to the top (filter, a new result set).
  private async postCommitsUpdate(reason: 'loadMore' | 'filter'): Promise<void> {
    // Messages are handled fire-and-forget, so pausing mid-word for longer than the debounce
    // leaves two of these runs in flight. Only the newest may be applied, and the guard has to
    // cover the assignment below as much as the message: letting a superseded run recompute
    // selectedCommit from its own commit list is exactly how a selection gets dropped.
    const seq = ++this.commitsUpdateSeq;
    try {
      const branches = await this.loadBranches();
      const { commits, hasMoreCommits } = await this.loadCommits(branches);
      if (seq !== this.commitsUpdateSeq) {
        return;
      }
      this.selectedCommit = this.selectVisibleCommit(commits);
      await this.webview.postMessage({
        type: 'commitsUpdated',
        reason,
        commits,
        hasMoreCommits,
        selectedCommit: this.selectedCommit
      });
    } catch (error) {
      if (seq !== this.commitsUpdateSeq) {
        return;
      }
      await this.webview.postMessage({
        type: 'commitsUpdated',
        reason,
        commits: [],
        hasMoreCommits: false,
        selectedCommit: this.selectedCommit,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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

      if (message.type === 'loadMoreCommits') {
        if (this.loadingMoreCommits) {
          return;
        }
        this.loadingMoreCommits = true;
        try {
          this.commitLimit += GitLogController.commitPageSize;
          await this.postCommitsUpdate('loadMore');
        } finally {
          this.loadingMoreCommits = false;
        }
        return;
      }

      if (message.type === 'updateCommitFilters') {
        this.commitFilterQuery = message.query || '';
        this.commitFilterMatchCase = Boolean(message.matchCase);
        this.commitFilterRegex = Boolean(message.regex);
        this.commitFilterUsers = new Set(message.users || []);
        this.commitFilterBranches = new Set(message.branches || []);
        this.commitFilterNoMerges = Boolean(message.noMerges);
        this.commitLimit = GitLogController.commitPageSize;
        // Searching is how you reach an old commit, so the one just picked out of the results
        // is usually deeper than a fresh page. Rebuilding from the newest page alone would
        // drop it from the list, and selectVisibleCommit would then clear the selection.
        this.commitLimit = Math.max(this.commitLimit, await this.depthOfSelectedCommit());
        await this.postCommitsUpdate('filter');
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
        await showBranchDiffInScm({ ref: hash, label: `${hash.slice(0, 8)} ↔ Working Tree` });
        return;
      case 'resetCurrentBranchHere':
        await this.resetCurrentBranchTo(hash);
        return;
      case 'revertCommit':
        await this.runGitAction(`git revert ${hashArgs}`, 'Revert completed.');
        return;
      case 'pushAllUpToHere':
        await this.runGitAction('git push', 'Push completed.');
        return;
      case 'undoCommit':
        await this.undoCommit(hash);
        return;
      case 'editCommitMessage':
        await this.editCommitMessage(hash);
        return;
      case 'fixup':
        await this.autosquashInto(hash, 'fixup');
        return;
      case 'squashInto':
        await this.autosquashInto(hash, 'squash');
        return;
      case 'dropCommits':
        await this.dropCommits(hashes);
        return;
      case 'squashCommits':
        await this.squashCommits(hashes);
        return;
      case 'interactiveRebaseFromHere':
        // Terminal, not exec: the todo list and any conflict resolution are the UX here,
        // exactly like giPro.interactiveRebase in extension.ts.
        await this.git.run(`git rebase -i --autostash ${hash}^`);
        return;
      case 'rebaseCurrentOnto':
        await this.runGitAction(`git rebase --autostash ${hash}`, 'Rebase completed.');
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
        await this.newBranchFrom(branch, branchType);
        return;
      case 'checkoutRebaseOnto':
        if (currentBranch) {
          await this.runGitAction(`git checkout ${shellQuote(branch)} && git rebase --autostash ${shellQuote(currentBranch)}`, 'Checkout and rebase completed.');
        }
        return;
      case 'compareWithCurrent':
        if (currentBranch) {
          await showBranchDiffInScm({ ref: branch, label: `${currentBranch} ↔ ${branch}`, against: currentBranch });
        }
        return;
      case 'diffWithWorkingTree':
        await showBranchDiffInScm({ ref: branch, label: `${branch} ↔ Working Tree` });
        return;
      case 'rebaseCurrentOnto':
        await this.runGitAction(`git rebase --autostash ${shellQuote(branch)}`, 'Rebase completed.');
        return;
      case 'mergeIntoCurrent':
        await this.runGitAction(mergeCommand(shellQuote(branch), []), 'Merge completed.');
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

  private async newBranchFrom(branch: string, branchType: Branch['type'] | undefined): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${branch}`,
      placeHolder: 'feature/my-branch',
      ignoreFocusOut: true,
      ...prefilledBranchName(branch, branchType === 'remote' ? 'remote' : 'local')
    });
    if (name) {
      await this.runGitAction(`git checkout -b ${shellQuote(name)} ${shellQuote(branch)}`, 'Branch created.');
      this.selectedBranch = name;
    }
  }

  private async newBranchFromCommit(hash: string): Promise<void> {
    const currentBranch = await this.getCurrentBranch();
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${hash.slice(0, 8)}`,
      placeHolder: 'feature/my-branch',
      ignoreFocusOut: true,
      ...prefilledBranchName(currentBranch)
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
      ...prefilledBranchName(currentBranch)
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

  private async resetCurrentBranchTo(hash: string): Promise<void> {
    const [currentBranch, target] = await Promise.all([this.getCurrentBranch(), this.describeCommit(hash)]);
    const head = currentBranch ?? 'HEAD (detached)';

    const picked = await pickResetMode(`Git Reset: ${head} → ${target}`);
    if (!picked) {
      return;
    }

    if (picked === 'hard') {
      const answer = await vscode.window.showWarningMessage(
        `Hard reset ${head} to ${hash.slice(0, 8)}? Any local changes will be lost.`,
        { modal: true },
        'Reset'
      );
      if (answer !== 'Reset') {
        return;
      }
    }

    await this.runGitAction(`git reset --${picked} ${hash}`, `Current branch reset (--${picked}).`);
  }

  private async describeCommit(hash: string): Promise<string> {
    const short = hash.slice(0, 8);
    try {
      const line = (await this.git.exec(`git log -1 --format=%s%x1f%an ${hash}`)).trim();
      const [subject, author] = line.split('\x1f');
      return subject && author ? `${short} "${subject}" by ${author}` : short;
    } catch {
      return short;
    }
  }

  private async headHash(): Promise<string> {
    return (await this.git.exec('git rev-parse HEAD')).trim();
  }

  private async undoCommit(hash: string): Promise<void> {
    // IntelliJ only offers Undo Commit on the newest commit, and it keeps the changes
    // rather than discarding them - that is a soft reset.
    if ((await this.headHash()) !== hash) {
      vscode.window.showInformationMessage('Undo Commit applies only to the most recent commit on the current branch.');
      return;
    }
    await this.runGitAction('git reset --soft HEAD~1', 'Commit undone. Its changes are staged again.');
  }

  private async editCommitMessage(hash: string): Promise<void> {
    const current = (await this.git.exec(`git log -1 --format=%B ${hash}`)).trim();
    const message = await vscode.window.showInputBox({
      prompt: `Edit the message of ${hash.slice(0, 8)}`,
      value: current,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'The commit message cannot be empty.')
    });
    if (!message) {
      return;
    }

    if ((await this.headHash()) === hash) {
      await this.runGitAction(`git commit --amend -m ${shellQuote(message)}`, 'Commit message updated.');
      return;
    }
    await this.rewriteHistory('reword', [hash], message, 'Commit message updated.');
  }

  private async dropCommits(hashes: string[]): Promise<void> {
    const label = hashes.length === 1 ? `commit ${hashes[0].slice(0, 8)}` : `${hashes.length} commits`;
    const answer = await vscode.window.showWarningMessage(
      `Drop ${label}? This rewrites the history of the current branch.`,
      { modal: true },
      'Drop'
    );
    if (answer !== 'Drop') {
      return;
    }
    await this.rewriteHistory('drop', hashes, undefined, hashes.length === 1 ? 'Commit dropped.' : 'Commits dropped.');
  }

  private async squashCommits(hashes: string[]): Promise<void> {
    if (hashes.length < 2) {
      vscode.window.showInformationMessage('Select at least two commits to squash.');
      return;
    }

    const subjects = await this.git.exec(`git log --no-walk=sorted --format=%s ${hashes.join(' ')}`);
    const message = await vscode.window.showInputBox({
      prompt: `Message for the squash of ${hashes.length} commits`,
      value: splitLines(subjects)[0] || '',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'The commit message cannot be empty.')
    });
    if (!message) {
      return;
    }
    await this.rewriteHistory('squash', hashes, message, 'Commits squashed.');
  }

  private async autosquashInto(hash: string, kind: 'fixup' | 'squash'): Promise<void> {
    // Both actions fold *staged* changes into an existing commit, so there is nothing to
    // do until something is staged.
    if (!(await this.git.exec('git diff --cached --name-only')).trim()) {
      vscode.window.showInformationMessage(`Stage the changes you want to ${kind} into ${hash.slice(0, 8)} first.`);
      return;
    }

    await this.runGitAction(`git commit --${kind}=${hash}`);
    await this.runRebase(
      `git rebase -i --autosquash --autostash ${await this.rebaseBase([hash])}`,
      // --autosquash already positions the marker commit, so accept the generated todo
      // list and the proposed message instead of opening an editor that would hang.
      { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
      kind === 'fixup' ? 'Fixup applied.' : 'Squashed into the selected commit.'
    );
  }

  private async rewriteHistory(
    op: 'drop' | 'squash' | 'reword',
    hashes: string[],
    message: string | undefined,
    successMessage: string
  ): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      GIT_SEQUENCE_EDITOR: `${this.rebaseEditor()} --todo`,
      GI_PRO_OP: op,
      GI_PRO_HASHES: hashes.join(' ')
    };

    let messageFile: string | undefined;
    if (message === undefined) {
      // No message to supply: take git's default rather than opening an editor, which
      // would block the child process forever.
      env.GIT_EDITOR = 'true';
    } else {
      messageFile = path.join(os.tmpdir(), `gi-pro-message-${process.pid}-${hashes[0].slice(0, 8)}`);
      fs.writeFileSync(messageFile, message.endsWith('\n') ? message : `${message}\n`);
      env.GIT_EDITOR = `${this.rebaseEditor()} --message`;
      env.GI_PRO_MESSAGE_FILE = messageFile;
    }

    try {
      await this.runRebase(`git rebase -i --autostash ${await this.rebaseBase(hashes)}`, env, successMessage);
    } finally {
      if (messageFile) {
        try {
          fs.unlinkSync(messageFile);
        } catch {
          // A leftover temp file is harmless.
        }
      }
    }
  }

  private async runRebase(command: string, env: NodeJS.ProcessEnv, successMessage: string): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Gitrail: ${command}` },
        () => this.git.exec(command, env)
      );
      vscode.window.showInformationMessage(successMessage);
    } catch (error) {
      // A conflict leaves the branch mid-rebase, and this panel has no UI for that state.
      // Abort so the repository is left exactly as it was, and say so explicitly.
      const aborted = await this.abortRebaseIfInProgress();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(aborted ? `${detail}\n\nThe rebase was aborted; the branch is unchanged.` : detail);
    }
  }

  private async abortRebaseIfInProgress(): Promise<boolean> {
    const gitDir = resolveGitDir(this.rootPath);
    if (!fs.existsSync(path.join(gitDir, 'rebase-merge')) && !fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
      return false;
    }
    try {
      await this.git.exec('git rebase --abort');
      return true;
    } catch {
      return false;
    }
  }

  // The rebase must start one commit before the oldest of the selection so every selected
  // commit appears in the todo list.
  private async rebaseBase(hashes: string[]): Promise<string> {
    // Ancestry, not dates: `rev-list --no-walk=sorted` orders by commit date, which ties
    // for commits made in the same second and disagrees with history order after a
    // rebase. merge-base returns the common ancestor, i.e. the oldest of the selection.
    const oldest = (await this.git.exec(`git merge-base --octopus ${hashes.join(' ')}`)).trim();
    const parents = (await this.git.exec(`git rev-list --parents -n 1 ${oldest}`)).trim().split(/\s+/);
    // A root commit has no parent, so <sha>^ would fail; rebase from the beginning.
    return parents.length > 1 ? `${oldest}^` : '--root';
  }

  private rebaseEditor(): string {
    // process.execPath is the VS Code binary; ELECTRON_RUN_AS_NODE makes it behave as
    // plain node, which avoids depending on node being installed on PATH.
    const editor = path.join(extensionUri().fsPath, 'dist', 'rebaseEditor.js');
    return `${shellQuote(process.execPath)} ${shellQuote(editor)}`;
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
      { location: vscode.ProgressLocation.Notification, title: `Gitrail: ${command}` },
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
    vscode.window.showInformationMessage(`${title} opened in Gitrail Git output.`);
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
      const { commits, hasMoreCommits } = await this.loadCommits(branches);
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
        hasMoreCommits,
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
        hasMoreCommits: false,
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
    const local = await this.git.exec("git for-each-ref --format='%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)' refs/heads");
    // refs/remotes/origin/HEAD shortens to plain "origin", which then shows up as a phantom
    // branch duplicating whatever it points at. It is a symbolic ref, so filter on that rather
    // than on the name: the old check looked for "HEAD ->" text, which --format never emits.
    const remote = await this.git.exec("git for-each-ref --format='%(refname)%09%(symref)%09%(objectname)' refs/remotes");
    const branches: Branch[] = [];

    for (const line of splitLines(local)) {
      const [name, head, upstream, trackingText, tip] = line.split('\t');
      if (name) {
        branches.push({
          name,
          type: 'local',
          current: head === '*',
          tip: tip || undefined,
          upstream: upstream || undefined,
          tracking: parseTrackingStatus(trackingText)
        });
      }
    }

    for (const line of splitLines(remote)) {
      const [refname, symref, tip] = line.split('\t');
      const name = (refname || '').replace(/^refs\/remotes\//, '').trim();
      // Skip the remote's default-branch pointer: symbolic normally, but also guard the name in
      // case someone has left a real ref sitting at refs/remotes/<remote>/HEAD.
      if (!name || symref || name.endsWith('/HEAD')) {
        continue;
      }
      branches.push({ name, type: 'remote', current: false, tip: (tip || '').trim() || undefined });
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

  // How deep the log has to run for the selected commit to still be listed. `rev-list ^hash`
  // counts the commits hash cannot reach, which approximates how many sit above it. It is only
  // an approximation: that count is ancestry, while the log is sorted by date, and an ancestor
  // with a skewed clock sorts above hash without being counted. Hence a page of slack. Filters
  // only ever remove rows, so a limit taken from the unfiltered count is never too small.
  // Returns 0 when there is nothing to keep on screen.
  private async depthOfSelectedCommit(): Promise<number> {
    if (!isCommitHash(this.selectedCommit)) {
      return 0;
    }
    try {
      const target = this.buildCommitLogTarget();
      const raw = await this.git.exec(`git rev-list --count ${target} ${shellQuote('^' + this.selectedCommit)}`);
      const above = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(above)) {
        return 0;
      }
      // Capped: a selection from the very bottom of a long history must not pull in all of it.
      return Math.min(above + GitLogController.commitPageSize, GitLogController.maxSelectedCommitDepth);
    } catch {
      // Not reachable from the current target, so no depth would bring it back.
      return 0;
    }
  }

  private buildCommitLogTarget(): string {
    if (this.commitFilterBranches.size > 0) {
      // Scope traversal directly to the selected refs (git ORs multiple positional
      // revs together), instead of --all + post-filtering a capped page — post-filtering
      // can drop real matches once commits from other branches fill the page first.
      return Array.from(this.commitFilterBranches).map(shellQuote).join(' ');
    }
    // --exclude only affects ref options that FOLLOW it, so it must precede --all.
    return '--exclude=refs/stash --all';
  }

  private buildCommitFilterArgs(): string {
    const query = this.commitFilterQuery.trim();
    const needsRegexFlags = Boolean(query) || this.commitFilterUsers.size > 0;
    const args: string[] = [];
    if (this.commitFilterNoMerges) {
      args.push('--no-merges');
    }
    if (needsRegexFlags) {
      // A single regex flavor (ERE) is used for both --grep and --author, since git
      // applies --fixed-strings/--extended-regexp/-i uniformly to both. "Non-regex"
      // query mode is implemented by escaping metacharacters before building the
      // pattern, not by switching flags.
      args.push('--extended-regexp');
      if (!this.commitFilterMatchCase) {
        args.push('-i');
      }
    }
    if (query) {
      const pattern = this.commitFilterRegex ? query : escapeRegExpLiteral(query);
      args.push(`--grep=${shellQuote(pattern)}`);
    }
    for (const user of this.commitFilterUsers) {
      // --author matches against the full "Name <email>" ident, so anchoring with a
      // trailing $ (as if matching just the name) never matches anything. Anchor up
      // to the " <" boundary instead.
      args.push(`--author=${shellQuote('^' + escapeRegExpLiteral(user) + ' <')}`);
    }
    return args.join(' ');
  }

  private async prependHashMatch(commits: Commit[]): Promise<void> {
    const query = this.commitFilterQuery.trim();
    if (!isCommitHash(query) || commits.some((commit) => commit.hash === query || commit.hash.startsWith(query))) {
      return;
    }
    try {
      const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
      const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -1 ${shellQuote(query)}`);
      const commit = parseCommitLine(raw.split(/\r?\n/)[0] || '');
      // This lookup bypasses the log's filters by design - pasting a hash should find the
      // commit. "No merge commits" is the one filter that must still hold, or the toggle
      // leaks back the single row it was asked to hide.
      if (this.commitFilterNoMerges && commit && commit.parents.length > 1) {
        return;
      }
      if (commit && !commits.some((existing) => existing.hash === commit.hash)) {
        commits.unshift(commit);
      }
    } catch {
      // query isn't a resolvable revision (invalid or ambiguous prefix) — ignore.
    }
  }

  private async loadCommits(branches: Branch[]): Promise<{ commits: Commit[]; hasMoreCommits: boolean }> {
    const target = this.buildCommitLogTarget();
    const filterArgs = this.buildCommitFilterArgs();
    const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
    const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -n ${this.commitLimit + 1} ${filterArgs} ${target}`);

    const commits: Commit[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const commit = parseCommitLine(line);
      if (commit) commits.push(commit);
    }
    const hasMoreCommits = commits.length > this.commitLimit;
    commits.splice(this.commitLimit);
    await this.prependHashMatch(commits);
    await this.assignCommitBranches(commits, branches);
    await this.assignGraphParents(commits);
    return { commits, hasMoreCommits };
  }

  private get commitFilterActive(): boolean {
    return Boolean(this.commitFilterQuery.trim()) ||
      this.commitFilterNoMerges ||
      this.commitFilterUsers.size > 0 ||
      this.commitFilterBranches.size > 0;
  }

  // A filter removes commits from the log but not from history, so a row's parent is often no
  // longer on screen and its lane simply ends - the graph falls apart into loose dots. git does
  // not rewrite parents for --grep, --author or --no-merges (only path-limited history
  // simplification does that), so the nearest surviving ancestors are worked out here.
  private async assignGraphParents(commits: Commit[]): Promise<void> {
    if (!commits.length || !this.commitFilterActive) {
      return;
    }

    // The last row's parents are below the page rather than filtered away, so they do not count
    // as broken. If nothing above it has lost a parent, a filter happened to match a contiguous
    // run of history and the walk below would only confirm what is already drawn.
    const visible = new Set(commits.map((commit) => commit.hash));
    const broken = commits.some((commit, index) =>
      index < commits.length - 1 && commit.parents.some((parent) => !visible.has(parent)));
    if (!broken) {
      return;
    }

    // Same target and same ordering as the log, capped, so this is a prefix superset of what is
    // displayed rather than an unbounded walk: `^oldest` would only subtract oldest's ancestry
    // and drag in every unrelated branch. A row whose ancestry leaves the window keeps the
    // behaviour it has today, which is a missing edge - never a wrong one.
    const window = Math.max(1, this.commitLimit) * 3;
    let raw: string;
    try {
      raw = await this.git.exec(`git rev-list --parents --date-order -n ${window} ${this.buildCommitLogTarget()}`);
    } catch {
      return;
    }

    const parentsOf = new Map<string, string[]>();
    for (const line of splitLines(raw)) {
      const [hash, ...rest] = line.trim().split(' ').filter(Boolean);
      if (hash) parentsOf.set(hash, rest);
    }

    for (const commit of commits) {
      commit.graphParents = GitLogController.nearestVisible(commit, visible, parentsOf);
    }
  }

  // Walks down through hidden commits to the first visible one on each path. Chains of hidden
  // merges branch, so the walk is capped in both directions: a graph row can only draw so many
  // lines before it stops meaning anything, and an unbounded fan-out would hang the render.
  private static nearestVisible(commit: Commit, visible: Set<string>, parentsOf: Map<string, string[]>): string[] {
    // Two, because that is what a node in a git graph can draw: a first parent and a merge
    // side. Allowing four let chains of hidden merges fan out and tripled the lane count.
    const maxParents = 2;
    const maxVisits = 500;
    const resolved: string[] = [];
    const seen = new Set<string>([commit.hash]);
    const queue = [...commit.parents];
    let visits = 0;

    while (queue.length && resolved.length < maxParents && visits < maxVisits) {
      const hash = queue.shift() as string;
      if (seen.has(hash)) continue;
      seen.add(hash);
      visits += 1;
      if (visible.has(hash)) {
        resolved.push(hash);
        continue;
      }
      const next = parentsOf.get(hash);
      if (next) queue.push(...next);
    }

    return resolved;
  }

  private async assignCommitBranches(commits: Commit[], branches: Branch[]): Promise<void> {
    if (!commits.length) {
      return;
    }

    const membership = await this.branchMembership(branches);
    for (const commit of commits) {
      const names = membership.get(commit.hash);
      if (names) {
        // Branch order, not rev-list completion order, so the hint on a row does not reshuffle
        // between renders.
        commit.branches.push(...names);
      }
    }
  }

  // Which branches contain which commits. This was around 60% of the cost of applying a
  // commit filter - one rev-list per branch, every keystroke - while typing in the search box
  // moves no branch tip at all. rev-list from a fixed tip is immutable in git, so caching on
  // the tips plus the depth is exact rather than a guess: the same inputs cannot produce a
  // different answer. A branch whose tip could not be read disables the cache, and a failed
  // rev-list is not cached either, so a ref deleted mid-refresh is retried rather than
  // remembered as absent.
  private async branchMembership(branches: Branch[]): Promise<Map<string, string[]>> {
    const depth = Math.max(1000, this.commitLimit);
    const keyable = branches.every((branch) => Boolean(branch.tip));
    const key = branches.map((branch) => `${branch.name}@${branch.tip}`).join('\n');
    const cached = this.branchMembershipCache;
    if (keyable && cached && cached.key === key && cached.depth >= depth) {
      return cached.map;
    }

    const lists = await Promise.all(branches.map(async (branch) => {
      try {
        const output = await this.git.exec(`git rev-list -n ${depth} ${shellQuote(branch.name)}`);
        return { name: branch.name, hashes: splitLines(output) };
      } catch {
        // Deleted or otherwise unreadable ref during a refresh.
        return undefined;
      }
    }));

    const map = new Map<string, string[]>();
    for (const list of lists) {
      if (!list) {
        continue;
      }
      for (const hash of list.hashes) {
        const names = map.get(hash);
        if (names) {
          names.push(list.name);
        } else {
          map.set(hash, [list.name]);
        }
      }
    }

    if (keyable && lists.every(Boolean)) {
      this.branchMembershipCache = { key, depth, map };
    }
    return map;
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

// showQuickPick always highlights the first item; IntelliJ pre-selects Mixed, so drive
// the picker directly to keep the same default while preserving the Soft/Mixed/Hard/Keep order.
function pickResetMode(title: string): Promise<(typeof RESET_MODES)[number]['mode'] | undefined> {
  type ResetItem = vscode.QuickPickItem & { mode: (typeof RESET_MODES)[number]['mode'] };
  const picker = vscode.window.createQuickPick<ResetItem>();
  picker.title = title;
  picker.placeholder = 'Select how the working tree and the index are updated';
  picker.ignoreFocusOut = true;
  picker.matchOnDetail = true;
  picker.items = RESET_MODES.map((entry) => ({ label: entry.label, detail: entry.detail, mode: entry.mode }));
  picker.activeItems = picker.items.filter((item) => item.mode === 'mixed');

  return new Promise((resolve) => {
    let picked: ResetItem | undefined;
    picker.onDidAccept(() => {
      picked = picker.selectedItems[0];
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(picked?.mode);
    });
    picker.show();
  });
}

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

function mediaUri(webview: vscode.Webview, name: string): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri(), 'media', name));
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

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommitHash(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{7,40}$/i.test(value));
}

type BranchNamePrefill = Pick<vscode.InputBoxOptions, 'value' | 'valueSelection' | 'validateInput'>;

/**
 * Seeds a New Branch prompt with a name derived from `base`, selected end to end so it can be
 * typed straight over or edited in place.
 */
function prefilledBranchName(base: string | undefined, branchType: 'local' | 'remote' = 'local'): BranchNamePrefill {
  const suggestion = suggestBranchName(base, branchType);
  return {
    value: suggestion,
    valueSelection: [0, suggestion.length],
    validateInput: validateBranchName
  };
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
