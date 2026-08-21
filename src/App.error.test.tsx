import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/// Regression test for the audit's top finding: a REJECTED pull-request
/// query rendered as "0 Open -- No pull requests match these filters",
/// which is a confident wrong answer rather than an error.

vi.mock("./api/hooks", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    usePullRequests: () => mockQuery(),
    usePollError: () => null,
    useRefreshRequested: () => undefined,
  useTruncation: () => null,
  useViewCadence: () => undefined,
  usePollState: () => "idle",
  usePollInterval: () => ({ seconds: 120, set: () => Promise.resolve(120) }),
  useWorktreeDirs: () => ({ dirs: [], set: () => Promise.resolve([]) }),
  useReviewing: () => ({ data: [], isLoading: false }),
    usePeriods: () => ({ data: undefined, isLoading: true }),
    useHistory: () => ({ data: undefined, isLoading: true }),
    useMergedDetail: () => ({ data: undefined, isLoading: true }),
  };
});

const mockQuery = vi.fn();

const { default: App } = await import("./App");

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App — failed PR query", () => {
  it("shows an error, not an empty list, when the query rejects", async () => {
    mockQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: "not authenticated: run `gh auth login`",
      refetch: vi.fn(),
    });
    renderApp();

    await waitFor(() =>
      expect(screen.getByText(/could not load your pull requests/i)).toBeTruthy(),
    );
    // No empty-state copy at all -- an error is not an empty result.
    expect(screen.queryByText(/no open pull requests/i)).toBeNull();
    expect(screen.queryByText(/match these filters/i)).toBeNull();
  });

  it("surfaces the rejection message so the user can act on it", () => {
    mockQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: "not authenticated: run `gh auth login`",
      refetch: vi.fn(),
    });
    renderApp();
    expect(screen.getByText(/gh auth login/)).toBeTruthy();
  });

  it("offers a retry that refetches", () => {
    const refetch = vi.fn();
    mockQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("network down"),
      refetch,
    });
    renderApp();
    screen.getByRole("button", { name: /try again/i }).click();
    expect(refetch).toHaveBeenCalled();
  });

  // A genuinely empty result must still read as empty, not as an error.
  it("still shows the empty state when the query succeeds with no PRs", () => {
    mockQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    renderApp();
    // No filters active in this test, so the unfiltered copy applies.
    expect(screen.getByText(/no open pull requests/i)).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });
});
