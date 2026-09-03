import { type QueryClient, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten } from "./unlisten";
import { timed } from "./diag";
import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  Artifact,
  CleanupPrefs,
  DockerImage,
  PrDetail,
  PullRequest,
  Venv,
  Worktree,
} from "../types/pr";
import type { PrActionName } from "./tauri";
import {
  getCached,
  actOnPrs,
  updatePrBranch,
  getHistory,
  getMergedDetail,
  getCycleTrend,
  getPeriods,
  getPollInterval,
  actOnPr,
  getPrDetail,
  getWorktreeDirs,
  classifyWorktrees,
  listWorktrees,
  removeWorktree,
  pullCheckout,
  removeOrphan,
  assessedWorktrees,
  dockerBuilds,
  dockerDanglingVolumes,
  dockerDiskUsage,
  dockerImages,
  dockerPruneCache,
  dockerRemoveImages,
  dockerRemoveVolume,
  dockerState,
  deleteHeadBranch,
  removeWorktreeForced,
  setAutoMerge,
  removeWorktrees,
  removeArtifacts,
  markAssessed,
  checkPackages,
  readClaudeMd,
  scanClaudeMd,
  cleanupLog,
  getCleanupPrefs,
  previewCleanup,
  removeVenvs,
  setCleanupPrefs,
  scanVenvs,
  sizeVenvs,
  scanArtifacts,
  sizeArtifacts,
  sizeWorktrees,
  getReviewing,
  getCachedReviewing,
  countReviewing,
  getStats,
  refreshNow,
  setPollInterval,
  setViewNeedsGithub,
  setWorktreeDirs,
  reviewPr,
  commentOnPr,
  replyToThread,
  resolveThread,
  unresolveThread,
  getViewer,
  rerunChecks,
  getUiPrefs,
  setUiPrefs,
  type UiPrefs,
  getAutostart,
  setAutostart,
  assessWorktree,
  getNotifyPrefs,
  setNotifyPrefs,
  type NotifyPrefs,
  type ReviewVerdictName,
} from "./tauri";

/// The PR list. Seeded from the SQLite snapshot so the first paint shows
/// real content, then reconciled by the Rust poll loop via `prs-updated`.
/// React never talks to GitHub directly.
///
/// `get_cached` returns `[]` both on a genuinely PR-free account and while
/// the first poll (~3s cold) hasn't landed yet. This hook does not attempt
/// to tell those apart -- it falls back to `refresh_now` so the first paint
/// is never a bare empty screen while a poll is in flight. Callers that
/// need "never authenticated" vs. "authenticated, still loading" should
/// consult `get_auth_state` (see `AuthGate`).
export function usePullRequests() {
  const qc = useQueryClient();

  useEffect(() => {
    // Cleanup must not race `listen()`'s own promise: if the effect tears
    // down before `listen` resolves, a naive `un.then(f => f())` calls
    // unlisten on a promise that hasn't produced `f` yet, so the listener
    // registers *after* teardown and leaks. React 19 StrictMode mounts,
    // unmounts, and remounts effects on purpose, so this is not
    // theoretical -- it's the normal dev-mode path.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen<PullRequest[]>("prs-updated", (e) => {
      qc.setQueryData(["prs"], e.payload);
    }).then((fn) => {
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, [qc]);

  return useQuery({
    queryKey: ["prs"],
    queryFn: PRS_FN,
    staleTime: Infinity,
  });
}

/// `Stats`'s five derived fields always come back zero from the Rust layer
/// today (see `src/types/pr.ts`); only `merged_week`/`merged_month` are
/// real. `refresh_now`-style: does not persist to SQLite, so this is always
/// a live network call, not a cache read.
export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: getStats, staleTime: 60_000 });
}

/// The Rust poll loop emits `poll-error` (payload: a display-ready message
/// string) on every failed background poll, and nothing else listens for
/// it. Without this, M2's error handling is invisible: the UI would show
/// stale cached data forever with no indication a poll is failing.
///
/// Deliberately not a TanStack Query cache entry -- there's no `queryFn` to
/// attach it to, it's a push notification from a background loop, not the
/// result of a fetch this component initiated. A minimal module-level store
/// subscribed via `useSyncExternalStore` is the smallest thing that works.
let lastPollError: string | null = null;
const listeners = new Set<() => void>();

function setLastPollError(message: string | null): void {
  lastPollError = message;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return lastPollError;
}

/// Clear the poll-error banner.
///
/// The banner used to clear ONLY on a `prs-updated` event, and
/// `refresh_now` never emits one -- so a successful tray refresh left a red
/// "Background refresh failed" banner over freshly-loaded PRs until the
/// next background tick, up to 300s later.
export function clearPollError(): void {
  setLastPollError(null);
}

/// `src-tauri/src/tray.rs` emits `refresh-requested` when the user clicks
/// "Refresh now" in the tray menu. That click has no other effect on its
/// own -- it only fires the event -- so without a listener the menu item is
/// silently dead: the click succeeds, the event fires, and nothing happens.
///
/// It calls `refreshNow()` directly rather than invalidating the `["prs"]`
/// query -- see the comment on the call itself for why. (This paragraph
/// previously claimed the opposite of what the code does.)
export function useRefreshRequested(): void {
  const qc = useQueryClient();

  useEffect(() => {
    // Same guarded pattern as the two listeners above -- see their comments
    // for why the `cancelled` flag is load-bearing under StrictMode.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen("refresh-requested", () => {
      // `refreshNow()` directly, NOT `invalidateQueries`. Invalidating would
      // re-run `usePullRequests`'s queryFn, which reads the SQLite snapshot
      // first and only falls back to the network when that snapshot is
      // empty. The poll loop writes a snapshot every tick, so it never is --
      // meaning an invalidate would re-read the same rows the user is
      // already looking at. "Refresh now" has to mean "ask GitHub now", or
      // the user waits out the 60s/300s poll cadence while believing they
      // just refreshed.
      refreshNow().then(
        (prs) => {
          qc.setQueryData(["prs"], prs);
          // A successful manual refresh is proof the failure is over.
          clearPollError();
        },
        // Single-argument `.then` left this as an unhandled rejection in a
        // console nobody watches: the tray menu closed and nothing changed.
        // Routing it into the same store the poll loop uses means a failed
        // tray refresh says so.
        (err: unknown) => {
          setLastPollError(
            typeof err === "string" ? err : err instanceof Error ? err.message : "Refresh failed",
          );
        },
      );
    }).then((fn) => {
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, [qc]);
}

/// The most recent `poll-error` message, or `null` if no poll has failed
/// since this window opened (or a later poll has since succeeded and
/// re-emitted `prs-updated`, which clears it).
export function usePollError(): string | null {
  useEffect(() => {
    let unlistenError: UnlistenFn | undefined;
    let unlistenUpdated: UnlistenFn | undefined;
    let cancelled = false;

    listen<string>("poll-error", (e) => {
      setLastPollError(e.payload);
    }).then((fn) => {
      if (cancelled) safeUnlisten(fn);
      else unlistenError = fn;
    });

    // A later successful poll clears the error banner. `prs-updated` is
    // already listened to by `usePullRequests` (which updates the query
    // cache); this listens independently only to clear the error flag, so
    // the two hooks stay decoupled -- a banner can mount without the list
    // being mounted too.
    listen<PullRequest[]>("prs-updated", () => {
      setLastPollError(null);
    }).then((fn) => {
      if (cancelled) safeUnlisten(fn);
      else unlistenUpdated = fn;
    });

    return () => {
      cancelled = true;
      safeUnlisten(unlistenError);
      safeUnlisten(unlistenUpdated);
    };
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/// Median cycle time this week against last.
///
/// The Stats page could prove throughput but not improvement: cycle time
/// was a single window with no prior value, which is why its delta card
/// was hardcoded to null. Same 5-minute staleness as the other stats.
export function useCycleTrend() {
  return useQuery({
    queryKey: ["cycle-trend"],
    queryFn: getCycleTrend,
    staleTime: 5 * 60 * 1000,
  });
}

/// Whether the poll loop is currently fetching.
///
/// Emitted by the Rust loop rather than inferred from `isFetching`: the
/// tray refresh path calls `refreshNow` outside the queryFn, so the query
/// flag never flips for it. The loop that knows is the one that says.
export function usePollState(): "idle" | "fetching" | "retrying" {
  const [state, setState] = useState<"idle" | "fetching" | "retrying">("idle");

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>("poll-state", (e) => {
      setState(
        e.payload === "fetching"
          ? "fetching"
          : e.payload === "retrying"
            ? "retrying"
            : "idle",
      );
    }).then(
      (fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return state;
}

/// Keep the poll cadence in step with the active view.
///
/// The worktrees view needs no GitHub data, so the loop drops to the
/// background rate while it is open. It does NOT stop: the tray badge
/// would silently go stale, and the badge staying honest while the window
/// is not being watched is the reason polling lives in Rust.
export function useViewCadence(view: string): void {
  useEffect(() => {
    // Tolerate a host without the command, as the other listeners do:
    // cadence is an optimisation, and failing to set it must not break
    // the page.
    void setViewNeedsGithub(view !== "worktrees").catch(() => {});
  }, [view]);
}

/// Refresh the PR list from GITHUB after a write, and seed the cache.
///
/// `invalidateQueries(["prs"])` alone does nothing here, and this is the
/// bug behind "I closed a PR and it stayed in the list until I reloaded".
/// The query's own `queryFn` reads the SQLite snapshot first and only
/// falls through to a live fetch when that snapshot is EMPTY -- so with
/// any PRs at all, the refetch re-reads the very rows the user is looking
/// at. The invalidation was a no-op by construction.
///
/// The `prs-updated` push from the woken poll loop does eventually
/// correct it, but that is a full GitHub round-trip after the click with
/// nothing on screen to say so, and if that one poll fails the list stays
/// wrong for another interval -- up to 2 minutes focused, 10 backgrounded.
///
/// Costs one extra request per write (2 rate-limit points against
/// 5000/hour). It stays NON-OPTIMISTIC: the row disappears because GitHub
/// says it is gone, never because we assumed the write succeeded.
/// Query functions, defined ONCE at module scope.
///
/// `timed()` returns a new function on every call, so wrapping inline
/// in a hook body handed TanStack a different `queryFn` identity each
/// render. Hoisting is correct regardless of whether that ever caused
/// a refetch: a queryFn is configuration, and rebuilding it per render
/// is the kind of thing that bites later even when it is currently
/// harmless.
const REVIEWING_FN = timed("reviewing", getReviewing);
const CACHED_REVIEWING_FN = timed("reviewing-cached", getCachedReviewing);
const REVIEWING_COUNT_FN = timed("reviewing-count", countReviewing);
const PRS_FN = timed("prs", async () => {
  const cached = await getCached();
  // Show the cache immediately; the poll loop supplies fresh data.
  if (cached.length > 0) return cached;
  return refreshNow();
});

async function refreshPrs(qc: QueryClient): Promise<void> {
  try {
    qc.setQueryData(["prs"], await refreshNow());
  } catch {
    // The write already succeeded; only the read-back failed. Fall back
    // to the poll loop, which the Rust side has already woken. Throwing
    // here would report a successful action as failed.
    void qc.invalidateQueries({ queryKey: ["prs"] });
  }
}

/// Apply an action to a pull request, then refresh what it affected.
///
/// NOT optimistic. Every list mutation elsewhere updates locally first,
/// but a merge either happened or did not, and showing a PR as merged
/// before GitHub agreed would be a lie about a state the user cannot
/// undo. The Rust side wakes the poll loop on success, so the list
/// catches up within a tick rather than after the full interval.
export function useActOnPr() {
  const qc = useQueryClient();
  return (
    id: string,
    repo: string,
    number: number,
    action: PrActionName,
  ) =>
    actOnPr(id, repo, number, action).then(async () => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      void qc.invalidateQueries({ queryKey: ["reviewing"] });
      await refreshPrs(qc);
    });
}

/// Who the token belongs to.
///
/// `staleTime: Infinity` because a login cannot change during a session,
/// so this is one request per launch. Used to decide whether approving is
/// offered at all -- GitHub refuses self-approval, and the UI should say
/// so before the click rather than after a round-trip.
export function useViewer() {
  return useQuery({ queryKey: ["viewer"], queryFn: getViewer, staleTime: Infinity });
}

/// Re-run a pull request's failed CI.
///
/// Invalidates the detail view, where the check list lives, and
/// refreshes the list because the rollup state changes too.
export function useRerunChecks() {
  const qc = useQueryClient();
  return (repo: string, number: number, runId: number) =>
    rerunChecks(repo, number, runId).then(async () => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      await refreshPrs(qc);
    });
}

/// The `latestReviews` state each verdict produces.
///
/// `comment` is absent deliberately: a COMMENT review does not change
/// whether the viewer has approved, so seeding one would be inventing a
/// state change that did not happen.
export const REVIEW_STATE: Partial<Record<ReviewVerdictName, string>> = {
  approve: "APPROVED",
  request_changes: "CHANGES_REQUESTED",
};

/// `detail` with the viewer's own review replaced by `state`.
///
/// Pure and non-mutating: React Query compares by reference, and editing
/// the cached object in place would leave components rendering the old
/// value.
export function withOwnReview(detail: PrDetail, viewer: string, state: string): PrDetail {
  const others = detail.latest_reviews.filter((r) => r.author !== viewer);
  return { ...detail, latest_reviews: [...others, { author: viewer, state }] };
}

/// Submit a review on a pull request.
///
/// Invalidates `["reviewing"]` and refreshes the PR list: approving a PR
/// removes it from the review queue, and the queue is the surface the
/// user is standing on when they do this.
export function useReviewPr() {
  const qc = useQueryClient();
  return (
    id: string,
    repo: string,
    number: number,
    verdict: ReviewVerdictName,
    body: string,
  ) =>
    reviewPr(id, repo, number, verdict, body).then(async () => {
      void qc.invalidateQueries({ queryKey: ["reviewing"] });
      // Write the verdict we KNOW landed straight into the cache, before
      // asking GitHub anything.
      //
      // `latestReviews` lags `addPullRequestReview`: for a second or two
      // afterwards GitHub still returns the pre-approval review set. The
      // refetch below can land inside that window, and `staleTime` means
      // nothing asks again -- so the button reverted to "Approve" for an
      // approval that had succeeded, which reads as "the click did
      // nothing" and invites a second review.
      //
      // The mutation already verified the outcome (it rejects a PENDING
      // review), so this is not optimism about whether it worked. It is
      // the authoritative answer, applied while GitHub's read side
      // catches up. The refetch that follows overwrites it either way.
      // From the cache rather than a hook argument: `useViewer` has
      // `staleTime: Infinity` and is fetched once at launch, so by the
      // time anyone can click Approve it is populated. Undefined means we
      // genuinely could not ask, and then the seed is skipped rather than
      // attributed to the wrong person.
      const viewer = qc.getQueryData<string>(["viewer"]);
      const state = REVIEW_STATE[verdict];
      if (state !== undefined && viewer !== undefined) {
        qc.setQueryData<PrDetail>(["pr-detail", repo, number], (prev) =>
          prev === undefined ? prev : withOwnReview(prev, viewer, state),
        );
      }
      // AWAITED, unlike the list refresh. The button stays busy until the
      // detail view reflects the click, rather than until an unrelated
      // list finishes.
      await qc.refetchQueries({ queryKey: ["pr-detail", repo, number] });
      await refreshPrs(qc);
    });
}

/// Comment on a pull request.
///
/// Only the detail view changes: a comment does not alter any state the
/// list renders, so refreshing the whole list would be a wasted request.
export function useCommentOnPr() {
  const qc = useQueryClient();
  return (id: string, repo: string, number: number, body: string) =>
    commentOnPr(id, repo, number, body).then(() => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
    });
}

/// Resolve, reopen, and reply on a review conversation.
///
/// All three invalidate the detail query, because all three change the
/// unresolved COUNT the header renders beside the thread list. Leaving it
/// stale would put "2 unresolved conversations" above a list showing one
/// -- the header contradicting the section beneath it.
///
/// The list queries are deliberately untouched: `unresolved_threads` is
/// on the list model too, but a poll refreshes it within the minute and
/// invalidating a 6-second query for a number nobody is looking at is the
/// cost #328 measured and rejected.
///
/// AWAITED, not `void`-ed. A fire-and-forget invalidation settles the
/// promise immediately, so the button cleared its busy state before the
/// data it depends on existed -- the same defect as #377, which these
/// three inherited by being written one commit before that fix. The
/// backend now verifies each of these mutations landed, so refetching
/// here is confirming a known-good result rather than hoping.
export function useResolveThread() {
  const qc = useQueryClient();
  return (threadId: string, repo: string, number: number) =>
    resolveThread(threadId, repo, number).then(async () => {
      await qc.refetchQueries({ queryKey: ["pr-detail", repo, number] });
    });
}

export function useUnresolveThread() {
  const qc = useQueryClient();
  return (threadId: string, repo: string, number: number) =>
    unresolveThread(threadId, repo, number).then(async () => {
      await qc.refetchQueries({ queryKey: ["pr-detail", repo, number] });
    });
}

export function useReplyToThread() {
  const qc = useQueryClient();
  return (threadId: string, repo: string, number: number, body: string) =>
    replyToThread(threadId, repo, number, body).then(async () => {
      await qc.refetchQueries({ queryKey: ["pr-detail", repo, number] });
    });
}

/// Regenerable build output under the configured scan roots.
///
/// Discovery only. Sizes come from `useArtifactSizes`, because the two
/// passes differ by three orders of magnitude and blocking the list on
/// the slow one would leave the view empty for a minute -- the exact
/// complaint that shaped the worktree page.
export function useArtifacts(enabled: boolean) {
  return useQuery({
    queryKey: ["artifacts"],
    queryFn: scanArtifacts,
    enabled,
    // The set changes when someone builds or clones, not on a timer.
    staleTime: 60 * 1000,
  });
}

/// Sizes for artifact directories, measured in per-repository batches.
///
/// Batched by repo rather than one query for everything, so the page
/// fills in progressively instead of staying blank until the slowest
/// directory finishes. A 61 GB `target/` can take tens of seconds on its
/// own; the other 177 rows should not wait behind it.
///
/// `staleTime` is long for the same reason as the worktree equivalent: a
/// directory's size does not change unless its contents do.
export function useArtifactSizes(artifacts: Artifact[], enabled: boolean) {
  // Grouped OUTSIDE the query so the key set is stable across renders --
  // a fresh grouping each render would remount every query and restart
  // the measurement.
  const byRepo = new Map<string, string[]>();
  for (const a of artifacts) {
    const list = byRepo.get(a.repo_path) ?? [];
    list.push(a.path);
    byRepo.set(a.repo_path, list);
  }
  const groups = [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b));

  const results = useQueries({
    queries: groups.map(([repo, paths]) => ({
      queryKey: ["artifact-sizes", repo, paths.length],
      queryFn: () => sizeArtifacts(paths),
      enabled,
      staleTime: 5 * 60 * 1000,
    })),
  });

  const sizes = new Map<string, number>();
  const ages = new Map<string, number>();
  for (const r of results) {
    for (const [path, bytes, age] of r.data ?? []) {
      sizes.set(path, bytes);
      if (age !== null) ages.set(path, age);
    }
  }
  return {
    sizes,
    ages,
    /// How many repositories have not answered yet -- the number that
    /// makes a partially-filled page legible rather than broken.
    pending: results.filter((r) => r.isFetching).length,
    total: results.length,
  };
}

/// Remove artifact directories.
///
/// Invalidates the scan AND the sizes: a removed directory must leave
/// the list, and a stale size row would otherwise keep counting bytes
/// that are no longer there.
export function useRemoveArtifacts() {
  const qc = useQueryClient();
  return async (paths: string[]) => {
    const out = await removeArtifacts(paths);
    await qc.invalidateQueries({ queryKey: ["artifacts"] });
    await qc.invalidateQueries({ queryKey: ["artifact-sizes"] });
    return out;
  };
}

/// Poetry virtualenvs, classified.
///
/// Discovery only. Sizes and idle times come from `useVenvSizes`,
/// because deciding staleness needs a full walk of each venv.
export function useVenvs(enabled: boolean) {
  return useQuery({
    queryKey: ["venvs"],
    queryFn: scanVenvs,
    enabled,
    staleTime: 60 * 1000,
  });
}

/// Sizes and idle times for virtualenvs.
///
/// One batch rather than per-project groups: unlike artifacts, venvs are
/// individually small (under a gigabyte each on a real cache), so no
/// single one holds up the rest and the added query keys would only
/// fragment the cache.
export function useVenvSizes(venvs: Venv[], enabled: boolean) {
  const paths = venvs.map((v) => v.path);
  const q = useQuery({
    // Keyed on the PATHS, not their count. Two different sets of the
    // same size shared a cache entry, so removing one venv and adding
    // another served the old sizes.
    queryKey: ["venv-sizes", ...paths],
    queryFn: () => sizeVenvs(paths),
    enabled: enabled && paths.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const sizes = new Map<string, number>();
  const idle = new Map<string, number>();
  for (const [path, bytes, secs] of q.data ?? []) {
    sizes.set(path, bytes);
    if (secs !== null) idle.set(path, secs);
  }
  return { sizes, idle, measuring: q.isFetching };
}

/// Remove virtualenvs, then refresh what is left.
export function useRemoveVenvs() {
  const qc = useQueryClient();
  return async (paths: string[]) => {
    const out = await removeVenvs(paths);
    await qc.invalidateQueries({ queryKey: ["venvs"] });
    await qc.invalidateQueries({ queryKey: ["venv-sizes"] });
    return out;
  };
}

/// Automatic cleanup preferences.
export function useCleanupPrefs() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["cleanup-prefs"],
    queryFn: getCleanupPrefs,
    staleTime: Infinity,
  });
  return {
    prefs: data,
    set: async (prefs: CleanupPrefs) => {
      await setCleanupPrefs(prefs);
      await qc.invalidateQueries({ queryKey: ["cleanup-prefs"] });
    },
  };
}

/// The cleanup ledger, and a way to run a pass now.
///
/// Running it on demand is the whole of Phase 1's value: the user turns
/// the feature on, clicks once, and reads what it WOULD have removed on
/// their own machine -- rather than being asked to trust a rule they
/// have never seen applied.
export function useCleanupLog(enabled: boolean) {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ["cleanup-log"],
    queryFn: cleanupLog,
    enabled,
    staleTime: 30_000,
  });
  return {
    entries: data,
    isLoading,
    run: async () => {
      const out = await previewCleanup();
      await qc.invalidateQueries({ queryKey: ["cleanup-log"] });
      return out;
    },
  };
}

/// Outdated packages for one repository.
///
/// `enabled` gates it on a repo actually being selected, and it never
/// runs on a timer: these commands hit registries and take seconds.
export function usePackages(repoPath: string | undefined) {
  return useQuery({
    queryKey: ["packages", repoPath],
    queryFn: () => checkPackages(repoPath as string),
    enabled: Boolean(repoPath),
    // Long, because the answer changes when a registry publishes, not
    // when the user clicks around. Refetching costs seconds and network.
    staleTime: 10 * 60 * 1000,
  });
}

/// CLAUDE.md files in one repository, with import trees resolved.
export function useClaudeMd(repoPath: string | undefined) {
  return useQuery({
    queryKey: ["claude-md", repoPath],
    queryFn: () => scanClaudeMd(repoPath as string),
    enabled: Boolean(repoPath),
    staleTime: 30_000,
  });
}

/// The text of one file.
///
/// Fetched separately from the scan: holding every file's contents to
/// display one is a lot of bytes across the bridge for nothing.
export function useClaudeMdText(path: string | undefined) {
  return useQuery({
    queryKey: ["claude-md-text", path],
    queryFn: () => readClaudeMd(path as string),
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}

/// Merge the base branch into a pull request's head.
///
/// Invalidates the same keys as `useActOnPr`: the update changes CI
/// state and mergeability, so a row left showing "behind" after a
/// successful update would be stale in exactly the way the button was
/// meant to fix.
export function useUpdatePrBranch() {
  const qc = useQueryClient();
  return (id: string, repo: string, number: number, expectedHead: string) =>
    updatePrBranch(id, repo, number, expectedHead).then(async () => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      void qc.invalidateQueries({ queryKey: ["reviewing"] });
      await refreshPrs(qc);
    });
}

/// Apply one action to several pull requests.
///
/// Invalidates once after the whole batch rather than per pull request:
/// forty mutations would otherwise trigger forty refetches of the same
/// list. Resolves with per-PR outcomes; it rejects only if the batch
/// itself could not run.
export function useActOnPrs() {
  const qc = useQueryClient();
  return (prs: [string, string, number][], action: PrActionName) =>
    actOnPrs(prs, action).then(async (outcomes) => {
      void qc.invalidateQueries({ queryKey: ["reviewing"] });
      await refreshPrs(qc);
      return outcomes;
    });
}

/// Enable or cancel "merge when green".
export function useSetAutoMerge() {
  const qc = useQueryClient();
  return (id: string, repo: string, number: number, expectedHead: string, enable: boolean) =>
    setAutoMerge(id, repo, number, expectedHead, enable).then(async () => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      await refreshPrs(qc);
    });
}

/// Delete a merged pull request's head branch.
export function useDeleteHeadBranch() {
  const qc = useQueryClient();
  return (refId: string, repo: string, number: number, branch: string, merged: boolean) =>
    deleteHeadBranch(refId, repo, number, branch, merged).then(async () => {
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      await refreshPrs(qc);
    });
}

/// One pull request's detail, fetched when the view opens.
///
/// Not part of the poll loop: it is per-PR and only wanted while on
/// screen. Kept briefly so reopening the same PR is instant, but short
/// enough that CI state is not stale on return.
export function usePrDetail(repo: string | undefined, number: number | undefined) {
  return useQuery({
    queryKey: ["pr-detail", repo, number],
    queryFn: () => getPrDetail(repo as string, number as number),
    enabled: Boolean(repo && number),
    staleTime: 30_000,
    // `unknown` mergeability is TRANSIENT: GitHub sets it while it
    // recomputes, which approving a pull request is precisely what
    // triggers. One invalidation after the mutation is not enough --
    // the refetch lands while GitHub is still computing and gets
    // `unknown` back, then nothing asks again.
    //
    // Polling only in that state, and only while the detail view is
    // open. It stops the moment a real answer arrives, so this is a few
    // seconds of extra requests on one pull request rather than a
    // background cost.
    refetchInterval: (query) =>
      query.state.data?.merge_status === "unknown" ? 3_000 : false,
  });
}

/// Repos with worktrees. Listing only -- see `useWorktreeSafety`.
///
/// `staleTime` is short but non-zero: the set changes when the user
/// creates or removes a worktree, not on a timer, so refetching on every
/// mount would spend a second of subprocess work for nothing.
export function useWorktrees() {
  return useQuery({
    queryKey: ["worktrees"],
    queryFn: listWorktrees,
    staleTime: 30_000,
  });
}

/// Safety for one repo's worktrees, fetched only when that repo is
/// selected -- classifying all 37 up front would take ~16s.
export function useWorktreeSafety(repoPath: string | undefined) {
  return useQuery({
    queryKey: ["worktree-safety", repoPath],
    queryFn: () => classifyWorktrees(repoPath as string),
    enabled: Boolean(repoPath),
    staleTime: 30_000,
  });
}

/// Disk sizes for one repo's worktrees, keyed by path.
///
/// The slowest of the three passes (~13s for 147 worktrees), so it is
/// last: the list appears, then safety, then sizes. Sizes change only
/// when the tree does, so they are cached for longer than the rest.
export function useWorktreeSizes(repoPath: string | undefined) {
  return useQuery({
    queryKey: ["worktree-sizes", repoPath],
    queryFn: async () => {
      const pairs = await sizeWorktrees(repoPath as string);
      return new Map(pairs);
    },
    enabled: Boolean(repoPath),
    staleTime: 5 * 60 * 1000,
  });
}

/// Sizes for EVERY repository, landing one repository at a time.
///
/// MEASURED: sizing all 41 repositories on a real machine takes 119
/// seconds -- `size_repo` shells out to `du` per worktree, and 158
/// worktrees at roughly 0.75s each is the whole cost. Issuing them all
/// and awaiting the set would leave the all-repositories view showing
/// dashes for two minutes with nothing to say why, which is exactly
/// what was reported.
///
/// So: one query PER REPOSITORY, merged as each resolves. The view
/// fills in progressively and can say how much is still outstanding.
/// The per-repository queries share `worktree-sizes` keys with
/// `useWorktreeSizes`, so opening a repository afterwards is free.
///
/// `staleTime` is long for the same reason it is on the single-repo
/// hook: a worktree's size does not change unless its contents do.
export function useAllWorktreeSizes(repoPaths: string[], enabled: boolean) {
  const results = useQueries({
    queries: repoPaths.map((path) => ({
      queryKey: ["worktree-sizes", path],
      queryFn: async () => new Map(await sizeWorktrees(path)),
      enabled,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Merged into one map, so callers do not care that it arrived in
  // pieces.
  const sizes = new Map<string, number>();
  for (const r of results) {
    if (r.data) for (const [k, v] of r.data) sizes.set(k, v);
  }
  return {
    sizes,
    /// How many repositories have not answered yet -- the number that
    /// makes a partially-filled page legible rather than broken.
    pending: results.filter((r) => r.isFetching).length,
    total: results.length,
  };
}

/// Remove a worktree, then refresh both queries.
///
/// Deliberately NOT optimistic. Every other mutation in this app updates
/// locally first, but this one deletes files: showing a row as gone
/// before the deletion succeeded would be a lie about the filesystem, and
/// the failure case here is "your work is still there", which the user
/// needs to see rather than have hidden.
/// Fast-forward a checkout to its upstream.
///
/// Invalidates the worktree list on success rather than patching a row:
/// the upstream line is the whole reason the action exists, and a
/// successful pull that left "behind by 40" on screen would look like
/// it had failed. Unlike removal there is no long re-classification to
/// avoid -- the row count does not change.
export function usePullCheckout() {
  const qc = useQueryClient();
  return (path: string) =>
    pullCheckout(path).then((out) => {
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
      // AND the safety classification, which is what actually renders
      // the "N commits behind upstream" line. Invalidating only the
      // base list left the row yellow for ~10 seconds after a
      // SUCCESSFUL pull, until something else happened to refresh it --
      // so the button looked like it had done nothing, which is exactly
      // what #346 reported.
      void qc.invalidateQueries({ queryKey: ["worktree-safety"] });
      return out;
    });
}

/// Delete an orphaned worktree directory.
///
/// Invalidates rather than patching a row: an orphan's removal changes
/// what the Orphaned section contains, and that section disappears
/// entirely at zero.
export function useRemoveOrphan() {
  const qc = useQueryClient();
  return (path: string) =>
    removeOrphan(path).then(() => {
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
    });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return (repoPath: string, worktreePath: string) =>
    removeWorktree(repoPath, worktreePath).then(() => {
      // Drop the row rather than invalidating. Invalidation re-runs
      // `classify_repo` over EVERY worktree in the repo, sequentially --
      // ~0.35s each, so 51 seconds on a 146-worktree repo, during which
      // the deleted row sits there looking undeleted.
      //
      // It is also unnecessary: removing a worktree cannot change any
      // other worktree's safety, since each verdict is computed from that
      // worktree's own state. Filtering the cache is instant and exactly
      // as accurate as re-running 146 git commands.
      qc.setQueryData<Worktree[]>(["worktree-safety", repoPath], (old) =>
        old?.filter((w) => w.path !== worktreePath),
      );
      // The repo listing IS invalidated: it is cheap, and a repo that
      // just lost its last worktree should leave the sidebar.
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
    });
}

/// Remove every safe worktree in a repo.
///
/// Drops the successful paths from the cache rather than invalidating,
/// for the same reason a single removal does: re-classifying 146
/// worktrees takes ~51s, and removing worktrees cannot change any other
/// worktree's safety.
export function useRemoveWorktrees() {
  const qc = useQueryClient();
  return (repoPath: string, worktreePaths: string[]) =>
    removeWorktrees(repoPath, worktreePaths).then((outcomes) => {
      const removed = new Set(
        outcomes.filter((o) => o.error === null).map((o) => o.path),
      );
      qc.setQueryData<Worktree[]>(["worktree-safety", repoPath], (old) =>
        old?.filter((w) => !removed.has(w.path)),
      );
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
      return outcomes;
    });
}

/// Which worktrees have been assessed, so the row can say so.
export function useAssessed() {
  return useQuery({
    queryKey: ["assessed-worktrees"],
    queryFn: assessedWorktrees,
    staleTime: 5_000,
  });
}

/// Record that a human read an assessment.
///
/// Invalidates the assessed list so the row's action updates -- which is
/// the point: the change is now the deliberate result of the user saying
/// they read the verdict, rather than a delayed side effect of copying a
/// command.
export function useMarkAssessed() {
  const qc = useQueryClient();
  return async (worktreePath: string) => {
    await markAssessed(worktreePath);
    await qc.invalidateQueries({ queryKey: ["assessed-worktrees"] });
  };
}

/// Remove a worktree past the safety gate.
///
/// Separate hook from `useRemoveWorktree` on purpose: the two are not
/// interchangeable, and a single function with a boolean would make the
/// dangerous call one typo away from the safe one.
export function useRemoveWorktreeForced() {
  const qc = useQueryClient();
  return (repoPath: string, worktreePath: string) =>
    removeWorktreeForced(repoPath, worktreePath).then(() => {
      qc.setQueryData<Worktree[]>(["worktree-safety", repoPath], (old) =>
        old?.filter((w) => w.path !== worktreePath),
      );
      void qc.invalidateQueries({ queryKey: ["assessed-worktrees"] });
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
    });
}

/// A local-store failure: a full disk, a locked database.
///
/// Its own channel, deliberately. It used to share `poll-error`, which
/// `prs-updated` clears -- and `persist_and_emit` emits the error then
/// unconditionally emits `prs-updated`, so the banner was destroyed
/// microseconds after it appeared. A store failure also describes a
/// condition a later successful poll did not fix, so nothing clears it
/// but the user.
export function useStoreError(): { message: string | null; dismiss: () => void } {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>("store-error", (e) => setMsg(e.payload)).then(
      (fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);
  return { message: msg, dismiss: () => setMsg(null) };
}

/// --- Docker -------------------------------------------------------

/// Whether Docker can be talked to. Polled slowly: the daemon starting
/// or stopping is the kind of thing a user does, so the view should
/// notice without them reloading.
export function useDockerState() {
  return useQuery({
    queryKey: ["docker-state"],
    queryFn: dockerState,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

/// The image list, with provenance. Only fetched when Docker is up --
/// asking a stopped daemon just produces an error the view already
/// explains better.
export function useDockerImages(enabled: boolean) {
  return useQuery({
    queryKey: ["docker-images"],
    queryFn: dockerImages,
    enabled,
    staleTime: 10_000,
  });
}

/// Build history. Failed builds are kept: a failing build is usually
/// what the user came to investigate.
export function useDockerBuilds(enabled: boolean) {
  return useQuery({
    queryKey: ["docker-builds"],
    queryFn: dockerBuilds,
    enabled,
    staleTime: 10_000,
  });
}


export function useDockerDiskUsage(enabled: boolean) {
  return useQuery({
    queryKey: ["docker-disk"],
    queryFn: dockerDiskUsage,
    enabled,
    staleTime: 10_000,
  });
}

export function useDockerVolumes(enabled: boolean) {
  return useQuery({
    queryKey: ["docker-volumes"],
    queryFn: dockerDanglingVolumes,
    enabled,
    staleTime: 10_000,
  });
}

/// Remove images, dropping the successful ones from the cache.
///
/// Filtered rather than invalidated, for the same reason worktree
/// removal is: re-resolving provenance means git calls per tag, and
/// removing an image cannot change any other image's standing.
export function useRemoveImages() {
  const qc = useQueryClient();
  return (ids: string[]) =>
    dockerRemoveImages(ids).then((outcomes) => {
      const gone = new Set(outcomes.filter((o) => o.error === null).map((o) => o.id));
      qc.setQueryData<DockerImage[]>(["docker-images"], (old) =>
        old?.filter((i) => !gone.has(i.id)),
      );
      void qc.invalidateQueries({ queryKey: ["docker-disk"] });
      return outcomes;
    });
}

export function useRemoveVolume() {
  const qc = useQueryClient();
  return (name: string) =>
    dockerRemoveVolume(name).then(() => {
      void qc.invalidateQueries({ queryKey: ["docker-volumes"] });
      void qc.invalidateQueries({ queryKey: ["docker-disk"] });
    });
}

export function usePruneCache() {
  const qc = useQueryClient();
  return (until?: string) =>
    dockerPruneCache(until).then((freed) => {
      void qc.invalidateQueries({ queryKey: ["docker-disk"] });
      return freed;
    });
}

/// Directories scanned for git checkouts, and a way to change them.
///
/// The mutation can FAIL -- a path that is not a directory is rejected by
/// the backend -- so this surfaces the error rather than swallowing it,
/// unlike the interval setting which only clamps.
export function useWorktreeDirs() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["worktree-dirs"],
    queryFn: getWorktreeDirs,
    staleTime: Infinity,
  });
  const set = (dirs: string[]) =>
    setWorktreeDirs(dirs).then((applied) => {
      qc.setQueryData(["worktree-dirs"], applied);
      return applied;
    });
  return { dirs: query.data ?? [], set };
}

/// The poll interval setting, and a way to change it.
///
/// The value is authoritative on the Rust side, which owns the running
/// loop -- the mutation returns what was actually applied after clamping,
/// so the UI can never show a value the backend rejected.
export function usePollInterval() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["poll-interval"],
    queryFn: getPollInterval,
    staleTime: Infinity,
  });
  const set = (secs: number) =>
    setPollInterval(secs).then((applied) => {
      qc.setQueryData(["poll-interval"], applied);
      return applied;
    });
  return { seconds: query.data, set };
}

/// Interface preferences.
export function useUiPrefs() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["ui-prefs"],
    queryFn: getUiPrefs,
    staleTime: Infinity,
  });
  const set = (prefs: UiPrefs) =>
    setUiPrefs(prefs).then(() => {
      qc.setQueryData(["ui-prefs"], prefs);
    });
  return { prefs: query.data, set };
}

/// Whether the app starts at login.
///
/// No optimistic seed: this one can genuinely FAIL -- registering a
/// launch agent touches the filesystem -- so the checkbox should reflect
/// what the OS actually did, not what was asked for.
export function useAutostart() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["autostart"],
    queryFn: getAutostart,
    staleTime: Infinity,
  });
  const set = (enabled: boolean) =>
    setAutostart(enabled).then(() =>
      qc.invalidateQueries({ queryKey: ["autostart"] }),
    );
  return { enabled: query.data ?? false, set };
}

/// How far a bulk worktree removal has got, or null when idle.
///
/// The button previously showed a single boolean for what can be ~30
/// seconds of sequential deletion, so a long batch was
/// indistinguishable from a hang. The Rust side emits (done, total)
/// after EACH removal -- including failures, or a batch where several
/// fail appears to stall.
export function useRemovalProgress(): { done: number; total: number } | null {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<[number, number]>("worktree-removal-progress", (e) => {
      const [done, total] = e.payload;
      // Clears on the last one rather than leaving "106 of 106" on
      // screen after the work is over.
      setProgress(done >= total ? null : { done, total });
    }).then((fn) => {
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return progress;
}

/// What one worktree is holding, fetched on demand.
///
/// `enabled` so it costs nothing until a row is actually opened:
/// several git calls per worktree, and there can be hundreds of rows.
/// A long `staleTime` because the answer only changes when the branch
/// does, and the row is already keyed by path.
export function useAssessment(
  repoPath: string | null,
  worktreePath: string | null,
  branch: string | null,
) {
  return useQuery({
    queryKey: ["assessment", repoPath, worktreePath],
    queryFn: () => assessWorktree(repoPath!, worktreePath!, branch!),
    enabled: repoPath !== null && worktreePath !== null && branch !== null,
    staleTime: 5 * 60 * 1000,
  });
}

/// Which desktop notifications the user wants.
///
/// Seeds optimistically on write, like `usePollInterval`: the Rust side
/// is the source of truth, but a checkbox that waits for a round-trip to
/// tick feels broken.
export function useNotifyPrefs() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["notify-prefs"],
    queryFn: getNotifyPrefs,
    staleTime: Infinity,
  });
  const set = (prefs: NotifyPrefs) =>
    setNotifyPrefs(prefs).then(() => {
      qc.setQueryData(["notify-prefs"], prefs);
    });
  return { prefs: query.data, set };
}

/// PRs awaiting the user's review.
///
/// The app previously queried only `author:@me`, so it could say nothing
/// about the queue the user is the bottleneck for -- the largest gap for a
/// daily driver. Same 60s staleness as the authored list.
export function useReviewing(enabled = true) {
  // The cached list, read from SQLite and never from GitHub. Its own
  // query so it resolves in milliseconds while the live one runs --
  // folding the cache into the live queryFn instead would let a cached
  // result satisfy `staleTime` and leave the list permanently stale.
  //
  // The cache is still worth having even now that the live query is
  // fast: it paints in milliseconds where a network round-trip cannot.
  //
  // CORRECTION to what this comment used to say. It claimed "the live
  // query cannot be made meaningfully faster -- a bare 25-item search
  // already costs 6.2s". That measurement was WRONG, and it sat here as
  // a reason not to try. A bare 25-item search costs ~0.7s; the 6.2s was
  // the FIELDS, and specifically `mergeStateStatus` at ~154ms per pull
  // request. #328 pages at 25 concurrently now, which measured 62 pull
  // requests in ~7s against ~21s-then-truncate.
  const cached = useQuery({
    queryKey: ["reviewing-cached"],
    queryFn: CACHED_REVIEWING_FN,
    enabled,
    // Read once per mount. The live query is what keeps the view
    // current; re-reading the cache would only ever show older data.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const live = useQuery({
    queryKey: ["reviewing"],
    queryFn: REVIEWING_FN,
    // Only the view that RENDERS these pull requests fetches them. It
    // used to run on every view -- including Docker and Worktrees, which
    // show none -- purely so a sidebar badge could display its length.
    // That is a 100-node query for a number, and on a slow account it
    // failed there too.
    enabled,
    staleTime: 60_000,
  });

  // Live data the moment it exists; the cache only until then. Note
  // `live.data` is checked rather than `live.isSuccess`, so a refetch
  // still in flight keeps showing the previous LIVE list rather than
  // falling back to a staler cached one.
  const data = live.data ?? cached.data;

  return {
    ...live,
    data,
    // Loading only when there is genuinely nothing to show. With a warm
    // cache the panel paints immediately, which is the whole point --
    // the reported complaint was an empty view for over a minute.
    isLoading: data === undefined && (live.isLoading || cached.isLoading),
    // True while the live query runs, INCLUDING when the cache is
    // already painted. This drives the "refreshing" indicator, which is
    // the other half of the complaint: "no indication that it is
    // blocked".
    isRefreshing: live.isFetching,
    /// Whether what is on screen came from disk rather than GitHub.
    isFromCache: live.data === undefined && cached.data !== undefined,
  };
}


/// How many pull requests await the user's review.
///
/// The badge's own query, so it does not depend on the list being
/// fetched. MEASURED: 1 rate-limit point and ~0.9s, against 6 and ~4s
/// for the list it replaces here.
export function useReviewingCount() {
  return useQuery({
    queryKey: ["reviewing-count"],
    queryFn: REVIEWING_COUNT_FN,
    staleTime: 60_000,
  });
}

/// GitHub's true open-PR count, when it exceeds what the query returned.
///
/// `null` in the normal case. The Rust loop emits `prs-truncated` only
/// above the 100-PR page size, so this stays quiet for almost everyone
/// while making the cap visible to the accounts it actually affects.
/// How many fields GitHub refused on the last poll, or 0.
///
/// Advisory, like `useTruncation`. GitHub answered with usable data and
/// a complaint that it could not compute all of it; the list is real but
/// short, and saying so beats either hiding it or -- as v3.2.5 did --
/// discarding the data and showing nothing.
export function useIncomplete(): number {
  const [refused, setRefused] = useState(0);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<number>("prs-incomplete", (e) => setRefused(e.payload)).then(
      (fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      },
      // Same tolerance as truncation: an advisory notice must not break
      // the page when the event bridge is absent.
      () => {},
    );
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return refused;
}

/// How many pull requests the review list is MISSING, or 0.
///
/// The 100 -> 50 fallback returns a short list and everything
/// downstream presented it as complete. The v3.5.3 diagnostic log
/// caught the consequence on a real machine: 50 pull requests shown
/// against a count of 62, with twelve gone and nothing to say so. That
/// is almost certainly the "numbers are off" report -- the sidebar
/// badge and the panel come from different queries, and only one of
/// them got truncated.
///
/// Advisory, like `useTruncation` and `useIncomplete`: the pull
/// requests that arrived are real, so the list is shown and annotated
/// rather than replaced with an error.
export function useReviewShortfall(): number {
  const [short, setShort] = useState(0);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<number>("reviewing-short", (e) => setShort(e.payload)).then(
      (fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      },
      // Same tolerance as the other advisories: a notice must not break
      // the page when the event bridge is absent.
      () => {},
    );
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return short;
}

export function useTruncation(): number | null {
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    // Tolerate a host without Tauri's event bridge (tests that do not opt
    // into mocked events, and any non-Tauri render). Truncation is an
    // advisory notice; failing to subscribe must not break the page.
    listen<number>("prs-truncated", (e) => setTotal(e.payload)).then(
      (fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return total;
}

/// The period comparisons behind the delta cards.
///
/// Separate from `useHistory` so the four headline numbers appear in about
/// a second rather than waiting on the whole daily series. Same staleTime,
/// so the two stay consistent within a session.
export function usePeriods() {
  return useQuery({
    queryKey: ["periods"],
    queryFn: getPeriods,
    staleTime: 5 * 60 * 1000,
  });
}

/// The daily series behind the activity chart.
///
/// Held for five minutes rather than the list's live cadence: these counts
/// move on the order of hours, and the query is only mounted while the
/// Stats view is open, so a shorter window would spend rate limit for no
/// visible change.
export function useHistory(days: number) {
  return useQuery({
    queryKey: ["history", days],
    queryFn: () => getHistory(days),
    staleTime: 5 * 60 * 1000,
  });
}

/// The merged-PR sample behind the insight cards and repo table. Kept
/// separate from `useHistory` so a slow or failed detail fetch leaves the
/// chart and cards fully rendered.
export function useMergedDetail() {
  return useQuery({
    queryKey: ["merged-detail"],
    queryFn: getMergedDetail,
    staleTime: 5 * 60 * 1000,
  });
}
