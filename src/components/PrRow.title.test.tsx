import { fireEvent, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrRow } from "@/components/PrRow";
import { PR_FIXTURES } from "@/fixtures/prs";
import { renderWithQuery as render } from "@/test-utils";

afterEach(cleanup);

/// Reported as "clicking a PR on To review does not show it". The cause
/// was not view-specific: the title was an `<a target="_blank">` that
/// stopped propagation, so clicking it opened github.com and never
/// reached the row's `onOpen` -- on EVERY view.
///
/// It reads as a To review problem because that is where the title is
/// the obvious target: `canWrite` is false there, so the row has no
/// action buttons and the title is the only thing that looks
/// interactive.
describe("clicking a row's title", () => {
  it("opens the detail view", () => {
    const onOpen = vi.fn();
    render(<PrRow pr={PR_FIXTURES[0]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText(PR_FIXTURES[0].title));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // The row itself must keep working -- the title is an addition, not a
  // replacement.
  it("still opens from anywhere else in the row", () => {
    const onOpen = vi.fn();
    const { container } = render(<PrRow pr={PR_FIXTURES[0]} onOpen={onOpen} />);
    fireEvent.click(container.firstElementChild!);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // It must not ALSO navigate to github.com. A title that both opens the
  // detail view and launches a browser tab is worse than either.
  it("does not navigate to GitHub as well", () => {
    render(<PrRow pr={PR_FIXTURES[0]} onOpen={vi.fn()} />);
    const title = screen.getByText(PR_FIXTURES[0].title);
    expect(title.closest("a")).toBeNull();
  });

  // On a list with no detail view to open, the title must still reach
  // GitHub rather than becoming inert.
  it("falls back to a GitHub link when the row cannot be opened", () => {
    render(<PrRow pr={PR_FIXTURES[0]} />);
    const link = screen.getByText(PR_FIXTURES[0].title).closest("a");
    expect(link?.getAttribute("href")).toBe(PR_FIXTURES[0].url);
  });
});
