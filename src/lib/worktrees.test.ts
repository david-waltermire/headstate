import { describe, expect, it } from "vitest";
import type { Safety } from "@/types/pr";
import { formatSize, isSafe, safetyReason, safetyTone } from "./worktrees";

describe("isSafe", () => {
  // Only `safe` is deletable. Everything else is disabled rather than
  // warned past: a cleanup tool that occasionally eats a day of work is
  // worse than no cleanup tool.
  it("is true only for safe", () => {
    expect(isSafe({ kind: "safe" })).toBe(true);
    for (const s of [
      { kind: "main_checkout" },
      { kind: "dirty", detail: 3 },
      { kind: "unpushed", detail: 2 },
      { kind: "never_pushed" },
      { kind: "unmerged" },
      { kind: "unknown", detail: "x" },
    ] as Safety[]) {
      expect(isSafe(s)).toBe(false);
    }
  });
});

describe("safetyReason", () => {
  it("pluralises counts", () => {
    expect(safetyReason({ kind: "dirty", detail: 1 })).toBe("1 uncommitted file");
    expect(safetyReason({ kind: "dirty", detail: 3 })).toBe("3 uncommitted files");
    expect(safetyReason({ kind: "unpushed", detail: 1 })).toBe("1 unpushed commit");
  });

  // The most dangerous state deserves the plainest words: 52 of 295
  // worktrees on this machine hold commits that exist nowhere else.
  it("says plainly when commits exist nowhere else", () => {
    expect(safetyReason({ kind: "never_pushed" })).toContain("only here");
  });
});

describe("safetyTone", () => {
  it("uses green only for safe", () => {
    expect(safetyTone({ kind: "safe" })).toContain("3fb950");
    expect(safetyTone({ kind: "unmerged" })).not.toContain("3fb950");
    expect(safetyTone({ kind: "never_pushed" })).not.toContain("3fb950");
  });

  // The main checkout is not a problem, so it must not look like one.
  it("does not alarm about the main checkout", () => {
    expect(safetyTone({ kind: "main_checkout" })).toContain("8b949e");
  });
});

describe("formatSize", () => {
  it("scales units", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  // An unmeasured size must not read as an empty directory.
  it("shows a dash rather than claiming zero", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(0)).toBe("0 B");
  });
});
