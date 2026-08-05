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
```

There are no automated tests. Manual testing is done by pressing `F5` in VS Code, which launches an Extension Development Host (configured in `.vscode/launch.json` with a `preLaunchTask: npm: compile`).

## Architecture

Three source files in `src/`:

| File | Role |
|------|------|
| `extension.ts` | Entry point. Registers all 15 commands. Each command calls helpers that use `GitRunner`. |
| `gitRunner.ts` | `GitRunner` class — two modes: `run()` sends a command to a persistent VS Code terminal; `exec()` runs a command with `child_process.exec` and returns stdout. Also exports `shellQuote()`. |
| `gitLogView.ts` | Singleton webview panel (`giProLog`). `GitLogController` loads state (branches, commits, commit detail + patch) and renders everything as a single self-contained HTML string with embedded CSS and JS. |

### Key design decisions

- **`run()` vs `exec()`**: `run()` is for commands where terminal output is the UX (push, pull, rebase, etc.). `exec()` is for commands that need to parse stdout to build UI (branch list, commit log, file list).
- **Webview rendering**: `gitLogView.ts` renders the entire panel as server-side HTML each time state changes; there is no framework. The webview JS posts messages (`selectBranch`, `selectCommit`, `selectFile`, `checkout`, `cherryPick`, `copyHash`, `refresh`) back to `GitLogController.handleMessage()`.
- **Security**: The webview uses a per-render nonce and a strict CSP (`default-src 'none'`). All dynamic content is escaped through an `html()` helper in the embedded JS.
- **Graph rendering**: The git graph is rendered as an SVG overlay (`.graph-layer`) positioned absolutely over the commit list. Each character from `git log --graph` is mapped to SVG paths and circles in `renderGraphLayer()`.
- **No extension dependencies**: The extension does not depend on VS Code's built-in Git extension; it shells out directly.

### Commit log format

`gitLogView.ts` uses `\x1f` (ASCII unit separator) as a field delimiter within `git log --pretty=format:` to avoid conflicts with commit message content, then splits graph characters from the leading portion of each line.
