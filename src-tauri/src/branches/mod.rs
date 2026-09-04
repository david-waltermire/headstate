//! Local and remote branches, per repository, with cleanup of merged ones.
//!
//! Separate from `worktrees` because the questions differ: a worktree
//! is a directory that may hold uncommitted work, while a branch is a
//! ref whose only real question is whether its content already landed.
//! They share the git helper and the patch-id technique, not the model.

pub mod delete;
pub mod model;
pub mod scan;

pub use delete::{delete_local, delete_remote, DeleteOutcome};
pub use model::{Branch, Deletable, Location, MergedHow};
pub use scan::scan;
