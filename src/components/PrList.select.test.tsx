import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PrList } from "./PrList";
import { useFilters } from "@/store/filters";
import { PR_FIXTURES } from "../fixtures/prs";

afterEach(() => {
  cleanup();
  // `anchor` too: it is store state like `checked`, and leaving it set
  // let an earlier test supply the anchor for a later one.
  useFilters.setState({ checked: [], anchor: null });
});

const key = (i: number) => `${PR_FIXTURES[i].repo}#${PR_FIXTURES[i].number}`;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const show = () => wrap(<PrList prs={PR_FIXTURES} hasFilters={false} selectable canWrite />);

/// Selecting 13 PRs meant 13 individual checkbox clicks. `setChecked`
/// existed in the store all along -- its only caller was BulkBar's retry
/// path -- so the capability was there and simply had no control.
describe("selecting many pull requests at once", () => {
  it("selects every visible row from the header", () => {
    show();
    fireEvent.click(screen.getByRole("checkbox", { name: /select all/i }));
    expect(useFilters.getState().checked).toHaveLength(PR_FIXTURES.length);
  });

  // Selecting all then clicking again must CLEAR, not re-add.
  it("clears the selection when everything is already selected", () => {
    show();
    const all = screen.getByRole("checkbox", { name: /select all/i });
    fireEvent.click(all);
    fireEvent.click(all);
    expect(useFilters.getState().checked).toEqual([]);
  });

  // Select-all must act on what is ON SCREEN, not the unfiltered list --
  // otherwise a filtered view silently selects rows the user cannot see,
  // and a bulk close acts on them.
  it("selects only the rows currently shown", () => {
    const two = PR_FIXTURES.slice(0, 2);
    wrap(<PrList prs={two} hasFilters selectable canWrite />);
    fireEvent.click(screen.getByRole("checkbox", { name: /select all/i }));
    expect(useFilters.getState().checked).toHaveLength(2);
  });

  it("shows an indeterminate state for a partial selection", () => {
    useFilters.setState({ checked: [key(0)] });
    show();
    const all = screen.getByRole("checkbox", { name: /select all/i }) as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("shift-click selects the range between two rows", () => {
    show();
    const boxes = screen.getAllByRole("checkbox", { name: /select #/i });
    // Three fixtures, so 0..2 is the whole list.
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2], { shiftKey: true });
    expect(useFilters.getState().checked).toHaveLength(3);
  });

  // Without an anchor a shift-click is just a click, not a select-to-here
  // from the top of the list.
  it("treats a shift-click with no previous selection as a plain click", () => {
    show();
    const boxes = screen.getAllByRole("checkbox", { name: /select #/i });
    fireEvent.click(boxes[2], { shiftKey: true });
    expect(useFilters.getState().checked).toHaveLength(1);
  });

  it("selects the range in either direction", () => {
    show();
    const boxes = screen.getAllByRole("checkbox", { name: /select #/i });
    // Anchor BELOW the target: the range must still resolve.
    fireEvent.click(boxes[2]);
    fireEvent.click(boxes[0], { shiftKey: true });
    expect(useFilters.getState().checked).toHaveLength(3);
  });

  // A second range must EXTEND the selection, not discard the first.
  // Without this the "replaces" implementation passes every other test:
  // each range test starts from an empty selection, so replace and
  // extend are indistinguishable.
  it("extends an existing selection rather than replacing it", () => {
    // Seed a selection that is NOT part of the range about to be made.
    useFilters.setState({ checked: [key(2)], anchor: null });
    show();
    const boxes = screen.getAllByRole("checkbox", { name: /select #/i });
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1], { shiftKey: true });
    const got = useFilters.getState().checked;
    expect(got).toContain(key(2));
    expect(got).toHaveLength(3);
  });

  it("has no select-all when rows are not selectable", () => {
    wrap(<PrList prs={PR_FIXTURES} hasFilters={false} />);
    expect(screen.queryByRole("checkbox", { name: /select all/i })).toBeNull();
  });
});
