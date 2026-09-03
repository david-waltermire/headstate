import { ExternalLink } from "./ExternalLink";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  useClearAssessed,
  useMarkAssessed,
  useRemoveWorktree,
  useAssessed,
  usePullRequests,
  useRemoveWorktreeForced,
  useRemoveWorktrees,
  useWorktreeSafety,
  useWorktreeSizes,
  useWorktrees,
  usePullCheckout,
  useRemoveOrphan,
  useAllWorktreeSizes,
  useRemovalProgress,
  useAssessment,
} from "../api/hooks";
import {
  formatSize,
  canClaudify,
  isPending,
  isSafe,
  pathBasename,
  prForWorktree,
  worktreeSignal,
  isOrphaned,
  ORPHAN_FILTER,
  safetyReason,
  safetyTone,
  upstreamReason,
  upstreamShort,
  upstreamTone,
} from "../lib/worktrees";
import { HelpButton } from "./HelpButton";
import { WorktreeKebab } from "./WorktreeKebab";
import { claudifyCommand } from "../api/tauri";
import { copyText } from "../lib/clipboard";
import { relativeTime } from "../lib/time";
import { assessmentSummary } from "../lib/assessment";
import { rollupRepos } from "../lib/rollup";
import { useActiveFilters, useFilters } from "../store/filters";
import type { PullRequest, Worktree } from "../types/pr";
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
  repoPath,
  pr,
  onRemove,
  onClaudify,
  onForget,
  sizePending,
  removing = false,
  assessed = false,
  onForce,
  onRemoveOrphan,
  onPull,
  pulling = false,
}: {
  wt: Worktree;
  /// The open pull request for this worktree, when there is one.
  /// DISPLAY ONLY -- it never feeds a safety gate.
  pr?: PullRequest | null;
  onRemove: (wt: Worktree) => void;
  onClaudify: (wt: Worktree) => void;
  onForget: (wt: Worktree) => void;
  /// This row's removal is in flight. Per row, not per page: with 100+
  /// rows, freezing all of them because one is deleting would be worse
  /// than no feedback at all.
  removing?: boolean;
  /// This worktree has been handed to Claude Code and the branch has not
  /// moved since. Unlocks the override.
  assessed?: boolean;
  onForce: (wt: Worktree) => void;
  /// Delete an orphaned directory. A different call from `onRemove`:
  /// git cannot remove a worktree whose repository is gone.
  onRemoveOrphan: (wt: Worktree) => void;
  /// Sizes arrive in their own pass, after safety. Tracked separately so
  /// a row whose safety has resolved does not keep waiting on its size.
  sizePending?: boolean;
  /// The repo this worktree belongs to. Needed to assess it: git has to
  /// be run from the repo, not the worktree.
  repoPath: string;
  /// Fast-forward this checkout. Only ever called for the main one.
  onPull: (wt: Worktree) => void;
  /// This row's pull is in flight. Per row, like `removing`.
  pulling?: boolean;
}) {
  const safe = isSafe(wt.safety);
  const orphaned = isOrphaned(wt.safety);
  // `Safety` already answers "is this dirty, and by how much" -- reusing
  // it means the button's reason cannot disagree with the row's own
  // explanation of the same checkout.
  const dirtyCount = wt.safety.kind === "dirty" ? wt.safety.detail : null;
  const pending = isPending(wt.safety);
  const claudifiable = canClaudify(wt.safety);
  const signal = worktreeSignal(pr);
  // Fetched only once a row is opened: several git calls each, and
  // there can be hundreds of rows on screen.
  const [open, setOpen] = useState(false);
  const { data: assessment, isLoading: assessing } = useAssessment(
    open ? repoPath : null,
    open ? wt.path : null,
    open ? wt.branch : null,
  );
  return (
    <div className="border-b border-[#30363d] last:border-b-0">
    <div className="flex items-baseline gap-3 px-4 py-2.5 text-sm">
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
        //
        // `aria-live` is what makes that true. `aria-busy` alone is
        // INERT on a non-live element -- it suppresses announcements
        // from a live region, so without the pairing the comment above
        // described an intent the markup never carried out.
        aria-live="polite"
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
        {/* The app already holds GitHub's answer for this branch and
            never showed it here. Display only: a wrong pairing must not
            be able to authorise a deletion. */}
        {pr ? (
          <ExternalLink
            href={pr.url}
            className="text-[#58a6ff] hover:underline"
          >
            {" · "}#{pr.number}
          </ExternalLink>
        ) : null}
        {/* Why you would come back to this checkout. Display only, like
            the number itself: a wrong pairing must never authorise a
            deletion. Costs no new call -- every field read here is
            already on the pull request resolved above. */}
        {signal ? (
          <span className={signal.className}> · {signal.label}</span>
        ) : null}
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
      {/* A FIXED-WIDTH action cell. The button in it changes label --
          "Claudify" becomes the wider "Remove anyway…" once assessed --
          and without a reserved width that swap re-flowed every column
          in the table. A row's layout should not depend on which action
          it currently offers. */}
      {/* Fixed width still, but wider: the assessed state now holds a
          button AND a kebab, and the point of the fixed cell is that a
          row's layout never depends on which action it offers. */}
      <span className="flex w-40 shrink-0 items-center justify-end gap-1">
      {claudifiable && assessed ? (
        // Only after an assessment of THIS worktree. Otherwise this is a
        // "delete anything" button with extra steps.
        //
        // The kebab beside it is the way BACK. Marking an assessment
        // used to be a one-way door: it replaced Claudify, persisted
        // across restarts, and cleared only when the branch moved -- so
        // one exploratory click permanently removed the only route to
        // that worktree's prompt. Needing the prompt again is normal.
        <>
          <button
            type="button"
            onClick={() => onForce(wt)}
            title="You assessed this worktree — remove it despite the safety gate"
            className="shrink-0 rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10"
          >
            Remove anyway…
          </button>
          <WorktreeKebab worktree={wt} onClaudify={onClaudify} onForget={onForget} />
        </>
      ) : claudifiable ? (
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
          // An ORPHAN is removable too, by a different route: git
          // cannot remove it (its repository is gone), so the Rust side
          // deletes the directory after re-checking that it is still
          // orphaned. Gating it on `safe` left the user looking at 2.5
          // GB they were told about and could not act on.
          disabled={(!safe && !orphaned) || removing}
          onClick={() => (orphaned ? onRemoveOrphan(wt) : onRemove(wt))}
          title={
            orphaned
              ? "Delete this directory — its repository is gone, so nothing about the contents can be checked first"
              : safe
                ? "Remove this worktree"
                : safetyReason(wt.safety)
          }
          className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
            (safe || orphaned) && !removing
              ? "border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
              : "border-[#30363d] text-[#8b949e] opacity-50"
          }`}
        >
          {removing ? "Removing…" : orphaned ? "Delete" : "Remove"}
        </button>
      )}
      </span>
      {/* The disclosure, not a second action: the row keeps its
          one-action rule and this only reveals what the app already
          knows. */}
      {/* The main checkout reports how far behind it is and, until now,
          offered no way to act on it -- so fixing it meant leaving the
          app for a terminal, which is the thing this view exists to
          avoid. Its staleness is also what makes the worktrees below it
          stale.

          Disabled rather than hidden when the tree is dirty, with the
          reason in the title: an absent button just looks broken, while
          a greyed one that says "3 uncommitted files" teaches. Same
          rule `PrActions` applies to an unavailable merge. */}
      {wt.is_main ? (
        <button
          type="button"
          disabled={dirtyCount !== null || pulling}
          onClick={() => onPull(wt)}
          title={
            dirtyCount !== null
              ? `${dirtyCount} uncommitted file${dirtyCount === 1 ? "" : "s"} — commit or stash first`
              : "Fast-forward this checkout to its upstream"
          }
          className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
            dirtyCount !== null || pulling
              ? "border-[#30363d] text-[#8b949e] opacity-50"
              : "border-[#30363d] text-[#e6edf3] hover:bg-[#161b22]"
          }`}
        >
          {pulling ? "Updating…" : "Update to latest"}
        </button>
      ) : null}
      {/* Beside the action, since its two limits -- refuses on a dirty
          tree, never merges -- are not guessable from the label. */}
      {wt.is_main ? (
        <HelpButton topic="update-checkout" />
      ) : null}
      {claudifiable ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`What is in ${pathBasename(wt.path)}`}
          className="shrink-0 rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] hover:bg-[#161b22]"
        >
          {open ? "Hide" : "What's in it?"}
        </button>
      ) : null}
    </div>
    {open ? (
      <div className="px-4 pb-2.5 text-xs text-[#8b949e]">
        {assessing ? (
          "Reading…"
        ) : assessment ? (
          <>
            {/* An empty summary means git answered none of it, which is
                worth saying rather than rendering a blank line. */}
            <p>{assessmentSummary(assessment) || "Nothing could be measured here."}</p>
            {assessment.subjects.length > 0 ? (
              <ul className="mt-1 list-inside list-disc">
                {assessment.subjects.map((subject, i) => (
                  <li key={`${i}-${subject}`} className="truncate">
                    {subject}
                  </li>
                ))}
                {assessment.subjects_elided > 0 ? (
                  <li className="list-none">and {assessment.subjects_elided} more</li>
                ) : null}
              </ul>
            ) : null}
          </>
        ) : (
          "Could not read this worktree."
        )}
      </div>
    ) : null}
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
  const {
    data: classified,
    isLoading: classifying,
    isError: classifyFailed,
    error: classifyError,
    refetch: retryClassify,
  } = useWorktreeSafety(selected?.path);
  const sizesQuery = useWorktreeSizes(selected?.path);
  const sizes = sizesQuery.data;
  // `isFetching`, NOT `isLoading`. A DISABLED query reports `isLoading:
  // true` forever in TanStack v5 -- it has no data and never will --
  // so on "All repositories", where no repo is selected and the sizing
  // query never runs, every row waited on a request that was never
  // made. `isFetching` is true only while something is actually in
  // flight.
  const sizing = sizesQuery.isFetching;
  const remove = useRemoveWorktree();

  /// Copy rather than spawn. The command lands in the user's own shell,
  /// where their config applies and `claude` resolves -- and there is no
  /// portable way to open "the user's terminal" anyway.
  const markRead = useMarkAssessed();
  const clearRead = useClearAssessed();

  /// Restore a worktree's Claudify action.
  ///
  /// Re-LOCKS force removal rather than unlocking it, so it is the safe
  /// direction and needs no confirmation of its own.
  const forget = (wt: Worktree) => {
    void clearRead(wt.path).then(
      () => toast.success(`${pathBasename(wt.path)} is no longer marked as assessed`),
      (e: unknown) =>
        toast.error("Could not clear the assessment", {
          description: typeof e === "string" ? e : undefined,
        }),
    );
  };

  const claudify = (wt: Worktree) => {
    claudifyCommand(selected?.path ?? "", wt.path, wt.branch).then(
      async ({ command, claude_installed }) => {
        // `copyText` rather than `navigator.clipboard` directly: an
        // ABSENT clipboard throws synchronously on property access, so
        // the old `.then(ok, err)` attached neither handler and the
        // click produced no toast of either kind.
        const failure = await copyText(command);
        if (failure !== null) {
          toast.error("Could not copy the command", { description: failure });
          return;
        }
        toast.success("Command copied to the clipboard", {
          // The user has to switch apps; this is the only place to say
          // so. And if Claude Code is missing, better to learn it here
          // than as a `command not found` after pasting.
          description: claude_installed
            ? "Paste it in your terminal to start the assessment."
            : "Paste it in your terminal. Claude Code was not found on this machine.",
          // The ONLY way to reach "Remove anyway…", and it is here
          // rather than automatic because that button removes a worktree
          // past its safety gate. Copying a prompt is not evidence
          // anyone read the answer; clicking this is.
          action: {
            label: "I read the assessment",
            onClick: () => {
              void markRead(wt.path).then(
                () => toast.success(`${pathBasename(wt.path)} can now be removed`),
                (e: unknown) =>
                  toast.error("Could not record the assessment", {
                    description: typeof e === "string" ? e : undefined,
                  }),
              );
            },
          },
        });
      },
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const removalProgress = useRemovalProgress();
  const removeMany = useRemoveWorktrees();
  const forceRemove = useRemoveWorktreeForced();
  const { data: assessedPaths } = useAssessed();
  const { data: prs = [] } = usePullRequests();
  // Only while the confirmation is open. Docker is a subprocess call,
  // and the Worktrees page has no business paying for it just to sit
  // there -- the manifest is needed at the moment of confirming, not
  // on every render of a list nobody is acting on.
  const assessed = new Set(assessedPaths ?? []);
  const [forcing, setForcing] = useState<Worktree | null>(null);
  const [pullingPath, setPullingPath] = useState<string | null>(null);
  const removeOrphanFn = useRemoveOrphan();
  // Every repository's sizes, only on the all-repositories view. One
  // query per repository so results land progressively -- the full set
  // takes ~2 minutes, and blocking on it is what made this page look
  // stuck.
  const {
    sizes: allSizes,
    pending: sizesPending,
    total: sizesTotal,
  } = useAllWorktreeSizes(
    (repos ?? []).map((r) => r.path),
    !filters.repo,
  );

  /// Delete an orphaned directory, reporting the Rust side's own words.
  ///
  /// No confirmation dialog: nothing about the contents can be checked
  /// -- that is the definition of an orphan -- so a dialog could only
  /// repeat what the button's title already says. The re-check that
  /// matters happens in Rust, at the moment of deletion.
  const runRemoveOrphan = (wt: Worktree) => {
    setRemoving(wt.path);
    removeOrphanFn(wt.path).then(
      () => {
        setRemoving(null);
        toast.success(`Deleted ${pathBasename(wt.path)}`);
      },
      (e: unknown) => {
        setRemoving(null);
        toast.error(`Could not delete ${pathBasename(wt.path)}`, {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };
  const pull = usePullCheckout();

  /// Fast-forward the main checkout, reporting git's own words either
  /// way. A generic "could not update" would throw away the one part of
  /// the failure that tells the user what to do.
  const runPull = (wt: Worktree) => {
    setPullingPath(wt.path);
    pull(wt.path).then(
      (out) => {
        setPullingPath(null);
        // Git says "Already up to date." when there was nothing to
        // fetch, which is a real answer and worth passing through
        // rather than replacing with a claim that something changed.
        toast.success(out.trim() || "Updated");
      },
      (e: unknown) => {
        setPullingPath(null);
        toast.error(`Could not update ${pathBasename(wt.path)}`, {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

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

  // "All repositories": a genuine rollup rather than the first repo.
  //
  // Deliberately READ-ONLY. Safety classification is per repo and costs
  // ~16s across all of them, so this view has no verdicts -- and every
  // removal path in this app is gated on a verdict. Offering Remove here
  // would mean either deleting without a safety check or blocking the
  // view on a 16-second scan; showing where the disk went, and sending
  // the user into the repo to act, is neither.
  // The Orphaned section. Its own branch rather than a repo page: an
  // orphan belongs to no repository, so `selected` cannot express it,
  // and the per-repo page's safety affordances do not apply.
  if (filters.repo === ORPHAN_FILTER) {
    const orphans = (repos ?? [])
      .flatMap((r) => r.worktrees)
      .filter((w) => isOrphaned(w.safety));
    return (
      <div className="rounded-md border border-[#30363d]">
        <div className="border-b border-[#30363d] px-4 py-3">
          <span className="text-sm font-semibold text-[#e6edf3]">
            {orphans.length} orphaned worktree{orphans.length === 1 ? "" : "s"}
            {/* The most important help in the app: this is the only
                place it offers a delete having verified nothing. */}
            <HelpButton topic="orphaned-worktrees" />
          </span>
          {/* Says what these ARE before offering to delete them. The
              row's own reason says nothing can be checked; this says
              why that is, which is what makes the Delete button a
              considered choice rather than a gamble. */}
          <p className="mt-1 text-xs text-[#8b949e]">
            The repository each of these belonged to has been deleted, so git can
            no longer read them — not whether they hold uncommitted work, and not
            whether their branch ever merged. Deleting one removes the directory
            outright.
          </p>
        </div>
        {orphans.map((wt) => (
          <Row
            key={wt.path}
            wt={wt}
            repoPath=""
            assessed={false}
            onForce={setForcing}
            onRemoveOrphan={runRemoveOrphan}
            onPull={runPull}
            onRemove={setPending}
            onClaudify={claudify}
              onForget={forget}
            removing={removing === wt.path}
          />
        ))}
      </div>
    );
  }

  if (!filters.repo) {
    // Sizes merged in as each repository answers. MEASURED: the full
    // set takes ~2 minutes, so awaiting it would show dashes for that
    // long with nothing to explain them -- which is what was reported.
    const withSizes = repos.map((r) => ({
      ...r,
      worktrees: r.worktrees.map((w) => ({
        ...w,
        size_bytes: allSizes.get(w.path) ?? w.size_bytes,
      })),
    }));
    const { worktrees, totalBytes, sizesComplete } = rollupRepos(withSizes);
    return (
      <div className="rounded-md border border-[#30363d]">
        <div className="flex items-baseline justify-between border-b border-[#30363d] px-4 py-3">
          <span className="text-sm font-semibold text-[#e6edf3]">
            {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"} across{" "}
            {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
          </span>
          <span className="text-xs text-[#8b949e]">
            {/* "at least" while any size is still unmeasured: a total
                that silently counts unknowns as zero is a confident
                wrong answer. */}
            {sizesComplete ? "" : "at least "}
            {formatSize(totalBytes)}
          </span>
        </div>
        {/* Sizes arrive one repository at a time, and this says how
            many are still outstanding.
            
            MEASURED: the full set takes ~2 minutes on a real machine
            (158 worktrees, `du` per worktree). Awaiting all of it
            showed dashes for that long with nothing to explain them.
            A count that visibly falls is the difference between "still
            working" and "broken". */}
        {sizesPending > 0 ? (
          <p className="border-b border-[#30363d] px-4 py-2 text-xs text-[#8b949e]">
            Measuring sizes — {sizesPending} of {sizesTotal} repositor
            {sizesTotal === 1 ? "y" : "ies"} still to go.
          </p>
        ) : null}
        {worktrees.map((wt) => (
          <button
            type="button"
            key={wt.path}
            onClick={() => setFilter("repo", wt.repoPath)}
            title="Open this repository to act on it"
            className="flex w-full items-baseline gap-3 border-b border-[#30363d] px-4 py-2.5 text-left text-sm last:border-b-0 hover:bg-[#161b22]"
          >
            <span className="w-40 shrink-0 truncate text-[#8b949e]">{wt.repoName}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">
              {pathBasename(wt.path)}
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-xs text-[#8b949e]">
              {wt.size_bytes === null ? "—" : formatSize(wt.size_bytes)}
            </span>
          </button>
        ))}
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
    .sort((a, b) => {
      // The main checkout first, ALWAYS. It is not a peer of the rows
      // below it -- every one of those is a removal candidate and it
      // never is, so sorting it among them invites reading it as one.
      // Its row also carries the upstream prose ("behind by 40"), which
      // is the reason the worktrees under it are stale, and an
      // explanation belongs above the thing it explains.
      if (a.is_main !== b.is_main) return a.is_main ? -1 : 1;
      // Assessed rows first: the user just came back from reading a
      // verdict, and finding that row among 124 candidates is the part
      // that made this feel unfinished.
      const aa = assessed.has(a.path) ? 0 : 1;
      const bb = assessed.has(b.path) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return sizing
        ? a.path.localeCompare(b.path)
        : (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
    });

  // Withheld unless classification actually SUCCEEDED. A failed pass
  // used to resolve as an empty success, so rows sat on "checking..."
  // forever while this read a confident "0 safe to remove".
  const safeKnown = !classifying && !classifyFailed;
  const shownSafe = shown.filter((w) => isSafe(w.safety));
  const safeCount = shownSafe.length;
  // Same honesty rule as the all-repositories rollup: an unmeasured
  // size is null, and counting it as zero would report a confident
  // wrong total. Sizes arrive in their own pass after safety, so this
  // grows as results land rather than being computed once.
  const measured = shown.filter((w) => w.size_bytes !== null && w.size_bytes !== undefined);
  const totalBytes = measured.reduce((n, w) => n + (w.size_bytes ?? 0), 0);
  const sizesComplete = measured.length === shown.length;

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
        ) : classifyFailed ? (
          <button
            type="button"
            onClick={() => void retryClassify()}
            className="text-xs text-[#f85149] hover:underline"
            title={errorMessage(classifyError)}
          >
            could not check what is safe — retry
          </button>
        ) : (
          <span className="inline-flex items-center text-xs text-[#3fb950]">
            {safeCount} safe to remove
            {/* This view deletes directories on the strength of a
                one-line verdict. The rules behind it run to several
                paragraphs and lived only in source comments. */}
            <HelpButton topic="worktree-safety" />
          </span>
        )}
        {!classifying && sizing ? (
          <span className="text-xs text-[#8b949e]">measuring sizes…</span>
        ) : null}
        {/* "at least" until every worktree has been measured. Reported
            here as well as on the rollup, because the per-repo page is
            where you land after choosing a repo and could not answer
            "how much is this one holding?". */}
        {measured.length > 0 ? (
          <span className="text-xs text-[#8b949e]">
            {sizesComplete ? "" : "at least "}
            {formatSize(totalBytes)} total
          </span>
        ) : null}

        {/* The count is in the label, so the scope is legible before
            clicking rather than only in the dialog. 106 of 268 worktrees
            are safe on a real machine, mostly in a few repos -- clicking
            those one at a time adds no safety, only clicks. */}
        {safeCount > 1 && safeKnown ? (
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => setBulkOpen(true)}
            className="rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-50"
          >
            {/* A count, not a spinner: ~100 worktrees is around 30
                seconds of sequential deletion, and a bare "Removing…"
                for that long is indistinguishable from a hang. */}
            {bulkBusy
              ? removalProgress
                ? `Removed ${removalProgress.done} of ${removalProgress.total}…`
                : "Removing…"
              : `Remove ${safeCount} safe worktree${safeCount === 1 ? "" : "s"}`}
          </button>
        ) : null}
        {/* Beside the button rather than in the dialog: the question
            ("can I leave this page?") occurs while it is running, which
            is when the dialog is already gone. */}
        {safeCount > 1 && safeKnown ? <HelpButton topic="bulk-removal" /> : null}

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

      {forcing ? (
        <Dialog open onOpenChange={(o) => !o && setForcing(null)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>Remove {pathBasename(forcing.path)}?</DialogTitle>
            <p className="mt-3 break-all font-mono text-xs text-[#8b949e]">{forcing.path}</p>
            {/* The specific loss, computed now -- "are you sure?" is not
                something anyone can act on, and this is the only
                genuinely unrecoverable case in the app. */}
            <p className="mt-3 text-sm text-[#e6edf3]">
              {safetyReason(forcing.safety)}
              {forcing.upstream && upstreamShort(forcing.upstream)
                ? ` · ${upstreamShort(forcing.upstream)}`
                : ""}
              {forcing.last_commit ? ` · last commit ${relativeTime(forcing.last_commit)}` : ""}
            </p>
            <p className="mt-2 text-sm text-[#f85149]">
              {forcing.safety.kind === "never_pushed"
                ? "These commits are not pushed anywhere. This cannot be undone."
                : "Headstate does not consider this safe to remove. This cannot be undone."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForcing(null)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = forcing;
                  const name = pathBasename(target.path);
                  setForcing(null);
                  setRemoving(target.path);
                  forceRemove(selected?.path ?? "", target.path).then(
                    () => {
                      setRemoving(null);
                      toast.success(`Removed ${name}`);
                    },
                    (e: unknown) => {
                      setRemoving(null);
                      toast.error(`Could not remove ${name}`, {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                I have reviewed this — remove it
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {bulkOpen ? (
        <Dialog open onOpenChange={(o) => !o && setBulkOpen(false)}>
          <DialogContent className="max-w-2xl">
            <DialogTitle>
              Remove {safeCount} safe worktree{safeCount === 1 ? "" : "s"}?
            </DialogTitle>
            <p className="mt-2 text-sm text-[#8b949e]">
              {/* Sizes are already computed, and reclaimed space is the
                  number that makes this decision -- it is why the view
                  exists. */}
              Reclaims {formatSize(
                shown
                  .filter((w) => isSafe(w.safety))
                  .reduce((n, w) => n + (w.size_bytes ?? 0), 0) || null,
              )}
              . Each is re-checked before deletion, so anything that changed
              since the scan is skipped.
            </p>
            {/* The third system this page could never reach. Docker
                images built from these worktrees outlive them, and
                until now removing them meant going to another view and
                working out by hand which ones belonged to what.

                Named, not just counted, and listed separately from the
                paths: this is a SECOND irreversible action in a dialog
                that used to perform one, and folding it in silently
                would be exactly the unreviewed bulk delete the manifest
                exists to prevent. */}
            {/* Every path, not a count: these are directories on disk. */}
            <ul className="mt-3 max-h-64 overflow-y-auto font-mono text-xs text-[#8b949e]">
              {shownSafe.map((w) => (
                <li key={w.path} className="py-0.5">
                  {w.path}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkOpen(false)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = shownSafe.map((w) => w.path);
                  removeMany(selected?.path ?? "", targets).then(
                    (outcomes) => {
                      setBulkBusy(false);
                      const failed = outcomes.filter((o) => o.error !== null);
                      const ok = outcomes.length - failed.length;
                      // Never a bare "done": a worktree that went dirty
                      // since the scan is refused, and hiding that would
                      // misreport what is still on disk.
                      if (failed.length === 0) {
                        toast.success(`Removed ${ok} worktree${ok === 1 ? "" : "s"}`);
                      } else {
                        toast.error(`${failed.length} of ${outcomes.length} could not be removed`, {
                          description: failed
                            .map((f) => `${pathBasename(f.path)}: ${f.error}`)
                            .join("\n"),
                        });
                      }
                    },
                    (e: unknown) => {
                      setBulkBusy(false);
                      toast.error("The bulk removal could not run", {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Remove {safeCount} worktree{safeCount === 1 ? "" : "s"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
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
              repoPath={selected?.path ?? ""}
              pr={prForWorktree(prs, selected?.identity ?? null, wt.branch)}
              assessed={assessed.has(wt.path)}
              onForce={setForcing}
              onRemoveOrphan={runRemoveOrphan}
              onPull={runPull}
              pulling={pullingPath === wt.path}
              onRemove={setPending}
              onClaudify={claudify}
              onForget={forget}
              sizePending={sizing}
              removing={removing === wt.path}
            />
          ))
        )}
      </div>
    </div>
  );
}
