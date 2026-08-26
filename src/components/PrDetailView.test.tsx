import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrDetail } from "@/types/pr";

const state = vi.hoisted(() => ({
  data: undefined as PrDetail | undefined,
  isLoading: false,
  isError: false,
}));

const deleteBranch = vi.hoisted(() =>
  vi.fn<(r: string, repo: string, n: number, b: string, m: boolean) => Promise<void>>(
    () => Promise.resolve(),
  ),
);
const reviewPr = vi.fn(() => Promise.resolve());
const rerunChecks = vi.fn(() => Promise.resolve());
const commentOnPr = vi.fn(() => Promise.resolve());

vi.mock("../api/hooks", () => ({
  usePrDetail: () => ({ ...state, error: "boom", refetch: vi.fn() }),
  useActOnPr: () => vi.fn(() => Promise.resolve()),
  useDeleteHeadBranch: () => deleteBranch,
  useReviewPr: () => reviewPr,
  useRerunChecks: () => rerunChecks,
  useCommentOnPr: () => commentOnPr,
  // The detail view treats undefined as "we could not ask", which is
  // deliberately NOT the same as "this is mine" -- see ReviewBox.
  useViewer: () => ({ data: undefined }),
}));

import { PrDetailView } from "./PrDetailView";

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  id: "PR_test",
  number: 42,
  title: "Add retry to the fetch client",
  url: "https://github.com/octocat/hello-world/pull/42",
  state: "open",
  is_draft: false,
  body: "## Why\n\nThe client gave up too early.",
  author: "octocat",
  repo: "octocat/hello-world",
  head_ref: "feature/retry",
  head_oid: "oid-detail",
  head_ref_id: null,
  base_ref: "main",
  merge_status: "clean",
  review: "none",
  additions: 100,
  deletions: 20,
  changed_files: 3,
  unresolved_threads: 0,
  comment_count: 0,
  comments: [],
  latest_reviews: [],
  merge_queue_enabled: false,
  in_merge_queue: false,
  checks: [],
  ...over,
});

function view(over: Partial<PrDetail> = {}) {
  state.data = detail(over);
  return render(<PrDetailView repo="octocat/hello-world" number={42} onBack={() => {}} />);
}

describe("PrDetailView", () => {
  beforeEach(() => {
    Object.assign(state, { data: undefined, isLoading: false, isError: false });
    // The mutation mocks are module-level, so without this a later test
    // sees calls made by an earlier one -- which is exactly how the
    // "not called" assertion below failed while passing in isolation.
    reviewPr.mockClear();
    rerunChecks.mockClear();
    commentOnPr.mockClear();
    deleteBranch.mockClear();
  });

  it("shows the title, number and branch pair", () => {
    view();
    expect(screen.getByText(/add retry to the fetch client/i)).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("feature/retry")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("renders the description as Markdown", () => {
    const { container } = view();
    expect(screen.getByText("Why")).toBeTruthy();
    expect(container.querySelector("h2")).toBeTruthy();
  });

  // An empty body must read as empty, not as a broken render.
  it("says so when there is no description", () => {
    view({ body: "   " });
    expect(screen.getByText(/no description/i)).toBeTruthy();
  });

  it("lists each check with its outcome", () => {
    view({
      checks: [
        { name: "build", state: "success", url: "https://ci/1", run_id: null },
        { name: "lint", state: "failure", url: "", run_id: null },
      ],
    });
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("failure")).toBeTruthy();
  });

  // The `rerunnableRun` rules are tested in lib/rerun.test.ts. These
  // prove the button is WIRED to them.
  it("offers a re-run when a failing check has a workflow run", () => {
    view({ checks: [{ name: "lint", state: "failure", url: "", run_id: 99 }] });
    expect(screen.getByRole("button", { name: /re-run failed/i })).toBeTruthy();
  });

  it("offers no re-run when everything passed", () => {
    view({ checks: [{ name: "lint", state: "success", url: "", run_id: 99 }] });
    expect(screen.queryByRole("button", { name: /re-run failed/i })).toBeNull();
  });

  // A status context has no workflow run, so the REST call would 404.
  it("offers no re-run for a failure with no workflow run", () => {
    view({ checks: [{ name: "legacy", state: "failure", url: "", run_id: null }] });
    expect(screen.queryByRole("button", { name: /re-run failed/i })).toBeNull();
  });

  it("re-runs against the workflow run, not the check", async () => {
    view({ checks: [{ name: "lint", state: "failure", url: "", run_id: 99 }] });
    fireEvent.click(screen.getByRole("button", { name: /re-run failed/i }));
    await waitFor(() =>
      expect(rerunChecks).toHaveBeenCalledWith("octocat/hello-world", 42, 99),
    );
  });

  // A check with no URL must not render an anchor going nowhere.
  it("only links checks that have a URL", () => {
    const { container } = view({
      checks: [{ name: "lint", state: "failure", url: "", run_id: null }],
    });
    const anchors = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.textContent?.includes("lint"),
    );
    expect(anchors).toHaveLength(0);
  });

  it("renders comments with their author", () => {
    view({
      comment_count: 1,
      comments: [
        { author: "hubot", created_at: "2026-08-20T10:00:00Z", body: "looks good" },
      ],
    });
    expect(screen.getByText(/hubot/)).toBeTruthy();
    expect(screen.getByText(/looks good/)).toBeTruthy();
  });

  // The query caps comments at 50; claiming to show all of them would
  // be a quiet lie.
  it("says when comments are truncated", () => {
    view({ comment_count: 80, comments: [
      { author: "hubot", created_at: "2026-08-20T10:00:00Z", body: "one" },
    ] });
    expect(screen.getByText(/showing 1 of 80/i)).toBeTruthy();
  });

  it("surfaces unresolved conversations", () => {
    view({ unresolved_threads: 3 });
    expect(screen.getByText(/3 unresolved conversations/i)).toBeTruthy();
  });

  /// The reported problem: "there are no buttons that fix to the top of
  /// a PR as I'm scrolling, so I have to scroll all the way to the top
  /// to see approve and all the way to the bottom to see the view on
  /// github button".
  ///
  /// The actions were unreachable from where the decision gets made --
  /// after reading a long thread, every control was off-screen.
  it("pins the back, merge and GitHub actions to the top", () => {
    state.data = detail();
    const { container } = render(
      <PrDetailView repo="octocat/hello-world" number={42} onBack={vi.fn()} />,
    );
    const header = container.querySelector(".sticky");
    expect(header, "the header must be sticky, not merely present").toBeTruthy();
    const bar = header as HTMLElement;
    expect(within(bar).getByRole("button", { name: /back to list/i })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /^merge$/i })).toBeTruthy();
    expect(within(bar).getByText(/github/i)).toBeTruthy();
  });

  /// `top-0` only works because the app header above scrolls away. If
  /// that ever changes, the two overlap and this is the reminder.
  it("pins to the very top of the scroll container", () => {
    state.data = detail();
    const { container } = render(
      <PrDetailView repo="octocat/hello-world" number={42} onBack={vi.fn()} />,
    );
    expect(container.querySelector(".sticky")?.className).toContain("top-0");
  });

  /// Close is irreversible and deliberately NOT pinned: a destructive
  /// button that follows you down the page is the wrong one to make
  /// easier to reach.
  it("does not pin the irreversible close action", () => {
    state.data = detail();
    const { container } = render(
      <PrDetailView repo="octocat/hello-world" number={42} onBack={vi.fn()} />,
    );
    const bar = container.querySelector(".sticky") as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /close pr/i })).toBeNull();
    // Still available in the body, where it always was.
    expect(screen.getByRole("button", { name: /close pr/i })).toBeTruthy();
  });

  /// The header must not become a second source of truth for which
  /// merge action applies -- it renders `PrActions` in compact mode
  /// rather than reimplementing the merge/enqueue/dequeue choice.
  it("pins the queue action on a merge-queue branch, not a plain merge", () => {
    state.data = { ...detail(), merge_queue_enabled: true };
    const { container } = render(
      <PrDetailView repo="octocat/hello-world" number={42} onBack={vi.fn()} />,
    );
    const bar = container.querySelector(".sticky") as HTMLElement;
    expect(within(bar).getByRole("button", { name: /add to merge queue/i })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: /^merge$/i })).toBeNull();
  });

  it("offers a way back to the list", () => {
    const onBack = vi.fn();
    state.data = detail();
    render(<PrDetailView repo="octocat/hello-world" number={42} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to list/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows an error rather than a blank page", () => {
    state.isError = true;
    render(<PrDetailView repo="octocat/hello-world" number={42} onBack={() => {}} />);
    expect(screen.getByText(/could not load this pull request/i)).toBeTruthy();
  });

  // This DELIBERATELY reverses an earlier assertion. The old test read
  // "does not pretend to offer a diff or a comment box", encoding the
  // v1 stance that reviewing belongs in GitHub. The comment box is now
  // the point -- approving was the most common reviewer action and the
  // one thing that still forced a trip to the browser.
  //
  // The diff genuinely stays absent: rendering one well is a different
  // product, and the GitHub link remains the way there.
  it("offers a review box but still no diff", () => {
    view();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByRole("link", { name: /view on github/i })).toBeTruthy();
    expect(screen.queryByText(/^@@/)).toBeNull();
  });

  it("submits a verdict through the review hook", async () => {
    view();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "needs work" } });
    fireEvent.click(screen.getByRole("button", { name: /request changes/i }));
    await waitFor(() =>
      expect(reviewPr).toHaveBeenCalledWith(
        "PR_test",
        "octocat/hello-world",
        42,
        "request_changes",
        "needs work",
      ),
    );
  });

  // "Comment" must post a CONVERSATION comment, not a COMMENT review.
  // They are different GraphQL nodes -- addComment makes an IssueComment,
  // addPullRequestReview makes a PullRequestReview with state COMMENTED
  // -- and the comment list in this view renders IssueComments. Routing
  // it through the review mutation would post something the user could
  // then not see in the list right above the box.
  it("posts a plain comment through addComment, not as a review", async () => {
    view();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
    await waitFor(() =>
      expect(commentOnPr).toHaveBeenCalledWith("PR_test", "octocat/hello-world", 42, "looks good"),
    );
    expect(reviewPr).not.toHaveBeenCalled();
  });

  // 31 of the last 60 merged PRs on a real account still held a live
  // remote branch. This is the app's own thesis applied to the one
  // domain where it did nothing.
  describe("delete branch", () => {
    it("is offered once the PR has merged and the branch still exists", () => {
      state.data = { ...detail(), state: "MERGED", head_ref_id: "REF_1" };
      render(<PrDetailView repo="o/r" number={1} onBack={() => {}} />);
      expect(screen.getByRole("button", { name: /delete branch/i })).toBeTruthy();
    });

    // Deleting the head ref of an OPEN pull request closes it off.
    it("is never offered while the PR is still open", () => {
      state.data = { ...detail(), state: "OPEN", head_ref_id: "REF_1" };
      render(<PrDetailView repo="o/r" number={1} onBack={() => {}} />);
      expect(screen.queryByRole("button", { name: /delete branch/i })).toBeNull();
    });

    // A null ref id IS the signal that cleanup already happened.
    it("is not offered once the branch is already gone", () => {
      state.data = { ...detail(), state: "MERGED", head_ref_id: null };
      render(<PrDetailView repo="o/r" number={1} onBack={() => {}} />);
      expect(screen.queryByRole("button", { name: /delete branch/i })).toBeNull();
    });

    it("passes merged=true so the backend gate can agree", async () => {
      state.data = { ...detail(), state: "MERGED", head_ref_id: "REF_1" };
      render(<PrDetailView repo="o/r" number={1} onBack={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /delete branch/i }));
      await waitFor(() => expect(deleteBranch).toHaveBeenCalled());
      expect(deleteBranch.mock.calls[0][0]).toBe("REF_1");
      expect(deleteBranch.mock.calls[0][4]).toBe(true);
    });
  });
});
