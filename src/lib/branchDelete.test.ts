import { describe, expect, it } from "vitest";
import type { Branch } from "@/types/pr";
import { scopeLabel, scopesFor, targetsFor } from "./branchDelete";

const b = (over: Partial<Branch> = {}): Branch => ({
  name: "feature",
  location: "local",
  upstream: null,
  ahead: 0,
  behind: 0,
  committed: "2026-09-01T00:00:00Z",
  author: "octocat",
  tip: "abc1234",
  deletable: { kind: "merged", how: "squash" },
  ...over,
});

const tracked = (name: string) =>
  b({ name, location: "tracked", upstream: `origin/${name}` });
const remoteOnly = (name: string) => b({ name: `origin/${name}`, location: "remote" });

describe("scopesFor", () => {
  it("offers only local when nothing selected has a remote side", () => {
    expect(scopesFor([b({ name: "x" })])).toEqual(["local"]);
  });

  it("offers only remote for a remote-only selection", () => {
    expect(scopesFor([remoteOnly("x")])).toEqual(["remote"]);
  });

  /// The #473 case: a tracked branch exists in both places, so all
  /// three scopes are real choices.
  it("offers both for a tracked branch", () => {
    expect(scopesFor([tracked("x")])).toEqual(["local", "remote", "both"]);
  });

  /// A tracked branch with no upstream has no remote side to delete,
  /// whatever its location says.
  it("does not offer a remote scope for a tracked branch with no upstream", () => {
    const orphan = b({ name: "x", location: "tracked", upstream: null });
    expect(scopesFor([orphan])).toEqual(["local"]);
  });

  it("offers both scopes for a mixed selection, without offering both-at-once", () => {
    expect(scopesFor([b({ name: "x" }), remoteOnly("y")])).toEqual(["local", "remote"]);
  });
});

describe("targetsFor", () => {
  /// THE bug. Deleting a tracked branch locally must not silently
  /// leave the remote branch alive.
  it("sends a tracked branch to both calls when the scope is both", () => {
    expect(targetsFor([tracked("shipped")], "both")).toEqual({
      local: ["shipped"],
      remote: ["origin/shipped"],
    });
  });

  /// The remote call needs the UPSTREAM name, not the local one.
  /// Passing "shipped" where "origin/shipped" is expected deletes the
  /// wrong thing or nothing at all.
  it("uses the upstream name for the remote half of a tracked branch", () => {
    expect(targetsFor([tracked("shipped")], "remote")).toEqual({
      local: [],
      remote: ["origin/shipped"],
    });
  });

  it("passes a remote-only branch through whole", () => {
    expect(targetsFor([remoteOnly("gone")], "remote")).toEqual({
      local: [],
      remote: ["origin/gone"],
    });
  });

  it("never sends a remote-only branch to the local call", () => {
    expect(targetsFor([remoteOnly("gone")], "both").local).toEqual([]);
  });

  it("never sends a local-only branch to the remote call", () => {
    expect(targetsFor([b({ name: "x" })], "both").remote).toEqual([]);
  });

  it("splits a mixed selection correctly", () => {
    const sel = [b({ name: "loc" }), tracked("tr"), remoteOnly("rem")];
    expect(targetsFor(sel, "both")).toEqual({
      local: ["loc", "tr"],
      remote: ["origin/tr", "origin/rem"],
    });
  });
});

describe("scopeLabel", () => {
  /// Remote deletion pushes to shared state that no reflog can undo.
  /// With one button instead of two, the words carry that warning.
  it("says remote deletion is on the remote", () => {
    const t = { local: [], remote: ["origin/a"] };
    expect(scopeLabel("remote", t)).toMatch(/on the remote/);
  });

  it("counts what will actually be deleted", () => {
    expect(scopeLabel("local", { local: ["a", "b"], remote: [] })).toMatch(/2 branches/);
    expect(scopeLabel("local", { local: ["a"], remote: [] })).toMatch(/1 branch\b/);
  });
});
