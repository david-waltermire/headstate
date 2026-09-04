use serde::{Deserialize, Serialize};

/// Which toolchain owns a project's dependencies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ecosystem {
    Npm,
    Yarn,
    Poetry,
    Uv,
    Dotnet,
    /// CocoaPods, detected from a `Podfile`.
    Cocoapods,
    /// Terraform providers, from `.terraform.lock.hcl`.
    ///
    /// The only ecosystem here that needs NO tool installed. The lock
    /// file carries the resolved version in plain text, and the newest
    /// comes from the registry over HTTP -- so unlike every other one,
    /// a missing `terraform` binary cannot make this report nothing.
    Terraform,
    /// Swift packages, whether a `Package.swift` or Xcode-managed.
    ///
    /// Xcode-managed dependencies have NO CLI that reports outdated
    /// packages -- `xcodebuild -resolvePackageDependencies` resolves but
    /// does not diff. So this reports the pinned versions from
    /// `Package.resolved` and says plainly that it cannot check them,
    /// rather than rendering an empty list that reads as "up to date".
    Swift,
}

impl Ecosystem {
    /// The executable this ecosystem needs.
    pub fn program(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Yarn => "yarn",
            Ecosystem::Poetry => "poetry",
            Ecosystem::Uv => "uv",
            Ecosystem::Dotnet => "dotnet",
            Ecosystem::Cocoapods => "pod",
            // Never spawned; see the variant's comment.
            Ecosystem::Terraform => "terraform",
            Ecosystem::Swift => "swift",
        }
    }

    /// How a user updates one package here, for the markdown handoff.
    pub fn update_hint(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm install <pkg>@<version>",
            Ecosystem::Yarn => "yarn up <pkg>@<version>",
            Ecosystem::Poetry => "poetry add <pkg>@<version>",
            Ecosystem::Uv => "uv add <pkg>==<version>",
            Ecosystem::Dotnet => "dotnet add package <pkg> --version <version>",
            Ecosystem::Cocoapods => "pod update <pkg>",
            Ecosystem::Terraform => "raise the version constraint, then terraform init -upgrade",
            Ecosystem::Swift => "update the version rule in Xcode, or Package.swift",
        }
    }

    /// The manifest whose presence means this ecosystem is in use.
    pub fn manifest(self) -> &'static str {
        match self {
            Ecosystem::Npm | Ecosystem::Yarn => "package.json",
            Ecosystem::Poetry | Ecosystem::Uv => "pyproject.toml",
            Ecosystem::Cocoapods => "Podfile",
            Ecosystem::Terraform => ".terraform.lock.hcl",
            Ecosystem::Swift => "Package.resolved",
            // .NET is a glob, handled by the detector rather than here.
            Ecosystem::Dotnet => "",
        }
    }
}

/// How large a version jump is.
///
/// `Unknown` is a first-class answer rather than a fallback to `Major`.
/// Version schemes here are NOT all semver: .NET routinely uses four
/// parts, and PEP 440 has epochs and local versions that a semver parser
/// rejects outright. A version we cannot compare must be shown as
/// uncomparable, because silently calling it major would hide it from a
/// "minors only" filter and silently calling it minor would offer it as
/// safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bump {
    Patch,
    Minor,
    Major,
    Unknown,
}

/// One package with an update available.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outdated {
    pub name: String,
    pub current: String,
    pub latest: String,
    pub bump: Bump,
    pub ecosystem: Ecosystem,
    /// The manifest to edit, relative to the repo. What a Claude session
    /// needs in order to act without rediscovering it.
    pub manifest: String,
}

/// What one ecosystem reported for one repository.
///
/// A result rather than a bare list, because "no updates" and "the tool
/// is not installed" are completely different answers and rendering both
/// as an empty list is the worst outcome available -- it looks like good
/// news.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EcosystemReport {
    pub ecosystem: Ecosystem,
    pub outdated: Vec<Outdated>,
    /// Set when the check could not run. The UI shows this instead of an
    /// empty list.
    pub error: Option<String>,
}

/// One project's worth of reports.
///
/// The unit the UI groups by. A repository can hold several, and their
/// updates are separate pieces of work: different manifests, and
/// sometimes different ecosystems entirely.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectReport {
    /// Absolute path to the project directory.
    pub path: String,
    /// Relative to the repository root. Empty at the root itself.
    pub label: String,
    pub reports: Vec<EcosystemReport>,
}
