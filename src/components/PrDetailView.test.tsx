import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrDetail } from "@/types/pr";

const state = vi.hoisted(() => ({
  data: undefined as PrDetail | undefined,
  isLoading: false,
  isError: false,
}));

vi.mock("../api/hooks", () => ({
  usePrDetail: () => ({ ...state, error: "boom", refetch: vi.fn() }),
  useActOnPr: () => vi.fn(() => Promise.resolve()),
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
});
