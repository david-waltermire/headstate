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
    dismissSplash(doc, 400, 0);
    vi.advanceTimersByTime(600);
    expect(doc.getElementById("splash")).toBeNull();
    vi.useRealTimers();
  });

  it("is safe to call when no splash exists", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(() => dismissSplash(doc)).not.toThrow();
  });

  // The splash is floored so a fast launch does not flash it past. The
  // floor must never gate work -- it only delays removing an overlay from
  // a UI that is already live underneath.
  it("holds the splash until the floor elapses", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400, 3000);
    // Well past the fade, but inside the floor.
    vi.advanceTimersByTime(600);
    expect(doc.getElementById("splash")).not.toBeNull();
    vi.useRealTimers();
  });

  it("removes the splash once the floor and fade have both elapsed", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400, 3000);
    vi.advanceTimersByTime(3000 + 600);
    expect(doc.getElementById("splash")).toBeNull();
    vi.useRealTimers();
  });

  // Repeated calls during the floor must collapse to a single dismissal.
  it("is safe to call repeatedly while the floor is pending", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400, 3000);
    dismissSplash(doc, 400, 3000);
    dismissSplash(doc, 400, 3000);
    vi.advanceTimersByTime(3000 + 600);
    expect(doc.getElementById("splash")).toBeNull();
    vi.useRealTimers();
  });

  it("is safe to call twice", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400, 0);
    expect(() => dismissSplash(doc, 400, 0)).not.toThrow();
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
  });
});
