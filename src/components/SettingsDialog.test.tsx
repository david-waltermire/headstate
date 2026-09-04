import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const setDirs = vi.hoisted(() => vi.fn((d: string[]) => Promise.resolve(d)));
const setInterval_ = vi.hoisted(() => vi.fn((s: number) => Promise.resolve(s)));
const dirs = vi.hoisted(() => ({ current: ["/Users/x/code"] as string[] }));

const setCleanup = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const uiState = vi.hoisted(() => ({ diagnosticLogging: false }));
const revealFn = vi.hoisted(() => vi.fn(() => Promise.resolve("/Users/x/Library/Logs/app/headstate.log")));
const cleanupPrefs = vi.hoisted(() => ({
  current: {
    enabled: false,
    mode: "preview" as const,
    artifacts: false,
    venvs: false,
    max_per_run: 0,
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api/tauri", () => ({ revealLog: revealFn }));
vi.mock("../api/hooks", () => ({
  // Defaults, matching the Rust side: nothing hidden, close hides.
  useUiPrefs: () => ({
    prefs: {
      hidden_views: [],
      close_hides_to_tray: true,
      diagnostic_logging: uiState.diagnosticLogging,
    },
    set: () => Promise.resolve(),
  }),
  useCleanupPrefs: () => ({ prefs: cleanupPrefs.current, set: setCleanup }),
  useAutostart: () => ({ enabled: false, set: () => Promise.resolve() }),
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

  /// A `<button>` nested inside a `<label>` joins that label's
  /// accessible name, so a help icon there would make the field
  /// announce as "Directories to scan for repositories About scanned
  /// directories". Caught by getByLabelText finding two matches.
  it("keeps help buttons out of field labels", () => {
    open();
    for (const label of Array.from(document.querySelectorAll("label"))) {
      expect(label.querySelector("button")).toBeNull();
    }
  });
});

describe("automatic cleanup settings", () => {
  /// The feature must present itself as what it IS. A switch that
  /// sounds like it might delete, in a build where it cannot, is the
  /// one thing worth not understating.
  it("says plainly that nothing is removed automatically", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/never removes anything automatically/i)).toBeTruthy();
  });

  it("hides the per-kind options until the feature is on", () => {
    cleanupPrefs.current = { ...cleanupPrefs.current, enabled: false };
    const r = render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByLabelText(/Build output/)).toBeNull();
    r.unmount();

    cleanupPrefs.current = { ...cleanupPrefs.current, enabled: true };
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByLabelText(/Build output/)).toBeTruthy();
    expect(screen.getByLabelText(/Orphaned virtualenvs/)).toBeTruthy();
  });

  /// #394: the opt-in must say what turning it on ASSERTS, since the
  /// distinction between orphaned and stale is the whole reason it
  /// exists as a separate switch.
  /// The stale opt-in belongs to AUTOMATIC cleanup, beside the orphan
  /// one -- not to manual removal, which it used to gate. Ticking a row
  /// and confirming a dialog is already the user's intent; unattended
  /// deletion acting on a 90-day threshold is not.
  it("offers stale virtualenvs beside orphaned ones, under automatic cleanup", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const orphaned = screen.getByLabelText(/Orphaned virtualenvs/);
    const stale = screen.getByLabelText(/Stale virtualenvs/);
    expect(orphaned).toBeTruthy();
    expect(stale).toBeTruthy();
    // Same section: the stale toggle sits with the automatic-cleanup
    // choices rather than in a section of its own about manual removal.
    expect(orphaned.closest("div")?.parentElement).toBe(
      stale.closest("div")?.parentElement,
    );
  });
});

describe("the diagnostic log controls", () => {
  /// The old text said "each GitHub request", which was true until the
  /// local scans were instrumented. A user with a hanging Virtualenvs
  /// page had no reason to think this setting would help.
  it("says it records local scans, not only GitHub requests", () => {
    uiState.diagnosticLogging = true;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/GitHub requests and local scans/)).toBeTruthy();
  });

  /// The promise is load-bearing: this log exists to be SENT to someone.
  it("still promises no repository names", () => {
    uiState.diagnosticLogging = true;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/never repository names/)).toBeTruthy();
  });

  it("can reveal the log file", async () => {
    uiState.diagnosticLogging = true;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /show the log/i }));
    await waitFor(() => expect(revealFn).toHaveBeenCalled());
  });

  /// Nothing to reveal and nothing to explain when it is off.
  it("offers nothing while logging is disabled", () => {
    uiState.diagnosticLogging = false;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /show the log/i })).toBeNull();
  });
});

/// #436: a notification when a PR enters the green "Ready for review"
/// panel, so it can be picked up immediately.
describe("the ready-for-review notification", () => {
  it("offers a toggle for it", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByLabelText(/ready for your review/i)).toBeTruthy();
  });

  /// The wording described breakage while every notification WAS
  /// breakage. This one is good news.
  it("no longer says notifications are only about breakage", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByText(/newly breaks/)).toBeNull();
    expect(screen.getByText(/never on first launch/)).toBeTruthy();
  });
});

/// #437: ~445 lines of continuous scroll became topics on the left and
/// one panel on the right.
describe("the settings sections", () => {
  it("offers a topic for each group", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const nav = screen.getByRole("navigation", { name: /settings sections/i });
    for (const label of ["General", "Repositories", "Notifications", "Cleanup", "Views"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  /// #485: the frame is fixed in BOTH dimensions, like macOS System
  /// Settings, so switching topics does not resize the window under
  /// the cursor.
  ///
  /// Asserted on the resolved class list because that is what the bug
  /// was: `max-w-lg` left ~20rem for controls once the 9rem topic menu
  /// took its share, and no height at all meant the dialog sized to
  /// whichever panel was showing.
  it("has a fixed frame that does not resize with the topic", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const panel = screen.getByRole("dialog");
    const cls = panel.className;

    expect(cls).toMatch(/\bh-\[32rem\]/);
    expect(cls).toMatch(/\bmax-w-3xl\b/);
    // The base DialogContent carries `sm:max-w-sm`, and tailwind-merge
    // keeps a responsive variant alongside a bare one -- so without an
    // explicit `sm:` override the dialog is NARROWER above 640px than
    // before this change.
    expect(cls).toMatch(/\bsm:max-w-3xl\b/);
    expect(cls).not.toMatch(/\bsm:max-w-sm\b/);
  });

  it("marks the chosen topic as current", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const nav = screen.getByRole("navigation", { name: /settings sections/i });
    const notifications = within(nav).getByRole("button", { name: "Notifications" });
    expect(notifications.getAttribute("aria-current")).toBeNull();
    fireEvent.click(notifications);
    expect(notifications.getAttribute("aria-current")).toBe("page");
  });

  /// The constraint from the issue: a reorganisation that HIDES a
  /// control is a regression.
  ///
  /// Panels are hidden with CSS, never unmounted and never with the
  /// `hidden` attribute -- that attribute removes them from the
  /// accessibility tree, so a screen reader could not reach a setting
  /// until the right topic was clicked. Both wrong approaches were
  /// tried and both were caught by the existing tests failing to find
  /// controls by role.
  it("keeps every control reachable whichever topic is selected", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    // On "General" by default, yet a Notifications control is present.
    expect(screen.getByRole("checkbox", { name: /desktop notifications/i })).toBeTruthy();
    // ...and a Repositories one.
    expect(screen.getByLabelText(/directories to scan/i)).toBeTruthy();
  });
});
