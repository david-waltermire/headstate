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
