import type { Assessment } from "@/types/pr";

/// One line summarising what a worktree is holding.
///
/// Reads left to right in the order a person decides: how much work,
/// how old, and whether it exists anywhere but this machine. That last
/// one is the fact that actually decides whether deleting is
/// recoverable, so it is never abbreviated away.
///
/// Every field is optional on the Rust side -- git can fail to answer
/// any of them -- and an absent number is SKIPPED rather than rendered
/// as zero. "0 commits ahead" and "we could not count" are opposite
/// answers, and printing the first for the second is exactly the
/// confident-wrong-answer failure this codebase keeps guarding against.
export function assessmentSummary(a: Assessment): string {
  const parts: string[] = [];

  if (a.commits_ahead !== null) {
    parts.push(`${a.commits_ahead} commit${a.commits_ahead === 1 ? "" : "s"} ahead`);
  }
  if (a.files_changed !== null) {
    parts.push(`${a.files_changed} file${a.files_changed === 1 ? "" : "s"}`);
  }
  // Only when at least one side is known, and each side independently:
  // git reports insertions and deletions together, but a diff of pure
  // deletions genuinely has no insertions line.
  if (a.insertions !== null || a.deletions !== null) {
    parts.push(`+${a.insertions ?? 0}/-${a.deletions ?? 0}`);
  }
  if (a.last_activity !== null) parts.push(a.last_activity);
  if (!a.has_upstream) parts.push("never pushed");

  return parts.join(" · ");
}
