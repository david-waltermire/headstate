import { BarChart3 } from "lucide-react";
import { useWorktrees } from "../api/hooks";
import { type View, useActiveFilters, useFilters } from "../store/filters";
import { isOrphaned, ORPHAN_FILTER } from "../lib/worktrees";
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
  // Counted by EXCLUDING the main checkout, not by subtracting one.
  //
  // `n - 1` assumed every repository has a main checkout. An ORPHANED
  // worktree has exactly one entry and no main, so `n - 1` made it zero
  // -- which both undercounted the total and hid the row entirely.
  // MEASURED on a real machine: sidebar 121 against a rollup of 124,
  // with exactly 3 repositories having no main checkout.
  //
  // The rollup already counts this way (`rollup.ts` skips `is_main`),
  // so this makes one number out of what were two methods for the same
  // thing.
  const removable = (r: { worktrees: { is_main: boolean }[] }) =>
    r.worktrees.filter((w) => !w.is_main).length;
  // Same rule as the per-repo counts: the main checkout is not a
  // worktree anyone would remove, so it is not counted as one.
  const allCount = (repos ?? []).reduce((n, r) => n + removable(r), 0);
  // Repositories with nothing to act on are hidden. Most repositories
  // have no worktrees at any given moment, so listing them all made the
  // sidebar mostly rows that cannot be clicked usefully.
  //
  // The TOTAL is deliberately not filtered: it is already built from
  // `removable`, so hiding rows cannot change it -- and a total that
  // moved when rows were hidden would be a different number pretending
  // to be the same one.
  // Orphans are excluded here and given their own section below: an
  // orphan record IS a single worktree with no main checkout, so
  // without this it would appear both as a repository row and in the
  // Orphaned section -- counted once but listed twice.
  const withWorktrees = (repos ?? []).filter(
    (r) => removable(r) > 0 && !r.worktrees.some((w) => isOrphaned(w.safety)),
  );

  // Orphans get their own section rather than sitting among the repos.
  //
  // They are not a repository -- the repository is exactly what is
  // gone -- so listing them alongside real ones invites reading them as
  // ordinary. Grouped, they answer a question the per-repo rows cannot:
  // "what is on disk that nothing owns any more".
  const orphans = (repos ?? []).filter((r) =>
    r.worktrees.some((w) => isOrphaned(w.safety)),
  );
  const orphanCount = orphans.reduce(
    (n, r) => n + r.worktrees.filter((w) => isOrphaned(w.safety)).length,
    0,
  );

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
            <span className="ml-2 shrink-0">{removable(r)}</span>
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
        {/* Below the repositories, with a rule: it is a different
            KIND of thing, not another repo. Absent entirely when there
            are none, since a permanent empty heading trains the eye to
            skip it. */}
        {orphanCount > 0 ? (
          <div className="mt-2 border-t border-[#30363d] pt-2">
            <button
              type="button"
              onClick={() => setFilter("repo", ORPHAN_FILTER)}
              className={rowClass(filters.repo === ORPHAN_FILTER)}
            >
              <span className="truncate text-[#d29922]">Orphaned</span>
              <span className="ml-2 shrink-0">{orphanCount}</span>
            </button>
          </div>
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
