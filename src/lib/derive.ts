import type { PullRequest, Stats } from "../types/pr";

export const STALE_DAYS = 3;

export interface Filters {
  /// Free-text match over title, repo, and PR number. Case-insensitive.
  query?: string;
  /// Only PRs with review conversations still open.
  unresolvedOnly?: boolean;
  /// Only PRs awaiting MY review verdict. Review-view only.
  needsMyReviewOnly?: boolean;
  repo?: string;
  readyOnly?: boolean;
  draftsOnly?: boolean;
  ci?: PullRequest["ci"];
  review?: PullRequest["review"];
  includeLabels?: string[];
  excludeLabels?: string[];
  needsAttentionOnly?: boolean;
  staleOnly?: boolean;
  inMergeQueueOnly?: boolean;
  awaitingReviewOnly?: boolean;
  readyToQueueOnly?: boolean;
  sort?: "newest" | "oldest" | "recently-updated" | "least-recently-updated";
}

/// Blocked on the author and nobody else: a real conflict, or failing CI.
/// `checking` is deliberately excluded -- GitHub reports UNKNOWN
/// mergeability while it computes, and treating that as a conflict would
/// fire a false warning on every push. This mirrors the equivalent rule in
/// the Rust mapping layer -- keep the two consistent.
export function needsAttention(pr: PullRequest): boolean {
  return pr.merge === "conflicted" || pr.ci === "failure";
}

/// Waiting on a reviewer and nobody else.
///
/// `ci === "none"` counts, for the same reason `readyForReview` accepts
/// it: a repository with no checks configured has nothing to wait for.
/// Requiring `success` silently dropped those pull requests out of BOTH
/// triage chips -- they were not blocked on the author and not counted
/// as awaiting review either, so a repo showing 13 in the sidebar
/// offered chips adding to 7 with no explanation for the rest.
///
/// `pending` still does not count, also matching `readyForReview`: a
/// run in progress may go red, and "awaiting review" would be the wrong
/// thing to tell someone about a pull request that is about to need
/// their attention instead.
export function awaitingReview(pr: PullRequest): boolean {
  return (
    !pr.is_draft &&
    // A conflicted pull request is blocked on the AUTHOR, not on a
    // reviewer -- the diff a reviewer would read is not the diff that
    // will land. Without this, a conflicted PR with green CI counted in
    // BOTH chips at once, which is how "4 need attention · 3 awaiting
    // review" could describe overlapping sets and reconcile with
    // nothing. `readyForReview` already excludes conflicts for exactly
    // this reason.
    pr.merge !== "conflicted" &&
    (pr.ci === "success" || pr.ci === "none") &&
    (pr.review === "none" || pr.review === "review_required")
  );
}

export function readyToQueue(pr: PullRequest): boolean {
  return !pr.is_draft && pr.ci === "success" && pr.review === "approved" && !pr.in_merge_queue;
}

/// Ready to be reviewed right now.
///
/// The review queue's counterpart to `needsAttention`: what a reviewer
/// can pick up without wasting anyone's time.
///
/// Deliberately NOT `awaitingReview`, which asks whether the AUTHOR is
/// waiting on a review. This asks whether the review is worth GIVING
/// yet, which is a different question with a different answer on a
/// conflicted or queued pull request.
///
/// `ci === "none"` counts as ready: a repository with no checks
/// configured has nothing to wait for, and excluding it would empty
/// this section entirely for anyone not running CI. But `pending` does
/// NOT -- "ready" means the checks passed, not that they have not failed
/// yet, and a run in progress may still go red.
///
/// Conflicts exclude it because the diff a reviewer reads is not the
/// diff that will land. An existing review verdict excludes it because
/// this section is what is still WAITING.
export function readyForReview(pr: PullRequest): boolean {
  return (
    !pr.is_draft &&
    (pr.ci === "success" || pr.ci === "none") &&
    pr.merge !== "conflicted" &&
    pr.review !== "approved" &&
    pr.review !== "changes_requested" &&
    !pr.in_merge_queue
  );
}

/// Needs MY attention as a reviewer.
///
/// Deliberately NOT `needsAttention`, which means blocked on you as the
/// AUTHOR: someone else's failing CI or merge conflict is not yours to
/// fix, and treating it as attention-worthy would badge the tray with
/// other people's broken builds.
///
/// What is actually yours: a review was requested, you have not given a
/// verdict yet, and it is not a draft. A PR you have already reviewed
/// stays in the list -- the author may still be responding -- but stops
/// demanding anything.
export function needsMyReview(pr: PullRequest): boolean {
  return !pr.is_draft && pr.review !== "approved" && pr.review !== "changes_requested";
}

/// A reviewer formally asked for changes.
///
/// Renamed from `blockedByComments`, which was a misnomer: this is a
/// review VERDICT, not comment resolution. The two are genuinely
/// different -- a PR can have six open conversations and no verdict, or a
/// changes-requested verdict with every thread resolved. Unresolved
/// conversations are counted separately in `pr.unresolved_threads`.
export function changesRequested(pr: PullRequest): boolean {
  return pr.review === "changes_requested";
}

/// Review conversations still open on the current code.
///
/// Not a claim that the PR is BLOCKED: whether a repo requires resolution
/// before merging is only readable with admin access on that repository,
/// so the UI reports the count and lets the reader draw the conclusion.
export function hasUnresolvedThreads(pr: PullRequest): boolean {
  return pr.unresolved_threads > 0;
}

/// Green, approved, and untouched for `days`+: the single most
/// nudge-worthy state, and the one no other filter surfaces.
export function isStale(pr: PullRequest, now: Date, days = STALE_DAYS): boolean {
  if (!readyToQueue(pr)) return false;
  const age = now.getTime() - new Date(pr.updated_at).getTime();
  return age > days * 86_400_000;
}

const hasLabel = (pr: PullRequest, names: string[]) =>
  pr.labels.some((l) => names.includes(l.name));

/// Whether any narrowing filter is active.
///
/// `repo` is excluded on purpose: it is sidebar navigation rather than a
/// filter chip (the store's `reset` treats it the same way), so a repo page
/// with no PRs should still explain what the app tracks rather than
/// blaming filters the user did not set.
export function hasActiveFilters(f: Filters): boolean {
  return Boolean(
    f.query ||
      f.unresolvedOnly ||
      f.needsMyReviewOnly ||
      f.readyOnly ||
      f.draftsOnly ||
      f.ci ||
      f.review ||
      f.includeLabels?.length ||
      f.excludeLabels?.length ||
      f.needsAttentionOnly ||
      f.staleOnly ||
      f.inMergeQueueOnly ||
      f.awaitingReviewOnly ||
      f.readyToQueueOnly,
  );
}

/// Does a PR match a free-text query?
///
/// Title, repository, and number, because those are what a person
/// remembers about a PR they are looking for. A bare "#123" or "123" both
/// match the number.
function matchesQuery(pr: PullRequest, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  const bare = needle.startsWith("#") ? needle.slice(1) : needle;
  return (
    pr.title.toLowerCase().includes(needle) ||
    pr.repo.toLowerCase().includes(needle) ||
    String(pr.number) === bare
  );
}

export function applyFilters(
  prs: PullRequest[],
  f: Filters,
  now: Date = new Date(),
): PullRequest[] {
  return prs.filter((pr) => {
    if (f.repo && pr.repo !== f.repo) return false;
    if (f.query && !matchesQuery(pr, f.query)) return false;
    if (f.unresolvedOnly && !hasUnresolvedThreads(pr)) return false;
    if (f.needsMyReviewOnly && !needsMyReview(pr)) return false;
    if (f.readyOnly && pr.is_draft) return false;
    if (f.draftsOnly && !pr.is_draft) return false;
    if (f.ci && pr.ci !== f.ci) return false;
    if (f.review && pr.review !== f.review) return false;
    if (f.includeLabels?.length && !hasLabel(pr, f.includeLabels)) return false;
    if (f.excludeLabels?.length && hasLabel(pr, f.excludeLabels)) return false;
    if (f.needsAttentionOnly && !needsAttention(pr)) return false;
    if (f.inMergeQueueOnly && !pr.in_merge_queue) return false;
    // Delegate to the same predicates deriveStats counts with, rather than
    // re-expressing "review is none OR review_required" or "approved AND
    // not already queued" as scalar equality filters -- a scalar `review`
    // field can only match one value at a time and has no way to express
    // "not in queue," so re-encoding these compound conditions as
    // combinations of existing scalar fields silently drops or admits PRs
    // the count did not (Task 17 fix round 1: cards 5 and 6 opened a list
    // that disagreed with their own numbers).
    if (f.awaitingReviewOnly && !awaitingReview(pr)) return false;
    if (f.readyToQueueOnly && !readyToQueue(pr)) return false;
    if (f.staleOnly && !isStale(pr, now)) return false;
    return true;
  });
}

/// PrList used to hardcode newest-first internally; that hid the ordering
/// from callers who need a different one (e.g. a future "least recently
/// updated" nudge view) and made it untestable independent of rendering.
/// Pure and non-mutating -- callers pass the result straight to PrList.
export function sortPrs(prs: PullRequest[], sort: Filters["sort"] = "newest"): PullRequest[] {
  const byCreated = (a: PullRequest, b: PullRequest) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  const byUpdated = (a: PullRequest, b: PullRequest) =>
    new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();

  switch (sort) {
    case "oldest":
      return [...prs].sort(byCreated);
    case "recently-updated":
      return [...prs].sort((a, b) => -byUpdated(a, b));
    case "least-recently-updated":
      return [...prs].sort(byUpdated);
    case "newest":
    default:
      return [...prs].sort((a, b) => -byCreated(a, b));
  }
}

/// Five of the seven `Stats` fields come from the PR list already in
/// memory, at zero API cost -- the Rust `get_stats` command always returns
/// zero for these because they are not derivable from a single GitHub
/// search. Only `merged_week`/`merged_month` are real and stay Rust-side.
/// Task 17's dashboard must render this, not `get_stats` directly.
export function deriveStats(
  prs: PullRequest[],
): Omit<Stats, "merged_week" | "merged_month"> {
  return {
    in_merge_queue: prs.filter((p) => p.in_merge_queue).length,
    needs_attention: prs.filter(needsAttention).length,
    awaiting_review: prs.filter(awaitingReview).length,
    ready_to_queue: prs.filter(readyToQueue).length,
    blocked_by_comments: prs.filter(changesRequested).length,
  };
}
