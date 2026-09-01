import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommentRow } from "./CommentRow";

const props = {
  author: "alice",
  createdAt: new Date().toISOString(),
  body: "Can we pin the tauri version before this lands?",
};

describe("CommentRow", () => {
  it("starts collapsed, showing the author and a body preview", () => {
    render(<CommentRow {...props} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("alice")).toBeTruthy();
    expect(
      screen.getByText(/Can we pin the tauri version/),
    ).toBeTruthy();
  });

  it("expands to the full body on click", () => {
    render(<CommentRow {...props} body={"## Heading\n\nThe full body text."} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("The full body text.")).toBeTruthy();
  });

  // Showing the preview beside the rendered body prints the comment's
  // first line twice, once truncated -- so it must not be VISIBLE once
  // the body is open.
  it("hides the preview visually once the body is showing", () => {
    const body = "The one and only line.";
    render(<CommentRow {...props} body={body} />);
    fireEvent.click(screen.getByRole("button"));
    const visible = screen
      .getAllByText(body)
      .filter((el) => !el.classList.contains("sr-only"));
    expect(visible).toHaveLength(1);
  });

  // ...but it must stay in the toggle's ACCESSIBLE name. Removing it
  // outright left every expanded row announcing just "alice 2 days ago",
  // so a screen reader user could not tell which comment they had opened
  // and all of them sounded alike.
  it("keeps the preview in the accessible name when expanded", () => {
    render(<CommentRow {...props} body="Pin the tauri version" />);
    const toggle = screen.getByRole("button", { name: /Pin the tauri version/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Pin the tauri version/ }),
    ).toBeTruthy();
  });

  it("collapses again on a second click", () => {
    render(<CommentRow {...props} />);
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  // An empty body would otherwise render a bare "·" with nothing after it.
  it("omits the separator when there is nothing to preview", () => {
    render(<CommentRow {...props} body={"\n\n"} />);
    expect(screen.queryByText("·")).toBeNull();
  });
});
