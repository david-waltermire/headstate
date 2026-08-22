import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import type { Worktree } from "../types/pr";
import {
  clearPollError,
  usePollError,
  usePullRequests,
  useRefreshRequested,
  useRemoveWorktree,
  useStats,
} from "./hooks";

afterEach(() => {
  // Unmount every hook (which runs its `listen().then(unlisten)` cleanup)
  // before tearing down the mocked Tauri IPC internals -- otherwise a
  // still-mounted component's unmount effect calls the now-deleted
  // `unregisterListener` and throws inside React's commit phase.
  cleanup();
  clearMocks();
});

/// One `QueryClient` per test, not one per render: `wrapper` is invoked on
/// every re-render of the hook under test (RTL re-runs it whenever the
/// hook's own render count changes), so allocating `new QueryClient()`
/// inside the function body would hand `usePullRequests` a different
/// client's cache on each pass and make its `setQueryData` calls invisible
/// to the client `useQuery` is actually reading from.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
  // Exposed so a test can seed and inspect the cache directly. Cache
  // contents are the observable behaviour for a mutation hook that has no
  // return value of its own.
  wrapper.client = qc;
  return wrapper;
}

describe("usePullRequests", () => {
  it("returns the cached snapshot without calling refresh_now when non-empty", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return PR_FIXTURES;
      if (cmd === "refresh_now") throw new Error("should not be called");
      return undefined;
    }, { shouldMockEvents: true });

    const { result } = renderHook(() => usePullRequests(), { wrapper: makeWrapper() });

    // Assert on `data` directly rather than `isSuccess` first: `renderHook`
    // only republishes `result.current` from a `useEffect` that runs after
    // commit, so polling a boolean flag can observe a render that is
    // already stale by the time the next microtask runs. Waiting on the
    // actual value removes the race.
    await waitFor(() => expect(result.current.data).toEqual(PR_FIXTURES));
  });

  it("falls back to refresh_now when the cache is empty (first launch or first poll pending)", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return [];
      if (cmd === "refresh_now") return PR_FIXTURES;
      return undefined;
    }, { shouldMockEvents: true });

    const { result } = renderHook(() => usePullRequests(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(PR_FIXTURES));
  });

  it("updates query data when prs-updated fires", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return PR_FIXTURES;
      return undefined;
    }, { shouldMockEvents: true });

    const { result } = renderHook(() => usePullRequests(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(PR_FIXTURES));

    const updated = [PR_FIXTURES[0]];
    await emit("prs-updated", updated);

    await waitFor(() => expect(result.current.data).toEqual(updated));
  });

  it("removes its listener on unmount without throwing", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return PR_FIXTURES;
      return undefined;
    }, { shouldMockEvents: true });

    const { result, unmount } = renderHook(() => usePullRequests(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(PR_FIXTURES));

    expect(() => unmount()).not.toThrow();
    // Emitting after unmount must not throw or hang the test -- if teardown
    // raced `listen()`'s promise, a stale listener would still be
    // registered here and could call setQueryData on an unmounted query
    // client.
    await expect(emit("prs-updated", [])).resolves.not.toThrow();
  });
});

describe("useStats", () => {
  it("returns the stats payload", async () => {
    const stats = {
      merged_week: 1,
      merged_month: 4,
      in_merge_queue: 0,
      needs_attention: 0,
      awaiting_review: 0,
      ready_to_queue: 0,
      blocked_by_comments: 0,
    };
    mockIPC((cmd) => (cmd === "get_stats" ? stats : undefined));

    const { result } = renderHook(() => useStats(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(stats));
  });
});

describe("usePollError", () => {
  it("starts null and surfaces the poll-error payload", async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });

    const { result } = renderHook(() => usePollError(), { wrapper: makeWrapper() });
    expect(result.current).toBeNull();

    await emit("poll-error", "GitHub API rate limit exceeded");
    await waitFor(() =>
      expect(result.current).toBe("GitHub API rate limit exceeded"),
    );
  });

  it("clears on the next prs-updated", async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });

    const { result } = renderHook(() => usePollError(), { wrapper: makeWrapper() });
    await emit("poll-error", "network error");
    await waitFor(() => expect(result.current).toBe("network error"));

    await emit("prs-updated", PR_FIXTURES);
    await waitFor(() => expect(result.current).toBeNull());
  });
});

/// The tray's "Refresh now" wiring. Previously untested entirely, and it
/// carried two bugs: a single-argument `.then` that swallowed rejections,
/// and a banner that could only be cleared by an event `refresh_now` never
/// emits.
describe("useRefreshRequested", () => {
  it("fetches from GitHub and publishes the result on refresh-requested", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "get_cached") return PR_FIXTURES;
      if (cmd === "refresh_now") return [PR_FIXTURES[0]];
      return undefined;
    }, { shouldMockEvents: true });

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => {
        useRefreshRequested();
        return usePullRequests();
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    await emit("refresh-requested", null);
    // It must ask GitHub, not just re-read the snapshot -- the poll loop
    // keeps that snapshot non-empty, so an invalidate would be a no-op.
    await waitFor(() => expect(calls).toContain("refresh_now"));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });

  it("surfaces a failed tray refresh instead of swallowing it", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return PR_FIXTURES;
      if (cmd === "refresh_now") throw new Error("rate limit exceeded");
      return undefined;
    }, { shouldMockEvents: true });

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => {
        useRefreshRequested();
        return usePollError();
      },
      { wrapper },
    );

    await emit("refresh-requested", null);
    await waitFor(() => expect(result.current).toMatch(/rate limit exceeded/));
  });

  it("clears a stale error banner once a refresh succeeds", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_cached") return PR_FIXTURES;
      if (cmd === "refresh_now") return [PR_FIXTURES[0]];
      return undefined;
    }, { shouldMockEvents: true });

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => {
        useRefreshRequested();
        return usePollError();
      },
      { wrapper },
    );

    // A background poll failed a moment ago.
    await emit("poll-error", "network unreachable");
    await waitFor(() => expect(result.current).toBe("network unreachable"));

    // The user clicks "Refresh now" and it works. `refresh_now` never emits
    // `prs-updated`, so before the fix the banner stayed up to 300s.
    await emit("refresh-requested", null);
    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe("clearPollError", () => {
  it("resets the banner state", async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });
    const { result } = renderHook(() => usePollError(), { wrapper: makeWrapper() });
    await emit("poll-error", "boom");
    await waitFor(() => expect(result.current).toBe("boom"));
    clearPollError();
    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe("useRemoveWorktree", () => {
  const wt = (path: string): Worktree => ({
    path,
    branch: "b",
    head: "abc",
    size_bytes: 1,
    safety: { kind: "safe" },
    is_main: false,
    merged_at: null,
    upstream: null,
  });

  /// Re-classifying after a removal costs ~0.35s per worktree,
  /// sequentially -- 51 seconds on a 146-worktree repo. Removing one
  /// worktree cannot change any OTHER worktree's safety, since each
  /// verdict comes from that worktree's own state, so dropping the row
  /// from the cache is both instant and exactly as accurate.
  it("drops the removed row without re-classifying the repo", async () => {
    let classifyCalls = 0;
    mockIPC((cmd) => {
      if (cmd === "remove_worktree") return null;
      if (cmd === "classify_worktrees") {
        classifyCalls += 1;
        return [];
      }
      return undefined;
    }, { shouldMockEvents: true });

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useRemoveWorktree(), { wrapper });

    const qc = wrapper.client;
    qc.setQueryData(["worktree-safety", "/repo"], [wt("/repo/a"), wt("/repo/b")]);

    await result.current("/repo", "/repo/a");

    const after = qc.getQueryData<Worktree[]>(["worktree-safety", "/repo"]);
    expect(after?.map((w) => w.path)).toEqual(["/repo/b"]);
    expect(classifyCalls).toBe(0);
  });

  /// A refusal -- the backend re-checks safety at delete time and rejects
  /// a worktree that went dirty since the scan -- must leave the row
  /// exactly where it was.
  it("leaves the row in place when the removal fails", async () => {
    mockIPC((cmd) => {
      if (cmd === "remove_worktree") throw new Error("not safe to remove: 2 uncommitted files");
      return undefined;
    }, { shouldMockEvents: true });

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useRemoveWorktree(), { wrapper });

    const qc = wrapper.client;
    qc.setQueryData(["worktree-safety", "/repo"], [wt("/repo/a"), wt("/repo/b")]);

    await expect(result.current("/repo", "/repo/a")).rejects.toBeTruthy();

    const after = qc.getQueryData<Worktree[]>(["worktree-safety", "/repo"]);
    expect(after?.map((w) => w.path)).toEqual(["/repo/a", "/repo/b"]);
  });
});
