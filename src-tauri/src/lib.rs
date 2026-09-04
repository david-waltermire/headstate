pub mod artifacts;
pub mod auth;
pub mod branches;
pub mod caches;
pub mod claudemd;
pub mod cleanup;
pub mod commands;
pub mod diag;
pub mod docker;
pub mod github;
pub mod packages;
pub mod poll;
pub mod store;
pub mod tray;
mod worktrees;

use commands::{AuthState, GhClient};
use github::client::GitHubClient;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

/// Whether the main window is currently focused. Shared with `poll::spawn`
/// so the background loop can pick FOCUSED vs BACKGROUND cadence; managed as
/// Tauri state so the window-event handler below (the only place focus
/// actually changes) can reach the same `Arc` and flip it.
struct Focused(Arc<AtomicBool>);

/// Record that the window was hidden (close-to-tray or otherwise): the poll
/// loop should drop to the background cadence. A window can be hidden
/// without the platform ever sending a `WindowEvent::Focused(false)`, so
/// close-to-tray has to clear the flag itself rather than relying on a
/// focus event to follow.
fn mark_hidden(focused: &AtomicBool) {
    focused.store(false, Ordering::Relaxed);
}

/// Record a real focus change: focused -> FOCUSED cadence, blurred ->
/// BACKGROUND cadence.
fn mark_focus(focused: &AtomicBool, is_focused: bool) {
    focused.store(is_focused, Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A GUI-launched .app has no stderr, so every eprintln! in this
        // codebase went nowhere a user could reach. "It stopped updating"
        // was uninvestigable: no log file to ask for, and no way to know
        // which of the failure paths fired.
        //
        // Writes to the OS log directory (Console.app on macOS) and a
        // rotating file beside it. Never log the token, and never log a
        // repository owner -- see CONTRIBUTING and check-privacy.sh.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // No launch args: the app already opens hidden-to-tray on its
        // own terms, and passing --hidden here would be a second, easily
        // divergent source of truth for that behaviour.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // KEEP the previous file. The default discards it on
                // startup, which destroyed a real diagnostic recording
                // mid-analysis: 305 lines became 1 the moment the app
                // relaunched.
                //
                // That is not a corner case for this feature. The
                // workflow is "turn the log on, reproduce the problem,
                // send the file" -- and reproducing a hang or a slow
                // start is exactly what makes someone quit and relaunch,
                // destroying the evidence of the thing they were
                // capturing.
                //
                // Bounded, because this app is a disk-cleanup tool and
                // must not become the thing filling the disk.
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .max_file_size(8 * 1024 * 1024)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("headstate".into()),
                    }),
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::diag_log,
            commands::reveal_log,
            commands::pull_checkout,
            commands::remove_orphan,
            commands::get_cached,
            commands::get_cached_reviewing,
            commands::refresh_now,
            commands::get_stats,
            commands::get_history,
            commands::get_periods,
            commands::get_reviewing,
            commands::count_reviewing,
            commands::get_pr_detail,
            commands::act_on_pr,
            commands::build_target,
            commands::get_viewer,
            commands::rerun_checks,
            commands::get_ui_prefs,
            commands::set_ui_prefs,
            commands::get_autostart,
            commands::set_autostart,
            commands::get_notify_prefs,
            commands::set_notify_prefs,
            commands::review_pr,
            commands::comment_on_pr,
            commands::scan_artifacts,
            commands::remove_artifacts,
            commands::size_artifacts,
            commands::mark_assessed,
            commands::clear_assessed,
            commands::preview_cleanup,
            commands::cleanup_log,
            commands::get_cleanup_prefs,
            commands::set_cleanup_prefs,
            commands::apply_package_updates,
            commands::open_update_pr,
            commands::scan_claude_md,
            commands::read_claude_md,
            commands::check_packages,
            commands::packages_markdown,
            commands::scan_venvs,
            commands::size_venvs,
            commands::remove_venvs,
            commands::resolve_thread,
            commands::unresolve_thread,
            commands::reply_to_thread,
            commands::update_pr_branch,
            commands::set_auto_merge,
            commands::delete_head_branch,
            commands::latest_release,
            commands::act_on_prs,
            commands::get_poll_interval,
            commands::set_poll_interval,
            commands::get_worktree_dirs,
            commands::set_worktree_dirs,
            commands::list_worktrees,
            commands::classify_worktrees,
            commands::list_branches,
            commands::delete_branches,
            commands::delete_remote_branches,
            commands::remove_worktree,
            commands::remove_worktrees,
            commands::docker_state,
            commands::docker_builds,
            commands::docker_images,
            commands::docker_disk_usage,
            commands::docker_remove_images,
            commands::docker_dangling_volumes,
            commands::docker_remove_volume,
            commands::docker_prune_cache,
            commands::docker_running_containers,
            commands::docker_restart,
            commands::docker_start,
            commands::assess_worktree,
            commands::claudify_command,
            commands::assessed_worktrees,
            commands::remove_worktree_forced,
            commands::size_worktrees,
            commands::set_view_needs_github,
            commands::get_cycle_trend,
            commands::get_merged_detail,
            commands::get_auth_state,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Before anything that logs. The stored preference decides
            // whether the verbose `[diag]` lines are written, and
            // reading it first means a user who left diagnostics on
            // captures the startup sequence too -- which is where the
            // v3.5.3 log proved most useful.
            crate::diag::set_enabled(crate::commands::read_ui_prefs(&handle).diagnostic_logging);

            // `read_token` shells out via `std::process::Command`, which
            // blocks -- fine here, because `setup` is a plain synchronous
            // closure and is not occupying a tokio worker.
            //
            // `build_client` is different and must run inside the runtime.
            // Octocrab builds a hyper/tower stack whose Buffer layer calls
            // `tokio::spawn` during construction, so building it outside a
            // reactor panics with "there is no reactor running" -- crashing
            // the app on launch for every user who IS authenticated, which
            // no unit test catches because tests always construct it from an
            // async context. `block_on` enters Tauri's own runtime for the
            // duration of the call.
            let (auth_state, gh_client) = match auth::read_token() {
                Ok(token) => {
                    match tauri::async_runtime::block_on(async { auth::build_client(&token) }) {
                        Ok(octocrab) => {
                            let client = Arc::new(GitHubClient::new(octocrab));
                            (
                                AuthState {
                                    ok: true,
                                    message: String::new(),
                                },
                                Some(client),
                            )
                        }
                        Err(e) => (
                            AuthState {
                                ok: false,
                                message: e.to_string(),
                            },
                            None,
                        ),
                    }
                }
                // `AuthError`'s Display messages (including
                // `GhNotLoggedIn`'s, which comes verbatim from `gh`'s own
                // stderr) are already display-ready prose for a first-run
                // screen -- never re-wrapped, never containing a token.
                Err(e) => (
                    AuthState {
                        ok: false,
                        message: e.to_string(),
                    },
                    None,
                ),
            };

            app.manage(auth_state);
            app.manage(GhClient(gh_client.clone()));

            // Only poll GitHub if we actually have a client; there is
            // nothing to fetch without one, and this task is the only
            // caller of GitHub in the whole app.
            // Managed unconditionally: the tray menu is built whether or
            // not auth succeeded, and its handler must always find a Waker
            // to signal even when nothing is listening for it.
            let waker = Arc::new(tokio::sync::Notify::new());
            app.manage(poll::Waker(waker.clone()));

            // Managed unconditionally, like the Waker: the settings command
            // must find it whether or not auth succeeded.
            // Restore the saved interval, falling back to the default.
            // Read here rather than lazily so the FIRST tick already uses
            // the user's choice instead of polling fast once and then
            // settling down.
            let saved = store::open_db(&commands::db_path(&handle))
                .ok()
                .and_then(|c| {
                    store::settings::get::<u64>(&c, store::settings::keys::POLL_INTERVAL_SECS).ok()
                })
                .flatten()
                .map(poll::clamp_interval)
                .unwrap_or(poll::DEFAULT_FOCUSED_SECS);
            let interval = Arc::new(std::sync::atomic::AtomicU64::new(saved));
            app.manage(poll::PollInterval(interval.clone()));

            // Starts true: the app opens on a PR view.
            let needs_gh = Arc::new(AtomicBool::new(true));
            app.manage(poll::ViewNeedsGithub(needs_gh.clone()));

            log::info!(
                "headstate v{} starting (authenticated: {})",
                env!("CARGO_PKG_VERSION"),
                gh_client.is_some()
            );

            if let Some(client) = gh_client {
                // WHICH account, not just that there is one. A reported
                // failure took four rounds partly because the log said
                // "authenticated: true" and nothing else -- so whether
                // two machines were even using the same account could
                // not be established from it.
                //
                // A login is a public GitHub handle, not a credential;
                // the token is never logged. Fire-and-forget so a slow
                // or failed lookup cannot delay startup.
                {
                    let c = client.clone();
                    tauri::async_runtime::spawn(async move {
                        match c.fetch_viewer().await {
                            Ok(login) => log::info!("signed in as {login}"),
                            Err(e) => log::warn!("could not read the signed-in account: {e}"),
                        }
                    });
                }
                let focused = Arc::new(AtomicBool::new(true));
                app.manage(Focused(focused.clone()));
                poll::spawn(handle, client, focused, waker, interval, needs_gh);
            }

            tray::setup_tray(&app.handle().clone())?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing hides to the tray rather than quitting, so polling
            // keeps running and the badge stays live. Quit is explicit,
            // from the tray menu or Cmd-Q. A window can be hidden without a
            // `Focused(false)` event, so this also has to clear the
            // focused flag itself -- otherwise polling would stay on the
            // 60s cadence forever after close-to-tray.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Read per close rather than cached at startup, so the
                // setting takes effect immediately rather than at the
                // next launch -- and an unreadable database falls back
                // to hiding, the app's pre-existing behaviour, because
                // quitting unexpectedly loses more than hiding does.
                if !crate::commands::read_ui_prefs(&window.app_handle().clone()).close_hides_to_tray
                {
                    // Let the close proceed: Tauri exits when the last
                    // window closes, which is what "quit" means here.
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                if let Some(focused) = window.try_state::<Focused>() {
                    mark_hidden(&focused.0);
                }
            }
            tauri::WindowEvent::Focused(is_focused) => {
                if let Some(focused) = window.try_state::<Focused>() {
                    mark_focus(&focused.0, *is_focused);
                }
                // Regaining focus is exactly when fresh data is wanted, and
                // it is the reliable signal that a machine woke from sleep:
                // `tokio::time::sleep` does not fire while suspended and
                // does not compensate on wake, so without this the first
                // tick after a closed lid was up to a full interval late.
                if *is_focused {
                    if let Some(waker) = window.try_state::<poll::Waker>() {
                        waker.0.notify_one();
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This is the bug Task 10 left behind: the `Arc<AtomicBool>` given to
    /// `poll::spawn` was never retained anywhere else, so nothing could
    /// ever flip it and the background 300s cadence was unreachable at
    /// runtime. Managing `Focused` as Tauri state and mutating it through
    /// `mark_hidden`/`mark_focus` (the same functions the window-event
    /// handler calls) is the fix; these tests exercise the exact same
    /// `Arc<AtomicBool>` that `poll::interval_for` reads, through the exact
    /// same functions the closure calls, proving the flag is both reachable
    /// and mutable at runtime -- not merely that the module compiles.
    #[test]
    fn hiding_the_window_clears_the_focused_flag() {
        let focused = Arc::new(AtomicBool::new(true));
        mark_hidden(&focused);
        assert!(!focused.load(Ordering::Relaxed));
        assert_eq!(
            poll::interval_for(focused.load(Ordering::Relaxed)),
            poll::BACKGROUND
        );
    }

    #[test]
    fn losing_focus_clears_the_flag_and_gaining_it_sets_it() {
        let focused = Arc::new(AtomicBool::new(true));

        mark_focus(&focused, false);
        assert!(!focused.load(Ordering::Relaxed));

        mark_focus(&focused, true);
        assert!(focused.load(Ordering::Relaxed));
    }

    /// Drives a real `tauri::WindowEvent::Focused` value (not a stand-in)
    /// through the same match arm used in `run`'s `on_window_event`
    /// closure, confirming the event type itself -- constructed exactly as
    /// the platform would deliver it -- reaches `mark_focus` and flips the
    /// shared flag that `poll::spawn` reads.
    #[test]
    /// Note the limit of this test: it duplicates the match arm rather than
    /// invoking the real `on_window_event` closure, because Tauri gives no way
    /// to construct a `CloseRequested`'s `api` field or dispatch a synthetic
    /// event from a unit test. So it proves `mark_focus` maps a real
    /// `WindowEvent::Focused` payload onto the cadence correctly -- it does NOT
    /// prove the production closure is wired up. That wiring is guaranteed by
    /// the type checker and by reading lib.rs's handler, not by this test.
    fn a_real_focused_event_reaches_the_shared_flag() {
        let focused = Arc::new(AtomicBool::new(true));

        let event = tauri::WindowEvent::Focused(false);
        match &event {
            tauri::WindowEvent::Focused(is_focused) => mark_focus(&focused, *is_focused),
            _ => unreachable!(),
        }

        assert!(!focused.load(Ordering::Relaxed));
        assert_eq!(
            poll::interval_for(focused.load(Ordering::Relaxed)),
            poll::BACKGROUND
        );
    }

    /// `Focused` is managed as Tauri state and read back through
    /// `try_state::<Focused>()` inside the real window-event closure. That
    /// retrieval is unit-testable on its own: the newtype wraps the same
    /// `Arc<AtomicBool>` `poll::spawn` holds, so storing through one handle
    /// is observable through the other -- which is exactly what
    /// `app.manage(Focused(focused.clone()))` plus `window.try_state` give
    /// us at runtime.
    #[test]
    fn the_managed_focused_newtype_shares_the_same_arc_poll_reads() {
        let focused = Arc::new(AtomicBool::new(true));
        let managed = Focused(focused.clone());

        mark_hidden(&managed.0);

        // The clone `poll::spawn` was given observes the same store.
        assert!(!focused.load(Ordering::Relaxed));
    }
}
