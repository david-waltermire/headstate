//! Poetry's virtualenv cache.
//!
//! Poetry names a venv `<project>-<hash>-py<X.Y>`, where the hash is
//! `base64(sha256(absolute project path))[:8]`. That naming is what makes
//! this tractable: the hash is a pure function of the path, so we can
//! reconstruct it for every directory we know about and ask whether any
//! of them produced a given venv.
//!
//! It also explains why the cache grows without bound on a machine that
//! uses worktrees. Every worktree is a different absolute path, so every
//! worktree gets its OWN venv -- and deleting the worktree leaves the
//! venv behind forever. On the machine this was built for, one project
//! that no longer exists on disk at all accounted for 70 venvs and
//! 54.9 GB, against 90 venvs and 57 GB in total.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Why a venv is considered reclaimable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VenvState {
    /// No directory we scanned hashes to this venv's name.
    ///
    /// A FACT rather than a judgement, and the strongest claim available:
    /// the path that created it is gone, so nothing can ever use it
    /// again. Subject only to the scan roots being complete, which is
    /// why `Unknown` exists rather than folding into this.
    Orphaned,
    /// The project exists, but nothing has touched the venv in a long
    /// time.
    ///
    /// Weaker than `Orphaned` and deliberately kept separate. The user
    /// whose report prompted this had a project still on disk that they
    /// had not worked on in a year -- existence alone is not evidence
    /// that a venv is wanted.
    Stale,
    /// The project exists and the venv is in use. Never offered.
    Live,
}

/// One Poetry virtualenv.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Venv {
    pub path: String,
    /// The project name Poetry encoded, e.g. `mls-delivery-service`.
    pub project: String,
    pub state: VenvState,
    /// The directory that produced it, when one was found. None for an
    /// orphan -- that IS the finding, not missing data.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// Seconds since the newest file inside was written.
    ///
    /// From the DEEPEST mtime, never the directory's own. Poetry touches
    /// the venv root on resolve without writing anything inside, so the
    /// top-level mtime reports a year-old venv as days old -- measured:
    /// bucketing by it claimed 42 GB was under 30 days when those same
    /// directories contained no file written in 30 days.
    #[serde(default)]
    pub idle_secs: Option<u64>,
}

/// Poetry's venv name for a project directory.
///
/// `base64(sha256(path))[:8]`, on the RAW path -- not lowercased, though
/// the name segment is. Verified against a real cache entry rather than
/// inferred from Poetry's source.
pub fn venv_token(project_dir: &Path) -> String {
    let digest = Sha256::digest(project_dir.to_string_lossy().as_bytes());
    let b64 = base64::engine::general_purpose::URL_SAFE.encode(digest);
    b64[..8].to_string()
}

/// `<name>-<hash>-py<X.Y>` split back into its parts.
///
/// The hash alphabet includes `-`, so splitting on the last dash is
/// wrong: it turns `regscale-cli-HIA...` into a project called
/// `regscale-cli-HIA`. Anchoring on the `-py<X.Y>` suffix and taking
/// exactly 8 characters before it is what parses every real entry.
pub fn parse_venv_name(name: &str) -> Option<(String, String)> {
    let (head, _py) = name.rsplit_once("-py")?;
    if head.len() < 10 {
        return None;
    }
    let (project, hash) = head.split_at(head.len() - 9);
    let hash = hash.strip_prefix('-')?;
    if hash.len() != 8
        || !hash
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some((project.to_string(), hash.to_string()))
}

/// Where Poetry keeps its virtualenvs on this platform.
pub fn cache_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = PathBuf::from(home);
    // macOS uses Library/Caches; Linux respects XDG. Both are checked
    // rather than assuming the platform, because a user with
    // POETRY_CACHE_DIR set is not covered by either and should get an
    // empty list rather than a wrong one.
    [
        base.join("Library/Caches/pypoetry/virtualenvs"),
        base.join(".cache/pypoetry/virtualenvs"),
    ]
    .into_iter()
    .find(|c| c.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned as a LITERAL, computed from Poetry's documented scheme and
    /// checked against a real cache entry during development.
    ///
    /// The scheme is Poetry's, not ours: if they change it, this test is
    /// how we find out -- rather than the feature silently reclassifying
    /// every venv on every machine as an orphan.
    #[test]
    fn the_token_matches_poetrys_scheme() {
        // This path is chosen so the digest's first 8 characters DIFFER
        // between url-safe and standard base64 (`_` vs `/`). A path
        // where the two agree -- most of them -- would pass with the
        // wrong alphabet, and the wrong alphabet reclassifies every venv
        // on the machine as an orphan.
        assert_eq!(
            venv_token(Path::new("/Users/octocat/code/acme/hello-world-4")),
            "FpVt51X_"
        );
    }

    /// The hash is over the RAW path. Lowercasing it -- an easy thing to
    /// add while normalising the name segment -- produces a completely
    /// different token and would orphan every venv on the machine.
    #[test]
    fn the_token_is_case_sensitive_on_the_path() {
        let a = venv_token(Path::new("/Users/Sam/code/App"));
        let b = venv_token(Path::new("/users/sam/code/app"));
        assert_ne!(a, b);
    }

    #[test]
    fn parses_a_plain_name() {
        assert_eq!(
            parse_venv_name("cm-backend-Ja7MTDN0-py3.13"),
            Some(("cm-backend".into(), "Ja7MTDN0".into()))
        );
    }

    /// The hash alphabet includes `-`, so splitting on the LAST dash is
    /// wrong. A naive split turned `regscale-cli-HIAxxxxx` into a project
    /// called `regscale-cli-HIA`, which then matched nothing.
    #[test]
    fn a_hash_containing_a_dash_does_not_eat_the_name() {
        assert_eq!(
            parse_venv_name("regscale-cli-HIA-2bcd-py3.13"),
            Some(("regscale-cli".into(), "HIA-2bcd".into()))
        );
        assert_eq!(
            parse_venv_name("mls-delivery-service--GlU8mQR-py3.13"),
            Some(("mls-delivery-service".into(), "-GlU8mQR".into()))
        );
    }

    /// Anything that is not Poetry's shape must be skipped rather than
    /// half-parsed: this directory is not exclusively ours, and a
    /// mis-parse here becomes a deletion candidate.
    #[test]
    fn refuses_anything_that_is_not_a_venv_name() {
        for bad in [
            "not-a-venv",
            "short-py3.13",
            "name-TOOLONGHASH-py3.13",
            "-py3.13",
            "",
        ] {
            assert_eq!(parse_venv_name(bad), None, "{bad}");
        }
    }
}
