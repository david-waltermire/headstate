import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useBranches } from "@/api/hooks";
import { deleteBranches, deleteRemoteBranches } from "@/api/tauri";
import { useActiveFilters } from "@/store/filters";
import type { Branch, Deletable } from "@/types/pr";

/// Why a branch is or is not deletable, in words.
///
/// The whole reason `Deletable` is a tagged union rather than a boolean:
/// "not merged: 3 commits" and "checked out in ../foo" send the user to
/// different places, and a greyed-out checkbox sends them nowhere.
export function reason(d: Deletable): string {
  switch (d.kind) {
    case "merged":
      return d.how === "ancestor" ? "Merged" : "Merged (squashed)";
    case "defaultBranch":
      return "Default branch";
    case "checkedOut":
      return `Checked out in ${d.path}`;
    case "unmerged":
      return `Not merged — ${d.ahead} commit${d.ahead === 1 ? "" : "s"} not on the default branch`;
    case "pending":
      return "Checking…";
    case "unknown":
      return d.reason;
  }
}

const isDeletable = (b: Branch) => b.deletable.kind === "merged";

/// How long ago, in the coarse terms this decision actually needs.
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function BranchesPage() {
  const { repo } = useActiveFilters();
  const { data, isLoading, error } = useBranches(repo ?? undefined);
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const branches = useMemo(() => data ?? [], [data]);
  const deletable = useMemo(() => branches.filter(isDeletable), [branches]);

  // Local and remote are counted separately because they are deleted
  // by separate actions: one removes a ref here, the other pushes a
  // deletion everyone else sees.
  const pickedLocal = useMemo(
    () =>
      [...picked].filter((n) =>
        branches.some((b) => b.name === n && b.location !== "remote"),
      ),
    [picked, branches],
  );
  const pickedRemote = useMemo(
    () =>
      [...picked].filter((n) =>
        branches.some((b) => b.name === n && b.location === "remote"),
      ),
    [picked, branches],
  );

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const report = (outcomes: { name: string; error: string | null }[]) => {
    const failed = outcomes.filter((o) => o.error !== null);
    const done = outcomes.length - failed.length;
    if (done > 0) toast.success(`Deleted ${done} branch${done === 1 ? "" : "es"}`);
    // Each refusal names the branch AND the reason. A count alone
    // ("3 failed") tells the user nothing they can act on.
    for (const f of failed) {
      toast.error(`Could not delete ${f.name}`, { description: f.error ?? undefined });
    }
  };

  const run = (
    fn: (repoPath: string, names: string[]) => Promise<{ name: string; error: string | null }[]>,
    names: string[],
  ) => {
    if (!repo || names.length === 0) return;
    setBusy(true);
    fn(repo, names).then(
      (outcomes) => {
        setBusy(false);
        setPicked(new Set());
        report(outcomes);
        void qc.invalidateQueries({ queryKey: ["branches", repo] });
      },
      (e: unknown) => {
        setBusy(false);
        toast.error("Deletion failed", {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  if (!repo) {
    return <p className="text-sm text-[#8b949e]">Select a repository to see its branches.</p>;
  }
  if (isLoading) {
    // Named as slow rather than shown as a bare spinner: ~9s on a large
    // repository is long enough that silence reads as a hang.
    return (
      <p className="text-sm text-[#8b949e]">
        Scanning branches… this checks every branch for squash merges and can take a
        few seconds.
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-[#f85149]">
        {typeof error === "string" ? error : "Could not read branches for this repository."}
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[#8b949e]">
        {branches.length} branch{branches.length === 1 ? "" : "es"} · {deletable.length} merged
      </p>

      {picked.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-[#30363d] bg-[#161b22] p-2">
          <span className="text-[#8b949e]">{picked.size} selected</span>
          <button
            type="button"
            disabled={busy || pickedLocal.length === 0}
            onClick={() => run(deleteBranches, pickedLocal)}
            className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#21262d] disabled:opacity-40"
          >
            Delete {pickedLocal.length} local
          </button>
          {/* Its own control, in its own colour, saying "remote" in the
              label. This pushes a deletion to a shared remote, which no
              local reflog can undo -- it must not be reachable by the
              same click as a local ref. */}
          <button
            type="button"
            disabled={busy || pickedRemote.length === 0}
            onClick={() => run(deleteRemoteBranches, pickedRemote)}
            className="rounded border border-[#f85149]/40 px-2 py-1 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-40"
          >
            Delete {pickedRemote.length} on the remote
          </button>
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="ml-auto text-xs text-[#8b949e] hover:text-[#e6edf3]"
          >
            Clear
          </button>
        </div>
      ) : null}

      <ul className="space-y-1">
        {branches.map((b) => {
          const can = isDeletable(b);
          return (
            <li
              key={`${b.location}:${b.name}`}
              className="flex items-center gap-3 rounded border border-[#30363d] px-3 py-2"
            >
              <input
                type="checkbox"
                aria-label={b.name}
                checked={picked.has(b.name)}
                disabled={!can}
                onChange={() => toggle(b.name)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[#e6edf3]">{b.name}</span>
                  <span className="shrink-0 rounded bg-[#21262d] px-1.5 py-0.5 text-[10px] text-[#8b949e]">
                    {b.location}
                  </span>
                </div>
                {/* The reason is shown for EVERY row, not only the
                    blocked ones: "Merged (squashed)" is the evidence
                    that makes a bulk deletion safe to confirm. */}
                <div className={`text-xs ${can ? "text-[#3fb950]" : "text-[#8b949e]"}`}>
                  {reason(b.deletable)}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-[#8b949e]">
                <div>{ago(b.committed)}</div>
                <div className="truncate">{b.author}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
