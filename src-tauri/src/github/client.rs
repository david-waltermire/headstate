//! The GitHub client: wraps octocrab's GraphQL transport with the two
//! queries the product needs, and maps their responses into typed Rust.
//!
//! Read-only: every query here is a `search`, never a mutation.

use super::map::{map_history, map_merged_detail, map_search, map_total};
use super::model::{History, MergedDetail, Periods, PullRequest, Stats};
use super::query::{
    history_query_range, history_query_range_with_periods, periods_query, HISTORY_CHUNK_DAYS,
    MERGED_DETAIL_QUERY, PRS_QUERY, STATS_QUERY,
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
                "variables": { "q": "is:pr is:open author:@me" }
            }))
            .await?;
        Ok(map_search(&v))
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
                "variables": { "q": "is:pr is:open author:@me" }
            }))
            .await?;
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
        // carries the six period aliases, so a 30-day fetch is two requests
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

    /// `issueCount` is what makes truncation visible; it was requested by
    /// the query and read by nothing, so >100 open PRs silently became 100.
    #[tokio::test]
    async fn reports_the_true_total_when_the_page_truncates() {
        let server = MockServer::start().await;
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        // The fixture has 3 nodes; claim GitHub matched 137.
        let mut truncated = body.clone();
        truncated["search"]["issueCount"] = json!(137);
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
                "errors": [{ "message": "API rate limit exceeded" }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(
            err.to_string().contains("API rate limit exceeded"),
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
