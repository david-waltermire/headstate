import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "@/store/filters";
import { RepoTable } from "./RepoTable";

const repos = [
  { repo: "acme/alpha", merged: 48 },
  { repo: "acme/beta", merged: 12 },
];

describe("RepoTable", () => {
  beforeEach(() => {
    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {} }, view: "my-prs", panel: "list" } as never);
  });

  it("lists repos with counts", () => {
    render(<RepoTable repos={repos} />);
    expect(screen.getByText("acme/alpha")).toBeTruthy();
    expect(screen.getByText("48")).toBeTruthy();
  });

  it("shows each repo's share of the total", () => {
    render(<RepoTable repos={repos} />);
    expect(screen.getByText("80%")).toBeTruthy(); // 48 of 60
  });

  it("shows an empty state", () => {
    render(<RepoTable repos={[]} />);
    expect(screen.getByText(/no merged pull requests/i)).toBeTruthy();
  });

  // The table's purpose is navigation, not just display.
  it("scopes to the repo and switches to the list when a row is clicked", () => {
    render(<RepoTable repos={repos} />);
    fireEvent.click(screen.getByText("acme/alpha"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].repo).toBe("acme/alpha");
    expect(useFilters.getState().panel).toBe("list");
  });
});
