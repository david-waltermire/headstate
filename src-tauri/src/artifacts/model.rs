use serde::{Deserialize, Serialize};

/// What kind of build output a directory holds, and therefore what
/// regenerates it.
///
/// The whole feature rests on one membership rule: a directory belongs
/// here only if a documented command rebuilds it. That is what makes
/// removal cost a rebuild rather than losing work, and it is why this is
/// an enum rather than a user-supplied glob -- an arbitrary pattern could
/// match a directory nothing knows how to recreate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    /// Rust build output. Measured at 108 GB across 7 directories on the
    /// machine that prompted this feature -- the single largest consumer,
    /// and 99.7% of it sits beside main checkouts rather than inside
    /// worktrees, which is why the worktree view could never reach it.
    CargoTarget,
    NodeModules,
    /// Provider binaries, re-downloaded per module directory. Pure
    /// duplication: 37 directories clustered at ~0.8 GB each.
    Terraform,
    /// A build output directory -- `dist` or `build`.
    ///
    /// The only kind that is not named by its tool, and therefore the
    /// only one that can be wrong: some projects COMMIT a `build/` of
    /// real source. `is_generated` is what separates them.
    BuildOutput,
}

impl ArtifactKind {
    /// The command that puts it back.
    ///
    /// Shown in the UI rather than kept as a comment: "you can delete
    /// this" is only actionable if the user knows what restores it.
    pub fn regenerated_by(self) -> &'static str {
        match self {
            ArtifactKind::CargoTarget => "cargo build",
            ArtifactKind::NodeModules => "npm install (or yarn)",
            ArtifactKind::Terraform => "terraform init",
            ArtifactKind::BuildOutput => "the project's build script",
        }
    }

    /// The manifest that proves a tool owns this directory.
    ///
    /// A `target/` beside a `Cargo.toml` is cargo's. A `target/` beside
    /// nothing is somebody's data directory that happens to share a name
    /// -- and deleting it would not cost a rebuild, it would cost the
    /// data. `BuildOutput` has no manifest, which is exactly why it needs
    /// the gitignore check instead.
    pub fn manifest(self) -> Option<&'static str> {
        match self {
            ArtifactKind::CargoTarget => Some("Cargo.toml"),
            ArtifactKind::NodeModules => Some("package.json"),
            ArtifactKind::Terraform => None,
            ArtifactKind::BuildOutput => None,
        }
    }
}

/// One directory of regenerable build output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    /// Absolute path. Removal takes this, never a name matched by
    /// pattern -- and re-verifies it sits under a configured scan root.
    pub path: String,
    pub kind: ArtifactKind,
    /// The checkout it belongs to, for grouping.
    pub repo_path: String,
    /// Bytes on disk, or None until measured.
    ///
    /// Sizing is three orders of magnitude slower than discovery
    /// (measured: 54ms to find 111 directories, 56s to size them), so the
    /// list is rendered before this is known and filled in as it lands.
    /// Optional rather than 0: "not measured yet" and "empty" are
    /// different facts, and showing 0 B for the former is a lie the user
    /// would act on.
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// Seconds since anything under it was written, or None if unknown.
    ///
    /// A running `cargo build` does NOT make git dirty -- build output is
    /// gitignored -- so no git-based safety check can see it. This is the
    /// only signal that a directory is in active use.
    #[serde(default)]
    pub modified_secs_ago: Option<u64>,
}
