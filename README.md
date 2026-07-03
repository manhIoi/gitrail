# IntelliJ Git Actions

VS Code extension prototype for Git workflows similar to IntelliJ IDEA.

## Features

- Smart Commit flow with staged/un-staged handling and optional push prompt.
- Fetch, pull with rebase, push, and force push with lease.
- Interactive rebase from a chosen number of commits.
- Stash and pop stash through Quick Pick.
- Checkout local or remote branches through Quick Pick.
- Compare current file with `HEAD`.
- Show file history and graph log in the terminal.
- Cherry-pick a commit selected from recent log entries.
- IntelliJ-like Git Log GUI with searchable branch tree, colored graph lanes, changed-file tree, and file patch preview.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

Use the Command Palette and search for `IntelliJ Git`.

Open `IntelliJ Git: Git: Open IntelliJ-like Log View` to use the GUI log view.

- Search branches from the left sidebar.
- Click a branch to filter commits.
- Double-click a branch to checkout.
- Click a commit to inspect metadata and changed files.
- Expand folders in the changed-file tree and click a file to preview its patch.
