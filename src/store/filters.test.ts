import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "./filters";

describe("useFilters", () => {
  beforeEach(() => useFilters.setState({ filters: {}, view: "list" }));

  it("sets an individual filter", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    expect(useFilters.getState().filters.repo).toBe("octocat/hello-world");
  });

  it("a preset replaces the filter set rather than merging", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    useFilters.getState().applyPreset({ needsAttentionOnly: true });
    expect(useFilters.getState().filters).toEqual({ needsAttentionOnly: true });
  });

  it("a preset switches to the list view", () => {
    useFilters.getState().setView("dashboard");
    useFilters.getState().applyPreset({ staleOnly: true });
    expect(useFilters.getState().view).toBe("list");
  });
});
