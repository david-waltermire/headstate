//! GitHub mutations.
//!
//! **This module is the only place Headstate writes to GitHub.** Reads
//! live in `query.rs` and stay `search`-only, so the read path remains
//! separately auditable -- the point of keeping them apart.
//!
//! Every mutation takes a GraphQL node ID rather than a number, so the
//! caller must have fetched the PR first. That is deliberate: it means a
//! write can only follow a read of the thing being written.

use super::client::{ClientError, GitHubClient};
use serde_json::json;

/// The "Update branch" mutation, hoisted so its test asserts on the
/// document actually sent rather than a copy that could drift from it.
/// Enable "merge when green".
///
/// Takes `expectedHeadOid` for the same reason update-branch does, and it
/// matters MORE here: auto-merge is a DEFERRED write that fires later,
/// unattended, when the user is not looking. Without the guard, a push
/// after enabling would auto-merge a commit they never saw.
const ENABLE_AUTO_MERGE_DOC: &str = "mutation($id: ID!, $oid: GitObjectID!) { \
     enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $oid, \
     mergeMethod: SQUASH }) { clientMutationId } }";

const DISABLE_AUTO_MERGE_DOC: &str = "mutation($id: ID!) { \
     disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }";

/// Delete a branch, by ref node id.
///
/// There is no `deletePullRequestHeadRef`: the path is `deleteRef` on the
/// Ref node, which is why the list query has to fetch `headRef { id }`.
/// (`deleteLinkedBranch` is for issue-linked branches and takes a
/// different id entirely -- verified by introspection.)
const DELETE_REF_DOC: &str = "mutation($id: ID!) { \
     deleteRef(input: { refId: $id }) { clientMutationId } }";

/// Submit a review: approve, request changes, or plain comment.
///
/// Verified against the live schema by introspection, like every other
/// document here: `addPullRequestReview(input: { pullRequestId: ID!,
/// event: PullRequestReviewEvent, body: String })`.
///
/// This is the first mutation Headstate makes to a pull request it does
/// NOT own, which is the whole point -- the to-review queue was
/// read-only, so the most common action a reviewer takes (approving)
/// meant leaving the app.
///
/// `body` is sent unconditionally rather than omitted when empty. GitHub
/// rejects REQUEST_CHANGES without one, and an empty string produces the
/// same refusal as a missing field -- but sending it keeps one document
/// for all three events instead of branching on the event to pick a
/// query, which is the kind of drift the hoisted-document convention in
/// this module exists to prevent.
/// Asks for the resulting review's `state` rather than just
/// `clientMutationId`. A mutation that returns 200 with no errors is not
/// proof the review landed in the state the user asked for -- GitHub can
/// accept the call and record a PENDING review, which looks identical to
/// success from here and is exactly the reported "I clicked approve and
/// nothing happened". With the state in hand the caller can say so.
const ADD_REVIEW_DOC: &str =
    "mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { \
     addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) \
     { pullRequestReview { state } } }";

/// Comment on a pull request.
///
/// `subjectId` takes the PR's own node id -- the same id every other
/// mutation here uses -- because a pull request IS a comment subject.
const ADD_COMMENT_DOC: &str = "mutation($id: ID!, $body: String!) { \
     addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }";

/// Resolve and unresolve take the THREAD's id, not the pull request's --
/// a different node from every other mutation in this file.
///
/// Unresolve exists because resolving is one click with no in-app undo:
/// without it a mis-click can only be corrected on github.com.
const RESOLVE_THREAD_DOC: &str = "mutation($id: ID!) { \
     resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }";

const UNRESOLVE_THREAD_DOC: &str = "mutation($id: ID!) { \
     unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }";

/// A reply goes INTO an existing thread, which is what distinguishes it
/// from `addComment`: that starts a new top-level conversation, and using
/// it to answer an inline review comment would strand the reply away from
/// the code it is about.
const REPLY_TO_THREAD_DOC: &str = "mutation($id: ID!, $body: String!) { \
     addPullRequestReviewThreadReply(\
       input: { pullRequestReviewThreadId: $id, body: $body }) \
     { clientMutationId } }";

const UPDATE_BRANCH_DOC: &str = "mutation($id: ID!, $oid: GitObjectID!) { \
     updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $oid }) \
     { clientMutationId } }";

/// A review verdict.
///
/// Separate from `PrAction` on purpose: every `PrAction` sends the
/// identical `{ pullRequestId: $id }` input, which is what lets
/// `mutate_pr` build them all from one format string. A review carries an
/// event AND a body, so folding it in would mean special-casing the very
/// uniformity that makes `PrAction` safe.
///
/// DISMISS exists in the schema but is deliberately absent: it dismisses
/// someone ELSE's review, which is a different act with different social
/// weight, and nothing in the UI asks for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewVerdict {
    Approve,
    RequestChanges,
    Comment,
}

impl ReviewVerdict {
    /// The `PullRequestReviewEvent` enum value.
    fn event(self) -> &'static str {
        match self {
            ReviewVerdict::Approve => "APPROVE",
            ReviewVerdict::RequestChanges => "REQUEST_CHANGES",
            ReviewVerdict::Comment => "COMMENT",
        }
    }

    /// For logs. Past tense, matching `PrAction::describe`.
    pub fn describe(self) -> &'static str {
        match self {
            ReviewVerdict::Approve => "approved",
            ReviewVerdict::RequestChanges => "sent change requests to",
            ReviewVerdict::Comment => "reviewed",
        }
    }

    /// Whether GitHub refuses this event without body text.
    ///
    /// Checked in the UI so the user sees "a comment is required" before
    /// they click, rather than a GraphQL refusal after.
    pub fn requires_body(self) -> bool {
        matches!(self, ReviewVerdict::RequestChanges | ReviewVerdict::Comment)
    }
}

/// What a mutation does to a pull request.
///
/// An enum rather than free-form strings so the UI cannot ask for an
/// action that does not exist, and so logging names them consistently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrAction {
    Merge,
    Close,
    Reopen,
    ConvertToDraft,
    MarkReady,
    Enqueue,
    Dequeue,
}

impl PrAction {
    /// The GraphQL mutation field.
    fn field(self) -> &'static str {
        match self {
            PrAction::Merge => "mergePullRequest",
            PrAction::Close => "closePullRequest",
            PrAction::Reopen => "reopenPullRequest",
            PrAction::ConvertToDraft => "convertPullRequestToDraft",
            PrAction::MarkReady => "markPullRequestReadyForReview",
            PrAction::Enqueue => "enqueuePullRequest",
            PrAction::Dequeue => "dequeuePullRequest",
        }
    }

    /// For logs and error messages. Past tense reads correctly in both.
    pub fn describe(self) -> &'static str {
        match self {
            PrAction::Merge => "merged",
            PrAction::Close => "closed",
            PrAction::Reopen => "reopened",
            PrAction::ConvertToDraft => "converted to draft",
            PrAction::MarkReady => "marked ready for review",
            PrAction::Enqueue => "added to the merge queue",
            PrAction::Dequeue => "removed from the merge queue",
        }
    }

    /// Whether this destroys work if done by mistake.
    ///
    /// Only `Close` qualifies. Merging is recoverable (revert, or reopen
    /// the branch) and is the action this app exists to speed up, so it
    /// applies immediately -- its safety comes from the button being
    /// enabled only when `mergeStateStatus` is CLEAN, not from a dialog.
    pub fn is_destructive(self) -> bool {
        matches!(self, PrAction::Close)
    }
}

impl GitHubClient {
    /// Re-run the failed jobs of an Actions workflow run.
    ///
    /// REST, not GraphQL: there is no re-run mutation in the GraphQL
    /// schema at all (verified by introspection), so this is the only
    /// path. It is still a WRITE and still lives in this module, so the
    /// "reads and writes are separately auditable" split holds.
    ///
    /// Targets the WORKFLOW RUN rather than individual check runs. One
    /// call re-runs everything that failed, where per-check would be one
    /// request each -- and could not re-run a job that never started
    /// because an earlier one failed.
    ///
    /// GitHub answers 403 "This workflow run cannot be retried" for a
    /// run that succeeded or is too old. That text is returned verbatim,
    /// like every other refusal here.
    pub async fn rerun_failed_jobs(&self, repo: &str, run_id: u64) -> Result<(), ClientError> {
        self.rest_post(&format!(
            "/repos/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
        ))
        .await
    }

    /// Apply an action to a pull request.
    ///
    /// Returns the GitHub error verbatim on refusal -- a rejected merge
    /// ("base branch was modified", "required status check failed") is
    /// already display-ready prose, and rewording it would lose the
    /// specifics the user needs.
    pub async fn mutate_pr(&self, id: &str, action: PrAction) -> Result<(), ClientError> {
        let query = format!(
            "mutation($id: ID!) {{ {}(input: {{ pullRequestId: $id }}) {{ clientMutationId }} }}",
            action.field()
        );
        self.graphql_mutation(&json!({
            "query": query,
            "variables": { "id": id }
        }))
        .await
    }

    /// Submit a review on a pull request.
    ///
    /// The first write Headstate makes to a PR it does not own. Returns
    /// GitHub's refusal verbatim, like every other mutation here: "Can
    /// not approve your own pull request" is exactly what the user needs
    /// to read, and rewording it would lose that.
    pub async fn add_review(
        &self,
        id: &str,
        verdict: ReviewVerdict,
        body: &str,
    ) -> Result<(), ClientError> {
        let v = self
            .graphql_mutation_data(&json!({
                "query": ADD_REVIEW_DOC,
                "variables": { "id": id, "event": verdict.event(), "body": body }
            }))
            .await?;

        // The mutation succeeding is not the same as the review landing.
        // A PENDING review -- one GitHub filed but did not submit -- is
        // returned without any error, and reporting that as success is
        // what left the user staring at an unchanged button wondering
        // whether the click registered.
        //
        // Only PENDING is treated as a failure. Any other state,
        // including one this build does not recognise, is left alone:
        // guessing that an unfamiliar state means failure would be a
        // worse error than the one being fixed.
        let state = v["addPullRequestReview"]["pullRequestReview"]["state"].as_str();
        if state == Some("PENDING") {
            return Err(ClientError::Graphql(
                "GitHub accepted the review but left it pending rather than \
                 submitting it. Open the pull request on GitHub to submit it."
                    .into(),
            ));
        }
        Ok(())
    }

    /// Comment on a pull request without reviewing it.
    ///
    /// Distinct from a COMMENT review: this is a plain issue comment on
    /// the conversation, which is what the detail view already displays
    /// 50 of. A COMMENT review appears as a review in the timeline.
    pub async fn add_comment(&self, id: &str, body: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": ADD_COMMENT_DOC,
            "variables": { "id": id, "body": body }
        }))
        .await
    }

    /// Resolve a review conversation.
    ///
    /// Takes the THREAD id from `ReviewThread.id`, not the pull request's.
    pub async fn resolve_thread(&self, thread_id: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": RESOLVE_THREAD_DOC,
            "variables": { "id": thread_id }
        }))
        .await
    }

    /// Reopen a review conversation that was resolved.
    pub async fn unresolve_thread(&self, thread_id: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": UNRESOLVE_THREAD_DOC,
            "variables": { "id": thread_id }
        }))
        .await
    }

    /// Reply within a review conversation, keeping the answer attached to
    /// the code it is about rather than starting a new top-level comment.
    pub async fn reply_to_thread(&self, thread_id: &str, body: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": REPLY_TO_THREAD_DOC,
            "variables": { "id": thread_id, "body": body }
        }))
        .await
    }

    /// Merge the base branch into a pull request's head -- GitHub's
    /// "Update branch" button.
    ///
    /// `expected_head` is the head OID the caller last saw. GitHub
    /// refuses if the branch has moved since, which is the whole point:
    /// without it, a stale click would quietly update a commit the user
    /// never looked at. The issue this implements calls out exactly that
    /// race ("the base moved between the check and the click"), and the
    /// argument is how GitHub lets us lose it rather than paper over it.
    /// Merge this pull request as soon as its checks pass.
    ///
    /// The answer to the most common blocked state: on a real account 6
    /// of 24 open PRs are UNSTABLE -- checks still running -- which is
    /// precisely "I would merge this the moment CI goes green", and the
    /// only way to say so was to leave the app.
    pub async fn enable_auto_merge(
        &self,
        id: &str,
        expected_head: &str,
    ) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": ENABLE_AUTO_MERGE_DOC,
            "variables": { "id": id, "oid": expected_head }
        }))
        .await
    }

    /// Cancel it, mirroring the enqueue/dequeue pair.
    pub async fn disable_auto_merge(&self, id: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": DISABLE_AUTO_MERGE_DOC,
            "variables": { "id": id }
        }))
        .await
    }

    /// Delete a merged pull request's head branch.
    ///
    /// Measured: 31 of the last 60 merged PRs on a real account still
    /// held a live remote branch, 12 of them merged within two days.
    /// This is the app's own thesis -- agents create branches, PRs merge,
    /// the leftovers stay -- applied to the one domain where it did
    /// nothing.
    ///
    /// The caller must have established the PR is merged or closed:
    /// deleting the head ref of an OPEN pull request closes it off.
    pub async fn delete_ref(&self, ref_id: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": DELETE_REF_DOC,
            "variables": { "id": ref_id }
        }))
        .await
    }

    pub async fn update_pr_branch(&self, id: &str, expected_head: &str) -> Result<(), ClientError> {
        self.graphql_mutation(&json!({
            "query": UPDATE_BRANCH_DOC,
            "variables": { "id": id, "oid": expected_head }
        }))
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every action maps to a real mutation, verified against the live
    /// schema by introspection before this was written.
    #[test]
    fn every_action_names_a_real_mutation() {
        for (action, field) in [
            (PrAction::Merge, "mergePullRequest"),
            (PrAction::Close, "closePullRequest"),
            (PrAction::Reopen, "reopenPullRequest"),
            (PrAction::ConvertToDraft, "convertPullRequestToDraft"),
            (PrAction::MarkReady, "markPullRequestReadyForReview"),
            (PrAction::Enqueue, "enqueuePullRequest"),
            (PrAction::Dequeue, "dequeuePullRequest"),
        ] {
            assert_eq!(action.field(), field);
        }
    }

    /// Verified against the live schema by introspection:
    /// `PullRequestReviewEvent` is exactly COMMENT / APPROVE /
    /// REQUEST_CHANGES / DISMISS.
    #[test]
    fn every_verdict_names_a_real_event() {
        assert_eq!(ReviewVerdict::Approve.event(), "APPROVE");
        assert_eq!(ReviewVerdict::RequestChanges.event(), "REQUEST_CHANGES");
        assert_eq!(ReviewVerdict::Comment.event(), "COMMENT");
    }

    /// Approving with no words is normal and GitHub allows it. The other
    /// two are refused without a body, so the UI must ask first rather
    /// than let the user discover it through a GraphQL error.
    #[test]
    fn only_approve_may_omit_the_body() {
        assert!(!ReviewVerdict::Approve.requires_body());
        assert!(ReviewVerdict::RequestChanges.requires_body());
        assert!(ReviewVerdict::Comment.requires_body());
    }

    /// The documents are hoisted so these assert on what is actually
    /// sent, not on a copy that could drift.
    #[test]
    fn review_document_targets_the_pull_request_and_carries_the_event() {
        assert!(ADD_REVIEW_DOC.contains("addPullRequestReview"));
        assert!(ADD_REVIEW_DOC.contains("pullRequestId: $id"));
        assert!(ADD_REVIEW_DOC.contains("event: $event"));
        assert!(ADD_REVIEW_DOC.contains("$event: PullRequestReviewEvent!"));
    }

    /// `addComment` takes `subjectId`, NOT `pullRequestId` -- a different
    /// argument name from every other mutation in this module, and the
    /// kind of detail that is easy to get wrong from memory.
    #[test]
    fn comment_document_uses_subject_id() {
        assert!(ADD_COMMENT_DOC.contains("addComment"));
        assert!(ADD_COMMENT_DOC.contains("subjectId: $id"));
        assert!(!ADD_COMMENT_DOC.contains("pullRequestId"));
    }

    /// DISMISS is in the schema but must not be reachable: it dismisses
    /// someone else's review, which nothing in the UI asks for.
    #[test]
    fn dismiss_is_not_offered() {
        for v in [
            ReviewVerdict::Approve,
            ReviewVerdict::RequestChanges,
            ReviewVerdict::Comment,
        ] {
            assert_ne!(v.event(), "DISMISS");
        }
    }

    /// The thread mutations take `threadId`/`pullRequestReviewThreadId`,
    /// NOT the pull request id every other mutation here uses. Sending a
    /// PR id to these is the mistake this pins: GitHub answers with a type
    /// error, and the reply lands nowhere.
    #[test]
    fn thread_mutations_address_the_thread_not_the_pull_request() {
        assert!(RESOLVE_THREAD_DOC.contains("resolveReviewThread"));
        assert!(RESOLVE_THREAD_DOC.contains("threadId"));
        assert!(UNRESOLVE_THREAD_DOC.contains("unresolveReviewThread"));
        assert!(UNRESOLVE_THREAD_DOC.contains("threadId"));
        assert!(REPLY_TO_THREAD_DOC.contains("addPullRequestReviewThreadReply"));
        assert!(REPLY_TO_THREAD_DOC.contains("pullRequestReviewThreadId"));
        // A reply must not be routed through addComment, which would post
        // a top-level comment detached from the code under discussion.
        assert!(!REPLY_TO_THREAD_DOC.contains("addComment"));
    }

    /// Only Close destroys work. Merging is recoverable and is the action
    /// this app exists to speed up, so a dialog in front of it would
    /// defeat the point -- its safety comes from the button being enabled
    /// only when GitHub says the PR is mergeable.
    #[test]
    fn only_closing_is_treated_as_destructive() {
        assert!(PrAction::Close.is_destructive());
        for a in [
            PrAction::Merge,
            PrAction::Reopen,
            PrAction::ConvertToDraft,
            PrAction::MarkReady,
            PrAction::Enqueue,
            PrAction::Dequeue,
        ] {
            assert!(!a.is_destructive(), "{a:?} should not need confirmation");
        }
    }

    /// Auto-merge is a DEFERRED write: it fires later, unattended, when
    /// nobody is looking. That is categorically different from the
    /// immediate actions whose safety comes from the button being
    /// enabled only on CLEAN, so the mutation pins expectedHeadOid --
    /// without it, a push after enabling auto-merges a commit the user
    /// never saw.
    #[test]
    fn auto_merge_pins_the_head_it_was_enabled_on() {
        assert!(
            ENABLE_AUTO_MERGE_DOC.contains("$oid: GitObjectID!"),
            "the OID must be non-null or it can be silently omitted"
        );
        assert!(ENABLE_AUTO_MERGE_DOC.contains("expectedHeadOid: $oid"));
        assert!(ENABLE_AUTO_MERGE_DOC.contains("enablePullRequestAutoMerge"));
        // Disabling needs no OID: cancelling is safe whatever the head is.
        assert!(!DISABLE_AUTO_MERGE_DOC.contains("expectedHeadOid"));
    }

    /// The mutation is `deleteRef`, not a PR-specific one -- there is no
    /// `deletePullRequestHeadRef`, and `deleteLinkedBranch` is for
    /// issue-linked branches and takes a different id.
    #[test]
    fn deleting_a_branch_uses_the_ref_node() {
        assert!(DELETE_REF_DOC.contains("deleteRef"));
        assert!(DELETE_REF_DOC.contains("refId: $id"));
        assert!(!DELETE_REF_DOC.contains("deleteLinkedBranch"));
    }

    /// Descriptions are logged and shown in errors, so they must read as
    /// prose in both: "octocat/hello-world#42 merged".
    #[test]
    fn descriptions_read_as_past_tense_prose() {
        assert_eq!(PrAction::Merge.describe(), "merged");
        assert_eq!(PrAction::Enqueue.describe(), "added to the merge queue");
        assert_eq!(PrAction::MarkReady.describe(), "marked ready for review");
    }

    /// Updating a branch must send `expectedHeadOid`. Without it GitHub
    /// updates whatever the head is *now*, so a click on a stale row
    /// would act on a commit the user never saw. The typed `GitObjectID!`
    /// declaration is what makes the argument non-optional at the wire
    /// level, so both halves are pinned here.
    #[test]
    fn updating_a_branch_pins_the_expected_head() {
        let doc = UPDATE_BRANCH_DOC;
        assert!(
            doc.contains("$oid: GitObjectID!"),
            "the OID must be declared non-null or it can be silently omitted"
        );
        assert!(
            doc.contains("expectedHeadOid: $oid"),
            "the OID must actually be passed to the mutation"
        );
        assert!(doc.contains("updatePullRequestBranch"));
    }
}
