import { useState } from "react";
import {
  useRemoveWorktree,
  useWorktreeSafety,
  useWorktreeSizes,
  useWorktrees,
} from "../api/hooks";
import {
  formatSize,
  isSafe,
  safetyReason,
  safetyTone,
  upstreamReason,
  upstreamTone,
} from "../lib/worktrees";
import { useActiveFilters, useFilters } from "../store/filters";
import type { Worktree } from "../types/pr";
import { toast } from "sonner";
import { QueryError, errorMessage } from "./QueryError";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// Local git worktrees, so lingering ones can be found and removed.
///
/// Sorted by size within a repo -- with 152 worktrees on one repository,
/// the biggest offenders are what you came for. But SAFETY is the primary
/// axis: every row says whether it can be removed and why not, because
/// 52 of 295 worktrees here hold commits that exist nowhere else.
function Row({
  wt,
  onRemove,
}: {
  wt: Worktree;
  onRemove: (wt: Worktree) => void;
}) {
  const safe = isSafe(wt.safety);
  return (
    <div className="flex items-baseline gap-3 border-b border-[#30363d] px-4 py-2.5 text-sm last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">
        {wt.path.split("/").pop()}
        {wt.branch ? (
          <span className="ml-2 text-xs text-[#8b949e]">{wt.branch}</span>
        ) : (
          <span className="ml-2 text-xs text-[#8b949e]">detached</span>
        )}
      </span>
      <span className={`shrink-0 text-xs ${safetyTone(wt.safety)}`}>
        {safetyReason(wt.safety)}
        {wt.merged_at ? (
          <span className="text-[#8b949e]"> · merged {wt.merged_at}</span>
        ) : null}
        {/* The main checkout's row said only what it was, while every
            other row earned its space. "Behind by 40" is also what
            explains why the worktrees below it are stale. */}
        {wt.upstream ? (
          <span className={upstreamTone(wt.upstream)}>
            {" · "}
            {upstreamReason(wt.upstream)}
          </span>
        ) : null}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums text-xs text-[#8b949e]">
        {formatSize(wt.size_bytes)}
      </span>
      {/* Genuinely disabled when not safe, not a warning to click past:
          52 of 296 worktrees here hold commits that exist nowhere else.
          The title explains WHY, so the row teaches rather than blocks. */}
      <button
        type="button"
        disabled={!safe}
        onClick={() => onRemove(wt)}
        title={safe ? "Remove this worktree" : safetyReason(wt.safety)}
        className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
          safe
            ? "border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
            : "border-[#30363d] text-[#8b949e] opacity-50"
        }`}
      >
        Remove
      </button>
    </div>
  );
}

/// Confirmation, naming the path and the branch.
///
/// A MODAL, not an inline banner: with 149 worktrees on one repository
/// the user clicks a row far down the page, and a prompt rendered at the
/// top is off-screen -- indistinguishable from nothing happening.
///
/// A count is not enough to act on safely either: the user needs to see
/// WHICH directory is about to disappear.
function ConfirmRemove({
  wt,
  onConfirm,
  onCancel,
}: {
  wt: Worktree;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Remove this worktree?</DialogTitle>
        <p className="mt-3 break-all font-mono text-xs text-[#8b949e]">{wt.path}</p>
        <p className="mt-2 text-sm text-[#8b949e]">
          Branch <span className="font-mono">{wt.branch || "detached"}</span> is merged and
          pushed
          {wt.merged_at ? <> (merged {wt.merged_at})</> : null}, so nothing is lost.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
          >
            Remove
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WorktreesPage() {
  const { data: repos, isLoading, isError, error, refetch } = useWorktrees();
  const filters = useActiveFilters();
  const { setFilter } = useFilters();

  const selected = repos?.find((r) => r.path === filters.repo) ?? repos?.[0];
  const { data: classified, isLoading: classifying } = useWorktreeSafety(selected?.path);
  const { data: sizes } = useWorktreeSizes(selected?.path);
  const remove = useRemoveWorktree();
  const [pending, setPending] = useState<Worktree | null>(null);

  if (isLoading) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
        Scanning for worktrees…
      </div>
    );
  }

  if (isError) {
    return (
      <QueryError
        title="Could not scan for worktrees"
        message={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center">
        <p className="text-sm font-semibold text-[#e6edf3]">No repositories found</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#8b949e]">
          Set the directories to scan in Settings, at the bottom right.
        </p>
      </div>
    );
  }

  // Classified data replaces the unclassified listing as it arrives, so
  // the page is useful immediately and gets more informative rather than
  // blocking on ~16s of git calls.
  // Sizes arrive last and are merged in here rather than refetching the
  // list, so the page never flickers back to unclassified.
  const shown = (classified ?? selected?.worktrees ?? [])
    .map((w) => ({ ...w, size_bytes: sizes?.get(w.path) ?? w.size_bytes }))
    .sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));

  const safeCount = shown.filter((w) => isSafe(w.safety)).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3 text-sm">
        <span className="font-semibold">{selected?.name}</span>
        <span className="text-[#8b949e]">
          {shown.length} worktree{shown.length === 1 ? "" : "s"}
        </span>
        {classifying ? (
          <span className="text-xs text-[#58a6ff]">checking what is safe to remove…</span>
        ) : (
          <span className="text-xs text-[#3fb950]">{safeCount} safe to remove</span>
        )}
        <button
          type="button"
          onClick={() => setFilter("repo", undefined)}
          className="ml-auto text-xs text-[#8b949e] hover:text-[#e6edf3]"
        >
          All repositories
        </button>
      </div>

      {/* Per worktree, not bulk. Bulk-deleting directories is where a
          wrong predicate becomes unrecoverable at scale, and with 149
          removable worktrees on one repo the temptation is real. */}
      {pending ? (
        <ConfirmRemove
          wt={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const target = pending;
            const name = target.path.split("/").pop() ?? target.path;
            setPending(null);
            remove(selected?.path ?? "", target.path).then(
              () => toast.success(`Removed ${name}`),
              // The backend re-checks safety at delete time, so a
              // worktree that went dirty since the scan is refused. That
              // message is the useful part -- show it, do not summarise.
              (e: unknown) =>
                toast.error(`Could not remove ${name}`, {
                  description: typeof e === "string" ? e : undefined,
                }),
            );
          }}
        />
      ) : null}

      <div className="rounded-md border border-[#30363d]">
        {shown.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[#8b949e]">
            No worktrees in this repository.
          </div>
        ) : (
          shown.map((wt) => <Row key={wt.path} wt={wt} onRemove={setPending} />)
        )}
      </div>
    </div>
  );
}
