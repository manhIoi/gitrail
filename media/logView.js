	    const vscode = acquireVsCodeApi();
	    const state = window.__gitrailState;
	    const currentBranch = state.branches.find((branch) => branch.current)?.name;
	    const branchesByName = new Map(state.branches.map((branch) => [branch.name, branch]));
	    const persistedViewState = vscode.getState() || {};
	    const commitFilters = {
	      query: persistedViewState.commitFilters?.query || '',
	      matchCase: Boolean(persistedViewState.commitFilters?.matchCase),
	      regex: Boolean(persistedViewState.commitFilters?.regex),
	      branches: new Set(persistedViewState.commitFilters?.branches || []),
	      users: new Set(persistedViewState.commitFilters?.users || [])
	    };
	    // Highlighting is decided in the browser from data already on each row; No merge
	    // commits is a git argument and has to go back to the extension.
	    const viewOptions = {
	      highlightCurrentBranch: Boolean(persistedViewState.viewOptions?.highlightCurrentBranch),
	      noMerges: Boolean(persistedViewState.viewOptions?.noMerges)
	    };
	    const paneSizes = {
	      sidebar: persistedViewState.paneSizes?.sidebar || 280,
	      detail: persistedViewState.paneSizes?.detail || 420
	    };
	    const scrollTops = {
	      branches: persistedViewState.scrollTops?.branches || 0,
	      commits: persistedViewState.scrollTops?.commits || 0,
	      files: persistedViewState.scrollTops?.files || 0
	    };
	    // A multi-commit selection is what Drop Commits and Squash Commits operate on, and it
	    // lives only in the DOM, so restore it across a re-render. Drop hashes that are no
	    // longer listed: a branch switch or a filter change must not carry a stale selection.
	    const selectedCommitHashes = new Set(
	      (persistedViewState.selectedCommits || []).filter((hash) => state.commits.some((commit) => commit.hash === hash))
	    );
	    if (!selectedCommitHashes.size && state.selectedCommit) {
	      selectedCommitHashes.add(state.selectedCommit);
	    }
	    let lastSelectedCommitHash = selectedCommitHashes.has(persistedViewState.lastSelectedCommit)
	      ? persistedViewState.lastSelectedCommit
	      : state.selectedCommit;
	    let loadingMoreCommits = false;
	    let commitFilterDebounce;
	    let lastReportedOverlayOpen = false;

	    function sendCommitFilters() {
	      showCommitsSearching();
	      send({
	        type: 'updateCommitFilters',
	        query: commitFilters.query,
	        matchCase: commitFilters.matchCase,
	        regex: commitFilters.regex,
	        users: Array.from(commitFilters.users),
	        branches: Array.from(commitFilters.branches),
	        noMerges: viewOptions.noMerges
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

	    function send(message) {
	      vscode.postMessage(message);
	    }

	    function persistViewState() {
	      vscode.setState({
	        commitFilters: {
	          query: commitFilters.query,
	          matchCase: commitFilters.matchCase,
	          regex: commitFilters.regex,
	          branches: Array.from(commitFilters.branches),
	          users: Array.from(commitFilters.users)
	        },
	        viewOptions,
	        paneSizes,
	        scrollTops,
	        selectedCommits: Array.from(selectedCommitHashes),
	        lastSelectedCommit: lastSelectedCommitHash
	      });
	    }

    function html(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const now = new Date();
      // Use Date.UTC with local components on both sides to avoid DST arithmetic errors
      const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const commitMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((todayMs - commitMs) / 86400000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const time = hh + ':' + mm;
      const minutesAgo = Math.floor((now.getTime() - d.getTime()) / 60000);
      // Within the hour a clock time makes the reader do the subtraction, so say it outright.
      // Anything older reads better as a fixed point in time than as a growing count.
      if (diff <= 0 && minutesAgo >= 0 && minutesAgo < 60) {
        if (minutesAgo < 1) return 'just now';
        return minutesAgo === 1 ? '1 minute ago' : minutesAgo + ' minutes ago';
      }
      if (diff <= 0) return 'Today ' + time;
      if (diff === 1) return 'Yesterday ' + time;
      return d.getDate() + '/' + (d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ', ' + time;
    }

    // "N minutes ago" would sit frozen now that refreshes wait for the user to be idle, so
    // retick it here. Only the text of the date cells is rewritten: replacing the list's
    // innerHTML would close an open context menu, which is the bug this release fixes.
    function startRelativeTimeTicker() {
      setInterval(() => {
        document.querySelectorAll('.date[data-date]').forEach((node) => {
          const next = formatDate(node.dataset.date);
          if (node.textContent !== next) node.textContent = next;
        });
      }, 30000);
    }

    function formatDetailDate(isoStr) {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return d.getDate() + '/' + (d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' at ' + hh + ':' + mm;
    }

	    function refLabels(refs) {
	      const groups = groupRefs(refs);
	      if (!groups.length) return '';
	      return '<span class="refs">' + groups.slice(0, 3).map(renderRefLabel).join('') + '</span>';
	    }

	    // git names every ref pointing at the commit, so a branch that is up to date with its
	    // remote is listed twice and each label ends up truncated to "origin/..." - three of
	    // those say nothing. IntelliJ shows one label per branch, writing the pair as
	    // "origin & main", which is safe here: git only listed both because both are on this
	    // commit, so there is no divergence to hide. refs/remotes/<remote>/HEAD comes through
	    // too, shortened to a bare remote name that only duplicates whatever it points at.
	    function groupRefs(refs) {
	      const names = (refs || []).map(refName).filter((name) => name && !name.endsWith('/HEAD'));
	      const isRemote = (name) => branchesByName.get(name)?.type === 'remote';
	      const remoteOf = new Map();
	      const paired = new Set();
	      names.filter(isRemote).forEach((remote) => {
	        const local = names.find((name) => {
	          if (isRemote(name) || remoteOf.has(name) || !remote.endsWith('/' + name)) return false;
	          // What is left has to be the remote's own name, or this pairs a local "feature"
	          // with an unrelated "origin/my/feature" and invents a remote called "origin/my".
	          return !remote.slice(0, remote.length - name.length - 1).includes('/');
	        });
	        if (!local) return;
	        remoteOf.set(local, remote.slice(0, remote.length - local.length - 1));
	        paired.add(remote);
	      });
	      return names
	        .filter((name) => !paired.has(name))
	        .map((name) => ({ text: remoteOf.has(name) ? remoteOf.get(name) + ' & ' + name : name, branch: name }));
	    }

	    function renderRefLabel(group) {
	      const branch = branchesByName.get(group.branch);
	      const className = branch ? branchStatusClass(branch, 'ref') : 'ref';
	      const tracking = branch ? trackingText(branch.tracking, true) : '';
	      return '<span class="' + className + '" title="' + html(group.text) + '">' + html(group.text) + (tracking ? '<span class="ref-track">' + html(tracking) + '</span>' : '') + '</span>';
	    }

	    function refName(ref) {
	      return String(ref || '').replace('HEAD -> ', '').trim();
	    }

	    function trackingText(tracking, compact) {
	      const ahead = Number(tracking?.ahead || 0);
	      const behind = Number(tracking?.behind || 0);
	      const parts = [];
	      if (behind) parts.push('↓' + (compact ? '' : ' ') + behind);
	      if (ahead) parts.push('↑' + (compact ? '' : ' ') + ahead);
	      return parts.join(compact ? ' ' : '  ');
	    }

	    function branchStatusClass(branch, target) {
	      const tracking = branch?.tracking || {};
	      const ahead = Number(tracking.ahead || 0);
	      const behind = Number(tracking.behind || 0);
	      if (target === 'status') {
	        if (ahead && behind) return 'track-diverged';
	        if (behind) return 'track-behind';
	        if (ahead) return 'track-ahead';
	        return '';
	      }
	      if (target === 'tree') {
	        return branch?.current ? 'tree-icon current-icon' : 'tree-icon branch-icon';
	      }
	      if (branch?.current) return 'ref current-ref';
	      if (ahead && behind) return 'ref diverged-ref';
	      if (behind) return 'ref behind-ref';
	      if (ahead) return 'ref ahead-ref';
	      return 'ref ';
	    }

	    function branchFilterOptions() {
	      return state.branches.map((branch) => branch.name).sort((a, b) => a.localeCompare(b));
	    }

	    function userFilterOptions() {
	      return Array.from(new Set(state.commits.map((commit) => commit.author).filter(Boolean))).sort((a, b) => a.localeCompare(b));
	    }

	    function filterButtonLabel(label, selectedCount) {
	      return '<span class="filter-label">' + html(label + (selectedCount ? ' ' + selectedCount : '')) + '</span>' +
	        (selectedCount ? '<span class="filter-clear" role="button" title="Clear ' + html(label.toLowerCase()) + '" data-filter-clear="' + html(label.toLowerCase()) + '">×</span>' : '') +
	        '<span class="filter-chevron" aria-hidden="true"></span>';
	    }

	    function renderFilterOption(kind, value, displayLabel, selected, searchable) {
	      const checked = selected.has(value) ? ' checked' : '';
	      const rowAttr = searchable ? ' data-filter-option-row="' + html(displayLabel.toLowerCase()) + '"' : '';
	      return '<label class="filter-option" title="' + html(displayLabel) + '"' + rowAttr + '>' +
	        '<input type="checkbox" data-filter-option="' + html(kind) + '" value="' + html(value) + '"' + checked + '>' +
	        '<span>' + html(displayLabel) + '</span>' +
	      '</label>';
	    }

	    function renderFilterDropdown(kind, label, pinned, options, selected) {
	      const active = selected.size > 0 ? ' active' : '';
	      const pinnedItems = pinned.map((option) => renderFilterOption(kind, option.value, option.display, selected, false)).join('');
	      const items = options.map((option) => renderFilterOption(kind, option, option, selected, true)).join('');
	      return '<div class="filter-dropdown" data-filter-dropdown="' + html(kind) + '">' +
	        '<button class="filter-dropdown-button' + active + '" type="button" data-filter-toggle="' + html(kind) + '">' + filterButtonLabel(label, selected.size) + '</button>' +
	        '<div class="filter-menu">' +
	          (pinnedItems ? '<div class="filter-pinned">' + pinnedItems + '</div><div class="filter-menu-divider"></div>' : '') +
	          '<input class="filter-menu-search" data-filter-menu-search="' + html(kind) + '" placeholder="Search ' + html(label.toLowerCase()) + '">' +
	          (items || '<div class="empty">No options</div>') +
	        '</div>' +
	      '</div>';
	    }

	    // Same shell as the Branch and User dropdowns, so opening it closes them, clicking away
	    // closes it, and reportOverlayState() already knows to hold refreshes back while it is
	    // open. The options are booleans rather than a set, so they get their own attribute and
	    // handler instead of riding on data-filter-option.
	    function renderViewOptionsDropdown() {
	      const items = [
	        {
	          key: 'highlightCurrentBranch',
	          label: 'Highlight commits on ' + (currentBranch ? "'" + currentBranch + "'" : 'current branch'),
	          // With a detached HEAD there is no branch to compare against, and every row would
	          // dim at once - which reads as a broken panel rather than a highlight.
	          disabled: !currentBranch,
	          title: currentBranch ? 'Dim commits that are not on ' + currentBranch : 'HEAD is detached, so there is no current branch'
	        },
	        { key: 'noMerges', label: 'No merge commits', disabled: false, title: 'Hide commits with more than one parent' }
	      ];
	      const active = items.some((item) => !item.disabled && viewOptions[item.key]);
	      return '<div class="filter-dropdown" data-filter-dropdown="view">' +
	        '<button class="filter-dropdown-button' + (active ? ' active' : '') + '" type="button" data-filter-toggle="view">' +
	          '<span class="filter-label">View</span><span class="filter-chevron" aria-hidden="true"></span>' +
	        '</button>' +
	        '<div class="filter-menu">' +
	          items.map((item) =>
	            '<label class="filter-option" title="' + html(item.title) + '">' +
	              '<input type="checkbox" data-view-option="' + html(item.key) + '"' +
	                (viewOptions[item.key] && !item.disabled ? ' checked' : '') +
	                (item.disabled ? ' disabled' : '') + '>' +
	              '<span>' + html(item.label) + '</span>' +
	            '</label>'
	          ).join('') +
	        '</div>' +
	      '</div>';
	    }

	    function renderCommitToolbar() {
	      return '<div class="toolbar commit-toolbar">' +
	        '<div class="commit-search-wrap">' +
	          '<span class="commit-search-icon">' + searchIcon() + '</span>' +
	          '<input id="commitSearch" class="commit-search" placeholder="Filter by commit message or hash">' +
	          '<button id="commitSearchClear" class="clear-button" type="button" title="Clear filter" hidden>×</button>' +
	          '<button class="filter-toggle" type="button" title="Match case" data-filter-flag="matchCase">Aa</button>' +
	          '<button class="filter-toggle" type="button" title="Match regex" data-filter-flag="regex">.*</button>' +
	        '</div>' +
	        renderFilterDropdown('branches', 'Branch', currentBranch ? [{ value: currentBranch, display: 'HEAD' }] : [], branchFilterOptions(), commitFilters.branches) +
	        renderFilterDropdown('users', 'User', state.currentUser ? [{ value: state.currentUser, display: 'Me' }] : [], userFilterOptions(), commitFilters.users) +
	        renderViewOptionsDropdown() +
	        '<span class="toolbar-spacer"></span>' +
	        '<button id="goToHead" class="icon-button" type="button" title="Go to branch head (selected branch or current)">' + targetIcon() + '</button>' +
	        '</div>';
	    }

	    function searchIcon() {
	      return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.9 9.9 13.4 13.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
	    }

    function renderBranches() {
      const groups = [
        ['HEAD', state.branches.filter((branch) => branch.current)],
        ['Local', state.branches.filter((branch) => branch.type === 'local' && !branch.current)],
        ['Remote', state.branches.filter((branch) => branch.type === 'remote')]
      ];
      return groups.map(([title, branches]) => {
        const rows = renderBranchTree(buildBranchTree(branches));
        return '<div class="section-title">' + title + '</div>' + (rows || '<div class="empty">No branches</div>');
      }).join('');
    }

    function buildBranchTree(branches) {
      const root = { folders: new Map(), branches: [] };
      branches.forEach((branch) => {
        const parts = branch.name.split('/').filter(Boolean);
        let node = root;
        parts.slice(0, -1).forEach((part) => {
          if (!node.folders.has(part)) {
            node.folders.set(part, { name: part, folders: new Map(), branches: [] });
          }
          node = node.folders.get(part);
        });
        node.branches.push({ ...branch, displayName: parts.at(-1) || branch.name });
      });
      return root;
    }

    function renderBranchTree(node, depth = 0) {
      const entries = [
        ...Array.from(node.folders.values()).map((folder) => ({ kind: 'folder', name: folder.name, folder })),
        ...node.branches.map((branch) => ({ kind: 'branch', name: branch.displayName, branch }))
      ].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));

      return entries.map((entry) => {
        if (entry.kind === 'folder') {
          const folder = entry.folder;
          return '<div class="tree-row folder ' + treeLevel(depth) + '" data-branch-folder data-tree="branch" data-depth="' + depth + '">' +
            '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon folder-icon">' + folderIcon() + '</span><span class="tree-name">' + html(folder.name) + '</span>' +
          '</div>' + renderBranchTree(folder, depth + 1);
        }

        const branch = entry.branch;
        const active = state.selectedBranch === branch.name;
        const isPrimary = branch.current || branch.displayName === 'main' || branch.displayName === 'master';
        const iconClass = isPrimary ? 'tree-icon current-icon' : branchStatusClass(branch, 'tree');
        const icon = isPrimary ? starIcon() : (branch.type === 'remote' ? remoteIcon() : branchIcon());
        const status = renderBranchStatus(branch);
        return '<div class="tree-row branch ' + treeLevel(depth) + ' ' + (active ? 'active' : '') + '" data-branch="' + html(branch.name) + '" data-branch-type="' + html(branch.type) + '" data-branch-current="' + String(Boolean(branch.current)) + '" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="' + iconClass + '">' + icon + '</span><span class="tree-name">' + html(branch.displayName) + '</span>' + status +
        '</div>';
      }).join('');
    }

    function renderBranchStatus(branch) {
      const ahead = Number(branch.tracking?.ahead || 0);
      const behind = Number(branch.tracking?.behind || 0);
      if (!ahead && !behind) return '';
      const statusClass = branchStatusClass(branch, 'status');
      // The arrow and the count are separate spans so the direction can be marked without
      // recolouring the number, which is text and wants to stay readable.
      const part = (arrow, count) =>
        '<span class="track-part">' +
          '<span class="track-arrow">' + arrow + '</span>' +
          '<span class="track-count">' + count + '</span>' +
        '</span>';
      return '<span class="branch-status ' + statusClass + '">' +
        (behind ? part('↓', behind) : '') +
        (ahead ? part('↑', ahead) : '') +
      '</span>';
    }

    function renderBranchContextMenu() {
      return '<div id="branchContextMenu" class="context-menu" hidden></div>';
    }

    function renderCommitContextMenu() {
      return '<div id="commitContextMenu" class="context-menu" hidden></div>';
    }

    function branchContextItems(branch, branchType, isCurrent) {
      const selected = "'" + branch + "'";
      const current = currentBranch ? "'" + currentBranch + "'" : 'current branch';
      const noCurrent = !currentBranch;
      const isRemote = branchType === 'remote';
      return [
        { label: 'Checkout', action: 'checkout', disabled: isCurrent },
        { label: 'New Branch from ' + selected + '...', action: 'newBranchFrom' },
        { label: 'Checkout and Rebase onto ' + current, action: 'checkoutRebaseOnto', disabled: isCurrent || isRemote || noCurrent },
        { separator: true },
        { label: 'Compare with ' + current, action: 'compareWithCurrent', disabled: noCurrent || branch === currentBranch },
        { label: 'Show Diff with Working Tree', action: 'diffWithWorkingTree' },
        { separator: true },
        { label: 'Rebase ' + current + ' onto ' + selected, action: 'rebaseCurrentOnto', disabled: noCurrent || branch === currentBranch },
        { label: 'Merge ' + selected + ' into ' + current, action: 'mergeIntoCurrent', disabled: noCurrent || branch === currentBranch },
        { separator: true },
        { label: 'Update', action: 'update' },
        { label: 'Push...', action: 'push', disabled: isRemote },
        { separator: true },
        { label: 'Rename...', action: 'rename', disabled: isRemote },
        { label: 'Delete', action: 'delete', disabled: isCurrent }
      ];
    }

    function commitContextItems(hashes) {
      const current = currentBranch || 'current branch';
      const multi = hashes.length > 1;
      return [
        { label: multi ? 'Copy Revision Numbers' : 'Copy Revision Number', action: 'copyRevisionNumber', icon: copyIcon() },
        { label: 'Create Patch...', action: 'createPatch', icon: fileIcon() },
        { label: 'Cherry-Pick', action: 'cherryPick', icon: pickIcon() },
        { separator: true },
        { label: 'Checkout Revision', action: 'checkoutRevision', disabled: multi },
        { label: 'Show Repository at Revision', action: 'showRepositoryAtRevision', disabled: multi },
        { label: 'Compare with Local', action: 'compareWithLocal', disabled: multi },
        { separator: true },
        { label: 'Reset Current Branch to Here...', action: 'resetCurrentBranchHere', icon: undoIcon(), disabled: multi },
        { label: multi ? 'Revert Commits' : 'Revert Commit', action: 'revertCommit' },
        { label: 'Undo Commit...', action: 'undoCommit', disabled: multi },
        { separator: true },
        { label: 'Edit Commit Message...', action: 'editCommitMessage', disabled: multi, shortcut: 'F2' },
        { label: 'Fixup...', action: 'fixup', disabled: multi },
        { label: 'Squash Into...', action: 'squashInto', disabled: multi },
        { label: multi ? 'Drop Commits' : 'Drop Commit', action: 'dropCommits' },
        { label: 'Squash Commits...', action: 'squashCommits', disabled: !multi },
        { label: 'Interactively Rebase from Here...', action: 'interactiveRebaseFromHere', disabled: multi },
        { label: 'Push All up to Here...', action: 'pushAllUpToHere', disabled: multi },
        { separator: true },
        { label: "Rebase '" + current + "' onto Selected Commit", action: 'rebaseCurrentOnto', disabled: multi },
        { label: 'New Branch...', action: 'newBranch', icon: branchIcon(), disabled: multi },
        { label: 'New Tag...', action: 'newTag', icon: tagIcon(), disabled: multi },
        { separator: true },
        { label: 'Go to Child Commit', action: 'goChild', clientAction: true, disabled: multi },
        { label: 'Go to Parent Commit', action: 'goParent', clientAction: true, disabled: multi }
      ];
    }

    const GRAPH_ROW_H = 24;
    // How far a link may reach before it is drawn as a pair of arrows instead of a routed lane.
    const GRAPH_LONG_LINK_ROWS = 4;
    const GRAPH_LANE_W = 12;
    const GRAPH_PAD = 10;
    const GRAPH_COLOR_COUNT = 8;

    // Assigns each commit to a swim lane from hash/parent relationships (the
    // same model VS Code's SCM graph and IntelliJ use), instead of re-parsing
    // "git log --graph" ASCII art. Colors stick to a lane for the lifetime of
    // its branch line.
    function computeGraphLayout(commits) {
      const visible = new Set(commits.map((commit) => commit.hash));
      const rowOf = new Map(commits.map((commit, index) => [commit.hash, index]));
      const lanes = []; // slot: { expected, colorIdx, branchedFrom? } | null
      const nodes = [];
      const edges = [];
      // A link whose ends are far apart holds a lane open across every row in between, and
      // filtering produces plenty of them - one link here reaches 163 rows. git's own graph
      // does not route those either. Marked at both ends with an arrow instead, which is what
      // frees the lanes; the pending map carries the incoming mark until its row is reached.
      // Only where a filter created them: unfiltered, every parent is on screen where history
      // put it, and that view stays exactly as it was.
      const longLinkRows = commits.some((commit) => commit.graphParents) ? GRAPH_LONG_LINK_ROWS : Infinity;
      const arrows = [];
      const pendingArrivals = new Map();
      let colorCounter = 0;
      let maxLanes = 1;

      commits.forEach((commit, row) => {
        let commitLane = -1;
        lanes.forEach((lane, index) => {
          if (commitLane < 0 && lane && lane.expected === commit.hash) {
            commitLane = index;
          }
        });

        let colorIdx;
        if (commitLane >= 0) {
          colorIdx = lanes[commitLane].colorIdx;
        } else {
          commitLane = lanes.findIndex((lane) => !lane);
          if (commitLane < 0) {
            commitLane = lanes.length;
            lanes.push(null);
          }
          colorIdx = colorCounter % GRAPH_COLOR_COUNT;
          colorCounter += 1;
        }

        // Edges for the boundary between the previous row and this one.
        if (row > 0) {
          lanes.forEach((lane, index) => {
            if (!lane) return;
            const to = lane.expected === commit.hash ? commitLane : index;
            const from = lane.branchedFrom !== undefined ? lane.branchedFrom : index;
            edges.push({ row: row - 1, from, to, colorIdx: lane.colorIdx });
            (lane.joins || []).forEach((joinFrom) => {
              edges.push({ row: row - 1, from: joinFrom, to, colorIdx: lane.colorIdx });
            });
            delete lane.branchedFrom;
            delete lane.joins;
          });
        }

        // Lanes that merged into this commit (beyond the one it continues) end here.
        lanes.forEach((lane, index) => {
          if (lane && lane.expected === commit.hash && index !== commitLane) {
            lanes[index] = null;
          }
        });

        (pendingArrivals.get(commit.hash) || []).forEach((colorIdx) => {
          arrows.push({ row, lane: commitLane, colorIdx, direction: 'in' });
        });
        pendingArrivals.delete(commit.hash);

        const reachable = (commit.graphParents || commit.parents).filter((parent) => visible.has(parent));
        const parents = [];
        reachable.forEach((parent) => {
          if (rowOf.get(parent) - row > longLinkRows) {
            arrows.push({ row, lane: commitLane, colorIdx, direction: 'out' });
            pendingArrivals.set(parent, (pendingArrivals.get(parent) || []).concat(colorIdx));
            return;
          }
          parents.push(parent);
        });
        if (!parents.length) {
          lanes[commitLane] = null;
        } else {
          lanes[commitLane] = { expected: parents[0], colorIdx };
          parents.slice(1).forEach((parent) => {
            const existing = lanes.findIndex((lane) => lane && lane.expected === parent);
            if (existing >= 0) {
              // The merge line joins a lane that already awaits this parent;
              // emit its edge at the next boundary so it follows that lane's path.
              lanes[existing].joins = (lanes[existing].joins || []).concat(commitLane);
              return;
            }
            let slot = lanes.findIndex((lane) => !lane);
            if (slot < 0) {
              slot = lanes.length;
              lanes.push(null);
            }
            lanes[slot] = { expected: parent, colorIdx: colorCounter % GRAPH_COLOR_COUNT, branchedFrom: commitLane };
            colorCounter += 1;
          });
        }

        while (lanes.length && !lanes[lanes.length - 1]) {
          lanes.pop();
        }
        maxLanes = Math.max(maxLanes, lanes.length, commitLane + 1);
        nodes.push({ lane: commitLane, colorIdx, merge: commit.parents.length > 1 });
      });

      return { nodes, edges, arrows, maxLanes };
    }

    function graphX(lane) {
      return GRAPH_PAD + lane * GRAPH_LANE_W;
    }

    function renderGraphSvg(commits, layout) {
      const width = Math.min(260, GRAPH_PAD * 2 + Math.max(0, layout.maxLanes - 1) * GRAPH_LANE_W + 8);
      const height = commits.length * GRAPH_ROW_H;
      const half = GRAPH_ROW_H / 2;
      const pieces = [];

      layout.edges.forEach((edge) => {
        const y1 = edge.row * GRAPH_ROW_H + half;
        const y2 = y1 + GRAPH_ROW_H;
        const x1 = graphX(edge.from);
        const x2 = graphX(edge.to);
        const cls = 'graph-edge ge-' + edge.colorIdx;
        if (x1 === x2) {
          pieces.push('<path class="' + cls + '" d="M' + x1 + ' ' + y1 + ' V' + y2 + '"/>');
        } else {
          const c1 = y1 + GRAPH_ROW_H * 0.5;
          const c2 = y2 - GRAPH_ROW_H * 0.5;
          pieces.push('<path class="' + cls + '" d="M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + c1 + ', ' + x2 + ' ' + c2 + ', ' + x2 + ' ' + y2 + '"/>');
        }
      });

      (layout.arrows || []).forEach((arrow) => {
        const cy = arrow.row * GRAPH_ROW_H + half;
        const x = graphX(arrow.lane);
        // Out hangs below its node, in sits above the node it arrives at; both point down, the
        // direction history runs on screen.
        const tip = arrow.direction === 'out' ? cy + 11 : cy - 5;
        const tail = arrow.direction === 'out' ? cy + 5 : cy - 11;
        pieces.push('<path class="graph-edge ge-' + arrow.colorIdx + '" d="M' + x + ' ' + tail + ' V' + (tip - 3) + '"/>');
        pieces.push('<path class="graph-arrow gd-' + arrow.colorIdx + '" d="M' + (x - 3) + ' ' + (tip - 4) + ' L' + (x + 3) + ' ' + (tip - 4) + ' L' + x + ' ' + tip + ' Z"/>');
      });

      layout.nodes.forEach((node, row) => {
        const cy = row * GRAPH_ROW_H + half;
        const cls = 'graph-dot gd-' + node.colorIdx + (node.merge ? ' merge' : '');
        pieces.push('<circle class="' + cls + '" cx="' + graphX(node.lane) + '" cy="' + cy + '" r="' + (node.merge ? 3 : 4) + '"/>');
      });

      return {
        width,
        html: '<div class="graph-layer"><svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" aria-hidden="true">' + pieces.join('') + '</svg></div>'
      };
    }

    function commitTooltip(commit) {
      const branches = Array.from(new Set(commit.branches || [])).sort((a, b) => a.localeCompare(b));
      const branchText = branches.length ? branches.join(', ') : 'No containing branch';
      return 'Branches: ' + branchText + '\n' +
        'Commit: ' + commit.shortHash + '\n' +
        'Author: ' + (commit.author || '-') + '\n' +
        'Date: ' + (formatDate(commit.date) || '-');
    }

    function commitBranchHint(commit) {
      const branch = pickCommitBranch(commit);
      if (!branch) return '';
      if ((commit.refs || []).map(refName).includes(branch)) return '';
      return '<span class="branch-hint" title="' + html(branch) + '">' +
        tagIcon() +
        '<span class="branch-hint-name">' + html(branch) + '</span>' +
      '</span>';
    }

    function pickCommitBranch(commit) {
      const branches = Array.from(new Set(commit.branches || []));
      if (!branches.length) return undefined;

      const refBranches = (commit.refs || [])
        .map(refName)
        .filter((name) => branches.includes(name));
      const preferred = [
        state.selectedBranch,
        currentBranch,
        ...refBranches,
        ...branches.filter((name) => branchesByName.get(name)?.type === 'local'),
        ...branches.filter((name) => branchesByName.get(name)?.type === 'remote'),
        ...branches
      ].filter(Boolean);

      return preferred.find((name, index) => preferred.indexOf(name) === index && branches.includes(name));
    }

	    function renderCommits(commits = state.commits) {
	      if (state.error) return { html: '<div class="error">' + html(state.error) + '</div>', graphWidth: 48 };
	      if (!commits.length) return { html: '<div class="empty">No commits found</div>', graphWidth: 48 };
	      const layout = computeGraphLayout(commits);
	      const graph = renderGraphSvg(commits, layout);
	      let rows = '';
	      commits.forEach((commit) => {
	        const active = selectedCommitHashes.has(commit.hash);
	        const isMerge = commit.parents.length > 1;
	        const offBranch = currentBranch && !(commit.branches || []).includes(currentBranch);
	        rows += '<div class="commit-row' + (isMerge ? ' is-merge' : '') + (active ? ' active' : '') + '" data-hash="' + html(commit.hash) + '"' + (offBranch ? ' data-off-branch="1"' : '') + ' title="' + html(commitTooltip(commit)) + '">' +
          '<div class="graph-cell"></div>' +
          '<div class="subject"><span class="subject-text">' + html(commit.subject) + '</span>' + refLabels(commit.refs) + commitBranchHint(commit) + '</div>' +
          '<div class="author">' + html(commit.author) + '</div>' +
          '<div class="date" data-date="' + html(commit.date) + '">' + html(formatDate(commit.date)) + '</div>' +
	        '</div>';
	      });
	      return { html: graph.html + rows, graphWidth: graph.width };
	    }

    function renderDetail() {
      if (state.branchDiff) return renderBranchDiff();
      const detail = state.detail;
      if (!detail) return '<div class="empty">Select a commit</div>';
      const files = renderFileTree(buildFileTree(detail.files));
      return '<div class="commit-card">' +
        '<div class="commit-title">' + html(detail.message.split('\n')[0] || detail.hash) + '</div>' +
        '<div class="kv">' +
          '<span>Hash</span><span>' + html(detail.hash) + '</span>' +
          '<span>Author</span><span>' + html(detail.author + ' <' + detail.authorEmail + '>') + '</span>' +
          '<span>Date</span><span>' + html(formatDetailDate(detail.authorDate)) + '</span>' +
          '<span>Refs</span><span>' + html(detail.refs.join(', ') || '-') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="file-list">' + (files || '<div class="empty">No changed files</div>') + '</div>';
    }

    function renderBranchDiff() {
      const diff = state.branchDiff;
      const files = renderFileTree(buildFileTree(diff.files), { mode: 'branchDiff', selectedFile: diff.selectedFile });
      return '<div class="diff-toolbar">' +
        '<div class="diff-title">Diff with Working Tree <span class="diff-count">' + html(diff.files.length + ' file' + (diff.files.length === 1 ? '' : 's')) + '</span></div>' +
        '<button class="mini-button" type="button" data-action="getDiffAll"' + (diff.files.length ? '' : ' disabled') + '>Get All</button>' +
        '<button class="mini-button" type="button" data-action="closeBranchDiff">Close</button>' +
      '</div>' +
      '<div class="file-list">' + (files || '<div class="empty">No changed files</div>') + '</div>';
    }

    function buildFileTree(files) {
      const root = { folders: new Map(), files: [] };
      files.forEach((file) => {
        const parts = file.path.split('/').filter(Boolean);
        let node = root;
        parts.slice(0, -1).forEach((part) => {
          if (!node.folders.has(part)) {
            node.folders.set(part, { name: part, folders: new Map(), files: [] });
          }
          node = node.folders.get(part);
        });
        node.files.push({ ...file, displayName: parts.at(-1) || file.path });
      });
      return root;
    }

    function renderFileTree(node, options = {}, depth = 0) {
      const folders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
      const files = node.files.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return folders.map((folder) => (
        '<div class="tree-row folder ' + treeLevel(depth) + '" data-file-folder data-tree="file" data-depth="' + depth + '">' +
          '<span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon folder-icon">' + folderIcon() + '</span><span class="tree-name">' + html(folder.name) + '</span>' +
        '</div>' + renderFileTree(folder, options, depth + 1)
      )).join('') + files.map((file) => {
        const key = file.status.charAt(0);
        const selected = options.selectedFile === file.path ? ' active' : '';
        const modeAttr = options.mode ? ' data-file-mode="' + html(options.mode) + '"' : '';
        const action = options.mode === 'branchDiff' ? '<button class="mini-button" type="button" data-get-file="' + html(file.path) + '">Get</button>' : '';
        return '<div class="tree-row file file-row ' + treeLevel(depth) + selected + '" data-file="' + html(file.path) + '"' + modeAttr + ' data-depth="' + depth + '">' +
          '<span class="status ' + html(key) + '">' + html(file.status) + '</span>' +
          '<span class="tree-name">' + html(file.previousPath ? file.previousPath + ' -> ' + file.displayName : file.displayName) + '</span>' + action +
        '</div>';
      }).join('');
    }

    function treeLevel(depth) {
      return 'tree-level-' + Math.min(depth, 10);
    }

    function svgIcon(inner, size) {
      const s = size || 16;
      return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    }

    function folderIcon() {
      return svgIcon('<path d="M1.75 12.75v-9h4.1l1.5 1.5h6.9v7.5z"/>');
    }

    function branchIcon() {
      return svgIcon('<circle cx="4.75" cy="3.75" r="1.6"/><circle cx="4.75" cy="12.25" r="1.6"/><circle cx="11.25" cy="5.75" r="1.6"/><path d="M4.75 5.45v5.2M11.25 7.45c0 2.3-2.5 2.8-4.8 3"/>');
    }

    function remoteIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.9 1.7 1.9 9.5 0 11.2M8 2.4c-1.9 1.7-1.9 9.5 0 11.2"/>');
    }

    function starIcon() {
      return svgIcon('<path fill="currentColor" stroke="none" d="M8 1.9l1.85 3.75 4.15.6-3 2.93.71 4.12L8 11.35l-3.71 1.95.71-4.12-3-2.93 4.15-.6z"/>');
    }

    function tagIcon() {
      return svgIcon('<path d="M2.75 2.75h4.9l5.6 5.6-4.9 4.9-5.6-5.6z"/><circle cx="5.9" cy="5.9" r="1.1" fill="currentColor" stroke="none"/>');
    }

    function targetIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/><path d="M8 1.2v2M8 12.8v2M1.2 8h2M12.8 8h2"/>');
    }

    function copyIcon() {
      return svgIcon('<rect x="5.25" y="5.25" width="8" height="8" rx="1"/><path d="M10.75 3.25h-7.5v7.5"/>', 14);
    }

    function fileIcon() {
      return svgIcon('<path d="M4.25 1.75h5l3 3v9.5h-8z"/><path d="M9.25 1.75v3h3"/>', 14);
    }

    function pickIcon() {
      return svgIcon('<circle cx="8" cy="8" r="5.6" stroke-dasharray="2.4 2.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>', 14);
    }

    function undoIcon() {
      return svgIcon('<path d="M3.25 3.75v3.5h3.5"/><path d="M3.6 7.25a5 5 0 1 0 1.3-3.3"/>', 14);
    }

	  function render() {
	    const commitsView = renderCommits(state.commits);
	    document.getElementById('root').innerHTML =
	      '<main class="app">' +
		        '<aside class="sidebar">' +
		          '<div class="toolbar"><input id="branchSearch" class="search" placeholder="Search branches"></div>' +
		          '<div id="branches" class="branch-list">' + renderBranches() + '</div>' +
		        '</aside>' +
		        '<div class="pane-resizer" data-resize-pane="sidebar" title="Resize branches"></div>' +
		        '<section class="commits">' +
		          renderCommitToolbar() +
		          '<div id="commits" class="commit-list">' + commitsView.html + '</div>' +
		        '</section>' +
		        '<div class="pane-resizer" data-resize-pane="detail" title="Resize details"></div>' +
	        '<aside class="detail">' + renderDetail() + '</aside>' +
        '</main>' +
        renderBranchContextMenu() +
        renderCommitContextMenu();
      // The webview CSP (style-src 'nonce-...') blocks style="" attributes in
      // generated HTML, so sizing vars must be applied through the CSSOM.
      const app = document.querySelector('.app');
      app.style.setProperty('--sidebar-width', paneSizes.sidebar + 'px');
      app.style.setProperty('--detail-width', paneSizes.detail + 'px');
      document.getElementById('commits').style.setProperty('--graph-col', commitsView.graphWidth + 'px');
      applyHighlightCurrentBranch();
      wire();
      restoreScrollPositions();
    }

	    function wire() {
	      document.querySelectorAll('[data-branch]').forEach((node) => {
	        node.addEventListener('click', () => {
	          document.querySelectorAll('[data-branch]').forEach((other) => other.classList.remove('active'));
	          node.classList.add('active');
	          state.selectedBranch = node.dataset.branch;
	          send({ type: 'selectBranch', branch: node.dataset.branch });
	        });
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
		        node.addEventListener('contextmenu', (event) => openBranchContextMenu(event, node));
	      });
	      wireCommitRows();
	      wireDetailPane();
	      document.querySelectorAll('[data-branch-folder]').forEach((node) => {
	        node.addEventListener('click', () => toggleFolder(node));
	      });
	      wirePaneResizers();
	      document.getElementById('branchSearch').addEventListener('input', (event) => filterBranches(event.target.value));
	      document.getElementById('goToHead')?.addEventListener('click', goToBranchHead);
	      wireCommitFilters();
		      document.addEventListener('click', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      document.addEventListener('keydown', (event) => {
		        if (event.key === 'Escape') {
		          closeBranchContextMenu();
		          closeCommitContextMenu();
		          closeFilterDropdowns();
		        }
		      });
		      window.addEventListener('blur', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      window.addEventListener('resize', () => {
		        closeBranchContextMenu();
		        closeCommitContextMenu();
		        closeFilterDropdowns();
		      });
		      document.querySelectorAll('.branch-list, .commit-list').forEach((node) => {
		        node.addEventListener('scroll', () => {
		          updateScrollState(node);
		          if (node.id === 'commits') loadMoreCommitsNearBottom(node);
		          closeBranchContextMenu();
		          closeCommitContextMenu();
		          closeFilterDropdowns();
		        });
		      });
	    }

	    function wireDetailPane() {
	      document.querySelectorAll('[data-file]').forEach((node) => {
	        node.addEventListener('click', () => {
	          document.querySelectorAll('[data-file]').forEach((n) => n.classList.remove('active'));
	          node.classList.add('active');
	          if (node.dataset.fileMode === 'branchDiff') {
	            send({ type: 'openBranchDiffFile', file: node.dataset.file });
	          } else {
	            send({ type: 'openDiff', file: node.dataset.file });
	          }
	        });
	      });
	      document.querySelectorAll('[data-get-file]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.preventDefault();
	          event.stopPropagation();
	          send({ type: 'getDiffFile', file: node.dataset.getFile });
	        });
	      });
	      document.querySelectorAll('[data-file-folder]').forEach((node) => {
	        node.addEventListener('click', () => toggleFolder(node));
	      });
	      document.querySelectorAll('.file-list').forEach((node) => {
	        node.addEventListener('scroll', () => {
	          updateScrollState(node);
	          closeBranchContextMenu();
	          closeCommitContextMenu();
	          closeFilterDropdowns();
	        });
	      });
	      wireActions();
	    }

	    function restoreScrollPositions() {
	      const branches = document.getElementById('branches');
	      const commits = document.getElementById('commits');
	      const files = document.querySelector('.file-list');
	      if (branches) branches.scrollTop = scrollTops.branches;
	      if (commits) commits.scrollTop = scrollTops.commits;
	      if (files) files.scrollTop = scrollTops.files;
	    }

	    function updateScrollState(node) {
	      if (node.id === 'branches') {
	        scrollTops.branches = node.scrollTop;
	      } else if (node.id === 'commits') {
	        scrollTops.commits = node.scrollTop;
	      } else if (node.classList.contains('file-list')) {
	        scrollTops.files = node.scrollTop;
	      }
	      persistViewState();
	    }

	    function wireCommitRows() {
		      document.querySelectorAll('[data-hash]').forEach((node) => {
		        node.addEventListener('click', (event) => selectCommitRow(node, event.shiftKey));
		        node.addEventListener('contextmenu', (event) => openCommitContextMenu(event, node));
		      });
		    }

		    function selectCommitRow(node, extendRange) {
		      const hash = node.dataset.hash;
		      if (!hash) return;

		      if (extendRange && lastSelectedCommitHash) {
		        selectCommitRange(lastSelectedCommitHash, hash);
		        lastSelectedCommitHash = hash;
		        updateCommitSelectionUi();
		        return;
		      }

		      selectedCommitHashes.clear();
		      selectedCommitHashes.add(hash);
		      lastSelectedCommitHash = hash;
		      updateCommitSelectionUi();
		      const commits = document.getElementById('commits');
		      if (commits) {
		        scrollTops.commits = commits.scrollTop;
		        persistViewState();
		      }
		      send({ type: 'selectCommit', hash });
		    }

		    function selectCommitRange(fromHash, toHash) {
		      const commits = state.commits;
		      const fromIndex = commits.findIndex((commit) => commit.hash === fromHash);
		      const toIndex = commits.findIndex((commit) => commit.hash === toHash);
		      if (fromIndex < 0 || toIndex < 0) {
		        selectedCommitHashes.clear();
		        selectedCommitHashes.add(toHash);
		        return;
		      }

		      selectedCommitHashes.clear();
		      const start = Math.min(fromIndex, toIndex);
		      const end = Math.max(fromIndex, toIndex);
		      commits.slice(start, end + 1).forEach((commit) => selectedCommitHashes.add(commit.hash));
		    }

		    function updateCommitSelectionUi() {
		      document.querySelectorAll('[data-hash]').forEach((node) => {
		        node.classList.toggle('active', selectedCommitHashes.has(node.dataset.hash));
		      });
		      persistViewState();
		    }

	    function wireActions() {
	      document.querySelectorAll('[data-action]').forEach((node) => {
		        node.addEventListener('click', () => {
		          const action = node.dataset.action;
		          if (action === 'getDiffAll') send({ type: 'getDiffAll' });
		          if (action === 'closeBranchDiff') send({ type: 'closeBranchDiff' });
		        });
	      });
	    }

	    function loadMoreCommitsNearBottom(node) {
	      if (loadingMoreCommits || !state.hasMoreCommits) return;
	      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
	      if (distanceFromBottom > 240) return;
	      loadingMoreCommits = true;
	      updateScrollState(node);
	      send({ type: 'loadMoreCommits' });
	    }

	    function wirePaneResizers() {
	      document.querySelectorAll('[data-resize-pane]').forEach((handle) => {
	        handle.addEventListener('mousedown', (event) => startPaneResize(event, handle));
	      });
	    }

	    function startPaneResize(event, handle) {
	      event.preventDefault();
	      const pane = handle.dataset.resizePane;
	      const app = document.querySelector('.app');
	      const startX = event.clientX;
	      const startSize = pane === 'sidebar' ? paneSizes.sidebar : paneSizes.detail;
	      const minSize = pane === 'sidebar' ? 180 : 280;
	      const maxSize = pane === 'sidebar' ? 520 : 720;
	      handle.classList.add('dragging');
	      document.body.classList.add('resizing-pane');

	      const onMove = (moveEvent) => {
	        const delta = moveEvent.clientX - startX;
	        const nextSize = pane === 'sidebar'
	          ? clamp(startSize + delta, minSize, maxSize)
	          : clamp(startSize - delta, minSize, maxSize);
	        paneSizes[pane] = nextSize;
	        app.style.setProperty(pane === 'sidebar' ? '--sidebar-width' : '--detail-width', nextSize + 'px');
	        // Persist as we drag: mouseup can land outside the webview and never fire.
	        persistViewState();
	      };

	      const onUp = () => {
	        handle.classList.remove('dragging');
	        document.body.classList.remove('resizing-pane');
	        persistViewState();
	        window.removeEventListener('mousemove', onMove);
	        window.removeEventListener('mouseup', onUp);
	      };

	      window.addEventListener('mousemove', onMove);
	      window.addEventListener('mouseup', onUp);
	    }

	    function clamp(value, min, max) {
	      return Math.min(max, Math.max(min, value));
	    }

	    function wireCommitFilters() {
	      const search = document.getElementById('commitSearch');
	      if (search) {
	        search.value = commitFilters.query;
	        search.addEventListener('input', (event) => {
	          commitFilters.query = event.target.value;
	          persistViewState();
	          updateCommitSearchClear();
	          sendCommitFiltersDebounced();
	        });
	      }

	      const searchClear = document.getElementById('commitSearchClear');
	      if (searchClear) {
	        updateCommitSearchClear();
	        searchClear.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters.query = '';
	          if (search) search.value = '';
	          persistViewState();
	          updateCommitSearchClear();
	          sendCommitFilters();
	        });
	      }

	      document.querySelectorAll('[data-filter-flag]').forEach((node) => {
	        const key = node.dataset.filterFlag;
	        node.classList.toggle('active', Boolean(commitFilters[key]));
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          commitFilters[key] = !commitFilters[key];
	          persistViewState();
	          node.classList.toggle('active', Boolean(commitFilters[key]));
	          sendCommitFilters();
	        });
	      });

	      document.querySelectorAll('[data-filter-toggle]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.stopPropagation();
	          const clear = event.target.closest('[data-filter-clear]');
	          if (clear) {
	            event.preventDefault();
	            clearCommitFilter(clear.dataset.filterClear);
	            return;
	          }
	          const dropdown = node.closest('[data-filter-dropdown]');
	          const wasOpen = dropdown.classList.contains('open');
	          closeFilterDropdowns();
	          dropdown.classList.toggle('open', !wasOpen);
	          reportOverlayState();
	        });
	      });

	      document.querySelectorAll('[data-filter-dropdown]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          const clear = event.target.closest('[data-filter-clear]');
	          if (clear) {
	            event.preventDefault();
	            event.stopPropagation();
	            clearCommitFilter(clear.dataset.filterClear);
	            return;
	          }
	          event.stopPropagation();
	        });
	      });

	      document.querySelectorAll('[data-filter-clear]').forEach((node) => {
	        node.addEventListener('click', (event) => {
	          event.preventDefault();
	          event.stopPropagation();
	          clearCommitFilter(node.dataset.filterClear);
	        });
	      });

	      document.querySelectorAll('[data-filter-menu-search]').forEach((node) => {
	        node.addEventListener('input', () => filterDropdownOptions(node));
	        node.addEventListener('keydown', (event) => {
	          if (event.key === 'Escape') {
	            closeFilterDropdowns();
	          }
	        });
	      });

	      document.querySelectorAll('[data-view-option]').forEach((node) => {
	        node.addEventListener('click', (event) => event.stopPropagation());
	        node.addEventListener('change', () => {
	          const key = node.dataset.viewOption;
	          viewOptions[key] = node.checked;
	          persistViewState();
	          // Highlighting needs no git, so it lands immediately. Hiding merges changes what
	          // the log is asked for, so it goes back to the extension like any other filter.
	          if (key === 'noMerges') {
	            sendCommitFilters();
	          } else {
	            applyHighlightCurrentBranch();
	          }
	          const button = node.closest('[data-filter-dropdown]')?.querySelector('.filter-dropdown-button');
	          if (button) button.classList.toggle('active', viewOptions.highlightCurrentBranch || viewOptions.noMerges);
	        });
	      });

	      document.querySelectorAll('[data-filter-option]').forEach((node) => {
	        node.addEventListener('click', (event) => event.stopPropagation());
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
	      });
	    }

	    function applyHighlightCurrentBranch() {
	      const list = document.getElementById('commits');
	      if (list) list.classList.toggle('highlight-current', Boolean(currentBranch) && viewOptions.highlightCurrentBranch);
	    }

	    function closeFilterDropdowns() {
	      document.querySelectorAll('[data-filter-dropdown]').forEach((node) => node.classList.remove('open'));
	      reportOverlayState();
	    }

	    function filterDropdownOptions(input) {
	      const menu = input.closest('.filter-menu');
	      const query = input.value.trim().toLowerCase();
	      menu.querySelectorAll('[data-filter-option-row]').forEach((row) => {
	        row.style.display = row.dataset.filterOptionRow.includes(query) ? '' : 'none';
	      });
	    }

	    function updateCommitSearchClear() {
	      const button = document.getElementById('commitSearchClear');
	      if (button) {
	        button.hidden = !commitFilters.query;
	      }
	    }

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

	    function updateCommitFilterIndicators() {
	      document.querySelectorAll('[data-filter-dropdown]').forEach((dropdown) => {
	        const key = dropdown.dataset.filterDropdown;
	        // The View menu shares this shell but holds booleans, not a set of chosen values, so
	        // it has no count to show and reading .size off it would throw here.
	        const selected = commitFilters[key];
	        if (!selected) {
	          return;
	        }
	        const button = dropdown.querySelector('[data-filter-toggle]');
	        const label = key === 'branches' ? 'Branch' : 'User';
	        if (button) {
	          button.classList.toggle('active', commitFilters[key].size > 0);
	          button.innerHTML = filterButtonLabel(label, commitFilters[key].size);
	        }
	      });
	    }

	    function openBranchContextMenu(event, branchNode) {
	      event.preventDefault();
	      event.stopPropagation();
	      closeCommitContextMenu();
	      document.querySelectorAll('[data-branch]').forEach((node) => node.classList.remove('active'));
	      branchNode.classList.add('active');

      const menu = document.getElementById('branchContextMenu');
      const branch = branchNode.dataset.branch;
      const branchType = branchNode.dataset.branchType;
      const isCurrent = branchNode.dataset.branchCurrent === 'true';
      menu.innerHTML = branchContextItems(branch, branchType, isCurrent).map((item) => {
        if (item.separator) return '<div class="context-menu-separator" role="separator"></div>';
        return '<button class="context-menu-item no-icon" type="button" data-branch-action="' + html(item.action) + '" ' + (item.disabled ? 'disabled' : '') + ' title="' + html(item.label) + '">' +
          '<span class="context-menu-label">' + html(item.label) + '</span>' +
        '</button>';
      }).join('');

      menu.querySelectorAll('[data-branch-action]').forEach((item) => {
        item.addEventListener('click', (clickEvent) => {
          clickEvent.stopPropagation();
          const action = item.dataset.branchAction;
          closeBranchContextMenu();
          send({ type: 'branchAction', action, branch, branchType });
        });
      });

      menu.hidden = false;
	      positionContextMenu(menu, event.clientX, event.clientY);
	      reportOverlayState();
	    }

		    function openCommitContextMenu(event, commitNode) {
		      event.preventDefault();
		      event.stopPropagation();
		      closeBranchContextMenu();
		      const clickedHash = commitNode.dataset.hash;
		      if (!selectedCommitHashes.has(clickedHash)) {
		        selectedCommitHashes.clear();
		        selectedCommitHashes.add(clickedHash);
		        lastSelectedCommitHash = clickedHash;
		        updateCommitSelectionUi();
		      }

		      const menu = document.getElementById('commitContextMenu');
		      const hashes = selectedHashesInView();
		      const hash = hashes[0];
		      menu.innerHTML = commitContextItems(hashes).map((item) => {
		        if (item.separator) return '<div class="context-menu-separator" role="separator"></div>';
		        return '<button class="context-menu-item" type="button" data-commit-action="' + html(item.action) + '" ' + (item.disabled ? 'disabled' : '') + ' title="' + html(item.label) + '">' +
	          '<span class="context-menu-icon">' + (item.icon || '') + '</span>' +
	          '<span class="context-menu-label">' + html(item.label) + '</span>' +
	          '<span class="context-menu-shortcut">' + html(item.shortcut || '') + '</span>' +
	        '</button>';
	      }).join('');

	      menu.querySelectorAll('[data-commit-action]').forEach((item) => {
	        item.addEventListener('click', (clickEvent) => {
	          clickEvent.stopPropagation();
	          const action = item.dataset.commitAction;
	          closeCommitContextMenu();
	          if (action === 'goParent') {
	            selectRelatedCommit(hash, 'parent');
	            return;
	          }
	          if (action === 'goChild') {
	            selectRelatedCommit(hash, 'child');
	            return;
		          }
		          send({ type: 'commitAction', action, hash, hashes });
		        });
		      });

	      menu.hidden = false;
		      positionContextMenu(menu, event.clientX, event.clientY);
		      reportOverlayState();
		    }

		    function selectedHashesInView() {
		      const visible = state.commits.map((commit) => commit.hash);
		      return visible.filter((hash) => selectedCommitHashes.has(hash));
		    }

	    function selectRelatedCommit(hash, direction) {
	      const commits = state.commits;
	      const current = commits.find((commit) => commit.hash === hash);
	      if (!current) return;
	      const target = direction === 'parent'
	        ? commits.find((commit) => current.parents.includes(commit.hash))
	        : commits.find((commit) => commit.parents.includes(hash));
	      if (target) {
	        send({ type: 'selectCommit', hash: target.hash });
	      }
	    }

    function positionContextMenu(menu, x, y) {
      menu.style.left = '0px';
      menu.style.top = '0px';
      const rect = menu.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - rect.width - 8);
      const top = Math.min(y, window.innerHeight - rect.height - 8);
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
    }

	    function closeBranchContextMenu() {
	      const menu = document.getElementById('branchContextMenu');
	      if (menu) {
	        menu.hidden = true;
	        menu.innerHTML = '';
	      }
	      reportOverlayState();
	    }

	    function closeCommitContextMenu() {
	      const menu = document.getElementById('commitContextMenu');
	      if (menu) {
	        menu.hidden = true;
	        menu.innerHTML = '';
	      }
	      reportOverlayState();
	    }

	    // A background refresh replaces the whole document, so the extension holds it back
	    // while an overlay is open. Read the answer off the DOM instead of tracking a flag:
	    // closing one menu to open another would otherwise leave the flag stale.
	    function reportOverlayState() {
	      const menuOpen = ['branchContextMenu', 'commitContextMenu'].some((id) => {
	        const node = document.getElementById(id);
	        return node && !node.hidden;
	      });
	      const open = menuOpen || Boolean(document.querySelector('[data-filter-dropdown].open'));
	      if (open === lastReportedOverlayOpen) return;
	      lastReportedOverlayOpen = open;
	      send({ type: 'overlayState', open });
	    }

    function toggleFolder(folder) {
      const depth = Number(folder.dataset.depth || '0');
      const collapsed = folder.dataset.collapsed !== 'true';
      folder.dataset.collapsed = String(collapsed);

      let row = folder.nextElementSibling;
      while (row && Number(row.dataset.depth || '0') > depth) {
        row.style.display = collapsed ? 'none' : '';
        row = row.nextElementSibling;
      }
    }

    function filterBranches(query) {
      const normalized = query.trim().toLowerCase();
      const branchRows = Array.from(document.querySelectorAll('[data-branch]'));
      branchRows.forEach((node) => {
        // The row only renders the last path segment, so match the full name from the
        // dataset instead - otherwise searching a folder prefix never hits anything.
        const name = (node.dataset.branch || node.textContent).toLowerCase();
        node.style.display = name.includes(normalized) ? '' : 'none';
      });

      const folderRows = Array.from(document.querySelectorAll('[data-branch-folder]')).reverse();
      folderRows.forEach((folder) => {
        if (!normalized) {
          folder.style.display = '';
          return;
        }

        const depth = Number(folder.dataset.depth || '0');
        let hasVisibleChild = false;
        let row = folder.nextElementSibling;
        while (row && Number(row.dataset.depth || '0') > depth) {
          if (row.matches('[data-branch]') && row.style.display !== 'none') {
            hasVisibleChild = true;
            break;
          }
          row = row.nextElementSibling;
        }
        folder.style.display = hasVisibleChild ? '' : 'none';
      });
    }

    // Centres a commit row in the list. Returns false when that commit is not on the current
    // page, so the caller can fall back to whatever it does otherwise.
    function revealCommitRow(hash) {
      if (!hash) return false;
      const list = document.getElementById('commits');
      const row = list && list.querySelector('[data-hash="' + hash + '"]');
      if (!row) return false;
      list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2 + 12);
      scrollTops.commits = list.scrollTop;
      persistViewState();
      return true;
    }

    function goToBranchHead() {
      const branchName = state.selectedBranch || currentBranch;
      if (!branchName) return;
      const target = state.commits.find((commit) => (commit.refs || []).some((ref) => refName(ref) === branchName));
      if (!target) return;
      if (!state.commits.some((commit) => commit.hash === target.hash)) {
        clearAllCommitFilters();
      }
      const row = document.querySelector('[data-hash="' + target.hash + '"]');
      if (!row) return;
      revealCommitRow(target.hash);
      selectCommitRow(row, false);
    }

    function clearAllCommitFilters() {
      commitFilters.query = '';
      commitFilters.branches.clear();
      commitFilters.users.clear();
      const search = document.getElementById('commitSearch');
      if (search) search.value = '';
      document.querySelectorAll('[data-filter-option]').forEach((input) => {
        input.checked = false;
      });
      persistViewState();
      updateCommitSearchClear();
      updateCommitFilterIndicators();
      sendCommitFilters();
    }

    // A repository watcher tick triggers a full webview.html replace, which would wipe
    // whatever is being typed. Report focus so the extension can hold that refresh back.
    function isTextEntry(node) {
      return Boolean(node) && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
    }

    document.addEventListener('focusin', (event) => {
      if (isTextEntry(event.target)) send({ type: 'inputFocus', focused: true });
    });

    document.addEventListener('focusout', (event) => {
      if (isTextEntry(event.target)) send({ type: 'inputFocus', focused: false });
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'commitsUpdated') {
        state.commits = message.commits || [];
        state.hasMoreCommits = Boolean(message.hasMoreCommits);
        state.error = message.error;
        loadingMoreCommits = false;
        if (state.selectedCommit && message.selectedCommit === undefined) {
          state.selectedCommit = undefined;
          state.detail = undefined;
          selectedCommitHashes.clear();
          lastSelectedCommitHash = undefined;
          const pane = document.querySelector('.detail');
          if (pane) {
            pane.innerHTML = renderDetail();
            wireDetailPane();
          }
        }
        const list = document.getElementById('commits');
        if (list) {
          const commitsView = renderCommits(state.commits);
          list.style.setProperty('--graph-col', commitsView.graphWidth + 'px');
          list.innerHTML = commitsView.html;
          wireCommitRows();
          // Replacing innerHTML resets scrollTop to 0. loadMore appends further down an
          // existing list, so restore where the user was. A filter change is a new result set
          // where the old offset means nothing - but a selected commit is the one row the user
          // is tracking, so keep it on screen instead of jumping away from it.
          if (message.reason === 'loadMore') {
            list.scrollTop = scrollTops.commits;
          } else if (!revealCommitRow(state.selectedCommit)) {
            list.scrollTop = 0;
            scrollTops.commits = 0;
            persistViewState();
          }
        }
        return;
      }
      if (message.type === 'commitDetail' && message.detail) {
        state.detail = message.detail;
        state.branchDiff = null;
        state.selectedCommit = message.detail.hash;
        selectedCommitHashes.clear();
        selectedCommitHashes.add(message.detail.hash);
        lastSelectedCommitHash = message.detail.hash;
        updateCommitSelectionUi();
        const row = document.querySelector('[data-hash="' + message.detail.hash + '"]');
        if (row) row.scrollIntoView({ block: 'nearest' });
        const pane = document.querySelector('.detail');
        if (pane) {
          pane.innerHTML = renderDetail();
          wireDetailPane();
        }
      }
    });

    render();
    startRelativeTimeTicker();
