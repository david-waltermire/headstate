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
/// Every top-level view, in sidebar order.
///
/// The single source of truth: `View` is derived from it, and the
/// migration's completeness test iterates it rather than repeating the
/// names. A hardcoded second list is one that gets edited to match
/// whatever the code does and stops checking anything.
export const ALL_VIEWS = [
  "my-prs",
  "to-review",
  "worktrees",
  "docker",
  "artifacts",
  "packages",
  "claude-md",
] as const;

export type View = (typeof ALL_VIEWS)[number];

interface FilterStore {
  /// Filters are PER VIEW: a repo selected in My PRs must not leak into
  /// Worktrees, which has an entirely different repo list.
  filtersByView: Record<View, Filters>;
  view: View;
  /// Within My PRs: the list, or the stats page. Stats is a property of
  /// that view rather than a fourth peer, so it stays pinned in the
  /// sidebar rather than joining the switcher. Inlined rather than an
  /// exported type, since nothing imports the name.
  /// The sub-page within a view: the PR list versus Stats, and images
  /// versus builds inside Docker. A separate axis from `view` for the
  /// same reason it always was.
  panel: "list" | "stats" | "builds";
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  applyPreset: (filters: Filters) => void;
  setView: (view: View) => void;
  setPanel: (panel: "list" | "stats" | "builds") => void;
  /// How tightly PR rows pack.
  ///
  /// A global preference rather than per-view: it is about the user's
  /// eyes and screen, not about which list they happen to be reading.
  density: "comfortable" | "dense";
  setDensity: (density: "comfortable" | "dense") => void;
  /// The PR the detail view is showing, or null for the list.
  ///
  /// Deliberately NOT persisted: reopening the app on a detail page for a
  /// PR that has since merged is worse than landing on the list.
  selectedPr: { repo: string; number: number } | null;
  selectPr: (pr: { repo: string; number: number } | null) => void;
  /// Rows checked for a bulk action, keyed `repo#number`.
  ///
  /// Keyed rather than held as a list of PRs so selection is independent
  /// of the filtered list: narrowing a filter after selecting must not
  /// silently drop rows from the batch, which the issue calls out as the
  /// first requirement. Not persisted -- a selection is a working set for
  /// one sitting, and restoring it against PRs that may have merged
  /// would be worse than starting empty.
  checked: string[];
  toggleChecked: (key: string) => void;
  /// The last row toggled by a plain click, for shift-click ranges.
  ///
  /// Deliberately NOT persisted and cleared with the view, like
  /// `checked`: an anchor is meaningful only against the list currently
  /// on screen, and restoring one from a previous session would extend a
  /// range from a row the user never touched.
  anchor: string | null;
  /// Which visible row the keyboard cursor is on, or null for none.
  ///
  /// An INDEX into the visible list rather than a PR key, because the
  /// list the user is arrowing through is the filtered, sorted one --
  /// and a key would silently point at a row that filtering has removed.
  /// Cleared with the view for the same reason as `checked`.
  cursor: number | null;
  setCursor: (cursor: number | null) => void;
  setAnchor: (key: string | null) => void;
  setChecked: (keys: string[]) => void;
  clearChecked: () => void;
  reset: () => void;
}

const EMPTY_FILTERS: Record<View, Filters> = {
  "my-prs": {},
  "to-review": {},
  worktrees: {},
  docker: {},
  artifacts: {},
  packages: {},
  "claude-md": {},
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
/// The localStorage key this store persists under.
///
/// Exported so the error boundary's reset clears the SAME key this writes.
/// A hardcoded string in both places is one rename away from a reset
/// button that silently clears nothing -- and the crash it exists to
/// escape came from persisted state, so a no-op reset would loop forever.
export const PERSIST_KEY = "headstate-filters";

export const useFilters = create<FilterStore>()(
  persist(
    (set) => ({
      filtersByView: { ...EMPTY_FILTERS },
      view: "my-prs",
      panel: "list",
      density: "comfortable",
      setDensity: (density) => set({ density }),
      setFilter: (key, value) =>
        set((s) => ({
          filtersByView: {
            ...s.filtersByView,
            [s.view]: { ...s.filtersByView[s.view], [key]: value },
          },
          // Choosing a REPO is navigation -- it is how the sidebar
          // changes page -- so it must leave the detail view. Selecting
          // a repository and still staring at one pull request from a
          // different one meant clicking "Back to list" every time, and
          // the sidebar appeared to do nothing.
          //
          // Only `repo`. The other keys narrow the list you are looking
          // at, and closing the detail view on a label filter would
          // throw away what the user is reading.
          ...(key === "repo" ? { selectedPr: null } : {}),
        })),
      // Preset navigation replaces the filter set wholesale, so a click
      // never inherits a filter the user forgot was active and shows a
      // count that doesn't match the list it opens.
      applyPreset: (filters) =>
        set((s) => ({
          filtersByView: { ...s.filtersByView, [s.view]: filters },
          panel: "list",
      density: "comfortable",
      setDensity: (density) => set({ density }),
        })),
      // Selection clears with the view: a working set assembled on My
      // PRs means nothing on the review list, and carrying it across
      // would let a later batch act on rows the user cannot see.
      setView: (view) =>
        set({ view, selectedPr: null, checked: [], anchor: null, cursor: null }),
      setPanel: (panel) => set({ panel }),
      selectedPr: null,
      selectPr: (selectedPr) => set({ selectedPr }),
      checked: [],
      anchor: null,
      cursor: null,
      setCursor: (cursor) => set({ cursor }),
      setAnchor: (anchor) => set({ anchor }),
      toggleChecked: (key) =>
        set((s) => ({
          checked: s.checked.includes(key)
            ? s.checked.filter((k) => k !== key)
            : [...s.checked, key],
        })),
      setChecked: (checked) => set({ checked }),
      clearChecked: () => set({ checked: [] }),
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
      name: PERSIST_KEY,
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
      // Stored state is REPLACED into the store, not merged, so adding a
      // view to the `View` union silently breaks every existing install:
      // the persisted `filtersByView` has no key for it, and reading
      // `.sort` off undefined takes down the entire app with a black
      // window. This happened for real when `worktrees` and `docker`
      // were added -- both were already version 2, so the migration
      // above returned the old shape untouched.
      //
      // Merging per-view against EMPTY_FILTERS makes the store complete
      // by construction, for every view that exists now or later.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<FilterStore>;
        return {
          ...current,
          ...p,
          filtersByView: { ...EMPTY_FILTERS, ...(p.filtersByView ?? {}) },
        };
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
        density: s.density,
      }),
    },
  ),
);

/// Shared empty-filter object, so the fallback below is reference-stable.
const NO_FILTERS: Filters = Object.freeze({});

/// The active view's filters.
///
/// A selector rather than a stored field, so there is exactly one source
/// of truth and no chance of the two drifting apart.
export function useActiveFilters(): Filters {
  // NO_FILTERS is a module constant, not an inline `?? {}`. zustand
  // compares selector results by reference, so returning a fresh `{}`
  // each call makes every read look like a change and spins
  // useSyncExternalStore into an infinite re-render -- a worse failure
  // than the crash this guards against. Caught by the test below.
  //
  // The guard itself is real, not defensive noise. `filtersByView` is
  // rehydrated from disk, and `persist` REPLACES this object rather than
  // merging it -- so a store written before a view existed comes back
  // without that view's key. Every consumer reads `.sort` / `.repo` off
  // this value, so returning undefined crashes the whole tree.
  return useFilters((s) => s.filtersByView[s.view] ?? NO_FILTERS);
}
