import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MergedDetail, Periods } from "@/types/pr";
import { DeltaCards } from "./DeltaCards";

const periods: Periods = {
  week_current: 183,
  week_previous: 110,
  opened_week_current: 190,
  opened_week_previous: 120,
  month_current: 571,
  month_previous: 515,
};

const detail: MergedDetail = {
  cycle_time_hours: [0.5, 1.0, 2.0],
  pr_sizes: [15, 120, 324, 900],
  additions: 0,
  deletions: 0,
  changed_files: 0,
  review_count: 0,
  comment_count: 0,
  sample_size: 3,
  repo_counts: [],
};

describe("DeltaCards", () => {
  it("shows the merged count and its week-over-week change", () => {
    render(<DeltaCards periods={periods} detail={undefined} />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(screen.getByText("+66%")).toBeTruthy();
  });

  it("names the comparison window so the number is interpretable", () => {
    render(<DeltaCards periods={periods} detail={undefined} />);
    expect(screen.getAllByText(/vs previous 7 days/i).length).toBeGreaterThan(0);
  });

  it("renders without a detail payload", () => {
    render(<DeltaCards periods={periods} detail={undefined} />);
    expect(screen.getByText(/median cycle time/i)).toBeTruthy();
  });

  // Nearest-rank median of [0.5, 1.0, 2.0] is index floor(3*0.5)=1 -> 1.0h.
  it("shows median cycle time when detail is present", () => {
    render(<DeltaCards periods={periods} detail={detail} />);
    expect(screen.getByText("1.0h")).toBeTruthy();
  });

  // A decline must not read as growth.
  it("marks a decline with a negative percentage", () => {
    render(
      <DeltaCards
        periods={{ ...periods, week_current: 110, week_previous: 183 }}
        detail={undefined}
      />,
    );
    expect(screen.getByText("-40%")).toBeTruthy();
  });

  // Both periods empty is "no activity", not a 0% change.
  it("renders a dash when both periods are empty", () => {
    render(
      <DeltaCards
        periods={{ ...periods, week_current: 0, week_previous: 0 }}
        detail={undefined}
      />,
    );
    expect(screen.getAllByText("--").length).toBeGreaterThan(0);
  });

  // An empty cycle-time array must not render "0.0h" as if it were measured.
  it("does not report a cycle time when the sample has no timings", () => {
    render(
      <DeltaCards periods={periods} detail={{ ...detail, cycle_time_hours: [] }} />,
    );
    expect(screen.queryByText("0.0h")).toBeNull();
  });
});
