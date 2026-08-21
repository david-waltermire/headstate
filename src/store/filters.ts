import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Filters } from "../lib/derive";

/// zustand holds UI state only. Server data lives in TanStack Query and is
/// never duplicated here.
/// The three top-level views.
///
/// A separate axis from `panel`: "which view am I in" and "am I looking at
/// the list or the stats" were previously one enum, which is what made the
/// sidebar highlight logic awkward -- `reviewing` and `dashboard` were
/// peers of `list` despite being different kinds of thing.
export type View = "my-prs" | "to-review" | "worktrees";

interface FilterStore {
  /// Filters are PER VIEW: a repo selected in My PRs must not leak into
  /// Worktrees, which has an entirely different repo list.
  filtersByView: Record<View, Filters>;
  view: View;
  /// Within My PRs: the list, or the stats page. Stats is a property of
  /// that view rather than a fourth peer, so it stays pinned in the
  /// sidebar rather than joining the switcher. Inlined rather than an
  /// exported type, since nothing imports the name.
  panel: "list" | "stats";
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  applyPreset: (filters: Filters) => void;
  setView: (view: View) => void;
  setPanel: (panel: "list" | "stats") => void;
  /// The PR the detail view is showing, or null for the list.
  ///
  /// Deliberately NOT persisted: reopening the app on a detail page for a
  /// PR that has since merged is worse than landing on the list.
  selectedPr: { repo: string; number: number } | null;
  selectPr: (pr: { repo: string; number: number } | null) => void;
  reset: () => void;
}

const EMPTY_FILTERS: Record<View, Filters> = {
  "my-prs": {},
  "to-review": {},
  worktrees: {},
};

/// Filters and view survive a relaunch.
///
/// Every launch previously dropped the user on "All repositories, no
/// filters, sort newest", discarding whatever they were looking at. The
/// state is a flat bag of primitives and string arrays, so `persist` needs
/// no custom serialization.
///
/// `query` is deliberately NOT persisted: a search box that comes back
/// pre-filled with yesterday's text renders a filtered list that looks
/// like an empty one -- the same class of confusion as the old empty
/// state, and harder to diagnose because the cause is offscreen history.
export const useFilters = create<FilterStore>()(
  persist(
    (set) => ({
      filtersByView: { ...EMPTY_FILTERS },
      view: "my-prs",
      panel: "list",
      setFilter: (key, value) =>
        set((s) => ({
          filtersByView: {
            ...s.filtersByView,
            [s.view]: { ...s.filtersByView[s.view], [key]: value },
          },
        })),
      // Preset navigation replaces the filter set wholesale, so a click
      // never inherits a filter the user forgot was active and shows a
      // count that doesn't match the list it opens.
      applyPreset: (filters) =>
        set((s) => ({
          filtersByView: { ...s.filtersByView, [s.view]: filters },
          panel: "list",
        })),
      setView: (view) => set({ view, selectedPr: null }),
      setPanel: (panel) => set({ panel }),
      selectedPr: null,
      selectPr: (selectedPr) => set({ selectedPr }),
      // `repo` is sidebar NAVIGATION, not a filter chip -- it decides
      // which page you are on, scopes the priorities strip, and
      // pre-answers the wizard's repo step. Clearing it navigated the user
      // off the repo they were looking at, which is not what "Clear
      // filters" says it does.
      reset: () =>
        set((s) => {
          const current = s.filtersByView[s.view];
          return {
            filtersByView: {
              ...s.filtersByView,
              [s.view]: current.repo ? { repo: current.repo } : {},
            },
          };
        }),
    }),
    {
      name: "headstate-filters",
      // Bumped when the persisted SHAPE changes. Without this, a store
      // saved by v1 -- which had a flat `filters` and a `view` enum
      // conflating view with panel -- rehydrates straight into the new
      // shape, leaving `filtersByView` undefined and crashing on first
      // render. Tests never caught it because they always start empty.
      version: 2,
      migrate: (persisted: unknown, from: number) => {
        if (from >= 2) return persisted as never;
        // v1 -> v2: lift the single filter set into the active view, and
        // split `view` into view + panel. An unrecognised value falls back
        // to the defaults rather than propagating a bad state.
        const old = (persisted ?? {}) as {
          filters?: Filters;
          view?: string;
        };
        const view: View =
          old.view === "reviewing" ? "to-review" : "my-prs";
        const panel: "list" | "stats" = old.view === "dashboard" ? "stats" : "list";
        return {
          filtersByView: { ...EMPTY_FILTERS, [view]: old.filters ?? {} },
          view,
          panel,
        } as never;
      },
      partialize: (s) => ({
        // `query` is dropped per view for the same reason as before: a
        // search box restored with yesterday's text renders a filtered
        // list that looks like an empty one.
        filtersByView: Object.fromEntries(
          Object.entries(s.filtersByView).map(([k, f]) => [k, { ...f, query: undefined }]),
        ) as Record<View, Filters>,
        view: s.view,
        panel: s.panel,
      }),
    },
  ),
);

/// The active view's filters.
///
/// A selector rather than a stored field, so there is exactly one source
/// of truth and no chance of the two drifting apart.
export function useActiveFilters(): Filters {
  return useFilters((s) => s.filtersByView[s.view]);
}
