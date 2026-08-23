/// The workflow run to re-run for a pull request, or null if there is
/// nothing to re-run.
///
/// Two conditions, both necessary:
///
/// - Something actually FAILED. Offering "re-run failed" on a green
///   pull request would either do nothing or re-run passing work.
/// - That failure belongs to an Actions workflow run. A plain commit
///   status and a check run from a non-Actions app both have no run,
///   so the call would 404 rather than help.
///
/// Returns the FIRST failing run rather than all of them: one call
/// re-runs every failed job in a run, and the overwhelmingly common case
/// is a single workflow. Multiple distinct failing runs would need a
/// picker, which is not worth building before anyone has two.
export function rerunnableRun(
  checks: { state: string; run_id: number | null }[],
): number | null {
  return checks.find((c) => c.state === "failure" && c.run_id !== null)?.run_id ?? null;
}
