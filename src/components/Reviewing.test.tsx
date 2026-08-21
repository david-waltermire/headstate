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
  usePollState: () => "idle",
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

describe("Awaiting your review", () => {
  it("shows the incoming count in the sidebar", () => {
    useFilters.setState({ filters: {}, view: "list" } as never);
    renderApp();
    expect(screen.getByRole("button", { name: /awaiting your review/i })).toBeTruthy();
  });

  it("lists the incoming PRs on its own view", () => {
    useFilters.setState({ filters: {}, view: "reviewing" } as never);
    renderApp();
    expect(screen.getByText("Someone else's PR")).toBeTruthy();
  });

  // The constraint that matters: `needsAttention` means "blocked on YOU as
  // author". A red-CI PR you were merely asked to review is not your
  // problem to fix, and must not inflate the strip, the chips, or the
  // tray badge.
  it("does not let another author's red CI reach the priorities strip", () => {
    useFilters.setState({ filters: {}, view: "list" } as never);
    renderApp();
    expect(screen.queryByText("Someone else's PR")).toBeNull();
  });
});
