import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { History, MergedDetail, Periods } from "@/types/pr";

vi.mock("../api/hooks", () => ({
  usePeriods: vi.fn(),
  useHistory: vi.fn(),
  useMergedDetail: vi.fn(),
}));

import { useHistory, useMergedDetail, usePeriods } from "../api/hooks";
import { StatsPage } from "./StatsPage";

const periods: Periods = {
  week_current: 183,
  week_previous: 110,
  opened_week_current: 190,
  opened_week_previous: 120,
  month_current: 571,
  month_previous: 515,
};

const history: History = {
  points: [{ date: "2026-08-19", opened: 5, merged: 4 }],
  ...periods,
};

const detail: MergedDetail = {
  cycle_time_hours: [1, 2, 3],
  pr_sizes: [10, 20, 30],
  additions: 100,
  deletions: 50,
  changed_files: 9,
  review_count: 0,
  comment_count: 3,
  sample_size: 3,
  repo_counts: [{ repo: "acme/alpha", merged: 3 }],
};

const pending = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() } as never;
const settled = <T,>(data: T) =>
  ({ data, isLoading: false, isError: false, refetch: vi.fn() }) as never;
const failed = (error: unknown = "boom") =>
  ({ data: undefined, isLoading: false, isError: true, error, refetch: vi.fn() }) as never;

function setup(p: unknown, h: unknown, d: unknown) {
  vi.mocked(usePeriods).mockReturnValue(p as never);
  vi.mocked(useHistory).mockReturnValue(h as never);
  vi.mocked(useMergedDetail).mockReturnValue(d as never);
}

describe("StatsPage", () => {
  it("renders nothing but placeholders before any query lands", () => {
    setup(pending, pending, pending);
    const { container } = render(<StatsPage />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByText("183")).toBeNull();
  });

  // The point of the split: the fast query paints while the slow ones run.
  it("shows the delta cards while the chart and sample are still loading", () => {
    setup(settled(periods), pending, pending);
    render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(screen.getByText("+66%")).toBeTruthy();
    // Chart header is present as a placeholder, but no chart is drawn yet.
    expect(screen.getByText(/pull request activity/i)).toBeTruthy();
  });

  it("draws the chart as soon as history lands, without waiting on the sample", () => {
    setup(settled(periods), settled(history), pending);
    const { container } = render(<StatsPage />);
    expect(container.querySelector("svg")).toBeTruthy();
    // The insight row is still a placeholder.
    expect(screen.queryByText(/median pr size/i)).toBeNull();
  });

  it("renders every section once all three have landed", () => {
    setup(settled(periods), settled(history), settled(detail));
    const { container } = render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText(/median pr size/i)).toBeTruthy();
    expect(screen.getByText("acme/alpha")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  // A slow or failed sample must never blank the sections that did load.
  it("keeps the cards and chart when the sample query fails", () => {
    setup(settled(periods), settled(history), failed());
    const { container } = render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  // Regression: a failed query is not a pending one. Before this, every
  // gate was a bare truthiness check and an error pulsed skeletons forever.
  it("shows an error instead of pulsing skeletons when a query fails", () => {
    setup(failed("rate limit exceeded"), settled(history), settled(detail));
    const { container } = render(<StatsPage />);
    expect(screen.getByText(/could not load the headline figures/i)).toBeTruthy();
    expect(screen.getByText(/rate limit exceeded/)).toBeTruthy();
    // The failed section stops shimmering; the others still render.
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("shows one error for the whole page when all three fail", () => {
    setup(failed("network down"), failed("network down"), failed("network down"));
    const { container } = render(<StatsPage />);
    expect(screen.getByText(/could not load your statistics/i)).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  // Four uncoordinated "nothing here" fragments became one sentence.
  it("shows a single coordinated message when there is nothing yet", () => {
    const empty = {
      week_current: 0,
      week_previous: 0,
      opened_week_current: 0,
      opened_week_previous: 0,
      month_current: 0,
      month_previous: 0,
    };
    setup(settled(empty), settled({ ...history, points: [] }), settled({ ...detail, sample_size: 0 }));
    render(<StatsPage />);
    expect(screen.getByText(/no merged pull requests yet/i)).toBeTruthy();
    expect(screen.queryByText(/no activity in this period/i)).toBeNull();
  });

  // But a user with real activity must never see it.
  it("does not show the empty message when there is activity", () => {
    setup(settled(periods), settled(history), settled(detail));
    render(<StatsPage />);
    expect(screen.queryByText(/no merged pull requests yet/i)).toBeNull();
  });

  it("retries the failed query", () => {
    const q = failed("boom") as unknown as { refetch: ReturnType<typeof vi.fn> };
    setup(q, settled(history), settled(detail));
    render(<StatsPage />);
    screen.getByRole("button", { name: /try again/i }).click();
    expect(q.refetch).toHaveBeenCalled();
  });
});
