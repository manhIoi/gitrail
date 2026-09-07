# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension that replicates GI Pro Git workflows. Published as **Gitrail** (`<publisher>.gitrail`); it ships its commands under the `Gitrail` category and a full-screen webview Git Log panel.

Note: `giPro.*` command IDs, configuration keys, and view IDs are unchanged internal identifiers — only user-facing strings were renamed to Gitrail.

## Commands

```bash
npm install          # install dependencies
npm run compile      # tsc one-shot build → dist/
npm run watch        # incremental build on file save
npm run lint         # ESLint over src/
npm test             # compile, then node --test over test/*.test.js (pure parsing + spawn helper)
npm run test:webview # compile, then render the Contributors page in headless Chrome and assert
```

`npm test` covers the pure code (`src/gitSpawn.ts`, `src/contributors/stats.ts`); everything that touches the VS Code API is tested manually by pressing `F5`, which launches an Extension Development Host (configured in `.vscode/launch.json` with a `preLaunchTask: npm: compile`).

## Architecture

Top level of `src/`:

| File | Role |
|------|------|
| `extension.ts` | Entry point. Registers all 16 commands. Each command calls helpers that use `GitRunner`. |
| `gitRunner.ts` | `GitRunner` class — two modes: `run()` sends a command to a persistent VS Code terminal; `exec()` runs a command with `child_process.exec` and returns stdout. Also exports `shellQuote()`. |
| `gitSpawn.ts` | `spawnGit()` — git via `child_process.spawn`, no shell, no stdout cap, optional timeout (`GitTimeoutError`). Backs `GitRunner.stream()`. No `vscode` import, so `npm test` can load it. |
| `gitLogView.ts` | Registration only — wires up the Log View provider and the branch-diff tree, and exposes `GitProContentProvider`. This is the module `extension.ts` imports. |
| `branchNames.ts` | Branch/ref naming shared by the commands and the panel: `suggestBranchName`, `prefilledBranchName`, `validateBranchName`, `validateRefName`, `remoteBranchParts`. |
| `webviewUtil.ts` | `getNonce()`, shared by both webviews. |
| `historyView.ts`, `inlineBlame.ts`, `mergeOptions.ts`, `rebaseEditor.ts` | Independent features. |

The Git Log panel lives in `src/logView/`:

| File | Role |
|------|------|
| `controller.ts` | `GitLogController` — loads state (branches, commits, commit detail + patch) and handles every message the webview posts. The bulk of the panel. |
| `provider.ts` | `GitLogViewProvider` — resolves the webview, watches the repo for refreshes, defers them while a menu or input is open. |
| `branchDiff.ts` | The branch-diff tree in the SCM view: provider, tree items, and its own command registration. |
| `html.ts` | The HTML shell: CSP, nonce, and the `<link>`/`<script>` pointing at `media/`. |
| `controller`'s inputs: `types.ts`, `parse.ts`, `prompts.ts`, `extensionHome.ts` | Shared types, git output parsing, VS Code prompts, and the extension install root. |

The Contributors panel lives in `src/contributors/`:

| File | Role |
|------|------|
| `provider.ts` | `ContributorsViewProvider` — resolves the webview, watches `HEAD`/`refs/**`, recomputes only when `git rev-parse HEAD` changes, keeps the last state in memory. Exports `registerContributorsView` and `showContributorsView`. |
| `stats.ts` | Pure: `contributorLogArgs()`, `weekStart()` (Monday 00:00 UTC), `parseContributorLog()` — folds `git log --numstat` into per-author `WeekRow`s. |
| `html.ts` | The HTML shell; state handed off as `window.__gitrailContributors`. |
| `types.ts` | `WeekRow`, `Contributor`, `ContributorsState`. |

Its front end is `media/contributors.js` and `media/contributors.css`. All filtering (Range), ranking (Metric) and SVG drawing happen there from the one state object; the only message it posts is `refresh`. `FIRST_MONDAY` is declared in both `stats.ts` and `contributors.js` and must stay equal.

The panels' front ends are **not** in `src/` — they are plain files loaded through `asWebviewUri`:

- `media/logView.css`
- `media/logView.js`
- `media/contributors.css`
- `media/contributors.js`

### Key design decisions

- **`run()` vs `exec()`**: `run()` is for commands where terminal output is the UX (push, pull, rebase, etc.). `exec()` is for commands that need to parse stdout to build UI (branch list, commit log, file list).
- **Webview rendering**: `media/logView.js` renders the whole panel client-side from a state object; there is no framework. It posts messages (`selectBranch`, `selectCommit`, `selectFile`, `checkout`, `cherryPick`, `copyHash`, `refresh`) back to `GitLogController.handleMessage()`.
- **State handoff**: `html.ts` emits the state as an inline `<script>` setting `window.__gitrailState`, which `media/logView.js` reads on its first line. The external script must stay after that inline one.
- **Security**: The webview uses a per-render nonce and a strict CSP (`default-src 'none'`). The nonce is carried on the external `<link>` and `<script>`, so the CSP needs no host source. All dynamic content is escaped through an `html()` helper in `media/logView.js`.
- **Graph rendering**: The git graph is rendered as an SVG overlay (`.graph-layer`) positioned absolutely over the commit list. Each character from `git log --graph` is mapped to SVG paths and circles in `renderGraphLayer()`.
- **No extension dependencies**: The extension does not depend on VS Code's built-in Git extension; it shells out directly.

### Verifying webview changes

`tsc` does not look at `media/logView.js` at all, so a green compile says nothing about it. To check a change, render `renderHtml` outside VS Code (stub the `vscode` module, pin `Math.random` so the nonce is stable), inline the two `media/` files into the page, and load it in headless Chrome asserting on `.commit-row` / `.file-row` / `.branch` counts and zero `window.onerror` events.

Two things the harness gets wrong unless you set them up:

- **Run both themes.** VS Code puts `vscode-light` / `vscode-dark` on `<body>`; without that class the page silently uses the dark tokens, which is exactly how a light-theme-only bug hides from a green run.
- **Put VS Code's variables on `:root`.** `--text` and friends are declared there as `var(--vscode-editor-foreground, …)`. A custom property that references another resolves *where it is declared*, so defining `--vscode-*` on `<body>` is too late and the fallback wins. The same rule means a token like `--behind-arrow: var(--orange)` on `:root` freezes the dark value and no `body.vscode-light` override can reach it — state per-theme values literally.

For the Contributors page this harness exists as `test/render-contributors.js` (`npm run test:webview`): it stubs `vscode`, renders `renderContributorsHtml` with a fixed 20-week fixture, loads it in headless Chrome for both themes and asserts card, rank, bar and computed-colour values. Extend its assertions when changing `media/contributors.*`.

### Commit log format

`logView/parse.ts` uses `\x1f` (ASCII unit separator) as a field delimiter within `git log --pretty=format:` to avoid conflicts with commit message content, then splits graph characters from the leading portion of each line.
