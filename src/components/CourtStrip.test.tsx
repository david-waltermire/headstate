import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourtStrip } from "./CourtStrip";
import type { PullRequest } from "@/types/pr";

afterEach(cleanup);

const pr = (over: Partial<PullRequest> = {}) =>
  ({
    repo: "octocat/api",
    number: 1,
    title: "t",
    is_draft: false,
    ci: "success",
    merge: "mergeable",
    review: "none",
    in_merge_queue: false,
    ...over,
  }) as PullRequest;

/// The landing view answered "is anything on fire?" with a 12px muted
/// line reading "Nothing blocked on you", then gave a six-control filter
/// toolbar the visual weight. The app KNOWS the answer -- the tray badge
/// is computed from it -- so the glance surface should say it plainly.
describe("CourtStrip", () => {
  it("states the all-clear confidently, not as a footnote", () => {
    render(<CourtStrip authored={[pr()]} reviewing={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/nothing needs your attention/i)).toBeTruthy();
  });

  // The counts are the context that makes an all-clear trustworthy: "0
  // of nothing" and "0 of 24" feel very different to a reader.
  it("still says what it looked at when all is clear", () => {
    render(<CourtStrip authored={[pr(), pr({ number: 2 })]} reviewing={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/2 open/i)).toBeTruthy();
  });

  it("counts what is in my court", () => {
    render(
      <CourtStrip authored={[pr({ ci: "failure" })]} reviewing={[]} onSelect={vi.fn()} />,
    );
    expect(screen.getByText(/1 needs you/i)).toBeTruthy();
  });

  it("counts what is waiting on someone else separately", () => {
    render(
      <CourtStrip
        authored={[pr({ review: "review_required" })]}
        reviewing={[]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 waiting on others/i)).toBeTruthy();
  });

  it("opens the list scoped to my court when clicked", () => {
    const onSelect = vi.fn();
    render(<CourtStrip authored={[pr({ ci: "failure" })]} reviewing={[]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /needs you/i }));
    expect(onSelect).toHaveBeenCalledWith("mine");
  });

  // A card that cannot be acted on is decoration.
  it("does not offer a click when the count is zero", () => {
    render(<CourtStrip authored={[pr()]} reviewing={[]} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /needs you/i })).toBeNull();
  });
});
