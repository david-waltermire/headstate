use serde::{Deserialize, Serialize};

/// A checkout with worktrees hanging off it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Repo {
    /// `owner/repo` from the git remote, when it can be established.
    ///
    /// From the REMOTE, never the directory name -- this app's own
    /// directory is `ghstat` while its repository is
    /// `pktstorm/headstate`. Used to pair a worktree with its pull
    /// request; None means no pairing rather than a fuzzy one.
    #[serde(default)]
    pub identity: Option<String>,
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
    /// Listed, but not yet classified. A transient state the UI shows as
    /// a skeleton rather than as an answer -- distinct from `Unknown`,
    /// which means the check ran and could not decide.
    Pending,
    /// Git could not answer; never assume safe on an error.
    Unknown(String),
}

/// Defaults to `Pending`, never `Safe`.
///
/// A partially-constructed `Worktree` must not be deletable: the default
/// is the value a bug is most likely to leave behind, and neither
/// `Pending` nor `Unknown` is deletable.
impl Default for Safety {
    /// Not-yet-checked, which is NOT the same as checked-and-failed.
    ///
    /// This used to default to `Unknown("not yet classified")`, which the
    /// UI rendered as "could not determine: not yet classified" -- a
    /// failed check, in the same grey as a real failure. The fast listing
    /// lands in ~2.6s and classification takes up to ~57s, so for most of
    /// a minute every row claimed its safety check had failed.
    fn default() -> Self {
        Safety::Pending
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
            Safety::Pending => "checking…".into(),
            Safety::Unknown(why) => format!("could not determine: {why}"),
        }
    }
}

/// How a checkout stands against its tracked upstream.
///
/// Separate from `Safety` on purpose: safety answers "may I delete
/// this?", while this answers "is this current?". Folding them together
/// would make the main checkout's row a safety verdict about a directory
/// nobody is proposing to delete.
///
/// Comparison is against the last fetch -- reading refs already on disk,
/// never the network. This is a local disk-usage view, and a scan that
/// silently fetched 37 remotes would be both slow and surprising.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "n")]
pub enum Upstream {
    /// Level with the upstream as of the last fetch.
    Current,
    Ahead(u64),
    Behind(u64),
    /// Both sides moved: `.0` ahead, `.1` behind.
    Diverged(u64, u64),
    /// A local-only branch. Normal, not an error -- and distinctly not
    /// "up to date", which is what a bare zero would imply.
    Untracked,
    /// No branch to compare, so the question does not apply.
    Detached,
    Unknown(String),
}

impl Upstream {
    /// Display-ready prose, so the UI does not re-derive it.
    pub fn reason(&self) -> String {
        let commits = |n: &u64| format!("{n} commit{}", if *n == 1 { "" } else { "s" });
        match self {
            Upstream::Current => "up to date with upstream".into(),
            Upstream::Ahead(n) => format!("{} ahead of upstream", commits(n)),
            Upstream::Behind(n) => format!("{} behind upstream", commits(n)),
            Upstream::Diverged(a, b) => {
                format!("diverged: {} ahead, {} behind", commits(a), commits(b))
            }
            Upstream::Untracked => "no upstream — local only".into(),
            Upstream::Detached => "detached HEAD".into(),
            Upstream::Unknown(why) => format!("upstream unknown: {why}"),
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
    /// How this checkout stands against its upstream.
    ///
    /// Computed for EVERY worktree, not just the main checkout. That
    /// restriction was right when a row's only action was Remove and the
    /// safety verdict answered the only question; Claudify changed it,
    /// and "3 commits ahead" is the evidence for whether there is
    /// anything worth keeping.
    pub upstream: Option<Upstream>,
    /// RFC 3339 timestamp of the branch tip's own commit.
    ///
    /// NOT `merged_at`, which is when the work reached the default
    /// branch. A branch written in March and merged in August has both,
    /// and they answer different questions: this one says how stale the
    /// work is, that one says whether it is already accounted for.
    pub last_commit: Option<String>,
    /// `YYYY-MM-DD` when this branch landed in the default branch.
    ///
    /// The date the work reached the default branch, NOT the branch tip's
    /// own commit date. They coincide for a fast-forward but diverge for
    /// a branch written weeks before it merged, and the merge date is the
    /// one that answers "is this safe to forget about".
    pub merged_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default must never be deletable. A partially-constructed
    /// `Worktree` is what a bug leaves behind, and this is the one place
    /// where getting it wrong deletes someone's work.
    #[test]
    fn the_default_safety_is_not_deletable() {
        assert!(!Safety::default().is_safe());
        assert_eq!(Safety::default(), Safety::Pending);
    }

    /// `Pending` and `Unknown` are different states and must stay
    /// different.
    ///
    /// `Pending` means "not checked yet" and shows as a skeleton;
    /// `Unknown` means "checked, could not decide" and shows as a
    /// failure. Collapsing them is what made every unclassified row
    /// claim its safety check had failed for the first minute of a scan.
    #[test]
    fn pending_reads_as_waiting_not_as_failure() {
        assert_eq!(Safety::Pending.reason(), "checking…");
        let unknown = Safety::Unknown("git exploded".into());
        assert!(unknown.reason().contains("could not determine"));
        assert_ne!(Safety::Pending.reason(), unknown.reason());
        assert!(!Safety::Pending.is_safe());
    }
}
