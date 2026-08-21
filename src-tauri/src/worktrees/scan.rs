use super::model::{Repo, Safety, Worktree};
use std::path::Path;
use std::process::Command;

/// Run a git command in a directory, returning stdout on success.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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
            cur.branch = b.to_string();
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
pub fn worktree_safety(wt: &Worktree, default_branch: &str) -> Safety {
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
    if git(dir, &["rev-parse", "--abbrev-ref", "@{u}"]).is_err() {
        return Safety::NeverPushed;
    }

    match git(dir, &["log", "--oneline", "@{u}.."]) {
        Ok(s) => {
            let n = s.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            if n > 0 {
                return Safety::Unpushed(n);
            }
        }
        Err(e) => return Safety::Unknown(e),
    }

    if wt.branch.is_empty() {
        return Safety::Unknown("detached HEAD".into());
    }

    match git(
        dir,
        &["merge-base", "--is-ancestor", "HEAD", default_branch],
    ) {
        Ok(_) => Safety::Safe,
        Err(_) => Safety::Unmerged,
    }
}

/// The repository's default branch, falling back to `main`.
fn default_branch(repo: &Path) -> String {
    git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|s| s.trim().rsplit('/').next().map(str::to_string))
    .filter(|s| !s.is_empty())
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
    repos.sort_by(|a, b| a.name.cmp(&b.name));
    repos
}

/// Classify one repo's worktrees. Called per repo so the UI can fill in
/// results as they arrive rather than waiting for all 37.
pub fn classify_repo(repo_path: &str) -> Vec<Worktree> {
    let dir = Path::new(repo_path);
    let Ok(list) = git(dir, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let branch = default_branch(dir);
    parse_porcelain(&list)
        .into_iter()
        .map(|mut w| {
            w.safety = worktree_safety(&w, &branch);
            w
        })
        .collect()
}

/// Every repo with its worktrees fully classified, in one pass.
///
/// Only the live test uses this: production lists first and classifies
/// per repo, because classifying all 295 worktrees takes ~16s where
/// listing takes ~800ms.
#[cfg(test)]
///
/// One level deep by design: `~/code/enclave/enc-api` is found via
/// `~/code/enclave`. Walking arbitrarily deep would descend into the
/// worktrees themselves and into `node_modules`.
pub fn scan_dirs(dirs: &[String]) -> Vec<Repo> {
    let mut repos = Vec::new();
    for base in dirs {
        collect_inner(Path::new(base), 0, &mut repos, true);
    }
    repos.sort_by(|a, b| a.name.cmp(&b.name));
    repos
}

fn collect_inner(dir: &Path, depth: usize, out: &mut Vec<Repo>, classify: bool) {
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
                    if classify {
                        w.safety = worktree_safety(&w, &branch);
                    }
                    w
                })
                .collect();
            out.push(Repo {
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
            collect_inner(&p, depth + 1, out, classify);
        }
    }
}

#[cfg(test)]
mod tests {
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
                Safety::Unknown(_) => "unknown",
            };
            *counts.entry(k).or_default() += 1;
        }
        println!("SAFETY {counts:?}");

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
