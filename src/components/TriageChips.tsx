import type { PullRequest } from "@/types/pr";
import type { Filters } from "@/lib/derive";
import { deriveStats, hasUnresolvedThreads, isStale } from "@/lib/derive";
import { useActiveFilters, useFilters } from "@/store/filters";

/// Clickable counters above the list.
///
/// `applyFilters` has supported these five predicates since M3 and
/// `deriveStats` has counted four of them, but nothing rendered either --
/// the triage knowledge existed, was tested, and had no surface. This is
/// the surface. Counts come from the SAME predicates the filters apply, so
/// a chip's number can never disagree with the list it opens.
///
/// Each chip REPLACES the filter set rather than adding to it, so a click
/// never inherits a filter the user forgot was active and lands on a list
/// that contradicts the count they just clicked. `repo` is carried through
/// because it is navigation, not a filter.
const CHIPS: {
  key: string;
  label: string;
  preset: Filters;
  count: (prs: PullRequest[], now: Date) => number;
  tone: string;
}[] = [
  {
    key: "attention",
    label: "Need attention",
    preset: { needsAttentionOnly: true },
    count: (prs) => deriveStats(prs).needs_attention,
    tone: "text-[#f85149] border-[#f85149]/40",
  },
  {
    key: "awaiting",
    label: "Awaiting review",
    preset: { awaitingReviewOnly: true },
    count: (prs) => deriveStats(prs).awaiting_review,
    tone: "text-[#58a6ff] border-[#58a6ff]/40",
  },
  {
    key: "queue",
    label: "Ready to queue",
    preset: { readyToQueueOnly: true },
    count: (prs) => deriveStats(prs).ready_to_queue,
    tone: "text-[#3fb950] border-[#3fb950]/40",
  },
  {
    key: "unresolved",
    label: "Unresolved comments",
    preset: { unresolvedOnly: true },
    count: (prs) => prs.filter(hasUnresolvedThreads).length,
    tone: "text-[#d29922] border-[#d29922]/40",
  },
  {
    key: "stale",
    label: "Stale",
    preset: { staleOnly: true },
    // `isStale` is documented as the most nudge-worthy state and the one
    // no other filter surfaces, yet its only UI was a wizard checkbox.
    count: (prs, now) => prs.filter((p) => isStale(p, now)).length,
    tone: "text-[#d29922] border-[#d29922]/40",
  },
];

export function TriageChips({ prs, now = new Date() }: { prs: PullRequest[]; now?: Date }) {
  const filters = useActiveFilters();
  const { applyPreset } = useFilters();
  const active = CHIPS.filter((c) => c.count(prs, now) > 0);
  if (active.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {active.map((chip) => {
        const isOn = Object.keys(chip.preset).every(
          (k) => filters[k as keyof Filters] === true,
        );
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={isOn}
            onClick={() =>
              applyPreset(
                isOn
                  ? filters.repo
                    ? { repo: filters.repo }
                    : {}
                  : { ...chip.preset, ...(filters.repo ? { repo: filters.repo } : {}) },
              )
            }
            className={`rounded-full border px-3 py-1 text-xs ${chip.tone} ${
              isOn ? "bg-[#161b22]" : "hover:bg-[#161b22]"
            }`}
          >
            <span className="font-semibold tabular-nums">{chip.count(prs, now)}</span>{" "}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
