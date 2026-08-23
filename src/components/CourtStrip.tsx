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
  const total = authored.length;

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
    <section className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-[#f85149]/40 bg-[#f85149]/5 px-4 py-3">
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
      ) : (
        <span className="text-xs text-[#8b949e]">{total} open</span>
      )}
    </section>
  );
}
