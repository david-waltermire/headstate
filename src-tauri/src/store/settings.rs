//! User settings, persisted in SQLite.
//!
//! Key-value with JSON values, so adding a setting needs no migration and
//! a setting can grow from a scalar into a list without one either.
//!
//! Rust owns these rather than the webview because the poll loop and the
//! worktree scanner both read them, and neither can see `localStorage`.

use super::schema::StoreError;
use rusqlite::{Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

/// Read a setting, or `None` if it has never been set.
///
/// A value that fails to deserialise is treated as absent rather than as
/// an error: a setting written by a newer version should fall back to the
/// default instead of breaking startup.
pub fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> Result<Option<T>, StoreError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

/// Write a setting, replacing any previous value.
pub fn set<T: Serialize>(conn: &Connection, key: &str, value: &T) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

/// Keys, named in one place so a typo cannot silently create a second
/// setting that nothing reads.
pub mod keys {
    /// Focused poll interval, in seconds.
    pub const POLL_INTERVAL_SECS: &str = "poll_interval_secs";
    /// Directories scanned for git checkouts, as a JSON array of paths.
    pub const WORKTREE_DIRS: &str = "worktree_dirs";
    /// Worktrees handed to Claude Code, as a JSON map of path -> head
    /// OID. The OID is what makes the mark expire: a branch that has
    /// moved since the assessment was read is no longer the thing that
    /// was assessed, and acting on a stale verdict is the failure this
    /// guards against -- the same reasoning as `expectedHeadOid` on the
    /// update-branch mutation.
    pub const ASSESSED_WORKTREES: &str = "assessed_worktrees";
    /// Which desktop notifications to send, as a JSON `NotifyPrefs`.
    ///
    /// Absent means the default (everything on), which is what the app
    /// did before this key existed -- an upgrade must not silently turn
    /// off a feature someone relies on.
    pub const NOTIFY_PREFS: &str = "notify_prefs";
    /// Interface preferences, as a JSON `UiPrefs`. Absent means the
    /// defaults, which are what the app did before this key existed.
    pub const UI_PREFS: &str = "ui_prefs";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::open_db;
    use tempfile::TempDir;

    fn db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let conn = open_db(&dir.path().join("t.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn an_unset_setting_reads_as_none() {
        let (_d, conn) = db();
        assert_eq!(get::<u64>(&conn, keys::POLL_INTERVAL_SECS).unwrap(), None);
    }

    #[test]
    fn a_setting_round_trips() {
        let (_d, conn) = db();
        set(&conn, keys::POLL_INTERVAL_SECS, &300u64).unwrap();
        assert_eq!(
            get::<u64>(&conn, keys::POLL_INTERVAL_SECS).unwrap(),
            Some(300)
        );
    }

    #[test]
    fn writing_twice_replaces_rather_than_erroring() {
        let (_d, conn) = db();
        set(&conn, keys::POLL_INTERVAL_SECS, &120u64).unwrap();
        set(&conn, keys::POLL_INTERVAL_SECS, &600u64).unwrap();
        assert_eq!(
            get::<u64>(&conn, keys::POLL_INTERVAL_SECS).unwrap(),
            Some(600)
        );
    }

    /// The reason values are JSON: `worktree_dirs` starts as one path and
    /// will not stay that way.
    #[test]
    fn a_list_setting_round_trips() {
        let (_d, conn) = db();
        let dirs = vec!["/a".to_string(), "/b".to_string()];
        set(&conn, keys::WORKTREE_DIRS, &dirs).unwrap();
        assert_eq!(
            get::<Vec<String>>(&conn, keys::WORKTREE_DIRS).unwrap(),
            Some(dirs)
        );
    }

    /// A value written by a NEWER version must fall back to the default
    /// rather than breaking startup -- settings are read during setup, so
    /// an error here would be a launch failure.
    #[test]
    fn an_unparseable_value_reads_as_absent() {
        let (_d, conn) = db();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![keys::POLL_INTERVAL_SECS, "{\"shape\":\"from the future\"}"],
        )
        .unwrap();
        assert_eq!(get::<u64>(&conn, keys::POLL_INTERVAL_SECS).unwrap(), None);
    }

    /// Settings must survive the upgrade, not just exist on fresh installs.
    #[test]
    fn an_existing_database_gains_the_settings_table() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        {
            // A v2-era database: snapshot only, no settings table.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload TEXT NOT NULL, fetched_at TEXT NOT NULL);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 2i64).unwrap();
        }
        let conn = open_db(&path).unwrap();
        set(&conn, keys::POLL_INTERVAL_SECS, &120u64).unwrap();
        assert_eq!(
            get::<u64>(&conn, keys::POLL_INTERVAL_SECS).unwrap(),
            Some(120)
        );
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use crate::store::open_db;

    /// Writes to the REAL database the running app uses, proving the
    /// migration and round-trip work on live data rather than a temp file.
    /// Cleans up after itself. Run manually:
    /// `cargo test --lib live_settings -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_settings_round_trip() {
        let path = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/com.pktstorm.headstate/headstate.db");
        let conn = open_db(&path).unwrap();

        let before: Option<Vec<String>> = get(&conn, keys::WORKTREE_DIRS).unwrap();
        set(&conn, keys::WORKTREE_DIRS, &vec!["/tmp/probe".to_string()]).unwrap();
        let read: Option<Vec<String>> = get(&conn, keys::WORKTREE_DIRS).unwrap();
        println!("LIVE round-trip: {read:?}");
        assert_eq!(read, Some(vec!["/tmp/probe".to_string()]));

        // Restore whatever was there, so a manual run leaves no trace.
        match before {
            Some(v) => set(&conn, keys::WORKTREE_DIRS, &v).unwrap(),
            None => {
                conn.execute("DELETE FROM settings WHERE key = ?1", [keys::WORKTREE_DIRS])
                    .unwrap();
            }
        }
        println!("LIVE restored");
    }
}
