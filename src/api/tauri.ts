/// Typed wrappers around the Tauri command surface in
/// `src-tauri/src/commands.rs`. Every command returns `Result<T, String>` on
/// the Rust side, which Tauri surfaces as a *rejected* promise (not a
/// resolved `Err` value) when the Rust side returns `Err`. Callers that need
/// to distinguish "not authenticated" from a network failure should inspect
/// the rejection message; `AuthGate` covers the common case by gating
/// render on `get_auth_state` before anything else calls in.

import { invoke } from "@tauri-apps/api/core";
import type {
  CycleTrend,
  DanglingVolume,
  DockerBuild,
  DockerDiskUsage,
  DockerImage,
  DockerState,
  History,
  ImageRemovalOutcome,
  MergedDetail,
  Periods,
  PrDetail,
  PullRequest,
  Stats,
  Worktree,
  WorktreeRepo,
} from "../types/pr";

export interface AuthState {
  ok: boolean;
  message: string;
}

/// The cached snapshot. Never talks to GitHub. Returns `[]` both when
/// nothing has ever been polled and when auth failed at startup -- callers
/// must consult `getAuthState` to tell those apart.
export const getCached = () => invoke<PullRequest[]>("get_cached");

/// A user-initiated, out-of-band fetch. Does not persist to SQLite and does
/// not affect the poll loop's cadence.
export const refreshNow = () => invoke<PullRequest[]>("refresh_now");

/// `Stats.merged_week`/`merged_month` are real; the other five fields
/// always come back zero today. Does not persist to SQLite.
export const getStats = () => invoke<Stats>("get_stats");

/// Repos and their worktrees, WITHOUT safety classification.
///
/// ~800ms for 37 repos and 295 worktrees; safe to block a view on.
export const listWorktrees = () => invoke<WorktreeRepo[]>("list_worktrees");

/// Classify one repo's worktrees. Four git calls each, ~16s across all
/// 295 -- so this is per repo, filling in as results arrive.
export const classifyWorktrees = (repoPath: string) =>
  invoke<Worktree[]>("classify_worktrees", { repoPath });

/// Apply an action to a pull request.
///
/// Rejects with GitHub's own message on refusal -- "base branch was
/// modified" is display-ready and more useful than a substitute.
export const actOnPr = (
  id: string,
  repo: string,
  number: number,
  action: PrActionName,
) => invoke<void>("act_on_pr", { id, repo, number, action });

/// One worktree's outcome in a bulk removal. `error` is null on success.
export interface RemovalOutcome {
  path: string;
  error: string | null;
}

/// Remove several worktrees, each safety-checked independently at delete
/// time. Resolves with an outcome per worktree rather than throwing on
/// the first refusal: partial failure is the normal case.
export const removeWorktrees = (repoPath: string, worktreePaths: string[]) =>
  invoke<RemovalOutcome[]>("remove_worktrees", { repoPath, worktreePaths });

/// The newest published release, or null when this build is current.
///
/// Distribution is dmg/exe/deb/AppImage, so no package manager carries
/// updates: a user on a version with a launch-blocking bug otherwise has
/// no way to learn a fix exists.
export const latestRelease = () => invoke<string | null>("latest_release");

/// --- Docker -------------------------------------------------------

export const dockerState = () => invoke<DockerState>("docker_state");
export const dockerBuilds = () => invoke<DockerBuild[]>("docker_builds");
export const dockerBuildDetail = (reference: string) =>
  invoke<DockerBuild>("docker_build_detail", { reference });
export const dockerImages = () => invoke<DockerImage[]>("docker_images");
export const dockerDiskUsage = () => invoke<DockerDiskUsage>("docker_disk_usage");
export const dockerRemoveImages = (ids: string[]) =>
  invoke<ImageRemovalOutcome[]>("docker_remove_images", { ids });
export const dockerDanglingVolumes = () => invoke<DanglingVolume[]>("docker_dangling_volumes");
export const dockerRemoveVolume = (name: string) =>
  invoke<void>("docker_remove_volume", { name });
/// Returns bytes actually freed, read from the command's own output
/// rather than echoed from an estimate.
export const dockerPruneCache = (until?: string) =>
  invoke<number>("docker_prune_cache", { until });
export const dockerRunningContainers = () => invoke<string[]>("docker_running_containers");
export const dockerRestart = () => invoke<void>("docker_restart");
export const dockerStart = () => invoke<void>("docker_start");

/// Worktrees handed to Claude Code and still at the head they were
/// assessed at. A branch that has moved since is dropped: the assessment
/// described a different state.
export const assessedWorktrees = () => invoke<string[]>("assessed_worktrees");

/// Remove a worktree the safety gate refuses. Reached only from a
/// confirmation opened after reading an assessment of that worktree.
export const removeWorktreeForced = (repoPath: string, worktreePath: string) =>
  invoke<void>("remove_worktree_forced", { repoPath, worktreePath });

/// The clipboard payload for Claudify, plus whether Claude Code was
/// found. `claude_installed` is advisory: the command is returned either
/// way, since a user may paste it on another machine.
export interface ClaudifyCommand {
  command: string;
  claude_installed: boolean;
}

/// The shell command that hands a worktree to Claude Code.
///
/// Text for the clipboard, not a spawn. Spawning a terminal is not
/// portable -- macOS has no default-terminal concept, and on Linux
/// `gio open` on a shell script opens an editor -- and the clipboard
/// lands the user in their own shell, where `claude` resolves even
/// though a GUI app's PATH does not include it.
export const claudifyCommand = (repoPath: string, worktreePath: string, branch: string) =>
  invoke<ClaudifyCommand>("claudify_command", { repoPath, worktreePath, branch });

/// Merge a pull request when its checks pass, or cancel that.
///
/// Takes the head OID the row was rendered from: auto-merge fires later
/// and unattended, so without the guard a push after enabling would
/// merge a commit the user never saw.
export const setAutoMerge = (
  id: string,
  repo: string,
  number: number,
  expectedHead: string,
  enable: boolean,
) => invoke<void>("set_auto_merge", { id, repo, number, expectedHead, enable });

/// Merge the base branch into a pull request's head -- GitHub's "Update
/// branch" button.
///
/// Separate from `actOnPr` because it needs `expectedHead`: GitHub
/// refuses if the branch moved since the row was rendered, so a stale
/// click reports an error rather than updating a commit the user never
/// saw. Pass the `head_oid` from the same row that showed the button.
export const updatePrBranch = (
  id: string,
  repo: string,
  number: number,
  expectedHead: string,
) => invoke<void>("update_pr_branch", { id, repo, number, expectedHead });
/// One pull request's outcome in a batch. `error` is null on success.
export interface BatchOutcome {
  repo: string;
  number: number;
  error: string | null;
}

/// Apply one action to several pull requests.
///
/// Returns an outcome per pull request rather than throwing on the first
/// rejection: partial failure is the normal case for a batch, and a
/// single verdict would hide the rejections.
export const actOnPrs = (
  prs: [string, string, number][],
  action: PrActionName,
) => invoke<BatchOutcome[]>("act_on_prs", { prs, action });

/// The actions the backend accepts. A union rather than `string`, so a
/// typo is a compile error instead of a runtime "unknown action".
export type PrActionName =
  | "merge"
  | "close"
  | "reopen"
  | "draft"
  | "ready"
  | "enqueue"
  | "dequeue";

/// Everything the detail view shows for one pull request. Cost 1.
export const getPrDetail = (repo: string, number: number) =>
  invoke<PrDetail>("get_pr_detail", { repo, number });

/// Disk sizes for one repo's worktrees, as `[path, bytes]` pairs.
///
/// A full tree walk -- ~13s for 147 worktrees -- so it is a separate
/// query from listing and classification, and arrives last.
export const sizeWorktrees = (repoPath: string) =>
  invoke<[string, number][]>("size_worktrees", { repoPath });

/// Remove a worktree. Rejects anything not provably safe; the gate is
/// re-evaluated on the Rust side rather than trusted from the last scan.
export const removeWorktree = (repoPath: string, worktreePath: string) =>
  invoke<void>("remove_worktree", { repoPath, worktreePath });

/// Tell the poll loop whether the active view needs live PR data.
export const setViewNeedsGithub = (needs: boolean) =>
  invoke<void>("set_view_needs_github", { needs });

/// Directories scanned for git checkouts. Defaults to `~/code`.
export const getWorktreeDirs = () => invoke<string[]>("get_worktree_dirs");

/// Replace the scanned directories. Rejects paths that are not
/// directories, so a typo fails here rather than yielding an empty view.
export const setWorktreeDirs = (dirs: string[]) =>
  invoke<string[]>("set_worktree_dirs", { dirs });

/// The configured focused poll interval, in seconds.
export const getPollInterval = () => invoke<number>("get_poll_interval");

/// Set the poll interval. Returns the value actually applied, which may be
/// clamped -- the UI shows what the backend accepted, not what was asked.
export const setPollInterval = (secs: number) =>
  invoke<number>("set_poll_interval", { secs });

/// PRs awaiting the user's review. Rides along in the same GraphQL
/// document as the authored list, so it costs no extra rate limit.
export const getReviewing = () => invoke<PullRequest[]>("get_reviewing");

/// Median cycle time this week against last, in one request.
export const getCycleTrend = () => invoke<CycleTrend>("get_cycle_trend");

/// The period comparisons alone -- one small request (~1.6s) so the delta
/// cards paint without waiting on the daily series.
export const getPeriods = () => invoke<Periods>("get_periods");

/// The daily opened/merged series plus period comparisons. Fetched as
/// concurrent chunks on the Rust side. `days` is clamped to 1..=90.
export const getHistory = (days: number) => invoke<History>("get_history", { days });

/// Aggregates over the most recent 100 merged PRs. A separate command from
/// `getHistory` on purpose: it is the more expensive of the two and only
/// the insight row needs it, so a failure here must not blank the chart.
export const getMergedDetail = () => invoke<MergedDetail>("get_merged_detail");

/// Computed once at startup from the `gh` CLI token. `ok: false` means the
/// user needs to run `gh auth login`; `message` is ready-to-display prose.
export const getAuthState = () => invoke<AuthState>("get_auth_state");
