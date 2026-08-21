import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrDetail } from "@/types/pr";

const actFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../api/hooks", () => ({ useActOnPr: () => actFn }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { PrActions } from "./PrActions";

const pr = (over: Partial<PrDetail> = {}): PrDetail => ({
  id: "PR_abc",
  number: 42,
  title: "Add retry",
  url: "u",
  state: "open",
  is_draft: false,
  body: "",
  author: "octocat",
  repo: "octocat/hello-world",
  head_ref: "feature",
  head_oid: "oid-detail",
  base_ref: "main",
  merge_status: "clean",
  review: "approved",
  additions: 1,
  deletions: 0,
  changed_files: 1,
  unresolved_threads: 0,
  comment_count: 0,
  comments: [],
  checks: [],
  ...over,
});

describe("PrActions", () => {
  beforeEach(() => {
    actFn.mockClear();
    actFn.mockImplementation(() => Promise.resolve());
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  // Merge applies immediately: it is the action this app exists to speed
  // up, and it is recoverable. Safety comes from the button being
  // enabled only when GitHub says the PR is mergeable.
  it("merges immediately, with no confirmation", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(actFn).toHaveBeenCalledWith("PR_abc", "octocat/hello-world", 42, "merge");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Closing loses review context and is rare, so it earns a dialog.
  it("confirms before closing", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(actFn).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes only after confirmation", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /close pull request/i }),
    );
    expect(actFn).toHaveBeenCalledWith("PR_abc", "octocat/hello-world", 42, "close");
  });

  it("cancelling closes nothing", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(actFn).not.toHaveBeenCalled();
  });

  // THE safety property: merge must be impossible when GitHub would
  // reject it. 14 of 25 open PRs on this account are dirty or unstable.
  it("disables merge for every non-clean state, with a reason", () => {
    for (const [status, reason] of [
      ["dirty", /conflict/i],
      ["blocked", /required review/i],
      ["unstable", /checks are failing/i],
      ["behind", /behind its base/i],
      ["unknown", /has not confirmed/i],
    ] as const) {
      const { unmount } = render(<PrActions pr={pr({ merge_status: status })} />);
      expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", true);
      expect(screen.getByText(reason)).toBeTruthy();
      unmount();
    }
  });

  it("never offers merge on a draft", () => {
    render(<PrActions pr={pr({ is_draft: true })} />);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: /mark ready/i })).toBeTruthy();
  });

  it("toasts success", async () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  // GitHub's refusal text tells the user what to do; a substitute does not.
  it("toasts GitHub's own refusal message", async () => {
    actFn.mockImplementationOnce(() =>
      Promise.reject("Base branch was modified. Review and try the merge again."),
    );
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("42"),
        expect.objectContaining({
          description: "Base branch was modified. Review and try the merge again.",
        }),
      ),
    );
  });
});
