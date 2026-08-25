import { describe, expect, it } from "vitest";
import { readyForReview } from "./derive";
import type { PullRequest } from "@/types/pr";

const pr = (over: Partial<PullRequest> = {}) =>
  ({
    is_draft: false,
    ci: "success",
    merge: "mergeable",
    review: "none",
    in_merge_queue: false,
    ...over,
  }) as PullRequest;

/// The review queue's counterpart to "Needs your attention": what is
/// ready to be reviewed right now, so a reviewer can start with the pull
/// requests that will not waste their time.
describe("readyForReview", () => {
  it("includes a green, non-draft pull request", () => {
    expect(readyForReview(pr())).toBe(true);
  });

  // A draft is not asking to be reviewed.
  it("excludes drafts", () => {
    expect(readyForReview(pr({ is_draft: true }))).toBe(false);
  });

  // Reviewing code whose tests are failing wastes the reviewer's time
  // and the author's -- it is going to change.
  it("excludes failing CI", () => {
    expect(readyForReview(pr({ ci: "failure" }))).toBe(false);
  });

  // "Ready" means the checks have PASSED, not that they have not failed
  // yet. A run in progress may still go red.
  it("excludes CI still running", () => {
    expect(readyForReview(pr({ ci: "pending" }))).toBe(false);
  });

  // A repository with no CI configured has nothing to wait for, and its
  // pull requests are as ready as they will ever be. Excluding them
  // would empty this section for anyone not running checks.
  it("includes a repository with no CI at all", () => {
    expect(readyForReview(pr({ ci: "none" }))).toBe(true);
  });

  // Conflicts have to be resolved before a review is worth giving: the
  // diff a reviewer reads is not the diff that will land.
  it("excludes a conflicted pull request", () => {
    expect(readyForReview(pr({ merge: "conflicted" }))).toBe(false);
  });

  // Already approved, or already changes-requested, means a reviewer has
  // acted. This section is what is WAITING.
  it("excludes anything already reviewed", () => {
    expect(readyForReview(pr({ review: "approved" }))).toBe(false);
    expect(readyForReview(pr({ review: "changes_requested" }))).toBe(false);
  });

  // Queued means the machine has it; nobody is being waited on.
  it("excludes a pull request already in the merge queue", () => {
    expect(readyForReview(pr({ in_merge_queue: true }))).toBe(false);
  });
});
