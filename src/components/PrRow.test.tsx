import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery as render } from "@/test-utils";
import { describe, expect, it, vi } from "vitest";

import type { PullRequest } from "@/types/pr";
import { PR_FIXTURES } from "@/fixtures/prs";
import { PrRow } from "./PrRow";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { ...PR_FIXTURES[0], ...over };
}

describe("PrRow", () => {
  // The app fetched `review` for every PR and rendered it nowhere: ten
  // green PRs looked identical whether one was approved or none were.
  it("shows an approved chip", () => {
    render(<PrRow pr={pr({ review: "approved" })} />);
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("shows a changes-requested chip", () => {
    render(<PrRow pr={pr({ review: "changes_requested" })} />);
    expect(screen.getByText("Changes requested")).toBeTruthy();
  });

  // Deliberately blank: GitHub shows no neutral glyph either, and marking
  // every row teaches the reader to ignore the marker.
  it("shows no chip while a review is merely required", () => {
    render(<PrRow pr={pr({ review: "review_required" })} />);
    expect(screen.queryByText("Approved")).toBeNull();
    expect(screen.queryByText("Changes requested")).toBeNull();
  });

  // "tests running" used to be byte-identical to "no CI configured".
  it("distinguishes running CI from no CI", () => {
    const { unmount } = render(<PrRow pr={pr({ ci: "pending" })} />);
    expect(screen.getByLabelText("CI running")).toBeTruthy();
    unmount();
    render(<PrRow pr={pr({ ci: "none" })} />);
    expect(screen.queryByLabelText("CI running")).toBeNull();
  });

  it("still shows pass and fail glyphs", () => {
    const { unmount } = render(<PrRow pr={pr({ ci: "success" })} />);
    expect(screen.getByLabelText("CI passing")).toBeTruthy();
    unmount();
    render(<PrRow pr={pr({ ci: "failure" })} />);
    expect(screen.getByLabelText("CI failing")).toBeTruthy();
  });

  // The list sorts by updated_at, so a row showing only created_at could
  // not explain its own position.
  it("shows when the PR was last updated, not just when it was opened", () => {
    render(
      <PrRow
        pr={pr({
          created_at: "2026-06-01T10:00:00Z",
          updated_at: "2026-08-20T10:00:00Z",
        })}
      />,
    );
    expect(screen.getByText(/opened/)).toBeTruthy();
    expect(screen.getByText(/updated/)).toBeTruthy();
  });

  it("shows a comment count only when there are comments", () => {
    const { unmount } = render(<PrRow pr={pr({ comment_count: 4 })} />);
    expect(screen.getByText("4")).toBeTruthy();
    unmount();
    render(<PrRow pr={pr({ comment_count: 0 })} />);
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("PrRow branch pair", () => {
  it("shows source and target for every PR", () => {
    render(<PrRow pr={pr({ head_ref: "ci_fix_2", base_ref: "main" })} />);
    expect(screen.getByText("ci_fix_2")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("→")).toBeTruthy();
  });

  // A stacked PR cannot merge until its base does, and nothing else in
  // the row says so.
  it("tints the target when it is not the default branch", () => {
    const { container } = render(
      <PrRow pr={pr({ head_ref: "ci_fix_2", base_ref: "ci_fix_1" })} />,
    );
    const target = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "ci_fix_1",
    );
    expect(target?.className).toContain("#a371f7");
  });

  it("does not tint a PR targeting main or master", () => {
    for (const base of ["main", "master"]) {
      const { container, unmount } = render(
        <PrRow pr={pr({ head_ref: "feature/x", base_ref: base })} />,
      );
      const target = Array.from(container.querySelectorAll("span")).find(
        (s) => s.textContent === base,
      );
      expect(target?.className).not.toContain("#a371f7");
      unmount();
    }
  });

  // The mapper defaults these to "" when GitHub omits them; a row must
  // not render a bare arrow.
  it("renders nothing when the refs are missing", () => {
    render(<PrRow pr={pr({ head_ref: "", base_ref: "" })} />);
    expect(screen.queryByText("→")).toBeNull();
  });
});

describe("PrRow no-CI state", () => {
  // Normal for a stacked PR: most repos only run CI against the default
  // branch. Previously identical to "checks have not reported yet".
  it("distinguishes 'no CI ran' from every other CI state", () => {
    render(<PrRow pr={pr({ ci: "none" })} />);
    expect(screen.getByLabelText("No CI ran")).toBeTruthy();
  });

  it("does not show the no-CI glyph when CI actually ran", () => {
    for (const ci of ["success", "failure", "pending"] as const) {
      const { unmount } = render(<PrRow pr={pr({ ci })} />);
      expect(screen.queryByLabelText("No CI ran")).toBeNull();
      unmount();
    }
  });
});

describe("PrRow unresolved conversations", () => {
  it("shows the count when conversations are open", () => {
    render(<PrRow pr={pr({ unresolved_threads: 3 })} />);
    expect(screen.getByText(/3 unresolved/)).toBeTruthy();
  });

  it("says conversation, singular, for one", () => {
    render(<PrRow pr={pr({ unresolved_threads: 1 })} />);
    expect(screen.getByTitle(/1 review conversation not yet resolved/)).toBeTruthy();
  });

  it("stays silent when everything is resolved", () => {
    render(<PrRow pr={pr({ unresolved_threads: 0 })} />);
    expect(screen.queryByText(/unresolved/)).toBeNull();
  });

  // Amber, not red: an unanswered question is not a failure, and the app
  // cannot know whether the repo actually requires resolution to merge.
  it("does not present unresolved conversations as an error", () => {
    const { container } = render(<PrRow pr={pr({ unresolved_threads: 2 })} />);
    const chip = Array.from(container.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("unresolved"),
    );
    expect(chip?.className).toContain("#d29922");
    expect(chip?.className).not.toContain("#f85149");
  });
});

describe("PrRow state icon", () => {
  // It was unconditionally green, so the icon said nothing at all.
  it("is green for a healthy open PR", () => {
    const { container } = render(
      <PrRow pr={pr({ ci: "success", merge: "mergeable", is_draft: false, in_merge_queue: false })} />,
    );
    expect(screen.getByLabelText("Open")).toBeTruthy();
    expect(container.innerHTML).toContain("#3fb950");
  });

  it("is orange in the merge queue", () => {
    render(<PrRow pr={pr({ ci: "success", merge: "mergeable", in_merge_queue: true })} />);
    expect(screen.getByLabelText("In merge queue")).toBeTruthy();
  });

  it("is grey for a draft", () => {
    render(<PrRow pr={pr({ ci: "success", merge: "mergeable", is_draft: true })} />);
    expect(screen.getByLabelText("Draft")).toBeTruthy();
  });

  it("is red when blocked", () => {
    render(<PrRow pr={pr({ ci: "failure", merge: "mergeable" })} />);
    expect(screen.getByLabelText("Blocked")).toBeTruthy();
  });

  // The precedence decision: a draft that ALSO has conflicts is blocked,
  // not a benign draft. Getting this backwards hides real problems.
  it("prefers blocked over draft and queued", () => {
    render(<PrRow pr={pr({ ci: "failure", is_draft: true, in_merge_queue: true })} />);
    expect(screen.getByLabelText("Blocked")).toBeTruthy();
    expect(screen.queryByLabelText("Draft")).toBeNull();
  });

  it("prefers queued over draft", () => {
    render(
      <PrRow pr={pr({ ci: "success", merge: "mergeable", is_draft: true, in_merge_queue: true })} />,
    );
    expect(screen.getByLabelText("In merge queue")).toBeTruthy();
  });

  // Colour must never be the only signal.
  it("labels the state for anyone who cannot see the colour", () => {
    for (const [p, label] of [
      [{ ci: "success", merge: "mergeable" }, "Open"],
      [{ merge: "conflicted" }, "Blocked"],
      [{ ci: "success", merge: "mergeable", is_draft: true }, "Draft"],
    ] as const) {
      const { unmount } = render(<PrRow pr={pr(p)} />);
      expect(screen.getByLabelText(label)).toBeTruthy();
      unmount();
    }
  });
});

describe("PrRow merge-state nuance", () => {
  // These two states are invisible to the conflicts-or-red-CI rule, which
  // is exactly why mergeStateStatus is worth fetching.
  it("distinguishes 'blocked on review' from broken and from ready", () => {
    render(
      <PrRow pr={pr({ ci: "success", merge: "mergeable", merge_status: "blocked" })} />,
    );
    expect(screen.getByLabelText("Blocked on review")).toBeTruthy();
  });

  it("shows when a branch is behind its base", () => {
    render(
      <PrRow pr={pr({ ci: "success", merge: "mergeable", merge_status: "behind" })} />,
    );
    expect(screen.getByLabelText("Behind base branch")).toBeTruthy();
  });

  // Real breakage still outranks GitHub's softer verdicts.
  it("still prefers blocked-by-CI over blocked-on-review", () => {
    render(<PrRow pr={pr({ ci: "failure", merge_status: "blocked" })} />);
    expect(screen.getByLabelText("Blocked")).toBeTruthy();
  });

  it("treats clean as plain open", () => {
    render(
      <PrRow pr={pr({ ci: "success", merge: "mergeable", merge_status: "clean" })} />,
    );
    expect(screen.getByLabelText("Open")).toBeTruthy();
  });
});

describe("PrRow click-through", () => {
  it("opens the detail view when the row is clicked", () => {
    const onOpen = vi.fn();
    const { container } = render(<PrRow pr={pr()} onOpen={onOpen} />);
    fireEvent.click(container.querySelector('[role="button"]') as Element);
    expect(onOpen).toHaveBeenCalled();
  });

  // This DELIBERATELY reverses an earlier assertion. The old test read
  // "lets the title link through to GitHub without opening the detail",
  // encoding the view that the title belongs to github.com.
  //
  // Reported as "clicking a PR on To review does not show it": the
  // title was an `<a target="_blank">` that stopped propagation, so the
  // most obvious click target in the row launched a browser tab and
  // never reached `onOpen`. It behaved that way on EVERY view -- To
  // review just makes it visible, because `canWrite` is false there and
  // the title is the only thing that looks interactive.
  //
  // "View on GitHub" already exists in the kebab menu and in the detail
  // view, so the route to the browser is not lost.
  it("opens the detail view when the title is clicked", () => {
    const onOpen = vi.fn();
    render(<PrRow pr={pr()} onOpen={onOpen} />);
    fireEvent.click(screen.getByText(pr().title));
    expect(onOpen).toHaveBeenCalled();
  });

  it("is keyboard reachable", () => {
    const onOpen = vi.fn();
    const { container } = render(<PrRow pr={pr()} onOpen={onOpen} />);
    const row = container.querySelector('[role="button"]') as Element;
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalled();
  });

  // Rows are not clickable everywhere, and a bare div must not claim a
  // button role it cannot fulfil.
  it("is not interactive without a handler", () => {
    const { container } = render(<PrRow pr={pr()} />);
    expect(container.querySelector('[role="button"]')).toBeNull();
  });
});
