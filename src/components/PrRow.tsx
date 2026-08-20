import { Check, CircleDot, GitPullRequest, MessageSquare, X } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { labelForeground } from "@/lib/labels";
import { relativeTime } from "@/lib/time";

/// A check for green, an X for red, and an amber dot while CI is running.
///
/// `none` stays blank, matching GitHub -- there is no glyph for "this repo
/// has no CI". `pending` is NOT blank, though: GitHub does show a running
/// indicator, and collapsing it to nothing made "tests are running right
/// now" byte-identical to "no CI configured". The app already knew the
/// difference and the nudge text already said so, which made the copied
/// Slack message strictly more informative than the UI that produced it.
function CiGlyph({ pr }: { pr: PullRequest }) {
  if (pr.ci === "success") {
    return <Check className="h-4 w-4 shrink-0 text-[#3fb950]" aria-label="CI passing" />;
  }
  if (pr.ci === "failure") {
    return <X className="h-4 w-4 shrink-0 text-[#f85149]" aria-label="CI failing" />;
  }
  if (pr.ci === "pending") {
    return (
      <CircleDot className="h-4 w-4 shrink-0 text-[#d29922]" aria-label="CI running" />
    );
  }
  return null;
}

/// Review outcome, when GitHub has one.
///
/// `review_required` deliberately renders nothing: GitHub shows no neutral
/// glyph for "awaiting review" either, and a row where every PR carries a
/// marker teaches the reader to ignore all of them. Only a decision --
/// approved, or changes requested -- earns a chip.
function ReviewGlyph({ pr }: { pr: PullRequest }) {
  if (pr.review === "approved") {
    return (
      <span
        className="rounded-full border border-[#3fb950]/40 px-1.5 py-0.5 text-xs text-[#3fb950]"
        title="Approved"
      >
        Approved
      </span>
    );
  }
  if (pr.review === "changes_requested") {
    return (
      <span
        className="rounded-full border border-[#d29922]/40 px-1.5 py-0.5 text-xs text-[#d29922]"
        title="Changes requested"
      >
        Changes requested
      </span>
    );
  }
  return null;
}

export function PrRow({ pr }: { pr: PullRequest }) {
  return (
    <div className="flex gap-3 border-b border-[#30363d] px-4 py-3 last:border-b-0 hover:bg-[#161b22]">
      <GitPullRequest
        className="mt-0.5 h-4 w-4 shrink-0 text-[#3fb950]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-[#e6edf3] hover:text-[#4493f8]"
          >
            {pr.title}
          </a>
          <CiGlyph pr={pr} />
          <ReviewGlyph pr={pr} />
          {pr.labels.map((label) => (
            <span
              key={label.name}
              className="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: `#${label.color}`,
                color: labelForeground(label.color),
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
        <div className="mt-1 text-xs text-[#8b949e]">
          {/* `updated_at` is what the app SORTS and reasons about (stale
              detection, "least recently updated"), so a row showing only
              the creation date could not explain its own position in the
              list: two PRs both "opened 2 months ago", one touched an hour
              ago and one dead six weeks. */}
          #{pr.number} opened {relativeTime(pr.created_at)} by {pr.author} · updated{" "}
          {relativeTime(pr.updated_at)}
          {pr.is_draft && (
            <span className="ml-2 rounded border border-[#30363d] px-1.5">Draft</span>
          )}
          {pr.in_merge_queue && <span className="ml-2 text-[#a371f7]">• In merge queue</span>}
          {pr.merge === "conflicted" && (
            <span className="ml-2 text-[#f85149]">• Conflicts</span>
          )}
          {pr.merge === "checking" && <span className="ml-2">• Checking mergeability</span>}
          {pr.comment_count > 0 && (
            <span className="ml-2 inline-flex items-center gap-1">
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {pr.comment_count}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 text-xs text-[#8b949e]">{pr.repo}</div>
    </div>
  );
}
