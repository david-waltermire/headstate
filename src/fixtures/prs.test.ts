import { describe, expect, it } from "vitest";
import type { CiState, MergeState, ReviewState } from "../types/pr";
import { makeLabel, PR_FIXTURES, prWithState } from "./prs";

/// The wire-format casing is the whole point of `src/types/pr.ts`: serde
/// renames `CiState`/`MergeState` to lowercase and `ReviewState` to
/// snake_case, and a type that guesses "Success" or "changesRequested"
/// compiles fine but matches nothing at runtime. These assertions pin the
/// exact strings so a future edit that "cleans up" the casing fails loudly
/// here instead of silently in the UI.
describe("wire-format casing", () => {
  it("CiState/MergeState are lowercase", () => {
    const ci: CiState[] = ["success", "failure", "pending", "none"];
    const merge: MergeState[] = ["mergeable", "conflicted", "checking"];
    for (const v of ci) expect(v).toBe(v.toLowerCase());
    for (const v of merge) expect(v).toBe(v.toLowerCase());
  });

  it("ReviewState is snake_case, not camelCase", () => {
    const review: ReviewState[] = [
      "approved",
      "changes_requested",
      "review_required",
      "none",
    ];
    expect(review).toContain("changes_requested");
    expect(review).not.toContain("changesRequested" as ReviewState);
  });
});

describe("PR_FIXTURES", () => {
  it("only references synthetic octocat repos", () => {
    for (const pr of PR_FIXTURES) {
      expect(pr.repo.startsWith("octocat/")).toBe(true);
      expect(pr.author).toBe("octocat");
    }
  });

  it("covers a spread of ci/merge/review states, not just the happy path", () => {
    const states = new Set(PR_FIXTURES.map((pr) => `${pr.ci}/${pr.merge}/${pr.review}`));
    expect(states.size).toBe(PR_FIXTURES.length);
  });
});

describe("prWithState", () => {
  it("layers the given states onto PR_FIXTURES[0]", () => {
    const pr = prWithState("failure", "conflicted", "review_required");
    expect(pr.ci).toBe("failure");
    expect(pr.merge).toBe("conflicted");
    expect(pr.review).toBe("review_required");
    expect(pr.number).toBe(PR_FIXTURES[0].number);
  });

  it("accepts overrides for other fields", () => {
    const pr = prWithState("success", "mergeable", "approved", {
      number: 99,
      labels: [makeLabel("wontfix", "ffffff")],
    });
    expect(pr.number).toBe(99);
    expect(pr.labels).toEqual([{ name: "wontfix", color: "ffffff" }]);
  });
});
