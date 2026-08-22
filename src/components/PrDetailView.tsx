import { ArrowLeft, Trash2, Bot, Check, CircleDot, CircleSlash, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { useDeleteHeadBranch, usePrDetail } from "../api/hooks";
import { agentPrompt, toAgentContext } from "../lib/agentPrompt";
import { relativeTime } from "../lib/time";
import { Markdown } from "./Markdown";
import { PrActions } from "./PrActions";
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
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[#161b22]"
    >
      {body}
    </a>
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
    <div className="flex flex-col gap-4">
      {back}

      <div>
        <h2 className="text-lg font-semibold leading-snug text-[#e6edf3]">
          {pr.title} <span className="font-normal text-[#8b949e]">#{pr.number}</span>
        </h2>
        <p className="mt-1 text-xs text-[#8b949e]">
          {pr.author} wants to merge <span className="font-mono">{pr.head_ref}</span> into{" "}
          <span className="font-mono">{pr.base_ref}</span> · {pr.repo}
          {pr.is_draft ? " · draft" : null}
        </p>
        <p className="mt-1 text-xs text-[#8b949e]">
          +{pr.additions.toLocaleString()} −{pr.deletions.toLocaleString()} across{" "}
          {pr.changed_files} file{pr.changed_files === 1 ? "" : "s"}
          {pr.unresolved_threads > 0 ? (
            <span className="text-[#d29922]">
              {" "}
              · {pr.unresolved_threads} unresolved conversation
              {pr.unresolved_threads === 1 ? "" : "s"}
            </span>
          ) : null}
        </p>
      </div>

      <PrActions pr={pr} />

      {pr.body.trim() ? (
        <div className="rounded-md border border-[#30363d] p-4">
          <Markdown>{pr.body}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-[#8b949e]">No description.</p>
      )}

      {pr.checks.length > 0 ? (
        <div className="rounded-md border border-[#30363d]">
          <div className="border-b border-[#30363d] px-3 py-2 text-sm font-semibold">
            Checks
          </div>
          <div className="p-1">
            {pr.checks.map((c) => (
              <CheckRow key={c.name} {...c} />
            ))}
          </div>
        </div>
      ) : null}

      {pr.comments.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">
            {pr.comment_count} comment{pr.comment_count === 1 ? "" : "s"}
          </h3>
          {pr.comments.map((c, i) => (
            <div key={`${c.author}-${c.created_at}-${i}`} className="rounded-md border border-[#30363d] p-3">
              <p className="mb-2 text-xs text-[#8b949e]">
                {c.author} · {relativeTime(c.created_at)}
              </p>
              <Markdown>{c.body}</Markdown>
            </div>
          ))}
          {/* GitHub is where you reply; this view is for deciding. */}
          {pr.comment_count > pr.comments.length ? (
            <p className="text-xs text-[#8b949e]">
              Showing {pr.comments.length} of {pr.comment_count}. See the rest on GitHub.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex w-fit items-center gap-1.5 rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          View on GitHub
        </a>
        {/* Worth more here than on a row: this view has the per-check
            names and URLs, so the prompt names the jobs that actually
            failed rather than saying the checks were not loaded. */}
        <button
          type="button"
          onClick={() =>
            navigator.clipboard.writeText(agentPrompt(toAgentContext(pr))).then(
              () => toast.success("Prompt copied — paste it to an agent"),
              () => toast.error("Could not copy"),
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
