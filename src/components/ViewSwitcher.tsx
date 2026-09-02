import {
  Container,
  ChevronDown,
  Eye,
  FolderGit2,
  GitPullRequest,
  HardDrive,
  Package,
  FileText,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type View, useFilters } from "../store/filters";
import { useUiPrefs } from "../api/hooks";

const VIEWS: { id: View; label: string; Icon: typeof GitPullRequest }[] = [
  { id: "my-prs", label: "My pull requests", Icon: GitPullRequest },
  { id: "to-review", label: "To review", Icon: Eye },
  { id: "worktrees", label: "Worktrees", Icon: FolderGit2 },
  { id: "docker", label: "Docker", Icon: Container },
  { id: "artifacts", label: "Artifacts", Icon: HardDrive },
  { id: "packages", label: "Package updates", Icon: Package },
  { id: "claude-md", label: "CLAUDE.md", Icon: FileText },
];

/// The top-level view control, at the head of the sidebar.
///
/// Collapsed it names the CURRENT view; expanded it lists them all. It
/// replaces the "Awaiting your review" entry that was pinned to the
/// sidebar's bottom, which was a flat list masquerading as a peer of the
/// repo rows.
///
/// Stats deliberately stays pinned at the bottom rather than joining this
/// menu: it is a panel of My PRs, not a fourth view, and listing it here
/// would imply it has its own repo sidebar.
export function ViewSwitcher({ counts }: { counts?: Partial<Record<View, number>> }) {
  const { view, setView } = useFilters();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const { prefs } = useUiPrefs();
  // Two views are never hidden, whatever is stored:
  //
  // - "my-prs" is the default view and the app's whole premise. Hiding
  //   it would leave someone with no way back to what they installed
  //   this for.
  // - The CURRENT view, even when hidden, or the app would show a page
  //   its own switcher says does not exist -- with no way off it.
  const hidden = new Set(prefs?.hidden_views ?? []);
  const offered = VIEWS.filter(
    ({ id }) => id === "my-prs" || id === view || !hidden.has(id),
  );

  // Dismiss on Escape and on a click elsewhere. Without both, the menu
  // stays open behind whatever the user does next.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm font-semibold text-[#e6edf3] hover:bg-[#161b22]"
      >
        <current.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{current.label}</span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-[#30363d] bg-[#161b22] p-1 shadow-lg"
        >
          {offered.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              aria-current={id === view}
              onClick={() => {
                setView(id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${
                id === view ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#21262d]"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
              {counts?.[id] ? (
                <span className="ml-auto text-xs tabular-nums">{counts[id]}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
