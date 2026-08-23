import type { PullRequest } from "@/types/pr";
import { awaitingReview, needsAttention, needsMyReview } from "./derive";

/// Split everything the user can see into "the ball is in my court" and
/// "the ball is in someone else's".
///
/// Every predicate here already existed, exposed as flat chips across
/// TWO SEPARATE VIEWS -- so no single screen answered the question a
/// light user actually opens the app with. `App` already holds both
/// lists in memory, so this costs nothing: no fetch, no new field.
///
/// The two courts are not complements. A queued pull request and a draft
/// are in NEITHER: the machine has the first, and the second is
/// unfinished by choice. Forcing every row into one side or the other
/// would put "waiting on nobody" under a heading that says someone is
/// being waited on.
export function splitByCourt(
  authored: PullRequest[],
  reviewing: PullRequest[],
): { mine: PullRequest[]; theirs: PullRequest[] } {
  const mine: PullRequest[] = [];
  const theirs: PullRequest[] = [];
  const seen = new Set<string>();

  const push = (into: PullRequest[], pr: PullRequest) => {
    // The two lists are fetched separately. GitHub cannot request a
    // review from an author, but nothing here should double-count if
    // that ever changes.
    const key = `${pr.repo}#${pr.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    into.push(pr);
  };

  for (const pr of authored) {
    // Deliberately BEFORE the draft check: a draft with a red build is
    // still mine to fix. I broke it, draft or not.
    if (needsAttention(pr) || pr.review === "changes_requested") {
      push(mine, pr);
    } else if (awaitingReview(pr)) {
      push(theirs, pr);
    }
  }

  for (const pr of reviewing) {
    // Only what is MINE as a reviewer. Someone else's failing build is
    // not mine to fix -- the same distinction `needsMyReview` already
    // draws against `needsAttention`, and claiming it here would put
    // other people's broken work in my court.
    if (needsMyReview(pr)) push(mine, pr);
    else push(theirs, pr);
  }

  return { mine, theirs };
}
