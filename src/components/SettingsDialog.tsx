import { useState } from "react";
import { toast } from "sonner";
import { revealLog } from "@/api/tauri";
import { HelpButton } from "./HelpButton";
import {
  useAutostart,
  useNotifyPrefs,
  usePollInterval,
  useCleanupPrefs,
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
/// The left rail's topics, in the order shown.
///
/// Grouped by what a setting is ABOUT rather than by which struct it
/// lives in: "General" holds the poll interval, window behaviour and
/// keyboard notes, which come from three preference sources and are one
/// subject to a person.
const SECTIONS = [
  { id: "general", label: "General" },
  { id: "repositories", label: "Repositories" },
  { id: "notifications", label: "Notifications" },
  { id: "cleanup", label: "Cleanup" },
  { id: "views", label: "Views" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

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
  const { prefs: cleanup, set: setCleanup } = useCleanupPrefs();
  const { enabled: autostart, set: setAutostart } = useAutostart();
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("general");
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
      {/* FIXED in both dimensions, like macOS System Settings.
          Only the content pane scrolls.

          Width: `max-w-lg` was 32rem, chosen when this was one column.
          The topic menu then took 9rem of it and left ~20rem for
          controls, which squeezed every row -- the poll-interval label
          and its select, the cleanup granularity rows. `max-w-3xl`
          gives the content pane roughly the width it had before the
          menu existed.

          Height: the dialog had a max but no fixed height, so it sized
          to whichever topic was showing and jumped on every switch --
          moving the window under the cursor, so the topic just clicked
          could end up somewhere else. `h-[32rem]` holds it still.

          Sizing to the tallest topic would also stop the jumping, but
          pads every short topic with dead space and changes again the
          moment a setting is added. A fixed frame does not. */}
      {/* `sm:max-w-3xl` as well as `max-w-3xl`: the base
          `DialogContent` carries `sm:max-w-sm`, and tailwind-merge
          treats a responsive variant as a different key -- so a bare
          `max-w-3xl` loses to it above 640px and the dialog would come
          out NARROWER than the 32rem it started at. Verified against
          twMerge rather than assumed. */}
      <DialogContent className="flex h-[32rem] max-w-3xl flex-col sm:max-w-3xl">
        <DialogTitle>Settings</DialogTitle>

        {/* TWO PANES: topics on the left, the chosen one on the right.

            This was ~445 lines of continuous scroll with seven groups
            separated by hairlines, and it kept growing -- a log button,
            a notification toggle and a cleanup opt-in all landed in it
            recently.

            Every control is preserved verbatim; only where it lives
            changed. The existing tests assert specific labels and keep
            passing rather than being rewritten to match a new layout --
            a reorganisation that hides a control is a regression. */}
        <div className="-mx-1 flex min-h-0 flex-1 gap-4 overflow-hidden px-1">
          <nav
            aria-label="Settings sections"
            className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-[#30363d] pr-2"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={section === s.id ? "page" : undefined}
                onClick={() => setSection(s.id)}
                className={`rounded px-2 py-1 text-left text-sm ${
                  section === s.id
                    ? "bg-[#1f6feb] text-white"
                    : "text-[#e6edf3] hover:bg-[#21262d]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          {/* `min-h-0` is load-bearing here as it was on the old
              scroller: a flex child defaults to min-height:auto and
              refuses to shrink below its content, so without it the
              panel pushes the footer out instead of scrolling. */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {/* Rendered always, hidden with CSS -- never unmounted and
                never the `hidden` ATTRIBUTE.
                Unmounting loses a control's state on every tab switch.
                The `hidden` attribute additionally removes the panel
                from the accessibility tree, so a screen reader cannot
                reach a setting until the right topic is clicked -- the
                existing tests caught exactly that, by failing to find
                controls by role. */}
            <div className={section === "general" ? "" : "hidden"}>
        <div className="mt-4 flex flex-col gap-1">
          <div className="flex items-center">
            <label htmlFor="poll-interval" className="text-sm font-medium">
              Check GitHub every
            </label>
            {/* Outside the label, for the same reason as above. */}
            <HelpButton topic="poll-interval" />
          </div>
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
          {/* This log is meant to be SENT to someone, so what it
              contains has to be checkable rather than trusted. */}
          <span className="-mt-1 self-start">
            <HelpButton topic="diagnostic-log" />
          </span>
          {ui?.diagnostic_logging ? (
            <>
              {/* "GitHub requests" was accurate until local scans were
                  instrumented too. A user reading the old text had no
                  reason to think this would help with a hanging
                  Virtualenvs page, which is now what it is for. */}
              <p className="text-xs text-[#8b949e]">
                Records how long GitHub requests and local scans take. Counts and
                timings only — never repository names, titles, or tokens.
              </p>
              {/* Where the file IS. Without this the path has to be
                  passed on out of band, which is the friction the
                  checkbox exists to remove. */}
              <button
                type="button"
                onClick={() => {
                  void revealLog().then(
                    (path) => toast.success("Showed the log", { description: path }),
                    (e: unknown) =>
                      toast.error("Could not show the log", {
                        description: typeof e === "string" ? e : undefined,
                      }),
                  );
                }}
                className="self-start rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#e6edf3] hover:bg-[#21262d]"
              >
                Show the log
              </button>
            </>
          ) : null}
          {autostartError ? (
            <p role="alert" className="text-xs text-[#f85149]">
              {autostartError}
            </p>
          ) : null}
        </div>

        {/* Automatic cleanup, which in this build cannot remove
            anything. Presented as what it IS -- a report of what would
            be removed -- rather than as a feature with the acting half
            greyed out, because a switch that suggests it might delete is
            exactly the thing to avoid understating. */}
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
            {/* Rendered always, hidden with CSS -- never unmounted and
                never the `hidden` ATTRIBUTE.
                Unmounting loses a control's state on every tab switch.
                The `hidden` attribute additionally removes the panel
                from the accessibility tree, so a screen reader cannot
                reach a setting until the right topic is clicked -- the
                existing tests caught exactly that, by failing to find
                controls by role. */}
            <div className={section === "repositories" ? "" : "hidden"}>
        <div className="mt-5 flex flex-col gap-1">
          <div className="flex items-center">
            <label htmlFor="worktree-dirs" className="text-sm font-medium">
              Directories to scan for repositories
            </label>
            {/* OUTSIDE the label: a button nested inside one joins its
                accessible name, so the field would announce as
                "Directories to scan for repositories About scanned
                directories".
                
                Feeds Docker provenance too, which is not guessable from
                a setting that reads as being about worktrees -- and is
                the first thing to check when provenance is empty. */}
            <HelpButton topic="scanned-dirs" />
          </div>
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
            </div>
            {/* Rendered always, hidden with CSS -- never unmounted and
                never the `hidden` ATTRIBUTE.
                Unmounting loses a control's state on every tab switch.
                The `hidden` attribute additionally removes the panel
                from the accessibility tree, so a screen reader cannot
                reach a setting until the right topic is clicked -- the
                existing tests caught exactly that, by failing to find
                controls by role. */}
            <div className={section === "notifications" ? "" : "hidden"}>
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!(prefs?.enabled ?? true)}
                checked={prefs?.ready_to_review ?? true}
                onChange={() =>
                  prefs && void setPrefs({ ...prefs, ready_to_review: !prefs.ready_to_review })
                }
              />
              A pull request becomes ready for your review
            </label>
          </div>
          {/* "newly breaks" was accurate while every notification was
              breakage. The ready-to-review one is good news, so the
              wording is about the TRANSITION rather than the direction. */}
          <p className="text-xs text-[#8b949e]">
            Only when something newly changes — never repeated for a pull request
            already in that state, and never on first launch.
          </p>
        </div>

            </div>
            {/* Rendered always, hidden with CSS -- never unmounted and
                never the `hidden` ATTRIBUTE.
                Unmounting loses a control's state on every tab switch.
                The `hidden` attribute additionally removes the panel
                from the accessibility tree, so a screen reader cannot
                reach a setting until the right topic is clicked -- the
                existing tests caught exactly that, by failing to find
                controls by role. */}
            <div className={section === "cleanup" ? "" : "hidden"}>
        <div className="flex flex-col gap-2 border-t border-[#30363d] pt-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[#e6edf3]">Automatic cleanup</h3>
            <HelpButton topic="auto-cleanup" />
          </div>
          <p className="text-xs text-[#8b949e]">
            Reports what it would reclaim. This build never removes anything
            automatically — you review the list and act on it yourself.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cleanup?.enabled ?? false}
              onChange={() =>
                cleanup && void setCleanup({ ...cleanup, enabled: !cleanup.enabled })
              }
            />
            Report what could be reclaimed
          </label>
          {cleanup?.enabled ? (
            <>
              <label className="ml-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cleanup.artifacts}
                  onChange={() =>
                    void setCleanup({ ...cleanup, artifacts: !cleanup.artifacts })
                  }
                />
                Build output
              </label>
              <label className="ml-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cleanup.venvs}
                  onChange={() => void setCleanup({ ...cleanup, venvs: !cleanup.venvs })}
                />
                Orphaned virtualenvs
              </label>
              {/* Beside the orphan toggle, not in its own section.
                  It used to gate MANUAL removal too, which was wrong --
                  ticking a row and confirming a dialog is already the
                  user's intent. Unattended deletion is different: a
                  staleness threshold is a guess, and a guess is not
                  something the app should act on by itself. */}
              <label className="ml-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cleanup.venvs_stale}
                  disabled={!cleanup.venvs}
                  onChange={() =>
                    void setCleanup({ ...cleanup, venvs_stale: !cleanup.venvs_stale })
                  }
                />
                Stale virtualenvs, whose projects still exist
              </label>
            </>
          ) : null}
        </div>

        {/* Every one of these already worked and none was mentioned
            anywhere in the UI. Escape is the notable one: it hides the
            whole window to the tray, which is genuinely surprising the
            first time someone presses it to dismiss a menu. */}
            </div>
            {/* Rendered always, hidden with CSS -- never unmounted and
                never the `hidden` ATTRIBUTE.
                Unmounting loses a control's state on every tab switch.
                The `hidden` attribute additionally removes the panel
                from the accessibility tree, so a screen reader cannot
                reach a setting until the right topic is clicked -- the
                existing tests caught exactly that, by failing to find
                controls by role. */}
            <div className={section === "views" ? "" : "hidden"}>
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

            </div>
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
