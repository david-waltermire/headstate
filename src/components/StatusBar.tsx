import { ExternalLink } from "./ExternalLink";
import { getVersion } from "@tauri-apps/api/app";
import { latestRelease } from "../api/tauri";
import { UpdateDialog } from "./UpdateDialog";
import { useUiPrefs } from "../api/hooks";
import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { usePollError, usePollInterval, usePollState, useRemovalProgress } from "../api/hooks";
import { relativeTime } from "../lib/time";
import { SettingsDialog } from "./SettingsDialog";

const CHOICES = [60, 120, 300, 900];

function label(secs: number): string {
  return secs < 60 ? `${secs}s` : `${secs / 60}m`;
}

/// A thin strip along the bottom: what the app is doing, and when it last
/// heard from GitHub.
///
/// Deliberately quiet. The window is small and the list is the point, so
/// this is one line of muted text, not a second header.
///
/// It used to know only "fetching" and "Up to date", on the reasoning
/// that errors go to the banner. That holds only while a banner actually
/// appears -- and in #190 none did, so this line confidently asserted
/// everything was fine while both PR views sat empty. A status bar that
/// can only ever say "fine" is not a status bar.
///
/// It still shows STATE, not messages: the banner keeps the detail and
/// the retry. This just stops claiming success it cannot vouch for.
/// How often to re-ask GitHub for the newest release.
///
/// Daily. Releases ship every few days at most, and the request is one
/// unauthenticated call -- so this is far below any rate concern while
/// still being fast enough that nobody sits three versions behind.
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

export function StatusBar({ updatedAt }: { updatedAt: number }) {
  const state = usePollState();
  const pollError = usePollError();

  // "Never succeeded" and "stale after a failure" are different. A green
  // dot beside "Updated 3 hours ago" is defensible; a green dot with no
  // successful fetch at all is not.
  const status = pollError
    ? updatedAt > 0
      ? ("stale" as const)
      : ("failed" as const)
    : state === "fetching"
      ? ("fetching" as const)
      // A suppressed transient failure emits neither poll-error nor
      // prs-updated, so without this the bar showed a green "Up to date"
      // beside a stale timestamp -- the exact bug #191 was written to
      // eliminate, at smaller scale.
      : state === "retrying"
        ? ("retrying" as const)
        : ("ok" as const);

  const DOT = {
    fetching: "bg-[#58a6ff]",
    ok: "bg-[#3fb950]",
    retrying: "bg-[#d29922]",
    stale: "bg-[#d29922]",
    failed: "bg-[#f85149]",
  } as const;

  const TEXT = {
    fetching: "Checking GitHub…",
    ok: "Up to date",
    retrying: "Retrying…",
    stale: "Could not refresh",
    failed: "Could not reach GitHub",
  } as const;
  const { seconds, set } = usePollInterval();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // From the built binary, not package.json: the release workflow stamps
  // the version from the git tag at build time and never commits it, so
  // the repo reads 0.1.0 while a release reads 2.0.1. Asking Tauri gets
  // the number the user actually installed -- which is the whole point of
  // showing it, since it is what they would quote in a bug report.
  const [version, setVersion] = useState<string | null>(null);
  const [newer, setNewer] = useState<string | null>(null);
  const { prefs: ui } = useUiPrefs();
  // Subscribed here, not only on the Worktrees page, so the count
  // survives navigating away from it.
  const removal = useRemovalProgress();
  // Which version's announcement has been dismissed. localStorage, not
  // the settings table: it is a transient acknowledgement of one
  // release, not a preference, and it is meaningless on another machine.
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem("headstate-update-dismissed"),
  );
  useEffect(() => {
    if (dismissed !== null) localStorage.setItem("headstate-update-dismissed", dismissed);
  }, [dismissed]);
  useEffect(() => {
    let live = true;
    getVersion().then(
      (v) => live && setVersion(v),
      // Non-fatal: a missing version line is better than a broken bar.
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // At startup, then daily, and whenever the window is shown again.
  //
  // This used to run ONCE per mount, which is wrong for an app that
  // hides to the tray instead of quitting (`lib.rs` intercepts
  // CloseRequested and calls `window.hide()`). A machine left running
  // never asked again: it took one release and then stayed on it while
  // two more shipped, with no way for the user to discover them.
  //
  // The visibility trigger matters as much as the timer: a laptop asleep
  // for a week should learn about an update when its owner comes back to
  // it, not up to a day later.
  //
  // A failure is silent: a missing update hint is better than a broken
  // status bar, and the app works perfectly well without knowing.
  useEffect(() => {
    let live = true;
    const ask = () =>
      latestRelease().then(
        (v) => live && setNewer(v),
        () => {},
      );

    void ask();
    const timer = setInterval(() => void ask(), UPDATE_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <>
    {/* Per VERSION, not per launch: nagging about a release someone has
        already declined is how a notice trains people to dismiss it
        unread. `announce_updates` turns the dialog off entirely without
        touching the status-bar hint, which stays either way. */}
    {newer && (ui?.announce_updates ?? true) ? (
      <UpdateDialog
        version={newer}
        open={dismissed !== newer}
        onDismiss={() => setDismissed(newer)}
      />
    ) : null}
    <div className="flex shrink-0 items-center gap-3 border-t border-[#30363d] bg-[#0d1117] px-4 py-1.5 text-xs text-[#8b949e]">
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} aria-hidden="true" />
        <span className={status === "failed" ? "text-[#f85149]" : undefined}>
          {TEXT[status]}
        </span>
      </span>

      {/* `dataUpdatedAt`, not `isFetching`: the tray path advances the
          former on both routes but never flips the latter. */}
      {updatedAt > 0 ? (
        <span>Updated {relativeTime(new Date(updatedAt).toISOString())}</span>
      ) : null}

      {/* Bulk worktree removal reported progress only on the Worktrees
          page's own button -- but the work runs on the backend and
          outlives that page, so navigating away made a running batch
          look like it had stopped. The status bar is the surface that
          persists across views, which makes it the honest place for
          work that does. */}
      {removal ? (
        <span className="text-[#58a6ff]">
          Removing worktrees — {removal.done} of {removal.total}
        </span>
      ) : null}

      <label className="ml-auto flex items-center gap-1.5">
        <span>Check every</span>
        <select
          value={seconds ?? 120}
          onChange={(e) => void set(Number(e.target.value))}
          aria-label="Poll interval"
          className="rounded border border-[#30363d] bg-[#161b22] px-1.5 py-0.5 text-xs text-[#e6edf3]"
        >
          {CHOICES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </label>

      {/* Beside the settings button rather than next to the poll state:
          this is an identity, not a status, and it is what a user quotes
          in a bug report. Rendered only once known, so the bar does not
          flash a placeholder on every launch. */}
      {version ? (
        <span className="tabular-nums" title={`Headstate ${version}`}>
          v{version}
        </span>
      ) : null}
      {/* Unobtrusive on purpose: an update is worth knowing about, not
          worth interrupting for. */}
      {newer ? (
        <ExternalLink
          href="https://github.com/pktstorm/headstate/releases/latest"
          className="text-[#58a6ff] hover:underline"
          title={`Headstate ${newer} is available`}
        >
          v{newer} available
        </ExternalLink>
      ) : null}

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Settings"
        title="Settings"
        className="rounded p-1 hover:bg-[#161b22]"
      >
        <Settings className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
    </>
  );
}
