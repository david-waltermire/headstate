import { describe, expect, it, vi } from "vitest";
import { dismissSplash } from "./splash";

function withSplash(): Document {
  const doc = document.implementation.createHTMLDocument("t");
  const el = doc.createElement("div");
  el.id = "splash";
  doc.body.appendChild(el);
  return doc;
}

describe("dismissSplash", () => {
  it("removes the splash element after the fade", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400);
    vi.advanceTimersByTime(600);
    expect(doc.getElementById("splash")).toBeNull();
    vi.useRealTimers();
  });

  it("is safe to call when no splash exists", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(() => dismissSplash(doc)).not.toThrow();
  });

  it("is safe to call twice", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400);
    expect(() => dismissSplash(doc, 400)).not.toThrow();
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
  });
});
