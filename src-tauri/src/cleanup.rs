//! Automatic cleanup: what the app WOULD remove, recorded for review.
//!
//! Phase 1 of #382, and it deliberately cannot delete anything. There is
//! no removal path in this module.
//!
//! The reason is not caution for its own sake. Enabling this feature asks
//! the user to trust a predicate they have never seen run against their
//! own machine, and no amount of description substitutes for a list of
//! what it actually picked. Preview turns "trust this rule" into "confirm
//! this list", and it generates that list from real machines before any
//! code has the power to act on it.
//!
//! Nothing here talks to GitHub.

use crate::store::settings;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One thing the cleanup pass considered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub at: String,
    /// `artifact` or `venv`.
    pub kind: String,
    /// The path.
    pub target: String,
    /// What it is, in the terms the view uses: an artifact's rebuild
    /// command, or a virtualenv's project.
    pub detail: Option<String>,
    pub bytes: Option<u64>,
    /// `proposed`, `removed`, `refused`, or `skipped`.
    pub action: String,
    pub error: Option<String>,
}

/// What automatic cleanup is allowed to consider, and whether it may act.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupMode {
    /// Record what WOULD be removed. The only mode Phase 1 ships.
    Preview,
    /// Reserved for Phase 2. Present in the type so the ledger's `action`
    /// column and the settings shape do not need changing later, and
    /// absent from every code path that could act on it.
    Remove,
}

/// Preferences for the automatic pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupPrefs {
    /// Master switch. OFF, because an upgrade must never start deleting
    /// -- and in Phase 1, must not start scanning on a timer either.
    #[serde(default)]
    pub enabled: bool,
    /// Preview even once enabled. Flipping to Remove is a SECOND,
    /// separate decision, made after reading a week of real proposals.
    #[serde(default = "preview")]
    pub mode: CleanupMode,
    /// Whether build artifacts are considered.
    #[serde(default)]
    pub artifacts: bool,
    /// Whether virtualenvs are considered at all.
    #[serde(default)]
    pub venvs: bool,
    /// Whether STALE virtualenvs count too, not just orphans.
    ///
    /// The distinction is the whole reason this is separate from
    /// `venvs`. An orphan is a FACT: nothing on the machine hashes to
    /// it, so the project that made it is gone and it can never be used
    /// again. Stale is a THRESHOLD -- 90 days by default -- about a
    /// project that still exists, and a threshold is a guess at intent.
    ///
    /// Manual removal does not need this: ticking a row and confirming a
    /// dialog IS the intent. An unattended pass has no such signal, so
    /// this is where the opt-in belongs and where it now lives.
    ///
    /// Defaults OFF: an upgrade must never widen what runs by itself.
    #[serde(default)]
    pub venvs_stale: bool,
    /// Most entries a single run may propose.
    ///
    /// A blast radius, and it matters in Preview too: a run that proposed
    /// all 178 directories would produce a ledger nobody reads, which is
    /// the same as no ledger.
    #[serde(default)]
    pub max_per_run: u32,
}

fn preview() -> CleanupMode {
    CleanupMode::Preview
}

impl Default for CleanupPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: CleanupMode::Preview,
            artifacts: false,
            venvs: false,
            venvs_stale: false,
            max_per_run: 0,
        }
    }
}

/// Entries per run, honouring the setting.
///
/// Clamped rather than trusted, and 0 means "use the default" rather
/// than "propose nothing" -- a stored 0 from a bad write should not
/// silently disable a feature the user turned on.
pub fn max_per_run(prefs: &CleanupPrefs) -> usize {
    match prefs.max_per_run {
        0 => 25,
        n => n.clamp(1, 500) as usize,
    }
}

/// Append entries to the ledger.
///
/// Failure is logged and swallowed: the ledger is a record of work, and
/// losing a row must never take down the pass that produced it. Same
/// reasoning as `notify_breakage` in `poll`.
pub fn record(conn: &Connection, entries: &[LedgerEntry]) {
    for e in entries {
        let r = conn.execute(
            "INSERT INTO cleanup_log (at, kind, target, detail, bytes, action, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                e.at,
                e.kind,
                e.target,
                e.detail,
                e.bytes.map(|b| b as i64),
                e.action,
                e.error
            ],
        );
        if let Err(err) = r {
            log::warn!("could not record a cleanup entry: {err}");
        }
    }
}

/// The most recent entries, newest first.
pub fn recent(conn: &Connection, limit: u32) -> Result<Vec<LedgerEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT at, kind, target, detail, bytes, action, error
         FROM cleanup_log ORDER BY at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(LedgerEntry {
            at: r.get(0)?,
            kind: r.get(1)?,
            target: r.get(2)?,
            detail: r.get(3)?,
            bytes: r.get::<_, Option<i64>>(4)?.map(|b| b as u64),
            action: r.get(5)?,
            error: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// Read the stored preferences.
pub fn prefs(conn: &Connection) -> CleanupPrefs {
    settings::get(conn, settings::keys::CLEANUP_PREFS)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Build the proposal list for one run.
///
/// Reuses the SAME scanners and the same verdicts the Artifacts view
/// renders, rather than re-deriving what counts as reclaimable. One
/// implementation means the preview cannot drift from what the view
/// shows, and a user comparing the two will never find them disagreeing.
///
/// Pure apart from the filesystem reads the scanners do: it proposes,
/// and the caller decides what to do with the list. In Phase 1 the only
/// caller writes it to the ledger.
pub fn propose(prefs: &CleanupPrefs, roots: &[String], now: &str) -> Vec<LedgerEntry> {
    if !prefs.enabled {
        return Vec::new();
    }

    let cap = max_per_run(prefs);
    let mut out: Vec<LedgerEntry> = Vec::new();

    if prefs.venvs {
        // Orphans always; stale only with `venvs_stale`.
        //
        // An orphan is a FACT -- nothing on the machine hashes to it, so
        // the project that made it is gone. Stale is a THRESHOLD about a
        // project that still exists, and an unattended pass is the last
        // place to act on a threshold without being told to.
        //
        // The manual path deliberately has no such gate: ticking a row
        // and confirming a dialog is already the user's intent. Here
        // there is no such signal, which is why the opt-in lives here.
        let dirs = crate::caches::project_dirs(roots);
        for v in crate::caches::scan_poetry(&dirs) {
            if out.len() >= cap {
                break;
            }
            // MEASURED first, because staleness needs the idle time and
            // `scan_poetry` reports only what it can decide without a
            // walk. The size is needed for the ledger either way, so
            // this costs nothing extra.
            let (bytes, idle) = crate::caches::measure(std::path::Path::new(&v.path));
            let state = crate::caches::classify_measured(v.state, idle);
            let eligible = match state {
                crate::caches::VenvState::Orphaned => true,
                crate::caches::VenvState::Stale => prefs.venvs_stale,
                // Live is never removed unattended. Its project exists
                // and something touched it recently.
                crate::caches::VenvState::Live => false,
            };
            if !eligible {
                continue;
            }
            out.push(LedgerEntry {
                at: now.to_string(),
                kind: "venv".into(),
                target: v.path,
                detail: Some(v.project),
                bytes: Some(bytes),
                action: "proposed".into(),
                error: None,
            });
        }
    }

    if prefs.artifacts {
        for a in crate::artifacts::scan(roots) {
            if out.len() >= cap {
                break;
            }
            let (bytes, idle) = crate::artifacts::measure(std::path::Path::new(&a.path));
            // Skip anything a build may be writing to. Recorded as
            // `skipped` rather than omitted: a directory that keeps
            // being passed over is something the user should be able to
            // see, not a silent gap in the list.
            if idle.is_some_and(|secs| secs < ACTIVE_WINDOW_SECS) {
                out.push(LedgerEntry {
                    at: now.to_string(),
                    kind: "artifact".into(),
                    target: a.path,
                    detail: Some(a.kind.regenerated_by().to_string()),
                    bytes: Some(bytes),
                    action: "skipped".into(),
                    error: Some("written to recently".into()),
                });
                continue;
            }
            out.push(LedgerEntry {
                at: now.to_string(),
                kind: "artifact".into(),
                target: a.path,
                detail: Some(a.kind.regenerated_by().to_string()),
                bytes: Some(bytes),
                action: "proposed".into(),
                error: None,
            });
        }
    }

    out
}

/// Mirrors the artifact view's rule, and the backend's delete-time one.
const ACTIVE_WINDOW_SECS: u64 = 15 * 60;

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> CleanupPrefs {
        CleanupPrefs {
            enabled: true,
            artifacts: true,
            venvs: false,
            ..Default::default()
        }
    }

    /// #453: which virtualenv states an UNATTENDED pass may propose.
    ///
    /// Tested as the decision itself rather than through `propose`,
    /// which would need a real Poetry cache on the machine running the
    /// tests -- and writing into a developer's actual cache to assert a
    /// boolean is the wrong trade.
    mod venv_eligibility {
        use super::*;
        use crate::caches::VenvState;

        /// Mirrors the arm in `propose`. If that changes shape, this
        /// test must be updated with it -- which is the point: the rule
        /// is small enough that duplicating it beats not testing it.
        fn eligible(state: VenvState, venvs_stale: bool) -> bool {
            match state {
                VenvState::Orphaned => true,
                VenvState::Stale => venvs_stale,
                VenvState::Live => false,
            }
        }

        /// An orphan is a FACT -- nothing hashes to it, so the project
        /// that made it is gone. No opt-in needed.
        #[test]
        fn orphans_need_no_opt_in() {
            assert!(eligible(VenvState::Orphaned, false));
            assert!(eligible(VenvState::Orphaned, true));
        }

        /// Stale is a THRESHOLD about a project that still exists, and
        /// an unattended pass is the last place to act on one uninvited.
        #[test]
        fn stale_requires_the_opt_in() {
            assert!(!eligible(VenvState::Stale, false));
            assert!(eligible(VenvState::Stale, true));
        }

        /// Live is never proposed, whatever the settings say. Its
        /// project exists and something touched it recently.
        #[test]
        fn live_is_never_proposed() {
            assert!(!eligible(VenvState::Live, false));
            assert!(!eligible(VenvState::Live, true));
        }

        /// The default must not widen what runs by itself.
        #[test]
        fn the_default_is_orphans_only() {
            let p = CleanupPrefs::default();
            assert!(!p.venvs_stale);
            assert!(!eligible(VenvState::Stale, p.venvs_stale));
        }
    }

    /// The master switch is the outermost guard. An upgrade must not
    /// start scanning, let alone proposing, for someone who never opened
    /// Settings.
    /// The fixture must contain something the pass WOULD propose,
    /// otherwise an empty result proves nothing -- an earlier version of
    /// this test used a bare temp directory and passed with the master
    /// switch removed entirely.
    #[test]
    fn a_disabled_pass_proposes_nothing() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("x.bin"), "x").unwrap();
        let roots = vec![t.path().to_string_lossy().to_string()];

        // Enabled, this fixture yields an entry...
        assert!(!propose(&on(), &roots, "now").is_empty());

        // ...and disabled, it must yield none.
        let prefs = CleanupPrefs {
            enabled: false,
            artifacts: true,
            ..Default::default()
        };
        assert!(propose(&prefs, &roots, "now").is_empty());
    }

    /// Defaults are conservative in every direction, so a settings row
    /// written before this feature existed enables nothing.
    #[test]
    fn the_defaults_enable_nothing() {
        let d = CleanupPrefs::default();
        assert!(!d.enabled);
        assert!(!d.artifacts);
        assert!(!d.venvs);
        assert_eq!(d.mode, CleanupMode::Preview);
    }

    /// Phase 1 CANNOT delete. This pins the property that makes the
    /// phase reviewable on the predicate's merits alone: if the pass
    /// gains a removal path, this test is where that shows up.
    #[test]
    fn nothing_in_a_proposal_is_an_action() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("x.bin"), "x").unwrap();

        let out = propose(&on(), &[t.path().to_string_lossy().to_string()], "now");
        assert!(
            out.iter().all(|e| e.action != "removed"),
            "a preview run must never record a removal"
        );
        assert!(target.exists(), "and must never actually remove anything");
    }

    /// A directory a build may be writing to is recorded as SKIPPED
    /// rather than omitted: one that keeps being passed over is
    /// something the user should be able to see.
    #[test]
    fn an_active_directory_is_skipped_visibly() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        // Written just now.
        std::fs::write(target.join("fresh.bin"), "x").unwrap();

        let out = propose(&on(), &[t.path().to_string_lossy().to_string()], "now");
        let e = out
            .iter()
            .find(|e| e.target == target.to_string_lossy())
            .expect("the directory must appear in the ledger, not vanish from it");
        assert_eq!(
            e.action, "skipped",
            "a fresh directory must not be proposed"
        );
        assert_ne!(
            e.action, "proposed",
            "removing the active check would propose a directory a build may be writing to"
        );
        assert!(e.error.is_some(), "and says why");
    }

    /// The cap bounds a run. It matters in Preview too: a ledger listing
    /// every directory on the machine is one nobody reads, which is the
    /// same as no ledger.
    #[test]
    fn a_run_is_capped() {
        let t = tempfile::TempDir::new().unwrap();
        for i in 0..6 {
            let d = t.path().join(format!("p{i}"));
            std::fs::create_dir(&d).unwrap();
            std::fs::write(d.join("Cargo.toml"), "[package]").unwrap();
            std::fs::create_dir(d.join("target")).unwrap();
        }
        let prefs = CleanupPrefs {
            max_per_run: 2,
            ..on()
        };
        let out = propose(&prefs, &[t.path().to_string_lossy().to_string()], "now");
        assert_eq!(out.len(), 2);
    }

    /// Zero means "use the default", not "propose nothing": a stored 0
    /// from a bad write must not silently disable a feature the user
    /// turned on.
    #[test]
    fn a_zero_cap_means_the_default() {
        assert_eq!(max_per_run(&CleanupPrefs::default()), 25);
        assert_eq!(
            max_per_run(&CleanupPrefs {
                max_per_run: 3,
                ..Default::default()
            }),
            3
        );
        // And a wild value is clamped rather than trusted.
        assert_eq!(
            max_per_run(&CleanupPrefs {
                max_per_run: 9_999,
                ..Default::default()
            }),
            500
        );
    }

    /// Phase 1 must not be able to STORE Remove mode.
    ///
    /// The variant exists so the settings and ledger shapes do not change
    /// in Phase 2, but a setting that can be turned on and does nothing
    /// is worse than one that does not exist -- the user believes it.
    /// The command refuses it; this pins that the default never is it.
    #[test]
    fn remove_mode_is_never_the_stored_default() {
        assert_eq!(CleanupPrefs::default().mode, CleanupMode::Preview);
        let round: CleanupPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(
            round.mode,
            CleanupMode::Preview,
            "a settings row written before this field existed must read as Preview"
        );
    }

    #[test]
    fn the_ledger_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();
        record(
            &conn,
            &[LedgerEntry {
                at: "2026-09-02T00:00:00Z".into(),
                kind: "artifact".into(),
                target: "/code/x/target".into(),
                detail: Some("cargo build".into()),
                bytes: Some(1234),
                action: "proposed".into(),
                error: None,
            }],
        );
        let back = recent(&conn, 10).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].target, "/code/x/target");
        assert_eq!(back[0].bytes, Some(1234));
    }
}
