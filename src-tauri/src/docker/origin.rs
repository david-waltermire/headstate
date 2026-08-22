//! Resolving an image back to the work that produced it.
//!
//! This is the thing Docker Desktop structurally cannot do, and the
//! reason this view earns its place: it can say *this image came from a
//! branch that merged last week, so nothing will ever want it again*.
//!
//! Two independent sources, in preference order:
//!
//! 1. `docker buildx history inspect` records the build context path and
//!    VCS revision outright. Best answer, but history ages out.
//! 2. A SHA-shaped tag resolved against the local repositories. Verified
//!    on real data: three tags, each resolving to exactly one repo.

use super::cli::docker;
use super::model::{Origin, OriginSource};
use std::path::Path;
use std::process::Command;

/// Whether a tag could be an abbreviated commit SHA.
///
/// Cheap pre-filter before touching git: `latest`, `7-alpine`, and
/// `24.04` are not commits, and asking git about every tag in a large
/// image list would be wasted subprocess churn.
///
/// Seven is git's own minimum abbreviation length. Shorter strings are
/// too ambiguous to resolve, and requiring at least one digit rejects
/// pure-alpha tags like `alpine` that are technically valid hex.
pub fn looks_like_sha(tag: &str) -> bool {
    tag.len() >= 7
        && tag.len() <= 40
        && tag.chars().all(|c| c.is_ascii_hexdigit())
        && tag.chars().any(|c| c.is_ascii_digit())
}

/// Resolve a tag against one repository.
///
/// Returns `None` unless the tag names a real commit there. `cat-file -t`
/// rather than `rev-parse`: rev-parse happily echoes back a
/// non-existent-but-well-formed SHA, which would invent provenance.
pub fn resolve_in_repo(repo: &Path, tag: &str, default_branch: &str) -> Option<Origin> {
    let git = |args: &[&str]| -> Option<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    if git(&["cat-file", "-t", tag])? != "commit" {
        return None;
    }

    let subject = git(&["log", "-1", "--format=%s", tag])?;
    // Merged means the commit is reachable from the default branch, so
    // nothing will ever want this image again. Deliberately checked
    // against origin/<default>, not a local branch that may be stale.
    let merged = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", tag, default_branch])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    Some(Origin {
        repo_path: repo.to_string_lossy().into_owned(),
        context: None,
        commit: tag.to_string(),
        subject,
        merged,
        source: OriginSource::TagResolution,
    })
}

/// The build context and revision `buildx history` recorded for a build.
///
/// Parsed from the human-readable inspect output, which is the only form
/// that carries `Context`.
pub fn parse_build_inspect(out: &str) -> Option<(String, String)> {
    let mut context = None;
    let mut revision = None;
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("Context:") {
            context = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("VCS Revision:") {
            revision = Some(v.trim().to_string());
        }
    }
    match (context, revision) {
        (Some(c), Some(r)) if !c.is_empty() && !r.is_empty() => Some((c, r)),
        _ => None,
    }
}

/// Which images a running container is holding.
///
/// Read from running containers rather than inferred from tags: an image
/// in use must never be offered for cleanup, and `docker rmi` would
/// refuse it anyway -- better to not offer than to offer and fail.
pub fn images_in_use() -> Result<Vec<String>, String> {
    // Deliberately NOT unwrap_or_default(). A failed `docker ps` returning
    // an empty list is indistinguishable from "no containers are running",
    // and this function is used TWICE: once to decide whether to offer
    // removal, and once inside remove_image as the delete-time re-check.
    // One swallowed error therefore defeated both the offer and the guard,
    // making the safety gate fail OPEN.
    docker(&["ps", "--format", "{{.Image}}"]).map(|s| {
        s.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSPECT: &str = include_str!("../../tests/fixtures/buildx_inspect.txt");

    /// The best provenance source: buildx records the build context path
    /// outright, and for a worktree build that path IS the worktree.
    #[test]
    fn build_history_yields_the_context_and_revision() {
        let (context, revision) = parse_build_inspect(INSPECT).expect("should parse");
        assert!(context.ends_with("octocat-api"), "{context}");
        assert_eq!(revision, "1390188608bc2fa9566bf50c8a697f1d853dfed3");
    }

    /// A build whose history lacks either field yields nothing rather
    /// than half an answer -- a context with no revision cannot be tied
    /// to an image.
    #[test]
    fn partial_build_history_yields_nothing() {
        assert!(parse_build_inspect("Name:\tx\nContext:\t/code/p\n").is_none());
        assert!(parse_build_inspect("VCS Revision:\tabc123\n").is_none());
        assert!(parse_build_inspect("").is_none());
    }

    /// The pre-filter before touching git. Real tags from a real machine:
    /// the SHA-shaped ones are commits, the rest are versions.
    #[test]
    fn only_sha_shaped_tags_are_worth_resolving() {
        for yes in [
            "13901886",
            "2a324f38",
            "96cb8880",
            "1390188608bc2fa9566bf50c",
        ] {
            assert!(looks_like_sha(yes), "{yes} should look like a SHA");
        }
        // Real tags from a real machine, none of them commits.
        for no in [
            "latest",
            "7-alpine",
            "24.04",
            "15-alpine",
            "0.8.1",
            "v1",
            "abc",
        ] {
            assert!(!looks_like_sha(no), "{no} should not look like a SHA");
        }
    }

    /// Pure-alpha hex strings are rejected. `deadbeef` and `acceded` are
    /// valid hex, but a tag with no digit is far likelier to be a word
    /// than a commit -- and asking git about every such tag would be
    /// wasted subprocess churn across a large image list.
    #[test]
    fn pure_alpha_hex_is_not_treated_as_a_sha() {
        assert!(!looks_like_sha("deadbeef"));
        assert!(!looks_like_sha("acceded"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Against the real machine: do this account's image tags actually
    /// resolve to commits in local repositories?
    ///
    /// `cargo test --lib live_origin -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_origin_resolves_real_tags() {
        let home = std::env::var("HOME").unwrap();
        let out = docker(&["images", "--format", "{{json .}}"]).unwrap();
        let imgs = crate::docker::images(&out);

        let repos: Vec<std::path::PathBuf> =
            glob_repos(&format!("{home}/code")).into_iter().collect();
        println!("{} candidate repos", repos.len());

        for img in &imgs {
            for tag in &img.tags {
                if !looks_like_sha(tag) {
                    continue;
                }
                for repo in &repos {
                    if let Some(o) = resolve_in_repo(repo, tag, "origin/main") {
                        println!(
                            "  {tag} -> {} | merged={} | {}",
                            o.repo_path.rsplit('/').next().unwrap_or(""),
                            o.merged,
                            o.subject
                        );
                    }
                }
            }
        }
        println!("in use: {:?}", images_in_use());
    }

    fn glob_repos(base: &str) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(base)];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.join(".git").is_dir() {
                    out.push(p);
                } else if p.is_dir() && out.len() < 60 {
                    stack.push(p);
                }
            }
        }
        out
    }
}
