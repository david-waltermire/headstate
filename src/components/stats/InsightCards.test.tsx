import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MergedDetail } from "@/types/pr";
import { InsightCards } from "./InsightCards";

const detail: MergedDetail = {
  cycle_time_hours: [0.5, 1.0, 2.0, 4.0],
  pr_sizes: [15, 120, 324, 900],
  additions: 50000,
  deletions: 9139,
  changed_files: 400,
  review_count: 50,
  comment_count: 120,
  sample_size: 100,
  repo_counts: [],
  slowest: [],
  largest: [],
};

describe("InsightCards", () => {
  // True nearest-rank on 4 samples: p50 -> ceil(4*.5)-1 = index 1 (1.0),
  // p90 -> ceil(4*.9)-1 = index 3 (4.0).
  // n=4, so "p90" would be the largest value in the sample. The label
  // says "slowest" below 20 samples rather than implying a distribution.
  it("shows median and the slowest cycle time", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("1.0h")).toBeTruthy();
    expect(screen.getByText(/slowest 4\.0h/)).toBeTruthy();
  });

  it("shows total lines changed", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("59,139")).toBeTruthy();
  });

  // Review counts came back 0 across the whole live sample (self-merged
  // PRs), so the third card reports size, which has real spread.
  it("shows median PR size with p90 and comments in the hint", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("120")).toBeTruthy(); // nearest-rank p50
    expect(screen.getByText(/slowest 900/)).toBeTruthy();
    expect(screen.getByText(/1\.2 comments\/PR/)).toBeTruthy();
  });

  // sample_size 0 would divide by zero in every per-PR figure.
  it("renders dashes rather than NaN with no sample", () => {
    render(
      <InsightCards
        detail={{ ...detail, sample_size: 0, cycle_time_hours: [] }}
      />,
    );
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

describe("InsightCards cycle-time trend", () => {
  const trend = {
    current_hours: 0.63,
    previous_hours: 0.76,
    current_count: 183,
    previous_count: 110,
    sampled: false,
  };

  // Lower is better here, unlike every other card on the page.
  it("paints a FALLING cycle time green", () => {
    const { container } = render(<InsightCards detail={detail} trend={trend} />);
    expect(screen.getByText("-17%")).toBeTruthy();
    expect(container.innerHTML).toContain("#3fb950");
  });

  it("paints a rising cycle time red", () => {
    const { container } = render(
      <InsightCards
        detail={detail}
        trend={{ ...trend, current_hours: 2.0, previous_hours: 1.0 }}
      />,
    );
    expect(screen.getByText("+100%")).toBeTruthy();
    expect(container.innerHTML).toContain("#f85149");
  });

  // A week above 100 merges is a sample, and saying so is the difference
  // between an honest figure and a plausible-but-wrong one.
  it("says when the medians are over a sample", () => {
    render(<InsightCards detail={detail} trend={{ ...trend, sampled: true }} />);
    expect(screen.getByText(/sampled/)).toBeTruthy();
  });

  it("shows no trend when there is no prior week", () => {
    render(<InsightCards detail={detail} trend={{ ...trend, previous_hours: 0 }} />);
    expect(screen.queryByText(/vs last week/)).toBeNull();
  });
});
