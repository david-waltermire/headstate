import { useState } from "react";
import {
  useDockerBuildDetail,
  useDockerBuilds,
  useDockerImages,
  useDockerState,
} from "../api/hooks";
import { QueryError, errorMessage } from "./QueryError";
import { formatDockerSize } from "../lib/docker";
import { relativeTime } from "../lib/time";
import type { DockerBuild } from "../types/pr";
import { cachePercent, cacheTone, formatDuration } from "../lib/buildJoin";

/// What a build produced, and where it came from.
///
/// This is the grouping Docker Desktop's Builds page lacks: it shows
/// durations but never connects a build to its images or its worktree.
function BuildDetail({ build }: { build: DockerBuild }) {
  const { data: detail } = useDockerBuildDetail(build.reference);
  const { data: images } = useDockerImages(true);

  const revision = detail?.revision ?? null;
  // The build's revision is the image's tag -- that is the link.
  const produced = (images ?? []).filter((i) =>
    revision ? i.tags.some((t) => revision.startsWith(t)) : false,
  );

  return (
    <div className="rounded-md border border-[#30363d] p-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-semibold text-[#e6edf3]">{build.name}</span>
        <span className="text-[#8b949e]">{formatDuration(build.duration_secs)}</span>
        <span className={cacheTone(cachePercent(build))}>
          {build.cached_steps}/{build.total_steps} steps cached ({cachePercent(build)}%)
        </span>
      </div>

      {detail?.context ? (
        // For a worktree build this path IS the worktree, which is the
        // answer to "which session produced this?".
        <p className="mt-2 break-all font-mono text-[#8b949e]">{detail.context}</p>
      ) : null}

      <p className="mt-2 font-semibold text-[#e6edf3]">Images produced</p>
      {produced.length === 0 ? (
        // A normal end state, not an error: it usually means the cleanup
        // worked. Saying nothing would read as a failure to look.
        <p className="mt-1 text-[#8b949e]">
          {revision
            ? "None still on disk — they were removed, or this build produced no image."
            : "Build history no longer records what this produced."}
        </p>
      ) : (
        <ul className="mt-1">
          {produced.map((i) => (
            <li key={i.id} className="py-0.5 font-mono text-[#8b949e]">
              {i.repository}:{i.tags[0]} — {formatDockerSize(i.size_bytes)}
              {i.superseded ? " · superseded" : " · current"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DockerBuildsPage() {
  // Gated on the daemon being up, like every sibling on the Images tab.
  // Hardcoding `true` made a missing Docker render "No builds in
  // history" -- an empty answer to a question we could not ask.
  const { data: state } = useDockerState();
  const up = state?.kind === "running";
  const { data: builds, isLoading, isError, error, refetch } = useDockerBuilds(up);
  const [selected, setSelected] = useState<string | null>(null);

  if (state && !up) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
        {state.kind === "not_installed"
          ? "Docker was not found."
          : "Docker is not running."}{" "}
        Build history is unavailable.
      </div>
    );
  }

  if (isError) {
    return (
      <QueryError
        title="Could not read build history"
        message={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
        Reading build history…
      </div>
    );
  }

  const shown = builds ?? [];
  const chosen = shown.find((b) => b.reference === selected);

  return (
    <div className="flex flex-col gap-3">
      {chosen ? <BuildDetail build={chosen} /> : null}

      <div className="rounded-md border border-[#30363d]">
        {shown.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[#8b949e]">
            No builds in history.
          </div>
        ) : (
          shown.map((b) => {
            const pct = cachePercent(b);
            const failed = b.status !== "Completed";
            return (
              <button
                type="button"
                key={b.reference}
                onClick={() => setSelected(b.reference === selected ? null : b.reference)}
                className={`flex w-full items-baseline gap-3 border-b border-[#30363d] px-4 py-2.5 text-left text-sm last:border-b-0 hover:bg-[#161b22] ${
                  b.reference === selected ? "bg-[#161b22]" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">{b.name}</span>
                {/* Failures are kept, never filtered: a failing build is
                    usually what the user came to investigate. */}
                {failed ? <span className="shrink-0 text-xs text-[#f85149]">failed</span> : null}
                <span className={`shrink-0 text-xs ${cacheTone(pct)}`}>{pct}% cached</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-xs text-[#8b949e]">
                  {formatDuration(b.duration_secs)}
                </span>
                <span className="w-24 shrink-0 text-right text-xs text-[#8b949e]">
                  {b.started ? relativeTime(b.started) : ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
