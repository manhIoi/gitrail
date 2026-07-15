# Server-Side Commit Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make commit search/filter in the GI Pro Git Log webview search the entire repository history via `git log`, instead of only the currently lazy-loaded page of commits.

**Architecture:** All changes live in `src/gitLogView.ts`. The webview sends the active filter state (`query`, `matchCase`, `regex`, `users`, `branches`) to `GitLogController` via a new `updateCommitFilters` message. The controller stores it, resets pagination to page 1, and `loadCommits()` folds the filters directly into the `git log` invocation (`--grep`, `--author`, ref scoping) instead of the webview filtering an already-loaded array. When no filters are active, the constructed command is byte-for-byte equivalent to today's unfiltered command, so the default (no-search) path is provably unchanged.

**Tech Stack:** TypeScript (extension host), vanilla JS embedded as a template string (webview), `child_process.exec` via `GitRunner.exec()`, native `git log`/`git rev-list`.

## Global Constraints

- No automated test suite exists in this repo (confirmed in `CLAUDE.md`) — verification is `npm run compile` / `npm run lint` plus manual exercise via the `F5` Extension Development Host.
- Follow existing patterns: full `webview.html` replace on every state-changing message (no incremental DOM patching protocol), `shellQuote()` from `gitRunner.ts` for all interpolated shell values, try/catch-and-ignore for best-effort git calls (matches `assignCommitBranches`'s handling of stale refs).
- Do not touch unrelated parts of the file. The working tree currently has an uncommitted lazy-load/pagination change already applied (`commitPageSize`, `commitLimit`, `loadMoreCommits`) — build on top of it, don't revert or restage it.

## Deviations from the design spec (found while planning, fixed here)

The spec (`docs/superpowers/specs/2026-07-15-server-side-commit-search-design.md`) sketches `--fixed-strings`/`--extended-regexp` toggling by the query's regex flag, and a hash lookup via `git log <target> -1 <query>`. Two corrections, made because git's pattern-type flags (`--fixed-strings`/`--extended-regexp`/`-i`) apply uniformly to **both** `--grep` and `--author` in a single invocation:

1. **Regex flavor is always `--extended-regexp`.** If the query toggle were OFF and we passed `--fixed-strings`, the `^name$` anchors built for `--author` would also become literal text (searching for the literal characters `^name$`), breaking author filtering. Instead, "non-regex" mode is implemented by escaping the query's ERE metacharacters before it reaches `--grep`, so the shell-level flag stays constant (`--extended-regexp`) and author anchors remain valid in both modes.
2. **Hash lookup ignores `target`.** `git log <target> -1 <query>` (e.g. with `--all`) doesn't mean "find commit `<query>`" — it means "traverse all these starting points and give me the most recent one," which can silently return the wrong commit. The hash lookup instead runs `git log -1 <query> --pretty=format:...` with no target, since a hash/prefix already uniquely identifies a revision.

One accepted, documented limitation: `-i` (case-insensitivity) is a single global flag, so when the query's "match case" toggle is off, the `--author` matching also becomes case-insensitive (previously it was an exact, case-sensitive `Set.has()` match). This only matters for repos with two authors whose names differ solely by case, which is rare enough in practice not to warrant per-field regex flavors.

---

### Task 1: Message protocol and controller filter state

**Files:**
- Modify: `src/gitLogView.ts:69-77` (`WebviewMessage` type)
- Modify: `src/gitLogView.ts:507-521` (`GitLogController` field declarations)
- Modify: `src/gitLogView.ts:534-569` (`handleMessage`, add new branch)

**Interfaces:**
- Produces: `WebviewMessage.query?: string`, `.matchCase?: boolean`, `.regex?: boolean`, `.users?: string[]`, `.branches?: string[]`
- Produces: `GitLogController` fields `commitFilterQuery: string`, `commitFilterMatchCase: boolean`, `commitFilterRegex: boolean`, `commitFilterUsers: Set<string>`, `commitFilterBranches: Set<string>`
- Produces: handling of `message.type === 'updateCommitFilters'`
- Consumed by: Task 2 (`loadCommits` and helpers read these fields), Task 3 (webview sends this message shape)

- [ ] **Step 1: Add filter fields to `WebviewMessage`**

In `src/gitLogView.ts`, change:

```ts
type WebviewMessage = {
  type?: string;
  branch?: string;
  branchType?: Branch['type'];
  hash?: string;
  hashes?: string[];
  file?: string;
  action?: string;
};
```

to:

```ts
type WebviewMessage = {
  type?: string;
  branch?: string;
  branchType?: Branch['type'];
  hash?: string;
  hashes?: string[];
  file?: string;
  action?: string;
  query?: string;
  matchCase?: boolean;
  regex?: boolean;
  users?: string[];
  branches?: string[];
};
```

- [ ] **Step 2: Add filter state fields to `GitLogController`**

Change:

```ts
class GitLogController {
  private static readonly commitPageSize = 300;
  private selectedBranch: string | undefined;
  private selectedCommit: string | undefined;
  private diffBranch: string | undefined;
  private selectedDiffFile: string | undefined;
  private commitLimit = GitLogController.commitPageSize;
  private loadingMoreCommits = false;
  private readonly outputChannel = vscode.window.createOutputChannel('GI Pro Git');
```

to:

```ts
class GitLogController {
  private static readonly commitPageSize = 300;
  private selectedBranch: string | undefined;
  private selectedCommit: string | undefined;
  private diffBranch: string | undefined;
  private selectedDiffFile: string | undefined;
  private commitLimit = GitLogController.commitPageSize;
  private loadingMoreCommits = false;
  private commitFilterQuery = '';
  private commitFilterMatchCase = false;
  private commitFilterRegex = false;
  private commitFilterUsers = new Set<string>();
  private commitFilterBranches = new Set<string>();
  private readonly outputChannel = vscode.window.createOutputChannel('GI Pro Git');
```

- [ ] **Step 3: Handle the `updateCommitFilters` message**

In `handleMessage`, directly after the existing `loadMoreCommits` block (ends at line 554 with its closing `return;` / `}`), insert:

```ts
      if (message.type === 'updateCommitFilters') {
        this.commitFilterQuery = message.query || '';
        this.commitFilterMatchCase = Boolean(message.matchCase);
        this.commitFilterRegex = Boolean(message.regex);
        this.commitFilterUsers = new Set(message.users || []);
        this.commitFilterBranches = new Set(message.branches || []);
        this.commitLimit = GitLogController.commitPageSize;
        await this.render();
        return;
      }
```

This mirrors the existing `loadMoreCommits` handler's shape (mutate state, `render()`, `return`) — no new dispatch mechanism.

- [ ] **Step 4: Compile**

Run: `npm run compile`
Expected: succeeds with no TypeScript errors. (`loadCommits` doesn't read the new fields yet, so behavior is unchanged — this step only proves the type/field/message-handler plumbing is well-formed.)

- [ ] **Step 5: Commit**

```bash
git add src/gitLogView.ts
git commit -m "$(cat <<'EOF'
Add updateCommitFilters message and controller filter state

Extension-side plumbing only: stores the webview's active search/filter
values and resets pagination on change. loadCommits() doesn't consume
these fields yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Fold filters into the `git log` invocation

**Files:**
- Modify: `src/gitLogView.ts:1100-1137` (`loadCommits`, add helper methods)
- Modify: `src/gitLogView.ts:3374` area (add `escapeRegExpLiteral` module-level helper near `isCommitHash`)

**Interfaces:**
- Consumes: `commitFilterQuery/MatchCase/Regex/Users/Branches` fields from Task 1
- Produces: `GitLogController.buildCommitLogTarget(): string`, `GitLogController.buildCommitFilterArgs(): string`, `GitLogController.prependHashMatch(commits: Commit[]): Promise<void>` (all `private`)
- Produces: module-level `function escapeRegExpLiteral(value: string): string`
- `loadCommits(branches: Branch[]): Promise<{ commits: Commit[]; hasMoreCommits: boolean }>` keeps its existing signature — no callers need to change.

- [ ] **Step 1: Add `escapeRegExpLiteral` helper**

In `src/gitLogView.ts`, directly above `function isCommitHash` (currently at line 3374), add:

```ts
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 2: Replace `loadCommits` and add the three new helper methods**

Change:

```ts
  private async loadCommits(branches: Branch[]): Promise<{ commits: Commit[]; hasMoreCommits: boolean }> {
    // --exclude only affects ref options that FOLLOW it, so it must precede --all.
    const target = '--exclude=refs/stash --all';
    const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
    const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -n ${this.commitLimit + 1} ${target}`);

    const commits: Commit[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const commit = parseCommitLine(line);
      if (commit) commits.push(commit);
    }
    const hasMoreCommits = commits.length > this.commitLimit;
    commits.splice(this.commitLimit);
    await this.assignCommitBranches(commits, branches);
    return { commits, hasMoreCommits };
  }
```

to:

```ts
  private buildCommitLogTarget(): string {
    if (this.commitFilterBranches.size > 0) {
      // Scope traversal directly to the selected refs (git ORs multiple positional
      // revs together), instead of --all + post-filtering a capped page — post-filtering
      // can drop real matches once commits from other branches fill the page first.
      return Array.from(this.commitFilterBranches).map(shellQuote).join(' ');
    }
    // --exclude only affects ref options that FOLLOW it, so it must precede --all.
    return '--exclude=refs/stash --all';
  }

  private buildCommitFilterArgs(): string {
    const needsRegexFlags = Boolean(this.commitFilterQuery) || this.commitFilterUsers.size > 0;
    const args: string[] = [];
    if (needsRegexFlags) {
      // A single regex flavor (ERE) is used for both --grep and --author, since git
      // applies --fixed-strings/--extended-regexp/-i uniformly to both. "Non-regex"
      // query mode is implemented by escaping metacharacters before building the
      // pattern, not by switching flags.
      args.push('--extended-regexp');
      if (!this.commitFilterMatchCase) {
        args.push('-i');
      }
    }
    if (this.commitFilterQuery) {
      const pattern = this.commitFilterRegex ? this.commitFilterQuery : escapeRegExpLiteral(this.commitFilterQuery);
      args.push(`--grep=${shellQuote(pattern)}`);
    }
    for (const user of this.commitFilterUsers) {
      args.push(`--author=${shellQuote('^' + escapeRegExpLiteral(user) + '$')}`);
    }
    return args.join(' ');
  }

  private async prependHashMatch(commits: Commit[]): Promise<void> {
    const query = this.commitFilterQuery.trim();
    if (!isCommitHash(query) || commits.some((commit) => commit.hash === query || commit.hash.startsWith(query))) {
      return;
    }
    try {
      const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
      const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -1 ${shellQuote(query)}`);
      const commit = parseCommitLine(raw.split(/\r?\n/)[0] || '');
      if (commit && !commits.some((existing) => existing.hash === commit.hash)) {
        commits.unshift(commit);
      }
    } catch {
      // query isn't a resolvable revision (invalid or ambiguous prefix) — ignore.
    }
  }

  private async loadCommits(branches: Branch[]): Promise<{ commits: Commit[]; hasMoreCommits: boolean }> {
    const target = this.buildCommitLogTarget();
    const filterArgs = this.buildCommitFilterArgs();
    const format = '%x1f%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s';
    const raw = await this.git.exec(`git log --date-order --date=iso-strict --pretty=format:${shellQuote(format)} -n ${this.commitLimit + 1} ${filterArgs} ${target}`);

    const commits: Commit[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const commit = parseCommitLine(line);
      if (commit) commits.push(commit);
    }
    const hasMoreCommits = commits.length > this.commitLimit;
    commits.splice(this.commitLimit);
    await this.prependHashMatch(commits);
    await this.assignCommitBranches(commits, branches);
    return { commits, hasMoreCommits };
  }
```

Note: when no filters are active, `buildCommitLogTarget()` returns the original `'--exclude=refs/stash --all'` and `buildCommitFilterArgs()` returns `''`, so the constructed command is identical to today's (just with one harmless extra space) — this is what makes "clear all filters restores original behavior" true without a separate code path.

- [ ] **Step 3: Compile**

Run: `npm run compile`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Sanity-check the constructed `git log` commands directly against this repo**

This repo only has 15 commits (`git rev-list --all --count`), so this step substitutes for a unit test by running the actual command shapes `buildCommitLogTarget`/`buildCommitFilterArgs` produce, directly against real history, and checking the output is what's expected:

```bash
cd /Users/manhloi/Documents/personal_source/git-pro

# Non-regex query, case-insensitive (default): should match "Fix" and "fix"
git log --date-order --pretty=format:'%H %s' -n 20 --extended-regexp -i --grep='fix' --exclude=refs/stash --all

# Regex mode: anchors and alternation should work
git log --date-order --pretty=format:'%H %s' -n 20 --extended-regexp --grep='^(Fix|Add)' --exclude=refs/stash --all

# Author filter: exact author name, anchored
git log --date-order --pretty=format:'%H %an' -n 20 --extended-regexp -i --author='^iammanhIoi$' --exclude=refs/stash --all

# Branch-scoped target (replace 'main' with a real local branch name if needed)
git log --date-order --pretty=format:'%H %s' -n 20 main

# Hash lookup path: resolve a short prefix of a real commit directly (no target)
git log --date-order --pretty=format:'%H %s' -1 $(git rev-parse HEAD | cut -c1-8)
```

Expected: each command returns plausible, correctly-filtered output (e.g., the `--grep='fix'` command only lists commits whose subject contains "fix"/"Fix"; the author command lists only commits by that exact author; the hash command resolves to exactly one commit matching `git log -1 HEAD`). If any command errors or returns unexpected results, fix `buildCommitLogTarget`/`buildCommitFilterArgs`/`prependHashMatch` before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/gitLogView.ts
git commit -m "$(cat <<'EOF'
Fold commit search/filter into the git log invocation

loadCommits() now builds --grep/--author/ref-scoping directly from the
active filters instead of the webview filtering an already-loaded page,
so search covers full history. Includes a best-effort hash lookup for
queries that look like a commit hash/prefix.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Webview wiring — send filters instead of filtering locally

**Files:**
- Modify: `src/gitLogView.ts:2671-2672` (`render()`)
- Modify: `src/gitLogView.ts:2707-2719` (branch double-click handler)
- Modify: `src/gitLogView.ts:2932-3033` (`wireCommitFilters()`)
- Modify: `src/gitLogView.ts:3054-3063` (`clearCommitFilter()`)
- Modify: `src/gitLogView.ts:3077-3124` (delete `applyCommitFilters()`, `filteredCommits()`, `createCommitQueryMatcher()`)
- Modify: `src/gitLogView.ts` near line 2086 (add debounce timer variable, add `sendCommitFilters`/`sendCommitFiltersDebounced`/`showCommitsSearching` helpers)

**Interfaces:**
- Consumes: `updateCommitFilters` message shape from Task 1 (`{ type: 'updateCommitFilters', query, matchCase, regex, users, branches }`)
- Produces: webview JS functions `sendCommitFilters()`, `sendCommitFiltersDebounced()`, `showCommitsSearching()` (all local to the `renderHtml` template's `<script>`, not exported — nothing outside this task depends on them)
- Removes: `filteredCommits()`, `createCommitQueryMatcher()`, `applyCommitFilters()` — confirm nothing else in the file calls them before deleting (checked: only `render()` and `applyCommitFilters` itself called `filteredCommits()`; only the filter-wiring call sites listed above called `applyCommitFilters()`)

- [ ] **Step 1: Add debounce timer and helper functions**

Directly after the existing `let loadingMoreCommits = false;` (line 2086), add:

```js
	    let commitFilterDebounce;

	    function sendCommitFilters() {
	      showCommitsSearching();
	      send({
	        type: 'updateCommitFilters',
	        query: commitFilters.query,
	        matchCase: commitFilters.matchCase,
	        regex: commitFilters.regex,
	        users: Array.from(commitFilters.users),
	        branches: Array.from(commitFilters.branches)
	      });
	    }

	    function sendCommitFiltersDebounced() {
	      clearTimeout(commitFilterDebounce);
	      commitFilterDebounce = setTimeout(sendCommitFilters, 280);
	    }

	    function showCommitsSearching() {
	      const list = document.getElementById('commits');
	      if (list) list.innerHTML = '<div class="empty">Searching…</div>';
	    }
```

(`.empty` is the existing CSS class already used for "No commits found" / "Select a commit" — no new CSS needed.)

- [ ] **Step 2: Fix `render()` to stop calling the soon-to-be-deleted `filteredCommits()`**

Change:

```js
	  function render() {
	    const commitsView = renderCommits(filteredCommits());
```

to:

```js
	  function render() {
	    const commitsView = renderCommits(state.commits);
```

- [ ] **Step 3: Rewire the branch double-click "filter to this branch" handler**

Change:

```js
	        node.addEventListener('dblclick', () => {
	          const branch = node.dataset.branch;
	          if (!branch) return;
	          // Double-click filters the log to this branch; again on the same branch clears it.
	          const alreadyOnly = commitFilters.branches.size === 1 && commitFilters.branches.has(branch);
	          commitFilters.branches = alreadyOnly ? new Set() : new Set([branch]);
	          persistViewState();
	          document.querySelectorAll('[data-filter-option="branches"]').forEach((input) => {
	            input.checked = commitFilters.branches.has(input.value);
	          });
	          updateCommitFilterIndicators();
	          applyCommitFilters();
	        });
```

to:

```js
	        node.addEventListener('dblclick', () => {
	          const branch = node.dataset.branch;
	          if (!branch) return;
	          // Double-click filters the log to this branch; again on the same branch clears it.
	          const alreadyOnly = commitFilters.branches.size === 1 && commitFilters.branches.has(branch);
	          commitFilters.branches = alreadyOnly ? new Set() : new Set([branch]);
	          persistViewState();
	          document.querySelectorAll('[data-filter-option="branches"]').forEach((input) => {
	            input.checked = commitFilters.branches.has(input.value);
	          });
	          updateCommitFilterIndicators();
	          sendCommitFilters();
	        });
```

- [ ] **Step 4: Rewire `wireCommitFilters()`**

Change the search input listener from:

```js
	        search.addEventListener('input', (event) => {
	          commitFilters.query = event.target.value;
	          persistViewState();
	          updateCommitSearchClear();
	          applyCommitFilters();
	        });
```

to:

```js
	        search.addEventListener('input', (event) => {
	          commitFilters.query = event.target.value;
	          persistViewState();
	          updateCommitSearchClear();
	          sendCommitFiltersDebounced();
	        });
```

Change the search-clear button listener from:

```js
	        searchClear.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters.query = '';
	          if (search) search.value = '';
	          persistViewState();
	          updateCommitSearchClear();
	          applyCommitFilters();
	        });
```

to:

```js
	        searchClear.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters.query = '';
	          if (search) search.value = '';
	          persistViewState();
	          updateCommitSearchClear();
	          sendCommitFilters();
	        });
```

Change the `[data-filter-flag]` (matchCase/regex toggle) listener from:

```js
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters[key] = !commitFilters[key];
	          persistViewState();
	          node.classList.toggle('active', Boolean(commitFilters[key]));
	          applyCommitFilters();
	        });
```

to:

```js
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters[key] = !commitFilters[key];
	          persistViewState();
	          node.classList.toggle('active', Boolean(commitFilters[key]));
	          sendCommitFilters();
	        });
```

Change the `[data-filter-option]` (branch/user checkbox) listener from:

```js
	        node.addEventListener('change', () => {
	          const key = node.dataset.filterOption;
	          const selected = commitFilters[key];
	          if (node.checked) {
	            selected.add(node.value);
	          } else {
	            selected.delete(node.value);
	          }
	          document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((el) => {
	            el.checked = selected.has(el.value);
	          });
	          persistViewState();
	          updateCommitFilterIndicators();
	          applyCommitFilters();
	        });
```

to:

```js
	        node.addEventListener('change', () => {
	          const key = node.dataset.filterOption;
	          const selected = commitFilters[key];
	          if (node.checked) {
	            selected.add(node.value);
	          } else {
	            selected.delete(node.value);
	          }
	          document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((el) => {
	            el.checked = selected.has(el.value);
	          });
	          persistViewState();
	          updateCommitFilterIndicators();
	          sendCommitFilters();
	        });
```

- [ ] **Step 5: Rewire `clearCommitFilter()`**

Change:

```js
	    function clearCommitFilter(kind) {
	      const key = kind === 'branch' ? 'branches' : 'users';
	      commitFilters[key].clear();
	      document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((input) => {
	        input.checked = false;
	      });
	      persistViewState();
	      updateCommitFilterIndicators();
	      applyCommitFilters();
	    }
```

to:

```js
	    function clearCommitFilter(kind) {
	      const key = kind === 'branch' ? 'branches' : 'users';
	      commitFilters[key].clear();
	      document.querySelectorAll('[data-filter-option="' + key + '"]').forEach((input) => {
	        input.checked = false;
	      });
	      persistViewState();
	      updateCommitFilterIndicators();
	      sendCommitFilters();
	    }
```

- [ ] **Step 6: Delete `applyCommitFilters()`, `filteredCommits()`, and `createCommitQueryMatcher()`**

Remove this whole block (currently lines 3077-3124):

```js
	    function applyCommitFilters() {
	      const list = document.getElementById('commits');
	      if (!list) return;
	      const commitsView = renderCommits(filteredCommits());
	      list.style.setProperty('--graph-col', commitsView.graphWidth + 'px');
	      list.innerHTML = commitsView.html;
	      wireCommitRows();
	    }

	    function filteredCommits() {
	      const query = commitFilters.query || '';
	      const queryMatcher = createCommitQueryMatcher(query);
	      return state.commits.filter((commit) => {
	        if (queryMatcher && !queryMatcher(commit.subject, commit.hash, commit.shortHash)) {
	          return false;
	        }
	        if (commitFilters.users.size > 0 && !commitFilters.users.has(commit.author)) {
	          return false;
	        }
	        if (commitFilters.branches.size > 0) {
	          const commitBranches = new Set(commit.branches || []);
	          const hasBranch = Array.from(commitFilters.branches).some((branch) => commitBranches.has(branch));
	          if (!hasBranch) {
	            return false;
	          }
	        }
	        return true;
	      });
	    }

	    function createCommitQueryMatcher(query) {
	      if (!query.trim()) return undefined;
	      if (commitFilters.regex) {
	        try {
	          const flags = commitFilters.matchCase ? '' : 'i';
	          const pattern = new RegExp(query, flags);
	          return (subject, hash, shortHash) => pattern.test(subject || '') || pattern.test(hash || '') || pattern.test(shortHash || '');
	        } catch (_error) {
	          return () => false;
	        }
	      }

	      const needle = commitFilters.matchCase ? query : query.toLowerCase();
	      return (subject, hash, shortHash) => {
	        const values = [subject || '', hash || '', shortHash || ''];
	        return values.some((value) => (commitFilters.matchCase ? value : value.toLowerCase()).includes(needle));
	      };
	    }
```

- [ ] **Step 7: Compile and lint**

Run: `npm run compile && npm run lint`
Expected: both succeed. (The webview `<script>` body is a TS template string, so `tsc` only checks the surrounding TypeScript; this step primarily catches stray syntax errors that would break the template literal, plus confirms `filteredCommits`/`createCommitQueryMatcher`/`applyCommitFilters` aren't referenced anywhere else — if they were, this would leave dangling calls that only surface at runtime in the webview, so also grep to be sure:)

```bash
grep -n "filteredCommits\|createCommitQueryMatcher\|applyCommitFilters" src/gitLogView.ts
```

Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add src/gitLogView.ts
git commit -m "$(cat <<'EOF'
Wire commit search UI to server-side filtering

The search box, filter dropdowns, flag toggles, and branch double-click
now send updateCommitFilters (debounced for free text) instead of
filtering the loaded commit array in the webview. Removes the now-dead
client-side filtering functions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual end-to-end verification

**Files:** none (verification only)

**Interfaces:** none

This repo has only 15 commits (`git rev-list --all --count`), fewer than `commitPageSize` (300), so the "commit exists past the first loaded page" scenario can't be reproduced against it at the default page size. Temporarily lower the page size for this verification pass only.

- [ ] **Step 1: Temporarily shrink the page size for testing**

In `src/gitLogView.ts`, temporarily change:

```ts
  private static readonly commitPageSize = 300;
```

to:

```ts
  private static readonly commitPageSize = 3;
```

Do not commit this change — it's reverted in Step 8 below.

- [ ] **Step 2: Launch the Extension Development Host**

Press `F5` in VS Code (or run the `Run Extension` launch config). Wait for the new VS Code window to open, then open this repo (`git-pro`) as the workspace and open the GI Pro Git Log panel.

- [ ] **Step 3: Verify search finds commits past the first page**

With `commitPageSize = 3`, only the 3 most recent commits load initially. Pick a commit subject string that only exists further back (e.g. part of "Align publisher with Marketplace" or "Use supported marketplace category" — both older than the 3 most recent). Type it into the commit search box.

Expected: the matching commit appears in the results, even though it wasn't in the initial 3-commit page.

- [ ] **Step 4: Verify regex and match-case toggles**

Toggle regex on, search for a pattern like `^Fix|^Add` (alternation) and confirm only subjects starting with "Fix" or "Add" appear. Toggle match case on/off with a query like `fix` vs `Fix` and confirm case sensitivity changes the result set as expected.

- [ ] **Step 5: Verify branch filter + query combination**

Select a branch filter (via the Branch dropdown or double-clicking a branch in the sidebar) together with a text query. Confirm results are limited to commits reachable from that branch AND matching the query (cross-check by running the equivalent `git log <branch> --grep=... --extended-regexp -i` in a terminal and comparing).

- [ ] **Step 6: Verify hash lookup**

Copy a full 40-character hash and a short (7-8 char) prefix of an older commit (`git log --format=%H` in a terminal to get one). Paste each into the search box separately.

Expected: both resolve to the correct single commit, even if it wasn't in the currently loaded page.

- [ ] **Step 7: Verify clearing filters and invalid regex**

Clear all filters (text, branch, user) and confirm the log reverts to the normal unfiltered view with pagination working via scroll (`loadMoreCommitsNearBottom`). Then enable regex mode and type an unbalanced pattern like `(unclosed`.

Expected: the panel shows the existing error banner (`state.error`) rather than crashing or showing a blank list.

- [ ] **Step 8: Revert the temporary page size change**

In `src/gitLogView.ts`, change `commitPageSize` back to `300`:

```ts
  private static readonly commitPageSize = 300;
```

Run: `git diff src/gitLogView.ts`
Expected: no diff (confirms the temporary test change left no trace).

- [ ] **Step 9: Final compile check**

Run: `npm run compile && npm run lint`
Expected: both succeed with no errors.
