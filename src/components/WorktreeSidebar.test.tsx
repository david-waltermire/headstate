import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repos = vi.hoisted(() => vi.fn<() => unknown>(() => []));

vi.mock("../api/hooks", () => ({ useWorktrees: () => ({ data: repos() }) }));
vi.mock("./ViewSwitcher", () => ({ ViewSwitcher: () => null }));

import { WorktreeSidebar } from "./WorktreeSidebar";
import { useFilters } from "../store/filters";

/// `worktrees` includes the MAIN checkout, so a repo with only main has
/// a length of 1 and nothing anyone would remove.
const repo = (name: string, worktreeCount: number) => ({
  identity: null,
  name,
  path: `/code/${name}`,
  worktrees: Array.from({ length: worktreeCount }, (_, i) => ({ path: `/w/${name}/${i}` })),
});

beforeEach(() => {
  repos.mockReturnValue([]);
  useFilters.setState({
    filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} },
    view: "worktrees",
  } as never);
});

describe("WorktreeSidebar", () => {
  it("hides repositories whose only checkout is main", () => {
    repos.mockReturnValue([repo("busy", 3), repo("empty", 1), repo("bare", 0)]);
    render(<WorktreeSidebar />);
    expect(screen.getByText("busy")).toBeTruthy();
    expect(screen.queryByText("empty")).toBeNull();
    expect(screen.queryByText("bare")).toBeNull();
  });

  /// The total is built from the same `removable` rule, so hiding rows
  /// cannot change it. A total that moved when rows were hidden would
  /// be a different number pretending to be the same one.
  it("counts the same total whether or not rows are hidden", () => {
    repos.mockReturnValue([repo("busy", 3), repo("empty", 1)]);
    render(<WorktreeSidebar />);
    // 3 worktrees minus main = 2. The empty repo contributes 0, so the
    // total matches the one visible row -- scoped to the All row, since
    // both render the same digit.
    const all = screen.getByText("All repositories").closest("button");
    expect(all?.textContent).toContain("2");
  });

  /// A blank list reads as a failed scan, which is a different and more
  /// alarming thing than "everything is tidy".
  it("says so when every repository is empty, rather than rendering blank", () => {
    repos.mockReturnValue([repo("a", 1), repo("b", 1)]);
    render(<WorktreeSidebar />);
    expect(screen.getByText(/No worktrees in any scanned repository/i)).toBeTruthy();
  });

  /// Distinct message: the scan found nothing at all, which points at
  /// configuration rather than at a tidy machine.
  it("keeps the no-repositories message distinct", () => {
    repos.mockReturnValue([]);
    render(<WorktreeSidebar />);
    expect(screen.getByText(/No repositories found/i)).toBeTruthy();
    expect(screen.queryByText(/No worktrees in any scanned/i)).toBeNull();
  });
});
