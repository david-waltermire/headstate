//! The GitHub client: wraps octocrab's GraphQL transport with the two
//! queries the product needs, and maps their responses into typed Rust.
//!
//! Read-only: every query here is a `search`, never a mutation.

use super::map::map_search;
use super::model::{PullRequest, Stats};
use super::query::{PRS_QUERY, STATS_QUERY};
use chrono::{DateTime, Duration, Utc};
use octocrab::Octocrab;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("GitHub request failed: {0}")]
    Api(#[from] octocrab::Error),
}

pub struct GitHubClient {
    octocrab: Octocrab,
}

impl GitHubClient {
    pub fn new(octocrab: Octocrab) -> Self {
        Self { octocrab }
    }

    /// Every open PR authored by the viewer, with CI, mergeability, review
    /// decision, and merge-queue state.
    ///
    /// Octocrab unwraps the GraphQL `data` envelope, so the value returned
    /// here has `search` at its top level rather than under `data`.
    pub async fn fetch_prs(&self) -> Result<Vec<PullRequest>, ClientError> {
        let v: serde_json::Value = self
            .octocrab
            .graphql(&json!({
                "query": PRS_QUERY,
                "variables": { "q": "is:pr is:open author:@me" }
            }))
            .await?;
        Ok(map_search(&v))
    }

    /// The two historical counters. The other five dashboard numbers are
    /// derived from the PR list in the frontend and cost no extra request.
    pub async fn fetch_stats(&self, now: DateTime<Utc>) -> Result<Stats, ClientError> {
        let week = (now - Duration::days(7)).format("%Y-%m-%d").to_string();
        let month = (now - Duration::days(30)).format("%Y-%m-%d").to_string();
        let v: serde_json::Value = self
            .octocrab
            .graphql(&json!({
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
}
