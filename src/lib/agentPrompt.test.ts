import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "@/fixtures/prs";
import { type AgentContext, agentPrompt, toAgentContext } from "@/lib/agentPrompt";

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  repo: "octocat/hello-world",
  number: 42,
  title: "Add retry to the client",
  url: "https://github.com/octocat/hello-world/pull/42",
  head_ref: "feature/retry-client",
  base_ref: "main",
  merge_status: "clean",
  unresolved_threads: 0,
  checks: [],
  ...over,
});

describe("agentPrompt", () => {
  // The lead line is what an agent acts on, so it must name the task
  // rather than restate the state.
  it("leads with conflicts, which block everything else", () => {
    const out = agentPrompt(
      ctx({
        merge_status: "dirty",
        checks: [{ name: "build", state: "failure", url: "u" }],
        unresolved_threads: 3,
      }),
    );
    expect(out.split("\n")[0]).toMatch(/^Resolve the merge conflicts on octocat\/hello-world#42/);
  });

  it("leads with CI when there are no conflicts", () => {
    const out = agentPrompt(
      ctx({ checks: [{ name: "build", state: "failure", url: "u" }], unresolved_threads: 3 }),
    );
    expect(out.split("\n")[0]).toMatch(/^Fix the failing CI/);
  });

  it("leads with review feedback when CI is green", () => {
    expect(agentPrompt(ctx({ unresolved_threads: 2 })).split("\n")[0]).toMatch(
      /^Address the review feedback/,
    );
  });

  it("always names the branch pair, so the agent knows what to check out", () => {
    expect(agentPrompt(ctx())).toContain("(feature/retry-client → main)");
  });

  // skipped and pending are not failures. Treating anything non-success as
  // broken would send an agent chasing checks that never ran.
  it("lists only genuinely failed checks", () => {
    const out = agentPrompt(
      ctx({
        checks: [
          { name: "build", state: "failure", url: "https://ci/build" },
          { name: "lint", state: "error", url: "https://ci/lint" },
          { name: "skipped-job", state: "skipped", url: "https://ci/skip" },
          { name: "running", state: "pending", url: "https://ci/run" },
          { name: "tests", state: "success", url: "https://ci/tests" },
        ],
      }),
    );
    expect(out).toContain("build: https://ci/build");
    expect(out).toContain("lint: https://ci/lint");
    for (const absent of ["skipped-job", "running", "tests"]) {
      expect(out).not.toContain(absent);
    }
  });

  // A list row has no per-check detail. Silence would read as "CI is
  // fine", which is a lie the agent would act on.
  it("says checks were not loaded rather than implying CI is clean", () => {
    const out = agentPrompt(ctx({ checks: undefined }));
    expect(out).toMatch(/Failing checks: not loaded/);
  });

  it("stays silent about checks when they loaded and none failed", () => {
    expect(agentPrompt(ctx({ checks: [{ name: "build", state: "success", url: "u" }] }))).not.toMatch(
      /Failing checks/,
    );
  });

  it("mentions unresolved conversations only when there are some", () => {
    expect(agentPrompt(ctx({ unresolved_threads: 3 }))).toContain(
      "Unresolved review conversations: 3",
    );
    expect(agentPrompt(ctx())).not.toContain("Unresolved review");
  });
});

describe("toAgentContext", () => {
  // The absence of `checks` on a row is load-bearing -- it drives the
  // "not loaded" line -- so it must not be defaulted to [].
  it("preserves a list row's missing checks rather than defaulting them", () => {
    expect(toAgentContext(PR_FIXTURES[0]).checks).toBeUndefined();
  });

  it("carries a detail's checks through", () => {
    const detail = {
      ...PR_FIXTURES[0],
      checks: [{ name: "build", state: "failure", url: "u" }],
    } as unknown as Parameters<typeof toAgentContext>[0];
    expect(toAgentContext(detail).checks).toHaveLength(1);
  });
});

/// #426: the prompt named what was wrong and never said where to work.
describe("where the agent should work", () => {
  it("tells the agent to use a worktree, not the current checkout", () => {
    const out = agentPrompt(ctx());
    expect(out).toContain("git worktree add");
    expect(out).toMatch(/not the current checkout/i);
  });

  it("fetches the PR's branch before adding the worktree", () => {
    const out = agentPrompt(ctx({ head_ref: "feature/retry-client" }));
    const fetchAt = out.indexOf("git fetch origin feature/retry-client");
    const addAt = out.indexOf("git worktree add");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(fetchAt);
  });

  /// A branch name can contain slashes, which would nest the worktree
  /// somewhere the user did not expect. The PR number cannot.
  it("names the worktree from the number, so a slashed branch cannot nest it", () => {
    const out = agentPrompt(ctx({ number: 42, head_ref: "feature/deep/nested" }));
    expect(out).toContain("../pr-42");
    expect(out).not.toContain("../feature/deep/nested");
  });

  /// The instruction is last: it is what the agent does FIRST, and a
  /// reader scanning back finds it at the end.
  it("puts the setup after the problem description", () => {
    const out = agentPrompt(ctx({ merge_status: "dirty" }));
    expect(out.indexOf("merge conflicts")).toBeLessThan(out.indexOf("git worktree add"));
  });
});
