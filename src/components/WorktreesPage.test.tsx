import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree, WorktreeRepo } from "@/types/pr";
import { useFilters } from "@/store/filters";

const state = vi.hoisted(() => ({
  repos: undefined as WorktreeRepo[] | undefined,
  isLoading: false,
  isError: false,
  classified: undefined as Worktree[] | undefined,
  classifying: false,
}));

vi.mock("../api/hooks", () => ({
  useWorktrees: () => ({
    data: state.repos,
    isLoading: state.isLoading,
    isError: state.isError,
    error: "boom",
    refetch: vi.fn(),
  }),
  useWorktreeSafety: () => ({ data: state.classified, isLoading: state.classifying }),
}));

import { WorktreesPage } from "./WorktreesPage";

const wt = (over: Partial<Worktree>): Worktree => ({
  path: "/code/proj-a",
  branch: "feature",
  head: "abc",
  size_bytes: 1024,
  safety: { kind: "unmerged" },
  is_main: false,
  ...over,
});

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {} } as const;

describe("WorktreesPage", () => {
  beforeEach(() => {
    Object.assign(state, {
      repos: [{ name: "proj", path: "/code/proj", worktrees: [wt({})] }],
      isLoading: false,
      isError: false,
      classified: undefined,
      classifying: false,
    });
    useFilters.setState({ filtersByView: { ...EMPTY }, view: "worktrees", panel: "list" });
  });

  it("says what it is doing while scanning", () => {
    state.isLoading = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/scanning for worktrees/i)).toBeTruthy();
  });

  it("surfaces a scan failure rather than showing an empty list", () => {
    state.isError = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/could not scan/i)).toBeTruthy();
  });

  // An unconfigured base directory must point at the fix, not read as
  // "you have no worktrees".
  it("points at settings when no repos are found", () => {
    state.repos = [];
    render(<WorktreesPage />);
    expect(screen.getByText(/no repositories found/i)).toBeTruthy();
    expect(screen.getByText(/settings/i)).toBeTruthy();
  });

  it("lists worktrees with their branch and size", () => {
    render(<WorktreesPage />);
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
  });

  // Safety is the primary axis: every row must say whether it can be
  // removed and, if not, why.
  it("states why a worktree cannot be removed", () => {
    state.classified = [wt({ safety: { kind: "never_pushed" } })];
    render(<WorktreesPage />);
    expect(screen.getByText(/only here/i)).toBeTruthy();
  });

  it("sorts by size, biggest first", () => {
    state.classified = [
      wt({ path: "/code/small", size_bytes: 1024 }),
      wt({ path: "/code/huge", size_bytes: 5 * 1024 ** 3 }),
    ];
    const { container } = render(<WorktreesPage />);
    const rows = Array.from(container.querySelectorAll(".font-mono")).map(
      (e) => e.textContent ?? "",
    );
    expect(rows[0]).toContain("huge");
  });

  it("says it is still checking before classification lands", () => {
    state.classifying = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/checking what is safe/i)).toBeTruthy();
  });

  // Nothing is deletable yet, and the button must not imply otherwise.
  it("disables removal", () => {
    state.classified = [wt({ safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    expect(screen.getByRole("button", { name: /remove/i })).toHaveProperty("disabled", true);
  });
});
