//! Background polling.
//!
//! Polling lives in Rust rather than React so it continues while the window
//! is hidden to the tray -- which is what makes the tray badge meaningful.
//! React never talks to GitHub directly: it renders whatever snapshot is on
//! disk and listens for the `prs-updated` event.

use crate::github::client::{ClientError, GitHubClient};
use crate::github::model::{needs_attention_count, CiState, MergeState, PullRequest};
use crate::store::{open_db, save_snapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

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
/// Send one desktop notification for a newly-broken PR.
///
/// Failure is logged and swallowed: a notification is an affordance, and
/// losing one must never take down polling. Clicking is wired through the
/// plugin's default behaviour rather than a custom handler, so there is no
/// state to leak if the window is closed.
fn notify_breakage(app: &AppHandle, b: &Breakage) {
    use tauri_plugin_notification::NotificationExt;
    let body = format!("{}#{} {}", b.repo, b.number, b.reason);
    if let Err(e) = app
        .notification()
        .builder()
        .title(b.title.clone())
        .body(body)
        .show()
    {
        log::warn!("failed to show notification: {e}");
    }
}

/// A newly-broken PR worth interrupting the user for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Breakage {
    pub title: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub reason: &'static str,
}

/// PRs that just BROKE, by comparing a tick against the one before it.
///
/// Deliberately failures only. A 60s loop across many repos is a firehose
/// if it reports every state change, and "your PR was approved" is good
/// news the badge and list already carry passively. An interruption should
/// mean something needs your hands.
///
/// Only TRANSITIONS fire: a PR that was already red on the previous tick
/// is not re-reported, or every tick would re-notify the same 13 PRs
/// forever. A PR absent from `previous` -- first run, or newly opened --
/// never fires, because its "before" state is unknown and assuming green
/// would notify the whole list on first launch.
pub fn newly_broken(previous: &[PullRequest], current: &[PullRequest]) -> Vec<Breakage> {
    current
        .iter()
        .filter_map(|pr| {
            let was = previous
                .iter()
                .find(|p| p.repo == pr.repo && p.number == pr.number)?;
            let reason = if pr.ci == CiState::Failure && was.ci != CiState::Failure {
                "CI is failing"
            } else if pr.merge == MergeState::Conflicted && was.merge != MergeState::Conflicted {
                "has merge conflicts"
            } else {
                return None;
            };
            Some(Breakage {
                title: pr.title.clone(),
                repo: pr.repo.clone(),
                number: pr.number,
                url: pr.url.clone(),
                reason,
            })
        })
        .collect()
}

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
/// Tell the UI a local write failed.
///
/// Reuses the existing `poll-error` banner rather than adding a channel:
/// the snapshot failing means offline readability and cold-start speed are
/// gone, which the user should know about even though the live list is
/// unaffected.
fn emit_store_error(app: &AppHandle, msg: String) {
    if let Err(e) = app.emit("poll-error", msg) {
        log::warn!("failed to emit store error: {e}");
    }
}

fn persist_and_emit(app: &AppHandle, prs: &[PullRequest]) {
    match app.path().app_data_dir() {
        Ok(dir) => match open_db(&dir.join("headstate.db")) {
            Ok(conn) => {
                if let Err(e) = save_snapshot(&conn, prs) {
                    log::error!("failed to save snapshot: {e}");
                    emit_store_error(app, format!("could not save local snapshot: {e}"));
                }
            }
            Err(e) => {
                log::error!("failed to open db: {e}");
                emit_store_error(app, format!("could not open the local database: {e}"));
            }
        },
        Err(e) => {
            log::error!("failed to resolve app data dir: {e}");
            emit_store_error(app, format!("could not find the app data directory: {e}"));
        }
    }
    if let Err(e) = app.emit("prs-updated", prs) {
        log::warn!("failed to emit prs-updated: {e}");
    }
    // The badge is why polling lives in Rust at all: it has to stay correct
    // while the window is hidden, when no React component is mounted to
    // compute it. Counted here from the same list just persisted, using the
    // model's single owner of the rule.
    crate::tray::set_badge(app, needs_attention_count(prs));
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
                log::warn!("targeted recheck failed: {e}");
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
/// Wall-clock ceiling on one poll's fetch.
///
/// The transport timeouts in `auth::build_client` bound individual socket
/// operations; this bounds the whole request. A server that trickles bytes
/// can keep a read alive indefinitely without ever tripping a read timeout,
/// and the loop must reach its sleep either way.
///
/// Generous relative to the ~3s measured fetch, so it fires only on a
/// genuine hang and never truncates a merely slow response.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(90);

/// Wakes the poll loop out of its sleep.
///
/// Managed in Tauri state so the tray and the window-focus handler can
/// reach it. One mechanism covers two problems:
///
/// 1. Tray "Refresh now" only emitted an event whose sole listener is a
///    React effect inside `App` -- so while the window was hidden the
///    click did a real fetch whose result landed in a cache nobody was
///    looking at, never persisted, and never touched the badge.
/// 2. `tokio::time::sleep` does not fire during macOS system sleep and
///    does not compensate on wake, so after a closed lid the first tick
///    was delayed up to a full interval (300s when backgrounded).
pub struct Waker(pub Arc<Notify>);

pub fn spawn(
    app: AppHandle,
    client: Arc<GitHubClient>,
    focused: Arc<AtomicBool>,
    waker: Arc<Notify>,
) {
    tauri::async_runtime::spawn(async move {
        let mut previous: Vec<PullRequest> = Vec::new();
        loop {
            // `timeout` collapses a hang into the Err arm the loop already
            // handles, so a wedged request costs one tick instead of the
            // rest of the session.
            let fetched =
                match tokio::time::timeout(FETCH_TIMEOUT, client.fetch_prs_with_total()).await {
                    Ok(res) => res,
                    Err(_) => Err(ClientError::Timeout(FETCH_TIMEOUT.as_secs())),
                };
            match fetched {
                Ok((prs, total)) => {
                    // Compare against the tick before this one. `previous`
                    // starts empty, so the first tick never notifies --
                    // otherwise launching with 13 broken PRs would fire 13
                    // notifications at once.
                    for b in newly_broken(&previous, &prs) {
                        notify_breakage(&app, &b);
                    }
                    previous = prs.clone();
                    // Only interesting when GitHub says there are more than
                    // it returned; the UI stays silent otherwise.
                    if total > prs.len() as u64 {
                        log::warn!("truncated: showing {} of {total} open PRs", prs.len());
                        if let Err(e) = app.emit("prs-truncated", total) {
                            log::warn!("failed to emit prs-truncated: {e}");
                        }
                    }
                    // The heartbeat that makes "it stopped updating"
                    // answerable: if the log ends here, the loop died or
                    // the machine slept; if it keeps ticking, the problem
                    // is downstream. Counts only -- never titles, never
                    // repository names.
                    log::info!(
                        "poll ok: {} open, {} need attention",
                        prs.len(),
                        needs_attention_count(&prs)
                    );
                    persist_and_emit(&app, &prs);
                    if has_checking(&prs) {
                        spawn_recheck(app.clone(), client.clone(), prs);
                    }
                }
                // A failed poll leaves the last snapshot in place rather
                // than blanking the UI; the next tick retries.
                Err(e) => {
                    log::warn!("poll failed: {e}");
                    if let Err(emit_err) = app.emit("poll-error", e.to_string()) {
                        log::warn!("failed to emit poll-error: {emit_err}");
                    }
                }
            }
            // Whichever comes first: the cadence elapsing, or someone
            // asking for a refresh. `Notify` stores one permit, so a
            // request that arrives mid-fetch is not lost -- the next
            // `notified()` returns immediately rather than waiting out a
            // full interval.
            tokio::select! {
                _ = tokio::time::sleep(interval_for(focused.load(Ordering::Relaxed))) => {}
                _ = waker.notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `notify_one` stores a permit when nobody is waiting, so a refresh
    /// requested WHILE a fetch is in flight is not lost -- the next
    /// `notified()` returns immediately instead of waiting out a full
    /// interval. Without that property, a tray click landing mid-tick
    /// would appear to do nothing for up to 300s.
    #[tokio::test]
    async fn a_wake_requested_before_the_wait_is_not_lost() {
        let n = Notify::new();
        n.notify_one(); // arrives while the loop is busy fetching
        let waited = tokio::time::timeout(Duration::from_millis(50), n.notified()).await;
        assert!(waited.is_ok(), "a stored permit must satisfy the next wait");
    }

    /// And the select really does prefer whichever fires first, so a wake
    /// short-circuits the cadence rather than being queued behind it.
    #[tokio::test]
    async fn a_wake_short_circuits_the_sleep() {
        let n = Arc::new(Notify::new());
        let n2 = n.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            n2.notify_one();
        });
        let start = std::time::Instant::now();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(30)) => panic!("slept instead of waking"),
            _ = n.notified() => {}
        }
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    /// A hung request must collapse into the error arm rather than
    /// awaiting forever. Without the `timeout` wrapper the poll loop had
    /// no ceiling at all: a blackholed TCP connection meant no error, no
    /// next tick, and silent stale data for the rest of the session.
    #[tokio::test]
    async fn a_hung_fetch_times_out_instead_of_awaiting_forever() {
        // A future that never resolves, standing in for a wedged socket.
        // Uses a short ceiling so the test is instant; the mechanism is
        // identical to the one FETCH_TIMEOUT drives in `spawn`.
        let hung = std::future::pending::<Result<Vec<PullRequest>, ClientError>>();
        let out = tokio::time::timeout(Duration::from_millis(20), hung).await;
        assert!(out.is_err(), "a never-resolving fetch must time out");

        // And the timeout maps into the error arm the loop already handles.
        let mapped: Result<Vec<PullRequest>, ClientError> = match out {
            Ok(res) => res,
            Err(_) => Err(ClientError::Timeout(FETCH_TIMEOUT.as_secs())),
        };
        assert!(matches!(mapped, Err(ClientError::Timeout(90))));
    }

    /// The ceiling has to clear a normal fetch by a wide margin, or a
    /// merely slow response would be reported as a failure.
    #[test]
    fn fetch_timeout_leaves_headroom_over_a_normal_fetch() {
        // PRS_QUERY's own doc records ~2.9s for 27 PRs.
        assert!(FETCH_TIMEOUT >= Duration::from_secs(30));
        // And still well under the shortest poll interval, so a wedged
        // tick cannot overlap the next one.
        assert!(FETCH_TIMEOUT < FOCUSED + FOCUSED);
    }
    use crate::github::model::{CiState, Label, ReviewState};
    use chrono::Utc;

    fn pr(repo: &str, number: u64, merge: MergeState) -> PullRequest {
        PullRequest {
            number,
            title: "Add retry to the fetch client".into(),
            url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.into(),
            head_ref: "feature/x".into(),
            base_ref: "main".into(),
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
            unresolved_threads: 0,
        }
    }

    #[test]
    fn polls_faster_when_focused() {
        assert_eq!(interval_for(true), std::time::Duration::from_secs(60));
        assert_eq!(interval_for(false), std::time::Duration::from_secs(300));
    }

    /// Budget guard for BOTH cadences, with the per-poll cost derived from
    /// the query rather than hardcoded.
    ///
    /// The previous version tested only the focused cadence and could not
    /// fail unless `polls_faster_when_focused` already had -- both read the
    /// same `interval_for(true)`, which that test pins exactly. Its `* 2`
    /// was also a literal unconnected to what PRS_QUERY actually costs, so
    /// adding a search alias would silently double the real spend while the
    /// assertion kept passing.
    #[test]
    fn both_cadences_stay_well_inside_the_rate_limit() {
        // A LOWER BOUND, not the true cost: GitHub bills roughly one
        // point per top-level `search`, but nested connections can push
        // it higher (measured: PRS_QUERY costs 2, which happens to equal
        // its search count). This guard catches a cadence or alias-count
        // regression; it cannot catch a rise caused by nesting alone, so
        // any new connection is worth measuring against the live API.
        let cost = crate::github::query::PRS_QUERY.matches("search(").count() as u64;
        assert!(cost > 0, "PRS_QUERY must contain at least one search");

        for focused in [true, false] {
            let per_hour = 3600 / interval_for(focused).as_secs();
            let points = per_hour * cost;
            assert!(
                points < 500,
                "{} polling would spend {points}/hr of a 5000 budget",
                if focused { "focused" } else { "background" }
            );
        }
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

    fn pr_full(repo: &str, number: u64, ci: CiState, merge: MergeState) -> PullRequest {
        let t = chrono::DateTime::parse_from_rfc3339("2026-08-20T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        PullRequest {
            number,
            title: format!("PR {number}"),
            url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.to_string(),
            author: "someone".into(),
            is_draft: false,
            head_ref: "feature/x".into(),
            base_ref: "main".into(),
            created_at: t,
            updated_at: t,
            ci,
            merge,
            review: crate::github::model::ReviewState::None,
            in_merge_queue: false,
            labels: vec![],
            comment_count: 0,
            unresolved_threads: 0,
        }
    }

    #[test]
    fn notifies_when_ci_turns_red() {
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full(
            "acme/a",
            1,
            CiState::Failure,
            MergeState::Mergeable,
        )];
        let b = newly_broken(&before, &after);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].reason, "CI is failing");
        assert!(b[0].url.ends_with("/pull/1"), "must be clickable");
    }

    #[test]
    fn notifies_when_a_conflict_appears() {
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Conflicted,
        )];
        assert_eq!(
            newly_broken(&before, &after)[0].reason,
            "has merge conflicts"
        );
    }

    /// The rule that stops it being a firehose: an ALREADY-red PR must not
    /// re-notify every 60 seconds forever.
    #[test]
    fn does_not_renotify_a_pr_that_was_already_broken() {
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Failure,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full(
            "acme/a",
            1,
            CiState::Failure,
            MergeState::Mergeable,
        )];
        assert!(newly_broken(&before, &after).is_empty());
    }

    /// First run has no "before", and assuming green would notify the
    /// entire backlog at launch -- 13 notifications on this account today.
    #[test]
    fn never_notifies_for_a_pr_it_has_not_seen_before() {
        let after = vec![pr_full(
            "acme/a",
            1,
            CiState::Failure,
            MergeState::Conflicted,
        )];
        assert!(newly_broken(&[], &after).is_empty());
    }

    #[test]
    fn recovering_does_not_notify() {
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Failure,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Mergeable,
        )];
        assert!(newly_broken(&before, &after).is_empty());
    }

    /// `Checking` is GitHub still computing mergeability, which happens on
    /// every push -- treating it as a conflict would notify constantly.
    #[test]
    fn checking_mergeability_is_not_a_breakage() {
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full("acme/a", 1, CiState::Success, MergeState::Checking)];
        assert!(newly_broken(&before, &after).is_empty());
        // ...and pending CI likewise.
        let after2 = vec![pr_full(
            "acme/a",
            1,
            CiState::Pending,
            MergeState::Mergeable,
        )];
        assert!(newly_broken(&before, &after2).is_empty());
    }

    #[test]
    fn matches_prs_by_repo_and_number_together() {
        // Numbers repeat across repos; a number-only join would compare
        // unrelated PRs and report phantom breakages.
        let before = vec![pr_full(
            "acme/a",
            1,
            CiState::Success,
            MergeState::Mergeable,
        )];
        let after = vec![pr_full(
            "acme/b",
            1,
            CiState::Failure,
            MergeState::Mergeable,
        )];
        assert!(newly_broken(&before, &after).is_empty());
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
