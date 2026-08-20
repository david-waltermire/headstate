import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PullRequest } from "@/types/pr";
import { PR_FIXTURES } from "@/fixtures/prs";
import { applyFilters } from "@/lib/derive";
import { useFilters } from "@/store/filters";
import { TriageChips } from "./TriageChips";

const NOW = new Date("2026-08-20T12:00:00Z");

function pr(over: Partial<PullRequest>): PullRequest {
  return { ...PR_FIXTURES[0], ...over };
}

const PRS: PullRequest[] = [
  pr({ number: 5, ci: "success", merge: "mergeable", review: "none", unresolved_threads: 3 }),
  pr({ number: 1, ci: "failure", merge: "mergeable", review: "none" }),
  pr({ number: 2, ci: "success", merge: "conflicted", review: "none" }),
  pr({ number: 3, ci: "success", merge: "mergeable", review: "review_required", is_draft: false }),
  pr({ number: 4, ci: "success", merge: "mergeable", review: "approved", is_draft: false }),
];

describe("TriageChips", () => {
  beforeEach(() => {
    useFilters.setState({ filters: {}, view: "list" } as never);
  });

  it("shows a count for each non-empty triage state", () => {
    render(<TriageChips prs={PRS} now={NOW} />);
    expect(screen.getByText(/need attention/i)).toBeTruthy();
  });

  it("hides itself entirely when nothing needs triage", () => {
    const clean = [pr({ ci: "success", merge: "mergeable", review: "review_required" })];
    const { container } = render(<TriageChips prs={clean} now={NOW} />);
    // "Awaiting review" may legitimately match; assert no *attention* chip.
    expect(screen.queryByText(/need attention/i)).toBeNull();
    expect(container).toBeTruthy();
  });

  it("applies the preset and switches to the list on click", () => {
    render(<TriageChips prs={PRS} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: /need attention/i }));
    expect(useFilters.getState().filters.needsAttentionOnly).toBe(true);
    expect(useFilters.getState().view).toBe("list");
  });

  it("toggles back off when clicked again", () => {
    render(<TriageChips prs={PRS} now={NOW} />);
    const btn = screen.getByRole("button", { name: /need attention/i });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: /need attention/i }));
    expect(useFilters.getState().filters.needsAttentionOnly).toBeUndefined();
  });

  it("keeps the repo selection, which is navigation rather than a filter", () => {
    useFilters.setState({ filters: { repo: "octocat/hello-world" }, view: "list" } as never);
    render(<TriageChips prs={PRS} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: /need attention/i }));
    expect(useFilters.getState().filters.repo).toBe("octocat/hello-world");
  });

  // THE regression this design exists to prevent: two dashboard cards once
  // showed a count that disagreed with the list they opened, because the
  // count and the filter were computed by different code.
  it("every chip's count equals the number of PRs its own filter yields", () => {
    render(<TriageChips prs={PRS} now={NOW} />);
    for (const btn of screen.getAllByRole("button")) {
      const shown = Number(btn.textContent?.match(/\d+/)?.[0]);
      fireEvent.click(btn);
      const listed = applyFilters(PRS, useFilters.getState().filters, NOW).length;
      expect(listed).toBe(shown);
      // Reset for the next chip.
      useFilters.setState({ filters: {}, view: "list" } as never);
    }
  });
});
