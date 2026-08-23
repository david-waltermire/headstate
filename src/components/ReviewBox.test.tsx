import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewBox } from "./ReviewBox";

afterEach(cleanup);

const base = {
  onSubmit: vi.fn(),
  busy: null,
  viewer: "octocat",
  author: "someone-else",
};

describe("ReviewBox", () => {
  it("offers all three verdicts on someone else's pull request", () => {
    render(<ReviewBox {...base} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /request changes/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^comment$/i })).toBeTruthy();
  });

  // GitHub refuses self-approval outright. Offering the button and
  // surfacing a GraphQL refusal after the click is strictly worse than
  // saying so up front.
  it("does not offer to approve your own pull request", () => {
    render(<ReviewBox {...base} onSubmit={vi.fn()} viewer="octocat" author="octocat" />);
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    // Commenting on your own PR is fine, so that stays.
    expect(screen.getByRole("button", { name: /^comment$/i })).toBeTruthy();
  });

  // "We could not ask" is not "it is yours". If the viewer is unknown the
  // safe reading is that it might not be, so the button stays.
  it("still offers approve when the viewer is unknown", () => {
    render(<ReviewBox {...base} onSubmit={vi.fn()} viewer={undefined} author="octocat" />);
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });

  it("approves with no body, which GitHub allows", () => {
    const onSubmit = vi.fn();
    render(<ReviewBox {...base} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onSubmit).toHaveBeenCalledWith("approve", "");
  });

  // GitHub refuses these two without a body. Blocking here means the
  // user learns it before a round-trip, not after.
  it("blocks request-changes until there is a comment", () => {
    const onSubmit = vi.fn();
    render(<ReviewBox {...base} onSubmit={onSubmit} />);
    const btn = screen.getByRole("button", { name: /request changes/i });
    expect(btn).toHaveProperty("disabled", true);
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("enables request-changes once a comment is typed", () => {
    const onSubmit = vi.fn();
    render(<ReviewBox {...base} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "needs work" } });
    fireEvent.click(screen.getByRole("button", { name: /request changes/i }));
    expect(onSubmit).toHaveBeenCalledWith("request_changes", "needs work");
  });

  // Whitespace is not a comment.
  it("treats a whitespace-only comment as empty", () => {
    const onSubmit = vi.fn();
    render(<ReviewBox {...base} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   \n  " } });
    expect(screen.getByRole("button", { name: /request changes/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables every verdict while one is in flight", () => {
    render(<ReviewBox {...base} onSubmit={vi.fn()} busy="approve" />);
    expect(screen.getByRole("button", { name: /request changes/i })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
