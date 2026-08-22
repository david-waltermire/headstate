import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../api/hooks", () => ({
  usePrDetail: () => ({ ...state, error: "boom", refetch: vi.fn() }),
  useActOnPr: () => vi.fn(() => Promise.resolve()),
  useDeleteHeadBranch: () => deleteBranch,
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
  checks: [],
  ...over,
});

function view(over: Partial<PrDetail> = {}) {
  state.data = detail(over);
  return render(<PrDetailView repo="octocat/hello-world" number={42} onBack={() => {}} />);
}

describe("PrDetailView", () => {
  beforeEach(() => Object.assign(state, { data: undefined, isLoading: false, isError: false }));

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
        { name: "build", state: "success", url: "https://ci/1" },
        { name: "lint", state: "failure", url: "" },
      ],
    });
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("failure")).toBeTruthy();
  });

  // A check with no URL must not render an anchor going nowhere.
  it("only links checks that have a URL", () => {
    const { container } = view({
      checks: [{ name: "lint", state: "failure", url: "" }],
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

  // Deliberately absent: reviewing code belongs in GitHub or an editor.
  it("does not pretend to offer a diff or a comment box", () => {
    view();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: /view on github/i })).toBeTruthy();
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
