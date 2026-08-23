import type { Worktree, WorktreeRepo } from "@/types/pr";

/// A worktree carrying the repo it came from.
///
/// A flat list of 295 paths is unreadable without saying which repo each
/// belongs to, and the repo path is needed to act on the row at all --
/// git has to run from the repo, not the worktree.
export interface RolledWorktree extends Worktree {
  repoName: string;
  repoPath: string;
}

/// Every repo's worktrees as one list, biggest first.
///
/// "All repositories" previously fell through to `repos?.[0]` -- the
/// FIRST repo, which `sort_for_sidebar` makes the largest. So across 37
/// repos the one question the view could not answer was the one needing
/// every repo at once: where is my disk going, and what is safe to
/// delete anywhere?
///
/// Main checkouts are excluded. They are not worktrees anyone would
/// delete, and counting them makes every repo look like it holds one
/// more than it does.
export function rollupRepos(repos: WorktreeRepo[]): {
  worktrees: RolledWorktree[];
  totalBytes: number;
  /// False while any worktree has no size yet, so the total can be
  /// labelled as partial. An unmeasured size is null, and treating it as
  /// zero would report a confident total that is simply wrong.
  sizesComplete: boolean;
} {
  const worktrees: RolledWorktree[] = [];
  let totalBytes = 0;
  let sizesComplete = true;

  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (wt.is_main) continue;
      worktrees.push({ ...wt, repoName: repo.name, repoPath: repo.path });
      if (wt.size_bytes === null || wt.size_bytes === undefined) sizesComplete = false;
      else totalBytes += wt.size_bytes;
    }
  }

  // Largest first, because finding where the disk went is the point.
  // Unmeasured sorts ABOVE the smallest measured rows rather than to the
  // bottom: an unknown size is unknown, not small, and burying it would
  // hide the very rows still being measured.
  worktrees.sort((a, b) => {
    const aSize = a.size_bytes ?? Infinity;
    const bSize = b.size_bytes ?? Infinity;
    return bSize - aSize;
  });

  return { worktrees, totalBytes, sizesComplete };
}
