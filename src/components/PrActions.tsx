import { useState } from "react";
import { toast } from "sonner";
import { useActOnPr } from "../api/hooks";
import type { PrActionName } from "../api/tauri";
import { inverseOf } from "../lib/undo";
import type { PrDetail } from "../types/pr";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// Why an action is unavailable, or null when it is offered.
///
/// Greying out with a REASON beats hiding: a disabled "Merge" that says
/// "checks failing" teaches, where an absent item just looks broken. That
/// matters here -- 14 of 25 open PRs on this account are DIRTY or
/// UNSTABLE, so merge is unavailable more often than not.
function unavailable(pr: PrDetail, action: PrActionName): string | null {
  switch (action) {
    case "merge":
      if (pr.is_draft) return "drafts cannot be merged";
      if (pr.merge_status === "dirty") return "merge conflicts";
      if (pr.merge_status === "blocked") return "a required review or check is missing";
      if (pr.merge_status === "unstable") return "checks are failing";
      if (pr.merge_status === "behind") return "the branch is behind its base";
      // Anything unrecognised, including `unknown`, is NOT mergeable:
      // enabling merge on a state we cannot read would ask GitHub to
      // reject it, or worse, succeed unexpectedly.
      if (pr.merge_status !== "clean") return "GitHub has not confirmed this can merge";
      return null;
    case "ready":
      return pr.is_draft ? null : "already ready for review";
    case "draft":
      return pr.is_draft ? "already a draft" : null;
    default:
      return null;
  }
}

const LABEL: Record<PrActionName, string> = {
  merge: "Merge",
  close: "Close",
  reopen: "Reopen",
  draft: "Convert to draft",
  ready: "Mark ready for review",
  enqueue: "Add to merge queue",
  dequeue: "Remove from merge queue",
};

export function PrActions({ pr }: { pr: PrDetail }) {
  const act = useActOnPr();
  const [pending, setPending] = useState<PrActionName | null>(null);
  const [busy, setBusy] = useState<PrActionName | null>(null);

  const run = (action: PrActionName) => {
    setBusy(action);
    act(pr.id, pr.repo, pr.number, action).then(
      () => {
        setBusy(null);
        const back = inverseOf(action);
        toast.success(`${pr.repo}#${pr.number} — ${LABEL[action].toLowerCase()}`, {
          // Only for actions with a true inverse. Merge and close are
          // deliberately absent -- see `inverseOf`.
          action: back
            ? {
                label: "Undo",
                onClick: () => {
                  setBusy(back);
                  void act(pr.id, pr.repo, pr.number, back).then(
                    () => {
                      setBusy(null);
                      toast.success(
                        `${pr.repo}#${pr.number} — ${LABEL[back].toLowerCase()}`,
                      );
                    },
                    (e: unknown) => {
                      setBusy(null);
                      toast.error(`Could not undo #${pr.number}`, {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                },
              }
            : undefined,
        });
      },
      (e: unknown) => {
        setBusy(null);
        // GitHub's refusal text is the useful part: "base branch was
        // modified" tells the user what to do, where a generic message
        // does not.
        toast.error(`Could not ${LABEL[action].toLowerCase()} #${pr.number}`, {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  /// Close confirms; everything else applies immediately. Merging is
  /// recoverable and is the action this app exists to speed up -- a
  /// dialog in front of it defeats the point.
  const invoke = (action: PrActionName) =>
    action === "close" ? setPending(action) : run(action);

  const offered: PrActionName[] = pr.is_draft
    ? ["ready", "close"]
    : ["merge", "enqueue", "draft", "close"];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {offered.map((action) => {
        const why = unavailable(pr, action);
        const primary = action === "merge";
        return (
          <button
            key={action}
            type="button"
            disabled={why !== null || busy !== null}
            onClick={() => invoke(action)}
            title={why ?? LABEL[action]}
            className={`rounded px-3 py-1.5 text-sm ${
              why
                ? "border border-[#30363d] text-[#8b949e] opacity-50"
                : primary
                  ? "bg-[#238636] font-medium text-white hover:bg-[#2ea043]"
                  : "border border-[#30363d] text-[#e6edf3] hover:bg-[#161b22]"
            }`}
          >
            {busy === action ? "Working…" : LABEL[action]}
          </button>
        );
      })}

      {/* The reason a disabled Merge is disabled, in the open rather than
          hidden in a tooltip nobody hovers. */}
      {unavailable(pr, "merge") && !pr.is_draft ? (
        <span className="text-xs text-[#8b949e]">Cannot merge: {unavailable(pr, "merge")}</span>
      ) : null}

      {pending ? (
        <Dialog open onOpenChange={(open) => !open && setPending(null)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>Close this pull request?</DialogTitle>
            <p className="mt-3 text-sm text-[#8b949e]">
              {pr.repo}#{pr.number} — {pr.title}
            </p>
            <p className="mt-2 text-sm text-[#8b949e]">
              Closing loses the review context. The branch is untouched, and the pull
              request can be reopened.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const a = pending;
                  setPending(null);
                  run(a);
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Close pull request
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
