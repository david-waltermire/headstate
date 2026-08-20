import type { PullRequest } from "../types/pr";
import { awaitingReview, needsAttention, readyToQueue } from "./derive";

export interface NudgeOptions {
  grouped?: boolean;
  annotate?: boolean;
  slack?: boolean;
}

/// Grouping under repo headers is clearer across many repos and noisier for
/// a handful, so it auto-enables at this many distinct repos.
export const GROUP_THRESHOLD = 3;

/// Annotation text is chosen by delegating to the same predicates the rest
/// of the app classifies PRs with (`derive.ts`), never by re-deriving their
/// boolean logic inline. M4 shipped a Critical where a dashboard card's
/// count and the list it opened disagreed because the count used a compound
/// predicate and the filter rebuilt an equivalent one from scalar fields --
/// the two drifted. `needsAttention` is the single source of truth for
/// "this PR needs the author's attention"; once it says yes, the scalar
/// read of `pr.merge`/`pr.ci` below only picks *which* needs-attention
/// message to show, it does not redefine *whether* the bucket applies. If
/// `needsAttention`'s own logic changes, that flows through here for free.
///
/// "(draft)", "(in merge queue)", and "(CI running)" have no predicate to
/// delegate to -- they are direct single-field reads (`is_draft`,
/// `in_merge_queue`, `ci === "pending"`) with no compound condition to
/// drift out of sync with.
function annotation(pr: PullRequest): string {
  if (needsAttention(pr)) {
    return pr.ci === "failure" ? " (CI failing)" : " (needs rebase)";
  }
  if (pr.is_draft) return " (draft)";
  // #35: a green, approved PR already in the merge queue falls through
  // every other branch -- readyToQueue requires !in_merge_queue and
  // awaitingReview requires review to be none/review_required, neither of
  // which holds once a PR is queued -- so without this branch it rendered
  // identically to "nothing to report." This must come after the
  // needsAttention gate (a conflicted or red PR that's still sitting in
  // the queue is a problem worth naming first) and before
  // readyToQueue/awaitingReview (which can't be true for a queued PR
  // anyway, so ordering relative to them doesn't matter, but placing it
  // here documents that this is the queue-specific case of "no action
  // needed").
  if (pr.in_merge_queue) return " (in merge queue)";
  if (readyToQueue(pr)) return " (green, approved)";
  if (awaitingReview(pr)) return " (green, awaiting review)";
  if (pr.ci === "pending") return " (CI running)";
  return "";
}

function line(pr: PullRequest, opts: NudgeOptions, showRepo: boolean): string {
  const ref = showRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
  const note = opts.annotate ? annotation(pr) : "";
  // Slack renders mrkdwn, not markdown: a [text](url) link shows up as
  // literal text there, so the link syntax has to change with the target.
  return opts.slack
    ? `- <${pr.url}|${ref}> ${pr.title}${note}`
    : `- [${ref}] ${pr.title}${note} — ${pr.url}`;
}

export function formatNudge(prs: PullRequest[], opts: NudgeOptions): string {
  if (prs.length === 0) return "";

  const distinctRepos = new Set(prs.map((pr) => pr.repo)).size;
  // `grouped` explicitly set wins either way; otherwise grouping switches
  // on automatically once there are enough repos for a flat list to get
  // noisy. See the GROUP_THRESHOLD doc comment above.
  const grouped = opts.grouped ?? distinctRepos >= GROUP_THRESHOLD;

  if (!grouped) {
    return prs.map((pr) => line(pr, opts, true)).join("\n");
  }

  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  }

  // Slack bold is *single asterisks*, not markdown's **double**.
  const bold = opts.slack ? "*" : "**";
  return [...byRepo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, list]) =>
      [`${bold}${repo}${bold}`, ...list.map((pr) => line(pr, opts, false))].join("\n"),
    )
    .join("\n\n");
}
