import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders formatting", () => {
    const { container } = render(<Markdown>{"# Title\n\n- one\n- two"}</Markdown>);
    expect(screen.getByText("Title")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders tables via GFM", () => {
    const { container } = render(
      <Markdown>{"| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>,
    );
    expect(container.querySelector("table")).toBeTruthy();
  });

  // Bodies and comments are written by other people, and this app holds
  // a token in memory. The sanitiser is the load-bearing part.
  it("strips script tags while keeping the surrounding prose", () => {
    // Separate blocks: raw HTML and its neighbouring text are one node
    // otherwise, so dropping the script drops the sentence with it.
    const { container } = render(
      <Markdown>{"safe text\n\n<script>window.evil=1</script>"}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("window.evil");
    expect(container.textContent).toContain("safe text");
  });

  it("strips inline event handlers", () => {
    const { container } = render(
      <Markdown>{'<img src="x" onerror="window.evil=1" alt="a">'}</Markdown>,
    );
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("strips iframes", () => {
    const { container } = render(<Markdown>{'<iframe src="https://x"></iframe>'}</Markdown>);
    expect(container.querySelector("iframe")).toBeNull();
  });

  // A link must never navigate the app webview itself.
  it("opens links in the system browser, not the app", () => {
    const { container } = render(<Markdown>{"[click](https://example.com)"}</Markdown>);
    const a = container.querySelector("a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("survives an empty body", () => {
    expect(() => render(<Markdown>{""}</Markdown>)).not.toThrow();
  });
});
