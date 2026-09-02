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
    /// .NET build output: `bin/` and `obj/`.
    ///
    /// The most dangerous name in this list. `bin/` is ubiquitous and
    /// almost never .NET's -- in npm it holds executables a package
    /// ships, which are not regenerable and whose removal breaks the
    /// installed package.
    DotnetBuild,
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
            ArtifactKind::DotnetBuild => "dotnet build",
            ArtifactKind::Terraform => "terraform init",
            ArtifactKind::BuildOutput => "the project's build script",
        }
    }

    /// How to prove a tool owns this directory.
    ///
    /// A `target/` beside a `Cargo.toml` is cargo's. A `target/` beside
    /// nothing is somebody's data directory that happens to share a name
    /// -- and deleting it would not cost a rebuild, it would cost the
    /// data.
    ///
    /// A PREDICATE rather than a filename, because .NET's proof is a
    /// glob: `bin/` and `obj/` are the SDK's only when some `*.csproj`,
    /// `*.fsproj`, or `*.vbproj` sits beside them. That distinction is
    /// not academic -- on a machine with no C# at all there were 813
    /// `bin/` directories, nearly all of them npm packages where `bin/`
    /// holds shipped executables rather than build output. A name-based
    /// rule would have offered every one of them for deletion.
    pub fn proof(self) -> ManifestProof {
        match self {
            ArtifactKind::CargoTarget => ManifestProof::Named("Cargo.toml"),
            ArtifactKind::NodeModules => ManifestProof::Named("package.json"),
            ArtifactKind::DotnetBuild => {
                ManifestProof::AnyExtension(&["csproj", "fsproj", "vbproj"])
            }
            // Neither has a manifest of its own, which is exactly why
            // they lean on the gitignore check instead.
            ArtifactKind::Terraform => ManifestProof::None,
            ArtifactKind::BuildOutput => ManifestProof::None,
        }
    }
}

/// What must sit beside a directory for it to count as build output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestProof {
    /// A file with exactly this name.
    Named(&'static str),
    /// Any file with one of these extensions -- .NET names its project
    /// file after the project, so only the extension is fixed.
    AnyExtension(&'static [&'static str]),
    /// No manifest exists for this kind; something else must prove it.
    None,
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
