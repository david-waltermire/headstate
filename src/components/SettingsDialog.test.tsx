import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const setDirs = vi.hoisted(() => vi.fn((d: string[]) => Promise.resolve(d)));
const setInterval_ = vi.hoisted(() => vi.fn((s: number) => Promise.resolve(s)));
const dirs = vi.hoisted(() => ({ current: ["/Users/x/code"] as string[] }));

vi.mock("../api/hooks", () => ({
  usePollInterval: () => ({ seconds: 120, set: setInterval_ }),
  useWorktreeDirs: () => ({ dirs: dirs.current, set: setDirs }),
  // Defaults, matching the Rust side: absent prefs mean everything on.
  useNotifyPrefs: () => ({
    prefs: { enabled: true, ci_failed: true, conflicted: true },
    set: () => Promise.resolve(),
  }),
}));

import { SettingsDialog } from "./SettingsDialog";

function open() {
  return render(<SettingsDialog open onOpenChange={() => {}} />);
}

describe("SettingsDialog", () => {
  it("shows the configured directories, one per line", () => {
    open();
    expect(screen.getByLabelText(/directories to scan/i)).toHaveProperty(
      "value",
      "/Users/x/code",
    );
  });

  it("saves trimmed, non-empty paths", async () => {
    open();
    fireEvent.change(screen.getByLabelText(/directories to scan/i), {
      target: { value: "  /a  \n\n /b \n   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(setDirs).toHaveBeenCalledWith(["/a", "/b"]));
  });

  // Unlike the interval, which only clamps, this write can be REJECTED --
  // a typo must surface rather than appearing to succeed.
  it("shows the backend's error instead of closing", async () => {
    setDirs.mockImplementationOnce(() => Promise.reject("not a directory: /nope"));
    open();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "not a directory: /nope",
    );
  });

  it("changes the poll interval", () => {
    open();
    fireEvent.change(screen.getByLabelText(/check github every/i), {
      target: { value: "300" },
    });
    expect(setInterval_).toHaveBeenCalledWith(300);
  });

  // The floor is 60s on the Rust side; offering less would let the UI ask
  // for something silently clamped.
  it("offers no interval below the backend floor", () => {
    open();
    const opts = Array.from(
      screen.getByLabelText(/check github every/i).querySelectorAll("option"),
    ).map((o) => Number(o.getAttribute("value")));
    expect(Math.min(...opts)).toBeGreaterThanOrEqual(60);
  });
});
