import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Outdated, RunReport } from "@/types/pr";

const applyFn = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<RunReport>>());
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../api/tauri", () => ({ applyPackageUpdates: applyFn }));

import { UpdateWizard } from "./UpdateWizard";

const pkg = (name: string, ecosystem: Outdated["ecosystem"] = "npm"): Outdated => ({
  name,
  current: "1.0.0",
  latest: "2.0.0",
  bump: "major",
  ecosystem,
  manifest: "package.json",
});

const show = (packages: Outdated[]) =>
  render(
    <UpdateWizard repo="/code/app" packages={packages} open onOpenChange={vi.fn()} />,
  );

describe("UpdateWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyFn.mockResolvedValue({
      worktree: "/code/app/.worktrees/update-lodash",
      branch: "headstate/update-lodash",
      results: [
        {
          name: "lodash",
          requested: "4.17.21",
          changed_files: ["package.json", "package-lock.json"],
          output: "",
          resolved_constraint: "^4.17.21",
          error: null,
        },
      ],
    });
  });

  it("says plainly that nothing is pushed", () => {
    show([pkg("lodash")]);
    expect(screen.getByText(/Nothing is pushed/i)).toBeTruthy();
  });

  /// Swift cannot be applied, and saying so beats omitting it: a package
  /// that silently cannot be selected reads as a bug in the list.
  it("lists unappliable packages with a reason instead of hiding them", () => {
    show([pkg("lodash"), pkg("Alamofire", "swift")]);
    expect(screen.getByText("Alamofire")).toBeTruthy();
    expect(screen.getByText(/Xcode/)).toBeTruthy();
    // And it is not selectable.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("does not apply until something is selected", () => {
    show([pkg("lodash")]);
    const button = screen.getByRole("button", { name: /Apply/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(applyFn).not.toHaveBeenCalled();
  });

  it("requests the latest version for each selected package", async () => {
    show([pkg("lodash")]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(applyFn).toHaveBeenCalledTimes(1));
    expect(applyFn).toHaveBeenCalledWith("/code/app", [
      { name: "lodash", version: "2.0.0", ecosystem: "npm" },
    ]);
  });

  /// The finding phase 1 exists to surface: what the resolver actually
  /// wrote differs from what was asked for.
  it("reports the resolved constraint, not the requested version", async () => {
    show([pkg("lodash")]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await screen.findByText("^4.17.21");
    expect(screen.getByText("4.17.21")).toBeTruthy();
  });

  it("shows where the work landed", async () => {
    show([pkg("lodash")]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await screen.findByText("/code/app/.worktrees/update-lodash");
  });

  /// A command that succeeded and changed nothing is a real outcome --
  /// usually a manifest constraint pinning the package below what was
  /// asked for -- and must not render as blank.
  it("states when nothing changed rather than showing an empty list", async () => {
    applyFn.mockResolvedValue({
      worktree: "/w",
      branch: "b",
      results: [
        {
          name: "lodash",
          requested: "2.0.0",
          changed_files: [],
          output: "",
          resolved_constraint: "^1.0.0",
          error: null,
        },
      ],
    });
    show([pkg("lodash")]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await screen.findByText(/No files changed/i);
  });

  /// One package failing must not hide the others.
  it("reports a per-package failure without discarding the run", async () => {
    applyFn.mockResolvedValue({
      worktree: "/w",
      branch: "b",
      results: [
        {
          name: "lodash",
          requested: "2.0.0",
          changed_files: ["package.json"],
          output: "",
          resolved_constraint: "^2.0.0",
          error: null,
        },
        {
          name: "express",
          requested: "5.0.0",
          changed_files: [],
          output: "",
          resolved_constraint: null,
          error: "peer dependency conflict",
        },
      ],
    });
    show([pkg("lodash"), pkg("express")]);
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await screen.findByText("peer dependency conflict");
    // The one that worked is still reported.
    expect(screen.getByText("^2.0.0")).toBeTruthy();
    expect(toasts.warning).toHaveBeenCalled();
  });

  it("surfaces a failed run as an error", async () => {
    applyFn.mockRejectedValue("branch already exists");
    show([pkg("lodash")]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
  });
});
