//! The Tauri command surface. React never talks to GitHub directly -- it
//! calls these commands and listens for the `prs-updated` event that
//! [`crate::poll`] emits in the background.

use crate::github::client::{ClientError, GitHubClient};
use crate::github::model::{
    CycleTrend, History, MergedDetail, Periods, PrDetail, PullRequest, Stats,
};
use crate::github::mutate::{PrAction, ReviewVerdict};
use crate::store::{load_snapshot, open_db, save_snapshot, settings, CachedList};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// DIAGNOSTIC COMMAND (Settings > diagnostic log).
///
/// Lets the frontend write into the same log file as the Rust side, so
/// one file shows the whole path in order: React deciding to fetch, the
/// command running, the HTTP request, and React settling. Without a
/// shared timeline the two halves cannot be lined up, and the open
/// question is precisely WHICH half the missing minute is in.
///
/// Takes an already-formatted line rather than structured fields: every
/// caller is in this repo and passes counts and timings only.
///
/// The line is dropped when diagnostics are off, so the frontend does
/// not need its own copy of the flag -- one source of truth for one
/// setting.
#[tauri::command]
pub fn diag_log(line: String) {
    // Truncated: a log line is not a channel for page content, and a
    // bounded length means a runaway caller cannot fill the disk.
    let line: String = line.chars().take(300).collect();
    crate::diag!("[diag][ui] {line}");
}

/// The cached snapshot, so the window paints real content at launch rather
/// than a spinner. Never talks to GitHub.
#[tauri::command]
pub fn get_cached(app: AppHandle) -> Result<Vec<PullRequest>, String> {
    // DIAGNOSTIC LOGGING (Settings > diagnostic log). Distinguishes a cold
    // cache (n=0, so the UI must wait on a live fetch) from a warm one,
    // which is the difference between "slow query" and "slow paint".
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    let out = load_snapshot(&conn, CachedList::Authored).map_err(|e| e.to_string());
    crate::diag!(
        "[diag] cmd get_cached {}",
        match &out {
            Ok(v) => format!("ok n={}", v.len()),
            Err(e) => format!("err: {e}"),
        }
    );
    out
}

/// A user-initiated, out-of-band fetch (e.g. a manual refresh button).
/// Does not touch the poll loop's cadence or its cached snapshot on disk.
#[tauri::command]
pub async fn refresh_now(client: State<'_, GhClient>) -> Result<Vec<PullRequest>, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    // Bounded like the poll loop's fetch. This is the COLD-START path --
    // `usePullRequests` calls it whenever the cache is empty, which is
    // exactly a fresh install -- and it had no overall timeout at all.
    //
    // The transport timeouts on the client are not enough on their own,
    // for the reason its own comment gives: a server that trickles bytes
    // keeps a read alive indefinitely without ever tripping one. With
    // `retry` enabled each attempt restarts them, so a machine that
    // cannot complete a handshake sat on "Loading pull requests" for
    // minutes rather than failing with something to act on.
    // DIAGNOSTIC LOGGING (Settings > diagnostic log).
    crate::diag!("[diag] cmd refresh_now start");
    let started = std::time::Instant::now();
    let out = match tokio::time::timeout(crate::poll::FETCH_TIMEOUT, client.fetch_prs()).await {
        Ok(res) => res.map_err(|e| e.to_string()),
        Err(_) => Err(ClientError::Timeout(crate::poll::FETCH_TIMEOUT.as_secs()).to_string()),
    };
    crate::diag!(
        "[diag] cmd refresh_now end {}ms {}",
        started.elapsed().as_millis(),
        match &out {
            Ok(v) => format!("ok n={}", v.len()),
            Err(e) => format!("err: {e}"),
        }
    );
    out
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

/// Apply an action to a pull request.
///
/// **The only command that writes to GitHub.** The read-only invariant
/// asserted elsewhere in this codebase is now "reads by default, writes
/// only on explicit user action" -- see `github::mutate`.
///
/// Confirmation is the UI's job, not this layer's: a command cannot show
/// a dialog, and putting the policy here would mean a caller that forgot
/// to confirm silently gets the destructive path anyway. What this DOES
/// guarantee is that every write is logged with repo, number and action,
/// so "did I merge that?" has an answer.
#[tauri::command]
pub async fn act_on_pr(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    id: String,
    repo: String,
    number: u64,
    action: String,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let act = parse_action(&action)?;

    match client.mutate_pr(&id, act).await {
        Ok(()) => {
            log::info!("{repo}#{number} {}", act.describe());
            // Refresh promptly rather than waiting out the poll interval:
            // the list would otherwise keep showing a PR as open for up
            // to two minutes after merging it.
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not be {}: {e}", act.describe());
            Err(e.to_string())
        }
    }
}

/// Re-run the failed jobs of a pull request's CI.
///
/// Takes the workflow RUN id, which the detail query now fetches per
/// check. One call re-runs every failed job in that run.
#[tauri::command]
pub async fn rerun_checks(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    repo: String,
    number: u64,
    run_id: u64,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    match client.rerun_failed_jobs(&repo, run_id).await {
        Ok(()) => {
            log::info!("{repo}#{number} failed checks re-run requested");
            // CI state changes as a result, so the list should catch up
            // rather than keep showing the old red until the next tick.
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not re-run checks: {e}");
            Err(e.to_string())
        }
    }
}

/// The platform this build is running on.
///
/// Compile-time constants, so this cannot disagree with the binary. Used
/// by the error report, where both diagnoses so far needed to know the
/// platform and neither could get it from the error text.
#[tauri::command]
pub fn build_target() -> (String, String) {
    (
        std::env::consts::OS.to_string(),
        std::env::consts::ARCH.to_string(),
    )
}

/// Who the token belongs to.
///
/// Cached forever by the caller: a login does not change during a
/// session. Used to tell the user's own pull requests from everyone
/// else's, which decides whether approving is even offered -- GitHub
/// refuses self-approval.
#[tauri::command]
pub async fn get_viewer(client: State<'_, GhClient>) -> Result<String, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    client.fetch_viewer().await.map_err(|e| e.to_string())
}

/// Submit a review on a pull request.
///
/// The first write path for a PR the user does not own. Body text is
/// validated HERE as well as in the UI: a command is a public surface,
/// and GitHub refusing an empty REQUEST_CHANGES after a round-trip is a
/// worse error than refusing it before one.
#[tauri::command]
pub async fn review_pr(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    id: String,
    repo: String,
    number: u64,
    verdict: String,
    body: String,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let v = parse_verdict(&verdict)?;
    if v.requires_body() && body.trim().is_empty() {
        return Err(format!(
            "GitHub requires a comment to {}.",
            match v {
                ReviewVerdict::RequestChanges => "request changes",
                _ => "leave a review comment",
            }
        ));
    }

    match client.add_review(&id, v, &body).await {
        Ok(()) => {
            // Never log the body: review text is the user's words about
            // someone else's work, and logs are not the place for it.
            log::info!("{repo}#{number} {}", v.describe());
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not be reviewed: {e}");
            Err(e.to_string())
        }
    }
}

/// Comment on a pull request.
#[tauri::command]
pub async fn comment_on_pr(
    client: State<'_, GhClient>,
    id: String,
    repo: String,
    number: u64,
    body: String,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    if body.trim().is_empty() {
        return Err("A comment cannot be empty.".to_string());
    }
    match client.add_comment(&id, &body).await {
        Ok(()) => {
            log::info!("{repo}#{number} commented");
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not be commented on: {e}");
            Err(e.to_string())
        }
    }
}

/// Resolve a review conversation.
///
/// `thread_id` is the THREAD's node id, not the pull request's -- a
/// different node from every other mutation command here.
#[tauri::command]
pub async fn resolve_thread(
    client: State<'_, GhClient>,
    thread_id: String,
    repo: String,
    number: u64,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    match client.resolve_thread(&thread_id).await {
        Ok(()) => {
            log::info!("{repo}#{number} resolved a conversation");
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not resolve a conversation: {e}");
            Err(e.to_string())
        }
    }
}

/// Reopen a resolved review conversation.
///
/// The undo for `resolve_thread`. Resolving is a single click and GitHub
/// offers no confirmation, so without this a mis-click could only be
/// corrected by leaving the app.
#[tauri::command]
pub async fn unresolve_thread(
    client: State<'_, GhClient>,
    thread_id: String,
    repo: String,
    number: u64,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    match client.unresolve_thread(&thread_id).await {
        Ok(()) => {
            log::info!("{repo}#{number} reopened a conversation");
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not reopen a conversation: {e}");
            Err(e.to_string())
        }
    }
}

/// Reply inside a review conversation.
///
/// Not `comment_on_pr`: that starts a new top-level comment, which would
/// strand the answer away from the code it is about.
#[tauri::command]
pub async fn reply_to_thread(
    client: State<'_, GhClient>,
    thread_id: String,
    repo: String,
    number: u64,
    body: String,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    // Matches `comment_on_pr`: GitHub accepts an empty reply and posts a
    // blank comment, which is never what the click meant.
    if body.trim().is_empty() {
        return Err("A reply cannot be empty.".to_string());
    }
    match client.reply_to_thread(&thread_id, &body).await {
        Ok(()) => {
            log::info!("{repo}#{number} replied to a conversation");
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} could not reply to a conversation: {e}");
            Err(e.to_string())
        }
    }
}

/// Map the frontend's verdict name onto the typed verdict.
fn parse_verdict(v: &str) -> Result<ReviewVerdict, String> {
    match v {
        "approve" => Ok(ReviewVerdict::Approve),
        "request_changes" => Ok(ReviewVerdict::RequestChanges),
        "comment" => Ok(ReviewVerdict::Comment),
        other => Err(format!("unknown review verdict: {other}")),
    }
}

/// Everything the detail view shows for one pull request.
///
/// Fetched on open rather than in the poll loop: it is per-PR and only
/// needed while the view is on screen.
/// Map the frontend's action name onto the typed action.
///
/// Shared by the single and batch commands so the two cannot drift into
/// accepting different sets of names -- the batch would otherwise reject
/// an action the kebab menu happily offers.
fn parse_action(action: &str) -> Result<PrAction, String> {
    match action {
        "merge" => Ok(PrAction::Merge),
        "close" => Ok(PrAction::Close),
        "reopen" => Ok(PrAction::Reopen),
        "draft" => Ok(PrAction::ConvertToDraft),
        "ready" => Ok(PrAction::MarkReady),
        "enqueue" => Ok(PrAction::Enqueue),
        "dequeue" => Ok(PrAction::Dequeue),
        other => Err(format!("unknown action: {other}")),
    }
}

/// One pull request's outcome in a batch.
///
/// `error` is `None` on success. A batch reports every outcome rather
/// than a single verdict: partial failure is the normal case here, not
/// the exception -- some mutations are rejected while others apply, and
/// a lone "done" would hide the rejections.
#[derive(Debug, serde::Serialize)]
pub struct BatchOutcome {
    pub repo: String,
    pub number: u64,
    pub error: Option<String>,
}

/// How many mutations may be in flight at once.
///
/// GitHub applies secondary rate limits to concurrent mutations, and a
/// batch is exactly the shape that trips them -- the premise of this
/// feature is that AI-assisted work produces *many* pull requests, so
/// forty at once is a realistic batch, not a pathological one. Four is
/// well inside the limit while still finishing a large batch promptly.
const BATCH_CONCURRENCY: usize = 4;

#[tauri::command]
/// Apply one action to several pull requests.
///
/// Deliberately not a loop over `act_on_pr` from the frontend: that
/// would fire every mutation at once and wake the poll loop once per
/// success. This bounds concurrency and wakes once at the end.
pub async fn act_on_prs(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    prs: Vec<(String, String, u64)>,
    action: String,
) -> Result<Vec<BatchOutcome>, String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let act = parse_action(&action)?;

    let mut outcomes = Vec::with_capacity(prs.len());
    for chunk in prs.chunks(BATCH_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for (id, repo, number) in chunk {
            let (client, id, repo, number) = (client.clone(), id.clone(), repo.clone(), *number);
            set.spawn(async move {
                let error = match client.mutate_pr(&id, act).await {
                    Ok(()) => {
                        log::info!("{repo}#{number} {}", act.describe());
                        None
                    }
                    Err(e) => {
                        log::warn!("{repo}#{number} could not be {}: {e}", act.describe());
                        Some(e.to_string())
                    }
                };
                BatchOutcome {
                    repo,
                    number,
                    error,
                }
            });
        }
        while let Some(res) = set.join_next().await {
            match res {
                Ok(o) => outcomes.push(o),
                // A panicked task must not vanish silently, or the batch
                // would report fewer outcomes than it was given and the
                // UI would show a PR as neither succeeded nor failed.
                Err(e) => return Err(format!("a batch task failed: {e}")),
            }
        }
    }

    // Once, at the end -- not per success, which would wake the poll loop
    // forty times for a forty-PR batch.
    waker.0.notify_one();
    Ok(outcomes)
}

#[tauri::command]
/// Merge the base branch into a pull request's head.
///
/// Separate from `act_on_pr` because it needs the head OID: GitHub
/// refuses if the branch moved since the caller last saw it, which turns
/// a stale click into a clear error instead of an update to a commit the
/// user never looked at.
pub async fn update_pr_branch(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    id: String,
    repo: String,
    number: u64,
    expected_head: String,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    match client.update_pr_branch(&id, &expected_head).await {
        Ok(()) => {
            log::info!("{repo}#{number} branch updated from base");
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} branch could not be updated: {e}");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
/// Merge this pull request when its checks pass.
///
/// Takes the head OID the row was rendered from. Auto-merge is a
/// DEFERRED write -- it fires unattended, later -- so without the guard
/// a push after enabling would merge a commit the user never saw.
/// Verified live: a stale OID is refused with "expected head oid does
/// not match the current head oid".
pub async fn set_auto_merge(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    id: String,
    repo: String,
    number: u64,
    expected_head: String,
    enable: bool,
) -> Result<(), String> {
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let result = if enable {
        client.enable_auto_merge(&id, &expected_head).await
    } else {
        client.disable_auto_merge(&id).await
    };
    match result {
        Ok(()) => {
            log::info!(
                "{repo}#{number} auto-merge {}",
                if enable { "enabled" } else { "disabled" }
            );
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} auto-merge change refused: {e}");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
/// Delete a merged pull request's head branch.
///
/// The `merged` flag is checked HERE, not trusted from the caller:
/// deleting the head ref of an OPEN pull request closes it off, and this
/// is the last place that can refuse. Measured demand: 31 of the last 60
/// merged PRs on a real account still held a live remote branch.
pub async fn delete_head_branch(
    client: State<'_, GhClient>,
    waker: State<'_, crate::poll::Waker>,
    ref_id: String,
    repo: String,
    number: u64,
    branch: String,
    merged: bool,
) -> Result<(), String> {
    if !merged {
        return Err("refusing to delete the branch of a pull request that has not merged".into());
    }
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    match client.delete_ref(&ref_id).await {
        Ok(()) => {
            log::info!("{repo}#{number} head branch {branch} deleted");
            waker.0.notify_one();
            Ok(())
        }
        Err(e) => {
            log::warn!("{repo}#{number} branch {branch} could not be deleted: {e}");
            Err(e.to_string())
        }
    }
}

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
    // Two failure modes, both real: the join can fail if the blocking
    // task panicked, and classification itself can fail if git refuses.
    // Flattened rather than swallowed, so an unreadable repo surfaces as
    // an error instead of as zero worktrees.
    tauri::async_runtime::spawn_blocking(move || crate::worktrees::classify_repo(&repo_path))
        .await
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
}

/// Regenerable build output under the configured scan roots.
///
/// Discovery only -- every `size_bytes` comes back None. The two passes
/// are separate because they differ by three orders of magnitude:
/// measured on a real 221 GB code tree, finding 178 directories takes
/// ~1.5s where sizing them takes ~56s. Blocking the view on the second
/// would repeat the "All repositories never populates" complaint that
/// shaped the worktree view.
#[tauri::command]
pub async fn scan_artifacts(app: AppHandle) -> Result<Vec<crate::artifacts::Artifact>, String> {
    // The SAME roots the worktree view scans. A second directory setting
    // would be one more thing to keep in sync, and a user who has told
    // the app where their code lives has already answered this question.
    let dirs = get_worktree_dirs(app);
    tauri::async_runtime::spawn_blocking(move || crate::artifacts::scan(&dirs))
        .await
        .map_err(|e| e.to_string())
}

/// Sizes for artifact directories, as `(path, bytes, secs_since_write)`.
///
/// Takes explicit paths rather than rescanning, so the caller measures
/// exactly what it is showing -- a rescan here could return a directory
/// the list does not have a row for.
///
/// `secs_since_write` rides along because the walk already stats every
/// entry: asking a second question of the same `metadata()` call is
/// free, and it is the ONLY signal that a build is currently writing
/// there. Build output is gitignored, so no git check can see it.
#[tauri::command]
pub async fn size_artifacts(paths: Vec<String>) -> Result<Vec<(String, u64, Option<u64>)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // DIAGNOSTIC LOGGING (Settings > diagnostic log). Per-directory,
        // for the same reason as `size_venvs`: the total says the batch
        // was slow, this says which entry made it slow.
        let started = std::time::Instant::now();
        let total = paths.len();
        let out: Vec<(String, u64, Option<u64>)> = paths
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let each = std::time::Instant::now();
                let (bytes, age) = crate::artifacts::measure(std::path::Path::new(&p));
                crate::diag!(
                    "[diag] size_artifacts {}/{} {}ms {}b",
                    i + 1,
                    total,
                    each.elapsed().as_millis(),
                    bytes
                );
                (p, bytes, age)
            })
            .collect();
        crate::diag!(
            "[diag] size_artifacts total {}ms n={total}",
            started.elapsed().as_millis()
        );
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Remove artifact directories, re-verifying each at delete time.
///
/// The scan roots are passed to the backend rather than trusted from the
/// caller: containment is the only thing between a bad path and
/// `remove_dir_all` on an arbitrary directory, so the boundary it checks
/// against must come from settings, not from the request.
#[tauri::command]
pub async fn remove_artifacts(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<crate::artifacts::ArtifactRemoval>, String> {
    let roots = get_worktree_dirs(app);
    // DIAGNOSTIC LOGGING (Settings > diagnostic log). This is the
    // BACKEND half of the freeze report: paired with the frontend's
    // `ui remove_artifacts` marks, it separates a slow `remove_dir_all`
    // from a slow render. The work is already off the event loop, so if
    // this number is small and the UI one is large, the cost is in the
    // frontend.
    let started = std::time::Instant::now();
    let count = paths.len();
    crate::diag!("[diag] remove_artifacts start n={count}");
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::artifacts::remove_artifacts(&paths, &roots)
    })
    .await
    .map_err(|e| e.to_string())?;
    crate::diag!(
        "[diag] remove_artifacts done {}ms n={count}",
        started.elapsed().as_millis()
    );
    let failed = out.iter().filter(|o| o.error.is_some()).count();
    log::info!(
        "artifact removal: {} of {} removed",
        out.len() - failed,
        out.len()
    );
    Ok(out)
}

/// Poetry virtualenvs, classified against every directory we can see.
///
/// Discovery only: sizes and idle times come from `size_venvs`, because
/// deciding staleness needs a full walk of each venv and the list should
/// paint before that finishes.
#[tauri::command]
pub async fn scan_venvs(app: AppHandle) -> Result<Vec<crate::caches::Venv>, String> {
    let roots = get_worktree_dirs(app);
    tauri::async_runtime::spawn_blocking(move || {
        let dirs = crate::caches::project_dirs(&roots);
        log::info!("venv scan: {} candidate project directories", dirs.len());
        crate::caches::scan_poetry(&dirs)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sizes and idle times, as `(path, bytes, idle_secs)`.
///
/// The idle time is the whole reason this is a second pass: it comes
/// from the DEEPEST file mtime, which needs the same walk as the size.
/// Poetry touches a venv's root without writing inside, so the
/// directory's own mtime reports a year-old venv as days old.
#[tauri::command]
pub async fn size_venvs(paths: Vec<String>) -> Result<Vec<(String, u64, Option<u64>)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // DIAGNOSTIC LOGGING (Settings > diagnostic log).
        //
        // PER-VENV, not just a total: these are walked serially in one
        // call, so a single pathological path -- a network mount, a
        // permission wall -- stalls every other row with nothing on
        // screen changing. A total says "slow"; this says WHICH.
        let started = std::time::Instant::now();
        let total = paths.len();
        let out: Vec<(String, u64, Option<u64>)> = paths
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let each = std::time::Instant::now();
                let (bytes, idle) = crate::caches::measure(std::path::Path::new(&p));
                crate::diag!(
                    "[diag] size_venvs {}/{} {}ms {}",
                    i + 1,
                    total,
                    each.elapsed().as_millis(),
                    // The basename, not the path: the full path is a
                    // project name on someone's disk.
                    std::path::Path::new(&p)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                );
                (p, bytes, idle)
            })
            .collect();
        crate::diag!(
            "[diag] size_venvs total {}ms n={}",
            started.elapsed().as_millis(),
            total
        );
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Remove Poetry virtualenvs, re-verifying each at delete time.
///
/// The project directories are re-walked HERE rather than taken from the
/// request: whether a venv is orphaned depends entirely on that set, and
/// a caller supplying a short one could turn any live venv into a
/// deletion candidate.
#[tauri::command]
pub async fn remove_venvs(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<crate::caches::VenvRemoval>, String> {
    // The policy is read from SETTINGS, never from the request. Whether
    // a stale venv may be removed is the user's standing decision, and a
    // caller that could pass its own would make the opt-in decorative.
    let prefs = get_ui_prefs(app.clone());
    let policy = crate::caches::RemovalPolicy {
        allow_stale: prefs.remove_stale_venvs,
        stale_days: crate::poll::stale_venv_days(&prefs),
    };
    let roots = get_worktree_dirs(app);
    let out = tauri::async_runtime::spawn_blocking(move || {
        let dirs = crate::caches::project_dirs(&roots);
        crate::caches::remove_venvs(&paths, &dirs, policy)
    })
    .await
    .map_err(|e| e.to_string())?;
    let failed = out.iter().filter(|o| o.error.is_some()).count();
    log::info!(
        "venv removal: {} of {} removed",
        out.len() - failed,
        out.len()
    );
    Ok(out)
}

/// Record that a human read an assessment for this worktree.
///
/// Split out of `claudify_command`, which used to do it as a side effect
/// of copying the prompt. That conflated "I asked for an assessment"
/// with "I read one" -- and the flag it sets is what unlocks removing a
/// worktree past the safety gate, which `remove_worktree_forced`
/// describes as needing "the record that a human looked at what would be
/// lost".
///
/// Keyed by the head OID it was assessed AT, so the mark expires the
/// moment the branch moves: a verdict about different commits is not a
/// verdict about these ones.
#[tauri::command]
pub fn mark_assessed(app: AppHandle, worktree_path: String) -> Result<(), String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    let mut seen: std::collections::BTreeMap<String, String> =
        settings::get(&conn, settings::keys::ASSESSED_WORKTREES)
            .ok()
            .flatten()
            .unwrap_or_default();
    let head = crate::worktrees::head_oid(&worktree_path)
        .map_err(|e| format!("could not read the worktree's head: {e}"))?;
    seen.insert(worktree_path, head);
    settings::set(&conn, settings::keys::ASSESSED_WORKTREES, &seen).map_err(|e| e.to_string())
}

/// Forget that a worktree was assessed.
///
/// The mark is what turns Claudify into "Remove anyway…", and it
/// persists across restarts -- so a single exploratory click removed the
/// only way to copy that worktree's prompt, permanently, until the
/// branch happened to move. This is the way back.
///
/// Removing a mark is the SAFE direction: it re-locks the force-removal
/// path rather than unlocking it, so it needs no confirmation of its
/// own.
#[tauri::command]
pub fn clear_assessed(app: AppHandle, worktree_path: String) -> Result<(), String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    let mut seen: std::collections::BTreeMap<String, String> =
        settings::get(&conn, settings::keys::ASSESSED_WORKTREES)
            .ok()
            .flatten()
            .unwrap_or_default();
    seen.remove(&worktree_path);
    settings::set(&conn, settings::keys::ASSESSED_WORKTREES, &seen).map_err(|e| e.to_string())
}

/// What automatic cleanup would remove, run now.
///
/// PREVIEW ONLY: `cleanup::propose` has no removal path, so this command
/// cannot delete regardless of what it is passed. That is the property
/// making Phase 1 reviewable on the predicate's merits alone.
///
/// Writes the result to the ledger before returning it, so the record
/// exists whether or not anyone is looking at the window when the pass
/// runs.
#[tauri::command]
pub async fn preview_cleanup(app: AppHandle) -> Result<Vec<crate::cleanup::LedgerEntry>, String> {
    let roots = get_worktree_dirs(app.clone());
    let db = db_path(&app);
    let now = chrono::Utc::now().to_rfc3339();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&db).map_err(|e| e.to_string())?;
        let prefs = crate::cleanup::prefs(&conn);
        let entries = crate::cleanup::propose(&prefs, &roots, &now);
        crate::cleanup::record(&conn, &entries);
        log::info!("cleanup preview: {} entries", entries.len());
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The cleanup ledger, newest first.
#[tauri::command]
pub fn cleanup_log(app: AppHandle) -> Result<Vec<crate::cleanup::LedgerEntry>, String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    crate::cleanup::recent(&conn, 200).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_cleanup_prefs(app: AppHandle) -> crate::cleanup::CleanupPrefs {
    open_db(&db_path(&app))
        .ok()
        .map(|c| crate::cleanup::prefs(&c))
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_cleanup_prefs(
    app: AppHandle,
    prefs: crate::cleanup::CleanupPrefs,
) -> Result<(), String> {
    // Remove mode is NOT accepted. The type carries the variant so the
    // ledger and settings shapes do not change in Phase 2, but nothing
    // in Phase 1 may store it -- a setting that does nothing is worse
    // than one that does not exist, because the user believes it.
    if prefs.mode == crate::cleanup::CleanupMode::Remove {
        return Err("automatic removal is not available yet; this build previews only".into());
    }
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    settings::set(&conn, settings::keys::CLEANUP_PREFS, &prefs).map_err(|e| e.to_string())
}

/// Which dependencies are out of date in one repository.
///
/// On demand, never on a timer: these commands hit package registries and
/// take seconds on a large tree. That is a per-repo click, not something
/// to do in the background across every repository.
#[tauri::command]
pub async fn check_packages(
    repo_path: String,
) -> Result<Vec<crate::packages::ProjectReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reports = crate::packages::run::check_repo(std::path::Path::new(&repo_path));
        // Counts only -- never package names, which would put a private
        // dependency list in a log meant to be shared.
        log::info!(
            "package check: {} projects, {} outdated",
            reports.len(),
            reports
                .iter()
                .flat_map(|p| &p.reports)
                .map(|r| r.outdated.len())
                .sum::<usize>()
        );
        reports
    })
    .await
    .map_err(|e| e.to_string())
}

/// The updates as markdown, for handing to an agent.
#[tauri::command]
pub fn packages_markdown(
    repo_path: String,
    reports: Vec<crate::packages::ProjectReport>,
    filter: crate::packages::markdown::Filter,
) -> String {
    crate::packages::markdown::render(&repo_path, &reports, filter)
}

/// Create a worktree and apply dependency updates in it.
///
/// Phase 1 of the update wizard: it does NOT push and does NOT open a
/// pull request. The worktree is left in place and its path is returned,
/// because what these package managers actually do to a checkout is the
/// thing being found out.
///
/// The FIRST command in this app that runs a package manager in a mode
/// that writes, which is why it carries the same care the destructive
/// git paths do.
#[tauri::command]
pub async fn apply_package_updates(
    repo_path: String,
    requests: Vec<crate::packages::apply::UpdateRequest>,
) -> Result<crate::packages::apply::RunReport, String> {
    let repo = repo_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::packages::apply::run(std::path::Path::new(&repo), &requests)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Logged with the repository and branch, so "where did that
    // worktree come from?" has an answer -- the same reason
    // `remove_worktree` logs.
    match &result {
        Ok(r) => log::info!(
            "applied {} update(s) in {} on branch {}",
            r.results.len(),
            r.worktree,
            r.branch
        ),
        Err(e) => log::warn!("update run in {repo_path} refused: {e}"),
    }
    result
}

/// Every CLAUDE.md in a repository, with its import tree resolved.
#[tauri::command]
pub async fn scan_claude_md(repo_path: String) -> Result<Vec<crate::claudemd::ClaudeFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::claudemd::scan_repo(std::path::Path::new(&repo_path))
    })
    .await
    .map_err(|e| e.to_string())
}

/// The text of one file, for rendering.
///
/// Read fresh rather than carried in the scan: the scan holds every file
/// in a repository, and shipping all of their contents to the frontend
/// to display one is a lot of bytes crossing the bridge for nothing.
#[tauri::command]
pub fn read_claude_md(path: String) -> Result<String, String> {
    // No containment check because there is no write here and no
    // deletion -- this reads a path the user picked from a list the app
    // produced. The risk a containment check guards against elsewhere
    // (`remove_dir_all` on an arbitrary path) does not exist for a read.
    std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))
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

/// Fast-forward a checkout to its upstream.
///
/// The FIRST command that writes to a local checkout, so it carries the
/// same care the destructive ones do: it refuses on a dirty tree, it
/// fast-forwards only, and it returns git's own refusal rather than a
/// generic message. `pull_checkout` re-checks the state itself rather
/// than trusting the scan.
#[tauri::command]
pub async fn pull_checkout(path: String) -> Result<String, String> {
    let p = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || crate::worktrees::pull_checkout(&p))
        .await
        .map_err(|e| e.to_string())?;

    match &result {
        Ok(_) => log::info!("updated checkout {path}"),
        Err(e) => log::warn!("refused to update checkout {path}: {e}"),
    }
    result
}

/// Delete an orphaned worktree directory.
///
/// Separate from `remove_worktree` because git cannot do it: the
/// repository that owned the checkout is gone, so there is nothing to
/// run `git worktree remove` against. That makes it a plain recursive
/// delete, and `remove_orphan` re-derives orphan status itself rather
/// than trusting this call.
#[tauri::command]
pub async fn remove_orphan(path: String) -> Result<(), String> {
    let p = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || crate::worktrees::remove_orphan(&p))
        .await
        .map_err(|e| e.to_string())?;

    match &result {
        Ok(()) => log::info!("removed orphaned worktree {path}"),
        Err(e) => log::warn!("refused to remove orphan {path}: {e}"),
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
    crate::auth::home_dir()
        .map(|h| h.join("code"))
        .filter(|p| p.is_dir())
        .map(|p| vec![p.to_string_lossy().into_owned()])
        .unwrap_or_default()
}

/// Replace the scanned directories.
///
/// Non-existent paths are rejected rather than stored: a typo should fail
/// visibly here, not silently produce an empty worktrees view later.
#[tauri::command]
/// Build history: what was built, how long it took, and how much came
/// from cache.
///
/// The context and revision ARE resolved here, in parallel.
///
/// They were not, and that was a silent bug: `parse_history` hardcodes
/// `context: None, revision: None`, and `enrich` -- the only thing that
/// fills them -- was called from exactly one place, an `#[ignore]`d
/// test. `buildForImage` filters on `b.revision &&`, so with revision
/// always null the build fold in the expanded image row NEVER rendered.
/// The tests passed because the fixture injects a synthetic revision.
///
/// So the "half that mattered" kept from the retired Builds page (#365)
/// was never actually delivered, which is why the Docker surface reads
/// as having little to say.
///
/// Parallel because `inspect` is a subprocess: MEASURED at ~2s per
/// record serially, which blew a two-minute timeout across fifty
/// records. Eight workers mirrors `CLASSIFY_WORKERS` in the worktree
/// scanner, whose author measured 12 and 16 as REGRESSIONS -- the number
/// is empirical, not a core count.
pub fn docker_builds() -> Result<Vec<crate::docker::Build>, String> {
    const ENRICH_WORKERS: usize = 8;

    let mut builds = crate::docker::docker(&["buildx", "history", "ls", "--format", "{{json .}}"])
        .map(|out| crate::docker::parse_history(&out))?;

    let chunk = builds.len().div_ceil(ENRICH_WORKERS).max(1);
    std::thread::scope(|scope| {
        for part in builds.chunks_mut(chunk) {
            scope.spawn(move || {
                for b in part {
                    crate::docker::enrich(b);
                }
            });
        }
    });

    Ok(builds)
}

#[tauri::command]
/// Whether Docker can be talked to.
///
/// A stopped daemon is a state, not an error: reporting it as a failure
/// -- or as an empty image list -- would say the machine is clean when
/// the truth is that we could not ask.
pub fn docker_state() -> crate::docker::DockerState {
    crate::docker::state()
}

#[tauri::command]
/// Images with provenance and in-use resolved.
///
/// Resolved against the same directories the worktrees view scans, so a
/// machine configured once works for both.
pub fn docker_images(app: AppHandle) -> Result<Vec<crate::docker::Image>, String> {
    let dirs = get_worktree_dirs(app);
    // EXPANDED into repositories, not passed as scan roots.
    //
    // `classify` resolves a SHA-shaped image tag by running git in each
    // path it is given, so handing it `~/code` asked git about a
    // directory that is not a repository -- every lookup failed, no
    // image resolved an origin, and the whole Docker page's provenance
    // was silently empty. MEASURED on a real machine: 0 of 24 images
    // resolved an origin with the roots, against 20 of 26 with the
    // repositories.
    //
    // `scan_dirs_fast` is the same expansion the Worktrees view uses,
    // which is why that view worked and this one did not.
    let repos: Vec<std::path::PathBuf> = crate::worktrees::scan_dirs_fast(&dirs)
        .into_iter()
        .map(|r| std::path::PathBuf::from(r.path))
        .collect();
    crate::docker::classify(&repos)
}

#[tauri::command]
/// Where the disk actually went. Images are only part of it.
pub fn docker_disk_usage() -> Result<crate::docker::DiskUsage, String> {
    crate::docker::docker(&["system", "df"]).map(|out| crate::docker::disk_usage(&out))
}

#[tauri::command]
/// Remove images by ID, reporting each independently.
///
/// In-use is re-checked per image at removal time, not trusted from the
/// listing: a container may have started since.
pub fn docker_remove_images(ids: Vec<String>) -> Vec<crate::docker::RemovalOutcome> {
    let outcomes = crate::docker::remove_images(&ids);
    let failed = outcomes.iter().filter(|o| o.error.is_some()).count();
    log::info!(
        "docker: removed {} of {} images",
        outcomes.len() - failed,
        outcomes.len()
    );
    outcomes
}

#[tauri::command]
/// Volumes attached to nothing.
pub fn docker_dangling_volumes() -> Result<Vec<crate::docker::DanglingVolume>, String> {
    crate::docker::dangling_volumes()
}

#[tauri::command]
/// Remove one volume. Never bulk: a wrongly deleted volume costs data,
/// where a wrongly deleted image costs a rebuild.
pub fn docker_remove_volume(name: String) -> Result<(), String> {
    log::warn!("docker: removing volume {name}");
    crate::docker::remove_volume(&name)
}

#[tauri::command]
/// Clear build cache, returning what was actually freed.
pub fn docker_prune_cache(until: Option<String>) -> Result<u64, String> {
    let freed = crate::docker::prune_build_cache(until.as_deref())?;
    log::info!("docker: build cache prune freed {freed} bytes");
    Ok(freed)
}

#[tauri::command]
/// Containers a restart would stop, so the confirmation can name them.
pub fn docker_running_containers() -> Result<Vec<String>, String> {
    crate::docker::running_containers()
}

#[tauri::command]
/// Restart the Docker engine.
pub fn docker_restart() -> Result<(), String> {
    log::warn!("docker: restarting the engine");
    crate::docker::restart_engine()
}

#[tauri::command]
/// Start a stopped engine.
pub fn docker_start() -> Result<(), String> {
    crate::docker::start_engine()
}

#[tauri::command]
/// Remove several worktrees, reporting each one's outcome.
///
/// The per-worktree safety gate is unchanged: this is N safe deletions,
/// not one bulk deletion. Each is re-checked at delete time, so a
/// worktree that went dirty since the scan is refused while the rest
/// proceed.
pub async fn remove_worktrees(
    app: AppHandle,
    repo_path: String,
    worktree_paths: Vec<String>,
) -> Result<Vec<crate::worktrees::RemovalOutcome>, String> {
    // `spawn_blocking`, unlike the previous version. Removal is
    // sequential git plumbing at a few hundred milliseconds each, so
    // ~100 worktrees blocked the async runtime for about 30 seconds --
    // which also stalled the poll loop and every other command. The
    // single-worktree command already did this; the bulk one, which
    // blocks far longer, did not.
    tauri::async_runtime::spawn_blocking(move || {
        let outcomes = crate::worktrees::remove_worktrees_with_progress(
            &repo_path,
            &worktree_paths,
            |done, total| {
                // Counts only -- never paths. A progress event is not a
                // place to leak what the user is working on.
                let _ = app.emit("worktree-removal-progress", (done, total));
            },
        );
        let failed = outcomes.iter().filter(|o| o.error.is_some()).count();
        log::info!(
            "bulk removal: {} of {} removed",
            outcomes.len() - failed,
            outcomes.len()
        );
        outcomes
    })
    .await
    .map_err(|e| format!("bulk removal failed to run: {e}"))
}

#[tauri::command]
/// Remove a worktree the safety gate refuses.
///
/// Reached only from a confirmation the user opened after reading an
/// assessment of this specific worktree. The flag is not a convenience:
/// it is the record that a human looked at what would be lost.
pub async fn remove_worktree_forced(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
) -> Result<(), String> {
    crate::worktrees::remove_worktree_forced(&repo_path, &worktree_path)?;
    // Drop the mark: the worktree is gone, so keeping it would leave a
    // stale entry that outlives the thing it described.
    if let Ok(conn) = open_db(&db_path(&app)) {
        let mut seen: std::collections::BTreeMap<String, String> =
            settings::get(&conn, settings::keys::ASSESSED_WORKTREES)
                .ok()
                .flatten()
                .unwrap_or_default();
        if seen.remove(&worktree_path).is_some() {
            let _ = settings::set(&conn, settings::keys::ASSESSED_WORKTREES, &seen);
        }
    }
    log::warn!("{worktree_path} removed past the safety gate");
    Ok(())
}

/// Everything the app already knows about one worktree's unmerged work.
///
/// `claudify_command` has always computed this whole struct and then
/// discarded all of it except a shell string -- so the app could say
/// "+240/-18 across 11 files, 4 commits ahead, last touched 3 weeks
/// ago" and instead asked the user to leave, paste a command into a
/// terminal, and wait for an agent to rediscover it.
///
/// `canClaudify` counts 124 of 268 worktrees in that state, which is the
/// largest single group. Claude Code stays for the genuine judgment
/// calls; these numbers triage the easy majority first.
///
/// `spawn_blocking`: several git calls per worktree, and it is opened
/// per row rather than per scan.
#[tauri::command]
pub async fn assess_worktree(
    repo_path: String,
    worktree_path: String,
    branch: String,
) -> Result<crate::worktrees::Assessment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktrees::assess(&repo_path, &worktree_path, &branch)
    })
    .await
    .map_err(|e| format!("could not assess this worktree: {e}"))
}

#[tauri::command]
/// The shell command that hands a worktree to Claude Code.
///
/// Returns text for the clipboard rather than spawning anything.
/// Spawning a terminal is not portable: macOS has no default-terminal
/// concept at all (no LaunchServices handler exists, so a machine with
/// both Terminal.app and iTerm gives no way to know which the user
/// wants), and on Linux `x-terminal-emulator` is Debian-only while
/// `gio open` on a shell script opens an editor. The clipboard works
/// identically everywhere and lands the user in their OWN shell.
///
/// It also sidesteps PATH: `claude` lives in `~/.local/bin`, outside a
/// GUI app's PATH, but the pasted command runs in a login shell where it
/// resolves fine.
pub fn claudify_command(
    repo_path: String,
    worktree_path: String,
    branch: String,
) -> ClaudifyCommand {
    let facts = crate::worktrees::assess(&repo_path, &worktree_path, &branch);
    // Fall back to the bare name: the command is going to a login shell,
    // which resolves it even when this process could not.
    let claude = crate::auth::find_claude();
    let installed = claude.is_some();
    let bin = claude
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "claude".to_string());

    // NOTE: copying the command deliberately does NOT record an
    // assessment.
    //
    // It used to. The mark gates "Remove anyway…", and `commands.rs`
    // describes that flag as "the record that a human looked at what
    // would be lost" -- but copying a prompt is the START of an
    // assessment, not the end of one. Marking here armed a force-remove
    // button on a worktree nobody had actually read a verdict for, and
    // it did so seconds later when the query refetched, swapping a
    // narrow "Claudify" for a wide "Remove anyway…" and re-flowing every
    // column in the table.
    //
    // `mark_assessed` is what records it, called once the user says they
    // have read the result.

    ClaudifyCommand {
        command: facts.command(&bin),
        claude_installed: installed,
    }
}

#[tauri::command]
/// Worktrees that have been assessed and are still at the head they were
/// assessed at.
///
/// A branch that has moved since is dropped: the assessment described a
/// different state, and offering an override on a stale verdict is
/// exactly the mistake this feature could otherwise introduce.
pub fn assessed_worktrees(app: AppHandle) -> Vec<String> {
    let Ok(conn) = open_db(&db_path(&app)) else {
        return Vec::new();
    };
    let seen: std::collections::BTreeMap<String, String> =
        settings::get(&conn, settings::keys::ASSESSED_WORKTREES)
            .ok()
            .flatten()
            .unwrap_or_default();

    seen.into_iter()
        .filter(|(path, oid)| crate::worktrees::head_oid(path).is_ok_and(|current| &current == oid))
        .map(|(path, _)| path)
        .collect()
}

/// The clipboard payload, plus whether Claude Code was actually found.
///
/// `claude_installed` is advisory only: the command is copied either way,
/// because a user may be pasting it on another machine.
#[derive(Debug, serde::Serialize)]
pub struct ClaudifyCommand {
    pub command: String,
    pub claude_installed: bool,
}

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
/// The newest published release, when it is newer than this build.
///
/// Distribution is dmg/exe/deb/AppImage, so no package manager carries
/// updates -- a user who installed a version with a launch-blocking bug
/// had no mechanism at all to discover the fix. That is not
/// hypothetical: v1.0.0 never left the splash screen on a second
/// machine, and v2.0.0 emptied both PR views on upgrade.
///
/// Unauthenticated and cheap: the releases endpoint needs no token, and
/// this runs once at startup rather than on the poll loop.
pub async fn latest_release(app: AppHandle) -> Option<String> {
    // The RUNTIME version, not CARGO_PKG_VERSION. The release workflow
    // stamps the tag into the manifests at build time and never commits
    // them, so the compiled-in constant reads 0.1.0 in a dev build and
    // would report every release as an update.
    let current = app.package_info().version.to_string();
    // Through the authenticated client, which already exists -- rather
    // than adding an HTTP dependency for one request. The endpoint is
    // public, so this works whether or not the token has any scopes.
    let json: serde_json::Value = octocrab::instance()
        .get("/repos/pktstorm/headstate/releases/latest", None::<&()>)
        .await
        .ok()?;
    let tag = json.get("tag_name")?.as_str()?.trim_start_matches('v');

    // A plain inequality, not a semver comparison. The published tag is
    // the only thing that ever appears here, and a wrong answer costs a
    // spurious "update available" rather than anything harmful -- where
    // pulling in a semver crate for one string compare would not repay
    // itself.
    (tag != current && !current.is_empty()).then(|| tag.to_string())
}

#[tauri::command]
pub fn get_poll_interval(state: State<'_, crate::poll::PollInterval>) -> u64 {
    state.0.load(std::sync::atomic::Ordering::Relaxed)
}

/// Which desktop notifications the user wants.
///
/// Absent means everything on, matching what the app did before this
/// setting existed -- an upgrade must not silently mute a feature.
#[tauri::command]
pub fn get_notify_prefs(app: AppHandle) -> crate::poll::NotifyPrefs {
    open_db(&db_path(&app))
        .ok()
        .and_then(|c| crate::store::settings::get(&c, settings::keys::NOTIFY_PREFS).ok())
        .flatten()
        .unwrap_or_default()
}

/// Interface preferences.
#[tauri::command]
pub fn get_ui_prefs(app: AppHandle) -> crate::poll::UiPrefs {
    read_ui_prefs(&app)
}

/// Read interface preferences, or the defaults if unreadable.
///
/// Shared with the window event handler, which needs
/// `close_hides_to_tray` and runs outside any command. Every failure
/// path returns the default, which is the app's pre-existing behaviour:
/// a database problem must not silently start QUITTING an app the user
/// expects to hide.
pub fn read_ui_prefs(app: &AppHandle) -> crate::poll::UiPrefs {
    open_db(&db_path(app))
        .ok()
        .and_then(|c| crate::store::settings::get(&c, settings::keys::UI_PREFS).ok())
        .flatten()
        .unwrap_or_default()
}

/// Whether the app is registered to start at login.
///
/// Asked of the OS rather than stored: the user can disable it from
/// System Settings, and a stored flag would then disagree with reality.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Register or unregister start-at-login.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let res = if enabled { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| e.to_string())?;
    log::info!("start at login: {enabled}");
    Ok(())
}

/// Change interface preferences.
#[tauri::command]
pub fn set_ui_prefs(app: AppHandle, prefs: crate::poll::UiPrefs) -> Result<(), String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    crate::store::settings::set(&conn, settings::keys::UI_PREFS, &prefs)
        .map_err(|e| e.to_string())?;
    // Applied immediately rather than at the next launch. Someone who
    // just ticked the box to capture a problem should get the log for
    // the problem they are currently reproducing, not the next one.
    crate::diag::set_enabled(prefs.diagnostic_logging);
    log::info!(
        "ui: {} view(s) hidden, close_hides_to_tray={}, diagnostics={}",
        prefs.hidden_views.len(),
        prefs.close_hides_to_tray,
        prefs.diagnostic_logging
    );
    Ok(())
}

/// Change which desktop notifications are sent.
///
/// No waker: the poll loop reads this per tick, so the next poll picks it
/// up without being nudged. Unlike the poll interval there is nothing
/// in-memory to update -- the loop is the only reader.
#[tauri::command]
pub fn set_notify_prefs(app: AppHandle, prefs: crate::poll::NotifyPrefs) -> Result<(), String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    crate::store::settings::set(&conn, settings::keys::NOTIFY_PREFS, &prefs)
        .map_err(|e| e.to_string())?;
    // Counts only -- which repos break is not a setting and not logged.
    log::info!(
        "notifications: enabled={} ci={} conflicts={}",
        prefs.enabled,
        prefs.ci_failed,
        prefs.conflicted
    );
    Ok(())
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

/// How many pull requests await the user's review.
///
/// The sidebar badge needs a number on EVERY view, including ones that
/// show no pull requests. Asking for the count rather than the list
/// costs 1 rate-limit point against 6, and ~0.9s against ~4s.
#[tauri::command]
pub async fn count_reviewing(client: State<'_, GhClient>) -> Result<u64, String> {
    // DIAGNOSTIC LOGGING (Settings > diagnostic log). Cheap and runs on every
    // view, so it doubles as a liveness check: if the badge count keeps
    // returning quickly while the list hangs, the account and token are
    // fine and the problem is specific to the heavy query.
    let started = std::time::Instant::now();
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let out = client.count_reviewing().await.map_err(|e| e.to_string());
    crate::diag!(
        "[diag] cmd count_reviewing {}ms {:?}",
        started.elapsed().as_millis(),
        out
    );
    out
}

/// The cached review list, so To review paints real content instead of
/// an empty panel while the live query runs.
///
/// Never talks to GitHub -- the mirror of `get_cached` for the other
/// list. The query it stands in for takes ~20s on a 60-PR queue and
/// cannot be made meaningfully faster (see #328), so the only way to
/// stop the user staring at nothing is to have something to show.
#[tauri::command]
pub fn get_cached_reviewing(app: AppHandle) -> Result<Vec<PullRequest>, String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    let out = load_snapshot(&conn, CachedList::Reviewing).map_err(|e| e.to_string());
    crate::diag!(
        "[diag] cmd get_cached_reviewing {}",
        match &out {
            Ok(v) => format!("ok n={}", v.len()),
            Err(e) => format!("err: {e}"),
        }
    );
    out
}

#[tauri::command]
pub async fn get_reviewing(
    app: AppHandle,
    client: State<'_, GhClient>,
) -> Result<Vec<PullRequest>, String> {
    // DIAGNOSTIC LOGGING (Settings > diagnostic log). Brackets the whole
    // command, so the log distinguishes the three ways To review can
    // appear stuck: the command was never invoked (no start line), it
    // is still running (a start with no end), or it returned promptly
    // and the delay is in the frontend (a fast start/end pair).
    crate::diag!("[diag] cmd get_reviewing start");
    let started = std::time::Instant::now();
    let client = client.0.clone().ok_or_else(|| AUTH_ERR.to_string())?;
    let out = client
        .fetch_reviewing_with_shortfall()
        .await
        .map(|(prs, short)| {
            // Tell the UI when the list is SHORT. The 100 -> 50 fallback
            // returns fewer pull requests than exist and everything
            // downstream presented that as complete -- the v3.5.3 log
            // caught 50 shown against a count of 62, with twelve gone
            // silently. Emitted even when zero, so a recovered fetch
            // clears a banner an earlier one raised.
            if let Err(e) = app.emit("reviewing-short", short) {
                log::warn!("failed to emit reviewing-short: {e}");
            }
            // Cache it, so the next visit to To review paints from disk
            // instead of waiting out the query again. The measurements
            // on #328 are what make this the fix: the query itself
            // cannot be made fast (a bare 25-item search already costs
            // 6.2s, and trimming fields measured as noise), so the win
            // has to come from not blocking on it.
            //
            // A failed write is logged and swallowed: the caller has
            // real pull requests in hand, and refusing to return them
            // because a cache write failed would turn a slow path into
            // a broken one.
            match open_db(&db_path(&app)) {
                Ok(conn) => {
                    if let Err(e) = save_snapshot(&conn, CachedList::Reviewing, &prs) {
                        log::warn!("could not cache the review list: {e}");
                    }
                }
                Err(e) => log::warn!("could not open the store to cache the review list: {e}"),
            }
            prs
        })
        .map_err(|e| e.to_string());
    crate::diag!(
        "[diag] cmd get_reviewing end {}ms {}",
        started.elapsed().as_millis(),
        match &out {
            Ok(v) => format!("ok n={}", v.len()),
            Err(e) => format!("err: {e}"),
        }
    );
    out
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
    /// #336: `docker_builds` must actually ENRICH.
    ///
    /// `parse_history` hardcodes `context: None, revision: None`, and
    /// `buildForImage` filters on `b.revision &&`. So a `docker_builds`
    /// that forgets to call `enrich` compiles, passes every other test,
    /// and silently renders no build information at all -- which is
    /// exactly what shipped.
    ///
    /// Asserted on the SOURCE because the behaviour needs a Docker
    /// daemon with build records, which CI has neither of. A source
    /// check is weak, but the alternative here was no check, and this
    /// bug survived precisely because nothing looked.
    #[test]
    fn docker_builds_enriches_rather_than_returning_bare_history() {
        let src = include_str!("commands.rs");
        let start = src
            .find("pub fn docker_builds()")
            .expect("docker_builds not found");
        let body = &src[start..start + 1200];
        assert!(
            body.contains("enrich"),
            "docker_builds must enrich, or context and revision stay null \
             and the build fold never renders"
        );
    }

    /// Every verdict the frontend can name must map, and nothing else
    /// may. A typo in the UI must fail loudly here rather than silently
    /// submitting the wrong verdict on someone else's pull request.
    #[test]
    fn verdict_names_round_trip_and_reject_anything_else() {
        assert_eq!(parse_verdict("approve").unwrap(), ReviewVerdict::Approve);
        assert_eq!(
            parse_verdict("request_changes").unwrap(),
            ReviewVerdict::RequestChanges
        );
        assert_eq!(parse_verdict("comment").unwrap(), ReviewVerdict::Comment);
        assert!(
            parse_verdict("APPROVE").is_err(),
            "casing must not slip through"
        );
        assert!(
            parse_verdict("dismiss").is_err(),
            "dismiss is deliberately unreachable"
        );
        assert!(parse_verdict("").is_err());
    }

    use super::*;

    /// Both commands must accept exactly the same action names. If they
    /// drift, the batch rejects an action the kebab menu offers -- a
    /// failure that only shows up when a user selects rows and acts.
    #[test]
    fn every_offered_action_parses() {
        for name in [
            "merge", "close", "reopen", "draft", "ready", "enqueue", "dequeue",
        ] {
            assert!(parse_action(name).is_ok(), "{name} should parse");
        }
    }

    /// An unknown action names itself in the error, so a typo in the
    /// frontend is diagnosable from the message alone.
    #[test]
    fn an_unknown_action_is_named_in_the_error() {
        let err = parse_action("frobnicate").unwrap_err();
        assert!(err.contains("frobnicate"), "got: {err}");
    }

    /// A batch is issued in chunks, never all at once: GitHub applies
    /// secondary rate limits to concurrent mutations, and the premise of
    /// this feature is that AI-assisted work produces *many* pull
    /// requests, so a forty-PR batch is realistic rather than
    /// pathological. Asserting on the const alone would be vacuous
    /// (clippy says so), so this exercises the chunking the command
    /// actually performs.
    #[test]
    fn a_large_batch_is_issued_in_bounded_chunks() {
        let batch: Vec<u64> = (0..40).collect();
        let chunks: Vec<_> = batch.chunks(BATCH_CONCURRENCY).collect();

        assert!(
            chunks.iter().all(|c| c.len() <= BATCH_CONCURRENCY),
            "no chunk may exceed the concurrency bound"
        );
        assert!(
            chunks.len() > 1,
            "a 40-PR batch must be split, not fired at once"
        );
        // Every pull request is issued exactly once -- a chunking bug
        // that dropped or duplicated one would report the wrong outcomes.
        assert_eq!(chunks.concat(), batch);
    }

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
