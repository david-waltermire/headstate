import { BarChart3 } from "lucide-react";
import { useWorktrees } from "../api/hooks";
import { type View, useActiveFilters, useFilters } from "../store/filters";
import { ViewSwitcher } from "./ViewSwitcher";

/// Repos that have worktrees.
///
/// A separate component from `RepoSidebar` rather than a mode of it: that
/// one is driven by a `PullRequest[]` and counts open PRs, which has no
/// meaning here. Sharing the shell and the switcher is enough.
export function WorktreeSidebar({
  viewCounts,
}: {
  viewCounts?: Partial<Record<View, number>>;
}) {
  const { data: repos } = useWorktrees();
  const filters = useActiveFilters();
  const { setFilter, setView, setPanel } = useFilters();

  const rowClass = (active: boolean) =>
    `flex w-full items-center justify-between rounded px-3 py-2 text-sm ${
      active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
    }`;

  // Worktree count EXCLUDING the main checkout: it is not a worktree you
  // would ever remove, and counting it inflates every repo by one.
  const removable = (n: number) => Math.max(0, n - 1);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher counts={viewCounts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(repos ?? []).map((r) => (
          <button
            type="button"
            key={r.path}
            onClick={() => setFilter("repo", r.path)}
            className={rowClass(filters.repo === r.path)}
          >
            <span className="truncate">{r.name}</span>
            <span className="ml-2 shrink-0">{removable(r.worktrees.length)}</span>
          </button>
        ))}
        {repos?.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[#8b949e]">
            No repositories found. Check the scanned directories in Settings.
          </p>
        ) : null}
      </div>

      {/* Stats belongs to My PRs, so selecting it also switches view --
          otherwise the stats page would render beside a worktree sidebar
          listing repos it knows nothing about. */}
      <div className="mt-2 shrink-0 border-t border-[#30363d] pt-2">
        <button
          type="button"
          onClick={() => {
            setView("my-prs");
            setPanel("stats");
          }}
          className={rowClass(false)}
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
