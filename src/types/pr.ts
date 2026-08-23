/// TypeScript mirrors of the Rust model in `src-tauri/src/github/model.rs`.
/// Field names and enum values are wire-format, not TS convention: serde
/// renames `CiState`/`MergeState` to lowercase and `ReviewState` to
/// snake_case, and every struct field is already snake_case. Do not
/// "clean up" the casing here -- it must match what `invoke()` actually
/// receives, byte for byte.

export type CiState = "success" | "failure" | "pending" | "none";
export type MergeState = "mergeable" | "conflicted" | "checking";
export type ReviewState = "approved" | "changes_requested" | "review_required" | "none";

export interface Label {
  name: string;
  color: string;
}

export interface PullRequest {
  /// GraphQL node ID, so a row can act without opening the detail view.
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  is_draft: boolean;
  /// The branch being merged, and the branch it merges into.
  head_ref: string;
  /// The head commit the row was rendered from, so an "update branch"
  /// click can tell GitHub which commit the user was looking at.
  head_oid: string;
  /// The head branch's Ref node id, for deleting it after merge. `null`
  /// once the branch is gone -- which is how the UI tells "already
  /// cleaned up" from "still there".
  head_ref_id: string | null;
  base_ref: string;
  created_at: string;
  updated_at: string;
  ci: CiState;
  merge: MergeState;
  /// GitHub's own merge-readiness summary.
  ///
  /// Richer than `merge`, which only distinguishes conflicts. `clean` is
  /// what makes a merge button honest: any other value means GitHub would
  /// reject or block the merge. Inlined rather than exported as a named
  /// type, since nothing imports the name.
  merge_status:
    | "clean"
    | "dirty"
    | "blocked"
    | "unstable"
    | "behind"
    | "draft"
    | "unknown";
  review: ReviewState;
  in_merge_queue: boolean;
  labels: Label[];
  comment_count: number;
  /// Review conversations still open on the current code. Resolved and
  /// outdated threads are excluded.
  unresolved_threads: number;
}

/// `merged_week`/`merged_month` are real. The other five derived fields
/// always come back zero from the Rust layer today -- Task 13 derives them
/// client-side from the PR list. Typed here so callers get the shape right;
/// do not rely on their values.
export interface Stats {
  merged_week: number;
  merged_month: number;
  in_merge_queue: number;
  needs_attention: number;
  awaiting_review: number;
  ready_to_queue: number;
  blocked_by_comments: number;
}

/// One day of PR activity. `date` is `YYYY-MM-DD` in UTC, matching the
/// GitHub search qualifiers the counts come from.
export interface HistoryPoint {
  date: string;
  opened: number;
  merged: number;
}

/// The daily series plus the period comparisons that drive the delta cards.
///
/// Every period window ENDS YESTERDAY: today is still accumulating, and
/// comparing a partial day against complete periods drags every delta
/// downward. `points` still includes today, because the chart's shape is
/// informative even when the last bar is short.
export interface History {
  points: HistoryPoint[];
  week_current: number;
  week_previous: number;
  opened_week_current: number;
  opened_week_previous: number;
  month_current: number;
  month_previous: number;
}

/// The period comparisons alone. Fetched separately from the daily series
/// so the delta cards can render while the chart is still loading.
export interface Periods {
  week_current: number;
  week_previous: number;
  opened_week_current: number;
  opened_week_previous: number;
  month_current: number;
  month_previous: number;
}

export interface RepoCount {
  repo: string;
  merged: number;
}

/// Aggregates over a SAMPLE of recently merged PRs, not a lifetime census
/// -- `sample_size` is how many were actually examined, and the UI labels
/// the figures with it. `cycle_time_hours` is sorted ascending so
/// `percentile()` can index it directly.
/// One merged PR, enough to name and open it.
export interface MergedPr {
  number: number;
  title: string;
  url: string;
  repo: string;
  cycle_time_hours: number;
  size: number;
}

export interface MergedDetail {
  cycle_time_hours: number[];
  /// additions+deletions per PR, sorted ascending for percentile lookup.
  pr_sizes: number[];
  additions: number;
  deletions: number;
  changed_files: number;
  review_count: number;
  comment_count: number;
  sample_size: number;
  repo_counts: RepoCount[];
  slowest: MergedPr[];
  largest: MergedPr[];
}

/// Median cycle time this week against last.
///
/// `sampled` is true when either window held more merges than GitHub
/// returns in one page (100), meaning the medians describe a sample of
/// that week rather than all of it.
export interface CycleTrend {
  current_hours: number;
  previous_hours: number;
  current_count: number;
  previous_count: number;
  sampled: boolean;
}

/// Why a worktree can or cannot be removed.
///
/// An enum rather than a boolean because the UI has to explain itself:
/// "3 uncommitted files" is actionable where a greyed-out button is not.
/// `never_pushed` is the dangerous one -- 52 of 295 worktrees on this
/// machine have no upstream, so their commits exist nowhere else.
export type Safety =
  | { kind: "safe" }
  | { kind: "main_checkout" }
  | { kind: "dirty"; detail: number }
  | { kind: "unpushed"; detail: number }
  | { kind: "never_pushed" }
  | { kind: "unmerged" }
  /// Listed, but not yet classified. Distinct from `unknown`, which
  /// means the check ran and could not decide.
  | { kind: "pending" }
  | { kind: "unknown"; detail: string };

/// How a checkout stands against its tracked upstream, as of the last
/// fetch. Never live -- the scan reads refs on disk and does not fetch.
export type Upstream =
  | { kind: "current" }
  | { kind: "ahead"; n: number }
  | { kind: "behind"; n: number }
  | { kind: "diverged"; n: [number, number] }
  | { kind: "untracked" }
  | { kind: "detached" }
  | { kind: "unknown"; n: string };

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  size_bytes: number | null;
  safety: Safety;
  is_main: boolean;
  /// `YYYY-MM-DD` when this branch landed in the default branch, when it
  /// can be determined. The date the work REACHED the default branch, not
  /// the branch tip's own commit date -- those diverge for a branch
  /// written weeks before it merged.
  merged_at: string | null;
  /// How this checkout stands against its upstream, for every row.
  upstream: Upstream | null;
  /// RFC 3339 timestamp of the branch tip's own commit. Not `merged_at`,
  /// which is when the work reached the default branch.
  last_commit: string | null;
}

export interface WorktreeRepo {
  /// `owner/repo` from the git REMOTE, not the directory name -- this
  /// app's own directory is `ghstat` while its repository is
  /// `pktstorm/headstate`. `null` when there is no remote to ask.
  identity: string | null;
  name: string;
  path: string;
  worktrees: Worktree[];
}

/// Everything the detail view renders.
///
/// Separate from `PullRequest`, which is a list row fetched 100 at a time
/// on a poll loop -- carrying a body and comments there would make every
/// tick haul data almost no row needs.
export interface PrDetail {
  /// GraphQL node ID. Every mutation takes this rather than a number, so
  /// a write can only follow a read of the thing being written.
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  is_draft: boolean;
  body: string;
  author: string;
  repo: string;
  head_ref: string;
  /// The head commit the row was rendered from, so an "update branch"
  /// click can tell GitHub which commit the user was looking at.
  head_oid: string;
  head_ref_id: string | null;
  base_ref: string;
  merge_status: string;
  review: string;
  additions: number;
  deletions: number;
  changed_files: number;
  unresolved_threads: number;
  comment_count: number;
  comments: { author: string; created_at: string; body: string }[];
  /// `state` is `success`, `failure`, `pending`, `skipped`, or a raw
  /// GitHub value when unmodelled -- never coerced to success. Inlined
  /// rather than exported types, since nothing imports the names.
  checks: {
    name: string;
    state: string;
    url: string;
    /// The Actions workflow run, for re-running failed jobs. Null for a
    /// plain commit status or a non-Actions check -- neither can be
    /// re-run, so the button is offered only where this exists.
    run_id: number | null;
  }[];
}

/// How an image's provenance was established. A recorded fact and a
/// resolved guess should not look identical in the UI.
type OriginSource = "build_history" | "tag_resolution";

interface DockerOrigin {
  repo_path: string;
  /// The build context, which for a worktree build IS the worktree.
  context: string | null;
  commit: string;
  subject: string;
  /// The branch landed, so nothing will ever want this image again.
  merged: boolean;
  source: OriginSource;
}

export interface DockerImage {
  id: string;
  repository: string;
  /// Every tag pointing at this ID -- `latest` and a SHA are one image.
  tags: string[];
  created: string;
  size_bytes: number;
  origin: DockerOrigin | null;
  /// `null` means we could not ask -- NOT "nothing is using it". An
  /// unknown answer renders as not-removable.
  in_use: boolean | null;
  superseded: boolean;
}

export interface DockerDiskUsage {
  images_bytes: number;
  images_reclaimable_bytes: number;
  build_cache_bytes: number;
  volumes_bytes: number;
  volumes_reclaimable_bytes: number;
}

/// Docker is frequently OFF, unlike git. "We could not ask" is not "the
/// answer is zero".
export type DockerState =
  | { kind: "running" }
  | { kind: "not_running" }
  | { kind: "permission_denied" }
  | { kind: "not_installed" }
  | { kind: "unknown"; detail: string };

export interface DanglingVolume {
  name: string;
  size_bytes: number;
}

export interface ImageRemovalOutcome {
  id: string;
  error: string | null;
}

export interface DockerBuild {
  reference: string;
  name: string;
  status: string;
  started: string;
  duration_secs: number;
  total_steps: number;
  cached_steps: number;
  /// Resolved on demand: `inspect` is a subprocess per build.
  context: string | null;
  revision: string | null;
}
