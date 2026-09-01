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

    /// For logs. Names the list a stale row belonged to, so "ignoring a
    /// snapshot" says WHICH view will be slow to paint.
    fn label(self) -> &'static str {
        match self {
            CachedList::Authored => "authored",
            CachedList::Reviewing => "reviewing",
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

/// How old a cached list may be and still be shown.
///
/// The reviewing snapshot is written in exactly one place -- inside
/// `get_reviewing`, which only runs when the To review view is open. The
/// poll loop never touches it. So visiting that view once and not
/// returning froze the snapshot forever, and every later cold start
/// painted it as though it were current. On a real machine that meant a
/// pull request merged four days earlier still listed as awaiting review.
///
/// An hour is well past the live query's 60s `staleTime`, so this never
/// costs the cold-start win the cache exists for (#328): a snapshot
/// written this session is always fresh enough. It only refuses one old
/// enough to be wrong.
const MAX_SNAPSHOT_AGE_SECS: i64 = 60 * 60;

/// Whether a snapshot written at `fetched_at` is still worth showing.
///
/// `fetched_at` is written by SQLite's `datetime('now')`, which is UTC
/// with no offset marker -- so it is parsed as naive and compared against
/// UTC rather than local time. Reading it as local would make the cache
/// look hours old or hours in the future depending on the zone, which is
/// the kind of bug that only appears for users east of UTC.
///
/// An UNPARSEABLE timestamp counts as too old. That direction is
/// deliberate: the cost of refusing a good snapshot is one slow view, and
/// the cost of accepting a bad one is showing merged work as open.
fn is_fresh(fetched_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Ok(naive) = chrono::NaiveDateTime::parse_from_str(fetched_at, "%Y-%m-%d %H:%M:%S") else {
        return false;
    };
    let age = now.signed_duration_since(naive.and_utc()).num_seconds();
    // A NEGATIVE age -- a row written in the future -- is treated as
    // fresh rather than as an error. Clocks move backwards (NTP
    // corrections, timezone changes, a VM resuming), and refusing a
    // snapshot for that would blank the view over something harmless.
    age <= MAX_SNAPSHOT_AGE_SECS
}

pub fn load_snapshot(conn: &Connection, which: CachedList) -> Result<Vec<PullRequest>, StoreError> {
    // `.optional()`, not `.ok()`: the latter collapses every rusqlite error
    // into "no snapshot", so a corrupt or locked database would render as
    // "you have no pull requests". Silently showing an empty list when the
    // store is broken is worse than surfacing the failure.
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT payload, fetched_at FROM snapshot WHERE id = ?1",
            [which.id()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    // Age it out BEFORE parsing. A snapshot too old to trust is reported
    // as no snapshot, which sends the caller to a fresh fetch and shows
    // the loading state -- honest about not knowing, rather than
    // confidently wrong. Nothing else reads `fetched_at`, so without this
    // the column was written on every save and never once consulted.
    let payload = match row {
        Some((p, at)) if is_fresh(&at, chrono::Utc::now()) => Some(p),
        Some((_, at)) => {
            log::info!(
                "ignoring a {} snapshot from {at}: older than {MAX_SNAPSHOT_AGE_SECS}s",
                which.label()
            );
            None
        }
        None => None,
    };
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

    /// The reported bug, at its root.
    ///
    /// `CachedList::Reviewing` is written in exactly one place -- inside
    /// `get_reviewing`, which only runs when the To review view is open.
    /// The poll loop never touches it. So visiting that view once and not
    /// returning froze the snapshot, and on a real machine a pull request
    /// merged four days earlier was still listed as awaiting review, with
    /// nothing on screen suggesting the data was old.
    #[test]
    fn a_stale_snapshot_is_not_returned() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();
        let prs: Vec<PullRequest> = serde_json::from_str(V1_SNAPSHOT).unwrap();
        save_snapshot(&conn, CachedList::Reviewing, &prs).unwrap();

        // Backdate the row the way four days of not visiting the view
        // would have.
        conn.execute(
            "UPDATE snapshot SET fetched_at = datetime('now', '-4 days') WHERE id = 2",
            [],
        )
        .unwrap();

        assert!(
            load_snapshot(&conn, CachedList::Reviewing)
                .unwrap()
                .is_empty(),
            "a four-day-old review list must not be painted as current"
        );
    }

    /// ...but the cold-start win the cache exists for (#328) must survive.
    /// A snapshot written this session is always fresh enough.
    #[test]
    fn a_snapshot_written_now_is_still_returned() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::store::open_db(&dir.path().join("t.db")).unwrap();
        let prs: Vec<PullRequest> = serde_json::from_str(V1_SNAPSHOT).unwrap();
        save_snapshot(&conn, CachedList::Reviewing, &prs).unwrap();

        assert_eq!(
            load_snapshot(&conn, CachedList::Reviewing).unwrap()[0].number,
            42
        );
    }

    /// The boundary, from both sides.
    #[test]
    fn freshness_is_bounded_at_an_hour() {
        let now = chrono::Utc::now();
        let at = |secs: i64| {
            (now - chrono::Duration::seconds(secs))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        };
        assert!(is_fresh(&at(60), now), "a minute old is fresh");
        assert!(is_fresh(&at(MAX_SNAPSHOT_AGE_SECS - 5), now));
        assert!(!is_fresh(&at(MAX_SNAPSHOT_AGE_SECS + 5), now));
        assert!(!is_fresh(&at(4 * 24 * 3600), now), "four days is not fresh");
    }

    /// `fetched_at` is SQLite's `datetime('now')`: UTC with no offset
    /// marker. Parsing it as LOCAL time would make the cache look hours
    /// stale or hours in the future depending on the zone -- a bug that
    /// only shows up for users away from UTC, which is most of them.
    #[test]
    fn the_timestamp_is_read_as_utc_not_local() {
        let now = chrono::Utc::now();
        let recent = (now - chrono::Duration::minutes(2))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert!(
            is_fresh(&recent, now),
            "a two-minute-old snapshot must be fresh in every timezone"
        );
    }

    /// Clocks move backwards -- NTP corrections, timezone changes, a VM
    /// resuming. A row that appears to come from the future is harmless,
    /// and blanking the view over it would be a worse outcome than
    /// showing it.
    #[test]
    fn a_future_timestamp_is_treated_as_fresh() {
        let now = chrono::Utc::now();
        let ahead = (now + chrono::Duration::hours(3))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert!(is_fresh(&ahead, now));
    }

    /// An unreadable timestamp counts as TOO OLD. Refusing a good
    /// snapshot costs one slow view; accepting a bad one shows merged
    /// work as open.
    #[test]
    fn an_unparseable_timestamp_is_not_fresh() {
        let now = chrono::Utc::now();
        assert!(!is_fresh("", now));
        assert!(!is_fresh("not a date", now));
        assert!(
            !is_fresh("2026-09-01T21:02:38Z", now),
            "RFC 3339 is not the stored shape"
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
