import { usePullRequests, useRefreshRequested } from "./api/hooks";
import { FilterBar } from "./components/FilterBar";
import { NudgeWizard } from "./components/NudgeWizard";
import { PrioritiesStrip } from "./components/PrioritiesStrip";
import { PrList } from "./components/PrList";
import { QueryError, errorMessage } from "./components/QueryError";
import { RepoSidebar } from "./components/RepoSidebar";
import { StatsPage } from "./components/StatsPage";
import { applyFilters, sortPrs } from "./lib/derive";
import { useFilters } from "./store/filters";

/// The assembled app shell. `AuthGate` already wraps this component once in
/// `main.tsx` -- it is not repeated here, so there is exactly one
/// `get_auth_state` query and one `usePollError` subscription (and
/// therefore one error banner) per window.
export default function App() {
  const { data: prs = [], isLoading, isError, error, refetch } = usePullRequests();
  const { filters, view } = useFilters();

  // The tray's "Refresh now" menu item only emits `refresh-requested`; this
  // is what actually makes it do anything (see the hook's own comment).
  useRefreshRequested();

  // Splash dismissal deliberately does NOT live here. `App` only mounts
  // when auth succeeds, so dismissing on `isSuccess` left every
  // unauthenticated machine showing the splash forever -- see AuthGate,
  // which owns it now and lifts it on any settled auth result.

  // Sorting was moved out of PrList in M3 -- it renders exactly the order
  // it's handed, so the sort dropdown in FilterBar is inert unless this
  // call site applies it.
  const visible = sortPrs(applyFilters(prs, filters), filters.sort);

  // The priorities strip is scoped to the selected repo, matching the page
  // it sits on: on `octocat/hello-world` you want that repo's blocked PRs,
  // not a list dominated by nine other repos you are not looking at. The
  // dashboard is the whole-account view, so its strip spans every repo.
  //
  // Note this scopes by REPO only, not by the rest of the filters. Something
  // blocked on you stays blocked whether or not you happen to be filtering
  // by label, so a label filter must not hide it -- but a repo selection is
  // a change of page, and the strip should follow.
  const scopedForStrip = filters.repo ? prs.filter((pr) => pr.repo === filters.repo) : prs;

  // FilterBar still sees the *unfiltered* `prs`: its label menu should offer
  // every label present across all open PRs, not shrink to only the labels
  // that survive whatever filter is already active, which would make some
  // combinations unreachable.
  return (
    <div className="flex h-screen bg-[#0d1117] text-[#e6edf3]">
      <RepoSidebar prs={prs} />
      <main className="flex-1 overflow-auto">
        <header className="flex items-center gap-2 border-b border-[#30363d] px-4 py-3">
          {/* View selection lives in the sidebar ("Stats", pinned to its
              bottom) rather than as a per-page tab pair here: the sidebar is
              already where you choose what you are looking at, and a tab row
              repeated above every page competed with it. */}
          <h1 className="text-sm font-semibold">
            {view === "dashboard" ? "Stats" : "Pull requests"}
          </h1>
          <div className="ml-auto">
            {/* scopedRepo skips the wizard's "which repositories?" step:
                selecting a repo in the sidebar already answers it. */}
            <NudgeWizard prs={prs} scopedRepo={filters.repo} />
          </div>
        </header>

        {view === "dashboard" ? (
          <div className="p-4">
            {/* No priorities strip here: Stats is a read-only summary of the
                whole account, and the strip is a triage surface that belongs
                beside the list it acts on. Its cards already surface what
                needs attention, and each one clicks through to the list. */}
            <StatsPage />
          </div>
        ) : (
          <div className="p-4">
            <PrioritiesStrip prs={scopedForStrip} />
            <FilterBar prs={prs} />
            {isLoading ? (
              // `get_cached` returns `[]` both for "never polled" and for
              // "authenticated, first poll (~3s) still in flight" -- an
              // empty PrList would misreport the latter as "no pull
              // requests match these filters" when no filters are even
              // active. Gating on isLoading keeps a cold start visibly
              // loading instead of falsely claiming zero matches.
              <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
                Loading pull requests…
              </div>
            ) : isError ? (
              // The same reasoning one step further. A REJECTED query also
              // leaves `prs` at its `[]` default, so without this branch the
              // list renders "0 Open -- no pull requests match these
              // filters": a confident answer to a question the app could not
              // answer. `poll-error` does not cover this -- that banner is
              // emitted by the background loop, and a failure here means the
              // foreground fetch itself never produced data.
              <QueryError
                title="Could not load your pull requests"
                message={errorMessage(error)}
                onRetry={() => void refetch()}
              />
            ) : (
              <PrList prs={visible} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
