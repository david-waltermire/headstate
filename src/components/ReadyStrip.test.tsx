import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

import { ReadyStrip } from "./ReadyStrip";
import { PR_FIXTURES } from "../fixtures/prs";
import type { PullRequest } from "@/types/pr";

afterEach(cleanup);

const ready: PullRequest = {
  ...PR_FIXTURES[0],
  title: "Ready one",
  is_draft: false,
  ci: "success",
  merge: "mergeable",
  review: "none",
  in_merge_queue: false,
};

describe("ReadyStrip", () => {
  it("lists what a reviewer can pick up", () => {
    render(<ReadyStrip prs={[ready]} onOpen={vi.fn()} />);
    expect(screen.getByText("Ready one")).toBeTruthy();
    expect(screen.getByText(/ready for review \(1\)/i)).toBeTruthy();
  });

  it("leaves out what is not ready", () => {
    render(<ReadyStrip prs={[{ ...ready, ci: "failure" }]} onOpen={vi.fn()} />);
    expect(screen.queryByText("Ready one")).toBeNull();
  });

  // Matches the attention strip: a section that shouts when there is
  // nothing in it stops being read.
  it("stays quiet when nothing is ready", () => {
    render(<ReadyStrip prs={[]} onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing ready to review/i)).toBeTruthy();
    expect(screen.queryByText(/ready for review \(/i)).toBeNull();
  });

  it("opens the detail view when clicked", () => {
    const onOpen = vi.fn();
    render(<ReadyStrip prs={[ready]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Ready one"));
    expect(onOpen).toHaveBeenCalledWith(ready);
  });

  it("is keyboard reachable, like the attention strip", () => {
    const onOpen = vi.fn();
    render(<ReadyStrip prs={[ready]} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /ready one/i }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(ready);
  });

  // With nothing to open, the entry must not look interactive.
  it("does not pretend to be clickable without a handler", () => {
    render(<ReadyStrip prs={[ready]} />);
    expect(screen.queryByRole("button", { name: /ready one/i })).toBeNull();
  });
});
