import { describe, expect, it } from "vitest";
import type { Safety } from "@/types/pr";
import {
  formatSize,
  isSafe,
  pathBasename,
  prForWorktree,
  safetyReason,
  safetyTone,
} from "./worktrees";

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

describe("pathBasename", () => {
  // The bug: split("/") returns the whole string unchanged on a Windows
  // path, so every row would show the full path instead of the directory.
  it("finds the last component of a Windows path", () => {
    expect(pathBasename("C:\\Users\\me\\code\\proj-feature")).toBe("proj-feature");
  });

  it("finds the last component of a Unix path", () => {
    expect(pathBasename("/Users/me/code/proj-feature")).toBe("proj-feature");
  });

  // Git on Windows often reports forward slashes even for Windows paths,
  // so both must work regardless of which platform produced them.
  it("handles a Windows drive with forward slashes", () => {
    expect(pathBasename("C:/Users/me/code/proj")).toBe("proj");
  });

  it("ignores a trailing separator rather than returning empty", () => {
    expect(pathBasename("/code/proj/")).toBe("proj");
    expect(pathBasename("C:\\code\\proj\\")).toBe("proj");
  });

  it("returns the input when there is no separator at all", () => {
    expect(pathBasename("proj")).toBe("proj");
  });
});

describe("prForWorktree", () => {
  const pr = (repo: string, head: string, number: number) =>
    ({ repo, head_ref: head, number } as unknown as import("@/types/pr").PullRequest);

  it("pairs a worktree with its pull request", () => {
    const prs = [pr("octocat/api", "feat/x", 1)];
    expect(prForWorktree(prs, "octocat/api", "feat/x")?.number).toBe(1);
  });

  // THE trap. Branch names are not unique across repositories -- this
  // account has feat/egr33-* in two of them -- and a wrong pairing would
  // attach GitHub's authoritative-looking "merged" to the wrong
  // directory.
  it("never matches the same branch in a different repository", () => {
    const prs = [pr("octocat/api", "feat/shared", 1)];
    expect(prForWorktree(prs, "octocat/worker", "feat/shared")).toBeNull();
  });

  // A repo with no remote resolves to null identity, which must mean
  // "no pairing" rather than "match anything".
  //
  // The PR fixture below carries repo=null so that a comparison-only
  // implementation WOULD match it -- without that, the guard could be
  // deleted and this test would still pass, since `repo === null` never
  // equals a real repo name.
  it("makes no match when the repository cannot be identified", () => {
    const prs = [
      { repo: null, head_ref: "feat/x", number: 9 } as unknown as
        import("@/types/pr").PullRequest,
    ];
    expect(prForWorktree(prs, null, "feat/x")).toBeNull();
  });

  it("makes no match for a detached worktree", () => {
    const prs = [pr("octocat/api", "feat/x", 1)];
    expect(prForWorktree(prs, "octocat/api", "")).toBeNull();
  });
});
