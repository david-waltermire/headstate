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
