// Unit tests for src/gitSpawn.ts, run against the compiled dist/ with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawnGit, GitTimeoutError } = require('../dist/gitSpawn.js');

const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@example.com',
  GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@example.com'
};

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrail-spawn-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: identity });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  return dir;
}

test('returns stdout of a successful command', async () => {
  const dir = makeRepo();
  const out = await spawnGit(['log', '--format=%s'], { cwd: dir });
  assert.equal(out.trim(), 'first');
});

test('rejects with git stderr when the command fails', async () => {
  const dir = makeRepo();
  await assert.rejects(spawnGit(['log', 'no-such-ref'], { cwd: dir }), /unknown revision|bad revision|ambiguous argument/);
});

test('is not capped at exec()\'s 10 MB', async () => {
  const dir = makeRepo();
  // 20 MB of NUL bytes: exec() with maxBuffer 10 MB would have thrown here.
  const out = await spawnGit(['-c', '20000000', '/dev/zero'], { cwd: dir, command: 'head' });
  assert.equal(out.length, 20_000_000);
});

test('kills the child and rejects with GitTimeoutError after timeoutMs', async () => {
  const dir = makeRepo();
  const started = Date.now();
  await assert.rejects(spawnGit(['5'], { cwd: dir, timeoutMs: 100, command: 'sleep' }), GitTimeoutError);
  assert.ok(Date.now() - started < 3000, 'the child was killed rather than waited for');
});
