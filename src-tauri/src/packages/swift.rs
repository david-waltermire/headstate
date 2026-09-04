//! Swift packages, read from `Package.resolved`.
//!
//! `check` used to report, accurately, that no command answers this:
//! `xcodebuild -resolvePackageDependencies` resolves and does not diff,
//! and `swift package update --dry-run` only exists for a
//! `Package.swift`, not for Xcode-managed dependencies.
//!
//! That was true about COMMANDS and wrong about the question. Swift
//! packages are Git repositories and their versions are TAGS, so
//! "is there a newer one" is answerable without any Swift tooling:
//! `Package.resolved` gives the pin and the source URL, and the host
//! lists the tags. For the common case that host is GitHub, which this
//! app is already authenticated against.
//!
//! Checking and applying are separate: knowing a newer tag exists is not
//! knowing how to update an Xcode project's package reference, so apply
//! stays refused.

use super::model::{Bump, Ecosystem, Outdated};
use std::path::Path;

/// How deep to look. Xcode buries `Package.resolved` inside the project
/// bundle: `App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`.
const MAX_DEPTH: usize = 6;

/// Every Swift package pinned in this repository.
///
/// `latest` starts equal to `current` with `Bump::Unknown`, and
/// `registry::enrich` fills it in. A pin without a version -- by branch
/// or bare revision -- is reported with its revision and left
/// uncomparable, because there is no version to compare and calling it
/// current would be a lie.
pub fn pinned(repo: &Path) -> Vec<Outdated> {
    let mut out = Vec::new();
    for file in resolved_files(repo) {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let manifest = file
            .strip_prefix(repo)
            .unwrap_or(&file)
            .to_string_lossy()
            .to_string();
        for pin in parse(&text) {
            out.push(Outdated {
                // The identity a person recognises, not the URL.
                //
                // `https://github.com/octocat/hello-world.git`
                // reads as noise in a list, and the same package pinned
                // in three `Package.resolved` files would show three
                // near-identical URLs. The full location is still the
                // lookup key -- `registry::enrich` needs it -- so it is
                // carried in `manifest` rather than dropped.
                name: display_name(&pin.location),
                current: pin.version,
                latest: String::new(),
                bump: Bump::Unknown,
                ecosystem: Ecosystem::Swift,
                // The source URL first, so enrichment can find it, then
                // WHICH resolved file it came from.
                manifest: format!("{} <- {manifest}", pin.location),
            });
        }
    }
    // `latest` is filled by enrichment; until then it mirrors current so
    // nothing renders as an update that has not been checked.
    for o in &mut out {
        o.latest = o.current.clone();
    }
    out
}

/// One pinned dependency.
pub struct Pin {
    /// The source URL. This is the lookup key, and it is what tells a
    /// GitHub package from a private host.
    pub location: String,
    /// The pinned version, or the revision when pinned by branch.
    pub version: String,
    /// Whether `version` is a real version rather than a revision.
    ///
    /// A branch or revision pin has nothing to compare against, and must
    /// report "cannot check" rather than "up to date" -- the inversion
    /// this whole module is built to avoid.
    pub comparable: bool,
}

/// Parse both formats.
///
/// v2 nests under `object.pins` and names the URL `repositoryURL`; v3
/// has `pins` at the root and `location`. Both are still written by
/// current tooling depending on the Xcode version, so both are read.
pub fn parse(text: &str) -> Vec<Pin> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let pins = v
        .get("pins")
        .or_else(|| v.get("object").and_then(|o| o.get("pins")))
        .and_then(|p| p.as_array());
    let Some(pins) = pins else {
        return Vec::new();
    };

    pins.iter()
        .filter_map(|p| {
            let location = p
                .get("location")
                .or_else(|| p.get("repositoryURL"))
                .and_then(|l| l.as_str())?
                .to_string();
            let state = p.get("state")?;
            let version = state.get("version").and_then(|s| s.as_str());
            let revision = state.get("revision").and_then(|s| s.as_str());
            match (version, revision) {
                (Some(v), _) => Some(Pin {
                    location,
                    version: v.to_string(),
                    comparable: true,
                }),
                // Pinned to a branch or a bare commit. Reported, and
                // explicitly not comparable.
                (None, Some(r)) => Some(Pin {
                    location,
                    version: r.chars().take(7).collect(),
                    comparable: false,
                }),
                (None, None) => None,
            }
        })
        .collect()
}

/// A readable name for a package source URL.
///
/// `https://github.com/octocat/hello-world.git` becomes
/// `octocat/hello-world`. Anything unrecognised is returned
/// unchanged rather than mangled -- a URL is at least true.
fn display_name(location: &str) -> String {
    let trimmed = location
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(location.trim_end_matches('/'));
    let after_host = trimmed
        .rsplit_once("github.com/")
        .or_else(|| trimmed.rsplit_once("github.com:"))
        .map(|(_, rest)| rest);
    after_host.unwrap_or(trimmed).to_string()
}

/// `owner/repo` for a GitHub source URL, or `None` for any other host.
///
/// Anything not on GitHub reports "cannot check" rather than being
/// guessed at: this app is authenticated against GitHub and nothing
/// else, and inventing an API shape for an unknown host would produce
/// wrong answers rather than missing ones.
pub fn github_repo(location: &str) -> Option<(String, String)> {
    let rest = location
        .strip_prefix("https://github.com/")
        .or_else(|| location.strip_prefix("git@github.com:"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?.to_string();
    let name = parts.next()?.to_string();
    // Belt and braces. Any URL that reaches here without the prefix
    // splits into ("https:", "") and is rejected by the empty check, so
    // this is unreachable through the prefix strip above -- it guards a
    // caller passing a bare `owner/` pair instead.
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some((owner, name))
}

/// `Package.resolved` files under `repo`.
fn resolved_files(repo: &Path) -> Vec<std::path::PathBuf> {
    const SKIP: &[&str] = &[".git", "build", ".build", "node_modules", ".worktrees"];
    let mut out = Vec::new();
    let mut stack = vec![(repo.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if depth < MAX_DEPTH && !SKIP.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
            } else if name == "Package.resolved" {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The v3 shape, which is what current Xcode writes.
    const V3: &str = r#"{
      "pins": [
        { "identity": "hello-world",
          "kind": "remoteSourceControl",
          "location": "https://github.com/octocat/hello-world.git",
          "state": { "revision": "abc123def456", "version": "4.13.0" } }
      ],
      "version": 3
    }"#;

    /// The v2 shape: pins nested under `object`, URL named differently.
    const V2: &str = r#"{
      "object": { "pins": [
        { "package": "spoon-knife",
          "repositoryURL": "https://github.com/octocat/spoon-knife.git",
          "state": { "revision": "deadbeef", "version": "5.8.0" } }
      ] },
      "version": 2
    }"#;

    #[test]
    fn reads_the_v3_format() {
        let pins = parse(V3);
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].version, "4.13.0");
        assert!(pins[0].comparable);
    }

    /// Both are still written depending on the Xcode version, so both
    /// are read -- a v2 project reporting nothing would look identical
    /// to one with no dependencies.
    #[test]
    fn reads_the_v2_format() {
        let pins = parse(V2);
        assert_eq!(pins.len(), 1);
        assert_eq!(
            pins[0].location,
            "https://github.com/octocat/spoon-knife.git"
        );
        assert_eq!(pins[0].version, "5.8.0");
    }

    /// A branch or revision pin has NO version to compare. Reporting it
    /// as current would be the inversion this module exists to avoid.
    #[test]
    fn a_revision_pin_is_not_comparable() {
        let by_branch = r#"{"pins":[{"identity":"x",
          "location":"https://github.com/octocat/example.git",
          "state":{"revision":"abcdef1234567890","branch":"main"}}],"version":3}"#;
        let pins = parse(by_branch);
        assert_eq!(pins.len(), 1);
        assert!(!pins[0].comparable, "a branch pin cannot be compared");
        assert_eq!(pins[0].version, "abcdef1", "the short revision is shown");
    }

    #[test]
    fn malformed_input_yields_nothing() {
        assert!(parse("not json").is_empty());
        assert!(parse("{}").is_empty());
        assert!(parse(r#"{"pins":[]}"#).is_empty());
    }

    #[test]
    fn recognises_github_urls_in_both_forms() {
        assert_eq!(
            github_repo("https://github.com/octocat/hello-world.git"),
            Some(("octocat".into(), "hello-world".into()))
        );
        assert_eq!(
            github_repo("git@github.com:octocat/example.git"),
            Some(("octocat".into(), "example".into()))
        );
    }

    /// Anything not on GitHub reports NOTHING rather than being guessed
    /// at: this app is authenticated against GitHub and nothing else.
    #[test]
    fn other_hosts_are_not_guessed_at() {
        assert_eq!(github_repo("https://gitlab.com/octocat/example.git"), None);
        assert_eq!(
            github_repo("https://git.example.internal/octocat/example.git"),
            None
        );
    }

    /// The dangerous shape: a host that LOOKS like a path pair, so a
    /// loosened prefix check would happily send someone's private
    /// dependency name to api.github.com.
    #[test]
    fn a_lookalike_host_is_not_treated_as_a_github_repo() {
        assert_eq!(github_repo("https://gitlab.com/octocat/example.git"), None);
        assert_eq!(
            github_repo("https://github.example.invalid/octocat/example.git"),
            None
        );
        // And an owner-only URL is not half a repository.
        assert_eq!(github_repo("https://github.com/octocat"), None);
    }

    #[test]
    fn names_a_package_readably() {
        assert_eq!(
            display_name("https://github.com/octocat/hello-world.git"),
            "octocat/hello-world"
        );
        // Unrecognised shapes come back unchanged: a URL is at least
        // true, where a mangled one is not.
        assert_eq!(
            display_name("https://example.invalid/x"),
            "https://example.invalid/x"
        );
    }

    /// Every row starts uncompared, and enrichment fills it in.
    #[test]
    fn pinned_rows_start_uncompared() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::write(t.path().join("Package.resolved"), V3).unwrap();
        let out = pinned(t.path());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].bump, Bump::Unknown);
        assert_eq!(out[0].latest, out[0].current);
        // The source URL survives for the lookup, alongside the file.
        assert!(out[0].manifest.contains("github.com/octocat"));
    }

    /// Xcode buries it several levels down inside the project bundle.
    #[test]
    fn finds_a_resolved_file_inside_an_xcode_bundle() {
        let t = tempfile::TempDir::new().unwrap();
        let deep = t
            .path()
            .join("App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("Package.resolved"), V3).unwrap();
        assert_eq!(pinned(t.path()).len(), 1);
    }
}
