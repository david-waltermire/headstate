import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { usePollError, usePullRequests, useStats } from "./hooks";

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
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
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
