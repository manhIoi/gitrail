import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitRunner, shellQuote } from '../gitRunner';
import type { BranchTrackingStatus, ChangedFile, Commit } from './types';

export function resolveGitDir(rootPath: string): string {
  const dotGit = path.join(rootPath, '.git');
  try {
    // In worktrees and submodules .git is a file containing "gitdir: <path>".
    if (fs.statSync(dotGit).isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (match) {
        return path.resolve(rootPath, match[1].trim());
      }
    }
  } catch {
    // Fall through to the default .git directory.
  }
  return dotGit;
}
export function parseCommitLine(line: string): Commit | undefined {
  const marker = line.indexOf('\x1f');
  if (marker < 0) {
    return undefined;
  }

  const [hash, parents, author, date, refs, subject] = line.slice(marker + 1).split('\x1f');
  if (!isCommitHash(hash)) {
    return undefined;
  }

  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    branches: [],
    subject,
    author,
    date,
    refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : []
  };
}
export function parseChangedFile(line: string): ChangedFile | undefined {
  const [status, first, second] = line.split('\t');
  if (!status || !first) {
    return undefined;
  }

  if (status.startsWith('R') && second) {
    return { status, previousPath: first, path: second };
  }

  return { status, path: first };
}
export function isBranchNotFullyMergedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not fully merged/i.test(message);
}
export function parseTrackingStatus(value: string | undefined): BranchTrackingStatus {
  const ahead = Number(value?.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(value?.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}
export async function pathExistsInRef(git: GitRunner, ref: string, filePath: string): Promise<boolean> {
  try {
    await git.exec(`git cat-file -e ${shellQuote(ref + ':' + filePath)}`);
    return true;
  } catch {
    return false;
  }
}
export function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}
export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function isCommitHash(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{7,40}$/i.test(value));
}