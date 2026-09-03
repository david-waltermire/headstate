import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/// Diagnostic timing log, off unless the user turns it on in Settings.
///
/// Added in v3.5.3 to diagnose a slow review query on one machine, and
/// kept as a switch rather than removed: the next "it is slow on my
/// machine" report wants exactly this log, and asking someone to
/// install a special build to produce it is far worse than a checkbox.
///
/// The Rust side owns the on/off decision (`crate::diag`), so this
/// always sends and the command drops the line when logging is off.
/// Duplicating the flag here would mean two sources of truth for one
/// setting, and the IPC call is cheap against the work being measured.
///
/// Writes through the Rust side so frontend and backend lines land in
/// ONE file, in order. That ordering is the whole point: the reported
/// symptom is a view that takes over a minute while the same search runs
/// in seconds from `gh`, and the only way to tell a slow request from a
/// slow render is to see React's timestamps interleaved with the
/// request's.
///
/// Never awaited by callers and never throws: diagnostics must not
/// change the behaviour they are measuring, so a failed log is dropped.
function diag(line: string): void {
  void invoke("diag_log", { line }).catch(() => {});
}

/// Wraps a query function with start/end lines and an elapsed time.
///
/// `performance.now()` rather than `Date.now()`: this measures a
/// duration, and a clock adjustment mid-request would otherwise produce
/// a negative or wildly wrong number in the one log we are relying on.
export function timed<T>(name: string, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const started = performance.now();
    diag(`query ${name} start`);
    try {
      const out = await fn();
      const n = Array.isArray(out) ? ` n=${out.length}` : "";
      diag(`query ${name} ok ${Math.round(performance.now() - started)}ms${n}`);
      return out;
    } catch (e) {
      // The message can carry a repo name from a GitHub error, so it is
      // deliberately NOT logged here -- the Rust side already logs the
      // scrubbed error, and this line only needs to mark the timing.
      diag(`query ${name} failed ${Math.round(performance.now() - started)}ms`);
      throw e;
    }
  };
}

/// Time one call without wrapping it, for parameterised query functions.
///
/// `timed()` returns a NEW function each call, so it must be hoisted to
/// module scope -- which a queryFn closing over per-render arguments
/// cannot be. This measures the same thing from inside the call instead,
/// leaving the queryFn's identity to TanStack.
export async function timeCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  diag(`call ${name} start`);
  try {
    const out = await fn();
    diag(`call ${name} ok ${Math.round(performance.now() - started)}ms`);
    return out;
  } catch (e) {
    diag(`call ${name} failed ${Math.round(performance.now() - started)}ms`);
    throw e;
  }
}

/// Mark a moment, for measuring a gap the caller brackets itself.
///
/// The freeze reports are about the window between a click and the UI
/// responding, which spans a command, a render, and a query
/// invalidation -- no single call wraps it.
export function diagMark(line: string): void {
  diag(line);
}

/// DIAGNOSTIC HOOK (Settings > diagnostic log).
///
/// Reports what the To review query is actually doing each render. The
/// reported symptom -- "No open pull requests" shown indefinitely after
/// switching views -- has two very different causes that look identical
/// on screen: the query is disabled (so it never runs and never
/// resolves), or it ran and returned an empty list. `enabled` and
/// `fetchStatus` separate them, and nothing currently records either.
export function useReviewingDiag(q: {
  enabled: boolean;
  status: string;
  fetchStatus: string;
  count: number | undefined;
}): void {
  const line = `reviewing state enabled=${q.enabled} status=${q.status} fetch=${q.fetchStatus} n=${q.count ?? "-"}`;
  useEffect(() => {
    diag(line);
    // Keyed on the formatted line so it logs on CHANGE, not every
    // render -- a render-rate log would bury the transitions it exists
    // to show.
  }, [line]);
}
