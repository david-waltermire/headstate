import { CheckCircle2 } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { splitByCourt } from "@/lib/court";

/// The glance: whose court is the ball in, right now.
///
/// The landing view answered "is anything on fire?" with a 12px muted
/// line reading "Nothing blocked on you", and then gave a six-control
/// filter toolbar the visual weight. The app KNOWS the answer -- the
/// tray badge is computed from the same predicates -- so the surface a
/// user opens first should say it plainly.
///
/// Spans BOTH lists. Every predicate behind this already existed, but
/// only as flat chips split across two separate views, so no single
/// screen could answer the question across authored and
/// review-requested pull requests at once.
export function CourtStrip({
  authored,
  reviewing,
  onSelect,
}: {
  authored: PullRequest[];
  reviewing: PullRequest[];
  /// Open the list scoped to one court. A card that cannot be acted on
  /// is decoration, so this is required rather than optional.
  onSelect: (court: "mine" | "theirs") => void;
}) {
  const { mine, theirs } = splitByCourt(authored, reviewing);
  // BOTH lists, because `mine` and `theirs` span both. Counting only
  // the authored list made the numerators and the denominator describe
  // different sets, so "36 needs you ... of 13 open" was not a
  // deliberate exclusion the reader could work out -- it was two
  // unrelated numbers in one sentence.
  //
  // Deduplicated on the same key `splitByCourt` uses: GitHub cannot
  // request a review from an author today, but the total must not
  // double-count if that ever changes, or it would exceed a sum of
  // parts that does not.
  const total = new Set(
    [...authored, ...reviewing].map((pr) => `${pr.repo}#${pr.number}`),
  ).size;

  if (mine.length === 0) {
    return (
      <section className="mb-4 flex items-center gap-2 rounded-md border border-[#3fb950]/40 bg-[#3fb950]/5 px-4 py-3">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[#3fb950]" aria-hidden="true" />
        <span className="text-sm font-medium text-[#e6edf3]">
          Nothing needs your attention
        </span>
        {/* The counts are what make an all-clear trustworthy: "0 of
            nothing" and "0 of 24" read very differently. */}
        <span className="text-xs text-[#8b949e]">
          {total} open
          {theirs.length > 0 ? ` · ${theirs.length} waiting on others` : ""}
        </span>
      </section>
    );
  }

  return (
    <section className="mb-4 flex flex-wrap items-baseline gap-3 rounded-md border border-[#f85149]/40 bg-[#f85149]/5 px-4 py-3">
      <button
        type="button"
        onClick={() => onSelect("mine")}
        className="text-sm font-semibold text-[#f85149] hover:underline"
      >
        {mine.length} needs you
      </button>
      {theirs.length > 0 ? (
        <button
          type="button"
          onClick={() => onSelect("theirs")}
          className="text-sm text-[#8b949e] hover:underline"
        >
          {theirs.length} waiting on others
        </button>
      ) : null}
      {/* The denominator, always. The two courts are NOT complements --
          a draft and a queued pull request are in neither -- so showing
          only "3 needs you · 6 waiting on others" against a sidebar
          reading 12 looks like an arithmetic bug rather than a
          deliberate exclusion. Naming the total makes the gap legible
          instead of suspicious. */}
      {/* Same SIZE as the counts beside it, with colour carrying the
          hierarchy instead. At `text-xs` against their `text-sm` the
          three parts sat on different baselines and read as a
          rendering bug rather than as context -- and they are one
          sentence. */}
      <span className="text-sm text-[#8b949e]">of {total} open</span>
    </section>
  );
}
