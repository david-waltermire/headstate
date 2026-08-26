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

/// What the TOAST says, as a verb phrase.
///
/// Separate from `LABEL` because the button and the sentence want
/// different words: the button says "Close PR" so it cannot be mistaken
/// for closing the view (it sits beside "Back to list"), while the toast
/// says "closed" -- `LABEL[action].toLowerCase()` would render "close pr".
const VERB: Record<PrActionName, string> = {
  merge: "merged",
  close: "closed",
  reopen: "reopened",
  draft: "converted to draft",
  ready: "marked ready for review",
  enqueue: "added to merge queue",
  dequeue: "removed from merge queue",
};

/// What the BUTTON says.
const LABEL: Record<PrActionName, string> = {
  merge: "Merge",
  close: "Close PR",
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
        toast.success(`${pr.repo}#${pr.number} — ${VERB[action]}`, {
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
                        `${pr.repo}#${pr.number} — ${VERB[back]}`,
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
        toast.error(`Could not ${VERB[action]} #${pr.number}`, {
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

  // ONE primary action, chosen by whether the base branch queues.
  //
  // Offering both Merge and "Add to merge queue" side by side asked the
  // user to know which one their repo needs -- and on a queue-enabled
  // branch, Merge is simply the wrong button. `isMergeQueueEnabled` is
  // per-pull-request, so this follows the base branch rather than a
  // repo-wide guess.
  //
  // `dequeue` replaces it entirely once the PR is queued: the only
  // useful action then is getting it back out.
  const primaryMerge: PrActionName = pr.in_merge_queue
    ? "dequeue"
    : pr.merge_queue_enabled
      ? "enqueue"
      : "merge";

  const offered: PrActionName[] = pr.is_draft
    ? ["ready", "close"]
    : [primaryMerge, "draft", "close"];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {offered.map((action) => {
        const why = unavailable(pr, action);
        const primary = action === primaryMerge && action !== "dequeue";
        // Closing a pull request is destructive and irreversible from
        // here (`inverseOf` deliberately gives close no undo), so it is
        // the one action that must not look like its neutral neighbours.
        const destructive = action === "close";
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
                  : destructive
                    ? "border border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
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
