import type { CiState, Label, MergeState, PullRequest, ReviewState } from "../types/pr";

/// Synthetic data only -- this is a public repo. Every repo/author here is
/// in the `octocat` GitHub demo org (see `scripts/check-privacy.sh`'s
/// allow-list). These fixtures back every later frontend test, so they
/// deliberately cover a spread of CI/merge/review states rather than just
/// the happy path.
export const PR_FIXTURES: PullRequest[] = [
  {
    number: 42,
    title: "Add retry to the fetch client",
    url: "https://github.com/octocat/hello-world/pull/42",
    repo: "octocat/hello-world",
    author: "octocat",
    is_draft: false,
    head_ref: "feature/retry-client",
    base_ref: "main",
    created_at: "2026-08-18T10:00:00Z",
    updated_at: "2026-08-18T12:00:00Z",
    ci: "success",
    merge: "mergeable",
    merge_status: "clean",
    review: "approved",
    in_merge_queue: false,
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comment_count: 2,
    unresolved_threads: 0,
  },
  {
    number: 43,
    title: "Fix flaky timezone test",
    url: "https://github.com/octocat/hello-world/pull/43",
    repo: "octocat/hello-world",
    author: "octocat",
    is_draft: true,
    head_ref: "fix/flaky-test",
    base_ref: "main",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:30:00Z",
    ci: "failure",
    merge: "conflicted",
    merge_status: "dirty",
    review: "changes_requested",
    in_merge_queue: false,
    labels: [{ name: "bug", color: "d73a4a" }],
    comment_count: 5,
    unresolved_threads: 2,
  },
  {
    number: 7,
    title: "Bump the parser dependency",
    url: "https://github.com/octocat/spoon-knife/pull/7",
    repo: "octocat/spoon-knife",
    author: "octocat",
    is_draft: false,
    head_ref: "stack/part-2",
    base_ref: "stack/part-1",
    created_at: "2026-08-16T09:00:00Z",
    updated_at: "2026-08-16T09:00:00Z",
    ci: "none",
    merge: "checking",
    merge_status: "unstable",
    review: "none",
    in_merge_queue: true,
    labels: [{ name: "dependencies", color: "0366d6" }],
    comment_count: 0,
    unresolved_threads: 0,
  },
];

/// Builds a fixture with a specific `ci`/`merge`/`review` combination,
/// layered on `PR_FIXTURES[0]`. Later tests (filters, priority derivation)
/// need PRs in states `PR_FIXTURES` doesn't happen to cover -- typing the
/// three arguments against the wire-format unions, rather than `string`,
/// makes an invalid combination a compile error instead of a typo that
/// silently matches nothing at runtime (see the casing trap in
/// `src/types/pr.ts`).
export function prWithState(
  ci: CiState,
  merge: MergeState,
  review: ReviewState,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return { ...PR_FIXTURES[0], ci, merge, review, ...overrides };
}

/// A synthetic label using the same hex-without-`#` convention as GitHub's
/// API (see `Label.color` in `src/types/pr.ts`).
export function makeLabel(name: string, color: string): Label {
  return { name, color };
}
