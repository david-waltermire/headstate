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
  allSizes: undefined as Map<string, number> | undefined,
  sizesPending: 0,
  sizesTotal: 0,
  sizing: false,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const dockerImages = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const removeOrphanFn = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<void>>(() => Promise.resolve()),
);
const pullFn = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<string>>(() => Promise.resolve("Already up to date.")),
);
// Typed so the call arguments can be asserted on: the untyped form
// infers an empty tuple, and indexing it is a compile error.
const removeImagesFn = vi.hoisted(() =>
  vi.fn<(ids: string[]) => Promise<{ id: string; error: string | null }[]>>(() =>
    Promise.resolve([]),
  ),
);

vi.mock("../api/hooks", () => ({
  // Idle: the progress line only appears mid-removal.
  useRemovalProgress: () => null,
  // Not opened in these tests: the disclosure is closed by default.
  useAssessment: () => ({ data: undefined, isLoading: false }),
  // The cleanup manifest joins worktrees to the images they own, so the
  // page now reads Docker state -- but only while the confirmation is
  // open, which is why the default here is an empty list.
  usePullCheckout: () => pullFn,
  useRemoveOrphan: () => removeOrphanFn,
  // Sizes land one repository at a time on the all-repos view, so the
  // mock carries the progress fields the page renders.
  useAllWorktreeSizes: () => ({
    sizes: state.allSizes ?? new Map<string, number>(),
    pending: state.sizesPending ?? 0,
    total: state.sizesTotal ?? 0,
  }),
  useDockerImages: () => ({ data: dockerImages() }),
  useRemoveImages: () => removeImagesFn,
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
  useMarkAssessed: () => markAssessedFn,
  usePullRequests: () => ({ data: state.prs }),
  // Mirrors the real hook: a DISABLED query reports `isLoading: true`
  // forever, so the page reads `isFetching` instead -- and a mock that
  // only carried `isLoading` would hide exactly the bug that caused.
  useWorktreeSizes: () => ({
    data: state.sizes,
    isLoading: state.sizing,
    isFetching: state.sizing,
  }),
}));

const removeFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const forceFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
type Outcome = { path: string; error: string | null };
const removeManyFn = vi.hoisted(() =>
  vi.fn<(repo: string, paths: string[]) => Promise<Outcome[]>>((_r, paths) =>
    Promise.resolve(paths.map((p) => ({ path: p, error: null }))),
  ),
);

const markAssessedFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
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

const EMPTY = { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} } as const;

describe("WorktreesPage", () => {
  beforeEach(() => {
    // Reset between tests: a leaked image list makes a later assertion
    // about paths fail on a Docker line it never set up.
    dockerImages.mockReturnValue([]);
    removeImagesFn.mockClear();
    // `removeManyFn` is asserted as "not called" by a later test, and a
    // confirm click in an earlier one leaks into it. Cleared here rather
    // than in that test, so every test starts from the same state.
    removeManyFn.mockClear();
    pullFn.mockClear();
    removeOrphanFn.mockClear();
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
    // These exercise the PER-REPO view, so they select a repo. They used
    // to rely on the `repos?.[0]` fallback -- which silently showed the
    // first repo when no repo was chosen, and is exactly the bug the
    // all-repos rollup replaced.
    useFilters.setState({
      filtersByView: { ...EMPTY, worktrees: { repo: "/code/proj" } },
      view: "worktrees",
      panel: "list",
    });
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
  /// #348/#358: the page read "at least 0 B" with dashes, indefinitely.
  ///
  /// The first fix said "open a repository to measure sizes" -- honest,
  /// but the view exists to answer where the disk went and could not.
  /// It now measures, one repository at a time, and says how many are
  /// outstanding. MEASURED: the full set takes ~2 minutes, so a count
  /// that visibly falls is the difference between "still working" and
  /// "broken".
  it("says how many repositories are still being measured", () => {
    Object.assign(state, {
      repos: [
        { identity: null, name: "a", path: "/code/a", worktrees: [wt({ size_bytes: null })] },
        {
          identity: null,
          name: "b",
          path: "/code/b",
          worktrees: [wt({ path: "/code/b-f", size_bytes: null })],
        },
      ],
      sizesPending: 2,
      sizesTotal: 2,
    });
    useFilters.setState({
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} },
      view: "worktrees",
    } as never);
    render(<WorktreesPage />);
    expect(screen.getByText(/2 of 2 repositories still to go/i)).toBeTruthy();
  });

  /// Silence once everything has answered -- a progress line that never
  /// clears is indistinguishable from one that is stuck.
  it("stops saying it once every repository has answered", () => {
    Object.assign(state, {
      repos: [
        { identity: null, name: "a", path: "/code/a", worktrees: [wt({ size_bytes: 2048 })] },
      ],
      sizesPending: 0,
      sizesTotal: 1,
    });
    useFilters.setState({
      filtersByView: { "my-prs": {}, "to-review": {}, worktrees: {}, docker: {}, artifacts: {}, packages: {}, "claude-md": {} },
      view: "worktrees",
    } as never);
    render(<WorktreesPage />);
    expect(screen.queryByText(/still to go/i)).toBeNull();
  });

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

    /// #393: the toast must SAY the clipboard, not just "copied".
    it("names the clipboard in the confirmation", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      expect(toastSuccess.mock.calls[0][0]).toMatch(/clipboard/i);
    });

    /// #393: copying a prompt must not unlock the force-remove path.
    ///
    /// It used to mark the worktree assessed as a side effect, which
    /// armed "Remove anyway…" on a worktree nobody had read a verdict
    /// for -- and swapped a narrow button for a wide one seconds later,
    /// re-flowing every column in the table.
    it("does not mark the worktree assessed just for copying", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      expect(markAssessedFn).not.toHaveBeenCalled();
    });

    /// ...and the toast offers the deliberate way to record it.
    it("offers an explicit way to say the assessment was read", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      const [, opts] = toastSuccess.mock.calls[0] as [
        string,
        { action?: { label: string; onClick: () => void } },
      ];
      expect(opts.action?.label).toMatch(/read the assessment/i);

      opts.action?.onClick();
      await waitFor(() => expect(markAssessedFn).toHaveBeenCalled());
    });

    /// #396: an ABSENT clipboard produced NO toast at all.
    ///
    /// `navigator.clipboard.writeText(...)` throws synchronously on
    /// property access when the object is missing, so `.then(ok, err)`
    /// attached neither handler and the click looked inert -- which is
    /// exactly what was reported against v4.0.0, after #393 had already
    /// fixed the assessment mark and the toast wording.
    it("says so when the window has no clipboard at all", async () => {
      Object.assign(navigator, { clipboard: undefined });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError.mock.calls[0][0]).toMatch(/could not copy/i);
      const [, opts] = toastError.mock.calls[0] as [string, { description: string }];
      expect(opts.description).toMatch(/no clipboard access/i);
    });

    /// #347: reported as "no indication it copied anything". The
    /// success toast is asserted above, so the visible gap is the
    /// FAILURE path -- `navigator.clipboard` rejects when the document
    /// is not focused, which is a real case in a desktop webview, and
    /// nothing tested that the user hears about it.
    it("says so when the clipboard refuses", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() =>
        Promise.reject(new Error("Document is not focused")),
      );
      Object.assign(navigator, { clipboard: { writeText } });
      state.classified = [wt({ safety: { kind: "never_pushed" } })];
      render(<WorktreesPage />);

      fireEvent.click(screen.getByRole("button", { name: /claudify/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError.mock.calls[0][0]).toMatch(/could not copy/i);
      // And the reason, which is the actionable part -- "could not
      // copy" alone leaves the user with nothing to do.
      const [, opts] = toastError.mock.calls[0] as [string, { description?: string }];
      expect(opts?.description).toMatch(/not focused/i);
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
  /// The main checkout is not a peer of the rows below it: every one of
  /// those is a removal candidate and it never is. Its row also carries
  /// the upstream prose that explains why the others are stale.
  it("pins the main checkout above every other row", () => {
    state.classified = [
      // Ordered so main loses on every OTHER key: it is smallest, and
      // sorts last by path.
      wt({ path: "/code/zzz-b", size_bytes: 9_000_000, safety: { kind: "safe" } }),
      wt({ path: "/code/aaa-a", size_bytes: 5_000_000, safety: { kind: "safe" } }),
      wt({
        path: "/code/zzz-main",
        size_bytes: 1,
        is_main: true,
        safety: { kind: "main_checkout" },
      }),
    ];
    render(<WorktreesPage />);
    // Rows show the basename, not the full path, and the element also
    // carries the branch -- so match the leading name rather than the
    // whole string.
    const rendered = screen.getAllByText(/^(zzz-b|aaa-a|zzz-main)/);
    expect(rendered[0].textContent).toMatch(/^zzz-main/);
  });

  /// #340: the main checkout reported how far behind it was and offered
  /// no way to act on it, so fixing it meant leaving the app.
  describe("updating the main checkout", () => {
    const withMain = (safety: unknown = { kind: "main_checkout" }) => [
      wt({ path: "/code/proj", is_main: true, safety: safety as never }),
      wt({ path: "/code/proj-feature", safety: { kind: "safe" } }),
    ];

    it("offers the update only on the main checkout", () => {
      state.classified = withMain();
      render(<WorktreesPage />);
      expect(screen.getAllByRole("button", { name: /update to latest/i })).toHaveLength(1);
    });

    it("pulls that checkout", async () => {
      state.classified = withMain();
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /update to latest/i }));
      await waitFor(() => expect(pullFn).toHaveBeenCalledWith("/code/proj"));
    });

    /// Disabled rather than hidden, with the reason in the title: an
    /// absent button just looks broken, while a greyed one that says
    /// "3 uncommitted files" teaches. The Rust side refuses too -- this
    /// is the explanation, not the gate.
    it("refuses a dirty checkout and says how dirty", () => {
      state.classified = withMain({ kind: "dirty", detail: 3 });
      render(<WorktreesPage />);
      const btn = screen.getByRole("button", { name: /update to latest/i });
      expect(btn).toHaveProperty("disabled", true);
      expect(btn.getAttribute("title")).toMatch(/3 uncommitted files/);
    });

    /// Git says "Already up to date." when there was nothing to fetch,
    /// which is a real answer -- replacing it with a claim that
    /// something changed would be a small lie.
    it("reports git's own words on success", async () => {
      state.classified = withMain();
      pullFn.mockResolvedValueOnce("Fast-forward to 3 commits");
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /update to latest/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      expect(toastSuccess.mock.calls[0][0]).toContain("Fast-forward");
    });

    it("reports git's own refusal on failure", async () => {
      state.classified = withMain();
      pullFn.mockRejectedValueOnce("divergent branches");
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /update to latest/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError.mock.calls[0][1]).toMatchObject({
        description: "divergent branches",
      });
    });
  });

  /// Reported: the orphan row said "its repository is gone" and the
  /// Remove button could not be clicked -- so the user was told about
  /// 2.5 GB they could not act on.
  describe("orphaned worktrees", () => {
    const orphan = () =>
      wt({ path: "/code/veil-coh", safety: { kind: "orphaned" } as never });

    it("offers Delete rather than a disabled Remove", () => {
      state.classified = [orphan()];
      render(<WorktreesPage />);
      const btn = screen.getByRole("button", { name: /delete/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    /// A DIFFERENT call from the ordinary removal: git cannot remove a
    /// worktree whose repository is gone, so this deletes the
    /// directory after re-checking on the Rust side.
    it("deletes through the orphan path, not the worktree path", async () => {
      state.classified = [orphan()];
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      await waitFor(() => expect(removeOrphanFn).toHaveBeenCalledWith("/code/veil-coh"));
      expect(removeFn).not.toHaveBeenCalled();
    });

    it("reports a refusal in the Rust side's own words", async () => {
      state.classified = [orphan()];
      removeOrphanFn.mockRejectedValueOnce("this is no longer an orphaned worktree");
      render(<WorktreesPage />);
      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError.mock.calls[0][1]).toMatchObject({
        description: "this is no longer an orphaned worktree",
      });
    });

    /// An orphan must never reach the bulk path: it is precisely the
    /// case where the delete-time safety re-check cannot run.
    it("is not counted among the safe worktrees", () => {
      state.classified = [orphan(), wt({ path: "/code/ok", safety: { kind: "safe" } })];
      render(<WorktreesPage />);
      expect(screen.queryByRole("button", { name: /remove 2 safe/i })).toBeNull();
    });
  });

  describe("bulk removal", () => {
    const threeSafe = () => [
      wt({ path: "/code/a", safety: { kind: "safe" }, size_bytes: 1024 }),
      wt({ path: "/code/b", safety: { kind: "safe" }, size_bytes: 2048 }),
      wt({ path: "/code/c", safety: { kind: "never_pushed" } }),
    ];

    /// #268: the cleanup that spans three systems. A merged branch
    /// leaves a worktree on disk AND a Docker image built from it, and
    /// removing the second used to mean going to another view and
    /// working out by hand which images belonged to what.
    // The Docker-image half of this dialog was REMOVED, not broken.
    //
    // It claimed images built from each worktree, and that join could
    // never fire: every build context on a real machine is the MAIN
    // checkout, which `Safety::MainCheckout` excludes from the manifest
    // by construction. Measured in #336 -- 50 build records, 2 distinct
    // contexts, both the main checkout. The tests that lived here
    // asserted a feature that had matched nothing since it shipped.

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

  /// "All repositories" fell through to `repos?.[0]` -- the FIRST repo,
  /// which `sort_for_sidebar` makes the largest. So across 37 repos the
  /// one question the view could not answer was the one needing every
  /// repo at once.
  describe("all repositories", () => {
    const twoRepos = [
      { identity: null, name: "proj-a", path: "/code/a", worktrees: [wt({ path: "/w/a", size_bytes: 10 })] },
      { identity: null, name: "proj-b", path: "/code/b", worktrees: [wt({ path: "/w/b", size_bytes: 900 })] },
    ];
    const showAll = () => {
      state.repos = twoRepos;
      useFilters.setState({
        filtersByView: { ...EMPTY, worktrees: {} },
        view: "worktrees",
        panel: "list",
      });
      return render(<WorktreesPage />);
    };

    it("lists worktrees from every repository, not just the first", () => {
      showAll();
      expect(screen.getByText("proj-a")).toBeTruthy();
      expect(screen.getByText("proj-b")).toBeTruthy();
    });

    it("says how many repositories it spanned", () => {
      showAll();
      expect(screen.getByText(/2 worktrees across 2 repositories/i)).toBeTruthy();
    });

    it("puts the largest worktree first", () => {
      showAll();
      const names = screen.getAllByText(/^proj-[ab]$/).map((el) => el.textContent);
      expect(names[0]).toBe("proj-b");
    });

    // Acting needs a safety verdict, and classification is per repo at
    // ~16s across all of them -- so a row here navigates instead.
    it("opens a repository rather than offering to remove from here", () => {
      showAll();
      expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
      fireEvent.click(screen.getByText("proj-b"));
      expect(useFilters.getState().filtersByView.worktrees.repo).toBe("/code/b");
    });

    // A total that counts unmeasured sizes as zero is a confident wrong
    // answer, so it is labelled while any are still missing.
    it("calls the total partial while a size is unmeasured", () => {
      state.repos = [
        { identity: null, name: "a", path: "/code/a", worktrees: [wt({ path: "/w/a", size_bytes: null })] },
      ];
      useFilters.setState({
        filtersByView: { ...EMPTY, worktrees: {} },
        view: "worktrees",
        panel: "list",
      });
      render(<WorktreesPage />);
      expect(screen.getByText(/at least/i)).toBeTruthy();
    });
  });

  /// The all-repositories rollup showed a total; the per-repo page --
  /// the one you land on after choosing a repo -- did not, so it could
  /// not answer "how much is this one holding?".
  describe("total size", () => {
    const withSizes = (sizes: (number | null)[]) => {
      state.repos = [
        {
          identity: null,
          name: "proj",
          path: "/code/proj",
          worktrees: sizes.map((size_bytes, i) =>
            wt({ path: `/w/${i}`, branch: `b-${i}`, size_bytes }),
          ),
        },
      ];
      useFilters.setState({
        filtersByView: { ...EMPTY, worktrees: { repo: "/code/proj" } },
        view: "worktrees",
        panel: "list",
      });
      return render(<WorktreesPage />);
    };

    it("sums the sizes it has", () => {
      withSizes([1024, 2048]);
      expect(screen.getByText(/3\.0 KB total|3 KB total/i)).toBeTruthy();
    });

    // Counting an unmeasured size as zero would report a confident
    // wrong number, so the total says so instead.
    it("says the total is partial while a size is missing", () => {
      withSizes([1024, null]);
      expect(screen.getByText(/at least/i)).toBeTruthy();
    });

    it("drops the qualifier once everything is measured", () => {
      withSizes([1024, 2048]);
      expect(screen.queryByText(/at least/i)).toBeNull();
    });

    // Nothing measured yet is not "0 bytes" -- it is no answer at all.
    it("shows no total before any size has arrived", () => {
      withSizes([null, null]);
      expect(screen.queryByText(/total/i)).toBeNull();
    });
  });
});
