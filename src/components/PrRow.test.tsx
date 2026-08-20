import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
