// One week of one author's activity: [Monday 00:00 UTC as Unix seconds, commits, additions, deletions].
// A tuple rather than an object because there is one per author per week and it is
// serialised into the webview on every render.
export type WeekRow = [week: number, commits: number, additions: number, deletions: number];

export type Contributor = {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  // Ascending by week; weeks with no commits are omitted.
  weeks: WeekRow[];
};

export type ContributorsState = {
  root: string;
  // HEAD hash the data was computed for; the provider recomputes only when this moves.
  head?: string;
  generatedAt: number;
  // Earliest week with a commit, so "All time" knows where its axis starts.
  firstWeek?: number;
  contributors: Contributor[];
  loading?: boolean;
  error?: string;
};

export type ContributorsMessage = {
  type?: string;
};
