import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "@/types/pr";

const runFn = vi.hoisted(() => vi.fn(() => Promise.resolve([] as LedgerEntry[])));
const state = vi.hoisted(() => ({ entries: [] as LedgerEntry[] }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api/hooks", () => ({
  useCleanupLog: () => ({ entries: state.entries, isLoading: false, run: runFn }),
}));

import { CleanupLog } from "./CleanupLog";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at: new Date().toISOString(),
  kind: "artifact",
  target: "/code/x/target",
  detail: "cargo build",
  bytes: 1_000_000_000,
  action: "proposed",
  error: null,
  ...over,
});

beforeEach(() => {
  runFn.mockClear();
  state.entries = [];
});

describe("CleanupLog", () => {
  it("explains how to get a report when there is none", () => {
    render(<CleanupLog />);
    expect(screen.getByText(/Turn on automatic cleanup in Settings/)).toBeTruthy();
  });

  it("totals only what was proposed", () => {
    state.entries = [
      entry({ bytes: 1_000_000_000 }),
      // Skipped rows must not inflate the headline: the total says what
      // would be reclaimed, and a skipped directory would not be.
      entry({ target: "/code/busy/target", action: "skipped", bytes: 9_000_000_000 }),
    ];
    render(<CleanupLog />);
    expect(screen.getByText(/1 item/)).toBeTruthy();
    expect(screen.queryByText(/10 GB/)).toBeNull();
  });

  /// A row passed over without explanation reads as a malfunction
  /// rather than a guard doing its job.
  it("shows why a row was skipped", () => {
    state.entries = [
      entry({ action: "skipped", error: "written to recently" }),
    ];
    render(<CleanupLog />);
    expect(screen.getByText("written to recently")).toBeTruthy();
  });

  it("runs a pass on demand", async () => {
    render(<CleanupLog />);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(runFn).toHaveBeenCalled());
  });
});
