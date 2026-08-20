import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrList } from "./PrList";

describe("PrList empty states", () => {
  // One fixed string used to cover both cases. With no filters set it read
  // as a bug, and told a new user nothing about what the app tracks.
  it("explains what the app tracks when nothing is filtered", () => {
    render(<PrList prs={[]} hasFilters={false} />);
    expect(screen.getByText(/no open pull requests/i)).toBeTruthy();
    expect(screen.getByText(/pull requests you opened/i)).toBeTruthy();
  });

  it("blames the filters only when filters are actually active", () => {
    render(<PrList prs={[]} hasFilters />);
    expect(screen.getByText(/match these filters/i)).toBeTruthy();
    expect(screen.queryByText(/pull requests you opened/i)).toBeNull();
  });
});

describe("PrList truncation notice", () => {
  // Silent truncation made the priorities strip -- whose whole job is
  // never to have a false negative -- filter a subset without saying so.
  it("says so when GitHub has more PRs than it returned", () => {
    render(<PrList prs={[]} hasFilters={false} total={137} />);
    expect(screen.getByText(/showing 0 of 137/i)).toBeTruthy();
  });

  it("stays silent in the normal case", () => {
    render(<PrList prs={[]} hasFilters={false} />);
    expect(screen.queryByText(/showing/i)).toBeNull();
  });

  it("stays silent when the total equals what was returned", () => {
    render(<PrList prs={[]} hasFilters={false} total={0} />);
    expect(screen.queryByText(/showing/i)).toBeNull();
  });
});
