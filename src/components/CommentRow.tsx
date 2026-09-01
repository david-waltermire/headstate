import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "./Markdown";
import { commentPreview } from "@/lib/preview";
import { relativeTime } from "@/lib/time";

/// One comment, collapsed to a single scannable line until opened.
///
/// The whole block of comments used to live inside ONE collapsible: it was
/// all fifty or none, so finding a particular comment meant expanding
/// everything and scrolling. Collapsing each one individually only helps if
/// the collapsed row says enough to pick from -- hence the body preview
/// beside the author, which is the only thing telling two comments by the
/// same person on the same day apart.
export function CommentRow({
  author,
  createdAt,
  body,
  defaultOpen = false,
}: {
  author: string;
  createdAt: string;
  body: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const preview = commentPreview(body);

  return (
    <div className="overflow-hidden rounded-md border border-[#30363d]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[#161b22]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <span className="shrink-0 font-semibold text-[#e6edf3]">{author}</span>
        <span className="shrink-0 text-[#8b949e]">{relativeTime(createdAt)}</span>
        {preview ? (
          <>
            <span className="shrink-0 text-[#8b949e]" aria-hidden="true">
              ·
            </span>
            {/* VISUALLY hidden once the body is on screen, but kept in the
                accessible name. Showing it would print the comment's first
                line twice, once truncated -- but removing it outright left
                an expanded row announcing only "alice 2 days ago", so a
                screen reader user could not tell which comment they had
                just opened, and every expanded toggle on the page sounded
                alike.

                `min-w-0` is what lets `truncate` work: a flex child
                defaults to `min-width: auto`, so without it the preview
                widens the row instead of ellipsing. */}
            <span
              className={
                open
                  ? "sr-only"
                  : "min-w-0 flex-1 truncate text-[#8b949e]"
              }
            >
              {preview}
            </span>
          </>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-[#30363d] p-3">
          <Markdown>{body}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
