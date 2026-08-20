import type { PullRequest } from "@/types/pr";
import { PrRow } from "@/components/PrRow";

/// Renders PRs in whatever order it is given -- sorting is the caller's
/// responsibility (see `sortPrs` in `@/lib/derive`), so this component has
/// no opinion about ordering and doesn't drift from what the caller chose.
export function PrList({ prs }: { prs: PullRequest[] }) {
  return (
    <div className="rounded-md border border-[#30363d]">
      <div className="flex items-center justify-between border-b border-[#30363d] bg-[#161b22] px-4 py-3 text-sm">
        <span className="font-semibold text-[#e6edf3]">{prs.length} Open</span>
      </div>
      {prs.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-[#8b949e]">
          No pull requests match these filters.
        </div>
      ) : (
        prs.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />)
      )}
    </div>
  );
}
