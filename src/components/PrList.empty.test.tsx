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
