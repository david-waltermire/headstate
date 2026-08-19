//! Authentication.
//!
//! The token comes from `gh auth token` and is held in memory only: never
//! written to SQLite, never logged, never sent anywhere but api.github.com.
//! Delegating credential storage to `gh` means Headstate carries no
//! credential-handling code of its own.

use std::process::{Command, Output};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("the GitHub CLI (gh) is not installed or not on PATH")]
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

pub fn read_token() -> Result<String, AuthError> {
    let out = Command::new("gh")
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
}
