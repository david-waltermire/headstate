import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Typed by its SIGNATURE, so `mock.calls[i][0]` is a string without an
// unused parameter that lint rejects.
const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string) => Promise<unknown[]>>(() => Promise.resolve([])),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useVenvs } from "./hooks";

/// #431: the virtualenv page never settled. A real recording showed
/// rescans at 18:28, 18:31, 18:34 and 18:37 -- each 9-40 seconds of
/// scanning followed by up to 73 seconds of sizing -- because
/// `staleTime` was 60 SECONDS on a scan that takes far longer than
/// that. The page spent essentially all of its life re-measuring, so
/// sizes never appeared to populate.
describe("useVenvs cadence", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("does not refetch on a cadence shorter than the scan itself", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useVenvs(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const scans = () =>
      invoke.mock.calls.filter((c) => c[0] === "scan_venvs").length;
    expect(scans()).toBe(1);

    // BEHAVIOUR, not configuration: remounting inside the stale window
    // must reuse the cached result rather than starting another
    // 9-40 second scan. With the old 60-second window this is exactly
    // what kept firing.
    vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
    const second = renderHook(() => useVenvs(true), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(scans()).toBe(1);
  });
});
