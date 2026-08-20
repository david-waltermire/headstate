import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Periods } from "@/types/pr";
import { DeltaCards } from "./DeltaCards";

const periods: Periods = {
  week_current: 183,
  week_previous: 110,
  opened_week_current: 190,
  opened_week_previous: 120,
  month_current: 571,
  month_previous: 515,
};

describe("DeltaCards", () => {
  it("shows the merged count and its week-over-week change", () => {
    render(<DeltaCards periods={periods} />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(screen.getByText("+66%")).toBeTruthy();
  });

  it("names the comparison window so the number is interpretable", () => {
    render(<DeltaCards periods={periods} />);
    expect(screen.getAllByText(/vs previous 7 days/i).length).toBeGreaterThan(0);
  });

  it("marks a decline with a negative percentage", () => {
    render(
      <DeltaCards periods={{ ...periods, week_current: 110, week_previous: 183 }} />,
    );
    expect(screen.getByText("-40%")).toBeTruthy();
  });

  it("renders a dash when both periods are empty", () => {
    render(<DeltaCards periods={{ ...periods, week_current: 0, week_previous: 0 }} />);
    expect(screen.getAllByText("--").length).toBeGreaterThan(0);
  });

  // A rising intake is not good news on its own: the activity chart's own
  // comment names the GAP between opened and merged as the signal. One
  // polarity rule across all four cards painted a growing backlog green.
  it("does not paint a rising open count green", () => {
    const { container } = render(
      <DeltaCards
        periods={{ ...periods, opened_week_current: 300, opened_week_previous: 120 }}
      />,
    );
    const opened = Array.from(container.querySelectorAll("div")).find(
      (d) => d.textContent?.startsWith("Opened this week"),
    );
    expect(opened).toBeTruthy();
    expect(opened?.innerHTML).not.toContain("#3fb950");
  });

  // Merged throughput still earns colour -- more IS better there.
  it("still paints rising merges green", () => {
    const { container } = render(<DeltaCards periods={periods} />);
    const merged = Array.from(container.querySelectorAll("div")).find(
      (d) => d.textContent?.startsWith("Merged this week"),
    );
    expect(merged?.innerHTML).toContain("#3fb950");
  });

  // Replaces a second copy of "Median cycle time", which already appears
  // with a p90 in the insight row and had no prior period to compare to.
  it("shows net backlog instead of duplicating cycle time", () => {
    render(<DeltaCards periods={periods} />);
    expect(screen.getByText(/net backlog/i)).toBeTruthy();
    expect(screen.getByText("+7")).toBeTruthy(); // 190 opened - 183 merged
    expect(screen.queryByText(/median cycle time/i)).toBeNull();
  });
});
