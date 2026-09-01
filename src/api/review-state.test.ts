import { describe, expect, it } from "vitest";
import type { PrDetail } from "../types/pr";
import { REVIEW_STATE, withOwnReview } from "./hooks";

const detail = (reviews: { author: string; state: string }[]) =>
  ({ latest_reviews: reviews }) as PrDetail;

describe("REVIEW_STATE", () => {
  it("maps the verdicts that change the viewer's own review state", () => {
    expect(REVIEW_STATE.approve).toBe("APPROVED");
    expect(REVIEW_STATE.request_changes).toBe("CHANGES_REQUESTED");
  });

  // A COMMENT review does not make the viewer an approver. Seeding one
  // would invent a state change that never happened, and the Approve
  // button would then claim an approval the user did not give.
  it("does not map comment to a review state", () => {
    expect(REVIEW_STATE.comment).toBeUndefined();
  });
});

describe("withOwnReview", () => {
  // The bug: GitHub's `latestReviews` lags the mutation, so the refetch
  // can return the PRE-approval set and the button reverts to "Approve"
  // for an approval that landed.
  it("adds the viewer's review when they had none", () => {
    const out = withOwnReview(detail([]), "octocat", "APPROVED");
    expect(out.latest_reviews).toEqual([{ author: "octocat", state: "APPROVED" }]);
  });

  it("replaces the viewer's previous review rather than duplicating it", () => {
    const out = withOwnReview(
      detail([{ author: "octocat", state: "CHANGES_REQUESTED" }]),
      "octocat",
      "APPROVED",
    );
    expect(out.latest_reviews).toHaveLength(1);
    expect(out.latest_reviews[0].state).toBe("APPROVED");
  });

  it("leaves other reviewers' verdicts alone", () => {
    const out = withOwnReview(
      detail([
        { author: "hubot", state: "CHANGES_REQUESTED" },
        { author: "octocat", state: "COMMENTED" },
      ]),
      "octocat",
      "APPROVED",
    );
    expect(out.latest_reviews).toContainEqual({
      author: "hubot",
      state: "CHANGES_REQUESTED",
    });
    expect(out.latest_reviews).toHaveLength(2);
  });

  // React Query compares by reference: mutating the cached object in
  // place would leave components rendering the value they already had.
  it("does not mutate the object it was given", () => {
    const before = detail([{ author: "octocat", state: "COMMENTED" }]);
    const snapshot = JSON.stringify(before);
    const out = withOwnReview(before, "octocat", "APPROVED");
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(out).not.toBe(before);
    expect(out.latest_reviews).not.toBe(before.latest_reviews);
  });
});
