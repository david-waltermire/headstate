import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "@/fixtures/prs";
import { PrioritiesStrip } from "./PrioritiesStrip";

describe("PrioritiesStrip", () => {
  it("shows PRs with failing CI or conflicts", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.getByText(/Fix flaky timezone test/)).toBeDefined();
  });

  it("does not show healthy PRs", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.queryByText(/Add retry to the fetch client/)).toBeNull();
  });

  /// The strip is only worth looking at if it never cries wolf. A PR whose
  /// mergeability GitHub has not finished computing is not a conflict.
  it("does not show a PR whose merge state is still checking", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.queryByText(/Bump the parser dependency/)).toBeNull();
  });

  it("renders a quiet line when nothing needs attention", () => {
    render(<PrioritiesStrip prs={[PR_FIXTURES[0]]} />);
    expect(screen.getByText(/Nothing blocked/i)).toBeDefined();
  });

  /// Not hypothetical: two of the author's real open PRs were conflicted AND
  /// red at once. Reporting only the first reason means fixing the rebase,
  /// coming back, and only then learning CI is also failing.
  it("names both reasons when a PR is conflicted and red", () => {
    const both = prWithState("failure", "conflicted", "none");
    const { container } = render(<PrioritiesStrip prs={[both]} />);
    expect(container.textContent).toContain("merge conflicts and CI failing");
  });

  it("names only the applicable reason when a PR is merely red", () => {
    const redOnly = prWithState("failure", "mergeable", "none");
    const { container } = render(<PrioritiesStrip prs={[redOnly]} />);
    expect(container.textContent).toContain("CI failing");
    expect(container.textContent).not.toContain("merge conflicts");
  });
});
