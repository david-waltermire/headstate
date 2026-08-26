import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/// TEMPORARY DIAGNOSTIC LOGGING (v3.5.3). Removed with the rest of the
/// diagnostics once the To review slowness is understood.
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

/// TEMPORARY DIAGNOSTIC HOOK (v3.5.3).
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
