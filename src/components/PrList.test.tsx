import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "@/fixtures/prs";
import { PrList } from "@/components/PrList";

describe("PrList", () => {
  it("renders every PR with its number and title", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText("Add retry to the fetch client")).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
    expect(screen.getByText(/#43/)).toBeDefined();
  });

  it("renders label pills", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText("enhancement")).toBeDefined();
    expect(screen.getByText("bug")).toBeDefined();
  });

  it("marks drafts", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText(/draft/i)).toBeDefined();
  });

  it("shows the open count in the header", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText(/3 Open/)).toBeDefined();
  });

  // The copy is now condition-aware and spans two elements, so match the
  // headline rather than a substring that straddles both.
  it("renders an empty state rather than a bare list", () => {
    render(<PrList prs={[]} />);
    expect(screen.getByText(/no open pull requests/i)).toBeDefined();
  });

  /// Sorting moved out of PrList and into `sortPrs` (src/lib/derive.ts) --
  /// PrList now renders whatever order it's handed. The ordering test moved
  /// with it; see derive.test.ts's "orders newest first even when handed
  /// the list reversed".
  it("renders PRs in the exact order it is given, without re-sorting", () => {
    const reversed = [...PR_FIXTURES].reverse();
    render(<PrList prs={reversed} />);

    const rendered = screen.getAllByRole("link").map((el) => el.textContent);
    expect(rendered).toEqual(reversed.map((pr) => pr.title));
  });
});
