import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: "idle" as "idle" | "fetching" | "retrying",
  error: null as string | null,
}));
const setInterval_ = vi.hoisted(() => vi.fn((s: number) => Promise.resolve(s)));

const version = vi.hoisted(() => ({
  value: "2.0.2" as string | null,
  newer: null as string | null,
}));
vi.mock("../api/tauri", () => ({
  latestRelease: () => Promise.resolve(version.newer),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () =>
    version.value === null
      ? Promise.reject(new Error("no tauri bridge"))
      : Promise.resolve(version.value),
}));

vi.mock("../api/hooks", () => ({
  usePollState: () => state.current,
  usePollError: () => state.error,
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

  // The bug behind #190 being invisible: this line could only ever say
  // "Up to date", so it asserted everything was fine while both PR views
  // sat empty and no banner appeared.
  describe("when a poll has failed", () => {
    it("never shows the green up-to-date pair", () => {
      state.current = "idle";
      state.error = "connection refused";
      const { container, unmount } = render(<StatusBar updatedAt={0} />);
      expect(screen.queryByText(/up to date/i)).toBeNull();
      expect(container.querySelector(".bg-\\[\\#3fb950\\]")).toBeNull();
      unmount();
      state.error = null;
    });

    // "Never succeeded" and "stale after a failure" are different
    // situations, and collapsing them hides the worse one.
    it("distinguishes never-succeeded from stale-after-a-failure", () => {
      state.current = "idle";
      state.error = "boom";

      const never = render(<StatusBar updatedAt={0} />);
      expect(screen.getByText(/could not reach github/i)).toBeTruthy();
      never.unmount();

      const stale = render(<StatusBar updatedAt={Date.now() - 3_600_000} />);
      expect(screen.getByText(/could not refresh/i)).toBeTruthy();
      stale.unmount();

      state.error = null;
    });

    it("goes back to up to date once a poll succeeds", () => {
      state.current = "idle";
      state.error = null;
      render(<StatusBar updatedAt={Date.now()} />);
      expect(screen.getByText(/up to date/i)).toBeTruthy();
    });

    // A failure must win over the in-flight indicator: a retry that is
    // itself failing should not read as ordinary progress.
    it("keeps reporting the failure while a retry is in flight", () => {
      state.current = "fetching";
      state.error = "still broken";
      const { unmount } = render(<StatusBar updatedAt={0} />);
      expect(screen.queryByText(/checking github/i)).toBeNull();
      unmount();
      state.current = "idle";
      state.error = null;
    });
  });

  // The version is what a user quotes in a bug report, and the repo's own
  // package.json reads 0.1.0 -- the release workflow stamps the real
  // number at build time. So this must come from the built binary.
  describe("version", () => {
    it("shows the version the binary was built with", async () => {
      version.value = "2.0.2";
      render(<StatusBar updatedAt={Date.now()} />);
      expect(await screen.findByText("v2.0.2")).toBeTruthy();
    });

    // A missing version line is better than a broken status bar: outside
    // a Tauri window there is no bridge to ask.
    it("stays quiet when the version cannot be read", async () => {
      version.value = null;
      const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText(/^v\d/)).toBeNull();
      unmount();
      version.value = "2.0.2";
    });
  });

  // A suppressed transient failure emits neither poll-error nor
  // prs-updated, so the bar had nothing to go on and showed a green
  // "Up to date" beside a stale timestamp.
  it("shows a distinct retrying state rather than claiming success", () => {
    state.current = "retrying";
    state.error = null;
    const { container } = render(<StatusBar updatedAt={Date.now() - 300_000} />);
    expect(screen.getByText(/retrying/i)).toBeTruthy();
    expect(screen.queryByText(/up to date/i)).toBeNull();
    expect(container.querySelector(".bg-\\[\\#3fb950\\]")).toBeNull();
    state.current = "idle";
  });

  // Distribution is dmg/exe/deb/AppImage, so no package manager carries
  // updates. A user on a version with a launch-blocking bug -- v1.0.0
  // never left the splash on a second machine -- otherwise has no way to
  // learn a fix exists.
  describe("update hint", () => {
    it("links to the release when a newer one exists", async () => {
      version.newer = "2.3.0";
      render(<StatusBar updatedAt={Date.now()} />);
      const link = await screen.findByRole("link", { name: /2\.3\.0 available/ });
      expect(link.getAttribute("href")).toContain("releases");
      version.newer = null;
    });

    // Silence is the right answer when current: an always-present
    // "you are up to date" is noise in a one-line bar.
    it("says nothing when this build is current", async () => {
      version.newer = null;
      render(<StatusBar updatedAt={Date.now()} />);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole("link", { name: /available/ })).toBeNull();
    });
  });
});
