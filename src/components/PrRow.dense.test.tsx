import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PrRow } from "./PrRow";
import { useFilters } from "@/store/filters";
import { PR_FIXTURES } from "../fixtures/prs";

afterEach(() => {
  cleanup();
  useFilters.setState({ density: "comfortable" });
});

function show(pr = PR_FIXTURES[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PrRow pr={pr} />, { wrapper: wrap });
}

const manyLabels = {
  ...PR_FIXTURES[0],
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "area:ci", color: "0e8a16" },
    { name: "priority", color: "1d76db" },
    { name: "needs-triage", color: "fbca04" },
    { name: "stale", color: "cfd3d7" },
  ],
};

/// Rows are two lines at py-3, so roughly 8-11 fit on screen and a 25-PR
/// list needs 2-3 screens -- the 13 attention items are never
/// co-visible. Worktree and Docker rows already use py-2.5; the PR list,
/// the most item-heavy surface in the app, was the LEAST dense.
describe("density", () => {
  it("renders both lines when comfortable", () => {
    show();
    expect(screen.getByText(/opened/)).toBeTruthy();
  });

  // Dense keeps every DECISIVE signal -- CI, review, title, number --
  // and drops only the prose line, which repeats what the glyphs say.
  it("keeps the decisive signals when dense", () => {
    useFilters.setState({ density: "dense" });
    show();
    expect(screen.getByText(PR_FIXTURES[0].title)).toBeTruthy();
    expect(screen.getByText(new RegExp(`#${PR_FIXTURES[0].number}`))).toBeTruthy();
  });

  it("drops the prose metadata line when dense", () => {
    useFilters.setState({ density: "dense" });
    show();
    expect(screen.queryByText(/opened .* by /)).toBeNull();
  });

  // Unbounded labels can wrap the flex line and push decisive state off
  // the row, which is exactly the density being reclaimed.
  it("caps labels and says how many are hidden", () => {
    useFilters.setState({ density: "dense" });
    show(manyLabels);
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
  });

  // Density is a VIEW preference, not a filter: it changes how rows
  // look, never which ones are shown. "Clear filters" must not reset it.
  it("survives clearing the filters", () => {
    useFilters.setState({ density: "dense" });
    useFilters.getState().reset();
    expect(useFilters.getState().density).toBe("dense");
  });

  it("shows every label when comfortable", () => {
    show(manyLabels);
    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.queryByText("+3")).toBeNull();
  });
});
