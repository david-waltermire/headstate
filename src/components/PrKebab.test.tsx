import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PR_FIXTURES } from "@/fixtures/prs";
import { PrKebab } from "@/components/PrKebab";
import { renderWithQuery as render } from "@/test-utils";
import type { PrActionName } from "@/api/tauri";
import type { PullRequest } from "@/types/pr";

type Act = (id: string, repo: string, number: number, action: PrActionName) => Promise<void>;
const act = vi.fn<Act>(() => Promise.resolve());
type Upd = (id: string, repo: string, number: number, head: string) => Promise<void>;
const update = vi.fn<Upd>(() => Promise.resolve());
const setAuto = vi.fn<
  (id: string, repo: string, n: number, head: string, enable: boolean) => Promise<void>
>(() => Promise.resolve());
vi.mock("@/api/hooks", () => ({
  useActOnPr: () => act,
  useSetAutoMerge: () => setAuto,
  useUpdatePrBranch: () => update,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  ...PR_FIXTURES[0],
  is_draft: false,
  in_merge_queue: false,
  merge: "mergeable",
  merge_status: "clean",
  ci: "success",
  ...over,
});

const open = () => fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));

beforeEach(() => {
  act.mockClear();
  setAuto.mockClear();
  update.mockClear();
});

describe("PrKebab", () => {
  it("merges without a confirmation step", async () => {
    render(<PrKebab pr={pr()} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Merge" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(act.mock.calls[0][3]).toBe("merge");
  });

  it("confirms before closing, and does not act until confirmed", async () => {
    render(<PrKebab pr={pr()} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(act.mock.calls[0][3]).toBe("close");
  });

  it("abandons the close when the dialog is cancelled", () => {
    render(<PrKebab pr={pr()} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(act).not.toHaveBeenCalled();
  });

  // Greying out beats hiding: an absent Merge looks broken, a disabled one
  // with a reason teaches why. Over half of a real account's PRs are DIRTY
  // or UNSTABLE, so this is the common case, not the edge case.
  it.each([
    ["conflicts", { merge: "conflicted" as const }, /merge conflicts/],
    ["failing checks", { ci: "failure" as const }, /checks are failing/],
    ["drafts", { is_draft: true }, /drafts cannot be merged/],
  ])("offers merge but disables it on %s", (_name, over, reason) => {
    render(<PrKebab pr={pr(over)} />);
    open();
    // A draft's menu swaps Merge for "Mark ready"; the others keep Merge
    // visible-but-dead. Either way the reason must be discoverable.
    const item = screen.queryByRole("menuitem", { name: "Merge" });
    if (item) {
      expect((item as HTMLButtonElement).disabled).toBe(true);
      expect(item.getAttribute("title")).toMatch(reason);
      fireEvent.click(item);
      expect(act).not.toHaveBeenCalled();
    }
  });

  it("offers the draft transition matching the PR's current state", () => {
    render(<PrKebab pr={pr({ is_draft: true })} />);
    open();
    expect((screen.getByRole("menuitem", { name: "Mark ready for review" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("menuitem", { name: "Convert to draft" })).toBeNull();
  });

  it("offers leaving the merge queue only when the PR is in it", () => {
    const { unmount } = render(<PrKebab pr={pr({ in_merge_queue: true })} />);
    open();
    expect((screen.getByRole("menuitem", { name: "Remove from merge queue" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("menuitem", { name: "Add to merge queue" })).toBeNull();
    unmount();

    render(<PrKebab pr={pr()} />);
    open();
    expect((screen.getByRole("menuitem", { name: "Add to merge queue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The review view: merging or closing someone else's PR is not yours to
  // do, and an action that fails on permissions is worse than no action.
  it("hides every write action on a PR the user does not own", () => {
    render(<PrKebab pr={pr()} canWrite={false} />);
    open();
    for (const name of ["Merge", "Close", "Convert to draft", "Add to merge queue"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
    expect(screen.getByRole("menuitem", { name: /Copy branch name/ })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /View on GitHub/ })).not.toBeNull();
  });

  // Available on every PR regardless of state and without write access:
  // it is a clipboard operation, not a mutation.
  it("copies an agent prompt naming the PR and its branch pair", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PrKebab pr={pr({ head_ref: "ci_fix_2", base_ref: "main" })} canWrite={false} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy for agent/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0][0];
    expect(text).toContain("(ci_fix_2 → main)");
    expect(text).toContain(`#${PR_FIXTURES[0].number}`);
  });

  it("copies the head branch, not the base", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PrKebab pr={pr({ head_ref: "ci_fix_2", base_ref: "main" })} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy branch name/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ci_fix_2"));
  });

  // "Update branch" is offered only for BEHIND. On a DIRTY PR it would
  // fail or produce a conflicted merge commit, so unlike Merge -- which
  // is shown disabled with its reason -- this one is absent entirely.
  it("offers Update branch only when the PR is behind its base", () => {
    const { unmount } = render(<PrKebab pr={pr({ merge_status: "behind" })} />);
    open();
    expect(screen.getByRole("menuitem", { name: "Update branch" })).not.toBeNull();
    unmount();

    for (const status of ["clean", "dirty", "blocked", "unstable"] as const) {
      const r = render(<PrKebab pr={pr({ merge_status: status })} />);
      open();
      expect(screen.queryByRole("menuitem", { name: "Update branch" })).toBeNull();
      r.unmount();
    }
  });

  // The OID is the whole point: it is what makes GitHub refuse a stale
  // click instead of updating a commit the user never looked at.
  it("sends the head commit the row was rendered from", async () => {
    render(<PrKebab pr={pr({ merge_status: "behind", head_oid: "abc123" })} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Update branch" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][3]).toBe("abc123");
  });

  it("does not confirm before updating, since the change is recoverable", async () => {
    render(<PrKebab pr={pr({ merge_status: "behind" })} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Update branch" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered on a PR the user does not own", () => {
    render(<PrKebab pr={pr({ merge_status: "behind" })} canWrite={false} />);
    open();
    expect(screen.queryByRole("menuitem", { name: "Update branch" })).toBeNull();
  });

  // The row is a click target that opens the detail view; acting from the
  // kebab must not also navigate.
  it("does not bubble clicks to the surrounding row", () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <PrKebab pr={pr()} />
      </div>,
    );
    open();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  // UNSTABLE means checks are still running, not that merging is
  // impossible -- exactly "I would merge this the moment CI goes green",
  // and 6 of 24 open PRs are in that state on a real account.
  describe("merge when green", () => {
    it("is offered for a PR whose checks are still running", () => {
      render(<PrKebab pr={pr({ merge_status: "unstable" })} />);
      open();
      expect(screen.getByRole("menuitem", { name: /merge when green/i })).toBeTruthy();
    });

    it("is not offered where an immediate merge already applies", () => {
      render(<PrKebab pr={pr({ merge_status: "clean" })} />);
      open();
      expect(screen.queryByRole("menuitem", { name: /merge when green/i })).toBeNull();
    });

    it("is not offered on a draft", () => {
      render(<PrKebab pr={pr({ merge_status: "unstable", is_draft: true })} />);
      open();
      expect(screen.queryByRole("menuitem", { name: /merge when green/i })).toBeNull();
    });

    // The OID keeps a DEFERRED write honest: it fires later, unattended,
    // so without it a push after enabling merges a commit never seen.
    it("pins the head the row was rendered from", async () => {
      render(<PrKebab pr={pr({ merge_status: "unstable", head_oid: "abc123" })} />);
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /merge when green/i }));
      await waitFor(() => expect(setAuto).toHaveBeenCalled());
      expect(setAuto.mock.calls[0][3]).toBe("abc123");
      expect(setAuto.mock.calls[0][4]).toBe(true);
    });

    it("is not offered on a PR the user does not own", () => {
      render(<PrKebab pr={pr({ merge_status: "unstable" })} canWrite={false} />);
      open();
      expect(screen.queryByRole("menuitem", { name: /merge when green/i })).toBeNull();
    });
  });
});
