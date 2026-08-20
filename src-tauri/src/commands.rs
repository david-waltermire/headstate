//! The Tauri command surface. React never talks to GitHub directly -- it
//! calls these commands and listens for the `prs-updated` event that
//! [`crate::poll`] emits in the background.

use crate::github::client::GitHubClient;
use crate::github::model::{CycleTrend, History, MergedDetail, Periods, PullRequest, Stats};
use crate::store::{load_snapshot, open_db};
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

fn db_path(app: &AppHandle) -> std::path::PathBuf {
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
    fn auth_error_names_the_command_that_fixes_it() {
        assert!(AUTH_ERR.contains("gh auth login"));
    }
}
