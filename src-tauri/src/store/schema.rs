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
