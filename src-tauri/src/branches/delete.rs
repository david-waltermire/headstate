//! Deleting branches, local and remote.
//!
//! The contract `remove_worktree` established, kept here: the safety
//! gate is RE-EVALUATED at delete time. What the UI last saw may be
//! minutes old and a branch can be merged, checked out, or advanced in
//! between -- so the list the user ticked is a list of names, never a
//! list of permissions.

use std::path::Path;

use super::model::Deletable;
use super::scan;
use crate::worktrees::scan::git;

/// What happened to one branch.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub name: String,
    /// `None` on success; the reason otherwise. A refusal and a git
    /// failure are both errors here because both leave the branch in
    /// place -- the caller does not have to tell them apart to be
    /// correct, and the message says which.
    pub error: Option<String>,
}

/// Re-check that this branch is still deletable, right now.
fn still_deletable(dir: &Path, name: &str) -> Result<(), String> {
    let branches = scan::scan(dir)?;
    let Some(b) = branches.iter().find(|b| b.name == name) else {
        return Err(format!("{name} no longer exists"));
    };
    match &b.deletable {
        Deletable::Merged { .. } => Ok(()),
        Deletable::DefaultBranch => Err(format!("{name} is the default branch")),
        Deletable::CheckedOut { path } => Err(format!("{name} is checked out in {path}")),
        Deletable::Unmerged { ahead } => Err(format!(
            "{name} is not merged: {ahead} commit(s) are not on the default branch"
        )),
        Deletable::Pending => Err(format!("{name} has not been checked yet")),
        Deletable::Unknown { reason } => Err(format!("{name}: {reason}")),
    }
}

/// Delete local branches that are still provably merged.
///
/// Uses `-D`, and the gate above is the reason that is safe.
///
/// `-d` was the first choice, as a second opinion from git. It does not
/// work here: git's own check is ANCESTRY, and a squash merge is never
/// an ancestor. Measured on a real repository, 489 of 536 merged
/// branches were squashes -- `-d` refuses all of them, so the feature
/// would refuse to delete 91% of what it correctly identified as
/// deletable.
///
/// So the patch-id gate in `still_deletable` is not a convenience in
/// front of git's check; it IS the check, and it is strictly stronger
/// than `-d` on this workflow. It is re-run immediately before the
/// delete, against the repository as it stands, never against what the
/// UI last displayed.
pub fn delete_local(repo_path: &str, names: &[String]) -> Vec<DeleteOutcome> {
    let dir = Path::new(repo_path);
    names
        .iter()
        .map(|name| {
            let error = still_deletable(dir, name)
                .err()
                .or_else(|| git(dir, &["branch", "-D", name]).err());
            DeleteOutcome {
                name: name.clone(),
                error,
            }
        })
        .collect()
}

/// Delete branches on the remote.
///
/// A push to shared state: everyone else loses the ref too, and there
/// is no reflog on the other side to recover it from. Separate from
/// `delete_local` so it cannot be reached by the same click, and it
/// still re-checks the merge gate first -- being remote does not make
/// the branch any more disposable.
pub fn delete_remote(repo_path: &str, names: &[String]) -> Vec<DeleteOutcome> {
    let dir = Path::new(repo_path);
    names
        .iter()
        .map(|name| {
            // `origin/feature` names a remote-tracking ref; the push
            // needs the remote and the branch separately.
            let error = match name.split_once('/') {
                None => Some(format!(
                    "{name} does not name a remote branch (expected <remote>/<branch>)"
                )),
                Some((remote, branch)) => still_deletable(dir, name)
                    .err()
                    .or_else(|| git(dir, &["push", remote, "--delete", branch]).err()),
            };
            DeleteOutcome {
                name: name.clone(),
                error,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const IDENT: [(&str, &str); 4] = [
        ("GIT_AUTHOR_NAME", "octocat"),
        ("GIT_COMMITTER_NAME", "octocat"),
        ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
        ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
    ];

    /// Retries the SPAWN, not the command.
    ///
    /// macOS `posix_spawn` intermittently returns ENOENT under process
    /// load -- the same failure #447 fixed in `is_ignored`. These
    /// fixtures each run a dozen git commands and the suite runs them
    /// concurrently, so a single attempt made three tests fail in the
    /// full run while passing when filtered. A git that RAN is
    /// believed, whatever it said.
    fn run(dir: &Path, args: &[&str]) {
        let mut last = None;
        for _ in 0..3 {
            match Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(IDENT)
                .output()
            {
                Ok(out) => {
                    assert!(
                        out.status.success(),
                        "git {args:?}: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                    return;
                }
                Err(e) => last = Some(e),
            }
        }
        panic!("could not spawn git {args:?}: {last:?}");
    }

    fn commit(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), name).unwrap();
        run(dir, &["add", "-A"]);
        run(dir, &["commit", "-q", "-m", name]);
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo, "base");
        run(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run(&repo, &["push", "-q", "-u", "origin", "main"]);
        run(&repo, &["remote", "set-head", "origin", "main"]);
        (tmp, repo)
    }

    /// Squash-merge `branch` into main so it is genuinely deletable.
    fn squash_merge(repo: &Path, branch: &str) {
        run(repo, &["checkout", "-q", "main"]);
        run(repo, &["merge", "-q", "--squash", branch]);
        run(repo, &["commit", "-q", "-m", &format!("squashed {branch}")]);
        run(repo, &["push", "-q", "origin", "main"]);
    }

    fn branch_exists(repo: &Path, name: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--verify", &format!("refs/heads/{name}")])
            .output()
            .unwrap()
            .status
            .success()
    }

    #[test]
    fn a_merged_branch_is_deleted() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "done"]);
        commit(&repo, "work");
        squash_merge(&repo, "done");

        let out = delete_local(repo.to_str().unwrap(), &["done".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].error, None, "{:?}", out[0]);
        assert!(!branch_exists(&repo, "done"));
    }

    /// The gate that matters. Deleting an unmerged branch loses commits
    /// that exist nowhere else.
    #[test]
    fn an_unmerged_branch_is_refused_and_survives() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "wip"]);
        commit(&repo, "unshared-work");
        run(&repo, &["checkout", "-q", "main"]);

        let out = delete_local(repo.to_str().unwrap(), &["wip".to_string()]);
        assert!(out[0].error.is_some(), "an unmerged branch must be refused");
        assert!(
            branch_exists(&repo, "wip"),
            "a refused deletion must leave the branch in place"
        );
    }

    /// Asserts on OUR reason, not merely that it failed.
    ///
    /// Both this and the checked-out case are refused by git anyway --
    /// which is exactly the trap: a test that only checks `is_some()`
    /// passes with the gate deleted, because git's own refusal fills
    /// in. Mutation testing caught both. Since local deletion runs
    /// `-D`, git's refusal is not a backstop we may lean on, so the
    /// assertion names the gate's own message.
    #[test]
    fn the_default_branch_is_refused_by_our_gate() {
        let (_t, repo) = fixture();
        let out = delete_local(repo.to_str().unwrap(), &["main".to_string()]);
        let err = out[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("is the default branch"),
            "expected the gate's own refusal, got: {err}"
        );
        assert!(branch_exists(&repo, "main"));
    }

    /// THE contract from `remove_worktree`: the gate is re-evaluated
    /// now, not trusted from whatever the UI last rendered. Here the
    /// branch is merged when listed and has new work by delete time.
    #[test]
    fn the_gate_is_re_evaluated_at_delete_time_not_taken_from_the_ui() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "moving"]);
        commit(&repo, "first");
        squash_merge(&repo, "moving");

        // What the UI would have seen: deletable.
        let listed = scan::scan(&repo).unwrap();
        let seen = listed.iter().find(|b| b.name == "moving").unwrap();
        assert!(seen.deletable.is_deletable());

        // Now the branch advances, exactly as it would if the user had
        // committed to it in another window.
        run(&repo, &["checkout", "-q", "moving"]);
        commit(&repo, "second");
        run(&repo, &["checkout", "-q", "main"]);

        let out = delete_local(repo.to_str().unwrap(), &["moving".to_string()]);
        assert!(
            out[0].error.is_some(),
            "a branch that gained commits after listing must be refused"
        );
        assert!(branch_exists(&repo, "moving"));
    }

    #[test]
    fn a_branch_checked_out_in_a_worktree_is_refused() {
        let (tmp, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "live"]);
        commit(&repo, "live-work");
        squash_merge(&repo, "live");
        let wt = tmp.path().join("live-wt");
        run(
            &repo,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "live"],
        );

        let out = delete_local(repo.to_str().unwrap(), &["live".to_string()]);
        let err = out[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("is checked out in"),
            "expected the gate's own refusal, got: {err}"
        );
        assert!(branch_exists(&repo, "live"));
    }

    /// One bad name must not stop the rest: a bulk deletion that
    /// aborted halfway would leave the user guessing what landed.
    #[test]
    fn one_refusal_does_not_abort_the_others() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "ok-one"]);
        commit(&repo, "a");
        squash_merge(&repo, "ok-one");
        run(&repo, &["checkout", "-q", "-b", "nope"]);
        commit(&repo, "b");
        run(&repo, &["checkout", "-q", "-b", "ok-two", "main"]);
        commit(&repo, "c");
        squash_merge(&repo, "ok-two");

        let out = delete_local(
            repo.to_str().unwrap(),
            &["ok-one".into(), "nope".into(), "ok-two".into()],
        );
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].error, None);
        assert!(out[1].error.is_some());
        assert_eq!(out[2].error, None, "{:?}", out[2]);
        assert!(!branch_exists(&repo, "ok-one"));
        assert!(branch_exists(&repo, "nope"));
        assert!(!branch_exists(&repo, "ok-two"));
    }

    #[test]
    fn a_merged_remote_branch_is_deleted_from_the_remote() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "shipped"]);
        commit(&repo, "shipped-work");
        run(&repo, &["push", "-q", "origin", "shipped"]);
        squash_merge(&repo, "shipped");
        run(&repo, &["branch", "-q", "-D", "shipped"]);

        let out = delete_remote(repo.to_str().unwrap(), &["origin/shipped".to_string()]);
        assert_eq!(out[0].error, None, "{:?}", out[0]);

        let refs = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["ls-remote", "--heads", "origin", "shipped"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&refs.stdout).trim().is_empty(),
            "the branch must be gone from the remote"
        );
    }

    /// Being remote is not a reason to skip the gate: a push deletion
    /// cannot be undone from a local reflog.
    #[test]
    fn an_unmerged_remote_branch_is_refused() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "live-remote"]);
        commit(&repo, "remote-work");
        run(&repo, &["push", "-q", "origin", "live-remote"]);
        run(&repo, &["checkout", "-q", "main"]);
        run(&repo, &["branch", "-q", "-D", "live-remote"]);

        let out = delete_remote(repo.to_str().unwrap(), &["origin/live-remote".to_string()]);
        assert!(out[0].error.is_some(), "unmerged remote must be refused");

        let refs = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["ls-remote", "--heads", "origin", "live-remote"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&refs.stdout).trim().is_empty());
    }

    /// A tracked branch deleted in BOTH places.
    ///
    /// #473: the view filed tracked branches under "local" and never
    /// offered the remote half, so the local ref went and the remote
    /// branch stayed -- and, its local ref now gone, it came back in
    /// the list as remote-only. The user believed it was cleaned up.
    ///
    /// The backend already supports this; what it needs is a caller
    /// that passes the branch name to one function and the UPSTREAM
    /// name to the other. This proves that pairing works.
    #[test]
    fn a_tracked_branch_can_be_deleted_in_both_places() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "shipped"]);
        commit(&repo, "shipped-work");
        run(&repo, &["push", "-q", "-u", "origin", "shipped"]);
        squash_merge(&repo, "shipped");

        // As the view sees it: one branch, location Tracked.
        let listed = scan::scan(&repo).unwrap();
        let b = listed.iter().find(|b| b.name == "shipped").unwrap();
        assert_eq!(b.location, super::super::model::Location::Tracked);
        let upstream = b
            .upstream
            .clone()
            .expect("a tracked branch has an upstream");

        let local = delete_local(repo.to_str().unwrap(), &["shipped".to_string()]);
        assert_eq!(local[0].error, None, "{:?}", local[0]);
        let remote = delete_remote(repo.to_str().unwrap(), &[upstream]);
        assert_eq!(remote[0].error, None, "{:?}", remote[0]);

        assert!(!branch_exists(&repo, "shipped"));
        let refs = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["ls-remote", "--heads", "origin", "shipped"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&refs.stdout).trim().is_empty(),
            "the remote branch must be gone too -- this is the #473 failure"
        );
    }
}
