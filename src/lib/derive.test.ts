import { describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "../fixtures/prs";
import {
  applyFilters, awaitingReview, changesRequested, deriveStats,
  isStale, needsAttention, pendingReviewers, readyToQueue, sortPrs, STALE_DAYS,
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
    expect(changesRequested(broken)).toBe(true);
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

/// Reported: "the left hand menu says 13 for the selected repo, Needs
/// your attention shows 4, Awaiting review shows 3 — where are the
/// missing 6?"
///
/// Two defects behind it, both fixed here. The shapes below are the
/// five that a live GraphQL probe actually returned for a real
/// account, not invented ones.
describe("the triage chips reconcile with the repo count", () => {
  const account = () => [
    ...Array(9).fill(0).map(() => prWithState("success", "mergeable", "none")),
    ...Array(3).fill(0).map(() => prWithState("success", "conflicted", "none")),
    prWithState("success", "mergeable", "none", { merge_status: "blocked" }),
    // A repository with no checks configured. This one was in NEITHER
    // chip before, because `awaitingReview` demanded `success`.
    prWithState("none", "mergeable", "none", { merge_status: "blocked" }),
    prWithState("failure", "conflicted", "none", { is_draft: true }),
  ];

  it("leaves no pull request in neither chip", () => {
    const all = account();
    const orphans = all.filter((p) => !needsAttention(p) && !awaitingReview(p));
    expect(orphans).toHaveLength(0);
  });

  /// A conflicted pull request with green CI used to satisfy BOTH: it
  /// is blocked on the author AND had nothing else disqualifying it.
  /// Counting it twice is how two chips could describe overlapping sets
  /// and reconcile with nothing.
  it("puts no pull request in both chips", () => {
    const all = account();
    const doubled = all.filter((p) => needsAttention(p) && awaitingReview(p));
    expect(doubled).toHaveLength(0);
  });

  it("sums to the total, which is the whole point", () => {
    const all = account();
    expect(all.filter(needsAttention).length + all.filter(awaitingReview).length).toBe(
      all.length,
    );
  });

  /// The specific miss: no checks configured is not "waiting on CI".
  /// `readyForReview` already treated it that way and these two must
  /// agree.
  it("counts a pull request with no CI as awaiting review", () => {
    expect(awaitingReview(prWithState("none", "mergeable", "none"))).toBe(true);
  });

  /// But a run still in progress does NOT count -- it may go red, and
  /// "awaiting review" would be the wrong thing to say about a pull
  /// request about to need the author instead.
  it("does not count a pull request whose CI is still running", () => {
    expect(awaitingReview(prWithState("pending", "mergeable", "none"))).toBe(false);
  });
});

/// "Waiting on a review" is a state; "waiting on octocat" is something
/// you can act on. `reviewDecision` cannot say the second -- it
/// collapses every reviewer into one verdict and names nobody.
describe("pendingReviewers", () => {
  const withReviewers = (
    requested: string[],
    reviews: { author: string; state: string }[] = [],
  ) => ({ ...PR_FIXTURES[0], requested_reviewers: requested, latest_reviews: reviews });

  it("names everyone still asked and not yet answered", () => {
    expect(pendingReviewers(withReviewers(["reviewer-one", "hubot"]))).toEqual([
      "reviewer-one",
      "hubot",
    ]);
  });

  /// The reason this is not just `requested_reviewers`: GitHub keeps a
  /// reviewer in that list after they respond in some workflows, and a
  /// re-request after a change puts an already-approved reviewer back
  /// into it. Showing them would tell the user to chase someone who
  /// already answered.
  it("drops a reviewer who has already given a verdict", () => {
    const pr = withReviewers(
      ["reviewer-one", "hubot"],
      [{ author: "reviewer-one", state: "APPROVED" }],
    );
    expect(pendingReviewers(pr)).toEqual(["hubot"]);
  });

  /// A COMMENTED review is an answer. They looked and said something
  /// without blocking, so the row should not suggest chasing them.
  it("treats a comment as an answer", () => {
    const pr = withReviewers(["reviewer-one"], [{ author: "reviewer-one", state: "COMMENTED" }]);
    expect(pendingReviewers(pr)).toEqual([]);
  });

  it("ignores reviews from people who were never requested", () => {
    const pr = withReviewers(["reviewer-one"], [{ author: "a-passerby", state: "APPROVED" }]);
    expect(pendingReviewers(pr)).toEqual(["reviewer-one"]);
  });

  /// The investigation that prompted this: `reviewRequests` is empty on
  /// 25 of 25 rust-lang/rust pull requests, because it assigns the
  /// reviewer instead. Without the fallback the feature shows nothing
  /// at all on whole repositories.
  it("falls back to assignees when no reviewer was requested", () => {
    const pr = { ...withReviewers([]), assignees: ["jieyouxu"] };
    expect(pendingReviewers(pr)).toEqual(["jieyouxu"]);
  });

  /// A FALLBACK, not an addition. On a repo that uses both, an assignee
  /// is often the author triaging their own pull request.
  it("prefers requested reviewers over assignees when both exist", () => {
    const pr = { ...withReviewers(["reviewer-one"]), assignees: ["someone-else"] };
    expect(pendingReviewers(pr)).toEqual(["reviewer-one"]);
  });

  /// The author assigning themselves is the common case on repos that
  /// use assignees for triage. "Waiting on yourself" is never useful.
  it("never lists the author as someone you are waiting on", () => {
    const base = withReviewers([]);
    const pr = { ...base, assignees: [base.author] };
    expect(pendingReviewers(pr)).toEqual([]);
  });

  it("still drops an assignee who has already reviewed", () => {
    const pr = {
      ...withReviewers([], [{ author: "jieyouxu", state: "APPROVED" }]),
      assignees: ["jieyouxu"],
    };
    expect(pendingReviewers(pr)).toEqual([]);
  });

  /// Empty is ORDINARY, not missing data -- measured at 0 of 25 on
  /// rust-lang/rust, which assigns reviewers through a bot. This must
  /// not throw or invent anything.
  it("returns nothing when no reviewer was requested", () => {
    expect(pendingReviewers(withReviewers([]))).toEqual([]);
  });

  /// A snapshot written before these fields existed deserialises
  /// without them, so the optional chaining is load-bearing rather than
  /// defensive padding.
  it("survives a pull request cached before these fields existed", () => {
    const old = { ...PR_FIXTURES[0] } as Record<string, unknown>;
    delete old.requested_reviewers;
    delete old.latest_reviews;
    expect(() => pendingReviewers(old as never)).not.toThrow();
    expect(pendingReviewers(old as never)).toEqual([]);
  });
});
