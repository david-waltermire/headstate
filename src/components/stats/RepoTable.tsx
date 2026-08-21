import { Card } from "@/components/ui/card";
import { useFilters } from "@/store/filters";
import type { RepoCount } from "@/types/pr";

/// Merged-PR distribution across repositories.
///
/// Clicking a row scopes the app to that repo and switches to the list.
/// "Which of my many repos is this happening in" is the whole reason this
/// table exists, so it has to be a way in, not just a readout.
export function RepoTable({
  repos,
  sampleSize,
}: {
  repos: RepoCount[];
  sampleSize?: number;
}) {
  const { setFilter, setPanel } = useFilters();
  const total = repos.reduce((sum, r) => sum + r.merged, 0);

  return (
    <Card className="px-4">
      <div className="text-sm font-semibold">Merged by repository</div>
      {/* The bars are the most visually assertive element on the page and
          had the weakest footing: they are shares of a SAMPLE of recent
          merges, not of all time. The delta and insight cards already say
          so; this was the holdout. */}
      <div className="text-xs text-[#8b949e]">
        {sampleSize ? `share of the last ${sampleSize} merged` : "share of recent merges"}
      </div>
      {repos.length === 0 ? (
        <div className="py-8 text-center text-sm text-[#8b949e]">
          No merged pull requests in this sample.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {repos.map((r) => {
            const pct = total === 0 ? 0 : Math.round((r.merged / total) * 100);
            return (
              <button
                key={r.repo}
                type="button"
                onClick={() => {
                  setFilter("repo", r.repo);
                  setPanel("list");
                }}
                className="flex items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-[#161b22]"
              >
                <span className="w-56 shrink-0 truncate text-left">{r.repo}</span>
                <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-[#21262d]">
                  <span
                    className="absolute inset-y-0 left-0 rounded bg-[#3fb950]"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right tabular-nums">{r.merged}</span>
                <span className="w-10 shrink-0 text-right text-xs text-[#8b949e]">
                  {pct}%
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
