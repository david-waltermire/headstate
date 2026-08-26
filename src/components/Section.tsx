import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/// A titled, collapsible block in the PR detail view.
///
/// The detail view was one flat column of full-width panels: description,
/// checks, comments, all expanded, all the same weight. Long PRs became a
/// wall you had to scroll past to reach anything.
///
/// `defaultOpen` rather than a controlled prop: which sections matter
/// differs per pull request, and remembering a per-section preference
/// across PRs would be wrong more often than right -- a collapsed
/// Checks is useful on the PR you just read, not on the next one.
export function Section({
  title,
  count,
  aside,
  defaultOpen = true,
  children,
}: {
  title: string;
  /// Shown beside the title, so a collapsed section still says how much
  /// it is hiding. That is what makes collapsing safe rather than a way
  /// to lose things.
  count?: number;
  /// An action belonging to this section (e.g. "Re-run failed"), kept
  /// out of the toggle so clicking it does not collapse the section.
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="overflow-hidden rounded-md border border-[#30363d]">
      <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#0d1117] px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-[#e6edf3]"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden="true"
          />
          {title}
          {count !== undefined ? (
            <span className="font-normal text-[#8b949e]">{count}</span>
          ) : null}
        </button>
        {aside}
      </div>
      {/* Unmounted rather than hidden: a collapsed section of fifty
          comments should not stay in the layout, and Markdown bodies are
          the expensive part of this view to render. */}
      {open ? <div className="p-3">{children}</div> : null}
    </section>
  );
}
