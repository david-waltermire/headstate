import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Package } from "lucide-react";
import type {
  Bump,
  Ecosystem,
  EcosystemReport,
  Outdated,
  UpdateFilter,
} from "@/types/pr";
import { usePackages } from "@/api/hooks";
import { packagesMarkdown } from "@/api/tauri";
import { copyText } from "@/lib/clipboard";
import { useActiveFilters } from "@/store/filters";
import { HelpButton } from "./HelpButton";
import { UpdateWizard } from "./UpdateWizard";

const ECOSYSTEM_LABEL: Record<Ecosystem, string> = {
  npm: "npm",
  yarn: "Yarn",
  poetry: "Poetry",
  uv: "uv",
  dotnet: ".NET",
  cocoapods: "CocoaPods",
  swift: "Swift",
};

const BUMP_TONE: Record<Bump, string> = {
  patch: "bg-[#238636]/15 text-[#3fb950]",
  minor: "bg-[#d29922]/15 text-[#d29922]",
  major: "bg-[#f85149]/15 text-[#f85149]",
  // Deliberately NOT a severity colour. It is an absence of information
  // rather than a size of change, and red or green would assert
  // something the comparison could not determine.
  unknown: "bg-[#30363d] text-[#8b949e]",
};

const FILTERS: { id: UpdateFilter; label: string; hint: string }[] = [
  // "Patch" rather than "safe": patch-only is a fact about the version
  // numbers, where safety is a claim about consequences that nothing
  // here can check.
  { id: "patch", label: "Patch only", hint: "Third-component changes" },
  { id: "minor", label: "Patch and minor", hint: "No major versions" },
  { id: "all", label: "Everything", hint: "Including uncomparable versions" },
];

/// How rows are ordered within a group.
type Sort = "size" | "name";

const BUMP_RANK: Record<Bump, number> = { major: 0, minor: 1, patch: 2, unknown: 3 };

/// Outdated dependencies for the selected repository.
///
/// Grouped by PROJECT, because a repository can hold several and their
/// updates are separate work: different manifests, sometimes different
/// ecosystems, always a different command.
export function PackagesPage() {
  const filters = useActiveFilters();
  const repo = filters.repo;
  const { data: projects = [], isLoading, isError, error, refetch } = usePackages(repo);
  const [filter, setFilter] = useState<UpdateFilter>("minor");
  const [sort, setSort] = useState<Sort>("size");
  const [query, setQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const admits = useMemo(
    () => (o: Outdated) =>
      (filter === "all"
        ? true
        : filter === "minor"
          ? o.bump === "patch" || o.bump === "minor"
          : o.bump === "patch") &&
      (query.trim() === "" || o.name.toLowerCase().includes(query.trim().toLowerCase())),
    [filter, query],
  );

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
    [...r.outdated.filter(admits)].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : BUMP_RANK[a.bump] - BUMP_RANK[b.bump] || a.name.localeCompare(b.name),
    );

  const allOutdated = projects.flatMap((p) => p.reports.flatMap((r) => r.outdated));
  const total = projects.reduce(
    (n, p) => n + p.reports.reduce((m, r) => m + shown(r).length, 0),
    0,
  );

  // Counted so the UI can SAY what the filter hides. A list that
  // silently omits what nothing could classify looks complete when it is
  // not, and those are exactly the packages nobody can vouch for.
  const hidden = allOutdated.filter((o) => o.bump === "unknown" && filter !== "all").length;
  const failures = projects.flatMap((p) =>
    p.reports.filter((r) => r.error !== null).map((r) => ({ project: p.label, report: r })),
  );

  const buildMarkdown = () => packagesMarkdown(repo, projects, filter);

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

        <label className="flex items-center gap-1 text-xs text-[#8b949e]">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort updates"
            className="rounded border border-[#30363d] bg-[#161b22] px-1.5 py-0.5 text-xs text-[#e6edf3]"
          >
            <option value="size">Biggest jump</option>
            <option value="name">Name</option>
          </select>
        </label>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter packages by name"
          className="w-40 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 text-xs text-[#e6edf3] placeholder:text-[#6e7681]"
        />

        <HelpButton topic="package-updates" />

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={total === 0}
            onClick={() => {
              void buildMarkdown().then(
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
            className="rounded border border-[#30363d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
          >
            Copy markdown
          </button>

          {/* Distinct from Copy markdown, which is a REPORT. This is an
              INSTRUCTION: what to do, where, and how to check it
              afterwards. */}
          {/* Applies the updates HERE rather than handing them off.
              Distinct from Claudify, which delegates the work to an
              agent; this does it in a worktree and shows what actually
              landed. */}
          <button
            type="button"
            disabled={total === 0}
            onClick={() => setWizardOpen(true)}
            className="rounded border border-[#238636]/40 px-2 py-1 text-xs text-[#3fb950] hover:bg-[#238636]/10 disabled:opacity-50"
          >
            Update in worktree
          </button>

          <button
            type="button"
            disabled={total === 0}
            onClick={() => {
              void buildMarkdown().then(
                async (md) => {
                  const failure = await copyText(claudifyPrompt(repo, md));
                  if (failure !== null) {
                    toast.error("Could not copy the prompt", { description: failure });
                    return;
                  }
                  toast.success("Prompt copied to the clipboard", {
                    description: "Paste it into Claude Code in this repository.",
                  });
                },
                (e: unknown) =>
                  toast.error("Could not build the prompt", {
                    description: typeof e === "string" ? e : undefined,
                  }),
              );
            }}
            className="flex items-center gap-1 rounded border border-[#8957e5]/40 px-2 py-1 text-xs text-[#a371f7] hover:bg-[#8957e5]/10 disabled:opacity-50"
          >
            Claudify
          </button>
        </div>
      </div>

      {/* A tool that could not run is STATED. An empty list where the
          check failed reads as "you are up to date", which is the worst
          available answer because nobody investigates good news. */}
      {failures.map(({ project, report }) => (
        <p key={`${project}-${report.ecosystem}`} className="mb-2 text-sm text-[#d29922]">
          {project ? `${project}: ` : ""}
          {ECOSYSTEM_LABEL[report.ecosystem]}: {report.error}
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

      {projects.map((project) => {
        const rows = project.reports.map((r) => [r, shown(r)] as const);
        const count = rows.reduce((n, [, list]) => n + list.length, 0);
        if (count === 0) return null;
        const isCollapsed = collapsed.has(project.path);

        return (
          <section key={project.path} className="mb-4">
            {/* Only a repository with SEVERAL projects gets headings. A
                single-project repo should not grow a level of nesting
                that says nothing. */}
            {projects.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(project.path)) next.delete(project.path);
                    else next.add(project.path);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                className="mb-2 flex w-full items-center gap-2 text-left text-sm font-semibold text-[#e6edf3]"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${
                    isCollapsed ? "" : "rotate-90"
                  }`}
                  aria-hidden="true"
                />
                {project.label || "repository root"}
                <span className="font-normal text-[#8b949e]">{count}</span>
              </button>
            ) : null}

            {isCollapsed
              ? null
              : rows.map(([report, list]) =>
                  list.length === 0 ? null : (
                    <div key={report.ecosystem} className="mb-3">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8b949e]">
                        {ECOSYSTEM_LABEL[report.ecosystem]}
                      </h3>
                      <ul className="flex flex-col gap-1">
                        {list.map((o) => (
                          <li
                            key={`${report.ecosystem}-${o.name}`}
                            className="flex items-center gap-3 rounded border border-[#30363d] px-3 py-2 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e6edf3]">
                              {o.name}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-[#8b949e]">
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
                    </div>
                  ),
                )}
          </section>
        );
      })}

      <UpdateWizard
        repo={repo}
        packages={allOutdated}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
      />
    </div>
  );
}

/// The prompt handed to Claude Code.
///
/// Carries what an agent cannot cheaply rediscover: which repository,
/// which manifests, the exact version pairs, and -- the part that makes
/// the result trustworthy -- an instruction to verify rather than to
/// assume. The update table itself is the markdown already built for the
/// active filter, so the two buttons cannot disagree about what is being
/// asked for.
function claudifyPrompt(repo: string, markdown: string): string {
  return `Update the dependencies listed below in ${repo}.

${markdown}

Work through them one manifest at a time, using the command shown for
that ecosystem. After each manifest:

- report the version the resolver ACTUALLY chose, which may differ from
  the one requested
- run that project's own tests
- stop and say so if anything fails, rather than continuing

Do not update anything that is not listed here.`;
}
