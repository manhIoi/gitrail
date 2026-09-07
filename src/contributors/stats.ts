import type { Contributor, WeekRow } from './types';

const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Monday 1970-01-05 00:00 UTC: 1970-01-01 was a Thursday. media/contributors.js declares the
// same constant, and the two must agree or the chart's columns miss the rows.
const FIRST_MONDAY = 4 * 24 * 60 * 60;

/** Arguments for the one git command the Contributors view runs. */
export function contributorLogArgs(): string[] {
  // %aN/%aE honour .mailmap; %x1e opens a commit and %x1f splits its fields, neither of which
  // can appear in a name or email. Merges are left out as GitHub does, and their numstat is
  // meaningless anyway.
  return ['log', 'HEAD', '--no-merges', '--numstat', '--date=unix', '--format=%x1e%aN%x1f%aE%x1f%at'];
}

/** Monday 00:00 UTC of the week containing the given Unix time, as Unix seconds. */
export function weekStart(unixSeconds: number): number {
  return Math.floor((unixSeconds - FIRST_MONDAY) / WEEK_SECONDS) * WEEK_SECONDS + FIRST_MONDAY;
}

export type ParsedContributorLog = {
  contributors: Contributor[];
  firstWeek?: number;
};

type Group = {
  name: string;
  email: string;
  latest: number;
  commits: number;
  additions: number;
  deletions: number;
  weeks: Map<number, WeekRow>;
};

/** Folds the stdout of `git <contributorLogArgs()>` into per-author, per-week totals. */
export function parseContributorLog(stdout: string): ParsedContributorLog {
  const groups = new Map<string, Group>();
  let current: { group: Group; week: WeekRow } | undefined;
  let firstWeek: number | undefined;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      continue;
    }

    if (line.charCodeAt(0) === 0x1e) {
      const [name = '', email = '', time = ''] = line.slice(1).split('\x1f');
      const authorTime = Number(time);
      if (!Number.isFinite(authorTime)) {
        current = undefined;
        continue;
      }
      // Emails are case-insensitive; a missing email falls back to the name, prefixed so a
      // name can never collide with somebody's address.
      const key = email ? 'e:' + email.toLowerCase() : 'n:' + name;
      let group = groups.get(key);
      if (!group) {
        group = { name, email, latest: authorTime, commits: 0, additions: 0, deletions: 0, weeks: new Map() };
        groups.set(key, group);
      } else if (authorTime > group.latest) {
        group.latest = authorTime;
        group.name = name;
      }
      const week = weekStart(authorTime);
      let row = group.weeks.get(week);
      if (!row) {
        row = [week, 0, 0, 0];
        group.weeks.set(week, row);
      }
      row[1] += 1;
      group.commits += 1;
      if (firstWeek === undefined || week < firstWeek) {
        firstWeek = week;
      }
      current = { group, week: row };
      continue;
    }

    if (!current) {
      continue;
    }
    // numstat: "<added>\t<deleted>\t<path>", with "-" for binary files.
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match || match[1] === '-' || match[2] === '-') {
      continue;
    }
    const added = Number(match[1]);
    const deleted = Number(match[2]);
    current.week[2] += added;
    current.week[3] += deleted;
    current.group.additions += added;
    current.group.deletions += deleted;
  }

  const contributors: Contributor[] = Array.from(groups.values())
    .map((group) => ({
      name: group.name,
      email: group.email,
      commits: group.commits,
      additions: group.additions,
      deletions: group.deletions,
      weeks: Array.from(group.weeks.values()).sort((a, b) => a[0] - b[0])
    }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));

  return { contributors, firstWeek };
}
