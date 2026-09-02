import { ExternalLink } from "./ExternalLink";
import { ArrowLeft, Trash2, Bot, Check, CircleDot, CircleSlash, ExternalLink as ExternalLinkIcon, X } from "lucide-react";
import { toast } from "sonner";
import {
  useCommentOnPr,
  useDeleteHeadBranch,
  usePrDetail,
  useRerunChecks,
  useReviewPr,
  useViewer,
} from "../api/hooks";
import { useState } from "react";
import type { ReviewVerdictName } from "../api/tauri";
import { agentPrompt, toAgentContext } from "../lib/agentPrompt";
import { rerunnableRun } from "../lib/rerun";
import { Markdown } from "./Markdown";
import { copyText } from "../lib/clipboard";
import { CommentRow } from "./CommentRow";
import { ReviewThreads } from "./ReviewThreads";
import { Section } from "./Section";
import { PrActions } from "./PrActions";
import { ReviewBox } from "./ReviewBox";
import { QueryError, errorMessage } from "./QueryError";

/// One check, with its outcome and a link to the run.
function CheckRow({ name, state, url }: { name: string; state: string; url: string }) {
  const Icon =
    state === "success" ? Check : state === "failure" ? X : state === "pending" ? CircleDot : CircleSlash;
  const tone =
    state === "success"
      ? "text-[#3fb950]"
      : state === "failure"
        ? "text-[#f85149]"
        : state === "pending"
          ? "text-[#d29922]"
          : "text-[#8b949e]";

  const body = (
    <>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className={`shrink-0 text-xs ${tone}`}>{state}</span>
    </>
  );

  // No link when GitHub gives no URL, rather than an anchor that goes
  // nowhere.
  return url ? (
    <ExternalLink
      href={url}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[#161b22]"
    >
      {body}
    </ExternalLink>
  ) : (
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm">{body}</div>
  );
}

/// The pull request detail view.
///
/// Modelled on GitHub's PR page minus what does not belong in a triage
/// tool: no file diff, no commit history, no posting comments. Headstate
/// is for deciding and acting; reviewing code belongs in GitHub or an
/// editor, and "View on GitHub" covers the rest.
export function PrDetailView({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const { data: pr, isLoading, isError, error, refetch } = usePrDetail(repo, number);
  const deleteBranch = useDeleteHeadBranch();
  const review = useReviewPr();
  const comment = useCommentOnPr();
  // Undefined until the login lands, and undefined FOREVER if it fails.
  // ReviewBox reads that as "might not be mine" rather than "is mine",
  // so a failed viewer fetch never silently removes the approve button.
  const { data: viewer } = useViewer();
  const [reviewing, setReviewing] = useState<ReviewVerdictName | null>(null);
  const rerun = useRerunChecks();
  const [rerunning, setRerunning] = useState(false);
  const rerunnable = pr ? rerunnableRun(pr.checks) : null;
  // The viewer's own verdict, read the same way ReviewBox reads it: the
  // pull request's aggregate `review` says CHANGES_REQUESTED when
  // somebody ELSE blocked it, which says nothing about whether this
  // user approved. DISMISSED is deliberately not an approval -- GitHub
  // dismisses a review when the branch changes under it.
  const approvedByViewer =
    viewer !== undefined &&
    pr?.latest_reviews?.some((r) => r.author === viewer && r.state === "APPROVED") === true;

  /// Lifted out of the ReviewBox JSX so the sticky header can submit
  /// the same way. Two call sites for one mutation, and a second inline
  /// copy would be the kind of duplication that drifts.
  ///
  /// `pr` is non-null at every call site (both are inside the loaded
  /// branch), but this closure is defined above the guard, so the guard
  /// is restated rather than asserted away.
  const submitReview = (verdict: ReviewVerdictName, body: string) => {
    if (!pr) return;
    setReviewing(verdict);
    const done = () => setReviewing(null);
    const label =
      verdict === "approve"
        ? "Approved"
        : verdict === "request_changes"
          ? "Changes requested on"
          : "Commented on";
    // "Comment" posts a CONVERSATION comment, not a COMMENT
    // review. They are different nodes: addComment creates an
    // IssueComment, addPullRequestReview creates a
    // PullRequestReview with state COMMENTED. The list above
    // renders IssueComments -- so routing this through the review
    // mutation would post something the user then could not see.
    const submit =
      verdict === "comment"
        ? comment(pr.id, pr.repo, pr.number, body)
        : review(pr.id, pr.repo, pr.number, verdict, body);
    submit.then(
      () => {
        done();
        toast.success(`${label} ${pr.repo}#${pr.number}`);
      },
      (e: unknown) => {
        done();
        // GitHub's refusal is the useful part -- "Can not approve
        // your own pull request" tells the user exactly what
        // happened where a generic message would not.
        toast.error(`Could not review #${pr.number}`, {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="mb-3 flex items-center gap-1.5 text-sm text-[#8b949e] hover:text-[#e6edf3]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to list
    </button>
  );

  if (isLoading) {
    return (
      <div>
        {back}
        <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
          Loading pull request…
        </div>
      </div>
    );
  }

  if (isError || !pr) {
    return (
      <div>
        {back}
        <QueryError
          title="Could not load this pull request"
          message={errorMessage(error)}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    // `max-w-4xl mx-auto`: the body is prose and prose needs a measure.
    // At full window width a description ran the entire monitor, which
    // is both hard to read and what made every section feel crammed
    // against its neighbour. The sticky header opts out via `-mx-4` so
    // it still spans the panel.
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      {/* NOTE: the body's own `back` button is deliberately not rendered
          here. The sticky header carries one that is always visible, and
          two "back" controls a few pixels apart is worse than one. The
          loading and error branches above still use `back`, since they
          have no header to hang it on. */}
      {/* Sticky, because the actions were unreachable from where the
          decision gets made. Reading a long PR put "Back to list" far
          above the viewport and "View on GitHub" far below it, so
          approving meant scrolling to the top and opening it on GitHub
          meant scrolling to the bottom.
          
          `top-0` is safe: the app header above scrolls away with the
          content rather than being sticky itself, so nothing overlaps.
          The scroll container is `<main>` in App, which is this
          element's scrolling ancestor -- that is what makes `sticky`
          work here at all. */}
      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b border-[#30363d] bg-[#0d1117] px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1.5 text-sm text-[#8b949e] hover:text-[#e6edf3]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to list
        </button>
        {/* No title or number here on purpose.
            
            Both are already in the <h2> immediately below, so putting
            them in the header repeats the same words at the top of the
            page and makes them ambiguous to a screen reader, which
            reads every copy. Only one pull request is ever open, so
            the pinned buttons cannot be about a different one. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* The two the user actually reaches for, in the order they
              reach for them. Approve is absent: it needs the comment box
              that only makes sense in the body, and a bare approve
              button here would submit an empty review from a header the
              user may have scrolled past without reading. */}
          {/* Approve, pinned.
              
              Deliberately omitted at first because it submits a review
              with no comment from a bar the user may have scrolled
              past. Added on request -- and GitHub allows an empty
              approval, so the objection was about accident, not
              validity. The guards that make it safe are the same ones
              ReviewBox applies: hidden on your own pull request, which
              GitHub refuses outright, and showing "Approved" rather
              than offering a second one once your approval is on
              record. */}
          {viewer !== undefined && viewer !== pr.author ? (
            <button
              type="button"
              disabled={approvedByViewer || reviewing !== null}
              onClick={() => submitReview("approve", "")}
              title={
                approvedByViewer
                  ? "You have already approved this pull request"
                  : "Approve without a comment"
              }
              className={`rounded px-2.5 py-1 text-sm font-medium ${
                approvedByViewer || reviewing !== null
                  ? "border border-[#30363d] text-[#8b949e] opacity-50"
                  : "bg-[#238636] text-white hover:bg-[#2ea043]"
              }`}
            >
              {reviewing === "approve"
                ? "Working…"
                : approvedByViewer
                  ? "Approved"
                  : "Approve"}
            </button>
          ) : null}
          <PrActions pr={pr} compact />
          <ExternalLink
            href={pr.url}
            className="flex items-center gap-1.5 rounded border border-[#30363d] px-2.5 py-1 text-sm hover:bg-[#161b22]"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            GitHub
          </ExternalLink>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold leading-snug text-[#e6edf3]">
          {pr.title} <span className="font-normal text-[#8b949e]">#{pr.number}</span>
        </h2>
        {/* ONE metadata line, not two stacked paragraphs. The branch
            pair and the diff size are the same kind of fact about the
            same pull request, and splitting them across two lines was
            half the vertical noise above the fold. */}
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-[#8b949e]">
          <span>
            {pr.author} wants to merge <span className="font-mono">{pr.head_ref}</span> into{" "}
            <span className="font-mono">{pr.base_ref}</span>
          </span>
          <span aria-hidden="true">·</span>
          <span>{pr.repo}</span>
          {pr.is_draft ? (
            <>
              <span aria-hidden="true">·</span>
              <span>draft</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            +{pr.additions.toLocaleString()} −{pr.deletions.toLocaleString()} across{" "}
            {pr.changed_files} file{pr.changed_files === 1 ? "" : "s"}
          </span>
          {pr.unresolved_threads > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[#d29922]">
                {pr.unresolved_threads} unresolved conversation
                {pr.unresolved_threads === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <PrActions pr={pr} />

      {/* Available on EVERY pull request, not only the review queue.
          Gating this on which list you arrived from would mean the same
          pull request offers different actions depending on how you
          navigated to it -- and commenting on your own work is normal.
          Approving your own is the one case GitHub refuses, and
          ReviewBox handles that itself. */}
      <ReviewBox
        viewer={viewer}
        author={pr.author}
        latestReviews={pr.latest_reviews}
        busy={reviewing}
        onSubmit={submitReview}
      />

      {pr.body.trim() ? (
        // Open by default: the description is what the pull request IS,
        // and collapsing it would hide the thing you opened the view to
        // read.
        <Section title="Description">
          <Markdown>{pr.body}</Markdown>
        </Section>
      ) : (
        <p className="text-sm text-[#8b949e]">No description.</p>
      )}

      {pr.checks.length > 0 ? (
        // COLLAPSED when everything passed. A wall of twenty green
        // check rows is the single largest block on a healthy pull
        // request and tells you nothing you did not already learn from
        // the CI pill -- but it stays open the moment anything is not
        // passing, which is when you actually need the names.
        <Section
          title="Checks"
          count={pr.checks.length}
          defaultOpen={pr.checks.some((c) => c.state !== "success")}
          // Offered only when something FAILED and that failure belongs
          // to an Actions workflow run. A status context and a
          // non-Actions check both have no run to re-run, so the button
          // would 404 rather than help.
          aside={
            rerunnable !== null ? (
              <button
                type="button"
                disabled={rerunning}
                onClick={() => {
                  setRerunning(true);
                  rerun(pr.repo, pr.number, rerunnable).then(
                    () => {
                      setRerunning(false);
                      toast.success(`Re-running failed checks on #${pr.number}`);
                    },
                    (e: unknown) => {
                      setRerunning(false);
                      // GitHub's refusal is the useful part: "This
                      // workflow run cannot be retried" says exactly why
                      // where a generic message would not.
                      toast.error(`Could not re-run checks on #${pr.number}`, {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded border border-[#30363d] px-2 py-1 text-xs font-normal text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
              >
                {rerunning ? "Working…" : "Re-run failed"}
              </button>
            ) : null
          }
        >
          {pr.checks.map((c) => (
            <CheckRow key={c.name} {...c} />
          ))}
        </Section>
      ) : null}

      {/* ABOVE the comments: a conversation waiting on an answer is
          more urgent than the discussion thread, and the header's
          unresolved count points at this section. */}
      <ReviewThreads threads={pr.review_threads} repo={pr.repo} number={pr.number} />

      {pr.comments.length > 0 ? (
        // COLLAPSED past a handful. Fifty comments is the longest block
        // in this view by far, and scrolling past all of it to reach
        // the footer links was most of the "shoved together" problem.
        // A short thread stays open, because collapsing three comments
        // hides nothing worth a click.
        <Section title="Comments" count={pr.comment_count}>
          <div className="flex flex-col gap-2">
          {/* Each comment collapses on its OWN, rather than the whole
              block collapsing together. One section for fifty comments
              meant finding a particular one required expanding all of
              them and scrolling; the collapsed row carries a body
              preview so it can be picked out without opening it.

              A lone comment opens by default -- there is nothing to
              scan past, so collapsing it only adds a click. */}
          {pr.comments.map((c, i) => (
            <CommentRow
              key={`${c.author}-${c.created_at}-${i}`}
              author={c.author}
              createdAt={c.created_at}
              body={c.body}
              defaultOpen={pr.comments.length === 1}
            />
          ))}
          {/* GitHub is where you reply; this view is for deciding. */}
          {pr.comment_count > pr.comments.length ? (
            <p className="text-xs text-[#8b949e]">
              Showing {pr.comments.length} of {pr.comment_count}. See the rest on GitHub.
            </p>
          ) : null}
          </div>
        </Section>
      ) : null}

      <div className="flex items-center gap-2">
        <ExternalLink
          href={pr.url}
          className="flex w-fit items-center gap-1.5 rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
          View on GitHub
        </ExternalLink>
        {/* Worth more here than on a row: this view has the per-check
            names and URLs, so the prompt names the jobs that actually
            failed rather than saying the checks were not loaded. */}
        <button
          type="button"
          onClick={() =>
            void copyText(agentPrompt(toAgentContext(pr))).then((failure) =>
              failure === null
                ? toast.success("Prompt copied — paste it to an agent")
                : // The REASON, which the previous version discarded.
                  // "Could not copy" alone leaves the user with nothing
                  // to act on, and an absent clipboard did not even
                  // reach this handler.
                  toast.error("Could not copy the prompt", { description: failure }),
            )
          }
          className="flex w-fit items-center gap-1.5 rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
        >
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          Copy for agent
        </button>

        {/* Only once the PR has MERGED, and only while the branch still
            exists. 31 of the last 60 merged PRs on a real account still
            held a live remote branch -- the app's own thesis (agents
            create branches, PRs merge, leftovers stay) applied to the
            one domain where it did nothing.

            Deleting the head ref of an OPEN pull request closes it off,
            so the gate is re-checked on the Rust side too. */}
        {pr.state === "MERGED" && pr.head_ref_id ? (
          <button
            type="button"
            onClick={() => {
              const refId = pr.head_ref_id as string;
              deleteBranch(refId, pr.repo, pr.number, pr.head_ref, true).then(
                () => toast.success(`Deleted ${pr.head_ref}`),
                (e: unknown) =>
                  toast.error(`Could not delete ${pr.head_ref}`, {
                    description: typeof e === "string" ? e : undefined,
                  }),
              );
            }}
            className="flex w-fit items-center gap-1.5 rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Delete branch
          </button>
        ) : null}
      </div>
    </div>
  );
}
