import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PullRequest } from "../types/pr";
import {
  getCached,
  getHistory,
  getMergedDetail,
  getCycleTrend,
  getPeriods,
  getPollInterval,
  getWorktreeDirs,
  classifyWorktrees,
  listWorktrees,
  removeWorktree,
  getReviewing,
  getStats,
  refreshNow,
  setPollInterval,
  setViewNeedsGithub,
  setWorktreeDirs,
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
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
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
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
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
      if (cancelled) fn();
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
      if (cancelled) fn();
      else unlistenUpdated = fn;
    });

    return () => {
      cancelled = true;
      unlistenError?.();
      unlistenUpdated?.();
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
export function usePollState(): "idle" | "fetching" {
  const [state, setState] = useState<"idle" | "fetching">("idle");

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>("poll-state", (e) => {
      setState(e.payload === "fetching" ? "fetching" : "idle");
    }).then(
      (fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      unlisten?.();
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
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
      void qc.invalidateQueries({ queryKey: ["worktree-safety", repoPath] });
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
        if (cancelled) fn();
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      unlisten?.();
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
