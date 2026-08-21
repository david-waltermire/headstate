import type { PrDetail, PullRequest } from "../types/pr";

/// The subset of a pull request needed to brief an agent.
///
/// Deliberately narrower than either `PullRequest` or `PrDetail`: both
/// satisfy it, so the kebab menu can compose from a list row and the
/// detail view can compose from its richer fetch, without two composers
/// that would drift the way M4's count-vs-list pair did.
export interface AgentContext {
  repo: string;
  number: number;
  title: string;
  url: string;
  head_ref: string;
  base_ref: string;
  merge_status: string;
  unresolved_threads: number;
  /// Only the detail view has per-check names and URLs. When absent the
  /// prompt says so rather than implying CI was clean.
  checks?: { name: string; state: string; url: string }[];
}

/// A check that failed. `state` is a raw GitHub value when unmodelled, so
/// this matches the two that mean failure rather than assuming anything
/// not "success" is broken -- `skipped` and `pending` are neither.
function failing(c: { state: string }): boolean {
  return c.state === "failure" || c.state === "error";
}

/// What this PR needs, as an instruction rather than a description.
///
/// The lead line is what an agent acts on, so it names the task instead
/// of restating the state: "Resolve the merge conflicts" beats "this PR
/// is DIRTY". Conflicts come first because nothing else can proceed
/// until they are resolved.
function lead(pr: AgentContext, failed: number): string {
  const ref = `${pr.repo}#${pr.number}`;
  if (pr.merge_status === "dirty") return `Resolve the merge conflicts on ${ref}`;
  if (failed > 0) return `Fix the failing CI on ${ref}`;
  if (pr.unresolved_threads > 0) return `Address the review feedback on ${ref}`;
  if (pr.merge_status === "behind") return `Update ${ref} with its base branch`;
  return `Review ${ref}`;
}

/// A prompt handing a pull request to a coding agent.
///
/// This is the loop the product is built around closing: an agent opens
/// the PR, Headstate surfaces that it broke, and this hands it back with
/// the context needed to fix it. No token, no mutation, no new
/// permission -- just the clipboard.
export function agentPrompt(pr: AgentContext): string {
  const failed = (pr.checks ?? []).filter(failing);
  const out = [`${lead(pr, failed.length)} (${pr.head_ref} → ${pr.base_ref}).`, ""];

  // No separate "Branch:" line -- the lead already names the pair, and a
  // prompt that repeats itself wastes the agent's attention on nothing.
  out.push(`Title: ${pr.title}`, `URL: ${pr.url}`);

  if (failed.length > 0) {
    out.push("", "Failing checks:");
    for (const c of failed) out.push(`  - ${c.name}: ${c.url}`);
  } else if (pr.checks === undefined) {
    // Say nothing rather than implying CI passed: the list row has a CI
    // rollup but not the per-check detail, and a silent omission would
    // read as "nothing failed".
    out.push("", "Failing checks: not loaded — open the PR for details.");
  }

  if (pr.merge_status === "dirty") out.push("", "This branch has merge conflicts with its base.");
  if (pr.unresolved_threads > 0) {
    out.push(
      "",
      `Unresolved review conversations: ${pr.unresolved_threads} (visible on the PR page).`,
    );
  }

  return out.join("\n");
}

/// Widen a list row or a detail into the shape `agentPrompt` needs.
///
/// A row has no `checks`, and that absence is meaningful -- see the
/// "not loaded" branch above -- so it is preserved rather than defaulted
/// to an empty array.
export function toAgentContext(pr: PullRequest | PrDetail): AgentContext {
  return {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    head_ref: pr.head_ref,
    base_ref: pr.base_ref,
    merge_status: pr.merge_status,
    unresolved_threads: pr.unresolved_threads,
    checks: "checks" in pr ? pr.checks : undefined,
  };
}
