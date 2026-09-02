use super::model::Ecosystem;
use std::path::Path;

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

    out
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

    #[test]
    fn dotnet_is_detected_from_any_project_or_solution_file() {
        for name in ["A.csproj", "B.fsproj", "C.vbproj", "D.sln", "E.CSPROJ"] {
            let t = repo();
            fs::write(t.path().join(name), "<Project/>").unwrap();
            assert_eq!(ecosystems(t.path()), vec![Ecosystem::Dotnet], "{name}");
        }
    }
}
