import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewThread } from "@/types/pr";

const resolve = vi.fn(() => Promise.resolve());
const unresolve = vi.fn(() => Promise.resolve());
const reply = vi.fn(() => Promise.resolve());

vi.mock("../api/hooks", () => ({
  useResolveThread: () => resolve,
  useUnresolveThread: () => unresolve,
  useReplyToThread: () => reply,
}));

import { ReviewThreads } from "./ReviewThreads";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "RT_1",
  is_resolved: false,
  is_outdated: false,
  path: "src/api/hooks.ts",
  line: 412,
  viewer_can_reply: true,
  viewer_can_resolve: true,
  viewer_can_unresolve: true,
  comments: [
    {
      author: "carol",
      created_at: "2026-08-20T10:00:00Z",
      body: "This leaks the subscription",
    },
  ],
  comment_count: 1,
  ...over,
});

const view = (threads: ReviewThread[]) =>
  render(<ReviewThreads threads={threads} repo="o/r" number={7} />);

beforeEach(() => {
  resolve.mockClear();
  unresolve.mockClear();
  reply.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("ReviewThreads", () => {
  it("renders nothing when there are no conversations", () => {
    const { container } = view([]);
    expect(container.firstChild).toBeNull();
  });

  // The whole point of the section: an unresolved thread is what needs an
  // answer, so it must not be hidden behind a click.
  it("opens unresolved conversations and collapses settled ones", () => {
    view([thread(), thread({ id: "RT_2", is_resolved: true })]);
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-expanded") !== null);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    expect(toggles[1].getAttribute("aria-expanded")).toBe("false");
  });

  it("puts actionable conversations before settled ones", () => {
    view([thread({ id: "RT_done", is_resolved: true, path: "a.ts" }), thread({ path: "b.ts" })]);
    const labels = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-expanded") !== null)
      .map((b) => b.textContent ?? "");
    expect(labels[0]).toContain("b.ts");
    expect(labels[1]).toContain("a.ts");
  });

  it("resolves a conversation by its thread id", () => {
    view([thread()]);
    fireEvent.click(screen.getByRole("button", { name: "Resolve conversation" }));
    expect(resolve).toHaveBeenCalledWith("RT_1", "o/r", 7);
  });

  it("replies with the typed body", () => {
    view([thread()]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "good catch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(reply).toHaveBeenCalledWith("RT_1", "o/r", 7, "good catch");
  });

  // An empty reply posts a blank comment, which is never what the click
  // meant. The command refuses it too; this keeps the button from looking
  // available for something that cannot happen.
  it("will not send an empty reply", () => {
    view([thread()]);
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  // Every control is gated on the viewer's own permission: an ungated
  // button renders and then 403s, which is a button that lies.
  it("hides Resolve when the viewer may not resolve", () => {
    view([thread({ viewer_can_resolve: false })]);
    expect(screen.queryByRole("button", { name: "Resolve conversation" })).toBeNull();
  });

  it("hides the reply box when the viewer may not reply", () => {
    view([thread({ viewer_can_reply: false })]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("offers Reopen only on a resolved thread the viewer may unresolve", () => {
    view([thread({ is_resolved: true })]);
    fireEvent.click(
      screen.getAllByRole("button").filter((b) => b.getAttribute("aria-expanded"))[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(unresolve).toHaveBeenCalledWith("RT_1", "o/r", 7);
  });

  it("hides Reopen when the viewer may not unresolve", () => {
    view([thread({ is_resolved: true, viewer_can_unresolve: false })]);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  // Outdated means the anchor line is gone, NOT that the question was
  // answered. Presenting it as resolved would tell the user something
  // untrue about work they still owe.
  it("marks an outdated thread as outdated and still unresolved", () => {
    view([thread({ is_outdated: true })]);
    expect(screen.getByText("outdated")).toBeTruthy();
    expect(screen.getByText("unresolved")).toBeTruthy();
  });

  /// An outdated thread is stranded, not answered: the code moved out
  /// from under it. It must sort and default with the SETTLED threads --
  /// the same rule `unresolved_threads` uses to leave it out of the
  /// count -- or the header says "0 unresolved" above a conversation
  /// presented as awaiting action.
  it("treats an outdated thread as settled, not as actionable", () => {
    view([
      thread({ id: "RT_old", is_outdated: true, path: "stale.ts" }),
      thread({ id: "RT_live", path: "live.ts" }),
    ]);
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-expanded") !== null);

    // The live thread sorts first and opens; the outdated one does not.
    expect(toggles[0].textContent).toContain("live.ts");
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    expect(toggles[1].textContent).toContain("stale.ts");
    expect(toggles[1].getAttribute("aria-expanded")).toBe("false");
  });

  // `line` is null exactly when the anchor is gone; "src/poll.rs:null"
  // points at a line that does not exist.
  it("shows the path alone when the line is gone", () => {
    view([thread({ is_outdated: true, line: null, path: "src/poll.rs" })]);
    expect(screen.getByText("src/poll.rs")).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
  });

  it("says when a thread has more comments than it shows", () => {
    view([thread({ comment_count: 12 })]);
    expect(screen.getByText(/Showing 1 of 12/)).toBeTruthy();
  });
});
