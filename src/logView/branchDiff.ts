import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRunner, shellQuote } from '../gitRunner';
import { parseChangedFile, pathExistsInRef, splitLines } from './parse';
import type { BranchDiff, ChangedFile, DiffTarget } from './types';

const branchDiffViewId = 'giPro.branchDiffView';

let currentBranchDiffProvider: BranchDiffTreeProvider | undefined;

export function registerBranchDiffView(context: vscode.ExtensionContext, git: GitRunner): void {
  void vscode.commands.executeCommand('setContext', 'giPro.branchDiffVisible', false);
  void vscode.commands.executeCommand('setContext', 'giPro.branchDiffAvailable', false);
  currentBranchDiffProvider = new BranchDiffTreeProvider(git);
  const tree = vscode.window.createTreeView(branchDiffViewId, {
    treeDataProvider: currentBranchDiffProvider,
    showCollapseAll: true
  });
  currentBranchDiffProvider.attachTree(tree);
  context.subscriptions.push(
    tree,
    vscode.commands.registerCommand('giPro.branchDiff.refresh', () => currentBranchDiffProvider?.refresh()),
    vscode.commands.registerCommand('giPro.branchDiff.getAll', () => currentBranchDiffProvider?.getAll()),
    vscode.commands.registerCommand('giPro.branchDiff.close', () => currentBranchDiffProvider?.close()),
    vscode.commands.registerCommand('giPro.branchDiff.openFile', (item?: BranchDiffTreeItem) => currentBranchDiffProvider?.openItem(item)),
    vscode.commands.registerCommand('giPro.branchDiff.getFile', (item?: BranchDiffTreeItem) => currentBranchDiffProvider?.getItem(item))
  );
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
export type BranchDiffTreeItem = BranchDiffFolderItem | BranchDiffFileItem | BranchDiffMessageItem;
export class BranchDiffFolderItem extends vscode.TreeItem {
  readonly children: BranchDiffTreeItem[] = [];

  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'giProBranchDiffFolder';
  }
}
export class BranchDiffFileItem extends vscode.TreeItem {
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
export class BranchDiffMessageItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'giProBranchDiffMessage';
  }
}
export function buildBranchDiffTree(files: ChangedFile[]): BranchDiffTreeItem[] {
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
export function sortBranchDiffItems(items: BranchDiffTreeItem[]): void {
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
async function openScmView(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.scm');
  } catch {
    // Older cached manifests or VS Code builds may not expose the SCM focus command.
  }
}
export async function showBranchDiffInScm(target: DiffTarget): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'giPro.branchDiffVisible', true);
  await openScmView();
  await currentBranchDiffProvider?.showDiff(target);
  await vscode.commands.executeCommand(`${branchDiffViewId}.focus`);
}
