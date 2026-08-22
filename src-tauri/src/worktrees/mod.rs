//! Local git worktree discovery.
//!
//! Agents create worktrees; pull requests merge; the worktrees stay. On
//! this machine that is 202 worktrees across 6 repositories in a `~/code`
//! totalling 270 GB, which is how a disk fills up silently.
//!
//! Discovery asks GIT rather than scanning for `.git` files: git owns the
//! truth about which worktrees exist, so there is no orphan-guessing and
//! no false positives from a stale directory.
//!
//! Nothing here talks to GitHub. It is local disk work and deliberately
//! runs off the poll loop.

mod assess;
mod model;
mod scan;

pub use assess::assess;
pub use model::{Repo, Worktree};
pub use scan::{
    classify_repo, head_oid, remove_worktree, remove_worktree_forced, remove_worktrees,
    scan_dirs_fast, size_repo, RemovalOutcome,
};
