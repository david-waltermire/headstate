import { useMemo, useState } from "react";
import { HardDrive } from "lucide-react";
import type { Artifact, ArtifactKind } from "@/types/pr";
import { useArtifacts, useArtifactSizes, useRemoveArtifacts } from "@/api/hooks";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { formatSize } from "@/lib/worktrees";
import { HelpButton } from "./HelpButton";
import { VenvSection } from "./VenvSection";

/// A placeholder holding the same footprint as the number it stands in
/// for, so rows do not jump as each measurement lands. Matches the one
/// on the worktree page rather than importing it -- that one is local to
/// its module, and a shared component for six lines of markup would be
/// indirection without benefit.
function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      // `motion-safe:` and `aria-hidden` for the same reasons the
      // worktree page's version carries them: an animation on every row
      // is what that setting exists to stop, and a placeholder has
      // nothing to announce.
      aria-hidden="true"
      className={`inline-block h-3 rounded bg-[#30363d] align-middle motion-safe:animate-pulse ${className}`}
    />
  );
}

/// What rebuilds each kind, shown beside the row.
///
/// "You can delete this" is only actionable next to what puts it back,
/// and the command is the whole safety argument in one phrase: removal
/// costs a rebuild, not work.
const REBUILD: Record<ArtifactKind, string> = {
  cargo_target: "cargo build",
  node_modules: "npm install",
  terraform: "terraform init",
  build_output: "the project's build",
};

const LABEL: Record<ArtifactKind, string> = {
  cargo_target: "target",
  node_modules: "node_modules",
  terraform: ".terraform",
  build_output: "build output",
};

/// Recently-written directories are probably being built into right now.
///
/// A running `cargo build` does NOT make git dirty -- build output is
/// gitignored -- so no git-based check can see it. Directory mtime is
/// the only available signal, which is why this is surfaced rather than
/// silently folded into a safety verdict.
const ACTIVE_SECS = 60 * 60;

/// Regenerable build output across the scanned directories.
///
/// A separate view from Worktrees despite scanning the same roots,
/// because it answers a different question. Measured on the machine that
/// prompted this: 0.28 GB of Rust build output sat inside worktrees,
/// against 108 GB beside main checkouts -- so the worktree view
/// structurally could not reach 99.7% of the largest thing on the disk.
export function ArtifactsPage() {
  const { data: artifacts = [], isLoading } = useArtifacts(true);
  const { sizes, ages, pending, total } = useArtifactSizes(artifacts, artifacts.length > 0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = useRemoveArtifacts();

  const toggle = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Largest first, and UNMEASURED rows sort last rather than as zero.
  // Sorting a null as 0 would bury the biggest directory on the machine
  // at the bottom until its size happened to arrive -- the ordering bug
  // #360 describes on the worktree page.
  const rows = useMemo(() => {
    return [...artifacts].sort((a, b) => {
      const sa = sizes.get(a.path);
      const sb = sizes.get(b.path);
      if (sa === undefined && sb === undefined) return a.path.localeCompare(b.path);
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      return sb - sa;
    });
  }, [artifacts, sizes]);

  const selectedBytes = [...checked].reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
  const selectedActive = [...checked].filter((p) => {
    const age = ages.get(p);
    return age !== undefined && age < ACTIVE_SECS;
  }).length;

  const measured = rows.filter((r) => sizes.has(r.path));
  const totalBytes = measured.reduce((n, r) => n + (sizes.get(r.path) ?? 0), 0);

  if (isLoading) {
    return <p className="p-4 text-sm text-[#8b949e]">Looking for build output…</p>;
  }

  if (artifacts.length === 0) {
    return (
      <p className="p-4 text-sm text-[#8b949e]">
        No build output found in the scanned directories.
      </p>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <HardDrive className="h-4 w-4 shrink-0 text-[#8b949e]" aria-hidden="true" />
        <span className="font-semibold text-[#e6edf3]">
          {artifacts.length} director{artifacts.length === 1 ? "y" : "ies"}
        </span>
        {/* "at least" until every batch has answered, because a total
            over a partial set is not the total. Claiming a finished
            number while measurement is still running is the kind of
            quiet wrongness this app tries not to ship. */}
        <span className="text-[#8b949e]">
          {pending > 0 ? "at least " : ""}
          {formatSize(totalBytes)}
        </span>
        {pending > 0 ? (
          <span
            aria-live="polite"
            className="text-xs text-[#58a6ff]"
          >
            measuring — {total - pending} of {total} repositories
          </span>
        ) : null}
        <HelpButton topic="build-artifacts" />

        {checked.size > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="ml-auto rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-50"
          >
            {/* The COUNT and the size in the label, so the scope is
                legible before the dialog rather than only inside it. */}
            {busy
              ? "Removing…"
              : `Remove ${checked.size} · ${formatSize(selectedBytes)}`}
          </button>
        ) : null}
      </div>

      {confirming ? (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>
              Remove {checked.size} director{checked.size === 1 ? "y" : "ies"}?
            </DialogTitle>
            {/* The specific loss, computed now. "Are you sure?" is not
                something anyone can act on -- and here the honest answer
                is that the loss is TIME, not work, which is exactly what
                makes this different from removing a worktree. */}
            <p className="mt-3 text-sm text-[#e6edf3]">
              This frees {formatSize(selectedBytes)}. Everything here is rebuilt by the
              command shown beside it — the cost is the rebuild, not lost work.
            </p>
            {selectedActive > 0 ? (
              <p className="mt-2 text-sm text-[#d29922]">
                {selectedActive} of them {selectedActive === 1 ? "was" : "were"} written
                to recently and may have a build running. Those will be refused.
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const paths = [...checked];
                  setConfirming(false);
                  setBusy(true);
                  remove(paths).then(
                    (outcomes) => {
                      setBusy(false);
                      setChecked(new Set());
                      const failed = outcomes.filter((o) => o.error !== null);
                      const ok = outcomes.length - failed.length;
                      // Never a bare "done": a directory refused at
                      // delete time is the guard working, and hiding it
                      // would misreport what is still on disk.
                      if (failed.length === 0) {
                        toast.success(`Removed ${ok} director${ok === 1 ? "y" : "ies"}`);
                      } else {
                        toast.error(
                          `${failed.length} of ${outcomes.length} could not be removed`,
                          { description: failed.map((f) => f.error).join("\n") },
                        );
                      }
                    },
                    (e: unknown) => {
                      setBusy(false);
                      toast.error("The removal could not run", {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Remove
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <ul className="flex flex-col gap-1">
        {rows.map((a) => (
          <ArtifactRow
            key={a.path}
            artifact={a}
            bytes={sizes.get(a.path)}
            ageSecs={ages.get(a.path)}
            checked={checked.has(a.path)}
            onToggle={() => toggle(a.path)}
          />
        ))}
      </ul>

      {/* Tool caches on the SAME page: both answer "where did the disk
          go", and splitting them across two views would make a user
          check two places for one answer. */}
      <VenvSection />
    </div>
  );
}

function ArtifactRow({
  artifact,
  bytes,
  ageSecs,
  checked,
  onToggle,
}: {
  artifact: Artifact;
  bytes: number | undefined;
  ageSecs: number | undefined;
  checked: boolean;
  onToggle: () => void;
}) {
  const active = ageSecs !== undefined && ageSecs < ACTIVE_SECS;
  return (
    <li className="flex items-center gap-3 rounded border border-[#30363d] px-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        // The PATH, not "select": with 178 rows an unnamed checkbox is
        // 178 identical controls to a screen reader.
        aria-label={`Select ${artifact.path}`}
        className="shrink-0"
      />
      <span className="shrink-0 rounded-full border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e]">
        {LABEL[artifact.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e6edf3]">
        {artifact.path}
      </span>
      {active ? (
        // Surfaced rather than hidden: this is the one hazard git cannot
        // see, and the user is the only one who knows whether a build is
        // theirs.
        <span className="shrink-0 text-xs text-[#d29922]">written recently</span>
      ) : null}
      <span className="shrink-0 text-xs text-[#8b949e]">{REBUILD[artifact.kind]}</span>
      <span className="w-20 shrink-0 text-right tabular-nums">
        {bytes === undefined ? <Skeleton className="ml-auto w-14" /> : formatSize(bytes)}
      </span>
    </li>
  );
}
