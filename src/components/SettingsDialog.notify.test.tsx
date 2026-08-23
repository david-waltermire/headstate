import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setPrefs = vi.fn(() => Promise.resolve());
const prefsState: { prefs: unknown } = { prefs: undefined };

vi.mock("../api/hooks", () => ({
  usePollInterval: () => ({ seconds: 120, set: vi.fn() }),
  useWorktreeDirs: () => ({ dirs: [], set: vi.fn(() => Promise.resolve()) }),
  useNotifyPrefs: () => ({ prefs: prefsState.prefs, set: setPrefs }),
}));

import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  setPrefs.mockClear();
  prefsState.prefs = { enabled: true, ci_failed: true, conflicted: true };
});
afterEach(cleanup);

const show = () => render(<SettingsDialog open onOpenChange={() => {}} />);

/// Notifications were the only interruption channel in the app with no
/// off switch -- not in Settings, not anywhere. The only escape was
/// denying permission at the OS level, which the poll loop treats as
/// permanent.
describe("notification settings", () => {
  it("offers a master switch and one toggle per kind", () => {
    show();
    expect(screen.getByRole("checkbox", { name: /desktop notifications/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /ci/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /conflict/i })).toBeTruthy();
  });

  it("turns everything off through the master switch", () => {
    show();
    fireEvent.click(screen.getByRole("checkbox", { name: /desktop notifications/i }));
    expect(setPrefs).toHaveBeenCalledWith({
      enabled: false,
      ci_failed: true,
      conflicted: true,
    });
  });

  // Turning the master switch off must not discard the per-kind choices,
  // so turning it back on restores what the user picked.
  it("keeps the per-kind choices when the master switch goes off", () => {
    prefsState.prefs = { enabled: true, ci_failed: true, conflicted: false };
    show();
    fireEvent.click(screen.getByRole("checkbox", { name: /desktop notifications/i }));
    expect(setPrefs).toHaveBeenCalledWith({
      enabled: false,
      ci_failed: true,
      conflicted: false,
    });
  });

  it("silences one kind without touching the other", () => {
    show();
    fireEvent.click(screen.getByRole("checkbox", { name: /conflict/i }));
    expect(setPrefs).toHaveBeenCalledWith({
      enabled: true,
      ci_failed: true,
      conflicted: false,
    });
  });

  // With the master switch off, the per-kind boxes must not imply they
  // still do something.
  it("disables the per-kind toggles when notifications are off", () => {
    prefsState.prefs = { enabled: false, ci_failed: true, conflicted: true };
    show();
    expect(screen.getByRole("checkbox", { name: /ci/i })).toHaveProperty("disabled", true);
  });

  // The behaviour is otherwise undiscoverable: nothing in the UI said
  // the app sends notifications at all.
  it("says what the app notifies about", () => {
    show();
    expect(screen.getByText(/only when a pull request newly breaks/i)).toBeTruthy();
  });
});
