# Changelog

## 0.1.1

- Fix the Log View discarding what you were in the middle of when a background refresh landed: an open context menu closed itself after a few seconds, an open Branch or User filter dropdown snapped shut, and a multi-commit selection collapsed to a single commit. The refresh now waits until you are idle. `git.autofetch` rewrites `FETCH_HEAD` on a timer, so this fired constantly.
- Keep a multi-commit selection across a refresh, so Drop Commits and Squash Commits no longer lose the commits you picked.
- Remove the duplicate `Focus on Log View`, `Focus on History View`, and `Focus on Gitrail Diff View` entries that VS Code generates automatically. Use `Gitrail: Open Log View`, which also reveals the panel and reloads the log.

## 0.1.0

**Renamed from GI Pro to Gitrail**, published under a new publisher. GI Pro is no longer
maintained; it will not update to Gitrail automatically, so uninstall it and install Gitrail.
Configuration keys (`giPro.*`) are unchanged, so existing settings keep working.

- Add reset modes to "Reset Current Branch to Here": Soft, Mixed, Hard, and Keep, instead of always doing a hard reset.
- Add merge options (`--no-ff`, `--ff-only`, `--squash`, `--no-commit`, `--no-verify`, `--allow-unrelated-histories`) to the Merge action, which previously always forced `--no-ff`.
- Implement the history-editing actions that were previously greyed out: Undo Commit, Edit Commit Message, Fixup, Squash Into, Drop Commits, Squash Commits, and Interactively Rebase from Here.
- Fix branch search in the Log View not matching folder prefixes; searching `folder` now finds `folder/feature-name`.
- Fix the Log View losing input focus while typing when a repository refresh landed mid-keystroke.
- New extension icon and matching panel icon.
- Remove the separator lines between commit rows, shrink the filter dropdown chevrons, and drop the italics from inline blame.

## 0.0.4

- Fix "Update" branch action failing with "local changes would be overwritten by checkout" when updating a branch other than the current one; it now fetches directly into the branch's ref instead of checking it out.
- Add pinned "HEAD" and "Me" quick-filter options to the Log View's Branch and User filters.
- Remove the "← Back to Branches" action from the branch actions menu.

## 0.0.1

- Initial release of GI Pro.
- Add a visual Git Log view with branch tree, searchable commits, graph lanes, changed files, and patch preview.
- Add File History and History for Selection commands from the editor context menu.
- Add inline blame for the active cursor line.
- Add quick Git workflows for smart commit, fetch, pull with rebase, push, force push with lease, stash, branch checkout, interactive rebase, and cherry-pick.

