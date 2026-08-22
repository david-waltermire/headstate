import { beforeEach, describe, expect, it, vi } from "vitest";

/// Regression tests for a black-window crash on launch.
///
/// A store written before `worktrees` and `docker` joined the `View`
/// union comes back from disk with no key for them. `persist` REPLACES
/// `filtersByView` rather than merging, and the version-2 migration
/// returns already-v2 data untouched, so nothing filled the gap --
/// `useActiveFilters` returned undefined and `filters.sort` in App threw,
/// taking down the whole tree with no error boundary to catch it.
describe("rehydrating a store older than the current View union", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  /// Exactly the shape an older build wrote: already version 2, so the
  /// migration passes it through, but only two of the four views.
  const storeTwoViews = (view: string) =>
    localStorage.setItem(
      "headstate-filters",
      JSON.stringify({
        version: 2,
        state: {
          filtersByView: { "my-prs": { sort: "newest" }, "to-review": {} },
          view,
          panel: "list",
        },
      }),
    );

  it("fills in every view missing from the stored object", async () => {
    storeTwoViews("docker");
    const { useFilters } = await import("./filters");
    const { filtersByView } = useFilters.getState();
    // The two that crashed.
    expect(filtersByView.docker).toEqual({});
    expect(filtersByView.worktrees).toEqual({});
  });

  it("keeps the filters that were actually stored", async () => {
    storeTwoViews("my-prs");
    const { useFilters } = await import("./filters");
    // Backfilling must not clobber real persisted state.
    expect(useFilters.getState().filtersByView["my-prs"]).toEqual({ sort: "newest" });
  });

  // `merge` above is the real fix, and it makes the selector's `?? {}`
  // unreachable through normal rehydration. This test reaches the guard
  // the only way left: by writing a hole into the live store, standing in
  // for any future path that sets `view` before its filters exist.
  it("hands out empty filters, not undefined, if a view key is ever missing", async () => {
    const { useFilters, useActiveFilters } = await import("./filters");
    const { renderHook } = await import("@testing-library/react");
    useFilters.setState({
      view: "docker",
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {} } as never,
    });
    const { result } = renderHook(() => useActiveFilters());
    // This is the exact read App makes before calling `.sort` on it.
    expect(result.current).toEqual({});
    expect(() => result.current.sort).not.toThrow();
  });

  it("survives a stored filtersByView that is missing entirely", async () => {
    localStorage.setItem(
      "headstate-filters",
      JSON.stringify({ version: 2, state: { view: "worktrees", panel: "list" } }),
    );
    const { useFilters } = await import("./filters");
    const s = useFilters.getState();
    expect(s.filtersByView.worktrees).toEqual({});
    expect(s.filtersByView["my-prs"]).toEqual({});
  });
});
