import type { PullRequest } from "@/types/pr";
import { PrRow } from "@/components/PrRow";

/// Renders PRs in whatever order it is given -- sorting is the caller's
/// responsibility (see `sortPrs` in `@/lib/derive`), so this component has
/// no opinion about ordering and doesn't drift from what the caller chose.
/// `hasFilters` distinguishes the two empty cases the old single string
/// conflated. With filters active, "nothing matches" is true and useful.
/// With NO filters active it was false and alarming: it read as a bug to a
/// user whose account genuinely has no open PRs, and told a reviewer-heavy
/// new user nothing about why their list is empty -- the app only ever
/// queries PRs they authored, and no rendered string said so.
export function PrList({
  prs,
  hasFilters = false,
}: {
  prs: PullRequest[];
  hasFilters?: boolean;
}) {
  return (
    <div className="rounded-md border border-[#30363d]">
      <div className="flex items-center justify-between border-b border-[#30363d] bg-[#161b22] px-4 py-3 text-sm">
        <span className="font-semibold text-[#e6edf3]">{prs.length} Open</span>
      </div>
      {prs.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-[#8b949e]">
          {hasFilters ? (
            "No pull requests match these filters."
          ) : (
            <>
              <p className="text-[#e6edf3]">No open pull requests.</p>
              <p className="mt-1">
                Headstate tracks pull requests you opened, across every repository you
                can access.
              </p>
            </>
          )}
        </div>
      ) : (
        prs.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />)
      )}
    </div>
  );
}
