import { describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "@/fixtures/prs";
import { repoCounts } from "./repos";

describe("repoCounts", () => {
  it("counts PRs per repo, most first", () => {
    expect(repoCounts(PR_FIXTURES)).toEqual([
      { repo: "octocat/hello-world", count: 2 },
      { repo: "octocat/spoon-knife", count: 1 },
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(repoCounts([])).toEqual([]);
  });

  /// Two repos tied on count must not jitter position across polls --
  /// the tiebreak is alphabetical on repo name, not insertion order.
  it("breaks ties on count alphabetically by repo name", () => {
    const prs = [
      prWithState("success", "mergeable", "approved", { repo: "octocat/zeta" }),
      prWithState("success", "mergeable", "approved", { repo: "octocat/alpha" }),
    ];
    expect(repoCounts(prs)).toEqual([
      { repo: "octocat/alpha", count: 1 },
      { repo: "octocat/zeta", count: 1 },
    ]);
  });
});
