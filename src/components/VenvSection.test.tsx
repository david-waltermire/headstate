import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Venv } from "@/types/pr";

// Typed so a test can resolve with real outcomes: a bare
// `Promise.resolve([])` infers `never[]`, which rejects every fixture.
const removeFn = vi.hoisted(() =>
  vi.fn<(paths: string[]) => Promise<{ path: string; error: string | null }[]>>(() =>
    Promise.resolve([]),
  ),
);
const state = vi.hoisted(() => ({
  venvs: [] as Venv[],
  sizes: new Map<string, number>(),
  idle: new Map<string, number>(),
  measuring: false,
  loading: false,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api/hooks", () => ({
  useVenvs: () => ({ data: state.venvs, isLoading: state.loading }),
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
  state.loading = false;
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
  /// Was "offers only orphans". A 416-day-old virtualenv is now
  /// removable without a setting: ticking the row IS the intent, and no
  /// other artifact asks twice. `live` stays refused -- its project
  /// exists and is in use, which is a fact rather than a threshold.
  it("offers orphans and stale virtualenvs, but never live ones", () => {
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
    // The orphan.
    expect(boxes[0].hasAttribute("disabled")).toBe(false);
    // 416 days idle -> stale -> now selectable, no setting involved.
    expect(boxes[1].hasAttribute("disabled")).toBe(false);
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

describe("selecting a stale virtualenv", () => {
  const staleVenv = () =>
    venv({
      path: "/cache/old-project-BBBBBBBB-py3.13",
      project: "old-project",
      state: "live",
    });

  /// Settings already had "Also allow removing stale virtualenvs", and
  /// `remove_venvs` already honoured it as `policy.allow_stale`. The
  /// checkbox did not, so turning the setting on changed nothing the
  /// user could see.
  it("is selectable once the setting allows it", () => {
    state.venvs = [staleVenv()];
    state.idle = new Map([["/cache/old-project-BBBBBBBB-py3.13", 60 * 60 * 24 * 400]]);
    render(<VenvSection />);
    expect(screen.getByText("stale")).toBeTruthy();
    const box = screen.getByLabelText("Select old-project virtualenv");
    expect(box.hasAttribute("disabled")).toBe(false);
  });

  /// The gate is GONE. This asserts it stays gone: a stale virtualenv is
  /// selectable regardless of any setting, because manual removal is not
  /// where a staleness threshold needs the user's permission.
  it("is selectable regardless of any setting", () => {
    state.venvs = [staleVenv()];
    state.idle = new Map([["/cache/old-project-BBBBBBBB-py3.13", 60 * 60 * 24 * 400]]);
    render(<VenvSection />);
    const box = screen.getByLabelText("Select old-project virtualenv");
    expect(box.hasAttribute("disabled")).toBe(false);
  });

  /// A live venv is never removable, at either layer.
  it("never offers a live virtualenv, even with the setting on", () => {
    state.venvs = [venv({ path: "/cache/live-CCCCCCCC-py3.13", project: "live", state: "live" })];
    state.idle = new Map([["/cache/live-CCCCCCCC-py3.13", 60]]);
    render(<VenvSection />);
    const box = screen.getByLabelText(/live virtualenv cannot be removed/);
    expect(box.hasAttribute("disabled")).toBe(true);
  });

  /// An orphan needs no setting: its project is gone, which is a fact
  /// rather than a judgement.
  it("always offers an orphan", () => {
    state.venvs = [venv()];
    render(<VenvSection />);
    const box = screen.getByLabelText("Select mls-delivery-service virtualenv");
    expect(box.hasAttribute("disabled")).toBe(false);
  });
});

describe("selection during removal", () => {
  /// Same defect as the artifacts page: a blanket reset after the await
  /// discarded anything ticked mid-flight, and unticked rows that FAILED
  /// -- which are the ones still needing attention.
  it("keeps a selection made while the removal was running", async () => {
    state.venvs = [
      venv({ path: "/cache/a-AAAAAAAA-py3.13", project: "a" }),
      venv({ path: "/cache/b-BBBBBBBB-py3.13", project: "b" }),
    ];
    state.sizes = new Map([
      ["/cache/a-AAAAAAAA-py3.13", 1_000],
      ["/cache/b-BBBBBBBB-py3.13", 2_000],
    ]);

    let settle: (v: { path: string; error: string | null }[]) => void = () => {};
    removeFn.mockImplementationOnce(() => new Promise((res) => { settle = res; }));

    render(<VenvSection />);
    fireEvent.click(screen.getByLabelText("Select a virtualenv"));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/ }));
    expect(removeFn).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Select b virtualenv"));

    await act(async () => {
      settle([{ path: "/cache/a-AAAAAAAA-py3.13", error: null }]);
    });

    await waitFor(() =>
      expect((screen.getByLabelText("Select a virtualenv") as HTMLInputElement).checked).toBe(false),
    );
    expect((screen.getByLabelText("Select b virtualenv") as HTMLInputElement).checked).toBe(true);
  });

  it("keeps the selection for a virtualenv that could not be removed", async () => {
    state.venvs = [venv({ path: "/cache/a-AAAAAAAA-py3.13", project: "a" })];
    state.sizes = new Map([["/cache/a-AAAAAAAA-py3.13", 1_000]]);
    removeFn.mockResolvedValueOnce([
      { path: "/cache/a-AAAAAAAA-py3.13", error: "it is not an orphan" },
    ]);

    render(<VenvSection />);
    fireEvent.click(screen.getByLabelText("Select a virtualenv"));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/ }));

    await waitFor(() => expect(removeFn).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Remove 1/ })).toBeTruthy(),
    );
    expect((screen.getByLabelText("Select a virtualenv") as HTMLInputElement).checked).toBe(true);
  });
});

/// #431: the virtualenv rows showed a size and no date, so "is this old
/// enough to remove" had no answer on screen. The idle time was already
/// being fetched -- it drove the stale badge -- and never displayed.
describe("age on a virtualenv row", () => {
  it("shows how long ago the virtualenv was last written", () => {
    state.venvs = [venv()];
    state.idle = new Map([
      ["/cache/mls-delivery-service-AAAAAAAA-py3.13", 60 * 60 * 24 * 270],
    ]);
    render(<VenvSection />);
    expect(screen.getByText("9 months ago")).toBeTruthy();
  });

  /// Unknown must not read as brand new -- that would hide exactly the
  /// venvs worth removing. Same rule the size column follows.
  it("does not claim an unmeasured virtualenv was written just now", () => {
    state.venvs = [venv()];
    state.idle = new Map();
    render(<VenvSection />);
    expect(screen.queryByText("just now")).toBeNull();
  });
});

/// #431: the section rendered NOTHING for the 9-40 seconds the scan
/// takes on a real machine, which is indistinguishable from having no
/// virtualenvs -- and is exactly how it was reported.
describe("while the scan is running", () => {
  it("says it is looking, rather than rendering nothing", () => {
    state.venvs = [];
    state.loading = true;
    const { container } = render(<VenvSection />);
    expect(screen.getByText(/looking for poetry virtualenvs/i)).toBeTruthy();
    expect(container.textContent).not.toBe("");
  });

  /// Once the scan has ANSWERED, an empty list really does mean none --
  /// and then saying nothing is right.
  it("renders nothing once an empty result is known", () => {
    state.venvs = [];
    state.loading = false;
    const { container } = render(<VenvSection />);
    expect(container.textContent).toBe("");
  });

  it("shows the rows once they arrive", () => {
    state.venvs = [venv()];
    state.loading = false;
    render(<VenvSection />);
    expect(screen.getByText("mls-delivery-service")).toBeTruthy();
    expect(screen.queryByText(/looking for poetry/i)).toBeNull();
  });
});
