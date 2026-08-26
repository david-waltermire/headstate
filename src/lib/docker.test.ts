import { describe, expect, it } from "vitest";
import { formatDockerSize, imageState, isStale, isSuperseded } from "@/lib/docker";
import type { DockerImage } from "@/types/pr";

const img = (over: Partial<DockerImage> = {}): DockerImage => ({
  id: "abc123def456",
  repository: "registry/app",
  tags: ["13901886"],
  created: "2026-08-21T21:39:15-04:00",
  size_bytes: 1_330_000_000,
  origin: {
    repo_path: "/code/app",
    context: null,
    commit: "13901886",
    subject: "add retry to the client",
    merged: true,
    source: "tag_resolution",
  },
  in_use: false,
  superseded: true,
  ...over,
});

describe("isStale", () => {
  // Deliberately narrower than "superseded": an image on a live branch
  // may still be wanted, and only the provably-dead set may be bulk
  // removed. Same rule the worktrees view applies to Safety::Safe.
  it("requires superseded, merged, and unused together", () => {
    expect(isStale(img())).toBe(true);
    expect(isStale(img({ superseded: false }))).toBe(false);
    expect(isStale(img({ in_use: true }))).toBe(false);
    expect(
      isStale(img({ origin: { ...img().origin!, merged: false } })),
    ).toBe(false);
  });

  // We cannot prove the branch landed, so it does not enter the bulk
  // set -- the same reasoning the worktree classifier applies to
  // Safety::Unknown.
  it("does not treat unknown provenance as stale", () => {
    expect(isStale(img({ origin: null }))).toBe(false);
  });
});

describe("isSuperseded", () => {
  /// The gap that motivated this: on a real machine most superseded
  /// images have no origin attribution at all, so `isStale` -- which
  /// requires a MERGED branch -- excluded them from the bulk set and
  /// the button under-counted badly.
  it("includes superseded images that isStale excludes", () => {
    const unattributed = img({ origin: null });
    const openBranch = img({ origin: { ...img().origin!, merged: false } });

    expect(isStale(unattributed)).toBe(false);
    expect(isSuperseded(unattributed)).toBe(true);

    expect(isStale(openBranch)).toBe(false);
    expect(isSuperseded(openBranch)).toBe(true);
  });

  it("still requires the image to be superseded", () => {
    expect(isSuperseded(img({ superseded: false }))).toBe(false);
  });

  /// `null` means "we could not ask". Treating an unknown as unused is
  /// how a bulk delete takes out something a container is running, so
  /// it is excluded from BOTH sets.
  it("never includes an image whose use is unknown or in use", () => {
    expect(isSuperseded(img({ in_use: null }))).toBe(false);
    expect(isSuperseded(img({ in_use: true }))).toBe(false);
  });

  /// A superset, not an alternative: everything safe by the narrow rule
  /// must remain included by the wide one.
  it("is a superset of isStale", () => {
    const cases = [
      img(),
      img({ origin: null }),
      img({ origin: { ...img().origin!, merged: false } }),
      img({ in_use: null }),
      img({ in_use: true }),
      img({ superseded: false }),
    ];
    for (const c of cases) {
      if (isStale(c)) expect(isSuperseded(c)).toBe(true);
    }
  });
});

describe("imageState", () => {
  // In use wins over everything: it is the reason the row cannot be
  // acted on at all, so it must be what the row says.
  it("reports in-use ahead of any other standing", () => {
    expect(imageState(img({ in_use: true, superseded: true }))).toMatch(/in use/i);
  });

  it("distinguishes a merged branch from a live one", () => {
    expect(imageState(img())).toMatch(/merged/i);
    expect(
      imageState(img({ origin: { ...img().origin!, merged: false } })),
    ).toMatch(/still open/i);
  });

  it("calls the newest image current", () => {
    expect(imageState(img({ superseded: false }))).toBe("current");
  });

  // Superseded with no provenance says only what is known, rather than
  // implying a verdict about the branch.
  it("says only what is known when provenance is missing", () => {
    const s = imageState(img({ origin: null }));
    expect(s).toBe("superseded");
    expect(s).not.toMatch(/merged|open/i);
  });
});

describe("formatDockerSize", () => {
  // Docker reports SI units. Rendering 4,654,000,000 as "4.3 GB" -- what
  // binary units give -- would look like a bug to anyone comparing the
  // page against `docker system df`, which prints 4.654GB.
  it("matches what docker itself prints", () => {
    expect(formatDockerSize(4_654_000_000)).toBe("4.65 GB");
    expect(formatDockerSize(1_330_000_000)).toBe("1.33 GB");
    expect(formatDockerSize(411_000_000)).toBe("411 MB");
  });

  // An unmeasured size is not a zero-byte one.
  it("renders an em dash for an absent size", () => {
    expect(formatDockerSize(null)).toBe("—");
  });
});
