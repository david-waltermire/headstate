import { Check, GitPullRequest, X } from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { labelForeground } from "@/lib/labels";
import { relativeTime } from "@/lib/time";
import { Checkbox } from "@/components/ui/checkbox";

/// GitHub shows a check for green CI, an X for red CI, and nothing for
/// "pending"/"none" -- there is no neutral glyph on the real page, so we
/// don't invent one either.
function CiGlyph({ pr }: { pr: PullRequest }) {
  if (pr.ci === "success") {
    return <Check className="h-4 w-4 shrink-0 text-[#3fb950]" aria-label="CI passing" />;
  }
  if (pr.ci === "failure") {
    return <X className="h-4 w-4 shrink-0 text-[#f85149]" aria-label="CI failing" />;
  }
  return null;
}

export function PrRow({ pr }: { pr: PullRequest }) {
  return (
    <div className="flex gap-3 border-b border-[#30363d] px-4 py-3 last:border-b-0 hover:bg-[#161b22]">
      <Checkbox className="mt-1" aria-label={`Select PR ${pr.number}`} />
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
          #{pr.number} opened {relativeTime(pr.created_at)} by {pr.author}
          {pr.is_draft && (
            <span className="ml-2 rounded border border-[#30363d] px-1.5">Draft</span>
          )}
          {pr.in_merge_queue && <span className="ml-2 text-[#a371f7]">• In merge queue</span>}
          {pr.merge === "conflicted" && (
            <span className="ml-2 text-[#f85149]">• Conflicts</span>
          )}
          {pr.merge === "checking" && <span className="ml-2">• Checking mergeability</span>}
        </div>
      </div>
      <div className="shrink-0 text-xs text-[#8b949e]">{pr.repo}</div>
    </div>
  );
}
