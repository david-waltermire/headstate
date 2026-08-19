//! Mapping from the raw GraphQL JSON to typed `PullRequest`s.

use super::model::{CiState, Label, MergeState, PullRequest, ReviewState};
use chrono::{DateTime, Utc};
use serde_json::Value;

fn ts(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    v[key].as_str()?.parse::<DateTime<Utc>>().ok()
}

fn ci_state(node: &Value) -> CiState {
    let state = node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str();
    match state {
        Some("SUCCESS") => CiState::Success,
        Some("FAILURE") | Some("ERROR") => CiState::Failure,
        Some("PENDING") | Some("EXPECTED") => CiState::Pending,
        // No rollup at all means the repo runs no checks on this PR.
        _ => CiState::None,
    }
}

fn merge_state(node: &Value) -> MergeState {
    match node["mergeable"].as_str() {
        Some("MERGEABLE") => MergeState::Mergeable,
        Some("CONFLICTING") => MergeState::Conflicted,
        // UNKNOWN and anything unrecognised. Never Conflicted: GitHub
        // reports UNKNOWN while it computes, and a false conflict warning
        // would fire on every push.
        _ => MergeState::Checking,
    }
}

fn review_state(node: &Value) -> ReviewState {
    match node["reviewDecision"].as_str() {
        Some("APPROVED") => ReviewState::Approved,
        Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
        Some("REVIEW_REQUIRED") => ReviewState::ReviewRequired,
        _ => ReviewState::None,
    }
}

fn labels(node: &Value) -> Vec<Label> {
    node["labels"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    Some(Label {
                        name: l["name"].as_str()?.to_string(),
                        color: l["color"].as_str().unwrap_or("cccccc").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn map_node(node: &Value) -> Option<PullRequest> {
    Some(PullRequest {
        number: node["number"].as_u64()?,
        title: node["title"].as_str()?.to_string(),
        url: node["url"].as_str()?.to_string(),
        repo: node["repository"]["nameWithOwner"].as_str()?.to_string(),
        author: node["author"]["login"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        is_draft: node["isDraft"].as_bool().unwrap_or(false),
        created_at: ts(node, "createdAt")?,
        updated_at: ts(node, "updatedAt")?,
        ci: ci_state(node),
        merge: merge_state(node),
        review: review_state(node),
        in_merge_queue: node["isInMergeQueue"].as_bool().unwrap_or(false),
        labels: labels(node),
        comment_count: node["totalCommentsCount"].as_u64().unwrap_or(0),
    })
}

/// Map a search response. Note the response passed here is Octocrab's
/// already-unwrapped `data` object, so `search` is at the top level.
/// Nodes that fail to map are skipped rather than failing the whole poll:
/// one malformed PR should not blank the list.
pub fn map_search(v: &Value) -> Vec<PullRequest> {
    v["search"]["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(map_node).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::{CiState, MergeState, ReviewState};

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap()
    }

    #[test]
    fn maps_all_prs() {
        assert_eq!(map_search(&fixture()).len(), 3);
    }

    #[test]
    fn maps_a_green_approved_pr() {
        let prs = map_search(&fixture());
        let pr = &prs[0];
        assert_eq!(pr.number, 42);
        assert_eq!(pr.repo, "octocat/hello-world");
        assert_eq!(pr.author, "octocat");
        assert_eq!(pr.ci, CiState::Success);
        assert_eq!(pr.merge, MergeState::Mergeable);
        assert_eq!(pr.review, ReviewState::Approved);
        assert_eq!(pr.labels.len(), 1);
        assert_eq!(pr.labels[0].name, "enhancement");
    }

    #[test]
    fn maps_a_conflicted_failing_draft() {
        let pr = map_search(&fixture())
            .into_iter()
            .find(|p| p.number == 43)
            .unwrap();
        assert!(pr.is_draft);
        assert_eq!(pr.ci, CiState::Failure);
        assert_eq!(pr.merge, MergeState::Conflicted);
        assert_eq!(pr.review, ReviewState::ChangesRequested);
        assert_eq!(pr.comment_count, 5);
    }

    /// GitHub computes mergeability lazily and returns UNKNOWN right after a
    /// push. Mapping that to Conflicted would show a false "needs rebase".
    #[test]
    fn unknown_mergeable_maps_to_checking_never_conflicted() {
        let pr = map_search(&fixture())
            .into_iter()
            .find(|p| p.number == 7)
            .unwrap();
        assert_eq!(pr.merge, MergeState::Checking);
        assert_ne!(pr.merge, MergeState::Conflicted);
    }

    /// A PR with no CI configured has no rollup at all.
    #[test]
    fn missing_status_rollup_maps_to_none() {
        let pr = map_search(&fixture())
            .into_iter()
            .find(|p| p.number == 7)
            .unwrap();
        assert_eq!(pr.ci, CiState::None);
        assert!(pr.in_merge_queue);
    }

    #[test]
    fn malformed_nodes_are_skipped_not_panicked_on() {
        let v = serde_json::json!({"search": {"nodes": [{"number": 1}, null]}});
        assert_eq!(map_search(&v).len(), 0);
    }
}
