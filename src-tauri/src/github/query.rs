//! GraphQL query documents. Every document HERE is read-only -- a
//! `search` or a `repository` lookup, never a mutation.
//!
//! Writes exist, and live in `mutate.rs`. Keeping them in a separate
//! module is the point: this file stays auditable as pure reads, and the
//! write surface is small enough to read in one sitting.

use chrono::{DateTime, Duration, Utc};

/// One query returns every open PR with everything the UI needs: CI rollup,
/// mergeability, review decision, merge-queue membership, and labels.
/// Measured at 27 PRs in ~2.9s for 2 rate-limit points of 5000/hour.
/// Two aliased searches: PRs the user authored, and PRs awaiting their
/// review. Aliased searches cost ONE point in total regardless of count,
/// so the second list is free -- verified against the live API.
///
/// `search` is aliased to `authored` rather than left bare, so the mapper
/// has to name which list it is reading and cannot silently take the wrong
/// one when a third is added.
/// One search's worth of pull requests.
///
/// ONE search per request. It used to carry both the authored and
/// review-requested searches as aliases, so every caller paid for both:
/// on a reported account with 40 authored and 71 review-requested, that
/// is 111 fully populated pull requests fetched whenever either list was
/// wanted. My pull requests recovered on that account once the page
/// shrank; To review did not, because 71 is nearly twice 40.
///
/// The alias stays named `authored` whatever the search is -- the mapper
/// reads it by that name, and renaming it per caller would mean the
/// query and the mapper could disagree.
pub const PRS_QUERY: &str = r#"
query($q: String!, $first: Int!) {
  rateLimit { cost remaining resetAt }
  viewer { login }
  authored: search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt updatedAt
        headRefName headRefOid baseRefName
        headRef { id }
        author { login }
        repository { nameWithOwner }
        mergeable mergeStateStatus reviewDecision isInMergeQueue totalCommentsCount
        # `isInMergeQueue` stays TRUE for an entry the queue has
        # rejected, so a pull request that was declined rendered as
        # calmly queued -- the amber "In merge queue" icon on something
        # that is actually stuck. The entry's own state is what
        # distinguishes them.
        mergeQueueEntry { state }
        # WHO is blocking this pull request, not just that something is.
        #
        # MEASURED against live repos: costs no extra rate-limit point,
        # and requested reviewers run median 2, max 4 across 30
        # kubernetes/kubernetes pull requests -- so 5 is ample.
        #
        # `requestedReviewer` is a UNION: User, Team and Mannequin all
        # satisfy it. Only User is selected here; the mapper drops the
        # rest rather than inventing a name for them.
        #
        # Empty is an ordinary state, not an error: repositories that
        # assign reviewers through a bot (rust-lang/rust, for one)
        # return nothing here at all.
        reviewRequests(first: 5) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        # Who has already reviewed, and what they said. A different
        # question from `reviewDecision`, which collapses everyone into
        # one verdict and names nobody.
        latestReviews(first: 5) { nodes { state author { login } } }
        labels(first: 20) { nodes { name color } }
        reviewThreads(first: 20) { nodes { isResolved isOutdated } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
"#;

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
query($first: Int!) {
  rateLimit { cost remaining resetAt }
  merged: search(query: "is:pr author:@me is:merged", type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number
        title
        url
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

/// Cycle time for two adjacent windows, so the headline figure has a prior
/// period to compare against.
///
/// Both windows in ONE aliased document at a total cost of 1 point. Each
/// window is capped at 100 nodes, so for a busy week these are SAMPLES of
/// that week rather than a census -- `sampled` says so, and the UI must
/// not present the result as complete.
pub fn cycle_trend_query(now: DateTime<Utc>) -> String {
    let r = period_ranges(now);
    format!(
        r#"query {{
  current: search(query: "is:pr author:@me is:merged merged:{}..{}", type: ISSUE, first: 100) {{
    issueCount
    nodes {{ ... on PullRequest {{ createdAt mergedAt }} }}
  }}
  previous: search(query: "is:pr author:@me is:merged merged:{}..{}", type: ISSUE, first: 100) {{
    issueCount
    nodes {{ ... on PullRequest {{ createdAt mergedAt }} }}
  }}
}}"#,
        r.week_current.0, r.week_current.1, r.week_previous.0, r.week_previous.1
    )
}

/// Everything the detail view shows, in one request.
///
/// Measured at cost 1 including per-check contexts. Fetched on open
/// rather than in the poll loop: it is per-PR and only needed while the
/// view is on screen.
///
/// Deliberately no file diff and no commit history. Headstate is for
/// deciding and acting; reviewing code belongs in GitHub or an editor,
/// and fetching a diff here would cost far more than a point.
pub const PR_DETAIL_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id number title url state isDraft body
      mergeable mergeStateStatus reviewDecision
      # Does THIS pull request's base branch use a merge queue?
      #
      # Per-pull-request rather than per-repository, which is the only
      # correct granularity: the setting is branch-scoped, so a repo can
      # queue `main` and not `release/*`, and asking at the repo level
      # would mislabel the button on every PR targeting another branch.
      #
      # MEASURED against the live API: the detail query still costs 1
      # point with this field, so it is affordable here in a way it
      # would not be on `PRS_QUERY` -- see #312.
      isMergeQueueEnabled
      # Same pair as the list query, and mapped by the same function:
      # `isInMergeQueue` alone reports a REJECTED entry as queued.
      isInMergeQueue mergeQueueEntry { state }
      additions deletions changedFiles
      headRefName headRefOid baseRefName
        headRef { id }
      createdAt updatedAt
      author { login }
      comments(first: 50) {
        totalCount
        nodes { author { login } createdAt body }
      }
      reviewThreads(first: 20) { nodes { isResolved isOutdated } }
      # Does the BASE branch of this pull request use a merge queue?
      #
      # `mergeQueue(branch:)` is branch-scoped because the setting is:
      # a repository can queue `main` and not `release/*`. Asking about
      # the PR's own base branch is therefore the only correct question
      # -- the repository-wide form would answer about the default
      # branch and mislabel the button on every PR targeting another.
      #
      # MEASURED: adds nothing to the query cost (the whole detail
      # query still totals 1 point), so this is affordable in a way the
      # list query is not -- see #312, which is why this lives on the
      # DETAIL query and not on `PRS_QUERY`.
      #
      # `null` means no queue, and also means "we could not tell". Both
      # collapse to "not queued", which is the safe default: it offers
      # a plain Merge, and GitHub refuses it if the branch really does
      # require the queue.
      # The VIEWER's own latest review, which is a different question
      # from `reviewDecision`. The decision is the pull request's
      # aggregate state: it reads CHANGES_REQUESTED when someone else
      # blocked it, and REVIEW_REQUIRED when a second approval is
      # outstanding -- neither of which tells the user whether THEIR
      # click landed. Approving and then seeing an unchanged button is
      # the reported confusion, so the answer has to be per-viewer.
      #
      # `latestReviews` returns one review per reviewer, so a small page
      # covers any realistic pull request and the viewer's entry is
      # found by matching login.
      latestReviews(first: 20) { nodes { state author { login } } }
      commits(last: 1) {
        nodes { commit { statusCheckRollup {
          state
          contexts(first: 20) { nodes {
            ... on CheckRun {
              name conclusion detailsUrl
              # The workflow RUN, not the check run: re-running failed
              # jobs is one REST call per run, where per-check would be
              # one call each and could not re-run a job that never
              # started. `workflowRun` is null for check runs from apps
              # that are not GitHub Actions, which is why the mapper
              # treats it as optional rather than assuming it.
              checkSuite { workflowRun { databaseId } }
            }
            ... on StatusContext { context state targetUrl }
          } }
        } } }
      }
    }
  }
}"#;

/// How many pull requests a search matches, and nothing else.
///
/// `issueCount` alone: no nodes, so none of the per-pull-request fields
/// that make the list query expensive are resolved at all. This exists
/// because the sidebar badge needs a NUMBER, and fetching 100 fully
/// populated pull requests to render one was both the largest wasted
/// request in the app and a way to fail on a view that shows no pull
/// requests at all.
pub const COUNT_QUERY: &str = r#"
query($q: String!) {
  rateLimit { cost remaining resetAt }
  matching: search(query: $q, type: ISSUE) { issueCount }
}
"#;

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
