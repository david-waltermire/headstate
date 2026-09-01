import { describe, expect, it } from "vitest";
import { commentPreview } from "./preview";

describe("commentPreview", () => {
  it("uses the body when it is a single plain line", () => {
    expect(commentPreview("LGTM once CI passes")).toBe("LGTM once CI passes");
  });

  // The three shapes `body.slice(0, n)` gets wrong. Each one is a real
  // comment opening, and each previews as punctuation without this.
  it("skips a leading blank line", () => {
    expect(commentPreview("\n\nThis will break on Windows")).toBe(
      "This will break on Windows",
    );
  });

  it("takes the text of a heading rather than the hashes", () => {
    expect(commentPreview("## Summary\n\nPin the version")).toBe("Summary");
  });

  it("skips a fence and previews the code's first line", () => {
    expect(commentPreview("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("reads bullets and task boxes as their text", () => {
    expect(commentPreview("- [ ] rebase onto main")).toBe("rebase onto main");
    expect(commentPreview("1. first step")).toBe("first step");
  });

  // The preview is placed as PLAIN text in a one-line row, so markup that
  // survives here would render literally rather than as formatting.
  it("renders inline markup as the text a person reads", () => {
    expect(commentPreview("**Please** pin `tauri` to [2.x](http://a.b)")).toBe(
      "Please pin tauri to 2.x",
    );
  });

  it("keeps an image's alt text without leaving the bang", () => {
    expect(commentPreview("![a screenshot](http://a.b/c.png)")).toBe("a screenshot");
  });

  it("collapses whitespace runs", () => {
    expect(commentPreview("a     b\tc")).toBe("a b c");
  });

  it("truncates long lines and marks that it did", () => {
    const out = commentPreview("x".repeat(200), 80);
    expect(out).toHaveLength(81);
    expect(out.endsWith("…")).toBe(true);
  });

  // An unconditional ellipsis makes a complete short comment look like it
  // continues, which is the opposite of what the row is for.
  it("does not mark a short comment as truncated", () => {
    expect(commentPreview("short").endsWith("…")).toBe(false);
  });

  it("returns empty for a body with nothing to show", () => {
    expect(commentPreview("\n\n   \n")).toBe("");
    expect(commentPreview("```\n```")).toBe("");
  });
});
