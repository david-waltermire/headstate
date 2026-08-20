import { create } from "zustand";
import type { Filters } from "../lib/derive";

/// zustand holds UI state only. Server data lives in TanStack Query and is
/// never duplicated here.
interface FilterStore {
  filters: Filters;
  view: "list" | "dashboard";
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  applyPreset: (filters: Filters) => void;
  setView: (view: "list" | "dashboard") => void;
  reset: () => void;
}

export const useFilters = create<FilterStore>((set) => ({
  filters: {},
  view: "list",
  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
  // Dashboard cards navigate by replacing the filter set wholesale, so a
  // card click never inherits a filter the user forgot was active and
  // shows a count that doesn't match the list.
  applyPreset: (filters) => set({ filters, view: "list" }),
  setView: (view) => set({ view }),
  reset: () => set({ filters: {} }),
}));
