import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import {
  usePullRequests,
  useRefreshRequested,
  useReviewing,
  useViewCadence,
  useTruncation,
} from "./api/hooks";
import { FilterBar } from "./components/FilterBar";
import { NudgeWizard } from "./components/NudgeWizard";
import { PrioritiesStrip } from "./components/PrioritiesStrip";
import { CourtStrip } from "./components/CourtStrip";
import { PrDetailView } from "./components/PrDetailView";
import { BulkBar } from "./components/BulkBar";
import { PrList } from "./components/PrList";
import { ReviewChips } from "./components/ReviewChips";
import { TriageChips } from "./components/TriageChips";
import { WorktreeSidebar } from "./components/WorktreeSidebar";
import { DockerBuildsPage } from "./components/DockerBuilds";
import { DockerPage } from "./components/DockerPage";
import { DockerSidebar } from "./components/DockerSidebar";
import { WorktreesPage } from "./components/WorktreesPage";
import { QueryError, errorMessage } from "./components/QueryError";
import { RepoSidebar } from "./components/RepoSidebar";
import { StatusBar } from "./components/StatusBar";
import { StatsPage } from "./components/StatsPage";
import { applyFilters, hasActiveFilters, sortPrs } from "./lib/derive";
import { shortcutFor } from "./lib/shortcuts";
import { useActiveFilters, useFilters } from "./store/filters";

/// The assembled app shell. `AuthGate` already wraps this component once in
/// `main.tsx` -- it is not repeated here, so there is exactly one
/// `get_auth_state` query and one `usePollError` subscription (and
/// therefore one error banner) per window.
export default function App() {
  const {
    data: prs = [],
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
  } = usePullRequests();
  const filters = useActiveFilters();
  const { view, panel, selectedPr, selectPr, applyPreset } = useFilters();

  // The tray's "Refresh now" menu item only emits `refresh-requested`; this
  // is what actually makes it do anything (see the hook's own comment).
  useRefreshRequested();
  useViewCadence(view);
  const truncatedTotal = useTruncation();
  const { data: reviewing = [] } = useReviewing();

  // The app had no keyboard affordances at all. These three need no
  // backend change: `refresh-requested` already exists and the window
  // already hides to the tray on close.

  // Splash dismissal deliberately does NOT live here. `App` only mounts
  // when auth succeeds, so dismissing on `isSuccess` left every
  // unauthenticated machine showing the splash forever -- see AuthGate,
  // which owns it now and lifts it on any settled auth result.

  // Sorting was moved out of PrList in M3 -- it renders exactly the order
  // it's handed, so the sort dropdown in FilterBar is inert unless this
  // call site applies it.
  // The list the active view operates on. Everything downstream --
  // sidebar counts, filters, the strip -- reads this rather than `prs`,
  // so the two views share every component instead of duplicating them.
  const source = view === "to-review" ? reviewing : prs;
  const visible = sortPrs(applyFilters(source, filters), filters.sort);

  // A cursor past the end of a newly-filtered list points at nothing.
  // Clamping here rather than in the key handler means it is correct for
  // rendering too, not just for the next key press.
  const { cursor, setCursor } = useFilters();
  useEffect(() => {
    if (cursor !== null && cursor >= visible.length) {
      setCursor(visible.length > 0 ? visible.length - 1 : null);
    }
  }, [cursor, visible.length, setCursor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action === "onRefresh") {
        void emit("refresh-requested", null);
      } else if (action === "onHide") {
        void getCurrentWindow().hide();
      } else if (action === "onFocusSearch") {
        const el = document.querySelector<HTMLInputElement>('input[type="search"]');
        el?.focus();
        el?.select();
      } else {
        // List navigation reads `visibleRef` rather than closing over
        // `visible`: this effect mounts once, so a captured list would
        // freeze at whatever was on screen at first render and the
        // cursor would walk a stale list after any filter change.
        const rows = visible;
        if (rows.length === 0) return;
        const { cursor, setCursor, toggleChecked } = useFilters.getState();
        if (action === "onNext") {
          // Clamped, not wrapped: wrapping from the bottom back to the
          // top silently moves the eye across the whole screen.
          setCursor(cursor === null ? 0 : Math.min(cursor + 1, rows.length - 1));
        } else if (action === "onPrev") {
          setCursor(cursor === null ? 0 : Math.max(cursor - 1, 0));
        } else if (cursor !== null && rows[cursor]) {
          const pr = rows[cursor];
          if (action === "onOpen") {
            selectPr({ repo: pr.repo, number: pr.number });
          } else if (action === "onToggleSelect") {
            toggleChecked(`${pr.repo}#${pr.number}`);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `visible` is a real dependency, not noise: the handler indexes
    // into it, so a listener bound to a stale list would move the
    // cursor through rows that are no longer on screen. Re-binding one
    // window listener per filter change is cheap; a wrong cursor is not.
  }, [selectPr, visible]);

  // The priorities strip is scoped to the selected repo, matching the page
  // it sits on: on `octocat/hello-world` you want that repo's blocked PRs,
  // not a list dominated by nine other repos you are not looking at. The
  // dashboard is the whole-account view, so its strip spans every repo.
  //
  // Note this scopes by REPO only, not by the rest of the filters. Something
  // blocked on you stays blocked whether or not you happen to be filtering
  // by label, so a label filter must not hide it -- but a repo selection is
  // a change of page, and the strip should follow.
  const scopedForStrip = filters.repo
    ? source.filter((pr) => pr.repo === filters.repo)
    : source;

  // `repo` is navigation, not a filter (see the store's `reset`), so it
  // does not count -- an empty repo page should still explain itself.

  // FilterBar still sees the *unfiltered* `prs`: its label menu should offer
  // every label present across all open PRs, not shrink to only the labels
  // that survive whatever filter is already active, which would make some
  // combinations unreachable.
  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-[#e6edf3]">
      <div className="flex min-h-0 flex-1">
      {view === "docker" ? (
        <DockerSidebar viewCounts={{ "to-review": reviewing.length }} />
      ) : view === "worktrees" ? (
        <WorktreeSidebar viewCounts={{ "to-review": reviewing.length }} />
      ) : (
        <RepoSidebar prs={source} viewCounts={{ "to-review": reviewing.length }} />
      )}
      <main className="flex-1 overflow-auto">
        <header className="flex items-center gap-2 border-b border-[#30363d] px-4 py-3">
          {/* View selection lives in the sidebar ("Stats", pinned to its
              bottom) rather than as a per-page tab pair here: the sidebar is
              already where you choose what you are looking at, and a tab row
              repeated above every page competed with it. */}
          <h1 className="text-sm font-semibold">
            {view === "to-review"
              ? "Pull requests to review"
              : view === "docker"
                ? panel === "builds"
                  ? "Docker builds"
                  : "Docker images"
                : view === "worktrees"
                  ? "Worktrees"
                : panel === "stats"
                  ? "Stats"
                  : "Pull requests"}
          </h1>
          <div className="ml-auto">
            {/* PR views only: composing a list of pull requests needing
                review is meaningless on a page about local directories. */}
            {view !== "worktrees" ? (
              // scopedRepo skips the wizard's "which repositories?" step:
              // selecting a repo in the sidebar already answers it.
              <NudgeWizard prs={source} scopedRepo={filters.repo} />
            ) : null}
          </div>
        </header>

        {selectedPr && view !== "worktrees" ? (
          <div className="p-4">
            <PrDetailView
              repo={selectedPr.repo}
              number={selectedPr.number}
              onBack={() => selectPr(null)}
            />
          </div>
        ) : view === "docker" ? (
          <div className="p-4">
            {panel === "builds" ? <DockerBuildsPage /> : <DockerPage />}
          </div>
        ) : view === "worktrees" ? (
          <div className="p-4">
            <WorktreesPage />
          </div>
        ) : panel === "stats" ? (
          <div className="p-4">
            {/* No priorities strip here: Stats is a read-only summary of the
                whole account, and the strip is a triage surface that belongs
                beside the list it acts on. Its cards already surface what
                needs attention, and each one clicks through to the list. */}
            <StatsPage />
          </div>
        ) : (
          <div className="p-4">
            {/* Only for My PRs: the strip means "blocked on YOU as
                author", and someone else's red CI is not yours to fix. The
                review view gets its own attention rule below. */}
            {/* Answers "is anything on fire?" before the filter
                toolbar does anything. `PrioritiesStrip` still follows
                with the WHY for each blocked pull request -- this says
                whether to look at all, that says what to look at. */}
            {view === "my-prs" ? (
              <CourtStrip
                authored={scopedForStrip}
                reviewing={reviewing}
                onSelect={(court) =>
                  applyPreset(
                    court === "mine"
                      ? { needsAttentionOnly: true }
                      : { awaitingReviewOnly: true },
                  )
                }
              />
            ) : null}
            {view === "my-prs" ? (
              <PrioritiesStrip
                prs={scopedForStrip}
                onOpen={(pr) => selectPr({ repo: pr.repo, number: pr.number })}
              />
            ) : null}
            {/* Counts come from the same predicates the chips apply, so a
                chip can never open a list that disagrees with its number.
                Scoped to the sidebar selection like the strip above. */}
            {view === "my-prs" ? <TriageChips prs={scopedForStrip} /> : null}
            {view === "to-review" ? <ReviewChips prs={scopedForStrip} /> : null}
            <FilterBar prs={source} />
            {/* Fed the UNFILTERED list on purpose: selection is keyed by
                repo#number, so narrowing a filter after selecting must
                not shrink the batch out from under the user. */}
            {view === "my-prs" ? <BulkBar prs={source} /> : null}
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
              <PrList
                prs={visible}
                hasFilters={hasActiveFilters(filters)}
                total={view === "my-prs" ? (truncatedTotal ?? undefined) : undefined}
                onOpen={(pr) => selectPr({ repo: pr.repo, number: pr.number })}
                canWrite={view === "my-prs"}
                selectable={view === "my-prs"}
              />
            )}
          </div>
        )}
      </main>
      </div>
      {/* Pinned below both the sidebar and the list, so it reads as the
          window's status rather than the list's. */}
      <StatusBar updatedAt={dataUpdatedAt} />
    </div>
  );
}
