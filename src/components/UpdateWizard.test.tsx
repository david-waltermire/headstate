import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Outdated, RunReport } from "@/types/pr";

const applyFn = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<RunReport>>());
const prFn = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<string>>());
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../api/tauri", () => ({ applyPackageUpdates: applyFn, openUpdatePr: prFn }));

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
    prFn.mockResolvedValue("https://github.com/octocat/hello-world/pull/7");
    applyFn.mockResolvedValue({
      worktree: "/code/app/.worktrees/update-lodash",
      branch: "headstate/update-lodash",
      ecosystems: ["npm"],
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
      ecosystems: ["npm"],
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
      ecosystems: ["npm"],
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

  /// #478: one repository declares the same dependency in several
  /// manifests, so `ecosystem:name` was not a unique row identity --
  /// ticking one checkbox ticked every row with that name.
  it("gives each manifest its own checkbox for the same package", () => {
    const dup = (manifest: string, current: string): Outdated => ({
      ...pkg("registry.terraform.io/hashicorp/aws"),
      manifest,
      current,
    });
    show([dup("a/main.tf", "5.100.0"), dup("b/main.tf", "5.90.0")]);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  /// Two rows for one dependency are indistinguishable without saying
  /// which file each came from.
  it("names the manifest each row belongs to", () => {
    show([pkg("lodash")]);
    expect(screen.getByText("package.json")).toBeTruthy();
  });

  it("selects and clears every applicable package", () => {
    show([pkg("lodash"), pkg("express")]);
    fireEvent.click(screen.getByRole("button", { name: /select all 2/i }));
    for (const b of screen.getAllByRole("checkbox")) {
      expect((b as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    for (const b of screen.getAllByRole("checkbox")) {
      expect((b as HTMLInputElement).checked).toBe(false);
    }
  });

  /// The backend refuses Terraform (`apply::supported`), but the UI
  /// listed it as applicable -- so every Terraform row was selectable,
  /// counted toward the button, and failed at apply time with a reason
  /// the user could have been given before clicking.
  it("does not offer Terraform providers as applicable", () => {
    show([pkg("registry.terraform.io/hashicorp/aws", "terraform")]);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(/constraint in your .tf source/i)).toBeTruthy();
  });

  /// The `2.8.0 → 2.8.0` rows in the report. `registry::enrich` leaves
  /// a provider at `latest == current` with `bump: "unknown"` when its
  /// lookup FAILS -- meaning "cannot compare", not "up to date". The
  /// wizard rendered that identically to a real update.
  it("does not offer a row whose latest could not be determined", () => {
    const unknown: Outdated = {
      ...pkg("registry.terraform.io/hashicorp/archive"),
      ecosystem: "npm",
      current: "2.8.0",
      latest: "2.8.0",
      bump: "unknown",
    };
    show([unknown]);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(/could not be determined/i)).toBeTruthy();
  });

  describe("opening a pull request from the report", () => {
    const runToReport = async () => {
      show([pkg("lodash")]);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /apply/i }));
      await screen.findByText("headstate/update-lodash");
    };

    it("pushes and opens a pull request, then shows the link", async () => {
      await runToReport();

      fireEvent.click(screen.getByRole("button", { name: /push and open a pull request/i }));

      await waitFor(() => expect(prFn).toHaveBeenCalledTimes(1));
      expect(prFn).toHaveBeenCalledWith(
        "/code/app",
        expect.objectContaining({ branch: "headstate/update-lodash" }),
      );
      // The URL is what the user needs next, so it stays on the page and is
      // not merely announced in a toast that disappears.
      expect(
        await screen.findByText("https://github.com/octocat/hello-world/pull/7"),
      ).toBeTruthy();
    });

    it("reports a failure instead of pretending the pull request opened", async () => {
      prFn.mockRejectedValue("no upstream remote");
      await runToReport();

      fireEvent.click(screen.getByRole("button", { name: /push and open a pull request/i }));

      await waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith(
          "Could not open the pull request",
          { description: "no upstream remote" },
        ),
      );
      expect(screen.queryByText(/pull\/7/)).toBeNull();
    });

    it("explains, rather than hides, why an unverifiable ecosystem gets no button", async () => {
      applyFn.mockResolvedValue({
        worktree: "/code/app/.worktrees/update-boto3",
        branch: "headstate/update-boto3",
        ecosystems: ["poetry"],
        results: [
          {
            name: "boto3",
            requested: "2.0.0",
            changed_files: ["requirements.txt"],
            output: "",
            resolved_constraint: null,
            error: null,
          },
        ],
      });
      show([pkg("boto3", "poetry")]);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /apply/i }));
      await screen.findByText("headstate/update-boto3");

      expect(
        screen.queryByRole("button", { name: /push and open a pull request/i }),
      ).toBeNull();
      expect(screen.getByText(/only be opened for npm and yarn/i)).toBeTruthy();
    });
  });
});
