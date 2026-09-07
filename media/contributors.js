(function () {
  const vscode = acquireVsCodeApi();
  const state = window.__gitrailContributors || { contributors: [] };
  const persisted = vscode.getState() || {};

  const WEEK = 7 * 24 * 60 * 60;
  // Monday 1970-01-05 00:00 UTC. Must equal FIRST_MONDAY in src/contributors/stats.ts.
  const FIRST_MONDAY = 4 * 24 * 60 * 60;
  const AVATAR_COLOURS = 8;

  const RANGES = [
    { key: '1m', label: '1 month', months: 1 },
    { key: '3m', label: '3 months', months: 3 },
    { key: '6m', label: '6 months', months: 6 },
    { key: '1y', label: '1 year', months: 12 },
    { key: 'all', label: 'All time', months: 0 }
  ];
  // index is the column in a WeekRow: [week, commits, additions, deletions].
  const METRICS = [
    { key: 'commits', label: 'Commits', index: 1, noun: ['commit', 'commits'] },
    { key: 'additions', label: 'Additions', index: 2, noun: ['addition', 'additions'] },
    { key: 'deletions', label: 'Deletions', index: 3, noun: ['deletion', 'deletions'] }
  ];

  // Range and Metric survive a re-render through the webview's own state; the extension
  // never needs to know them.
  const options = {
    range: RANGES.some((range) => range.key === persisted.range) ? persisted.range : 'all',
    metric: METRICS.some((metric) => metric.key === persisted.metric) ? persisted.metric : 'commits'
  };

  // What the current render is showing; drawCharts() reads it after layout.
  let current = { entries: [], weeks: [], max: 0 };

  function html(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }
  function send(message) { vscode.postMessage(message); }
  function persist() { vscode.setState({ range: options.range, metric: options.metric }); }
  function metric() { return METRICS.find((item) => item.key === options.metric); }
  function range() { return RANGES.find((item) => item.key === options.range); }
  function noun(count) { return metric().noun[count === 1 ? 0 : 1]; }

  function weekStart(seconds) {
    return Math.floor((seconds - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY;
  }
  function currentWeek() { return weekStart(Math.floor(Date.now() / 1000)); }

  function rangeStartWeek() {
    const latest = currentWeek();
    const months = range().months;
    if (!months) {
      return state.firstWeek === undefined ? latest : Math.min(state.firstWeek, latest);
    }
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - months);
    return Math.min(weekStart(Math.floor(date.getTime() / 1000)), latest);
  }

  function weeksInRange() {
    const weeks = [];
    for (let week = rangeStartWeek(), last = currentWeek(); week <= last; week += WEEK) {
      weeks.push(week);
    }
    return weeks;
  }

  // Totals per contributor over the selected range. Anyone at zero for the chosen metric is
  // dropped, and the rest are ranked by it - ties fall back to commits, then name.
  function visibleContributors(startWeek) {
    const key = metric().key;
    return state.contributors.map((contributor) => {
      const byWeek = new Map();
      const totals = { commits: 0, additions: 0, deletions: 0 };
      for (const row of contributor.weeks) {
        if (row[0] < startWeek) {
          continue;
        }
        byWeek.set(row[0], row);
        totals.commits += row[1];
        totals.additions += row[2];
        totals.deletions += row[3];
      }
      return { contributor, totals, byWeek, value: totals[key] };
    })
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || b.totals.commits - a.totals.commits || a.contributor.name.localeCompare(b.contributor.name));
  }

  // The tallest week among everyone shown: every chart shares one y-axis so bars compare
  // across cards, as on GitHub.
  function sharedMax(entries, weeks) {
    const index = metric().index;
    let max = 0;
    for (const entry of entries) {
      for (const week of weeks) {
        const row = entry.byWeek.get(week);
        if (row && row[index] > max) {
          max = row[index];
        }
      }
    }
    return max;
  }

  function avatarClass(email, name) {
    let hash = 0;
    for (const char of email || name) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return 'avatar-' + (hash % AVATAR_COLOURS);
  }

  function refreshIcon() {
    return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M13.6 1.8v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // Same shell as the Log View's Branch / User / View dropdowns, holding one chosen value.
  function renderDropdown(kind, label, items, selectedKey) {
    const selected = items.find((item) => item.key === selectedKey);
    return '<div class="filter-dropdown" data-dropdown="' + kind + '">' +
      '<button class="filter-dropdown-button" type="button" data-dropdown-toggle="' + kind + '" title="' + html(label) + '">' +
        '<span class="filter-label">' + html(label) + ': ' + html(selected.label) + '</span>' +
        '<span class="filter-chevron"></span>' +
      '</button>' +
      '<div class="filter-menu">' +
        items.map((item) =>
          '<button class="filter-option' + (item.key === selectedKey ? ' selected' : '') + '" type="button" ' +
            'data-dropdown-option="' + kind + '" data-value="' + html(item.key) + '">' + html(item.label) + '</button>'
        ).join('') +
      '</div>' +
    '</div>';
  }

  function renderToolbar(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const people = entries.length + (entries.length === 1 ? ' contributor' : ' contributors');
    return '<div class="toolbar">' +
      renderDropdown('range', 'Range', RANGES, options.range) +
      renderDropdown('metric', 'Metric', METRICS, options.metric) +
      '<span class="summary">' + people + ' · ' + total.toLocaleString() + ' ' + html(noun(total)) + '</span>' +
      '<span class="toolbar-spacer"></span>' +
      '<button id="refresh" class="icon-button" type="button" title="Recompute from git">' + refreshIcon() + '</button>' +
      '<div class="progress' + (state.loading ? ' active' : '') + '"></div>' +
    '</div>';
  }

  function renderCard(entry, rank, index) {
    const person = entry.contributor;
    const initial = (person.name || '?').trim().charAt(0).toUpperCase() || '?';
    const commits = entry.totals.commits.toLocaleString() + (entry.totals.commits === 1 ? ' commit' : ' commits');
    return '<div class="contributor-card" data-index="' + index + '">' +
      '<div class="card-head">' +
        '<div class="avatar ' + avatarClass(person.email, person.name) + '">' + html(initial) + '</div>' +
        '<div class="identity">' +
          '<div class="name" title="' + html(person.email) + '">' + html(person.name) + '</div>' +
          '<div class="totals">' + commits +
            ' · <span class="add">' + entry.totals.additions.toLocaleString() + ' ++</span>' +
            ' · <span class="del">' + entry.totals.deletions.toLocaleString() + ' --</span>' +
          '</div>' +
        '</div>' +
        '<span class="rank">#' + rank + '</span>' +
      '</div>' +
      '<div class="chart-host"></div>' +
    '</div>';
  }

  function emptyMessage() {
    if (state.contributors.length) {
      return 'No commits in this range.';
    }
    return state.loading ? 'Computing contributors…' : 'No commits yet.';
  }

  function render() {
    const weeks = weeksInRange();
    const entries = visibleContributors(weeks[0]);
    current = { entries, weeks, max: sharedMax(entries, weeks) };

    let body = state.error ? '<div class="banner error">' + html(state.error) + '</div>' : '';
    if (entries.length) {
      body += '<div class="grid">' + entries.map((entry, index) => renderCard(entry, index + 1, index)).join('') + '</div>';
    } else {
      body += '<div class="empty">' + emptyMessage() + '</div>';
    }
    document.getElementById('root').innerHTML =
      '<div class="app">' + renderToolbar(entries) + '<div class="content">' + body + '</div></div>' +
      '<div id="tooltip" class="tooltip" hidden></div>';
    bindToolbar();
    drawCharts();
  }

  // Charts are drawn in Task 4; until then the hosts stay empty.
  function drawCharts() {}

  function bindToolbar() {
    document.querySelectorAll('[data-dropdown-toggle]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const dropdown = button.closest('.filter-dropdown');
        const wasOpen = dropdown.classList.contains('open');
        closeDropdowns();
        if (!wasOpen) {
          dropdown.classList.add('open');
        }
      });
    });
    document.querySelectorAll('[data-dropdown-option]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        options[button.dataset.dropdownOption] = button.dataset.value;
        persist();
        render();
      });
    });
    document.getElementById('refresh').addEventListener('click', () => send({ type: 'refresh' }));
  }

  function closeDropdowns() {
    document.querySelectorAll('.filter-dropdown.open').forEach((node) => node.classList.remove('open'));
  }

  document.addEventListener('click', closeDropdowns);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDropdowns();
    }
  });

  render();
})();
