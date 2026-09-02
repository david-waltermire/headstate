import { ExternalLink } from "./ExternalLink";
import { copyText } from "../lib/clipboard";
import { Bot, Copy, ExternalLink as ExternalLinkIcon, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useActOnPr, useSetAutoMerge, useUpdatePrBranch } from "../api/hooks";
import type { PrActionName } from "../api/tauri";
import { inverseOf } from "../lib/undo";
import { agentPrompt, toAgentContext } from "../lib/agentPrompt";
import type { PullRequest } from "../types/pr";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// Why a row-level action is unavailable, or null when offered.
///
/// Greying out beats hiding. An absent "Merge" just looks broken, while
/// a disabled one carrying its reason teaches why -- and on a real
/// account this is the common case, not the edge: over half of a typical
/// open set is DIRTY or UNSTABLE at any moment.
///
/// The specific checks run before the general one so the tooltip names
/// the actual obstacle ("merge conflicts") rather than the catch-all.
/// Anything not listed here is left to GitHub, which refuses with a
/// toast -- better than guessing wrongly in the client.
function unavailable(pr: PullRequest, action: PrActionName): string | null {
  switch (action) {
    case "merge":
      if (pr.is_draft) return "drafts cannot be merged";
      if (pr.merge === "conflicted") return "merge conflicts";
      if (pr.merge === "checking") return "GitHub is still checking mergeability";
      if (pr.ci === "failure") return "checks are failing";
      if (pr.merge_status !== "clean") return "GitHub has not confirmed this can merge";
      return null;
    case "enqueue":
      // Enqueueing a PR that cannot merge is rejected by GitHub anyway;
      // saying so up front beats a toast after the round trip.
      if (pr.is_draft) return "drafts cannot be queued";
      if (pr.merge === "conflicted") return "merge conflicts";
      return null;
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

/// Row actions.
///
/// `canWrite` is false on the review view: merging or closing someone
/// else's pull request is usually not yours to do, and offering an action
/// that fails with a permissions error is worse than not offering it.
export function PrKebab({ pr, canWrite = true }: { pr: PullRequest; canWrite?: boolean }) {
  const act = useActOnPr();
  const updateBranch = useUpdatePrBranch();
  const setAuto = useSetAutoMerge();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PrActionName | null>(null);
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

  const run = (action: PrActionName) => {
    act(pr.id, pr.repo, pr.number, action).then(
      () => {
        const back = inverseOf(action);
        toast.success(`${pr.repo}#${pr.number} — ${VERB[action]}`, {
          // Only for actions with a true inverse. Merge and close are
          // deliberately absent -- see `inverseOf`.
          action: back
            ? {
                label: "Undo",
                onClick: () => {
                  void act(pr.id, pr.repo, pr.number, back).then(
                    () =>
                      toast.success(
                        `${pr.repo}#${pr.number} — ${VERB[back]}`,
                      ),
                    (e: unknown) =>
                      toast.error(`Could not undo #${pr.number}`, {
                        description: typeof e === "string" ? e : undefined,
                      }),
                  );
                },
              }
            : undefined,
        });
      },
      (e: unknown) =>
        toast.error(`Could not ${VERB[action]} #${pr.number}`, {
          description: typeof e === "string" ? e : undefined,
        }),
    );
  };

  const writes: PrActionName[] = pr.is_draft
    ? ["ready", "close"]
    : pr.in_merge_queue
      ? ["dequeue", "close"]
      : ["merge", "enqueue", "draft", "close"];

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Actions for #${pr.number}`}
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
          {canWrite
            ? writes.map((action) => {
                const why = unavailable(pr, action);
                return (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    disabled={why !== null}
                    title={why ?? LABEL[action]}
                    onClick={() => {
                      setOpen(false);
                      // Close confirms; everything else applies now.
                      if (action === "close") setPending(action);
                      else run(action);
                    }}
                    className={`flex w-full items-center rounded px-2 py-1.5 text-left text-sm ${
                      why
                        ? "text-[#8b949e] opacity-50"
                        : "text-[#e6edf3] hover:bg-[#21262d]"
                    }`}
                  >
                    {LABEL[action]}
                  </button>
                );
              })
            : null}

          {/* Only for BEHIND. On a DIRTY pull request this either fails or
              produces a conflicted merge commit, and an action that cannot
              work should not be offered at all -- unlike Merge, where the
              disabled-with-a-reason form teaches something. */}
          {/* The answer to the most common blocked state. On a real
              account 6 of 24 open PRs are UNSTABLE -- checks still
              running -- which is exactly "merge it the moment CI is
              green", and the only way to say so was to leave the app. */}
          {canWrite && pr.merge_status === "unstable" && !pr.is_draft ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setAuto(pr.id, pr.repo, pr.number, pr.head_oid, true).then(
                  () => toast.success(`${pr.repo}#${pr.number} will merge when green`),
                  (e: unknown) =>
                    toast.error(`Could not enable auto-merge on #${pr.number}`, {
                      description: typeof e === "string" ? e : undefined,
                    }),
                );
              }}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-[#e6edf3] hover:bg-[#21262d]"
            >
              Merge when green
            </button>
          ) : null}

          {canWrite && pr.merge_status === "behind" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                updateBranch(pr.id, pr.repo, pr.number, pr.head_oid).then(
                  () => toast.success(`${pr.repo}#${pr.number} updated from base`),
                  (e: unknown) =>
                    toast.error(`Could not update #${pr.number}`, {
                      description: typeof e === "string" ? e : undefined,
                    }),
                );
              }}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-[#e6edf3] hover:bg-[#21262d]"
            >
              Update branch
            </button>
          ) : null}

          {canWrite ? <div className="my-1 border-t border-[#30363d]" /> : null}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void copyText(agentPrompt(toAgentContext(pr))).then((failure) =>
                failure === null
                  ? toast.success("Prompt copied — paste it to an agent")
                  : toast.error("Could not copy the prompt", { description: failure }),
              );
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[#e6edf3] hover:bg-[#21262d]"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            Copy for agent
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void copyText(pr.head_ref).then((failure) =>
                failure === null
                  ? toast.success("Branch name copied")
                  : toast.error("Could not copy the branch name", {
                      description: failure,
                    }),
              );
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[#e6edf3] hover:bg-[#21262d]"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Copy branch name
          </button>
          <ExternalLink
            role="menuitem"
            href={pr.url}
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d]"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            View on GitHub
          </ExternalLink>
        </div>
      ) : null}

      {pending ? (
        <Dialog open onOpenChange={(o) => !o && setPending(null)}>
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
                  setPending(null);
                  run("close");
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
