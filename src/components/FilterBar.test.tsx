import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "@/fixtures/prs";
import { useFilters } from "@/store/filters";
import { FilterBar } from "./FilterBar";

afterEach(() => {
  cleanup();
  useFilters.getState().reset();
});

describe("FilterBar", () => {
  it("lists every label present across the given PRs", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Label"));
    expect(screen.getByText("enhancement")).toBeDefined();
    expect(screen.getByText("bug")).toBeDefined();
    expect(screen.getByText("dependencies")).toBeDefined();
  });

  it("adds a label to includeLabels via the filter store, not local state", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Label"));
    fireEvent.click(screen.getByText("bug"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].includeLabels).toEqual(["bug"]);
  });

  it("adds a label to excludeLabels independently of includeLabels", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Exclude label"));
    fireEvent.click(screen.getByText("dependencies"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].excludeLabels).toEqual(["dependencies"]);
    expect(useFilters.getState().filtersByView[useFilters.getState().view].includeLabels ?? []).toEqual([]);
  });

  it("toggling the same label twice removes it again", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Label"));
    fireEvent.click(screen.getByText("bug"));
    fireEvent.click(screen.getByText("bug"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].includeLabels).toEqual([]);
  });

  it("setting a review filter writes through the store", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText(/^Reviews/));
    fireEvent.click(screen.getByText("Approved"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].review).toBe("approved");
  });

  it("selecting a sort option writes through the store", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText(/^Sort/));
    fireEvent.click(screen.getByText("Oldest"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].sort).toBe("oldest");
  });

  it("toggles draftsOnly", () => {
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Drafts only"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view].draftsOnly).toBe(true);
  });

  it("Clear filters resets the whole filter set", () => {
    useFilters.getState().setFilter("includeLabels", ["bug"]);
    useFilters.getState().setFilter("review", "approved");
    render(<FilterBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByText("Clear filters"));
    expect(useFilters.getState().filtersByView[useFilters.getState().view]).toEqual({});
  });

  it("reflects existing store state rather than owning its own copy", () => {
    useFilters.getState().setFilter("includeLabels", ["bug"]);
    render(<FilterBar prs={PR_FIXTURES} />);
    expect(screen.getByText("Label (1)")).toBeDefined();
  });
});
