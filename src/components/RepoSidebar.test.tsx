import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "@/fixtures/prs";
import { useFilters } from "@/store/filters";
import { RepoSidebar } from "./RepoSidebar";

afterEach(() => {
  cleanup();
  useFilters.getState().reset();
});

describe("RepoSidebar", () => {
  it("lists only repos that currently have PRs", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    expect(screen.getByText("octocat/hello-world")).toBeDefined();
    expect(screen.getByText("octocat/spoon-knife")).toBeDefined();
  });

  it("always offers an All entry", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    expect(screen.getByText(/All/)).toBeDefined();
  });

  it("the All entry is selected by default", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    expect(screen.getByText("All repositories").closest("button")?.className).toContain(
      "bg-[#1f6feb]",
    );
  });

  it("selecting a repo writes through the shared filter store", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("octocat/spoon-knife"));
    expect(useFilters.getState().filters.repo).toBe("octocat/spoon-knife");
  });

  it("selecting All clears the repo filter", () => {
    useFilters.getState().setFilter("repo", "octocat/spoon-knife");
    render(<RepoSidebar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("All repositories"));
    expect(useFilters.getState().filters.repo).toBeUndefined();
  });

  it("shows a count badge per repo, busiest first in DOM order", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    const buttons = screen.getAllByRole("button");
    // All repositories, then octocat/hello-world (2), then
    // octocat/spoon-knife (1), then the two cross-repo destinations
    // pinned to the bottom.
    expect(buttons.map((b) => b.textContent)).toEqual([
      "All repositories3",
      "octocat/hello-world2",
      "octocat/spoon-knife1",
      "Awaiting your review",
      "Stats",
    ]);
  });

  /// Stats must be the LAST row, below every repo. Asserting the index
  /// rather than mere presence is the point: the whole request was to pin it
  /// to the bottom, and a Stats button that drifted into the repo list would
  /// still pass a presence check.
  it("pins Stats to the bottom, after every repo", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels[labels.length - 1]).toBe("Stats");
  });

  it("switches to the stats view and marks itself pressed", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    const stats = screen.getByRole("button", { name: /stats/i });
    expect(stats.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(stats);

    expect(useFilters.getState().view).toBe("dashboard");
    expect(
      screen.getByRole("button", { name: /stats/i }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  /// Picking a repo while on Stats has to return you to the list -- otherwise
  /// the click appears to do nothing, because the stats view ignores the repo
  /// filter entirely.
  it("returns to the list when a repo is chosen from the stats view", () => {
    useFilters.setState({ filters: {}, view: "dashboard" });
    render(<RepoSidebar prs={PR_FIXTURES} />);

    fireEvent.click(screen.getByRole("button", { name: /octocat\/hello-world/ }));

    expect(useFilters.getState().view).toBe("list");
    expect(useFilters.getState().filters.repo).toBe("octocat/hello-world");
  });
});
