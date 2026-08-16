# Changelog

## 0.1.9

- Recolour the author name on your own commits from teal to a deep sea blue — `#0b5a8a` in the light theme, `#74bdea` in the dark one. The teal was the same hue as the graph's `gc-7` lane, drawn two columns away in the same row, which is what made it read as glaring rather than as a mark. The blue also carries more contrast: 7.38:1 and 8.01:1, and 6.40:1 and 7.00:1 on a highlighted row, against teal's 5.47:1 and 4.74:1.

## 0.1.8

- Turn on `Highlight commits on '<branch>'` by default, and make it a setting — `giPro.logView.highlightCurrentBranch`. It had to become a setting to mean anything: the View menu's state was kept in the panel's own storage, which is rewritten on every scroll, so a stored value always won and there was no default left to change. The menu now writes the setting instead of a copy of it, which also means the choice follows you to another window and another machine.
- Add `Highlight my commits`, on by default, as `giPro.logView.highlightMyCommits`. Commits you authored show their name in teal and bold, leaving the row background to the branch highlight so both can be read at once. Matched on `git config user.name`, the same way the User filter's `Me` entry already does, so the two can never disagree. The option is greyed out when no user name is set.
- Fix the branch highlight vanishing from a row the moment you point at it. The rule excluded hovered rows outright, so hovering a commit on the current branch made it look exactly like one from elsewhere — at the moment you were looking hardest. The tint now rides on `background-image` while hover and selection keep `background-color`, so a hovered highlighted row shows both instead of one replacing the other.

## 0.1.7

- Colour the ahead/behind count blue rather than leaving it in the row's text colour, which made it plain white in the dark theme. IntelliJ gives the number its own blue so it reads as a count you can click toward rather than as part of the branch name, and Gitrail now matches: `#6089ef` in the dark theme, and `#4069e0` in the light one — IntelliJ's own `#4573e8` two steps darker, since at 12px bold its 4.31:1 sits just under the ratio text wants on white.

## 0.1.6

- Stop a branch that is behind turning its whole row one colour. The branch glyph, the arrow and the count were all painted with the same orange, so a row that was merely out of date read as a warning and the glyph stopped saying "branch" at all. The glyph now keeps its blue in every tracking state, the way IntelliJ's branch popup does, and only the small direction arrow carries the state — `↓` in coral when behind, `↑` in blue when ahead. The count beside it is a number, so it now sits in the row's ordinary text colour and is read rather than decoded.
- Brighten the star on the current branch in the light theme, to the gold IntelliJ uses. It had been sharing a token with the current branch's ref label on a commit row, which is 12px text and needs a text contrast ratio; they are separate now, so the star can be a bright `#f5c344` while the label stays readable at `#b45309`.

## 0.1.5

- Lift the branch icon colours in the light theme, which had been darkened past the point where they still read as the colour they were meant to be. A branch that is behind, and the star on the current branch, were `#8a6000` and `#a06000` — yellow at 27% lightness, which reads as olive mud rather than amber. They are now a single amber `#b45309`, ten points lighter and rotated away from the olive band, still clear of the red that marks a deleted file. The branch icon blue is lifted a little too, `#0066bb` to `#0072d1`, at the same hue. Every one of these stays above the 4.5:1 contrast ratio on white. The dark theme is untouched; its equivalents were already bright.

## 0.1.4

- Add `Gitrail: New Branch...` as a command. Creating a branch was only reachable by opening `Gitrail: Branches` and picking `+ New Branch...` from the list, so it never appeared in the Command Palette and there was nothing to bind a keyboard shortcut to. It behaves exactly as that list entry did — branches from HEAD, with the name prefilled from the current branch.

## 0.1.3

- Prefill the `New Branch` prompt with a name derived from the ref the branch starts at, selected end to end so it can be typed straight over or edited in place. Branching off `feature/login` opens with `feature/login` already in the box, so the prefix your convention dictates does not have to be retyped. Branching off a remote drops the remote — `origin/feature/login` becomes `feature/login`, the local name the branch would get anyway — and branching off a long-lived branch (`main`, `develop`, and so on) prefills nothing, since its name says nothing about what the new branch should be called. Applies to `New Branch` from a branch, from a commit, and from HEAD, in both the Log View and the command palette.
- Stop `origin/` — a remote name with nothing after the slash — being read as a branch on `origin` with an empty name. It is now rejected, as it already was everywhere else.
- Internal: the Log View's stylesheet and script moved out of `src/gitLogView.ts` into `media/logView.css` and `media/logView.js`, and the rest of that 4,367-line file was split into `src/logView/`. No behaviour changes, and the panel's CSP is unchanged.

## 0.1.2

- Make the branch labels on a commit readable. A branch level with its remote was listed twice and the two labels shared the space, so a row would show `origin/... origin/... ma...` and name nothing. The pair is now one `origin & main` label, the way IntelliJ writes it, and a label will not shrink below the width of an actual branch name — the commit subject gives way instead. `origin/HEAD` no longer appears as a label of its own.
- Add a `View` menu to the Log View toolbar, with two options that persist across reloads. `Highlight commits on '<branch>'` tints the background of every commit the current branch contains, so what you are working on stands out without recolouring text that already carries meaning; it is greyed out when HEAD is detached, since there would be no branch to compare against. `No merge commits` drops merges from the log, including one reached by pasting its hash.
- Keep the graph joined up when a filter is on. A filter hides commits from the log but not from history, so a row's parent was often no longer on screen and its lane simply ended — the graph broke into loose dots. git does not rewrite parents for `--grep`, `--author` or `--no-merges`, so Gitrail now works out the nearest ancestors that survived the filter and draws to those. Affects every filter, not just `No merge commits`. Links that reach further than a few rows are marked with an arrow at each end rather than routed as a lane, the way git's own graph declines to route them — on a real repository one such link spanned 163 rows, and routing them all took the graph from 3 lanes to 17. Measured against `git log --graph --no-merges` on the same commits: git uses 3 lanes there, Gitrail now uses 4, previously 17. The unfiltered graph is untouched.
- Remove every divider line from the Log View — between the three panes, under both toolbars, and under the commit details card — so the panel reads as one surface. The pane drag handle still occupies the same 6px and only shows itself when you are on it, so resizing is unchanged. Outlines around inputs and buttons, and the borders of popup menus, stay.
- Stop clicking commits painting them with a text selection. Selecting a range of commits is a drag, which the browser also read as dragging across text, so rows ended up highlighted blue on top of the row selection. Commit rows, branch tree rows, changed-file rows and context menus no longer take a text selection; the search box and the commit hash in the details pane still do.
- Fix the branch context menu sitting at a fixed narrow width and cutting its labels off mid-word. Its rows put the label straight into the row element, which lays its children out in a grid, so the label was placed in the 26px icon column and spilled out of it. The menu measured itself as a few pixels wide, fell back to its minimum, and clipped everything past that. It now sizes to the longest entry, so `Rebase 'development' onto 'chore/split-lt-cleanup-workflow'` reads in full.
- Enlarge the Log View text from 11px to 12px. Every text size now derives from one `--font-size` variable rather than being repeated in seven rules, so branch names, commit subjects, refs, authors and dates all grow together. Row height is unchanged.
- Remove the phantom `origin` entry from the `Checkout Branch` and `Branches` lists too. 0.1.1 dropped it from the Log View but left it in both quick picks, which read their remote branches separately.
- Stop the Merge action asking for merge options every time. IntelliJ's branch popup runs a bare `git merge <branch>` — fast-forward when it can, a merge commit otherwise — so that is what merging from a branch menu now does. The options are still there, as the `Gitrail: Merge with Options...` command, which asks for the branch and then the flags. Keeping them out of the branch menus keeps those menus short.

## 0.1.1

- Fix the Log View discarding what you were in the middle of when a background refresh landed: an open context menu closed itself after a few seconds, an open Branch or User filter dropdown snapped shut, and a multi-commit selection collapsed to a single commit — which meant Drop Commits and Squash Commits lost the commits you had picked. Refreshes now wait until you are idle, and the selection survives one. `git.autofetch` rewrites `FETCH_HEAD` on a timer, so this fired constantly.
- Fix clearing a commit search throwing away the commit you had selected. The list rebuilt from the newest 300 commits, which usually does not reach a commit found by searching, so the selection was dropped and the view jumped to the top. The log now loads deep enough to keep that commit listed and scrolls to centre it.
- Make applying a commit filter substantially cheaper. Working out which branches contain which commits ran one `git rev-list` per branch on every keystroke, around 60% of the cost, even though typing moves no branch tip. It is now computed once and reused until a tip actually changes. Measured on a synthetic 20,000 commit repository with 61 branches: 230ms of the 395ms went away.
- Ignore the result of a commit filter that a newer one has already superseded, instead of letting both finish and letting the loser write back.
- Remove the phantom `origin` entry from the branch tree and the Branch filter. It was `refs/remotes/origin/HEAD`, whose shortened name is just `origin`, duplicating whatever the remote's default branch points at. The check meant to drop it looked for `HEAD ->` text that `--format` never prints.
- Send `Compare with Local` and `Compare with <branch>` to the Gitrail Diff view instead of dumping raw `git diff` and `git log` text into an output channel. Every diff and compare action now lands in the same place, as a changed-file tree you can open file by file or Get from.
- Show commit times the way IntelliJ does: `just now` and `N minutes ago` within the hour, then `Today 15:53`, `Yesterday 22:45`, and `25/7/26, 01:54`. A bare `15:53` left it ambiguous whether the commit was from today. Relative labels retick every 30 seconds.

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

