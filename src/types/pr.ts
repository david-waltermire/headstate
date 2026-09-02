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
  /// Logins whose review is still outstanding.
  ///
  /// Empty is ORDINARY: repositories that assign reviewers through a
  /// bot return nothing here, and so does a solo account.
  requested_reviewers: string[];
  /// Assignees, used as a fallback when no reviewer was requested.
  assignees: string[];
  /// Who has already reviewed, and what they said.
  latest_reviews: { author: string; state: string }[];
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
  /// The repository that owned this worktree is gone, so nothing about
  /// the checkout can be classified -- there is no git to run in it.
  | { kind: "orphaned" }
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
/// One review conversation on a pull request.
export interface ReviewThread {
  /// The thread's node id, which the resolve and reply commands take --
  /// NOT the pull request's id.
  id: string;
  is_resolved: boolean;
  /// Whether the anchored line still exists after a force-push.
  ///
  /// Not the same question as resolved: an outdated thread can still hold
  /// an unanswered question, so the UI must never present "the code moved"
  /// as "this was dealt with".
  is_outdated: boolean;
  path: string;
  /// Null once the anchor is gone, which is when `is_outdated` is true.
  /// Render the path alone rather than `file.ts:null`.
  line: number | null;
  /// What THIS viewer may do, per thread. Separate permissions because
  /// GitHub grants them separately; a button shown without its permission
  /// fails with a 403 on click.
  viewer_can_reply: boolean;
  viewer_can_resolve: boolean;
  viewer_can_unresolve: boolean;
  comments: { author: string; created_at: string; body: string }[];
  /// The true total, which can exceed `comments.length` -- the query
  /// pages thread comments at 10.
  comment_count: number;
}

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
  /// Every reviewer's latest review state, keyed by login.
  ///
  /// A different question from `review`, which is the pull request's
  /// AGGREGATE decision: it reads "changes_requested" when someone else
  /// blocked it. Matching the viewer's login against this is the only
  /// way to answer "did MY approval land".
  latest_reviews: { author: string; state: string }[];
  /// Whether this pull request's base branch uses a merge queue.
  ///
  /// Chooses between Merge and Add to merge queue, so the user is not
  /// asked to pick between two buttons only one of which can work.
  merge_queue_enabled: boolean;
  /// Whether it is currently queued (and not rejected by the queue).
  in_merge_queue: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  unresolved_threads: number;
  comment_count: number;
  comments: { author: string; created_at: string; body: string }[];
  /// The review conversations -- inline threads anchored to a file and
  /// line. A DIFFERENT object from `comments` above, which are flat
  /// top-level comments: only threads can be resolved, so merging the two
  /// into one list would imply a Resolve button on comments that have no
  /// such concept.
  review_threads: ReviewThread[];
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

/// What the app already knows about a worktree's unmerged work.
///
/// Mirrors the Rust `Assessment`. Every field was already computed for
/// the Claude Code handoff and then discarded except the shell string.
export interface Assessment {
  path: string;
  branch: string;
  commits_ahead: number | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  /// Relative, as git prints it: "3 weeks ago".
  last_activity: string | null;
  /// Never pushed means these commits exist only on this machine.
  has_upstream: boolean;
  subjects: string[];
  subjects_elided: number;
}

/// What kind of build output a directory holds.
///
/// Mirrors `ArtifactKind` in Rust. The membership rule is that a
/// documented command rebuilds it -- which is what makes removal cost a
/// rebuild rather than work, and why this is a closed set rather than a
/// user-supplied pattern.
export type ArtifactKind =
  | "cargo_target"
  | "node_modules"
  | "terraform"
  | "dotnet_build"
  | "build_output";

/// One directory of regenerable build output.
export interface Artifact {
  /// Absolute path. Removal takes this, never a name matched by pattern.
  path: string;
  kind: ArtifactKind;
  /// The checkout it belongs to, for grouping.
  repo_path: string;
  /// Bytes on disk, or null until measured.
  ///
  /// Discovery and sizing differ by three orders of magnitude (measured:
  /// ~1.5s to find 178 directories, ~56s to size them), so the list
  /// renders before this is known. Null rather than 0: "not measured
  /// yet" and "empty" are different facts, and showing 0 B for the
  /// former is a lie the user would act on.
  size_bytes: number | null;
  /// Seconds since anything under it was written, or null if unknown.
  ///
  /// A running build does not make git dirty -- build output is
  /// gitignored -- so this is the only signal that a directory is in
  /// active use.
  modified_secs_ago: number | null;
}

/// The outcome of removing one artifact directory.
///
/// Per-directory rather than one verdict for the batch: a directory that
/// went active since the scan is refused while the rest succeed.
export interface ArtifactRemoval {
  path: string;
  /// Null on success. Shown verbatim -- it names WHY, and "could not
  /// remove" alone is not something a user can act on.
  error: string | null;
}

/// Why a Poetry virtualenv is reclaimable.
export type VenvState = "orphaned" | "stale" | "live";

/// One Poetry virtualenv.
export interface Venv {
  path: string;
  /// The project name Poetry encoded, e.g. `mls-delivery-service`.
  project: string;
  state: VenvState;
  /// The directory that produced it. Null for an orphan -- that IS the
  /// finding, not missing data.
  source: string | null;
  size_bytes: number | null;
  /// Seconds since the newest file INSIDE was written. Poetry touches a
  /// venv's root without writing inside, so its own mtime reports a
  /// year-old venv as days old.
  idle_secs: number | null;
}

export interface VenvRemoval {
  path: string;
  error: string | null;
}

/// One thing the automatic cleanup pass considered.
export interface LedgerEntry {
  at: string;
  /// `artifact` or `venv`.
  kind: string;
  target: string;
  /// An artifact's rebuild command, or a virtualenv's project.
  detail: string | null;
  bytes: number | null;
  /// `proposed`, `removed`, `refused`, or `skipped`.
  action: string;
  error: string | null;
}

/// Preferences for the automatic pass.
///
/// `mode` carries a `remove` variant so the stored shape does not change
/// in Phase 2, but this build refuses to store it: a setting that can be
/// turned on and does nothing is worse than one that does not exist.
export interface CleanupPrefs {
  enabled: boolean;
  mode: "preview" | "remove";
  artifacts: boolean;
  venvs: boolean;
  max_per_run: number;
}

export type Ecosystem =
  | "npm"
  | "yarn"
  | "poetry"
  | "uv"
  | "dotnet"
  | "cocoapods"
  | "swift";

/// How large a version jump is.
///
/// `unknown` is a real answer, not a fallback. Version schemes here are
/// not all semver -- .NET ships four parts, PEP 440 has epochs -- and a
/// version silently called major hides from a "minors only" filter while
/// one silently called minor is offered as safe.
export type Bump = "patch" | "minor" | "major" | "unknown";

export interface Outdated {
  name: string;
  current: string;
  latest: string;
  bump: Bump;
  ecosystem: Ecosystem;
  /// The manifest to edit, so an agent does not have to find it.
  manifest: string;
}

/// What one ecosystem reported for one repository.
///
/// `error` exists because "no updates" and "the check did not run" are
/// opposite answers, and rendering both as an empty list reports failure
/// as good news.
export interface EcosystemReport {
  ecosystem: Ecosystem;
  outdated: Outdated[];
  error: string | null;
}

export type UpdateFilter = "patch" | "minor" | "all";

/// One imported file in a CLAUDE.md tree.
export interface ImportNode {
  /// What the file wrote, verbatim.
  raw: string;
  /// Where it resolved to, when it did.
  path: string | null;
  bytes: number;
  tokens: number;
  /// Why this node is unusable, when it is. A broken or circular import
  /// is SHOWN rather than dropped -- omitting it makes the tree look
  /// complete when it is not.
  problem: string | null;
  children: ImportNode[];
}

/// One CLAUDE.md and the tree it pulls in.
export interface ClaudeFile {
  path: string;
  bytes: number;
  /// ESTIMATED tokens for this file alone. Characters divided by four,
  /// not a real tokeniser -- every label says so.
  tokens: number;
  /// Estimated tokens for this file plus everything it imports. The
  /// number that matters: a 2 KB file pulling in 40 KB of imports is the
  /// case this view exists to surface.
  total_tokens: number;
  imports: ImportNode[];
}

/// One project's worth of reports.
///
/// The unit the UI groups by. A repository can hold several -- a
/// frontend and a backend are separate manifests and often separate
/// ecosystems, so their updates are separate pieces of work.
export interface ProjectReport {
  /// Absolute path to the project directory.
  path: string;
  /// Relative to the repository root. Empty at the root itself.
  label: string;
  reports: EcosystemReport[];
}
