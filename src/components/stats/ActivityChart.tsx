import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { HistoryPoint } from "@/types/pr";

const RANGES = [7, 14, 30];

const config = {
  merged: { label: "Merged", color: "var(--chart-merged)" },
  opened: { label: "Opened", color: "var(--chart-opened)" },
};

/// Daily opened and merged counts as overlaid gradient areas.
///
/// Deliberately NOT stacked. The two series measure overlapping
/// populations -- a PR opened and merged on the same day appears in both --
/// so a stacked total would be a number that means nothing. Overlaid, the
/// gap between the lines is readable as the backlog growing or draining,
/// which is the actual signal.
///
/// The trailing day is always partial, so the last point dips by
/// construction. That is left visible rather than trimmed: the shape is
/// still informative, and the delta cards (which exclude today) carry the
/// numbers people quote.
export function ActivityChart({
  points,
  days,
  onDaysChange,
}: {
  points: HistoryPoint[];
  days: number;
  onDaysChange: (d: number) => void;
}) {
  return (
    <Card className="px-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Pull request activity</div>
          <div className="text-xs text-[#8b949e]">Opened and merged per day</div>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => onDaysChange(r)}
              className={`rounded px-2 py-1 text-xs ${
                days === r
                  ? "bg-[#1f6feb] text-white"
                  : "text-[#8b949e] hover:bg-[#161b22]"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="py-16 text-center text-sm text-[#8b949e]">
          No activity in this period.
        </div>
      ) : (
        <ChartContainer config={config} className="mt-4 h-56 w-full">
          <AreaChart data={points} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              {(["merged", "opened"] as const).map((k) => (
                <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={config[k].color} stopOpacity={0.7} />
                  <stop offset="95%" stopColor={config[k].color} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="#30363d" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tick={{ fill: "#8b949e", fontSize: 11 }}
              // Full ISO dates collide at 30 points; month-day is enough.
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={32}
              tick={{ fill: "#8b949e", fontSize: 11 }}
              allowDecimals={false}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
            <Area
              dataKey="opened"
              type="monotone"
              stroke={config.opened.color}
              fill="url(#fill-opened)"
              strokeWidth={2}
            />
            <Area
              dataKey="merged"
              type="monotone"
              stroke={config.merged.color}
              fill="url(#fill-merged)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </Card>
  );
}
