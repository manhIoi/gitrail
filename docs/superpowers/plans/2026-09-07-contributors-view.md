# Contributors View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Contributors** panel in Gitrail that shows, GitHub-style, one card per author with rank, commit / added / deleted totals and a weekly bar chart, with Range and Metric menus.

**Architecture:** The extension runs `git log HEAD --no-merges --numstat` **once per HEAD hash** through a new no-buffer-limit `spawn` helper, folds it into per-author, per-week rows in pure TypeScript (`src/contributors/stats.ts`), and embeds that state into a webview. The front end (`media/contributors.js` + `.css`, no framework) does all filtering, ranking and SVG drawing, so Range/Metric changes never touch git. A provider mirrors `src/logView/provider.ts`: same CSP/nonce shell, same repo watcher, recomputing only when `git rev-parse HEAD` moves.

**Tech Stack:** TypeScript 5.5 (`tsc`, CommonJS `dist/`), VS Code API ^1.92, plain browser JS/CSS/SVG in `media/`, Node 22 `node --test` for unit tests, headless Google Chrome for the webview check.

**Spec:** `docs/superpowers/specs/2026-09-07-contributors-view-design.md`

## Global Constraints

- Command IDs, config keys and view IDs stay in the `giPro.*` namespace; user-facing strings say **Gitrail** (CLAUDE.md).
- Webview CSP is `default-src 'none'` plus nonce'd `style-src` / `script-src`. **No `style=""` attributes** anywhere in generated markup (they are blocked); use classes, SVG presentation attributes, or `element.style.prop = …` from JS.
- CSS tokens live on `:root` built from `--vscode-*` variables with literal fallbacks; every per-theme value is restated literally in `body.vscode-light` (never `--x: var(--y)` across theme blocks). See CLAUDE.md "Verifying webview changes".
- Dynamic text is escaped through an `html()` helper before it reaches `innerHTML`.
- `tsc` never sees `media/`; webview changes are verified by rendering in headless Chrome for **both** `vscode-dark` and `vscode-light`.
- Week buckets are **Monday 00:00 UTC**, computed identically in `stats.ts` and `contributors.js` (`FIRST_MONDAY = 4 * 86400`, i.e. 1970-01-05).
- Merge commits are excluded; binary numstat rows (`-\t-`) are skipped for line counts.
- No new npm dependencies.
- One deviation from the spec, decided here: the view gets **its own panel container** `giProContributorsPanel` (title "Contributors") next to the "Gitrail" and "History" tabs, following `giProHistoryPanel`'s precedent, rather than a second view inside `giProPanel`. Two views in one panel container render side by side and would squash the Log View, whose `.app` has `min-width: 980px`.

---

## File map

| Path | Status | Responsibility |
|------|--------|----------------|
| `src/gitSpawn.ts` | create | `spawnGit(args, {cwd, timeoutMs, command})`: run git via `child_process.spawn`, unlimited stdout, `GitTimeoutError`. No `vscode` import so it is unit-testable. |
| `src/gitRunner.ts` | modify | `GitRunner.stream(args, timeoutMs)` wrapping `spawnGit` with the workspace root. |
| `src/contributors/types.ts` | create | `WeekRow`, `Contributor`, `ContributorsState`, `ContributorsMessage`. |
| `src/contributors/stats.ts` | create | `contributorLogArgs()`, `weekStart()`, `parseContributorLog()`. Pure. |
| `src/contributors/html.ts` | create | `renderContributorsHtml(webview, state)`: CSP shell, `window.__gitrailContributors`. |
| `src/contributors/provider.ts` | create | `ContributorsViewProvider`, `registerContributorsView()`, `showContributorsView()`. |
| `media/contributors.css` | create | Tokens, toolbar, dropdown shell, card grid, chart, tooltip. |
| `media/contributors.js` | create | Render from state; Range/Metric; ranking; SVG charts; tooltip. |
| `src/extension.ts` | modify | Register the view and the `giPro.openContributorsView` command. |
| `package.json` | modify | View container, view, command, activation events, `test` scripts. |
| `test/gitSpawn.test.js` | create | `node --test` for `spawnGit`. |
| `test/stats.test.js` | create | `node --test` for `stats.ts`. |
| `test/render-contributors.js` | create | Headless-Chrome render + assertions for the webview. |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md` | modify | Document the feature and the new directory. |

---

### Task 1: `spawnGit` and `GitRunner.stream`

**Files:**
- Create: `src/gitSpawn.ts`
- Modify: `src/gitRunner.ts` (add import and one method after `exec()`)
- Modify: `package.json` (`scripts.test`)
- Test: `test/gitSpawn.test.js`

**Interfaces:**
- Produces: `spawnGit(args: string[], options: { cwd: string; timeoutMs?: number; command?: string }): Promise<string>` and `class GitTimeoutError extends Error` from `src/gitSpawn.ts`; `GitRunner.stream(args: string[], timeoutMs?: number): Promise<string>`.

- [ ] **Step 1: Add the test script and write the failing test**

In `package.json` `scripts`, add after `"lint"`:

```json
    "test": "npm run compile && node --test test/*.test.js",
```

Create `test/gitSpawn.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../dist/gitSpawn.js'`.

- [ ] **Step 3: Write `src/gitSpawn.ts`**

```ts
import * as cp from 'node:child_process';

export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

export type SpawnGitOptions = {
  cwd: string;
  // Kill the child and reject once this many milliseconds have passed.
  timeoutMs?: number;
  // Tests point this at another executable; production always runs git.
  command?: string;
};

/**
 * Runs git without a shell and returns all of stdout, however large. GitRunner.exec() caps
 * stdout at 10 MB, which `git log --numstat` over a whole history can exceed.
 */
export function spawnGit(args: string[], options: SpawnGitOptions): Promise<string> {
  const command = options.command ?? 'git';
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        reject(new GitTimeoutError(`${command} ${args[0] ?? ''} took longer than ${options.timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
```

- [ ] **Step 4: Add `stream()` to `GitRunner`**

In `src/gitRunner.ts`, add the import at the top:

```ts
import { spawnGit } from './gitSpawn';
```

and this method directly after `exec()`:

```ts
  // Like exec(), but without a shell and without a stdout cap. For commands whose output
  // grows with the repository, such as `git log --numstat` over the whole history.
  async stream(args: string[], timeoutMs?: number): Promise<string> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace folder is open.');
    }
    return spawnGit(args, { cwd: root.fsPath, timeoutMs });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: 4 passing tests, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/gitSpawn.ts src/gitRunner.ts package.json test/gitSpawn.test.js
git commit -m "Add a no-buffer-limit git spawn helper"
```

---

### Task 2: Contributor stats parser

**Files:**
- Create: `src/contributors/types.ts`
- Create: `src/contributors/stats.ts`
- Test: `test/stats.test.js`

**Interfaces:**
- Produces (from `types.ts`):
  ```ts
  type WeekRow = [week: number, commits: number, additions: number, deletions: number];
  type Contributor = { name: string; email: string; commits: number; additions: number; deletions: number; weeks: WeekRow[] };
  type ContributorsState = { root: string; head?: string; generatedAt: number; firstWeek?: number; contributors: Contributor[]; loading?: boolean; error?: string };
  type ContributorsMessage = { type?: string };
  ```
- Produces (from `stats.ts`): `contributorLogArgs(): string[]`, `weekStart(unixSeconds: number): number`, `parseContributorLog(stdout: string): { contributors: Contributor[]; firstWeek?: number }`.

- [ ] **Step 1: Write the failing tests**

Create `test/stats.test.js`:

```js
// Unit tests for src/contributors/stats.ts, run against dist/ with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { contributorLogArgs, weekStart, parseContributorLog } = require('../dist/contributors/stats.js');

const RS = '\x1e';
const US = '\x1f';
const utc = (...parts) => Math.floor(Date.UTC(...parts) / 1000);

// One commit as `git log --numstat --format=%x1e%aN%x1f%aE%x1f%at` prints it: the format
// line, numstat rows, then a blank line.
function commit(name, email, time, files) {
  const rows = files.map(([added, deleted, file]) => `${added}\t${deleted}\t${file}`).join('\n');
  return `${RS}${name}${US}${email}${US}${time}\n${rows}${rows ? '\n' : ''}\n`;
}

test('contributorLogArgs asks for HEAD without merges, with numstat and unix author dates', () => {
  assert.deepEqual(contributorLogArgs(), [
    'log', 'HEAD', '--no-merges', '--numstat', '--date=unix', '--format=%x1e%aN%x1f%aE%x1f%at'
  ]);
});

test('weekStart snaps to Monday 00:00 UTC', () => {
  // 2026-09-07 is a Monday.
  const monday = utc(2026, 8, 7);
  assert.equal(weekStart(monday), monday);
  assert.equal(weekStart(utc(2026, 8, 7, 0, 0, 1)), monday);
  assert.equal(weekStart(utc(2026, 8, 13, 23, 59, 59)), monday);
  assert.equal(weekStart(utc(2026, 8, 6, 23, 59, 59)), utc(2026, 7, 31));
  assert.equal(weekStart(utc(2026, 8, 14)), utc(2026, 8, 14));
});

test('sums every numstat row of a commit', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[10, 2, 'a.ts'], [5, 1, 'b.ts']]));
  assert.equal(contributors.length, 1);
  assert.deepEqual(contributors[0], {
    name: 'Ann', email: 'ann@example.com', commits: 1, additions: 15, deletions: 3,
    weeks: [[utc(2026, 8, 7), 1, 15, 3]]
  });
});

test('skips binary rows for line counts but still counts the commit', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [['-', '-', 'logo.png'], [3, 0, 'a.ts']]));
  assert.equal(contributors[0].commits, 1);
  assert.equal(contributors[0].additions, 3);
  assert.equal(contributors[0].deletions, 0);
});

test('a commit with no file changes still counts', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), []));
  assert.equal(contributors[0].commits, 1);
  assert.deepEqual(contributors[0].weeks, [[utc(2026, 8, 7), 1, 0, 0]]);
});

test('merges emails that differ only in case, and names the group after the newest commit', () => {
  // git prints newest first; the second line here is older but carries the newer-looking name,
  // so the name must come from the timestamp, not from line order.
  const log =
    commit('A. Nguyen', 'Ann@Example.com', utc(2026, 8, 1), [[1, 0, 'a']]) +
    commit('Ann', 'ann@example.com', utc(2026, 7, 1), [[1, 0, 'a']]) +
    commit('Ann Nguyen', 'ann@example.com', utc(2026, 8, 9), [[1, 0, 'a']]);
  const { contributors } = parseContributorLog(log);
  assert.equal(contributors.length, 1);
  assert.equal(contributors[0].name, 'Ann Nguyen');
  assert.equal(contributors[0].commits, 3);
  assert.deepEqual(contributors[0].weeks.map((row) => row[0]), [utc(2026, 6, 27), utc(2026, 7, 31), utc(2026, 8, 7)]);
});

test('an empty email groups by name and does not merge with other empty emails', () => {
  const log =
    commit('claude', '', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('bot', '', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('claude', '', utc(2026, 8, 1), [[1, 0, 'a']]);
  const { contributors } = parseContributorLog(log);
  assert.deepEqual(contributors.map((c) => [c.name, c.commits]), [['claude', 2], ['bot', 1]]);
});

test('sorts by commits descending, then by name, and reports the earliest week', () => {
  const log =
    commit('Zed', 'zed@example.com', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('Bao', 'bao@example.com', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('Bao', 'bao@example.com', utc(2026, 5, 3), [[1, 0, 'a']]) +
    commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[1, 0, 'a']]);
  const { contributors, firstWeek } = parseContributorLog(log);
  assert.deepEqual(contributors.map((c) => c.name), ['Bao', 'Ann', 'Zed']);
  assert.equal(firstWeek, utc(2026, 5, 1));
});

test('empty output yields no contributors and no first week', () => {
  assert.deepEqual(parseContributorLog(''), { contributors: [], firstWeek: undefined });
});

test('tolerates CRLF line endings', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[4, 4, 'a.ts']]).replace(/\n/g, '\r\n'));
  assert.equal(contributors[0].additions, 4);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../dist/contributors/stats.js'`.

- [ ] **Step 3: Write `src/contributors/types.ts`**

```ts
// One week of one author's activity: [Monday 00:00 UTC as Unix seconds, commits, additions, deletions].
// A tuple rather than an object because there is one per author per week and it is
// serialised into the webview on every render.
export type WeekRow = [week: number, commits: number, additions: number, deletions: number];

export type Contributor = {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  // Ascending by week; weeks with no commits are omitted.
  weeks: WeekRow[];
};

export type ContributorsState = {
  root: string;
  // HEAD hash the data was computed for; the provider recomputes only when this moves.
  head?: string;
  generatedAt: number;
  // Earliest week with a commit, so "All time" knows where its axis starts.
  firstWeek?: number;
  contributors: Contributor[];
  loading?: boolean;
  error?: string;
};

export type ContributorsMessage = {
  type?: string;
};
```

- [ ] **Step 4: Write `src/contributors/stats.ts`**

```ts
import type { Contributor, WeekRow } from './types';

const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Monday 1970-01-05 00:00 UTC: 1970-01-01 was a Thursday. media/contributors.js declares the
// same constant, and the two must agree or the chart's columns miss the rows.
const FIRST_MONDAY = 4 * 24 * 60 * 60;

/** Arguments for the one git command the Contributors view runs. */
export function contributorLogArgs(): string[] {
  // %aN/%aE honour .mailmap; %x1e opens a commit and %x1f splits its fields, neither of which
  // can appear in a name or email. Merges are left out as GitHub does, and their numstat is
  // meaningless anyway.
  return ['log', 'HEAD', '--no-merges', '--numstat', '--date=unix', '--format=%x1e%aN%x1f%aE%x1f%at'];
}

/** Monday 00:00 UTC of the week containing the given Unix time, as Unix seconds. */
export function weekStart(unixSeconds: number): number {
  return Math.floor((unixSeconds - FIRST_MONDAY) / WEEK_SECONDS) * WEEK_SECONDS + FIRST_MONDAY;
}

export type ParsedContributorLog = {
  contributors: Contributor[];
  firstWeek?: number;
};

type Group = {
  name: string;
  email: string;
  latest: number;
  commits: number;
  additions: number;
  deletions: number;
  weeks: Map<number, WeekRow>;
};

/** Folds the stdout of `git <contributorLogArgs()>` into per-author, per-week totals. */
export function parseContributorLog(stdout: string): ParsedContributorLog {
  const groups = new Map<string, Group>();
  let current: { group: Group; week: WeekRow } | undefined;
  let firstWeek: number | undefined;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      continue;
    }

    if (line.charCodeAt(0) === 0x1e) {
      const [name = '', email = '', time = ''] = line.slice(1).split('\x1f');
      const authorTime = Number(time);
      if (!Number.isFinite(authorTime)) {
        current = undefined;
        continue;
      }
      // Emails are case-insensitive; a missing email falls back to the name, prefixed so a
      // name can never collide with somebody's address.
      const key = email ? 'e:' + email.toLowerCase() : 'n:' + name;
      let group = groups.get(key);
      if (!group) {
        group = { name, email, latest: authorTime, commits: 0, additions: 0, deletions: 0, weeks: new Map() };
        groups.set(key, group);
      } else if (authorTime > group.latest) {
        group.latest = authorTime;
        group.name = name;
      }
      const week = weekStart(authorTime);
      let row = group.weeks.get(week);
      if (!row) {
        row = [week, 0, 0, 0];
        group.weeks.set(week, row);
      }
      row[1] += 1;
      group.commits += 1;
      if (firstWeek === undefined || week < firstWeek) {
        firstWeek = week;
      }
      current = { group, week: row };
      continue;
    }

    if (!current) {
      continue;
    }
    // numstat: "<added>\t<deleted>\t<path>", with "-" for binary files.
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match || match[1] === '-' || match[2] === '-') {
      continue;
    }
    const added = Number(match[1]);
    const deleted = Number(match[2]);
    current.week[2] += added;
    current.week[3] += deleted;
    current.group.additions += added;
    current.group.deletions += deleted;
  }

  const contributors: Contributor[] = Array.from(groups.values())
    .map((group) => ({
      name: group.name,
      email: group.email,
      commits: group.commits,
      additions: group.additions,
      deletions: group.deletions,
      weeks: Array.from(group.weeks.values()).sort((a, b) => a[0] - b[0])
    }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));

  return { contributors, firstWeek };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests in both files pass, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/contributors/types.ts src/contributors/stats.ts test/stats.test.js
git commit -m "Parse git numstat into per-author weekly contribution rows"
```

---

### Task 3: Webview shell, stylesheet, and the card grid (no chart yet)

**Files:**
- Create: `src/contributors/html.ts`
- Create: `media/contributors.css`
- Create: `media/contributors.js`
- Create: `test/render-contributors.js`
- Modify: `package.json` (`scripts["test:webview"]`)

**Interfaces:**
- Consumes: `ContributorsState` from Task 2; `getNonce` (`src/webviewUtil.ts`); `mediaUri` (`src/logView/html.ts`); `setExtensionHome`/`extensionUri` (`src/logView/extensionHome.ts`).
- Produces: `renderContributorsHtml(webview: vscode.Webview, state: ContributorsState): string`. The page reads `window.__gitrailContributors`, posts `{ type: 'refresh' }`, persists `{ range, metric }` via `vscode.setState()`. DOM contract used by the harness and Task 4: `.toolbar`, `.summary`, `.progress.active`, `.banner.error`, `.empty`, `.grid`, `.contributor-card[data-index]`, `.avatar.avatar-N`, `.name`, `.totals .add/.del`, `.rank`, `.chart-host`, `#tooltip`.

- [ ] **Step 1: Write the render harness with failing assertions**

Add to `package.json` `scripts` after `"test"`:

```json
    "test:webview": "npm run compile && node test/render-contributors.js",
```

Create `test/render-contributors.js`:

```js
// Renders the Contributors webview in headless Chrome, both themes, and asserts on the DOM.
// tsc never reads media/, so this is the only check the front end gets. Run: npm run test:webview
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chrome)) {
  console.error(`Google Chrome not found at ${chrome}; set CHROME=/path/to/chrome`);
  process.exit(1);
}

// dist/ imports vscode at load time; stub just what html.ts touches.
const uri = (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath });
const vscodeStub = { Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
};
Math.random = () => 0.5; // stable nonce

const { setExtensionHome } = require('../dist/logView/extensionHome.js');
const { renderContributorsHtml } = require('../dist/contributors/html.js');
setExtensionHome(uri(repoRoot));

const webview = { asWebviewUri: (u) => u.toString(), cspSource: 'vscode-resource:' };

// Fixture: 20 weeks ending this week. Ann totals 192 commits over 13 weeks, Bao 96 over 8,
// claude 1 in the oldest week only - so ranks and the summary are fixed numbers.
const WEEK = 7 * 86400;
const FIRST_MONDAY = 4 * 86400;
const thisMonday = Math.floor((Math.floor(Date.now() / 1000) - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY;
function weeks(count, valueAt) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const value = valueAt(i);
    if (value) {
      rows.push([thisMonday - i * WEEK, value, value * 10, value * 3]);
    }
  }
  return rows;
}
const contributors = [
  { name: 'Ann Nguyen', email: 'ann@example.com', weeks: weeks(20, (i) => (i % 3 === 0 ? 0 : 5 + i)) },
  { name: 'Bao Tran', email: 'bao@example.com', weeks: weeks(20, (i) => (i < 8 ? 12 : 0)) },
  { name: 'claude', email: '', weeks: weeks(20, (i) => (i === 19 ? 1 : 0)) }
].map((c) => ({
  ...c,
  commits: c.weeks.reduce((sum, row) => sum + row[1], 0),
  additions: c.weeks.reduce((sum, row) => sum + row[2], 0),
  deletions: c.weeks.reduce((sum, row) => sum + row[3], 0)
}));
const state = { root: repoRoot, head: 'abc123', generatedAt: Date.now(), firstWeek: thisMonday - 19 * WEEK, contributors };

function renderTheme(theme, pageState) {
  let html = renderContributorsHtml(webview, pageState);
  const nonce = /nonce="([^"]+)"/.exec(html)[1];
  // The shim must carry the page nonce or the CSP drops it, and then contributors.js throws
  // on its first line and the body stays empty - which reads as a blank page, not an error.
  const shim = `<script nonce="${nonce}">
    window.__errors = [];
    window.onerror = (message) => { window.__errors.push(String(message)); };
    window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: () => {} });
    setTimeout(() => {
      const avatar = document.querySelector('.avatar');
      const bar = document.querySelector('rect.bar');
      document.title = JSON.stringify({
        errors: window.__errors,
        cards: document.querySelectorAll('.contributor-card').length,
        bars: document.querySelectorAll('rect.bar').length,
        ranks: Array.from(document.querySelectorAll('.rank'), (n) => n.textContent),
        names: Array.from(document.querySelectorAll('.name'), (n) => n.textContent),
        summary: document.querySelector('.summary') ? document.querySelector('.summary').textContent : null,
        empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : null,
        error: document.querySelector('.banner.error') ? document.querySelector('.banner.error').textContent : null,
        loading: Boolean(document.querySelector('.progress.active')),
        avatarBg: avatar ? getComputedStyle(avatar).backgroundColor : null,
        barFill: bar ? getComputedStyle(bar).fill : null,
        bodyBg: getComputedStyle(document.body).backgroundColor
      });
    }, 300);
  </script>`;
  html = html.replace('<body>', `<body class="${theme}">`).replace('<script nonce', shim + '<script nonce');
  const file = path.join(os.tmpdir(), `gitrail-contributors-${theme}.html`);
  fs.writeFileSync(file, html);
  const dom = execFileSync(chrome, [
    '--headless', '--disable-gpu', '--window-size=1200,900', '--virtual-time-budget=3000', '--dump-dom', 'file://' + file
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const title = /<title>(.*?)<\/title>/s.exec(dom)[1];
  return JSON.parse(title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

for (const theme of ['vscode-dark', 'vscode-light']) {
  const result = renderTheme(theme, state);
  assert.deepEqual(result.errors, [], `${theme}: window.onerror fired`);
  assert.equal(result.cards, 3, `${theme}: one card per contributor at All time`);
  assert.deepEqual(result.ranks, ['#1', '#2', '#3'], `${theme}: ranks follow the sort`);
  assert.deepEqual(result.names, ['Ann Nguyen', 'Bao Tran', 'claude'], `${theme}: sorted by commits`);
  assert.equal(result.summary, '3 contributors · 289 commits', `${theme}: summary`);
  assert.notEqual(result.avatarBg, 'rgba(0, 0, 0, 0)', `${theme}: avatar has a palette colour`);
  assert.equal(result.loading, false);
  assert.equal(result.error, null);

  const loading = renderTheme(theme, { ...state, contributors: [], firstWeek: undefined, loading: true });
  assert.equal(loading.loading, true, `${theme}: progress bar while loading`);
  assert.equal(loading.empty, 'Computing contributors…');

  const failed = renderTheme(theme, { ...state, contributors: [], firstWeek: undefined, error: 'fatal: bad revision' });
  assert.equal(failed.error, 'fatal: bad revision', `${theme}: git error is shown`);
  assert.equal(failed.empty, 'No commits yet.');
  console.log(`${theme}: ok (${result.summary})`);
}
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `npm run test:webview`
Expected: FAIL with `Cannot find module '../dist/contributors/html.js'`.

- [ ] **Step 3: Write `src/contributors/html.ts`**

```ts
import * as vscode from 'vscode';
import { mediaUri } from '../logView/html';
import { getNonce } from '../webviewUtil';
import type { ContributorsState } from './types';

/** The Contributors page. The state rides in an inline script that media/contributors.js reads first. */
export function renderContributorsHtml(webview: vscode.Webview, state: ContributorsState): string {
  const nonce = getNonce();
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  const styleUri = mediaUri(webview, 'contributors.css');
  const scriptUri = mediaUri(webview, 'contributors.js');

  // Same shape as the Log View shell: the nonce carries over to the external stylesheet and
  // script, so the CSP needs no host source. Avatars are initials, so no img-src either.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Contributors</title>
  <link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gitrailContributors = ${json};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Write `media/contributors.css`**

```css
:root {
  --bg: var(--vscode-editor-background, #15161a);
  --panel: var(--vscode-sideBar-background, var(--vscode-editor-background, #1c1e24));
  --panel-2: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #232631));
  --border: var(--vscode-panel-border, var(--vscode-editorGroup-border, #343845));
  --text: var(--vscode-editor-foreground, #d7dce8);
  --muted: var(--vscode-descriptionForeground, #8b92a3);
  --accent: var(--vscode-textLink-foreground, #6ea8fe);
  --toolbar-bg: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background, #181a20));
  --context-bg: var(--vscode-menu-background, var(--vscode-editor-background, #242630));
  --context-border: var(--vscode-menu-border, var(--vscode-panel-border, #4a5060));
  --context-hover: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #3a4771));
  --card-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #191b20));
  --error-fg: var(--vscode-errorForeground, #f48771);
  /* Stated literally per theme, never as var(--something): a custom property that references
     another resolves where it is declared, so an alias here would freeze the dark value. */
  --add-color: #88d38f;
  --del-color: #ff8b91;
  --bar: #4c8dff;
  --bar-hover: #8fb7ff;
  --grid-line: rgba(255, 255, 255, 0.12);
  --axis: rgba(255, 255, 255, 0.28);
  --font-size: 12px;
}
body.vscode-dark { color-scheme: dark; }
body.vscode-light {
  color-scheme: light;
  --add-color: #1e7a1e;
  --del-color: #bc2929;
  --bar: #0969da;
  --bar-hover: #0a4f9e;
  --grid-line: rgba(0, 0, 0, 0.10);
  --axis: rgba(0, 0, 0, 0.30);
}
/* Avatar palette: dark enough for white initials in both themes. Classes, not style="",
   because the CSP blocks inline style attributes. */
.avatar-0 { background: #c0392b; }
.avatar-1 { background: #d35400; }
.avatar-2 { background: #27ae60; }
.avatar-3 { background: #16a085; }
.avatar-4 { background: #2980b9; }
.avatar-5 { background: #8e44ad; }
.avatar-6 { background: #b8860b; }
.avatar-7 { background: #c2185b; }

* { box-sizing: border-box; }
body {
  margin: 0;
  /* VS Code's default webview stylesheet adds "padding: 0 20px". */
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--vscode-font-family);
  font-size: var(--font-size);
  overflow: hidden;
}
button { font: inherit; }
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Toolbar: same 42px band and dropdown shell as the Log View's commit toolbar. */
.toolbar {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 42px;
  height: 42px;
  padding: 6px 8px;
  background: var(--toolbar-bg);
}
.summary {
  margin-left: 4px;
  color: var(--muted);
  white-space: nowrap;
}
.toolbar-spacer { flex: 1 1 auto; }
.icon-button {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.icon-button:hover {
  background: var(--panel-2);
  border-color: var(--border);
}
.icon-button svg { display: block; }
.progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  display: none;
}
.progress.active { display: block; }
.progress::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 30%;
  background: var(--accent);
  animation: progress-slide 1.2s ease-in-out infinite;
}
@keyframes progress-slide {
  from { left: -30%; }
  to { left: 100%; }
}

.filter-dropdown {
  position: relative;
  flex: 0 0 auto;
}
.filter-dropdown-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 6px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 700;
  white-space: nowrap;
  line-height: 1;
}
.filter-label {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
.filter-dropdown-button:hover,
.filter-dropdown.open .filter-dropdown-button {
  color: var(--text);
  background: var(--panel-2);
  border-color: var(--border);
}
.filter-chevron {
  position: relative;
  display: inline-block;
  width: 11px;
  height: 11px;
  color: inherit;
  font-size: 0;
  line-height: 0;
}
.filter-chevron::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translate(-50%, -68%) rotate(45deg);
  transform-origin: center;
}
.filter-menu {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 40;
  width: 170px;
  display: none;
  padding: 6px;
  color: var(--text);
  background: var(--context-bg);
  border: 1px solid var(--context-border);
  border-radius: 6px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
}
.filter-dropdown.open .filter-menu { display: block; }
.filter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 28px;
  padding: 4px 6px 4px 24px;
  position: relative;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.filter-option:hover { background: var(--context-hover); }
.filter-option.selected::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 50%;
  width: 4px;
  height: 8px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-65%) rotate(45deg);
}

/* Content */
.content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.banner.error {
  margin: 12px 12px 0;
  padding: 8px 12px;
  color: var(--error-fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  white-space: pre-wrap;
}
.empty {
  padding: 32px 16px;
  color: var(--muted);
  text-align: center;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  align-content: start;
  padding: 12px;
}
.contributor-card {
  min-width: 0;
  padding: 14px 16px 10px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
  user-select: none;
}
.identity {
  min-width: 0;
  flex: 1 1 auto;
}
.name {
  color: var(--accent);
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.totals {
  margin-top: 2px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.totals .add { color: var(--add-color); }
.totals .del { color: var(--del-color); }
.rank {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 8px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-weight: 700;
}
.chart-host {
  margin-top: 10px;
  min-height: 150px;
}
.chart {
  display: block;
  width: 100%;
  height: 150px;
  overflow: visible;
}
.chart .bar { fill: var(--bar); }
.chart .bar:hover { fill: var(--bar-hover); }
.chart .grid-line {
  stroke: var(--grid-line);
  stroke-dasharray: 3 3;
}
.chart .axis { stroke: var(--axis); }
.chart text {
  fill: var(--muted);
  font-family: var(--vscode-font-family);
  font-size: 11px;
}
.tooltip {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  padding: 5px 8px;
  color: var(--text);
  background: var(--context-bg);
  border: 1px solid var(--context-border);
  border-radius: 4px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
  white-space: nowrap;
}
```

- [ ] **Step 5: Write `media/contributors.js` (toolbar, ranking, cards; charts come in Task 4)**

```js
(function () {
  const vscode = acquireVsCodeApi();
  const state = window.__gitrailContributors || { contributors: [] };
  const persisted = vscode.getState() || {};

  const WEEK = 7 * 24 * 60 * 60;
  // Monday 1970-01-05 00:00 UTC. Must equal FIRST_MONDAY in src/contributors/stats.ts.
  const FIRST_MONDAY = 4 * 24 * 60 * 60;
  const AVATAR_COLOURS = 8;

  const RANGES = [
    { key: '1m', label: '1 month', months: 1 },
    { key: '3m', label: '3 months', months: 3 },
    { key: '6m', label: '6 months', months: 6 },
    { key: '1y', label: '1 year', months: 12 },
    { key: 'all', label: 'All time', months: 0 }
  ];
  // index is the column in a WeekRow: [week, commits, additions, deletions].
  const METRICS = [
    { key: 'commits', label: 'Commits', index: 1, noun: ['commit', 'commits'] },
    { key: 'additions', label: 'Additions', index: 2, noun: ['addition', 'additions'] },
    { key: 'deletions', label: 'Deletions', index: 3, noun: ['deletion', 'deletions'] }
  ];

  // Range and Metric survive a re-render through the webview's own state; the extension
  // never needs to know them.
  const options = {
    range: RANGES.some((range) => range.key === persisted.range) ? persisted.range : 'all',
    metric: METRICS.some((metric) => metric.key === persisted.metric) ? persisted.metric : 'commits'
  };

  // What the current render is showing; drawCharts() (Task 4) reads it after layout.
  let current = { entries: [], weeks: [], max: 0 };

  function html(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }
  function send(message) { vscode.postMessage(message); }
  function persist() { vscode.setState({ range: options.range, metric: options.metric }); }
  function metric() { return METRICS.find((item) => item.key === options.metric); }
  function range() { return RANGES.find((item) => item.key === options.range); }
  function noun(count) { return metric().noun[count === 1 ? 0 : 1]; }

  function weekStart(seconds) {
    return Math.floor((seconds - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY;
  }
  function currentWeek() { return weekStart(Math.floor(Date.now() / 1000)); }

  function rangeStartWeek() {
    const latest = currentWeek();
    const months = range().months;
    if (!months) {
      return state.firstWeek === undefined ? latest : Math.min(state.firstWeek, latest);
    }
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - months);
    return Math.min(weekStart(Math.floor(date.getTime() / 1000)), latest);
  }

  function weeksInRange() {
    const weeks = [];
    for (let week = rangeStartWeek(), last = currentWeek(); week <= last; week += WEEK) {
      weeks.push(week);
    }
    return weeks;
  }

  // Totals per contributor over the selected range. Anyone at zero for the chosen metric is
  // dropped, and the rest are ranked by it - ties fall back to commits, then name.
  function visibleContributors(startWeek) {
    const key = metric().key;
    return state.contributors.map((contributor) => {
      const byWeek = new Map();
      const totals = { commits: 0, additions: 0, deletions: 0 };
      for (const row of contributor.weeks) {
        if (row[0] < startWeek) {
          continue;
        }
        byWeek.set(row[0], row);
        totals.commits += row[1];
        totals.additions += row[2];
        totals.deletions += row[3];
      }
      return { contributor, totals, byWeek, value: totals[key] };
    })
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || b.totals.commits - a.totals.commits || a.contributor.name.localeCompare(b.contributor.name));
  }

  // The tallest week among everyone shown: every chart shares one y-axis so bars compare
  // across cards, as on GitHub.
  function sharedMax(entries, weeks) {
    const index = metric().index;
    let max = 0;
    for (const entry of entries) {
      for (const week of weeks) {
        const row = entry.byWeek.get(week);
        if (row && row[index] > max) {
          max = row[index];
        }
      }
    }
    return max;
  }

  function avatarClass(email, name) {
    let hash = 0;
    for (const char of email || name) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return 'avatar-' + (hash % AVATAR_COLOURS);
  }

  function refreshIcon() {
    return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M13.6 1.8v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // Same shell as the Log View's Branch / User / View dropdowns, holding one chosen value.
  function renderDropdown(kind, label, items, selectedKey) {
    const selected = items.find((item) => item.key === selectedKey);
    return '<div class="filter-dropdown" data-dropdown="' + kind + '">' +
      '<button class="filter-dropdown-button" type="button" data-dropdown-toggle="' + kind + '" title="' + html(label) + '">' +
        '<span class="filter-label">' + html(label) + ': ' + html(selected.label) + '</span>' +
        '<span class="filter-chevron"></span>' +
      '</button>' +
      '<div class="filter-menu">' +
        items.map((item) =>
          '<button class="filter-option' + (item.key === selectedKey ? ' selected' : '') + '" type="button" ' +
            'data-dropdown-option="' + kind + '" data-value="' + html(item.key) + '">' + html(item.label) + '</button>'
        ).join('') +
      '</div>' +
    '</div>';
  }

  function renderToolbar(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const people = entries.length + (entries.length === 1 ? ' contributor' : ' contributors');
    return '<div class="toolbar">' +
      renderDropdown('range', 'Range', RANGES, options.range) +
      renderDropdown('metric', 'Metric', METRICS, options.metric) +
      '<span class="summary">' + people + ' · ' + total.toLocaleString() + ' ' + html(noun(total)) + '</span>' +
      '<span class="toolbar-spacer"></span>' +
      '<button id="refresh" class="icon-button" type="button" title="Recompute from git">' + refreshIcon() + '</button>' +
      '<div class="progress' + (state.loading ? ' active' : '') + '"></div>' +
    '</div>';
  }

  function renderCard(entry, rank, index) {
    const person = entry.contributor;
    const initial = (person.name || '?').trim().charAt(0).toUpperCase() || '?';
    const commits = entry.totals.commits.toLocaleString() + (entry.totals.commits === 1 ? ' commit' : ' commits');
    return '<div class="contributor-card" data-index="' + index + '">' +
      '<div class="card-head">' +
        '<div class="avatar ' + avatarClass(person.email, person.name) + '">' + html(initial) + '</div>' +
        '<div class="identity">' +
          '<div class="name" title="' + html(person.email) + '">' + html(person.name) + '</div>' +
          '<div class="totals">' + commits +
            ' · <span class="add">' + entry.totals.additions.toLocaleString() + ' ++</span>' +
            ' · <span class="del">' + entry.totals.deletions.toLocaleString() + ' --</span>' +
          '</div>' +
        '</div>' +
        '<span class="rank">#' + rank + '</span>' +
      '</div>' +
      '<div class="chart-host"></div>' +
    '</div>';
  }

  function emptyMessage() {
    if (state.contributors.length) {
      return 'No commits in this range.';
    }
    return state.loading ? 'Computing contributors…' : 'No commits yet.';
  }

  function render() {
    const weeks = weeksInRange();
    const entries = visibleContributors(weeks[0]);
    current = { entries, weeks, max: sharedMax(entries, weeks) };

    let body = state.error ? '<div class="banner error">' + html(state.error) + '</div>' : '';
    if (entries.length) {
      body += '<div class="grid">' + entries.map((entry, index) => renderCard(entry, index + 1, index)).join('') + '</div>';
    } else {
      body += '<div class="empty">' + emptyMessage() + '</div>';
    }
    document.getElementById('root').innerHTML =
      '<div class="app">' + renderToolbar(entries) + '<div class="content">' + body + '</div></div>' +
      '<div id="tooltip" class="tooltip" hidden></div>';
    bindToolbar();
    drawCharts();
  }

  // Charts are drawn in Task 4; until then the hosts stay empty.
  function drawCharts() {}

  function bindToolbar() {
    document.querySelectorAll('[data-dropdown-toggle]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const dropdown = button.closest('.filter-dropdown');
        const wasOpen = dropdown.classList.contains('open');
        closeDropdowns();
        if (!wasOpen) {
          dropdown.classList.add('open');
        }
      });
    });
    document.querySelectorAll('[data-dropdown-option]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        options[button.dataset.dropdownOption] = button.dataset.value;
        persist();
        render();
      });
    });
    document.getElementById('refresh').addEventListener('click', () => send({ type: 'refresh' }));
  }

  function closeDropdowns() {
    document.querySelectorAll('.filter-dropdown.open').forEach((node) => node.classList.remove('open'));
  }

  document.addEventListener('click', closeDropdowns);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDropdowns();
    }
  });

  render();
})();
```

- [ ] **Step 6: Compile and run the harness**

Run: `npm run test:webview`
Expected: prints `vscode-dark: ok (3 contributors · 289 commits)` and the same for `vscode-light`, exit code 0. If it fails on `errors`, the array holds the JS error message: fix `media/contributors.js` and rerun.

- [ ] **Step 7: Look at it**

Run (writes a PNG you can open):

```bash
node -e "
const fs=require('fs');const p=require('path');const os=require('os');
const f=p.join(os.tmpdir(),'gitrail-contributors-vscode-dark.html');
require('child_process').execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--window-size=1000,700','--virtual-time-budget=3000','--screenshot='+p.join(os.tmpdir(),'contributors-dark.png'),'file://'+f],{stdio:'ignore'});
console.log(p.join(os.tmpdir(),'contributors-dark.png'));
"
```

Open the PNG (Read tool). Expected: a 42 px toolbar with `Range: All time`, `Metric: Commits`, the summary, a refresh icon; two columns of cards with coloured initials, blue names, green `++` / red `--`, `#1`–`#3` badges, and an empty 150 px band where the chart will go.

- [ ] **Step 8: Commit**

```bash
git add src/contributors/html.ts media/contributors.css media/contributors.js test/render-contributors.js package.json
git commit -m "Render contributor cards from per-author weekly rows"
```

---

### Task 4: Weekly bar charts and tooltip

**Files:**
- Modify: `media/contributors.js` (replace the `drawCharts` stub; add `renderChart`, `niceCeil`, date formatters, tooltip handlers, resize handler)
- Modify: `media/contributors.css` (nothing new required; the `.chart*` and `.tooltip` rules from Task 3 apply)
- Modify: `test/render-contributors.js` (bar assertions)

**Interfaces:**
- Consumes: `current = { entries, weeks, max }` set by `render()` in Task 3; `.chart-host` per card; `#tooltip`.
- Produces: per card an `<svg class="chart">` with `rect.bar[data-week][data-value]`, `line.grid-line`, `line.axis`, `text.tick`, `text.month`.

- [ ] **Step 1: Extend the harness with failing chart assertions**

In `test/render-contributors.js`, inside the theme loop, after `assert.equal(result.error, null);` add:

```js
  // Ann has 13 non-zero weeks, Bao 8, claude 1.
  assert.equal(result.bars, 22, `${theme}: one rect per non-zero week`);
  assert.equal(
    result.barFill,
    theme === 'vscode-dark' ? 'rgb(76, 141, 255)' : 'rgb(9, 105, 218)',
    `${theme}: bar colour follows the theme`
  );
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `npm run test:webview`
Expected: FAIL `vscode-dark: one rect per non-zero week` with `0 !== 22`.

- [ ] **Step 3: Replace the `drawCharts` stub and add the chart code**

In `media/contributors.js`, delete these two lines:

```js
  // Charts are drawn in Task 4; until then the hosts stay empty.
  function drawCharts() {}
```

and put this in their place:

```js
  const CHART_HEIGHT = 150;
  const MARGIN = { top: 8, right: 44, bottom: 22, left: 8 };
  const MIN_MONTH_LABEL_GAP = 48;

  // Round up to 1, 2 or 5 times a power of ten so the axis reads in round numbers.
  function niceCeil(value) {
    if (value <= 0) {
      return 1;
    }
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    for (const step of [1, 2, 5, 10]) {
      if (step * power >= value) {
        return step * power;
      }
    }
    return 10 * power;
  }

  function formatWeek(week) {
    return new Date(week * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function monthLabel(week) {
    const date = new Date(week * 1000);
    return date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) + " '" + String(date.getUTCFullYear()).slice(-2);
  }

  // Charts are sized from their host's width, so they are drawn after the cards are in the
  // DOM and again on resize. The y-axis top is shared by every card.
  function drawCharts() {
    const index = metric().index;
    const top = niceCeil(current.max);
    document.querySelectorAll('.contributor-card').forEach((card) => {
      const entry = current.entries[Number(card.dataset.index)];
      const host = card.querySelector('.chart-host');
      host.innerHTML = renderChart(entry, current.weeks, top, index, host.clientWidth || 320);
    });
  }

  function renderChart(entry, weeks, top, index, width) {
    const height = CHART_HEIGHT;
    const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right);
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    const slot = plotWidth / weeks.length;
    const barWidth = Math.max(1, slot - Math.min(3, slot * 0.2));
    const y = (value) => MARGIN.top + plotHeight - (value / top) * plotHeight;
    const ticks = top % 2 === 0 ? [0, top / 2, top] : [0, top];
    const round = (n) => Math.round(n * 10) / 10;

    let svg = '<svg class="chart" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" ' +
      'role="img" aria-label="Weekly ' + html(metric().label.toLowerCase()) + '">';
    for (const tick of ticks) {
      svg += '<line class="grid-line" x1="' + MARGIN.left + '" x2="' + round(MARGIN.left + plotWidth) + '" y1="' + round(y(tick)) + '" y2="' + round(y(tick)) + '"/>';
      svg += '<text class="tick" x="' + round(MARGIN.left + plotWidth + 6) + '" y="' + round(y(tick) + 4) + '">' + tick.toLocaleString() + '</text>';
    }

    let lastLabelX = -Infinity;
    let lastMonth = -1;
    weeks.forEach((week, i) => {
      const x = MARGIN.left + i * slot;
      const row = entry.byWeek.get(week);
      const value = row ? row[index] : 0;
      if (value > 0) {
        svg += '<rect class="bar" x="' + round(x + (slot - barWidth) / 2) + '" y="' + round(y(value)) + '" ' +
          'width="' + round(barWidth) + '" height="' + round(y(0) - y(value)) + '" data-week="' + week + '" data-value="' + value + '"/>';
      }
      // A label where the month changes, thinned so labels never overlap when weeks are dense.
      const month = new Date(week * 1000).getUTCMonth();
      if (month !== lastMonth) {
        if (i > 0 && x - lastLabelX >= MIN_MONTH_LABEL_GAP) {
          svg += '<text class="month" x="' + round(x) + '" y="' + (height - 6) + '" text-anchor="middle">' + html(monthLabel(week)) + '</text>';
          lastLabelX = x;
        }
        lastMonth = month;
      }
    });
    svg += '<line class="axis" x1="' + MARGIN.left + '" x2="' + round(MARGIN.left + plotWidth) + '" y1="' + round(y(0)) + '" y2="' + round(y(0)) + '"/>';
    return svg + '</svg>';
  }

  // One tooltip element, driven by delegation so re-rendering the cards never loses it.
  function barAt(target) {
    return target instanceof Element ? target.closest('rect.bar') : null;
  }
  function positionTooltip(tooltip, event) {
    const pad = 12;
    const box = tooltip.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + box.width > window.innerWidth - 4) {
      left = event.clientX - box.width - pad;
    }
    if (top + box.height > window.innerHeight - 4) {
      top = event.clientY - box.height - pad;
    }
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  document.addEventListener('mouseover', (event) => {
    const bar = barAt(event.target);
    if (!bar) {
      return;
    }
    const tooltip = document.getElementById('tooltip');
    const value = Number(bar.dataset.value);
    tooltip.textContent = 'Week of ' + formatWeek(Number(bar.dataset.week)) + ' · ' + value.toLocaleString() + ' ' + noun(value);
    tooltip.hidden = false;
    positionTooltip(tooltip, event);
  });
  document.addEventListener('mousemove', (event) => {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip || tooltip.hidden) {
      return;
    }
    if (!barAt(event.target)) {
      tooltip.hidden = true;
      return;
    }
    positionTooltip(tooltip, event);
  });
  document.addEventListener('mouseout', (event) => {
    if (barAt(event.target)) {
      const tooltip = document.getElementById('tooltip');
      if (tooltip) {
        tooltip.hidden = true;
      }
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 100);
  });
```

Note: `drawCharts` is referenced by `render()` before this block in source order. That is fine: function declarations hoist within the IIFE, and `render()` is only *called* at the very end of the file.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `npm run test:webview`
Expected: both themes `ok`, exit code 0.

- [ ] **Step 5: Add a tooltip assertion to the harness**

In the shim inside `test/render-contributors.js`, before `document.title = JSON.stringify({`, add:

```js
      let tooltip = null;
      if (bar) {
        const box = bar.getBoundingClientRect();
        bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: box.left + 1, clientY: box.top + 1 }));
        const node = document.getElementById('tooltip');
        tooltip = node && !node.hidden ? node.textContent : null;
      }
```

and add `tooltip,` to the JSON object. Then, in the loop after the `barFill` assertion:

```js
  assert.match(result.tooltip || '', /^Week of .+ · \d[\d,]* commits?$/, `${theme}: hovering a bar shows the week and value`);
```

Run: `npm run test:webview`
Expected: both themes `ok`.

- [ ] **Step 6: Look at it in both themes**

Take screenshots as in Task 3 Step 7 for `gitrail-contributors-vscode-dark.html` and `gitrail-contributors-vscode-light.html` and open both PNGs. Expected: blue bars on a 0 / 20 / 40 (or similar round) axis shared across cards, dashed grid lines, month labels such as `Jul '26` under the axis, bars darker/lighter than the card background in each theme. Fix any visual defect before committing.

- [ ] **Step 7: Commit**

```bash
git add media/contributors.js test/render-contributors.js
git commit -m "Draw a shared-axis weekly bar chart on each contributor card"
```

---

### Task 5: Provider, view registration, and command

**Files:**
- Create: `src/contributors/provider.ts`
- Modify: `src/extension.ts` (imports; one `register*` call; one entry in `commands`)
- Modify: `package.json` (`activationEvents`, `contributes.commands`, `contributes.viewsContainers.panel`, `contributes.views`)

**Interfaces:**
- Consumes: `GitRunner.exec`, `GitRunner.stream` (Task 1); `contributorLogArgs`, `parseContributorLog` (Task 2); `renderContributorsHtml` (Task 3); `GitTimeoutError` (Task 1); `extensionUri` (`src/logView/extensionHome.ts`, already seeded by `registerGitLogView`); `renderErrorHtml` (`src/logView/html.ts`); `resolveGitDir` (`src/logView/parse.ts`).
- Produces: `registerContributorsView(context: vscode.ExtensionContext, git: GitRunner): void`, `showContributorsView(): Promise<void>`; view id `giPro.contributorsView`; container id `giProContributorsPanel`; command `giPro.openContributorsView`.

- [ ] **Step 1: Write `src/contributors/provider.ts`**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from '../gitRunner';
import { GitTimeoutError } from '../gitSpawn';
import { extensionUri } from '../logView/extensionHome';
import { renderErrorHtml } from '../logView/html';
import { resolveGitDir } from '../logView/parse';
import { renderContributorsHtml } from './html';
import { contributorLogArgs, parseContributorLog } from './stats';
import type { ContributorsMessage, ContributorsState } from './types';

const contributorsViewId = 'giPro.contributorsView';
const contributorsPanelId = 'giProContributorsPanel';
// A whole-history numstat on a very large repository can run for a while; past this it is
// killed and the user is told, rather than left with a progress bar that never ends.
const computeTimeoutMs = 60_000;

let currentProvider: ContributorsViewProvider | undefined;

export function registerContributorsView(context: vscode.ExtensionContext, git: GitRunner): void {
  currentProvider = new ContributorsViewProvider(git);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(contributorsViewId, currentProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  }));
}

export async function showContributorsView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${contributorsPanelId}`);
  } catch {
    // Older cached manifests or VS Code builds may not expose a container focus command.
  }
  await vscode.commands.executeCommand(`${contributorsViewId}.focus`);
  await currentProvider?.refreshIfHeadMoved();
}

export class ContributorsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private root: string | undefined;
  private state: ContributorsState | undefined;
  private computing: Promise<void> | undefined;
  private repoWatchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private needsCheck = false;

  constructor(private readonly git: GitRunner) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri(), 'media')]
    };
    const root = await this.git.getWorkspaceRoot();
    if (!root) {
      webviewView.webview.html = renderErrorHtml('Open a folder before opening Contributors.');
      return;
    }
    this.root = root.fsPath;

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as ContributorsMessage;
      if (message?.type === 'refresh') {
        void this.compute();
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.needsCheck) {
        this.needsCheck = false;
        void this.refreshIfHeadMoved();
      }
    });
    webviewView.onDidDispose(() => this.stopWatching());
    this.watchRepository(this.root);
    await this.compute();
  }

  // Recompute only when HEAD points somewhere new. Ref churn from fetches and branch work
  // that leaves HEAD alone costs one rev-parse and nothing more.
  async refreshIfHeadMoved(): Promise<void> {
    if (!this.root || this.computing) {
      return;
    }
    const head = await this.currentHead();
    if (head && head === this.state?.head) {
      return;
    }
    await this.compute();
  }

  private async currentHead(): Promise<string | undefined> {
    try {
      return (await this.git.exec('git rev-parse HEAD')).trim();
    } catch {
      // Unborn branch or not a repository: git log below reports it.
      return undefined;
    }
  }

  private compute(): Promise<void> {
    if (!this.root) {
      return Promise.resolve();
    }
    if (!this.computing) {
      this.computing = this.doCompute(this.root).finally(() => {
        this.computing = undefined;
      });
    }
    return this.computing;
  }

  private async doCompute(root: string): Promise<void> {
    // Keep the previous cards on screen under a progress bar rather than blanking the view.
    this.render({ root, generatedAt: Date.now(), contributors: [], ...this.state, loading: true, error: undefined });
    const head = await this.currentHead();
    try {
      const stdout = await this.git.stream(contributorLogArgs(), computeTimeoutMs);
      const parsed = parseContributorLog(stdout);
      this.state = { root, head, generatedAt: Date.now(), firstWeek: parsed.firstWeek, contributors: parsed.contributors };
    } catch (error) {
      const message = error instanceof GitTimeoutError
        ? 'Computing contributors took too long. Try again with Refresh.'
        : error instanceof Error ? error.message : String(error);
      this.state = {
        root,
        head,
        generatedAt: Date.now(),
        firstWeek: this.state?.firstWeek,
        contributors: this.state?.contributors ?? [],
        error: message
      };
    }
    this.render(this.state);
  }

  private render(state: ContributorsState): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = renderContributorsHtml(this.view.webview, state);
  }

  private watchRepository(rootPath: string): void {
    this.stopWatching();
    const gitDir = resolveGitDir(rootPath);
    const watchDirs = new Set([gitDir]);
    try {
      // Linked worktrees keep shared refs in the common git dir.
      const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      watchDirs.add(path.resolve(gitDir, commonDir));
    } catch {
      // No commondir file: regular repository layout.
    }

    for (const dir of watchDirs) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,packed-refs,refs/**}')
      );
      const schedule = () => this.scheduleCheck();
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.repoWatchers.push(watcher);
    }
  }

  private scheduleCheck(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.view?.visible) {
        void this.refreshIfHeadMoved();
      } else {
        this.needsCheck = true;
      }
    }, 400);
  }

  private stopWatching(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const watcher of this.repoWatchers) {
      watcher.dispose();
    }
    this.repoWatchers = [];
  }
}
```

- [ ] **Step 2: Register it in `src/extension.ts`**

Add the import next to the other feature imports:

```ts
import { registerContributorsView, showContributorsView } from './contributors/provider';
```

In `activate()`, directly after `registerGitLogView(context, git);` (it must come after, because `registerGitLogView` seeds `setExtensionHome`, which the provider's `extensionUri()` needs):

```ts
  registerContributorsView(context, git);
```

In the `commands` array, after the `giPro.openGitLogView` entry:

```ts
    { id: 'giPro.openContributorsView', handler: () => showContributorsView() },
```

- [ ] **Step 3: Declare the view and command in `package.json`**

In `activationEvents`, after `"onCommand:giPro.openGitLogView",` add:

```json
    "onCommand:giPro.openContributorsView",
```

and after `"onView:giPro.historyView",` add:

```json
    "onView:giPro.contributorsView",
```

In `contributes.commands`, after the `giPro.openGitLogView` object add:

```json
      {
        "command": "giPro.openContributorsView",
        "title": "Open Contributors",
        "category": "Gitrail"
      },
```

In `contributes.viewsContainers.panel`, after the `giProHistoryPanel` object add:

```json
        {
          "id": "giProContributorsPanel",
          "title": "Contributors",
          "icon": "media/git-log.svg"
        }
```

In `contributes.views`, after the `giProHistoryPanel` array add:

```json
      "giProContributorsPanel": [
        {
          "id": "giPro.contributorsView",
          "name": "Contributors",
          "type": "webview"
        }
      ],
```

- [ ] **Step 4: Compile and lint**

Run: `npm run compile && npm test`
Expected: `tsc` exits 0, all unit tests pass.

Run: `npm run lint`
Expected: if ESLint reports "ESLint couldn't find an eslint.config.(js|mjs|cjs) file", that is a pre-existing repository condition (there is no config checked in) and not caused by this task; note it in the task report and move on. Otherwise, zero errors.

- [ ] **Step 5: Manual check in the Extension Development Host**

Press `F5` in VS Code (the `preLaunchTask` compiles). In the host window open this repository, then:

1. Run `Gitrail: Open Contributors` from the Command Palette. Expected: a **Contributors** tab appears in the bottom panel beside **Gitrail** and **History**, shows a progress bar briefly, then cards ranked by commits.
2. Switch **Range** to `1 month` and **Metric** to `Additions`. Expected: instant re-rank with no progress bar. Hide and re-show the panel: the choices are kept.
3. Hover a bar. Expected: `Week of <date> · <n> additions`.
4. Make a commit in the host's terminal (`git commit --allow-empty -m tmp`). Expected: within about a second the progress bar shows and the top card's count rises by one. Then `git reset --hard HEAD~1` to undo; the count drops back.
5. Run `git fetch` (or wait for autofetch). Expected: no progress bar, since HEAD did not move.
6. Click **Refresh**. Expected: progress bar, then the same data.
7. Toggle the colour theme (`Preferences: Toggle between Light/Dark Themes`). Expected: bars, `++`/`--` and text remain legible in both.
8. Open a folder that is not a git repository. Expected: the view shows git's own error in the banner and a Refresh button, nothing else broken.

Record the outcome of each numbered item in the task report.

- [ ] **Step 6: Commit**

```bash
git add src/contributors/provider.ts src/extension.ts package.json
git commit -m "Add the Contributors panel"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` (Features list; a new Common Workflow after "Open the Git Log")
- Modify: `CHANGELOG.md` (new `## Unreleased` section at the top, above `## 0.1.3`)
- Modify: `CLAUDE.md` (architecture tables; Commands; Verifying webview changes)

- [ ] **Step 1: README**

In `## Features`, after the "Visual Git Log view…" bullet add:

```markdown
- Contributors panel: one card per author with commit, added-line and deleted-line totals and a weekly bar chart, filtered by range and ranked by commits, additions or deletions.
```

In `## Common Workflows`, after the "### Open the Git Log" section and before "### View File History", add:

```markdown
### See Who Contributes

Run `Gitrail: Open Contributors` from the Command Palette.

The panel counts every non-merge commit reachable from `HEAD`, grouped by author email (honouring `.mailmap`).

- Use **Range** to narrow to the last 1, 3, 6 or 12 months; **All time** is the default.
- Use **Metric** to rank and chart by commits, added lines or deleted lines.
- Every chart shares one y-axis, so bars compare across people.
- Hover a bar for the week and its value.

The numbers are computed once per `HEAD` and refresh when `HEAD` moves; **Refresh** recomputes on demand.
```

- [ ] **Step 2: CHANGELOG**

Insert at the top of `CHANGELOG.md`, directly under `# Changelog`:

```markdown
## Unreleased

- Add a **Contributors** panel, `Gitrail: Open Contributors`, in the style of GitHub's Insights → Contributors page: one card per author with a rank badge, commit / `++` / `--` totals, and a bar per week. A **Range** menu narrows to the last 1, 3, 6 or 12 months and a **Metric** menu ranks and charts by commits, additions or deletions; both are answered in the browser from data computed once, so switching them never waits on git. Every chart shares one y-axis so bars compare across people. Authors are grouped by email, case-insensitively and through `.mailmap`; merge commits are left out as GitHub does; binary files count toward commits but not lines. Avatars are initials on a colour chosen from the email — nothing is fetched, nothing leaves the machine.
- The panel recomputes only when `HEAD` moves to a new commit, so `git fetch` and autofetch cost one `rev-parse` and nothing more, and the previous cards stay on screen under a progress bar while it works. Computation over a very large history is cut off after 60 seconds with a message rather than a progress bar that never ends.
- Internal: git output that grows with the repository is now read through `GitRunner.stream()`, a shell-less `spawn` with no stdout cap — `exec()`'s 10 MB `maxBuffer` was too small for a whole-history `--numstat`. Added `npm test` (`node --test` over the pure parsing code) and `npm run test:webview` (renders the Contributors page in headless Chrome for both themes and asserts on the DOM).
```

- [ ] **Step 3: CLAUDE.md**

In `## Commands`, after `npm run lint` add:

```bash
npm test             # compile, then node --test over test/*.test.js (pure parsing + spawn helper)
npm run test:webview # compile, then render the Contributors page in headless Chrome and assert
```

Change the sentence "There are no automated tests." to:

```markdown
`npm test` covers the pure code (`src/gitSpawn.ts`, `src/contributors/stats.ts`); everything that touches the VS Code API is tested manually by pressing `F5`, which launches an Extension Development Host (configured in `.vscode/launch.json` with a `preLaunchTask: npm: compile`).
```

In the top-level `src/` table, add a row after `gitRunner.ts`:

```markdown
| `gitSpawn.ts` | `spawnGit()` — git via `child_process.spawn`, no shell, no stdout cap, optional timeout (`GitTimeoutError`). Backs `GitRunner.stream()`. No `vscode` import, so `npm test` can load it. |
```

After the Git Log panel table, add:

```markdown
The Contributors panel lives in `src/contributors/`:

| File | Role |
|------|------|
| `provider.ts` | `ContributorsViewProvider` — resolves the webview, watches `HEAD`/`refs/**`, recomputes only when `git rev-parse HEAD` changes, keeps the last state in memory. Exports `registerContributorsView` and `showContributorsView`. |
| `stats.ts` | Pure: `contributorLogArgs()`, `weekStart()` (Monday 00:00 UTC), `parseContributorLog()` — folds `git log --numstat` into per-author `WeekRow`s. |
| `html.ts` | The HTML shell; state handed off as `window.__gitrailContributors`. |
| `types.ts` | `WeekRow`, `Contributor`, `ContributorsState`. |

Its front end is `media/contributors.js` and `media/contributors.css`. All filtering (Range), ranking (Metric) and SVG drawing happen there from the one state object; the only message it posts is `refresh`. `FIRST_MONDAY` is declared in both `stats.ts` and `contributors.js` and must stay equal.
```

In the bullets under "The panel's front end is **not** in `src/`", extend the list:

```markdown
- `media/contributors.css`
- `media/contributors.js`
```

In "### Verifying webview changes", add a final paragraph:

```markdown
For the Contributors page this harness exists as `test/render-contributors.js` (`npm run test:webview`): it stubs `vscode`, renders `renderContributorsHtml` with a fixed 20-week fixture, loads it in headless Chrome for both themes and asserts card, rank, bar and computed-colour values. Extend its assertions when changing `media/contributors.*`.
```

- [ ] **Step 4: Check the rendered markdown and commit**

Run: `git diff --stat` and skim `README.md` / `CLAUDE.md` for broken tables (each row needs the same number of `|`).

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "Document the Contributors panel"
```

---

## Self-review

**Spec coverage**
- Separate view + provider, same mechanics as Log View → Task 5 (container decision recorded in Global Constraints).
- `stream()` via `spawn`, 60 s timeout, `GitTimeoutError` → Task 1, Task 5.
- git command, `--no-merges`, `.mailmap`, binary skip, case-insensitive email, empty-email fallback, latest-name, UTC Monday weeks, `firstWeek` → Task 2 with tests for each.
- State shape → Task 2 `types.ts`, matches the spec's field list.
- Refresh policy (watch, 400 ms debounce, rev-parse gate, keep old cards + `loading`, Refresh button, hidden view defers) → Task 5.
- Toolbar (Range defaults All time, Metric defaults Commits, Refresh, summary with metric noun, 2 px progress), persistence via `setState` → Task 3.
- Grid `minmax(340px, 1fr)`, sort by metric, hide zero, ranks → Task 3.
- Card (32 px initials avatar, 8-colour palette by email hash, name, totals with `++`/`--` colours, `#n`) → Task 3.
- Chart (one bar per week from range start / `firstWeek`, shared y max, grid lines with right labels, month labels thinned, hover darken + tooltip text) → Task 4.
- Theming rules → Task 3 CSS, checked in both themes by the harness.
- Error table: no workspace, git failure banner + Refresh, timeout text, "No commits in this range.", empty email → Tasks 3 and 5.
- Testing: `node --test` fixtures listed in the spec → Task 2; headless Chrome both themes, `.contributor-card` / `rect` counts / `onerror` → Tasks 3–4; compile/lint/F5 → Task 5.
- Docs → Task 6.

**Placeholders:** none; every code step carries the full code.

**Type consistency:** `WeekRow` column order `[week, commits, additions, deletions]` is used identically in `stats.ts`, `METRICS[].index` in `contributors.js`, and the harness fixture. `spawnGit(args, { cwd, timeoutMs, command })` matches its test and `GitRunner.stream`. `renderContributorsHtml(webview, state)` is called with the same signature in the harness and the provider. `current = { entries, weeks, max }` is written in Task 3's `render()` and read in Task 4's `drawCharts()`.
