//! Background polling.
//!
//! Polling lives in Rust rather than React so it continues while the window
//! is hidden to the tray -- which is what makes the tray badge meaningful.
//! React never talks to GitHub directly: it renders whatever snapshot is on
//! disk and listens for the `prs-updated` event.

use crate::github::client::GitHubClient;
use crate::store::{open_db, save_snapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const FOCUSED: Duration = Duration::from_secs(60);
pub const BACKGROUND: Duration = Duration::from_secs(300);

/// 60s focused / 300s backgrounded. At 2 rate-limit points per poll, focused
/// cadence is ~120 points/hour against a 5000/hour budget -- see the cadence
/// test below, which exists so a future change to "every 5 seconds" fails CI
/// rather than silently competing with the user's own `gh` usage.
pub fn interval_for(focused: bool) -> Duration {
    if focused {
        FOCUSED
    } else {
        BACKGROUND
    }
}

/// Spawn the poll loop. Each tick fetches, writes the snapshot, and emits
/// `prs-updated`; the frontend invalidates its query on that event.
///
/// A failed poll leaves the last snapshot on disk in place rather than
/// blanking the UI: on error we emit `poll-error` and let the next tick
/// retry, we never clear the cache. Nothing in this loop panics -- a panic
/// in a spawned task would silently kill polling for the rest of the
/// session, so every fallible step here is matched or logged, never
/// unwrapped.
pub fn spawn(app: AppHandle, client: Arc<GitHubClient>, focused: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match client.fetch_prs().await {
                Ok(prs) => {
                    match app.path().app_data_dir() {
                        Ok(dir) => match open_db(&dir.join("headstate.db")) {
                            Ok(conn) => {
                                if let Err(e) = save_snapshot(&conn, &prs) {
                                    eprintln!("headstate: failed to save snapshot: {e}");
                                }
                            }
                            Err(e) => {
                                eprintln!("headstate: failed to open db: {e}");
                            }
                        },
                        Err(e) => {
                            eprintln!("headstate: failed to resolve app data dir: {e}");
                        }
                    }
                    if let Err(e) = app.emit("prs-updated", &prs) {
                        eprintln!("headstate: failed to emit prs-updated: {e}");
                    }
                }
                // A failed poll leaves the last snapshot in place rather
                // than blanking the UI; the next tick retries.
                Err(e) => {
                    if let Err(emit_err) = app.emit("poll-error", e.to_string()) {
                        eprintln!("headstate: failed to emit poll-error: {emit_err}");
                    }
                }
            }
            tokio::time::sleep(interval_for(focused.load(Ordering::Relaxed))).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_faster_when_focused() {
        assert_eq!(interval_for(true), std::time::Duration::from_secs(60));
        assert_eq!(interval_for(false), std::time::Duration::from_secs(300));
    }

    /// 60s focused is 60 polls/hour at 2 points each, against a 5000/hour
    /// budget. If this ever regresses to a few seconds, the app would start
    /// competing with the user's own gh usage for rate limit.
    #[test]
    fn focused_cadence_stays_well_inside_the_rate_limit() {
        let per_hour = 3600 / interval_for(true).as_secs();
        assert!(per_hour * 2 < 500, "polling budget too aggressive");
    }
}
