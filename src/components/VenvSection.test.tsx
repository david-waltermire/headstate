import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Venv } from "@/types/pr";

const removeFn = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
const state = vi.hoisted(() => ({
  venvs: [] as Venv[],
  sizes: new Map<string, number>(),
  idle: new Map<string, number>(),
  measuring: false,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api/hooks", () => ({
  useVenvs: () => ({ data: state.venvs }),
  useVenvSizes: () => ({
    sizes: state.sizes,
    idle: state.idle,
    measuring: state.measuring,
  }),
  useRemoveVenvs: () => removeFn,
}));

import { VenvSection } from "./VenvSection";

const venv = (over: Partial<Venv> = {}): Venv => ({
  path: "/cache/mls-delivery-service-AAAAAAAA-py3.13",
  project: "mls-delivery-service",
  state: "orphaned",
  source: null,
  size_bytes: null,
  idle_secs: null,
  ...over,
});

beforeEach(() => {
  removeFn.mockClear();
  state.venvs = [];
  state.sizes = new Map();
  state.idle = new Map();
  state.measuring = false;
});

describe("VenvSection", () => {
  it("renders nothing when there are no virtualenvs", () => {
    const { container } = render(<VenvSection />);
    expect(container.firstChild).toBeNull();
  });

  /// Orphaned is a FACT -- the path that made it is gone. Stale is a
  /// judgement about a project that still exists, and this view will not
  /// act on a judgement.
  it("offers only orphans for removal", () => {
    state.venvs = [
      venv(),
      venv({
        path: "/cache/cm-backend-BBBBBBBB-py3.13",
        project: "cm-backend",
        state: "live",
        source: "/code/cm-backend",
      }),
    ];
    state.idle = new Map([["/cache/cm-backend-BBBBBBBB-py3.13", 416 * 86400]]);
    render(<VenvSection />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].hasAttribute("disabled")).toBe(false);
    expect(boxes[1].hasAttribute("disabled")).toBe(true);
  });

  /// The reported case: a project still on disk, untouched for over a
  /// year. It must be VISIBLE and labelled, but not removable.
  it("labels a long-idle venv as stale, not live", () => {
    state.venvs = [
      venv({
        path: "/cache/cm-backend-BBBBBBBB-py3.13",
        project: "cm-backend",
        state: "live",
        source: "/code/cm-backend",
      }),
    ];
    state.idle = new Map([["/cache/cm-backend-BBBBBBBB-py3.13", 416 * 86400]]);
    render(<VenvSection />);
    expect(screen.getByText("stale")).toBeTruthy();
  });

  it("keeps a recently used venv live", () => {
    state.venvs = [
      venv({
        path: "/cache/enclave-mcp-CCCCCCCC-py3.13",
        project: "enclave-mcp",
        state: "live",
        source: "/code/enclave-mcp",
      }),
    ];
    state.idle = new Map([["/cache/enclave-mcp-CCCCCCCC-py3.13", 3 * 3600]]);
    render(<VenvSection />);
    expect(screen.getByText("live")).toBeTruthy();
  });

  /// An orphan's path is gone, so how recently it was touched says
  /// nothing about whether anyone wants it.
  it("keeps an orphan orphaned however recently touched", () => {
    state.venvs = [venv()];
    // A VERY small idle time. Any rule that reclassifies an orphan by
    // age has to have a threshold somewhere, and a value below every
    // plausible one is what forces such a rule to show itself -- a
    // larger number sits above the threshold and passes either way.
    state.idle = new Map([[venv().path, 5]]);
    render(<VenvSection />);
    expect(screen.getByText("orphaned")).toBeTruthy();
  });

  /// ...and stays orphaned when it looks STALE by age too. Age must
  /// never reclassify an orphan in either direction: its path is gone,
  /// so the timestamp is not evidence about anything.
  it("keeps an orphan orphaned when it is also long idle", () => {
    state.venvs = [venv()];
    state.idle = new Map([[venv().path, 500 * 86400]]);
    render(<VenvSection />);
    expect(screen.getByText("orphaned")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
  });

  /// The source is the EVIDENCE for the verdict -- it is what lets a
  /// user disagree with the label.
  it("names the project directory behind a live verdict", () => {
    state.venvs = [
      venv({ state: "live", source: "/code/still-here", project: "still-here" }),
    ];
    render(<VenvSection />);
    expect(screen.getByText("/code/still-here")).toBeTruthy();
  });

  it("says so when no project directory was found", () => {
    state.venvs = [venv()];
    render(<VenvSection />);
    expect(screen.getByText("no project directory found")).toBeTruthy();
  });

  it("removes the selected orphans on confirm", () => {
    state.venvs = [venv()];
    state.sizes = new Map([[venv().path, 1_000_000]]);
    render(<VenvSection />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeFn).toHaveBeenCalledWith([venv().path]);
  });

  it("removes nothing on cancel", () => {
    state.venvs = [venv()];
    render(<VenvSection />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeFn).not.toHaveBeenCalled();
  });

  /// A disabled checkbox that explains itself beats one that silently
  /// ignores clicks.
  it("says why a live venv cannot be selected", () => {
    state.venvs = [
      venv({ state: "live", source: "/code/x", project: "x" }),
    ];
    render(<VenvSection />);
    expect(
      screen.getByRole("checkbox", { name: /its project still exists/ }),
    ).toBeTruthy();
  });
});

describe("VenvSection bulk removal", () => {
  /// The reported case: 78 orphans from ONE deleted project. Ticking
  /// them individually is 78 clicks for a decision made once -- and
  /// every one is a fact rather than a judgement, so there is nothing to
  /// weigh row by row.
  it("offers one click for every orphan", () => {
    state.venvs = [
      venv({ path: "/cache/a-AAAAAAAA-py3.13" }),
      venv({ path: "/cache/b-BBBBBBBB-py3.13" }),
      venv({ path: "/cache/c-CCCCCCCC-py3.13" }),
    ];
    state.sizes = new Map([
      ["/cache/a-AAAAAAAA-py3.13", 1_000_000_000],
      ["/cache/b-BBBBBBBB-py3.13", 2_000_000_000],
      ["/cache/c-CCCCCCCC-py3.13", 3_000_000_000],
    ]);
    render(<VenvSection />);
    expect(screen.getByRole("button", { name: /Remove all 3 orphaned/ })).toBeTruthy();
  });

  /// It must select ONLY orphans. A live venv swept into a bulk action
  /// is the one outcome that would make the button untrustworthy.
  it("never sweeps a live venv into the bulk selection", () => {
    state.venvs = [
      venv({ path: "/cache/a-AAAAAAAA-py3.13" }),
      venv({
        path: "/cache/live-BBBBBBBB-py3.13",
        state: "live",
        source: "/code/live",
      }),
      venv({ path: "/cache/c-CCCCCCCC-py3.13" }),
    ];
    render(<VenvSection />);
    fireEvent.click(screen.getByRole("button", { name: /Remove all 2 orphaned/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeFn).toHaveBeenCalledWith([
      "/cache/a-AAAAAAAA-py3.13",
      "/cache/c-CCCCCCCC-py3.13",
    ]);
  });

  /// A single orphan needs no bulk affordance -- its own checkbox is
  /// already one click.
  it("does not offer bulk removal for a single orphan", () => {
    state.venvs = [venv()];
    render(<VenvSection />);
    expect(screen.queryByRole("button", { name: /Remove all/ })).toBeNull();
  });
});
