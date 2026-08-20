import { describe, expect, it } from "vitest";
import { PR_FIXTURES, prWithState } from "../fixtures/prs";
import { formatNudge, GROUP_THRESHOLD } from "./nudge";

const [approved, broken, checking] = PR_FIXTURES;

describe("formatNudge", () => {
  it("produces flat markdown bullets by default", () => {
    expect(formatNudge([approved], {})).toBe(
      "- [octocat/hello-world#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
    );
  });

  it("joins multiple flat bullets with newlines, in input order", () => {
    expect(formatNudge([approved, checking], {})).toBe(
      [
        "- [octocat/hello-world#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
        "- [octocat/spoon-knife#7] Bump the parser dependency — https://github.com/octocat/spoon-knife/pull/7",
      ].join("\n"),
    );
  });

  it("groups under repo headers when asked", () => {
    expect(formatNudge([approved, checking], { grouped: true })).toBe(
      [
        "**octocat/hello-world**",
        "- [#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
        "",
        "**octocat/spoon-knife**",
        "- [#7] Bump the parser dependency — https://github.com/octocat/spoon-knife/pull/7",
      ].join("\n"),
    );
  });

  it("sorts repo groups alphabetically regardless of input order", () => {
    expect(formatNudge([checking, approved], { grouped: true })).toBe(
      [
        "**octocat/hello-world**",
        "- [#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
        "",
        "**octocat/spoon-knife**",
        "- [#7] Bump the parser dependency — https://github.com/octocat/spoon-knife/pull/7",
      ].join("\n"),
    );
  });

  it("keeps PRs within a repo group in input order", () => {
    const second = prWithState("failure", "conflicted", "changes_requested", {
      number: 99,
      title: "Second PR in the same repo",
      url: "https://github.com/octocat/hello-world/pull/99",
      repo: "octocat/hello-world",
    });
    expect(formatNudge([second, approved], { grouped: true })).toBe(
      [
        "**octocat/hello-world**",
        "- [#99] Second PR in the same repo — https://github.com/octocat/hello-world/pull/99",
        "- [#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
      ].join("\n"),
    );
  });

  it("does not group below the threshold unless explicitly asked", () => {
    expect(formatNudge([approved, checking], {})).not.toContain("**");
  });

  it(`auto-groups at ${GROUP_THRESHOLD} or more distinct repos`, () => {
    const third = prWithState("none", "mergeable", "none", {
      number: 1,
      title: "Third repo's only PR",
      url: "https://github.com/octocat/git-consortium/pull/1",
      repo: "octocat/git-consortium",
    });
    const out = formatNudge([approved, checking, third], {});
    expect(out).toBe(
      [
        "**octocat/git-consortium**",
        "- [#1] Third repo's only PR — https://github.com/octocat/git-consortium/pull/1",
        "",
        "**octocat/hello-world**",
        "- [#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
        "",
        "**octocat/spoon-knife**",
        "- [#7] Bump the parser dependency — https://github.com/octocat/spoon-knife/pull/7",
      ].join("\n"),
    );
  });

  it("honours an explicit grouped: false even at or above the threshold", () => {
    const third = prWithState("none", "mergeable", "none", {
      number: 1,
      title: "Third repo's only PR",
      url: "https://github.com/octocat/git-consortium/pull/1",
      repo: "octocat/git-consortium",
    });
    const out = formatNudge([approved, checking, third], { grouped: false });
    expect(out).not.toContain("**");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("annotates status when asked", () => {
    expect(formatNudge([approved], { annotate: true })).toContain("(green, approved)");
    expect(formatNudge([broken], { annotate: true })).toContain("(CI failing)");
  });

  it("annotates a real merge conflict as needing a rebase, not CI failing", () => {
    const conflicted = prWithState("success", "conflicted", "review_required");
    expect(formatNudge([conflicted], { annotate: true })).toContain("(needs rebase)");
  });

  /// GitHub reports mergeability as UNKNOWN right after a push while it
  /// computes; `needsAttention` in derive.ts deliberately excludes
  /// merge === "checking" from "needs rebase" for that reason, and this
  /// module delegates to that predicate rather than re-deriving it, so the
  /// same exclusion must hold here.
  it("never annotates a still-checking merge state as needing a rebase", () => {
    const out = formatNudge([checking], { annotate: true });
    expect(out).not.toContain("needs rebase");
  });

  it("annotates a draft PR", () => {
    const draft = prWithState("none", "mergeable", "none", { is_draft: true });
    expect(formatNudge([draft], { annotate: true })).toContain("(draft)");
  });

  it("annotates a green PR awaiting review", () => {
    const awaiting = prWithState("success", "mergeable", "review_required");
    expect(formatNudge([awaiting], { annotate: true })).toContain("(green, awaiting review)");
  });

  it("annotates a PR with CI still running", () => {
    const running = prWithState("pending", "mergeable", "none");
    expect(formatNudge([running], { annotate: true })).toContain("(CI running)");
  });

  /// #35: a green, approved PR already in the merge queue used to fall
  /// through every branch and render with no annotation at all -- silence
  /// indistinguishable from "nothing to report." It must say so instead.
  it("annotates a PR already in the merge queue", () => {
    const queued = prWithState("success", "mergeable", "approved", { in_merge_queue: true });
    expect(formatNudge([queued], { annotate: true })).toContain("(in merge queue)");
  });

  /// #35 placement: a conflicted (or red) PR is still a problem worth
  /// naming first, even if it's sitting in the merge queue -- the
  /// needsAttention gate must win over the in_merge_queue check.
  it("still annotates a queued PR that is also conflicted as needing a rebase", () => {
    const queuedAndConflicted = prWithState("success", "conflicted", "approved", {
      in_merge_queue: true,
    });
    const out = formatNudge([queuedAndConflicted], { annotate: true });
    expect(out).toContain("(needs rebase)");
    expect(out).not.toContain("(in merge queue)");
  });

  it("omits annotations by default", () => {
    expect(formatNudge([approved], {})).not.toContain("(");
  });

  /// Slack's mrkdwn is not markdown: a [text](url) link renders as literal
  /// text there, which is exactly the bad paste this option prevents.
  it("emits Slack mrkdwn links when asked", () => {
    const out = formatNudge([approved], { slack: true });
    expect(out).toContain("<https://github.com/octocat/hello-world/pull/42|octocat/hello-world#42>");
    expect(out).not.toContain("](");
  });

  it("uses Slack bold for group headers in Slack mode", () => {
    const out = formatNudge([approved, checking], { grouped: true, slack: true });
    expect(out).toContain("*octocat/hello-world*");
    expect(out).not.toContain("**octocat/hello-world**");
  });

  it("combines slack and annotate and grouped in one pass", () => {
    const out = formatNudge([approved, broken], { grouped: true, annotate: true, slack: true });
    expect(out).toBe(
      [
        "*octocat/hello-world*",
        "- <https://github.com/octocat/hello-world/pull/42|#42> Add retry to the fetch client (green, approved)",
        "- <https://github.com/octocat/hello-world/pull/43|#43> Fix flaky timezone test (CI failing)",
      ].join("\n"),
    );
  });

  it("returns an empty string for no PRs", () => {
    expect(formatNudge([], {})).toBe("");
  });

  it("returns an empty string for no PRs even with every option on", () => {
    expect(formatNudge([], { grouped: true, annotate: true, slack: true })).toBe("");
  });
});
