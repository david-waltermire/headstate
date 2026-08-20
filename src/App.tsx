import { useEffect } from "react";
import { usePullRequests, useRefreshRequested, useStats } from "./api/hooks";
import { Dashboard } from "./components/Dashboard";
import { FilterBar } from "./components/FilterBar";
import { NudgeWizard } from "./components/NudgeWizard";
import { PrioritiesStrip } from "./components/PrioritiesStrip";
import { PrList } from "./components/PrList";
import { RepoSidebar } from "./components/RepoSidebar";
import { Button } from "./components/ui/button";
import { applyFilters, sortPrs } from "./lib/derive";
import { dismissSplash } from "./splash";
import { useFilters } from "./store/filters";

/// The assembled app shell. `AuthGate` already wraps this component once in
/// `main.tsx` -- it is not repeated here, so there is exactly one
/// `get_auth_state` query and one `usePollError` subscription (and
/// therefore one error banner) per window.
export default function App() {
  const { data: prs = [], isSuccess, isLoading } = usePullRequests();
  const { data: stats } = useStats();
  const { filters, view, setView } = useFilters();

  // The tray's "Refresh now" menu item only emits `refresh-requested`; this
  // is what actually makes it do anything (see the hook's own comment).
  useRefreshRequested();

  // Splash dismissal is app-driven: it lifts on the first successful render
  // of real data, not on a timer that would guess wrong on either a slow or
  // a fast machine.
  useEffect(() => {
    if (isSuccess) dismissSplash();
  }, [isSuccess]);

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
          <Button
            variant={view === "list" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("list")}
          >
            Pull requests
          </Button>
          <Button
            variant={view === "dashboard" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </Button>
          <div className="ml-auto">
            {/* scopedRepo skips the wizard's "which repositories?" step:
                selecting a repo in the sidebar already answers it. */}
            <NudgeWizard prs={prs} scopedRepo={filters.repo} />
          </div>
        </header>

        {view === "dashboard" ? (
          <div className="p-4">
            {/* The dashboard is the whole-account view, so its strip spans
                every repo regardless of any repo selection in the sidebar. */}
            <PrioritiesStrip prs={prs} />
            <Dashboard prs={prs} stats={stats ?? { merged_week: 0, merged_month: 0 }} />
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
            ) : (
              <PrList prs={visible} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
