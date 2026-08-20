import type { PullRequest } from "@/types/pr";
import { useFilters } from "@/store/filters";
import { repoCounts } from "@/lib/repos";

/// Repos where the user currently has open PRs, busiest first, plus an
/// always-first "All repositories" entry that is the default (no `repo`
/// filter set). Selecting a repo writes through the shared filter store --
/// this component holds no filter state of its own.
export function RepoSidebar({ prs }: { prs: PullRequest[] }) {
  const { filters, setFilter } = useFilters();
  const counts = repoCounts(prs);

  return (
    <nav className="w-64 shrink-0 border-r border-[#30363d] p-3">
      <button
        type="button"
        onClick={() => setFilter("repo", undefined)}
        className={`flex w-full items-center justify-between rounded px-3 py-2 text-sm ${
          !filters.repo ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
        }`}
      >
        <span>All repositories</span>
        <span>{prs.length}</span>
      </button>
      {counts.map(({ repo, count }) => (
        <button
          type="button"
          key={repo}
          onClick={() => setFilter("repo", repo)}
          className={`flex w-full items-center justify-between rounded px-3 py-2 text-sm ${
            filters.repo === repo ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
          }`}
        >
          <span className="truncate">{repo}</span>
          <span className="ml-2 shrink-0">{count}</span>
        </button>
      ))}
    </nav>
  );
}
