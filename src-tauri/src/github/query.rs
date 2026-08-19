//! GraphQL query documents. Both are read-only: no mutations, ever — this
//! product performs no GitHub write operations.

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
