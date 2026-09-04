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
    let mut resolved: std::collections::HashMap<String, Option<super::model::Origin>> =
        std::collections::HashMap::new();
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
            .find_map(|tag| {
                // Memoised across images: the same SHA tag commonly
                // appears on several images (a repo's api and worker
                // built from one commit), and resolving it repeatedly
                // walks every candidate repo again.
                if let Some(hit) = resolved.get(tag.as_str()) {
                    return hit.clone();
                }
                let hit = resolve_tag(repos, tag);
                resolved.insert(tag.clone(), hit.clone());
                hit
            });
    }
    Ok(imgs)
}

/// The first repository in which a tag names a real commit.
///
/// Verified on real data that this is unambiguous: three tags across 40
/// candidate repositories each resolved to exactly one.
fn resolve_tag(repos: &[PathBuf], tag: &str) -> Option<super::model::Origin> {
    repos.iter().find_map(|repo| {
        // `cat-file` first, `default_branch` only once the tag actually
        // resolves: default_branch was half the git calls, and it is only
        // needed to answer "is it merged" for a commit that exists here.
        // Worst case -- a SHA-shaped tag matching no repo -- was a full
        // 37-repo walk at 0.78s per tag.
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
    let git = |args: &[&str]| -> Option<String> {
        let o = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .ok()?;
        o.status
            .success()
            .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };

    if let Some(head) = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        return head;
    }

    // `origin/HEAD` is NOT set by a plain `git clone` -- it needs
    // `git remote set-head`. Falling straight to a hardcoded
    // `origin/main` meant that on a `master`-default repo, every
    // merge-base check failed and EVERY image reported unmerged,
    // inverting the page's central signal.
    for candidate in ["origin/main", "origin/master"] {
        if git(&["rev-parse", "--verify", "--quiet", candidate]).is_some() {
            return candidate.to_string();
        }
    }
    "origin/main".to_string()
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
    match docker(&["rmi", id]) {
        Ok(_) => Ok(()),
        // An image carrying several references refuses removal by ID.
        // Remove the REFERENCES instead: the image goes when the last
        // one does, which is what the user asked for, without `--force`
        // silencing the in-use refusal too.
        Err(e) if is_multi_reference(&e) => remove_by_references(id, &e),
        Err(e) => Err(e),
    }
}

/// Whether a refusal is the several-references one.
///
/// Matched on the daemon's own wording. Deliberately narrow: every
/// OTHER "must be forced" refusal means something depends on the
/// image, and those must keep failing.
fn is_multi_reference(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("must be forced") && e.contains("referenced in multiple repositories")
}

/// Remove an image by untagging each of its references.
///
/// MEASURED, not assumed. `docker rmi <id>` refuses an image with
/// several references; removing each reference by name untags them in
/// turn and the daemon deletes the image once the last one is gone.
/// Verified against a real daemon: three references removed one by
/// one, image gone, no `--force` anywhere.
///
/// Only TAGS are removed, though digests are what usually cause the
/// conflict. A pulled image carries a `RepoDigest` per repository name
/// alongside its tags, and the daemon counts those toward "multiple
/// repositories" -- which is why this fires on images whose tags all
/// share one name.
///
/// Digests cannot be removed this way. Measured: `rmi` on a digest ref
/// of a locally-tagged image answers "No such image", and a first
/// version of this that passed digests through reported failure for an
/// image it had just successfully deleted. Removing the tags is
/// sufficient -- the daemon drops the image, and its digests with it,
/// when the last tag goes.
fn remove_by_references(id: &str, original: &str) -> Result<(), String> {
    let refs = references(id)?;
    if refs.is_empty() {
        // Nothing to untag means the conflict came from somewhere this
        // cannot address, so the daemon's own words stand.
        return Err(original.to_string());
    }

    let mut failures = Vec::new();
    for r in &refs {
        if let Err(e) = docker(&["rmi", r]) {
            failures.push(format!("{r}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// The tags this image can be addressed by.
fn references(id: &str) -> Result<Vec<String>, String> {
    let out = docker(&[
        "image",
        "inspect",
        id,
        "--format",
        "{{range .RepoTags}}{{println .}}{{end}}",
    ])?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "<none>:<none>")
        .map(str::to_string)
        .collect())
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

#[cfg(test)]
mod remove_tests {
    use super::*;

    /// The daemon's exact wording, captured from a real failure:
    ///
    ///   conflict: unable to delete 9b531bc8882c (must be forced)
    ///   - image is referenced in multiple repositories
    #[test]
    fn the_several_references_refusal_is_recognised() {
        let real = "Error response from daemon: conflict: unable to delete \
                    9b531bc8882c (must be forced) - image is referenced in \
                    multiple repositories";
        assert!(is_multi_reference(real));
    }

    /// THE distinction this fix rests on. Every other "must be forced"
    /// refusal means something DEPENDS on the image, and untagging
    /// references would not help -- those must keep failing rather
    /// than being routed into the untag path.
    #[test]
    fn an_in_use_refusal_is_not_treated_as_a_reference_conflict() {
        let in_use = "Error response from daemon: conflict: unable to delete \
                      9b531bc8882c (cannot be forced) - image is being used by \
                      running container abc123";
        assert!(!is_multi_reference(in_use));

        let stopped = "Error response from daemon: conflict: unable to delete \
                       9b531bc8882c (must be forced) - image is being used by \
                       stopped container abc123";
        assert!(
            !is_multi_reference(stopped),
            "a container refusal says 'must be forced' too, and is NOT this case"
        );

        let child = "Error response from daemon: conflict: unable to delete \
                     9b531bc8882c (must be forced) - image has dependent child images";
        assert!(!is_multi_reference(child));
    }

    /// `--force` must never appear, because it silences the IN-USE
    /// refusal as well as the reference one.
    ///
    /// A string test cannot catch that: mutation testing showed the
    /// whole untag path could be replaced with `rmi --force` and every
    /// other test still passed. This runs the real code against a
    /// stand-in docker that records its arguments.
    #[cfg(unix)]
    #[test]
    fn removal_never_passes_force_to_docker() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let log = tmp.path().join("args.log");
        let bin = tmp.path().join("docker");
        // Refuses `rmi <id>` the way a real daemon does, answers
        // `inspect` with two references, and accepts the untags.
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\necho \"$@\" >> {log}\n\
                 case \"$1 $2\" in\n\
                 \"image inspect\") echo 'octocat/example:v1'; echo 'octocat/example:latest'; exit 0;;\n\
                 esac\n\
                 case \"$2\" in\n\
                 deadbeef) echo 'Error response from daemon: conflict: unable to delete deadbeef (must be forced) - image is referenced in multiple repositories' >&2; exit 1;;\n\
                 esac\n\
                 exit 0\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        temp_env::with_var("HEADSTATE_DOCKER", Some(bin.to_str().unwrap()), || {
            let _ = remove_image("deadbeef");
        });

        let recorded = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(
            !recorded.contains("--force") && !recorded.contains(" -f"),
            "removal must never force; docker was called with:\n{recorded}"
        );
        assert!(
            recorded.contains("octocat/example:v1") && recorded.contains("octocat/example:latest"),
            "both references must be untagged; docker was called with:\n{recorded}"
        );
    }

    #[test]
    fn an_unrelated_error_is_not_a_reference_conflict() {
        assert!(!is_multi_reference("No such image: nope:latest"));
        assert!(!is_multi_reference(""));
    }
}
