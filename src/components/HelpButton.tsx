import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Markdown } from "./Markdown";
import { HELP_TOPICS, type HelpTopicId } from "@/help/topics";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";

/// A `?` beside something whose rule is not visible from looking at it.
///
/// A Sheet rather than a tooltip because help here is occasional but
/// sometimes long: the safety rules behind removing a worktree run to
/// several paragraphs, and there is nowhere in a row to put them. The
/// app's existing affordances cannot carry that -- a `title=` is
/// invisible until hovered, unreachable by keyboard, and truncated by
/// the OS; a toast is gone in four seconds.
///
/// Used SPARINGLY on purpose. A `?` beside every label is noise that
/// teaches people to ignore all of them, so its presence has to mean
/// "there is a rule here you cannot guess".
export function HelpButton({ topic }: { topic: HelpTopicId }) {
  const [open, setOpen] = useState(false);
  const { title, body } = HELP_TOPICS[topic];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // The topic's own title, prefixed. A bare "Help" repeated
        // across a page says nothing about which one to press, but the
        // bare title collides with the control it explains: "What makes
        // a worktree safe to remove" matched a query for the Remove
        // button, for a screen reader as much as for a test.
        //
        // Topic titles are therefore noun phrases without action verbs,
        // and this prefix makes the element's ROLE unambiguous.
        aria-label={`About ${title.charAt(0).toLowerCase()}${title.slice(1)}`}
        // `align-middle` and a fixed size keep the glyph from shifting
        // the baseline of the heading it sits beside.
        className="ml-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center align-middle text-[#8b949e] hover:text-[#e6edf3]"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {/* The same renderer the app uses for pull request bodies, so
            it is sanitized and styled identically. */}
        <div className="px-4 pb-6">
          <Markdown>{body}</Markdown>
        </div>
      </SheetContent>
    </Sheet>
  );
}
