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

  const CHART_HEIGHT = 150;
  const MARGIN = { top: 8, right: 44, bottom: 22, left: 8 };
  const MIN_MONTH_LABEL_GAP = 48;

  // Round up to 1, 2 or 5 times a power of ten so the axis reads in round numbers.
  function niceCeil(value) {
    if (value <= 0) {
      return 1;
    }
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    for (const step of [1, 2, 5, 10]) {
      if (step * power >= value) {
        return step * power;
      }
    }
    return 10 * power;
  }

  function formatWeek(week) {
    return new Date(week * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function monthLabel(week) {
    const date = new Date(week * 1000);
    return date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) + " '" + String(date.getUTCFullYear()).slice(-2);
  }

  // Charts are sized from their host's width, so they are drawn after the cards are in the
  // DOM and again on resize. The y-axis top is shared by every card.
  function drawCharts() {
    const index = metric().index;
    const top = niceCeil(current.max);
    document.querySelectorAll('.contributor-card').forEach((card) => {
      const entry = current.entries[Number(card.dataset.index)];
      const host = card.querySelector('.chart-host');
      host.innerHTML = renderChart(entry, current.weeks, top, index, host.clientWidth || 320);
    });
  }

  function renderChart(entry, weeks, top, index, width) {
    const height = CHART_HEIGHT;
    const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right);
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    const slot = plotWidth / weeks.length;
    const barWidth = Math.max(1, slot - Math.min(3, slot * 0.2));
    const y = (value) => MARGIN.top + plotHeight - (value / top) * plotHeight;
    const ticks = top % 2 === 0 ? [0, top / 2, top] : [0, top];
    const round = (n) => Math.round(n * 10) / 10;

    let svg = '<svg class="chart" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" ' +
      'role="img" aria-label="Weekly ' + html(metric().label.toLowerCase()) + '">';
    for (const tick of ticks) {
      svg += '<line class="grid-line" x1="' + MARGIN.left + '" x2="' + round(MARGIN.left + plotWidth) + '" y1="' + round(y(tick)) + '" y2="' + round(y(tick)) + '"/>';
      svg += '<text class="tick" x="' + round(MARGIN.left + plotWidth + 6) + '" y="' + round(y(tick) + 4) + '">' + tick.toLocaleString() + '</text>';
    }

    let lastLabelX = -Infinity;
    let lastMonth = -1;
    weeks.forEach((week, i) => {
      const x = MARGIN.left + i * slot;
      const row = entry.byWeek.get(week);
      const value = row ? row[index] : 0;
      if (value > 0) {
        svg += '<rect class="bar" x="' + round(x + (slot - barWidth) / 2) + '" y="' + round(y(value)) + '" ' +
          'width="' + round(barWidth) + '" height="' + round(y(0) - y(value)) + '" data-week="' + week + '" data-value="' + value + '"/>';
      }
      // A label where the month changes, thinned so labels never overlap when weeks are dense.
      const month = new Date(week * 1000).getUTCMonth();
      if (month !== lastMonth) {
        if (i > 0 && x - lastLabelX >= MIN_MONTH_LABEL_GAP) {
          svg += '<text class="month" x="' + round(x) + '" y="' + (height - 6) + '" text-anchor="middle">' + html(monthLabel(week)) + '</text>';
          lastLabelX = x;
        }
        lastMonth = month;
      }
    });
    svg += '<line class="axis" x1="' + MARGIN.left + '" x2="' + round(MARGIN.left + plotWidth) + '" y1="' + round(y(0)) + '" y2="' + round(y(0)) + '"/>';
    return svg + '</svg>';
  }

  // One tooltip element, driven by delegation so re-rendering the cards never loses it.
  function barAt(target) {
    return target instanceof Element ? target.closest('rect.bar') : null;
  }
  function positionTooltip(tooltip, event) {
    const pad = 12;
    const box = tooltip.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + box.width > window.innerWidth - 4) {
      left = event.clientX - box.width - pad;
    }
    if (top + box.height > window.innerHeight - 4) {
      top = event.clientY - box.height - pad;
    }
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  document.addEventListener('mouseover', (event) => {
    const bar = barAt(event.target);
    if (!bar) {
      return;
    }
    const tooltip = document.getElementById('tooltip');
    const value = Number(bar.dataset.value);
    tooltip.textContent = 'Week of ' + formatWeek(Number(bar.dataset.week)) + ' · ' + value.toLocaleString() + ' ' + noun(value);
    tooltip.hidden = false;
    positionTooltip(tooltip, event);
  });
  document.addEventListener('mousemove', (event) => {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip || tooltip.hidden) {
      return;
    }
    if (!barAt(event.target)) {
      tooltip.hidden = true;
      return;
    }
    positionTooltip(tooltip, event);
  });
  document.addEventListener('mouseout', (event) => {
    if (barAt(event.target)) {
      const tooltip = document.getElementById('tooltip');
      if (tooltip) {
        tooltip.hidden = true;
      }
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 100);
  });

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
