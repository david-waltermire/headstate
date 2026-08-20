import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MergedPr } from "@/types/pr";
import { Outliers } from "./Outliers";

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 42,
  title: "Add retry to the fetch client",
  url: "https://github.com/octocat/hello-world/pull/42",
  repo: "octocat/hello-world",
  cycle_time_hours: 2,
  size: 300,
  ...over,
});

describe("Outliers", () => {
  // The point of the component: a striking figure becomes reachable.
  it("links each PR to GitHub", () => {
    render(<Outliers slowest={[pr()]} largest={[]} />);
    const link = screen.getByRole("link", { name: /add retry/i });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/octocat/hello-world/pull/42",
    );
  });

  it("shows hours below a day and days above", () => {
    const { unmount } = render(
      <Outliers slowest={[pr({ cycle_time_hours: 5 })]} largest={[]} />,
    );
    expect(screen.getByText("5.0h")).toBeTruthy();
    unmount();
    render(<Outliers slowest={[pr({ cycle_time_hours: 96 })]} largest={[]} />);
    expect(screen.getByText("4.0d")).toBeTruthy();
  });

  it("formats large line counts readably", () => {
    render(<Outliers slowest={[]} largest={[pr({ size: 10088 })]} />);
    expect(screen.getByText("10,088 lines")).toBeTruthy();
  });

  // Both lists come from the same sample, so an empty one means no data
  // rather than an error -- render nothing rather than an empty card.
  it("renders nothing for an empty list", () => {
    const { container } = render(<Outliers slowest={[]} largest={[]} />);
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(screen.queryByText(/slowest to merge/i)).toBeNull();
  });

  it("says the figures are from a sample, not all time", () => {
    render(<Outliers slowest={[pr()]} largest={[]} />);
    expect(screen.getByText(/in this sample/i)).toBeTruthy();
  });
});
