import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree, WorktreeRepo } from "@/types/pr";
import { useFilters } from "@/store/filters";

const state = vi.hoisted(() => ({
  repos: undefined as WorktreeRepo[] | undefined,
  isLoading: false,
  isError: false,
  classified: undefined as Worktree[] | undefined,
  classifying: false,
  sizes: undefined as Map<string, number> | undefined,
  sizing: false,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("../api/hooks", () => ({
  useWorktrees: () => ({
    data: state.repos,
    isLoading: state.isLoading,
    isError: state.isError,
    error: "boom",
    refetch: vi.fn(),
  }),
  useWorktreeSafety: () => ({ data: state.classified, isLoading: state.classifying }),
  useRemoveWorktree: () => removeFn,
  useWorktreeSizes: () => ({ data: state.sizes, isLoading: state.sizing }),
}));

const removeFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const claudify = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({ command: "cd '/code/proj-a' && claude 'assess'", claude_installed: true }),
  ),
);
vi.mock("../api/tauri", () => ({ claudifyCommand: claudify }));

import { WorktreesPage } from "./WorktreesPage";

const wt = (over: Partial<Worktree>): Worktree => ({
  path: "/code/proj-a",
  branch: "feature",
  head: "abc",
  size_bytes: 1024,
  safety: { kind: "unmerged" },
  is_main: false,
  merged_at: null,
  upstream: null,
  ...over,
});

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {} } as const;

describe("WorktreesPage", () => {
  beforeEach(() => {
    Object.assign(state, {
      repos: [{ name: "proj", path: "/code/proj", worktrees: [wt({})] }],
      isLoading: false,
      isError: false,
      classified: undefined,
      classifying: false,
      sizes: undefined,
      sizing: false,
    });
    useFilters.setState({ filtersByView: { ...EMPTY }, view: "worktrees", panel: "list" });
    // Calls leak between tests otherwise, which makes "was not called"
    // assertions pass or fail depending on ordering.
    removeFn.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it("says what it is doing while scanning", () => {
    state.isLoading = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/scanning for worktrees/i)).toBeTruthy();
  });

  it("surfaces a scan failure rather than showing an empty list", () => {
    state.isError = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/could not scan/i)).toBeTruthy();
  });

  // An unconfigured base directory must point at the fix, not read as
  // "you have no worktrees".
  it("points at settings when no repos are found", () => {
    state.repos = [];
    render(<WorktreesPage />);
    expect(screen.getByText(/no repositories found/i)).toBeTruthy();
    expect(screen.getByText(/settings/i)).toBeTruthy();
  });

  it("lists worktrees with their branch and size", () => {
    render(<WorktreesPage />);
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
  });

  // Safety is the primary axis: every row must say whether it can be
  // removed and, if not, why.
  it("states why a worktree cannot be removed", () => {
    state.classified = [wt({ safety: { kind: "never_pushed" } })];
    render(<WorktreesPage />);
    expect(screen.getByText(/only here/i)).toBeTruthy();
  });

  it("sorts by size, biggest first", () => {
    state.classified = [
      wt({ path: "/code/small", size_bytes: 1024 }),
      wt({ path: "/code/huge", size_bytes: 5 * 1024 ** 3 }),
    ];
    const { container } = render(<WorktreesPage />);
    const rows = Array.from(container.querySelectorAll(".font-mono")).map(
      (e) => e.textContent ?? "",
    );
    expect(rows[0]).toContain("huge");
  });

  it("says it is still checking before classification lands", () => {
    state.classifying = true;
    render(<WorktreesPage />);
    expect(screen.getByText(/checking what is safe/i)).toBeTruthy();
  });

  // Genuinely disabled, not a warning to click past: 52 of 296 worktrees
  // here hold commits that exist nowhere else.
  // The invariant is unchanged -- nothing unsafe may be removed -- but
  // the row now offers Claudify in that slot rather than a dead Remove,
  // so "no removal is offered" is the assertion rather than "Remove is
  // disabled".
  it("offers no removal at all for anything not provably safe", () => {
    state.classified = [wt({ safety: { kind: "never_pushed" } })];
    render(<WorktreesPage />);
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("enables removal only when safe", () => {
    state.classified = [wt({ safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    expect(screen.getByRole("button", { name: /remove/i })).toHaveProperty("disabled", false);
  });

  // A modal, not an inline banner: with 149 worktrees on one repo the
  // clicked row is far down the page, and a prompt at the top is
  // off-screen -- indistinguishable from nothing happening.
  it("confirms in a dialog naming the path", () => {
    state.classified = [wt({ path: "/code/proj-gone", safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("/code/proj-gone")).toBeTruthy();
    expect(removeFn).not.toHaveBeenCalled();
  });

  it("removes only after confirmation", () => {
    state.classified = [wt({ path: "/code/proj-gone", safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    expect(removeFn).toHaveBeenCalledWith("/code/proj", "/code/proj-gone");
  });

  it("cancelling removes nothing", () => {
    state.classified = [wt({ safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(removeFn).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A refusal means the work is still there, which the user must see
  // rather than have hidden behind an optimistic update.
  it("toasts the backend's refusal, message and all", async () => {
    removeFn.mockImplementationOnce(() =>
      Promise.reject("not safe to remove: 3 uncommitted files"),
    );
    state.classified = [wt({ path: "/code/proj-gone", safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^remove$/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not remove proj-gone",
        expect.objectContaining({ description: "not safe to remove: 3 uncommitted files" }),
      ),
    );
  });

  // Removal is otherwise silent: the row vanishes on refetch with no
  // confirmation of what happened, which matters when clearing several.
  it("toasts success, naming the worktree", async () => {
    state.classified = [wt({ path: "/code/proj-gone", safety: { kind: "safe" } })];
    render(<WorktreesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Removed proj-gone"));
  });

  // A merged worktree should say WHEN, so "four months ago" reads
  // differently from "yesterday".
  it("shows the merge date when there is one", () => {
    state.classified = [wt({ safety: { kind: "safe" }, merged_at: "2026-08-18" })];
    render(<WorktreesPage />);
    expect(screen.getByText(/merged 2026-08-18/)).toBeTruthy();
  });

  // The bug: an unclassified row rendered "could not determine: not yet
  // classified" -- a FAILED check, in the same grey as a real failure.
  // Classification takes up to ~57s on a large tree, so that was most of
  // the first minute.
  it("shows a skeleton, not a failure, while a row is still being checked", () => {
    Object.assign(state, {
      repos: [
        { name: "proj", path: "/code/proj", worktrees: [wt({ safety: { kind: "pending" } })] },
      ],
      classifying: true,
    });
    render(<WorktreesPage />);
    expect(screen.queryByText(/could not determine/)).toBeNull();
    const row = screen.getByText("proj-a").closest("div") as HTMLElement;
    expect(row.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  // A row must stop being a skeleton the moment ITS answer lands, rather
  // than waiting for the whole pass to finish.
  it("resolves each row independently as its classification arrives", () => {
    Object.assign(state, {
      repos: [
        {
          name: "proj",
          path: "/code/proj",
          worktrees: [wt({ path: "/code/proj-a" }), wt({ path: "/code/proj-b" })],
        },
      ],
      classified: [
        wt({ path: "/code/proj-a", safety: { kind: "safe" } }),
        wt({ path: "/code/proj-b", safety: { kind: "pending" } }),
      ],
      classifying: true,
    });
    render(<WorktreesPage />);
    expect(screen.getByText(/safe to delete/)).not.toBeNull();
    const pendingRow = screen.getByText("proj-b").closest("div") as HTMLElement;
    expect(pendingRow.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  // The em dash read as "measured, and the answer is nothing".
  it("shows a skeleton rather than an em dash while a size is still coming", () => {
    Object.assign(state, {
      repos: [
        {
          name: "proj",
          path: "/code/proj",
          worktrees: [wt({ size_bytes: null, safety: { kind: "safe" } })],
        },
      ],
      sizing: true,
    });
    render(<WorktreesPage />);
    expect(screen.queryByText("—")).toBeNull();
  });

  // Safety and size are separate passes; a row whose safety resolved must
  // not be held hostage by a size that has not.
  it("shows a resolved safety even while that row's size is still pending", () => {
    Object.assign(state, {
      repos: [
        {
          name: "proj",
          path: "/code/proj",
          worktrees: [wt({ size_bytes: null, safety: { kind: "safe" } })],
        },
      ],
      sizing: true,
    });
    render(<WorktreesPage />);
    expect(screen.getByText(/safe to delete/)).not.toBeNull();
  });

  // A row you are about to click must not move as its number lands.
  it("holds a stable order while sizes are still arriving", () => {
    Object.assign(state, {
      repos: [
        {
          name: "proj",
          path: "/code/proj",
          worktrees: [
            wt({ path: "/code/aaa", size_bytes: null }),
            wt({ path: "/code/zzz", size_bytes: 9_999_999 }),
          ],
        },
      ],
      sizing: true,
    });
    const { container } = render(<WorktreesPage />);
    const names = [...container.querySelectorAll(".font-mono")].map((n) => n.textContent);
    // Path order while sizing, NOT size order -- zzz is far bigger but
    // must not jump to the top until every size is in.
    expect(names[0]).toMatch(/^aaa/);
  });

  it("sorts by size once every size has arrived", () => {
    Object.assign(state, {
      repos: [
        {
          name: "proj",
          path: "/code/proj",
          worktrees: [
            wt({ path: "/code/aaa", size_bytes: 10 }),
            wt({ path: "/code/zzz", size_bytes: 9_999_999 }),
          ],
        },
      ],
      sizing: false,
    });
    const { container } = render(<WorktreesPage />);
    const names = [...container.querySelectorAll(".font-mono")].map((n) => n.textContent);
    expect(names[0]).toMatch(/^zzz/);
  });

  // Deleting on an unresolved verdict is the one unrecoverable mistake
  // this page can make.
  it("refuses to offer removal while a row is still being checked", () => {
    Object.assign(state, {
      repos: [
        { name: "proj", path: "/code/proj", worktrees: [wt({ safety: { kind: "pending" } })] },
      ],
      classifying: true,
    });
    render(<WorktreesPage />);
    const btn = screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // 124 of 268 worktrees on a real machine cannot be removed. The row
  // used to show a dead Remove there; it now answers the question that
  // actually applies -- is there anything in here worth keeping?
  describe("Claudify", () => {
    it.each([["never_pushed"], ["unmerged"], ["dirty"], ["unpushed"]])(
      "offers it for %s",
      (kind) => {
        state.classified = [wt({ safety: { kind } as Worktree["safety"] })];
        const r = render(<WorktreesPage />);
        expect(screen.getByRole("button", { name: /claudify/i })).toBeTruthy();
        r.unmount();
      },
    );

    it("does not offer it where Remove already applies", () => {
      state.classified = [wt({ safety: { kind: "safe" } })];
      render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /claudify/i })).toBeNull();
      expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
    });

    // Offering an action based on a verdict that has not arrived is the
    // bug #190 was.
    it("does not offer it while the row is still being classified", () => {
      state.classified = [wt({ safety: { kind: "pending" } })];
      state.classifying = true;
      const r = render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /claudify/i })).toBeNull();
      r.unmount();
      state.classifying = false;
    });

    it("copies the command and says where to paste it", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(writeText.mock.calls[0][0]).toContain("claude");
      expect(toastSuccess).toHaveBeenCalled();
      const [, opts] = toastSuccess.mock.calls[0] as [string, { description: string }];
      expect(opts.description).toMatch(/paste it in your terminal/i);
    });

    // Better to learn it here than as `command not found` after pasting.
    it("says so when Claude Code was not found, but still copies", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });
      claudify.mockResolvedValueOnce({ command: "cd x && claude y", claude_installed: false });
      state.classified = [wt({ safety: { kind: "unmerged" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      const [, opts] = toastSuccess.mock.calls[0] as [string, { description: string }];
      expect(opts.description).toMatch(/not found/i);
    });
  });
});
