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
    // All repositories, then octocat/hello-world (2), then octocat/spoon-knife (1).
    expect(buttons.map((b) => b.textContent)).toEqual([
      "All repositories3",
      "octocat/hello-world2",
      "octocat/spoon-knife1",
    ]);
  });
});
