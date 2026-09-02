import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefsState: { prefs: { hidden_views: string[]; close_hides_to_tray: boolean } } = {
  prefs: { hidden_views: [], close_hides_to_tray: true },
};

vi.mock("../api/hooks", () => ({
  useUiPrefs: () => ({ prefs: prefsState.prefs, set: vi.fn() }),
  useCleanupPrefs: () => ({ prefs: undefined, set: () => Promise.resolve() }),
}));

import { ViewSwitcher } from "./ViewSwitcher";
import { useFilters } from "@/store/filters";

beforeEach(() => {
  prefsState.prefs = { hidden_views: [], close_hides_to_tray: true };
  useFilters.setState({ view: "my-prs" });
});
afterEach(cleanup);

/// Half the top-level navigation is irrelevant to a PR-only user, and
/// two of four entries lead to empty screens on first run: Worktrees
/// needs scan directories configured, Docker needs a running daemon.
describe("hiding views", () => {
  it("offers every view by default", () => {
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menuitem", { name: /docker/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /worktrees/i })).toBeTruthy();
  });

  it("drops a hidden view from the menu", () => {
    prefsState.prefs = { hidden_views: ["docker"], close_hides_to_tray: true };
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("menuitem", { name: /docker/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /worktrees/i })).toBeTruthy();
  });

  // Hiding the view you are STANDING ON would leave the app showing a
  // page its own switcher says does not exist, with no way back.
  it("still shows the current view even if it is hidden", () => {
    useFilters.setState({ view: "docker" });
    prefsState.prefs = { hidden_views: ["docker"], close_hides_to_tray: true };
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menuitem", { name: /docker/i })).toBeTruthy();
  });

  // My PRs is the default view and the app's whole premise. Hiding it
  // would leave a user with no way back to the thing they installed
  // this for.
  // Standing on a DIFFERENT view, so the current-view guard cannot be
  // what keeps "My pull requests" in the list. Without this the test is
  // vacuous: with view="my-prs" both guards fire and deleting either
  // one still passes.
  it("never hides my pull requests, whatever is stored", () => {
    useFilters.setState({ view: "worktrees" });
    prefsState.prefs = {
      hidden_views: ["my-prs", "to-review", "docker"],
      close_hides_to_tray: true,
    };
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menuitem", { name: /my pull requests/i })).toBeTruthy();
    // ...and the others really are gone, so this is not just "nothing
    // is hidden at all".
    expect(screen.queryByRole("menuitem", { name: /docker/i })).toBeNull();
  });
});
