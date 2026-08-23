import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrioritiesStrip } from "./PrioritiesStrip";
import { PR_FIXTURES } from "../fixtures/prs";
import type { PullRequest } from "@/types/pr";

afterEach(cleanup);

const blocked: PullRequest = { ...PR_FIXTURES[0], ci: "failure", title: "Broken thing" };

/// The one surface whose whole job is "these need you right now" was the
/// only place you could not act from: it had no interactive elements at
/// all except an external link to github.com.
describe("clicking a pull request in the attention panel", () => {
  it("opens the detail view", () => {
    const onOpen = vi.fn();
    render(<PrioritiesStrip prs={[blocked]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Broken thing"));
    expect(onOpen).toHaveBeenCalledWith(blocked);
  });

  it("is keyboard reachable, like the rows in the list", () => {
    const onOpen = vi.fn();
    render(<PrioritiesStrip prs={[blocked]} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /broken thing/i }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(blocked);
  });

  // Still says WHY, which is the panel's actual contribution -- the
  // list below can say a PR is blocked but not that CI is the reason.
  it("keeps the reason on screen", () => {
    render(<PrioritiesStrip prs={[blocked]} onOpen={vi.fn()} />);
    expect(screen.getByText(/CI failing/i)).toBeTruthy();
  });

  // With nothing to open, the entry must not look interactive.
  it("does not pretend to be clickable without a handler", () => {
    render(<PrioritiesStrip prs={[blocked]} />);
    expect(screen.queryByRole("button", { name: /broken thing/i })).toBeNull();
  });
});
