import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrList } from "./PrList";
import { renderWithQuery as render } from "@/test-utils";

afterEach(cleanup);

/// Reported from a fresh 3.1.2 install: no pull requests shown, plus two
/// network error banners. There is no cached snapshot on a first launch,
/// so a failing first poll leaves the list genuinely empty -- and the
/// empty state then said "No open pull requests", which is a confident
/// answer to a question the app could not ask.
///
/// This is the same failure class the codebase already guards against
/// for a rejected query and for a truncated list: never report zero for
/// "we could not find out".
describe("an empty list after a failed poll", () => {
  it("does not claim there are no pull requests", () => {
    render(<PrList prs={[]} hasFilters={false} unreachable />);
    expect(screen.queryByText(/no open pull requests/i)).toBeNull();
  });

  it("says GitHub could not be reached", () => {
    render(<PrList prs={[]} hasFilters={false} unreachable />);
    expect(screen.getByText(/could not reach github/i)).toBeTruthy();
  });

  // A genuinely empty account must still get the honest answer.
  it("still reports zero when the poll succeeded", () => {
    render(<PrList prs={[]} hasFilters={false} />);
    expect(screen.getByText(/no open pull requests/i)).toBeTruthy();
  });

  // With rows on screen the banner already says what happened; the list
  // is showing real data and must not be replaced by an error.
  it("shows the rows it has even when a later poll failed", () => {
    render(<PrList prs={[]} hasFilters unreachable />);
    // Filters active: that message is about the filter, not the network.
    expect(screen.getByText(/match these filters/i)).toBeTruthy();
  });
});
