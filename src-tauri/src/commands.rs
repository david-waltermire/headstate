//! The Tauri command surface. React never talks to GitHub directly -- it
//! calls these commands and listens for the `prs-updated` event that
//! [`crate::poll`] emits in the background.

use crate::github::client::GitHubClient;
use crate::github::model::{
    CycleTrend, History, MergedDetail, Periods, PrDetail, PullRequest, Stats,
};
use crate::store::{load_snapshot, open_db, settings};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Enough for the UI to render a real first-run screen (e.g. "install gh
/// and run `gh auth login`") rather than a generic error. `message` is
/// already display-ready prose from `gh`'s own stderr when auth failed; it
/// is never re-wrapped or parsed, and it never contains the token itself.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthState {
    pub ok: bool,
    pub message: String,
}

/// Managed state wrapping the client. `None` when startup auth failed (no
/// `gh` token available), so commands that need GitHub can fail with a
/// clear message instead of the generic "state not managed" error Tauri
/// would otherwise return if the client type were unmanaged entirely.
pub struct GhClient(pub Option<Arc<GitHubClient>>);

/// Shown verbatim when no client exists. Duplicated across five commands
/// before this; a const means the five cannot drift apart.
pub const AUTH_ERR: &str = "not authenticated: run `gh auth login`";

/// Bound the history window.
///
/// The UI only offers 7/14/30, but a Tauri command is a public surface: an
/// unbounded value builds an arbitrarily large query and, since the fetch
/// chunks by day, spawns roughly `days / HISTORY_CHUNK_DAYS` concurrent
/// requests. Extracted from `get_history` so it can be tested -- deleting
/// the clamp there left all frontend and Rust tests passing while
/// `get_history(10000)` spawned ~2000 chunks.
pub fn clamp_days(days: i64) -> i64 {
    days.clamp(1, 90)
}

pub fn db_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("headstate.db")
}

/// The cached snapshot, so the window paints real content at launch rather
/// than a spinner. Never talks to GitHub.
#[tauri::command]
pub fn get_cached(app: AppHandle) -> Result<Vec<PullRequest>, String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    load_snapshot(&conn).map_err(|e| e.to_string())
}

/// A user-initiated, out-of-band fetch (e.g. a manual refresh button).
/// Does not touch the poll loop's cadence or its cached snapshot on disk.
#[tauri::command]
pub async fn refresh_now(client: State<'_, GhClient>) -> Result<Vec<PullRequest>, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client.fetch_prs().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stats(client: State<'_, GhClient>) -> Result<Stats, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client
        .fetch_stats(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

/// PRs awaiting the user's review.
///
/// A separate command from `get_cached`/`refresh_now` so the snapshot
/// cache keeps its shape; the underlying query returns both lists in one
/// request, so this costs no extra rate limit.
#[tauri::command]
pub async fn get_cycle_trend(client: State<'_, GhClient>) -> Result<CycleTrend, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client
        .fetch_cycle_trend(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

/// Everything the detail view shows for one pull request.
///
/// Fetched on open rather than in the poll loop: it is per-PR and only
/// needed while the view is on screen.
#[tauri::command]
pub async fn get_pr_detail(
    client: State<'_, GhClient>,
    repo: String,
    number: u64,
) -> Result<PrDetail, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client
        .fetch_pr_detail(&repo, number)
        .await
        .map_err(|e| e.to_string())
}

/// Repos and their worktrees, unclassified.
///
/// Fast enough to block a view on: ~800ms for 37 repos and 295 worktrees
/// on this machine. Safety classification is four git calls per worktree
/// and takes ~16s across that set, so it is a separate command the UI
/// calls per repo as results arrive.
#[tauri::command]
pub async fn list_worktrees(app: AppHandle) -> Result<Vec<crate::worktrees::Repo>, String> {
    let dirs = get_worktree_dirs(app);
    // Blocking filesystem and subprocess work: keep it off the async
    // runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || crate::worktrees::scan_dirs_fast(&dirs))
        .await
        .map_err(|e| e.to_string())
}

/// Classify one repo's worktrees. See `list_worktrees`.
#[tauri::command]
pub async fn classify_worktrees(
    repo_path: String,
) -> Result<Vec<crate::worktrees::Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::worktrees::classify_repo(&repo_path))
        .await
        .map_err(|e| e.to_string())
}

/// Disk sizes for one repo's worktrees, as `(path, bytes)` pairs.
///
/// Separate from classification because it is a full tree walk -- ~60ms
/// per worktree, so ~18s across the 296 on this machine. The UI shows the
/// list, then safety, then sizes.
#[tauri::command]
pub async fn size_worktrees(repo_path: String) -> Result<Vec<(String, u64)>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::worktrees::size_repo(&repo_path))
        .await
        .map_err(|e| e.to_string())
}

/// Remove a worktree, refusing anything not provably safe.
///
/// The safety gate is re-evaluated inside `remove_worktree` rather than
/// trusted from whatever the UI last saw: a scan is a snapshot, and the
/// user may have started editing since.
///
/// Logged with path and branch, so "where did that go?" has an answer.
#[tauri::command]
pub async fn remove_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    let wt = worktree_path.clone();
    let repo = repo_path.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::worktrees::remove_worktree(&repo, &wt))
            .await
            .map_err(|e| e.to_string())?;

    match &result {
        Ok(()) => log::info!("removed worktree {worktree_path}"),
        Err(e) => log::warn!("refused to remove worktree {worktree_path}: {e}"),
    }
    result
}

/// Directories scanned for git checkouts.
///
/// Defaults to `~/code` when unset, so the app works with no
/// configuration on a machine that follows that convention -- and says
/// what it scanned rather than silently finding nothing.
#[tauri::command]
pub fn get_worktree_dirs(app: AppHandle) -> Vec<String> {
    open_db(&db_path(&app))
        .ok()
        .and_then(|c| settings::get::<Vec<String>>(&c, settings::keys::WORKTREE_DIRS).ok())
        .flatten()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(default_worktree_dirs)
}

/// `~/code` if it exists, else nothing.
///
/// Returning a path that does not exist would make the worktrees view
/// report "no repos found" for a directory the user never chose.
pub fn default_worktree_dirs() -> Vec<String> {
    std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join("code"))
        .filter(|p| p.is_dir())
        .map(|p| vec![p.to_string_lossy().into_owned()])
        .unwrap_or_default()
}

/// Replace the scanned directories.
///
/// Non-existent paths are rejected rather than stored: a typo should fail
/// visibly here, not silently produce an empty worktrees view later.
#[tauri::command]
pub fn set_worktree_dirs(app: AppHandle, dirs: Vec<String>) -> Result<Vec<String>, String> {
    let ok = validate_dirs(dirs)?;
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    settings::set(&conn, settings::keys::WORKTREE_DIRS, &ok).map_err(|e| e.to_string())?;
    log::info!("worktree directories set to {} path(s)", ok.len());
    Ok(ok)
}

/// Trim, drop blanks, and reject anything that is not a directory.
///
/// Split from the command so it is testable without an AppHandle. A typo
/// must fail HERE, visibly, rather than being stored and producing an
/// empty worktrees view that looks like "you have no worktrees".
pub fn validate_dirs(dirs: Vec<String>) -> Result<Vec<String>, String> {
    let (ok, bad): (Vec<String>, Vec<String>) = dirs
        .into_iter()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .partition(|d| std::path::Path::new(d).is_dir());

    if bad.is_empty() {
        Ok(ok)
    } else {
        Err(format!("not a directory: {}", bad.join(", ")))
    }
}

/// Tell the poll loop whether the active view needs live PR data.
///
/// Switching BACK to a PR view wakes the loop, so the list is fresh
/// immediately rather than after up to a full background interval.
/// Switching away does not wake it -- there is nothing to hurry for.
#[tauri::command]
pub fn set_view_needs_github(
    needs: bool,
    state: State<'_, crate::poll::ViewNeedsGithub>,
    waker: State<'_, crate::poll::Waker>,
) {
    let was = state.0.swap(needs, std::sync::atomic::Ordering::Relaxed);
    if needs && !was {
        waker.0.notify_one();
    }
}

/// The configured focused poll interval, in seconds.
#[tauri::command]
pub fn get_poll_interval(state: State<'_, crate::poll::PollInterval>) -> u64 {
    state.0.load(std::sync::atomic::Ordering::Relaxed)
}

/// Set the focused poll interval, clamped to the allowed range.
///
/// Wakes the poll loop so a SHORTENED interval takes effect immediately
/// rather than after the previous, longer sleep expires -- otherwise
/// dropping from an hour to a minute would appear to do nothing for up to
/// an hour. Returns the value actually applied, so the UI reflects the
/// clamp rather than showing a number the backend rejected.
#[tauri::command]
pub fn set_poll_interval(
    app: AppHandle,
    secs: u64,
    state: State<'_, crate::poll::PollInterval>,
    waker: State<'_, crate::poll::Waker>,
) -> u64 {
    let applied = crate::poll::clamp_interval(secs);
    state.0.store(applied, std::sync::atomic::Ordering::Relaxed);

    // Persist so the choice survives a relaunch. A write failure is
    // logged, not surfaced: the setting is already live in memory, and
    // refusing the change because the disk is unhappy would be worse than
    // forgetting it next launch.
    match open_db(&db_path(&app))
        .and_then(|c| crate::store::settings::set(&c, settings::keys::POLL_INTERVAL_SECS, &applied))
    {
        Ok(()) => log::info!("poll interval set to {applied}s"),
        Err(e) => log::warn!("poll interval set to {applied}s but not persisted: {e}"),
    }

    waker.0.notify_one();
    applied
}

#[tauri::command]
pub async fn get_reviewing(client: State<'_, GhClient>) -> Result<Vec<PullRequest>, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client.fetch_reviewing().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_periods(client: State<'_, GhClient>) -> Result<Periods, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client
        .fetch_periods(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(client: State<'_, GhClient>, days: i64) -> Result<History, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let days = clamp_days(days);
    client
        .fetch_history(chrono::Utc::now(), days)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_merged_detail(client: State<'_, GhClient>) -> Result<MergedDetail, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client
        .fetch_merged_detail()
        .await
        .map_err(|e| e.to_string())
}

/// Whether we have a usable GitHub client. `state` is computed once at
/// startup from `auth::read_token` / `auth::build_client` and stored as
/// managed state; this command just hands it to the frontend.
#[tauri::command]
pub fn get_auth_state(state: State<'_, AuthState>) -> AuthState {
    state.inner().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard against an unbounded query. Its absence is invisible to
    /// every other test in the project.
    #[test]
    fn clamp_days_bounds_the_window() {
        assert_eq!(clamp_days(30), 30, "a normal request passes through");
        assert_eq!(clamp_days(7), 7);
        assert_eq!(clamp_days(90), 90, "the documented maximum is allowed");
        assert_eq!(clamp_days(10_000), 90, "an absurd request is capped");
        assert_eq!(clamp_days(0), 1, "zero would produce an empty query");
        assert_eq!(clamp_days(-5), 1, "negative would loop backwards");
    }

    /// At the cap, the chunked fetch stays to a sane number of concurrent
    /// requests -- the actual reason the clamp exists.
    #[test]
    fn the_cap_bounds_concurrent_chunks() {
        let chunks = clamp_days(10_000) / crate::github::query::HISTORY_CHUNK_DAYS;
        assert!(chunks <= 18, "at most 18 concurrent chunks, got {chunks}");
    }

    #[test]
    fn validate_dirs_accepts_real_directories() {
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path().to_string_lossy().into_owned();
        assert_eq!(validate_dirs(vec![p.clone()]).unwrap(), vec![p]);
    }

    #[test]
    fn validate_dirs_trims_and_drops_blanks() {
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path().to_string_lossy().into_owned();
        let out = validate_dirs(vec![format!("  {p}  "), "".into(), "   ".into()]).unwrap();
        assert_eq!(out, vec![p]);
    }

    /// The point of validating at all: a typo should fail loudly rather
    /// than being stored and later rendering as "no worktrees found".
    #[test]
    fn validate_dirs_rejects_a_path_that_is_not_a_directory() {
        let err = validate_dirs(vec!["/definitely/not/here".into()]).unwrap_err();
        assert!(err.contains("/definitely/not/here"), "{err}");
    }

    /// A file is not a directory, and the error should say so rather than
    /// accepting it and failing during the scan.
    #[test]
    fn validate_dirs_rejects_a_file() {
        let d = tempfile::TempDir::new().unwrap();
        let f = d.path().join("a-file");
        std::fs::write(&f, "x").unwrap();
        assert!(validate_dirs(vec![f.to_string_lossy().into_owned()]).is_err());
    }

    #[test]
    fn auth_error_names_the_command_that_fixes_it() {
        assert!(AUTH_ERR.contains("gh auth login"));
    }
}
