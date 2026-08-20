import { describe, expect, it } from "vitest";
import { labelForeground } from "./labels";

describe("labelForeground", () => {
  it("picks dark text on a light background", () => {
    expect(labelForeground("ffffff")).toBe("#1f2328");
  });

  it("picks light text on a dark background", () => {
    expect(labelForeground("000000")).toBe("#ffffff");
  });

  it("accepts a leading #", () => {
    expect(labelForeground("#ffffff")).toBe("#1f2328");
  });

  it("matches GitHub's real label hexes", () => {
    // "enhancement" -- light blue, wants dark text.
    expect(labelForeground("a2eeef")).toBe("#1f2328");
    // "bug" -- a saturated red, wants light text.
    expect(labelForeground("d73a4a")).toBe("#ffffff");
  });
});
