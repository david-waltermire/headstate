import { useState } from "react";
import { useHistory, useMergedDetail, usePeriods } from "../api/hooks";
import { ActivityChart } from "./stats/ActivityChart";
import { DeltaCards } from "./stats/DeltaCards";
import { InsightCards } from "./stats/InsightCards";
import { RepoTable } from "./stats/RepoTable";
import { SkeletonChart, SkeletonRow } from "./stats/Skeleton";

/// The Stats view: the history-oriented counterpart to the PR list.
///
/// Three independent queries, each rendering the moment IT lands rather
/// than behind one combined gate. They differ enough in cost that a single
/// gate wasted most of the wait: periods ~1.6s, the daily series ~3.7s,
/// the merged sample ~3.7s. Blocking on the slowest meant the fast numbers
/// sat finished and invisible.
///
/// Each section keeps its own footprint while loading, so nothing jumps as
/// the later queries arrive.
export function StatsPage() {
  const [days, setDays] = useState(30);
  const { data: periods } = usePeriods();
  const { data: history } = useHistory(days);
  const { data: detail } = useMergedDetail();

  return (
    <div className="flex flex-col gap-3">
      {periods ? (
        <DeltaCards periods={periods} detail={detail} />
      ) : (
        <SkeletonRow count={4} cols="sm:grid-cols-2 lg:grid-cols-4" />
      )}

      {history ? (
        <ActivityChart points={history.points} days={days} onDaysChange={setDays} />
      ) : (
        <SkeletonChart
          title="Pull request activity"
          hint="Opened and merged per day"
        />
      )}

      {detail ? (
        <>
          <InsightCards detail={detail} />
          <RepoTable repos={detail.repo_counts} />
        </>
      ) : (
        <SkeletonRow count={3} cols="md:grid-cols-3" />
      )}
    </div>
  );
}
