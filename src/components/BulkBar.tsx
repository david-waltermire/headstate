import { useState } from "react";
import { toast } from "sonner";
import { useActOnPrs } from "../api/hooks";
import type { PrActionName } from "../api/tauri";
import { useFilters } from "../store/filters";
import type { PullRequest } from "../types/pr";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// Actions offered in bulk.
///
/// Merge is deliberately absent. Merging many pull requests at once --
/// each changing the base the next merges onto -- is how you get a
/// cascade of conflicts and broken CI on main. The merge queue exists to
/// serialise exactly that, so bulk *enqueue* is the safe expression of
/// the same intent.
const BULK: { action: PrActionName; label: string }[] = [
  { action: "enqueue", label: "Add to merge queue" },
  { action: "ready", label: "Mark ready" },
  { action: "draft", label: "Convert to draft" },
  { action: "close", label: "Close PRs" },
];

export function prKey(pr: { repo: string; number: number }): string {
  return `${pr.repo}#${pr.number}`;
}

/// The bar shown while rows are selected.
///
/// Every action confirms here, not just Close. A single merge applies
/// immediately because it is one deliberate click on one pull request;
/// a batch is a different act -- the count is the whole risk, and the
/// dialog is where the user sees which rows they actually picked up.
export function BulkBar({ prs }: { prs: PullRequest[] }) {
  const { checked, clearChecked } = useFilters();
  const actOnPrs = useActOnPrs();
  const [pending, setPending] = useState<PrActionName | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve keys back to PRs against the *unfiltered* list, so a filter
  // narrowed after selecting cannot silently shrink the batch.
  const selected = prs.filter((pr) => checked.includes(prKey(pr)));
  if (selected.length === 0) return null;

  const run = (action: PrActionName) => {
    setBusy(true);
    actOnPrs(
      selected.map((pr) => [pr.id, pr.repo, pr.number] as [string, string, number]),
      action,
    ).then(
      (outcomes) => {
        setBusy(false);
        const failed = outcomes.filter((o) => o.error !== null);
        const ok = outcomes.length - failed.length;
        // Never a bare "done": partial failure is the normal case, and a
        // single success message would hide the rejections.
        if (failed.length === 0) {
          toast.success(`${ok} pull request${ok === 1 ? "" : "s"} updated`);
          clearChecked();
        } else {
          toast.error(`${failed.length} of ${outcomes.length} failed`, {
            description: failed.map((f) => `${f.repo}#${f.number}: ${f.error}`).join("\n"),
          });
          // Keep the failures selected so they can be retried; drop the
          // ones that worked, or a retry would repeat them.
          const stillFailing = failed.map((f) => prKey(f));
          useFilters.getState().setChecked(stillFailing);
        }
      },
      (e: unknown) => {
        setBusy(false);
        toast.error("The batch could not run", {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  return (
    // Sticky because `<main>` is the scroll container and this bar
    // renders ABOVE the list: after scrolling down to check a row, the
    // bar you need to act on it had scrolled off the top. The worktrees
    // page already hit this and fixed it for its own confirm dialog.
    // `z-10` clears the rows; the opaque background stops text showing
    // through as they scroll under it.
    <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[#1f6feb] bg-[#0d1a2f] px-3 py-2 text-sm">
      <span className="font-medium">
        {selected.length} selected
      </span>
      <div className="ml-auto flex flex-wrap gap-2">
        {BULK.map(({ action, label }) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => setPending(action)}
            className="rounded border border-[#30363d] px-2 py-1 hover:bg-[#161b22] disabled:opacity-50"
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={clearChecked}
          className="rounded px-2 py-1 text-[#8b949e] hover:text-[#e6edf3]"
        >
          Clear
        </button>
      </div>

      {pending ? (
        <Dialog open onOpenChange={(o) => !o && setPending(null)}>
          <DialogContent className="max-w-2xl">
            <DialogTitle>
              {BULK.find((b) => b.action === pending)?.label} {selected.length} pull request
              {selected.length === 1 ? "" : "s"}?
            </DialogTitle>
            {/* The full list, not a count: "Close 12 pull requests?" is
                not something anyone can act on safely. */}
            <ul className="mt-3 max-h-64 overflow-y-auto text-sm text-[#8b949e]">
              {selected.map((pr) => (
                <li key={prKey(pr)} className="py-0.5">
                  {pr.repo}#{pr.number} — {pr.title}
                </li>
              ))}
            </ul>
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
                className={`rounded px-3 py-1.5 text-sm font-medium text-white ${
                  pending === "close"
                    ? "bg-[#da3633] hover:bg-[#f85149]"
                    : "bg-[#1f6feb] hover:bg-[#388bfd]"
                }`}
              >
                {BULK.find((b) => b.action === pending)?.label} {selected.length} pull request
                {selected.length === 1 ? "" : "s"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
