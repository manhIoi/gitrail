import * as path from 'node:path';
import * as vscode from 'vscode';
import { showGitLogView, GitProContentProvider, registerGitLogView } from './gitLogView';
import { GitRunner, shellQuote } from './gitRunner';
import { registerInlineBlame } from './inlineBlame';

type Command = {
  id: string;
  handler: () => Promise<void>;
};

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitRunner();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('gitpro', new GitProContentProvider(git)));
  registerGitLogView(context, git);
  registerInlineBlame(context);

  const commands: Command[] = [
    { id: 'intellijGit.smartCommit', handler: () => smartCommit(git) },
    { id: 'intellijGit.fetch', handler: () => git.run('git fetch --all --prune') },
    { id: 'intellijGit.pullRebase', handler: () => git.run('git pull --rebase --autostash') },
    { id: 'intellijGit.push', handler: () => git.run('git push') },
    { id: 'intellijGit.forcePushLease', handler: () => confirmAndRun(git, 'Force push with lease?', 'git push --force-with-lease') },
    { id: 'intellijGit.amendNoEdit', handler: () => confirmAndRun(git, 'Amend the last commit without editing its message?', 'git commit --amend --no-edit') },
    { id: 'intellijGit.interactiveRebase', handler: () => interactiveRebase(git) },
    { id: 'intellijGit.stash', handler: () => stash(git) },
    { id: 'intellijGit.stashPop', handler: () => stashPop(git) },
    { id: 'intellijGit.checkoutBranch', handler: () => checkoutBranch(git) },
    { id: 'intellijGit.compareFileWithHead', handler: () => compareFileWithHead(git) },
    { id: 'intellijGit.showFileHistory', handler: () => showFileHistory(git) },
    { id: 'intellijGit.showLogGraph', handler: () => git.run('git log --graph --decorate --oneline --all -n 80') },
    { id: 'intellijGit.openGitLogView', handler: () => showGitLogView(context, git) },
    { id: 'intellijGit.cherryPick', handler: () => cherryPick(git) }
  ];

  for (const command of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, command.handler));
  }
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

  if (stageChoice.command) {
    await git.run(stageChoice.command);
  }
  await git.run(`git commit -m ${shellQuote(message)}`);

  const config = vscode.workspace.getConfiguration('intellijGit');
  if (config.get<boolean>('smartCommitPushAfterCommit', false)) {
    const push = await vscode.window.showInformationMessage('Push after commit?', 'Push', 'Skip');
    if (push === 'Push') {
      await git.run('git push');
    }
  }
}

async function interactiveRebase(git: GitRunner): Promise<void> {
  const count = await vscode.window.showInputBox({
    prompt: 'Number of commits to include in interactive rebase',
    value: '5',
    validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive number.'
  });
  if (count) {
    await git.run(`git rebase -i HEAD~${count}`);
  }
}

async function stash(git: GitRunner): Promise<void> {
  const message = await vscode.window.showInputBox({
    prompt: 'Optional stash message',
    ignoreFocusOut: true
  });
  await git.run(message ? `git stash push -u -m ${shellQuote(message)}` : 'git stash push -u');
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
    await git.run(`git stash pop ${selected.stash}`);
  }
}

async function checkoutBranch(git: GitRunner): Promise<void> {
  const output = await safeExec(git, 'git branch --all --format="%(refname:short)"');
  if (!output) {
    vscode.window.showInformationMessage('No branches found.');
    return;
  }

  const branches = output
    .split('\n')
    .map((branch) => branch.trim())
    .filter((branch) => branch && !branch.includes('HEAD ->'))
    .map((branch) => ({
      label: branch.replace(/^origin\//, ''),
      description: branch.startsWith('origin/') ? 'remote' : 'local',
      branch
    }));

  const selected = await vscode.window.showQuickPick(branches, { placeHolder: 'Checkout branch' });
  if (!selected) {
    return;
  }

  const command = selected.branch.startsWith('origin/')
    ? `git checkout -t ${shellQuote(selected.branch)}`
    : `git checkout ${shellQuote(selected.branch)}`;
  await git.run(command);
}

async function compareFileWithHead(git: GitRunner): Promise<void> {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  await git.run(`git diff HEAD -- ${shellQuote(file)}`);
}

async function showFileHistory(git: GitRunner): Promise<void> {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  await git.run(`git log --follow --decorate --oneline -- ${shellQuote(file)}`);
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
    await git.run(`git cherry-pick ${selected.hash}`);
  }
}

async function confirmAndRun(git: GitRunner, prompt: string, command: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, 'Run');
  if (answer === 'Run') {
    await git.run(command);
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

function getActiveFile(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const fileName = editor?.document.uri.fsPath;
  if (!fileName) {
    vscode.window.showErrorMessage('Open a file before running this command.');
    return undefined;
  }

  return path.relative(vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? path.dirname(fileName), fileName);
}
