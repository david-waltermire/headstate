import { useState } from "react";
import {
  useAutostart,
  useNotifyPrefs,
  usePollInterval,
  useUiPrefs,
  useWorktreeDirs,
} from "../api/hooks";
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
  const { prefs: ui, set: setUi } = useUiPrefs();
  const { enabled: autostart, set: setAutostart } = useAutostart();
  const [autostartError, setAutostartError] = useState<string | null>(null);
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
      {/* The dialog caps its own height at the viewport, and this
          splits it so the BODY scrolls while the buttons stay put.
          Without it a tall settings list pushed OK and Cancel below the
          window edge on an unmaximised window -- not merely hard to
          reach, invisible and unclickable. */}
      <DialogContent className="flex max-w-lg flex-col">
        <DialogTitle>Settings</DialogTitle>

        {/* The scrolling region. `min-h-0` is load-bearing: a flex child
            defaults to min-height:auto and refuses to shrink below its
            content, so without it the body pushes the footer out of the
            dialog instead of scrolling -- which is the bug. */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
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

        {/* Half the top-level navigation is irrelevant to a PR-only
            user, and both of these lead to an empty screen on first run
            -- Worktrees needs scan directories, Docker needs a running
            daemon. "My pull requests" is deliberately absent: it is the
            default view and the app's premise, so hiding it would leave
            someone with no way back. */}
        <div className="mt-5 flex flex-col gap-2">
          <span className="text-sm font-medium">Views</span>
          {[
            { id: "to-review", label: "To review" },
            { id: "worktrees", label: "Worktrees" },
            { id: "docker", label: "Docker" },
          ].map(({ id, label }) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!(ui?.hidden_views ?? []).includes(id)}
                onChange={() => {
                  if (!ui) return;
                  const hidden = ui.hidden_views.includes(id)
                    ? ui.hidden_views.filter((v) => v !== id)
                    : [...ui.hidden_views, id];
                  void setUi({ ...ui, hidden_views: hidden });
                }}
              />
              {label}
            </label>
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <span className="text-sm font-medium">Window</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ui?.close_hides_to_tray ?? true}
              onChange={() =>
                ui && void setUi({ ...ui, close_hides_to_tray: !ui.close_hides_to_tray })
              }
            />
            Closing the window hides it to the tray
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autostart}
              onChange={() => {
                setAutostartError(null);
                // Unlike every other setting here this one touches the
                // filesystem and can genuinely fail, so the error is
                // shown rather than swallowed.
                void setAutostart(!autostart).catch((e: unknown) =>
                  setAutostartError(typeof e === "string" ? e : "Could not change this"),
                );
              }}
            />
            Start Headstate at login
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ui?.announce_updates ?? true}
              onChange={() =>
                ui && void setUi({ ...ui, announce_updates: !ui.announce_updates })
              }
            />
            Tell me when a new version is available
          </label>
          {/* Off by default and phrased for the situation it exists
              for. "Diagnostic logging" alone invites people to turn it
              on speculatively; naming the cost and the use makes it a
              tool you reach for when asked. */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ui?.diagnostic_logging ?? false}
              onChange={() =>
                ui && void setUi({ ...ui, diagnostic_logging: !ui.diagnostic_logging })
              }
            />
            Write a detailed timing log (for diagnosing slowness)
          </label>
          {ui?.diagnostic_logging ? (
            <p className="text-xs text-[#8b949e]">
              Records how long each GitHub request takes. Counts and timings only —
              never repository names, titles, or tokens.
            </p>
          ) : null}
          {autostartError ? (
            <p role="alert" className="text-xs text-[#f85149]">
              {autostartError}
            </p>
          ) : null}
        </div>

        {/* Every one of these already worked and none was mentioned
            anywhere in the UI. Escape is the notable one: it hides the
            whole window to the tray, which is genuinely surprising the
            first time someone presses it to dismiss a menu. */}
        <div className="mt-5 flex flex-col gap-1">
          <span className="text-sm font-medium">Keyboard</span>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[#8b949e]">
            {[
              ["j / k", "Move down / up the list"],
              ["Enter", "Open the highlighted pull request"],
              ["x", "Select the highlighted pull request"],
              ["/", "Search"],
              ["Esc", "Hide the window to the tray"],
            ].map(([keys, what]) => (
              <div key={keys} className="contents">
                <dt className="font-mono text-[#e6edf3]">{keys}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>

        </div>

        {/* Outside the scrolling region, so OK and Cancel are always
            reachable however long the list grows. */}
        <div className="mt-5 flex shrink-0 justify-end gap-2">
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
