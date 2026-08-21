import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ current: "idle" as "idle" | "fetching" }));
const setInterval_ = vi.hoisted(() => vi.fn((s: number) => Promise.resolve(s)));

vi.mock("../api/hooks", () => ({
  usePollState: () => state.current,
  usePollInterval: () => ({ seconds: 120, set: setInterval_ }),
  useWorktreeDirs: () => ({ dirs: [], set: () => Promise.resolve([]) }),
}));

import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  it("shows when the data was last updated", () => {
    render(<StatusBar updatedAt={Date.now() - 90_000} />);
    expect(screen.getByText(/updated/i)).toBeTruthy();
  });

  // A stalled poll should be visible, not inferred from a stale timestamp.
  it("distinguishes fetching from idle", () => {
    state.current = "fetching";
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    expect(screen.getByText(/checking github/i)).toBeTruthy();
    unmount();
    state.current = "idle";
    render(<StatusBar updatedAt={Date.now()} />);
    expect(screen.getByText(/up to date/i)).toBeTruthy();
  });

  // Never claim a time the app does not have: on a cold start there is no
  // previous fetch to report.
  it("says nothing about freshness before the first fetch", () => {
    render(<StatusBar updatedAt={0} />);
    expect(screen.queryByText(/updated/i)).toBeNull();
  });

  it("defaults to the two-minute interval", () => {
    render(<StatusBar updatedAt={Date.now()} />);
    expect(screen.getByLabelText(/poll interval/i)).toHaveProperty("value", "120");
  });

  it("applies a chosen interval", () => {
    render(<StatusBar updatedAt={Date.now()} />);
    fireEvent.change(screen.getByLabelText(/poll interval/i), { target: { value: "300" } });
    expect(setInterval_).toHaveBeenCalledWith(300);
  });

  // The floor is 60s on the Rust side; offering a faster choice would let
  // the UI ask for something the backend silently clamps.
  it("offers no interval below the backend floor", () => {
    render(<StatusBar updatedAt={Date.now()} />);
    const opts = Array.from(
      screen.getByLabelText(/poll interval/i).querySelectorAll("option"),
    ).map((o) => Number(o.getAttribute("value")));
    expect(Math.min(...opts)).toBeGreaterThanOrEqual(60);
  });
});
