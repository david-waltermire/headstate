//! Merge history: a row per PR observed merged, so the dashboard's
//! week/month counters survive offline and can become trend charts later
//! without a schema rewrite.
//!
//! GitHub search remains authoritative for the displayed numbers; where
//! local history and GitHub disagree, GitHub wins.

use super::schema::StoreError;
use crate::github::model::PullRequest;
use chrono::{DateTime, Utc};
use rusqlite::Connection;

/// Record PRs that have left the open set, so week/month counters survive
/// offline and can become trend charts later without a schema rewrite.
/// GitHub search remains authoritative for the displayed numbers.
pub fn record_merges(
    conn: &Connection,
    prs: &[PullRequest],
    seen_at: DateTime<Utc>,
) -> Result<(), StoreError> {
    for pr in prs {
        conn.execute(
            "INSERT OR IGNORE INTO merge_history (repo, number, merged_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![pr.repo, pr.number as i64, seen_at.to_rfc3339()],
        )?;
    }
    Ok(())
}
