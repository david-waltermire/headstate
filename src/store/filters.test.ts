import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "./filters";

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {} } as const;
const active = () => {
  const s = useFilters.getState();
  return s.filtersByView[s.view];
};

describe("useFilters", () => {
  beforeEach(() =>
    useFilters.setState({ filtersByView: { ...EMPTY }, view: "my-prs", panel: "list" }),
  );

  it("sets an individual filter", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    expect(active().repo).toBe("octocat/hello-world");
  });

  it("a preset replaces the filter set rather than merging", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    useFilters.getState().applyPreset({ needsAttentionOnly: true });
    expect(active()).toEqual({ needsAttentionOnly: true });
  });

  it("a preset returns to the list panel", () => {
    useFilters.getState().setPanel("stats");
    useFilters.getState().applyPreset({ staleOnly: true });
    expect(useFilters.getState().panel).toBe("list");
  });

  // The reason filters are per-view: My PRs and Worktrees have entirely
  // different repo lists, so a selection in one is meaningless in the
  // other and would silently filter it to nothing.
  it("keeps each view's filters separate", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    useFilters.getState().setView("worktrees");
    expect(active().repo).toBeUndefined();

    useFilters.getState().setFilter("repo", "some/other-repo");
    useFilters.getState().setView("my-prs");
    expect(active().repo).toBe("octocat/hello-world");
  });

  it("reset clears filters but keeps the repo, per view", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    useFilters.getState().setFilter("staleOnly", true);
    useFilters.getState().reset();
    expect(active()).toEqual({ repo: "octocat/hello-world" });
  });

  // Switching views must not change which panel My PRs shows.
  it("panel is independent of view", () => {
    useFilters.getState().setPanel("stats");
    useFilters.getState().setView("to-review");
    useFilters.getState().setView("my-prs");
    expect(useFilters.getState().panel).toBe("stats");
  });
});

describe("persisted state migration", () => {
  // A store saved by v1 has a flat `filters` and a `view` enum that
  // conflated view with panel. Loading it into the new shape left
  // `filtersByView` undefined and crashed on first render -- invisible to
  // tests, which always start from empty, and hit immediately on a real
  // machine with saved state.
  const migrate = (useFilters.persist.getOptions().migrate ??
    ((s: unknown) => s)) as (s: unknown, v: number) => {
    filtersByView: Record<string, unknown>;
    view: string;
    panel: string;
  };

  it("lifts a v1 filter set into the active view", () => {
    const out = migrate({ filters: { repo: "octocat/hello-world" }, view: "list" }, 1);
    expect(out.view).toBe("my-prs");
    expect(out.panel).toBe("list");
    expect(out.filtersByView["my-prs"]).toEqual({ repo: "octocat/hello-world" });
  });

  it("maps the old dashboard enum to the stats panel", () => {
    const out = migrate({ filters: {}, view: "dashboard" }, 1);
    expect(out.view).toBe("my-prs");
    expect(out.panel).toBe("stats");
  });

  it("maps the old reviewing enum to the to-review view", () => {
    const out = migrate({ filters: {}, view: "reviewing" }, 1);
    expect(out.view).toBe("to-review");
  });

  it("survives a persisted value with nothing recognisable in it", () => {
    const out = migrate({}, 1);
    expect(out.view).toBe("my-prs");
    expect(out.filtersByView["my-prs"]).toEqual({});
  });

  // Every view must exist as a key, or reading the active one is undefined.
  it("always produces a complete filtersByView", () => {
    const out = migrate({ filters: { staleOnly: true }, view: "list" }, 1);
    expect(Object.keys(out.filtersByView).sort()).toEqual([
      "my-prs",
      "to-review",
      "worktrees",
    ]);
  });
});
