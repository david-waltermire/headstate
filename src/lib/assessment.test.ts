import { describe, expect, it } from "vitest";
import { assessmentSummary } from "./assessment";
import type { Assessment } from "@/types/pr";

const a = (over: Partial<Assessment> = {}): Assessment => ({
  path: "/w/x",
  branch: "feat/x",
  commits_ahead: 4,
  files_changed: 11,
  insertions: 240,
  deletions: 18,
  last_activity: "3 weeks ago",
  has_upstream: true,
  subjects: [],
  subjects_elided: 0,
  ...over,
});

describe("assessmentSummary", () => {
  it("reads as one line in decision order", () => {
    expect(assessmentSummary(a())).toBe("4 commits ahead · 11 files · +240/-18 · 3 weeks ago");
  });

  // The fact that decides whether deleting is recoverable.
  it("says when the work exists only on this machine", () => {
    expect(assessmentSummary(a({ has_upstream: false }))).toContain("never pushed");
  });

  it("stays quiet about being pushed, which is the normal case", () => {
    expect(assessmentSummary(a())).not.toContain("pushed");
  });

  // "0 commits ahead" and "we could not count" are opposite answers.
  it("omits a count git could not produce rather than printing zero", () => {
    const s = assessmentSummary(a({ commits_ahead: null }));
    expect(s).not.toContain("0 commits");
    expect(s).not.toContain("commits ahead");
    expect(s).toContain("11 files");
  });

  it("still shows a real zero", () => {
    expect(assessmentSummary(a({ commits_ahead: 0 }))).toContain("0 commits ahead");
  });

  it("singularises one commit and one file", () => {
    expect(assessmentSummary(a({ commits_ahead: 1, files_changed: 1 }))).toContain(
      "1 commit ahead · 1 file",
    );
  });

  // A pure-deletion diff has no insertions line at all.
  it("renders a one-sided diff without inventing the other side", () => {
    expect(assessmentSummary(a({ insertions: null }))).toContain("+0/-18");
  });

  it("returns an empty string when git answered nothing", () => {
    expect(
      assessmentSummary(
        a({
          commits_ahead: null,
          files_changed: null,
          insertions: null,
          deletions: null,
          last_activity: null,
        }),
      ),
    ).toBe("");
  });
});
