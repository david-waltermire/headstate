import { describe, expect, it } from "vitest";
import { formatPct, pctChange, percentile } from "./stats";

describe("pctChange", () => {
  it("computes a rise", () => {
    expect(pctChange(183, 110)).toBeCloseTo(66.4, 1);
  });
  it("computes a decline", () => {
    expect(pctChange(110, 183)).toBeCloseTo(-39.9, 1);
  });
  // Guards the divide-by-zero that a naive ((c-p)/p) would hit.
  it("reports Infinity when there is no prior activity", () => {
    expect(pctChange(5, 0)).toBe(Infinity);
  });
  it("reports null when both periods are empty", () => {
    expect(pctChange(0, 0)).toBeNull();
  });
});

describe("percentile", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // Nearest rank: ceil(10 * 0.5) = 5th value = 5, not the 6th.
  it("takes p50", () => expect(percentile(ten, 0.5)).toBe(5));
  it("takes p90", () => expect(percentile(ten, 0.9)).toBe(9));
  // The case that made the old floor() implementation wrong in production:
  // n*p is an integer at both call sites the Stats page uses.
  it("does not overshoot by one rank on a round sample", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.9)).toBe(90);
  });
  it("clamps at p0 instead of indexing -1", () => {
    expect(percentile(ten, 0)).toBe(1);
  });
  // floor(n*p) can equal n; the index must be clamped.
  it("does not read past the end on a single sample", () => {
    expect(percentile([7], 0.9)).toBe(7);
  });
  // p=1.0 is the only input where floor(n*p) === n, so this is the case
  // that actually exercises the clamp. Without it the guard is untested.
  it("clamps at p100 instead of returning undefined", () => {
    expect(percentile([1, 2, 3], 1.0)).toBe(3);
  });
  it("returns 0 for an empty series rather than NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("formatPct", () => {
  it("signs a rise", () => expect(formatPct(66.4)).toBe("+66%"));
  it("signs a decline", () => expect(formatPct(-39.9)).toBe("-40%"));
  it("labels a start from zero", () => expect(formatPct(Infinity)).toBe("new"));
  it("labels no activity", () => expect(formatPct(null)).toBe("--"));
});
