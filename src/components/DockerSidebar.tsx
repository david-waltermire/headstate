import { BarChart3, Layers } from "lucide-react";
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
  const { setPanel, setView } = useFilters();

  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded px-3 py-2 text-sm ${
      active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
    }`;

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher counts={viewCounts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Builds no longer has its own page (#326). Its data was
            diagnostic rather than actionable -- a log with no button on
            it -- and both useful halves now sit where the decision is
            made: a build's duration and cache ratio on the image row it
            produced, and cache health beside the cache it describes.
            
            MEASURED before removing it: of 50 local builds, 41 matched
            a surviving image and the other 9 were superseded builds of
            targets that still appear among those 41. So nothing is
            hidden that the image rows do not already say. */}
        <button
          type="button"
          onClick={() => setPanel("list")}
          aria-pressed
          className={rowClass(true)}
        >
          <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
          Images
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
