import { describe, expect, it } from "vitest";
import { buildForImage } from "./buildJoin";
import type { DockerBuild, DockerImage } from "@/types/pr";

const build = (over: Partial<DockerBuild> = {}): DockerBuild => ({
  reference: "ref1",
  name: "docker/api",
  status: "completed",
  started: "2026-08-27T20:00:00Z",
  duration_secs: 12.5,
  total_steps: 14,
  cached_steps: 8,
  context: "/code/api",
  revision: "eb066adcec2cb9a6d85eb36050103552bede11ba",
  ...over,
});

const image = (over: Partial<DockerImage> = {}): DockerImage => ({
  id: "img1",
  repository: "registry/api",
  // Images in this project are tagged with the ABBREVIATED commit,
  // which is the whole basis of the join.
  tags: ["eb066adc"],
  created: "2026-08-27T20:00:00Z",
  size_bytes: 1000,
  origin: null,
  in_use: false,
  superseded: false,
  ...over,
});

describe("buildForImage", () => {
  /// Verified against real records: image tags ARE the build revisions
  /// on this project, so no new field was needed.
  it("matches an abbreviated tag against the full revision", () => {
    expect(buildForImage(image(), [build()])?.reference).toBe("ref1");
  });

  it("prefers the resolved origin commit over a raw tag", () => {
    const img = image({
      tags: ["latest"],
      origin: {
        repo_path: "/code/api",
        context: null,
        commit: "eb066adcec2cb9a6d85eb36050103552bede11ba",
        subject: "s",
        merged: true,
        source: "tag_resolution",
      },
    });
    expect(buildForImage(img, [build()])?.reference).toBe("ref1");
  });

  /// An image rebuilt from the same commit should report the build that
  /// produced what is on disk NOW, not the first one ever run.
  it("takes the newest build when a commit was built more than once", () => {
    const older = build({ reference: "old", started: "2026-08-01T00:00:00Z" });
    const newer = build({ reference: "new", started: "2026-08-27T00:00:00Z" });
    expect(buildForImage(image(), [older, newer])?.reference).toBe("new");
  });

  /// Ordinary, not an error: a project tagging by version rather than
  /// by commit matches nothing, and the row simply shows no build data.
  it("returns null when nothing matches", () => {
    expect(buildForImage(image({ tags: ["v1.2.3"] }), [build()])).toBeNull();
  });

  /// A short tag must never match by luck. `v1` as a prefix of a SHA is
  /// not a commit reference, and claiming a build for an unrelated
  /// image would attach the wrong duration to the wrong thing.
  it("ignores a tag too short to be a commit", () => {
    const b = build({ revision: "abc1234567890abcdef" });
    expect(buildForImage(image({ tags: ["abc"] }), [b])).toBeNull();
  });

  it("ignores builds with no recorded revision", () => {
    expect(buildForImage(image(), [build({ revision: null })])).toBeNull();
  });
});
