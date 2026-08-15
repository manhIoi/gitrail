import * as vscode from 'vscode';
import { suggestBranchName } from '../gitRunner';
import { RESET_MODES } from './types';

// showQuickPick always highlights the first item; IntelliJ pre-selects Mixed, so drive
// the picker directly to keep the same default while preserving the Soft/Mixed/Hard/Keep order.
export function pickResetMode(title: string): Promise<(typeof RESET_MODES)[number]['mode'] | undefined> {
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
export type BranchNamePrefill = Pick<vscode.InputBoxOptions, 'value' | 'valueSelection' | 'validateInput'>;
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
