use super::model::{Ecosystem, EcosystemReport, Outdated, ProjectReport};
use super::{detect, swift, terraform, tools, version};
use std::path::Path;

/// Whether this project's Yarn is version 1.
///
/// `yarn outdated` was REMOVED in Yarn 2. On a Berry project it is not
/// even a recognised command -- Yarn reports `Couldn't find a script
/// named "outdated"` and **exits 0**, so the existing error handling
/// never fired and an empty result rendered as "you are up to date".
///
/// There is no non-interactive replacement: `yarn npm outdated` does not
/// exist, and `yarn upgrade-interactive` is a full-screen UI.
///
/// `yarn --version` is resolved per project by Corepack from
/// `packageManager`, so this asks in the project directory rather than
/// assuming one global Yarn.
///
/// Unknown counts as NOT version 1: Berry is the default for anything
/// new, and guessing v1 restores the silent-empty-list failure.
fn yarn_is_v1(bin: &Path, repo: &Path) -> bool {
    std::process::Command::new(bin)
        .arg("--version")
        .current_dir(repo)
        .env("PATH", tools::child_path(bin))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .is_some_and(|major| major == 1)
}

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
    // Terraform answers from a FILE plus the registry, never a command.
    //
    // `terraform providers` reports the constraints (`>= 5.0.0`) and
    // does not diff, so there is nothing to spawn and parse. The lock
    // file carries the resolved versions, and `enrich` fills in the
    // latest asynchronously afterwards.
    if eco == Ecosystem::Terraform {
        return EcosystemReport {
            ecosystem: eco,
            outdated: terraform::pinned(repo),
            error: None,
        };
    }

    // Swift answers from a FILE plus the Git host, never a command.
    //
    // No command reports outdated Xcode-managed dependencies, which is
    // what this used to say and stop at. But Swift packages are Git
    // repositories and their versions are TAGS, so `Package.resolved`
    // plus a tag listing answers the question -- see `packages::swift`.
    if eco == Ecosystem::Swift {
        return EcosystemReport {
            ecosystem: eco,
            outdated: swift::pinned(repo),
            error: None,
        };
    }

    let fallbacks = tools::fallback_dirs();
    let refs: Vec<&str> = fallbacks.iter().map(String::as_str).collect();
    let Some(mut bin) = tools::find(eco.program(), &refs) else {
        return missing_tool(eco);
    };

    // Yarn Berry has no outdated command, so the CHECK runs through npm.
    //
    // `npm outdated` reads package.json and queries the registry; it
    // does not care which resolver installed the tree, and it does not
    // need npm to have installed anything. Verified on a real Yarn 4.9
    // project: 98 packages reported, correct current/latest.
    //
    // Only the check. The version npm reports as latest is a registry
    // fact and true either way, but the constraint Yarn would WRITE is
    // Yarn's business -- the requested-vs-resolved distinction #409
    // phase 1 established.
    if eco == Ecosystem::Yarn && !yarn_is_v1(&bin, repo) {
        let Some(npm) = tools::find("npm", &refs) else {
            return EcosystemReport {
                ecosystem: eco,
                outdated: Vec::new(),
                // A real "cannot check", not an empty list: this
                // ecosystem's own tool cannot answer and the stand-in is
                // absent.
                error: Some(
                    "Yarn 2+ has no command that reports outdated packages, and npm \
                     -- which can read this project -- was not found."
                        .into(),
                ),
            };
        };
        bin = npm;
    }

    let args: &[&str] = match eco {
        Ecosystem::Npm => &["outdated", "--json"],
        // Same flags either way: `yarn outdated --json` (v1) and
        // `npm outdated --json` take the same arguments and produce
        // output `parse_npm` already handles for both.
        Ecosystem::Yarn => &["outdated", "--json"],
        Ecosystem::Poetry => &["show", "--outdated"],
        Ecosystem::Uv => &["pip", "list", "--outdated", "--format", "json"],
        Ecosystem::Dotnet => &["list", "package", "--outdated"],
        Ecosystem::Cocoapods => &["outdated"],
        // Neither reaches here: both return early above, because
        // neither has a command that answers the question.
        Ecosystem::Terraform => &["version"],
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
/// So a failure requires nothing parsed AND a non-zero status, plus
/// either no output at all or output that is visibly not a result.
///
/// The "visibly not a result" case is real: `yarn outdated` on Yarn 2+
/// exits 1 and writes `Usage Error: Couldn't find a script named
/// "outdated"` to STDOUT. Requiring empty stdout let that through as
/// zero results, so every Berry project reported "no updates" -- the
/// inversion this function exists to prevent, arriving by a route it
/// did not cover.
fn is_real_failure(nothing_parsed: bool, status_ok: bool, stdout: &str) -> bool {
    let out = stdout.trim();
    nothing_parsed && !status_ok && (out.is_empty() || is_usage_error(out))
}

/// Output that is a tool complaining rather than a result.
///
/// Deliberately narrow: it must not match a legitimate empty result, so
/// this looks for the shape of a CLI's own refusal at the very start of
/// the output, never anywhere within it.
fn is_usage_error(stdout: &str) -> bool {
    // First line only. `starts_with` on the whole string would behave
    // the same for every input seen here -- both reject a match on a
    // later line -- but taking the line explicitly says what is meant
    // and does not depend on that coincidence holding.
    let head = stdout.lines().next().unwrap_or_default().trim_start();
    // Strip the ANSI colour codes Yarn writes even when redirected.
    let plain: String = head
        .split('\u{1b}')
        .map(|part| part.split_once('m').map_or(part, |(_, rest)| rest))
        .collect();
    let lowered = plain.to_ascii_lowercase();
    lowered.starts_with("usage error")
        || lowered.starts_with("unknown syntax error")
        || lowered.starts_with("error: unknown command")
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
        // Both handled before any command runs: neither has one.
        Ecosystem::Swift | Ecosystem::Terraform => Vec::new(),
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

    /// Swift IS checked now, from `Package.resolved` plus the Git host's
    /// tags -- #434.
    ///
    /// The old assertion here was that it reported "cannot check". That
    /// was accurate about COMMANDS (nothing diffs Xcode-managed
    /// dependencies) and wrong about the question: Swift versions are
    /// git tags, and the resolved file names both the pin and its source
    /// URL.
    ///
    /// A repository with no resolved file still reports NOTHING rather
    /// than an error: there is genuinely nothing pinned, which is a real
    /// empty rather than a failed check.
    #[test]
    fn swift_reports_its_pins_rather_than_refusing() {
        let t = tempfile::TempDir::new().unwrap();
        let r = check(t.path(), Ecosystem::Swift);
        assert!(r.outdated.is_empty(), "no resolved file, nothing pinned");
        assert!(r.error.is_none(), "an absent file is not a failure");

        // With one, the pin is reported -- and left UNCOMPARED until
        // enrichment, never claimed to be current.
        std::fs::write(
            t.path().join("Package.resolved"),
            r#"{"pins":[{"identity":"x",
               "location":"https://github.com/octocat/example.git",
               "state":{"revision":"abc","version":"1.2.3"}}],"version":3}"#,
        )
        .unwrap();
        let r = check(t.path(), Ecosystem::Swift);
        assert_eq!(r.outdated.len(), 1);
        assert_eq!(r.outdated[0].current, "1.2.3");
        assert_eq!(r.outdated[0].bump, crate::packages::model::Bump::Unknown);
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

#[cfg(test)]
mod berry {
    use super::*;

    /// The REAL bytes Yarn 4 writes, colour codes and all, captured from
    /// `yarn outdated --json` on a Yarn 4.9 project. Yarn colours its
    /// output even when redirected, so a naive prefix check misses it.
    const YARN_BERRY_USAGE: &str =
        "\u{1b}[31m\u{1b}[1mUsage Error\u{1b}[22m\u{1b}[39m: Couldn't find a script named \"outdated\".\n";

    #[test]
    fn a_yarn_berry_usage_error_is_a_failure_not_zero_updates() {
        assert!(
            is_usage_error(YARN_BERRY_USAGE),
            "the real Yarn Berry output must be recognised"
        );
        // Exits 1 and writes to STDOUT, so the old rule -- which
        // required empty stdout -- let this through as "no updates".
        assert!(is_real_failure(true, false, YARN_BERRY_USAGE));
    }

    /// The inversion this must never reintroduce: `npm outdated` exits 1
    /// precisely WHEN there are updates.
    #[test]
    fn a_non_zero_exit_with_real_output_is_not_a_failure() {
        let real = r#"{"lodash":{"current":"4.17.20","latest":"4.17.21"}}"#;
        assert!(!is_real_failure(false, false, real));
    }

    /// A genuinely empty result stays a non-failure.
    #[test]
    fn an_honestly_empty_result_is_not_a_failure() {
        assert!(!is_usage_error("{}"));
        assert!(!is_real_failure(true, true, "{}"));
    }

    /// Anchored to the FIRST line, so a later line that happens to begin
    /// with those words is not mistaken for the tool refusing.
    ///
    /// Pretty-printed JSON is the realistic case: `npm outdated --json`
    /// emits one key per line, and a package or field could legitimately
    /// start with "usage error".
    #[test]
    fn the_words_on_a_later_line_are_not_a_usage_error() {
        let pretty = "{\n  \"pkg\": {\n\"usage error handling\": 1\n  }\n}";
        assert!(
            !is_usage_error(pretty),
            "only the first line may declare a refusal"
        );
        // And a real result that merely mentions them stays a result.
        assert!(!is_real_failure(false, false, pretty));

        // The case that makes the anchoring load-bearing rather than
        // decorative: output whose FIRST line is blank, with the words
        // further down. Matching the whole string would call this a
        // refusal; matching the first line does not.
        let later = "\n{\"a\":1}\nusage error: not a refusal, just text\n";
        assert!(!is_usage_error(later));
    }
}

/// End-to-end against a REAL Yarn Berry project. Ignored by default: it
/// needs npm, a project on this machine, and the network.
///
/// `HEADSTATE_YARN_REPO=/path cargo test -- --ignored yarn_e2e`
#[cfg(test)]
mod yarn_e2e {
    use super::*;

    #[test]
    #[ignore = "needs a real Yarn Berry project and network access"]
    fn a_yarn_berry_project_reports_updates() {
        let Ok(repo) = std::env::var("HEADSTATE_YARN_REPO") else {
            eprintln!("set HEADSTATE_YARN_REPO to run this");
            return;
        };
        let report = check(Path::new(&repo), Ecosystem::Yarn);
        eprintln!("error: {:?}", report.error);
        eprintln!("outdated: {}", report.outdated.len());
        assert!(report.error.is_none(), "{:?}", report.error);
        assert!(
            !report.outdated.is_empty(),
            "a Berry project with outdated packages must report them"
        );
    }
}
