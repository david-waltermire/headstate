import { Bot, MoreHorizontal, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Worktree } from "../types/pr";

/// Row actions for a worktree that has already been assessed.
///
/// The action cell holds ONE button by design — the row is dense, and a
/// fixed width keeps a label swap from reflowing every column (#393).
/// So the second action lives behind a kebab rather than beside the
/// first, the same shape `PrKebab` uses.
///
/// It exists because "I read the assessment" was a one-way door:
/// Claudify was replaced by "Remove anyway…", the mark persisted across
/// restarts, and the only thing that cleared it was the branch moving.
/// A single exploratory click permanently removed the only way to copy
/// that worktree's prompt.
export function WorktreeKebab({
  worktree,
  onClaudify,
  onForget,
}: {
  worktree: Worktree;
  onClaudify: (wt: Worktree) => void;
  onForget: (wt: Worktree) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#e6edf3] hover:bg-[#21262d]";

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`More actions for ${worktree.branch}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded border border-[#30363d] bg-[#161b22] p-1 shadow-lg"
        >
          {/* The whole point: needing the prompt again is normal. The
              terminal was closed, the paste was lost, the assessment
              wants rerunning. */}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onClaudify(worktree);
            }}
          >
            <Bot className="h-3 w-3" aria-hidden="true" />
            Copy the Claudify command
          </button>
          {/* Re-LOCKS the force-removal path, so it is the safe
              direction and needs no confirmation. */}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onForget(worktree);
            }}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Forget the assessment
          </button>
        </div>
      ) : null}
    </div>
  );
}
