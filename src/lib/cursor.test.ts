import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "@/store/filters";

beforeEach(() => useFilters.setState({ cursor: null, checked: [], view: "my-prs" }));

/// The cursor is an INDEX into the visible list, not a PR key: the list
/// being arrowed through is the filtered, sorted one, and a key would
/// silently point at a row that filtering has removed.
describe("keyboard cursor state", () => {
  it("starts absent, so nothing is highlighted before a key is pressed", () => {
    expect(useFilters.getState().cursor).toBeNull();
  });

  it("clears with the view, like the selection", () => {
    useFilters.setState({ cursor: 3 });
    useFilters.getState().setView("to-review");
    expect(useFilters.getState().cursor).toBeNull();
  });

  // A cursor left over from My PRs would point at an unrelated row in
  // the review queue -- and `x` would then select the wrong PR.
  it("clears the selection with the view too", () => {
    useFilters.setState({ cursor: 1, checked: ["a/b#1"] });
    useFilters.getState().setView("worktrees");
    expect(useFilters.getState().checked).toEqual([]);
    expect(useFilters.getState().cursor).toBeNull();
  });
});
