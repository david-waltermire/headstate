import { describe, expect, it } from "vitest";
import { cleanupBytes, cleanupManifest } from "./cleanup";
import type { DockerImage, PullRequest, Worktree } from "@/types/pr";
import { PR_FIXTURES } from "@/fixtures/prs";

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  path: "/code/app/.worktrees/feature",
  branch: "feature",
  head: "abc123",
  size_bytes: 1_000_000,
  safety: { kind: "safe" },
  is_main: false,
  merged_at: "2026-08-01",
  upstream: null,
  last_commit: null,
  ...over,
} as Worktree);

const img = (over: Partial<DockerImage> = {}): DockerImage => ({
  id: "img1",
  repository: "registry/app",
  tags: ["abc123"],
  created: "2026-08-01T00:00:00Z",
  size_bytes: 500_000,
  origin: {
    repo_path: "/code/app/.worktrees/feature",
    context: "/code/app/.worktrees/feature",
    commit: "abc123",
    subject: "add retry",
    merged: true,
    source: "tag_resolution",
  },
  in_use: false,
  superseded: true,
  ...over,
} as DockerImage);

describe("cleanupManifest", () => {
  it("gathers the worktree and its images into one entry", () => {
    const items = cleanupManifest([wt()], [img()]);
    expect(items).toHaveLength(1);
    expect(items[0].branch).toBe("feature");
    expect(items[0].images).toHaveLength(1);
    expect(items[0].bytes).toBe(1_500_000);
  });

  /// `Safety` is the app's own vetted answer to "is this safe to
  /// remove". Every reason NOT to remove something is already
  /// enumerated there, and re-deriving it here would let this manifest
  /// disagree with the Worktrees page about the same checkout.
  it.each([
    ["dirty", { kind: "dirty", detail: 3 }],
    ["unpushed", { kind: "unpushed", detail: 2 }],
    ["never pushed", { kind: "never_pushed" }],
    ["unmerged", { kind: "unmerged" }],
    ["the main checkout", { kind: "main_checkout" }],
  ])("never offers a %s worktree", (_label, safety) => {
    expect(cleanupManifest([wt({ safety: safety as never })], [])).toHaveLength(0);
  });

  /// A safe worktree has merged, so an OPEN pull request on the same
  /// branch means the branch is live again -- that is not cleanup.
  it("skips a branch that has an open pull request again", () => {
    const open: PullRequest = { ...PR_FIXTURES[0], head_ref: "feature" };
    expect(cleanupManifest([wt()], [], [open])).toHaveLength(0);
  });

  /// `in_use === null` means "we could not ask". Treating an unknown as
  /// unused is how a bulk delete takes out something a container needs.
  it("never includes an image whose use is unknown or in use", () => {
    expect(cleanupManifest([wt()], [img({ in_use: null })])[0].images).toHaveLength(0);
    expect(cleanupManifest([wt()], [img({ in_use: true })])[0].images).toHaveLength(0);
  });

  it("does not claim an image built somewhere else", () => {
    const elsewhere = img({
      origin: { ...img().origin!, context: "/code/other", repo_path: "/code/other" },
    });
    expect(cleanupManifest([wt()], [elsewhere])[0].images).toHaveLength(0);
  });

  /// An image with no origin cannot be attributed to this worktree, and
  /// guessing would delete somebody else's build.
  it("does not claim an unattributed image", () => {
    expect(cleanupManifest([wt()], [img({ origin: null })])[0].images).toHaveLength(0);
  });

  it("offers a worktree with no images at all", () => {
    const items = cleanupManifest([wt()], []);
    expect(items).toHaveLength(1);
    expect(items[0].bytes).toBe(1_000_000);
  });

  it("sums the whole manifest", () => {
    const items = cleanupManifest(
      [wt(), wt({ path: "/code/app/.worktrees/other", branch: "other" })],
      [img()],
    );
    expect(cleanupBytes(items)).toBe(2_500_000);
  });
});
