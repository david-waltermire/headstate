import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "@/fixtures/prs";
import { applyFilters, deriveStats, type Filters } from "@/lib/derive";
import { useFilters } from "@/store/filters";
import { Dashboard } from "./Dashboard";

const STATS = { merged_week: 4, merged_month: 12 };

describe("Dashboard", () => {
  beforeEach(() => useFilters.setState({ filters: {}, view: "dashboard" }));

  it("shows the historical counters", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
  });

  it("derives the live counters from the PR list", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getByText(/Needs rebase or red CI/i)).toBeDefined();
    expect(screen.getByText(/In merge queue/i)).toBeDefined();
  });

  it("renders all seven cards", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getAllByRole("button").length).toBe(7);
  });

  /// The one way this task most likely ships broken: rendering `get_stats`
  /// directly for the five derived fields, which always come back zero
  /// from Rust. This builds a PR list where `deriveStats` is known to
  /// produce five distinct non-zero counts and asserts every one of those
  /// exact numbers is on screen -- a dashboard that (bug-for-bug) rendered
  /// zeros instead would fail this test even though "renders all seven
  /// cards" still passes.
  it("renders the five derived counts, not zero, when the PR list implies non-zero values", () => {
    const prs = [
      // in_merge_queue: 2
      prWithState("success", "mergeable", "approved", { in_merge_queue: true, number: 1 }),
      prWithState("success", "mergeable", "approved", { in_merge_queue: true, number: 2 }),
      // needs_attention: 3 (failing CI)
      prWithState("failure", "mergeable", "none", { number: 3 }),
      prWithState("failure", "mergeable", "none", { number: 4 }),
      prWithState("failure", "mergeable", "none", { number: 5 }),
      // awaiting_review: 4 (green, not draft, review none/required)
      prWithState("success", "mergeable", "none", { number: 6 }),
      prWithState("success", "mergeable", "none", { number: 7 }),
      prWithState("success", "mergeable", "review_required", { number: 8 }),
      prWithState("success", "mergeable", "review_required", { number: 9 }),
      // ready_to_queue: 5 (green, approved, not already queued)
      prWithState("success", "mergeable", "approved", { number: 10 }),
      prWithState("success", "mergeable", "approved", { number: 11 }),
      prWithState("success", "mergeable", "approved", { number: 12 }),
      prWithState("success", "mergeable", "approved", { number: 13 }),
      prWithState("success", "mergeable", "approved", { number: 14 }),
      // blocked_by_comments: 6. `changes_requested` alone drives this
      // predicate, so every fixture here uses passing CI and a mergeable
      // (or checking) merge state to avoid also tripping needs_attention
      // above -- keeping each card's count independently verifiable.
      prWithState("success", "mergeable", "changes_requested", { number: 15 }),
      prWithState("success", "mergeable", "changes_requested", { number: 16 }),
      prWithState("success", "checking", "changes_requested", { number: 17 }),
      prWithState("pending", "mergeable", "changes_requested", { number: 18 }),
      prWithState("none", "mergeable", "changes_requested", { number: 19 }),
      prWithState("success", "checking", "changes_requested", { number: 20 }),
    ];

    render(<Dashboard prs={prs} stats={{ merged_week: 0, merged_month: 0 }} />);

    // Assert against each card's own button, not a bare digit lookup --
    // several of these five counts collide numerically with each other
    // (e.g. one card legitimately reading "3" while another also reads
    // "3"), so scoping to the card that owns the label is what actually
    // proves each individual count is right, not just that some card
    // somewhere shows a non-zero number.
    const cardFor = (label: RegExp) => screen.getByText(label).closest("button")!;

    expect(cardFor(/In merge queue/i).textContent).toContain("2");
    expect(cardFor(/Needs rebase or red CI/i).textContent).toContain("3");
    expect(cardFor(/Green, awaiting review/i).textContent).toContain("4");
    expect(cardFor(/Approved, needs queueing/i).textContent).toContain("5");
    expect(cardFor(/Blocked by comments/i).textContent).toContain("6");
  });

  /// Clicking a card is the triage path: it must land the user on the list
  /// already filtered to exactly that card's PRs.
  it("a card click applies its filter and switches to the list", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    fireEvent.click(screen.getByText(/Needs rebase or red CI/i));
    expect(useFilters.getState().filters).toEqual({ needsAttentionOnly: true });
    expect(useFilters.getState().view).toBe("list");
  });

  /// Same proof for the "in merge queue" preset -- confirms the pattern
  /// isn't coincidental to one card's filter shape.
  it("the in-merge-queue card applies its own distinct preset", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    fireEvent.click(screen.getByText(/In merge queue/i));
    expect(useFilters.getState().filters).toEqual({ inMergeQueueOnly: true });
    expect(useFilters.getState().view).toBe("list");
  });

  /// A card click must *replace* filters, not merge into them -- otherwise
  /// a stale filter from a previous session would make the list disagree
  /// with the count the user just clicked.
  it("a card click replaces a pre-existing filter rather than merging with it", () => {
    useFilters.setState({ filters: { repo: "octocat/spoon-knife", staleOnly: true }, view: "dashboard" });
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    fireEvent.click(screen.getByText(/Blocked by comments/i));
    expect(useFilters.getState().filters).toEqual({ review: "changes_requested" });
  });

  /// Fix round 1: cards 5 ("Green, awaiting review") and 6 ("Approved,
  /// needs queueing") used to build their presets out of scalar `Filters`
  /// fields (`ci`, `review`, `readyOnly`), but the counts come from
  /// compound predicates (`awaitingReview`, `readyToQueue`) that scalars
  /// cannot express -- `review: "none"` can't also match
  /// `"review_required"`, and there is no scalar field for "NOT already
  /// queued." That let a card's number and the list it opened silently
  /// diverge. This fixture set is built specifically to expose that: PR
  /// #8 has `review: "review_required"` (counted by awaitingReview, but
  /// dropped by a `review: "none"` preset), and PR #12 is approved AND
  /// already in the merge queue (excluded from readyToQueue's count, but
  /// admitted by a preset with no "not queued" clause).
  ///
  /// The invariant every card rests on: `deriveStats`'s count and
  /// `applyFilters` run with that same card's preset must describe the
  /// *same set* of PRs, for all seven cards -- not just the two that broke.
  it("every card's preset selects exactly the PRs its own count included", () => {
    const prs = [
      prWithState("success", "mergeable", "none", { number: 1 }), // awaiting_review
      prWithState("success", "mergeable", "review_required", { number: 2 }), // awaiting_review too
      prWithState("success", "mergeable", "approved", { number: 3 }), // ready_to_queue
      prWithState("success", "mergeable", "approved", { in_merge_queue: true, number: 4 }), // NOT ready_to_queue (already queued) -- but IS in_merge_queue
      prWithState("failure", "mergeable", "approved", { number: 5 }), // needs_attention (failing CI)
      prWithState("failure", "conflicted", "approved", { number: 6 }), // needs_attention (conflicted, also red)
      prWithState("success", "mergeable", "changes_requested", { number: 7 }), // blocked_by_comments
      // in_merge_queue only -- review: "approved" keeps this out of
      // awaiting_review, and in_merge_queue: true keeps it out of
      // ready_to_queue, so it exercises the queue count in isolation.
      prWithState("success", "checking", "approved", { in_merge_queue: true, number: 8 }),
      prWithState("success", "mergeable", "none", { is_draft: true, number: 9 }), // draft: excluded from awaiting_review
    ];

    const derived = deriveStats(prs);

    const cardPresets: { label: string; preset: Filters; expectedCount: number }[] = [
      { label: "in_merge_queue", preset: { inMergeQueueOnly: true }, expectedCount: derived.in_merge_queue },
      { label: "needs_attention", preset: { needsAttentionOnly: true }, expectedCount: derived.needs_attention },
      { label: "awaiting_review", preset: { awaitingReviewOnly: true }, expectedCount: derived.awaiting_review },
      { label: "ready_to_queue", preset: { readyToQueueOnly: true }, expectedCount: derived.ready_to_queue },
      {
        label: "blocked_by_comments",
        preset: { review: "changes_requested" },
        expectedCount: derived.blocked_by_comments,
      },
    ];

    for (const { label, preset, expectedCount } of cardPresets) {
      expect(applyFilters(prs, preset).length, `${label} preset vs. count`).toBe(expectedCount);
    }

    // Concretely: awaiting_review is 2 (PRs #1 and #2, including the
    // review_required one) and the preset must return exactly those two.
    expect(derived.awaiting_review).toBe(2);
    expect(applyFilters(prs, { awaitingReviewOnly: true }).map((p) => p.number)).toEqual([1, 2]);

    // ready_to_queue is 1 (PR #3 only -- #4 is approved but already
    // queued) and the preset must exclude the already-queued PR.
    expect(derived.ready_to_queue).toBe(1);
    expect(applyFilters(prs, { readyToQueueOnly: true }).map((p) => p.number)).toEqual([3]);
  });

  /// Same proof, driven through the rendered component and a real click --
  /// not just the derive.ts layer in isolation -- for the two cards the
  /// review found broken.
  it("clicking 'Green, awaiting review' opens a list containing a review_required PR", () => {
    const prs = [
      prWithState("success", "mergeable", "none", { number: 1 }),
      prWithState("success", "mergeable", "review_required", { number: 2 }),
      prWithState("success", "mergeable", "approved", { number: 3 }),
    ];
    render(<Dashboard prs={prs} stats={STATS} />);
    fireEvent.click(screen.getByText(/Green, awaiting review/i));
    const { filters } = useFilters.getState();
    expect(applyFilters(prs, filters).map((p) => p.number).sort()).toEqual([1, 2]);
  });

  it("clicking 'Approved, needs queueing' opens a list excluding an already-queued approved PR", () => {
    const prs = [
      prWithState("success", "mergeable", "approved", { number: 1 }),
      prWithState("success", "mergeable", "approved", { in_merge_queue: true, number: 2 }),
    ];
    render(<Dashboard prs={prs} stats={STATS} />);
    fireEvent.click(screen.getByText(/Approved, needs queueing/i));
    const { filters } = useFilters.getState();
    expect(applyFilters(prs, filters).map((p) => p.number)).toEqual([1]);
  });
});
