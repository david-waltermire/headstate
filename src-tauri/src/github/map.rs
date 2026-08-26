//! Mapping from the raw GraphQL JSON to typed `PullRequest`s.

use super::model::{
    CheckRun, CiState, CycleTrend, HistoryPoint, Label, MergeState, MergeStateStatus, MergedDetail,
    MergedPr, PrComment, PrDetail, PullRequest, RepoCount, ReviewState, ReviewerVerdict,
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

/// One check's outcome, normalised.
///
/// CheckRun reports `conclusion` (SUCCESS/FAILURE/...) while
/// StatusContext reports `state` (SUCCESS/PENDING/...). Both shapes reach
/// here, and a null conclusion means the run has not finished.
fn check_state(node: &Value) -> String {
    let raw = node["conclusion"]
        .as_str()
        .or_else(|| node["state"].as_str())
        .unwrap_or("PENDING");
    match raw {
        "SUCCESS" => "success",
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "STARTUP_FAILURE" => "failure",
        "PENDING" | "IN_PROGRESS" | "QUEUED" | "WAITING" | "EXPECTED" => "pending",
        "NEUTRAL" | "SKIPPED" => "skipped",
        other => other,
    }
    .to_string()
}

/// The detail payload for one pull request.
/// The per-check list for one pull request.
///
/// Extracted so the `run_id` rules are testable without building a whole
/// `PrDetail`: which checks can be re-run is the decision the UI gates
/// its button on, and it must be exercised directly.
pub fn map_detail_checks(pr: &Value) -> Vec<CheckRun> {
    let empty = vec![];
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|c| CheckRun {
            // CheckRun uses `name`, StatusContext uses `context`.
            name: c["name"]
                .as_str()
                .or_else(|| c["context"].as_str())
                .unwrap_or("check")
                .to_string(),
            state: check_state(c),
            url: c["detailsUrl"]
                .as_str()
                .or_else(|| c["targetUrl"].as_str())
                .unwrap_or_default()
                .to_string(),
            // Absent for a StatusContext and for check runs from apps
            // that are not Actions. None means "cannot re-run this",
            // which the UI reads rather than guessing.
            run_id: c["checkSuite"]["workflowRun"]["databaseId"].as_u64(),
        })
        .collect()
}

pub fn map_detail(v: &Value, repo: &str) -> PrDetail {
    let pr = &v["repository"]["pullRequest"];
    let empty = vec![];

    let checks = map_detail_checks(pr);

    let comments = pr["comments"]["nodes"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|c| PrComment {
            author: c["author"]["login"].as_str().unwrap_or("ghost").to_string(),
            created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
            body: c["body"].as_str().unwrap_or_default().to_string(),
        })
        .collect();

    PrDetail {
        id: pr["id"].as_str().unwrap_or_default().to_string(),
        number: pr["number"].as_u64().unwrap_or(0),
        title: pr["title"].as_str().unwrap_or_default().to_string(),
        url: pr["url"].as_str().unwrap_or_default().to_string(),
        state: pr["state"].as_str().unwrap_or("OPEN").to_lowercase(),
        is_draft: pr["isDraft"].as_bool().unwrap_or(false),
        body: pr["body"].as_str().unwrap_or_default().to_string(),
        author: pr["author"]["login"]
            .as_str()
            .unwrap_or("ghost")
            .to_string(),
        repo: repo.to_string(),
        head_ref: pr["headRefName"].as_str().unwrap_or_default().to_string(),
        head_oid: pr["headRefOid"].as_str().unwrap_or_default().to_string(),
        head_ref_id: pr["headRef"]["id"].as_str().map(str::to_string),
        base_ref: pr["baseRefName"].as_str().unwrap_or_default().to_string(),
        merge_status: merge_status(pr),
        review: review_state(pr),
        merge_queue_enabled: pr["isMergeQueueEnabled"].as_bool().unwrap_or(false),
        in_merge_queue: in_merge_queue(pr),
        latest_reviews: pr["latestReviews"]["nodes"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            // A review whose author GitHub cannot name is useless for
            // matching against the viewer's login, so it is dropped
            // rather than mapped to a placeholder that could collide.
            .filter_map(|r| {
                Some(ReviewerVerdict {
                    author: r["author"]["login"].as_str()?.to_string(),
                    state: r["state"].as_str()?.to_string(),
                })
            })
            .collect(),
        additions: pr["additions"].as_u64().unwrap_or(0),
        deletions: pr["deletions"].as_u64().unwrap_or(0),
        changed_files: pr["changedFiles"].as_u64().unwrap_or(0),
        unresolved_threads: unresolved_threads(pr),
        comment_count: pr["comments"]["totalCount"].as_u64().unwrap_or(0),
        comments,
        checks,
    }
}

/// Is this pull request genuinely sitting in the merge queue?
///
/// `isInMergeQueue` stays TRUE for an entry the queue has REJECTED, so
/// reading it alone renders a stuck pull request as calmly queued. The
/// entry's own state is what separates them.
///
/// Shared by the list and detail mappers deliberately: they must agree,
/// or the row and the button it opens would disagree about whether the
/// pull request is queued.
fn in_merge_queue(node: &Value) -> bool {
    node["isInMergeQueue"].as_bool().unwrap_or(false)
        && !matches!(
            node["mergeQueueEntry"]["state"].as_str(),
            Some("UNMERGEABLE") | Some("LOCKED")
        )
}

/// Open review conversations on the current code.
///
/// Both filters matter: a resolved thread needs no action, and an outdated
/// one hangs off a line that has since changed, so counting either would
/// nag the author about work already finished.
fn unresolved_threads(node: &Value) -> u64 {
    node["reviewThreads"]["nodes"]
        .as_array()
        .map(|threads| {
            threads
                .iter()
                .filter(|t| {
                    !t["isResolved"].as_bool().unwrap_or(false)
                        && !t["isOutdated"].as_bool().unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0)
}

/// GitHub's merge-readiness summary.
///
/// Unrecognised and absent values both become `Unknown` rather than
/// guessing: a merge button must never be enabled on a state we do not
/// understand.
fn merge_status(node: &Value) -> MergeStateStatus {
    match node["mergeStateStatus"].as_str() {
        Some("CLEAN") => MergeStateStatus::Clean,
        Some("DIRTY") => MergeStateStatus::Dirty,
        Some("BLOCKED") => MergeStateStatus::Blocked,
        Some("UNSTABLE") => MergeStateStatus::Unstable,
        Some("BEHIND") => MergeStateStatus::Behind,
        Some("DRAFT") => MergeStateStatus::Draft,
        _ => MergeStateStatus::Unknown,
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
        id: node["id"].as_str().unwrap_or_default().to_string(),
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
        head_oid: node["headRefOid"].as_str().unwrap_or_default().to_string(),
        head_ref_id: node["headRef"]["id"].as_str().map(str::to_string),
        base_ref: node["baseRefName"].as_str().unwrap_or_default().to_string(),
        created_at: ts(node, "createdAt")?,
        updated_at: ts(node, "updatedAt")?,
        ci: ci_state(node),
        merge: merge_state(node),
        merge_status: merge_status(node),
        review: review_state(node),
        // Queued means WAITING, not merely present. `isInMergeQueue`
        // stays true for an entry the queue has rejected -- state
        // UNMERGEABLE -- so a declined pull request reported as calmly
        // queued and got the amber merge-queue icon while actually
        // being stuck.
        //
        // An absent entry falls back to the flag: `mergeQueueEntry` is
        // null on repositories without a merge queue, where
        // `isInMergeQueue` is false anyway.
        in_merge_queue: in_merge_queue(node),
        labels: labels(node),
        comment_count: node["totalCommentsCount"].as_u64().unwrap_or(0),
        unresolved_threads: unresolved_threads(node),
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
        .map(|a| {
            let mapped: Vec<PullRequest> = a.iter().filter_map(map_node).collect();
            // Dropping a node is SILENT and it is how a refused field
            // empties a list: GitHub nulls the fields it could not
            // compute, `map_node` requires title/url/repository, and
            // `filter_map` discards whatever is left. With 79 fields
            // refused, that can be the whole page -- reported as "No
            // open pull requests", which is a confident wrong answer.
            //
            // Counts only, never titles or repository names.
            if mapped.len() < a.len() {
                log::warn!(
                    "dropped {} of {} pull requests: GitHub returned them without \
                     the fields needed to render one",
                    a.len() - mapped.len(),
                    a.len()
                );
            }
            mapped
        })
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

/// The authenticated user's login.
///
/// The app ran entirely on `@me` search qualifiers and never learned who
/// it was, which was fine while everything was read-only. It stops being
/// fine once reviews exist: GitHub refuses self-approval, and the UI
/// should say so before the click rather than surface a GraphQL refusal
/// after it.
///
/// Returns None rather than a guess if the field is absent, so a caller
/// gets "we do not know" instead of a wrong answer about authorship.
pub fn map_viewer(v: &Value) -> Option<String> {
    v["viewer"]["login"].as_str().map(str::to_string)
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
    d.cycle_time_hours.sort_by(|a, b| a.total_cmp(b));
    d.pr_sizes.sort_unstable();

    // The outliers the scalar figures describe, so a striking number is a
    // link rather than a dead end. Ties broken by number for a stable
    // order between refreshes.
    let mut by_time = merged_prs.clone();
    by_time.sort_by(|a, b| {
        // total_cmp, not partial_cmp().unwrap(). A panic inside a Tauri
        // command aborts the WHOLE APP, and the invariant that keeps NaN
        // out of cycle_time_hours lives in a guard forty lines away --
        // implicit, undocumented, and one edit from turning a stats
        // refresh into a crash. total_cmp is total over floats and free.
        b.cycle_time_hours
            .total_cmp(&a.cycle_time_hours)
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
    hours.sort_by(|a, b| a.total_cmp(b));
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
    /// Reported: a pull request labelled `auto-merge-declined` showed
    /// the amber "In merge queue" icon.
    ///
    /// `isInMergeQueue` stays TRUE for an entry the queue has rejected,
    /// so the app reported it as calmly queued while it was actually
    /// stuck. Queued must mean WAITING, not merely present.
    #[test]
    fn a_rejected_queue_entry_does_not_count_as_queued() {
        for state in ["UNMERGEABLE", "LOCKED"] {
            let v = json!({"authored": {"nodes": [{
                "number": 1, "title": "t", "url": "u",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "repository": {"nameWithOwner": "octocat/hello-world"},
                "isInMergeQueue": true,
                "mergeQueueEntry": {"state": state}
            }]}});
            assert!(
                !map_list(&v, "authored")[0].in_merge_queue,
                "{state} is not waiting in a queue"
            );
        }
    }

    #[test]
    fn a_waiting_queue_entry_still_counts_as_queued() {
        for state in ["QUEUED", "AWAITING_CHECKS", "MERGEABLE"] {
            let v = json!({"authored": {"nodes": [{
                "number": 1, "title": "t", "url": "u",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "repository": {"nameWithOwner": "octocat/hello-world"},
                "isInMergeQueue": true,
                "mergeQueueEntry": {"state": state}
            }]}});
            assert!(
                map_list(&v, "authored")[0].in_merge_queue,
                "{state} is waiting"
            );
        }
    }

    /// `mergeQueueEntry` is null on a repository with no merge queue,
    /// where `isInMergeQueue` is false anyway -- the flag must still be
    /// what decides, not the absent entry.
    #[test]
    fn an_absent_entry_falls_back_to_the_flag() {
        let node = |q: bool| {
            json!({"authored": {"nodes": [{
                "number": 1, "title": "t", "url": "u",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "repository": {"nameWithOwner": "octocat/hello-world"},
                "isInMergeQueue": q
            }]}})
        };
        let queued = node(true);
        assert!(map_list(&queued, "authored")[0].in_merge_queue);
        let not = node(false);
        assert!(!map_list(&not, "authored")[0].in_merge_queue);
    }

    /// The workflow run id is what makes re-running possible, and it
    /// is OPTIONAL by design: a plain commit status and a check run from
    /// a non-Actions app both have no workflow run. None must mean
    /// "cannot re-run this" rather than defaulting to a wrong id.
    #[test]
    fn check_runs_carry_their_workflow_run_when_there_is_one() {
        let v = json!({"commits": {"nodes": [{"commit": {"statusCheckRollup": {
            "state": "FAILURE",
            "contexts": {"nodes": [
                {"name": "lint", "conclusion": "FAILURE", "detailsUrl": "https://x/1",
                 "checkSuite": {"workflowRun": {"databaseId": 12345}}},
                // A StatusContext: no checkSuite at all.
                {"context": "legacy/ci", "state": "FAILURE", "targetUrl": "https://x/2"}
            ]}
        }}}]}});
        let checks = map_detail_checks(&v);
        assert_eq!(checks[0].run_id, Some(12345));
        assert_eq!(checks[1].run_id, None, "a status context cannot be re-run");
    }

    /// An Actions check whose suite has no workflow run -- which happens
    /// for check runs created by other apps -- must also come back None
    /// rather than panicking on the missing field.
    #[test]
    fn a_check_without_a_workflow_run_is_not_rerunnable() {
        let v = json!({"commits": {"nodes": [{"commit": {"statusCheckRollup": {
            "contexts": {"nodes": [
                {"name": "third-party", "conclusion": "FAILURE",
                 "checkSuite": {"workflowRun": null}}
            ]}
        }}}]}});
        assert_eq!(map_detail_checks(&v)[0].run_id, None);
    }

    /// The login must come back verbatim, and its absence must be None
    /// rather than an empty string -- "we could not ask" is not "nobody".
    #[test]
    fn viewer_login_is_read_or_honestly_absent() {
        assert_eq!(
            map_viewer(&json!({"viewer": {"login": "octocat"}})),
            Some("octocat".to_string())
        );
        assert_eq!(map_viewer(&json!({})), None);
        assert_eq!(map_viewer(&json!({"viewer": null})), None);
    }

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
    fn node_with_threads(threads: serde_json::Value) -> serde_json::Value {
        json!({"authored": {"nodes": [{
            "number": 1, "title": "t", "url": "u", "isDraft": false,
            "headRefName": "f", "baseRefName": "main",
            "createdAt": "2026-08-20T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z",
            "author": {"login": "a"}, "repository": {"nameWithOwner": "acme/a"},
            "mergeable": "MERGEABLE", "reviewDecision": null,
            "isInMergeQueue": false, "totalCommentsCount": 0,
            "labels": {"nodes": []}, "commits": {"nodes": []},
            "reviewThreads": {"nodes": threads}
        }]}})
    }

    #[test]
    fn counts_only_open_conversations() {
        let v = node_with_threads(json!([
            {"isResolved": false, "isOutdated": false},
            {"isResolved": false, "isOutdated": false},
            {"isResolved": true, "isOutdated": false},
        ]));
        assert_eq!(map_search(&v)[0].unresolved_threads, 2);
    }

    /// An outdated thread hangs off a line that has since changed, so the
    /// author has nothing left to answer. Counting it would nag about work
    /// already done -- and unlike a resolved thread, nobody clicked
    /// anything to dismiss it.
    #[test]
    fn outdated_threads_do_not_count() {
        let v = node_with_threads(json!([
            {"isResolved": false, "isOutdated": true},
            {"isResolved": false, "isOutdated": false},
        ]));
        assert_eq!(map_search(&v)[0].unresolved_threads, 1);
    }

    #[test]
    fn no_threads_means_zero_not_a_panic() {
        assert_eq!(
            map_search(&node_with_threads(json!([])))[0].unresolved_threads,
            0
        );
        // And a PR from a query that never selected the field at all.
        let v = json!({"authored": {"nodes": [{
            "number": 1, "title": "t", "url": "u", "isDraft": false,
            "headRefName": "f", "baseRefName": "main",
            "createdAt": "2026-08-20T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z",
            "author": {"login": "a"}, "repository": {"nameWithOwner": "acme/a"},
            "mergeable": "MERGEABLE", "reviewDecision": null,
            "isInMergeQueue": false, "totalCommentsCount": 0,
            "labels": {"nodes": []}, "commits": {"nodes": []}
        }]}});
        assert_eq!(map_search(&v)[0].unresolved_threads, 0);
    }

    #[test]
    fn normalises_both_check_shapes() {
        // CheckRun reports `conclusion`; StatusContext reports `state`.
        assert_eq!(check_state(&json!({"conclusion": "SUCCESS"})), "success");
        assert_eq!(check_state(&json!({"state": "SUCCESS"})), "success");
        assert_eq!(check_state(&json!({"conclusion": "TIMED_OUT"})), "failure");
        assert_eq!(check_state(&json!({"state": "PENDING"})), "pending");
        assert_eq!(check_state(&json!({"conclusion": "SKIPPED"})), "skipped");
        // A null conclusion means the run has not finished.
        assert_eq!(check_state(&json!({"conclusion": null})), "pending");
    }

    /// An unmodelled value passes through rather than being coerced into
    /// "success", which would claim a green check that does not exist.
    #[test]
    fn an_unknown_check_state_is_never_success() {
        assert_eq!(
            check_state(&json!({"conclusion": "ACTION_REQUIRED"})),
            "ACTION_REQUIRED"
        );
    }

    #[test]
    fn maps_a_detail_payload() {
        let v = json!({"repository": {"pullRequest": {
            "number": 42, "title": "Add retry", "url": "u", "state": "OPEN",
            "isDraft": false, "body": "the description",
            "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED",
            "additions": 100, "deletions": 20, "changedFiles": 3,
            "headRefName": "feature", "baseRefName": "main",
            "author": {"login": "octocat"},
            "comments": {"totalCount": 2, "nodes": [
                {"author": {"login": "octocat"}, "createdAt": "2026-08-20T10:00:00Z", "body": "hi"}
            ]},
            "reviewThreads": {"nodes": [
                {"isResolved": false, "isOutdated": false},
                {"isResolved": true, "isOutdated": false}
            ]},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {
                "state": "SUCCESS",
                "contexts": {"nodes": [
                    {"name": "build", "conclusion": "SUCCESS", "detailsUrl": "b"},
                    {"context": "legacy", "state": "FAILURE", "targetUrl": "l"}
                ]}
            }}}]}
        }}});
        let d = map_detail(&v, "octocat/hello-world");
        assert_eq!(d.number, 42);
        assert_eq!(d.repo, "octocat/hello-world");
        assert_eq!(d.body, "the description");
        assert_eq!(d.state, "open");
        assert_eq!(d.merge_status, MergeStateStatus::Clean);
        assert_eq!(d.unresolved_threads, 1, "resolved threads must not count");
        assert_eq!(d.checks.len(), 2);
        assert_eq!(d.checks[0].name, "build");
        assert_eq!(d.checks[1].name, "legacy", "StatusContext uses `context`");
        assert_eq!(d.checks[1].state, "failure");
        assert_eq!(d.comments[0].author, "octocat");
    }

    /// The viewer's OWN verdict, which `reviewDecision` cannot answer.
    ///
    /// This payload is the exact case that made the reported bug
    /// invisible: the viewer approved, someone else requested changes,
    /// so the aggregate decision is CHANGES_REQUESTED. Reading the
    /// aggregate would tell the user their approval had not landed.
    #[test]
    fn maps_each_reviewers_latest_verdict_separately_from_the_decision() {
        let v = json!({"repository": {"pullRequest": {
            "number": 42,
            "reviewDecision": "CHANGES_REQUESTED",
            "latestReviews": {"nodes": [
                {"state": "APPROVED", "author": {"login": "octocat"}},
                {"state": "CHANGES_REQUESTED", "author": {"login": "hubot"}},
                // No author: unmatched against any login, so dropped
                // rather than given a placeholder that could collide
                // with a real user.
                {"state": "APPROVED", "author": null}
            ]}
        }}});
        let d = map_detail(&v, "octocat/hello-world");
        assert_eq!(d.review, ReviewState::ChangesRequested);
        assert_eq!(
            d.latest_reviews.len(),
            2,
            "the authorless review is dropped"
        );
        assert_eq!(d.latest_reviews[0].author, "octocat");
        assert_eq!(d.latest_reviews[0].state, "APPROVED");
        assert_eq!(d.latest_reviews[1].state, "CHANGES_REQUESTED");
    }

    /// A PR with no checks, no comments and a null author must not panic:
    /// the mapper's rule is that one odd payload never blanks the view.
    #[test]
    fn a_sparse_detail_payload_is_survivable() {
        let v = json!({"repository": {"pullRequest": {"number": 1}}});
        let d = map_detail(&v, "octocat/hello-world");
        assert_eq!(d.number, 1);
        assert_eq!(d.author, "ghost");
        assert!(d.checks.is_empty());
        assert!(d.comments.is_empty());
    }

    #[test]
    fn maps_every_merge_state_status_we_model() {
        for (raw, want) in [
            ("CLEAN", MergeStateStatus::Clean),
            ("DIRTY", MergeStateStatus::Dirty),
            ("BLOCKED", MergeStateStatus::Blocked),
            ("UNSTABLE", MergeStateStatus::Unstable),
            ("BEHIND", MergeStateStatus::Behind),
            ("DRAFT", MergeStateStatus::Draft),
        ] {
            let v = json!({"mergeStateStatus": raw});
            assert_eq!(merge_status(&v), want, "for {raw}");
        }
    }

    /// A value we do not model must never masquerade as mergeable: the
    /// merge button keys off Clean, so guessing here would enable it on a
    /// PR GitHub would reject.
    #[test]
    fn unrecognised_merge_status_is_unknown_never_clean() {
        assert_eq!(
            merge_status(&json!({"mergeStateStatus": "HAS_HOOKS"})),
            MergeStateStatus::Unknown
        );
        assert_eq!(
            merge_status(&json!({"mergeStateStatus": null})),
            MergeStateStatus::Unknown
        );
        assert_eq!(merge_status(&json!({})), MergeStateStatus::Unknown);
    }

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
