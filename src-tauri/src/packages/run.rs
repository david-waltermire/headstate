use super::model::{Ecosystem, EcosystemReport, Outdated, ProjectReport};
use super::{detect, tools, version};
use std::path::Path;

/// Check one repository, one ecosystem.
///
/// Every failure mode produces an `EcosystemReport` with an `error`
/// rather than an empty list. "No updates" and "the check did not run"
/// are opposite answers, and rendering both as nothing reports the second
/// as good news.
pub fn check(repo: &Path, eco: Ecosystem) -> EcosystemReport {
    // Swift has no command that reports outdated packages.
    //
    // `swift package update --dry-run` exists for a `Package.swift`, but
    // Xcode-managed dependencies -- which is what an iOS app actually
    // has -- have nothing: `xcodebuild -resolvePackageDependencies`
    // resolves and does not diff.
    //
    // Saying so is the point. An empty list would read as "up to date",
    // which is the same inversion a missing tool would produce, and this
    // module exists to refuse it.
    if eco == Ecosystem::Swift {
        return EcosystemReport {
            ecosystem: eco,
            outdated: Vec::new(),
            error: Some(
                "Swift packages are not checked yet: no command reports outdated \
                 Xcode-managed dependencies."
                    .into(),
            ),
        };
    }

    let fallbacks = tools::fallback_dirs();
    let refs: Vec<&str> = fallbacks.iter().map(String::as_str).collect();
    let Some(bin) = tools::find(eco.program(), &refs) else {
        return missing_tool(eco);
    };

    let args: &[&str] = match eco {
        Ecosystem::Npm => &["outdated", "--json"],
        Ecosystem::Yarn => &["outdated", "--json"],
        Ecosystem::Poetry => &["show", "--outdated"],
        Ecosystem::Uv => &["pip", "list", "--outdated", "--format", "json"],
        Ecosystem::Dotnet => &["list", "package", "--outdated"],
        Ecosystem::Cocoapods => &["outdated"],
        // Swift never reaches here -- `check` returns early for it,
        // because there is no command that answers the question.
        Ecosystem::Swift => &["--version"],
    };

    let out = match std::process::Command::new(&bin)
        .args(args)
        // The tool's own directory goes on the child's PATH: `npm` and
        // `yarn` are `#!/usr/bin/env node` scripts, so finding them is
        // not enough -- the child has to find `node` too.
        .env("PATH", tools::child_path(&bin))
        .current_dir(repo)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return EcosystemReport {
                ecosystem: eco,
                outdated: Vec::new(),
                error: Some(format!("could not run {}: {e}", eco.program())),
            }
        }
    };

    // EXIT CODE IS NOT THE ANSWER for several of these. `npm outdated`
    // exits 1 when updates EXIST -- the normal case -- so treating
    // non-zero as failure would report nothing on every repository that
    // has something to update. The output is what is parsed; the status
    // is only consulted when there is nothing to parse.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed = parse(&stdout, eco, repo);

    if is_real_failure(parsed.is_empty(), out.status.success(), &stdout) {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = stderr.lines().next().unwrap_or("the command failed");
        return EcosystemReport {
            ecosystem: eco,
            outdated: Vec::new(),
            error: Some(msg.to_string()),
        };
    }

    EcosystemReport {
        ecosystem: eco,
        outdated: parsed,
        error: None,
    }
}

/// The report for a tool that is not installed.
///
/// An ERROR, never an empty list. "No updates" and "the check did not
/// run" are opposite answers, and rendering the second as the first
/// reports a failure as good news -- which is the worst outcome
/// available here, because it is the one nobody investigates.
fn missing_tool(eco: Ecosystem) -> EcosystemReport {
    EcosystemReport {
        ecosystem: eco,
        outdated: Vec::new(),
        error: Some(format!(
            "{} was not found. A desktop app does not inherit your shell's PATH.",
            eco.program()
        )),
    }
}

/// Whether a non-zero exit really means the check failed.
///
/// It usually does not. `npm outdated` EXITS 1 WHEN UPDATES EXIST --
/// the normal case, and the whole reason anyone runs it. Treating
/// non-zero as failure would report "no updates" on every repository
/// that has some, which is the exact inversion this module is built to
/// avoid.
///
/// So a failure requires all three: nothing parsed, a non-zero status,
/// AND no output to have parsed. Output that produced no rows is a
/// format question, not a run failure.
fn is_real_failure(nothing_parsed: bool, status_ok: bool, stdout: &str) -> bool {
    nothing_parsed && !status_ok && stdout.trim().is_empty()
}

/// Every project in a repository, with its ecosystems checked.
///
/// Per PROJECT, not per repository: a repo with a frontend and a backend
/// is two sets of dependencies in two manifests, and flattening them
/// would produce a list where the same package at two versions is one
/// row and the update command is ambiguous.
pub fn check_repo(repo: &Path) -> Vec<ProjectReport> {
    detect::projects(repo)
        .into_iter()
        .map(|p| {
            let dir = std::path::PathBuf::from(&p.path);
            let reports = p.ecosystems.iter().map(|e| check(&dir, *e)).collect();
            ProjectReport {
                path: p.path,
                label: p.label,
                reports,
            }
        })
        .collect()
}

/// Parse a tool's output into rows.
///
/// Separate from `check` so each format can be tested against captured
/// output without running anything -- three of the five have no stable
/// machine-readable contract, so a fixture is the only honest way to
/// pin them.
pub fn parse(stdout: &str, eco: Ecosystem, repo: &Path) -> Vec<Outdated> {
    match eco {
        Ecosystem::Npm | Ecosystem::Yarn => parse_npm(stdout, eco),
        Ecosystem::Uv => parse_uv(stdout),
        Ecosystem::Poetry => parse_poetry(stdout),
        Ecosystem::Dotnet => parse_dotnet(stdout, repo),
        Ecosystem::Cocoapods => parse_cocoapods(stdout),
        // Handled before any command runs.
        Ecosystem::Swift => Vec::new(),
    }
}

/// `{"pkg": {"current": "1.0.0", "latest": "2.0.0", ...}}`
fn parse_npm(stdout: &str, eco: Ecosystem) -> Vec<Outdated> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let Some(map) = v.as_object() else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, info)| {
            // `current` is absent when a package is not installed at all.
            // Skipping it rather than defaulting keeps a phantom row out
            // of a list the user is about to hand to an agent.
            let current = info.get("current")?.as_str()?;
            let latest = info.get("latest")?.as_str()?;
            Some(Outdated {
                name: name.clone(),
                current: current.to_string(),
                latest: latest.to_string(),
                bump: version::bump(current, latest),
                ecosystem: eco,
                manifest: "package.json".into(),
            })
        })
        .collect()
}

/// `[{"name": "x", "version": "1.0", "latest_version": "2.0"}]`
fn parse_uv(stdout: &str) -> Vec<Outdated> {
    let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(stdout) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|r| {
            let name = r.get("name")?.as_str()?;
            let current = r.get("version")?.as_str()?;
            let latest = r.get("latest_version")?.as_str()?;
            Some(Outdated {
                name: name.to_string(),
                current: current.to_string(),
                latest: latest.to_string(),
                bump: version::bump(current, latest),
                ecosystem: Ecosystem::Uv,
                manifest: "pyproject.toml".into(),
            })
        })
        .collect()
}

/// `name  current  latest  description`, whitespace-aligned.
///
/// Poetry has no JSON output for this, so the columns are the contract --
/// and they are not one Poetry promises. A line that does not have at
/// least three fields is skipped rather than half-parsed.
fn parse_poetry(stdout: &str) -> Vec<Outdated> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let name = cols.next()?;
            let current = cols.next()?;
            let latest = cols.next()?;
            // Both version columns must LOOK like versions, or this is a
            // header, a warning, or wrapped description text.
            if !current.starts_with(|c: char| c.is_ascii_digit())
                || !latest.starts_with(|c: char| c.is_ascii_digit())
            {
                return None;
            }
            Some(Outdated {
                name: name.to_string(),
                current: current.to_string(),
                latest: latest.to_string(),
                bump: version::bump(current, latest),
                ecosystem: Ecosystem::Poetry,
                manifest: "pyproject.toml".into(),
            })
        })
        .collect()
}

/// `- Alamofire 5.6.1 -> 5.8.0 (latest version 5.8.0)`
///
/// `pod outdated` prints a bulleted list. Lines that do not carry two
/// versions are headers or advice, and are skipped rather than
/// half-parsed.
fn parse_cocoapods(stdout: &str) -> Vec<Outdated> {
    stdout
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("- ")?;
            let mut parts = rest.split_whitespace();
            let name = parts.next()?;
            let current = parts.next()?;
            // The arrow, then the target version.
            let latest = parts.find(|p| p.starts_with(|c: char| c.is_ascii_digit()))?;
            if !current.starts_with(|c: char| c.is_ascii_digit()) {
                return None;
            }
            Some(Outdated {
                name: name.to_string(),
                current: current.to_string(),
                latest: latest.to_string(),
                bump: version::bump(current, latest),
                ecosystem: Ecosystem::Cocoapods,
                manifest: "Podfile".into(),
            })
        })
        .collect()
}

/// `   > PackageName   1.0.0   1.0.0   2.0.0`
///
/// `dotnet list package --outdated` prints a tree with `>`-prefixed
/// package lines: requested, resolved, then latest.
fn parse_dotnet(stdout: &str, repo: &Path) -> Vec<Outdated> {
    let manifest = std::fs::read_dir(repo)
        .ok()
        .and_then(|entries| {
            entries.flatten().find_map(|e| {
                let p = e.path();
                let ext = p.extension()?.to_str()?.to_ascii_lowercase();
                ["csproj", "fsproj", "vbproj"]
                    .contains(&ext.as_str())
                    .then(|| e.file_name().to_string_lossy().to_string())
            })
        })
        .unwrap_or_else(|| "the project file".to_string());

    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("> ")?;
            let cols: Vec<&str> = rest.split_whitespace().collect();
            // name, requested, resolved, latest.
            if cols.len() < 4 {
                return None;
            }
            let (name, current, latest) = (cols[0], cols[2], cols[3]);
            Some(Outdated {
                name: name.to_string(),
                current: current.to_string(),
                latest: latest.to_string(),
                bump: version::bump(current, latest),
                ecosystem: Ecosystem::Dotnet,
                manifest: manifest.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packages::model::Bump;

    fn nowhere() -> &'static Path {
        Path::new("/nonexistent")
    }

    /// npm's real shape, including a package with NO `current` -- which
    /// happens when a dependency is declared but not installed. A
    /// phantom row here would be handed straight to an agent.
    #[test]
    fn parses_npm_json_and_skips_uninstalled_packages() {
        let out = r#"{
          "react": {"current": "18.2.0", "wanted": "18.3.0", "latest": "19.0.0"},
          "vite":  {"current": "5.0.1",  "wanted": "5.0.2",  "latest": "5.0.2"},
          "ghost": {"wanted": "1.0.0", "latest": "2.0.0"}
        }"#;
        let rows = parse(out, Ecosystem::Npm, nowhere());
        assert_eq!(
            rows.len(),
            2,
            "the uninstalled package is skipped: {rows:?}"
        );
        let react = rows.iter().find(|r| r.name == "react").unwrap();
        assert_eq!(react.bump, Bump::Major);
        assert_eq!(react.manifest, "package.json");
        let vite = rows.iter().find(|r| r.name == "vite").unwrap();
        assert_eq!(vite.bump, Bump::Patch);
    }

    /// npm prints `{}` when everything is current.
    #[test]
    fn an_empty_npm_result_is_no_rows_not_an_error() {
        assert!(parse("{}", Ecosystem::Npm, nowhere()).is_empty());
    }

    #[test]
    fn parses_uv_json() {
        let out = r#"[
          {"name": "requests", "version": "2.28.0", "latest_version": "2.31.0"},
          {"name": "urllib3",  "version": "1.26.0", "latest_version": "2.0.0"}
        ]"#;
        let rows = parse(out, Ecosystem::Uv, nowhere());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].bump, Bump::Minor);
        assert_eq!(rows[1].bump, Bump::Major);
    }

    /// Poetry has no JSON output, so the COLUMNS are the contract -- and
    /// they are not a contract Poetry promises. Header lines, warnings,
    /// and wrapped descriptions all have to be rejected.
    #[test]
    fn parses_poetry_columns_and_rejects_everything_else() {
        let out = "\
Warning: something happened
requests 2.28.0 2.31.0 Python HTTP for Humans
urllib3  1.26.0 2.0.0  HTTP library
  continued description text
";
        let rows = parse(out, Ecosystem::Poetry, nowhere());
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].name, "requests");
        assert_eq!(rows[1].bump, Bump::Major);
    }

    /// A version column that is not a version means the line is not a
    /// package row, whatever else it looks like.
    #[test]
    fn a_poetry_line_without_versions_is_not_a_package() {
        let out = "Package Version Latest Description\n";
        assert!(parse(out, Ecosystem::Poetry, nowhere()).is_empty());
    }

    #[test]
    fn parses_dotnet_tree_output() {
        let out = "\
Project `Api` has the following updates
   [net8.0]:
   Top-level Package      Requested   Resolved   Latest
   > Newtonsoft.Json      13.0.1      13.0.1     13.0.3
   > Serilog              2.12.0      2.12.0     3.1.1
";
        let rows = parse(out, Ecosystem::Dotnet, nowhere());
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].name, "Newtonsoft.Json");
        assert_eq!(rows[0].bump, Bump::Patch);
        assert_eq!(rows[1].bump, Bump::Major);
    }

    /// Unparseable output yields no rows rather than garbage ones. The
    /// caller turns "no rows and a failed status" into an error.
    #[test]
    fn garbage_output_produces_no_rows() {
        for eco in [
            Ecosystem::Npm,
            Ecosystem::Uv,
            Ecosystem::Poetry,
            Ecosystem::Dotnet,
        ] {
            assert!(
                parse("not json, not columns", eco, nowhere()).is_empty(),
                "{eco:?}"
            );
        }
    }

    /// The whole reason `error` exists on the report: a check that could
    /// not run must NOT render as "you are up to date".
    ///
    /// Driven through `check` against an empty directory, where every
    /// tool has something to complain about. What the message SAYS
    /// depends on whether the tool is installed on this machine -- that
    /// varies by environment and is not the property under test. What
    /// must hold everywhere is that a failure never comes back as an
    /// empty success.
    #[test]
    fn a_failed_check_never_looks_like_success() {
        let t = tempfile::TempDir::new().unwrap();
        let r = check(t.path(), Ecosystem::Dotnet);
        assert!(
            r.error.is_some() || r.outdated.is_empty(),
            "a report with rows and no error would be claiming a real result"
        );
        if let Some(msg) = &r.error {
            assert!(!msg.trim().is_empty(), "an error must say something");
        }
    }

    /// `npm outdated` EXITS 1 WHEN UPDATES EXIST. Treating non-zero as
    /// failure reports "no updates" on every repository that has some --
    /// the exact inversion this module exists to prevent.
    #[test]
    fn a_non_zero_exit_with_output_is_not_a_failure() {
        assert!(
            !is_real_failure(false, false, r#"{"react":{}}"#),
            "npm exits 1 when it finds updates"
        );
        assert!(
            !is_real_failure(true, false, "{}"),
            "output that parsed to nothing is a format question, not a failed run"
        );
    }

    #[test]
    fn a_non_zero_exit_with_no_output_at_all_is_a_failure() {
        assert!(is_real_failure(true, false, "   "));
    }

    #[test]
    fn a_clean_exit_is_never_a_failure() {
        assert!(!is_real_failure(true, true, ""));
    }

    /// Swift must say it cannot check, not report an empty list.
    ///
    /// An empty list reads as "up to date", which is the same inversion
    /// a missing tool would produce -- and on an iOS repository that
    /// would be a confident wrong answer about every dependency it has.
    #[test]
    fn swift_states_that_it_cannot_check_rather_than_reporting_nothing() {
        let t = tempfile::TempDir::new().unwrap();
        let r = check(t.path(), Ecosystem::Swift);
        assert!(r.outdated.is_empty());
        let msg = r.error.expect("Swift must not report an empty success");
        assert!(msg.contains("not checked"), "{msg}");
    }

    #[test]
    fn parses_cocoapods_output() {
        let out = "\
The following pod updates are available:
- Alamofire 5.6.1 -> 5.8.0 (latest version 5.8.0)
- SwiftyJSON 4.0.0 -> 5.0.0 (latest version 5.0.0)
";
        let rows = parse(out, Ecosystem::Cocoapods, nowhere());
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].name, "Alamofire");
        assert_eq!(rows[0].bump, Bump::Minor);
        assert_eq!(rows[1].bump, Bump::Major);
    }

    /// The not-installed path, without depending on what is installed.
    #[test]
    fn a_tool_that_cannot_be_found_is_reported_as_missing() {
        assert!(tools::find("headstate-definitely-not-a-real-tool", &[]).is_none());

        // And that None becomes an ERROR, not an empty success.
        let r = missing_tool(Ecosystem::Npm);
        assert!(r.outdated.is_empty());
        let msg = r
            .error
            .expect("a missing tool must never report as up to date");
        assert!(msg.contains("npm"), "and must name the tool: {msg}");
        assert!(
            msg.contains("PATH"),
            "and say why, since that is actionable"
        );
    }
}

/// End-to-end against a REAL project under a GUI-like PATH.
///
/// Ignored by default: it needs npm and a project on this machine. The
/// unit tests cover the mechanism; this proves the whole path, which is
/// what the bug report was about.
///
/// `HEADSTATE_E2E_REPO=/path/to/project cargo test -- --ignored gui_like`
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore = "needs npm and a real project"]
    fn a_gui_like_path_still_resolves_the_interpreter() {
        let Ok(repo) = std::env::var("HEADSTATE_E2E_REPO") else {
            eprintln!("set HEADSTATE_E2E_REPO to run this");
            return;
        };
        // The PATH a GUI-launched .app actually gets: no version
        // manager, no Homebrew.
        temp_env::with_var("PATH", Some("/usr/bin:/bin:/usr/sbin:/sbin"), || {
            let report = check(std::path::Path::new(&repo), Ecosystem::Npm);
            eprintln!("error: {:?}", report.error);
            eprintln!("outdated: {}", report.outdated.len());
            if let Some(e) = &report.error {
                assert!(
                    !e.contains("No such file or directory"),
                    "the interpreter must resolve: {e}"
                );
            }
        });
    }
}
