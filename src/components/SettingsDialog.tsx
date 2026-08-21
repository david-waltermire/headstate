import { useState } from "react";
import { usePollInterval, useWorktreeDirs } from "../api/hooks";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const INTERVALS = [60, 120, 300, 900];

function intervalLabel(secs: number): string {
  return secs < 60 ? `${secs}s` : `${secs / 60} min`;
}

/// Settings.
///
/// Values live in SQLite on the Rust side rather than in the webview,
/// because the poll loop and the worktree scanner both read them and
/// neither can see `localStorage`. That also means a write can FAIL -- a
/// path that is not a directory is rejected -- so the error is shown
/// rather than swallowed.
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { seconds, set: setInterval } = usePollInterval();
  const { dirs, set: setDirs } = useWorktreeDirs();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `null` means "not edited", so the field renders the saved value
  // without an effect copying it into state. Seeding via useEffect meant
  // a setState inside an effect, which cascades renders -- and it fought
  // the query: whenever `dirs` refetched, an in-progress edit would be
  // silently overwritten.
  const value = draft ?? dirs.join("\n");

  const close = () => {
    setDraft(null);
    setError(null);
    onOpenChange(false);
  };

  const save = () => {
    const next = value
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);
    setDirs(next).then(
      () => close(),
      (e: unknown) => setError(typeof e === "string" ? e : "Could not save"),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Settings</DialogTitle>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="poll-interval" className="text-sm font-medium">
            Check GitHub every
          </label>
          <select
            id="poll-interval"
            value={seconds ?? 120}
            onChange={(e) => void setInterval(Number(e.target.value))}
            className="w-40 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 text-sm"
          >
            {INTERVALS.map((s) => (
              <option key={s} value={s}>
                {intervalLabel(s)}
              </option>
            ))}
          </select>
          <p className="text-xs text-[#8b949e]">
            Applies immediately. Shorter intervals use more of your GitHub rate limit.
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-1">
          <label htmlFor="worktree-dirs" className="text-sm font-medium">
            Directories to scan for repositories
          </label>
          <textarea
            id="worktree-dirs"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="~/code"
            className="rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 font-mono text-sm"
          />
          <p className="text-xs text-[#8b949e]">
            One path per line. Used to find git worktrees.
          </p>
          {error ? (
            <p role="alert" className="text-xs text-[#f85149]">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded bg-[#238636] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#2ea043]"
          >
            Save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
