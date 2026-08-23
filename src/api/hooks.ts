import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten } from "./unlisten";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DockerImage, PullRequest, Worktree } from "../types/pr";
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
  assessedWorktrees,
  dockerBuildDetail,
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
  sizeWorktrees,
  getReviewing,
  getStats,
  refreshNow,
  setPollInterval,
  setViewNeedsGithub,
  setWorktreeDirs,
  reviewPr,
  commentOnPr,
  getViewer,
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
    queryFn: async () => {
      const cached = await getCached();
      // Show the cache immediately; the poll loop supplies fresh data.
      if (cached.length > 0) return cached;
      return refreshNow();
    },
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
      void qc.invalidateQueries({ queryKey: ["pr-detail", repo, number] });
      void qc.invalidateQueries({ queryKey: ["reviewing"] });
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

/// Remove a worktree, then refresh both queries.
///
/// Deliberately NOT optimistic. Every other mutation in this app updates
/// locally first, but this one deletes files: showing a row as gone
/// before the deletion succeeded would be a lie about the filesystem, and
/// the failure case here is "your work is still there", which the user
/// needs to see rather than have hidden.
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

/// One build's context and revision, fetched only when selected.
export function useDockerBuildDetail(reference: string | undefined) {
  return useQuery({
    queryKey: ["docker-build", reference],
    queryFn: () => dockerBuildDetail(reference as string),
    enabled: Boolean(reference),
    staleTime: 60_000,
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

/// PRs awaiting the user's review.
///
/// The app previously queried only `author:@me`, so it could say nothing
/// about the queue the user is the bottleneck for -- the largest gap for a
/// daily driver. Same 60s staleness as the authored list.
export function useReviewing() {
  return useQuery({
    queryKey: ["reviewing"],
    queryFn: getReviewing,
    staleTime: 60_000,
  });
}

/// GitHub's true open-PR count, when it exceeds what the query returned.
///
/// `null` in the normal case. The Rust loop emits `prs-truncated` only
/// above the 100-PR page size, so this stays quiet for almost everyone
/// while making the cap visible to the accounts it actually affects.
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
