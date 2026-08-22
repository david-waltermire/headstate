//! The GitHub client: wraps octocrab's GraphQL transport with the two
//! queries the product needs, and maps their responses into typed Rust.
//!
//! Reads by default; writes only on explicit user action. The mutation
//! transport is `graphql_mutation` below, used solely by `mutate.rs`.

use super::map::{
    map_cycle_trend, map_detail, map_history, map_list, map_merged_detail, map_rate_limit,
    map_search, map_total,
};
use super::model::{CycleTrend, History, MergedDetail, Periods, PrDetail, PullRequest, Stats};
use super::query::{
    cycle_trend_query, history_query_range, history_query_range_with_periods, periods_query,
    HISTORY_CHUNK_DAYS, MERGED_DETAIL_QUERY, PRS_QUERY, PR_DETAIL_QUERY, STATS_QUERY,
};
use chrono::{DateTime, Duration, Utc};
use octocrab::Octocrab;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("GitHub request failed: {0}")]
    Api(#[from] octocrab::Error),
    /// A concurrent chunk task panicked or was cancelled. Surfaced rather
    /// than ignored: silently dropping a chunk would render a short series
    /// that looks like real data.
    #[error("history fetch task failed: {0}")]
    Join(String),
    /// The request exceeded its wall-clock ceiling. Distinct from a
    /// transport error so the banner can say "timed out" rather than
    /// something generic the user cannot act on.
    #[error("GitHub request timed out after {0}s")]
    Timeout(u64),
    /// The response carried GraphQL errors and no usable data.
    #[error("GitHub GraphQL error: {0}")]
    Graphql(String),
    /// The hourly budget is exhausted. Distinct so the banner can say to
    /// wait rather than implying a network fault the user might chase.
    #[error("GitHub rate limit reached — polling will resume automatically ({0})")]
    RateLimited(String),
}

impl ClientError {
    /// Whether waiting is likely to fix this on its own.
    ///
    /// Transport failures are the common case and almost always recover:
    /// measured on a real log, 5 of 164 polls failed with SendRequest and
    /// EVERY one succeeded on the next tick. A Wi-Fi hiccup, a DNS blip,
    /// a laptop waking up.
    ///
    /// Auth and rate limits are the opposite: the next tick will fail the
    /// same way, so the user needs to know now. Rate limiting is listed
    /// as NOT transient for that reason -- it resolves eventually, but
    /// not within a poll or two, and its message tells the user to wait
    /// rather than chase a network fault.
    pub fn is_transient(&self) -> bool {
        match self {
            // The request never reached GitHub, or the response never
            // came back. Retrying is exactly the right response.
            ClientError::Timeout(_) => true,
            ClientError::Api(e) => is_transport_error(e),
            // A panicked chunk task is a bug, not weather.
            ClientError::Join(_) => false,
            // GraphQL errors mean the server answered and objected: a
            // malformed query, a missing field, a permissions problem.
            // The next identical request objects identically.
            ClientError::Graphql(_) => false,
            ClientError::RateLimited(_) => false,
        }
    }
}

/// Whether an octocrab error is a transport failure rather than a reply.
///
/// Octocrab wraps hyper/reqwest failures in `Service`, which is what a
/// dropped connection surfaces as -- the "client error (SendRequest)"
/// the banner was showing. An HTTP status means GitHub answered, which is
/// a different situation even when the status is a server error.
fn is_transport_error(e: &octocrab::Error) -> bool {
    match e {
        octocrab::Error::Service { .. } | octocrab::Error::Hyper { .. } => true,
        // 5xx is the server having a bad time, which the next tick may
        // well survive. 4xx is us being wrong, and repeating will not
        // help.
        octocrab::Error::GitHub { source, .. } => source.status_code.is_server_error(),
        _ => false,
    }
}

pub struct GitHubClient {
    octocrab: Octocrab,
}

impl GitHubClient {
    pub fn new(octocrab: Octocrab) -> Self {
        Self { octocrab }
    }

    /// Run a GraphQL document, keeping `data` on a PARTIAL success.
    ///
    /// `Octocrab::graphql` deserializes into `GraphqlResponse`, an untagged
    /// enum whose `Err` variant is declared FIRST -- so a 200 carrying both
    /// `data` and a non-empty `errors` array matches `Err` and the usable
    /// `data` is dropped, even though octocrab's own field doc says
    /// "GraphQL returns `data` even in the case of a partial success."
    ///
    /// GitHub returns exactly that when one repository's resolver fails:
    /// every other PR node is present and good. Discarding them meant one
    /// bad repo blanked the whole list and skipped the snapshot write --
    /// defeating `map_search`'s own "one malformed PR should not blank the
    /// list" rule one layer above where it was enforced.
    ///
    /// Errors are only fatal when NO data came back at all.
    async fn graphql_partial_ok(
        &self,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        graphql_partial_ok(&self.octocrab, body).await
    }

    /// Every open PR authored by the viewer, with CI, mergeability, review
    /// decision, and merge-queue state.
    ///
    /// Octocrab unwraps the GraphQL `data` envelope, so the value returned
    /// here has `search` at its top level rather than under `data`.
    pub async fn fetch_prs(&self) -> Result<Vec<PullRequest>, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({
                "query": PRS_QUERY,
                "variables": {
                    "q": "is:pr is:open author:@me",
                    "reviewing": "is:pr is:open review-requested:@me"
                }
            }))
            .await?;
        Ok(map_search(&v))
    }

    /// PRs awaiting the user's review.
    ///
    /// Rides along in PRS_QUERY at zero extra rate-limit cost. Kept a
    /// separate call rather than folded into `fetch_prs`'s return type so
    /// the snapshot cache, poll loop and existing commands keep their
    /// shapes; the poll loop fetches both in one request via
    /// `fetch_prs_and_reviewing`.
    pub async fn fetch_reviewing(&self) -> Result<Vec<PullRequest>, ClientError> {
        Ok(self.fetch_prs_and_reviewing().await?.1)
    }

    /// Both lists from ONE request.
    pub async fn fetch_prs_and_reviewing(
        &self,
    ) -> Result<(Vec<PullRequest>, Vec<PullRequest>), ClientError> {
        let v = self
            .graphql_partial_ok(&json!({
                "query": PRS_QUERY,
                "variables": {
                    "q": "is:pr is:open author:@me",
                    "reviewing": "is:pr is:open review-requested:@me"
                }
            }))
            .await?;
        Ok((map_list(&v, "authored"), map_list(&v, "reviewing")))
    }

    /// Median cycle time this week against last, in one request.
    pub async fn fetch_cycle_trend(&self, now: DateTime<Utc>) -> Result<CycleTrend, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": cycle_trend_query(now) }))
            .await?;
        Ok(map_cycle_trend(&v))
    }

    /// Run a mutation, treating ANY error as failure.
    ///
    /// Deliberately unlike `graphql_partial_ok`, which keeps `data` when
    /// errors accompany it. That is right for a read -- 26 good PR nodes
    /// beat none -- and wrong for a write: "partly merged" is not a
    /// state, and reporting success while GitHub complained would be the
    /// worst possible outcome for an action the user cannot undo.
    ///
    /// The GitHub message is passed through verbatim: "base branch was
    /// modified" is display-ready and more useful than anything this
    /// layer could substitute.
    pub(super) async fn graphql_mutation(
        &self,
        body: &serde_json::Value,
    ) -> Result<(), ClientError> {
        let raw: serde_json::Value = self.octocrab.post("/graphql", Some(body)).await?;

        if let Some(errs) = raw.get("errors").and_then(|e| e.as_array()) {
            if !errs.is_empty() {
                let msg = errs
                    .iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(ClientError::Graphql(if msg.is_empty() {
                    "GitHub refused the change".to_string()
                } else {
                    msg
                }));
            }
        }

        // A response with neither errors nor data means something is
        // wrong with our request shape; do not report success for it.
        if raw.get("data").is_none_or(|d| d.is_null()) {
            return Err(ClientError::Graphql(
                "GitHub returned no result for the change".into(),
            ));
        }
        Ok(())
    }

    /// Everything the detail view needs, in one request at cost 1.
    ///
    /// `repo` is `owner/name`; it is split here rather than by the caller
    /// so a malformed value fails in one place with a clear message.
    pub async fn fetch_pr_detail(&self, repo: &str, number: u64) -> Result<PrDetail, ClientError> {
        let (owner, name) = repo
            .split_once('/')
            .ok_or_else(|| ClientError::Graphql(format!("malformed repository: {repo}")))?;
        let v = self
            .graphql_partial_ok(&json!({
                "query": PR_DETAIL_QUERY,
                "variables": { "owner": owner, "repo": name, "number": number }
            }))
            .await?;
        Ok(map_detail(&v, repo))
    }

    /// The PR list together with GitHub's own match count.
    ///
    /// `PRS_QUERY` is `first: 100` with no pagination, and it already
    /// selects `issueCount` -- nothing read it. Above 100 open PRs the
    /// list, the sidebar, and the priorities strip all reported 100 with
    /// the remainder invisible; the strip in particular is designed never
    /// to have a false negative, and silently dropping PR 118 breaks that
    /// promise. Returning the total lets the UI say "showing 100 of 137"
    /// instead of quietly lying.
    pub async fn fetch_prs_with_total(&self) -> Result<(Vec<PullRequest>, u64), ClientError> {
        let v = self
            .graphql_partial_ok(&json!({
                "query": PRS_QUERY,
                "variables": {
                    "q": "is:pr is:open author:@me",
                    "reviewing": "is:pr is:open review-requested:@me"
                }
            }))
            .await?;
        // Warn before the budget is actually gone, so the user learns
        // about it from a message rather than from a wall of failures.
        if let Some((remaining, reset)) = map_rate_limit(&v) {
            if remaining < 500 {
                log::warn!("GitHub rate limit low: {remaining} remaining, resets at {reset}");
            }
        }
        Ok((map_search(&v), map_total(&v)))
    }

    /// The two historical counters. The other five dashboard numbers are
    /// derived from the PR list in the frontend and cost no extra request.
    pub async fn fetch_stats(&self, now: DateTime<Utc>) -> Result<Stats, ClientError> {
        let week = (now - Duration::days(7)).format("%Y-%m-%d").to_string();
        let month = (now - Duration::days(30)).format("%Y-%m-%d").to_string();
        let v = self
            .graphql_partial_ok(&json!({
                "query": STATS_QUERY,
                "variables": {
                    "week": format!("is:pr author:@me is:merged merged:>={week}"),
                    "month": format!("is:pr author:@me is:merged merged:>={month}"),
                }
            }))
            .await?;
        Ok(Stats {
            merged_week: v["merged_week"]["issueCount"].as_u64().unwrap_or(0),
            merged_month: v["merged_month"]["issueCount"].as_u64().unwrap_or(0),
            ..Stats::default()
        })
    }

    /// The chart's daily merged/opened series plus all four period-delta
    /// cards, in one request built by `history_query_with_periods`.
    /// Day-bucket chunks, fetched CONCURRENTLY and merged.
    ///
    /// GitHub evaluates search aliases serially, so one large query is slow
    /// (measured: 30 aliases = 7.8s). Small chunks in parallel finish in
    /// roughly the time of the slowest one -- 30 days dropped from 17s to
    /// ~3s. Chunk count is bounded by `days / HISTORY_CHUNK_DAYS`, so at the
    /// 90-day clamp this is 18 concurrent requests at 1 point each.
    async fn fetch_history_values(
        &self,
        now: DateTime<Utc>,
        days: i64,
        with_periods: bool,
    ) -> Result<serde_json::Value, ClientError> {
        let mut set = tokio::task::JoinSet::new();
        let mut start = 0;
        while start < days {
            let len = (days - start).min(HISTORY_CHUNK_DAYS);
            let q = if start == 0 && with_periods {
                history_query_range_with_periods(now, start, len)
            } else {
                history_query_range(now, start, len)
            };
            let oc = self.octocrab.clone();
            set.spawn(async move { graphql_partial_ok(&oc, &json!({ "query": q })).await });
            start += len;
        }

        let mut merged = serde_json::Map::new();
        while let Some(joined) = set.join_next().await {
            // A panicked task would otherwise be swallowed and show up as a
            // silently short series, so it is surfaced as an error.
            let chunk = joined.map_err(|e| ClientError::Join(e.to_string()))??;
            if let Some(obj) = chunk.as_object() {
                // Alias indices are absolute, so chunks merge in any
                // completion order without renumbering or clobbering.
                for (k, val) in obj {
                    merged.insert(k.clone(), val.clone());
                }
            }
        }
        Ok(serde_json::Value::Object(merged))
    }

    /// Just the period comparisons -- one small request so the delta cards
    /// can render without waiting on the daily series.
    pub async fn fetch_periods(&self, now: DateTime<Utc>) -> Result<Periods, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": periods_query(now) }))
            .await?;
        let count = |k: &str| v[k]["issueCount"].as_u64().unwrap_or(0);
        Ok(Periods {
            week_current: count("week_current"),
            week_previous: count("week_previous"),
            opened_week_current: count("opened_week_current"),
            opened_week_previous: count("opened_week_previous"),
            month_current: count("month_current"),
            month_previous: count("month_previous"),
        })
    }

    pub async fn fetch_history(
        &self,
        now: DateTime<Utc>,
        days: i64,
    ) -> Result<History, ClientError> {
        // Chunked because GitHub 502s on a query with too many concurrent
        // `search` aliases -- see HISTORY_CHUNK_DAYS. The first chunk also
        // carries the six period aliases, so a 30-day fetch is six requests
        // and two rate-limit points rather than one request that fails.
        let v = self.fetch_history_values(now, days, true).await?;
        let count = |k: &str| v[k]["issueCount"].as_u64().unwrap_or(0);
        Ok(History {
            points: map_history(&v, days, now),
            week_current: count("week_current"),
            week_previous: count("week_previous"),
            opened_week_current: count("opened_week_current"),
            opened_week_previous: count("opened_week_previous"),
            month_current: count("month_current"),
            month_previous: count("month_previous"),
        })
    }

    /// A sample of the most recent merged PRs, for the insight cards.
    pub async fn fetch_merged_detail(&self) -> Result<MergedDetail, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": MERGED_DETAIL_QUERY }))
            .await?;
        Ok(map_merged_detail(&v))
    }
}

/// See `GitHubClient::graphql_partial_ok`. A free function so the
/// concurrent history chunks, which own a cloned `Octocrab` inside a
/// spawned task, get the same partial-success handling.
async fn graphql_partial_ok(
    octocrab: &Octocrab,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let raw: serde_json::Value = octocrab.post("/graphql", Some(body)).await?;

    let errors = raw.get("errors").and_then(|e| e.as_array());
    let data = raw.get("data").filter(|d| !d.is_null());

    match (data, errors) {
        (Some(d), _) => Ok(d.clone()),
        (None, Some(errs)) if !errs.is_empty() => {
            let msg = errs
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            // Name the condition rather than leaving a generic failure the
            // user cannot tell from a network problem or a bad token.
            if msg.to_lowercase().contains("rate limit") {
                return Err(ClientError::RateLimited(msg));
            }
            Err(ClientError::Graphql(if msg.is_empty() {
                "GraphQL request failed".to_string()
            } else {
                msg
            }))
        }
        (None, _) => Err(ClientError::Graphql(
            "GraphQL response contained no data".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client_for(server: &MockServer) -> GitHubClient {
        let oc = octocrab::Octocrab::builder()
            .base_uri(server.uri())
            .unwrap()
            .personal_token("test-token".to_string())
            .build()
            .unwrap();
        GitHubClient::new(oc)
    }

    #[tokio::test]
    async fn fetch_prs_maps_the_response() {
        let server = MockServer::start().await;
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": body
            })))
            .mount(&server)
            .await;

        let prs = client_for(&server).await.fetch_prs().await.unwrap();
        assert_eq!(prs.len(), 3);
        assert_eq!(prs[0].number, 42);
    }

    #[tokio::test]
    async fn an_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server).await.fetch_prs().await.is_err());
    }

    #[tokio::test]
    async fn fetch_stats_maps_the_aliased_counts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {
                    "merged_week": { "issueCount": 4 },
                    "merged_month": { "issueCount": 11 }
                }
            })))
            .mount(&server)
            .await;

        let stats = client_for(&server)
            .await
            .fetch_stats(Utc::now())
            .await
            .unwrap();
        assert_eq!(stats.merged_week, 4);
        assert_eq!(stats.merged_month, 11);
        assert_eq!(stats.in_merge_queue, 0);
    }

    #[tokio::test]
    async fn fetch_stats_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_stats(Utc::now())
            .await
            .is_err());
    }

    /// Rate-limit exhaustion is named, not left as a generic failure the
    /// user cannot tell from a network fault or a bad token.
    #[tokio::test]
    async fn rate_limit_errors_say_so() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{ "message": "API rate limit exceeded for user ID 1." }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(matches!(err, ClientError::RateLimited(_)), "got {err:?}");
        assert!(err.to_string().contains("resume automatically"));
    }

    /// A mutation that GitHub refuses must NOT report success.
    ///
    /// Deliberately unlike the read path, which keeps partial data: for
    /// a write, "partly merged" is not a state, and claiming success
    /// while GitHub complained is the worst outcome for an action the
    /// user cannot undo.
    #[tokio::test]
    async fn a_refused_mutation_is_an_error_with_github_s_own_words() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "mergePullRequest": null },
                "errors": [{ "message": "Base branch was modified. Review and try the merge again." }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Merge)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("Base branch was modified"),
            "GitHub's own message must survive: {err}"
        );
    }

    #[tokio::test]
    async fn a_clean_mutation_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "closePullRequest": { "clientMutationId": null } }
            })))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Close)
            .await
            .expect("a clean response is success");
    }

    /// A response with neither data nor errors means our request shape is
    /// wrong; reporting success would hide that.
    #[tokio::test]
    async fn an_empty_mutation_response_is_not_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Merge)
            .await
            .is_err());
    }

    /// `issueCount` is what makes truncation visible; it was requested by
    /// the query and read by nothing, so >100 open PRs silently became 100.
    #[tokio::test]
    async fn reports_the_true_total_when_the_page_truncates() {
        let server = MockServer::start().await;
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        // The fixture has 3 nodes; claim GitHub matched 137.
        let mut truncated = body.clone();
        truncated["authored"]["issueCount"] = json!(137);
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": truncated })))
            .mount(&server)
            .await;

        let (prs, total) = client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .unwrap();
        assert_eq!(prs.len(), 3);
        assert_eq!(total, 137, "the UI needs the real total to say so");
    }

    /// The bug this replaced: octocrab's `GraphqlResponse` is untagged
    /// with `Err` first, so a 200 carrying BOTH `data` and `errors`
    /// deserialized as an error and threw away every good node. GitHub
    /// sends exactly that when one repo's resolver fails.
    #[tokio::test]
    async fn a_partial_success_keeps_the_good_nodes() {
        let server = MockServer::start().await;
        // The same three-PR fixture the clean-success test uses; the only
        // difference is the `errors` array riding alongside it.
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": body,
                "errors": [{
                    "type": "SERVICE_UNAVAILABLE",
                    "message": "Something went wrong while executing your query."
                }]
            })))
            .mount(&server)
            .await;

        let prs = client_for(&server).await.fetch_prs().await.unwrap();
        assert_eq!(prs.len(), 3, "a partial success must not blank the list");
        assert_eq!(prs[0].number, 42);
    }

    /// Errors are still fatal when nothing usable came back, and the
    /// message reaches the banner rather than being swallowed.
    #[tokio::test]
    async fn errors_without_data_are_still_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{ "message": "Could not resolve to a Repository" }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(
            err.to_string()
                .contains("Could not resolve to a Repository"),
            "message must reach the user: {err}"
        );
    }

    #[tokio::test]
    async fn fetch_history_maps_buckets_and_periods() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "m0": {"issueCount": 5}, "o0": {"issueCount": 7},
                    "m1": {"issueCount": 3}, "o1": {"issueCount": 4},
                    "week_current": {"issueCount": 183},
                    "week_previous": {"issueCount": 110},
                    "opened_week_current": {"issueCount": 190},
                    "opened_week_previous": {"issueCount": 120},
                    "month_current": {"issueCount": 571},
                    "month_previous": {"issueCount": 515}
                }
            })))
            .mount(&server)
            .await;
        let c = client_for(&server).await;
        let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let h = c.fetch_history(now, 2).await.unwrap();
        assert_eq!(h.points.len(), 2);
        assert_eq!(h.points[1].merged, 5);
        assert_eq!(h.week_current, 183);
        assert_eq!(h.week_previous, 110);
        assert_eq!(h.month_current, 571);
    }

    #[tokio::test]
    async fn fetch_history_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_history(Utc::now(), 7)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn fetch_merged_detail_maps_the_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "merged": {"nodes": [
                        {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T12:00:00Z",
                         "additions":100,"deletions":20,"changedFiles":3,
                         "reviews":{"totalCount":1},"comments":{"totalCount":2},
                         "repository":{"nameWithOwner":"acme/alpha"}}
                    ]}
                }
            })))
            .mount(&server)
            .await;

        let d = client_for(&server)
            .await
            .fetch_merged_detail()
            .await
            .unwrap();
        assert_eq!(d.sample_size, 1);
        assert_eq!(d.additions, 100);
        assert_eq!(d.cycle_time_hours, vec![2.0]);
    }

    #[tokio::test]
    async fn fetch_merged_detail_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_merged_detail()
            .await
            .is_err());
    }

    // Exercises the real fetch path against the LIVE API, exactly as the
    // Tauri commands do. #[ignore]d so CI never depends on network or a
    // token; run manually with `cargo test --lib live_ -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_fetch_history_and_detail() {
        let out = std::process::Command::new("gh")
            .args(["auth", "token"])
            .output()
            .expect("gh auth token");
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let c = GitHubClient::new(crate::auth::build_client(&token).unwrap());

        let tp = std::time::Instant::now();
        let p = c.fetch_periods(Utc::now()).await.unwrap();
        println!(
            "TIMING fetch_periods = {:?} (week {}/{})",
            tp.elapsed(),
            p.week_current,
            p.week_previous
        );

        let t0 = std::time::Instant::now();
        // The detail view's payload, through the real client.
        if let Ok(d) = c.fetch_pr_detail("pktstorm/headstate", 165).await {
            println!(
                "DETAIL #{} \"{}\" checks={} comments={} body={}b status={:?}",
                d.number,
                &d.title[..d.title.len().min(30)],
                d.checks.len(),
                d.comments.len(),
                d.body.len(),
                d.merge_status
            );
            assert!(!d.title.is_empty(), "title must be populated");
            assert!(!d.checks.is_empty(), "checks must be populated");
        }

        let (authored, reviewing) = c.fetch_prs_and_reviewing().await.unwrap();
        println!("AUTHORED={} REVIEWING={}", authored.len(), reviewing.len());
        {
            use std::collections::BTreeMap;
            let mut by: BTreeMap<String, usize> = BTreeMap::new();
            for p in &authored {
                *by.entry(format!("{:?}", p.merge_status)).or_default() += 1;
            }
            println!("MERGE_STATUS {by:?}");
            assert!(
                authored
                    .iter()
                    .any(|p| p.merge_status != crate::github::model::MergeStateStatus::Unknown),
                "mergeStateStatus must be populated, not all Unknown"
            );
        }
        let stacked: Vec<_> = authored
            .iter()
            .filter(|p| p.base_ref != "main" && p.base_ref != "master")
            .collect();
        let no_ci = authored
            .iter()
            .filter(|p| p.ci == crate::github::model::CiState::None)
            .count();
        println!("STACKED={} NO_CI={}", stacked.len(), no_ci);
        if let Some(p) = stacked.first() {
            println!("  e.g. {} -> {}", p.head_ref, p.base_ref);
        }
        assert!(
            authored.iter().all(|p| !p.base_ref.is_empty()),
            "base_ref must be populated"
        );
        assert!(!authored.is_empty());

        let t = c.fetch_cycle_trend(Utc::now()).await.unwrap();
        println!(
            "CYCLE cur={:.2}h ({} merged) prev={:.2}h ({} merged) sampled={}",
            t.current_hours, t.current_count, t.previous_hours, t.previous_count, t.sampled
        );

        let h = c.fetch_history(Utc::now(), 30).await.unwrap();
        println!("TIMING fetch_history(30) = {:?}", t0.elapsed());
        println!(
            "POINTS={} WEEK={}/{} MONTH={}/{}",
            h.points.len(),
            h.week_current,
            h.week_previous,
            h.month_current,
            h.month_previous
        );
        assert_eq!(h.points.len(), 30);
        // Ascending by date: the chart plots time left to right.
        assert!(h.points.windows(2).all(|w| w[0].date <= w[1].date));

        let d = c.fetch_merged_detail().await.unwrap();
        println!(
            "SLOWEST={} LARGEST={} top_slow={:.1}h top_big={} lines",
            d.slowest.len(),
            d.largest.len(),
            d.slowest.first().map(|p| p.cycle_time_hours).unwrap_or(0.0),
            d.largest.first().map(|p| p.size).unwrap_or(0)
        );
        assert!(!d.slowest.is_empty(), "outliers must be populated");
        assert!(
            d.slowest.iter().all(|p| !p.url.is_empty()),
            "each needs a link"
        );
        println!(
            "SAMPLE={} LINES={} SIZES={} REPOS={} CYCLES={}",
            d.sample_size,
            d.additions + d.deletions,
            d.pr_sizes.len(),
            d.repo_counts.len(),
            d.cycle_time_hours.len()
        );
        assert!(d.sample_size > 0);
        // Both vectors must be sorted or percentile() silently lies.
        assert!(
            d.pr_sizes.windows(2).all(|w| w[0] <= w[1]),
            "pr_sizes unsorted"
        );
        assert!(
            d.cycle_time_hours.windows(2).all(|w| w[0] <= w[1]),
            "cycle times unsorted"
        );
        // Repo counts descend, so the table's first row is the busiest.
        assert!(d.repo_counts.windows(2).all(|w| w[0].merged >= w[1].merged));
    }
}
