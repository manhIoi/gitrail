import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { prefilledBranchName, remoteBranchParts, validateBranchName, validateRefName } from '../branchNames';
import { GitRunner, shellQuote } from '../gitRunner';
import { mergeCommand } from '../mergeOptions';
import { showBranchDiffInScm } from './branchDiff';
import { extensionUri } from './extensionHome';
import { renderHtml } from './html';
import {
  escapeRegExpLiteral, isBranchNotFullyMergedError, isCommitHash, parseChangedFile,
  parseCommitLine, parseTrackingStatus, pathExistsInRef, resolveGitDir, splitLines
} from './parse';
import { pickResetMode } from './prompts';
import type {
  Branch, BranchDiff, ChangedFile, Commit, CommitDetail, ViewOptions, ViewState, WebviewMessage
} from './types';

export class GitLogController {
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

      if (message.type === 'setViewOption' && isViewOptionKey(message.key)) {
        // The View menu writes the setting rather than a copy of it, so there is one source
        // of truth and toggling here is what the panel opens with next time.
        await vscode.workspace.getConfiguration('giPro.logView')
          .update(message.key, Boolean(message.value), vscode.ConfigurationTarget.Global);
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
    if (await pathExistsInRef(this.git, branch, filePath)) {
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
      if (await pathExistsInRef(this.git, branch, file.path)) {
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
        viewOptions: readViewOptions(),
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
        viewOptions: readViewOptions(),
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

function readViewOptions(): ViewOptions {
  const config = vscode.workspace.getConfiguration('giPro.logView');
  return {
    highlightCurrentBranch: config.get<boolean>('highlightCurrentBranch', true),
    highlightMyCommits: config.get<boolean>('highlightMyCommits', true)
  };
}

function isViewOptionKey(key: string | undefined): key is keyof ViewOptions {
  return key === 'highlightCurrentBranch' || key === 'highlightMyCommits';
}
