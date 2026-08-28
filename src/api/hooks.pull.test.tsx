import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve("Already up to date.")));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { usePullCheckout } from "./hooks";

/// #346: "Update to latest" appeared to do nothing — the row stayed
/// yellow saying "N commits behind" for ~10 seconds after a SUCCESSFUL
/// pull, so the button looked broken.
///
/// The pull invalidated `["worktrees"]`, the base listing. But the
/// upstream line is rendered from `["worktree-safety"]`, which nothing
/// invalidated — it only refreshed when something else happened to.
describe("usePullCheckout", () => {
  beforeEach(() => invoke.mockClear());

  it("refreshes the classification that renders the upstream line", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated: unknown[] = [];
    const original = qc.invalidateQueries.bind(qc);
    vi.spyOn(qc, "invalidateQueries").mockImplementation((filters) => {
      invalidated.push((filters as { queryKey?: unknown[] })?.queryKey?.[0]);
      return original(filters);
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePullCheckout(), { wrapper });
    await result.current("/code/proj");

    await waitFor(() => expect(invalidated).toContain("worktrees"));
    // The one that was missing. Without it a successful pull leaves the
    // row saying the checkout is still behind.
    expect(invalidated).toContain("worktree-safety");
  });
});
