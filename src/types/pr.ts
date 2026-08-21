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
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  is_draft: boolean;
  /// The branch being merged, and the branch it merges into.
  head_ref: string;
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
  | { kind: "unknown"; detail: string };

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  size_bytes: number | null;
  safety: Safety;
  is_main: boolean;
}

export interface WorktreeRepo {
  name: string;
  path: string;
  worktrees: Worktree[];
}
