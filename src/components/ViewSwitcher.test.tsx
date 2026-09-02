import { fireEvent, screen } from "@testing-library/react";
// ViewSwitcher reads `useUiPrefs`, so it needs a QueryClient.
import { renderWithQuery as render } from "@/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "../store/filters";
import { ViewSwitcher } from "./ViewSwitcher";

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {}, artifacts: {} } as const;

describe("ViewSwitcher", () => {
  beforeEach(() =>
    useFilters.setState({ filtersByView: { ...EMPTY }, view: "my-prs", panel: "list" }),
  );

  it("names the current view when collapsed", () => {
    render(<ViewSwitcher />);
    expect(screen.getByRole("button", { name: /my pull requests/i })).toBeTruthy();
    // The others are not visible until expanded.
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  // Names rather than a count: a bare length assertion has to be edited
  // every time a view is added and says nothing about which are missing.
  it("lists every view when expanded", () => {
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    for (const label of [/my pull requests/i, /to review/i, /worktrees/i, /docker/i]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("switches view and closes", () => {
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /worktrees/i }));
    expect(useFilters.getState().view).toBe("worktrees");
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("marks the current view so the menu is not ambiguous", () => {
    useFilters.setState({ filtersByView: { ...EMPTY }, view: "to-review", panel: "list" });
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /to review/i }));
    const current = screen.getByRole("menuitem", { name: /to review/i });
    expect(current.getAttribute("aria-current")).toBe("true");
  });

  it("badges a count when one is supplied", () => {
    render(<ViewSwitcher counts={{ "to-review": 4 }} />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    expect(screen.getByText("4")).toBeTruthy();
  });

  // A menu that survives Escape or an outside click stays open behind
  // whatever the user does next.
  it("closes on Escape", () => {
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes on a click outside", () => {
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  // Switching views must not carry one view's repo selection into
  // another, which has an entirely different repo list.
  it("does not leak filters between views", () => {
    useFilters.setState({
      filtersByView: { "my-prs": { repo: "octocat/hello-world" }, "to-review": {}, worktrees: {}, docker: {}, artifacts: {} },
      view: "my-prs",
      panel: "list",
    });
    render(<ViewSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /my pull requests/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /to review/i }));
    const s = useFilters.getState();
    expect(s.filtersByView[s.view].repo).toBeUndefined();
  });
});
