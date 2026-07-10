# Changelog

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

