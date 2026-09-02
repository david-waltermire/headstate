//! Regenerable build output: `target/`, `node_modules/`, `.terraform/`,
//! and gitignored `dist`/`build` directories.
//!
//! A separate concern from `worktrees`, despite both walking the same
//! directories, because the two answer opposite questions. A worktree may
//! hold work that exists nowhere else, so its safety check asks "would
//! removing this lose something irreplaceable?" -- and the answer takes
//! git plumbing, an upstream probe, and a merge check. Build output is
//! regenerable by definition, so the only questions here are "is a tool's
//! output really what this is?" and "is something writing to it right
//! now?".
//!
//! That difference is why this is not an extension of the worktree view.
//! Measured on the machine that prompted it: only 0.28 GB of Rust target
//! space sat inside worktrees, against 108 GB beside main checkouts. The
//! worktree feature structurally could not reach 99.7% of the largest
//! thing on the disk.
//!
//! Nothing here talks to GitHub.

pub mod model;
pub mod scan;

pub use model::{Artifact, ArtifactKind};
pub use scan::scan;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::SystemTime;

/// Bytes on disk, and how recently anything under it was written.
///
/// One walk for both, because the expensive part is the traversal and
/// asking two questions of the same `metadata()` call is free.
///
/// Skips symlinks, so a link into another tree is neither counted twice
/// nor mistaken for local content -- the same rule `worktrees::dir_size`
/// applies, for the same reason.
///
/// Unreadable entries are skipped rather than failing the measurement: a
/// permission error on one file should not turn a real size into
/// "unknown".
pub fn measure(path: &Path) -> (u64, Option<u64>) {
    let mut total = 0u64;
    let mut newest: Option<SystemTime> = None;
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if let Ok(m) = meta.modified() {
                if newest.is_none_or(|n| m > n) {
                    newest = Some(m);
                }
            }
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }

    let age = newest.and_then(|n| n.elapsed().ok()).map(|d| d.as_secs());
    (total, age)
}

/// The outcome of removing one artifact directory.
///
/// Per-directory rather than one verdict for the batch: a directory that
/// went active since the scan is refused while the rest succeed, and a
/// single result would misreport what is still on disk. Mirrors
/// `RemovalOutcome` in `docker` and `worktrees` for the same reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRemoval {
    pub path: String,
    /// None on success. The message is shown verbatim -- it names WHY,
    /// and "could not remove" alone is not something a user can act on.
    pub error: Option<String>,
}

/// How recently a write disqualifies a directory from removal.
///
/// A running build does not appear in `git status`, because build output
/// is gitignored -- so there is no git-based check that can see it. The
/// newest mtime inside is the only available signal, and deleting a
/// `target/` out from under a running `cargo build` is the one way this
/// feature can cost real time rather than a rebuild.
///
/// Fifteen minutes rather than an hour: long enough to cover a build's
/// quiet phases (linking a large binary writes nothing for minutes), short
/// enough that yesterday's work is not still blocked today.
const ACTIVE_WINDOW_SECS: u64 = 15 * 60;

/// Remove one artifact directory, refusing anything that is not provably
/// regenerable build output.
///
/// Everything is re-verified HERE rather than trusted from the scan. The
/// list the user clicked may be minutes old: a build may have started, a
/// `.gitignore` may have changed, a directory may have been replaced by
/// something else entirely. The same discipline `remove_image` applies
/// ("a failed check REFUSES rather than proceeding") and `remove_worktree`
/// applies by re-running its safety check at delete time.
pub fn remove_artifact(path: &str, roots: &[String]) -> Result<(), String> {
    let p = std::path::Path::new(path);

    // 1. Never a symlink. FIRST, before `canonicalize` -- which
    //    resolves through links, so afterwards there is nothing left to
    //    detect. `remove_dir_all` on a symlink deletes the TARGET's
    //    contents, which may be anywhere at all.
    //
    //    A later check would still reject these by accident (the
    //    resolved path usually falls outside the root, or stops
    //    classifying), but "rejected for another reason" is not the same
    //    as "rejected because it is a symlink", and the day someone
    //    reorders those checks the accident stops happening.
    let link_meta =
        std::fs::symlink_metadata(p).map_err(|e| format!("could not read the directory: {e}"))?;
    if link_meta.is_symlink() {
        return Err("that path is a symlink, not a directory".into());
    }

    // 2. Inside a configured scan root, against the CANONICAL path so
    //    `../` cannot walk out of one. This is the only thing standing
    //    between a bad path and `remove_dir_all` on an arbitrary
    //    directory.
    let canon = p
        .canonicalize()
        .map_err(|e| format!("could not resolve the path: {e}"))?;
    let inside = roots.iter().any(|r| {
        std::path::Path::new(r)
            .canonicalize()
            .is_ok_and(|root| canon.starts_with(&root))
    });
    if !inside {
        return Err("that directory is outside the scanned folders".into());
    }

    if !link_meta.is_dir() {
        return Err("that path is not a directory".into());
    }

    // 3. Still classifies as an artifact. Re-derived from the filesystem
    //    rather than taken from the caller, so a stale row cannot talk
    //    the backend into deleting something the rules would now reject.
    if !crate::artifacts::scan::is_artifact(&canon) {
        return Err("that directory is no longer recognised as build output".into());
    }

    // 4. Nothing is writing to it. Last, because it is the only check
    //    that needs a full walk.
    let (_, newest) = measure(&canon);
    if newest.is_some_and(|secs| secs < ACTIVE_WINDOW_SECS) {
        return Err("something wrote to that directory in the last few minutes".into());
    }

    std::fs::remove_dir_all(&canon).map_err(|e| format!("could not remove it: {e}"))
}

/// Remove several, reporting each independently.
pub fn remove_artifacts(paths: &[String], roots: &[String]) -> Vec<ArtifactRemoval> {
    paths
        .iter()
        .map(|p| ArtifactRemoval {
            path: p.clone(),
            error: remove_artifact(p, roots).err(),
        })
        .collect()
}

#[cfg(test)]
mod removal_tests {
    use super::*;
    use std::fs;

    fn root_with_target() -> (tempfile::TempDir, String, Vec<String>) {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let target = t.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("artifact.bin"), "x").unwrap();
        let roots = vec![t.path().to_string_lossy().to_string()];
        (t, target.to_string_lossy().to_string(), roots)
    }

    /// Age the fixture past the active window, since a directory created
    /// during the test is by definition seconds old.
    ///
    /// Shells out to `touch` rather than adding a dev-dependency for one
    /// call: `std::fs` has no way to set an mtime, and `filetime` would
    /// be a new crate in the supply chain to age three files in tests.
    fn make_old(p: &Path) {
        let stamp = "202401010000"; // long before any test run
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            if let Ok(rd) = fs::read_dir(&d) {
                for e in rd.flatten() {
                    if e.path().is_dir() {
                        stack.push(e.path());
                    }
                    let _ = std::process::Command::new("touch")
                        .args(["-t", stamp])
                        .arg(e.path())
                        .status();
                }
            }
            let _ = std::process::Command::new("touch")
                .args(["-t", stamp])
                .arg(&d)
                .status();
        }
    }

    #[test]
    fn removes_a_stale_artifact() {
        let (_t, target, roots) = root_with_target();
        make_old(Path::new(&target));
        remove_artifact(&target, &roots).unwrap();
        assert!(!Path::new(&target).exists());
    }

    /// The guard that separates "costs a rebuild" from "costs an hour":
    /// a running build is invisible to git, because build output is
    /// gitignored, so mtime is the only signal there is.
    #[test]
    fn refuses_a_directory_something_just_wrote_to() {
        let (_t, target, roots) = root_with_target();
        // Left at its creation time, i.e. seconds old.
        let err = remove_artifact(&target, &roots).unwrap_err();
        assert!(err.contains("wrote to that directory"), "{err}");
        assert!(Path::new(&target).exists(), "and it must still be there");
    }

    /// The only thing between a bad path and `remove_dir_all` on an
    /// arbitrary directory.
    #[test]
    fn refuses_a_path_outside_every_scan_root() {
        let (_t, target, _) = root_with_target();
        make_old(Path::new(&target));
        let elsewhere = tempfile::TempDir::new().unwrap();
        let roots = vec![elsewhere.path().to_string_lossy().to_string()];
        let err = remove_artifact(&target, &roots).unwrap_err();
        assert!(err.contains("outside the scanned folders"), "{err}");
        assert!(Path::new(&target).exists());
    }

    /// `..` must not walk out of a scan root. Checked against the
    /// CANONICAL path for exactly this.
    #[test]
    fn refuses_a_traversal_out_of_the_root() {
        let (t, _target, roots) = root_with_target();
        let outside = tempfile::TempDir::new().unwrap();
        fs::write(outside.path().join("Cargo.toml"), "[package]").unwrap();
        let victim = outside.path().join("target");
        fs::create_dir(&victim).unwrap();
        make_old(&victim);

        // A path that LOOKS like it is under the root but resolves out.
        let sneaky = format!(
            "{}/../{}/target",
            t.path().to_string_lossy(),
            outside.path().file_name().unwrap().to_string_lossy()
        );
        let _ = remove_artifact(&sneaky, &roots);
        assert!(
            victim.exists(),
            "a path resolving outside the root must not be removed"
        );
    }

    /// `remove_dir_all` on a symlink deletes the TARGET's contents, which
    /// may be anywhere at all.
    ///
    /// Two paths reject this and BOTH are exercised, because which one
    /// fires depends on where the link points. `canonicalize` resolves
    /// through the link, so a link out of the tree is caught by the
    /// containment check; only a link that stays inside reaches the
    /// symlink check itself. Testing just one would leave the other
    /// unprotected the day someone reorders them.
    #[test]
    #[cfg(unix)]
    fn refuses_a_symlink_pointing_out_of_the_root() {
        let t = tempfile::TempDir::new().unwrap();
        let real = tempfile::TempDir::new().unwrap();
        fs::write(real.path().join("keep.txt"), "important").unwrap();
        fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let link = t.path().join("target");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();

        let roots = vec![t.path().to_string_lossy().to_string()];
        assert!(remove_artifact(&link.to_string_lossy(), &roots).is_err());
        assert!(
            real.path().join("keep.txt").exists(),
            "the link target must be untouched"
        );
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_symlink_pointing_inside_the_root() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let real = t.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("keep.txt"), "important").unwrap();
        let link = t.path().join("target");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        make_old(t.path());

        let roots = vec![t.path().to_string_lossy().to_string()];
        let err = remove_artifact(&link.to_string_lossy(), &roots).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(
            real.join("keep.txt").exists(),
            "the link target must be untouched"
        );
    }

    /// A stale row must not talk the backend into deleting something the
    /// rules would now reject -- here, a `target/` whose `Cargo.toml`
    /// disappeared since the scan.
    #[test]
    fn refuses_a_directory_that_no_longer_classifies() {
        let (t, target, roots) = root_with_target();
        make_old(Path::new(&target));
        fs::remove_file(t.path().join("Cargo.toml")).unwrap();
        let err = remove_artifact(&target, &roots).unwrap_err();
        assert!(err.contains("no longer recognised"), "{err}");
        assert!(Path::new(&target).exists());
    }

    /// Partial failure is the normal case, and one verdict for the batch
    /// would misreport what is still on disk.
    #[test]
    fn reports_each_removal_independently() {
        let (_t, target, roots) = root_with_target();
        make_old(Path::new(&target));
        let out = remove_artifacts(
            &[target.clone(), "/nowhere/at/all/target".to_string()],
            &roots,
        );
        assert_eq!(out.len(), 2);
        assert!(out[0].error.is_none(), "{:?}", out[0].error);
        assert!(out[1].error.is_some());
    }
}
