import { useMemo, useState } from "react";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useBranches } from "@/api/hooks";
import { deleteBranches, deleteRemoteBranches } from "@/api/tauri";
import { useActiveFilters } from "@/store/filters";
import type { Branch, Deletable } from "@/types/pr";
import { type Scope, scopeLabel, scopesFor, targetsFor } from "@/lib/branchDelete";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

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
  const [asking, setAsking] = useState(false);

  const branches = useMemo(() => data ?? [], [data]);
  const deletable = useMemo(() => branches.filter(isDeletable), [branches]);

  // The selected BRANCHES, not their names: deciding where a deletion
  // can happen needs each one's location and upstream, which a name
  // alone does not carry. #473 came from splitting on names.
  const chosen = useMemo(
    () => branches.filter((b) => picked.has(b.name)),
    [picked, branches],
  );
  const scopes = useMemo(() => scopesFor(chosen), [chosen]);

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

  /// Perform a deletion at the chosen scope.
  ///
  /// "Both" is TWO backend calls against two different things, and
  /// they are reported together but not merged: a tracked branch whose
  /// local ref went and whose remote push failed must say so, or the
  /// user is left believing the same thing #473 made them believe.
  const run = (scope: Scope) => {
    if (!repo) return;
    const t = targetsFor(chosen, scope);
    if (t.local.length === 0 && t.remote.length === 0) return;

    setBusy(true);
    setAsking(false);
    Promise.all([
      t.local.length > 0 ? deleteBranches(repo, t.local) : Promise.resolve([]),
      t.remote.length > 0 ? deleteRemoteBranches(repo, t.remote) : Promise.resolve([]),
    ]).then(
      ([local, remote]) => {
        setBusy(false);
        setPicked(new Set());
        report([...local, ...remote]);
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

      <div className="flex flex-wrap items-center gap-2">
        {/* Selects exactly what ticking every deletable row by hand
            would select -- the same `merged` gate, not a second
            definition that could drift from it. */}
        <button
          type="button"
          disabled={busy || deletable.length === 0}
          onClick={() => setPicked(new Set(deletable.map((b) => b.name)))}
          className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#21262d] disabled:opacity-40"
        >
          Select all {deletable.length} merged
        </button>
        {picked.size > 0 ? (
          <>
            <span className="text-xs text-[#8b949e]">{picked.size} selected</span>
            {/* ONE button. Where the deletion happens is a question the
                modal asks, because a tracked branch exists in two
                places and two side-by-side buttons could not express
                "both" -- they filed it under "local" and left the
                remote branch alive (#473). */}
            <button
              type="button"
              disabled={busy || scopes.length === 0}
              onClick={() => setAsking(true)}
              className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#21262d] disabled:opacity-40"
            >
              Delete {picked.size}…
            </button>
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="text-xs text-[#8b949e] hover:text-[#e6edf3]"
            >
              Clear
            </button>
          </>
        ) : null}
      </div>

      <DeleteScopeDialog
        open={asking}
        onOpenChange={setAsking}
        chosen={chosen}
        scopes={scopes}
        busy={busy}
        onConfirm={run}
      />

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

/// Asks WHERE to delete, rather than making the user pick a button
/// that guesses.
///
/// The scope question exists because a tracked branch is two things.
/// Before this, the view offered "local" and "remote" as separate
/// controls and quietly filed tracked branches under local -- deleting
/// the ref here and leaving the branch on the remote, which then
/// reappeared as remote-only (#473).
function DeleteScopeDialog({
  open,
  onOpenChange,
  chosen,
  scopes,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  chosen: Branch[];
  scopes: Scope[];
  busy: boolean;
  onConfirm: (s: Scope) => void;
}) {
  // Defaults to the safest option that applies. Local deletion is
  // recoverable from the reflog; a remote deletion is not, so it is
  // never what a distracted Enter press does.
  const [chosenScope, setScope] = useState<Scope | null>(null);
  // A held choice that no longer applies must not survive: selecting a
  // tracked branch, choosing "both", then changing the selection to
  // remote-only branches would otherwise leave "both" active and send
  // names to a call that cannot use them.
  const scope: Scope =
    chosenScope !== null && scopes.includes(chosenScope)
      ? chosenScope
      : (scopes[0] ?? "local");

  const describe = (s: Scope) => {
    switch (s) {
      case "local":
        return "Removes the branch here. Recoverable from the reflog.";
      case "remote":
        return "Pushes a deletion to the remote. Everyone loses it, and no local reflog can undo that.";
      case "both":
        return "Removes it here and on the remote. The remote half cannot be undone.";
    }
  };

  const targets = targetsFor(chosen, scope);
  const label = scopeLabel(scope, targets);
  // Saying so in the confirm state, not only in the option text: with
  // one control instead of two, the words are what carry the warning
  // the separate red button used to.
  const touchesRemote = targets.remote.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>
          Delete {chosen.length} branch{chosen.length === 1 ? "" : "es"}
        </DialogTitle>
        <Questionnaire.Root>
          <Questionnaire.Item name="scope" required>
            <Questionnaire.Title className="mt-2 text-sm text-[#e6edf3]">
              Where should these be deleted?
            </Questionnaire.Title>
            <Questionnaire.Choices className="mt-3 space-y-2">
              {scopes.map((s) => (
                <Questionnaire.Choice
                  key={s}
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="flex cursor-pointer items-start gap-2 rounded border border-[#30363d] p-2 hover:bg-[#161b22]"
                >
                  <Questionnaire.ChoiceInput className="mt-1" />
                  <span>
                    <Questionnaire.ChoiceLabel className="block text-sm text-[#e6edf3]">
                      {s === "local"
                        ? "Locally only"
                        : s === "remote"
                          ? "On the remote only"
                          : "Both here and on the remote"}
                    </Questionnaire.ChoiceLabel>
                    <span className="block text-xs text-[#8b949e]">{describe(s)}</span>
                  </span>
                </Questionnaire.Choice>
              ))}
            </Questionnaire.Choices>
          </Questionnaire.Item>
        </Questionnaire.Root>

        <p className="mt-3 text-xs text-[#8b949e]">
          Each branch is re-checked before deletion, so anything that changed since
          the scan is skipped.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(scope)}
            className={`rounded px-3 py-1 text-xs disabled:opacity-40 ${
              touchesRemote
                ? "border border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
                : "border border-[#30363d] text-[#e6edf3] hover:bg-[#21262d]"
            }`}
          >
            {label}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-xs text-[#8b949e] hover:text-[#e6edf3]"
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
