use serde::{Deserialize, Serialize};

/// A checkout with worktrees hanging off it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Repo {
    /// Directory name, e.g. `enc-api`.
    pub name: String,
    /// Absolute path to the main checkout.
    pub path: String,
    pub worktrees: Vec<Worktree>,
}

/// Why a worktree can or cannot be removed.
///
/// Deliberately an enum rather than a bool: the UI has to explain ITSELF,
/// and "3 uncommitted files" is actionable where a greyed-out button is
/// not. `NeverPushed` is separate from `Unmerged` because it is the
/// dangerous one -- measured, 5 of 25 sampled worktrees have no upstream
/// at all, so their commits exist nowhere else on earth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum Safety {
    /// Merged, clean, and pushed. Removable.
    ///
    /// Carries the date the branch landed in the default branch, when it
    /// can be determined -- knowing a branch merged yesterday versus four
    /// months ago changes how confidently you delete it.
    Safe,
    /// The repository's own checkout, not a worktree.
    MainCheckout,
    /// Uncommitted changes; the number of affected paths.
    Dirty(u64),
    /// Commits not on the remote; how many.
    Unpushed(u64),
    /// No upstream branch at all -- nothing has ever been pushed.
    NeverPushed,
    /// Branch is not merged into the default branch.
    Unmerged,
    /// Git could not answer; never assume safe on an error.
    Unknown(String),
}

/// Defaults to `Unknown`, never `Safe`.
///
/// A partially-constructed `Worktree` must not be deletable: the default
/// is the value a bug is most likely to leave behind.
impl Default for Safety {
    fn default() -> Self {
        Safety::Unknown("not yet classified".into())
    }
}

impl Safety {
    /// Only `Safe` may be deleted. Everything else is disabled in the UI
    /// rather than warned past -- a cleanup tool that occasionally eats a
    /// day of work is worse than no cleanup tool.
    pub fn is_safe(&self) -> bool {
        matches!(self, Safety::Safe)
    }

    /// Display-ready prose for the row, so the UI does not re-derive it.
    pub fn reason(&self) -> String {
        match self {
            Safety::Safe => "merged, pushed, safe to delete".into(),
            Safety::MainCheckout => "the repository's main checkout".into(),
            Safety::Dirty(n) => format!("{n} uncommitted file{}", if *n == 1 { "" } else { "s" }),
            Safety::Unpushed(n) => {
                format!("{n} unpushed commit{}", if *n == 1 { "" } else { "s" })
            }
            Safety::NeverPushed => "never pushed — commits exist only here".into(),
            Safety::Unmerged => "branch not merged".into(),
            Safety::Unknown(why) => format!("could not determine: {why}"),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    /// Bytes on disk. `None` until measured -- sizing 202 trees is a walk
    /// over hundreds of thousands of files, so it is deliberately lazy.
    pub size_bytes: Option<u64>,
    pub safety: Safety,
    /// True for the repository's own checkout.
    pub is_main: bool,
    /// `YYYY-MM-DD` when this branch landed in the default branch.
    ///
    /// The date the work reached the default branch, NOT the branch tip's
    /// own commit date. They coincide for a fast-forward but diverge for
    /// a branch written weeks before it merged, and the merge date is the
    /// one that answers "is this safe to forget about".
    pub merged_at: Option<String>,
}
