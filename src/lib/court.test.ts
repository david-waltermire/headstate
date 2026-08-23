import { describe, expect, it } from "vitest";
import { splitByCourt } from "./court";
import type { PullRequest } from "@/types/pr";

const pr = (over: Partial<PullRequest> = {}) =>
  ({
    repo: "octocat/api",
    number: 1,
    is_draft: false,
    ci: "success",
    merge: "mergeable",
    review: "none",
    in_merge_queue: false,
    ...over,
  }) as PullRequest;

/// Every predicate already existed in derive.ts, exposed as flat chips
/// across TWO SEPARATE VIEWS -- so no single screen answered "what is
/// the ball in my court on, right now?" across both authored and
/// review-requested pull requests. App.tsx already holds both lists.
///
/// Zero API cost: a regroup over data already in memory.
describe("splitByCourt", () => {
  it("puts a failing build of mine in my court", () => {
    const { mine } = splitByCourt([pr({ ci: "failure" })], []);
    expect(mine).toHaveLength(1);
  });

  it("puts changes requested on my pull request in my court", () => {
    const { mine } = splitByCourt([pr({ review: "changes_requested" })], []);
    expect(mine).toHaveLength(1);
  });

  it("puts a review requested of me in my court", () => {
    const { mine } = splitByCourt([], [pr({ review: "none" })]);
    expect(mine).toHaveLength(1);
  });

  // Someone else's failing build is NOT mine to fix -- the same
  // distinction `needsMyReview` already draws against `needsAttention`.
  it("does not claim someone else's broken build as mine", () => {
    const { mine, theirs } = splitByCourt([], [pr({ ci: "failure", review: "approved" })]);
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
  });

  it("puts a pull request awaiting someone else's review in their court", () => {
    const { mine, theirs } = splitByCourt([pr({ review: "review_required" })], []);
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
  });

  // Queued means the machine has it: nobody is being waited on.
  it("counts a queued pull request as nobody's court", () => {
    const { mine, theirs } = splitByCourt([pr({ review: "approved", in_merge_queue: true })], []);
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(0);
  });

  // A draft is not waiting on anyone -- it is unfinished by choice.
  it("counts a draft as nobody's court", () => {
    const { mine, theirs } = splitByCourt([pr({ is_draft: true })], []);
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(0);
  });

  // A draft with a RED BUILD is still mine: I broke it, draft or not.
  it("still claims a broken draft of mine", () => {
    const { mine } = splitByCourt([pr({ is_draft: true, ci: "failure" })], []);
    expect(mine).toHaveLength(1);
  });

  // The same pull request can appear in both lists (authored AND
  // review-requested is impossible on GitHub, but the lists are fetched
  // separately and must not double-count if they ever overlap).
  it("never lists the same pull request twice", () => {
    const p = pr({ ci: "failure" });
    const { mine } = splitByCourt([p], [p]);
    expect(mine).toHaveLength(1);
  });
});
