import type { PullRequest } from "@/types/pr";

/// Only repos where the user currently has open PRs, busiest first. Ties
/// break alphabetically on repo name so the order is deterministic across
/// polls -- otherwise two repos tied on count could visibly swap places on
/// every refresh for no reason a user could see.
///
/// A pure function over `PullRequest[]` rather than something owned by
/// `RepoSidebar`: the nudge wizard (Task 20) needs the same counts, and a
/// component importing a helper from a sibling component is a layering
/// smell that only gets worse as more consumers appear.
export function repoCounts(prs: PullRequest[]): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const pr of prs) counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
  return [...counts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}
