import { useState } from "react";
import { useHistory, useMergedDetail } from "../api/hooks";
import { ActivityChart } from "./stats/ActivityChart";
import { DeltaCards } from "./stats/DeltaCards";
import { InsightCards } from "./stats/InsightCards";
import { RepoTable } from "./stats/RepoTable";

/// The Stats view: the history-oriented counterpart to the PR list.
///
/// The two queries are deliberately independent. History drives the cards
/// and the chart and arrives in one cheap request; detail samples 100
/// merged PRs and is only needed by the insight row and repo table. A
/// failure or delay in one must not blank the other, so each is gated
/// separately rather than behind a single combined loading flag.
export function StatsPage() {
  const [days, setDays] = useState(30);
  const { data: history, isLoading } = useHistory(days);
  const { data: detail } = useMergedDetail();

  if (isLoading || !history) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
        Loading statistics…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DeltaCards history={history} detail={detail} />
      <ActivityChart points={history.points} days={days} onDaysChange={setDays} />
      {detail ? (
        <>
          <InsightCards detail={detail} />
          <RepoTable repos={detail.repo_counts} />
        </>
      ) : null}
    </div>
  );
}
