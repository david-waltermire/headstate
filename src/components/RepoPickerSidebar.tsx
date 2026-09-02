import { useWorktrees } from "@/api/hooks";
import { useActiveFilters, useFilters } from "@/store/filters";
import { ViewSwitcher } from "./ViewSwitcher";

/// A plain repository list, for views whose only axis is "which repo".
///
/// Separate from `WorktreeSidebar`, which decorates its rows with
/// worktree counts and an Orphaned section, and from
/// `ArtifactSidebar`, which groups by artifact kind. Those carry
/// information this does not have, and bending either into a shared
/// component would mean passing empty decorations through it.
export function RepoPickerSidebar({ reviewingCount }: { reviewingCount: number }) {
  const filters = useActiveFilters();
  const { setFilter } = useFilters();
  // The SAME repository list the worktree view uses -- one scan, one
  // source of truth for what exists in the monitored directories.
  const { data: repos = [] } = useWorktrees();

  const rowClass = (active: boolean) =>
    `flex w-full items-center justify-between rounded px-3 py-2 text-sm ${
      active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
    }`;

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher counts={{ "to-review": reviewingCount }} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {repos.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[#8b949e]">
            No repositories found in the scanned folders.
          </p>
        ) : null}
        {repos.map((r) => (
          <button
            type="button"
            key={r.path}
            onClick={() => setFilter("repo", r.path)}
            className={rowClass(filters.repo === r.path)}
          >
            <span className="truncate">{r.name}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
