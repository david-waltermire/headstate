//! Facts about a worktree's work, for handing to a coding agent.
//!
//! Gathered on demand rather than during the scan: this is six git calls
//! per worktree, and the scan already walks 268 of them. Nobody needs
//! these numbers until they click.
//!
//! Everything here is local. No network, no GitHub API -- the comparison
//! is against the `origin/main` ref already on disk, so this works on a
//! plane and costs no rate limit.

use super::scan::{default_branch, git};
use serde::Serialize;
use std::path::Path;

/// How many commit subjects to carry. A branch with 200 commits should
/// not produce a prompt nobody can read; ten is enough to see the shape
/// of the work, and the count says what was elided.
const MAX_SUBJECTS: usize = 10;

/// What the assessment prompt states as fact.
///
/// Every field is `Option` or defaulted because a git call can fail, and
/// a prompt that asserts "0 commits ahead" when the check failed sends an
/// agent looking for work that is there. Absent means absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Assessment {
    pub path: String,
    pub branch: String,
    /// Commits on this branch that are not on the default branch.
    pub commits_ahead: Option<u64>,
    pub files_changed: Option<u64>,
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
    /// Relative, as git prints it: "3 weeks ago".
    pub last_activity: Option<String>,
    /// Never pushed means these commits exist only on this machine. The
    /// single most important fact in the whole struct.
    pub has_upstream: bool,
    /// Newest first, capped at `MAX_SUBJECTS`.
    pub subjects: Vec<String>,
    /// How many subjects were elided by the cap.
    pub subjects_elided: u64,
    /// Uncommitted paths. Not covered by the diff against the default
    /// branch, so an agent would otherwise assess an incomplete picture.
    pub uncommitted: u64,
}

/// Gather what can be known about a worktree's work, locally.
pub fn assess(repo_path: &str, worktree_path: &str, branch: &str) -> Assessment {
    let repo = Path::new(repo_path);
    let dir = Path::new(worktree_path);
    let base = format!("origin/{}", default_branch(repo));

    // Three dots: the merge-base comparison, which shows what this BRANCH
    // added. Two dots would fold in everything the default branch gained
    // since, inflating an old branch's diff with unrelated work and
    // sending the agent to assess changes that are not the user's.
    let range3 = format!("{base}...{branch}");
    let range2 = format!("{base}..{branch}");

    let count = |args: &[&str]| -> Option<u64> { git(dir, args).ok()?.trim().parse::<u64>().ok() };

    let mut a = Assessment {
        path: worktree_path.to_string(),
        branch: branch.to_string(),
        commits_ahead: count(&["rev-list", "--count", &range2]),
        // `--` before the ref: a branch named `--output=/path` would
        // otherwise make git write to an arbitrary file. The boundary in
        // `parse_porcelain` should already have dropped it; this is the
        // second layer.
        last_activity: git(dir, &["log", "-1", "--format=%cr", "--", branch])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        has_upstream: git(dir, &["rev-parse", "--abbrev-ref", "@{u}"]).is_ok(),
        ..Default::default()
    };

    if let Ok(stat) = git(dir, &["diff", "--shortstat", &range3]) {
        let (f, i, d) = parse_shortstat(&stat);
        a.files_changed = f;
        a.insertions = i;
        a.deletions = d;
    }

    if let Ok(log) = git(dir, &["log", &range2, "--format=%s"]) {
        let all: Vec<String> = log
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        a.subjects_elided = all.len().saturating_sub(MAX_SUBJECTS) as u64;
        a.subjects = all.into_iter().take(MAX_SUBJECTS).collect();
    }

    if let Ok(status) = git(dir, &["status", "--porcelain"]) {
        a.uncommitted = status.lines().filter(|l| !l.trim().is_empty()).count() as u64;
    }

    a
}

impl Assessment {
    /// The prompt handed to a coding agent.
    ///
    /// States what is known and asks four questions, in the order a human
    /// would: what is this, what would it break, is it finished, and what
    /// should I do. The agent is told explicitly NOT to push or open a
    /// pull request -- a button labelled "assess" that writes to GitHub is
    /// a different feature with a different risk profile.
    ///
    /// A fact that could not be gathered is OMITTED rather than guessed.
    /// "0 commits ahead" when the check failed would send an agent looking
    /// for work that is there.
    pub fn prompt(&self) -> String {
        let mut out = format!(
            "Assess the git worktree at {}, branch {}.\n\n",
            self.path, self.branch
        );

        let mut facts = Vec::new();
        if let Some(n) = self.commits_ahead {
            facts.push(format!(
                "  {n} commit{} ahead of the default branch",
                plural(n)
            ));
        }
        if let Some(f) = self.files_changed {
            let ins = self.insertions.unwrap_or(0);
            let del = self.deletions.unwrap_or(0);
            facts.push(format!("  {f} file{} changed, +{ins}/-{del}", plural(f)));
        }
        if let Some(when) = &self.last_activity {
            facts.push(format!("  last commit {when}"));
        }
        if self.uncommitted > 0 {
            // Not covered by the diff against the default branch, so an
            // agent would otherwise assess an incomplete picture.
            facts.push(format!(
                "  {} uncommitted file{} in the working tree",
                self.uncommitted,
                plural(self.uncommitted)
            ));
        }
        if !self.has_upstream {
            // The single most important line here, so it goes last where
            // it is read rather than buried among the counts.
            facts.push("  NOT PUSHED -- these commits exist only on this machine".to_string());
        }
        if !facts.is_empty() {
            out.push_str(&facts.join("\n"));
            out.push_str("\n\n");
        }

        if !self.subjects.is_empty() {
            out.push_str("Commits:\n");
            for s in &self.subjects {
                out.push_str(&format!("  - {s}\n"));
            }
            if self.subjects_elided > 0 {
                out.push_str(&format!("  ... and {} more\n", self.subjects_elided));
            }
            out.push('\n');
        }

        out.push_str(
            "Please:\n\
             \x20 1. What does this change, and why does it appear to exist?\n\
             \x20 2. What would it affect if merged into the default branch?\n\
             \x20 3. Is it complete, or was it abandoned midway?\n\
             \x20 4. Recommend one: open a PR / needs work first / safe to discard.\n\n\
             Do not push anything or open a pull request. Report your assessment \
             and let me decide.",
        );
        out
    }

    /// The whole command, ready to paste into a shell.
    ///
    /// Single quotes around both the path and the prompt: that is what
    /// makes `$VARS`, backticks, and `;` in a branch name inert rather
    /// than executable. Embedded single quotes are closed, escaped, and
    /// reopened -- the only way to get one inside a single-quoted string.
    pub fn command(&self, claude: &str) -> String {
        format!(
            "cd {} && {claude} {}",
            shell_quote(&self.path),
            shell_quote(&self.prompt())
        )
    }
}

/// Wrap in single quotes so the shell treats the contents as literal.
///
/// A worktree path or commit subject is untrusted input as far as the
/// shell is concerned: a branch named `x'; rm -rf ~` would otherwise
/// paste as two commands.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn plural(n: u64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// Pull the three numbers out of `git diff --shortstat`.
///
/// The line omits a clause entirely when it is zero -- a pure-addition
/// diff has no "deletions" part at all -- so this reads each independently
/// rather than positionally.
fn parse_shortstat(s: &str) -> (Option<u64>, Option<u64>, Option<u64>) {
    let num_before = |needle: &str| -> Option<u64> {
        let idx = s.find(needle)?;
        s[..idx]
            .split_whitespace()
            .next_back()
            .and_then(|n| n.parse().ok())
    };
    (
        num_before("file"),
        num_before("insertion"),
        num_before("deletion"),
    )
}

#[cfg(test)]
mod live {
    use super::*;

    /// Against a real worktree on this machine. Run manually:
    /// `cargo test --lib live_assess -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_assess_a_real_worktree() {
        // Supplied by the environment rather than hardcoded. The paths
        // that used to sit here named a private project, which is both a
        // leak and useless to anyone else running this.
        let (repo, wt, branch) = match (
            std::env::var("HEADSTATE_LIVE_REPO"),
            std::env::var("HEADSTATE_LIVE_WORKTREE"),
            std::env::var("HEADSTATE_LIVE_BRANCH"),
        ) {
            (Ok(r), Ok(w), Ok(b)) => (r, w, b),
            _ => {
                println!(
                    "set HEADSTATE_LIVE_REPO, HEADSTATE_LIVE_WORKTREE and \
                     HEADSTATE_LIVE_BRANCH to run this"
                );
                return;
            }
        };
        let a = assess(&repo, &wt, &branch);
        println!("--- ASSESSMENT ---\n{a:#?}");
        println!("--- PROMPT ---\n{}", a.prompt());
        println!("--- COMMAND ---\n{}", a.command("claude"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Assessment {
        Assessment {
            path: "/code/proj-feature".into(),
            branch: "feature/retry".into(),
            commits_ahead: Some(4),
            files_changed: Some(11),
            insertions: Some(240),
            deletions: Some(18),
            last_activity: Some("3 weeks ago".into()),
            has_upstream: true,
            subjects: vec!["add retry to the client".into()],
            subjects_elided: 0,
            uncommitted: 0,
        }
    }

    /// The most important fact in the struct: these commits exist nowhere
    /// else. It must be stated, and only when true.
    #[test]
    fn never_pushed_is_called_out_explicitly() {
        let p = Assessment {
            has_upstream: false,
            ..base()
        }
        .prompt();
        assert!(p.contains("NOT PUSHED"), "{p}");
        assert!(p.contains("only on this machine"), "{p}");

        assert!(!base().prompt().contains("NOT PUSHED"));
    }

    /// Uncommitted work is not in the diff against the default branch, so
    /// an agent told only about commits would assess an incomplete
    /// picture.
    #[test]
    fn uncommitted_files_are_mentioned_only_when_present() {
        let dirty = Assessment {
            uncommitted: 3,
            ..base()
        }
        .prompt();
        assert!(dirty.contains("3 uncommitted files"), "{dirty}");
        assert!(!base().prompt().contains("uncommitted"));
    }

    /// A branch with 200 commits must not produce a prompt nobody reads.
    #[test]
    fn the_commit_list_is_capped_and_says_what_it_elided() {
        let p = Assessment {
            subjects: (0..MAX_SUBJECTS).map(|i| format!("commit {i}")).collect(),
            subjects_elided: 190,
            ..base()
        }
        .prompt();
        assert_eq!(p.matches("  - commit").count(), MAX_SUBJECTS);
        assert!(p.contains("and 190 more"), "{p}");
    }

    /// A fact that could not be gathered is omitted, never guessed. "0
    /// commits ahead" when the check failed sends an agent looking for
    /// work that is there.
    #[test]
    fn missing_facts_are_omitted_rather_than_defaulted() {
        let p = Assessment {
            commits_ahead: None,
            files_changed: None,
            last_activity: None,
            ..base()
        }
        .prompt();
        assert!(!p.contains("0 commits ahead"), "{p}");
        assert!(!p.contains("files changed"), "{p}");
        // The questions still get asked -- an agent with fewer facts is
        // still more use than no prompt.
        assert!(p.contains("Recommend one"));
    }

    /// The agent is told not to write. A button labelled "assess" that
    /// pushes branches is a different feature.
    #[test]
    fn the_prompt_forbids_pushing_and_opening_prs() {
        let p = base().prompt();
        assert!(p.contains("Do not push"), "{p}");
        assert!(p.contains("open a pull request"), "{p}");
        assert!(p.contains("let me decide"), "{p}");
    }

    /// Single quoting is what keeps a branch name from executing. Checked
    /// against a real shell separately; this pins the encoding.
    #[test]
    fn shell_metacharacters_are_neutralised() {
        for hostile in ["$HOME", "`whoami`", "x'; echo PWNED; '", "semi;colon"] {
            let q = shell_quote(hostile);
            assert!(q.starts_with('\'') && q.ends_with('\''), "{q}");
            // Every embedded quote is closed-escaped-reopened, so the
            // string cannot terminate early and start a new command.
            let inner = &q[1..q.len() - 1];
            assert!(
                !inner.contains('\'') || inner.contains(r"'\''"),
                "unescaped quote in {q}"
            );
        }
    }

    /// A path with a space must survive the `cd`.
    #[test]
    fn a_path_with_a_space_stays_one_argument() {
        let cmd = Assessment {
            path: "/code/my project".into(),
            ..base()
        }
        .command("claude");
        assert!(cmd.starts_with("cd '/code/my project' &&"), "{cmd}");
    }

    /// shortstat omits a clause entirely when it is zero, so the numbers
    /// must be read independently rather than positionally.
    #[test]
    fn shortstat_parses_partial_lines() {
        assert_eq!(
            parse_shortstat(" 2 files changed, 8 insertions(+)"),
            (Some(2), Some(8), None)
        );
        assert_eq!(
            parse_shortstat(" 1 file changed, 3 deletions(-)"),
            (Some(1), None, Some(3))
        );
        assert_eq!(
            parse_shortstat(" 11 files changed, 240 insertions(+), 18 deletions(-)"),
            (Some(11), Some(240), Some(18))
        );
        assert_eq!(parse_shortstat(""), (None, None, None));
    }
}
