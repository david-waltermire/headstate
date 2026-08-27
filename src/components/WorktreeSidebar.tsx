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
  // Same rule as the per-repo counts: the main checkout is not a
  // worktree anyone would remove, so it is not counted as one.
  const allCount = (repos ?? []).reduce((n, r) => n + removable(r.worktrees.length), 0);
  // Repositories with nothing to act on are hidden. Most repositories
  // have no worktrees at any given moment, so listing them all made the
  // sidebar mostly rows that cannot be clicked usefully.
  //
  // The TOTAL is deliberately not filtered: it is already built from
  // `removable`, so hiding rows cannot change it -- and a total that
  // moved when rows were hidden would be a different number pretending
  // to be the same one.
  const withWorktrees = (repos ?? []).filter((r) => removable(r.worktrees.length) > 0);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher counts={viewCounts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Missing entirely before: with no "all" entry, clearing the
            repo filter fell through to `repos?.[0]` and silently showed
            the FIRST repo -- so across 37 repos there was no way to ask
            where the disk went. RepoSidebar has had a real all-repos row
            all along. */}
        <button
          type="button"
          onClick={() => setFilter("repo", undefined)}
          className={rowClass(!filters.repo)}
        >
          <span>All repositories</span>
          <span className="ml-2 shrink-0">{allCount}</span>
        </button>
        {withWorktrees.map((r) => (
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
        {/* Distinct from "no repositories found": the scan worked and
            found repositories, they simply have no worktrees. Rendering
            a blank list instead would read as a failed scan, which is a
            different and more alarming thing. */}
        {repos !== undefined && repos.length > 0 && withWorktrees.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[#8b949e]">
            No worktrees in any scanned repository.
          </p>
        ) : null}
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
