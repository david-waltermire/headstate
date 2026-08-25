import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useReviewing, useReviewingCount } from "./hooks";

afterEach(() => {
  cleanup();
  clearMocks();
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return wrapper;
}

/// The review list ran on EVERY view -- including Docker and Worktrees,
/// which render no pull requests -- purely so a sidebar badge could
/// display its length. That is a 100-node query for a number, and on a
/// slow account it failed there too.
describe("the review queue is fetched only where it is shown", () => {
  it("does not ask for the list when disabled", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "get_reviewing") return [];
      if (cmd === "count_reviewing") return 3;
      return undefined;
    });

    renderHook(() => useReviewing(false), { wrapper: wrap() });
    // Give any queued fetch a chance to fire before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain("get_reviewing");
  });

  it("asks for the list when enabled", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "get_reviewing") return [];
      return undefined;
    });

    renderHook(() => useReviewing(true), { wrapper: wrap() });
    await waitFor(() => expect(calls).toContain("get_reviewing"));
  });

  // The badge must still have a number on every view -- it just gets it
  // from a query that costs 1 point instead of 6.
  it("counts without fetching the list", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "count_reviewing") return 7;
      return undefined;
    });

    const { result } = renderHook(() => useReviewingCount(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toBe(7));
    expect(calls).not.toContain("get_reviewing");
  });
});
