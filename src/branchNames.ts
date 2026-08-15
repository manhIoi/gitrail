import type * as vscode from 'vscode';

// Branches that exist to be branched off, so their own names say nothing about how the
// new branch should be named.
const LONG_LIVED_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'dev', 'trunk']);

/**
 * Prefill for a "New Branch" prompt, derived from the ref the branch starts at so the
 * naming convention is already in the box and only the parts that differ need editing.
 * A remote ref drops its remote (`origin/feature/login` → `feature/login`), which is the
 * local name it would get anyway. A long-lived base branch prefills nothing.
 */
export function suggestBranchName(base: string | undefined, branchType: 'local' | 'remote' = 'local'): string {
  const trimmed = (base ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (branchType === 'remote') {
    return trimmed.split('/').slice(1).join('/');
  }
  return LONG_LIVED_BRANCHES.has(trimmed.toLowerCase()) ? '' : trimmed;
}

type BranchNamePrefill = Pick<vscode.InputBoxOptions, 'value' | 'valueSelection' | 'validateInput'>;

/**
 * Seeds a New Branch prompt with a name derived from `base`, selected end to end so it can be
 * typed straight over or edited in place.
 */
export function prefilledBranchName(base: string | undefined, branchType: 'local' | 'remote' = 'local'): BranchNamePrefill {
  const suggestion = suggestBranchName(base, branchType);
  return {
    value: suggestion,
    valueSelection: [0, suggestion.length],
    validateInput: validateBranchName
  };
}

export function validateBranchName(value: string): string | undefined {
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

export function validateRefName(value: string): string | undefined {
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

/** Splits `origin/feature/login` into its remote and the branch name on that remote. */
export function remoteBranchParts(branch: string): { remote: string; name: string } | undefined {
  const parts = branch.split('/');
  const remote = parts.shift();
  const name = parts.join('/');
  if (!remote || !name) {
    return undefined;
  }
  return { remote, name };
}
