import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "./types/pr";
import { PR_FIXTURES, prWithState } from "./fixtures/prs";
import { useFilters } from "./store/filters";

// The shell talks to Tauri on mount. Stub the command surface so these tests
// exercise the wiring, not the backend.
const mockPrs = vi.fn<() => PullRequest[]>(() => []);
const mockReviewing = vi.fn<() => PullRequest[]>(() => []);
const mockRefused = vi.fn<() => number>(() => 0);

vi.mock("./api/hooks", () => ({
  // Defaults, matching the Rust side: nothing hidden, close hides.
  useUiPrefs: () => ({
    prefs: { hidden_views: [], close_hides_to_tray: true },
    set: () => Promise.resolve(),
  }),
  useAutostart: () => ({ enabled: false, set: () => Promise.resolve() }),
  useActOnPr: () => () => Promise.resolve(),
  useUpdatePrBranch: () => () => Promise.resolve(),
  useActOnPrs: () => () => Promise.resolve([]),
  useSetAutoMerge: () => () => Promise.resolve(),
  usePullRequests: () => ({ data: mockPrs(), isSuccess: true, isLoading: false }),
  usePollError: () => null,
  useRefreshRequested: () => undefined,
  useTruncation: () => null,
  // No refused fields: the advisory banner stays hidden.
  useIncomplete: () => mockRefused(),
  useViewCadence: () => undefined,
  usePollState: () => "idle",
  usePollInterval: () => ({ seconds: 120, set: () => Promise.resolve(120) }),
  useWorktreeDirs: () => ({ dirs: [], set: () => Promise.resolve([]) }),
  // Defaults, matching the Rust side: absent prefs mean everything on.
  useNotifyPrefs: () => ({
    prefs: { enabled: true, ci_failed: true, conflicted: true },
    set: () => Promise.resolve(),
  }),
  useReviewing: () => ({ data: mockReviewing(), isLoading: false }),
  // The badge's own cheap query, separate from the list.
  useReviewingCount: () => ({ data: mockReviewing().length }),
  // PrDetailView's hooks: App's mock replaces the whole module, so
  // rendering the detail branch needs every hook it calls.
  usePrDetail: () => ({ data: undefined, isLoading: true, isError: false, refetch: () => {} }),
  useDeleteHeadBranch: () => () => Promise.resolve(),
  useReviewPr: () => () => Promise.resolve(),
  useCommentOnPr: () => () => Promise.resolve(),
  useRerunChecks: () => () => Promise.resolve(),
  useViewer: () => ({ data: undefined }),
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
    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} }, view: "my-prs", panel: "list" } as never);
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

    useFilters.setState({ filtersByView: { "my-prs": { repo: "octocat/hello-world" }, "to-review": {}, worktrees: {}, docker: {} }, view: "my-prs", panel: "list" } as never);
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

    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} }, view: "my-prs", panel: "list" } as never);
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

    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} }, view: "my-prs", panel: "stats" } as never);
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

    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} }, view: "my-prs", panel: "list" } as never);
    renderApp();

    const strip = screen.getByText(/Needs your attention/).closest("section");
    expect(strip?.textContent).toContain("Blocked but unlabelled");
  });
});

/// The key MAPPING is tested in `lib/shortcuts.nav.test.ts`. These prove
/// it is WIRED: a correct mapping that never moves the cursor is worth
/// nothing to the user.
describe("keyboard triage", () => {
  beforeEach(() => useFilters.setState({ cursor: null, checked: [] }));

  const press = (key: string) =>
    fireEvent.keyDown(window, { key, bubbles: true });

  it("puts the cursor on the first row on the first press", () => {
    render(<App />);
    press("j");
    expect(useFilters.getState().cursor).toBe(0);
  });

  it("walks down and back up", () => {
    render(<App />);
    press("j");
    press("j");
    expect(useFilters.getState().cursor).toBe(1);
    press("k");
    expect(useFilters.getState().cursor).toBe(0);
  });

  // Clamped, not wrapped: wrapping from the bottom back to the top
  // silently moves the eye across the whole screen.
  it("stops at the top rather than wrapping", () => {
    render(<App />);
    press("j");
    press("k");
    press("k");
    expect(useFilters.getState().cursor).toBe(0);
  });

  it("selects the cursor row with x", () => {
    render(<App />);
    press("j");
    press("x");
    expect(useFilters.getState().checked).toHaveLength(1);
  });

  // `x` with no cursor must do nothing rather than select row 0 -- the
  // user has not pointed at anything yet.
  it("does nothing on x before the cursor exists", () => {
    render(<App />);
    press("x");
    expect(useFilters.getState().checked).toEqual([]);
  });
});

/// Reported: clicking a pull request on To review did not show it.
///
/// The existing tests mocked `useReviewing` to an empty array, so no
/// test ever clicked a row on that view -- which is how a regression
/// here would go unnoticed regardless of cause.
describe("opening a pull request from To review", () => {
  const theirs: PullRequest = {
    ...PR_FIXTURES[0],
    repo: "someone/else",
    number: 71,
    title: "Someone else's pull request",
    author: "caitlinhalla",
  };

  beforeEach(() => {
    mockPrs.mockReturnValue([]);
    mockReviewing.mockReturnValue([theirs]);
    useFilters.setState({
      view: "to-review",
      panel: "list",
      selectedPr: null,
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} },
    });
  });

  it("lists the review queue", () => {
    render(<App />);
    expect(screen.getByText(theirs.title)).toBeTruthy();
  });

  it("selects the pull request when its row is clicked", () => {
    render(<App />);
    fireEvent.click(screen.getByText(theirs.title));
    expect(useFilters.getState().selectedPr).toEqual({
      repo: "someone/else",
      number: 71,
    });
  });

  // The actual complaint: selecting it must SHOW it, not leave the list
  // on screen. `view !== "worktrees"` already allows this branch, so a
  // failure here is about rendering rather than routing.
  it("shows the detail view rather than staying on the list", () => {
    useFilters.setState({ selectedPr: { repo: "someone/else", number: 71 } });
    render(<App />);
    expect(screen.getByRole("button", { name: /back to list/i })).toBeTruthy();
  });
});


/// v3.2.5 escalated a partial response to a hard error, so a user who
/// had been seeing a short review queue started seeing nothing at all.
/// The data is kept now, and the shortfall is said out loud instead.
describe("an incomplete refresh", () => {
  beforeEach(() => {
    mockRefused.mockReturnValue(0);
    mockPrs.mockReturnValue([]);
    useFilters.setState({
      view: "my-prs",
      panel: "list",
      selectedPr: null,
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} },
    });
  });

  it("says so when GitHub refused some fields", () => {
    mockRefused.mockReturnValue(86);
    render(<App />);
    expect(screen.getByText(/could not compute 86 fields/i)).toBeTruthy();
  });

  // Silence is the normal case; a banner that is always there stops
  // being read.
  it("stays quiet when nothing was refused", () => {
    render(<App />);
    expect(screen.queryByText(/could not compute/i)).toBeNull();
  });

  // The whole point of the fix: the list is still there.
  it("still renders the pull requests it did receive", () => {
    mockRefused.mockReturnValue(86);
    mockPrs.mockReturnValue([{ ...PR_FIXTURES[0], title: "Survived" }]);
    render(<App />);
    expect(screen.getByText("Survived")).toBeTruthy();
  });
});
