import { Card } from "@/components/ui/card";
import type { MergedPr } from "@/types/pr";

/// The pull requests behind the striking numbers.
///
/// Every figure on this page was a scalar: it could report that something
/// took four days or ran to ten thousand lines and then not say WHICH pull
/// request that was. The repo table already documents the opposite
/// principle for itself -- "a way in, not just a readout" -- and these are
/// the figures that most invite a click.
///
/// Links open github.com rather than filtering the list, because these are
/// MERGED PRs and the list holds open ones.
function OutlierList({
  title,
  hint,
  prs,
  format,
}: {
  title: string;
  hint: string;
  prs: MergedPr[];
  format: (pr: MergedPr) => string;
}) {
  if (prs.length === 0) return null;
  return (
    <Card className="px-4">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-[#8b949e]">{hint}</div>
      <div className="mt-3 flex flex-col gap-1">
        {prs.map((pr) => (
          <a
            key={`${pr.repo}#${pr.number}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-baseline gap-3 rounded px-2 py-1.5 text-sm hover:bg-[#161b22]"
          >
            <span className="min-w-0 flex-1 truncate text-[#e6edf3]">{pr.title}</span>
            <span className="shrink-0 text-xs text-[#8b949e]">{pr.repo}</span>
            <span className="shrink-0 tabular-nums text-xs text-[#8b949e]">
              {format(pr)}
            </span>
          </a>
        ))}
      </div>
    </Card>
  );
}

export function Outliers({ slowest, largest }: { slowest: MergedPr[]; largest: MergedPr[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <OutlierList
        title="Slowest to merge"
        hint="longest time from open to merge, in this sample"
        prs={slowest}
        format={(pr) =>
          pr.cycle_time_hours >= 24
            ? `${(pr.cycle_time_hours / 24).toFixed(1)}d`
            : `${pr.cycle_time_hours.toFixed(1)}h`
        }
      />
      <OutlierList
        title="Largest changes"
        hint="most lines added and removed, in this sample"
        prs={largest}
        format={(pr) => `${pr.size.toLocaleString()} lines`}
      />
    </div>
  );
}
