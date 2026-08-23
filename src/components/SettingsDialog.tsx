import { useState } from "react";
import { useNotifyPrefs, usePollInterval, useWorktreeDirs } from "../api/hooks";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// Matches the backend's own range: `clamp_interval` allows 60s..3600s
/// (`poll.rs`), and the UI previously stopped at 900 -- so a user who
/// wanted a half-hour cadence to conserve rate limit could not pick one
/// even though the backend would have accepted it.
const INTERVALS = [60, 120, 300, 900, 1800, 3600];

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
  const { prefs, set: setPrefs } = useNotifyPrefs();
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

        {/* Notifications had no off switch anywhere in the app -- the
            only escape was denying permission at the OS level, which the
            poll loop treats as permanent. Nothing in the UI even said
            the app sent them. */}
        <div className="mt-5 flex flex-col gap-2">
          <span className="text-sm font-medium">Notifications</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs?.enabled ?? true}
              onChange={() =>
                prefs && void setPrefs({ ...prefs, enabled: !prefs.enabled })
              }
            />
            Desktop notifications
          </label>
          {/* Nested and disabled rather than hidden when the master
              switch is off: hiding them would make the choices look
              lost, and they are deliberately preserved so turning
              notifications back on restores what was picked. */}
          <div className="ml-6 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!(prefs?.enabled ?? true)}
                checked={prefs?.ci_failed ?? true}
                onChange={() =>
                  prefs && void setPrefs({ ...prefs, ci_failed: !prefs.ci_failed })
                }
              />
              CI starts failing
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!(prefs?.enabled ?? true)}
                checked={prefs?.conflicted ?? true}
                onChange={() =>
                  prefs && void setPrefs({ ...prefs, conflicted: !prefs.conflicted })
                }
              />
              Merge conflicts appear
            </label>
          </div>
          <p className="text-xs text-[#8b949e]">
            Only when a pull request newly breaks — never repeated for one that
            was already broken, and never on first launch.
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
