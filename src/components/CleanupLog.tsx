import { useState } from "react";
import { toast } from "sonner";
import { useCleanupLog } from "@/api/hooks";
import { formatSize } from "@/lib/worktrees";
import { relativeTime } from "@/lib/time";

/// What each action means, in the terms the user cares about.
const ACTION_TONE: Record<string, string> = {
  proposed: "bg-[#1f6feb]/15 text-[#58a6ff]",
  skipped: "bg-[#d29922]/15 text-[#d29922]",
  refused: "bg-[#d29922]/15 text-[#d29922]",
  removed: "bg-[#f85149]/15 text-[#f85149]",
};

/// The cleanup ledger, and a button to run a pass now.
///
/// This IS Phase 1. The setting turns the rules on; this is where the
/// user finds out what those rules actually picked on their own machine
/// — which is the only thing that can turn "trust this predicate" into
/// "I have read this list".
export function CleanupLog() {
  const { entries, run } = useCleanupLog(true);
  const [busy, setBusy] = useState(false);

  const proposed = entries.filter((e) => e.action === "proposed");
  const bytes = proposed.reduce((n, e) => n + (e.bytes ?? 0), 0);

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-semibold text-[#e6edf3]">What cleanup would reclaim</span>
        {proposed.length > 0 ? (
          <span className="text-[#8b949e]">
            {proposed.length} item{proposed.length === 1 ? "" : "s"} · {formatSize(bytes)}
          </span>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            run().then(
              (out) => {
                setBusy(false);
                // The COUNT, because a run that found nothing is a real
                // answer and a silent button is not.
                toast.success(
                  out.length === 0
                    ? "Nothing to reclaim right now"
                    : `Found ${out.length} item${out.length === 1 ? "" : "s"}`,
                );
              },
              (e: unknown) => {
                setBusy(false);
                toast.error("The cleanup pass could not run", {
                  description: typeof e === "string" ? e : undefined,
                });
              },
            );
          }}
          className="ml-auto rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-[#8b949e]">
          No reports yet. Turn on automatic cleanup in Settings, then check now.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.slice(0, 50).map((e, i) => (
            <li
              key={`${e.at}-${e.target}-${i}`}
              className="flex items-center gap-3 rounded border border-[#30363d] px-3 py-2 text-sm"
            >
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  ACTION_TONE[e.action] ?? "bg-[#30363d] text-[#8b949e]"
                }`}
              >
                {e.action}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e6edf3]">
                {e.target}
              </span>
              {/* The REASON, on anything that was not proposed. A row
                  passed over without explanation reads as a malfunction
                  rather than a guard doing its job. */}
              {e.error ? (
                <span className="shrink-0 text-xs text-[#8b949e]">{e.error}</span>
              ) : null}
              <span className="shrink-0 text-xs text-[#8b949e]">
                {relativeTime(e.at)}
              </span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-[#8b949e]">
                {e.bytes !== null ? formatSize(e.bytes) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
