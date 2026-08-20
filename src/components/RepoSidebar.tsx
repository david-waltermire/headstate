import { BarChart3, Eye } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { useFilters } from "@/store/filters";
import { repoCounts } from "@/lib/repos";

/// Repos where the user currently has open PRs, busiest first, plus an
/// always-first "All repositories" entry that is the default (no `repo`
/// filter set). Selecting a repo writes through the shared filter store --
/// this component holds no filter state of its own.
///
/// "Stats" is pinned to the bottom rather than sitting in the repo list:
/// it is a different kind of destination (a whole-account view, not a
/// repo), and the repo list above it grows with the number of repos you
/// have PRs in. A column layout with the list scrolling and Stats outside
/// the scroll area keeps it reachable at any repo count.
export function RepoSidebar({
  prs,
  reviewingCount = 0,
}: {
  prs: PullRequest[];
  reviewingCount?: number;
}) {
  const { filters, setFilter, view, setView } = useFilters();
  const counts = repoCounts(prs);

  const rowClass = (active: boolean) =>
    `flex w-full items-center justify-between rounded px-3 py-2 text-sm ${
      active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
    }`;

  // A repo is only "selected" while the list is showing. On the stats view
  // the sidebar highlight belongs to Stats, or two rows look active at once.
  const listActive = view === "list";

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => {
            setFilter("repo", undefined);
            setView("list");
          }}
          className={rowClass(listActive && !filters.repo)}
        >
          <span>All repositories</span>
          <span>{prs.length}</span>
        </button>
        {counts.map(({ repo, count }) => (
          <button
            type="button"
            key={repo}
            onClick={() => {
              setFilter("repo", repo);
              setView("list");
            }}
            className={rowClass(listActive && filters.repo === repo)}
          >
            <span className="truncate">{repo}</span>
            <span className="ml-2 shrink-0">{count}</span>
          </button>
        ))}
      </div>

      <div className="mt-2 shrink-0 border-t border-[#30363d] pt-2">
        {/* Incoming review requests: the queue the user is the bottleneck
            for. Pinned beside Stats rather than in the repo list because
            it spans repos, like Stats does. */}
        <button
          type="button"
          onClick={() => setView("reviewing")}
          aria-pressed={view === "reviewing"}
          className={rowClass(view === "reviewing")}
        >
          <span className="flex items-center gap-2">
            <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
            Awaiting your review
          </span>
          {reviewingCount > 0 ? <span>{reviewingCount}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => setView("dashboard")}
          aria-pressed={view === "dashboard"}
          className={rowClass(view === "dashboard")}
        >
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Stats
          </span>
        </button>
      </div>
    </nav>
  );
}
