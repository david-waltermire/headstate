import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EcosystemReport, Outdated, ProjectReport } from "@/types/pr";

const state = vi.hoisted(() => ({
  repo: "/code/app" as string | undefined,
  reports: [] as ProjectReport[],
  loading: false,
}));
const markdownFn = vi.hoisted(() => vi.fn(() => Promise.resolve("# md")));
// Typed via the mock's signature rather than an unused parameter, so
// `copyFn.mock.calls[0][0]` is a string without eslint objecting to an
// argument nothing reads.
const copyFn = vi.hoisted(() =>
  vi.fn<(text: string) => Promise<string | null>>(() => Promise.resolve(null)),
);

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

/// One ecosystem's report, wrapped as the single unnamed project a
/// one-project repository produces.
const report = (over: Partial<EcosystemReport> = {}): ProjectReport => ({
  path: "/code/app",
  label: "",
  reports: [{ ecosystem: "npm", outdated: [], error: null, ...over }],
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

describe("PackagesPage grouping, sorting, and Claudify", () => {
  const project = (label: string, names: string[]): ProjectReport => ({
    path: `/code/app/${label}`,
    label,
    reports: [
      {
        ecosystem: "npm",
        outdated: names.map((n) => pkg(n, "patch")),
        error: null,
      },
    ],
  });

  /// A repository with several projects must say which is which: the
  /// same package at two versions in two projects is otherwise two
  /// indistinguishable rows.
  it("groups a multi-project repository by project", () => {
    state.reports = [project("frontend", ["a"]), project("backend", ["b"])];
    render(<PackagesPage />);
    expect(screen.getByRole("button", { name: /frontend/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /backend/ })).toBeTruthy();
  });

  /// ...and a single-project repo must NOT grow a heading that says
  /// nothing.
  it("adds no project heading to a single-project repository", () => {
    state.reports = [report({ outdated: [pkg("a", "patch")] })];
    render(<PackagesPage />);
    expect(screen.queryByRole("button", { name: /repository root/ })).toBeNull();
  });

  it("collapses a project group", () => {
    state.reports = [project("frontend", ["only-in-frontend"]), project("backend", ["b"])];
    render(<PackagesPage />);
    expect(screen.getByText("only-in-frontend")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /frontend/ }));
    expect(screen.queryByText("only-in-frontend")).toBeNull();
  });

  it("filters by package name", () => {
    state.reports = [report({ outdated: [pkg("react", "patch"), pkg("vite", "patch")] })];
    render(<PackagesPage />);
    fireEvent.change(screen.getByLabelText(/Filter packages by name/), {
      target: { value: "rea" },
    });
    expect(screen.getByText("react")).toBeTruthy();
    expect(screen.queryByText("vite")).toBeNull();
  });

  it("sorts by biggest jump by default, and by name on request", () => {
    // Both within the DEFAULT filter, so the ordering is what the test
    // observes rather than the filter. `zeta` is the bigger jump and
    // sorts first by size; `alpha` sorts first by name.
    state.reports = [
      report({ outdated: [pkg("zeta", "minor"), pkg("alpha", "patch")] }),
    ];
    render(<PackagesPage />);
    const names = () =>
      screen.getAllByText(/^(zeta|alpha)$/).map((el) => el.textContent);
    expect(names()[0]).toBe("zeta");

    fireEvent.change(screen.getByLabelText(/Sort updates/), { target: { value: "name" } });
    expect(names()[0]).toBe("alpha");
  });

  /// Claudify is an INSTRUCTION where Copy markdown is a REPORT. The
  /// prompt has to say what to do and, critically, to verify rather than
  /// assume -- an update applied without running the tests produces a
  /// change nobody can trust.
  it("builds a prompt that asks for verification", async () => {
    state.reports = [report({ outdated: [pkg("a", "patch")] })];
    render(<PackagesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Claudify" }));
    await waitFor(() => expect(copyFn).toHaveBeenCalled());
    const prompt = copyFn.mock.calls[0][0];
    expect(prompt).toMatch(/run that project's own tests/i);
    expect(prompt).toMatch(/ACTUALLY chose/);
    expect(prompt).toMatch(/Do not update anything that is not listed/i);
  });
});
