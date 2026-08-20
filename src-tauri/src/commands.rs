//! The Tauri command surface. React never talks to GitHub directly -- it
//! calls these commands and listens for the `prs-updated` event that
//! [`crate::poll`] emits in the background.

use crate::github::client::GitHubClient;
use crate::github::model::{History, MergedDetail, Periods, PullRequest, Stats};
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
    let client = client
        .0
        .clone()
        .ok_or_else(|| "not authenticated: run `gh auth login`".to_string())?;
    client.fetch_prs().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stats(client: State<'_, GhClient>) -> Result<Stats, String> {
    let client = client
        .0
        .clone()
        .ok_or_else(|| "not authenticated: run `gh auth login`".to_string())?;
    client
        .fetch_stats(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_periods(client: State<'_, GhClient>) -> Result<Periods, String> {
    let client = client
        .0
        .clone()
        .ok_or_else(|| "not authenticated: run `gh auth login`".to_string())?;
    client
        .fetch_periods(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(client: State<'_, GhClient>, days: i64) -> Result<History, String> {
    let client = client
        .0
        .clone()
        .ok_or_else(|| "not authenticated: run `gh auth login`".to_string())?;
    // Clamp: the UI offers 7/14/30, but a command is a public surface and
    // an unbounded value would build an arbitrarily large query.
    let days = days.clamp(1, 90);
    client
        .fetch_history(chrono::Utc::now(), days)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_merged_detail(client: State<'_, GhClient>) -> Result<MergedDetail, String> {
    let client = client
        .0
        .clone()
        .ok_or_else(|| "not authenticated: run `gh auth login`".to_string())?;
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
