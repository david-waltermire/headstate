import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PullRequest } from "../types/pr";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useReviewing } from "./hooks";

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const pr = (n: number) => ({ number: n, title: `pr ${n}` }) as unknown as PullRequest;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => invoke.mockReset());

/// The reported complaint: To review "takes more than a minute to load,
/// with no indication that it is blocked", showing an empty panel the
/// whole time.
///
/// The cache still earns its place now that #328 has made the live query
/// fast: painting from disk beats any network round-trip.
///
/// The claim this comment used to carry -- "a bare 25-item search already
/// costs 6.2s", so the query could not be improved -- was a wrong
/// measurement. A bare search is ~0.7s; the cost was `mergeStateStatus`
/// at ~154ms per pull request.
describe("useReviewing paints from cache while the live query runs", () => {
  it("shows the cached list without waiting for GitHub", async () => {
    const live = deferred<PullRequest[]>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_cached_reviewing") return Promise.resolve([pr(1), pr(2)]);
      if (cmd === "get_reviewing") return live.promise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useReviewing(true), { wrapper: wrapper(client()) });

    // The cache resolves in milliseconds; the live query is still out.
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFromCache).toBe(true);
    expect(result.current.isRefreshing).toBe(true);

    live.resolve([pr(1), pr(2), pr(3)]);
  });

  /// Painting from cache must not mean showing stale data forever.
  it("replaces the cache with live data when it arrives", async () => {
    const live = deferred<PullRequest[]>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_cached_reviewing") return Promise.resolve([pr(1)]);
      if (cmd === "get_reviewing") return live.promise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useReviewing(true), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    live.resolve([pr(1), pr(2), pr(3)]);
    await waitFor(() => expect(result.current.data).toHaveLength(3));
    expect(result.current.isFromCache).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  /// A cold cache is the first-run case and must still report loading,
  /// or the panel would claim "no open pull requests" before asking.
  it("still reports loading when there is nothing cached", async () => {
    const live = deferred<PullRequest[]>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_cached_reviewing") return Promise.resolve([]);
      if (cmd === "get_reviewing") return live.promise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useReviewing(true), { wrapper: wrapper(client()) });
    // An EMPTY cached array is data, so the hook must not present it as
    // a finished answer while the live query is still running.
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.data ?? []).toHaveLength(0);

    live.resolve([pr(7)]);
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });

  it("reads nothing at all while the view is disabled", async () => {
    invoke.mockImplementation(() => Promise.resolve([]));
    renderHook(() => useReviewing(false), { wrapper: wrapper(client()) });
    expect(invoke).not.toHaveBeenCalled();
  });
});
