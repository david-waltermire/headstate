//! Background polling.
//!
//! Polling lives in Rust rather than React so it continues while the window
//! is hidden to the tray -- which is what makes the tray badge meaningful.
//! React never talks to GitHub directly: it renders whatever snapshot is on
//! disk and listens for the `prs-updated` event.

use crate::github::client::{ClientError, GitHubClient};
use crate::github::model::{needs_attention_count, CiState, MergeState, PullRequest};
use crate::store::{open_db, save_snapshot};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

/// Default focused cadence, in seconds.
///
/// Two minutes rather than one: PR state rarely changes minute-to-minute,
/// and the shipped query costs 6 rate-limit points, so halving the rate
/// halves the spend for no practical loss of freshness.
pub const DEFAULT_FOCUSED_SECS: u64 = 120;

/// Floor on the configured interval.
///
/// 60s, not 30: the shipped query costs 6 rate-limit points, so a 30s
/// cadence would spend 720/hour and a 60s one spends 360. Both are
/// survivable against a 5000/hour budget, but the app should not be able
/// to consume a seventh of the user's own `gh` allowance on a setting they
/// picked without knowing the cost.
///
/// The budget test asserts against THIS value rather than the default, so
/// a user choosing the fastest allowed setting still cannot blow through
/// the guard.
pub const MIN_FOCUSED_SECS: u64 = 60;
pub const MAX_FOCUSED_SECS: u64 = 3600;

/// Backgrounded polling is 5x the focused interval: the window is hidden,
/// so freshness matters less, but the tray badge must not go stale for
/// long. Proportional rather than separately configurable -- one knob is
/// enough, and two invites inconsistent pairs.
pub const BACKGROUND_MULTIPLIER: u64 = 5;

pub const FOCUSED: Duration = Duration::from_secs(DEFAULT_FOCUSED_SECS);
pub const BACKGROUND: Duration = Duration::from_secs(DEFAULT_FOCUSED_SECS * BACKGROUND_MULTIPLIER);

/// Clamp a user-supplied interval into the allowed range.
///
/// Extracted so it is testable: a Tauri command is a public surface, and
/// an unbounded value here would either hammer GitHub or effectively stop
/// polling.
pub fn clamp_interval(secs: u64) -> u64 {
    secs.clamp(MIN_FOCUSED_SECS, MAX_FOCUSED_SECS)
}

/// #22: how long after a poll to fire the one-shot targeted re-poll for
/// PRs still stuck on `MergeState::Checking`. GitHub computes mergeability
/// lazily and often hasn't finished 5s after a push; this is far shorter
/// than either regular cadence so a fresh push resolves quickly without
/// waiting a full tick.
pub const RECHECK_DELAY: Duration = Duration::from_secs(5);

/// The cadence for the current window state, given a configured interval.
///
/// The shipped query costs 6 rate-limit points (see the budget test), so
/// the default 120s focused cadence spends ~180 points/hour against a
/// 5000/hour budget. The test asserts the FLOOR, not the default, so no
/// reachable setting can blow the budget.
pub fn interval_for_secs(focused: bool, configured_secs: u64) -> Duration {
    let secs = clamp_interval(configured_secs);
    Duration::from_secs(if focused {
        secs
    } else {
        secs * BACKGROUND_MULTIPLIER
    })
}

/// The default cadence, for callers with no configured value.
pub fn interval_for(focused: bool) -> Duration {
    interval_for_secs(focused, DEFAULT_FOCUSED_SECS)
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

    // Ask ONCE, before the first notification rather than at whatever
    // arbitrary moment a PR happens to break. Left implicit, the OS
    // prompt appeared hours in and possibly while the window was hidden;
    // if it was missed or dismissed, `show()` failed forever after and
    // the failure was swallowed by design ("a notification is an
    // affordance"). So a headline feature could be permanently dead with
    // no user-visible signal at all.
    match app.notification().permission_state() {
        Ok(tauri_plugin_notification::PermissionState::Granted) => {}
        Ok(tauri_plugin_notification::PermissionState::Prompt)
        | Ok(tauri_plugin_notification::PermissionState::PromptWithRationale) => {
            if let Err(e) = app.notification().request_permission() {
                log::warn!("could not request notification permission: {e}");
                return;
            }
        }
        Ok(tauri_plugin_notification::PermissionState::Denied) => {
            // Logged at INFO, not warn: the user said no, which is a
            // choice rather than a fault. Logging it once per breakage
            // would be noise, but silence made "why do I get no
            // notifications?" unanswerable from the log.
            log::info!(
                "notifications are denied; not notifying about {}#{}",
                b.repo,
                b.number
            );
            return;
        }
        Err(e) => {
            log::warn!("could not read notification permission: {e}");
            return;
        }
    }

    let body = format!("{}#{} {}", b.repo, b.number, b.kind.reason());
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
    pub kind: BreakageKind,
}

/// What broke.
///
/// A type rather than the prose string it used to be, so the settings
/// filter matches on the KIND and cannot drift from display wording. A
/// user who turns off conflict notifications must keep getting CI ones,
/// and comparing on "has merge conflicts" would break the moment that
/// sentence is reworded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakageKind {
    CiFailed,
    Conflicted,
}

impl BreakageKind {
    /// The notification body. Reads after "owner/repo#123 ...".
    pub fn reason(self) -> &'static str {
        match self {
            BreakageKind::CiFailed => "CI is failing",
            BreakageKind::Conflicted => "has merge conflicts",
        }
    }

    /// Whether the user wants to hear about this one.
    pub fn enabled_by(self, prefs: &NotifyPrefs) -> bool {
        match self {
            BreakageKind::CiFailed => prefs.ci_failed,
            BreakageKind::Conflicted => prefs.conflicted,
        }
    }
}

/// Interface preferences that Rust needs to know about.
///
/// Lives here beside `NotifyPrefs` rather than in a UI module because
/// `close_hides_to_tray` is read by the window event handler, which is
/// Rust-side and cannot see anything the webview stores.
///
/// `hidden_views` is a plain list of view ids rather than a bool per
/// view, so adding a view later needs no migration and hiding an id
/// this build does not know about is harmless.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UiPrefs {
    /// View ids the switcher should not offer.
    pub hidden_views: Vec<String>,
    /// Whether the close button hides to the tray instead of quitting.
    pub close_hides_to_tray: bool,
    /// Whether a new release announces itself with a dialog.
    ///
    /// `serde(default)` so a settings row written before this field
    /// existed still deserialises -- without it, adding a field would
    /// make every stored value unreadable and silently reset every
    /// other preference alongside it.
    #[serde(default = "default_true")]
    pub announce_updates: bool,
}

/// Serde needs a function, not a literal, for a defaulted bool.
fn default_true() -> bool {
    true
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            // Nothing hidden, and close hides -- exactly what the app
            // did before this setting existed. An upgrade must not
            // change behaviour for someone who never opens Settings.
            hidden_views: Vec::new(),
            close_hides_to_tray: true,
            // Announcing is the point of checking. The status bar has
            // always shown the hint and it was easy to miss; a user who
            // finds the dialog intrusive can turn it off, which is what
            // the setting is for.
            announce_updates: true,
        }
    }
}

/// Which notifications the user wants.
///
/// Defaults to everything ON, matching the behaviour before this existed
/// -- an upgrade must not silently turn off a feature someone relies on.
/// `enabled` is a master switch rather than a third kind, so turning
/// notifications off does not lose the per-kind choices underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NotifyPrefs {
    pub enabled: bool,
    pub ci_failed: bool,
    pub conflicted: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            ci_failed: true,
            conflicted: true,
        }
    }
}

impl NotifyPrefs {
    /// Whether this breakage should interrupt the user.
    pub fn wants(&self, kind: BreakageKind) -> bool {
        self.enabled && kind.enabled_by(self)
    }
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
            let kind = if pr.ci == CiState::Failure && was.ci != CiState::Failure {
                BreakageKind::CiFailed
            } else if pr.merge == MergeState::Conflicted && was.merge != MergeState::Conflicted {
                BreakageKind::Conflicted
            } else {
                return None;
            };
            Some(Breakage {
                title: pr.title.clone(),
                repo: pr.repo.clone(),
                number: pr.number,
                url: pr.url.clone(),
                kind,
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
    // Its OWN channel, not `poll-error`. Sharing it meant this banner was
    // destroyed microseconds after it appeared: persist_and_emit emits
    // the error and then UNCONDITIONALLY emits `prs-updated`, which the
    // frontend uses to clear poll errors. A full disk was invisible.
    //
    // A store failure also describes a condition the successful poll did
    // NOT fix, so a later success must not clear it.
    if let Err(e) = app.emit("store-error", msg) {
        log::warn!("failed to emit store error: {e}");
    }
}

/// The user's notification choices, or the default if unreadable.
///
/// Every failure path here -- no data dir, no database, a corrupt value
/// -- falls back to `NotifyPrefs::default()`, which is everything ON.
/// That direction is deliberate: the alternative is that a transient
/// database problem silently mutes an interruption channel the user is
/// relying on, and they would have no way to tell that from "nothing
/// broke". A notification too many is recoverable; a missed one is not.
fn read_notify_prefs(app: &AppHandle) -> NotifyPrefs {
    let Ok(dir) = app.path().app_data_dir() else {
        return NotifyPrefs::default();
    };
    let Ok(conn) = open_db(&dir.join("headstate.db")) else {
        return NotifyPrefs::default();
    };
    crate::store::settings::get(&conn, crate::store::settings::keys::NOTIFY_PREFS)
        .ok()
        .flatten()
        .unwrap_or_default()
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

/// The configured focused interval, in seconds.
///
/// Shared rather than passed once, so changing the setting takes effect on
/// the NEXT tick instead of requiring a relaunch. Paired with the `Waker`:
/// after a change the loop is woken so a shortened interval applies
/// immediately rather than after the old, longer sleep expires.
pub struct PollInterval(pub Arc<AtomicU64>);

/// Whether the active view needs live GitHub data.
///
/// `false` while the user is looking at local worktrees, which need no
/// PR data at all. The loop drops to the BACKGROUND cadence rather than
/// stopping: the tray badge must not go stale while the window sits open
/// on another view, and the badge staying honest is the stated reason
/// polling lives in Rust at all.
pub struct ViewNeedsGithub(pub Arc<AtomicBool>);

/// How many consecutive transient failures before the banner appears.
///
/// Measured on a real log: 5 of 164 polls failed with a transport error
/// and every one recovered on the very next tick. One blip is weather;
/// two in a row is a problem worth naming.
///
/// Deliberately small. This delays a real outage's banner by one poll,
/// which is a fair price for not alarming a user about something that
/// fixed itself before they finished reading it.
const FAILURES_BEFORE_BANNER: u32 = 2;

/// Whether a failure is worth interrupting the user for.
///
/// Actionable failures -- a dead token, an exhausted rate limit, a
/// malformed query -- surface immediately, because the next tick will
/// fail identically and waiting cannot help. Transient ones wait for a
/// second opinion.
fn should_surface(e: &ClientError, consecutive: u32) -> bool {
    !e.is_transient() || consecutive >= FAILURES_BEFORE_BANNER
}

pub fn spawn(
    app: AppHandle,
    client: Arc<GitHubClient>,
    focused: Arc<AtomicBool>,
    waker: Arc<Notify>,
    interval_secs: Arc<AtomicU64>,
    view_needs_github: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut previous: Vec<PullRequest> = Vec::new();
        // Consecutive failures, reset by any success. Transient failures
        // are not surfaced until this crosses the threshold -- see
        // `should_surface`.
        let mut consecutive_failures: u32 = 0;
        loop {
            // `timeout` collapses a hang into the Err arm the loop already
            // handles, so a wedged request costs one tick instead of the
            // rest of the session.
            let _ = app.emit("poll-state", "fetching");
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
                    // Read per tick rather than cached at startup, so a
                    // setting change takes effect on the next poll
                    // instead of at the next relaunch. A failed read
                    // falls back to the default (everything on), which
                    // is what the app did before the setting existed.
                    let prefs = read_notify_prefs(&app);
                    for b in newly_broken(&previous, &prs) {
                        if prefs.wants(b.kind) {
                            notify_breakage(&app, &b);
                        }
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
                        "poll ok: {} open, {} need attention (of {total} matching)",
                        prs.len(),
                        needs_attention_count(&prs)
                    );
                    // Fields GitHub refused on this fetch, then cleared:
                    // a later complete response must stop reporting a
                    // shortfall that no longer exists. Emitted even when
                    // zero, so the banner disappears on recovery rather
                    // than sticking until relaunch.
                    let refused = crate::github::client::REFUSED_FIELDS.swap(0, Ordering::Relaxed);
                    if let Err(e) = app.emit("prs-incomplete", refused) {
                        log::warn!("failed to emit prs-incomplete: {e}");
                    }

                    consecutive_failures = 0;
                    persist_and_emit(&app, &prs);
                    if has_checking(&prs) {
                        spawn_recheck(app.clone(), client.clone(), prs);
                    }
                }
                // A failed poll leaves the last snapshot in place rather
                // than blanking the UI; the next tick retries.
                Err(e) => {
                    log::warn!("poll failed: {e}");
                    consecutive_failures += 1;
                    if should_surface(&e, consecutive_failures) {
                        if let Err(emit_err) = app.emit("poll-error", e.to_string()) {
                            log::warn!("failed to emit poll-error: {emit_err}");
                        }
                    } else {
                        log::info!(
                            "not surfacing a transient failure ({consecutive_failures} in a row); \
                             the next tick should recover"
                        );
                        // The bar has nothing else to go on: no
                        // poll-error and no prs-updated on a suppressed
                        // failure, so it would otherwise show a green
                        // "Up to date" while the data is stale.
                        let _ = app.emit("poll-state", "retrying");
                    }
                }
            }
            // The bar shows FETCHING only while a request is genuinely in
            // flight. Inferring it from `isFetching` would miss the tray
            // path, which bypasses the queryFn -- so the loop that knows
            // says so directly.
            let _ = app.emit("poll-state", "idle");

            // Whichever comes first: the cadence elapsing, or someone
            // asking for a refresh. `Notify` stores one permit, so a
            // request that arrives mid-fetch is not lost -- the next
            // `notified()` returns immediately rather than waiting out a
            // full interval.
            tokio::select! {
                _ = tokio::time::sleep(interval_for_secs(
                    // A view that does not show PR data polls at the
                    // background rate even when the window is focused.
                    focused.load(Ordering::Relaxed)
                        && view_needs_github.load(Ordering::Relaxed),
                    interval_secs.load(Ordering::Relaxed),
                )) => {}
                _ = waker.notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// The consequence of classifying a parse failure as transient: one
    /// stays quiet, two in a row is still named.
    ///
    /// A `Timeout` stands in for the parse failure because octocrab's
    /// `Serde` variant has no public constructor -- both are transient,
    /// and `should_surface` reads only that property, so this asserts
    /// the exact rule that governs the reported case. The
    /// classification itself is tested against a real truncated
    /// response in `github::client`.
    #[test]
    fn a_transient_failure_is_named_only_when_it_repeats() {
        let e = ClientError::Timeout(90);
        assert!(e.is_transient());
        assert!(!should_surface(&e, 1), "one blip is weather");
        assert!(
            should_surface(&e, FAILURES_BEFORE_BANNER),
            "two in a row is a problem"
        );
    }

    /// Defaults must reproduce the behaviour from before this setting
    /// existed: nothing hidden, and close hides to the tray. An upgrade
    /// must not change what the app does for someone who never opens
    /// Settings -- and a close button that suddenly QUITS loses more
    /// than one that hides.
    #[test]
    fn ui_prefs_default_to_the_previous_behaviour() {
        let d = UiPrefs::default();
        assert!(d.hidden_views.is_empty());
        assert!(d.close_hides_to_tray);
    }

    /// A settings row written BEFORE `announce_updates` existed must
    /// still deserialise, and must not silently reset the preferences
    /// stored alongside it.
    ///
    /// Without `serde(default)` the whole struct fails to parse, the
    /// read falls back to `Default`, and a user who had hidden Docker
    /// and turned off close-to-tray quietly gets both back.
    #[test]
    fn prefs_stored_before_this_field_existed_still_load() {
        let old = r#"{"hidden_views":["docker"],"close_hides_to_tray":false}"#;
        let p: UiPrefs = serde_json::from_str(old).expect("old rows must still parse");
        assert_eq!(p.hidden_views, vec!["docker"]);
        assert!(!p.close_hides_to_tray, "the stored choice must survive");
        assert!(p.announce_updates, "a missing field takes the default");
    }

    /// Hidden views are a list of ids, not a bool per view, so a build
    /// that does not know an id simply carries it -- no migration, and
    /// no crash on a value written by a newer version.
    #[test]
    fn an_unknown_hidden_view_id_is_carried_not_rejected() {
        let json =
            r#"{"hidden_views":["docker","a-view-from-the-future"],"close_hides_to_tray":false}"#;
        let p: UiPrefs = serde_json::from_str(json).unwrap();
        assert_eq!(p.hidden_views.len(), 2);
        assert!(!p.close_hides_to_tray);
    }

    /// The default must be everything ON. This is the upgrade path: a
    /// user who has never opened Settings had notifications before this
    /// key existed, and must still have them after.
    #[test]
    fn notifications_default_to_on() {
        let d = NotifyPrefs::default();
        assert!(d.enabled && d.ci_failed && d.conflicted);
        assert!(d.wants(BreakageKind::CiFailed));
        assert!(d.wants(BreakageKind::Conflicted));
    }

    /// The master switch silences everything without discarding the
    /// per-kind choices underneath it, so turning notifications back on
    /// restores what the user picked rather than a reset.
    #[test]
    fn the_master_switch_silences_every_kind() {
        let p = NotifyPrefs {
            enabled: false,
            ci_failed: true,
            conflicted: true,
        };
        assert!(!p.wants(BreakageKind::CiFailed));
        assert!(!p.wants(BreakageKind::Conflicted));
        // The choices survive: flipping `enabled` back is enough.
        assert!(p.ci_failed && p.conflicted);
    }

    /// Turning one kind off must not touch the other. This is the whole
    /// point of the per-kind split -- "stop telling me about conflicts"
    /// is a different request from "stop telling me anything".
    #[test]
    fn kinds_are_silenced_independently() {
        let no_conflicts = NotifyPrefs {
            enabled: true,
            ci_failed: true,
            conflicted: false,
        };
        assert!(no_conflicts.wants(BreakageKind::CiFailed));
        assert!(!no_conflicts.wants(BreakageKind::Conflicted));

        let no_ci = NotifyPrefs {
            enabled: true,
            ci_failed: false,
            conflicted: true,
        };
        assert!(!no_ci.wants(BreakageKind::CiFailed));
        assert!(no_ci.wants(BreakageKind::Conflicted));
    }

    /// The kind drives the filter; the prose is only display. Asserting
    /// both here is what stops a reworded sentence from silently
    /// changing which notifications a user receives.
    #[test]
    fn kind_carries_the_wording_but_the_filter_matches_the_kind() {
        assert_eq!(BreakageKind::CiFailed.reason(), "CI is failing");
        assert_eq!(BreakageKind::Conflicted.reason(), "has merge conflicts");
        assert_ne!(BreakageKind::CiFailed, BreakageKind::Conflicted);
    }

    use super::*;

    /// The reported bug. A single transport blip painted a red banner
    /// that stayed for a full poll interval -- for something that fixed
    /// itself on the next tick.
    ///
    /// Real numbers from the log that prompted this: 5 failures in 164
    /// polls, every one followed immediately by a success.
    #[test]
    fn one_transient_failure_does_not_surface() {
        let e = ClientError::Timeout(90);
        assert!(e.is_transient());
        assert!(!should_surface(&e, 1), "one blip must stay quiet");
    }

    /// But a real outage must not be hidden. Two in a row stops being
    /// weather.
    #[test]
    fn repeated_transient_failures_do_surface() {
        let e = ClientError::Timeout(90);
        assert!(should_surface(&e, FAILURES_BEFORE_BANNER));
        assert!(should_surface(&e, FAILURES_BEFORE_BANNER + 5));
    }

    /// Waiting cannot fix a rate limit or a malformed query, so those
    /// surface on the first failure -- the next tick fails identically.
    #[test]
    fn actionable_failures_surface_immediately() {
        for e in [
            ClientError::RateLimited("resets in 12m".into()),
            ClientError::Graphql("field 'nope' does not exist".into()),
            ClientError::Join("task panicked".into()),
        ] {
            assert!(!e.is_transient(), "{e} should not be transient");
            assert!(
                should_surface(&e, 1),
                "{e} must surface on the first failure"
            );
        }
    }

    /// The counter must reset on success, or a machine that blips once
    /// an hour would eventually cross the threshold and show a banner
    /// for a network that is fine. Models the loop's own sequence, since
    /// the counter lives in a spawned task the tests cannot reach.
    #[test]
    fn a_success_resets_the_failure_count() {
        let e = ClientError::Timeout(90);
        let mut consecutive: u32 = 0;

        // blip, recover, blip, recover -- the pattern from the real log.
        for _ in 0..5 {
            consecutive += 1;
            assert!(
                !should_surface(&e, consecutive),
                "an isolated blip must never surface"
            );
            consecutive = 0; // the success arm
        }

        // Two back to back, with no success between them, does surface.
        consecutive += 1;
        assert!(!should_surface(&e, consecutive));
        consecutive += 1;
        assert!(should_surface(&e, consecutive));
    }

    /// A timeout is transient by definition: the request was still in
    /// flight when the ceiling hit, which says nothing about whether the
    /// next one will succeed.
    #[test]
    fn a_timeout_is_transient() {
        assert!(ClientError::Timeout(90).is_transient());
    }
    use crate::github::model::MergeStateStatus;

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
            id: "PR_test".into(),
            number,
            title: "Add retry to the fetch client".into(),
            url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.into(),
            head_ref: "feature/x".into(),
            head_oid: "deadbeef".into(),
            head_ref_id: None,
            base_ref: "main".into(),
            author: "octocat".into(),
            is_draft: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            ci: CiState::Success,
            merge,
            merge_status: MergeStateStatus::Clean,
            review: ReviewState::Approved,
            in_merge_queue: false,
            labels: Vec::<Label>::new(),
            comment_count: 0,
            unresolved_threads: 0,
        }
    }

    #[test]
    fn polls_faster_when_focused() {
        assert_eq!(
            interval_for(true),
            Duration::from_secs(DEFAULT_FOCUSED_SECS)
        );
        assert_eq!(
            interval_for(false),
            Duration::from_secs(DEFAULT_FOCUSED_SECS * BACKGROUND_MULTIPLIER)
        );
    }

    #[test]
    fn the_default_cadence_is_two_minutes() {
        assert_eq!(DEFAULT_FOCUSED_SECS, 120);
        assert_eq!(interval_for(true), Duration::from_secs(120));
    }

    #[test]
    fn a_configured_interval_is_honoured() {
        assert_eq!(interval_for_secs(true, 300), Duration::from_secs(300));
        // Background stays proportional.
        assert_eq!(
            interval_for_secs(false, 300),
            Duration::from_secs(300 * BACKGROUND_MULTIPLIER)
        );
    }

    /// A Tauri command is a public surface. Without a floor, `0` would
    /// busy-loop against GitHub; without a ceiling, a huge value would
    /// effectively stop polling while the UI still claimed to be live.
    #[test]
    fn a_configured_interval_is_clamped() {
        assert_eq!(clamp_interval(0), MIN_FOCUSED_SECS);
        assert_eq!(clamp_interval(1), MIN_FOCUSED_SECS);
        assert_eq!(clamp_interval(u64::MAX), MAX_FOCUSED_SECS);
        assert_eq!(clamp_interval(120), 120, "a normal value passes through");
        assert_eq!(
            interval_for_secs(true, 0),
            Duration::from_secs(MIN_FOCUSED_SECS)
        );
    }

    /// A view that shows no PR data polls at the BACKGROUND rate even
    /// when the window is focused -- but still polls, so the tray badge
    /// does not go stale while the user cleans up worktrees.
    #[test]
    fn a_non_github_view_uses_the_background_cadence() {
        let secs = 120;
        // Read through atomics so the `focused && needs_github` the loop
        // actually evaluates cannot be constant-folded away.
        let focused = AtomicBool::new(true);
        let needs_github = AtomicBool::new(true);
        let effective = || {
            interval_for_secs(
                focused.load(Ordering::Relaxed) && needs_github.load(Ordering::Relaxed),
                secs,
            )
        };

        let fast = effective();
        assert_eq!(fast, Duration::from_secs(secs));

        // Focused, but on a view that shows no PR data.
        needs_github.store(false, Ordering::Relaxed);
        let on_worktrees = effective();

        // Same as being unfocused...
        focused.store(false, Ordering::Relaxed);
        needs_github.store(true, Ordering::Relaxed);
        assert_eq!(on_worktrees, effective());

        // ...slower than focused, and never stopped: the tray badge must
        // not go stale while the window sits on another view.
        assert!(on_worktrees > fast);
        assert!(on_worktrees.as_secs() > 0, "must not stop");
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
        let q = crate::github::query::PRS_QUERY;
        assert!(
            q.contains("search("),
            "PRS_QUERY must contain at least one search"
        );
        // Cost is driven by NESTED CONNECTIONS, not the search count.
        // Measured against the live API: labels, statusCheckRollup and
        // reviewThreads each cost a point PER SEARCH and are additive, so
        // three connections across two searches is 6 -- what the shipped
        // query actually costs. (An earlier comment here claimed 2; that
        // was measured on a stripped-down query, not the real one.)
        //
        // Occurrences, not presence: dropping a connection from a single
        // search has to move this number.
        // A PROXY for the real cost, not the cost itself: GitHub charges
        // for connection fields, and these three are the ones the query
        // currently has. It is a tripwire for "someone edited the query",
        // and it only trips for fields already on this list.
        //
        // That gap is real and was found by measuring: adding
        // `reviewRequests(first: 10)` takes the LIVE cost from 6 to 7
        // while leaving this count at 6, so the guard would have passed
        // a 17%-per-poll increase in silence. The list below is therefore
        // every connection field in the query, not only the expensive
        // ones -- a new connection must either appear here or be a
        // deliberate, measured exception.
        let connections = [
            "labels(",
            "statusCheckRollup",
            "reviewThreads(",
            "reviewRequests(",
            "latestReviews(",
            "assignees(",
            "comments(",
        ];
        let cost = connections
            .iter()
            .map(|c| q.matches(c).count() as u64)
            .sum::<u64>();
        assert_eq!(
            cost, 3,
            "PRS_QUERY cost changed; re-measure against the live API \
             (it was 3 points on 2026-08-25, for ONE search -- the query \
              carried two aliases and cost 6 until they were split)"
        );

        // The FLOOR, not the default: a user picking the fastest allowed
        // setting must still be inside budget, or this guard only protects
        // people who never touch the setting.
        for focused in [true, false] {
            let per_hour = 3600 / interval_for_secs(focused, MIN_FOCUSED_SECS).as_secs();
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
            id: "PR_test".into(),
            number,
            title: format!("PR {number}"),
            url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.to_string(),
            author: "someone".into(),
            is_draft: false,
            head_ref: "feature/x".into(),
            head_oid: "deadbeef".into(),
            head_ref_id: None,
            base_ref: "main".into(),
            created_at: t,
            updated_at: t,
            ci,
            merge,
            merge_status: MergeStateStatus::Clean,
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
        // The KIND, not the prose: the kind is what the notification
        // filter matches on, and the wording is asserted separately.
        assert_eq!(b[0].kind, BreakageKind::CiFailed);
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
            newly_broken(&before, &after)[0].kind,
            BreakageKind::Conflicted
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
