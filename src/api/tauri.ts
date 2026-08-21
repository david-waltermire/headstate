/// Typed wrappers around the Tauri command surface in
/// `src-tauri/src/commands.rs`. Every command returns `Result<T, String>` on
/// the Rust side, which Tauri surfaces as a *rejected* promise (not a
/// resolved `Err` value) when the Rust side returns `Err`. Callers that need
/// to distinguish "not authenticated" from a network failure should inspect
/// the rejection message; `AuthGate` covers the common case by gating
/// render on `get_auth_state` before anything else calls in.

import { invoke } from "@tauri-apps/api/core";
import type {
  Worktree,
  WorktreeRepo,
  CycleTrend,
  History,
  MergedDetail,
  Periods,
  PullRequest,
  Stats,
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
