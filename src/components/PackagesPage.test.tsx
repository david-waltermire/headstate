import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EcosystemReport, Outdated } from "@/types/pr";

const state = vi.hoisted(() => ({
  repo: "/code/app" as string | undefined,
  reports: [] as EcosystemReport[],
  loading: false,
}));
const markdownFn = vi.hoisted(() => vi.fn(() => Promise.resolve("# md")));
const copyFn = vi.hoisted(() => vi.fn(() => Promise.resolve(null as string | null)));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api/hooks", () => ({
  usePackages: () => ({
    data: state.reports,
    isLoading: state.loading,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../api/tauri", () => ({ packagesMarkdown: markdownFn }));
vi.mock("../lib/clipboard", () => ({ copyText: copyFn }));
vi.mock("../store/filters", () => ({ useActiveFilters: () => ({ repo: state.repo }) }));

import { PackagesPage } from "./PackagesPage";

const pkg = (name: string, bump: Outdated["bump"]): Outdated => ({
  name,
  current: "1.0.0",
  latest: "2.0.0",
  bump,
  ecosystem: "npm",
  manifest: "package.json",
});

const report = (over: Partial<EcosystemReport> = {}): EcosystemReport => ({
  ecosystem: "npm",
  outdated: [],
  error: null,
  ...over,
});

beforeEach(() => {
  state.repo = "/code/app";
  state.reports = [];
  state.loading = false;
  markdownFn.mockClear();
  copyFn.mockClear();
  copyFn.mockResolvedValue(null);
});

describe("PackagesPage", () => {
  it("asks for a repository before checking anything", () => {
    state.repo = undefined;
    render(<PackagesPage />);
    expect(screen.getByText(/Choose a repository/)).toBeTruthy();
  });

  /// The filters are the feature. "Patch only" must mean patch.
  it("filters by the size of the jump", () => {
    state.reports = [
      report({ outdated: [pkg("a", "patch"), pkg("b", "minor"), pkg("c", "major")] }),
    ];
    render(<PackagesPage />);

    // Default is patch-and-minor.
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.queryByText("c")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Patch only" }));
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
  });

  /// A list that silently omits what nothing could classify looks
  /// complete when it is not -- and those are precisely the packages
  /// nobody can vouch for.
  it("says how many packages the filter is hiding as uncomparable", () => {
    state.reports = [report({ outdated: [pkg("a", "patch"), pkg("odd", "unknown")] })];
    render(<PackagesPage />);
    expect(screen.queryByText("odd")).toBeNull();
    expect(screen.getByText(/1 package had versions this could not compare/)).toBeTruthy();
  });

  it("shows uncomparable packages under Everything", () => {
    state.reports = [report({ outdated: [pkg("odd", "unknown")] })];
    render(<PackagesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(screen.getByText("odd")).toBeTruthy();
  });

  /// A tool that could not run must NEVER render as "up to date". That
  /// is the worst available answer, because nobody investigates good
  /// news.
  it("states a failed check instead of showing an empty list", () => {
    state.reports = [report({ error: "npm was not found" })];
    render(<PackagesPage />);
    expect(screen.getByText(/npm was not found/)).toBeTruthy();
    expect(screen.queryByText(/Nothing matches this filter/)).toBeNull();
  });

  it("says when there is genuinely nothing to do", () => {
    state.reports = [report()];
    render(<PackagesPage />);
    expect(screen.getByText(/Nothing matches this filter/)).toBeTruthy();
  });

  /// The markdown IS the deliverable of v1.
  it("copies markdown for the active filter", async () => {
    state.reports = [report({ outdated: [pkg("a", "patch")] })];
    render(<PackagesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));
    await waitFor(() => expect(copyFn).toHaveBeenCalled());
    expect(markdownFn).toHaveBeenCalledWith("/code/app", state.reports, "minor");
  });

  it("reports a clipboard failure rather than claiming success", async () => {
    copyFn.mockResolvedValue("This window has no clipboard access.");
    state.reports = [report({ outdated: [pkg("a", "patch")] })];
    render(<PackagesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
