import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Worktree, WorktreeRepo } from "@/types/pr";

const invoke = vi.hoisted(() =>
  vi.fn<(...a: unknown[]) => Promise<{ path: string; error: string | null }[]>>(() =>
    Promise.resolve([{ path: "/code/a/wt1", error: null }]),
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useRemoveWorktrees } from "./hooks";

const wt = (path: string) => ({ path, branch: "b" }) as unknown as Worktree;

/// #435: a bulk removal reported success and the same worktrees were
/// still listed afterwards.
///
/// The page renders `classified ?? selected?.worktrees`, so it reads the
/// SAFETY cache when present and falls back to the base listing when
/// not. Only the first was updated, so whenever the classification had
/// not arrived the removed rows came straight back.
describe("useRemoveWorktrees", () => {
  beforeEach(() => invoke.mockClear());

  const harness = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return { qc, wrapper };
  };

  it("drops the removed worktree from the safety cache", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData<Worktree[]>(
      ["worktree-safety", "/code/a"],
      [wt("/code/a/wt1"), wt("/code/a/wt2")],
    );

    const { result } = renderHook(() => useRemoveWorktrees(), { wrapper });
    await result.current("/code/a", ["/code/a/wt1"]);

    const after = qc.getQueryData<Worktree[]>(["worktree-safety", "/code/a"]);
    expect(after?.map((w) => w.path)).toEqual(["/code/a/wt2"]);
  });

  /// The half that was missing. Without it the fallback still serves the
  /// removed row until a refetch lands.
  it("drops it from the base listing too, not only the classification", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData<WorktreeRepo[]>(
      ["worktrees"],
      [{ path: "/code/a", worktrees: [wt("/code/a/wt1"), wt("/code/a/wt2")] } as WorktreeRepo],
    );

    const { result } = renderHook(() => useRemoveWorktrees(), { wrapper });
    await result.current("/code/a", ["/code/a/wt1"]);

    const after = qc.getQueryData<WorktreeRepo[]>(["worktrees"]);
    expect(after?.[0].worktrees.map((w) => w.path)).toEqual(["/code/a/wt2"]);
  });

  /// A worktree that could NOT be removed is still on disk and must stay
  /// on screen -- it is the one that still needs attention.
  it("keeps a worktree that failed to remove", async () => {
    invoke.mockResolvedValueOnce([{ path: "/code/a/wt1", error: "it went dirty" }]);
    const { qc, wrapper } = harness();
    qc.setQueryData<Worktree[]>(["worktree-safety", "/code/a"], [wt("/code/a/wt1")]);

    const { result } = renderHook(() => useRemoveWorktrees(), { wrapper });
    await result.current("/code/a", ["/code/a/wt1"]);

    const after = qc.getQueryData<Worktree[]>(["worktree-safety", "/code/a"]);
    expect(after?.map((w) => w.path)).toEqual(["/code/a/wt1"]);
  });
});
