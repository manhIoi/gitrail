// Unit tests for src/contributors/stats.ts, run against dist/ with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { contributorLogArgs, weekStart, parseContributorLog } = require('../dist/contributors/stats.js');

const RS = '\x1e';
const US = '\x1f';
const utc = (...parts) => Math.floor(Date.UTC(...parts) / 1000);

// One commit as `git log --numstat --format=%x1e%aN%x1f%aE%x1f%at` prints it: the format
// line, numstat rows, then a blank line.
function commit(name, email, time, files) {
  const rows = files.map(([added, deleted, file]) => `${added}\t${deleted}\t${file}`).join('\n');
  return `${RS}${name}${US}${email}${US}${time}\n${rows}${rows ? '\n' : ''}\n`;
}

test('contributorLogArgs asks for HEAD without merges, with numstat and unix author dates', () => {
  assert.deepEqual(contributorLogArgs(), [
    'log', 'HEAD', '--no-merges', '--numstat', '--date=unix', '--format=%x1e%aN%x1f%aE%x1f%at'
  ]);
});

test('weekStart snaps to Monday 00:00 UTC', () => {
  // 2026-09-07 is a Monday.
  const monday = utc(2026, 8, 7);
  assert.equal(weekStart(monday), monday);
  assert.equal(weekStart(utc(2026, 8, 7, 0, 0, 1)), monday);
  assert.equal(weekStart(utc(2026, 8, 13, 23, 59, 59)), monday);
  assert.equal(weekStart(utc(2026, 8, 6, 23, 59, 59)), utc(2026, 7, 31));
  assert.equal(weekStart(utc(2026, 8, 14)), utc(2026, 8, 14));
});

test('sums every numstat row of a commit', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[10, 2, 'a.ts'], [5, 1, 'b.ts']]));
  assert.equal(contributors.length, 1);
  assert.deepEqual(contributors[0], {
    name: 'Ann', email: 'ann@example.com', commits: 1, additions: 15, deletions: 3,
    weeks: [[utc(2026, 8, 7), 1, 15, 3]]
  });
});

test('skips binary rows for line counts but still counts the commit', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [['-', '-', 'logo.png'], [3, 0, 'a.ts']]));
  assert.equal(contributors[0].commits, 1);
  assert.equal(contributors[0].additions, 3);
  assert.equal(contributors[0].deletions, 0);
});

test('a commit with no file changes still counts', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), []));
  assert.equal(contributors[0].commits, 1);
  assert.deepEqual(contributors[0].weeks, [[utc(2026, 8, 7), 1, 0, 0]]);
});

test('merges emails that differ only in case, and names the group after the newest commit', () => {
  // git prints newest first; the second line here is older but carries the newer-looking name,
  // so the name must come from the timestamp, not from line order.
  const log =
    commit('A. Nguyen', 'Ann@Example.com', utc(2026, 8, 1), [[1, 0, 'a']]) +
    commit('Ann', 'ann@example.com', utc(2026, 7, 1), [[1, 0, 'a']]) +
    commit('Ann Nguyen', 'ann@example.com', utc(2026, 8, 9), [[1, 0, 'a']]);
  const { contributors } = parseContributorLog(log);
  assert.equal(contributors.length, 1);
  assert.equal(contributors[0].name, 'Ann Nguyen');
  assert.equal(contributors[0].commits, 3);
  assert.deepEqual(contributors[0].weeks.map((row) => row[0]), [utc(2026, 6, 27), utc(2026, 7, 31), utc(2026, 8, 7)]);
});

test('an empty email groups by name and does not merge with other empty emails', () => {
  const log =
    commit('claude', '', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('bot', '', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('claude', '', utc(2026, 8, 1), [[1, 0, 'a']]);
  const { contributors } = parseContributorLog(log);
  assert.deepEqual(contributors.map((c) => [c.name, c.commits]), [['claude', 2], ['bot', 1]]);
});

test('sorts by commits descending, then by name, and reports the earliest week', () => {
  const log =
    commit('Zed', 'zed@example.com', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('Bao', 'bao@example.com', utc(2026, 8, 8), [[1, 0, 'a']]) +
    commit('Bao', 'bao@example.com', utc(2026, 5, 3), [[1, 0, 'a']]) +
    commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[1, 0, 'a']]);
  const { contributors, firstWeek } = parseContributorLog(log);
  assert.deepEqual(contributors.map((c) => c.name), ['Bao', 'Ann', 'Zed']);
  assert.equal(firstWeek, utc(2026, 5, 1));
});

test('empty output yields no contributors and no first week', () => {
  assert.deepEqual(parseContributorLog(''), { contributors: [], firstWeek: undefined });
});

test('tolerates CRLF line endings', () => {
  const { contributors } = parseContributorLog(commit('Ann', 'ann@example.com', utc(2026, 8, 8), [[4, 4, 'a.ts']]).replace(/\n/g, '\r\n'));
  assert.equal(contributors[0].additions, 4);
});
