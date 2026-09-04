import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Typed, so a test can resolve with a real error: the inferred type
// from a null-only literal rejects the failure fixture.
const invoke = vi.hoisted(() =>
  vi.fn<(...a: unknown[]) => Promise<{ path: string; error: string | null }[]>>(() =>
    Promise.resolve([{ path: "/code/a/target", error: null }]),
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useRemoveArtifacts } from "./hooks";

/// #439/#422: removing artifacts re-measured EVERY group on the machine.
///
/// Measured on a real removal: 54 concurrent `size_artifacts` calls all
/// finishing around 17.8s, with groups of two directories taking 17.6s.
/// The 20.4-second "freeze" after a deletion was this — not
/// `remove_dir_all`, and not rendering, which cost 1ms.
describe("useRemoveArtifacts", () => {
  beforeEach(() => invoke.mockClear());

  const harness = () => {
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
    return { qc, invalidated, wrapper };
  };

  it("does not invalidate the sizes, which re-walked every group", async () => {
    const { invalidated, wrapper } = harness();
    const { result } = renderHook(() => useRemoveArtifacts(), { wrapper });
    await result.current(["/code/a/target"]);

    // The scan MUST refresh: a removed directory has to leave the list.
    expect(invalidated).toContain("artifacts");
    // The sizes must not. This is the storm.
    expect(invalidated).not.toContain("artifact-sizes");
  });

  /// Dropping the removed rows is what makes not-invalidating safe: the
  /// total would otherwise keep counting bytes that are gone, which is
  /// the reason the invalidation was there in the first place.
  it("drops the removed paths from the cached sizes", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData<[string, number, number | null][]>(
      ["artifact-sizes", "/code/a"],
      [
        ["/code/a/target", 1000, 60],
        ["/code/a/node_modules", 2000, 60],
      ],
    );

    const { result } = renderHook(() => useRemoveArtifacts(), { wrapper });
    await result.current(["/code/a/target"]);

    const after = qc.getQueryData<[string, number, number | null][]>([
      "artifact-sizes",
      "/code/a",
    ]);
    expect(after?.map(([p]) => p)).toEqual(["/code/a/node_modules"]);
  });

  /// A directory that could NOT be removed is still on disk, so its size
  /// is still correct and must survive.
  it("keeps a path that failed to remove", async () => {
    invoke.mockResolvedValueOnce([
      { path: "/code/a/target", error: "a build is writing there" },
    ]);
    const { qc, wrapper } = harness();
    qc.setQueryData<[string, number, number | null][]>(
      ["artifact-sizes", "/code/a"],
      [["/code/a/target", 1000, 60]],
    );

    const { result } = renderHook(() => useRemoveArtifacts(), { wrapper });
    await result.current(["/code/a/target"]);

    const after = qc.getQueryData<[string, number, number | null][]>([
      "artifact-sizes",
      "/code/a",
    ]);
    expect(after?.map(([p]) => p)).toEqual(["/code/a/target"]);
  });
});
