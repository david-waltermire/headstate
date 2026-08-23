import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FilterBar } from "./FilterBar";
import { useFilters } from "@/store/filters";
import { PR_FIXTURES } from "../fixtures/prs";

afterEach(() => {
  cleanup();
  useFilters.getState().reset();
  useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} } });
});

/// The Reviews trigger rendered `${filters.review}` directly, so choosing
/// "Changes requested" made the button read `Reviews: changes_requested`
/// -- raw snake_case database jargon in the most-used view. The Sort
/// trigger three blocks below already looked its label up correctly,
/// which is what makes this an oversight rather than a convention.
describe("FilterBar review trigger", () => {
  it("shows the human label, not the enum value", () => {
    useFilters.setState({
      filtersByView: {
        "my-prs": { review: "changes_requested" },
        "to-review": {},
        worktrees: {},
        docker: {},
      },
    });
    render(<FilterBar prs={PR_FIXTURES} />);
    expect(screen.getByText(/Reviews: Changes requested/)).toBeTruthy();
    expect(screen.queryByText(/changes_requested/)).toBeNull();
  });

  it("shows the same for review_required, the other snake_case value", () => {
    useFilters.setState({
      filtersByView: {
        "my-prs": { review: "review_required" },
        "to-review": {},
        worktrees: {},
        docker: {},
      },
    });
    render(<FilterBar prs={PR_FIXTURES} />);
    expect(screen.queryByText(/review_required/)).toBeNull();
  });
});
