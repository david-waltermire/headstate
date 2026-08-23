import { describe, expect, it } from "vitest";
import { rollupRepos } from "./rollup";
import type { WorktreeRepo, Worktree } from "@/types/pr";

const wt = (over: Partial<Worktree> = {}): Worktree =>
  ({
    path: "/w/a",
    branch: "feat/a",
    is_main: false,
    safety: { verdict: "safe" },
    size_bytes: 100,
    ...over,
  }) as Worktree;

const repo = (name: string, worktrees: Worktree[]): WorktreeRepo => ({
  identity: `octocat/${name}`,
  name,
  path: `/r/${name}`,
  worktrees,
});

/// With 37 repos, "All repositories" fell through to `repos?.[0]` -- the
/// FIRST repo, which `sort_for_sidebar` makes the largest. So the one
/// question the view could not answer was the one that needs every repo
/// at once: where is my disk going, and what is safe to delete anywhere?
describe("rollupRepos", () => {
  it("counts worktrees across every repo", () => {
    const rolled = rollupRepos([
      repo("a", [wt(), wt({ path: "/w/b" })]),
      repo("b", [wt({ path: "/w/c" })]),
    ]);
    expect(rolled.worktrees).toHaveLength(3);
  });

  // The main checkout is not a worktree anyone would delete, and
  // counting it makes every repo look like it has one more than it does.
  it("excludes main checkouts", () => {
    const rolled = rollupRepos([repo("a", [wt({ is_main: true }), wt({ path: "/w/b" })])]);
    expect(rolled.worktrees).toHaveLength(1);
  });

  it("sums size across repos", () => {
    const rolled = rollupRepos([
      repo("a", [wt({ size_bytes: 100 })]),
      repo("b", [wt({ path: "/w/b", size_bytes: 250 })]),
    ]);
    expect(rolled.totalBytes).toBe(350);
  });

  // A size that has not been measured yet is null, and treating it as
  // zero would report a confident total that is simply wrong.
  it("reports sizes as partial while any are unmeasured", () => {
    const rolled = rollupRepos([
      repo("a", [wt({ size_bytes: 100 })]),
      repo("b", [wt({ path: "/w/b", size_bytes: null })]),
    ]);
    expect(rolled.totalBytes).toBe(100);
    expect(rolled.sizesComplete).toBe(false);
  });

  it("says sizes are complete when every worktree has one", () => {
    expect(rollupRepos([repo("a", [wt({ size_bytes: 5 })])]).sizesComplete).toBe(true);
  });

  // Each row has to say which repo it came from, or a flat list of 295
  // paths is unreadable.
  it("labels every worktree with its repo", () => {
    const rolled = rollupRepos([repo("a", [wt()])]);
    expect(rolled.worktrees[0].repoName).toBe("a");
    expect(rolled.worktrees[0].repoPath).toBe("/r/a");
  });

  it("handles an empty list without inventing a total", () => {
    const rolled = rollupRepos([]);
    expect(rolled.worktrees).toEqual([]);
    expect(rolled.totalBytes).toBe(0);
    // Nothing to measure is not the same as "measurement finished".
    expect(rolled.sizesComplete).toBe(true);
  });

  // Biggest first: the whole point is finding where the disk went.
  it("sorts by size, largest first", () => {
    const rolled = rollupRepos([
      repo("a", [wt({ size_bytes: 10 })]),
      repo("b", [wt({ path: "/w/b", size_bytes: 900 })]),
    ]);
    expect(rolled.worktrees[0].size_bytes).toBe(900);
  });

  // An unmeasured worktree must not sort as if it were empty and vanish
  // to the bottom -- it is unknown, not small.
  it("keeps unmeasured worktrees above the smallest measured ones", () => {
    const rolled = rollupRepos([
      repo("a", [wt({ size_bytes: 1 })]),
      repo("b", [wt({ path: "/w/b", size_bytes: null })]),
    ]);
    expect(rolled.worktrees[0].size_bytes).toBeNull();
  });
});
