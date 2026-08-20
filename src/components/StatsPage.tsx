import { useState } from "react";
import { useHistory, useMergedDetail, usePeriods } from "../api/hooks";
import { QueryError, errorMessage } from "./QueryError";
import { ActivityChart } from "./stats/ActivityChart";
import { DeltaCards } from "./stats/DeltaCards";
import { InsightCards } from "./stats/InsightCards";
import { Outliers } from "./stats/Outliers";
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
  const periodsQ = usePeriods();
  const historyQ = useHistory(days);
  const detailQ = useMergedDetail();
  const { data: periods } = periodsQ;
  const { data: history } = historyQ;
  const { data: detail } = detailQ;

  // Every section gates on truthy data, so without an explicit error branch
  // a REJECTED query is indistinguishable from a pending one and its
  // skeleton pulses forever. Nothing else covers this: `poll-error` is
  // emitted only by the PR poll loop, so the AuthGate banner structurally
  // cannot reach these three commands.
  const allFailed = periodsQ.isError && historyQ.isError && detailQ.isError;
  const retryAll = () => {
    void periodsQ.refetch();
    void historyQ.refetch();
    void detailQ.refetch();
  };

  if (allFailed) {
    return (
      <QueryError
        title="Could not load your statistics"
        message={errorMessage(periodsQ.error)}
        onRetry={retryAll}
      />
    );
  }

  // A brand-new user, or one back from holiday, otherwise met four cards
  // reading 0 and "--", plus "over 0 merged", plus "No activity in this
  // period", plus "No merged pull requests in this sample" -- four
  // uncoordinated fragments where one sentence is clearer. Tolerates
  // `detail` being absent, since the two queries land independently and a
  // flicker would be worse than the fragments.
  const nothingYet =
    periods !== undefined &&
    periods.week_current === 0 &&
    periods.month_current === 0 &&
    periods.opened_week_current === 0 &&
    (detail === undefined || detail.sample_size === 0);

  if (nothingYet) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center">
        <p className="text-sm font-semibold text-[#e6edf3]">No merged pull requests yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#8b949e]">
          Statistics appear here once you have merged some pull requests. Headstate
          counts only pull requests you opened.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {periods ? (
        <DeltaCards periods={periods} />
      ) : periodsQ.isError ? (
        <QueryError
          title="Could not load the headline figures"
          message={errorMessage(periodsQ.error)}
          onRetry={() => void periodsQ.refetch()}
        />
      ) : (
        <SkeletonRow count={4} cols="sm:grid-cols-2 lg:grid-cols-4" />
      )}

      {history ? (
        <ActivityChart points={history.points} days={days} onDaysChange={setDays} />
      ) : historyQ.isError ? (
        <QueryError
          title="Could not load the activity chart"
          message={errorMessage(historyQ.error)}
          onRetry={() => void historyQ.refetch()}
        />
      ) : (
        <SkeletonChart
          title="Pull request activity"
          hint="Opened and merged per day"
        />
      )}

      {detail ? (
        <>
          <InsightCards detail={detail} />
          <Outliers slowest={detail.slowest} largest={detail.largest} />
          <RepoTable repos={detail.repo_counts} sampleSize={detail.sample_size} />
        </>
      ) : detailQ.isError ? (
        <QueryError
          title="Could not load the merged-PR sample"
          message={errorMessage(detailQ.error)}
          onRetry={() => void detailQ.refetch()}
        />
      ) : (
        <SkeletonRow count={3} cols="md:grid-cols-3" />
      )}
    </div>
  );
}
