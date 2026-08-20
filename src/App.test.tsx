import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "./types/pr";
import { PR_FIXTURES, prWithState } from "./fixtures/prs";
import { useFilters } from "./store/filters";

// The shell talks to Tauri on mount. Stub the command surface so these tests
// exercise the wiring, not the backend.
const mockPrs = vi.fn<() => PullRequest[]>(() => []);

vi.mock("./api/hooks", () => ({
  usePullRequests: () => ({ data: mockPrs(), isSuccess: true, isLoading: false }),
  usePollError: () => null,
  useRefreshRequested: () => undefined,
  useTruncation: () => null,
  useReviewing: () => ({ data: [], isLoading: false }),
  useCycleTrend: () => ({ data: undefined }),
  // StatsPage owns these; this suite only asserts the shell's layout, so
  // they return a settled empty result rather than real figures.
  // Non-zero on purpose: an all-zero account now renders a single
  // "no merged pull requests yet" message instead of the card grid, and
  // this suite asserts on a card being present.
  usePeriods: () => ({
    data: {
      week_current: 5,
      week_previous: 3,
      opened_week_current: 6,
      opened_week_previous: 4,
      month_current: 20,
      month_previous: 18,
    },
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useHistory: () => ({
    data: {
      points: [],
      week_current: 0,
      week_previous: 0,
      opened_week_current: 0,
      opened_week_previous: 0,
      month_current: 0,
      month_previous: 0,
    },
    isLoading: false,
  }),
  useMergedDetail: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("./components/AuthGate", () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: App } = await import("./App");

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App — priorities strip scoping", () => {
  afterEach(() => {
    useFilters.setState({ filters: {}, view: "list" });
    vi.clearAllMocks();
  });

  /// Two blocked PRs in different repos. Selecting one repo must scope the
  /// strip to it: a page for `octocat/hello-world` showing a PR from
  /// `octocat/spoon-knife` is answering a question the user did not ask.
  it("scopes the strip to the selected repo in the list view", () => {
    const here = prWithState("failure", "mergeable", "none", {
      number: 101,
      repo: "octocat/hello-world",
      title: "Blocked in the selected repo",
    });
    const elsewhere = prWithState("failure", "mergeable", "none", {
      number: 202,
      repo: "octocat/spoon-knife",
      title: "Blocked in a different repo",
    });
    mockPrs.mockReturnValue([here, elsewhere]);

    useFilters.setState({ filters: { repo: "octocat/hello-world" }, view: "list" });
    renderApp();

    // Scope to the strip: the selected repo's PR also appears in the list
    // below, so a document-wide query would find it twice.
    const strip = screen.getByText(/Needs your attention \(1\)/).closest("section");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Blocked in the selected repo");
    expect(strip?.textContent).not.toContain("Blocked in a different repo");
  });

  it("shows every repo in the strip when no repo is selected", () => {
    const here = prWithState("failure", "mergeable", "none", {
      number: 101,
      repo: "octocat/hello-world",
      title: "Blocked in one repo",
    });
    const elsewhere = prWithState("failure", "mergeable", "none", {
      number: 202,
      repo: "octocat/spoon-knife",
      title: "Blocked in another repo",
    });
    mockPrs.mockReturnValue([here, elsewhere]);

    useFilters.setState({ filters: {}, view: "list" });
    renderApp();

    expect(screen.getByText(/Needs your attention \(2\)/)).toBeDefined();
  });

  /// Stats is a read-only summary, not a triage surface -- the strip
  /// belongs beside the list it acts on. Asserting the strip is ABSENT
  /// rather than just that cards render: an extra panel above the cards
  /// would still pass a cards-are-present check.
  it("shows no priorities strip on the stats view", () => {
    const blocked = prWithState("failure", "mergeable", "none", {
      number: 101,
      repo: "octocat/hello-world",
      title: "Blocked in one repo",
    });
    mockPrs.mockReturnValue([blocked]);

    useFilters.setState({ filters: {}, view: "dashboard" });
    renderApp();

    expect(screen.queryByText(/Needs your attention/)).toBeNull();
    // The stats content itself still renders, so this is proving the strip
    // is absent from a populated page rather than from a blank one.
    expect(screen.getByText(/Merged this week/)).toBeDefined();
  });

  /// A repo selection scopes the strip; a label filter must not. Something
  /// blocked on you stays blocked regardless of what you are filtering the
  /// list by.
  it("does not let a non-repo filter hide a blocked PR", () => {
    const blocked = prWithState("failure", "mergeable", "none", {
      number: 303,
      repo: "octocat/hello-world",
      title: "Blocked but unlabelled",
      labels: [],
    });
    mockPrs.mockReturnValue([blocked, ...PR_FIXTURES]);

    useFilters.setState({ filters: { includeLabels: ["bug"] }, view: "list" });
    renderApp();

    const strip = screen.getByText(/Needs your attention/).closest("section");
    expect(strip?.textContent).toContain("Blocked but unlabelled");
  });
});
