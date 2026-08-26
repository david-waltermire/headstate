import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchOutcome } from "@/api/tauri";
import { BulkBar, prKey } from "@/components/BulkBar";
import { PR_FIXTURES } from "@/fixtures/prs";
import { useFilters } from "@/store/filters";
import { renderWithQuery as render } from "@/test-utils";

type Batch = (prs: [string, string, number][], action: string) => Promise<BatchOutcome[]>;
const batch = vi.fn<Batch>(() => Promise.resolve([]));
vi.mock("@/api/hooks", () => ({ useActOnPrs: () => batch }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

beforeEach(() => {
  batch.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  useFilters.getState().clearChecked();
});

const select = (...prs: { repo: string; number: number }[]) =>
  useFilters.getState().setChecked(prs.map(prKey));

/// Click the confirm button inside the dialog. Scoped with `within` --
/// the toolbar button that opened the dialog carries the same label, so
/// an unscoped query matches both.
const confirm = (label: string) =>
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: new RegExp(`^${label} \\d+ pull request`),
    }),
  );

describe("BulkBar", () => {
  it("stays out of the way when nothing is selected", () => {
    const { container } = render(<BulkBar prs={PR_FIXTURES} />);
    expect(container.firstChild).toBeNull();
  });

  it("counts what is selected", () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    render(<BulkBar prs={PR_FIXTURES} />);
    expect(screen.getByText("2 selected")).not.toBeNull();
  });

  // The issue's first requirement: selecting then narrowing a filter must
  // not silently drop rows. Selection is keyed, and the bar resolves keys
  // against the unfiltered list it is handed.
  it("keeps a selected PR that the visible list no longer contains", async () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    render(<BulkBar prs={PR_FIXTURES} />);

    // The batch must contain BOTH -- proven by acting, not by the count,
    // which a bar handed a pre-filtered list would also render correctly.
    batch.mockResolvedValueOnce(
      [PR_FIXTURES[0], PR_FIXTURES[1]].map((p) => ({
        repo: p.repo,
        number: p.number,
        error: null,
      })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to merge queue" }));
    confirm("Add to merge queue");
    await waitFor(() => expect(batch).toHaveBeenCalled());
    expect(batch.mock.calls[0][0].map((t) => t[2]).sort()).toEqual(
      [PR_FIXTURES[0].number, PR_FIXTURES[1].number].sort(),
    );
  });

  // Bulk merge is deliberately excluded: each merge changes the base the
  // next merges onto, which cascades conflicts onto main. Enqueue is the
  // safe expression of the same intent.
  it("does not offer bulk merge", () => {
    select(PR_FIXTURES[0]);
    render(<BulkBar prs={PR_FIXTURES} />);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add to merge queue" })).not.toBeNull();
  });

  // A count is not something anyone can act on safely.
  it("names every pull request in the confirmation, not just a count", () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PRs" }));
    for (const pr of [PR_FIXTURES[0], PR_FIXTURES[1]]) {
      expect(screen.getByText(new RegExp(`${pr.repo}#${pr.number}`))).not.toBeNull();
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it("confirms every bulk action, not only the destructive one", () => {
    select(PR_FIXTURES[0]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to merge queue" }));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", () => {
    select(PR_FIXTURES[0]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PRs" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(batch).not.toHaveBeenCalled();
  });

  it("sends every selected PR once confirmed", async () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    batch.mockResolvedValueOnce([
      { repo: PR_FIXTURES[0].repo, number: PR_FIXTURES[0].number, error: null },
      { repo: PR_FIXTURES[1].repo, number: PR_FIXTURES[1].number, error: null },
    ]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to merge queue" }));
    confirm("Add to merge queue");
    await waitFor(() => expect(batch).toHaveBeenCalled());
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(batch.mock.calls[0][1]).toBe("enqueue");
  });

  // Partial failure is the normal case for a batch, not the exception.
  it("reports failures rather than a bare success", async () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    batch.mockResolvedValueOnce([
      { repo: PR_FIXTURES[0].repo, number: PR_FIXTURES[0].number, error: null },
      { repo: PR_FIXTURES[1].repo, number: PR_FIXTURES[1].number, error: "not mergeable" },
    ]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Close PRs" }));
    confirm("Close PRs");
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toMatch(/1 of 2 failed/);
    expect(opts.description).toContain("not mergeable");
  });

  // Retrying should not repeat what already worked.
  it("keeps only the failures selected, so a retry does not repeat successes", async () => {
    select(PR_FIXTURES[0], PR_FIXTURES[1]);
    batch.mockResolvedValueOnce([
      { repo: PR_FIXTURES[0].repo, number: PR_FIXTURES[0].number, error: null },
      { repo: PR_FIXTURES[1].repo, number: PR_FIXTURES[1].number, error: "boom" },
    ]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Convert to draft" }));
    confirm("Convert to draft");
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(useFilters.getState().checked).toEqual([prKey(PR_FIXTURES[1])]);
  });

  it("clears the selection when everything succeeded", async () => {
    select(PR_FIXTURES[0]);
    batch.mockResolvedValueOnce([
      { repo: PR_FIXTURES[0].repo, number: PR_FIXTURES[0].number, error: null },
    ]);
    render(<BulkBar prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    confirm("Mark ready");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(useFilters.getState().checked).toEqual([]);
  });
});
