//! The snapshot cache: the last poll's PR list, so launch paints real
//! content instead of a spinner, and the app is readable offline.
//!
//! GitHub search stays authoritative for the displayed numbers; this is
//! purely a cache of the last successful fetch.

use super::schema::StoreError;
use crate::github::model::PullRequest;
use rusqlite::{Connection, OptionalExtension};

/// The whole snapshot is one JSON row. At ~30 PRs this is a few hundred KB,
/// so a normalised schema would buy nothing and cost migrations later.
pub fn save_snapshot(conn: &Connection, prs: &[PullRequest]) -> Result<(), StoreError> {
    let payload = serde_json::to_string(prs)?;
    conn.execute(
        "INSERT INTO snapshot (id, payload, fetched_at) VALUES (1, ?1, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET payload = ?1, fetched_at = datetime('now')",
        [&payload],
    )?;
    Ok(())
}

pub fn load_snapshot(conn: &Connection) -> Result<Vec<PullRequest>, StoreError> {
    // `.optional()`, not `.ok()`: the latter collapses every rusqlite error
    // into "no snapshot", so a corrupt or locked database would render as
    // "you have no pull requests". Silently showing an empty list when the
    // store is broken is worse than surfacing the failure.
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM snapshot WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?;
    match payload {
        Some(p) => Ok(serde_json::from_str(&p)?),
        None => Ok(Vec::new()),
    }
}
