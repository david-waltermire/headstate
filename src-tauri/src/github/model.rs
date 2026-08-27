//! The PR model. Field names, enum variants, and serde casing here are
//! consumed by later tasks (the Tauri command layer, the store) and are
//! mirrored into TypeScript in a later milestone, so they are chosen to be
//! stable and are not to be changed casually.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiState {
    Success,
    Failure,
    Pending,
    None,
}

/// GitHub's own summary of whether a PR can merge right now.
///
/// Richer than `MergeState`, which only distinguishes conflicts: this
/// separates "ready" from "blocked on a required review" from "checks
/// failing" -- the difference between a merge button that works and one
/// that lies.
///
/// Live distribution across 25 open PRs when this was added: Clean 11,
/// Dirty 7, Unstable 7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeStateStatus {
    /// Mergeable now.
    Clean,
    /// Merge conflicts.
    Dirty,
    /// A required review or check is missing.
    Blocked,
    /// Non-required checks are failing.
    Unstable,
    /// The base has moved ahead; needs updating.
    Behind,
    /// Draft PRs cannot merge.
    Draft,
    /// Still being computed, or a state we do not model.
    #[default]
    Unknown,
}

/// Three states, not two. `Checking` exists because GitHub computes
/// mergeability lazily and reports UNKNOWN until it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeState {
    Mergeable,
    Conflicted,
    Checking,
}

#[derive(Debug, Clone, Default, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    ReviewRequired,
    /// No verdict. The default, so a partially-built value never claims
    /// an approval that does not exist.
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    /// GraphQL node ID, so a row can act without first opening the
    /// detail view. Rides along in the list query at no extra cost.
    ///
    /// `#[serde(default)]` here and on the fields below is about the
    /// SNAPSHOT CACHE, not the wire: these were added after v1.0.1, and a
    /// cache written by that version has no such key. Without a default,
    /// serde fails the whole payload and every pull request vanishes on
    /// upgrade -- which is what shipped in v2.0.0. An empty id means
    /// "cannot act on this row", and the next poll replaces it wholesale.
    #[serde(default)]
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    pub is_draft: bool,
    /// The branch being merged, and the branch it merges into.
    ///
    /// Carried for the list row: a PR stacked on another branch cannot
    /// merge until its base does, and is otherwise indistinguishable from
    /// one targeting the default branch.
    pub head_ref: String,
    /// The head commit, so an "update branch" click can tell GitHub which
    /// commit the user was actually looking at.
    #[serde(default)]
    pub head_oid: String,
    /// The head branch's Ref node id, for deleting it after merge.
    ///
    /// `None` once the branch is gone -- which is exactly how the UI
    /// tells "already cleaned up" from "still there".
    #[serde(default)]
    pub head_ref_id: Option<String>,
    pub base_ref: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ci: CiState,
    pub merge: MergeState,
    /// GitHub's own merge-readiness summary. See `MergeStateStatus`.
    // Defaults to Unknown, never Clean: a merge button enabled on data the
    // app never fetched is the one wrong answer that costs something.
    #[serde(default)]
    pub merge_status: MergeStateStatus,
    pub review: ReviewState,
    pub in_merge_queue: bool,
    pub labels: Vec<Label>,
    pub comment_count: u64,
    /// Review conversations still open on the current code.
    ///
    /// Resolved threads are excluded, and so are OUTDATED ones -- a thread
    /// on a line that has since changed is not something the author still
    /// has to answer, and counting it would nag about work already done.
    ///
    /// Deliberately a count of open conversations, not a claim that the PR
    /// is blocked: whether a repo REQUIRES resolution before merging lives
    /// in `requiresConversationResolution`, which needs admin access on
    /// that repository and is unreadable for most of them.
    #[serde(default)]
    pub unresolved_threads: u64,
    /// Logins whose review is still outstanding.
    ///
    /// Empty is ORDINARY, not missing data: repositories that assign
    /// reviewers through a bot return nothing here, and so does a solo
    /// account. Anything the UI shows must read sensibly when empty.
    ///
    /// Users only. `requestedReviewer` is a union that also admits
    /// Team and Mannequin; those are dropped rather than given an
    /// invented name.
    #[serde(default)]
    pub requested_reviewers: Vec<String>,
    /// Who has already reviewed, and what they said.
    ///
    /// A different question from `review`, which collapses every
    /// reviewer into one verdict and names nobody.
    #[serde(default)]
    pub latest_reviews: Vec<ReviewerVerdict>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stats {
    pub merged_week: u64,
    pub merged_month: u64,
    pub in_merge_queue: u64,
    pub needs_attention: u64,
    pub awaiting_review: u64,
    pub ready_to_queue: u64,
    pub blocked_by_comments: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HistoryPoint {
    pub date: String,
    pub opened: u64,
    pub merged: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoCount {
    pub repo: String,
    pub merged: u64,
}

/// One merged PR, enough to name and open it.
///
/// The Stats page could show that something took four days or ran to ten
/// thousand lines, and then not say WHICH pull request that was -- every
/// figure was a scalar with no way back to the thing it described.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MergedPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub cycle_time_hours: f64,
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MergedDetail {
    pub cycle_time_hours: Vec<f64>,
    /// additions+deletions per PR, sorted ascending for percentile lookup.
    pub pr_sizes: Vec<u64>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub review_count: u64,
    pub comment_count: u64,
    pub sample_size: u64,
    pub repo_counts: Vec<RepoCount>,
    /// The slowest and largest merges in the sample, so the outlier a
    /// figure describes is reachable rather than merely reported.
    pub slowest: Vec<MergedPr>,
    pub largest: Vec<MergedPr>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Periods {
    pub week_current: u64,
    pub week_previous: u64,
    pub opened_week_current: u64,
    pub opened_week_previous: u64,
    pub month_current: u64,
    pub month_previous: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub points: Vec<HistoryPoint>,
    pub week_current: u64,
    pub week_previous: u64,
    pub opened_week_current: u64,
    pub opened_week_previous: u64,
    pub month_current: u64,
    pub month_previous: u64,
}

impl PullRequest {
    /// Blocked on the author and nobody else: a real conflict, or failing
    /// CI. `Checking` is deliberately excluded -- GitHub reports UNKNOWN
    /// mergeability while it computes, and treating that as a conflict
    /// would fire a false warning on every push.
    ///
    /// This is the ONE Rust owner of the rule. The frontend has its own
    /// copy in `src/lib/derive.ts`; `needs_attention_rule_matches_frontend`
    /// pins them together so the tray badge can never disagree with the
    /// priorities strip.
    pub fn needs_attention(&self) -> bool {
        self.merge == MergeState::Conflicted || self.ci == CiState::Failure
    }
}

/// How many PRs are blocked on the author. Feeds the tray badge.
pub fn needs_attention_count(prs: &[PullRequest]) -> u64 {
    prs.iter().filter(|p| p.needs_attention()).count() as u64
}

/// One CI check on a pull request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    /// `success`, `failure`, `pending`, or the raw value when unmodelled.
    pub state: String,
    /// Where to see the run itself. Empty when GitHub gives none.
    pub url: String,
    /// The Actions workflow RUN this check belongs to, for re-running.
    ///
    /// None for a check from an app that is not GitHub Actions, and for
    /// a plain commit status -- neither has a workflow run to re-run.
    /// Optional rather than defaulted, so the UI offers the button only
    /// where it can actually work rather than failing on click.
    pub run_id: Option<u64>,
}

/// One comment on a pull request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PrComment {
    pub author: String,
    pub created_at: String,
    pub body: String,
}

/// One reviewer's latest review on a pull request.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewerVerdict {
    pub author: String,
    /// GitHub's raw review state: APPROVED, CHANGES_REQUESTED,
    /// COMMENTED, DISMISSED or PENDING. Passed through rather than
    /// narrowed to a bool -- a DISMISSED approval is not an approval,
    /// and collapsing it here would silently claim otherwise.
    pub state: String,
}

/// Everything the detail view renders.
///
/// A separate type from `PullRequest`: that one is a LIST row fetched 100
/// at a time on a 2-minute loop, and adding a body and comments to it
/// would make every poll carry data almost none of the rows need.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PrDetail {
    /// GraphQL node ID. Every mutation takes this rather than a number,
    /// so the detail view is what makes a PR actionable.
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub body: String,
    pub author: String,
    pub repo: String,
    pub head_ref: String,
    /// The head commit, so an "update branch" click can tell GitHub which
    /// commit the user was actually looking at.
    #[serde(default)]
    pub head_oid: String,
    /// The head branch's Ref node id, for deleting it after merge.
    ///
    /// `None` once the branch is gone -- which is exactly how the UI
    /// tells "already cleaned up" from "still there".
    #[serde(default)]
    pub head_ref_id: Option<String>,
    pub base_ref: String,
    // Defaults to Unknown, never Clean: a merge button enabled on data the
    // app never fetched is the one wrong answer that costs something.
    #[serde(default)]
    pub merge_status: MergeStateStatus,
    pub review: ReviewState,
    /// Every reviewer's latest review state, keyed by login.
    ///
    /// A different question from `review`, which is the pull request's
    /// AGGREGATE decision: it reads `changes_requested` when someone
    /// else blocked the PR and `review_required` when a second approval
    /// is outstanding. Neither tells the user whether their own approval
    /// landed -- which is the whole reported confusion.
    ///
    /// The viewer is matched by login on the frontend, which already
    /// knows who it is (`useViewer`), rather than threading a login down
    /// through the client and mapper for one field.
    #[serde(default)]
    pub latest_reviews: Vec<ReviewerVerdict>,
    /// Whether this pull request's base branch uses a merge queue.
    ///
    /// Decides whether the primary action merges or enqueues. Defaults
    /// to false when absent, which is the safe direction: it offers a
    /// plain Merge, and GitHub refuses that if the branch really does
    /// require the queue. Defaulting the other way would hide Merge on
    /// every repo the field could not be read for.
    #[serde(default)]
    pub merge_queue_enabled: bool,
    /// Whether it is currently queued (and not rejected by the queue).
    #[serde(default)]
    pub in_merge_queue: bool,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    #[serde(default)]
    pub unresolved_threads: u64,
    pub comment_count: u64,
    pub comments: Vec<PrComment>,
    pub checks: Vec<CheckRun>,
}

#[cfg(test)]
mod attention_tests {
    use super::*;

    fn pr(merge: MergeState, ci: CiState) -> PullRequest {
        let t = DateTime::parse_from_rfc3339("2026-08-20T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        PullRequest {
            id: "PR_test".into(),
            number: 1,
            title: "t".into(),
            url: "u".into(),
            repo: "acme/repo".into(),
            author: "a".into(),
            is_draft: false,
            head_ref: "feature/x".into(),
            head_oid: "deadbeef".into(),
            head_ref_id: None,
            base_ref: "main".into(),
            created_at: t,
            updated_at: t,
            ci,
            merge,
            merge_status: MergeStateStatus::Clean,
            review: ReviewState::None,
            in_merge_queue: false,
            labels: vec![],
            comment_count: 0,
            unresolved_threads: 0,
            requested_reviewers: Vec::new(),
            latest_reviews: Vec::new(),
        }
    }

    #[test]
    fn conflicted_or_failing_needs_attention() {
        assert!(pr(MergeState::Conflicted, CiState::Success).needs_attention());
        assert!(pr(MergeState::Mergeable, CiState::Failure).needs_attention());
        assert!(pr(MergeState::Conflicted, CiState::Failure).needs_attention());
    }

    /// The rule that keeps the badge honest. GitHub reports UNKNOWN
    /// mergeability while it computes, so counting `Checking` would badge
    /// the tray on every push and train the user to ignore it.
    #[test]
    fn checking_is_not_attention() {
        assert!(!pr(MergeState::Checking, CiState::Success).needs_attention());
        assert!(!pr(MergeState::Checking, CiState::Pending).needs_attention());
    }

    #[test]
    fn pending_and_none_ci_are_not_attention() {
        assert!(!pr(MergeState::Mergeable, CiState::Pending).needs_attention());
        assert!(!pr(MergeState::Mergeable, CiState::None).needs_attention());
    }

    #[test]
    fn counts_only_the_blocked_ones() {
        let prs = vec![
            pr(MergeState::Conflicted, CiState::Success),
            pr(MergeState::Mergeable, CiState::Failure),
            pr(MergeState::Mergeable, CiState::Success),
            pr(MergeState::Checking, CiState::Pending),
        ];
        assert_eq!(needs_attention_count(&prs), 2);
    }

    /// Pins the Rust rule to the TypeScript one by reading the actual
    /// source. The two implementations are unavoidably separate -- one
    /// badges a hidden tray, the other renders a strip -- so a drift here
    /// would silently make the badge disagree with the UI.
    #[test]
    fn needs_attention_rule_matches_frontend() {
        let ts = include_str!("../../../src/lib/derive.ts");
        let start = ts
            .find("export function needsAttention")
            .expect("needsAttention not found in derive.ts");
        let body = &ts[start..start + 200];
        assert!(
            body.contains(r#"pr.merge === "conflicted""#),
            "frontend rule changed: {body}"
        );
        assert!(
            body.contains(r#"pr.ci === "failure""#),
            "frontend rule changed: {body}"
        );
        assert!(
            !body.contains("checking"),
            "frontend now counts checking; Rust does not: {body}"
        );
    }
}

/// Median cycle time for the current week against the previous one.
///
/// `sampled` is true when either window exceeded the 100-node page size,
/// meaning the medians are over a sample of that week rather than all of
/// it. The UI says so rather than implying a census.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CycleTrend {
    pub current_hours: f64,
    pub previous_hours: f64,
    pub current_count: u64,
    pub previous_count: u64,
    pub sampled: bool,
}
