import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PrRow } from "./PrRow";
import { PR_FIXTURES } from "../fixtures/prs";
import type { PullRequest } from "@/types/pr";

afterEach(cleanup);

function show(over: Partial<PullRequest>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PrRow pr={{ ...PR_FIXTURES[0], ...over }} />, { wrapper: wrap });
}

/// `prState` has six states and conveyed them through a coloured icon
/// whose meaning lived in an `aria-label`. That is not visible text and
/// is not a tooltip, so for a sighted user COLOUR was the only carrier
/// -- and "Blocked on review" and "Behind base branch" are the SAME hue
/// (#d29922), making them pixel-identical.
describe("pull request state is readable, not just coloured", () => {
  it("names 'blocked on review' in visible text", () => {
    show({ merge_status: "blocked", is_draft: false, ci: "success" });
    expect(screen.getByText(/blocked on review/i)).toBeTruthy();
  });

  // The other #d29922 state. If only one of these renders a chip they
  // are still indistinguishable, which is the actual bug.
  it("names 'behind base branch' in visible text", () => {
    show({ merge_status: "behind", is_draft: false, ci: "success" });
    expect(screen.getByText(/behind base branch/i)).toBeTruthy();
  });

  it("distinguishes the two amber states from each other", () => {
    const { unmount } = show({ merge_status: "blocked", is_draft: false, ci: "success" });
    expect(screen.queryByText(/behind base branch/i)).toBeNull();
    unmount();
    show({ merge_status: "behind", is_draft: false, ci: "success" });
    expect(screen.queryByText(/blocked on review/i)).toBeNull();
  });

  it("names draft in visible text", () => {
    show({ is_draft: true, ci: "success", merge_status: "clean" });
    expect(screen.getAllByText(/draft/i).length).toBeGreaterThan(0);
  });

  // A chip on EVERY row would be noise and would defeat its own purpose
  // -- the same reasoning ReviewGlyph already applies to itself.
  it("stays quiet on an ordinary open pull request", () => {
    show({ is_draft: false, ci: "success", merge_status: "clean", merge: "mergeable" });
    expect(screen.queryByText(/^Open$/)).toBeNull();
  });

  // `prState` returns exactly ONE state, so a draft whose CI is also
  // red reports as "Blocked". Dropping the metadata-line marker as
  // redundant therefore lost the fact that it was a draft at all --
  // caught by an existing test, and asserted directly here.
  it("still says a red-CI draft is a draft", () => {
    show({ is_draft: true, ci: "failure", merge: "conflicted", merge_status: "dirty" });
    expect(screen.getByText(/blocked/i)).toBeTruthy();
    expect(screen.getByText(/draft/i)).toBeTruthy();
  });

  // ...but it must not say it twice when the chip already does.
  it("does not repeat the word when the chip already says it", () => {
    show({ is_draft: true, ci: "success", merge_status: "clean", merge: "mergeable" });
    expect(screen.getAllByText(/^draft$/i)).toHaveLength(1);
  });

  // The aria-label must survive: it is what a screen reader reads, and
  // adding visible text is not a reason to remove it.
  it("keeps the accessible label on the icon", () => {
    show({ merge_status: "behind", is_draft: false, ci: "success" });
    expect(screen.getByLabelText(/behind base branch/i)).toBeTruthy();
  });
});
