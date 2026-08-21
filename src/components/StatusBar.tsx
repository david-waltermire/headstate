import { Settings } from "lucide-react";
import { useState } from "react";
import { usePollInterval, usePollState } from "../api/hooks";
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
/// this is one line of muted text, not a second header. Errors keep going
/// to the banner -- this shows STATE, not messages.
export function StatusBar({ updatedAt }: { updatedAt: number }) {
  const state = usePollState();
  const { seconds, set } = usePollInterval();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-[#30363d] bg-[#0d1117] px-4 py-1.5 text-xs text-[#8b949e]">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            state === "fetching" ? "bg-[#58a6ff]" : "bg-[#3fb950]"
          }`}
          aria-hidden="true"
        />
        {state === "fetching" ? "Checking GitHub…" : "Up to date"}
      </span>

      {/* `dataUpdatedAt`, not `isFetching`: the tray path advances the
          former on both routes but never flips the latter. */}
      {updatedAt > 0 ? (
        <span>Updated {relativeTime(new Date(updatedAt).toISOString())}</span>
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
  );
}
