//! Authentication.
//!
//! The token comes from `gh auth token` and is held in memory only: never
//! written to SQLite, never logged, never sent anywhere but api.github.com.
//! Delegating credential storage to `gh` means Headstate carries no
//! credential-handling code of its own.

use std::process::{Command, Output};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    // A GUI app does not inherit the shell's PATH, so "not on PATH" is the
    // common case for a user who has gh working in their terminal. The
    // message names the searched locations so that is diagnosable.
    #[error(
        "could not find the GitHub CLI (gh). Headstate looked on PATH and in \
         /opt/homebrew/bin, /usr/local/bin, /opt/local/bin. If gh is installed \
         somewhere else, set HEADSTATE_GH to its full path."
    )]
    GhNotFound,
    #[error("gh is installed but not logged in: {0}")]
    GhNotLoggedIn(String),
    #[error("failed to run gh: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to build the GitHub client: {0}")]
    ClientBuild(octocrab::Error),
}

/// Parse `gh auth token` output. Split from the subprocess call so it can be
/// tested without spawning anything.
pub fn read_token_from(out: Output) -> Result<String, AuthError> {
    if !out.status.success() {
        return Err(AuthError::GhNotLoggedIn(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // A zero exit with empty stdout would otherwise become an empty bearer
    // token and fail much later as a confusing 401.
    if token.is_empty() {
        return Err(AuthError::GhNotLoggedIn(
            "gh returned an empty token".into(),
        ));
    }
    Ok(token)
}

/// Directories to search for `gh` beyond the inherited `PATH`.
///
/// A GUI-launched .app does NOT inherit the shell's PATH. On a clean Mac it
/// gets `/usr/bin:/bin:/usr/sbin:/sbin`, and Homebrew installs `gh` outside
/// all of those -- so `Command::new("gh")` fails with NotFound even though
/// `gh` works fine in the user's terminal. Verified: `env -i
/// PATH=/usr/bin:/bin:/usr/sbin:/sbin gh` -> "command not found".
///
/// Ordered most- to least-common: Apple Silicon Homebrew, Intel Homebrew,
/// MacPorts, then a manual install under the user's home.
const GH_FALLBACK_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
];

/// Locate the `gh` binary: `PATH` first, then the known install locations.
///
/// Returns the path to run. `None` means `gh` is genuinely not installed,
/// which is a different message from "installed but not logged in".
pub fn find_gh() -> Option<std::path::PathBuf> {
    find_gh_in(GH_FALLBACK_DIRS)
}

/// `find_gh` with the fallback list injected, so the fallback branch --
/// the entire fix for a GUI app's PATH not containing Homebrew -- is
/// testable without depending on what is installed on the test machine.
pub fn find_gh_in(fallbacks: &[&str]) -> Option<std::path::PathBuf> {
    // An explicit override wins over everything: the escape hatch for a
    // non-standard install, and the only thing a user can act on when the
    // fallback list does not cover their setup.
    if let Ok(explicit) = std::env::var("HEADSTATE_GH") {
        let p = std::path::PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    // `PATH` next so an explicitly-installed gh beats the fallbacks.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("gh");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in fallbacks {
        let candidate = std::path::Path::new(dir).join("gh");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn read_token() -> Result<String, AuthError> {
    let gh = find_gh().ok_or(AuthError::GhNotFound)?;
    let out = Command::new(&gh)
        .args(["auth", "token"])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AuthError::GhNotFound
            } else {
                AuthError::Io(e)
            }
        })?;
    read_token_from(out)
}

pub fn build_client(token: &str) -> Result<octocrab::Octocrab, AuthError> {
    octocrab::Octocrab::builder()
        .personal_token(token.to_string())
        // Without these, octocrab's Config leaves every timeout as None. A
        // hung TCP connection -- a closed laptop lid, a captive portal that
        // blackholes rather than resets -- then never returns and never
        // errors, and the poll loop awaits it forever: no error banner, no
        // next tick, silent stale data for the rest of the session.
        //
        // These bound the transport. `poll::FETCH_TIMEOUT` bounds the whole
        // request on top, because a server that trickles bytes can keep a
        // read alive indefinitely without ever tripping a read timeout.
        .set_connect_timeout(Some(std::time::Duration::from_secs(10)))
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .set_write_timeout(Some(std::time::Duration::from_secs(30)))
        // Octocrab's default is RetryConfig::Simple(3), which retries with
        // `future::ready(())` -- no delay at all. On a 429 that means three
        // more requests fired instantly at a server that just said "slow
        // down", which is the opposite of what a rate limit asks for.
        // HandleRateLimits reads GitHub's own retry headers and waits for the
        // refresh window instead, falling back to min_wait_seconds when the
        // headers are absent.
        .add_retry_config(
            octocrab::service::middleware::retry::RetryConfig::HandleRateLimits {
                metrics: std::sync::Arc::new(
                    octocrab::service::middleware::retry::NoOpRateLimitMetrics,
                ),
                max_retries: 3,
                min_wait_seconds: 60,
            },
        )
        .build()
        .map_err(AuthError::ClientBuild)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn trims_the_token() {
        let t = read_token_from(output(0, "gho_abc123\n", "")).unwrap();
        assert_eq!(t, "gho_abc123");
    }

    #[test]
    fn reports_logged_out() {
        let err = read_token_from(output(1, "", "not logged in")).unwrap_err();
        assert!(matches!(err, AuthError::GhNotLoggedIn(_)));
    }

    #[test]
    fn empty_stdout_is_logged_out_not_a_valid_token() {
        let err = read_token_from(output(0, "   \n", "")).unwrap_err();
        assert!(matches!(err, AuthError::GhNotLoggedIn(_)));
    }

    use std::os::unix::fs::PermissionsExt;

    fn fake_gh(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("gh");
        std::fs::write(&p, "#!/bin/sh\necho tok\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    // The whole point: a GUI app's PATH does not include Homebrew, so
    // discovery must not depend on PATH alone.
    #[test]
    fn finds_gh_via_path() {
        let tmp = std::env::temp_dir().join(format!("hs-gh-path-{}", std::process::id()));
        let bin = fake_gh(&tmp);
        temp_env::with_var("PATH", Some(tmp.to_str().unwrap()), || {
            assert_eq!(find_gh(), Some(bin.clone()));
        });
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn explicit_override_wins_over_path() {
        let a = std::env::temp_dir().join(format!("hs-gh-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("hs-gh-b-{}", std::process::id()));
        fake_gh(&a);
        let want = fake_gh(&b);
        temp_env::with_vars(
            [
                ("PATH", Some(a.to_str().unwrap())),
                ("HEADSTATE_GH", Some(want.to_str().unwrap())),
            ],
            || assert_eq!(find_gh(), Some(want.clone())),
        );
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    // An override pointing at nothing must fall through, not hard-fail.
    #[test]
    fn bogus_override_falls_back_to_path() {
        let tmp = std::env::temp_dir().join(format!("hs-gh-fb-{}", std::process::id()));
        let bin = fake_gh(&tmp);
        temp_env::with_vars(
            [
                ("PATH", Some(tmp.to_str().unwrap())),
                ("HEADSTATE_GH", Some("/nonexistent/gh")),
            ],
            || assert_eq!(find_gh(), Some(bin.clone())),
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    // THE REGRESSION TEST for the v1.0.0 hang. A GUI-launched .app gets
    // PATH=/usr/bin:/bin:/usr/sbin:/sbin, which excludes Homebrew, so
    // PATH-only lookup found nothing and the app reported "gh not
    // installed" to a user whose terminal `gh` works fine.
    #[test]
    fn finds_gh_outside_path_via_fallback_dirs() {
        let brew = std::env::temp_dir().join(format!("hs-gh-brew-{}", std::process::id()));
        let want = fake_gh(&brew);
        let empty = std::env::temp_dir().join(format!("hs-gh-nopath-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let fallbacks = [brew.to_str().unwrap()];
        temp_env::with_vars(
            [
                // A PATH with no gh on it at all, as a GUI app sees.
                ("PATH", Some(empty.to_str().unwrap())),
                ("HEADSTATE_GH", None),
            ],
            || assert_eq!(find_gh_in(&fallbacks), Some(want.clone())),
        );
        std::fs::remove_dir_all(&brew).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn returns_none_when_gh_is_nowhere() {
        let empty = std::env::temp_dir().join(format!("hs-gh-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        temp_env::with_vars(
            [
                ("PATH", Some(empty.to_str().unwrap())),
                ("HEADSTATE_GH", None),
            ],
            || {
                // Only meaningful if the machine has no gh in a fallback dir.
                if GH_FALLBACK_DIRS
                    .iter()
                    .all(|d| !std::path::Path::new(d).join("gh").is_file())
                {
                    assert_eq!(find_gh(), None);
                }
            },
        );
        std::fs::remove_dir_all(&empty).ok();
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Reproduces the v1.0.0 launch condition: the PATH a GUI-launched
    /// .app actually receives on a clean Mac. Run manually:
    /// `cargo test --lib live_gui_path -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_gui_path_still_finds_gh() {
        temp_env::with_vars(
            [
                ("PATH", Some("/usr/bin:/bin:/usr/sbin:/sbin")),
                ("HEADSTATE_GH", None),
            ],
            || {
                let found = find_gh();
                println!("gh on a GUI PATH: {found:?}");
                assert!(found.is_some(), "gh must be findable off-PATH");
                let token = read_token();
                println!("read_token ok: {}", token.is_ok());
                assert!(token.is_ok(), "token read must succeed: {token:?}");
            },
        );
    }
}
