import { AlertTriangle } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { needsAttention } from "@/lib/derive";

/// Pinned above the list on every page. Contains only PRs blocked on the
/// author and nobody else: real merge conflicts, or failing CI.
///
/// `needsAttention` (Task 13) is the single source of truth for that
/// predicate -- it structurally excludes `merge === "checking"`, the same
/// rule enforced independently in `src-tauri/src/github/map.rs` and in
/// `PrRow`'s rendering. Re-deriving the condition here would risk a fifth,
/// diverging copy of a rule that must never drift.
///
/// The empty state is one quiet line, not a card: a strip that shouts when
/// nothing is wrong stops being read -- and then it fails on the day it
/// matters.
/// Every reason, not just the first. A ternary here would report only
/// "merge conflicts" for a PR that is also red -- so you would fix the
/// rebase, come back, and only then discover CI was failing too. Two of the
/// author's own open PRs were in exactly that state when this was written.
function blockedReasons(pr: PullRequest): string[] {
  const reasons: string[] = [];
  if (pr.merge === "conflicted") reasons.push("merge conflicts");
  if (pr.ci === "failure") reasons.push("CI failing");
  return reasons;
}

export function PrioritiesStrip({ prs }: { prs: PullRequest[] }) {
  const blocked = prs.filter(needsAttention);

  if (blocked.length === 0) {
    return (
      <p className="px-4 py-2 text-xs text-[#8b949e]">Nothing blocked on you.</p>
    );
  }

  return (
    <section className="mb-4 rounded-md border border-[#f85149]/40 bg-[#f85149]/5">
      <h2 className="flex items-center gap-2 border-b border-[#f85149]/30 px-4 py-2 text-sm font-semibold text-[#f85149]">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Needs your attention ({blocked.length})
      </h2>
      <ul>
        {blocked.map((pr) => (
          <li key={`${pr.repo}#${pr.number}`} className="px-4 py-2 text-sm">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-[#e6edf3] hover:text-[#4493f8]"
            >
              {pr.title}
            </a>
            <span className="ml-2 text-xs text-[#8b949e]">
              {pr.repo}#{pr.number} — {blockedReasons(pr).join(" and ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
