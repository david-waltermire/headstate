import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: "idle" as "idle" | "fetching" | "retrying",
  error: null as string | null,
  removal: null as { done: number; total: number } | null,
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
  // Defaults, matching the Rust side: nothing hidden, close hides.
  useUiPrefs: () => ({
    prefs: { hidden_views: [], close_hides_to_tray: true },
    set: () => Promise.resolve(),
  }),
  useCleanupPrefs: () => ({ prefs: undefined, set: () => Promise.resolve() }),
  useAutostart: () => ({ enabled: false, set: () => Promise.resolve() }),
  usePollState: () => state.current,
  useRemovalProgress: () => state.removal,
  usePollError: () => state.error,
  usePollInterval: () => ({ seconds: 120, set: setInterval_ }),
  useWorktreeDirs: () => ({ dirs: [], set: () => Promise.resolve([]) }),
  // Defaults, matching the Rust side: absent prefs mean everything on.
  useNotifyPrefs: () => ({
    prefs: { enabled: true, ci_failed: true, conflicted: true },
    set: () => Promise.resolve(),
  }),
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

  /// The reported bug: a machine that hides to the tray instead of
  /// quitting never re-mounts, so a once-per-mount check meant it took
  /// one release and then sat there while later ones shipped.
  it("asks again when the window is shown, not only at startup", async () => {
    version.newer = null;
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    // A release ships while the app sits in the tray.
    version.newer = "9.9.9";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
  });

  /// ...and the timer covers a window that is never hidden at all.
  it("asks again on the daily timer", async () => {
    vi.useFakeTimers();
    version.newer = null;
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    await act(async () => {});

    version.newer = "9.9.9";
    await act(async () => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
    vi.useRealTimers();
  });

  /// The regression the re-checking introduces if the dismissal is not
  /// respected: asking every 24 hours about a release the user already
  /// declined is precisely the nag the per-version key exists to stop.
  it("does not reopen a version the user dismissed", async () => {
    localStorage.setItem("headstate-update-dismissed", "9.9.9");
    version.newer = "9.9.9";
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    // Re-checking finds the same version. It must stay dismissed.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    localStorage.clear();
  });

  /// But a NEWER release must get through, or dismissing one version
  /// would silence every future one.
  it("opens for a newer version even after dismissing an older one", async () => {
    localStorage.setItem("headstate-update-dismissed", "9.9.9");
    version.newer = "9.9.9";
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    version.newer = "10.0.0";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
    localStorage.clear();
  });

  /// Bulk removal runs on the backend and outlives the Worktrees page.
  /// Reporting it only there made a running batch look stopped the
  /// moment the user navigated away -- which is exactly what prompted
  /// "will leaving the page stop the deletion?".
  /// A live region must EXIST before its text appears, or the first
  /// announcement -- the one saying work started -- is never made. So the
  /// container is always mounted and only its content changes.
  it("keeps the progress live region mounted while idle", () => {
    state.removal = null;
    const { container } = render(<StatusBar updatedAt={Date.now()} />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toBe("");
  });

  it("announces progress through that same region", () => {
    state.removal = { done: 7, total: 20 };
    const { container, unmount } = render(<StatusBar updatedAt={Date.now()} />);
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent,
    ).toMatch(/7 of 20/);
    unmount();
    state.removal = null;
  });

  it("shows bulk removal progress, so it survives leaving the page", () => {
    state.removal = { done: 12, total: 50 };
    const { unmount } = render(<StatusBar updatedAt={Date.now()} />);
    expect(screen.getByText(/Removing worktrees . 12 of 50/)).toBeTruthy();
    unmount();
    state.removal = null;
  });

  it("says nothing about removals when none is running", () => {
    state.removal = null;
    render(<StatusBar updatedAt={Date.now()} />);
    expect(screen.queryByText(/Removing worktrees/)).toBeNull();
  });
});
