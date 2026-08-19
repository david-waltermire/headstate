//! SQLite persistence.
//!
//! Two distinct roles, kept in separate modules so they are not conflated:
//!
//! - [`cache`]: the snapshot cache -- the last poll's PR list, so launch
//!   paints real content instead of a spinner, and the app is readable
//!   offline.
//! - [`history`]: a row per PR observed merged, so the dashboard's
//!   week/month counters survive offline and can become trend charts later
//!   without a schema rewrite.
//!
//! GitHub search stays authoritative for the displayed numbers; where local
//! history and GitHub disagree, GitHub wins.

mod cache;
mod history;
mod schema;

pub use cache::{load_snapshot, save_snapshot};
pub use history::record_merges;
pub use schema::{open_db, StoreError};

#[cfg(test)]
use schema::migrate;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::{CiState, Label, MergeState, PullRequest, ReviewState};
    use chrono::Utc;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn sample() -> PullRequest {
        PullRequest {
            number: 42,
            title: "Add retry to the fetch client".into(),
            url: "https://github.com/octocat/hello-world/pull/42".into(),
            repo: "octocat/hello-world".into(),
            author: "octocat".into(),
            is_draft: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            ci: CiState::Success,
            merge: MergeState::Mergeable,
            review: ReviewState::Approved,
            in_merge_queue: false,
            labels: vec![Label {
                name: "bug".into(),
                color: "d73a4a".into(),
            }],
            comment_count: 2,
        }
    }

    #[test]
    fn round_trips_a_snapshot() {
        let conn = db();
        save_snapshot(&conn, &[sample()]).unwrap();
        let loaded = load_snapshot(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].number, 42);
        assert_eq!(loaded[0].labels[0].name, "bug");
    }

    #[test]
    fn a_snapshot_replaces_the_previous_one() {
        let conn = db();
        save_snapshot(&conn, &[sample()]).unwrap();
        save_snapshot(&conn, &[]).unwrap();
        assert_eq!(load_snapshot(&conn).unwrap().len(), 0);
    }

    #[test]
    fn loading_from_an_empty_db_returns_empty_not_an_error() {
        assert_eq!(load_snapshot(&db()).unwrap().len(), 0);
    }

    #[test]
    fn migrations_are_idempotent() {
        let conn = db();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(load_snapshot(&conn).unwrap().len(), 0);
    }
}
