import { useState } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import type { ReviewThread } from "@/types/pr";
import { Markdown } from "./Markdown";
import { relativeTime } from "@/lib/time";
import { useReplyToThread, useResolveThread, useUnresolveThread } from "@/api/hooks";

/// Whether a thread still wants an answer.
///
/// The SAME rule the unresolved count uses (`map.rs`'s `unresolved_threads`
/// excludes both). Restated here rather than re-derived loosely, because
/// the header renders that count directly above this list: if the two ever
/// disagree, the header contradicts the section beneath it.
///
/// Outdated is excluded because a force-push moved the code out from under
/// the thread -- the comment is stranded, and nagging about it is what the
/// count already declined to do.
function isActionable(t: ReviewThread): boolean {
  return !t.is_resolved && !t.is_outdated;
}

/// Where a thread hangs, as a label.
///
/// `line` is null exactly when the anchor is gone, so the path stands
/// alone rather than reading `src/poll.rs:null`.
function location(t: ReviewThread): string {
  return t.line === null ? t.path : `${t.path}:${t.line}`;
}

/// The review conversations on a pull request.
///
/// A separate section from Comments because these are a different GitHub
/// object: inline threads anchored to a file and line, and the only ones
/// that can be resolved. Merging them into the comment list would imply a
/// Resolve button on comments that have no such concept.
export function ReviewThreads({ threads, repo, number }: {
  threads: ReviewThread[];
  repo: string;
  number: number;
}) {
  if (threads.length === 0) return null;

  // Actionable first. These are why the section exists; a resolved thread
  // is history, and history should not push the open question below the
  // fold.
  const actionable = threads.filter(isActionable);
  const settled = threads.filter((t) => !isActionable(t));

  return (
    <section className="overflow-hidden rounded-md border border-[#30363d]">
      <h2 className="flex items-center gap-2 border-b border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm font-semibold text-[#e6edf3]">
        <MessageSquare className="h-4 w-4 shrink-0 text-[#8b949e]" aria-hidden="true" />
        Conversations
        <span className="font-normal text-[#8b949e]">{threads.length}</span>
      </h2>
      <div className="flex flex-col gap-2 p-3">
        {actionable.map((t) => (
          <ThreadCard key={t.id} thread={t} repo={repo} number={number} />
        ))}
        {settled.map((t) => (
          <ThreadCard key={t.id} thread={t} repo={repo} number={number} />
        ))}
      </div>
    </section>
  );
}

function ThreadCard({ thread, repo, number }: {
  thread: ReviewThread;
  repo: string;
  number: number;
}) {
  const actionable = isActionable(thread);
  // Unresolved threads start OPEN: they are the ones needing an answer,
  // and hiding them behind a click is what the whole section exists to
  // stop. Settled ones collapse but stay listed, so a resolved discussion
  // remains findable.
  const [open, setOpen] = useState(actionable);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const resolve = useResolveThread();
  const unresolve = useUnresolveThread();
  const sendReply = useReplyToThread();

  const run = (p: Promise<void>, ok: string, bad: string) => {
    setBusy(true);
    p.then(
      () => {
        setBusy(false);
        setReply("");
        toast.success(ok);
      },
      (e: unknown) => {
        setBusy(false);
        // GitHub's own refusal is the useful part -- a generic message
        // hides which permission was missing.
        toast.error(bad, { description: typeof e === "string" ? e : undefined });
      },
    );
  };

  return (
    <div className="overflow-hidden rounded-md border border-[#30363d]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[#161b22]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">
          {location(thread)}
        </span>
        {/* Outdated is its own state, never folded into resolved: the
            question may still be open, and only the anchor is gone. */}
        {thread.is_outdated ? (
          <span className="shrink-0 rounded-full border border-[#30363d] px-2 py-0.5 text-[#8b949e]">
            outdated
          </span>
        ) : null}
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 ${
            thread.is_resolved
              ? "bg-[#238636]/15 text-[#3fb950]"
              : "bg-[#d29922]/15 text-[#d29922]"
          }`}
        >
          {thread.is_resolved ? "resolved" : "unresolved"}
        </span>
      </button>

      {open ? (
        <div className="border-t border-[#30363d] p-3">
          <div className="flex flex-col gap-3">
            {thread.comments.map((c, i) => (
              <div key={`${c.author}-${c.created_at}-${i}`}>
                <p className="mb-1 text-xs text-[#8b949e]">
                  {c.author} · {relativeTime(c.created_at)}
                </p>
                <Markdown>{c.body}</Markdown>
              </div>
            ))}
            {/* The query pages thread comments at 10; claiming to show
                all of them would be a quiet lie. */}
            {thread.comment_count > thread.comments.length ? (
              <p className="text-xs text-[#8b949e]">
                Showing {thread.comments.length} of {thread.comment_count}. See the rest
                on GitHub.
              </p>
            ) : null}
          </div>

          {/* Every control is gated on the viewer's OWN permission for
              this thread. Without the gate a reader without write access
              gets a Resolve button that 403s on click -- the button
              would be lying about what it can do. */}
          {thread.viewer_can_reply ? (
            <div className="mt-3">
              <label htmlFor={`reply-${thread.id}`} className="sr-only">
                Reply to the conversation on {location(thread)}
              </label>
              <textarea
                id={`reply-${thread.id}`}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                placeholder="Reply…"
                className="w-full rounded border border-[#30363d] bg-[#0d1117] p-2 text-sm text-[#e6edf3] placeholder:text-[#6e7681]"
              />
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            {thread.viewer_can_reply ? (
              <button
                type="button"
                // Empty replies are refused by the command too; disabling
                // here means the button never looks available for an
                // action that cannot happen.
                disabled={busy || reply.trim() === ""}
                onClick={() =>
                  run(
                    sendReply(thread.id, repo, number, reply),
                    "Replied",
                    `Could not reply on ${repo}#${number}`,
                  )
                }
                className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
              >
                {busy ? "Working…" : "Reply"}
              </button>
            ) : null}

            {!thread.is_resolved && thread.viewer_can_resolve ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    resolve(thread.id, repo, number),
                    "Conversation resolved",
                    `Could not resolve the conversation on ${repo}#${number}`,
                  )
                }
                className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
              >
                Resolve conversation
              </button>
            ) : null}

            {/* Resolving is one click with no confirmation, so the undo
                belongs beside it rather than only on github.com. */}
            {thread.is_resolved && thread.viewer_can_unresolve ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    unresolve(thread.id, repo, number),
                    "Conversation reopened",
                    `Could not reopen the conversation on ${repo}#${number}`,
                  )
                }
                className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
              >
                Reopen
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
