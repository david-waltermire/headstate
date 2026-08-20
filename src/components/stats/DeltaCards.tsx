import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatPct, pctChange, percentile } from "@/lib/stats";
import type { MergedDetail, Periods } from "@/types/pr";

/// A single headline number with its change against the prior period.
///
/// `delta` is null when both periods were empty and Infinity when only the
/// prior one was, so only a finite value earns an arrow and a colour --
/// otherwise "no activity" would render as a green +0%.
function DeltaCard({
  label,
  value,
  delta,
  window: win,
}: {
  label: string;
  value: string;
  delta: number | null;
  window: string;
}) {
  const finite = delta !== null && Number.isFinite(delta);
  const up = finite && (delta as number) >= 0;
  const Icon = !finite ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <Card className="px-4">
      <div className="text-xs text-[#8b949e]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div
        className={`mt-1 flex items-center gap-1 text-xs ${
          !finite ? "text-[#8b949e]" : up ? "text-[#3fb950]" : "text-[#f85149]"
        }`}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{formatPct(delta)}</span>
        <span className="text-[#8b949e]">{win}</span>
      </div>
    </Card>
  );
}

/// The four headline figures.
///
/// Every window is stated in words ("vs previous 7 days") rather than left
/// implicit: the periods deliberately exclude today, so a bare percentage
/// would be quietly comparing something different from what the reader
/// assumes.
export function DeltaCards({
  periods,
  detail,
}: {
  periods: Periods;
  detail: MergedDetail | undefined;
}) {
  const median = detail ? percentile(detail.cycle_time_hours, 0.5) : 0;
  const hasTimes = (detail?.cycle_time_hours.length ?? 0) > 0;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <DeltaCard
        label="Merged this week"
        value={String(periods.week_current)}
        delta={pctChange(periods.week_current, periods.week_previous)}
        window="vs previous 7 days"
      />
      <DeltaCard
        label="Opened this week"
        value={String(periods.opened_week_current)}
        delta={pctChange(periods.opened_week_current, periods.opened_week_previous)}
        window="vs previous 7 days"
      />
      <DeltaCard
        label="Merged this month"
        value={String(periods.month_current)}
        delta={pctChange(periods.month_current, periods.month_previous)}
        window="vs previous 30 days"
      />
      <DeltaCard
        label="Median cycle time"
        value={hasTimes ? `${median.toFixed(1)}h` : "--"}
        delta={null}
        window={detail ? `over ${detail.sample_size} merged` : ""}
      />
    </div>
  );
}
