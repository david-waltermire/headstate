/// Percent change between two periods.
///
/// Returns `Infinity` when `previous` is 0 but `current` is not -- there is
/// no meaningful ratio, and the UI renders that as "new" rather than a
/// number. Returns `null` when both are 0, which is "no activity", not a
/// 0% change.
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : Infinity;
  return ((current - previous) / previous) * 100;
}

/// Nearest-rank percentile over an ALREADY SORTED ascending array.
///
/// Nearest rank is `ceil(n * p)` in 1-based terms, so `ceil(n*p) - 1`
/// zero-indexed. `floor(n*p)` -- what this used to do -- agrees only when
/// `n*p` is NOT an integer, and it is an integer at exactly the two call
/// sites the UI exercises: p50 and p90 over a 100-PR sample. That returned
/// the 51st and 91st values where the 50th and 90th are correct.
///
/// Both ends are clamped: `p = 1.0` would index `n`, and `p = 0` would
/// index `-1`.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

export function formatPct(v: number | null): string {
  if (v === null) return "--";
  if (!Number.isFinite(v)) return "new";
  return `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
}
