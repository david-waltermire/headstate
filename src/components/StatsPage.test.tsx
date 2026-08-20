import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { History } from "@/types/pr";

vi.mock("../api/hooks", () => ({
  useHistory: vi.fn(),
  useMergedDetail: vi.fn(),
}));

import { useHistory, useMergedDetail } from "../api/hooks";
import { StatsPage } from "./StatsPage";

const history: History = {
  points: [{ date: "2026-08-19", opened: 5, merged: 4 }],
  week_current: 183,
  week_previous: 110,
  opened_week_current: 190,
  opened_week_previous: 120,
  month_current: 571,
  month_previous: 515,
};

describe("StatsPage", () => {
  it("shows a loading state before history arrives", () => {
    vi.mocked(useHistory).mockReturnValue({ data: undefined, isLoading: true } as never);
    vi.mocked(useMergedDetail).mockReturnValue({ data: undefined, isLoading: true } as never);
    render(<StatsPage />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("renders the delta cards once history arrives", () => {
    vi.mocked(useHistory).mockReturnValue({ data: history, isLoading: false } as never);
    vi.mocked(useMergedDetail).mockReturnValue({ data: undefined, isLoading: false } as never);
    render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
  });

  // The detail query is independent and more expensive; the page must not
  // block on it or a slow sample would blank the whole view.
  it("renders history even when the detail query fails", () => {
    vi.mocked(useHistory).mockReturnValue({ data: history, isLoading: false } as never);
    vi.mocked(useMergedDetail).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as never);
    render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(screen.getByText(/pull request activity/i)).toBeTruthy();
  });
});
