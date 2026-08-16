export type Branch = {
  name: string;
  type: 'local' | 'remote';
  current: boolean;
  // Tip commit. Only used to key the branch-membership cache; absent if the ref could not be
  // read, which disables that cache rather than risking a stale answer.
  tip?: string;
  upstream?: string;
  tracking?: BranchTrackingStatus;
};
export type BranchTrackingStatus = {
  ahead: number;
  behind: number;
};
export type Commit = {
  hash: string;
  shortHash: string;
  parents: string[];
  // Nearest ancestors that survived the filter, so the graph stays joined up when a filter
  // hides the commits in between. Absent when nothing is filtered, where it would equal
  // parents. Never used for "is this a merge" or for Go to Parent - those want the real ones.
  graphParents?: string[];
  branches: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
};
export type ChangedFile = {
  status: string;
  path: string;
  previousPath?: string;
};
export type CommitDetail = {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  refs: string[];
  message: string;
  files: ChangedFile[];
};
export type BranchDiff = {
  branch: string;
  files: ChangedFile[];
  selectedFile?: string;
};
// What the Gitrail Diff view is showing. `ref` is the side files are taken from when you
// Get them. Without `against` the comparison is ref against the working tree; with it the
// two refs are compared directly, which is what Compare with <branch> needs.
export type DiffTarget = {
  ref: string;
  label: string;
  against?: string;
};
/**
 * Display options the panel starts with. These live in VS Code settings rather than in the
 * webview's own state: the webview persists its state on every scroll, so a value stored
 * there would always win and "default" would never mean anything.
 */
export type ViewOptions = {
  highlightCurrentBranch: boolean;
  highlightMyCommits: boolean;
};

export type ViewState = {
  root: string;
  selectedBranch?: string;
  selectedCommit?: string;
  branches: Branch[];
  commits: Commit[];
  hasMoreCommits: boolean;
  currentUser?: string;
  viewOptions: ViewOptions;
  detail?: CommitDetail;
  branchDiff?: BranchDiff;
  error?: string;
};
export type WebviewMessage = {
  type?: string;
  branch?: string;
  branchType?: Branch['type'];
  hash?: string;
  hashes?: string[];
  file?: string;
  action?: string;
  query?: string;
  matchCase?: boolean;
  regex?: boolean;
  users?: string[];
  branches?: string[];
  noMerges?: boolean;
  key?: string;
  value?: boolean;
  focused?: boolean;
  open?: boolean;
};
export const RESET_MODES = [
  { mode: 'soft', label: 'Soft', detail: "Files won't change, differences will be staged for commit." },
  { mode: 'mixed', label: 'Mixed', detail: "Files won't change, differences won't be staged." },
  { mode: 'hard', label: 'Hard', detail: 'Files will be reverted to the state of the selected commit. Any local changes will be lost.' },
  { mode: 'keep', label: 'Keep', detail: 'Files will be reverted to the state of the selected commit, but local changes will be kept intact.' }
] as const;
