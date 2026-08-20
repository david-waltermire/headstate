//! Background polling.
//!
//! Polling lives in Rust rather than React so it continues while the window
//! is hidden to the tray -- which is what makes the tray badge meaningful.
//! React never talks to GitHub directly: it renders whatever snapshot is on
//! disk and listens for the `prs-updated` event.

use crate::github::client::GitHubClient;
use crate::github::model::{MergeState, PullRequest};
use crate::store::{open_db, save_snapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const FOCUSED: Duration = Duration::from_secs(60);
pub const BACKGROUND: Duration = Duration::from_secs(300);

/// #22: how long after a poll to fire the one-shot targeted re-poll for
/// PRs still stuck on `MergeState::Checking`. GitHub computes mergeability
/// lazily and often hasn't finished 5s after a push; this is far shorter
/// than either regular cadence so a fresh push resolves quickly without
/// waiting a full tick.
pub const RECHECK_DELAY: Duration = Duration::from_secs(5);

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

/// True if any PR is still waiting on GitHub's lazy mergeability
/// computation. Drives whether a one-shot recheck (#22) is worth
/// scheduling at all -- no `Checking` PRs means nothing to gain from an
/// extra request.
fn has_checking(prs: &[PullRequest]) -> bool {
    prs.iter().any(|pr| pr.merge == MergeState::Checking)
}

/// Overlays freshly-fetched PRs onto a base snapshot by `(repo, number)`
/// identity, leaving every other PR in `base` untouched. Used to fold the
/// #22 targeted recheck's results back into the last known snapshot without
/// discarding PRs the recheck didn't (need to) touch.
///
/// Pure and side-effect free so the merge semantics -- "only the polled
/// identities move, everything else is preserved verbatim" -- are testable
/// without a mock server or a running event loop.
fn merge_by_identity(base: &[PullRequest], updates: &[PullRequest]) -> Vec<PullRequest> {
    base.iter()
        .map(|pr| {
            updates
                .iter()
                .find(|u| u.repo == pr.repo && u.number == pr.number)
                .cloned()
                .unwrap_or_else(|| pr.clone())
        })
        .collect()
}

/// Persists a snapshot and emits `prs-updated`, matching every fallible
/// step rather than unwrapping -- shared by both the regular poll tick and
/// the #22 one-shot recheck so the "never panic, never blank the UI on
/// failure" discipline lives in exactly one place.
fn persist_and_emit(app: &AppHandle, prs: &[PullRequest]) {
    match app.path().app_data_dir() {
        Ok(dir) => match open_db(&dir.join("headstate.db")) {
            Ok(conn) => {
                if let Err(e) = save_snapshot(&conn, prs) {
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
    if let Err(e) = app.emit("prs-updated", prs) {
        eprintln!("headstate: failed to emit prs-updated: {e}");
    }
}

/// #22: schedules exactly one targeted re-poll ~`RECHECK_DELAY` after a
/// poll that left PRs in `MergeState::Checking`, so a mergeability check
/// that GitHub hadn't finished computing yet gets a chance to resolve
/// before the next regular tick (60s/300s) instead of always waiting for
/// it.
///
/// "Exactly one" is enforced structurally, not by a retry counter: this
/// function calls `client.fetch_prs()` a single time and then returns --
/// there is no loop, no re-scheduling of itself, and no path back into this
/// function from within it. Whatever happens (success, network error, or
/// nothing left `Checking` by the time it fires), the task ends and the
/// regular poll loop's own next tick is what runs after that. A failed
/// recheck logs and returns without touching the snapshot, so the last good
/// snapshot on disk is left exactly as the regular tick left it -- the UI
/// is never blanked.
fn spawn_recheck(app: AppHandle, client: Arc<GitHubClient>, last_known: Vec<PullRequest>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RECHECK_DELAY).await;

        match client.fetch_prs().await {
            Ok(fresh) => {
                let merged = merge_by_identity(&last_known, &fresh);
                persist_and_emit(&app, &merged);
            }
            Err(e) => {
                // No retry: the regular 60s/300s cadence picks this back up
                // on its own next tick. Logging only, snapshot untouched.
                eprintln!("headstate: targeted recheck failed: {e}");
            }
        }
    });
}

/// Spawn the poll loop. Each tick fetches, writes the snapshot, and emits
/// `prs-updated`; the frontend invalidates its query on that event. If the
/// fetch left any PR in `MergeState::Checking`, it also schedules the #22
/// one-shot recheck described on `spawn_recheck` above.
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
                    persist_and_emit(&app, &prs);
                    if has_checking(&prs) {
                        spawn_recheck(app.clone(), client.clone(), prs);
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
    use crate::github::model::{CiState, Label, ReviewState};
    use chrono::Utc;

    fn pr(repo: &str, number: u64, merge: MergeState) -> PullRequest {
        PullRequest {
            number,
            title: "Add retry to the fetch client".into(),
            url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.into(),
            author: "octocat".into(),
            is_draft: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            ci: CiState::Success,
            merge,
            review: ReviewState::Approved,
            in_merge_queue: false,
            labels: Vec::<Label>::new(),
            comment_count: 0,
        }
    }

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

    /// #22's recheck delay is a single one-shot query, not a recurring
    /// cadence -- guard it the same way the regular cadence test guards
    /// FOCUSED/BACKGROUND, so a future change (e.g. a mistaken retry loop)
    /// that shrank this toward "every few seconds" fails CI instead of
    /// silently turning into a retry storm against the rate limit.
    #[test]
    fn recheck_delay_is_a_single_short_one_shot_not_a_tight_polling_cadence() {
        assert!(
            RECHECK_DELAY < FOCUSED,
            "recheck should fire before the next regular tick"
        );
        assert!(
            RECHECK_DELAY >= Duration::from_secs(1),
            "recheck delay too aggressive for a one-shot"
        );
    }

    #[test]
    fn has_checking_detects_a_pr_still_being_computed() {
        let prs = vec![
            pr("octocat/hello-world", 1, MergeState::Mergeable),
            pr("octocat/hello-world", 2, MergeState::Checking),
        ];
        assert!(has_checking(&prs));
    }

    #[test]
    fn has_checking_is_false_once_everything_resolved() {
        let prs = vec![
            pr("octocat/hello-world", 1, MergeState::Mergeable),
            pr("octocat/spoon-knife", 7, MergeState::Conflicted),
        ];
        assert!(!has_checking(&prs));
    }

    /// The core #22 invariant: a targeted recheck's results replace only
    /// the PRs it actually re-fetched, identified by (repo, number) --
    /// everything else in the last known snapshot survives untouched. This
    /// is what keeps a partial recheck from silently dropping PRs that
    /// weren't part of it.
    #[test]
    fn merge_by_identity_replaces_only_matching_prs() {
        let base = vec![
            pr("octocat/hello-world", 1, MergeState::Checking),
            pr("octocat/hello-world", 2, MergeState::Mergeable),
            pr("octocat/spoon-knife", 7, MergeState::Checking),
        ];
        let updates = vec![
            pr("octocat/hello-world", 1, MergeState::Mergeable),
            pr("octocat/spoon-knife", 7, MergeState::Conflicted),
        ];

        let merged = merge_by_identity(&base, &updates);

        assert_eq!(merged[0].merge, MergeState::Mergeable); // resolved
        assert_eq!(merged[1].merge, MergeState::Mergeable); // untouched, unchanged
        assert_eq!(merged[2].merge, MergeState::Conflicted); // resolved
    }

    /// A PR present in the base snapshot but absent from the recheck's
    /// results (e.g. it was closed between the two fetches) must be kept,
    /// not dropped -- the recheck only ever narrows toward "resolved,"
    /// never toward "gone," since that would blank part of the UI on a
    /// mismatch that isn't even an error.
    #[test]
    fn merge_by_identity_keeps_prs_absent_from_the_update_set() {
        let base = vec![pr("octocat/hello-world", 1, MergeState::Checking)];
        let updates: Vec<PullRequest> = vec![];

        let merged = merge_by_identity(&base, &updates);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].merge, MergeState::Checking);
    }

    /// Distinct repos can legally share a PR number -- identity must be the
    /// (repo, number) pair, not the number alone, or a recheck could
    /// overwrite the wrong repo's PR.
    #[test]
    fn merge_by_identity_disambiguates_same_number_in_different_repos() {
        let base = vec![
            pr("octocat/hello-world", 7, MergeState::Checking),
            pr("octocat/spoon-knife", 7, MergeState::Checking),
        ];
        let updates = vec![pr("octocat/hello-world", 7, MergeState::Mergeable)];

        let merged = merge_by_identity(&base, &updates);

        assert_eq!(merged[0].merge, MergeState::Mergeable);
        assert_eq!(merged[1].merge, MergeState::Checking); // different repo, untouched
    }
}
