import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Filters } from "../lib/derive";

/// zustand holds UI state only. Server data lives in TanStack Query and is
/// never duplicated here.
interface FilterStore {
  filters: Filters;
  view: "list" | "dashboard" | "reviewing";
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  applyPreset: (filters: Filters) => void;
  setView: (view: "list" | "dashboard" | "reviewing") => void;
  reset: () => void;
}

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
      filters: {},
      view: "list",
      setFilter: (key, value) =>
        set((s) => ({ filters: { ...s.filters, [key]: value } })),
      // Preset navigation replaces the filter set wholesale, so a click
      // never inherits a filter the user forgot was active and shows a
      // count that doesn't match the list it opens.
      applyPreset: (filters) => set({ filters, view: "list" }),
      setView: (view) => set({ view }),
      // `repo` is sidebar NAVIGATION, not a filter chip -- it decides
      // which page you are on, scopes the priorities strip, and
      // pre-answers the wizard's repo step. Clearing it navigated the user
      // off the repo they were looking at, which is not what "Clear
      // filters" says it does.
      reset: () =>
        set((s) => ({ filters: s.filters.repo ? { repo: s.filters.repo } : {} })),
    }),
    {
      name: "headstate-filters",
      partialize: (s) => ({
        filters: { ...s.filters, query: undefined },
        view: s.view,
      }),
    },
  ),
);
