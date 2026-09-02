import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repos = vi.hoisted(() => vi.fn<() => unknown>(() => []));

vi.mock("../api/hooks", () => ({ useWorktrees: () => ({ data: repos() }) }));
vi.mock("./ViewSwitcher", () => ({ ViewSwitcher: () => null }));

import { WorktreeSidebar } from "./WorktreeSidebar";
import { useFilters } from "../store/filters";

/// `worktrees` includes the MAIN checkout, so a repo with only main has
/// nothing anyone would remove.
///
/// `is_main` is set on the first entry, which the real scanner always
/// does. The fixture omitted it before, and the count was computed as
/// `n - 1` -- so the two agreed by coincidence rather than because the
/// fixture was right. An ORPHANED repo has no main at all, which is
/// what broke that arithmetic.
const repo = (name: string, worktreeCount: number) => ({
  identity: null,
  name,
  path: `/code/${name}`,
  worktrees: Array.from({ length: worktreeCount }, (_, i) => ({
    path: `/w/${name}/${i}`,
    is_main: i === 0,
    safety: { kind: "safe" as const },
  })),
});

/// A repository record for an ORPHAN: one worktree, no main checkout.
const orphanRepo = (name: string) => ({
  identity: null,
  name,
  path: `/code/${name}`,
  worktrees: [
    { path: `/code/${name}`, is_main: false, safety: { kind: "orphaned" as const } },
  ],
});

beforeEach(() => {
  repos.mockReturnValue([]);
  useFilters.setState({
    filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} },
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

  /// Reported: orphans were invisible in the sidebar. `n - 1` assumed
  /// every repository has a main checkout -- an orphan has one entry
  /// and no main, so it counted as zero and the row was hidden.
  describe("orphans", () => {
    it("gives them their own section rather than a repo row", () => {
      repos.mockReturnValue([repo("busy", 3), orphanRepo("veil-coh")]);
      render(<WorktreeSidebar />);
      expect(screen.getByText("Orphaned")).toBeTruthy();
      // NOT listed among the repositories: an orphan is not one.
      expect(screen.queryByText("veil-coh")).toBeNull();
    });

    it("counts them, and does not fold them into the repository total", () => {
      repos.mockReturnValue([
        repo("busy", 3),
        orphanRepo("a"),
        orphanRepo("b"),
      ]);
      render(<WorktreeSidebar />);
      const orphan = screen.getByText("Orphaned").closest("button");
      expect(orphan?.textContent).toContain("2");
    });

    /// A permanent empty heading trains the eye to skip it.
    it("is absent entirely when there are none", () => {
      repos.mockReturnValue([repo("busy", 3)]);
      render(<WorktreeSidebar />);
      expect(screen.queryByText("Orphaned")).toBeNull();
    });

    /// The reported symptom behind the 120-vs-123 mismatch: the
    /// sidebar's `n - 1` undercounted by exactly the number of
    /// repositories with no main checkout.
    it("counts a repository by what is not its main checkout", () => {
      repos.mockReturnValue([repo("busy", 3), orphanRepo("orphan")]);
      render(<WorktreeSidebar />);
      const all = screen.getByText("All repositories").closest("button");
      // 2 removable in `busy`, plus the 1 orphan = 3.
      expect(all?.textContent).toContain("3");
    });
  });
});
