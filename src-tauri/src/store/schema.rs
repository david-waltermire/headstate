//! Database schema and migrations.
//!
//! Migrations are numbered from the first commit, so v0.1 installs stay
//! upgradable rather than needing the database deleted -- this matters even
//! though there is only one migration today.

use rusqlite::Connection;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialisation error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Numbered migrations from the first commit, so v0.1 installs stay
/// upgradable rather than needing the database deleted.
const MIGRATIONS: &[&str] = &[
    // 1: the snapshot cache and the merge history.
    "CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        fetched_at TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS merge_history (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        merged_at TEXT NOT NULL,
        PRIMARY KEY (repo, number)
     );",
    // `merge_history` was never written to -- see `store/mod.rs`. Dropped
    // rather than left as a permanently-empty table implying a feature
    // that does not exist. Additive-only migrations elsewhere; this one is
    // safe because nothing ever read it either.
    "DROP TABLE IF EXISTS merge_history;",
];

pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}

pub fn open_db(path: &Path) -> Result<Connection, StoreError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_table(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    /// An existing install sits at user_version 1 with the empty
    /// merge_history table. The DROP must run for THOSE databases, not
    /// only for fresh ones -- otherwise the dead table lingers forever on
    /// every machine that already installed the app.
    #[test]
    fn upgrading_an_existing_db_drops_the_dead_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
             CREATE TABLE merge_history (repo TEXT NOT NULL, number INTEGER NOT NULL,
                merged_at TEXT NOT NULL, PRIMARY KEY (repo, number));",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1i64).unwrap();

        migrate(&conn).unwrap();

        assert!(
            !has_table(&conn, "merge_history"),
            "dead table must be dropped"
        );
        assert!(has_table(&conn, "snapshot"), "the real cache must survive");
    }

    #[test]
    fn a_fresh_db_ends_up_with_only_the_snapshot_table() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert!(has_table(&conn, "snapshot"));
        assert!(!has_table(&conn, "merge_history"));
    }

    /// Migrations are applied once and are idempotent on re-open, which
    /// every call to `open_db` relies on.
    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let v1: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        migrate(&conn).unwrap();
        let v2: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v1, v2);
        assert_eq!(v1 as usize, MIGRATIONS.len());
    }
}
