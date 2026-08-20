import { Card } from "@/components/ui/card";
import { formatPct, pctChange, percentile } from "@/lib/stats";
import type { CycleTrend, MergedDetail } from "@/types/pr";

function Stat({
  label,
  value,
  hint,
  trend,
}: {
  label: string;
  value: string;
  hint: string;
  /// Optional week-over-week change. `lowerIsBetter` inverts the colour,
  /// because a falling cycle time is good news where a falling merge count
  /// is not.
  trend?: { pct: number | null; lowerIsBetter: boolean; note: string };
}) {
  const finite = trend && trend.pct !== null && Number.isFinite(trend.pct);
  const good = finite && (trend.lowerIsBetter ? trend.pct! < 0 : trend.pct! >= 0);
  return (
    <Card className="px-4">
      <div className="text-xs text-[#8b949e]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-[#8b949e]">{hint}</div>
      {trend ? (
        <div className="mt-1 text-xs">
          <span className={good ? "text-[#3fb950]" : finite ? "text-[#f85149]" : "text-[#8b949e]"}>
            {formatPct(trend.pct)}
          </span>{" "}
          <span className="text-[#8b949e]">vs last week · {trend.note}</span>
        </div>
      ) : null}
    </Card>
  );
}

/// Quality signals over the merged-PR sample.
///
/// Every per-PR figure divides by `sample_size`, so an empty sample renders
/// "--" rather than NaN. The hints name the sample explicitly: these are
/// aggregates over the last N merged PRs, not lifetime totals, and a reader
/// who mistakes one for the other draws the wrong conclusion.
///
/// The third card shows PR SIZE rather than review burden. Review counts
/// were checked against live data and came back 0 across the whole sample
/// -- these are self-merged PRs, so a "reviews per PR" card is a permanent
/// 0.0 that teaches nothing. Size has real spread (measured: 3 to 10,088
/// lines, median 324) and speaks to whether generated PRs are staying
/// reviewable, which is the question the review card was reaching for.
export function InsightCards({
  detail,
  trend,
}: {
  detail: MergedDetail;
  trend?: CycleTrend;
}) {
  const n = detail.sample_size;
  const lines = detail.additions + detail.deletions;
  const per = (total: number, digits = 1) =>
    n === 0 ? "--" : (total / n).toFixed(digits);
  const median = percentile(detail.cycle_time_hours, 0.5);
  const p90 = percentile(detail.cycle_time_hours, 0.9);
  const hasTimes = detail.cycle_time_hours.length > 0;
  // For a small sample, "p90" resolves to the largest value in it -- a
  // brand-new account's single weekend PR would be presented with the
  // authority of a tail metric. Say "slowest" instead of implying a
  // distribution that is not there.
  const tailLabel = (n: number) => (n >= 20 ? "p90" : "slowest");
  const medianSize = percentile(detail.pr_sizes, 0.5);
  const p90Size = percentile(detail.pr_sizes, 0.9);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {/* Cycle time is the only figure here with a prior period, now that
          the trend query supplies one -- so it is the one that can show
          IMPROVEMENT rather than just throughput. Lower is better, hence
          the inverted colour. */}
      <Stat
        label="Cycle time"
        value={hasTimes ? `${median.toFixed(1)}h` : "--"}
        trend={
          trend && trend.previous_hours > 0
            ? {
                pct: pctChange(trend.current_hours, trend.previous_hours),
                lowerIsBetter: true,
                note: trend.sampled
                  ? `${trend.current_count} vs ${trend.previous_count} merged (sampled)`
                  : `${trend.current_count} vs ${trend.previous_count} merged`,
              }
            : undefined
        }
        hint={
          hasTimes
            ? `median · ${tailLabel(detail.cycle_time_hours.length)} ${p90.toFixed(1)}h`
            : "no timing data"
        }
      />
      <Stat
        label="Lines changed"
        value={lines.toLocaleString()}
        hint={
          n === 0
            ? "no sample"
            : `over ${n} merged · ${per(lines, 0)} per PR · ${per(detail.changed_files)} files`
        }
      />
      <Stat
        label="Median PR size"
        value={n === 0 ? "--" : `${medianSize.toLocaleString()}`}
        hint={
          n === 0
            ? "no sample"
            : `lines · ${tailLabel(detail.pr_sizes.length)} ${p90Size.toLocaleString()} · ${per(detail.comment_count)} comments/PR`
        }
      />
    </div>
  );
}
