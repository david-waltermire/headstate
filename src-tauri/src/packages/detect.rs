use super::model::Ecosystem;
use std::path::Path;

/// One project within a repository, and what it uses.
///
/// A repository is not one project. Measured on a real machine, one repo
/// held `frontend/package.json`, `backend/pyproject.toml`, and a third
/// service beside them -- and the root-only check found NONE of them,
/// rendering the page as though there were nothing to update.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Project {
    /// Absolute path to the directory holding the manifest.
    pub path: String,
    /// Relative to the repository root, for display. Empty at the root.
    pub label: String,
    pub ecosystems: Vec<Ecosystem>,
}

/// Every project in a repository, root included.
///
/// Bounded in depth and skipping the directories that hold other
/// people's manifests: a `node_modules` tree contains thousands of
/// `package.json` files, none of them this repository's.
pub fn projects(repo: &Path) -> Vec<Project> {
    const MAX_DEPTH: usize = 3;
    const SKIP: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        ".terraform",
        ".venv",
        "venv",
        "dist",
        "build",
        "bin",
        "obj",
        ".worktrees",
    ];

    let mut out = Vec::new();
    let mut stack = vec![(repo.to_path_buf(), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        let ecos = ecosystems(&dir);
        if !ecos.is_empty() {
            let label = dir
                .strip_prefix(repo)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            out.push(Project {
                path: dir.to_string_lossy().to_string(),
                label,
                ecosystems: ecos,
            });
            // A project's own subdirectories are not separate projects
            // for this purpose -- a workspace member is the workspace's
            // business, and the tool reports it from the root.
            continue;
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            stack.push((e.path(), depth + 1));
        }
    }

    // Root first, then alphabetical -- a stable order that does not
    // reshuffle between scans.
    out.sort_by(|a, b| {
        a.label
            .len()
            .cmp(&b.label.len())
            .then(a.label.cmp(&b.label))
    });
    out
}

/// Which ecosystems a repository actually uses.
///
/// Detected from manifests on disk rather than guessed, and a repo can
/// legitimately return several: a Python service with a web frontend has
/// both, and reporting only the first would hide half its dependencies.
pub fn ecosystems(repo: &Path) -> Vec<Ecosystem> {
    let mut out = Vec::new();

    if repo.join("package.json").is_file() {
        // Yarn and npm share `package.json`, so the LOCKFILE decides.
        // Asking the wrong tool produces a confident empty list rather
        // than an error, which is the failure mode this whole module is
        // built to avoid.
        if repo.join("yarn.lock").is_file() {
            out.push(Ecosystem::Yarn);
        } else {
            out.push(Ecosystem::Npm);
        }
    }

    if repo.join("pyproject.toml").is_file() {
        // Same problem again: both tools use `pyproject.toml`. `uv.lock`
        // is uv's; `poetry.lock` is Poetry's. With neither, the
        // `[tool.*]` table is the tiebreak.
        if repo.join("uv.lock").is_file() {
            out.push(Ecosystem::Uv);
        } else if repo.join("poetry.lock").is_file() {
            out.push(Ecosystem::Poetry);
        } else if let Ok(text) = std::fs::read_to_string(repo.join("pyproject.toml")) {
            if text.contains("[tool.uv") {
                out.push(Ecosystem::Uv);
            } else if text.contains("[tool.poetry") {
                out.push(Ecosystem::Poetry);
            }
            // Neither table and no lockfile: a pyproject.toml that
            // belongs to some third tool. Reporting nothing beats
            // running the wrong one.
        }
    }

    if has_project_file(repo) {
        out.push(Ecosystem::Dotnet);
    }

    if repo.join("Podfile").is_file() {
        out.push(Ecosystem::Cocoapods);
    }

    // Terraform, if any lock file exists ANYWHERE in the repo rather
    // than only in this directory. A Terraform repository is commonly
    // many rooted modules -- `modules/*/`, `environments/*/` -- each
    // with its own lock, and matching only the project directory finds
    // nothing on a real one.
    if !crate::packages::terraform::pinned(repo).is_empty() {
        out.push(Ecosystem::Terraform);
    }

    // Swift: a package of its own, or dependencies Xcode manages.
    //
    // The Xcode case is the one that matters for iOS repositories, and
    // its `Package.resolved` is buried inside the project bundle rather
    // than sitting at the root -- which is why a root-only check found
    // nothing on a real iOS repo that plainly uses SPM.
    if repo.join("Package.swift").is_file() || has_xcode_spm(repo) {
        out.push(Ecosystem::Swift);
    }

    out
}

/// Whether Xcode manages Swift packages here.
///
/// `Package.resolved` lives under the `.xcodeproj` or `.xcworkspace`
/// bundle. Its presence is what distinguishes a project WITH
/// dependencies from one without.
fn has_xcode_spm(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        let p = e.path();
        let is_bundle = p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x == "xcodeproj" || x == "xcworkspace");
        is_bundle
            && p.join("project.xcworkspace/xcshareddata/swiftpm/Package.resolved")
                .is_file()
    })
}

/// Whether a .NET project or solution file sits here.
fn has_project_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| {
                ["csproj", "fsproj", "vbproj", "sln"]
                    .iter()
                    .any(|w| x.eq_ignore_ascii_case(w))
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    #[test]
    fn a_repo_with_nothing_uses_nothing() {
        assert!(ecosystems(repo().path()).is_empty());
    }

    /// npm and yarn share `package.json`, so the lockfile decides.
    /// Asking the wrong tool returns a confident EMPTY list rather than
    /// an error, which is the exact failure this module exists to avoid.
    #[test]
    fn the_lockfile_decides_between_npm_and_yarn() {
        let t = repo();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Npm]);

        fs::write(t.path().join("yarn.lock"), "").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Yarn]);
    }

    /// Same problem for Python: both tools own `pyproject.toml`.
    #[test]
    fn the_lockfile_decides_between_poetry_and_uv() {
        let t = repo();
        fs::write(t.path().join("pyproject.toml"), "[project]").unwrap();
        fs::write(t.path().join("poetry.lock"), "").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Poetry]);

        let t2 = repo();
        fs::write(t2.path().join("pyproject.toml"), "[project]").unwrap();
        fs::write(t2.path().join("uv.lock"), "").unwrap();
        assert_eq!(ecosystems(t2.path()), vec![Ecosystem::Uv]);
    }

    /// With no lockfile the `[tool.*]` table is the tiebreak.
    #[test]
    fn the_tool_table_breaks_the_tie_without_a_lockfile() {
        let t = repo();
        fs::write(t.path().join("pyproject.toml"), "[tool.poetry]\nname='x'").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Poetry]);
    }

    /// A `pyproject.toml` belonging to some third tool must report
    /// NOTHING rather than running one of ours against it.
    #[test]
    fn an_unrecognised_pyproject_reports_no_ecosystem() {
        let t = repo();
        fs::write(t.path().join("pyproject.toml"), "[build-system]").unwrap();
        assert!(ecosystems(t.path()).is_empty());
    }

    /// A repo can legitimately use several. Reporting only the first
    /// would hide half its dependencies.
    #[test]
    fn a_polyglot_repo_reports_every_ecosystem() {
        let t = repo();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        fs::write(t.path().join("pyproject.toml"), "[tool.uv]").unwrap();
        fs::write(t.path().join("Api.csproj"), "<Project/>").unwrap();
        let found = ecosystems(t.path());
        assert_eq!(found.len(), 3, "{found:?}");
    }

    /// The reported case: a repository whose projects live one level
    /// down reported NOTHING, because only the root was checked.
    /// Measured on a real repo -- three projects, none found.
    #[test]
    fn nested_projects_are_found() {
        let t = repo();
        for (dir, file, body) in [
            ("frontend", "package.json", "{}"),
            ("backend", "pyproject.toml", "[tool.poetry]"),
            ("service", "pyproject.toml", "[tool.uv]"),
        ] {
            fs::create_dir(t.path().join(dir)).unwrap();
            fs::write(t.path().join(dir).join(file), body).unwrap();
        }

        let found = projects(t.path());
        assert_eq!(found.len(), 3, "{found:?}");
        let labels: Vec<&str> = found.iter().map(|p| p.label.as_str()).collect();
        assert!(labels.contains(&"frontend") && labels.contains(&"backend"));
    }

    /// A project's own subdirectories are not separate projects. A
    /// workspace member is the workspace's business, and the tool
    /// reports it from the root.
    #[test]
    fn a_nested_manifest_under_a_project_is_not_a_second_project() {
        let t = repo();
        fs::write(t.path().join("package.json"), "{}").unwrap();
        fs::create_dir_all(t.path().join("packages/inner")).unwrap();
        fs::write(t.path().join("packages/inner/package.json"), "{}").unwrap();

        let found = projects(t.path());
        assert_eq!(found.len(), 1, "the root subsumes its members: {found:?}");
        assert_eq!(found[0].label, "");
    }

    /// `node_modules` holds thousands of other people's manifests.
    #[test]
    fn dependency_directories_are_never_projects() {
        let t = repo();
        fs::create_dir_all(t.path().join("node_modules/left-pad")).unwrap();
        fs::write(t.path().join("node_modules/left-pad/package.json"), "{}").unwrap();
        assert!(projects(t.path()).is_empty());
    }

    #[test]
    fn cocoapods_is_detected_from_a_podfile() {
        let t = repo();
        fs::write(t.path().join("Podfile"), "platform :ios").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Cocoapods]);
    }

    #[test]
    fn a_swift_package_is_detected() {
        let t = repo();
        fs::write(t.path().join("Package.swift"), "// swift-tools-version:5.9").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Swift]);
    }

    /// Xcode buries `Package.resolved` inside the project bundle, which
    /// is why a root-only check found nothing on a real iOS repository.
    #[test]
    fn xcode_managed_swift_packages_are_detected() {
        let t = repo();
        let deep = t
            .path()
            .join("App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("Package.resolved"), "{}").unwrap();
        assert_eq!(ecosystems(t.path()), vec![Ecosystem::Swift]);
    }

    /// An `.xcodeproj` with NO resolved packages is a project without
    /// dependencies, not a Swift ecosystem to check.
    #[test]
    fn an_xcodeproj_without_resolved_packages_is_not_swift() {
        let t = repo();
        fs::create_dir(t.path().join("App.xcodeproj")).unwrap();
        assert!(ecosystems(t.path()).is_empty());
    }

    #[test]
    fn dotnet_is_detected_from_any_project_or_solution_file() {
        for name in ["A.csproj", "B.fsproj", "C.vbproj", "D.sln", "E.CSPROJ"] {
            let t = repo();
            fs::write(t.path().join(name), "<Project/>").unwrap();
            assert_eq!(ecosystems(t.path()), vec![Ecosystem::Dotnet], "{name}");
        }
    }
}
