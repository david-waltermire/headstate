//! What a branch is, and whether it can be deleted.
//!
//! Deliberately NOT `worktrees::Safety`. That enum answers "can this
//! directory be removed", and its cases say so -- `MainCheckout`,
//! `Orphaned`, `Dirty(u64)` all describe a working tree. A ref has no
//! working tree, and reusing the type would mean carrying four variants
//! that can never occur here while missing the two that dominate:
//! a branch checked out somewhere else, and a branch that exists only
//! on the remote.

use serde::{Deserialize, Serialize};

/// Where a branch exists.
///
/// The three cases clean up differently, which is why this is a type
/// rather than a pair of booleans. Deleting a tracked pair is two
/// operations against two different things -- one local ref, one push
/// to a shared remote -- and the UI must not present that as one click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Location {
    /// A local ref with no counterpart on the remote.
    Local,
    /// On the remote only: never checked out here, or already deleted
    /// locally. Removing it is a push, not a local operation.
    Remote,
    /// Both, and the local one tracks the remote.
    Tracked,
}

/// Why a branch may or may not be deleted.
///
/// Reports the FACT, not a verdict. The stale/orphan split taught that
/// "merged 4 months ago" and "not merged" want different words on
/// screen, and that collapsing them into a boolean loses exactly the
/// information that makes a bulk deletion safe to confirm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Deletable {
    /// Merged into the default branch. Carries how it was established,
    /// because the two answers do not deserve equal confidence.
    Merged { how: MergedHow },
    /// The default branch itself. Never offered.
    DefaultBranch,
    /// Checked out in a worktree, so git will refuse. Names the path,
    /// since the next question is always "where?".
    CheckedOut { path: String },
    /// Not merged: it has commits the default branch does not have.
    Unmerged { ahead: u64 },
    /// Listed, not yet classified. A skeleton in the UI, never an
    /// answer -- distinct from `Unknown`, which means the check ran.
    Pending,
    /// The check ran and could not decide. Never assume deletable.
    Unknown { reason: String },
}

/// How a merge was established.
///
/// A squash merge is detected by comparing patch-ids, which is a
/// content comparison rather than a graph one: two different changes
/// that happen to produce an identical diff are indistinguishable.
/// That is vanishingly rare and it is still not the same claim as
/// "this commit is an ancestor", so the UI gets to say which.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergedHow {
    /// The branch tip is an ancestor of the default branch. Certain.
    Ancestor,
    /// The branch's diff appears in the default branch under a
    /// different commit -- the shape every squash-merged PR leaves.
    Squash,
}

impl Deletable {
    /// Whether deletion may be OFFERED.
    ///
    /// The gate is re-evaluated at delete time regardless; this only
    /// decides what the UI enables. `Pending` and `Unknown` are false
    /// on purpose -- an unfinished or failed check is not permission.
    pub fn is_deletable(&self) -> bool {
        matches!(self, Deletable::Merged { .. })
    }
}

/// One branch, local or remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name: `feature/x`, or `origin/feature/x` for remote-only.
    pub name: String,
    pub location: Location,
    /// The tracked upstream, when there is one.
    pub upstream: Option<String>,
    /// Commits ahead of / behind the default branch.
    pub ahead: u64,
    pub behind: u64,
    /// Last commit date, ISO 8601, as git reports it.
    pub committed: String,
    pub author: String,
    /// Abbreviated tip SHA.
    pub tip: String,
    pub deletable: Deletable,
}

/// Defaults to `Pending`, never to a deletable state.
///
/// Same reasoning as `Safety`: the default is the value a bug is most
/// likely to leave behind, so it must be the one that refuses.
impl Default for Deletable {
    fn default() -> Self {
        Deletable::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_merged_branch_is_offered_for_deletion() {
        assert!(Deletable::Merged {
            how: MergedHow::Ancestor
        }
        .is_deletable());
        assert!(Deletable::Merged {
            how: MergedHow::Squash
        }
        .is_deletable());

        assert!(!Deletable::DefaultBranch.is_deletable());
        assert!(!Deletable::Unmerged { ahead: 3 }.is_deletable());
        assert!(!Deletable::CheckedOut {
            path: "/w/x".into()
        }
        .is_deletable());
    }

    /// An unfinished check and a failed one are both "no", and for the
    /// same reason: neither established anything.
    #[test]
    fn an_unresolved_check_is_never_permission_to_delete() {
        assert!(!Deletable::Pending.is_deletable());
        assert!(!Deletable::Unknown {
            reason: "git failed".into()
        }
        .is_deletable());
        assert!(!Deletable::default().is_deletable());
    }
}
