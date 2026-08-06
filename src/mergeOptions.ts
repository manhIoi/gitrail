import * as vscode from 'vscode';

// Mirrors the "Modify options" dropdown of IntelliJ's Merge dialog. These sit behind the
// explicit "Merge ... with Options" action; the plain Merge action runs a bare `git merge`
// and allows a fast-forward, which is what IntelliJ's branch popup does.
export const MERGE_OPTIONS = [
  { flag: '--no-ff', detail: 'Create a merge commit even if the merge could be resolved as a fast-forward.' },
  { flag: '--ff-only', detail: 'Resolve the merge only if it is possible to fast-forward.' },
  { flag: '--squash', detail: 'Create a single commit with all merged changes on top of the current branch.' },
  { flag: '--no-commit', detail: 'Merge but do not create the merge commit, so you can inspect the result.' },
  { flag: '--no-verify', detail: 'Bypass the pre-merge and commit-message hooks.' },
  { flag: '--allow-unrelated-histories', detail: 'Merge histories that do not share a common ancestor.' }
] as const;

// --no-ff / --ff-only / --squash decide the same thing three different ways; git errors
// out when they are combined, so reject it here with a message that names the conflict.
const EXCLUSIVE = ['--no-ff', '--ff-only', '--squash'];

export async function pickMergeOptions(title: string): Promise<string[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    MERGE_OPTIONS.map((option) => ({ label: option.flag, detail: option.detail })),
    {
      title,
      placeHolder: 'Select merge options, or confirm with none for a plain merge',
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDetail: true
    }
  );
  if (!picked) {
    return undefined;
  }

  const flags = picked.map((option) => option.label);
  const conflicting = flags.filter((flag) => EXCLUSIVE.includes(flag));
  if (conflicting.length > 1) {
    vscode.window.showErrorMessage(`${conflicting.join(' and ')} cannot be combined. Pick one.`);
    return undefined;
  }

  return flags;
}

export function mergeCommand(branch: string, flags: string[]): string {
  return ['git merge', ...flags, branch].join(' ');
}
