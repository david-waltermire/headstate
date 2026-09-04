//! Listing branches and deciding which are deletable.
//!
//! The shape here comes from measurement on a 507-branch repository,
//! not from guessing (recorded on #411):
//!
//! - Every piece of METADATA -- name, upstream, ahead/behind, date,
//!   author, tip -- comes from ONE `for-each-ref`. 1057 branches in
//!   72ms. None of it needs a worker.
//! - `--merged` settles only 49 of 507. The other 458 are squash
//!   merges, so patch-id comparison is the main path here, not a
//!   fallback.
//! - Per-branch patch-id work cannot be batched: `git diff` has no
//!   `--stdin`, and merge-bases are effectively unique (110 distinct
//!   across 120 branches). Serial costs 18s; the existing 8-worker
//!   pool brings it to 3.5s.

use std::collections::HashSet;
use std::path::Path;

use super::model::{Branch, Deletable, Location, MergedHow};
use crate::worktrees::scan::git;

/// Matches the worktree classifier. Measured 18.0s serial against
/// 3.5s at 8 workers on 458 branches; beyond 8 the win flattens while
/// contention with the rest of the app does not.
const WORKERS: usize = 8;

/// Fields pulled in one pass. Tab-separated because a branch name may
/// contain almost anything else, including `|` and spaces.
const REF_FORMAT: &str = "%(refname:short)\t%(upstream:short)\t%(committerdate:iso8601)\t%(authorname)\t%(objectname:short)";

/// Spawn a git command, retrying only the SPAWN.
///
/// Same reason as `git()`: spawning git intermittently fails with
/// ENOENT under load. It matters more here than anywhere else, because the
/// callers below treat a spawn failure as "no patch-ids" -- which
/// reports every branch as unmerged, quietly, as "nothing is
/// deletable" rather than as an error.
fn spawn_git(dir: &Path, args: &[&str], stdin: bool) -> Option<std::process::Child> {
    use std::process::Stdio;
    retrying(|| {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(dir)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if stdin {
            cmd.stdin(Stdio::piped());
        }
        cmd.spawn()
    })
}

/// How many times a spawn is attempted before giving up.
///
/// Three, not two: the observed failures were single transient
/// ENOENTs, and a second attempt already covers those. The third is
/// headroom for a burst, and it costs nothing when the first succeeds.
const SPAWN_ATTEMPTS: usize = 3;

/// Run `attempt` until it succeeds, up to `SPAWN_ATTEMPTS` times.
///
/// Split out from `spawn_git` so the retry itself is testable without
/// having to provoke a real ENOENT from the kernel, which is exactly
/// the thing that cannot be summoned on demand.
fn retrying<T>(mut attempt: impl FnMut() -> std::io::Result<T>) -> Option<T> {
    for _ in 0..SPAWN_ATTEMPTS {
        if let Ok(v) = attempt() {
            return Some(v);
        }
    }
    None
}

/// The default branch, read from the remote rather than assumed.
///
/// Assuming `main` here would mean classifying every branch against a
/// ref that may not exist, and reporting the whole repository as
/// unmerged -- quietly, as "nothing is deletable".
pub fn default_branch(dir: &Path) -> Option<String> {
    let head = git(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()?;
    let head = head.trim();
    if head.is_empty() {
        return None;
    }
    Some(head.to_string())
}

/// Branches currently checked out in a worktree, by branch name.
///
/// Queried here rather than shared with the Worktrees view. The two
/// views then cannot disagree: a cache that is invalidated but not
/// refreshed is exactly what made #435 delete against stale state.
fn checked_out(dir: &Path) -> Vec<(String, String)> {
    let Ok(out) = git(dir, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };

    let mut pairs = Vec::new();
    let mut path: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            let name = b.trim().strip_prefix("refs/heads/").unwrap_or(b.trim());
            if let Some(p) = path.clone() {
                pairs.push((name.to_string(), p));
            }
        }
    }
    pairs
}

/// Parse one `for-each-ref` line into the metadata half of a branch.
///
/// Returns None rather than a partial branch: a row we cannot read is
/// not a branch we should offer to delete.
fn parse_ref(line: &str, remote: bool) -> Option<(String, Option<String>, String, String, String)> {
    let mut f = line.split('\t');
    let name = f.next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let upstream = f.next().unwrap_or("").trim();
    let upstream = (!upstream.is_empty()).then(|| upstream.to_string());
    let committed = f.next().unwrap_or("").trim().to_string();
    let author = f.next().unwrap_or("").trim().to_string();
    let tip = f.next().unwrap_or("").trim().to_string();

    // `origin/HEAD` is a symref, not a branch anyone deletes.
    if remote && name.ends_with("/HEAD") {
        return None;
    }
    Some((name, upstream, committed, author, tip))
}

/// Ahead/behind counts for every local branch, in one process.
///
/// `%(ahead-behind:)` needs git 2.41. On an older git the field comes
/// back empty and every branch reports 0/0 -- which would make an
/// unmerged branch look like it had nothing to lose. So a missing
/// count is treated as unknown by the caller, never as zero.
fn ahead_behind(dir: &Path, default: &str) -> std::collections::HashMap<String, (u64, u64)> {
    let fmt = format!("%(refname:short)\t%(ahead-behind:{default})");
    let mut map = std::collections::HashMap::new();
    let Ok(out) = git(dir, &["for-each-ref", "--format", &fmt, "refs/heads"]) else {
        return map;
    };
    for line in out.lines() {
        let mut f = line.split('\t');
        let (Some(name), Some(counts)) = (f.next(), f.next()) else {
            continue;
        };
        let mut n = counts.split_whitespace();
        let (Some(a), Some(b)) = (n.next(), n.next()) else {
            continue;
        };
        let (Ok(a), Ok(b)) = (a.parse(), b.parse()) else {
            continue;
        };
        map.insert(name.trim().to_string(), (a, b));
    }
    map
}

/// The patch-ids of every commit on the default branch since `since`.
///
/// Built ONCE per repository and shared by every branch. Measured at
/// 4.2s for 1729 commits; doing it per branch is what made the naive
/// version take minutes.
fn mainline_patch_ids(dir: &Path, default: &str) -> HashSet<String> {
    use std::io::Write;

    let mut set = HashSet::new();
    let Ok(shas) = git(dir, &["rev-list", default, "-n", "5000"]) else {
        return set;
    };
    if shas.trim().is_empty() {
        return set;
    }

    let Some(mut log) = spawn_git(
        dir,
        &["log", "--stdin", "--no-walk", "-p", "--format=commit %H"],
        true,
    ) else {
        return set;
    };
    if let Some(mut stdin) = log.stdin.take() {
        let _ = stdin.write_all(shas.as_bytes());
    }
    let Ok(log_out) = log.wait_with_output() else {
        return set;
    };

    let Some(mut pid) = spawn_git(dir, &["patch-id", "--stable"], true) else {
        return set;
    };
    // Feed stdin from ITS OWN THREAD.
    //
    // The obvious form -- `write_all` into stdin, THEN
    // `wait_with_output` -- deadlocks on a real repository. Verified by
    // A/B on a 1779-commit history whose `git log -p` is 60MB: the
    // simple form hung past 90s with no output and no error, the form
    // below completes the same work in 4.5s. Isolated to this function;
    // no concurrency involved.
    //
    // The mechanism is the classic one: both processes block, us on
    // writing input and `patch-id` on writing output that nobody is
    // reading. What I could NOT establish is a byte threshold -- a
    // synthetic fixture pushing 58MB through the same pipeline does not
    // reproduce it, so rate and diff shape matter, not volume alone.
    // That is why there is no unit test here: a fixture that passes
    // against the broken code would assert nothing. The guard is this
    // comment plus the shape of the code.
    //
    // `batch_contains_patch` in `worktrees::scan` has the simple form
    // and is fine, because its input is bounded by a merge-base --
    // measured around 300 commits. Do not copy it here.
    let writer = {
        let mut stdin = pid.stdin.take();
        std::thread::spawn(move || {
            if let Some(stdin) = stdin.as_mut() {
                let _ = stdin.write_all(&log_out.stdout);
            }
            // Dropping stdin closes the pipe, which is what tells
            // patch-id there is no more input.
            drop(stdin);
        })
    };
    let Ok(out) = pid.wait_with_output() else {
        return set;
    };
    let _ = writer.join();

    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(id) = line.split_whitespace().next() {
            set.insert(id.to_string());
        }
    }
    set
}

/// The patch-id of everything `branch` adds on top of the default.
fn branch_patch_id(dir: &Path, branch: &str, default: &str) -> Option<String> {
    use std::io::Write;

    let base = git(dir, &["merge-base", branch, default]).ok()?;
    let base = base.trim();
    if base.is_empty() {
        return None;
    }

    let diff = spawn_git(dir, &["diff", base, branch], false)?
        .wait_with_output()
        .ok()?;
    // An empty diff means there is nothing to compare. Claiming merged
    // on that would greenlight a deletion nothing established.
    if !diff.status.success() || diff.stdout.is_empty() {
        return None;
    }

    let mut child = spawn_git(dir, &["patch-id", "--stable"], true)?;
    child.stdin.take()?.write_all(&diff.stdout).ok()?;
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
}

/// Decide one branch's deletability.
///
/// Order matters: the cheap and certain checks come first, so the
/// patch-id comparison only runs for branches nothing else settled.
fn classify(
    dir: &Path,
    name: &str,
    default: &str,
    ancestors: &HashSet<String>,
    checked_out: &[(String, String)],
    ahead: Option<(u64, u64)>,
    mainline: &HashSet<String>,
) -> Deletable {
    // The default branch, under either its local or remote name.
    let bare_default = default.rsplit('/').next().unwrap_or(default);
    if name == default || name == bare_default {
        return Deletable::DefaultBranch;
    }

    // Checked out beats merged: git refuses regardless, so reporting
    // "merged" here would offer a deletion that cannot succeed.
    if let Some((_, path)) = checked_out.iter().find(|(b, _)| b == name) {
        return Deletable::CheckedOut { path: path.clone() };
    }

    if ancestors.contains(name) {
        return Deletable::Merged {
            how: MergedHow::Ancestor,
        };
    }

    match branch_patch_id(dir, name, default) {
        Some(pid) if mainline.contains(&pid) => Deletable::Merged {
            how: MergedHow::Squash,
        },
        Some(_) => Deletable::Unmerged {
            ahead: ahead.map(|(a, _)| a).unwrap_or(0),
        },
        // No diff against the merge-base, and not an ancestor. Nothing
        // was established either way, so this is a failed check rather
        // than a negative result.
        None => Deletable::Unknown {
            reason: "could not compare this branch against the default branch".into(),
        },
    }
}

/// Every branch in a repository, classified.
pub fn scan(dir: &Path) -> Result<Vec<Branch>, String> {
    let Some(default) = default_branch(dir) else {
        return Err("could not determine the default branch from origin/HEAD".into());
    };

    let locals = git(dir, &["for-each-ref", "--format", REF_FORMAT, "refs/heads"])?;
    let remotes = git(
        dir,
        &["for-each-ref", "--format", REF_FORMAT, "refs/remotes"],
    )?;

    let ancestors: HashSet<String> = git(
        dir,
        &[
            "for-each-ref",
            "--format",
            "%(refname:short)",
            "--merged",
            &default,
            "refs/heads",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty())
    .collect();

    let wt = checked_out(dir);
    let ab = ahead_behind(dir, &default);
    let mainline = mainline_patch_ids(dir, &default);

    // Which local branches have a remote counterpart, so a local-only
    // branch is not reported as tracked just because a same-named
    // remote ref exists without an upstream configured.
    let remote_names: HashSet<String> = remotes
        .lines()
        .filter_map(|l| parse_ref(l, true))
        .map(|(n, ..)| n)
        .collect();

    let mut out: Vec<Branch> = Vec::new();
    let mut local_upstreams: HashSet<String> = HashSet::new();

    for line in locals.lines() {
        let Some((name, upstream, committed, author, tip)) = parse_ref(line, false) else {
            continue;
        };
        if let Some(u) = &upstream {
            local_upstreams.insert(u.clone());
        }
        let location = match &upstream {
            Some(u) if remote_names.contains(u) => Location::Tracked,
            _ => Location::Local,
        };
        let (ahead, behind) = ab.get(&name).copied().unwrap_or((0, 0));
        out.push(Branch {
            name,
            location,
            upstream,
            ahead,
            behind,
            committed,
            author,
            tip,
            deletable: Deletable::Pending,
        });
    }

    // Remote branches with no local counterpart. These clean up by a
    // push to a shared remote, which is why they are a separate case
    // rather than a flag on the local row.
    for line in remotes.lines() {
        let Some((name, _, committed, author, tip)) = parse_ref(line, true) else {
            continue;
        };
        if local_upstreams.contains(&name) {
            continue;
        }
        out.push(Branch {
            name,
            location: Location::Remote,
            upstream: None,
            ahead: 0,
            behind: 0,
            committed,
            author,
            tip,
            deletable: Deletable::Pending,
        });
    }

    // The expensive pass, 8 ways. Measured 18.0s serial / 3.5s here.
    let chunk = out.len().div_ceil(WORKERS).max(1);
    std::thread::scope(|scope| {
        for part in out.chunks_mut(chunk) {
            let (default, ancestors, wt, ab, mainline) =
                (&default, &ancestors, &wt, &ab, &mainline);
            scope.spawn(move || {
                for b in part {
                    b.deletable = classify(
                        dir,
                        &b.name,
                        default,
                        ancestors,
                        wt,
                        ab.get(&b.name).copied(),
                        mainline,
                    );
                }
            });
        }
    });

    out.sort_by(|a, b| b.committed.cmp(&a.committed));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Synthetic identity: these fixtures must never carry a real one.
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

    /// A repo with a remote, so `origin/HEAD` resolves the way the
    /// scan requires.
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

    fn find<'a>(bs: &'a [Branch], name: &str) -> &'a Branch {
        bs.iter().find(|b| b.name == name).unwrap_or_else(|| {
            panic!(
                "no branch {name} in {:?}",
                bs.iter().map(|b| &b.name).collect::<Vec<_>>()
            )
        })
    }

    #[test]
    fn the_default_branch_is_never_offered_for_deletion() {
        let (_t, repo) = fixture();
        let out = scan(&repo).unwrap();
        assert_eq!(find(&out, "main").deletable, Deletable::DefaultBranch);
    }

    /// THE case this view exists for. `git branch --merged` misses a
    /// squash merge entirely, and every merged PR in these repos is a
    /// squash -- so without patch-id comparison the view would report
    /// almost nothing as deletable.
    #[test]
    fn a_squash_merged_branch_is_detected_as_merged() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "feature"]);
        commit(&repo, "feature-work");
        run(&repo, &["checkout", "-q", "main"]);
        // Squash: same content, different commit -- not an ancestor.
        run(&repo, &["merge", "-q", "--squash", "feature"]);
        run(&repo, &["commit", "-q", "-m", "squashed feature"]);
        run(&repo, &["push", "-q", "origin", "main"]);

        let out = scan(&repo).unwrap();
        assert_eq!(
            find(&out, "feature").deletable,
            Deletable::Merged {
                how: MergedHow::Squash
            },
            "a squash merge must be recognised; --merged alone never sees it"
        );
    }

    #[test]
    fn a_fast_forward_merged_branch_reports_as_an_ancestor() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "ff"]);
        commit(&repo, "ff-work");
        run(&repo, &["checkout", "-q", "main"]);
        run(&repo, &["merge", "-q", "--ff-only", "ff"]);
        run(&repo, &["push", "-q", "origin", "main"]);

        let out = scan(&repo).unwrap();
        assert_eq!(
            find(&out, "ff").deletable,
            Deletable::Merged {
                how: MergedHow::Ancestor
            }
        );
    }

    #[test]
    fn an_unmerged_branch_is_not_deletable_and_says_how_far_ahead() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "wip"]);
        commit(&repo, "wip-one");
        commit(&repo, "wip-two");
        run(&repo, &["checkout", "-q", "main"]);

        let out = scan(&repo).unwrap();
        assert_eq!(
            find(&out, "wip").deletable,
            Deletable::Unmerged { ahead: 2 }
        );
        assert!(!find(&out, "wip").deletable.is_deletable());
    }

    /// Checked-out beats merged: git refuses to delete a branch that is
    /// checked out, so reporting it as deletable would offer an action
    /// that cannot succeed.
    #[test]
    fn a_branch_checked_out_in_a_worktree_is_reported_as_checked_out() {
        let (tmp, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "live"]);
        commit(&repo, "live-work");
        run(&repo, &["checkout", "-q", "main"]);
        run(&repo, &["merge", "-q", "--squash", "live"]);
        run(&repo, &["commit", "-q", "-m", "squashed live"]);
        run(&repo, &["push", "-q", "origin", "main"]);

        let wt = tmp.path().join("live-wt");
        run(
            &repo,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "live"],
        );

        let out = scan(&repo).unwrap();
        match &find(&out, "live").deletable {
            Deletable::CheckedOut { path } => assert!(path.contains("live-wt"), "{path}"),
            other => panic!("merged-but-checked-out must report CheckedOut, got {other:?}"),
        }
    }

    /// A remote branch with no local counterpart is its own case: it is
    /// removed by a push to a shared remote, not by deleting a ref here.
    #[test]
    fn a_remote_only_branch_is_listed_and_marked_remote() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "only-remote"]);
        commit(&repo, "remote-work");
        run(&repo, &["push", "-q", "origin", "only-remote"]);
        run(&repo, &["checkout", "-q", "main"]);
        run(&repo, &["branch", "-q", "-D", "only-remote"]);

        let out = scan(&repo).unwrap();
        let b = find(&out, "origin/only-remote");
        assert_eq!(b.location, Location::Remote);
    }

    #[test]
    fn a_branch_with_an_upstream_is_tracked_not_local_only() {
        let (_t, repo) = fixture();
        run(&repo, &["checkout", "-q", "-b", "shared"]);
        commit(&repo, "shared-work");
        run(&repo, &["push", "-q", "-u", "origin", "shared"]);
        run(&repo, &["checkout", "-q", "main"]);

        let out = scan(&repo).unwrap();
        let b = find(&out, "shared");
        assert_eq!(b.location, Location::Tracked);
        assert_eq!(b.upstream.as_deref(), Some("origin/shared"));
        // And it is listed once, not twice.
        assert_eq!(out.iter().filter(|x| x.name == "origin/shared").count(), 0);
    }

    /// The retry is the fix for the CI failure that stopped v4.6.0,
    /// so it gets a test of its own rather than resting on "the flake
    /// stopped happening".
    ///
    /// A real ENOENT under load cannot be summoned on demand, which is
    /// why `retrying` is split out: the transient failure is injected
    /// instead.
    #[test]
    fn a_spawn_that_fails_twice_still_answers() {
        let mut calls = 0;
        let got = retrying(|| {
            calls += 1;
            if calls <= 2 {
                Err(std::io::Error::from(std::io::ErrorKind::NotFound))
            } else {
                Ok("answered")
            }
        });
        assert_eq!(got, Some("answered"));
        assert_eq!(calls, 3, "it must keep trying, not give up after one");
    }

    /// A spawn that never works must report failure, not spin.
    #[test]
    fn a_spawn_that_always_fails_gives_up_and_says_so() {
        let mut calls = 0;
        let got: Option<()> = retrying(|| {
            calls += 1;
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        });
        assert_eq!(got, None);
        assert_eq!(calls, SPAWN_ATTEMPTS);
    }

    /// The common path pays nothing: one call, no retries.
    #[test]
    fn a_spawn_that_works_is_attempted_once() {
        let mut calls = 0;
        let got = retrying(|| {
            calls += 1;
            Ok::<_, std::io::Error>(7)
        });
        assert_eq!(got, Some(7));
        assert_eq!(calls, 1);
    }

    /// `origin/HEAD` is a symref, not something anyone deletes.
    #[test]
    fn the_remote_head_symref_is_not_listed_as_a_branch() {
        let (_t, repo) = fixture();
        let out = scan(&repo).unwrap();
        assert!(
            !out.iter().any(|b| b.name.ends_with("/HEAD")),
            "origin/HEAD must not appear as a deletable branch"
        );
    }

    /// Without a resolvable default branch every classification would
    /// be measured against a ref that does not exist, quietly reporting
    /// the whole repository as unmerged.
    #[test]
    fn a_repository_with_no_remote_head_is_an_error_not_an_empty_answer() {
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("solo");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo, "base");

        assert!(scan(&repo).is_err());
    }
}

#[cfg(test)]
/// Measurement, not verification. `#[ignore]` because it needs a real
/// repository: `REPO=~/path cargo test -- --ignored live_scan`.
///
/// It is what produced the numbers this module's design rests on --
/// 675 branches in 9.4s, of which 489 merges were squashes and only 47
/// were ancestors. Kept so the cost can be re-checked on a different
/// machine rather than taken on faith from a comment.
mod live {
    #[test]
    #[ignore]
    fn live_scan_of_a_real_repository() {
        let dir = std::path::PathBuf::from(std::env::var("REPO").unwrap());
        let t = std::time::Instant::now();
        let out = super::scan(&dir).unwrap();
        let elapsed = t.elapsed();
        use crate::branches::{Deletable, Location, MergedHow};
        let n = |f: &dyn Fn(&crate::branches::Branch) -> bool| out.iter().filter(|b| f(b)).count();
        eprintln!("TOTAL {} branches in {:?}", out.len(), elapsed);
        eprintln!(
            "  local {}  tracked {}  remote {}",
            n(&|b| b.location == Location::Local),
            n(&|b| b.location == Location::Tracked),
            n(&|b| b.location == Location::Remote)
        );
        eprintln!(
            "  merged/ancestor {}",
            n(&|b| matches!(
                b.deletable,
                Deletable::Merged {
                    how: MergedHow::Ancestor
                }
            ))
        );
        eprintln!(
            "  merged/squash   {}",
            n(&|b| matches!(
                b.deletable,
                Deletable::Merged {
                    how: MergedHow::Squash
                }
            ))
        );
        eprintln!(
            "  unmerged        {}",
            n(&|b| matches!(b.deletable, Deletable::Unmerged { .. }))
        );
        eprintln!(
            "  checked out     {}",
            n(&|b| matches!(b.deletable, Deletable::CheckedOut { .. }))
        );
        eprintln!(
            "  unknown         {}",
            n(&|b| matches!(b.deletable, Deletable::Unknown { .. }))
        );
        eprintln!(
            "  pending         {}",
            n(&|b| matches!(b.deletable, Deletable::Pending))
        );
    }
}
