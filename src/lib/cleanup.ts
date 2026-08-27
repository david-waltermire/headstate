import type { DockerImage, PullRequest, Worktree } from "@/types/pr";

/// One merged pull request and every leftover it owns.
///
/// The app's thesis is that agents create branches, pull requests merge,
/// and the leftovers stay -- a remote branch, a worktree on disk, and a
/// Docker image built from it. Each was already removable, but from three
/// different views, so nobody did all three.
export interface CleanupItem {
  /// The worktree path, which is what identifies the entry on screen.
  repo: string;
  branch: string;
  worktree: Worktree;
  /// Images built from that worktree that nothing is running.
  images: DockerImage[];
  /// Bytes reclaimed by removing the worktree and the images.
  bytes: number;
}

/// Everything safe to clean up, one entry per merged pull request.
///
/// MERGED only. An open pull request's branch is live work and its
/// worktree is where that work happens; offering to delete either would
/// be offering to lose it. `delete_head_branch` re-checks this on the
/// Rust side too, because deleting the head ref of an open pull request
/// closes it.
///
/// Nothing here is destructive by itself. This builds the list the user
/// confirms -- three separately-gated irreversible actions must not
/// collapse into one unreviewed click, which is why the manifest exists
/// at all rather than a "clean up everything" button.
export function cleanupManifest(
  worktrees: Worktree[],
  images: DockerImage[],
  prs: PullRequest[] = [],
): CleanupItem[] {
  const items: CleanupItem[] = [];

  for (const wt of worktrees) {
    // WORKTREE-DRIVEN, not pull-request-driven. The open-PR list cannot
    // answer "did this merge" -- it holds only open pull requests, and
    // the merged ones the app knows about are a stats sample rather than
    // a complete set. `Safety` is the app's own vetted answer to "is
    // this safe to remove", computed from the actual checkout: merged,
    // clean, pushed, not the main checkout.
    //
    // Reusing it rather than re-deriving means this manifest cannot
    // disagree with the Worktrees page about what is safe -- and every
    // reason NOT to remove something (dirty, unpushed, never pushed,
    // unmerged) is already enumerated there.
    if (wt.safety.kind !== "safe") continue;

    // The open pull request for this branch, if there is one. There
    // should not be: a safe worktree has merged. If one turns up, the
    // branch is live again and this is not cleanup.
    const open = prs.find((p) => p.head_ref === wt.branch);
    if (open) continue;

    // Only images we can prove nothing is running. `in_use === null`
    // means "we could not ask", and treating an unknown as unused is how
    // a bulk delete takes out something a container needs -- the same
    // rule `isSuperseded` applies on the Docker page.
    //
    // Matched on the build CONTEXT, which for a worktree build is the
    // worktree path itself, falling back to the recorded repo path.
    const owned = images.filter(
      (img) =>
        img.in_use === false &&
        img.origin !== null &&
        (img.origin.context === wt.path || img.origin.repo_path === wt.path),
    );

    items.push({
      repo: wt.path,
      branch: wt.branch,
      worktree: wt,
      images: owned,
      bytes: (wt.size_bytes ?? 0) + owned.reduce((n, i) => n + i.size_bytes, 0),
    });
  }

  return items;
}

/// Total bytes the manifest would reclaim.
export function cleanupBytes(items: CleanupItem[]): number {
  return items.reduce((n, i) => n + i.bytes, 0);
}
