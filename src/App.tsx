import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import {
  usePullRequests,
  useRefreshRequested,
  useReviewing,
  useReviewingCount,
  useViewCadence,
  useTruncation,
  useIncomplete,
  useReviewShortfall,
  usePollError,
} from "./api/hooks";
import { useReviewingDiag } from "./api/diag";
import { useScrollReset } from "./lib/scrollReset";
import { FilterBar } from "./components/FilterBar";
import { NudgeWizard } from "./components/NudgeWizard";
import { PrioritiesStrip } from "./components/PrioritiesStrip";
import { ReadyStrip } from "./components/ReadyStrip";
import { CourtStrip } from "./components/CourtStrip";
import { PrDetailView } from "./components/PrDetailView";
import { BulkBar } from "./components/BulkBar";
import { PrList } from "./components/PrList";
import { ReviewChips } from "./components/ReviewChips";
import { TriageChips } from "./components/TriageChips";
import { WorktreeSidebar } from "./components/WorktreeSidebar";
import { ArtifactsPage } from "./components/ArtifactsPage";
import { ArtifactSidebar } from "./components/ArtifactSidebar";
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
  // The main panel is the scroll container for every view, so the reset
  // hangs off it rather than off each page.
  const mainRef = useRef<HTMLElement>(null);
  // Every axis that changes WHAT is rendered, and nothing that merely
  // changes the data within it. A poll tick refreshing the same list
  // must not scroll the user away from what they are reading.
  useScrollReset(
    mainRef,
    `${view}|${panel}|${filters.repo ?? ""}|${selectedPr ? `${selectedPr.repo}#${selectedPr.number}` : ""}`,
  );

  // The tray's "Refresh now" menu item only emits `refresh-requested`; this
  // is what actually makes it do anything (see the hook's own comment).
  useRefreshRequested();
  useViewCadence(view);
  const truncatedTotal = useTruncation();
  const refusedFields = useIncomplete();
  const reviewShortfall = useReviewShortfall();
  const pollError = usePollError();
  // The LIST only where it is rendered. The badge below uses a count
  // query instead, so Docker and Worktrees no longer fetch 100 pull
  // requests to display a number.
  // `isLoading` is taken from the query that feeds the CURRENT view.
  // Only the authored query's was used, and it has already resolved by
  // the time anyone reaches To review -- so switching there showed an
  // empty list with no indication anything was happening, for as long
  // as the request took.
  const reviewingQuery = useReviewing(view === "to-review");
  const {
    data: reviewing = [],
    isLoading: reviewingLoading,
    isError: reviewingError,
    error: reviewingErr,
    refetch: refetchReviewing,
    isRefreshing: reviewingRefreshing,
    isFromCache: reviewingFromCache,
  } = reviewingQuery;
  // DIAGNOSTIC LOGGING (Settings > diagnostic log).
  useReviewingDiag({
    enabled: view === "to-review",
    status: reviewingQuery.status,
    fetchStatus: reviewingQuery.fetchStatus,
    count: reviewingQuery.data?.length,
  });
  const { data: reviewingCount = 0 } = useReviewingCount();

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

  // Scoped the SAME WAY as `scopedForStrip`. The court strip counts
  // both lists together, so passing a repo-scoped authored list beside
  // an account-wide review queue produced a sentence with two different
  // scopes in it: "36 needs you · 18 waiting on others · of 13 open",
  // where 36 and 18 spanned every repo and 13 was one repo. That reads
  // as an arithmetic bug because it is one.
  const scopedReviewing = filters.repo
    ? reviewing.filter((pr) => pr.repo === filters.repo)
    : reviewing;

  // `repo` is navigation, not a filter (see the store's `reset`), so it
  // does not count -- an empty repo page should still explain itself.

  // FilterBar still sees the *unfiltered* `prs`: its label menu should offer
  // every label present across all open PRs, not shrink to only the labels
  // that survive whatever filter is already active, which would make some
  // combinations unreachable.
  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-[#e6edf3]">
      <div className="flex min-h-0 flex-1">
      {view === "artifacts" ? (
        <ArtifactSidebar reviewingCount={reviewingCount} />
      ) : view === "docker" ? (
        <DockerSidebar viewCounts={{ "to-review": reviewingCount }} />
      ) : view === "worktrees" ? (
        <WorktreeSidebar viewCounts={{ "to-review": reviewingCount }} />
      ) : (
        <RepoSidebar prs={source} viewCounts={{ "to-review": reviewingCount }} />
      )}
      <main ref={mainRef} className="flex-1 overflow-auto">
        <header className="flex items-center gap-2 border-b border-[#30363d] px-4 py-3">
          {/* View selection lives in the sidebar ("Stats", pinned to its
              bottom) rather than as a per-page tab pair here: the sidebar is
              already where you choose what you are looking at, and a tab row
              repeated above every page competed with it. */}
          <h1 className="text-sm font-semibold">
            {view === "to-review"
              ? "Pull requests to review"
              : view === "artifacts"
                ? "Build artifacts"
              : view === "docker"
                ? "Docker images"
                : view === "worktrees"
                  ? "Worktrees"
                : panel === "stats"
                  ? "Stats"
                  : "Pull requests"}
          </h1>
          <div className="ml-auto">
            {/* My pull requests ONLY. The wizard composes a nudge for
                pull requests YOU authored, so it means nothing on
                Docker or Worktrees (local state) and nothing on To
                review (other people's work). The previous condition
                excluded only Worktrees, so it appeared on all three. */}
            {view === "my-prs" ? (
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
        ) : view === "artifacts" ? (
          // No `p-4` wrapper: ArtifactsPage owns its own padding, since
          // its header row has to sit flush with the list beneath it.
          <ArtifactsPage />
        ) : view === "docker" ? (
          <div className="p-4">
            <DockerPage />
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
                reviewing={scopedReviewing}
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
            {/* The review queue's counterpart to the attention strip:
                what a reviewer can pick up right now. Scoped to the
                sidebar selection for the same reason -- on one
                repository you want that repository's work, not a list
                dominated by nine others. */}
            {view === "to-review" ? (
              <ReadyStrip
                prs={scopedForStrip}
                onOpen={(pr) => selectPr({ repo: pr.repo, number: pr.number })}
              />
            ) : null}
            {/* Counts come from the same predicates the chips apply, so a
                chip can never open a list that disagrees with its number.
                Scoped to the sidebar selection like the strip above. */}
            {view === "my-prs" ? <TriageChips prs={scopedForStrip} /> : null}
            {view === "to-review" ? <ReviewChips prs={scopedForStrip} /> : null}
            {/* GitHub answered with usable data and a complaint that it
                could not compute all of it. The list is real but short,
                and saying so beats hiding it -- or, as v3.2.5 did,
                discarding the data and showing nothing at all. */}
            {refusedFields > 0 ? (
              <p className="mb-3 rounded-md border border-[#d29922]/40 bg-[#d29922]/5 px-4 py-2 text-xs text-[#d29922]">
                GitHub could not compute {refusedFields} field
                {refusedFields === 1 ? "" : "s"} on the last refresh, so some pull
                requests may be missing details or absent. It usually recovers on
                the next one.
              </p>
            ) : null}
            {/* The 100 -> 50 fallback returns a SHORT list, and this is
                the only thing that says so. Without it the panel shows
                50 pull requests under a sidebar badge reading 62, with
                nothing to explain the gap -- which is what "the numbers
                are off" was describing. */}
            {view === "to-review" && reviewShortfall > 0 ? (
              <p className="mb-3 rounded-md border border-[#d29922]/40 bg-[#d29922]/5 px-4 py-2 text-xs text-[#d29922]">
                {reviewShortfall} pull request{reviewShortfall === 1 ? " is" : "s are"}{" "}
                missing from this list — GitHub could not answer the full query, so
                it was retried for fewer. Refreshing usually returns the rest.
              </p>
            ) : null}
            {/* The other half of the reported complaint: "no indication
                that it is blocked". The list now paints from the cache
                immediately, so without this the user would be looking
                at stale data with nothing to say it was being
                refreshed. */}
            {view === "to-review" && reviewingRefreshing && reviewingFromCache ? (
              <p className="mb-3 rounded-md border border-[#30363d] bg-[#161b22] px-4 py-2 text-xs text-[#8b949e]">
                Showing the last saved list — checking GitHub for changes…
              </p>
            ) : null}
            <FilterBar prs={source} />
            {/* Fed the UNFILTERED list on purpose: selection is keyed by
                repo#number, so narrowing a filter after selecting must
                not shrink the batch out from under the user. */}
            {view === "my-prs" ? <BulkBar prs={source} /> : null}
            {(view === "to-review" ? reviewingLoading : isLoading) ? (
              // `get_cached` returns `[]` both for "never polled" and for
              // "authenticated, first poll (~3s) still in flight" -- an
              // empty PrList would misreport the latter as "no pull
              // requests match these filters" when no filters are even
              // active. Gating on isLoading keeps a cold start visibly
              // loading instead of falsely claiming zero matches.
              <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
                Loading pull requests…
              </div>
            ) : (view === "to-review" ? reviewingError : isError) ? (
              // The same reasoning one step further. A REJECTED query also
              // leaves `prs` at its `[]` default, so without this branch the
              // list renders "0 Open -- no pull requests match these
              // filters": a confident answer to a question the app could not
              // answer. `poll-error` does not cover this -- that banner is
              // emitted by the background loop, and a failure here means the
              // foreground fetch itself never produced data.
              <QueryError
                title={
                  view === "to-review"
                    ? "Could not load the pull requests awaiting your review"
                    : "Could not load your pull requests"
                }
                // The failing query's OWN error and retry. Reporting the
                // authored query's here would show a stale message and
                // a retry that refetches the wrong list.
                message={errorMessage(view === "to-review" ? reviewingErr : error)}
                onRetry={() =>
                  void (view === "to-review" ? refetchReviewing() : refetch())
                }
              />
            ) : (
              <PrList
                prs={visible}
                hasFilters={hasActiveFilters(filters)}
                total={view === "my-prs" ? (truncatedTotal ?? undefined) : undefined}
                onOpen={(pr) => selectPr({ repo: pr.repo, number: pr.number })}
                canWrite={view === "my-prs"}
                selectable={view === "my-prs"}
                // A poll failure with a SUCCESSFUL but empty cache read
                // is the fresh-install case: `isError` above covers a
                // rejected query, and this covers "the query returned
                // the empty snapshot because no poll has ever landed".
                unreachable={pollError !== null && source.length === 0}
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
