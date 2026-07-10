import * as path from 'node:path';
import * as vscode from 'vscode';
import { showBranchDiffWithWorkingTree, showGitLogView, GitProContentProvider, registerGitLogView } from './gitLogView';
import { GitRunner, shellQuote } from './gitRunner';
import { registerHistoryView, showFileHistoryView, showSelectionHistoryView } from './historyView';
import { registerInlineBlame } from './inlineBlame';

type Command = {
  id: string;
  handler: () => Promise<void>;
};

type BranchPickItem = vscode.QuickPickItem & {
  action?: 'updateProject' | 'commit' | 'push' | 'newBranch' | 'checkoutRevision' | 'branch';
  branch?: string;
  branchType?: 'local' | 'remote';
  current?: boolean;
  upstream?: string;
  tracking?: BranchTrackingStatus;
};

type BranchTrackingStatus = {
  ahead: number;
  behind: number;
};

type BranchActionItem = vscode.QuickPickItem & {
  action:
    | 'checkout'
    | 'newBranchFrom'
    | 'checkoutRebaseOnto'
    | 'compareWithCurrent'
    | 'diffWithWorkingTree'
    | 'rebaseCurrentOnto'
    | 'mergeIntoCurrent'
    | 'update'
    | 'push'
    | 'rename'
    | 'delete';
};

let gitOutputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitRunner();
  gitOutputChannel = vscode.window.createOutputChannel('GI Pro Git');
  context.subscriptions.push(gitOutputChannel);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('gitpro', new GitProContentProvider(git)));
  registerGitLogView(context, git);
  registerHistoryView(context);
  registerInlineBlame(context);
  registerAbortContextRefresh(context, git);

  const commands: Command[] = [
    { id: 'giPro.smartCommit', handler: () => smartCommit(git) },
    { id: 'giPro.fetch', handler: () => execGitAction(git, 'git fetch --all --prune', 'Fetch completed.', 'Fetching all remotes...') },
    { id: 'giPro.pullRebase', handler: () => execGitAction(git, 'git pull --rebase --autostash', 'Pull with rebase completed.', 'Pulling with rebase...') },
    { id: 'giPro.push', handler: () => execGitAction(git, 'git push', 'Push completed.', 'Pushing...') },
    { id: 'giPro.forcePushLease', handler: () => confirmAndRun(git, 'Force push with lease?', 'git push --force-with-lease', 'Force pushing with lease...') },
    { id: 'giPro.amendNoEdit', handler: () => confirmAndRun(git, 'Amend the last commit without editing its message?', 'git commit --amend --no-edit', 'Amending last commit...') },
    { id: 'giPro.interactiveRebase', handler: () => interactiveRebase(git) },
    { id: 'giPro.abortGitOperation', handler: () => abortGitOperation(git) },
    { id: 'giPro.stash', handler: () => stash(git) },
    { id: 'giPro.stashPop', handler: () => stashPop(git) },
    { id: 'giPro.checkoutBranch', handler: () => checkoutBranch(git) },
    { id: 'giPro.branches', handler: () => branches(context, git) },
    { id: 'giPro.compareFileWithHead', handler: () => compareFileWithHead(git) },
    { id: 'giPro.showFileHistory', handler: () => showFileHistory(git) },
    { id: 'giPro.showHistoryForSelection', handler: () => showHistoryForSelection(git) },
    { id: 'giPro.openGitLogView', handler: () => showGitLogView(context, git) },
    { id: 'giPro.cherryPick', handler: () => cherryPick(git) }
  ];

  for (const command of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, command.handler));
  }

  void refreshAbortContext(git);
}

export function deactivate(): void {
  // Nothing to dispose outside VS Code subscriptions.
}

async function smartCommit(git: GitRunner): Promise<void> {
  const status = await safeExec(git, 'git status --porcelain');
  if (!status) {
    vscode.window.showInformationMessage('No changes to commit.');
    return;
  }

  const stageChoice = await vscode.window.showQuickPick(
    [
      { label: 'Commit staged changes', command: undefined },
      { label: 'Stage all and commit', command: 'git add -A' }
    ],
    { placeHolder: 'Choose Smart Commit mode' }
  );
  if (!stageChoice) {
    return;
  }

  const message = await vscode.window.showInputBox({
    prompt: 'Commit message',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Commit message is required.'
  });
  if (!message) {
    return;
  }

  try {
    if (stageChoice.command) {
      await git.exec(stageChoice.command);
    }
    await git.exec(`git commit -m ${shellQuote(message)}`);
    vscode.window.showInformationMessage('Commit created.');

    const config = vscode.workspace.getConfiguration('giPro');
    if (config.get<boolean>('smartCommitPushAfterCommit', false)) {
      const push = await vscode.window.showInformationMessage('Push after commit?', 'Push', 'Skip');
      if (push === 'Push') {
        await execGitAction(git, 'git push', 'Push completed.');
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(errorMessage);
  }
}

async function interactiveRebase(git: GitRunner): Promise<void> {
  const count = await vscode.window.showInputBox({
    prompt: 'Number of commits to include in interactive rebase',
    value: '5',
    validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive number.'
  });
  if (count) {
    await execGitAction(git, `git rebase -i HEAD~${count}`, 'Interactive rebase started.');
  }
}

async function abortGitOperation(git: GitRunner): Promise<void> {
  const operation = await detectAbortableOperation(git);
  if (!operation) {
    vscode.window.showInformationMessage('No merge, rebase, cherry-pick, or revert operation is in progress.');
    await refreshAbortContext(git);
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Abort current ${operation.label}? This will roll back the in-progress Git operation.`,
    { modal: true },
    'Abort'
  );
  if (answer !== 'Abort') {
    return;
  }

  await execGitAction(git, operation.command, `${operation.label} aborted.`);
}

function registerAbortContextRefresh(context: vscode.ExtensionContext, git: GitRunner): void {
  const refresh = () => void refreshAbortContext(git);
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge,rebase-apply}');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete(refresh),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        refresh();
      }
    })
  );
}

async function refreshAbortContext(git: GitRunner): Promise<void> {
  const operation = await detectAbortableOperation(git);
  await vscode.commands.executeCommand('setContext', 'giPro.abortAvailable', Boolean(operation));
}

async function detectAbortableOperation(git: GitRunner): Promise<{ label: string; command: string } | undefined> {
  if (await commandSucceeds(git, 'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"')) {
    return { label: 'rebase', command: 'git rebase --abort' };
  }
  if (await commandSucceeds(git, 'git rev-parse -q --verify MERGE_HEAD')) {
    return { label: 'merge', command: 'git merge --abort' };
  }
  if (await commandSucceeds(git, 'git rev-parse -q --verify CHERRY_PICK_HEAD')) {
    return { label: 'cherry-pick', command: 'git cherry-pick --abort' };
  }
  if (await commandSucceeds(git, 'git rev-parse -q --verify REVERT_HEAD')) {
    return { label: 'revert', command: 'git revert --abort' };
  }
  return undefined;
}

async function commandSucceeds(git: GitRunner, command: string): Promise<boolean> {
  try {
    await git.exec(command);
    return true;
  } catch {
    return false;
  }
}

async function stash(git: GitRunner): Promise<void> {
  const message = await vscode.window.showInputBox({
    prompt: 'Optional stash message',
    ignoreFocusOut: true
  });
  await execGitAction(git, message ? `git stash push -u -m ${shellQuote(message)}` : 'git stash push -u', 'Stash created.');
}

async function stashPop(git: GitRunner): Promise<void> {
  const output = await safeExec(git, 'git stash list');
  if (!output) {
    vscode.window.showInformationMessage('No stashes found.');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    output.split('\n').map((line) => ({ label: line, stash: line.split(':')[0] })),
    { placeHolder: 'Select stash to pop' }
  );
  if (selected) {
    await execGitAction(git, `git stash pop ${selected.stash}`, 'Stash popped.');
  }
}

async function checkoutBranch(git: GitRunner): Promise<void> {
  const items = await checkoutBranchItems(git);
  const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Checkout branch' });
  if (!selected?.branch || !selected.branchType) {
    return;
  }

  await checkoutSelectedBranch(git, selected.branch, selected.branchType);
}

async function branches(context: vscode.ExtensionContext, git: GitRunner): Promise<void> {
  const currentBranch = await getCurrentBranch(git);
  const items = await branchPickItems(git, currentBranch);
  const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Search for branches and actions' });
  if (!selected) {
    return;
  }

  if (selected.action === 'updateProject') {
    await execGitAction(git, 'git pull --rebase --autostash', 'Project updated.');
    return;
  }

  if (selected.action === 'commit') {
    await smartCommit(git);
    return;
  }

  if (selected.action === 'push') {
    await execGitAction(git, 'git push', 'Push completed.');
    return;
  }

  if (selected.action === 'newBranch') {
    await newBranchFromHead(git);
    return;
  }

  if (selected.action === 'checkoutRevision') {
    await checkoutRevision(git);
    return;
  }

  if (selected.action === 'branch' && selected.branch && selected.branchType) {
    await showBranchActions(context, git, selected.branch, selected.branchType, selected.current ?? false, currentBranch);
  }
}

async function checkoutBranchItems(git: GitRunner): Promise<BranchPickItem[]> {
  const [localOutput, remoteOutput] = await Promise.all([
    safeExec(git, "git for-each-ref --format='%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)' refs/heads"),
    safeExec(git, 'git branch -r --format="%(refname:short)"')
  ]);

  const locals: BranchPickItem[] = splitLines(localOutput || '').map((line) => {
    const [branch, head, upstream, trackingText] = line.split('\t');
    const tracking = parseTrackingStatus(trackingText);
    return {
      label: branch,
      description: branchDescription(upstream, tracking, head === '*'),
      iconPath: branchIcon(head === '*', tracking),
      branch,
      branchType: 'local',
      current: head === '*',
      upstream,
      tracking
    };
  });

  const remotes: BranchPickItem[] = splitLines(remoteOutput || '')
    .filter((branch) => !branch.endsWith('/HEAD'))
    .map((branch) => ({
      label: branch.replace(/^origin\//, ''),
      description: branch,
      iconPath: new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue')),
      branch,
      branchType: 'remote',
      current: false
    }));

  return [
    { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
    ...locals,
    { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
    ...remotes
  ];
}

async function newBranchFromHead(git: GitRunner): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'New branch from HEAD',
    placeHolder: 'feature/my-branch',
    ignoreFocusOut: true,
    validateInput: validateBranchName
  });
  if (name) {
    await execGitAction(git, `git checkout -b ${shellQuote(name)}`, `Created and checked out ${name}.`);
  }
}

async function branchPickItems(git: GitRunner, currentBranch: string | undefined): Promise<BranchPickItem[]> {
  const [localOutput, remoteOutput] = await Promise.all([
    safeExec(git, "git for-each-ref --format='%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)' refs/heads"),
    safeExec(git, 'git branch -r --format="%(refname:short)"')
  ]);

  const locals: BranchPickItem[] = splitLines(localOutput || '').map((line) => {
    const [branch, head, upstream, trackingText] = line.split('\t');
    const tracking = parseTrackingStatus(trackingText);
    return {
      label: branch,
      description: branchDescription(upstream, tracking, head === '*'),
      iconPath: branchIcon(head === '*', tracking),
      action: 'branch',
      branch,
      branchType: 'local',
      current: head === '*',
      upstream,
      tracking
    };
  });

  const remotes: BranchPickItem[] = splitLines(remoteOutput || '')
    .filter((branch) => !branch.endsWith('/HEAD'))
    .map((branch) => ({
      label: branch.replace(/^origin\//, ''),
      description: branch,
      iconPath: new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue')),
      action: 'branch',
      branch,
      branchType: 'remote',
      current: false
    }));

  const recent = locals
    .filter((branch) => branch.current || branch.branch === currentBranch)
    .slice(0, 1);

  return [
    { label: 'Update Project...', description: 'Pull with rebase and autostash', action: 'updateProject' },
    { label: 'Commit...', action: 'commit' },
    { label: 'Push...', action: 'push' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '+ New Branch...', description: 'Create from HEAD', action: 'newBranch' },
    { label: 'Checkout Tag or Revision...', action: 'checkoutRevision' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...(recent.length ? [{ label: 'Recent', kind: vscode.QuickPickItemKind.Separator } satisfies BranchPickItem, ...recent] : []),
    { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
    ...locals,
    { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
    ...remotes
  ];
}

async function showBranchActions(
  context: vscode.ExtensionContext,
  git: GitRunner,
  branch: string,
  branchType: 'local' | 'remote',
  isCurrent: boolean,
  currentBranch: string | undefined
): Promise<void> {
  const selected = await vscode.window.showQuickPick(branchActionItems(branch, branchType, isCurrent, currentBranch), {
    placeHolder: `Actions for ${branch}`
  });
  if (!selected) {
    return;
  }

  switch (selected.action) {
    case 'checkout':
      await checkoutSelectedBranch(git, branch, branchType);
      return;
    case 'newBranchFrom':
      await newBranchFromRef(git, branch);
      return;
    case 'checkoutRebaseOnto':
      if (currentBranch) {
        await execGitAction(git, `git checkout ${shellQuote(branch)} && git rebase ${shellQuote(currentBranch)}`, 'Checkout and rebase completed.');
      }
      return;
    case 'compareWithCurrent':
      if (currentBranch) {
        await showGitOutput(git, `git log --left-right --cherry-pick --oneline ${shellQuote(currentBranch)}...${shellQuote(branch)}`, `Compare ${currentBranch}...${branch}`);
      }
      return;
    case 'diffWithWorkingTree':
      await showBranchDiffWithWorkingTree(context, git, branch);
      return;
    case 'rebaseCurrentOnto':
      await execGitAction(git, `git rebase ${shellQuote(branch)}`, 'Rebase completed.');
      return;
    case 'mergeIntoCurrent':
      await execGitAction(git, `git merge --no-ff ${shellQuote(branch)}`, 'Merge completed.');
      return;
    case 'update':
      await updateSelectedBranch(git, branch, branchType, currentBranch);
      return;
    case 'push':
      await pushSelectedBranch(git, branch, branchType);
      return;
    case 'rename':
      await renameSelectedBranch(git, branch, branchType);
      return;
    case 'delete':
      await deleteSelectedBranch(git, branch, branchType);
      return;
  }
}

function branchActionItems(
  branch: string,
  branchType: 'local' | 'remote',
  isCurrent: boolean,
  currentBranch: string | undefined
): BranchActionItem[] {
  const current = currentBranch || 'current branch';
  const isRemote = branchType === 'remote';
  const items: BranchActionItem[] = [
    { label: 'Checkout', action: 'checkout', description: isCurrent ? 'current branch' : undefined },
    { label: `New Branch from '${branch}'...`, action: 'newBranchFrom' }
  ];

  if (!isCurrent && !isRemote && currentBranch) {
    items.push({ label: `Checkout and Rebase onto '${current}'`, action: 'checkoutRebaseOnto' });
  }

  if (currentBranch && branch !== currentBranch) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: 'compareWithCurrent' },
      { label: `Compare with '${current}'`, action: 'compareWithCurrent' }
    );
  }

  items.push({ label: 'Show Diff with Working Tree', action: 'diffWithWorkingTree' });

  if (currentBranch && branch !== currentBranch) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: 'rebaseCurrentOnto' },
      { label: `Rebase '${current}' onto '${branch}'`, action: 'rebaseCurrentOnto' },
      { label: `Merge '${branch}' into '${current}'`, action: 'mergeIntoCurrent' }
    );
  }

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator, action: 'update' },
    { label: 'Update', action: 'update' }
  );

  if (!isRemote) {
    items.push({ label: 'Push...', action: 'push' });
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'rename' });
  if (!isRemote) {
    items.push({ label: 'Rename...', action: 'rename' });
  }
  items.push({ label: 'Delete', action: 'delete' });
  return items;
}

async function checkoutSelectedBranch(git: GitRunner, branch: string, branchType: 'local' | 'remote'): Promise<void> {
  const command = branchType === 'remote'
    ? `git checkout -t ${shellQuote(branch)}`
    : `git checkout ${shellQuote(branch)}`;
  await execGitAction(git, command, 'Branch checked out.');
}

async function newBranchFromRef(git: GitRunner, ref: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: `New branch from ${ref}`,
    placeHolder: 'feature/my-branch',
    ignoreFocusOut: true,
    validateInput: validateBranchName
  });
  if (name) {
    await execGitAction(git, `git checkout -b ${shellQuote(name)} ${shellQuote(ref)}`, `Created and checked out ${name}.`);
  }
}

async function checkoutRevision(git: GitRunner): Promise<void> {
  const ref = await vscode.window.showInputBox({
    prompt: 'Checkout tag, branch, or revision',
    placeHolder: 'v1.0.0 or abc1234',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Revision is required.'
  });
  if (ref) {
    await execGitAction(git, `git checkout ${shellQuote(ref)}`, 'Revision checked out.');
  }
}

async function updateSelectedBranch(git: GitRunner, branch: string, branchType: 'local' | 'remote', currentBranch: string | undefined): Promise<void> {
  if (branchType === 'remote') {
    await execGitAction(git, 'git fetch --all --prune', 'Remote branches updated.');
    return;
  }

  if (currentBranch === branch) {
    await execGitAction(git, 'git pull --ff-only', 'Branch updated.');
    return;
  }

  const { remote, remoteBranch } = await resolveUpstream(git, branch);
  await execGitAction(git, `git fetch ${shellQuote(remote)} ${shellQuote(remoteBranch)}:${shellQuote(branch)}`, 'Branch updated.');
}

async function resolveUpstream(git: GitRunner, branch: string): Promise<{ remote: string; remoteBranch: string }> {
  let upstream: string | undefined;
  try {
    upstream = (await git.exec(`git rev-parse --abbrev-ref ${shellQuote(branch)}@{upstream}`)).trim() || undefined;
  } catch {
    upstream = undefined;
  }

  const slashIndex = upstream?.indexOf('/') ?? -1;
  return slashIndex > 0
    ? { remote: upstream!.slice(0, slashIndex), remoteBranch: upstream!.slice(slashIndex + 1) }
    : { remote: 'origin', remoteBranch: branch };
}

async function pushSelectedBranch(git: GitRunner, branch: string, branchType: 'local' | 'remote'): Promise<void> {
  if (branchType === 'remote') {
    vscode.window.showInformationMessage('Remote branches cannot be pushed directly. Checkout a local branch first.');
    return;
  }
  await execGitAction(git, `git push -u origin ${shellQuote(branch)}`, 'Branch pushed.');
}

async function renameSelectedBranch(git: GitRunner, branch: string, branchType: 'local' | 'remote'): Promise<void> {
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
    await execGitAction(git, `git branch -m ${shellQuote(branch)} ${shellQuote(name)}`, 'Branch renamed.');
  }
}

async function deleteSelectedBranch(git: GitRunner, branch: string, branchType: 'local' | 'remote'): Promise<void> {
  const answer = await vscode.window.showWarningMessage(`Delete branch ${branch}?`, { modal: true }, 'Delete');
  if (answer !== 'Delete') {
    return;
  }

  const remote = remoteBranchParts(branch);
  if (branchType === 'remote' && remote) {
    await execGitAction(git, `git push ${shellQuote(remote.remote)} --delete ${shellQuote(remote.name)}`, 'Branch deleted.');
    return;
  }

  try {
    await git.exec(`git branch -d ${shellQuote(branch)}`);
    vscode.window.showInformationMessage('Branch deleted.');
  } catch (error) {
    if (!isBranchNotFullyMergedError(error)) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    const forceAnswer = await vscode.window.showWarningMessage(
      `Branch ${branch} is not fully merged. Delete it anyway?`,
      { modal: true },
      'Force Delete'
    );
    if (forceAnswer === 'Force Delete') {
      await execGitAction(git, `git branch -D ${shellQuote(branch)}`, 'Branch deleted.');
    }
  } finally {
    await refreshAbortContext(git);
  }
}

function isBranchNotFullyMergedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not fully merged/i.test(message);
}

async function compareFileWithHead(git: GitRunner): Promise<void> {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  await showGitOutput(git, `git diff HEAD -- ${shellQuote(file)}`, `Diff HEAD -- ${file}`);
}

async function showFileHistory(git: GitRunner): Promise<void> {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  try {
    await showFileHistoryView(git, file);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function showHistoryForSelection(git: GitRunner): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const file = getActiveFile();
  if (!editor || !file) {
    return;
  }

  const selection = editor.selection;
  const startLine = selection.start.line + 1;
  // A selection ending at column 0 does not include that line.
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1;

  try {
    await showSelectionHistoryView(git, file, startLine, endLine);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function cherryPick(git: GitRunner): Promise<void> {
  const output = await safeExec(git, 'git log --oneline -n 50');
  if (!output) {
    vscode.window.showInformationMessage('No commits found.');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    output.split('\n').map((line) => {
      const [hash, ...message] = line.split(' ');
      return { label: hash, description: message.join(' '), hash };
    }),
    { placeHolder: 'Select commit to cherry-pick' }
  );

  if (selected) {
    await execGitAction(git, `git cherry-pick ${selected.hash}`, 'Cherry-pick completed.');
  }
}

async function confirmAndRun(git: GitRunner, prompt: string, command: string, progressTitle?: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, 'Run');
  if (answer === 'Run') {
    await execGitAction(git, command, 'Git action completed.', progressTitle);
  }
}

async function safeExec(git: GitRunner, command: string): Promise<string | undefined> {
  try {
    return await git.exec(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
    return undefined;
  }
}

async function execGitAction(git: GitRunner, command: string, successMessage: string, progressTitle?: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: progressTitle ?? `GI Pro: ${command}` },
      () => git.exec(command)
    );
    vscode.window.showInformationMessage(successMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
  } finally {
    await refreshAbortContext(git);
  }
}

async function showGitOutput(git: GitRunner, command: string, title: string): Promise<void> {
  try {
    const output = await git.exec(command);
    const channel = getGitOutputChannel();
    channel.clear();
    channel.appendLine(`$ ${command}`);
    channel.appendLine('');
    channel.appendLine(output || '(no output)');
    channel.show(true);
    vscode.window.showInformationMessage(`${title} opened in GI Pro Git output.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
  }
}

function getGitOutputChannel(): vscode.OutputChannel {
  if (!gitOutputChannel) {
    gitOutputChannel = vscode.window.createOutputChannel('GI Pro Git');
  }
  return gitOutputChannel;
}

async function getCurrentBranch(git: GitRunner): Promise<string | undefined> {
  const branch = await safeExec(git, 'git branch --show-current');
  return branch || undefined;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function parseTrackingStatus(value: string | undefined): BranchTrackingStatus {
  const ahead = Number(value?.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(value?.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}

function branchDescription(upstream: string | undefined, tracking: BranchTrackingStatus, isCurrent: boolean): string {
  const parts: string[] = [];
  if (tracking.behind) {
    parts.push(`↓ ${tracking.behind}`);
  }
  if (tracking.ahead) {
    parts.push(`↑ ${tracking.ahead}`);
  }
  if (upstream) {
    parts.push(upstream);
  } else if (isCurrent) {
    parts.push('current');
  } else {
    parts.push('local');
  }
  return parts.join('  ');
}

function branchIcon(isCurrent: boolean, tracking: BranchTrackingStatus): vscode.ThemeIcon {
  if (isCurrent) {
    return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
  }
  if (tracking.ahead && tracking.behind) {
    return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.purple'));
  }
  if (tracking.behind) {
    return new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.orange'));
  }
  if (tracking.ahead) {
    return new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('charts.blue'));
  }
  return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.blue'));
}

function remoteBranchParts(branch: string): { remote: string; name: string } | undefined {
  const [remote, ...parts] = branch.split('/');
  if (!remote || !parts.length) {
    return undefined;
  }
  return { remote, name: parts.join('/') };
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

function getActiveFile(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const fileName = editor?.document.uri.fsPath;
  if (!fileName) {
    vscode.window.showErrorMessage('Open a file before running this command.');
    return undefined;
  }

  return path.relative(vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? path.dirname(fileName), fileName);
}
