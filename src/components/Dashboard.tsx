import type { PullRequest } from "@/types/pr";
import { deriveStats } from "@/lib/derive";
import { useFilters } from "@/store/filters";
import { StatCard } from "@/components/StatCard";

/// Seven cards. Five are derived from the PR list already in memory and
/// cost no request -- the Rust `get_stats` command always returns zero for
/// them (see `deriveStats` in `@/lib/derive`). Only the two historical
/// counters, `merged_week`/`merged_month`, come from GitHub via
/// `useStats()`.
///
/// Every card is a triage entry point: clicking calls `applyPreset`, which
/// *replaces* the whole filter set and switches to the list view in one
/// atomic update. That's deliberate, not incidental -- a card click must
/// never inherit a filter the user forgot was active, or the number on the
/// card would disagree with what the list then shows. See `applyPreset` in
/// `@/store/filters`.
///
/// `applyPreset` does not carry over `filters.sort`, so every card click
/// resets sort to `sortPrs`'s default ("newest"). That's intentional: this
/// is a triage view, and "what's newest in this bucket" is the useful
/// starting order regardless of what the list was previously sorted by.
///
/// The two historical cards ("merged this week/month") have no
/// corresponding filter -- `usePullRequests()` only ever holds *open* PRs,
/// and `Filters` has no merged/state predicate, so there is no preset that
/// represents "PRs merged this week." Clicking them clears filters back to
/// the full open list (`applyPreset({})`) rather than doing nothing.
export function Dashboard({
  prs,
  stats,
}: {
  prs: PullRequest[];
  stats: { merged_week: number; merged_month: number };
}) {
  const derived = deriveStats(prs);
  const { applyPreset } = useFilters();

  return (
    <div className="grid grid-cols-2 gap-4 p-6 lg:grid-cols-4">
      <StatCard
        label="Merged this week"
        value={stats.merged_week}
        onClick={() => applyPreset({})}
      />
      <StatCard
        label="Merged this month"
        value={stats.merged_month}
        onClick={() => applyPreset({})}
      />
      <StatCard
        label="In merge queue"
        value={derived.in_merge_queue}
        onClick={() => applyPreset({ inMergeQueueOnly: true })}
      />
      <StatCard
        label="Needs rebase or red CI"
        value={derived.needs_attention}
        tone="danger"
        onClick={() => applyPreset({ needsAttentionOnly: true })}
      />
      <StatCard
        label="Green, awaiting review"
        value={derived.awaiting_review}
        tone="success"
        onClick={() => applyPreset({ awaitingReviewOnly: true })}
      />
      <StatCard
        label="Approved, needs queueing"
        value={derived.ready_to_queue}
        tone="success"
        onClick={() => applyPreset({ readyToQueueOnly: true })}
      />
      <StatCard
        label="Blocked by comments"
        value={derived.blocked_by_comments}
        tone="warn"
        onClick={() => applyPreset({ review: "changes_requested" })}
      />
    </div>
  );
}
