import type { PullRequest } from "@/types/pr";
import { PrRow } from "@/components/PrRow";
import { useFilters } from "@/store/filters";
import { prKey } from "@/components/BulkBar";

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
  total,
  onOpen,
  canWrite = true,
  selectable = false,
}: {
  prs: PullRequest[];
  hasFilters?: boolean;
  /// GitHub's true match count when it exceeds the page size, else
  /// undefined. Shown so a truncated list never passes for a complete one.
  total?: number;
  /// Called with the clicked PR. Omitted where rows are not clickable.
  onOpen?: (pr: PullRequest) => void;
  canWrite?: boolean;
  selectable?: boolean;
}) {
  const { checked, setChecked, cursor } = useFilters();

  // Select-all acts on what is ON SCREEN, not the unfiltered list.
  // Selecting rows the user cannot see and then bulk-closing them is the
  // failure this avoids -- BulkBar deliberately reads the unfiltered
  // list so narrowing a filter cannot shrink a batch, which makes it all
  // the more important that the batch only ever grows from visible rows.
  const visibleKeys = prs.map(prKey);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => checked.includes(k));
  const someSelected = !allSelected && visibleKeys.some((k) => checked.includes(k));

  // Range selection lives HERE, not in the row: only the list knows the
  // order rows are rendered in, and a range is defined by that order.
  // ADDS to the selection rather than replacing it, so shift-clicking a
  // second range extends rather than discards the first.
  const selectRange = (from: string, to: string) => {
    const a = visibleKeys.indexOf(from);
    const b = visibleKeys.indexOf(to);
    if (a === -1 || b === -1) return;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    setChecked([...new Set([...checked, ...visibleKeys.slice(lo, hi + 1)])]);
  };

  const toggleAll = () => {
    if (allSelected) {
      // Clear only the visible ones, leaving any off-screen selection
      // the user made before filtering.
      setChecked(checked.filter((k) => !visibleKeys.includes(k)));
    } else {
      setChecked([...new Set([...checked, ...visibleKeys])]);
    }
  };

  return (
    <div className="rounded-md border border-[#30363d]">
      <div className="flex items-center justify-between border-b border-[#30363d] bg-[#161b22] px-4 py-3 text-sm">
        <span className="flex items-center gap-3 font-semibold text-[#e6edf3]">
          {selectable ? (
            <label className="flex items-center">
              <span className="sr-only">Select all</span>
              <input
                type="checkbox"
                checked={allSelected}
                // A partial selection is neither checked nor unchecked,
                // and only the DOM property can say so.
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleAll}
                className="h-4 w-4 cursor-pointer accent-[#1f6feb]"
              />
            </label>
          ) : null}
          {prs.length} Open
        </span>
        {total !== undefined && total > prs.length ? (
          <span className="text-xs text-[#d29922]">
            showing {prs.length} of {total} — GitHub returns at most 100
          </span>
        ) : null}
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
        prs.map((pr, i) => (
          <PrRow
            key={`${pr.repo}#${pr.number}`}
            pr={pr}
            onOpen={onOpen ? () => onOpen(pr) : undefined}
            canWrite={canWrite}
            selectable={selectable}
            onRange={selectRange}
            cursored={cursor === i}
          />
        ))
      )}
    </div>
  );
}
