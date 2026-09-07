# Contributors view — design

## Goal

A **Contributors** view in the Gitrail panel, next to **Log**, that shows who has
committed to the repository and when, in the style of GitHub's Insights →
Contributors page: one card per author with a rank badge, commit / added-line /
deleted-line totals, and a weekly bar chart. A **Range** menu narrows the period
and a **Metric** menu switches the chart and ranking between commits, additions
and deletions.

## Decisions taken during brainstorming

| Question | Decision |
|----------|----------|
| Where it lives | A separate webview view (`giPro.contributorsView`) in the existing `giProPanel` container, beside Log. Same provider/webview mechanics as the Log View. |
| Data scope | The full history of `HEAD`, with a client-side time range filter (1 month, 3 months, 6 months, 1 year, All time). Weekly buckets. No branch picker. |
| Avatars | An initials circle coloured by a hash of the author's email. No network calls, no email leaves the machine. |
| Interactions | Metric switch (Commits / Additions / Deletions) and a per-bar hover tooltip. Clicking a contributor does nothing in this version. |
| Computation split | Git runs **once** per HEAD hash on the extension side and produces per-author, per-week totals. Filtering, ranking and drawing happen in the webview, so changing Range or Metric never re-runs git. |

### Approaches rejected

- **Re-run git on every filter change** (`git log --since=…`). Simpler client,
  but every Range change waits on git, and `--numstat` is still needed so it
  is no faster than computing once.
- **`git shortlog -sne` only.** Very fast, but gives no line counts and no
  per-week data, so no chart.

## Files

New directory `src/contributors/`, mirroring `src/logView/`:

| File | Role |
|------|------|
| `src/contributors/provider.ts` | `ContributorsViewProvider`: resolves the webview, watches the repo, recomputes only when `HEAD`'s hash changes, keeps the last computed state in memory, handles webview messages (`refresh`). Exports `registerContributorsView(context, git)` and `showContributorsView()`. |
| `src/contributors/stats.ts` | Pure functions, no `vscode` import: build the git argument list, parse the `--numstat` stream, bucket by author and ISO week. |
| `src/contributors/html.ts` | HTML shell with CSP and nonce, `<link>`/`<script>` to `media/contributors.css` / `media/contributors.js`, state handed off as `window.__gitrailContributors`. Reuses `mediaUri`, `renderErrorHtml` from `logView/html.ts` and `getNonce` from `webviewUtil.ts`. |
| `src/contributors/types.ts` | `ContributorsState`, `Contributor`, `WeekRow`, `ContributorsMessage`. |
| `media/contributors.js` | Front end. Reads the state, applies Range and Metric, ranks, renders cards and SVG charts, owns the toolbar menus and tooltip. No framework. |
| `media/contributors.css` | Styles. Tokens declared on `:root` from `--vscode-*` variables, with `body.vscode-light` overrides stated per theme (see CLAUDE.md "Verifying webview changes"). |

Changes to existing files:

- `package.json`: view `giPro.contributorsView` (name "Contributors", type
  `webview`) under `views.giProPanel`; command `giPro.openContributorsView`
  ("Open Contributors", category Gitrail); activation events
  `onView:giPro.contributorsView` and `onCommand:giPro.openContributorsView`.
- `src/extension.ts`: call `registerContributorsView` and register the command.
- `src/gitRunner.ts`: add `stream(args: string[]): Promise<string>` that runs
  `git` via `child_process.spawn` (no shell, `cwd` = workspace root), concatenates
  stdout without a `maxBuffer` limit, rejects with trimmed stderr on a non-zero
  exit. `exec()` is unchanged; its 10 MB buffer is too small for `--numstat`
  over a large history. `stream()` accepts an optional `timeoutMs`; on timeout
  it kills the child and rejects.

## Data flow

### The git command

```
git log HEAD --no-merges --numstat --date=unix --format=%x1e%aN%x1f%aE%x1f%at
```

- `--no-merges` matches GitHub, and merge commits have no meaningful numstat.
- `%aN` / `%aE` respect `.mailmap`.
- `%x1e` (record separator) opens each commit; `%x1f` splits its fields.
- Author date is used, matching what the Log View displays.

### Parsing (`stats.ts`)

Line by line over stdout:

1. A line starting with `\x1e` begins a new commit: `name`, `email`, `authorTime`.
2. `A\tD\tpath` adds `A` and `D` to the current commit.
3. `-\t-\tpath` (binary file) is skipped.
4. Blank lines are skipped.

Grouping key is the email lower-cased; an empty email falls back to the name.
The display name is the `%aN` of the group's most recent commit.

Week key: the Unix timestamp of Monday 00:00 **UTC** of the week containing the
author date. UTC avoids buckets shifting with the user's timezone between
extension host and webview.

### State

```ts
type WeekRow = [week: number, commits: number, additions: number, deletions: number];

type Contributor = {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  weeks: WeekRow[];          // ascending by week; weeks with no commits omitted
};

type ContributorsState = {
  root: string;
  head?: string;             // HEAD hash the data was computed for
  generatedAt: number;       // ms since epoch
  firstWeek?: number;        // earliest week with a commit, for the "All time" axis
  contributors: Contributor[];
  loading?: boolean;
  error?: string;
};
```

The provider embeds this into the page on every render. The webview never
posts computed data back; it only posts `refresh`.

### Refresh policy

- The provider watches `HEAD`, `packed-refs` and `refs/**` in the git dir (and
  the common dir for linked worktrees), debounced 400 ms, like the Log View.
- On a watcher event it runs `git rev-parse HEAD`. If the hash equals the cached
  `head`, nothing happens. Otherwise it recomputes.
- While recomputing, it renders the **previous** state with `loading: true` so
  the toolbar shows a progress bar and the current charts stay visible.
- The toolbar **Refresh** button posts `{ type: 'refresh' }`, which recomputes
  regardless of the hash.
- Computation is skipped while the view is hidden; the hash check runs when it
  becomes visible.

## UI

### Toolbar

Fixed at the top, styled like the Log View toolbar:

- **Range** dropdown: 1 month · 3 months · 6 months · 1 year · All time
  (default All time).
- **Metric** dropdown: Commits · Additions · Deletions (default Commits).
- **Refresh** button.
- Summary text: "N contributors · M commits" for the selected range and metric
  (the noun follows the metric: "commits", "additions", "deletions").
- A 2 px indeterminate progress bar under the toolbar while `loading`.

Range and Metric are persisted with the webview's `vscode.setState()` so they
survive hide/show.

### Card grid

`display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px`.
Two columns when the panel is wide, one when narrow.

Cards are sorted descending by the selected metric within the selected range.
A contributor whose metric is 0 in the range is not shown. Rank badges `#1`,
`#2`, … follow the sorted order.

### Card

- **Avatar**: 32 px circle, first letter of the name (upper-cased), background
  chosen from an 8-colour palette by a hash of the email, white text.
- **Name** in bold, then a muted line
  `153 commits · 43,303 ++ · 10,475 --` with `++` in the existing green token
  and `--` in the existing red token. Numbers use `toLocaleString()`.
- **Rank badge** `#n` at the top right.
- **Chart**: an SVG below. One bar per week from the range start (or
  `firstWeek` for All time) to the current week. The **y-axis maximum is shared
  across all cards**: the largest single-week value of the selected metric among
  all shown contributors, so bars are comparable between people, as on GitHub.
  Three horizontal grid lines with labels on the right; month labels (`Jul '26`)
  under the x-axis at each month boundary, thinned when weeks are dense.
- **Hover**: the hovered bar darkens and a tooltip shows
  `Week of 21 Jul 2026 · 37 commits`. Tooltip is one absolutely positioned
  element reused across cards.

### Theming

All colours are tokens on `:root` built from `--vscode-*` variables with
fallbacks, and every per-theme value is stated literally in
`body.vscode-light` / default (dark) blocks. No token references another token
across theme blocks.

## Errors and edge cases

| Case | Behaviour |
|------|-----------|
| No workspace folder | `renderErrorHtml('Open a folder before opening Contributors.')`. |
| No commits / `git log` fails | State carries `error` with git's stderr; toolbar still renders with Refresh. |
| Very large repository | Single computation with the loading bar. `stream()` timeout of 60 s; on timeout the error reads "Computing contributors took too long. Try again with Refresh." |
| Range with no commits | Grid shows "No commits in this range." |
| Empty author email | Grouped by name instead. |
| Binary files | Skipped for line counts; the commit still counts. |
| Merge commits | Excluded. |

## Testing

There is no test runner in the repo today. This feature adds:

- `node --test` cases against the compiled `dist/contributors/stats.js`,
  driven from a `test/` directory, with fixtures for: a commit touching several
  files, a binary file line, two emails differing only in case, `.mailmap`-style
  name changes across commits, and commits on either side of a Monday 00:00 UTC
  boundary.
- The headless-Chrome check described in CLAUDE.md, run for both
  `vscode-dark` and `vscode-light`, asserting the `.contributor-card` count, the
  bar `rect` count, and zero `window.onerror` events.
- `npm run compile` and `npm run lint` clean; manual F5 check on this repo and
  on a larger one.

## Out of scope

- Branch picker; clicking a card to filter the Log View; Gravatar or GitHub
  avatars; per-file or per-directory breakdowns; persistence of computed stats
  across VS Code restarts.
