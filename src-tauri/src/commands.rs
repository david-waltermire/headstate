//! The Tauri command surface. React never talks to GitHub directly -- it
//! calls these commands and listens for the `prs-updated` event that
//! [`crate::poll`] emits in the background.

use crate::github::client::GitHubClient;
use crate::github::model::{
    CycleTrend, History, MergedDetail, Periods, PrDetail, PullRequest, Stats,
};
use crate::github::mutate::{PrAction, ReviewVerdict};
use crate::store::{load_snapshot, open_db, settings};
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
/// The context and revision are NOT resolved here: `inspect` is a
/// subprocess per build, and fetching it for fifty builds up front would
/// make the page slow for data only the selected build needs.
pub fn docker_builds() -> Result<Vec<crate::docker::Build>, String> {
    crate::docker::docker(&["buildx", "history", "ls", "--format", "{{json .}}"])
        .map(|out| crate::docker::parse_history(&out))
}

#[tauri::command]
/// The build context and revision for one build, resolved on demand.
pub fn docker_build_detail(reference: String) -> Result<crate::docker::Build, String> {
    let out = crate::docker::docker(&["buildx", "history", "ls", "--format", "{{json .}}"])?;
    let mut build = crate::docker::parse_history(&out)
        .into_iter()
        .find(|b| b.reference == reference)
        .ok_or_else(|| "that build is no longer in history".to_string())?;
    crate::docker::enrich(&mut build);
    Ok(build)
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
    let repos: Vec<std::path::PathBuf> = dirs.iter().map(std::path::PathBuf::from).collect();
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
    app: AppHandle,
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

    // Record what was assessed, keyed by the head it was assessed AT.
    // Without this the user comes back from a "safe to discard" verdict
    // and has to find the row again among 124 candidates.
    if let Ok(conn) = open_db(&db_path(&app)) {
        let mut seen: std::collections::BTreeMap<String, String> =
            settings::get(&conn, settings::keys::ASSESSED_WORKTREES)
                .ok()
                .flatten()
                .unwrap_or_default();
        if let Ok(head) = crate::worktrees::head_oid(&worktree_path) {
            seen.insert(worktree_path.clone(), head);
            let _ = settings::set(&conn, settings::keys::ASSESSED_WORKTREES, &seen);
        }
    }

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
    log::info!(
        "ui: {} view(s) hidden, close_hides_to_tray={}",
        prefs.hidden_views.len(),
        prefs.close_hides_to_tray
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
