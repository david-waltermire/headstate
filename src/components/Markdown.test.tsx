import { vi } from "vitest";
const openUrl = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
import { fireEvent, render, screen } from "@testing-library/react";
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
  // The intent is unchanged -- a link must open the user's browser, not
  // navigate the app -- but `target="_blank"` was never the mechanism
  // that achieved it. In a packaged Tauri window there is no browser
  // context to open a tab in, so the attribute did nothing; it only
  // appeared to work in `tauri dev`, where the webview IS a browser.
  it("opens links in the system browser, not the app", () => {
    const { container } = render(<Markdown>{"[click](https://example.com)"}</Markdown>);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    fireEvent.click(a as Element);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("survives an empty body", () => {
    expect(() => render(<Markdown>{""}</Markdown>)).not.toThrow();
  });
});

/// #438: paragraphs and tables rendered squished together, and blank
/// lines looked ignored.
///
/// They were parsed correctly all along -- `prose-headstate` was applied
/// to the wrapper and never DEFINED anywhere, so every block element
/// fell back to the CSS reset, which strips margins.
describe("vertical rhythm", () => {
  /// Asserting on the CLASS rather than on computed style: jsdom
  /// computes no layout, so a margin assertion would pass either way.
  it("gives paragraphs a margin, so blank lines are visible", () => {
    const { container } = render(<Markdown>{"First para.\n\nSecond para."}</Markdown>);
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    for (const p of ps) expect(p.className).toMatch(/my-\d/);
  });

  it("spaces tables and collapses their borders", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const { container } = render(<Markdown>{md}</Markdown>);
    const table = container.querySelector("table");
    expect(table?.className).toMatch(/border-collapse/);
    expect(table?.parentElement?.className).toMatch(/my-\d/);
  });

  it("spaces lists and their items", () => {
    const { container } = render(<Markdown>{"- one\n- two"}</Markdown>);
    const ul = container.querySelector("ul");
    expect(ul?.className).toMatch(/my-\d/);
    expect(ul?.className).toMatch(/space-y-\d/);
  });

  /// A heading belongs to what FOLLOWS it, so it needs more space above
  /// than below -- equal margins make it float between two sections.
  it("gives headings more space above than below", () => {
    const { container } = render(<Markdown>{"## Heading\n\nBody."}</Markdown>);
    const h2 = container.querySelector("h2");
    expect(h2?.className).toMatch(/mt-5/);
    expect(h2?.className).toMatch(/mb-2/);
  });

  it("spaces block quotes and code blocks", () => {
    const { container } = render(
      <Markdown>{"> quoted\n\n```\ncode\n```"}</Markdown>,
    );
    expect(container.querySelector("blockquote")?.className).toMatch(/my-\d/);
    expect(container.querySelector("pre")?.className).toMatch(/my-\d/);
  });
});
