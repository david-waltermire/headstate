import { useState } from "react";
import { FileText } from "lucide-react";
import type { ClaudeFile, ImportNode } from "@/types/pr";
import { useClaudeMd, useClaudeMdText } from "@/api/hooks";
import { useActiveFilters } from "@/store/filters";
import { formatSize } from "@/lib/worktrees";
import { Markdown } from "./Markdown";

/// Token counts are an ESTIMATE, and every label says so.
///
/// The backend divides characters by four. That is the standard rough
/// figure for English prose and it is wrong for code blocks and paths,
/// which these files are full of. A number labelled "tokens" that is
/// actually chars/4 is exactly the confidently-wrong figure this app
/// refuses to ship, so the word "est." travels with it everywhere.
function tokenLabel(n: number): string {
  return `~${n.toLocaleString()} est. tokens`;
}

/// CLAUDE.md files for the selected repository.
///
/// Read-only: a wrong render costs a confused reader rather than a
/// corrupted config file.
export function ClaudeMdPage() {
  const filters = useActiveFilters();
  const repo = filters.repo;
  const { data: files = [], isLoading } = useClaudeMd(repo);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // The selection falls back to the first file so the pane is never
  // empty when there is something to show.
  const active = files.find((f) => f.path === selected) ?? files[0];
  const { data: text, isLoading: textLoading } = useClaudeMdText(active?.path);

  if (!repo) {
    return (
      <p className="p-4 text-sm text-[#8b949e]">
        Choose a repository to see its CLAUDE.md files.
      </p>
    );
  }
  if (isLoading) {
    return <p className="p-4 text-sm text-[#8b949e]">Looking for CLAUDE.md files…</p>;
  }
  if (files.length === 0) {
    return <p className="p-4 text-sm text-[#8b949e]">No CLAUDE.md files in this repository.</p>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* The browser: every file, its own size, and what its whole tree
          costs. */}
      <div className="w-96 shrink-0 overflow-y-auto border-r border-[#30363d] p-3">
        {files.map((f) => (
          <FileEntry
            key={f.path}
            file={f}
            active={f.path === active?.path}
            onSelect={() => setSelected(f.path)}
          />
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {textLoading ? (
          <p className="text-sm text-[#8b949e]">Reading…</p>
        ) : text !== undefined ? (
          // Through the SAME sanitising renderer the rest of the app
          // uses. These files come off disk, and one containing raw HTML
          // must not be able to inject anything here.
          <Markdown>{text}</Markdown>
        ) : null}
      </div>
    </div>
  );
}

function FileEntry({
  file,
  active,
  onSelect,
}: {
  file: ClaudeFile;
  active: boolean;
  onSelect: () => void;
}) {
  // Only worth stating separately when the tree adds something. On a
  // file with no imports the two numbers are equal and printing both
  // reads as a mistake.
  const treeAdds = file.total_tokens > file.tokens;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left ${
          active ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
        }`}
      >
        <span className="flex w-full items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        </span>
        <span className={`text-xs ${active ? "text-white/80" : "text-[#8b949e]"}`}>
          {formatSize(file.bytes)} · {tokenLabel(file.tokens)}
          {treeAdds ? ` · ${tokenLabel(file.total_tokens)} with imports` : ""}
        </span>
      </button>
      {file.imports.length > 0 ? (
        <ul className="ml-4 mt-1 border-l border-[#30363d] pl-2">
          {file.imports.map((n, i) => (
            <ImportRow key={`${n.raw}-${i}`} node={n} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ImportRow({ node }: { node: ImportNode }) {
  return (
    <li className="text-xs">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[#8b949e]">{node.raw}</span>
        {/* A broken or circular import is NAMED. Dropping it makes the
            tree look complete when it is not, and a cycle is a bug in
            the user's own config that nothing else will surface. */}
        {node.problem ? (
          <span className="rounded-full bg-[#f85149]/15 px-2 py-0.5 text-[#f85149]">
            {node.problem}
          </span>
        ) : (
          <span className="text-[#8b949e]">{tokenLabel(node.tokens)}</span>
        )}
      </span>
      {node.children.length > 0 ? (
        <ul className="ml-3 border-l border-[#30363d] pl-2">
          {node.children.map((c, i) => (
            <ImportRow key={`${c.raw}-${i}`} node={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
