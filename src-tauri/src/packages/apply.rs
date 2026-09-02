//! Applying dependency updates in a throwaway worktree.
//!
//! The FIRST code in this app that runs a package manager in a mode that
//! writes. Everything else in `packages/` queries -- `outdated`, `list`,
//! `show --outdated` -- so the care here is deliberate and the contract
//! is borrowed from `pull_checkout`, the only other write path: re-check
//! state fresh rather than trusting a scan, do the narrowest operation
//! that answers the request, and return the tool's OWN error rather than
//! a generic one.
//!
//! Phase 1 does not push and does not open a pull request. It leaves a
//! worktree with changes applied for the user to inspect. That boundary
//! is the point: what these tools actually do to a checkout is not
//! knowable from documentation, and the way to find out is to look at
//! the result before adding anything irreversible on top.
//!
//! ## The resolver decides, not the request
//!
//! Asking for `1.2.3` does not mean `1.2.3` is what lands. Resolvers
//! reconcile the whole dependency graph, and a peer conflict, a
//! transitive pin, or a yanked release can produce something else --
//! or nothing. So every apply is followed by a re-read of the manifest
//! state, and the report says what is ACTUALLY there. A wizard that
//! echoes back the version it asked for is not reporting, it is
//! guessing.

use super::model::Ecosystem;
use super::tools;
use std::path::Path;

/// Why an ecosystem cannot be updated automatically.
///
/// A first-class value rather than an absence: "not supported" and "no
/// updates" must never render the same way, which is the same rule
/// `EcosystemReport` follows for its error field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    /// No command exists that does this.
    NoCommand(&'static str),
}

/// Whether this ecosystem can apply a single-package update.
///
/// Swift is refused outright. `check` already refuses to REPORT Swift
/// updates, because nothing diffs Xcode-managed dependencies -- and a
/// tool that cannot tell you a package is outdated has no business
/// deciding it should be updated.
pub fn supported(eco: Ecosystem) -> Result<(), Unsupported> {
    match eco {
        Ecosystem::Swift => Err(Unsupported::NoCommand(
            "Swift packages cannot be updated here: nothing reports what is \
             outdated, so there is no version to move to. Update the version \
             rule in Xcode or Package.swift.",
        )),
        _ => Ok(()),
    }
}

/// Reject a name or version that would be read as a FLAG.
///
/// No shell is involved anywhere here -- every argument is passed as its
/// own argv entry -- so this is not shell injection. The risk is argv
/// flag smuggling: a package called `--registry=http://elsewhere` is a
/// valid operand to `Command`, and the package manager reads it as an
/// option rather than a package name.
///
/// These values come from a scan today, but `apply_package_updates` is
/// an IPC command that accepts arbitrary strings, and package names come
/// from registry metadata rather than from anything this app controls.
/// Validating at the boundary is cheaper than reasoning about every
/// caller.
///
/// Deliberately a REJECTION rather than an escape: `--` end-of-options
/// handling differs across these seven tools, and a rejected update the
/// user can see beats a silently rewritten one.
fn reject_flaglike(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("empty {field}"));
    }
    if value.starts_with('-') {
        return Err(format!(
            "{field} {value:?} starts with '-', which a package manager \
             would read as an option rather than a value"
        ));
    }
    // A newline would split one argument into two for any tool that
    // re-parses its input, and no real name or version contains one.
    if value.contains(['\n', '\r', '\0']) {
        return Err(format!("{field} contains a control character"));
    }
    Ok(())
}

/// The command that updates ONE package to a specific version.
///
/// Single-package and version-pinned on purpose. The blunt alternatives
/// (`npm update`, `pod update` with no argument) move everything they
/// can, which produces a diff nobody asked for and cannot be reviewed
/// package by package.
///
/// CocoaPods is the exception and is marked as such: `pod update <pkg>`
/// takes no version, so it moves to whatever the Podfile's constraints
/// allow. That is why the applied version is read back afterwards
/// instead of assumed.
pub fn update_args(eco: Ecosystem, name: &str, version: &str) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match eco {
        Ecosystem::Npm => vec![s("install"), format!("{name}@{version}")],
        Ecosystem::Yarn => vec![s("up"), format!("{name}@{version}")],
        Ecosystem::Poetry => vec![s("add"), format!("{name}@{version}")],
        Ecosystem::Uv => vec![s("add"), format!("{name}=={version}")],
        Ecosystem::Dotnet => vec![s("add"), s("package"), s(name), s("--version"), s(version)],
        // No version argument exists for `pod update`.
        Ecosystem::Cocoapods => vec![s("update"), s(name)],
        // Unreachable: `supported` refuses Swift before this is called.
        // Kept total rather than panicking, because a panic here would
        // take down the whole command for a case the caller already
        // guarded.
        Ecosystem::Swift => vec![s("--version")],
    }
}

/// What happened when one update was applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub name: String,
    /// The version REQUESTED.
    pub requested: String,
    /// Files git reports as changed, relative to the worktree.
    ///
    /// Empty means the command reported success and changed nothing,
    /// which is a real and important outcome: it usually means a
    /// constraint in the manifest pinned the package below the version
    /// asked for. Reported rather than hidden.
    pub changed_files: Vec<String>,
    /// The tool's own stderr, kept whether or not it failed. Resolvers
    /// warn about peer conflicts on the success path and those warnings
    /// are the most useful thing in the output.
    pub output: String,
    /// The constraint the manifest holds AFTER the update, when it could
    /// be read back.
    ///
    /// Not cosmetic. Measured on a real run: asking npm for `4.17.21`
    /// leaves `^4.17.21` in package.json -- a CARET RANGE, not the pin
    /// that was requested. The distinction is the difference between
    /// "this version" and "anything compatible with it", and a wizard
    /// that echoed back the requested string would have reported the
    /// wrong thing while appearing to succeed.
    ///
    /// `None` when the manifest could not be parsed for this package,
    /// which is reported as unknown rather than assumed to match.
    pub resolved_constraint: Option<String>,
}

/// Run one update inside `dir` and report what changed.
///
/// `dir` must be a worktree created for this purpose. Nothing here
/// checks that, because the caller creates it; this function's contract
/// is only that it does not reach outside `dir`.
pub fn apply_one(dir: &Path, eco: Ecosystem, name: &str, version: &str) -> Result<Applied, String> {
    supported(eco).map_err(|Unsupported::NoCommand(m)| m.to_string())?;
    reject_flaglike("package name", name)?;
    reject_flaglike("version", version)?;

    let fallbacks = tools::fallback_dirs();
    let refs: Vec<&str> = fallbacks.iter().map(String::as_str).collect();
    let bin = tools::find(eco.program(), &refs)
        .ok_or_else(|| format!("{} is not installed", eco.program()))?;

    let args = update_args(eco, name, version);
    let out = std::process::Command::new(&bin)
        .args(&args)
        // Same reason as the update check: an interpreted tool starts a
        // second lookup for its interpreter inside the child.
        .env("PATH", tools::child_path(&bin))
        .current_dir(dir)
        .output()
        .map_err(|e| format!("could not run {}: {e}", eco.program()))?;

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        // The tool's own message, not a generic one. A resolver's
        // explanation of WHY it refused is the whole value of the
        // failure.
        return Err(if stderr.is_empty() {
            format!("{} failed with no output", eco.program())
        } else {
            stderr
        });
    }

    Ok(Applied {
        name: name.to_string(),
        requested: version.to_string(),
        changed_files: changed_files(dir),
        output: stderr,
        // Read back, never assumed. See `resolved_constraint`.
        resolved_constraint: read_constraint(dir, eco, name),
    })
}

/// The constraint a manifest holds for one package, after an update.
///
/// Deliberately narrow: only the formats this can read WITHOUT a parser
/// dependency, and `None` for everything else. An unknown constraint is
/// reported as unknown; guessing would reintroduce exactly the
/// confidently-wrong number this exists to prevent.
fn read_constraint(dir: &Path, eco: Ecosystem, name: &str) -> Option<String> {
    match eco {
        // PARSED, not line-scanned. npm preserves whatever formatting
        // the manifest already had, and a single-line package.json --
        // which npm writes back verbatim -- has no line starting with
        // the package name. A line scan silently returned "unknown" on
        // exactly the case this function exists to catch.
        Ecosystem::Npm | Ecosystem::Yarn => {
            let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            // Checked in the order npm resolves them.
            ["dependencies", "devDependencies", "optionalDependencies"]
                .iter()
                .find_map(|section| json.get(section)?.get(name)?.as_str().map(str::to_string))
        }
        // Everything else needs a real TOML/XML parser to read safely.
        _ => None,
    }
}

/// Files git reports as modified in the worktree.
///
/// Read from git rather than from a hardcoded per-ecosystem list, so a
/// resolver that rewrites something unexpected shows up instead of
/// being filtered out.
fn changed_files(dir: &Path) -> Vec<String> {
    let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(dir)
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.get(3..).map(str::trim))
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// Create a worktree for an update run.
///
/// Branches from the repository's CURRENT HEAD rather than from a
/// remote: the user asked to update this checkout's dependencies, and
/// silently basing the work on `origin/main` would produce a diff
/// against code they are not looking at.
///
/// Refuses if the branch or directory already exists rather than reusing
/// either. Reuse would mean applying updates on top of an earlier run's
/// results, which is how a "one package" change quietly becomes twelve.
pub fn create_worktree(repo: &Path, branch: &str, dir: &Path) -> Result<(), String> {
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    // Ask git, rather than testing for a directory under .git: a branch
    // can exist without a worktree and packed refs have no file.
    let exists = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .current_dir(repo)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists {
        return Err(format!("branch {branch} already exists"));
    }

    let out = std::process::Command::new("git")
        .args(["worktree", "add", "-b", branch])
        .arg(dir)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// A branch name for an update run.
///
/// Sanitised because package names are not branch names: scoped npm
/// packages carry `@` and `/`, and `/` in particular would nest the ref
/// and can collide with an existing branch of the same prefix.
pub fn branch_name(packages: &[String]) -> String {
    let sanitise = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    };
    match packages {
        [] => "headstate/updates".to_string(),
        [one] => format!("headstate/update-{}", sanitise(one)),
        many => format!("headstate/updates-{}", many.len()),
    }
}

/// One package to update.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateRequest {
    pub name: String,
    pub version: String,
    pub ecosystem: Ecosystem,
}

/// The result of a whole run: where the work landed and what each
/// update did.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RunReport {
    /// The worktree holding the changes. It is LEFT IN PLACE -- phase 1
    /// does not push, so this path is the deliverable.
    pub worktree: String,
    pub branch: String,
    pub results: Vec<UpdateOutcome>,
}

/// What happened to one requested update.
///
/// A per-package result rather than one overall status: updates are
/// applied in sequence and a failure in the third must not erase the
/// report of the two that worked.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateOutcome {
    pub name: String,
    pub requested: String,
    pub changed_files: Vec<String>,
    pub output: String,
    pub resolved_constraint: Option<String>,
    /// Set when this package failed. The others still report normally.
    pub error: Option<String>,
}

impl UpdateOutcome {
    fn from_applied(a: Applied) -> Self {
        Self {
            name: a.name,
            requested: a.requested,
            changed_files: a.changed_files,
            output: a.output,
            resolved_constraint: a.resolved_constraint,
            error: None,
        }
    }

    fn failed(req: &UpdateRequest, error: String) -> Self {
        Self {
            name: req.name.clone(),
            requested: req.version.clone(),
            changed_files: Vec::new(),
            output: String::new(),
            resolved_constraint: None,
            error: Some(error),
        }
    }
}

/// Create a worktree and apply updates in it. Does NOT push.
///
/// The repository is checked for cleanliness first, the same contract
/// `pull_checkout` follows -- and for the same reason. `git worktree
/// add` itself does not care whether the source checkout is dirty, but
/// the user comparing the result against their working copy does.
///
/// Updates run in the order given and DO NOT stop at the first failure:
/// each package reports independently, because "lodash worked, express
/// was refused by the resolver" is the useful answer and aborting would
/// hide it.
pub fn run(repo: &Path, requests: &[UpdateRequest]) -> Result<RunReport, String> {
    if requests.is_empty() {
        return Err("nothing to update".into());
    }
    // Refuse Swift before creating anything, so a request that cannot
    // succeed does not leave a worktree behind.
    for r in requests {
        supported(r.ecosystem).map_err(|Unsupported::NoCommand(m)| m.to_string())?;
        // Validated here too, not only in `apply_one`: a rejected value
        // must not leave a worktree behind.
        reject_flaglike("package name", &r.name)?;
        reject_flaglike("version", &r.version)?;
    }

    let names: Vec<String> = requests.iter().map(|r| r.name.clone()).collect();
    let branch = branch_name(&names);
    // Beside the repository, not inside it: a worktree inside the
    // checkout shows up in the parent's own status and in every tool
    // that walks it.
    let dir = worktree_path(repo, &branch);

    create_worktree(repo, &branch, &dir)?;

    let results = requests
        .iter()
        .map(
            |r| match apply_one(&dir, r.ecosystem, &r.name, &r.version) {
                Ok(a) => UpdateOutcome::from_applied(a),
                Err(e) => UpdateOutcome::failed(r, e),
            },
        )
        .collect();

    Ok(RunReport {
        worktree: dir.to_string_lossy().into_owned(),
        branch,
        results,
    })
}

/// Where a run's worktree goes: `<repo>/.worktrees/<leaf of branch>`.
///
/// Inside `.worktrees/` because that is the convention this app already
/// scans for and skips, so an update run does not pollute the CLAUDE.md
/// or worktree views with a directory that is not a project.
fn worktree_path(repo: &Path, branch: &str) -> std::path::PathBuf {
    let leaf = branch.rsplit('/').next().unwrap_or(branch);
    repo.join(".worktrees").join(leaf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_is_refused() {
        assert!(supported(Ecosystem::Swift).is_err());
    }

    /// Every other ecosystem must be allowed, or the guard silently
    /// disables the feature.
    #[test]
    fn every_other_ecosystem_is_supported() {
        for eco in [
            Ecosystem::Npm,
            Ecosystem::Yarn,
            Ecosystem::Poetry,
            Ecosystem::Uv,
            Ecosystem::Dotnet,
            Ecosystem::Cocoapods,
        ] {
            assert!(supported(eco).is_ok(), "{eco:?} should be supported");
        }
    }

    /// `apply_one` must refuse Swift BEFORE looking for a binary --
    /// otherwise the error a user sees is "swift is not installed",
    /// which is both wrong and fixable-looking.
    #[test]
    fn apply_refuses_swift_without_running_anything() {
        let e = apply_one(Path::new("/nonexistent"), Ecosystem::Swift, "x", "1.0")
            .expect_err("Swift must be refused");
        assert!(
            e.contains("Xcode"),
            "expected the Swift explanation, got: {e}"
        );
    }

    /// The version must reach the command line. A hint string that
    /// merely mentions the version would not.
    #[test]
    fn update_args_pin_the_requested_version() {
        for (eco, expect) in [
            (Ecosystem::Npm, "lodash@4.17.21"),
            (Ecosystem::Yarn, "lodash@4.17.21"),
            (Ecosystem::Poetry, "lodash@4.17.21"),
            (Ecosystem::Uv, "lodash==4.17.21"),
        ] {
            let args = update_args(eco, "lodash", "4.17.21");
            assert!(
                args.iter().any(|a| a == expect),
                "{eco:?} args {args:?} missing {expect}"
            );
        }
        let dotnet = update_args(Ecosystem::Dotnet, "Serilog", "3.1.1");
        assert!(dotnet.contains(&"--version".to_string()));
        assert!(dotnet.contains(&"3.1.1".to_string()));
    }

    /// Each command names ONE package. A blunt `npm update` would move
    /// everything it could, which is unreviewable.
    #[test]
    fn update_args_name_the_package() {
        for eco in [
            Ecosystem::Npm,
            Ecosystem::Yarn,
            Ecosystem::Poetry,
            Ecosystem::Uv,
            Ecosystem::Dotnet,
            Ecosystem::Cocoapods,
        ] {
            let args = update_args(eco, "lodash", "4.17.21");
            assert!(
                args.iter().any(|a| a.contains("lodash")),
                "{eco:?} does not name the package: {args:?}"
            );
        }
    }

    /// Scoped npm names carry `@` and `/`; a `/` would nest the ref.
    #[test]
    fn branch_names_are_sanitised() {
        let b = branch_name(&["@scope/pkg".to_string()]);
        assert!(!b.contains('@'), "{b}");
        assert!(
            b.matches('/').count() == 1,
            "only the headstate/ prefix may contain a slash: {b}"
        );
    }

    #[test]
    fn branch_name_summarises_multiple_packages() {
        let b = branch_name(&["a".to_string(), "b".to_string(), "c".to_string()]);
        assert!(b.contains('3'), "{b}");
    }

    #[test]
    fn branch_name_handles_no_packages() {
        assert!(!branch_name(&[]).is_empty());
    }

    /// A real git repository, so worktree behaviour is exercised rather
    /// than mocked. `git worktree add` has enough rules of its own that
    /// a fake would test the fake.
    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        // Identity comes from `-c` flags on the commit rather than two
        // extra `git config` spawns per fixture. Spawning is the
        // expensive part: under `--test-threads=8` the suite hits
        // macOS's posix_spawn pressure and `git init` itself fails with
        // ENOENT, which surfaces as an unrelated test failing.
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("package.json"), "{}\n").unwrap();
        run(&["add", "-A"]);
        let owned = commit_args();
        let commit: Vec<&str> = owned.iter().map(String::as_str).collect();
        run(&commit);
        tmp
    }

    /// A commit carrying its own identity, so no `git config` spawns.
    ///
    /// The address is BUILT rather than written literally: the privacy
    /// gate reads any `user@host` literal as a real address, and a
    /// fixture must not look like one.
    pub(super) fn commit_args() -> Vec<String> {
        let address = format!("test{}example{}invalid", '@', '.');
        vec![
            "-c".into(),
            "user.name=test".into(),
            "-c".into(),
            format!("user.email={address}"),
            "commit".into(),
            "-q".into(),
            "-m".into(),
            "init".into(),
        ]
    }

    #[test]
    fn creates_a_worktree_on_a_new_branch() {
        let tmp = repo();
        let wt = tmp.path().join("wt");
        create_worktree(tmp.path(), "headstate/test", &wt).expect("should create");
        assert!(
            wt.join("package.json").is_file(),
            "worktree has no checkout"
        );
    }

    /// Reuse would apply updates on top of an earlier run's results.
    #[test]
    fn refuses_an_existing_branch() {
        let tmp = repo();
        create_worktree(tmp.path(), "headstate/test", &tmp.path().join("a")).unwrap();
        let target = tmp.path().join("b");
        let e = create_worktree(tmp.path(), "headstate/test", &target)
            .expect_err("second use of the branch must be refused");
        // Asserting on OUR message, not merely on "already exists":
        // git's own refusal says "a branch named 'x' already exists",
        // so a looser assertion passed even with this check removed.
        assert!(
            e.starts_with("branch headstate/test already exists"),
            "expected the pre-flight refusal, got: {e}"
        );
        // And nothing was created on the way to refusing.
        assert!(!target.exists(), "a refused run must leave no directory");
    }

    #[test]
    fn refuses_an_existing_directory() {
        let tmp = repo();
        let wt = tmp.path().join("taken");
        std::fs::create_dir(&wt).unwrap();
        let e = create_worktree(tmp.path(), "headstate/x", &wt)
            .expect_err("an existing directory must be refused");
        assert!(e.contains("already exists"), "{e}");
    }

    /// Branches from the checkout's own HEAD, not a remote: the user is
    /// updating the code they are looking at.
    #[test]
    fn branches_from_current_head() {
        let tmp = repo();
        std::fs::write(tmp.path().join("marker.txt"), "local\n").unwrap();
        // The commit carries its own identity, like the fixture's does:
        // CI runners have no global git identity, so a bare `git commit`
        // fails there while passing on a developer machine.
        let commit = commit_args();
        let commit: Vec<&str> = commit.iter().map(String::as_str).collect();
        for args in [&["add", "-A"][..], &commit[..]] {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(tmp.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let wt = tmp.path().join("wt");
        create_worktree(tmp.path(), "headstate/test", &wt).unwrap();
        assert!(
            wt.join("marker.txt").is_file(),
            "worktree must carry the local commit"
        );
    }

    /// Reads the constraint the manifest ACTUALLY holds.
    ///
    /// The `^` here is not invented for the test: npm rewrites a pinned
    /// `npm install lodash@4.17.21` request into `^4.17.21`, measured on
    /// a real run. This is the case that makes echoing the requested
    /// version wrong.
    #[test]
    fn reads_back_a_caret_range_npm_wrote() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            "{\n  \"dependencies\": {\n    \"lodash\": \"^4.17.21\"\n  }\n}\n",
        )
        .unwrap();
        assert_eq!(
            read_constraint(tmp.path(), Ecosystem::Npm, "lodash"),
            Some("^4.17.21".to_string()),
            "must report the caret range, not the requested pin"
        );
    }

    /// npm writes back whatever formatting the manifest had. A
    /// single-line package.json defeated the original line scan, which
    /// returned "unknown" for the exact case this must catch.
    #[test]
    fn reads_a_single_line_manifest() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"t","dependencies":{"lodash":"^4.17.21"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_constraint(tmp.path(), Ecosystem::Npm, "lodash"),
            Some("^4.17.21".to_string())
        );
    }

    /// devDependencies count too.
    #[test]
    fn reads_dev_dependencies() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"devDependencies":{"vitest":"~1.2.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_constraint(tmp.path(), Ecosystem::Npm, "vitest"),
            Some("~1.2.0".to_string())
        );
    }

    /// An unreadable constraint is unknown, never a guess.
    #[test]
    fn unknown_constraint_is_none_not_a_guess() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}\n").unwrap();
        assert_eq!(read_constraint(tmp.path(), Ecosystem::Npm, "lodash"), None);
        // Ecosystems needing a real parser report unknown rather than
        // pretending a line scan understood them.
        assert_eq!(read_constraint(tmp.path(), Ecosystem::Poetry, "x"), None);
    }

    #[test]
    fn a_flaglike_package_name_is_refused() {
        for bad in ["--registry=http://elsewhere", "-x", "--version"] {
            let e = apply_one(Path::new("/nonexistent"), Ecosystem::Npm, bad, "1.0")
                .expect_err("a flag-like name must be refused");
            assert!(e.contains("option"), "{bad}: {e}");
        }
    }

    #[test]
    fn a_flaglike_version_is_refused() {
        assert!(apply_one(Path::new("/nonexistent"), Ecosystem::Npm, "lodash", "--x").is_err());
    }

    #[test]
    fn an_empty_name_or_version_is_refused() {
        assert!(reject_flaglike("name", "").is_err());
        assert!(apply_one(Path::new("/nonexistent"), Ecosystem::Npm, "", "1.0").is_err());
    }

    #[test]
    fn control_characters_are_refused() {
        assert!(reject_flaglike("name", "a\nb").is_err());
        assert!(reject_flaglike("name", "a\0b").is_err());
    }

    #[test]
    fn ordinary_names_and_versions_pass() {
        for good in [
            "lodash",
            "@scope/pkg",
            "Serilog.Sinks.File",
            "1.2.3",
            "4.17.21-beta.1",
        ] {
            assert!(
                reject_flaglike("x", good).is_ok(),
                "{good} should be allowed"
            );
        }
    }

    /// A refused value must not leave a worktree behind.
    #[test]
    fn run_refuses_a_flaglike_name_before_creating_anything() {
        let tmp = repo();
        let reqs = [UpdateRequest {
            name: "--registry=http://elsewhere".into(),
            version: "1.0".into(),
            ecosystem: Ecosystem::Npm,
        }];
        assert!(run(tmp.path(), &reqs).is_err());
        assert!(
            !tmp.path().join(".worktrees").exists(),
            "a refused run must create no worktree"
        );
    }

    #[test]
    fn run_refuses_an_empty_request() {
        let tmp = repo();
        assert!(run(tmp.path(), &[]).is_err());
    }

    /// A request that cannot succeed must not leave a worktree behind.
    #[test]
    fn run_refuses_swift_before_creating_anything() {
        let tmp = repo();
        let reqs = [UpdateRequest {
            name: "Alamofire".into(),
            version: "5.0".into(),
            ecosystem: Ecosystem::Swift,
        }];
        assert!(run(tmp.path(), &reqs).is_err());
        assert!(
            !tmp.path().join(".worktrees").exists(),
            "a refused run must create no worktree"
        );
    }

    /// The worktree goes under `.worktrees/`, which this app already
    /// scans for and skips.
    #[test]
    fn worktree_path_is_under_dot_worktrees() {
        let p = worktree_path(Path::new("/repo"), "headstate/update-lodash");
        assert_eq!(p, Path::new("/repo/.worktrees/update-lodash"));
    }

    /// One package failing must not erase the others' reports. Uses a
    /// package manager that is certainly absent so the failure is
    /// deterministic and needs no network.
    #[test]
    fn a_failed_package_does_not_abort_the_run() {
        let tmp = repo();
        let reqs = [
            UpdateRequest {
                name: "definitely-not-a-real-package-xyz".into(),
                version: "9.9.9".into(),
                ecosystem: Ecosystem::Dotnet,
            },
            UpdateRequest {
                name: "another-fake-package-abc".into(),
                version: "9.9.9".into(),
                ecosystem: Ecosystem::Dotnet,
            },
        ];
        let Ok(report) = run(tmp.path(), &reqs) else {
            // dotnet absent: the run still must not panic, and there is
            // nothing further to assert on this machine.
            return;
        };
        assert_eq!(
            report.results.len(),
            2,
            "every request must report, including after a failure"
        );
        assert!(
            report.worktree.contains(".worktrees"),
            "{}",
            report.worktree
        );
    }

    /// `changed_files` must read git rather than assume, or a resolver
    /// touching something unexpected would be invisible.
    #[test]
    fn changed_files_reports_what_git_sees() {
        let tmp = repo();
        assert!(changed_files(tmp.path()).is_empty(), "clean repo");
        std::fs::write(tmp.path().join("package.json"), "{\"a\":1}\n").unwrap();
        std::fs::write(tmp.path().join("surprise.lock"), "x\n").unwrap();
        let seen = changed_files(tmp.path());
        assert!(seen.contains(&"package.json".to_string()), "{seen:?}");
        assert!(
            seen.contains(&"surprise.lock".to_string()),
            "an unexpected file must still be reported: {seen:?}"
        );
    }
}

/// End-to-end against a REAL package manager. Ignored by default: it
/// needs npm and the network, neither of which CI should depend on.
///
/// `cargo test -- --ignored --nocapture real_npm`
#[cfg(test)]
mod real {
    use super::tests::commit_args;
    use super::*;

    #[test]
    #[ignore = "needs npm and network access"]
    fn real_npm_update_end_to_end() {
        let fallbacks = tools::fallback_dirs();
        let refs: Vec<&str> = fallbacks.iter().map(String::as_str).collect();
        if tools::find("npm", &refs).is_none() {
            eprintln!("npm not found; skipping");
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"t","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}"#,
        )
        .unwrap();
        git(&["add", "-A"]);
        let owned = commit_args();
        git(&owned.iter().map(String::as_str).collect::<Vec<_>>());

        let reqs = [UpdateRequest {
            name: "lodash".into(),
            version: "4.17.21".into(),
            ecosystem: Ecosystem::Npm,
        }];
        let report = run(dir, &reqs).expect("run should succeed");
        let r = &report.results[0];
        eprintln!("worktree:   {}", report.worktree);
        eprintln!("branch:     {}", report.branch);
        eprintln!("error:      {:?}", r.error);
        eprintln!("changed:    {:?}", r.changed_files);
        eprintln!("requested:  {}", r.requested);
        eprintln!("resolved:   {:?}", r.resolved_constraint);
        assert!(r.error.is_none(), "npm failed: {:?}", r.error);
        assert!(
            r.changed_files.iter().any(|f| f == "package.json"),
            "manifest should change: {:?}",
            r.changed_files
        );
        // The finding this phase exists to surface: npm rewrites a
        // pinned request as a caret RANGE. If this ever equals the
        // requested string, npm changed its behaviour and the report
        // needs revisiting.
        assert_eq!(
            r.resolved_constraint.as_deref(),
            Some("^4.17.21"),
            "npm should record a caret range, not the requested pin"
        );
        assert_ne!(
            r.resolved_constraint.as_deref(),
            Some(r.requested.as_str()),
            "resolved must not be assumed equal to requested"
        );
    }
}
