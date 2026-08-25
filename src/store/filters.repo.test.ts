import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "./filters";

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} };

beforeEach(() => {
  useFilters.setState({
    view: "my-prs",
    panel: "list",
    selectedPr: null,
    filtersByView: { ...EMPTY },
  });
});

/// Reported: after opening a pull request, clicking a repository in the
/// sidebar left the detail view on screen. The sidebar appeared to do
/// nothing, and "Back to list" was required every time.
///
/// Choosing a repo is NAVIGATION -- it is how the sidebar changes page
/// -- so it has to leave the detail view.
describe("choosing a repository", () => {
  it("closes the detail view", () => {
    useFilters.setState({ selectedPr: { repo: "octocat/api", number: 1 } });
    useFilters.getState().setFilter("repo", "octocat/web");
    expect(useFilters.getState().selectedPr).toBeNull();
  });

  it("closes it when clearing back to all repositories", () => {
    useFilters.setState({ selectedPr: { repo: "octocat/api", number: 1 } });
    useFilters.getState().setFilter("repo", undefined);
    expect(useFilters.getState().selectedPr).toBeNull();
  });

  // The other filters narrow the list you are looking at. Closing the
  // detail view on a label filter would throw away what you are reading.
  it("leaves the detail view open for every other filter", () => {
    for (const key of ["query", "sort", "draftsOnly", "staleOnly"] as const) {
      useFilters.setState({ selectedPr: { repo: "octocat/api", number: 1 } });
      useFilters.getState().setFilter(key, "x" as never);
      expect(useFilters.getState().selectedPr).not.toBeNull();
    }
  });

  it("still applies the repo filter itself", () => {
    useFilters.getState().setFilter("repo", "octocat/web");
    expect(useFilters.getState().filtersByView["my-prs"].repo).toBe("octocat/web");
  });
});
