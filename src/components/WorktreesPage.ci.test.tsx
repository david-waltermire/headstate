import { describe, expect, it } from "vitest";
import { worktreeSignal } from "@/lib/worktrees";
import type { PullRequest } from "@/types/pr";

const pr = (over: Partial<PullRequest> = {}) =>
  ({ number: 7, ci: "success", merge: "mergeable", review: "approved", ...over }) as PullRequest;

/// `prForWorktree` (shipped in #243) already resolves the pull request
/// for a worktree row, but the row rendered only its NUMBER. The
/// PullRequest in hand carries `ci`, `merge`, and `review` -- so the row
/// can say "this checkout's pull request is red" with no new call.
///
/// That is usually the reason to come back to a worktree at all.
describe("worktreeSignal", () => {
  // Both spellings of "no pull request": the row's prop is optional.
  it("says nothing without a pull request", () => {
    expect(worktreeSignal(null)).toBeNull();
    expect(worktreeSignal(undefined)).toBeNull();
  });

  // Red CI is the loudest thing a PR can say, so it wins.
  it("reports failing CI first", () => {
    expect(worktreeSignal(pr({ ci: "failure", merge: "conflicted" }))?.label).toMatch(/failing/i);
  });

  it("reports conflicts when CI is not failing", () => {
    expect(worktreeSignal(pr({ ci: "success", merge: "conflicted" }))?.label).toMatch(/conflict/i);
  });

  it("reports changes requested", () => {
    expect(
      worktreeSignal(pr({ ci: "success", merge: "mergeable", review: "changes_requested" }))?.label,
    ).toMatch(/changes requested/i);
  });

  // A healthy PR gets no marker: a badge on every row is noise, and the
  // number is already a link for anyone who wants the detail.
  it("stays quiet when nothing is wrong", () => {
    expect(worktreeSignal(pr())).toBeNull();
  });

  // Running CI is not a problem, just an unfinished answer.
  it("stays quiet while CI is still running", () => {
    expect(worktreeSignal(pr({ ci: "pending" }))).toBeNull();
  });
});
