import { useMemo, useState } from "react";
import { HardDrive } from "lucide-react";
import type { Artifact, ArtifactKind } from "@/types/pr";
import { useArtifacts, useArtifactSizes, useRemoveArtifacts, useVenvs } from "@/api/hooks";
import { useActiveFilters } from "@/store/filters";
import { GROUP_LABEL, VENV_GROUP } from "./ArtifactSidebar";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { formatSize } from "@/lib/worktrees";
import { HelpButton } from "./HelpButton";
import { VenvSection } from "./VenvSection";
import { CleanupLog } from "./CleanupLog";

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
  const filters = useActiveFilters();
  // `repo` is the sidebar's selection key across every view; here it
  // holds an artifact KIND rather than a path. Reusing it keeps one
  // selection mechanism instead of a second parallel one.
  const group = filters.repo;
  const { data: allArtifacts = [], isLoading } = useArtifacts(true);
  // Read here only to decide the empty state; VenvSection owns the rest.
  const { data: venvList = [] } = useVenvs(true);
  const venvCount = venvList.length;
  // Filtered BEFORE sizing, so a group page measures only what it shows
  // rather than paying for the whole machine to render one section.
  const artifacts =
    group === undefined || group === VENV_GROUP
      ? allArtifacts
      : allArtifacts.filter((a) => a.kind === group);
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

  // Everything a build is NOT currently writing to. The same rule the
  // backend enforces at delete time, applied here so the button's count
  // matches what the click will actually remove.
  const removable = rows.filter((r) => {
    const age = ages.get(r.path);
    return age === undefined || age >= ACTIVE_SECS;
  });
  const removableBytes = removable.reduce((n, r) => n + (sizes.get(r.path) ?? 0), 0);

  const measured = rows.filter((r) => sizes.has(r.path));
  const totalBytes = measured.reduce((n, r) => n + (sizes.get(r.path) ?? 0), 0);

  // On the virtualenv page the build-artifact list is not the subject.
  const showArtifacts = group !== VENV_GROUP;
  const showVenvs = group === undefined || group === VENV_GROUP;

  if (isLoading && showArtifacts) {
    return <p className="p-4 text-sm text-[#8b949e]">Looking for build output…</p>;
  }

  // Named by the group the user chose, so an empty Terraform page does
  // not claim there is no build output at all.
  const label =
    group !== undefined && group in GROUP_LABEL
      ? GROUP_LABEL[group as keyof typeof GROUP_LABEL].toLowerCase()
      : "build output";

  // Only when there is genuinely nothing on the page. On "Everything"
  // that means no artifacts AND no virtualenvs -- an empty artifact list
  // beside 78 virtualenvs is not an empty page, and saying so would be
  // wrong in the one place the user is looking for the total.
  if (artifacts.length === 0 && (!showVenvs || venvCount === 0)) {
    return (
      <p className="p-4 text-sm text-[#8b949e]">
        No {label} found in the scanned directories.
      </p>
    );
  }

  return (
    <div className="p-4">
      {showArtifacts ? (
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

        {/* One click for the group, EXCLUDING anything a build may be
            writing to. Those are refused at delete time anyway, so
            selecting them would only produce a failure report the user
            did not ask for -- and the count in the label would promise
            more than the click delivers. */}
        {removable.length > 1 && checked.size === 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChecked(new Set(removable.map((r) => r.path)));
              setConfirming(true);
            }}
            className="ml-auto rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-50"
          >
            Remove all {removable.length}
            {pending > 0 ? "" : ` · ${formatSize(removableBytes)}`}
          </button>
        ) : null}

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
      ) : null}

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

      {showArtifacts ? (
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
      ) : null}

      {/* Shown on "Everything" and on the virtualenv page, hidden when a
          build-artifact group is selected -- the sidebar's whole point is
          that choosing a group narrows the page to it. */}
      {showVenvs ? <VenvSection /> : null}

      {/* The ledger, on "Everything" only: it spans both kinds, so it
          belongs where the whole picture is rather than repeated under
          each group. */}
      {group === undefined ? <CleanupLog /> : null}
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
