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
  head_ref_id: null,
  base_ref: "main",
  merge_status: "clean",
  review: "approved",
  additions: 1,
  deletions: 0,
  changed_files: 1,
  unresolved_threads: 0,
  comment_count: 0,
  comments: [],
  latest_reviews: [],
  merge_queue_enabled: false,
  in_merge_queue: false,
  checks: [],
  ...over,
});

describe("PrActions", () => {
  /// Offering Merge and "Add to merge queue" side by side asked the user
  /// to know which one their repo needs -- and on a queue-enabled branch
  /// Merge is simply the wrong button.
  it("offers only the queue action when the base branch queues", () => {
    render(<PrActions pr={pr({ merge_queue_enabled: true })} />);
    expect(screen.getByRole("button", { name: "Add to merge queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("offers only Merge when the base branch does not queue", () => {
    render(<PrActions pr={pr({ merge_queue_enabled: false })} />);
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to merge queue" })).toBeNull();
  });

  /// Once it is queued the only useful action is getting it back out.
  it("offers dequeue instead once the pull request is queued", () => {
    render(<PrActions pr={pr({ merge_queue_enabled: true, in_merge_queue: true })} />);
    expect(screen.getByRole("button", { name: "Remove from merge queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to merge queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  /// Close is irreversible from here -- `inverseOf` gives it no undo --
  /// and it sits beside "Back to list", where a bare "Close" reads as
  /// "close this view". Both halves of that fix are asserted: the words
  /// and the destructive styling.
  /// #349: approved a pull request, clicked merge, got "GitHub has not
  /// confirmed this can merge" -- then found it merged on GitHub.
  ///
  /// `unknown` is what GitHub reports WHILE it recomputes mergeability,
  /// and an approval is exactly what triggers that. The old wording
  /// reported a transient state in the words of a settled refusal.
  it("says the unknown merge state is transient, not a refusal", () => {
    render(<PrActions pr={pr({ merge_status: "unknown" })} />);
    expect(screen.getByText(/still checking/i)).toBeTruthy();
    expect(screen.queryByText(/has not confirmed/i)).toBeNull();
  });

  /// Still disabled: acting on a state we cannot read is the one wrong
  /// answer that costs something. The defect was the wording, not the
  /// gate.
  it("keeps merge disabled while the state is unknown", () => {
    render(<PrActions pr={pr({ merge_status: "unknown" })} />);
    const btn = screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  /// A genuinely unmergeable state keeps its own words -- collapsing
  /// them all into "still checking" would tell the user to wait for
  /// something that is never going to resolve.
  it("keeps the settled wording for a state that is not transient", () => {
    render(<PrActions pr={pr({ merge_status: "dirty" })} />);
    expect(screen.getByText(/merge conflicts/i)).toBeTruthy();
    expect(screen.queryByText(/still checking/i)).toBeNull();
  });

  it("names the close action so it cannot be read as closing the view", () => {
    render(<PrActions pr={pr()} />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close PR" })).toBeTruthy();
  });

  it("styles close destructively, unlike its neutral neighbours", () => {
    render(<PrActions pr={pr()} />);
    const close = screen.getByRole("button", { name: "Close PR" });
    const neutral = screen.getByRole("button", { name: "Convert to draft" });
    expect(close.className).toContain("f85149");
    expect(neutral.className).not.toContain("f85149");
  });

  /// The button and the toast need DIFFERENT words. Reusing the button
  /// label lowercased -- which is what the code did before -- produces
  /// "octocat/hello-world#42 - close pr".
  it("reports the close in past tense, not as the button's label", async () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PR" }));
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = toastSuccess.mock.calls[0][0] as string;
    expect(msg).toContain("closed");
    expect(msg).not.toContain("close pr");
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Close PR" }));
    expect(actFn).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes only after confirmation", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PR" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /close pull request/i }),
    );
    expect(actFn).toHaveBeenCalledWith("PR_abc", "octocat/hello-world", 42, "close");
  });

  it("cancelling closes nothing", () => {
    render(<PrActions pr={pr()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PR" }));
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
      // Transient, so it gets its own wording -- see #349. Still
      // disabled, which is what this test is really pinning.
      ["unknown", /still checking/i],
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
