//! The Docker model.
//!
//! Field names and casing mirror what the TypeScript side receives, the
//! same contract `worktrees::model` keeps.

use serde::{Deserialize, Serialize};

/// Where an image came from, when it can be established.
///
/// Two independent sources, in preference order: `docker buildx history`
/// records the build context path and VCS revision directly, and failing
/// that a SHA-shaped tag can be resolved against the local repositories.
/// Which one answered is recorded, because a fact and an inference should
/// not look identical in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Origin {
    /// The repository directory the commit was found in.
    pub repo_path: String,
    /// The build context, which for a worktree build IS the worktree.
    /// Absent when the origin came from tag resolution rather than build
    /// history.
    pub context: Option<String>,
    pub commit: String,
    pub subject: String,
    /// Whether the commit has landed in the default branch. The highest
    /// value signal on the page: a superseded image whose branch merged
    /// is unambiguously dead, where one on a live branch may still be
    /// wanted.
    pub merged: bool,
    /// How the origin was established, so the UI can distinguish a
    /// recorded fact from a resolved guess.
    pub source: OriginSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginSource {
    /// `docker buildx history inspect` recorded it.
    BuildHistory,
    /// The tag looked like a commit SHA and resolved in a local repo.
    TagResolution,
}

/// One image, deduplicated by ID.
///
/// `latest` and a SHA tag are frequently the SAME image -- on a real
/// machine that is 1.33GB counted twice if the rows are taken at face
/// value, which would advertise reclaimable space that does not exist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Image {
    pub id: String,
    pub repository: String,
    /// Every tag pointing at this ID.
    pub tags: Vec<String>,
    /// RFC 3339, so the UI can render it relatively.
    pub created: String,
    pub size_bytes: u64,
    pub origin: Option<Origin>,
    /// A running container holds this image. Never a cleanup candidate,
    /// regardless of everything else.
    ///
    /// `None` means we could not ask -- the daemon was mid-restart, or
    /// the socket refused us. That is NOT "nothing is using it": an
    /// unknown answer must render as not-removable, since `docker rmi`
    /// would refuse anyway and offering-then-failing is worse than not
    /// offering.
    pub in_use: Option<bool>,
    /// A newer image exists for the same repository.
    pub superseded: bool,
    /// Another image shares this repository, whether newer or older.
    ///
    /// Separates "the newest of several" from "the only one there is".
    /// Without it every single-image repository reads as `current`,
    /// which is true and useless: with one image per repository nothing
    /// can ever be superseded, so the badge appeared on every row and
    /// discriminated nothing. A user reasonably read a page of
    /// `current` as a claim that their images were all in use.
    #[serde(default)]
    pub has_siblings: bool,
}

impl Image {
    /// Whether this image is safe to remove without asking anything else.
    ///
    /// Superseded AND merged AND unused. Deliberately narrower than
    /// "superseded": an image on a live branch may still be wanted, and
    /// the bulk path is for the provably-dead set only -- the same rule
    /// the worktrees view applies to `Safety::Safe`.
    pub fn is_stale(&self) -> bool {
        self.superseded
            // Only a KNOWN-unused image is stale. `None` -- we could not
            // ask -- keeps it out of the bulk set.
            && self.in_use == Some(false)
            && self.origin.as_ref().is_some_and(|o| o.merged)
    }
}

/// What `docker system df` reports, made actionable.
///
/// Images are only part of the problem: measured on a real machine,
/// 17.35GB of images sat beside 4.65GB of build cache and a 4.74GB
/// orphaned volume. A view that listed only images would leave most of
/// the waste invisible.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiskUsage {
    pub images_bytes: u64,
    pub images_reclaimable_bytes: u64,
    pub build_cache_bytes: u64,
    pub volumes_bytes: u64,
    pub volumes_reclaimable_bytes: u64,
}

/// Whether Docker can be talked to at all.
///
/// Unlike git, Docker is frequently OFF. "We could not ask" is not "the
/// answer is zero" -- the distinction #190 and #191 established for
/// polling, and an empty image list would otherwise read as a clean
/// machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum DockerState {
    Running,
    /// The CLI exists but the daemon is not up.
    NotRunning,
    /// The daemon is there and refused us -- on Linux, almost always
    /// because the user is not in the `docker` group. A distinct state
    /// because its fix is nothing like "start Docker".
    PermissionDenied,
    /// No `docker` binary was found.
    NotInstalled,
    /// Something else went wrong; carries the message.
    Unknown(String),
}
