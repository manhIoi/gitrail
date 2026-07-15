# Server-side commit search/filter — design

## Problem

The commit log webview (`src/gitLogView.ts`) lazy-loads commits from `git log` in
pages of `commitPageSize = 300`, growing `commitLimit` by 300 whenever the user
scrolls near the bottom of the commit list (`loadMoreCommitsNearBottom`,
`handleMessage` on `loadMoreCommits`).

The commit search/filter box (message text, hash, author, branch) is implemented
entirely client-side in the webview: `filteredCommits()` filters `state.commits`,
which only contains whatever has been loaded into the current page. If a commit
matching the search hasn't been loaded yet (e.g. commit #500 while only 300 are
loaded), the search silently returns nothing, even though the commit exists in
the repository.

## Why not just load the full history

Loading every commit up front was considered and rejected. This file's rendering
architecture makes that expensive independent of how fast `git log` itself runs:

1. **Full-state re-embed on every render.** `renderHtml` does
   `JSON.stringify(state)` and `this.webview.html = renderHtml(...)` fully
   replaces the webview content on *every* state-changing message (select
   branch, select commit, checkout, refresh, load more, ...). A full-history
   commit array would make every one of those interactions re-serialize and
   re-parse a very large JSON blob.
2. **No DOM virtualization.** `renderCommits()` creates one `<div class="commit-row">`
   per commit and `computeGraphLayout`/`renderGraphSvg` compute SVG paths/circles
   per commit for the graph overlay — for every row in the array, not just the
   visible ones. Tens of thousands of real DOM nodes get janky.
3. **O(n) graph layout recompute per keystroke.** `applyCommitFilters()` calls
   `renderCommits(filteredCommits())` on every input event, re-running
   `computeGraphLayout` over the full filtered set each time.

IntelliJ's VCS Log achieves "search finds anything in history" not by loading
everything into memory/DOM, but via a persistent on-disk commit index plus a
virtualized list renderer. This project has neither, and building a persistent
index is out of scope here. Instead, this design keeps the existing bounded
pagination and pushes search to `git log` itself, which is fast even against
very large histories.

## Design

### 1. Trigger strategy: always server-side

Whenever any filter is active (`query`, `users`, or `branches` non-empty),
commit results come **only** from a `git log` invocation built from those
filters — not from filtering the already-loaded page. This keeps a single
source of truth and guarantees "search" really means "search all of history,"
matching user expectation.

Free-text query changes are debounced ~280ms in the webview before sending;
checkbox/dropdown changes (users, branches, regex, matchCase toggle) send
immediately.

### 2. Message protocol & controller state

New webview → extension message:

```ts
{ type: 'updateCommitFilters', query: string, matchCase: boolean, regex: boolean,
  users: string[], branches: string[] }
```

`GitLogController` gains fields mirroring this (`commitFilterQuery`,
`commitFilterMatchCase`, `commitFilterRegex`, `commitFilterUsers: Set<string>`,
`commitFilterBranches: Set<string>`). On receipt:

1. Store the new filter values.
2. Reset `this.commitLimit = GitLogController.commitPageSize` (a filter change
   starts a fresh "page 1").
3. Call `this.render()` — same full-HTML-replace pattern already used by
   `loadMoreCommits`; no new update mechanism is introduced.

`loadMoreCommits` is unchanged in shape (`commitLimit += commitPageSize` then
`render()`), but because `loadCommits()` now consults the active filters, "load
more" while a search is active correctly paginates through more search
matches instead of the unfiltered log.

Clearing all filters (empty query, no users, no branches) reverts `loadCommits()`
to the exact original unfiltered `--all` path.

### 3. `git log` construction

```
target = commitFilterBranches.size > 0
  ? [...commitFilterBranches].map(shellQuote).join(' ')   // scope directly to selected refs (OR semantics)
  : '--exclude=refs/stash --all'

grepArgs = query
  ? `--grep=${shellQuote(query)} ${regex ? '--extended-regexp' : '--fixed-strings'} ${matchCase ? '' : '-i'}`
  : ''

authorArgs = [...commitFilterUsers]
  .map(u => `--author=${shellQuote('^' + escapeRegex(u) + '$')}`)
  .join(' ')   // multiple --author flags are OR'd natively by git
```

`escapeRegex` is a small new local helper (escapes basic-regex metacharacters)
so an author name containing regex-special characters is matched literally
inside the `^...$` anchor. `shellQuote` already exists in `gitRunner.ts` and is
reused as-is.

`--fixed-strings` is used for non-regex queries so plain-text search behaves
like a literal substring match (matching today's client-side behavior) instead
of git's default basic-regex interpretation.

Branch filter scoping directly replaces `--all` with the selected ref(s) rather
than keeping `--all` and post-filtering the page, because post-filtering a
capped `-n commitLimit` page can drop real matches that exist beyond the page
boundary once commits from other branches have consumed page slots.

**Hash branch.** `git log --grep` does not search hashes, but the search box's
placeholder ("Filter by commit message or hash") and prior client behavior
both support hash lookup. If `query` matches `/^[0-9a-f]{4,40}$/i`, run an
additional best-effort lookup in parallel:

```
git log <target> -1 <query> --pretty=format:<same format>
```

wrapped in try/catch (invalid/ambiguous revs throw). If it resolves, dedupe by
hash and prepend the result before applying the `commitLimit` slice.

`assignCommitBranches` (branch badge annotation) is unchanged — it runs on
whatever commit array results, and its cost doesn't depend on how many commits
are in that array.

### 4. Webview changes

- `filteredCommits()` and `createCommitQueryMatcher()` are deleted. `state.commits`
  is already filtered by the time it reaches the webview.
- The commit search input, filter dropdowns, and flag toggles send
  `updateCommitFilters` (debounced for text) instead of calling
  `applyCommitFilters()` locally.
- A lightweight "Searching…" indicator is shown while awaiting the extension's
  response, reusing the existing `loadingMoreCommits`-style flag/spinner used
  for load-more.

### 5. Error handling

- Invalid regex (e.g. unbalanced `(` with the regex flag on): `git log` exits
  non-zero with stderr from the grep compile failure. This surfaces through the
  existing `loadState()` catch block into `state.error`, reusing the error
  banner already rendered for other git failures — no new error UI needed.
- Invalid/ambiguous hash query: the extra hash-lookup call is best-effort;
  errors are swallowed silently, matching the existing per-branch try/catch in
  `assignCommitBranches` for stale/deleted refs.

### 6. Manual verification plan

No automated test infrastructure exists in this repo (per `CLAUDE.md`). Verify
via `F5` Extension Development Host against a repo with 300+ commits:

1. Search a message string that only exists on a commit past the first page →
   confirm it's found (previously silently failed).
2. Toggle regex / matchCase and confirm results match git's actual grep
   semantics for a couple of patterns.
3. Combine a branch filter with a query on a repo with divergent branches →
   confirm no matches are missed (the scoping-vs-post-filter correctness fix).
4. Paste a full 40-char hash and a short (7-char) prefix of an old, unloaded
   commit → confirm the hash branch resolves it.
5. Clear all filters → confirm exact reversion to the original unfiltered
   behavior and pagination.
6. Type an invalid regex pattern with the regex flag on → confirm a graceful
   error banner, not a crash.

## Out of scope

- Persistent on-disk commit index (IntelliJ-style). Not needed once search is
  server-side against `git log`, which is fast enough for this use case.
- DOM virtualization of the commit list. Independent concern; not required by
  this change since page size stays bounded at `commitPageSize`.
