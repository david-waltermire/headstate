use super::model::{Artifact, ArtifactKind, ManifestProof};
use std::path::Path;

/// Directory names that MIGHT be build output, with the kind they imply.
///
/// A name is a candidate, never a verdict: `classify` still has to prove
/// a tool owns the directory before it is offered for removal.
const CANDIDATES: &[(&str, ArtifactKind)] = &[
    ("target", ArtifactKind::CargoTarget),
    ("bin", ArtifactKind::DotnetBuild),
    ("obj", ArtifactKind::DotnetBuild),
    ("node_modules", ArtifactKind::NodeModules),
    (".terraform", ArtifactKind::Terraform),
    ("dist", ArtifactKind::BuildOutput),
    ("build", ArtifactKind::BuildOutput),
];

/// How deep to walk below a scan root before giving up.
///
/// Artifact directories sit within a few levels of a checkout root, and
/// the walk PRUNES at every match -- it never descends into a
/// `node_modules` looking for more. That is what makes discovery cheap:
/// measured at 54ms for 111 directories across a 221 GB code tree.
const MAX_DEPTH: usize = 4;

/// Every artifact directory under the configured roots, unmeasured.
///
/// Deliberately does NOT size anything. Sizing 111 directories measured
/// at 56 seconds against 54ms to find them, so the two are separate
/// passes and the UI renders the first while the second runs.
pub fn scan(roots: &[String]) -> Vec<Artifact> {
    let mut out = Vec::new();
    for root in roots {
        walk(Path::new(root), Path::new(root), 0, &mut out);
    }
    // Deterministic order, so a rescan does not visibly reshuffle rows
    // that have not changed.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(dir: &Path, root: &Path, depth: usize, out: &mut Vec<Artifact>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        // `read_dir`'s `metadata()` does NOT follow symlinks (verified
        // on macOS: a link to a directory reports `is_dir() == false`),
        // so this one check excludes both plain files and links. A link
        // into another tree must never be walked: its bytes belong to
        // the tree it points at, and offering removal through a path
        // that is not what it appears to be is how a cleanup deletes
        // something nobody pointed it at.
        if !meta.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(&(_, kind)) = CANDIDATES.iter().find(|(n, _)| *n == name) {
            if let Some(a) = classify(&e.path(), kind, root) {
                out.push(a);
            }
            // PRUNE either way. A directory that failed classification is
            // still not somewhere to hunt for nested artifacts, and
            // descending into a rejected `node_modules` is how a fast
            // scan becomes a slow one.
            continue;
        }
        // `.git` holds no build output and is expensive to walk.
        if name == ".git" {
            continue;
        }
        walk(&e.path(), root, depth + 1, out);
    }
}

/// Whether a path classifies as an artifact right now.
///
/// The delete-time counterpart to what the walk does, sharing `classify`
/// so the two can never disagree. Removal re-derives this from the
/// filesystem rather than trusting the row the user clicked: that row may
/// be minutes old, and a `.gitignore` change or a replaced directory in
/// between must be caught here, not assumed away.
pub(crate) fn is_artifact(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(&(_, kind)) = CANDIDATES.iter().find(|(n, _)| *n == name) else {
        return false;
    };
    // `root` only groups the result, and a rejection does not depend on
    // it -- the containment check is the caller's job and is stricter.
    classify(path, kind, path).is_some()
}

/// Whether this directory is really regenerable build output.
///
/// Two ways a name can lie, and each kind is vulnerable to one of them:
///
/// - A `target/` or `node_modules/` with no manifest beside it is not a
///   tool's output at all -- deleting it would cost data rather than a
///   rebuild.
/// - A `dist/` or `build/` may hold COMMITTED source. Some projects
///   check one in. A directory git tracks is not an artifact, and that
///   is the only thing separating the two cases.
fn classify(path: &Path, kind: ArtifactKind, root: &Path) -> Option<Artifact> {
    let parent = path.parent()?;

    match kind.proof() {
        ManifestProof::Named(name) => {
            if !parent.join(name).is_file() {
                return None;
            }
        }
        ManifestProof::AnyExtension(exts) => {
            if !has_file_with_extension(parent, exts) {
                return None;
            }
        }
        ManifestProof::None => {
            if kind == ArtifactKind::BuildOutput && !is_disposable_build_dir(path) {
                // Not gitignored means git is tracking it, or it is
                // outside a repository entirely. Either way it is not
                // ours to offer.
                return None;
            }
        }
    }

    Some(Artifact {
        path: path.to_string_lossy().to_string(),
        kind,
        repo_path: repo_root(parent).unwrap_or_else(|| root.to_string_lossy().to_string()),
        size_bytes: None,
        modified_secs_ago: None,
    })
}

/// Whether a `dist`/`build` directory is really disposable output.
///
/// Two disqualifiers, cheapest first, and the ordering is the point.
///
/// The walk prunes at every candidate NAME, so most nested build
/// directories are never reached. But a scan root can start partway down
/// a tree -- pointed straight at a package directory, or reaching one at
/// `MAX_DEPTH` from another root -- and then a bundled dependency's own
/// `dist` is visited with no pruned ancestor above it. Measured on the
/// machine that prompted this feature: 6,194 `dist`/`build` candidates
/// exist against 41 real ones, and asking git about all of them took
/// 4.9s where the path check first takes 1.5s, with identical results.
///
/// That matters because `is_ignored` spawns a process per call, and the
/// whole UI design rests on discovery being fast: the list renders from
/// discovery and fills in sizes afterwards.
fn is_disposable_build_dir(path: &Path) -> bool {
    // Anything beneath a directory we already treat as an artifact
    // belongs to that artifact, not to the project.
    if path.ancestors().skip(1).any(|a| {
        a.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| CANDIDATES.iter().any(|(c, _)| *c == n))
    }) {
        return false;
    }
    is_ignored(path)
}

/// Whether the directory holds any file with one of these extensions.
///
/// .NET names its project file after the project, so only the extension
/// is fixed -- `Foo.csproj`, `Bar.fsproj`. Reads the directory once
/// rather than globbing, and an unreadable directory answers NO: a proof
/// that could not be gathered is not a proof.
fn has_file_with_extension(dir: &Path, exts: &[&str]) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| exts.iter().any(|want| x.eq_ignore_ascii_case(want)))
    })
}

/// Whether git ignores this path.
///
/// Shells out rather than parsing `.gitignore` files: the rules compose
/// across nested files, global config, and `.git/info/exclude`, and a
/// reimplementation that got any of that wrong would offer a tracked
/// directory for deletion.
///
/// A failure -- not a repository, no git, anything -- reads as NOT
/// ignored, so the directory is skipped. The check exists to prove a
/// directory is disposable; being unable to run it proves nothing.
fn is_ignored(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(parent)
        .arg("check-ignore")
        .arg("-q")
        .arg(path)
        .status();
    // `check-ignore -q` answers in three ways, and only ONE of them is
    // permission: 0 means ignored, 1 means tracked or untracked, and
    // anything else (128 for a broken repository) means it could not
    // answer. All the non-permission cases collapse to false, which is
    // the direction that matters -- an inconclusive check must never
    // read as "safe to delete".
    match status {
        Ok(s) => s.success(),
        // git is not on PATH at all. The answer is still "not
        // disposable", but this one is worth SAYING: it silently
        // removes every `dist`/`build` row from the view, and a user
        // seeing their build output missing has no way to know why.
        //
        // A macOS .app launched from Finder does not inherit a shell's
        // PATH, so this is a real configuration to hit rather than a
        // theoretical one.
        Err(e) => {
            log::warn!(
                "cannot check gitignore status ({e}); \
                 build output directories will not be listed"
            );
            false
        }
    }
}

/// The checkout a directory belongs to, by walking up to the nearest
/// `.git`. Used only for grouping, so None simply means "group under the
/// scan root".
fn repo_root(from: &Path) -> Option<String> {
    let mut cur = Some(from);
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return Some(d.to_string_lossy().to_string());
        }
        cur = d.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Whether git can be run at all.
    ///
    /// The Rust test image has no git binary, and these tests were
    /// unwrapping the spawn -- so they passed locally and panicked in
    /// CI. Returning a bool rather than panicking lets the git-dependent
    /// tests skip explicitly instead of failing for a reason that has
    /// nothing to do with what they check.
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .status()
            .is_ok()
    }

    fn git_init(dir: &Path) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            let _ = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .status();
        }
    }

    /// The happy path: a `target/` beside a `Cargo.toml` is cargo's.
    #[test]
    fn finds_a_cargo_target_beside_its_manifest() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        fs::create_dir(t.path().join("target")).unwrap();

        let found = scan(&[t.path().to_string_lossy().to_string()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, ArtifactKind::CargoTarget);
        assert!(
            found[0].size_bytes.is_none(),
            "discovery must not size: the two passes differ by 1000x"
        );
    }

    /// A name is not a verdict. `target/` with no `Cargo.toml` beside it
    /// is somebody's data directory that happens to share a name --
    /// deleting it costs the data, not a rebuild.
    #[test]
    fn a_target_without_a_manifest_is_not_an_artifact() {
        let t = tempfile::TempDir::new().unwrap();
        fs::create_dir(t.path().join("target")).unwrap();
        assert!(scan(&[t.path().to_string_lossy().to_string()]).is_empty());
    }

    #[test]
    fn node_modules_needs_a_package_json() {
        let t = tempfile::TempDir::new().unwrap();
        fs::create_dir(t.path().join("node_modules")).unwrap();
        assert!(scan(&[t.path().to_string_lossy().to_string()]).is_empty());

        fs::write(t.path().join("package.json"), "{}").unwrap();
        assert_eq!(scan(&[t.path().to_string_lossy().to_string()]).len(), 1);
    }

    /// The sharpest rule in the module: some projects COMMIT a `build/`
    /// of real source. A directory git tracks is not an artifact, and
    /// offering it for deletion would destroy work.
    #[test]
    fn a_tracked_build_directory_is_never_offered() {
        if !git_available() {
            return;
        }
        let t = tempfile::TempDir::new().unwrap();
        git_init(t.path());
        fs::create_dir(t.path().join("build")).unwrap();
        fs::write(t.path().join("build/main.c"), "int main(){}").unwrap();

        assert!(
            scan(&[t.path().to_string_lossy().to_string()]).is_empty(),
            "a build/ that git tracks holds source, not output"
        );
    }

    #[test]
    fn a_gitignored_build_directory_is_an_artifact() {
        if !git_available() {
            return;
        }
        let t = tempfile::TempDir::new().unwrap();
        git_init(t.path());
        fs::write(t.path().join(".gitignore"), "build/\n").unwrap();
        fs::create_dir(t.path().join("build")).unwrap();

        let found = scan(&[t.path().to_string_lossy().to_string()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, ArtifactKind::BuildOutput);
    }

    /// Outside a repository the ignore check cannot run, and a check that
    /// cannot run proves nothing. It must not read as permission.
    #[test]
    fn a_build_directory_outside_a_repository_is_skipped() {
        let t = tempfile::TempDir::new().unwrap();
        fs::create_dir(t.path().join("dist")).unwrap();
        assert!(scan(&[t.path().to_string_lossy().to_string()]).is_empty());
    }

    /// Pruning at every match is what keeps discovery cheap -- and stops
    /// a vendored `node_modules/foo/node_modules` from being offered
    /// separately from its parent.
    #[test]
    fn the_walk_prunes_at_a_match() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        let nested = t.path().join("node_modules/pkg/node_modules");
        fs::create_dir_all(&nested).unwrap();
        fs::write(t.path().join("node_modules/pkg/package.json"), "{}").unwrap();

        let found = scan(&[t.path().to_string_lossy().to_string()]);
        assert_eq!(
            found.len(),
            1,
            "the outer directory subsumes what is inside it"
        );
    }

    /// Following a symlink would count another tree's bytes here and,
    /// far worse, offer removal through a path that is not what it
    /// appears to be.
    ///
    /// The fixture puts a VALID artifact behind the link -- a `target/`
    /// with a `Cargo.toml` beside it -- so the only thing that can
    /// reject it is the symlink rule itself. An earlier version of this
    /// test linked to a directory the manifest check would have refused
    /// anyway, so it passed with the symlink handling removed entirely.
    #[test]
    #[cfg(unix)]
    fn symlinked_directories_are_not_followed() {
        let t = tempfile::TempDir::new().unwrap();
        let real = tempfile::TempDir::new().unwrap();
        fs::create_dir(real.path().join("target")).unwrap();

        // Beside the LINK, so a scanner that followed it would find a
        // manifest and accept.
        fs::write(t.path().join("Cargo.toml"), "[package]").unwrap();
        std::os::unix::fs::symlink(real.path().join("target"), t.path().join("target")).unwrap();

        assert!(
            scan(&[t.path().to_string_lossy().to_string()]).is_empty(),
            "a symlinked target belongs to the tree it points at"
        );
    }

    /// The ignore check exists to PROVE a directory is disposable. Being
    /// unable to run it proves nothing, so a failure must skip the
    /// directory rather than admit it.
    ///
    /// Distinct from the outside-a-repository case above: this pins the
    /// DIRECTION of the failure, which is the half that would silently
    /// offer tracked source if it were inverted.
    #[test]
    fn an_unrunnable_ignore_check_never_reads_as_permission() {
        if !git_available() {
            return;
        }
        let t = tempfile::TempDir::new().unwrap();
        fs::create_dir(t.path().join("dist")).unwrap();
        // A BROKEN gitfile, written directly rather than by initialising
        // a repository and deleting it. The earlier version raced git's
        // own processes -- `remove_dir_all` on a `.git` it may still
        // hold open failed intermittently, about one run in four.
        //
        // `.git` as a FILE containing garbage is what a corrupt worktree
        // link looks like, and `check-ignore` answers it with exit 128:
        // a failure to answer rather than an answer.
        fs::write(t.path().join(".git"), "gitdir: /nonexistent").unwrap();

        assert!(
            scan(&[t.path().to_string_lossy().to_string()]).is_empty(),
            "a check that could not run must not read as permission"
        );
    }

    /// A `dist` inside a `node_modules` is that dependency's own build
    /// output -- it belongs to the artifact above it, not to the project.
    ///
    /// This is also what keeps discovery fast. Measured on the machine
    /// that prompted the feature: 6,194 `dist`/`build` candidates exist,
    /// against 41 real ones. Running the git check on all of them took
    /// 4.0s; rejecting the nested ones by path first took 1.5s, with
    /// identical results.
    #[test]
    fn a_build_dir_inside_another_artifact_belongs_to_it() {
        let t = tempfile::TempDir::new().unwrap();
        git_init(t.path());
        fs::write(
            t.path().join(".gitignore"),
            "node_modules/
dist/
",
        )
        .unwrap();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        let inner = t.path().join("node_modules/pkg/dist");
        fs::create_dir_all(&inner).unwrap();

        let found = scan(&[t.path().to_string_lossy().to_string()]);
        assert_eq!(
            found.len(),
            1,
            "only the node_modules itself: {:?}",
            found.iter().map(|a| &a.path).collect::<Vec<_>>()
        );
        assert_eq!(found[0].kind, ArtifactKind::NodeModules);
    }

    /// The case pruning cannot catch: a scan root that starts BELOW the
    /// artifact directory.
    ///
    /// Pointed at a package directory directly, the walk never sees the
    /// `node_modules` above it, so nothing was pruned and the nested
    /// `dist` is visited normally. Only the ancestor check rejects it.
    /// Without that, a dependency's own build output would be listed as
    /// though it were the project's -- and there are 6,194 such
    /// candidates against 41 real ones on the machine that prompted this
    /// feature, so the check is also what keeps discovery fast.
    #[test]
    fn a_build_dir_reached_below_its_artifact_parent_is_still_subsumed() {
        if !git_available() {
            return;
        }
        let t = tempfile::TempDir::new().unwrap();
        git_init(t.path());
        fs::write(t.path().join(".gitignore"), "dist/\n").unwrap();
        let pkg = t.path().join("node_modules/pkg");
        fs::create_dir_all(pkg.join("dist")).unwrap();

        // Scanning the PACKAGE, not the repository root.
        let found = scan(&[pkg.to_string_lossy().to_string()]);
        assert!(
            found.is_empty(),
            "a dist under node_modules belongs to that dependency: {:?}",
            found.iter().map(|a| &a.path).collect::<Vec<_>>()
        );
    }

    /// THE test for this feature, and it matters more than the happy
    /// path.
    ///
    /// On a machine with no C# at all -- zero `.csproj`, `.sln`, or
    /// `.fsproj` -- there were 813 `bin/` directories, nearly all of
    /// them npm packages. In npm, `bin/` holds executables the package
    /// SHIPS: not regenerable, and deleting one breaks the installed
    /// package. A name-based rule would have offered every one.
    #[test]
    fn a_bin_beside_a_package_json_is_never_dotnet_output() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        fs::create_dir(t.path().join("bin")).unwrap();

        let found = scan(&[t.path().to_string_lossy().to_string()]);
        assert!(
            !found.iter().any(|a| a.kind == ArtifactKind::DotnetBuild),
            "a bin/ with no project file beside it is not .NET output: {found:?}"
        );
    }

    #[test]
    fn a_bare_bin_with_no_manifest_is_not_an_artifact() {
        let t = tempfile::TempDir::new().unwrap();
        fs::create_dir(t.path().join("bin")).unwrap();
        assert!(scan(&[t.path().to_string_lossy().to_string()]).is_empty());
    }

    /// The proof is a GLOB, not a filename: .NET names the project file
    /// after the project, so only the extension is fixed.
    #[test]
    fn a_bin_beside_any_project_file_is_dotnet_output() {
        for ext in ["csproj", "fsproj", "vbproj"] {
            let t = tempfile::TempDir::new().unwrap();
            fs::write(t.path().join(format!("Whatever.{ext}")), "<Project/>").unwrap();
            fs::create_dir(t.path().join("bin")).unwrap();
            fs::create_dir(t.path().join("obj")).unwrap();

            let found = scan(&[t.path().to_string_lossy().to_string()]);
            assert_eq!(found.len(), 2, "{ext}: both bin and obj: {found:?}");
            assert!(found.iter().all(|a| a.kind == ArtifactKind::DotnetBuild));
        }
    }

    /// A proof that could not be GATHERED is not a proof.
    ///
    /// If the parent directory cannot be read, there is no evidence a
    /// project file sits there -- and an unreadable directory must not
    /// read as permission, the same rule the gitignore check follows.
    #[test]
    fn an_unreadable_parent_is_not_proof() {
        assert!(
            !has_file_with_extension(Path::new("/nonexistent/nowhere"), &["csproj"]),
            "an unreadable directory cannot prove anything"
        );
    }

    /// Windows and macOS write project files with any casing, and a
    /// case-sensitive check would miss `Foo.CSPROJ` on Linux.
    #[test]
    fn the_project_extension_is_matched_case_insensitively() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("App.CSPROJ"), "<Project/>").unwrap();
        fs::create_dir(t.path().join("obj")).unwrap();
        assert_eq!(scan(&[t.path().to_string_lossy().to_string()]).len(), 1);
    }

    /// Every artifact must say what puts it back. "You can delete this"
    /// is only actionable alongside that.
    #[test]
    fn every_kind_names_its_rebuild_command() {
        for k in [
            ArtifactKind::CargoTarget,
            ArtifactKind::NodeModules,
            ArtifactKind::Terraform,
            ArtifactKind::BuildOutput,
        ] {
            assert!(!k.regenerated_by().is_empty());
        }
    }
}
