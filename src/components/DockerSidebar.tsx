import { BarChart3, Hammer, Layers } from "lucide-react";
import { type View, useFilters } from "../store/filters";
import { ViewSwitcher } from "./ViewSwitcher";

/// The Docker view's own sidebar.
///
/// Not a mode of `WorktreeSidebar`: that one lists repositories with
/// worktrees, which has no meaning here. Docker's axis is Images versus
/// Builds -- two answers to different questions about the same machine.
export function DockerSidebar({
  viewCounts,
}: {
  viewCounts?: Partial<Record<View, number>>;
}) {
  const { panel, setPanel, setView } = useFilters();

  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded px-3 py-2 text-sm ${
      active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
    }`;

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher counts={viewCounts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Images is the disk problem; Builds is the provenance and the
            timing. Images leads because reclaiming space is why someone
            opens this view. */}
        <button
          type="button"
          onClick={() => setPanel("list")}
          aria-pressed={panel !== "builds"}
          className={rowClass(panel !== "builds")}
        >
          <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
          Images
        </button>
        <button
          type="button"
          onClick={() => setPanel("builds")}
          aria-pressed={panel === "builds"}
          className={rowClass(panel === "builds")}
        >
          <Hammer className="h-4 w-4 shrink-0" aria-hidden="true" />
          Builds
        </button>
      </div>

      {/* Stats belongs to My PRs, so selecting it also switches view. */}
      <div className="mt-2 shrink-0 border-t border-[#30363d] pt-2">
        <button
          type="button"
          onClick={() => {
            setView("my-prs");
            setPanel("stats");
          }}
          className={rowClass(false)}
        >
          <BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Stats
        </button>
      </div>
    </nav>
  );
}
