import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from '../gitRunner';
import { GitLogController } from './controller';
import { extensionUri } from './extensionHome';
import { renderErrorHtml } from './html';
import { resolveGitDir } from './parse';
import type { WebviewMessage } from './types';

export class GitLogViewProvider implements vscode.WebviewViewProvider {
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
