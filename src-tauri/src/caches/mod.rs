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
