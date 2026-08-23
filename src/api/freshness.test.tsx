import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { useActOnPr, usePullRequests } from "./hooks";

afterEach(() => {
  cleanup();
  clearMocks();
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

/// The reported bug: "I close a PR and it stays in the list until I
/// reload the app."
///
/// `useActOnPr` DOES invalidate ["prs"], so the intent was there. But the
/// query's own queryFn reads the SQLite snapshot first and only falls
/// through to a live fetch when that snapshot is EMPTY:
///
///     const cached = await getCached();
///     if (cached.length > 0) return cached;   // <- always taken
///     return refreshNow();
///
/// With any PRs at all the fast path is always taken, so the refetch
/// re-reads the same stale rows the user is already looking at. The
/// invalidation is a no-op by construction, and the only route to truth
/// is the background poll's `prs-updated` push -- one GitHub round-trip
/// later, with no indication anything is happening.
describe("closing a pull request updates the list", () => {
  it("re-reads GitHub after a mutation, not the stale local snapshot", async () => {
    const closed = PR_FIXTURES[0];
    // The snapshot the poll loop last wrote: still contains the PR.
    const stale = PR_FIXTURES;
    // What GitHub returns now that it is closed.
    const fresh = PR_FIXTURES.filter((p) => p.number !== closed.number);

    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "get_cached") return stale;
      if (cmd === "refresh_now") return fresh;
      if (cmd === "act_on_pr") return null;
      return undefined;
    }, { shouldMockEvents: true });

    const { qc, wrapper } = wrap();
    const list = renderHook(() => usePullRequests(), { wrapper });
    await waitFor(() => expect(list.result.current.data).toHaveLength(stale.length));

    const { result: act } = renderHook(() => useActOnPr(), { wrapper });
    await act.current(closed.id, closed.repo, closed.number, "close");

    // The whole point: the closed PR is gone WITHOUT an app reload.
    await waitFor(() => {
      const data = qc.getQueryData(["prs"]) as typeof PR_FIXTURES;
      expect(data.map((p) => p.number)).not.toContain(closed.number);
    });
  });

  it("asks GitHub rather than re-reading the snapshot it already showed", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "get_cached") return PR_FIXTURES;
      if (cmd === "refresh_now") return [];
      if (cmd === "act_on_pr") return null;
      return undefined;
    }, { shouldMockEvents: true });

    const { wrapper } = wrap();
    const list = renderHook(() => usePullRequests(), { wrapper });
    await waitFor(() => expect(list.result.current.data).toBeDefined());

    const before = calls.filter((c) => c === "refresh_now").length;
    const { result: act } = renderHook(() => useActOnPr(), { wrapper });
    await act.current("id", "octocat/api", 1, "close");

    await waitFor(() => {
      const after = calls.filter((c) => c === "refresh_now").length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
