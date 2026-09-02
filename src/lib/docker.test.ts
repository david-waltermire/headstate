import { describe, expect, it } from "vitest";
import {
  formatDockerSize,
  imageName,
  imageState,
  isStale,
  isSuperseded,
  shortRepository,
} from "@/lib/docker";
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
  has_siblings: true,
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

describe("imageName", () => {
  /// The reported bug: 31 rows all reading `latest`. Docker keeps
  /// Repository and Tag apart, so the tag alone is not an identity.
  it("names an image by repository AND tag, not the tag alone", () => {
    expect(imageName(img({ repository: "registry/app", tags: ["latest"] }))).toBe(
      "registry/app:latest",
    );
  });

  it("tells apart two images that share the tag `latest`", () => {
    const a = imageName(img({ repository: "registry/api", tags: ["latest"] }));
    const b = imageName(img({ repository: "registry/web", tags: ["latest"] }));
    expect(a).not.toBe(b);
  });

  /// ~50 characters identical on every ECR row, which pushes the part
  /// that differs out of a truncated cell.
  it("elides a registry host", () => {
    expect(
      imageName(
        img({
          repository: "469164977587.dkr.ecr.us-east-1.amazonaws.com/enclave-api",
          tags: ["latest"],
        }),
      ),
    ).toBe("enclave-api:latest");
  });

  /// A bare `postgres` or an org path has no host to drop.
  it("keeps a repository that has no registry host", () => {
    expect(shortRepository("postgres")).toBe("postgres");
    expect(shortRepository("tufin/oasdiff")).toBe("tufin/oasdiff");
    expect(shortRepository("localhost:5000/app")).toBe("app");
  });

  it("falls back to the id when there is no repository", () => {
    expect(imageName(img({ repository: "<none>", tags: [] }))).toBe("abc123def456");
    expect(imageName(img({ repository: "", tags: [] }))).toBe("abc123def456");
  });

  it("uses the id for an untagged image", () => {
    expect(imageName(img({ repository: "registry/app", tags: [] }))).toBe(
      "registry/app@abc123def456",
    );
  });
});

describe("imageState with siblings", () => {
  /// `current` on a row with nothing to be current AGAINST is true and
  /// useless -- a page of identical badges reads as a claim.
  it("says nothing for the only image in its repository", () => {
    expect(imageState(img({ superseded: false, has_siblings: false }))).toBe("");
  });

  it("still says current when there is a sibling to be newer than", () => {
    expect(imageState(img({ superseded: false, has_siblings: true }))).toBe("current");
  });

  /// Superseded is a real finding either way.
  it("reports superseded regardless of siblings", () => {
    expect(
      imageState(img({ superseded: true, has_siblings: true, origin: null })),
    ).toBe("superseded");
  });
});
