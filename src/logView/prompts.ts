import * as vscode from 'vscode';
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