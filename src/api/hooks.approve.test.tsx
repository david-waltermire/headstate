import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PrDetail } from "@/types/pr";

/// The detail response GitHub returns during its read-side lag: the
/// approval succeeded, and `latestReviews` does not show it yet.
const STALE_DETAIL = { latest_reviews: [] } as unknown as PrDetail;

const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, ...a: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { usePrDetail, useReviewPr } from "./hooks";

/// #440: after approving, the button stayed on "Approve" until you left
/// the PR and came back.
///
/// `useReviewPr` deliberately seeds the cache with the verdict it knows
/// landed, because `latestReviews` lags `addPullRequestReview` by a
/// second or two. Then it immediately awaited a refetch of THE SAME KEY
/// -- replacing the correct answer with GitHub's stale one, inside the
/// exact window the seed exists to cover.
describe("useReviewPr", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_pr_detail") return Promise.resolve(STALE_DETAIL);
      return Promise.resolve();
    });
  });

  it("keeps the approval visible while GitHub's read side lags", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["viewer"], "me");
    qc.setQueryData<PrDetail>(["pr-detail", "o/r", 7], STALE_DETAIL);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    // A MOUNTED observer of the detail query, which is what makes
    // `refetchQueries` actually refetch: it only refreshes ACTIVE
    // queries, so without a component watching the key the refetch is a
    // no-op and the bug cannot reproduce.
    const { result } = renderHook(
      () => ({ review: useReviewPr(), detail: usePrDetail("o/r", 7) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.data).toBeDefined());
    await result.current.review("id", "o/r", 7, "approve", "");

    const after = qc.getQueryData<PrDetail>(["pr-detail", "o/r", 7]);
    expect(after?.latest_reviews).toContainEqual({ author: "me", state: "APPROVED" });
  });

  /// The seed must not become a lie that outlives the truth: once
  /// GitHub reports the review, the normal fetch path replaces it.
  it("lets a later fetch replace the seeded verdict", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["viewer"], "me");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ review: useReviewPr(), detail: usePrDetail("o/r", 7) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.data).toBeDefined());
    await result.current.review("id", "o/r", 7, "approve", "");

    // GitHub has caught up and reports a DIFFERENT state.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_pr_detail") {
        return Promise.resolve({
          latest_reviews: [{ author: "me", state: "CHANGES_REQUESTED" }],
        } as unknown as PrDetail);
      }
      return Promise.resolve();
    });
    await qc.refetchQueries({ queryKey: ["pr-detail", "o/r", 7] });

    const after = qc.getQueryData<PrDetail>(["pr-detail", "o/r", 7]);
    expect(after?.latest_reviews).toEqual([{ author: "me", state: "CHANGES_REQUESTED" }]);
  });
});