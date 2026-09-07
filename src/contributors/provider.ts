import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from '../gitRunner';
import { GitTimeoutError } from '../gitSpawn';
import { extensionUri } from '../logView/extensionHome';
import { renderErrorHtml } from '../logView/html';
import { resolveGitDir } from '../logView/parse';
import { renderContributorsHtml } from './html';
import { contributorLogArgs, parseContributorLog } from './stats';
import type { ContributorsMessage, ContributorsState } from './types';

const contributorsViewId = 'giPro.contributorsView';
const contributorsPanelId = 'giProContributorsPanel';
// A whole-history numstat on a very large repository can run for a while; past this it is
// killed and the user is told, rather than left with a progress bar that never ends.
const computeTimeoutMs = 60_000;

let currentProvider: ContributorsViewProvider | undefined;

export function registerContributorsView(context: vscode.ExtensionContext, git: GitRunner): void {
  currentProvider = new ContributorsViewProvider(git);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(contributorsViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
}

export async function showContributorsView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${contributorsPanelId}`);
  } catch {
    // Older cached manifests or VS Code builds may not expose a container focus command.
  }
  await vscode.commands.executeCommand(`${contributorsViewId}.focus`);
  await currentProvider?.refreshIfHeadMoved();
}

export class ContributorsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private root: string | undefined;
  private state: ContributorsState | undefined;
  private computing: Promise<void> | undefined;
  private repoWatchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private needsCheck = false;

  constructor(private readonly git: GitRunner) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri(), 'media')]
    };
    const root = await this.git.getWorkspaceRoot();
    if (!root) {
      webviewView.webview.html = renderErrorHtml('Open a folder before opening Contributors.');
      return;
    }
    this.root = root.fsPath;

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as ContributorsMessage;
      if (message?.type === 'refresh') {
        void this.compute();
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.needsCheck) {
        this.needsCheck = false;
        void this.refreshIfHeadMoved();
      }
    });
    webviewView.onDidDispose(() => this.stopWatching());
    this.watchRepository(this.root);
    await this.compute();
  }

  // Recompute only when HEAD points somewhere new. Ref churn from fetches and branch work
  // that leaves HEAD alone costs one rev-parse and nothing more.
  async refreshIfHeadMoved(): Promise<void> {
    if (!this.root || this.computing) {
      return;
    }
    const head = await this.currentHead();
    if (head && head === this.state?.head) {
      return;
    }
    await this.compute();
  }

  private async currentHead(): Promise<string | undefined> {
    try {
      return (await this.git.exec('git rev-parse HEAD')).trim();
    } catch {
      // Unborn branch or not a repository: git log below reports it.
      return undefined;
    }
  }

  private compute(): Promise<void> {
    if (!this.root) {
      return Promise.resolve();
    }
    if (!this.computing) {
      this.computing = this.doCompute(this.root).finally(() => {
        this.computing = undefined;
      });
    }
    return this.computing;
  }

  private async doCompute(root: string): Promise<void> {
    // Keep the previous cards on screen under a progress bar rather than blanking the view.
    this.render({ root, generatedAt: Date.now(), contributors: [], ...this.state, loading: true, error: undefined });
    const head = await this.currentHead();
    try {
      const stdout = await this.git.stream(contributorLogArgs(), computeTimeoutMs);
      const parsed = parseContributorLog(stdout);
      this.state = { root, head, generatedAt: Date.now(), firstWeek: parsed.firstWeek, contributors: parsed.contributors };
    } catch (error) {
      const message = error instanceof GitTimeoutError
        ? 'Computing contributors took too long. Try again with Refresh.'
        : error instanceof Error ? error.message : String(error);
      this.state = {
        root,
        head,
        generatedAt: Date.now(),
        firstWeek: this.state?.firstWeek,
        contributors: this.state?.contributors ?? [],
        error: message
      };
    }
    this.render(this.state);
  }

  private render(state: ContributorsState): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = renderContributorsHtml(this.view.webview, state);
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
        new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,packed-refs,refs/**}')
      );
      const schedule = () => this.scheduleCheck();
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.repoWatchers.push(watcher);
    }
  }

  private scheduleCheck(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.view?.visible) {
        void this.refreshIfHeadMoved();
      } else {
        this.needsCheck = true;
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
