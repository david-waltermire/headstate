import { useState } from "react";
import { toast } from "sonner";
import { Package } from "lucide-react";
import type { Bump, Ecosystem, EcosystemReport, UpdateFilter } from "@/types/pr";
import { usePackages } from "@/api/hooks";
import { packagesMarkdown } from "@/api/tauri";
import { copyText } from "@/lib/clipboard";
import { useActiveFilters } from "@/store/filters";
import { HelpButton } from "./HelpButton";

/// Shown as the section heading for each ecosystem's rows.
const ECOSYSTEM_LABEL: Record<Ecosystem, string> = {
  npm: "npm",
  yarn: "Yarn",
  poetry: "Poetry",
  uv: "uv",
  dotnet: ".NET",
};

const BUMP_TONE: Record<Bump, string> = {
  patch: "bg-[#238636]/15 text-[#3fb950]",
  minor: "bg-[#d29922]/15 text-[#d29922]",
  major: "bg-[#f85149]/15 text-[#f85149]",
  // Deliberately NOT styled as a severity. It is an absence of
  // information, not a size of change, and colouring it red or green
  // would assert something the comparison could not determine.
  unknown: "bg-[#30363d] text-[#8b949e]",
};

const FILTERS: { id: UpdateFilter; label: string; hint: string }[] = [
  // "Patch" rather than "safe". Patch-only is a fact about the version
  // numbers; "safe" is a claim about consequences that nothing here can
  // check, and the codebase does not present guesses as facts.
  { id: "patch", label: "Patch only", hint: "Third-component changes" },
  { id: "minor", label: "Patch and minor", hint: "No major versions" },
  { id: "all", label: "Everything", hint: "Including uncomparable versions" },
];

/// Outdated dependencies for the selected repository.
///
/// Reports only. The markdown button is the deliverable: it carries
/// enough that an agent can act without rediscovering the manifest or
/// the update command.
export function PackagesPage() {
  const filters = useActiveFilters();
  const repo = filters.repo;
  const { data: reports = [], isLoading, isError, error, refetch } = usePackages(repo);
  const [filter, setFilter] = useState<UpdateFilter>("minor");

  if (!repo) {
    return (
      <p className="p-4 text-sm text-[#8b949e]">
        Choose a repository to see what is out of date.
      </p>
    );
  }
  if (isLoading) {
    return <p className="p-4 text-sm text-[#8b949e]">Asking each package manager…</p>;
  }
  if (isError) {
    return (
      <div className="p-4">
        <p className="text-sm text-[#f85149]">
          Could not check this repository: {String(error)}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-2 rounded border border-[#30363d] px-2 py-1 text-xs hover:bg-[#161b22]"
        >
          Try again
        </button>
      </div>
    );
  }

  const shown = (r: EcosystemReport) =>
    r.outdated.filter((o) =>
      filter === "all"
        ? true
        : filter === "minor"
          ? o.bump === "patch" || o.bump === "minor"
          : o.bump === "patch",
    );

  // Counted so the UI can SAY what the filter is hiding. A list that
  // silently omits what nothing could classify looks complete when it is
  // not, and those are precisely the packages nobody can vouch for.
  const hidden = reports
    .flatMap((r) => r.outdated)
    .filter((o) => o.bump === "unknown" && filter !== "all").length;

  const total = reports.reduce((n, r) => n + shown(r).length, 0);
  const failures = reports.filter((r) => r.error !== null);

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Package className="h-4 w-4 shrink-0 text-[#8b949e]" aria-hidden="true" />
        <span className="font-semibold text-[#e6edf3]">
          {total} update{total === 1 ? "" : "s"}
        </span>

        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              title={f.hint}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === f.id
                  ? "border-[#1f6feb] bg-[#1f6feb]/15 text-[#58a6ff]"
                  : "border-[#30363d] text-[#8b949e] hover:bg-[#161b22]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <HelpButton topic="package-updates" />

        <button
          type="button"
          disabled={total === 0}
          onClick={() => {
            void packagesMarkdown(repo, reports, filter).then(
              async (md) => {
                const failure = await copyText(md);
                if (failure !== null) {
                  toast.error("Could not copy the summary", { description: failure });
                  return;
                }
                toast.success("Markdown copied to the clipboard", {
                  description: "Paste it into a Claude session to do the updates.",
                });
              },
              (e: unknown) =>
                toast.error("Could not build the summary", {
                  description: typeof e === "string" ? e : undefined,
                }),
            );
          }}
          className="ml-auto rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
        >
          Copy markdown
        </button>
      </div>

      {/* A tool that could not run is STATED. An empty list where the
          check failed reads as "you are up to date", which is the worst
          available answer because nobody investigates good news. */}
      {failures.map((r) => (
        <p key={r.ecosystem} className="mb-2 text-sm text-[#d29922]">
          {ECOSYSTEM_LABEL[r.ecosystem]}: {r.error}
        </p>
      ))}

      {hidden > 0 ? (
        <p className="mb-2 text-xs text-[#8b949e]">
          {hidden} package{hidden === 1 ? "" : "s"} had versions this could not compare and{" "}
          {hidden === 1 ? "is" : "are"} hidden by this filter.
        </p>
      ) : null}

      {total === 0 && failures.length === 0 ? (
        <p className="text-sm text-[#8b949e]">Nothing matches this filter.</p>
      ) : null}

      {reports.map((r) =>
        shown(r).length === 0 ? null : (
          <section key={r.ecosystem} className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8b949e]">
              {ECOSYSTEM_LABEL[r.ecosystem]}
            </h3>
            <ul className="flex flex-col gap-1">
              {shown(r).map((o) => (
                <li
                  key={`${r.ecosystem}-${o.name}`}
                  className="flex items-center gap-3 rounded border border-[#30363d] px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e6edf3]">
                    {o.name}
                  </span>
                  <span className="shrink-0 text-xs text-[#8b949e] tabular-nums">
                    {o.current} → {o.latest}
                  </span>
                  <span
                    className={`w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-xs ${BUMP_TONE[o.bump]}`}
                  >
                    {o.bump}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}
