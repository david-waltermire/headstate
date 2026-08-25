import { CircleCheck } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { readyForReview } from "@/lib/derive";
import { ExternalLink } from "./ExternalLink";

/// Pinned above the review queue: what is ready to review right now.
///
/// The counterpart to `PrioritiesStrip` on My pull requests. That one
/// says what is blocked on you as an author; this says what a reviewer
/// can pick up without wasting anyone's time -- not a draft, checks
/// passed, no conflicts, nobody has reviewed it yet.
///
/// `readyForReview` is the single source of truth for the predicate.
/// Re-deriving it here would risk a second, drifting copy of a rule
/// that decides what a reviewer sees first.
///
/// The empty state is one quiet line rather than a card, matching the
/// attention strip: a section that shouts when there is nothing in it
/// stops being read, and then it fails on the day it matters.
export function ReadyStrip({
  prs,
  onOpen,
}: {
  prs: PullRequest[];
  /// Open a pull request's detail view. Optional so a caller with
  /// nowhere to send the user does not get a row that LOOKS clickable
  /// and is not -- the entry falls back to a plain link.
  onOpen?: (pr: PullRequest) => void;
}) {
  const ready = prs.filter(readyForReview);

  if (ready.length === 0) {
    return <p className="px-4 py-2 text-xs text-[#8b949e]">Nothing ready to review.</p>;
  }

  return (
    <section className="mb-4 rounded-md border border-[#3fb950]/40 bg-[#3fb950]/5">
      <h2 className="flex items-center gap-2 border-b border-[#3fb950]/30 px-4 py-2 text-sm font-semibold text-[#3fb950]">
        <CircleCheck className="h-4 w-4" aria-hidden="true" />
        Ready for review ({ready.length})
      </h2>
      <ul>
        {ready.map((pr) => (
          <li key={`${pr.repo}#${pr.number}`} className="text-sm">
            {onOpen ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpen(pr)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(pr);
                  }
                }}
                className="cursor-pointer px-4 py-2 hover:bg-[#3fb950]/10"
              >
                <span className="text-[#e6edf3]">{pr.title}</span>
                <span className="ml-2 text-xs text-[#8b949e]">
                  {pr.repo}#{pr.number} · {pr.author}
                </span>
              </div>
            ) : (
              <div className="px-4 py-2">
                <ExternalLink href={pr.url} className="text-[#e6edf3] hover:text-[#4493f8]">
                  {pr.title}
                </ExternalLink>
                <span className="ml-2 text-xs text-[#8b949e]">
                  {pr.repo}#{pr.number} · {pr.author}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
