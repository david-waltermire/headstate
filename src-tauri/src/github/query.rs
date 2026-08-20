//! GraphQL query documents. All are read-only: no mutations, ever — this
//! product performs no GitHub write operations.

use chrono::{DateTime, Duration, Utc};

/// One query returns every open PR with everything the UI needs: CI rollup,
/// mergeability, review decision, merge-queue membership, and labels.
/// Measured at 27 PRs in ~2.9s for 2 rate-limit points of 5000/hour.
pub const PRS_QUERY: &str = r#"
query($q: String!) {
  rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt
        author { login }
        repository { nameWithOwner }
        mergeable reviewDecision isInMergeQueue totalCommentsCount
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}"#;

/// The dashboard counters, as one aliased query costing 1 point.
/// `$week` and `$month` are ISO dates.
pub const STATS_QUERY: &str = r#"
query($week: String!, $month: String!) {
  merged_week: search(query: $week, type: ISSUE) { issueCount }
  merged_month: search(query: $month, type: ISSUE) { issueCount }
}"#;

/// Detail on the most recent merged PRs, sampled for the insight cards.
///
/// 100 is the per-page maximum. It is a sample, not a census: the totals it
/// feeds are labelled with their sample size in the UI rather than being
/// presented as lifetime figures.
pub const MERGED_DETAIL_QUERY: &str = r#"
query {
  merged: search(query: "is:pr author:@me is:merged", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        createdAt
        mergedAt
        additions
        deletions
        changedFiles
        reviews { totalCount }
        comments { totalCount }
        repository { nameWithOwner }
      }
    }
  }
}"#;

/// Days per request when fetching history.
///
/// Sized for LATENCY, not just the 502 ceiling. GitHub evaluates search
/// aliases serially, so response time scales with alias count: measured
/// 30 aliases = 7.8s but 10 aliases = 2.8s. Chunks are fetched
/// concurrently, so total wall-clock is roughly one chunk rather than the
/// sum -- 30 days went from 17s serial to ~3s.
///
/// 5 days = 10 aliases, far under the ~44 where GitHub starts
/// intermittently returning 502 Bad Gateway.
pub const HISTORY_CHUNK_DAYS: i64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodRanges {
    pub week_current: (String, String),
    pub week_previous: (String, String),
    pub month_current: (String, String),
    pub month_previous: (String, String),
}

fn day(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// One `search` alias per day per series, `m{i}` merged and `o{i}` opened,
/// counting back `days` from `now`.
///
/// Aliased searches cost ONE rate-limit point in total regardless of how
/// many aliases the query carries — measured against the live API at 60
/// aliases plus 6 period aliases, cost 1. That is why this is a single
/// query rather than paginating merged PRs, which would take 6+ sequential
/// requests at current volume.
pub fn history_query(now: DateTime<Utc>, days: i64) -> String {
    history_query_range(now, 0, days)
}

/// The day buckets for `start..start+len`, keeping alias indices absolute
/// so a chunked fetch can merge results without renumbering.
///
/// GitHub 502s on a query carrying too many concurrent `search` aliases.
/// Measured: 28-36 aliases succeed 5/5, 44-46 fail INTERMITTENTLY (44
/// succeeded once then failed twice; 46 failed once then succeeded twice),
/// and 60 fails outright. It is a server-side timeout, not a documented
/// limit, so the fix is to stay well below it rather than retry into it.
pub fn history_query_range(now: DateTime<Utc>, start: i64, len: i64) -> String {
    let mut q = String::from("query {\n");
    for i in start..start + len {
        let d = day(now - Duration::days(i));
        q.push_str(&format!(
            "  m{i}: search(query: \"is:pr author:@me is:merged merged:{d}\", type: ISSUE) {{ issueCount }}\n"
        ));
        q.push_str(&format!(
            "  o{i}: search(query: \"is:pr author:@me created:{d}\", type: ISSUE) {{ issueCount }}\n"
        ));
    }
    q.push_str("}\n");
    q
}

/// Comparison windows, each ending YESTERDAY.
///
/// Today is still accumulating, so including it compares a partial period
/// against complete ones and drags every delta downward. Measured on real
/// data: including today reported +47% week-over-week where the honest
/// full-week comparison was +66%.
pub fn period_ranges(now: DateTime<Utc>) -> PeriodRanges {
    let end = now - Duration::days(1);
    let win = |offset: i64, len: i64| {
        let e = end - Duration::days(offset);
        (day(e - Duration::days(len - 1)), day(e))
    };
    PeriodRanges {
        week_current: win(0, 7),
        week_previous: win(7, 7),
        month_current: win(0, 30),
        month_previous: win(30, 30),
    }
}

/// The day buckets plus the six period-comparison aliases, so the chart
/// series and all four delta cards arrive in ONE request at cost 1.
///
/// Built by appending inside the brace `history_query` already closed, so
/// the two are never allowed to drift out of sync.
pub fn history_query_with_periods(now: DateTime<Utc>, days: i64) -> String {
    history_query_range_with_periods(now, 0, days)
}

/// Just the six period-comparison aliases.
///
/// Split out so the delta cards can render from one small, fast request
/// rather than waiting on the whole daily series.
pub fn periods_query(now: DateTime<Utc>) -> String {
    let r = period_ranges(now);
    let mut q = String::from("query {\n");
    let mut add = |alias: &str, filter: &str, range: &(String, String)| {
        q.push_str(&format!(
            "  {alias}: search(query: \"is:pr author:@me {filter}{}..{}\", type: ISSUE) {{ issueCount }}\n",
            range.0, range.1
        ));
    };
    add("week_current", "is:merged merged:", &r.week_current);
    add("week_previous", "is:merged merged:", &r.week_previous);
    add("opened_week_current", "created:", &r.week_current);
    add("opened_week_previous", "created:", &r.week_previous);
    add("month_current", "is:merged merged:", &r.month_current);
    add("month_previous", "is:merged merged:", &r.month_previous);
    q.push_str("}\n");
    q
}

/// The first chunk of a chunked fetch: day buckets plus the six period
/// aliases, which ride along at no extra cost.
pub fn history_query_range_with_periods(now: DateTime<Utc>, start: i64, len: i64) -> String {
    let base = history_query_range(now, start, len);
    let inner = base
        .strip_suffix("}\n")
        .expect("history_query always ends with a closing brace and newline");
    let r = period_ranges(now);
    let mut q = String::from(inner);
    let mut add = |alias: &str, filter: &str, range: &(String, String)| {
        q.push_str(&format!(
            "  {alias}: search(query: \"is:pr author:@me {filter}{}..{}\", type: ISSUE) {{ issueCount }}\n",
            range.0, range.1
        ));
    };
    add("week_current", "is:merged merged:", &r.week_current);
    add("week_previous", "is:merged merged:", &r.week_previous);
    add("opened_week_current", "created:", &r.week_current);
    add("opened_week_previous", "created:", &r.week_previous);
    add("month_current", "is:merged merged:", &r.month_current);
    add("month_previous", "is:merged merged:", &r.month_previous);
    q.push_str("}\n");
    q
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn builds_two_aliases_per_day() {
        let q = history_query(at("2026-08-20T14:00:00Z"), 30);
        assert_eq!(q.matches("search(").count(), 60);
        assert!(q.contains("m0: search"));
        assert!(q.contains("o29: search"));
    }

    #[test]
    fn counts_back_from_today() {
        let q = history_query(at("2026-08-20T14:00:00Z"), 2);
        assert!(q.contains("merged:2026-08-20"));
        assert!(q.contains("merged:2026-08-19"));
    }

    // Naive day arithmetic breaks across month ends; this pins the
    // behaviour chrono gives us.
    #[test]
    fn crosses_a_leap_day() {
        let q = history_query(at("2024-03-01T00:30:00Z"), 2);
        assert!(q.contains("merged:2024-02-29"));
    }

    // The current day is incomplete, so counting it against full prior
    // weeks understates the trend. Windows end yesterday.
    #[test]
    fn period_windows_exclude_today_and_do_not_overlap() {
        let r = period_ranges(at("2026-08-20T14:00:00Z"));
        assert_eq!(
            r.week_current,
            ("2026-08-13".to_string(), "2026-08-19".to_string())
        );
        assert_eq!(
            r.week_previous,
            ("2026-08-06".to_string(), "2026-08-12".to_string())
        );
    }

    #[test]
    fn month_windows_are_thirty_days_each() {
        let r = period_ranges(at("2026-08-20T14:00:00Z"));
        assert_eq!(
            r.month_current,
            ("2026-07-21".to_string(), "2026-08-19".to_string())
        );
        assert_eq!(
            r.month_previous,
            ("2026-06-21".to_string(), "2026-07-20".to_string())
        );
    }

    // The combined query must stay valid GraphQL: exactly one top-level
    // brace pair, with the period aliases INSIDE it.
    /// The README states the chunk size in prose. It drifted once already
    /// -- it claimed 15 days and three points after HISTORY_CHUNK_DAYS
    /// became 5 and the cost became 8 -- so the doc is pinned to the
    /// constant rather than trusted to be updated by hand.
    #[test]
    fn the_readme_matches_the_chunk_constant() {
        let readme = include_str!("../../../README.md");
        let spelled = match HISTORY_CHUNK_DAYS {
            5 => "five",
            7 => "seven",
            10 => "ten",
            15 => "fifteen",
            n => panic!("add a spelling for {n} days"),
        };
        assert!(
            readme.contains(&format!("chunks of {spelled} days")),
            "README does not describe {HISTORY_CHUNK_DAYS}-day chunks"
        );
    }

    // GitHub 502s on too many concurrent search aliases, intermittently
    // from ~44, and latency scales with alias count besides. A chunk must
    // stay well under that ceiling at whatever HISTORY_CHUNK_DAYS is set to.
    #[test]
    fn a_chunk_stays_under_the_alias_ceiling() {
        let now = at("2026-08-20T14:00:00Z");
        let first = history_query_range_with_periods(now, 0, HISTORY_CHUNK_DAYS);
        let rest = history_query_range(now, HISTORY_CHUNK_DAYS, HISTORY_CHUNK_DAYS);
        // Two aliases per day, plus six period aliases in the first chunk.
        let per_chunk = (HISTORY_CHUNK_DAYS * 2) as usize;
        assert_eq!(first.matches("search(").count(), per_chunk + 6);
        assert_eq!(rest.matches("search(").count(), per_chunk);
        // Derived from the constant, so changing the chunk size cannot
        // silently drift past the ceiling.
        assert!(
            first.matches("search(").count() <= 40,
            "chunk too close to the ~44-alias 502 ceiling"
        );
    }

    // Alias indices must be ABSOLUTE, or merging chunks would overwrite
    // day 0 with day 15 and silently corrupt the series.
    #[test]
    fn chunk_alias_indices_are_absolute() {
        let now = at("2026-08-20T14:00:00Z");
        let rest = history_query_range(now, 15, 3);
        assert!(rest.contains("m15: search"));
        assert!(rest.contains("m17: search"));
        assert!(!rest.contains("m0: search"));
        // And the dates line up with the absolute index.
        assert!(rest.contains("merged:2026-08-05"));
    }

    #[test]
    fn combined_query_is_balanced_and_complete() {
        let q = history_query_with_periods(at("2026-08-20T14:00:00Z"), 3);
        assert_eq!(q.matches('{').count(), q.matches('}').count());
        assert_eq!(q.matches("search(").count(), 12); // 3 days x 2 + 6 periods
        assert!(q.trim_end().ends_with('}'));
        assert!(q.contains("week_current: search"));
        assert!(q.contains("month_previous: search"));
        // The transition from the last day bucket to the first period
        // alias must not carry a closing top-level brace. Alias lines end
        // in "}" from "{ issueCount }", so check the line itself.
        // Alias lines end in "}" from "{ issueCount }", so a substring
        // check is meaningless here. What matters: exactly ONE bare
        // closing brace, and it is the last line.
        let bare: Vec<usize> = q
            .lines()
            .enumerate()
            .filter(|(_, l)| l.trim() == "}")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(bare.len(), 1, "exactly one top-level closing brace");
        assert_eq!(bare[0], q.lines().count() - 1, "and it closes the query");
    }
}
