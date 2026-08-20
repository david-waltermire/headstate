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
/// `Math.floor(n * p)` can equal `n` (n=10, p=1.0 -> 10 is out of bounds),
/// so the index is clamped to the last element.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function formatPct(v: number | null): string {
  if (v === null) return "--";
  if (!Number.isFinite(v)) return "new";
  return `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
}
