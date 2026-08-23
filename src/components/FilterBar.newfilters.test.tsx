import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FilterBar } from "./FilterBar";
import { useFilters } from "@/store/filters";
import { PR_FIXTURES } from "../fixtures/prs";

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} };

afterEach(() => {
  cleanup();
  useFilters.setState({ filtersByView: { ...EMPTY } });
});

/// `applyFilters` has implemented `ci` and `inMergeQueueOnly` all along
/// (derive.ts:144 and :149) -- they simply had no control. `ci` was
/// reachable only from inside NudgeWizard's local state, which never
/// wrote the store, and `inMergeQueueOnly` had zero UI references
/// anywhere in the app.
///
/// `in_merge_queue` is rendered on rows, counted by deriveStats, and
/// gates kebab actions -- so the one thing you could not do with it was
/// filter to it.
describe("filters that existed in the engine but had no control", () => {
  it("filters by CI status", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /^CI/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /failing/i }));
    expect(useFilters.getState().filtersByView["my-prs"].ci).toBe("failure");
  });

  it("names the CI selection in the trigger, in prose", () => {
    useFilters.setState({
      filtersByView: { ...EMPTY, "my-prs": { ci: "failure" } },
    });
    render(<FilterBar prs={PR_FIXTURES} />);
    expect(screen.getByText(/CI: Failing/)).toBeTruthy();
    // The enum must not leak, which is the bug this pairs with.
    expect(screen.queryByText(/failure/)).toBeNull();
  });

  it("toggles the merge-queue filter", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /in merge queue/i }));
    expect(useFilters.getState().filtersByView["my-prs"].inMergeQueueOnly).toBe(true);
  });

  it("turns the merge-queue filter back off", () => {
    useFilters.setState({
      filtersByView: { ...EMPTY, "my-prs": { inMergeQueueOnly: true } },
    });
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /in merge queue/i }));
    expect(useFilters.getState().filtersByView["my-prs"].inMergeQueueOnly).toBeUndefined();
  });
});
