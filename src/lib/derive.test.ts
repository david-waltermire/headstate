import { describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "../fixtures/prs";
import {
  applyFilters, awaitingReview, blockedByComments, deriveStats,
  isStale, needsAttention, readyToQueue, sortPrs, STALE_DAYS,
} from "./derive";

const [approved, broken, checking] = PR_FIXTURES;

describe("needsAttention", () => {
  it("flags failing CI", () => {
    expect(needsAttention(broken)).toBe(true);
  });

  it("does not flag a green PR", () => {
    expect(needsAttention(approved)).toBe(false);
  });

  /// The priorities strip must never cry wolf: a PR whose mergeability
  /// GitHub has not finished computing is not a conflict.
  it("never flags a PR whose merge state is still checking", () => {
    expect(needsAttention(checking)).toBe(false);
  });
});

describe("isStale", () => {
  it("flags a green approved PR untouched for more than 3 days", () => {
    expect(isStale(approved, new Date("2026-08-25T12:00:00Z"))).toBe(true);
  });

  it("does not flag one touched today", () => {
    expect(isStale(approved, new Date("2026-08-18T13:00:00Z"))).toBe(false);
  });

  it("does not flag a PR that is not yet approved", () => {
    expect(isStale(checking, new Date("2026-08-25T12:00:00Z"))).toBe(false);
  });

  it("honours a custom threshold instead of the STALE_DAYS default", () => {
    const now = new Date("2026-08-19T13:00:00Z"); // 1 day after approved's updated_at
    expect(isStale(approved, now, STALE_DAYS)).toBe(false);
    expect(isStale(approved, now, 1)).toBe(true);
  });
});

describe("categories", () => {
  it("classifies awaiting review, ready to queue, and blocked", () => {
    expect(readyToQueue(approved)).toBe(true);
    expect(blockedByComments(broken)).toBe(true);
    expect(awaitingReview(approved)).toBe(false);
  });
});

describe("applyFilters", () => {
  it("returns everything by default", () => {
    expect(applyFilters(PR_FIXTURES, {}).length).toBe(3);
  });

  it("filters by repo", () => {
    const out = applyFilters(PR_FIXTURES, { repo: "octocat/spoon-knife" });
    expect(out.map((p) => p.number)).toEqual([7]);
  });

  it("hides drafts when readyOnly is set", () => {
    expect(applyFilters(PR_FIXTURES, { readyOnly: true }).some((p) => p.is_draft)).toBe(false);
  });

  it("includes by label", () => {
    const out = applyFilters(PR_FIXTURES, { includeLabels: ["bug"] });
    expect(out.map((p) => p.number)).toEqual([43]);
  });

  /// Excluding `dependencies` to silence dependabot is the dominant
  /// real-world case for label filtering.
  it("excludes by label", () => {
    const out = applyFilters(PR_FIXTURES, { excludeLabels: ["dependencies"] });
    expect(out.map((p) => p.number)).toEqual([42, 43]);
  });

  it("applies include and exclude together", () => {
    const out = applyFilters(PR_FIXTURES, {
      includeLabels: ["bug", "dependencies"],
      excludeLabels: ["dependencies"],
    });
    expect(out.map((p) => p.number)).toEqual([43]);
  });

  it("filters to only PRs that need attention", () => {
    // PR_FIXTURES[1] (#43) is the only one with failing CI/conflicted merge.
    const out = applyFilters(PR_FIXTURES, { needsAttentionOnly: true });
    expect(out.map((p) => p.number)).toEqual([43]);
  });

  it("filters to only PRs in the merge queue", () => {
    // PR_FIXTURES[2] (#7) is the only one with in_merge_queue: true.
    const out = applyFilters(PR_FIXTURES, { inMergeQueueOnly: true });
    expect(out.map((p) => p.number)).toEqual([7]);
  });

  /// `staleOnly` depends on wall-clock time via `isStale`. `applyFilters`
  /// must thread an explicit `now` through rather than calling `new Date()`
  /// internally, or this branch is untestable without depending on the
  /// machine clock relative to the fixtures' `updated_at` values.
  describe("staleOnly", () => {
    const stale = prWithState("success", "mergeable", "approved", {
      number: 100,
      in_merge_queue: false,
      updated_at: "2026-08-01T00:00:00Z",
    });
    const fresh = prWithState("success", "mergeable", "approved", {
      number: 101,
      in_merge_queue: false,
      updated_at: "2026-08-19T00:00:00Z",
    });
    const now = new Date("2026-08-20T00:00:00Z");

    it("keeps only PRs stale as of the given now", () => {
      const out = applyFilters([stale, fresh], { staleOnly: true }, now);
      expect(out.map((p) => p.number)).toEqual([100]);
    });

    it("excludes a PR that is not yet stale relative to now", () => {
      const out = applyFilters([fresh], { staleOnly: true }, now);
      expect(out).toEqual([]);
    });
  });
});

describe("sortPrs", () => {
  it("does not mutate its input", () => {
    const original = [...PR_FIXTURES];
    sortPrs(PR_FIXTURES, "oldest");
    expect(PR_FIXTURES).toEqual(original);
  });

  /// Moved from PrList.test.tsx when sorting moved out of the component.
  /// Deliberately passes the fixtures in the WRONG order: PR_FIXTURES is
  /// already newest-first, so feeding it in unchanged would pass even
  /// against a function that does nothing at all -- the assertion would be
  /// measuring the fixture, not the code.
  it("orders newest first even when handed the list reversed", () => {
    const oldestFirst = [...PR_FIXTURES].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const sorted = sortPrs(oldestFirst, "newest");
    expect(sorted.map((pr) => pr.title)).toEqual(
      [...PR_FIXTURES]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map((pr) => pr.title),
    );
  });

  it("defaults to newest first when no sort is given", () => {
    const oldestFirst = [...PR_FIXTURES].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    expect(sortPrs(oldestFirst)).toEqual(sortPrs(oldestFirst, "newest"));
  });

  it("orders oldest first", () => {
    const sorted = sortPrs(PR_FIXTURES, "oldest");
    expect(sorted.map((pr) => pr.number)).toEqual([7, 43, 42]);
  });

  it("orders by most recently updated", () => {
    const sorted = sortPrs(PR_FIXTURES, "recently-updated");
    expect(sorted.map((pr) => pr.number)).toEqual([42, 43, 7]);
  });

  it("orders by least recently updated", () => {
    const sorted = sortPrs(PR_FIXTURES, "least-recently-updated");
    expect(sorted.map((pr) => pr.number)).toEqual([7, 43, 42]);
  });
});

describe("deriveStats", () => {
  it("counts each category from the list", () => {
    const s = deriveStats(PR_FIXTURES);
    expect(s.needs_attention).toBe(1);
    expect(s.in_merge_queue).toBe(1);
    expect(s.blocked_by_comments).toBe(1);
    expect(s.ready_to_queue).toBe(1);
  });
});

describe("free-text search", () => {
  const prs = PR_FIXTURES;

  it("matches on title, case-insensitively", () => {
    const hit = applyFilters(prs, { query: "RETRY" });
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((p) => p.title.toLowerCase().includes("retry"))).toBe(true);
  });

  it("matches on repository", () => {
    const hit = applyFilters(prs, { query: "spoon" });
    expect(hit.every((p) => p.repo.includes("spoon"))).toBe(true);
  });

  // A person searching for a PR usually remembers its number.
  it("matches an exact PR number, with or without the hash", () => {
    expect(applyFilters(prs, { query: "42" }).map((p) => p.number)).toContain(42);
    expect(applyFilters(prs, { query: "#42" }).map((p) => p.number)).toContain(42);
  });

  it("does not partial-match numbers", () => {
    // "4" must not match #42 -- substring matching on numbers would make
    // a number search useless on a long list.
    expect(applyFilters(prs, { query: "4" }).map((p) => p.number)).not.toContain(42);
  });

  it("an empty or whitespace query filters nothing", () => {
    expect(applyFilters(prs, { query: "   " }).length).toBe(prs.length);
  });
});
