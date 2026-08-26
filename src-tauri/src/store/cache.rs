//! The snapshot cache: the last poll's PR list, so launch paints real
//! content instead of a spinner, and the app is readable offline.
//!
//! GitHub search stays authoritative for the displayed numbers; this is
//! purely a cache of the last successful fetch.

use super::schema::StoreError;
use crate::github::model::PullRequest;
use rusqlite::{Connection, OptionalExtension};

/// Which cached list a row holds.
///
/// The table originally allowed exactly one row (`CHECK (id = 1)`), so
/// only the authored list was cached and To review always waited on a
/// live query -- ~20s on a 60-PR queue with an empty panel throughout.
/// Migration 4 relaxed that; this names the rows so the two lists cannot
/// be confused for each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachedList {
    /// Pull requests the user authored. Row 1, unchanged, so an existing
    /// cache keeps working across the upgrade.
    Authored,
    /// Pull requests awaiting the user's review.
    Reviewing,
}

impl CachedList {
    fn id(self) -> i64 {
        match self {
            CachedList::Authored => 1,
            CachedList::Reviewing => 2,
        }
    }
}

/// The whole snapshot is one JSON row. At ~30 PRs this is a few hundred KB,
/// so a normalised schema would buy nothing and cost migrations later.
pub fn save_snapshot(
    conn: &Connection,
    which: CachedList,
    prs: &[PullRequest],
) -> Result<(), StoreError> {
    let payload = serde_json::to_string(prs)?;
    conn.execute(
        "INSERT INTO snapshot (id, payload, fetched_at) VALUES (?2, ?1, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET payload = ?1, fetched_at = datetime('now')",
        rusqlite::params![&payload, which.id()],
    )?;
    Ok(())
}

pub fn load_snapshot(conn: &Connection, which: CachedList) -> Result<Vec<PullRequest>, StoreError> {
    // `.optional()`, not `.ok()`: the latter collapses every rusqlite error
    // into "no snapshot", so a corrupt or locked database would render as
    // "you have no pull requests". Silently showing an empty list when the
    // store is broken is worse than surfacing the failure.
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM snapshot WHERE id = ?1",
            [which.id()],
            |r| r.get(0),
        )
        .optional()?;
    match payload {
        // A cache that cannot be parsed is NOT the same as an empty one.
        // Propagating the error would blank the list behind a retry, and
        // swallowing it would assert "you have no pull requests" -- so
        // discard the unreadable row and report none-cached, which sends
        // the caller to a fresh fetch. Logged loudly: this should only
        // happen on an upgrade that changed the shape, and it is the last
        // clue if it happens for any other reason.
        Some(p) => match serde_json::from_str(&p) {
            Ok(prs) => Ok(prs),
            Err(e) => {
                log::warn!("discarding an unreadable snapshot ({e}); fetching fresh data instead");
                Ok(Vec::new())
            }
        },
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::MergeStateStatus;

    /// A snapshot exactly as v1.0.1 wrote it.
    ///
    /// A LITERAL payload, not a round-trip of the current type -- a
    /// round-trip cannot catch this by construction, since it would
    /// serialise the very fields whose absence is the bug.
    const V1_SNAPSHOT: &str = r#"[{
      "number": 42,
      "title": "an older pull request",
      "url": "https://github.com/o/r/pull/42",
      "repo": "o/r",
      "author": "octocat",
      "is_draft": false,
      "head_ref": "feature",
      "base_ref": "main",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-02T00:00:00Z",
      "ci": "success",
      "merge": "mergeable",
      "review": "approved",
      "in_merge_queue": false,
      "labels": [],
      "comment_count": 3
    }]"#;

    /// The v2.0.0 upgrade bug: `id`, `head_oid`, `merge_status`, and
    /// `unresolved_threads` were added as required fields, so serde
    /// rejected the whole payload and every pull request disappeared.
    /// A fresh install never hit it -- only upgrades.
    #[test]
    fn a_v1_snapshot_still_loads() {
        let prs: Vec<PullRequest> =
            serde_json::from_str(V1_SNAPSHOT).expect("a v1 snapshot must still deserialise");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 42);
        assert_eq!(prs[0].title, "an older pull request");
        // Fields that survived the upgrade keep their values.
        assert_eq!(prs[0].comment_count, 3);
    }

    /// Defaults must be the safe answer, not merely a compiling one.
    /// `merge_status` reaching `Clean` would enable a merge button on data
    /// the app never fetched -- the one wrong default that costs
    /// something.
    #[test]
    fn missing_fields_default_to_the_safe_value() {
        let prs: Vec<PullRequest> = serde_json::from_str(V1_SNAPSHOT).unwrap();
        assert_eq!(prs[0].merge_status, MergeStateStatus::Unknown);
        assert_eq!(prs[0].unresolved_threads, 0);
        assert!(prs[0].id.is_empty());
        assert!(prs[0].head_oid.is_empty());
    }

    /// The two lists must not overwrite each other.
    ///
    /// The table originally allowed one row (`CHECK (id = 1)`), so
    /// caching the review list at all required migration 4. If both
    /// wrote to the same id, To review would show the authored list --
    /// a far worse bug than the slow load it is meant to fix.
    #[test]
    fn the_two_lists_are_cached_independently() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();

        let authored: Vec<PullRequest> = serde_json::from_str(V1_SNAPSHOT).unwrap();
        let mut reviewing = authored.clone();
        reviewing[0].number = 99;

        save_snapshot(&conn, CachedList::Authored, &authored).unwrap();
        save_snapshot(&conn, CachedList::Reviewing, &reviewing).unwrap();

        assert_eq!(
            load_snapshot(&conn, CachedList::Authored).unwrap()[0].number,
            42
        );
        assert_eq!(
            load_snapshot(&conn, CachedList::Reviewing).unwrap()[0].number,
            99
        );
    }

    /// An empty review cache is the first-run case, and must read as
    /// "nothing cached" rather than erroring.
    #[test]
    fn an_absent_review_cache_reads_as_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();
        assert!(load_snapshot(&conn, CachedList::Reviewing)
            .unwrap()
            .is_empty());
    }

    /// An unreadable cache must not assert "you have no pull requests".
    /// It reports none-cached, which sends the caller to a fresh fetch.
    #[test]
    fn an_unreadable_snapshot_reports_none_cached_rather_than_erroring() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();
        conn.execute(
            "INSERT INTO snapshot (id, payload, fetched_at) VALUES (1, ?1, datetime('now'))",
            ["{ this is not json at all"],
        )
        .unwrap();

        let got = load_snapshot(&conn, CachedList::Authored)
            .expect("a corrupt cache must not be an error");
        assert!(got.is_empty(), "a corrupt cache must not invent rows");
    }
}
