//! Tool caches: package managers' own storage, outside any checkout.
//!
//! A different concern from `artifacts` despite both reclaiming disk.
//! Build output belongs to a checkout and is proven regenerable by a
//! manifest beside it; a tool cache belongs to no project at all, and its
//! contents are proven regenerable by the tool's own design -- these
//! directories exist to be refilled.
//!
//! Nothing here talks to GitHub.

pub mod poetry;

pub use poetry::{Venv, VenvState};

use std::collections::HashMap;
use std::path::Path;

/// How long a venv must sit untouched before it counts as stale.
///
/// Ninety days rather than thirty: a project worked on seasonally is
/// normal, and the cost of a wrong call here is a re-resolve, but the
/// cost of nagging about a live project is that the whole view stops
/// being trusted. The user report that prompted this involved a venv
/// idle for 416 days, so the signal is not subtle when it matters.
const STALE_SECS: u64 = 90 * 24 * 60 * 60;

/// Every directory under the scan roots that could have produced a venv.
///
/// COMPLETENESS is the safety property here. A venv is called orphaned
/// because nothing in this set hashes to it, so a set that is too small
/// calls live venvs orphans -- the one way this feature could propose
/// deleting something wanted. It therefore walks broadly and cheaply,
/// and errs toward including directories rather than excluding them.
///
/// Skips only what cannot contain a Python project root: `.git`, and the
/// artifact directories that hold thousands of vendored packages. A
/// `node_modules` tree can hold 50,000 directories and none of them is a
/// Poetry project.
pub fn project_dirs(roots: &[String]) -> Vec<String> {
    const SKIP: &[&str] = &[".git", "node_modules", "target", ".terraform", ".venv"];
    // Depth-first with an explicit cap, so a pathological tree cannot
    // hang the scan. 48,000 directories on a real machine took under a
    // second; the cap is far above that and exists only as a backstop.
    const MAX_DIRS: usize = 200_000;

    let mut out = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = roots.iter().map(std::path::PathBuf::from).collect();

    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_DIRS {
            log::warn!("stopped walking project directories at {MAX_DIRS}");
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            // `metadata()` from `read_dir` does not follow symlinks, so
            // a link to a directory reports false here -- which is what
            // we want: a linked tree is reachable by its real path.
            if !meta.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            out.push(e.path().to_string_lossy().to_string());
            stack.push(e.path());
        }
    }
    out
}

/// Every Poetry venv, classified against the directories we can see.
///
/// `project_dirs` are the candidate paths a venv could have come from.
/// Completeness matters: a venv is called orphaned because NOTHING in
/// this set hashes to it, so a short list would call live venvs orphans.
/// The caller passes every directory under the configured scan roots for
/// exactly that reason.
pub fn scan_poetry(project_dirs: &[String]) -> Vec<Venv> {
    let Some(dir) = poetry::cache_dir() else {
        return Vec::new();
    };

    // token -> path, for every directory that could have produced a venv.
    let index: HashMap<String, String> = project_dirs
        .iter()
        .map(|d| (poetry::venv_token(Path::new(d)), d.clone()))
        .collect();

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out: Vec<Venv> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (project, hash) = poetry::parse_venv_name(&name)?;
            let path = e.path();
            if !path.is_dir() {
                return None;
            }

            let source = index.get(&hash).cloned();
            // Measured lazily, like every other size in this app: the
            // walk is the expensive part and the list should paint
            // first.
            Some(Venv {
                path: path.to_string_lossy().to_string(),
                project,
                // Classified on `source` alone here; staleness needs the
                // idle time, which is not known until measurement.
                state: if source.is_none() {
                    VenvState::Orphaned
                } else {
                    VenvState::Live
                },
                source,
                size_bytes: None,
                idle_secs: None,
            })
        })
        .collect();

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Bytes on disk, and seconds since the newest file inside was written.
///
/// The idle time comes from the DEEPEST mtime, never the directory's
/// own. Poetry touches the venv root when it resolves without writing
/// anything inside, so the top-level mtime reports a year-old venv as
/// days old -- measured on a real cache, bucketing by it claimed 42 GB
/// was under 30 days old while those same directories contained no file
/// written in 30 days.
///
/// Skips symlinks and tolerates unreadable entries, for the same reasons
/// `artifacts::measure` does.
pub fn measure(path: &Path) -> (u64, Option<u64>) {
    let mut total = 0u64;
    let mut newest: Option<std::time::SystemTime> = None;
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
            // FILES only for the timestamp. A directory's mtime changes
            // when its listing changes, which is exactly the signal that
            // misled the first version of this.
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
                if let Ok(m) = meta.modified() {
                    if newest.is_none_or(|n| m > n) {
                        newest = Some(m);
                    }
                }
            }
        }
    }

    let idle = newest.and_then(|n| n.elapsed().ok()).map(|d| d.as_secs());
    (total, idle)
}

/// Re-classify a measured venv, now that its idle time is known.
///
/// Separate from `scan_poetry` because staleness cannot be decided
/// without walking the directory, and the walk is what the two-pass
/// design exists to defer.
///
/// An orphan STAYS an orphan regardless of idle time: the path that made
/// it is gone, so "recently touched" says nothing about whether anyone
/// wants it.
pub fn classify_measured(state: VenvState, idle_secs: Option<u64>) -> VenvState {
    match state {
        VenvState::Orphaned => VenvState::Orphaned,
        _ => match idle_secs {
            Some(secs) if secs >= STALE_SECS => VenvState::Stale,
            // Unknown idle time is treated as LIVE. A directory we could
            // not read is not evidence that it is disposable, and this
            // is the direction every other check in this codebase fails
            // in.
            _ => VenvState::Live,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's own correction, and the reason `Stale` exists at all:
    ///
    /// > cm-backend is a great example - I stopped working on that a year
    /// > ago and definitely would want to clean up that cache
    ///
    /// Its directory still exists, so a pure orphan check PROTECTS it.
    /// Existence is not evidence that a venv is wanted.
    #[test]
    fn a_long_idle_venv_with_a_live_project_is_stale() {
        let year = 416 * 24 * 60 * 60;
        assert_eq!(
            classify_measured(VenvState::Live, Some(year)),
            VenvState::Stale
        );
    }

    #[test]
    fn a_recently_used_venv_stays_live() {
        let three_hours = 3 * 60 * 60;
        assert_eq!(
            classify_measured(VenvState::Live, Some(three_hours)),
            VenvState::Live
        );
    }

    /// An orphan's path is GONE, so how recently something touched it
    /// says nothing about whether anyone wants it. Downgrading an orphan
    /// on a fresh mtime would protect exactly the 54.9 GB this feature
    /// exists to find.
    #[test]
    fn an_orphan_stays_an_orphan_however_recently_touched() {
        assert_eq!(
            classify_measured(VenvState::Orphaned, Some(0)),
            VenvState::Orphaned
        );
        assert_eq!(
            classify_measured(VenvState::Orphaned, None),
            VenvState::Orphaned
        );
    }

    /// A directory we could not read is not evidence that it is
    /// disposable -- the same direction every other check in this
    /// codebase fails in.
    #[test]
    fn an_unmeasurable_venv_is_treated_as_live() {
        assert_eq!(classify_measured(VenvState::Live, None), VenvState::Live);
    }

    /// The boundary, from both sides.
    #[test]
    fn staleness_is_bounded_at_ninety_days() {
        assert_eq!(
            classify_measured(VenvState::Live, Some(STALE_SECS - 1)),
            VenvState::Live
        );
        assert_eq!(
            classify_measured(VenvState::Live, Some(STALE_SECS)),
            VenvState::Stale
        );
    }
}

/// The outcome of removing one virtualenv.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VenvRemoval {
    pub path: String,
    /// None on success. Shown verbatim -- it names WHY.
    pub error: Option<String>,
}

/// Remove one virtualenv, re-verifying it at delete time.
///
/// Every check runs against the FILESYSTEM rather than the row the user
/// clicked, for the same reason `artifacts::remove_artifact` does: the
/// list may be minutes old, and in that time a project directory could
/// have been restored -- which would turn an orphan back into a live
/// venv.
///
/// `project_dirs` is passed in rather than re-walked here so the caller
/// controls the completeness that the orphan verdict depends on.
pub fn remove_venv(path: &str, project_dirs: &[String]) -> Result<(), String> {
    let p = Path::new(path);

    // 1. Never a symlink, checked BEFORE canonicalising -- which
    //    resolves through links and leaves nothing to detect.
    //    `remove_dir_all` on a symlink deletes the TARGET's contents.
    let meta =
        std::fs::symlink_metadata(p).map_err(|e| format!("could not read the directory: {e}"))?;
    if meta.is_symlink() {
        return Err("that path is a symlink, not a directory".into());
    }
    if !meta.is_dir() {
        return Err("that path is not a directory".into());
    }

    // 2. Inside Poetry's own cache directory. This is the containment
    //    boundary: without it a bad path is `remove_dir_all` on anything
    //    at all.
    let cache = poetry::cache_dir().ok_or("could not locate the Poetry cache")?;
    let canon = p
        .canonicalize()
        .map_err(|e| format!("could not resolve the path: {e}"))?;
    is_inside_cache(&canon, &cache)?;

    // 3. Still parses as a venv name. A directory someone dropped in the
    //    cache by hand is not ours to delete.
    let name = canon
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("unreadable directory name")?;
    let (_, hash) = poetry::parse_venv_name(name).ok_or("that is not a Poetry virtualenv")?;

    // 4. Still not owned by a live project. Re-derived NOW: if the
    //    project directory came back since the scan, this is no longer
    //    an orphan and must not be removed on the strength of a stale
    //    verdict.
    if project_dirs
        .iter()
        .any(|d| poetry::venv_token(Path::new(d)) == hash)
    {
        return Err("its project directory exists again; this is no longer orphaned".into());
    }

    std::fs::remove_dir_all(&canon).map_err(|e| format!("could not remove it: {e}"))
}

/// Whether a canonical path sits inside the cache directory.
///
/// Split out so the containment rule can be tested WITHOUT a Poetry
/// cache on the machine. It is the guard standing between a bad path and
/// `remove_dir_all` on an arbitrary directory, so it is the one rule
/// that must never go untested because CI happens to lack Python
/// tooling -- which is exactly what happened the first time this shipped.
///
/// Both sides are canonicalised so `../` cannot walk out of the cache.
fn is_inside_cache(canon: &Path, cache: &Path) -> Result<(), String> {
    let cache_canon = cache
        .canonicalize()
        .map_err(|e| format!("could not resolve the cache directory: {e}"))?;
    if !canon.starts_with(&cache_canon) {
        return Err("that directory is not inside the Poetry cache".into());
    }
    Ok(())
}

/// Remove several, reporting each independently.
pub fn remove_venvs(paths: &[String], project_dirs: &[String]) -> Vec<VenvRemoval> {
    paths
        .iter()
        .map(|p| VenvRemoval {
            path: p.clone(),
            error: remove_venv(p, project_dirs).err(),
        })
        .collect()
}

#[cfg(test)]
mod removal_tests {
    use super::*;

    /// Every test here needs a venv INSIDE the real cache directory,
    /// because containment is checked against it. Creating one there is
    /// acceptable -- it is named so it cannot collide, and each test
    /// removes it.
    struct TempVenv {
        path: std::path::PathBuf,
    }

    impl TempVenv {
        fn new(name: &str) -> Option<Self> {
            let cache = poetry::cache_dir()?;
            let path = cache.join(name);
            std::fs::create_dir_all(path.join("lib")).ok()?;
            std::fs::write(path.join("pyvenv.cfg"), "home = /x").ok()?;
            Some(Self { path })
        }
    }

    impl Drop for TempVenv {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A name whose hash cannot match any real directory.
    const ORPHAN: &str = "headstate-test-orphan-ZZZZZZZZ-py3.99";

    #[test]
    fn removes_an_orphan() {
        let Some(v) = TempVenv::new(ORPHAN) else {
            return; // no Poetry cache on this machine
        };
        remove_venv(&v.path.to_string_lossy(), &[]).unwrap();
        assert!(!v.path.exists());
    }

    /// The verdict is re-derived at delete time. If the project came
    /// back since the scan, the venv is live again and a stale row must
    /// not talk the backend into removing it.
    #[test]
    fn refuses_one_whose_project_reappeared() {
        let t = tempfile::TempDir::new().unwrap();
        let project = t.path().to_string_lossy().to_string();
        let hash = poetry::venv_token(t.path());
        let name = format!("headstate-test-live-{hash}-py3.99");

        let Some(v) = TempVenv::new(&name) else {
            return;
        };
        let err = remove_venv(&v.path.to_string_lossy(), &[project]).unwrap_err();
        assert!(err.contains("no longer orphaned"), "{err}");
        assert!(v.path.exists(), "and it must still be there");
    }

    /// The containment boundary. Without it a bad path is
    /// `remove_dir_all` on anything at all.
    /// The containment boundary, tested against a SYNTHETIC cache
    /// directory rather than the real one.
    ///
    /// The first version drove this through `remove_venv`, which needs a
    /// real Poetry cache to exist -- so on CI, which has no Python
    /// tooling, it failed on "could not locate the Poetry cache" and
    /// never reached the rule it was meant to check. The guard standing
    /// between a bad path and `remove_dir_all` on an arbitrary directory
    /// must not go untested because the runner lacks Poetry.
    #[test]
    fn refuses_a_path_outside_the_poetry_cache() {
        let cache = tempfile::TempDir::new().unwrap();
        let elsewhere = tempfile::TempDir::new().unwrap();
        let outside = elsewhere.path().canonicalize().unwrap();

        let err = is_inside_cache(&outside, cache.path()).unwrap_err();
        assert!(err.contains("not inside the Poetry cache"), "{err}");
    }

    #[test]
    fn accepts_a_path_inside_the_cache() {
        let cache = tempfile::TempDir::new().unwrap();
        let venv = cache.path().join("a-AAAAAAAA-py3.13");
        std::fs::create_dir(&venv).unwrap();
        let canon = venv.canonicalize().unwrap();
        assert!(is_inside_cache(&canon, cache.path()).is_ok());
    }

    /// `../` must not walk out of the cache. Both sides are
    /// canonicalised for exactly this.
    #[test]
    fn a_traversal_out_of_the_cache_is_refused() {
        let cache = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(outside.path().join("victim")).unwrap();
        let sneaky = outside.path().join("victim").canonicalize().unwrap();
        assert!(is_inside_cache(&sneaky, cache.path()).is_err());
    }

    /// The cache directory is not exclusively ours. A directory someone
    /// put there by hand is not a venv and not ours to delete.
    #[test]
    fn refuses_a_directory_that_is_not_a_venv_name() {
        let Some(v) = TempVenv::new("headstate-test-plain-directory") else {
            return;
        };
        let err = remove_venv(&v.path.to_string_lossy(), &[]).unwrap_err();
        assert!(err.contains("not a Poetry virtualenv"), "{err}");
        assert!(v.path.exists());
    }

    /// `remove_dir_all` on a symlink deletes the TARGET's contents.
    #[test]
    #[cfg(unix)]
    fn refuses_a_symlink() {
        let Some(cache) = poetry::cache_dir() else {
            return;
        };
        let real = tempfile::TempDir::new().unwrap();
        std::fs::write(real.path().join("keep.txt"), "important").unwrap();
        let link = cache.join("headstate-test-link-ZZZZZZZZ-py3.99");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(real.path(), &link).unwrap();

        let err = remove_venv(&link.to_string_lossy(), &[]).unwrap_err();
        let _ = std::fs::remove_file(&link);
        assert!(err.contains("symlink"), "{err}");
        assert!(real.path().join("keep.txt").exists(), "target untouched");
    }

    #[test]
    fn reports_each_removal_independently() {
        let Some(v) = TempVenv::new("headstate-test-batch-ZZZZZZZZ-py3.99") else {
            return;
        };
        let out = remove_venvs(
            &[
                v.path.to_string_lossy().to_string(),
                "/nowhere/at/all".to_string(),
            ],
            &[],
        );
        assert_eq!(out.len(), 2);
        assert!(out[0].error.is_none(), "{:?}", out[0].error);
        assert!(out[1].error.is_some());
    }
}
