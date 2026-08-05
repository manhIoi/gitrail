// Standalone helper invoked by git as GIT_SEQUENCE_EDITOR / GIT_EDITOR during a
// non-interactive `git rebase -i`. It must not import vscode: git spawns it as a plain
// node process (the extension host binary re-run with ELECTRON_RUN_AS_NODE=1).
//
// git appends the file it wants edited, so argv is [node, script, <mode>, <file>]:
//
//   --todo     rewrite the rebase todo list. Reads GI_PRO_OP (drop|squash|reword) and
//              GI_PRO_HASHES (space separated).
//   --message  overwrite the file with the contents of GI_PRO_MESSAGE_FILE.
//
// Anything unexpected exits non-zero, which makes git abort the rebase rather than
// silently rewriting history the wrong way.

import * as fs from 'node:fs';

type TodoOp = 'drop' | 'squash' | 'reword';

const TODO_OPS: TodoOp[] = ['drop', 'squash', 'reword'];

function hashesMatch(todoHash: string, target: string): boolean {
  // The todo list carries abbreviated hashes; callers pass full ones.
  return todoHash.startsWith(target) || target.startsWith(todoHash);
}

function rewriteTodo(file: string, op: TodoOp, targets: string[]): void {
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  // Index the pick lines first: `squash` folds a commit into whatever precedes it in the
  // todo list, so validating the selection needs their positions, not just a count.
  const picks: number[] = [];
  const matchedPicks: number[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(pick|p)\s+([0-9a-f]+)\s/i);
    if (!match) {
      return;
    }
    picks.push(index);
    if (targets.some((target) => hashesMatch(match[2], target))) {
      matchedPicks.push(index);
    }
  });

  if (!matchedPicks.length) {
    throw new Error('No matching commits in the rebase todo list.');
  }

  if (op === 'squash') {
    // Without a second match there is nothing to fold in, and git would report a
    // successful no-op rebase.
    if (matchedPicks.length < 2) {
      throw new Error('Squash needs at least two commits in the rebase todo list.');
    }
    // Non-adjacent commits would each fold into their unselected neighbour instead of
    // into the oldest selection - the wrong commit, silently. Refuse.
    const positions = matchedPicks.map((index) => picks.indexOf(index));
    const contiguous = positions.every((position, offset) => offset === 0 || position === positions[offset - 1] + 1);
    if (!contiguous) {
      throw new Error('Squash requires consecutive commits. Deselect the commits in between and try again.');
    }
  }

  const selected = new Set(matchedPicks);
  const oldestSelected = matchedPicks[0];
  const rewritten = lines.flatMap((line, index) => {
    if (!selected.has(index)) {
      return [line];
    }
    if (op === 'drop') {
      return [];
    }
    if (op === 'reword') {
      return [line.replace(/^(pick|p)\s/i, 'reword ')];
    }
    // The todo list is oldest-first, so the first match is the commit the rest fold into.
    return index === oldestSelected ? [line] : [line.replace(/^(pick|p)\s/i, 'squash ')];
  });

  fs.writeFileSync(file, rewritten.join('\n'));
}

function main(): void {
  const mode = process.argv[2];
  const file = process.argv[3];
  if (!file) {
    throw new Error('git did not pass a file to edit.');
  }

  if (mode === '--message') {
    const source = process.env.GI_PRO_MESSAGE_FILE;
    if (!source) {
      throw new Error('GI_PRO_MESSAGE_FILE is not set.');
    }
    fs.writeFileSync(file, fs.readFileSync(source, 'utf8'));
    return;
  }

  if (mode !== '--todo') {
    throw new Error(`Unknown rebase editor mode: ${mode}`);
  }

  const op = process.env.GI_PRO_OP as TodoOp | undefined;
  const targets = (process.env.GI_PRO_HASHES || '').split(/\s+/).filter(Boolean);
  if (!op || !TODO_OPS.includes(op)) {
    throw new Error(`Unknown rebase todo op: ${op}`);
  }
  if (!targets.length) {
    throw new Error('GI_PRO_HASHES is empty.');
  }

  rewriteTodo(file, op, targets);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
