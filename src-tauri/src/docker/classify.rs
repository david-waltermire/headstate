//! Attaching provenance and use to a raw image list.
//!
//! Split from `parse` because it is the slow half: git calls per tag and
//! a `docker ps`. The listing is fast and should paint immediately, the
//! way the worktrees view lists first and classifies after (#176).

use super::cli::docker;
use super::model::Image;
use super::origin::{images_in_use, looks_like_sha, resolve_in_repo};
use super::parse::images;
use std::path::{Path, PathBuf};

/// Images with provenance and in-use resolved.
///
/// `repos` are the directories to resolve tags against -- the same
/// scanned directories the worktrees view uses, so a machine configured
/// once works for both views.
pub fn classify(repos: &[PathBuf]) -> Result<Vec<Image>, String> {
    let raw = docker(&["images", "--format", "{{json .}}"])?;
    let mut imgs = images(&raw);

    // A failed `docker ps` yields None, which propagates to every image
    // as "unknown" rather than "not in use". The gate fails CLOSED.
    let in_use = images_in_use().ok();
    for img in imgs.iter_mut() {
        // `docker ps` reports whatever reference the container was
        // started with -- a tag, or an ID. Match either.
        img.in_use = in_use.as_ref().map(|running| {
            running.iter().any(|r| {
                r.starts_with(&img.id)
                    || img
                        .tags
                        .iter()
                        .any(|t| r == &format!("{}:{}", img.repository, t))
            })
        });

        img.origin = img
            .tags
            .iter()
            .filter(|t| looks_like_sha(t))
            .find_map(|tag| resolve_tag(repos, tag));
    }
    Ok(imgs)
}

/// The first repository in which a tag names a real commit.
///
/// Verified on real data that this is unambiguous: three tags across 40
/// candidate repositories each resolved to exactly one.
fn resolve_tag(repos: &[PathBuf], tag: &str) -> Option<super::model::Origin> {
    repos.iter().find_map(|repo| {
        let default = default_branch(repo);
        resolve_in_repo(repo, tag, &default)
    })
}

/// The repository's default branch, as an origin ref.
///
/// Checked against `origin/<default>` rather than a local branch: a local
/// `main` can be weeks stale, and "merged" driving deletion means a stale
/// answer deletes an image whose work is not actually landed.
fn default_branch(repo: &Path) -> String {
    std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "origin/main".to_string())
}

/// One image's outcome in a removal.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RemovalOutcome {
    pub id: String,
    pub error: Option<String>,
}

/// Remove one image and every tag pointing at it.
///
/// By ID, not by tag: removing `:latest` from a two-tag image frees
/// nothing and looks broken. `docker rmi <id>` requires all its tags to
/// go together, which is the honest unit.
///
/// The in-use check is re-run HERE rather than trusted from the listing.
/// A container may have started since -- the same reasoning as
/// re-checking worktree safety at delete time rather than at scan time.
pub fn remove_image(id: &str) -> Result<(), String> {
    // A failed check REFUSES rather than proceeding. This is the
    // delete-time gate; letting it fail open was the bug.
    let running =
        images_in_use().map_err(|e| format!("could not check whether the image is in use: {e}"))?;
    if running.iter().any(|r| r.starts_with(id)) {
        return Err("a running container is using this image".into());
    }
    // No `--force`. A refusal means something depends on it, and forcing
    // past that is how a running stack loses its image mid-session.
    docker(&["rmi", id]).map(|_| ())
}

/// Remove several images, reporting each independently.
///
/// Partial failure is the normal case: `docker rmi` refuses an image
/// another image's layers depend on, and a single verdict would
/// misreport what is still on disk.
pub fn remove_images(ids: &[String]) -> Vec<RemovalOutcome> {
    ids.iter()
        .map(|id| RemovalOutcome {
            id: id.clone(),
            error: remove_image(id).err(),
        })
        .collect()
}
