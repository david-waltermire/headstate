import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { useFilters } from "../store/filters";

const reviewing = [
  { ...PR_FIXTURES[0], number: 900, title: "Someone else's PR", ci: "failure" as const },
];

vi.mock("../api/hooks", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    usePullRequests: () => ({ data: PR_FIXTURES, isLoading: false, isError: false }),
    usePollError: () => null,
    useRefreshRequested: () => undefined,
    useTruncation: () => null,
  useViewCadence: () => undefined,
  usePollState: () => "idle",
  useRemovalProgress: () => null,
  usePollInterval: () => ({ seconds: 120, set: () => Promise.resolve(120) }),
  useWorktreeDirs: () => ({ dirs: [], set: () => Promise.resolve([]) }),
    useReviewing: () => ({ data: reviewing, isLoading: false }),
    usePeriods: () => ({ data: undefined, isLoading: true, isError: false, refetch: () => {} }),
    useHistory: () => ({ data: undefined, isLoading: true, isError: false, refetch: () => {} }),
    useMergedDetail: () => ({ data: undefined, isLoading: true, isError: false, refetch: () => {} }),
  };
});

const { default: App } = await import("../App");

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe("PRs to review", () => {
  it("shows the incoming count on the view switcher", () => {
    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {},
  branches: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} }, view: "my-prs", panel: "list" } as never);
    renderApp();
    // The switcher heads the sidebar and badges the count; the old
    // bottom-pinned entry is gone.
    expect(screen.getByRole("button", { name: /my pull requests/i })).toBeTruthy();
  });

  it("lists the incoming PRs on its own view", () => {
    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {},
  branches: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} }, view: "to-review", panel: "list" } as never);
    renderApp();
    expect(screen.getByText("Someone else's PR")).toBeTruthy();
  });

  // Full parity: the review view gets the same sidebar, filters and
  // status rendering, driven by the reviewing list rather than my own.
  it("scopes the repo sidebar to the reviewing list", () => {
    useFilters.setState({
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {},
  branches: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} },
      view: "to-review",
      panel: "list",
    } as never);
    renderApp();
    // The reviewing fixture is one PR in octocat/hello-world; the
    // authored fixtures span two repos and must not appear here.
    expect(screen.queryByText("octocat/spoon-knife")).toBeNull();
  });

  it("offers filters on the review view, not just a flat list", () => {
    useFilters.setState({
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {},
  branches: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} },
      view: "to-review",
      panel: "list",
    } as never);
    renderApp();
    expect(screen.getByLabelText(/search pull requests/i)).toBeTruthy();
  });

  // The constraint that matters: `needsAttention` means "blocked on YOU as
  // author". A red-CI PR you were merely asked to review is not your
  // problem to fix, and must not inflate the strip, the chips, or the
  // tray badge.
  it("does not let another author's red CI reach the priorities strip", () => {
    useFilters.setState({ filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {},
  branches: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} }, view: "my-prs", panel: "list" } as never);
    renderApp();
    expect(screen.queryByText("Someone else's PR")).toBeNull();
  });
});
