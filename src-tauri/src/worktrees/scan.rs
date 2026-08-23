use super::model::{Repo, Safety, Upstream, Worktree};
use std::path::Path;
use std::process::Command;

/// Run a git command in a directory, returning stdout on success.
/// Git calls are bounded, like the Docker ones.
///
/// Every subcommand here is local-only -- cherry, log, rev-list,
/// rev-parse, worktree list -- so this is not about a network call. The
/// risk is a stalled FILESYSTEM: an unresponsive network mount, a stale
/// index.lock, a disk that stops answering.
///
/// The consequence justified the bound: `output()` blocks forever, and
/// this runs inside spawn_blocking, so a hung call permanently consumes
/// a pool thread. Repeated across a scan that exhausts the pool and
/// wedges every worktree operation until restart, with no in-app
/// recovery. A timeout maps onto the existing `Safety::Unknown` arm,
/// which already treats a git failure as "cannot say", never "safe".
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // A thread that BLOCKS on the child, rather than polling it. Polling
    // was measurably wrong here: a flat 20ms interval took the full scan
    // from 35s to 71s, and even 1ms-with-backoff left it at 48s, because
    // several thousand calls each paid up to an interval of dead time.
    // Blocking costs nothing on the common path and still bounds the
    // pathological one.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let result = child.wait_with_output();
        // The receiver is gone on timeout; that is expected, not an error.
        let _ = tx.send(result);
    });

    match rx.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(out)) => {
            let _ = handle.join();
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        Ok(Err(e)) => Err(e.to_string()),
        // The thread is left running rather than detached-and-killed:
        // `wait_with_output` owns the child, so there is no handle here
        // to kill it with. It exits when git does, and the scan moves on
        // treating this worktree as Unknown -- which is the honest
        // answer for a call that never came back.
        Err(_) => Err(format!(
            "git did not respond within {}s",
            GIT_TIMEOUT.as_secs()
        )),
    }
}

/// `owner/repo` from a git remote URL.
///
/// From the REMOTE, never the directory name. This repository is the
/// proof: its directory is `ghstat` and its repository is
/// `pktstorm/headstate`. Since a match here decides whether GitHub's
/// "merged" verdict is shown against a worktree, a wrong pairing would
/// attach an authoritative-looking answer to the wrong directory.
///
/// Returns None for anything unrecognisable rather than guessing.
pub fn parse_owner_repo(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    // Everything after the host, whichever form the URL takes:
    //   git@host:owner/repo   https://host/owner/repo   ssh://git@host/owner/repo
    let tail = url.rsplit_once(':').map_or(url, |(_, t)| t);
    let mut parts = tail.rsplit('/');
    let repo = parts.next()?;
    let owner = parts.next()?;
    (!owner.is_empty() && !repo.is_empty() && !owner.contains(' ') && !repo.contains(' '))
        .then(|| format!("{owner}/{repo}"))
}

/// The `owner/repo` a checkout belongs to, or None.
pub fn repo_identity(repo_path: &str) -> Option<String> {
    git(Path::new(repo_path), &["remote", "get-url", "origin"])
        .ok()
        .and_then(|u| parse_owner_repo(&u))
}

/// Whether a ref can be passed to git without being read as a flag.
///
/// Git ref names may legitimately begin with `-` -- `git branch` refuses
/// them, but `update-ref` accepts them, so a hostile remote can ship
/// one. Passed as a bare argv element, `--output=/path` makes `git log`
/// write to an arbitrary file, which is an arbitrary file write with the
/// app's privileges.
///
/// Rejected at the two BOUNDARIES where remote-controlled refs enter
/// (`parse_porcelain` and `default_branch`) rather than at each of the
/// ten call sites, because a boundary cannot be forgotten. The `--`
/// separators at the sinks are the second layer, not the only one.
pub(super) fn is_safe_ref(r: &str) -> bool {
    !r.is_empty() && !r.starts_with('-')
}

/// Parse `git worktree list --porcelain`.
///
/// Blank-line-delimited records of `worktree`/`HEAD`/`branch`. A record
/// without a branch is detached HEAD, which is still a real worktree
/// occupying real disk -- so it is kept, with an empty branch, rather
/// than dropped.
pub fn parse_porcelain(out: &str) -> Vec<Worktree> {
    let mut all = Vec::new();
    let mut cur = Worktree::default();

    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if !cur.path.is_empty() {
                all.push(std::mem::take(&mut cur));
            }
            cur.path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            cur.head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            // A flag-shaped ref is dropped rather than carried. The
            // worktree still lists -- it just has no usable branch name,
            // which the classifier already handles as detached.
            if is_safe_ref(b) {
                cur.branch = b.to_string();
            } else {
                log::warn!("ignoring a branch name that reads as a flag: {b:?}");
            }
        }
    }
    if !cur.path.is_empty() {
        all.push(cur);
    }

    // The first record is always the main checkout.
    if let Some(first) = all.first_mut() {
        first.is_main = true;
        first.safety = Safety::MainCheckout;
    }
    all
}

/// Classify a worktree.
///
/// The order is the design: the DANGEROUS conditions are checked before
/// the merely-inconvenient ones, so a worktree that is both unmerged and
/// never-pushed reports the fact that matters. Any git failure yields
/// `Unknown`, never `Safe`.
pub fn worktree_safety(
    wt: &Worktree,
    default_branch: &str,
    has_upstream: bool,
    ahead: Option<u64>,
) -> Safety {
    if wt.is_main {
        return Safety::MainCheckout;
    }
    let dir = Path::new(&wt.path);
    if !dir.is_dir() {
        return Safety::Unknown("directory is missing".into());
    }

    match git(dir, &["status", "--porcelain"]) {
        Ok(s) => {
            let n = s.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            if n > 0 {
                return Safety::Dirty(n);
            }
        }
        Err(e) => return Safety::Unknown(e),
    }

    // No upstream means nothing was ever pushed: these commits exist only
    // here. Checked BEFORE merge status, because a branch name that looks
    // merged tells you nothing about commits that never left the machine.
    //
    // `has_upstream` is passed in rather than re-probed: the caller
    // already asked, and this was one of two identical `rev-parse @{u}`
    // calls per worktree -- 1.58s of pure duplication across a real
    // 145-worktree repo.
    if !has_upstream {
        return Safety::NeverPushed;
    }

    // Ahead-count comes from the caller's `rev-list --left-right`, which
    // computes it as the right-hand column. This used to be a separate
    // `log --oneline @{u}..` -- a second walk for a number already in
    // hand. A None here means git failed, which must stay Unknown rather
    // than becoming a confident zero.
    match ahead {
        Some(0) => {}
        Some(n) => return Safety::Unpushed(n),
        None => return Safety::Unknown("could not count unpushed commits".into()),
    }

    if wt.branch.is_empty() {
        return Safety::Unknown("detached HEAD".into());
    }

    // Ancestry is the cheap answer, but it only sees fast-forward and
    // merge-commit merges. A squash-merge replays the branch as a NEW
    // commit with a new SHA, so the original tip is never an ancestor --
    // and squash is the default on these repos. Measured across every
    // repo on this machine: ancestry alone found 10 of 157 merged
    // worktrees, calling the other 147 unmerged. Those 147 are exactly
    // the ones filling the disk this view exists to reclaim.
    if git(
        dir,
        &["merge-base", "--is-ancestor", "HEAD", default_branch],
    )
    .is_ok()
    {
        return Safety::Safe;
    }
    squash_merged(dir, default_branch)
}

/// Whether every commit on this branch already exists upstream as an
/// equivalent patch.
///
/// `git cherry` compares patch-ids rather than SHAs, marking each commit
/// `+` (not upstream) or `-` (an equivalent patch is upstream) -- which
/// is precisely what a squash-merge produces. All `-` means merged.
///
/// Only reached when the ancestry check has already failed, so this adds
/// one git call per *unmerged-looking* worktree, not per worktree.
///
/// Measured on a real 289-worktree tree: the scan goes from 16.0s to
/// 29.7s while `safe` goes from 6 to 122. That cost buys back 116
/// worktrees the user was previously told not to delete, and it shrinks
/// as they are deleted -- the call only fires for branches ancestry
/// cannot resolve.
/// How a checkout stands against its tracked upstream.
///
/// Uses `@{u}` rather than a hardcoded `origin/main`: repos differ
/// (`master`, `develop`, a fork tracking `upstream`), and guessing the
/// wrong ref reports confident nonsense.
///
/// Reads refs already on disk -- no fetch. The counts are as of the last
/// fetch, which the UI says plainly rather than implying they are live.
fn upstream_state(dir: &Path) -> Upstream {
    // A detached HEAD has no upstream to compare against, and asking
    // anyway yields an error that reads as a failure rather than as the
    // "question does not apply" it actually is.
    match git(dir, &["symbolic-ref", "--quiet", "HEAD"]) {
        Ok(_) => {}
        Err(_) => return Upstream::Detached,
    }

    // A local-only branch is normal, not a failure.
    if git(dir, &["rev-parse", "--abbrev-ref", "@{u}"]).is_err() {
        return Upstream::Untracked;
    }

    // One call for both numbers: left is upstream-only (behind), right is
    // HEAD-only (ahead).
    match git(dir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
        Ok(s) => {
            let mut it = s.split_whitespace();
            let behind = it.next().and_then(|v| v.parse::<u64>().ok());
            let ahead = it.next().and_then(|v| v.parse::<u64>().ok());
            match (ahead, behind) {
                (Some(0), Some(0)) => Upstream::Current,
                (Some(a), Some(0)) => Upstream::Ahead(a),
                (Some(0), Some(b)) => Upstream::Behind(b),
                (Some(a), Some(b)) => Upstream::Diverged(a, b),
                // Unparsable output must not become a confident zero.
                _ => Upstream::Unknown("could not read ahead/behind counts".into()),
            }
        }
        Err(e) => Upstream::Unknown(e),
    }
}

/// Order repos for the sidebar: most worktrees first.
///
/// Sorts by the count the sidebar actually SHOWS, which excludes the
/// main checkout -- every repo has one, and ordering by the raw length
/// would rank rows by a number nobody can see. Ties break by name so the
/// list does not reshuffle between polls.
///
/// The point of this view is finding disks full of stale worktrees, and
/// alphabetical order buries a repo with forty of them under one with
/// one.
fn sort_for_sidebar(repos: &mut [Repo]) {
    repos.sort_by(|a, b| {
        let count = |r: &Repo| r.worktrees.len().saturating_sub(1);
        count(b).cmp(&count(a)).then_with(|| a.name.cmp(&b.name))
    });
}

fn squash_merged(dir: &Path, default_branch: &str) -> Safety {
    match git(dir, &["cherry", default_branch, "HEAD"]) {
        Ok(s) => {
            let mut saw_commit = false;
            for line in s.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                saw_commit = true;
                if line.starts_with('+') {
                    return Safety::Unmerged;
                }
            }
            // No output means no commits relative to the default branch.
            // That is a branch with nothing on it, not a merged one --
            // reporting Safe here would greenlight deleting a worktree
            // whose state we never actually established.
            if saw_commit {
                Safety::Safe
            } else {
                Safety::Unmerged
            }
        }
        // Any git failure yields Unknown, never Safe.
        Err(e) => Safety::Unknown(e),
    }
}

/// The repository's default branch, falling back to `main`.
pub(super) fn default_branch(repo: &Path) -> String {
    git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|s| s.trim().rsplit('/').next().map(str::to_string))
    // Same guard: a hostile `origin/HEAD` yields `--output=EVIL` here.
    .filter(|s| is_safe_ref(s))
    .unwrap_or_else(|| "main".to_string())
}

/// Repos and their worktrees, WITHOUT classifying safety.
///
/// Fast: one `git worktree list` per repo. Classification is four git
/// calls per worktree, which across 295 worktrees takes ~15s -- far too
/// long to block a view on. The UI lists first and classifies after.
pub fn scan_dirs_fast(dirs: &[String]) -> Vec<Repo> {
    let mut repos = Vec::new();
    for base in dirs {
        collect_inner(Path::new(base), 0, &mut repos, false);
    }
    sort_for_sidebar(&mut repos);
    repos
}

/// Bytes on disk for a directory tree.
///
/// Walks rather than shelling out to `du`: one subprocess per worktree
/// across 296 of them is a lot of process churn for a number, and this
/// skips symlinks so a link into another tree is not counted twice.
///
/// Unreadable entries are skipped rather than failing the whole
/// measurement -- a permission error on one file should not turn a real
/// size into "unknown".
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// Sizes for one repo's worktrees, keyed by path.
///
/// A separate pass from classification: ~60ms per worktree, so ~18s
/// across all 296 here. The UI fills these in after the list and the
/// safety states are already on screen.
pub fn size_repo(repo_path: &str) -> Result<Vec<(String, u64)>, String> {
    let dir = Path::new(repo_path);
    // An empty vec on git failure resolved as SUCCESS, so the UI could
    // not tell "this repo has no worktrees" from "we could not look".
    let list = git(dir, &["worktree", "list", "--porcelain"])
        .map_err(|e| format!("could not list worktrees: {e}"))?;
    Ok(parse_porcelain(&list)
        .into_iter()
        .map(|w| {
            let bytes = dir_size(Path::new(&w.path));
            (w.path, bytes)
        })
        .collect())
}

/// When a branch's tip landed in the default branch.
///
/// The first commit on an ancestry path from the tip to the default
/// branch is the one that brought it in. Only meaningful for a merged
/// branch, so callers skip it otherwise -- it is an extra `git log` per
/// worktree, and 283 of the 296 here are not merged.
/// How many worktrees are classified at once.
///
/// Measured, not guessed: 4 workers gave 3.2x and 8 gave 3.7x on a
/// 145-worktree repo, while 12 and 16 regressed. The floor is process
/// spawn -- a bare `git rev-parse` costs ~10ms -- so past a point more
/// threads only add contention.
const CLASSIFY_WORKERS: usize = 8;

/// Classify a worktree and, when merged, date it.
///
/// The single place both scan paths go through: `classify_repo` and
/// `collect_inner` previously each had their own copy, and adding the
/// merge date to one silently left the other behind.
fn classify(w: &mut Worktree, repo: &Path, default_branch: &str) {
    let dir = Path::new(&w.path);

    // Upstream FIRST, so its answers feed the safety check rather than
    // being recomputed there. This removed two duplicated calls per
    // worktree -- a second `rev-parse @{u}` and a `log --oneline @{u}..`
    // whose count `rev-list --left-right` already produces -- worth
    // ~3.1s across a real 145-worktree repo.
    let upstream = upstream_state(dir);
    // Detached counts as NO upstream here. `upstream_state` returns
    // Detached before it ever probes @{u}, so treating only Untracked as
    // "no upstream" made a detached, never-pushed worktree report
    // Unknown instead of NeverPushed -- measured: 7 rows changed verdict
    // and never_pushed fell from 51 to 44.
    let has_upstream = !matches!(upstream, Upstream::Untracked | Upstream::Detached);
    let ahead = match &upstream {
        Upstream::Ahead(n) => Some(*n),
        Upstream::Diverged(a, _) => Some(*a),
        Upstream::Current | Upstream::Behind(_) => Some(0),
        // Detached has no upstream to be ahead of; Untracked is handled
        // by `has_upstream`. Unknown means git failed, and must NOT
        // become a confident zero.
        Upstream::Detached => Some(0),
        Upstream::Untracked => Some(0),
        Upstream::Unknown(_) => None,
    };

    w.safety = worktree_safety(w, default_branch, has_upstream, ahead);
    w.upstream = Some(upstream);
    w.last_commit = git(dir, &["log", "-1", "--format=%cI"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Only for merged branches: an extra git call, and the date is
    // meaningless for anything else. 283 of 296 here are not merged.
    if w.safety.is_safe() {
        w.merged_at = merged_date(repo, &w.head, default_branch);
    }
}

fn merged_date(repo: &Path, head: &str, default_branch: &str) -> Option<String> {
    let range = format!("{head}..{default_branch}");
    let out = git(
        repo,
        &[
            "log",
            "--format=%cs",
            "--ancestry-path",
            "--reverse",
            &range,
        ],
    )
    .ok()?;
    let first = out.lines().next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// Classify one repo's worktrees. Called per repo so the UI can fill in
/// results as they arrive rather than waiting for all 37.
pub fn classify_repo(repo_path: &str) -> Result<Vec<Worktree>, String> {
    let dir = Path::new(repo_path);
    // An empty vec on git failure resolved as SUCCESS, which left rows
    // stuck on "checking..." forever while the header confidently read
    // "0 safe to remove" -- a definite zero for a question we could not
    // ask.
    let list = git(dir, &["worktree", "list", "--porcelain"])
        .map_err(|e| format!("could not list worktrees: {e}"))?;
    let branch = default_branch(dir);
    let mut wts = parse_porcelain(&list);

    // Classified in parallel. git here is I/O-bound, not CPU-bound:
    // measured on a real 145-worktree repo, 28.3s serial -> 8.9s at 4
    // workers -> 7.9s at 8. Twelve and sixteen REGRESS, so the width is
    // pinned rather than taken from the core count.
    //
    // Safe because each verdict is computed purely from that worktree's
    // own state -- the same property `useRemoveWorktree` already relies
    // on when it filters the cache instead of re-classifying. Ordering
    // is preserved by chunking the slice rather than pushing to a shared
    // collection, since a reshuffling sidebar is what `sort_for_sidebar`
    // exists to prevent.
    let chunk = wts.len().div_ceil(CLASSIFY_WORKERS).max(1);
    std::thread::scope(|scope| {
        for part in wts.chunks_mut(chunk) {
            let branch = &branch;
            scope.spawn(move || {
                for w in part {
                    classify(w, dir, branch);
                }
            });
        }
    });
    Ok(wts)
}

/// Every repo with its worktrees fully classified, in one pass.
///
/// Only the live test uses this: production lists first and classifies
/// per repo, because classifying all 295 worktrees takes ~16s where
/// listing takes ~800ms.
#[cfg(test)]
///
/// One level deep by design: `~/code/acme/widget` is found via
/// `~/code/acme`. Walking arbitrarily deep would descend into the
/// worktrees themselves and into `node_modules`.
pub fn scan_dirs(dirs: &[String]) -> Vec<Repo> {
    let mut repos = Vec::new();
    for base in dirs {
        collect_inner(Path::new(base), 0, &mut repos, true);
    }
    sort_for_sidebar(&mut repos);
    repos
}

fn collect_inner(dir: &Path, depth: usize, out: &mut Vec<Repo>, with_safety: bool) {
    if depth > 2 || !dir.is_dir() {
        return;
    }
    // A `.git` DIRECTORY is a real checkout; a `.git` FILE is a worktree
    // pointing back at one. That distinction is load-bearing: worktrees
    // are commonly created as SIBLINGS of the repo, so treating every
    // `.git` as a repo made this scan call `git worktree list` 216 times
    // -- each returning the same 152 entries -- and take over ten minutes
    // instead of seconds. Measured on this machine.
    if dir.join(".git").is_file() {
        return; // a worktree; its own repo will report it
    }
    if dir.join(".git").is_dir() {
        if let Ok(list) = git(dir, &["worktree", "list", "--porcelain"]) {
            let branch = default_branch(dir);
            let worktrees = parse_porcelain(&list)
                .into_iter()
                .map(|mut w| {
                    if with_safety {
                        classify(&mut w, dir, &branch);
                    }
                    w
                })
                .collect();
            out.push(Repo {
                identity: repo_identity(&dir.to_string_lossy()),
                name: dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: dir.to_string_lossy().into_owned(),
                worktrees,
            });
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir()
            && !p
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
        {
            collect_inner(&p, depth + 1, out, with_safety);
        }
    }
}

#[cfg(test)]
mod tests {
    /// Progress must be reported AFTER each removal, so the count means
    /// "done" rather than "started". A bar that reaches 100% while work
    /// is still running is worse than no bar at all.
    ///
    /// Uses paths that do not exist: each removal FAILS, which is
    /// exactly the point -- progress must advance for failures too, or a
    /// batch where several fail appears to stall.
    #[test]
    fn progress_counts_completed_removals_including_failures() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let paths: Vec<String> = (0..3)
            .map(|i| {
                dir.path()
                    .join(format!("nope-{i}"))
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        let seen = std::cell::RefCell::new(Vec::new());
        let outcomes = remove_worktrees_with_progress(&repo, &paths, |done, total| {
            seen.borrow_mut().push((done, total));
        });

        assert_eq!(seen.into_inner(), vec![(1, 3), (2, 3), (3, 3)]);
        assert_eq!(outcomes.len(), 3);
        assert!(
            outcomes.iter().all(|o| o.error.is_some()),
            "these paths do not exist, so every removal should fail"
        );
    }

    /// An empty batch must report nothing rather than a bare (0, 0),
    /// which a UI would render as a stuck progress line.
    #[test]
    fn an_empty_batch_reports_no_progress() {
        let seen = std::cell::RefCell::new(Vec::new());
        let outcomes = remove_worktrees_with_progress("/tmp", &[], |d, t| {
            seen.borrow_mut().push((d, t));
        });
        assert!(seen.into_inner().is_empty());
        assert!(outcomes.is_empty());
    }

    use super::*;

    const SAMPLE: &str = "\
worktree /home/u/code/enc-api
HEAD 3d2216e643c827fb1dfad5c3fa58d9a14421e236
branch refs/heads/main

worktree /home/u/code/enc-api-35b
HEAD 48fa2124c6fd90bc07881e32037db99ce5b194c4
branch refs/heads/chore-remove-dead

worktree /home/u/code/enc-api-detached
HEAD 8ed50a741e1696d1a0c9506f2e033cf2887bb144
";

    #[test]
    fn parses_every_record() {
        let w = parse_porcelain(SAMPLE);
        assert_eq!(w.len(), 3);
        assert_eq!(w[1].path, "/home/u/code/enc-api-35b");
        assert_eq!(w[1].branch, "chore-remove-dead");
        assert_eq!(w[1].head, "48fa2124c6fd90bc07881e32037db99ce5b194c4");
    }

    /// The first record is the repository's own checkout, and deleting it
    /// would destroy the repo rather than a worktree.
    #[test]
    fn the_first_record_is_the_main_checkout_and_is_never_safe() {
        let w = parse_porcelain(SAMPLE);
        assert!(w[0].is_main);
        assert_eq!(w[0].safety, Safety::MainCheckout);
        assert!(!w[0].safety.is_safe());
        assert!(!w[1].is_main);
    }

    /// A detached-HEAD worktree still occupies real disk, so it must be
    /// listed rather than silently dropped for lacking a branch.
    #[test]
    fn keeps_detached_head_worktrees() {
        let w = parse_porcelain(SAMPLE);
        assert_eq!(w[2].branch, "");
        assert_eq!(w[2].head, "8ed50a741e1696d1a0c9506f2e033cf2887bb144");
    }

    #[test]
    fn empty_output_yields_nothing() {
        assert!(parse_porcelain("").is_empty());
    }

    /// Only `Safe` is deletable. Everything else must be disabled in the
    /// UI rather than warned past.
    #[test]
    fn nothing_but_safe_is_deletable() {
        for s in [
            Safety::MainCheckout,
            Safety::Dirty(3),
            Safety::Unpushed(2),
            Safety::NeverPushed,
            Safety::Unmerged,
            Safety::Unknown("x".into()),
        ] {
            assert!(!s.is_safe(), "{s:?} must not be deletable");
        }
        assert!(Safety::Safe.is_safe());
    }

    /// A default-constructed value must never be safe: it is what a bug
    /// is most likely to leave behind.
    #[test]
    fn the_default_safety_is_not_safe() {
        assert!(!Safety::default().is_safe());
        assert!(!Worktree::default().safety.is_safe());
    }

    /// THE regression that made this scan take ten minutes.
    ///
    /// Worktrees are commonly created as SIBLINGS of the repo, each with
    /// a `.git` FILE. Treating every `.git` as a repository meant calling
    /// `git worktree list` once per worktree -- 216 times on this
    /// machine, each returning the same 152 entries.
    #[test]
    fn a_worktree_sibling_is_not_mistaken_for_a_repository() {
        let tmp = tempfile::TempDir::new().unwrap();
        let base = tmp.path();

        // A REAL repository, so `git worktree list` actually succeeds --
        // a synthetic .git directory would fail for both the buggy and
        // the fixed code, making the test pass vacuously.
        let repo = base.join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        // Identity comes from the environment rather than the source:
        // any email-shaped literal trips the privacy guard, which does
        // not special-case test fixtures and should not.
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["commit", "-q", "--allow-empty", "-m", "init"],
        ] {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .envs(ident)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        }

        // A real worktree, created as a SIBLING -- the layout that made
        // the scan quadratic.
        let wt = base.join("proj-feature");
        let ok = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "add", "-q", "-b", "feature"])
            .arg(&wt)
            .envs(ident)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git worktree add failed");
        assert!(
            wt.join(".git").is_file(),
            "a worktree's .git must be a file"
        );

        let found = scan_dirs_fast(&[base.to_string_lossy().into_owned()]);
        let names: Vec<&str> = found.iter().map(|r| r.name.as_str()).collect();
        assert!(
            names.contains(&"proj"),
            "the real repo must be found: {names:?}"
        );
        assert!(
            !names.contains(&"proj-feature"),
            "a worktree must not be listed as its own repository: {names:?}"
        );
    }

    /// A repo whose worktree is merged, pushed and clean -- the only
    /// state in which a merge date exists.
    fn merged_worktree_fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run_in = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(ident)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run_in(&remote, &["init", "-q", "--bare", "-b", "main"]);

        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run_in(&repo, &["init", "-q", "-b", "main"]);
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "one"]);
        run_in(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_in(&repo, &["push", "-q", "-u", "origin", "main"]);

        let wt = tmp.path().join("proj-done");
        run_in(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--track",
                "-b",
                "done",
                wt.to_str().unwrap(),
                "main",
            ],
        );
        run_in(&wt, &["push", "-q", "-u", "origin", "done"]);
        // Advance main so there IS an ancestry path to date.
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "two"]);
        run_in(&repo, &["push", "-q", "origin", "main"]);
        (tmp, repo, wt)
    }

    /// A branch whose work landed on `main` as a SQUASH commit.
    ///
    /// This is the shape the real repos use, and the one ancestry cannot
    /// see: the branch's change is applied to `main` as a brand-new
    /// commit with its own SHA, so the branch tip is not an ancestor of
    /// `main` even though every line of its work is there.
    ///
    /// Real git throughout -- a hand-built fixture would let the check
    /// pass for the wrong reason, which is exactly the failure this test
    /// exists to catch.
    fn squash_merged_fixture(
        squash: bool,
    ) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run_in = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(ident)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run_in(&remote, &["init", "-q", "--bare", "-b", "main"]);

        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run_in(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        run_in(&repo, &["add", "-A"]);
        run_in(&repo, &["commit", "-q", "-m", "base"]);
        run_in(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_in(&repo, &["push", "-q", "-u", "origin", "main"]);

        // The branch does its work in a worktree and pushes it.
        let wt = tmp.path().join("proj-feature");
        run_in(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--track",
                "-b",
                "feature",
                wt.to_str().unwrap(),
                "main",
            ],
        );
        std::fs::write(wt.join("feature.txt"), "the change\n").unwrap();
        run_in(&wt, &["add", "-A"]);
        run_in(&wt, &["commit", "-q", "-m", "add the feature"]);
        run_in(&wt, &["push", "-q", "-u", "origin", "feature"]);

        if squash {
            // What "Squash and merge" does: the same content lands on
            // main as a NEW commit. Note this is NOT a merge commit and
            // NOT a fast-forward -- the branch tip stays unreachable.
            std::fs::write(repo.join("feature.txt"), "the change\n").unwrap();
            run_in(&repo, &["add", "-A"]);
            run_in(&repo, &["commit", "-q", "-m", "add the feature (#1)"]);
        } else {
            // Genuinely unmerged: main moves on without the change.
            std::fs::write(repo.join("other.txt"), "unrelated\n").unwrap();
            run_in(&repo, &["add", "-A"]);
            run_in(&repo, &["commit", "-q", "-m", "something else"]);
        }
        run_in(&repo, &["push", "-q", "origin", "main"]);
        (tmp, repo, wt)
    }

    /// A real repo with one worktree, for the deletion tests.
    ///
    /// Real git throughout: a synthetic fixture would let the gate pass
    /// for the wrong reason, and this is the one place where a vacuous
    /// test could cost someone their work.
    fn repo_with_worktree(
        name: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .envs(ident)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = tmp.path().join(name);
        run(&["worktree", "add", "-q", "-b", name, wt.to_str().unwrap()]);
        (tmp, repo, wt)
    }

    /// A worktree with no upstream is NEVER safe, even when its branch
    /// points at the same commit as the default branch. 52 of 296
    /// worktrees on this machine are in exactly this state.
    #[test]
    fn refuses_a_worktree_that_was_never_pushed() {
        let (_t, repo, wt) = repo_with_worktree("feature");
        let err = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap()).unwrap_err();
        assert!(err.contains("never pushed"), "{err}");
        assert!(wt.is_dir(), "the worktree must still exist");
    }

    /// The other half of the gate: a genuinely safe worktree MUST be
    /// removable, or the feature is a list of things you cannot act on.
    ///
    /// Builds a real remote so the branch has an upstream and is merged,
    /// which is what "safe" actually requires.
    #[test]
    fn removes_a_worktree_that_is_merged_clean_and_pushed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run_in = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(ident)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        // A bare "remote" to push to.
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run_in(&remote, &["init", "-q", "--bare", "-b", "main"]);

        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run_in(&repo, &["init", "-q", "-b", "main"]);
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        run_in(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_in(&repo, &["push", "-q", "-u", "origin", "main"]);

        // A worktree on a branch that IS main: merged by definition.
        let wt = tmp.path().join("proj-done");
        run_in(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--track",
                "-b",
                "done",
                wt.to_str().unwrap(),
                "main",
            ],
        );
        run_in(&wt, &["push", "-q", "-u", "origin", "done"]);

        assert!(wt.is_dir());
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap())
            .expect("a merged, clean, pushed worktree must be removable");
        assert!(!wt.exists(), "the directory must be gone");

        // And git's own bookkeeping must agree, which is why this uses
        // `git worktree remove` rather than deleting the directory.
        let list = git(&repo, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(!list.contains("proj-done"), "git still lists it: {list}");
    }

    /// Both scan paths must classify identically.
    ///
    /// The sidebar exists to find disks full of stale worktrees, so the
    /// repo with the most must come first regardless of name.
    #[test]
    fn repos_sort_by_worktree_count_not_name() {
        let mk = |name: &str, n: usize| Repo {
            identity: None,
            name: name.into(),
            path: format!("/tmp/{name}"),
            worktrees: vec![Worktree::default(); n],
        };
        // "zed" has the most but sorts last alphabetically -- the whole
        // point. "alpha" has the fewest but would sort first by name.
        let mut repos = vec![mk("alpha", 2), mk("zed", 9), mk("mid", 5)];
        sort_for_sidebar(&mut repos);
        let names: Vec<_> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["zed", "mid", "alpha"]);
    }

    /// Equal counts must not reshuffle between polls, or the list is
    /// unreadable.
    #[test]
    fn equal_counts_break_ties_by_name() {
        let mk = |name: &str, n: usize| Repo {
            identity: None,
            name: name.into(),
            path: format!("/tmp/{name}"),
            worktrees: vec![Worktree::default(); n],
        };
        let mut repos = vec![mk("charlie", 4), mk("alpha", 4), mk("bravo", 4)];
        sort_for_sidebar(&mut repos);
        let names: Vec<_> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["alpha", "bravo", "charlie"]);
    }

    /// The sidebar shows the count EXCLUDING the main checkout, so the
    /// sort must use that same number -- ordering rows by a figure nobody
    /// can see produces a list that looks wrong.
    #[test]
    fn sorting_uses_the_count_the_sidebar_displays() {
        let mk = |name: &str, n: usize| Repo {
            identity: None,
            name: name.into(),
            path: format!("/tmp/{name}"),
            worktrees: vec![Worktree::default(); n],
        };
        // A repo with only its main checkout displays 0 and must sort
        // below one displaying 1.
        let mut repos = vec![mk("only-main", 1), mk("has-one", 2)];
        sort_for_sidebar(&mut repos);
        assert_eq!(repos[0].name, "has-one");
        // And a repo with no worktrees at all must not underflow.
        let mut empty = vec![mk("empty", 0), mk("has-one", 2)];
        sort_for_sidebar(&mut empty);
        assert_eq!(empty[0].name, "has-one");
    }

    /// Upstream states, against real git rather than a stubbed helper --
    /// `@{u}` resolution and rev-list's column order are exactly the
    /// parts a hand-built fixture would get wrong.
    fn upstream_fixture(f: impl Fn(&Path, &Path)) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run_in = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(ident)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run_in(&remote, &["init", "-q", "--bare", "-b", "main"]);

        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run_in(&repo, &["init", "-q", "-b", "main"]);
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
        run_in(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_in(&repo, &["push", "-q", "-u", "origin", "main"]);

        f(&repo, &remote);
        (tmp, repo)
    }

    /// A checkout level with its upstream.
    #[test]
    fn a_current_checkout_reports_up_to_date() {
        let (_t, repo) = upstream_fixture(|_, _| {});
        assert_eq!(upstream_state(&repo), Upstream::Current);
    }

    /// Local commits not yet pushed.
    #[test]
    fn local_commits_report_ahead() {
        let (_t, repo) = upstream_fixture(|repo, _| {
            for m in ["a", "b"] {
                Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["commit", "-q", "--allow-empty", "-m", m])
                    .envs([
                        ("GIT_AUTHOR_NAME", "octocat"),
                        ("GIT_COMMITTER_NAME", "octocat"),
                        ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
                        ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
                    ])
                    .output()
                    .unwrap();
            }
        });
        assert_eq!(upstream_state(&repo), Upstream::Ahead(2));
    }

    /// The upstream moved and this checkout did not -- the state that
    /// explains why everything below it is stale.
    ///
    /// Also pins rev-list's column order: `--left-right` puts the
    /// upstream-only count first. Swapping the two would report "3 ahead"
    /// for a checkout that is 3 behind, which is not merely wrong but
    /// inverted.
    #[test]
    fn an_outdated_checkout_reports_behind() {
        let (_t, repo) = upstream_fixture(|repo, remote| {
            let ident = [
                ("GIT_AUTHOR_NAME", "octocat"),
                ("GIT_COMMITTER_NAME", "octocat"),
                ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
                ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
            ];
            // Advance the remote from a second clone, then fetch so the
            // local ref knows about it without moving HEAD.
            let other = repo.parent().unwrap().join("other");
            Command::new("git")
                .args([
                    "clone",
                    "-q",
                    remote.to_str().unwrap(),
                    other.to_str().unwrap(),
                ])
                .output()
                .unwrap();
            for m in ["x", "y", "z"] {
                Command::new("git")
                    .arg("-C")
                    .arg(&other)
                    .args(["commit", "-q", "--allow-empty", "-m", m])
                    .envs(ident)
                    .output()
                    .unwrap();
            }
            Command::new("git")
                .arg("-C")
                .arg(&other)
                .args(["push", "-q", "origin", "main"])
                .output()
                .unwrap();
            Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["fetch", "-q", "origin"])
                .output()
                .unwrap();
        });
        assert_eq!(upstream_state(&repo), Upstream::Behind(3));
    }

    /// The upstream must come from `@{u}`, not a hardcoded `origin/main`.
    ///
    /// Repos differ -- `master`, `develop`, a fork tracking `upstream` --
    /// and every other fixture here happens to use `origin/main`, so
    /// hardcoding it would pass all of them. This one tracks a
    /// differently-named branch on purpose: with `origin/main` hardcoded
    /// the rev-list call fails and this reports Unknown instead of the
    /// real count.
    #[test]
    fn the_upstream_is_the_tracked_branch_not_origin_main() {
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        let run_in = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .envs(ident)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let tmp = tempfile::TempDir::new().unwrap();
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        // Default branch is `develop`, and `main` does not exist at all.
        run_in(&remote, &["init", "-q", "--bare", "-b", "develop"]);

        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        run_in(&repo, &["init", "-q", "-b", "develop"]);
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
        run_in(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_in(&repo, &["push", "-q", "-u", "origin", "develop"]);
        run_in(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]);

        assert_eq!(upstream_state(&repo), Upstream::Ahead(1));
    }

    /// A local-only branch is normal, and distinctly NOT "up to date" --
    /// a bare zero would read as current when nothing was ever compared.
    #[test]
    fn a_branch_with_no_upstream_says_so() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["commit", "-q", "--allow-empty", "-m", "base"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(&args)
                .envs([
                    ("GIT_AUTHOR_NAME", "octocat"),
                    ("GIT_COMMITTER_NAME", "octocat"),
                    ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
                    ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
                ])
                .output()
                .unwrap();
        }
        assert_eq!(upstream_state(dir), Upstream::Untracked);
    }

    /// Detached HEAD has no upstream to compare against. It must report
    /// that, not an error that reads as a failure.
    #[test]
    fn a_detached_head_reports_detached_not_an_error() {
        let (_t, repo) = upstream_fixture(|repo, _| {
            Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["checkout", "-q", "--detach", "HEAD"])
                .output()
                .unwrap();
        });
        assert_eq!(upstream_state(&repo), Upstream::Detached);
    }

    /// The macOS case that motivated canonicalising at all: /var is a
    /// symlink to /private/var, so git reports a path the caller never
    /// typed and a raw string compare fails.
    #[test]
    fn two_spellings_of_one_directory_compare_equal() {
        let tmp = tempfile::TempDir::new().unwrap();
        let real = tmp.path().join("wt");
        std::fs::create_dir_all(&real).unwrap();

        // TempDir on macOS lives under /var, which resolves to
        // /private/var -- so these two differ as strings but name one
        // directory. On Linux they are already identical, which is fine:
        // the assertion is that the KEY matches, not that the inputs did.
        let canon = std::fs::canonicalize(&real).unwrap();
        assert_eq!(canonical_key(&real), canonical_key(&canon));
    }

    /// A path that cannot be canonicalised still yields a comparable key
    /// rather than erroring -- `remove_worktree` needs to look up a target
    /// that may already be gone.
    #[test]
    fn a_missing_path_still_produces_a_key() {
        let missing = Path::new("/definitely/not/here/at/all");
        assert_eq!(canonical_key(missing), missing.to_string_lossy());
    }

    /// Different directories must not collide. Case folding and separator
    /// normalisation make the key looser on Windows, and a key that maps
    /// two real directories together would delete the wrong one.
    #[test]
    fn different_directories_get_different_keys() {
        let tmp = tempfile::TempDir::new().unwrap();
        let a = tmp.path().join("alpha");
        let b = tmp.path().join("beta");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        assert_ne!(canonical_key(&a), canonical_key(&b));
    }

    /// On Windows the key must be case-folded and slash-normalised, since
    /// git reports `C:/code/proj` where canonicalize returns
    /// `\\?\C:\Code\Proj` for the same place. Inert on Unix, where
    /// case and separator are both significant.
    #[test]
    #[cfg(windows)]
    fn windows_keys_ignore_case_and_separator() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("MixedCase");
        std::fs::create_dir_all(&dir).unwrap();

        let key = canonical_key(&dir);
        assert!(!key.contains('\\'), "separators must be normalised: {key}");
        assert!(
            !key.starts_with(r"\\?\"),
            "UNC prefix must be stripped: {key}"
        );
        assert_eq!(key, key.to_lowercase(), "key must be case-folded: {key}");
    }

    /// The override exists so a user who has READ an assessment can act
    /// on it. It must never be the default: without it, an unmerged
    /// worktree is still refused.
    #[test]
    fn the_override_is_required_to_remove_unsafe_work() {
        let (_t, repo, wt) = squash_merged_fixture(false);
        let repo_s = repo.to_str().unwrap();
        let wt_s = wt.to_string_lossy().into_owned();

        assert!(
            remove_worktree(repo_s, &wt_s).is_err(),
            "an unmerged worktree must be refused by default"
        );
        assert!(wt.is_dir());

        assert!(
            remove_worktree_forced(repo_s, &wt_s).is_ok(),
            "the override must permit what the user acknowledged"
        );
        assert!(!wt.is_dir(), "the directory should be gone");
    }

    /// The override permits a known-unsafe SAFETY state. It does not make
    /// git force anything, and it does not bypass the checks that protect
    /// against acting on the wrong directory.
    #[test]
    fn the_override_still_refuses_a_worktree_of_another_repo() {
        let (_t, repo, _wt) = squash_merged_fixture(false);
        let (_t2, other, other_wt) = squash_merged_fixture(false);
        let _ = other;

        let err = remove_worktree_forced(repo.to_str().unwrap(), &other_wt.to_string_lossy())
            .unwrap_err();
        assert!(err.contains("not a worktree"), "{err}");
        assert!(other_wt.is_dir(), "the other repo's worktree must survive");
    }

    /// The main checkout is never removable, override or not.
    #[test]
    fn the_override_never_removes_the_main_checkout() {
        let (_t, repo, _wt) = squash_merged_fixture(false);
        let repo_s = repo.to_str().unwrap();
        let err = remove_worktree_forced(repo_s, repo_s).unwrap_err();
        assert!(err.contains("main checkout"), "{err}");
        assert!(repo.is_dir());
    }

    /// Bulk removal must re-check safety PER worktree, not once for the
    /// batch. A bulk button that evaluates safety once and then deletes
    /// N directories is a different, much more dangerous thing.
    #[test]
    fn bulk_removal_refuses_anything_not_provably_safe() {
        let (_t, repo, wt) = squash_merged_fixture(false);
        let repo_s = repo.to_str().unwrap();

        // The fixture's branch is genuinely unmerged, so a bulk call
        // naming it must refuse rather than delete.
        let outcomes =
            remove_worktrees_with_progress(repo_s, &[wt.to_string_lossy().into_owned()], |_, _| {});
        assert_eq!(outcomes.len(), 1);
        assert!(
            outcomes[0].error.is_some(),
            "an unmerged worktree must not be removed in bulk"
        );
        assert!(wt.is_dir(), "the directory must still exist");
    }

    /// One refusal must not abort the rest: partial failure is the normal
    /// case, since safety is re-checked at delete time and a worktree may
    /// have gone dirty since the scan.
    #[test]
    fn one_refusal_does_not_stop_the_batch() {
        let (_t, repo, wt) = squash_merged_fixture(false);
        let repo_s = repo.to_str().unwrap();

        let outcomes = remove_worktrees_with_progress(
            repo_s,
            &[
                "/nonexistent/path".to_string(),
                wt.to_string_lossy().into_owned(),
            ],
            |_, _| {},
        );
        assert_eq!(outcomes.len(), 2, "every input must get an outcome");
        assert!(outcomes.iter().all(|o| o.error.is_some()));
    }

    /// Every row needs ahead/behind now, not just the main checkout.
    ///
    /// That restriction made sense when a row's only action was Remove:
    /// the safety verdict answered the only question. Claudify (#198)
    /// changed it -- the row now also answers "is there anything worth
    /// keeping in here?", and how much work is in the branch is that
    /// question's evidence.
    #[test]
    fn every_worktree_gets_its_upstream_state() {
        let (_t, repo, _wt) = squash_merged_fixture(false);
        let wts = classify_repo(repo.to_str().unwrap()).unwrap();

        for w in &wts {
            assert!(w.upstream.is_some(), "{} has no upstream state", w.path);
        }
    }

    /// The branch tip's own commit date, which is NOT the merge date.
    /// A branch written in March and merged in August has both, and they
    /// answer different questions.
    #[test]
    fn every_worktree_carries_its_last_commit_date() {
        let (_t, repo, _wt) = squash_merged_fixture(false);
        let wts = classify_repo(repo.to_str().unwrap()).unwrap();

        for w in &wts {
            let d = w
                .last_commit
                .as_ref()
                .unwrap_or_else(|| panic!("{} has no last commit date", w.path));
            // RFC 3339, so the UI can render it relatively.
            assert!(d.starts_with("20"), "not a date: {d}");
            assert!(d.contains('T'), "not RFC 3339: {d}");
        }
    }

    /// Repo identity must come from the REMOTE, never the directory
    /// name. This very repository proves why: the directory is `ghstat`
    /// and the repository is `pktstorm/headstate`. Matching on directory
    /// name would silently pair a pull request with the wrong worktree,
    /// and "GitHub says this merged" is a verdict that authorises
    /// deletion.
    #[test]
    fn repo_identity_comes_from_the_remote_url_not_the_path() {
        for (url, want) in [
            (
                "git@github.com:pktstorm/headstate.git",
                "pktstorm/headstate",
            ),
            (
                "https://github.com/pktstorm/headstate.git",
                "pktstorm/headstate",
            ),
            (
                "https://github.com/pktstorm/headstate",
                "pktstorm/headstate",
            ),
            (
                "ssh://git@github.com/octocat/hello-world.git",
                "octocat/hello-world",
            ),
        ] {
            assert_eq!(parse_owner_repo(url).as_deref(), Some(want), "{url}");
        }
        // Anything unrecognisable yields None rather than a guess: a
        // fuzzy match here pairs a PR with the wrong directory.
        assert_eq!(parse_owner_repo("not a url"), None);
        assert_eq!(parse_owner_repo(""), None);
    }

    /// A ref beginning with `-` is a valid git ref name but reads as a
    /// FLAG when passed as a bare argv element. Verified end to end:
    ///
    ///   git check-ref-format 'refs/heads/--output=/tmp/x'  -> exit 0
    ///   git update-ref       'refs/heads/--output=/tmp/x' HEAD
    ///   worktree list --porcelain -> "branch refs/heads/--output=/tmp/x"
    ///   git log -1 --format=%cr '--output=/tmp/hs-pwn.txt' -> FILE WRITTEN
    ///
    /// Reachable by clicking Claudify on a worktree of a repo you cloned,
    /// with no typing involved. Overwriting a shell rc file or a git hook
    /// escalates to code execution.
    ///
    /// The boundary is the place to stop it: one guard here beats
    /// remembering `--` at ten call sites.
    #[test]
    fn a_branch_that_looks_like_a_flag_is_rejected_at_the_boundary() {
        // Real porcelain has no leading indentation; a raw multi-line
        // string would give every line whitespace that strip_prefix
        // then fails on.
        let porcelain = "worktree /code/proj\nHEAD abc123\nbranch refs/heads/main\n\nworktree /code/proj-evil\nHEAD def456\nbranch refs/heads/--output=/tmp/hs-pwn.txt\n";
        let wts = parse_porcelain(porcelain);

        let evil = wts
            .iter()
            .find(|w| w.path.contains("evil"))
            .expect("the worktree itself must still be listed");
        assert!(
            evil.branch.is_empty(),
            "a flag-shaped branch must not survive as a branch name, got {:?}",
            evil.branch
        );
        // The ordinary branch is untouched.
        assert_eq!(wts[0].branch, "main");
    }

    /// The same guard on the other remote-controlled ref. A hostile
    /// `origin/HEAD` yields `--output=EVIL` after the `rsplit('/')`.
    #[test]
    fn a_flag_shaped_default_branch_falls_back_rather_than_being_used() {
        assert!(!is_safe_ref("--output=/tmp/x"));
        assert!(!is_safe_ref("-f"));
        assert!(!is_safe_ref(""));
        // Ordinary refs, including ones with dashes INSIDE, are fine.
        assert!(is_safe_ref("main"));
        assert!(is_safe_ref("feat/some-branch"));
        assert!(is_safe_ref("release-2.0"));
    }

    /// The bug this fixes. A squash-merged branch is fully merged, but
    /// its tip is not an ancestor of main -- squash replays the work as
    /// a new commit with a new SHA. Ancestry alone therefore reports
    /// Unmerged forever.
    ///
    /// Measured on real repos before this fix: ancestry found 10 of 157
    /// merged worktrees and called the other 147 unmerged. Those 147 are
    /// exactly the ones filling the disk this view exists to reclaim.
    #[test]
    fn a_squash_merged_branch_is_recognised_as_merged() {
        let (_t, repo, _wt) = squash_merged_fixture(true);

        // The premise: ancestry genuinely cannot see this merge. If this
        // assertion ever fails the fixture stopped reproducing the bug,
        // and the test below would pass for the wrong reason.
        let anc = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["merge-base", "--is-ancestor", "feature", "origin/main"])
            .output()
            .unwrap();
        assert!(
            !anc.status.success(),
            "fixture no longer reproduces a squash merge"
        );

        let wts = classify_repo(repo.to_str().unwrap()).unwrap();
        let found = wts
            .iter()
            .find(|w| w.path.contains("proj-feature"))
            .expect("worktree not found");
        assert_eq!(
            found.safety,
            Safety::Safe,
            "a squash-merged branch must be safe to remove"
        );
    }

    /// The other half: the looser check must not start calling genuinely
    /// unmerged work merged. Deleting one of these destroys commits that
    /// exist nowhere else.
    #[test]
    fn a_genuinely_unmerged_branch_is_still_unmerged() {
        let (_t, repo, _wt) = squash_merged_fixture(false);
        let wts = classify_repo(repo.to_str().unwrap()).unwrap();
        let found = wts
            .iter()
            .find(|w| w.path.contains("proj-feature"))
            .expect("worktree not found");
        assert_eq!(found.safety, Safety::Unmerged);
    }

    /// `git cherry` prints nothing for a branch with no commits relative
    /// to the default. That is a branch with nothing on it, not a merged
    /// one -- treating empty output as "merged" would greenlight
    /// deleting a worktree whose state was never established.
    #[test]
    fn an_empty_branch_is_not_reported_merged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let ident = [
            ("GIT_AUTHOR_NAME", "octocat"),
            ("GIT_COMMITTER_NAME", "octocat"),
            ("GIT_AUTHOR_EMAIL", "octocat@invalid"),
            ("GIT_COMMITTER_EMAIL", "octocat@invalid"),
        ];
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["commit", "-q", "--allow-empty", "-m", "base"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(&args)
                .envs(ident)
                .output()
                .unwrap();
        }
        // HEAD == main, so `git cherry main HEAD` emits nothing at all.
        assert_eq!(squash_merged(dir, "main"), Safety::Unmerged);
    }

    /// Any git failure yields Unknown, never Safe -- the invariant the
    /// whole classifier is built on.
    #[test]
    fn a_git_failure_in_the_squash_check_is_unknown_not_safe() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Not a git repo at all, so `git cherry` fails outright.
        match squash_merged(tmp.path(), "main") {
            Safety::Unknown(_) => {}
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// They each had their own copy of the logic, and adding the merge
    /// date to one silently left the other returning None -- which is how
    /// this shipped broken the first time.
    #[test]
    fn both_scan_paths_classify_the_same_way() {
        // A MERGED worktree, so merged_at is actually populated -- with a
        // never-pushed one both paths return None and the comparison
        // proves nothing. Checked: with the drift re-introduced and an
        // unmerged fixture, this test passed vacuously.
        let (_t, repo, wt) = merged_worktree_fixture();
        let _ = &wt;
        let base = repo.parent().unwrap().to_string_lossy().into_owned();

        let via_scan = scan_dirs(std::slice::from_ref(&base));
        let scanned = via_scan
            .iter()
            .find(|r| r.name == "proj")
            .expect("repo not found");
        let via_classify = classify_repo(repo.to_str().unwrap()).unwrap();

        assert_eq!(scanned.worktrees.len(), via_classify.len());
        for (a, b) in scanned.worktrees.iter().zip(via_classify.iter()) {
            assert_eq!(a.safety, b.safety, "safety differs for {}", a.path);
            assert_eq!(
                a.merged_at, b.merged_at,
                "merge date differs for {}",
                a.path
            );
        }
    }

    #[test]
    fn refuses_the_main_checkout() {
        let (_t, repo, _wt) = repo_with_worktree("feature");
        let err = remove_worktree(repo.to_str().unwrap(), repo.to_str().unwrap()).unwrap_err();
        assert!(err.contains("main checkout"), "{err}");
        assert!(repo.is_dir());
    }

    #[test]
    fn refuses_a_path_that_is_not_a_worktree_of_this_repo() {
        let (_t, repo, _wt) = repo_with_worktree("feature");
        let err = remove_worktree(repo.to_str().unwrap(), "/tmp/somewhere-else").unwrap_err();
        assert!(err.contains("not a worktree"), "{err}");
    }

    /// Uncommitted work blocks removal even when everything else passes.
    #[test]
    fn refuses_a_dirty_worktree() {
        let (_t, repo, wt) = repo_with_worktree("feature");
        std::fs::write(wt.join("scratch.txt"), "unsaved work").unwrap();
        let err = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap()).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(wt.join("scratch.txt").exists(), "the file must survive");
    }

    #[test]
    fn reasons_are_display_ready_and_pluralised() {
        assert_eq!(Safety::Dirty(1).reason(), "1 uncommitted file");
        assert_eq!(Safety::Dirty(3).reason(), "3 uncommitted files");
        assert_eq!(Safety::Unpushed(1).reason(), "1 unpushed commit");
        assert!(Safety::NeverPushed.reason().contains("only here"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Scans the real `~/code`. Read-only -- it runs git queries and
    /// deletes nothing. Run manually:
    /// `cargo test --lib live_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_scan_classifies_real_worktrees() {
        let home = std::env::var("HOME").unwrap();
        let base = format!("{home}/code");
        let t = std::time::Instant::now();
        let fast = scan_dirs_fast(std::slice::from_ref(&base));
        println!(
            "FAST listing: {} repos, {} worktrees in {:?}",
            fast.len(),
            fast.iter().map(|r| r.worktrees.len()).sum::<usize>(),
            t.elapsed()
        );

        let t = std::time::Instant::now();
        let repos = scan_dirs(std::slice::from_ref(&base));
        let elapsed = t.elapsed();

        let total: usize = repos.iter().map(|r| r.worktrees.len()).sum();
        println!("REPOS={} WORKTREES={total} in {elapsed:?}", repos.len());

        let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
        for w in repos.iter().flat_map(|r| &r.worktrees) {
            let k = match &w.safety {
                Safety::Safe => "safe",
                Safety::MainCheckout => "main",
                Safety::Dirty(_) => "dirty",
                Safety::Unpushed(_) => "unpushed",
                Safety::NeverPushed => "never_pushed",
                Safety::Unmerged => "unmerged",
                Safety::Pending => "pending",
                Safety::Unknown(_) => "unknown",
            };
            *counts.entry(k).or_default() += 1;
        }
        println!("SAFETY {counts:?}");

        // What the sidebar will show: repos, and removable counts.
        let mut top: Vec<(usize, &str)> = repos
            .iter()
            .map(|r| (r.worktrees.len().saturating_sub(1), r.name.as_str()))
            .collect();
        top.sort_by_key(|a| std::cmp::Reverse(a.0));
        println!("TOP REPOS {:?}", &top[..top.len().min(4)]);

        let safe: Vec<&str> = repos
            .iter()
            .flat_map(|r| &r.worktrees)
            .filter(|w| w.safety.is_safe())
            .map(|w| w.path.rsplit('/').next().unwrap_or(""))
            .take(4)
            .collect();
        println!("SAFE SAMPLE {safe:?}");

        // Merge dates on the safe ones, and sizes for one repo.
        let dated: Vec<(&str, &str)> = repos
            .iter()
            .flat_map(|r| &r.worktrees)
            .filter(|w| w.safety.is_safe())
            .filter_map(|w| {
                w.merged_at
                    .as_deref()
                    .map(|d| (w.path.rsplit('/').next().unwrap_or(""), d))
            })
            .take(4)
            .collect();
        println!("MERGED DATES {dated:?}");

        if let Some(r) = repos.iter().max_by_key(|r| r.worktrees.len()) {
            let t = std::time::Instant::now();
            let sizes = size_repo(&r.path).unwrap();
            let total: u64 = sizes.iter().map(|(_, b)| b).sum();
            println!(
                "SIZED {} worktrees of {} in {:?}, total {:.1} GB",
                sizes.len(),
                r.name,
                t.elapsed(),
                total as f64 / 1024.0 / 1024.0 / 1024.0
            );
            assert!(sizes.iter().any(|(_, b)| *b > 0), "sizes must be populated");
        }

        assert!(!repos.is_empty(), "expected repos under ~/code");
        // The main checkout of every repo must be classified as such --
        // deleting one would destroy the repository.
        for r in &repos {
            assert!(
                r.worktrees.first().is_some_and(|w| w.is_main),
                "{} has no main checkout",
                r.name
            );
        }
    }
}

/// Remove a worktree, refusing anything not provably safe.
///
/// The commit a worktree's HEAD currently points at.
///
/// Used to expire an assessment: a branch that has moved since it was
/// assessed is no longer the thing that was assessed.
pub fn head_oid(worktree_path: &str) -> Result<String, String> {
    git(Path::new(worktree_path), &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

/// One worktree's outcome in a bulk removal.
///
/// Every input gets an outcome. Partial failure is the normal case here,
/// not the exception: safety is re-checked at delete time, so a worktree
/// that went dirty since the scan is refused mid-batch, and a single
/// verdict would hide that.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RemovalOutcome {
    pub path: String,
    pub error: Option<String>,
}

/// Remove several worktrees, reporting each independently.
///
/// Deliberately a loop over `remove_worktree` rather than a bulk git
/// call: that keeps the per-worktree safety gate exactly as it is. A
/// bulk path that evaluated safety once and then deleted N directories
/// would be a different and much more dangerous thing than N safe
/// deletions.
///
/// Sequential rather than concurrent. `git worktree remove` mutates the
/// repository's administrative files, so parallel removals in one repo
/// contend on the same lock -- and at a few hundred milliseconds each
/// the wall-clock saving would not repay the risk of interleaved writes.
/// Remove worktrees, reporting after each one.
///
/// Removal is sequential at a few hundred milliseconds each, so ~100
/// worktrees is around 30 seconds behind a single boolean "busy" flag.
/// `on_progress` is called with (done, total) after every removal so the
/// UI can say "Removed 34 of 106" instead of spinning silently.
///
/// A CALLBACK rather than emitting Tauri events here: this module is
/// pure git plumbing and has no AppHandle, which is also what keeps it
/// testable without a running app.
pub fn remove_worktrees_with_progress(
    repo_path: &str,
    worktree_paths: &[String],
    mut on_progress: impl FnMut(usize, usize),
) -> Vec<RemovalOutcome> {
    let total = worktree_paths.len();
    worktree_paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let outcome = RemovalOutcome {
                path: p.clone(),
                error: remove_worktree(repo_path, p).err(),
            };
            // AFTER the removal, so the count means "done", not
            // "started" -- a progress bar that reaches 100% before the
            // work finishes is worse than none.
            on_progress(i + 1, total);
            outcome
        })
        .collect()
}

/// A path reduced to something two spellings of the same location share.
///
/// Three platform differences all land on this one comparison, and it
/// decides which directory `remove_worktree` deletes:
///
/// - macOS resolves `/var` to `/private/var`, so a raw string compare
///   fails for anything under a temp directory.
/// - Windows `canonicalize` returns a UNC extended-length path
///   (`\\?\C:\...`) while git reports `C:/...`, so canonicalising only
///   one side guarantees a mismatch.
/// - Windows paths are case-insensitive and git may report either
///   separator, so `C:\Code\Proj` and `c:/code/proj` are the same place.
///
/// Canonicalising both sides handles the first two; the UNC prefix is
/// stripped and the result lowercased on Windows for the third. A path
/// that cannot be canonicalised falls back to its raw form rather than
/// erroring, so a missing target stays comparable.
fn canonical_key(p: &Path) -> String {
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = resolved.to_string_lossy().into_owned();

    if cfg!(windows) {
        // Strip the extended-length prefix git never uses, normalise the
        // separator, and fold case -- Windows filesystems are
        // case-insensitive, so differing case is the same directory.
        s.trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_lowercase()
    } else {
        s
    }
}

/// **The only destructive operation Headstate performs on local disk.**
/// It deletes files that may be the only copy of work, so the bar is
/// higher than for the GitHub mutations: the safety gate is RE-EVALUATED
/// here rather than trusted from the scan. A scan is a snapshot, and the
/// user may have started editing in the seconds since -- 24 of 296
/// worktrees on this machine are dirty at any moment.
///
/// Uses `git worktree remove`, never `rm -rf`: git updates its own
/// administrative files, where a raw delete leaves a stale entry making
/// the repo report a worktree that no longer exists.
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    remove_inner(repo_path, worktree_path, false)
}

/// Remove a worktree the safety gate would refuse.
///
/// The ONLY caller is a confirmation the user reached by reading an
/// assessment of that specific worktree. It exists because the app's
/// verdict and a considered human judgement can legitimately differ:
/// `never_pushed` means "these commits exist only here", which is a
/// reason to think hard, not a reason the user may never decide.
///
/// It relaxes exactly one check -- the safety gate. Everything else
/// holds: the target must still be a worktree of THIS repository, the
/// main checkout is still refused, and git is still asked without
/// `--force`, so a genuinely stuck worktree still fails rather than
/// being torn out.
pub fn remove_worktree_forced(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    remove_inner(repo_path, worktree_path, true)
}

fn remove_inner(repo_path: &str, worktree_path: &str, allow_unsafe: bool) -> Result<(), String> {
    let repo = Path::new(repo_path);
    let target = Path::new(worktree_path);

    let list = git(repo, &["worktree", "list", "--porcelain"])
        .map_err(|e| format!("could not list worktrees: {e}"))?;
    let known = parse_porcelain(&list);

    // Compare CANONICAL paths. Git reports what it resolved, which may
    // differ from what the caller holds when any component is a symlink
    // -- on macOS /var is a link to /private/var, so a naive string
    // compare fails for anything under a temp directory. Falling back to
    // the raw path keeps a non-existent target comparable rather than
    // erroring here.
    let target_canon = canonical_key(target);
    let wt = known
        .iter()
        .find(|w| canonical_key(Path::new(&w.path)) == target_canon)
        .ok_or_else(|| "not a worktree of this repository".to_string())?;

    if wt.is_main {
        return Err("refusing to remove the repository's main checkout".into());
    }

    // Re-check RIGHT NOW, not from the scan. Skipped only when the caller
    // came through `remove_worktree_forced`, which means a human read an
    // assessment of this specific worktree and decided anyway.
    if !allow_unsafe {
        let branch = default_branch(repo);
        // Probed FRESH here, never reused from the scan: this is the
        // delete-time gate, and its whole point is that the scan is a
        // snapshot the world may have moved past.
        let up = upstream_state(Path::new(&wt.path));
        let has_upstream = !matches!(up, Upstream::Untracked);
        let ahead = match &up {
            Upstream::Ahead(n) => Some(*n),
            Upstream::Diverged(a, _) => Some(*a),
            Upstream::Unknown(_) => None,
            _ => Some(0),
        };
        let safety = worktree_safety(wt, &branch, has_upstream, ahead);
        if !safety.is_safe() {
            return Err(format!("not safe to remove: {}", safety.reason()));
        }
    } else {
        log::warn!("removing {worktree_path} past the safety gate, by explicit confirmation");
    }

    // No `--force`. The gate above already established the tree is clean,
    // so needing force here would mean the gate was wrong -- and forcing
    // past it is precisely how unpushed work is lost.
    // git's OWN resolved path, with a separator: the caller's raw string
    // could be relative or flag-shaped, and the gate above already
    // matched this record.
    git(repo, &["worktree", "remove", "--", &wt.path])
        .map(|_| ())
        .map_err(|e| format!("git refused: {e}"))
}
