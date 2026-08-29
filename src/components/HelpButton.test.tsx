import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HelpButton } from "./HelpButton";
import { HELP_TOPICS } from "@/help/topics";

afterEach(cleanup);

describe("HelpButton", () => {
  it("shows the topic's content when opened", async () => {
    render(<HelpButton topic="needs-attention" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByText(HELP_TOPICS["needs-attention"].title)).toBeTruthy(),
    );
    // The body, not just the heading -- a Sheet that opens empty is
    // worse than no help at all.
    expect(screen.getByText(/merge conflicts/i)).toBeTruthy();
  });

  it("shows nothing until it is asked", () => {
    render(<HelpButton topic="needs-attention" />);
    expect(screen.queryByText(/merge conflicts/i)).toBeNull();
  });

  /// A lone `?` is unreadable to a screen reader, and "help" repeated
  /// across a page says nothing about which one to press.
  it("names itself by its topic, not as a bare help button", () => {
    render(<HelpButton topic="triage-chips" />);
    const label = screen.getByRole("button").getAttribute("aria-label") ?? "";
    // Names its topic, so eleven of these on a page are distinguishable.
    expect(label.toLowerCase()).toContain("triage chips");
    expect(label).not.toMatch(/^help$/i);
    // And says it is help, so it cannot be mistaken for the control it
    // sits beside -- a title reading "...safe to remove" matched a
    // query for the Remove button.
    expect(label).toMatch(/^About /);
  });
});

/// The registry is content, so these check the CONTENT rather than the
/// plumbing. A topic that renders an empty Sheet passes every
/// component test and fails the user.
describe("help topics", () => {
  it.each(Object.entries(HELP_TOPICS))("%s has a title and a real body", (_id, topic) => {
    expect(topic.title.length).toBeGreaterThan(0);
    // Long enough to be an explanation rather than a restated label --
    // if a topic fits in a tooltip it does not need a Sheet.
    expect(topic.body.trim().length).toBeGreaterThan(120);
  });

  /// A title phrased as a question reads as a FAQ entry rather than a
  /// panel heading, and the Sheet already sits in answer position.
  it.each(Object.entries(HELP_TOPICS))("%s is titled as a noun phrase", (_id, topic) => {
    expect(topic.title).not.toMatch(/\?$/);
  });

  /// A title becomes the button's accessible name, so an action verb in
  /// one makes the help button indistinguishable from the control it
  /// explains. "What makes a worktree safe to remove" matched a query
  /// for the Remove button -- for a screen reader as much as for a test.
  it.each(Object.entries(HELP_TOPICS))("%s does not read as an action", (_id, topic) => {
    expect(topic.title).not.toMatch(/\b(remov|delet|install|merg|updat|clear)/i);
  });
});
