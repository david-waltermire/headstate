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
  assessed: [] as string[],
  prs: [] as import("@/types/pr").PullRequest[],
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
  useRemoveWorktrees: () => removeManyFn,
  useRemoveWorktreeForced: () => forceFn,
  useAssessed: () => ({ data: state.assessed }),
  usePullRequests: () => ({ data: state.prs }),
  useWorktreeSizes: () => ({ data: state.sizes, isLoading: state.sizing }),
}));

const removeFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const forceFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
type Outcome = { path: string; error: string | null };
const removeManyFn = vi.hoisted(() =>
  vi.fn<(repo: string, paths: string[]) => Promise<Outcome[]>>((_r, paths) =>
    Promise.resolve(paths.map((p) => ({ path: p, error: null }))),
  ),
);

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
  last_commit: null,
  ...over,
});

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {} } as const;

describe("WorktreesPage", () => {
  beforeEach(() => {
    Object.assign(state, {
      repos: [{ identity: null, name: "proj", path: "/code/proj", worktrees: [wt({})] }],
      isLoading: false,
      isError: false,
      classified: undefined,
      classifying: false,
      sizes: undefined,
      sizing: false,
      assessed: [],
      prs: [],
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
        { identity: null, name: "proj", path: "/code/proj", worktrees: [wt({ safety: { kind: "pending" } })] },
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
          identity: null,
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
          identity: null,
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
          identity: null,
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
          identity: null,
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
          identity: null,
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
        { identity: null, name: "proj", path: "/code/proj", worktrees: [wt({ safety: { kind: "pending" } })] },
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

  // Removal takes a moment, and a button that still looks live invites a
  // second click on a directory that is already being deleted.
  describe("removal feedback", () => {
    it("shows the button as busy and stops accepting clicks", async () => {
      let release: () => void = () => {};
      removeFn.mockImplementationOnce(
        () => new Promise<void>((r) => { release = r; }),
      );
      state.classified = [wt({ safety: { kind: "safe" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /^remove$/i }),
      );

      const busy = await screen.findByRole("button", { name: /removing/i });
      expect((busy as HTMLButtonElement).disabled).toBe(true);

      // A second click while in flight must not submit again.
      fireEvent.click(busy);
      expect(removeFn).toHaveBeenCalledTimes(1);

      release();
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    });

    // The backend re-checks safety at delete time and can refuse. The
    // button must come back, not stay stuck on "Removing...".
    it("returns the button to normal when the removal is refused", async () => {
      removeFn.mockRejectedValueOnce("not safe to remove: 2 uncommitted files");
      state.classified = [wt({ safety: { kind: "safe" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /^remove$/i }),
      );

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      const back = await screen.findByRole("button", { name: /^remove$/i });
      expect((back as HTMLButtonElement).disabled).toBe(false);
    });

    // With 100+ rows, freezing all of them because one is in flight
    // would be worse than the current behaviour.
    it("leaves other rows clickable while one is being removed", async () => {
      let release: () => void = () => {};
      removeFn.mockImplementationOnce(
        () => new Promise<void>((r) => { release = r; }),
      );
      state.classified = [
        wt({ path: "/code/proj-a", safety: { kind: "safe" } }),
        wt({ path: "/code/proj-b", safety: { kind: "safe" } }),
      ];
      render(<WorktreesPage />);

      fireEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[0]);
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /^remove$/i }),
      );
      await screen.findByRole("button", { name: /removing/i });

      const others = screen.getAllByRole("button", { name: /^remove$/i });
      expect(others).toHaveLength(1);
      expect((others[0] as HTMLButtonElement).disabled).toBe(false);

      release();
    });
  });

  // How much work is in a branch and how stale it is are the two facts
  // that decide what to do with a worktree you do not recognise.
  describe("row facts", () => {
    it("shows ahead and behind compactly", () => {
      state.classified = [
        wt({ path: "/code/a", upstream: { kind: "ahead", n: 3 } }),
        wt({ path: "/code/b", upstream: { kind: "behind", n: 7 } }),
        wt({ path: "/code/c", upstream: { kind: "diverged", n: [2, 5] } }),
      ];
      render(<WorktreesPage />);
      const text = document.body.textContent ?? "";
      expect(text).toContain("↑3");
      expect(text).toContain("↓7");
      expect(text).toContain("↑2 ↓5");
    });

    // The difference between "this is redundant" and "this is the only
    // copy" is worth a word, where "up to date" is just noise.
    it("names a local-only branch but stays quiet when up to date", () => {
      state.classified = [wt({ upstream: { kind: "untracked" } })];
      const r = render(<WorktreesPage />);
      expect(document.body.textContent).toContain("local only");
      r.unmount();

      state.classified = [wt({ upstream: { kind: "current" } })];
      render(<WorktreesPage />);
      expect(document.body.textContent).not.toContain("up to date");
    });

    it("shows how stale the work is, relatively", () => {
      // relativeTime has no weeks tier -- days up to 30, then months.
      const twoWeeks = new Date(Date.now() - 14 * 864e5).toISOString();
      state.classified = [wt({ last_commit: twoWeeks })];
      render(<WorktreesPage />);
      expect(document.body.textContent).toContain("14 days ago");
    });

    // merged_at says whether the work is accounted for; last_commit says
    // how old it is. A branch written in March and merged in August has
    // both, and showing one for the other misleads.
    it("does not confuse the last commit date with the merge date", () => {
      state.classified = [
        wt({
          safety: { kind: "safe" },
          merged_at: "2026-08-01",
          last_commit: new Date(Date.now() - 90 * 864e5).toISOString(),
        }),
      ];
      render(<WorktreesPage />);
      const body = document.body.textContent ?? "";
      expect(body).toContain("merged 2026-08-01");
      expect(body).toContain("3 months ago");
    });
  });

  // 106 of 268 worktrees are safe on a real machine, mostly concentrated
  // in a few repos. Clicking each adds no safety, only clicks.
  describe("bulk removal", () => {
    const threeSafe = () => [
      wt({ path: "/code/a", safety: { kind: "safe" }, size_bytes: 1024 }),
      wt({ path: "/code/b", safety: { kind: "safe" }, size_bytes: 2048 }),
      wt({ path: "/code/c", safety: { kind: "never_pushed" } }),
    ];

    it("counts only the safe rows, in the label", () => {
      state.classified = threeSafe();
      render(<WorktreesPage />);
      expect(screen.getByRole("button", { name: /remove 2 safe worktrees/i })).toBeTruthy();
    });

    it("lists every path in the confirmation, not just a count", () => {
      state.classified = threeSafe();
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove 2 safe worktrees/i }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("/code/a")).toBeTruthy();
      expect(within(dialog).getByText("/code/b")).toBeTruthy();
      // The unsafe one must not be in the list at all.
      expect(within(dialog).queryByText("/code/c")).toBeNull();
      expect(removeManyFn).not.toHaveBeenCalled();
    });

    // Never unmerged, never_pushed, dirty, or unpushed -- regardless of
    // what any assessment said. Bulk is for the provably-safe set only.
    it("never submits a worktree that is not safe", async () => {
      state.classified = threeSafe();
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove 2 safe worktrees/i }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /remove 2 worktrees/i }),
      );
      await waitFor(() => expect(removeManyFn).toHaveBeenCalled());
      // Sorted by size for display, so compare the set rather than the
      // order -- what matters is which worktrees were submitted.
      expect([...removeManyFn.mock.calls[0][1]].sort()).toEqual(["/code/a", "/code/b"]);
    });

    // Partial failure is the normal case: safety is re-checked at delete
    // time, so a worktree that went dirty since the scan is refused.
    it("reports partial failure rather than a bare success", async () => {
      removeManyFn.mockResolvedValueOnce([
        { path: "/code/a", error: null },
        { path: "/code/b", error: "not safe to remove: 2 uncommitted files" },
      ]);
      state.classified = threeSafe();
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove 2 safe worktrees/i }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /remove 2 worktrees/i }),
      );

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastSuccess).not.toHaveBeenCalled();
      const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
      expect(title).toMatch(/1 of 2/);
      expect(opts.description).toContain("uncommitted");
    });

    it("does not offer the button while rows are still being classified", () => {
      state.classified = threeSafe();
      state.classifying = true;
      const r = render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /remove 2 safe/i })).toBeNull();
      r.unmount();
      state.classifying = false;
    });

    // One safe row is a single click already; a bulk affordance for it
    // is noise.
    it("does not offer the button for a single safe worktree", () => {
      state.classified = [wt({ safety: { kind: "safe" } })];
      render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /safe worktree/i })).toBeNull();
    });
  });

  // Coming back from a "safe to discard" verdict, the app's answer and
  // the user's disagreed and the app won -- with no way to act and no
  // way to find the row again among 124 candidates.
  describe("after an assessment", () => {
    it("offers no override on a worktree that was never assessed", () => {
      state.classified = [wt({ path: "/code/a", safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /remove anyway/i })).toBeNull();
      expect(screen.getByRole("button", { name: /claudify/i })).toBeTruthy();
    });

    it("offers the override once that worktree has been assessed", () => {
      state.classified = [wt({ path: "/code/a", safety: { kind: "never_pushed" } })];
      state.assessed = ["/code/a"];
      render(<WorktreesPage />);
      expect(screen.getByRole("button", { name: /remove anyway/i })).toBeTruthy();
    });

    // Finding the row you just assessed is the part that made the
    // feature feel unfinished.
    it("sorts assessed rows to the top", () => {
      state.classified = [
        wt({ path: "/code/big", safety: { kind: "never_pushed" }, size_bytes: 9_000_000 }),
        wt({ path: "/code/assessed", safety: { kind: "never_pushed" }, size_bytes: 1 }),
      ];
      state.assessed = ["/code/assessed"];
      const { container } = render(<WorktreesPage />);
      // The cell carries the directory name and the branch, so match the
      // prefix rather than the whole string.
      const names = [...container.querySelectorAll(".font-mono")].map((n) => n.textContent);
      expect(names[0]).toMatch(/^assessed/);
    });

    // "Are you sure?" is not something anyone can act on. This is the
    // only genuinely unrecoverable action in the app.
    it("names the specific loss before removing", () => {
      state.classified = [wt({ path: "/code/a", safety: { kind: "never_pushed" } })];
      state.assessed = ["/code/a"];
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove anyway/i }));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("/code/a")).toBeTruthy();
      expect(within(dialog).getByText(/not pushed anywhere/i)).toBeTruthy();
      expect(forceFn).not.toHaveBeenCalled();
    });

    it("removes only after the explicit confirmation", async () => {
      state.classified = [wt({ path: "/code/a", safety: { kind: "never_pushed" } })];
      state.assessed = ["/code/a"];
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove anyway/i }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /i have reviewed this/i }),
      );
      await waitFor(() => expect(forceFn).toHaveBeenCalledWith("/code/proj", "/code/a"));
    });

    // The bulk path is for the provably-safe set only, regardless of
    // what any assessment said.
    it("never includes an assessed-but-unsafe worktree in a bulk removal", () => {
      state.classified = [
        wt({ path: "/code/a", safety: { kind: "never_pushed" } }),
        wt({ path: "/code/b", safety: { kind: "safe" } }),
        wt({ path: "/code/c", safety: { kind: "safe" } }),
      ];
      state.assessed = ["/code/a"];
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /remove 2 safe worktrees/i }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByText("/code/a")).toBeNull();
    });
  });
});
