import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityChart } from "./ActivityChart";

const points = [
  { date: "2026-08-18", opened: 10, merged: 8 },
  { date: "2026-08-19", opened: 12, merged: 14 },
];

describe("ActivityChart", () => {
  it("offers the three range toggles", () => {
    render(<ActivityChart points={points} days={30} onDaysChange={() => {}} />);
    expect(screen.getByRole("button", { name: "7d" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "14d" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "30d" })).toBeTruthy();
  });

  it("marks the active range", () => {
    render(<ActivityChart points={points} days={14} onDaysChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: "14d" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "30d" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("reports a range change", () => {
    const onDaysChange = vi.fn();
    render(<ActivityChart points={points} days={30} onDaysChange={onDaysChange} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(onDaysChange).toHaveBeenCalledWith(7);
  });

  // The buckets are UTC and the label must say so: a Pacific user's
  // evening merge lands in the next day's column, and an undisclosed
  // off-by-one-day chart is worse than a labelled one.
  it("discloses that days are UTC", () => {
    render(<ActivityChart points={points} days={30} onDaysChange={() => {}} />);
    expect(screen.getByText(/\(UTC\)/)).toBeTruthy();
  });

  it("shows an empty state rather than a broken axis", () => {
    render(<ActivityChart points={[]} days={30} onDaysChange={() => {}} />);
    expect(screen.getByText(/no activity/i)).toBeTruthy();
  });

  // The chart is the centrepiece; a silent render failure would leave an
  // empty card that still looks deliberate.
  it("actually draws the series", () => {
    const { container } = render(
      <ActivityChart points={points} days={30} onDaysChange={() => {}} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("path").length).toBeGreaterThan(0);
  });
});
