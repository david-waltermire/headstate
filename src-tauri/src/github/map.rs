//! Mapping from the raw GraphQL JSON to typed `PullRequest`s.

use super::model::{
    CiState, CycleTrend, HistoryPoint, Label, MergeState, MergedDetail, MergedPr, PullRequest,
    RepoCount, ReviewState,
};
use chrono::{DateTime, Duration, Utc};
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
        head_ref: node["headRefName"].as_str().unwrap_or_default().to_string(),
        base_ref: node["baseRefName"].as_str().unwrap_or_default().to_string(),
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
    map_list(v, "authored")
}

/// One named search alias from the response.
pub fn map_list(v: &Value, alias: &str) -> Vec<PullRequest> {
    v[alias]["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(map_node).collect())
        .unwrap_or_default()
}

/// How many PRs GitHub says match, which may exceed how many it returned.
///
/// `PRS_QUERY` asks for `first: 100` and already selects `issueCount`, but
/// nothing read it -- so an account with 137 open PRs saw a list, a
/// sidebar, and a priorities strip all confidently reporting 100, with the
/// remaining 37 invisible. Worst case the strip, whose entire job is never
/// to have a false negative, renders "Nothing blocked on you" while a
/// conflicted PR sits at rank 118.
/// The rate-limit budget the response already carried.
///
/// `PRS_QUERY` has always selected `rateLimit`, and nothing read it -- so
/// when the budget did run out, the user got a generic failure and could
/// not tell it from a network problem or an expired token, nor learn how
/// long to wait, even though the reset time was in a response already
/// received.
pub fn map_rate_limit(v: &Value) -> Option<(u64, String)> {
    let remaining = v["rateLimit"]["remaining"].as_u64()?;
    let reset = v["rateLimit"]["resetAt"].as_str().unwrap_or("").to_string();
    Some((remaining, reset))
}

pub fn map_total(v: &Value) -> u64 {
    v["authored"]["issueCount"].as_u64().unwrap_or(0)
}

/// Day-bucket aliases into an ascending-by-date series.
///
/// Aliases are emitted newest-first (`m0` is today); the chart plots time
/// left to right, so the series is reversed here rather than in the view.
/// A missing alias maps to 0: GitHub omits nothing today, but a partial
/// response must not panic a dashboard.
pub fn map_history(v: &Value, days: i64, now: DateTime<Utc>) -> Vec<HistoryPoint> {
    let mut pts: Vec<HistoryPoint> = (0..days)
        .map(|i| HistoryPoint {
            date: (now - Duration::days(i)).format("%Y-%m-%d").to_string(),
            merged: v[format!("m{i}")]["issueCount"].as_u64().unwrap_or(0),
            opened: v[format!("o{i}")]["issueCount"].as_u64().unwrap_or(0),
        })
        .collect();
    pts.reverse();
    pts
}

/// Totals over the merged-PR sample.
///
/// Cycle times are collected only for nodes carrying both timestamps, but
/// such nodes still count toward volume totals -- the PR did merge; only
/// its duration is unknown. The vector is sorted so percentile() can index
/// it without re-sorting per call.
pub fn map_merged_detail(v: &Value) -> MergedDetail {
    let mut d = MergedDetail::default();
    let mut repos: std::collections::HashMap<String, u64> = Default::default();
    let mut merged_prs: Vec<MergedPr> = Vec::new();
    let empty = vec![];
    let nodes = v["merged"]["nodes"].as_array().unwrap_or(&empty);
    for n in nodes {
        d.sample_size += 1;
        let size = n["additions"].as_u64().unwrap_or(0) + n["deletions"].as_u64().unwrap_or(0);
        d.pr_sizes.push(size);
        d.additions += n["additions"].as_u64().unwrap_or(0);
        d.deletions += n["deletions"].as_u64().unwrap_or(0);
        d.changed_files += n["changedFiles"].as_u64().unwrap_or(0);
        d.review_count += n["reviews"]["totalCount"].as_u64().unwrap_or(0);
        d.comment_count += n["comments"]["totalCount"].as_u64().unwrap_or(0);
        if let Some(r) = n["repository"]["nameWithOwner"].as_str() {
            *repos.entry(r.to_string()).or_insert(0) += 1;
        }
        let mut hours_for_pr = 0.0;
        if let (Some(c), Some(m)) = (n["createdAt"].as_str(), n["mergedAt"].as_str()) {
            if let (Ok(c), Ok(m)) = (
                DateTime::parse_from_rfc3339(c),
                DateTime::parse_from_rfc3339(m),
            ) {
                let hours = (m - c).num_seconds() as f64 / 3600.0;
                if hours >= 0.0 {
                    d.cycle_time_hours.push(hours);
                    hours_for_pr = hours;
                }
            }
        }
        if let Some(num) = n["number"].as_u64() {
            merged_prs.push(MergedPr {
                number: num,
                title: n["title"].as_str().unwrap_or_default().to_string(),
                url: n["url"].as_str().unwrap_or_default().to_string(),
                repo: n["repository"]["nameWithOwner"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                cycle_time_hours: hours_for_pr,
                size,
            });
        }
    }
    d.cycle_time_hours.sort_by(|a, b| a.partial_cmp(b).unwrap());
    d.pr_sizes.sort_unstable();

    // The outliers the scalar figures describe, so a striking number is a
    // link rather than a dead end. Ties broken by number for a stable
    // order between refreshes.
    let mut by_time = merged_prs.clone();
    by_time.sort_by(|a, b| {
        b.cycle_time_hours
            .partial_cmp(&a.cycle_time_hours)
            .unwrap()
            .then(a.number.cmp(&b.number))
    });
    d.slowest = by_time.into_iter().take(5).collect();

    let mut by_size = merged_prs;
    by_size.sort_by(|a, b| b.size.cmp(&a.size).then(a.number.cmp(&b.number)));
    d.largest = by_size.into_iter().take(5).collect();
    let mut rc: Vec<RepoCount> = repos
        .into_iter()
        .map(|(repo, merged)| RepoCount { repo, merged })
        .collect();
    // Ties broken by name so the table order is stable between refreshes.
    rc.sort_by(|a, b| b.merged.cmp(&a.merged).then(a.repo.cmp(&b.repo)));
    d.repo_counts = rc;
    d
}

/// Median cycle time in hours for one window's nodes.
///
/// Nearest rank, matching `percentile` on the frontend: `ceil(n*p) - 1`
/// zero-indexed. Nodes missing either timestamp are skipped.
fn median_hours(nodes: &Value) -> f64 {
    let empty = vec![];
    let mut hours: Vec<f64> = nodes
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|n| {
            let c = DateTime::parse_from_rfc3339(n["createdAt"].as_str()?).ok()?;
            let m = DateTime::parse_from_rfc3339(n["mergedAt"].as_str()?).ok()?;
            let h = (m - c).num_seconds() as f64 / 3600.0;
            (h >= 0.0).then_some(h)
        })
        .collect();
    if hours.is_empty() {
        return 0.0;
    }
    hours.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((hours.len() as f64 * 0.5).ceil() as usize).saturating_sub(1);
    hours[idx.min(hours.len() - 1)]
}

pub fn map_cycle_trend(v: &Value) -> CycleTrend {
    let cur_n = v["current"]["issueCount"].as_u64().unwrap_or(0);
    let prev_n = v["previous"]["issueCount"].as_u64().unwrap_or(0);
    let cur_len = v["current"]["nodes"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0) as u64;
    let prev_len = v["previous"]["nodes"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0) as u64;
    CycleTrend {
        current_hours: median_hours(&v["current"]["nodes"]),
        previous_hours: median_hours(&v["previous"]["nodes"]),
        current_count: cur_n,
        previous_count: prev_n,
        // GitHub returns at most 100 nodes per window; above that the
        // medians describe a sample of the week, not the week.
        sampled: cur_n > cur_len || prev_n > prev_len,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::{CiState, MergeState, ReviewState};
    use serde_json::json;

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
    /// Branch refs ride along in the existing query at no extra cost, and
    /// distinguish a stacked PR -- which cannot merge until its base does
    /// -- from one targeting the default branch.
    #[test]
    fn maps_the_branch_pair() {
        let prs = map_search(&fixture());
        assert_eq!(prs[0].head_ref, "feature/retry-client");
        assert_eq!(prs[0].base_ref, "main");
        // The stacked one: base is another feature branch.
        let stacked = prs.iter().find(|p| p.number == 7).unwrap();
        assert_eq!(stacked.head_ref, "stack/part-2");
        assert_eq!(stacked.base_ref, "stack/part-1");
    }

    /// A node missing the fields must not panic -- the mapper's rule is
    /// that one malformed PR never blanks the list.
    #[test]
    fn missing_branch_refs_map_to_empty_strings() {
        let v = json!({"authored": {"nodes": [{
            "number": 1, "title": "t", "url": "u", "isDraft": false,
            "createdAt": "2026-08-20T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z",
            "author": {"login": "a"}, "repository": {"nameWithOwner": "acme/a"},
            "mergeable": "MERGEABLE", "reviewDecision": null,
            "isInMergeQueue": false, "totalCommentsCount": 0,
            "labels": {"nodes": []}, "commits": {"nodes": []}
        }]}});
        let prs = map_search(&v);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].head_ref, "");
        assert_eq!(prs[0].base_ref, "");
    }

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

    #[test]
    fn cycle_trend_takes_the_nearest_rank_median() {
        // 4 samples: ceil(4*0.5)-1 = index 1.
        let v = json!({
            "current": {"issueCount": 4, "nodes": [
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt":"2026-08-19T01:00:00Z"},
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt":"2026-08-19T02:00:00Z"},
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt":"2026-08-19T03:00:00Z"},
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt":"2026-08-19T04:00:00Z"}
            ]},
            "previous": {"issueCount": 1, "nodes": [
                {"createdAt":"2026-08-12T00:00:00Z","mergedAt":"2026-08-12T10:00:00Z"}
            ]}
        });
        let t = map_cycle_trend(&v);
        assert_eq!(t.current_hours, 2.0);
        assert_eq!(t.previous_hours, 10.0);
        assert_eq!(t.current_count, 4);
        assert!(!t.sampled, "neither window hit the page cap");
    }

    /// Above 100 merges in a week, the nodes are a SAMPLE of that week --
    /// presenting the median as the week's would be the same class of
    /// plausible-but-wrong number this page exists to avoid.
    #[test]
    fn cycle_trend_flags_a_truncated_window() {
        let v = json!({
            "current": {"issueCount": 183, "nodes": [
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt":"2026-08-19T01:00:00Z"}
            ]},
            "previous": {"issueCount": 1, "nodes": [
                {"createdAt":"2026-08-12T00:00:00Z","mergedAt":"2026-08-12T02:00:00Z"}
            ]}
        });
        assert!(map_cycle_trend(&v).sampled);
    }

    #[test]
    fn cycle_trend_survives_missing_timestamps() {
        let v = json!({
            "current": {"issueCount": 1, "nodes": [
                {"createdAt":"2026-08-19T00:00:00Z","mergedAt": null}
            ]},
            "previous": {"issueCount": 0, "nodes": []}
        });
        let t = map_cycle_trend(&v);
        assert_eq!(t.current_hours, 0.0);
        assert_eq!(t.previous_hours, 0.0);
    }

    #[test]
    fn maps_day_buckets_oldest_first() {
        // NOTE: no "data" key -- octocrab strips the envelope before we see it.
        let v = json!({
            "m0": {"issueCount": 5}, "o0": {"issueCount": 7},
            "m1": {"issueCount": 3}, "o1": {"issueCount": 4}
        });
        let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let pts = map_history(&v, 2, now);
        // Chart reads left-to-right as time moving forward, so oldest first.
        assert_eq!(pts[0].date, "2026-08-19");
        assert_eq!(pts[0].merged, 3);
        assert_eq!(pts[1].date, "2026-08-20");
        assert_eq!(pts[1].merged, 5);
        assert_eq!(pts[1].opened, 7);
    }

    #[test]
    fn missing_buckets_become_zero_not_panic() {
        let v = json!({ "m0": {"issueCount": 2} });
        let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let pts = map_history(&v, 1, now);
        assert_eq!(pts[0].merged, 2);
        assert_eq!(pts[0].opened, 0);
    }

    #[test]
    fn aggregates_merged_detail_and_cycle_times() {
        let v = json!({"merged": {"nodes": [
            {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T12:00:00Z",
             "additions":100,"deletions":20,"changedFiles":3,
             "reviews":{"totalCount":1},"comments":{"totalCount":2},
             "repository":{"nameWithOwner":"acme/alpha"}},
            {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T10:30:00Z",
             "additions":10,"deletions":5,"changedFiles":1,
             "reviews":{"totalCount":0},"comments":{"totalCount":0},
             "repository":{"nameWithOwner":"acme/alpha"}}
        ]}});
        let d = map_merged_detail(&v);
        assert_eq!(d.sample_size, 2);
        assert_eq!(d.additions, 110);
        assert_eq!(d.changed_files, 4);
        // Sorted ascending so percentile() can index directly.
        assert_eq!(d.cycle_time_hours, vec![0.5, 2.0]);
        // additions+deletions per PR, ascending: 10+5=15 then 100+20=120.
        assert_eq!(d.pr_sizes, vec![15, 120]);
        assert_eq!(
            d.repo_counts,
            vec![RepoCount {
                repo: "acme/alpha".into(),
                merged: 2
            }]
        );
    }

    #[test]
    fn skips_nodes_missing_timestamps() {
        let v = json!({"merged": {"nodes": [
            {"createdAt":"2026-08-19T10:00:00Z","mergedAt": null,
             "additions":1,"deletions":0,"changedFiles":1,
             "reviews":{"totalCount":0},"comments":{"totalCount":0},
             "repository":{"nameWithOwner":"acme/alpha"}}
        ]}});
        let d = map_merged_detail(&v);
        assert!(d.cycle_time_hours.is_empty());
        // Still counted for volume: the PR merged, we just cannot time it.
        assert_eq!(d.sample_size, 1);
        assert_eq!(d.additions, 1);
    }
}
