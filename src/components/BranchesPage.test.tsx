import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Deletable } from "@/types/pr";

const listFn = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<Branch[]>>());
const delLocal = vi.hoisted(() =>
  vi.fn<(...a: unknown[]) => Promise<{ name: string; error: string | null }[]>>(),
);
const delRemote = vi.hoisted(() =>
  vi.fn<(...a: unknown[]) => Promise<{ name: string; error: string | null }[]>>(),
);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("sonner", () => ({ toast: toasts }));
// The hook, not the whole tauri module: `api/hooks` pulls in the rest of
// the app's commands, and mocking that module wholesale would make this
// test depend on every one of them.
vi.mock("../api/hooks", () => ({
  useBranches: (repoPath: string | undefined) => {
    const q = useQuery({
      queryKey: ["branches", repoPath],
      queryFn: () => listFn(repoPath),
      enabled: !!repoPath,
      retry: false,
    });
    return q;
  },
}));
vi.mock("../api/tauri", () => ({
  listBranches: listFn,
  deleteBranches: delLocal,
  deleteRemoteBranches: delRemote,
}));

import { BranchesPage, reason } from "./BranchesPage";
import { useFilters } from "../store/filters";

const branch = (over: Partial<Branch> = {}): Branch => ({
  name: "feature",
  location: "local",
  upstream: null,
  ahead: 0,
  behind: 0,
  committed: new Date().toISOString(),
  author: "octocat",
  tip: "abc1234",
  deletable: { kind: "merged", how: "squash" },
  ...over,
});

const show = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BranchesPage />
    </QueryClientProvider>,
  );
};

describe("reason", () => {
  /// Every case must produce words. A branch with no reason shown is
  /// the failure this whole tagged union exists to prevent.
  it("explains every state, including the ones that block deletion", () => {
    const cases: Deletable[] = [
      { kind: "merged", how: "ancestor" },
      { kind: "merged", how: "squash" },
      { kind: "defaultBranch" },
      { kind: "checkedOut", path: "/w/foo" },
      { kind: "unmerged", ahead: 3 },
      { kind: "pending" },
      { kind: "unknown", reason: "git failed" },
    ];
    for (const c of cases) expect(reason(c).length).toBeGreaterThan(0);
  });

  /// A squash merge is established by comparing content, not ancestry.
  /// The UI says which, because they do not deserve equal confidence.
  it("distinguishes a squash merge from an ancestor merge", () => {
    expect(reason({ kind: "merged", how: "squash" })).toMatch(/squash/i);
    expect(reason({ kind: "merged", how: "ancestor" })).not.toMatch(/squash/i);
  });

  it("counts commits when a branch is unmerged", () => {
    expect(reason({ kind: "unmerged", ahead: 1 })).toMatch(/1 commit\b/);
    expect(reason({ kind: "unmerged", ahead: 4 })).toMatch(/4 commits/);
  });

  it("names where a checked-out branch is checked out", () => {
    expect(reason({ kind: "checkedOut", path: "/w/foo" })).toContain("/w/foo");
  });
});

describe("BranchesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFilters.getState().setView("branches");
    useFilters.getState().setFilter("repo", "/code/app");
    listFn.mockResolvedValue([
      branch({ name: "done" }),
      branch({
        name: "wip",
        deletable: { kind: "unmerged", ahead: 2 },
      }),
    ]);
    delLocal.mockResolvedValue([{ name: "done", error: null }]);
    delRemote.mockResolvedValue([{ name: "origin/shipped", error: null }]);
  });

  it("lists branches with the reason each one is or is not deletable", async () => {
    show();
    expect(await screen.findByText("done")).toBeTruthy();
    expect(screen.getByText(/Merged \(squashed\)/)).toBeTruthy();
    expect(screen.getByText(/Not merged — 2 commits/)).toBeTruthy();
  });

  /// The gate the UI enforces before the backend re-checks it.
  it("does not let an unmerged branch be selected", async () => {
    show();
    await screen.findByText("done");
    expect(screen.getByLabelText("done").hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("wip").hasAttribute("disabled")).toBe(true);
  });

  it("deletes the selected local branches", async () => {
    show();
    await screen.findByText("done");
    fireEvent.click(screen.getByLabelText("done"));
    fireEvent.click(screen.getByRole("button", { name: /delete 1 local/i }));

    await waitFor(() => expect(delLocal).toHaveBeenCalledTimes(1));
    expect(delLocal).toHaveBeenCalledWith("/code/app", ["done"]);
    expect(delRemote).not.toHaveBeenCalled();
  });

  /// Deleting on the remote is a push to shared state. It must never
  /// be reachable by the control that deletes a local ref.
  it("keeps remote deletion on a separate control from local deletion", async () => {
    listFn.mockResolvedValue([
      branch({ name: "origin/shipped", location: "remote" }),
    ]);
    show();
    await screen.findByText("origin/shipped");
    fireEvent.click(screen.getByLabelText("origin/shipped"));

    // The local button is present but has nothing local to act on.
    expect(
      screen.getByRole("button", { name: /delete 0 local/i }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /delete 1 on the remote/i }));
    await waitFor(() => expect(delRemote).toHaveBeenCalledTimes(1));
    expect(delRemote).toHaveBeenCalledWith("/code/app", ["origin/shipped"]);
    expect(delLocal).not.toHaveBeenCalled();
  });

  /// A refusal names the branch AND the reason: a bare count tells the
  /// user nothing they can act on.
  it("reports each refusal with its reason", async () => {
    delLocal.mockResolvedValue([
      { name: "done", error: "done is not merged: 1 commit(s) are not on the default branch" },
    ]);
    show();
    await screen.findByText("done");
    fireEvent.click(screen.getByLabelText("done"));
    fireEvent.click(screen.getByRole("button", { name: /delete 1 local/i }));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not delete done", {
        description: "done is not merged: 1 commit(s) are not on the default branch",
      }),
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });

  /// ~9s on a large repository is long enough that a silent page reads
  /// as a hang.
  it("says the scan is slow rather than showing nothing", () => {
    listFn.mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByText(/scanning branches/i)).toBeTruthy();
  });

  it("asks for a repository when none is selected", () => {
    useFilters.getState().setFilter("repo", undefined);
    show();
    expect(screen.getByText(/select a repository/i)).toBeTruthy();
    expect(listFn).not.toHaveBeenCalled();
  });
});
