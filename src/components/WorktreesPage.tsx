import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  useRemoveWorktree,
  useWorktreeSafety,
  useWorktreeSizes,
  useWorktrees,
} from "../api/hooks";
import {
  formatSize,
  canClaudify,
  isPending,
  isSafe,
  pathBasename,
  safetyReason,
  safetyTone,
  upstreamReason,
  upstreamShort,
  upstreamTone,
} from "../lib/worktrees";
import { claudifyCommand } from "../api/tauri";
import { relativeTime } from "../lib/time";
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
/// A shimmering placeholder sized to the text it stands in for.
///
/// Deliberately not a spinner per row: 289 spinners is a disco, and a
/// spinner says "something is happening" where a skeleton says "a value
/// belongs here and is coming". Respects prefers-reduced-motion via the
/// motion-safe: prefix -- an animation on every row is exactly what that
/// setting exists to stop.
function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-3 rounded bg-[#30363d] align-middle motion-safe:animate-pulse ${className}`}
    />
  );
}

function Row({
  wt,
  onRemove,
  onClaudify,
  sizePending,
  removing = false,
}: {
  wt: Worktree;
  onRemove: (wt: Worktree) => void;
  onClaudify: (wt: Worktree) => void;
  /// This row's removal is in flight. Per row, not per page: with 100+
  /// rows, freezing all of them because one is deleting would be worse
  /// than no feedback at all.
  removing?: boolean;
  /// Sizes arrive in their own pass, after safety. Tracked separately so
  /// a row whose safety has resolved does not keep waiting on its size.
  sizePending?: boolean;
}) {
  const safe = isSafe(wt.safety);
  const pending = isPending(wt.safety);
  const claudifiable = canClaudify(wt.safety);
  return (
    <div className="flex items-baseline gap-3 border-b border-[#30363d] px-4 py-2.5 text-sm last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">
        {pathBasename(wt.path)}
        {wt.branch ? (
          <span className="ml-2 text-xs text-[#8b949e]">{wt.branch}</span>
        ) : (
          <span className="ml-2 text-xs text-[#8b949e]">detached</span>
        )}
      </span>
      <span
        className={`shrink-0 text-xs ${safetyTone(wt.safety)}`}
        // The whole row is one live region while it fills in, so a
        // screen reader hears the resolved value once rather than
        // announcing each cell as it lands.
        aria-busy={pending || sizePending ? true : undefined}
      >
        {pending ? <Skeleton className="w-40" /> : safetyReason(wt.safety)}
        {wt.merged_at ? (
          <span className="text-[#8b949e]"> · merged {wt.merged_at}</span>
        ) : null}
        {/* The main checkout's row said only what it was, while every
            other row earned its space. "Behind by 40" is also what
            explains why the worktrees below it are stale. */}
        {/* The main checkout gets the long prose -- it is the only thing
            that line says. Every other row gets the compact arrow form,
            since it already carries name, branch, safety, and size. */}
        {wt.upstream && wt.is_main ? (
          <span className={upstreamTone(wt.upstream)}>
            {" · "}
            {upstreamReason(wt.upstream)}
          </span>
        ) : null}
        {wt.upstream && !wt.is_main && upstreamShort(wt.upstream) ? (
          <span className={upstreamTone(wt.upstream)}>
            {" · "}
            {upstreamShort(wt.upstream)}
          </span>
        ) : null}
        {/* How stale the work is -- distinct from merged_at, which says
            whether it is already accounted for. */}
        {wt.last_commit && !wt.is_main ? (
          <span className="text-[#8b949e]"> · {relativeTime(wt.last_commit)}</span>
        ) : null}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums text-xs text-[#8b949e]">
        {/* An em dash here read as "measured, and the answer is nothing".
            A skeleton says a number is still coming. */}
        {sizePending && wt.size_bytes === null ? (
          <Skeleton className="w-12" />
        ) : (
          formatSize(wt.size_bytes)
        )}
      </span>
      {/* One action per row, never two: the row is already dense. Safe
          rows get Remove; the 124 that cannot be removed get Claudify,
          which answers the question that actually applies to them --
          "is there anything in here worth keeping?" -- rather than
          showing a dead button that says the app will not help. */}
      {claudifiable ? (
        <button
          type="button"
          onClick={() => onClaudify(wt)}
          title={`Copy a prompt asking Claude Code to assess this worktree (${safetyReason(
            wt.safety,
          )})`}
          className="flex shrink-0 items-center gap-1 rounded border border-[#8957e5]/40 px-2 py-0.5 text-xs text-[#a371f7] hover:bg-[#8957e5]/10"
        >
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          Claudify
        </button>
      ) : (
        <button
          type="button"
          disabled={!safe || removing}
          onClick={() => onRemove(wt)}
          title={safe ? "Remove this worktree" : safetyReason(wt.safety)}
          className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
            safe && !removing
              ? "border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
              : "border-[#30363d] text-[#8b949e] opacity-50"
          }`}
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      )}
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
  const { data: sizes, isLoading: sizing } = useWorktreeSizes(selected?.path);
  const remove = useRemoveWorktree();

  /// Copy rather than spawn. The command lands in the user's own shell,
  /// where their config applies and `claude` resolves -- and there is no
  /// portable way to open "the user's terminal" anyway.
  const claudify = (wt: Worktree) => {
    claudifyCommand(selected?.path ?? "", wt.path, wt.branch).then(
      ({ command, claude_installed }) =>
        navigator.clipboard.writeText(command).then(
          () =>
            toast.success("Command copied", {
              // The user has to switch apps; this is the only place to
              // say so. And if Claude Code is missing, better to learn it
              // here than as a `command not found` after pasting.
              description: claude_installed
                ? "Paste it in your terminal to start the assessment."
                : "Paste it in your terminal. Claude Code was not found on this machine.",
            }),
          () => toast.error("Could not copy the command"),
        ),
      (e: unknown) =>
        toast.error("Could not build the command", {
          description: typeof e === "string" ? e : undefined,
        }),
    );
  };
  const [pending, setPending] = useState<Worktree | null>(null);
  /// The path currently being removed, or null. A path rather than a
  /// boolean so only the clicked row goes busy.
  const [removing, setRemoving] = useState<string | null>(null);

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
    // Sorting by size while sizes are still arriving would make rows jump
    // under the cursor -- a row you were about to click moves as its
    // number lands. Hold the stable path order until they are all in.
    .sort((a, b) =>
      sizing ? a.path.localeCompare(b.path) : (b.size_bytes ?? 0) - (a.size_bytes ?? 0),
    );

  const safeCount = shown.filter((w) => isSafe(w.safety)).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3 text-sm">
        <span className="font-semibold">{selected?.name}</span>
        <span className="text-[#8b949e]">
          {shown.length} worktree{shown.length === 1 ? "" : "s"}
        </span>
        {/* The count is withheld, not shown as a growing number: a
            "3 safe to remove" that climbs to 122 as rows resolve invites
            acting on a figure that was never the answer. */}
        {classifying ? (
          <span className="text-xs text-[#58a6ff]">checking what is safe to remove…</span>
        ) : (
          <span className="text-xs text-[#3fb950]">{safeCount} safe to remove</span>
        )}
        {!classifying && sizing ? (
          <span className="text-xs text-[#8b949e]">measuring sizes…</span>
        ) : null}
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
            const name = pathBasename(target.path);
            setPending(null);
            setRemoving(target.path);
            remove(selected?.path ?? "", target.path).then(
              () => {
                setRemoving(null);
                toast.success(`Removed ${name}`);
              },
              // The backend re-checks safety at delete time, so a
              // worktree that went dirty since the scan is refused. That
              // message is the useful part -- show it, do not summarise.
              (e: unknown) => {
                // Back to normal, not stuck on "Removing...": the backend
                // re-checks safety at delete time and legitimately
                // refuses a worktree that went dirty since the scan.
                setRemoving(null);
                toast.error(`Could not remove ${name}`, {
                  description: typeof e === "string" ? e : undefined,
                });
              },
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
          shown.map((wt) => (
            <Row
              key={wt.path}
              wt={wt}
              onRemove={setPending}
              onClaudify={claudify}
              sizePending={sizing}
              removing={removing === wt.path}
            />
          ))
        )}
      </div>
    </div>
  );
}
