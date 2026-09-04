import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { Ecosystem, Outdated, RunReport } from "@/types/pr";
import { ExternalLink } from "./ExternalLink";
import { applyPackageUpdates, openUpdatePr } from "@/api/tauri";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/// Ecosystems whose updates this can apply.
///
/// Swift is excluded for the same reason the CHECK excludes it: nothing
/// reports what is outdated for Xcode-managed dependencies, so there is
/// no version to move to. Stated in the UI rather than silently omitted,
/// because a package that quietly cannot be selected reads as a bug.
/// Ecosystems the backend refuses, with the reason shown to the user.
///
/// Must match `packages::apply::supported`. Terraform was missing here
/// while the backend refused it -- so every Terraform row was
/// selectable, counted toward the button, and failed at apply time with
/// an error the user could have been told about before clicking.
const CANNOT_APPLY: Partial<Record<Ecosystem, string>> = {
  swift: "Swift packages must be updated in Xcode or Package.swift.",
  terraform:
    "Terraform provider versions are a constraint in your .tf source, not something a lockfile edit can change.",
};

/// Applies dependency updates in a fresh worktree.
///
/// Phase 1: it does NOT push and does NOT open a pull request. The
/// deliverable is a worktree the user inspects themselves, which is
/// deliberate — what these package managers actually do to a checkout is
/// the thing being found out, and adding an irreversible step on top of
/// an unknown is how a small update becomes a bad pull request.
export function UpdateWizard({
  repo,
  packages,
  open,
  onOpenChange,
}: {
  repo: string;
  packages: Outdated[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RunReport | null>(null);

  /// Identifies a ROW, not a package.
  ///
  /// This was `ecosystem:name`, which is not unique: one repository
  /// declares the same dependency in several manifests, so every row
  /// for that name shared one checkbox -- ticking one ticked them all,
  /// and React saw duplicate keys. `manifest` is what actually
  /// distinguishes them.
  const key = (p: Outdated) => `${p.ecosystem}:${p.manifest}:${p.name}`;

  const { applicable, blocked } = useMemo(() => {
    const applicable: Outdated[] = [];
    const blocked: Outdated[] = [];
    for (const p of packages) {
      // A row whose latest EQUALS its current is not an update.
      //
      // `registry::enrich` leaves a provider at `latest == current` with
      // `bump: "unknown"` when its registry lookup fails -- deliberately,
      // so one unreachable host cannot turn a repository into a false
      // all-clear. But the wizard rendered that identically to a real
      // update, offering "2.8.0 → 2.8.0" as something to apply.
      if (p.bump === "unknown" && p.current === p.latest) {
        blocked.push(p);
        continue;
      }
      (CANNOT_APPLY[p.ecosystem] ? blocked : applicable).push(p);
    }
    return { applicable, blocked };
  }, [packages]);

  const run = () => {
    const requests = applicable
      .filter((p) => selected.has(key(p)))
      .map((p) => ({ name: p.name, version: p.latest, ecosystem: p.ecosystem }));
    // Unreachable through the UI -- the button is disabled with an
    // empty selection -- and kept as a guard for any other caller.
    if (requests.length === 0) return;
    setRunning(true);
    applyPackageUpdates(repo, requests).then(
      (r) => {
        setRunning(false);
        setReport(r);
        const failed = r.results.filter((x) => x.error !== null).length;
        if (failed === 0) {
          toast.success(`Updated ${r.results.length} package${r.results.length === 1 ? "" : "s"}`, {
            description: `On branch ${r.branch}. Nothing was pushed.`,
          });
        } else {
          // Not an error toast: the run itself succeeded and the
          // worktree exists. Some packages failing is a result, not a
          // failure of the operation.
          toast.warning(`${failed} of ${r.results.length} could not be updated`, {
            description: "See the details below.",
          });
        }
      },
      (e: unknown) => {
        setRunning(false);
        toast.error("Could not apply updates", {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] w-[min(46rem,92vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Update packages in a worktree</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-[#8b949e]">
          Creates a new worktree, applies the updates there, and leaves it for you to
          review. Nothing is pushed and no pull request is opened.
        </p>

        {report ? (
          <Report report={report} repo={repo} />
        ) : (
          <>
            {applicable.length > 1 ? (
              <div className="flex items-center gap-3 border-b border-[#30363d] pb-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(applicable.map(key)))}
                  className="text-[#4493f8] hover:underline"
                >
                  Select all {applicable.length}
                </button>
                {selected.size > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-[#8b949e] hover:text-[#e6edf3]"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-1">
              {applicable.map((p) => {
                const k = key(p);
                return (
                  <label
                    key={k}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[#161b22]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(k)}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[#e6edf3]">{p.name}</span>
                      {/* Which manifest, so two rows for one dependency
                          are told apart. Without it the list showed the
                          same name twice with different versions and no
                          way to attribute either to a file. */}
                      <span className="block truncate text-[10px] text-[#6e7681]">
                        {p.manifest}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-[#8b949e]">
                      {p.current} → {p.latest}
                    </span>
                  </label>
                );
              })}
              {applicable.length === 0 && (
                <p className="text-sm text-[#8b949e]">Nothing here can be updated automatically.</p>
              )}
            </div>

            {/* Stated, not hidden. A package that silently cannot be
                selected reads as a bug in the list. */}
            {blocked.length > 0 && (
              <div className="mt-3 border-t border-[#30363d] pt-3">
                <p className="mb-1 text-xs font-medium text-[#8b949e]">
                  Cannot be updated here
                </p>
                {blocked.map((p) => (
                  <p key={key(p)} className="text-xs text-[#8b949e]">
                    <span className="text-[#e6edf3]">{p.name}</span> —{" "}
                    {CANNOT_APPLY[p.ecosystem] ??
                      "The latest version could not be determined, so there is nothing to update to."}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded border border-[#30363d] px-3 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || running}
                onClick={run}
                className="flex items-center gap-1 rounded border border-[#238636]/40 px-3 py-1 text-xs text-[#3fb950] hover:bg-[#238636]/10 disabled:opacity-50"
              >
                {running && <Loader2 className="h-3 w-3 animate-spin" />}
                {running ? "Applying…" : `Apply ${selected.size} update${selected.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/// What the run actually did.
///
/// Reports the resolved constraint next to the requested version because
/// they genuinely differ: npm rewrites a pinned `4.17.21` request into
/// `^4.17.21`, a range rather than a pin. Echoing back the requested
/// version would look like a report while telling the user nothing.
function Report({ report, repo }: { report: RunReport; repo: string }) {
  const [opening, setOpening] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const applied = report.results.filter((r) => r.error === null).length;
  // Only where the resolved constraint can be read back. The other
  // ecosystems report it as null, so the description would have to say
  // "not verified" about every row.
  const describable = report.ecosystems.every((e) => e === "npm" || e === "yarn");

  const open = () => {
    setOpening(true);
    openUpdatePr(repo, report).then(
      (u) => {
        setOpening(false);
        setUrl(u);
        toast.success("Pull request opened", { description: u });
      },
      (e: unknown) => {
        setOpening(false);
        toast.error("Could not open the pull request", {
          description: typeof e === "string" ? e : undefined,
        });
      },
    );
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[#8b949e]">
        Worktree: <code className="text-[#e6edf3]">{report.worktree}</code>
        <br />
        Branch: <code className="text-[#e6edf3]">{report.branch}</code>
      </p>

      {/* The one action here that leaves this machine. Everything above
          is a local worktree the user can delete; this pushes a branch
          and opens a pull request. */}
      {url !== null ? (
        <p className="text-xs">
          <ExternalLink href={url} className="text-[#4493f8] hover:underline">
            {url}
          </ExternalLink>
        </p>
      ) : applied > 0 && describable ? (
        <button
          type="button"
          disabled={opening}
          onClick={open}
          className="rounded border border-[#238636]/40 px-3 py-1 text-xs text-[#3fb950] hover:bg-[#238636]/10 disabled:opacity-50"
        >
          {opening ? "Opening…" : "Push and open a pull request"}
        </button>
      ) : applied > 0 ? (
        // Said, not hidden. A missing button reads as a bug, where the
        // reason is a real limitation worth knowing.
        <p className="text-xs text-[#8b949e]">
          A pull request can only be opened for npm and yarn so far — the other
          ecosystems do not report which version actually landed.
        </p>
      ) : null}
      {report.results.map((r) => (
        <div key={r.name} className="rounded border border-[#30363d] p-2">
          <p className="text-[#e6edf3]">{r.name}</p>
          {r.error !== null ? (
            <p className="mt-1 whitespace-pre-wrap text-xs text-[#f85149]">{r.error}</p>
          ) : (
            <div className="mt-1 space-y-0.5 text-xs text-[#8b949e]">
              <p>
                Requested <code className="text-[#e6edf3]">{r.requested}</code>
                {r.resolved_constraint !== null && (
                  <>
                    , manifest now{" "}
                    <code className="text-[#e6edf3]">{r.resolved_constraint}</code>
                  </>
                )}
              </p>
              {/* Reported rather than hidden: a command that succeeded
                  and changed nothing usually means a manifest
                  constraint pinned the package below what was asked
                  for, which the user needs to know. */}
              <p>
                {r.changed_files.length > 0
                  ? `Changed: ${r.changed_files.join(", ")}`
                  : "No files changed."}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
