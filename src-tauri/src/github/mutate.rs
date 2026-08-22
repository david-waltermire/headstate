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

const UPDATE_BRANCH_DOC: &str = "mutation($id: ID!, $oid: GitObjectID!) { \
     updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $oid }) \
     { clientMutationId } }";

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
