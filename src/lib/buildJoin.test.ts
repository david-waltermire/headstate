import { describe, expect, it } from "vitest";
import { buildForImage, recentCacheHealth } from "./buildJoin";
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

/// The number the Builds page existed to show, kept when the page was
/// retired (#326). A cold build is not a problem in itself; a target
/// that USED to be warm and is not any more means something invalidated
/// the cache.
describe("recentCacheHealth", () => {
  const b = (cached: number, total: number, started: string) =>
    build({ cached_steps: cached, total_steps: total, started });

  it("reports the share of steps served from cache", () => {
    const h = recentCacheHealth([b(8, 10, "2026-08-01T00:00:00Z")]);
    expect(h).toEqual({ percent: 80, count: 1 });
  });

  /// Weighted by STEPS, not a mean of percentages. A 2-step build at 0%
  /// and a 40-step build at 90% is not 45% cached, and the unweighted
  /// form lets one trivial target swing the whole number.
  it("weights by steps rather than averaging percentages", () => {
    const h = recentCacheHealth([
      b(0, 2, "2026-08-01T00:00:00Z"),
      b(36, 40, "2026-08-02T00:00:00Z"),
    ]);
    // 36 of 42 steps, not the 45% an unweighted mean would give.
    expect(h?.percent).toBe(85);
  });

  /// Averaging six months of history hides exactly the change worth
  /// noticing.
  it("looks only at the most recent builds", () => {
    const old = Array.from({ length: 12 }, (_, i) =>
      b(10, 10, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const h = recentCacheHealth([...old, b(0, 10, "2026-08-01T00:00:00Z")], 2);
    expect(h?.count).toBe(2);
    // The recent cold build dominates rather than being diluted.
    expect(h?.percent).toBeLessThan(100);
  });

  it("ignores builds with no steps rather than dividing by zero", () => {
    expect(recentCacheHealth([b(0, 0, "2026-08-01T00:00:00Z")])).toBeNull();
  });

  /// A machine that has never built anything has no health to report,
  /// and the row omits it rather than showing a confident zero.
  it("returns nothing when there are no builds", () => {
    expect(recentCacheHealth([])).toBeNull();
  });
});
