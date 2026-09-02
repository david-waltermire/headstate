import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/types/pr";

const state = vi.hoisted(() => ({
  artifacts: [] as Artifact[],
  loading: false,
  venvs: [] as unknown[],
  sizes: new Map<string, number>(),
  ages: new Map<string, number>(),
  pending: 0,
  total: 0,
}));

const removeFn = vi.hoisted(() => vi.fn(() => Promise.resolve([])));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../api/hooks", () => ({
  useRemoveArtifacts: () => removeFn,
  // The page renders VenvSection, which has its own hooks. Stubbed to
  // empty here rather than exercised: that component has its own test
  // file, and duplicating its fixtures would make both harder to change.
  useVenvs: () => ({ data: state.venvs ?? [] }),
  useVenvSizes: () => ({ sizes: new Map(), idle: new Map(), measuring: false }),
  useRemoveVenvs: () => vi.fn(),
  // The page renders CleanupLog on "Everything"; it has its own test
  // file, so this is stubbed empty rather than exercised here.
  useCleanupLog: () => ({ entries: [], isLoading: false, run: () => Promise.resolve([]) }),
  useArtifacts: () => ({ data: state.artifacts, isLoading: state.loading }),
  useArtifactSizes: () => ({
    sizes: state.sizes,
    ages: state.ages,
    pending: state.pending,
    total: state.total,
  }),
}));

import { ArtifactsPage } from "./ArtifactsPage";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  path: "/code/repo/target",
  kind: "cargo_target",
  repo_path: "/code/repo",
  size_bytes: null,
  modified_secs_ago: null,
  ...over,
});

describe("ArtifactsPage", () => {
  it("says so when there is nothing to show", () => {
    state.artifacts = [];
    render(<ArtifactsPage />);
    expect(screen.getByText(/No build output found/)).toBeTruthy();
  });

  /// Every row names what puts it back. "You can delete this" is only
  /// actionable next to the command that restores it, and that pairing
  /// is the whole safety argument for the view.
  it("names the command that regenerates each kind", () => {
    state.artifacts = [
      art(),
      art({ path: "/code/repo/node_modules", kind: "node_modules" }),
      art({ path: "/code/repo/.terraform", kind: "terraform" }),
    ];
    render(<ArtifactsPage />);
    expect(screen.getByText("cargo build")).toBeTruthy();
    expect(screen.getByText("npm install")).toBeTruthy();
    expect(screen.getByText("terraform init")).toBeTruthy();
  });

  /// The total is over a PARTIAL set until every batch answers, and
  /// claiming a finished number while measurement runs is the kind of
  /// quiet wrongness that makes a figure untrustworthy everywhere else.
  it("says the total is a lower bound while measuring", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000_000_000]]);
    state.pending = 2;
    state.total = 5;
    render(<ArtifactsPage />);
    expect(screen.getByText(/at least/)).toBeTruthy();
    expect(screen.getByText(/measuring — 3 of 5/)).toBeTruthy();
  });

  it("drops the lower-bound wording once every batch has answered", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000_000_000]]);
    state.pending = 0;
    state.total = 5;
    render(<ArtifactsPage />);
    expect(screen.queryByText(/at least/)).toBeNull();
    expect(screen.queryByText(/measuring/)).toBeNull();
  });

  /// A build writing into a directory does not show up in `git status`,
  /// because build output is gitignored. The mtime is the only signal
  /// there is, so it must be surfaced rather than folded away.
  it("flags a directory that was written to recently", () => {
    state.artifacts = [art()];
    state.ages = new Map([["/code/repo/target", 60]]);
    state.sizes = new Map();
    state.pending = 0;
    render(<ArtifactsPage />);
    expect(screen.getByText("written recently")).toBeTruthy();
  });

  /// The reported gap: the list showed paths and sizes but never WHEN.
  /// Size cannot rank these -- every node_modules is ~1.4 GB -- so age
  /// is the only thing that says which are safe to remove.
  it("shows how long ago each directory was written", () => {
    state.artifacts = [art()];
    state.ages = new Map([["/code/repo/target", 60 * 60 * 24 * 270]]);
    state.sizes = new Map([["/code/repo/target", 1_400_000_000]]);
    state.pending = 0;
    render(<ArtifactsPage />);
    expect(screen.getByText("9 months ago")).toBeTruthy();
  });

  /// An unknown age must render a placeholder, never "just now" -- the
  /// same rule the size column follows for "not measured yet". Reading
  /// unknown as brand-new would hide the oldest directories.
  it("does not claim an unmeasured directory was written just now", () => {
    state.artifacts = [art()];
    state.ages = new Map();
    state.sizes = new Map();
    state.pending = 1;
    render(<ArtifactsPage />);
    expect(screen.queryByText("just now")).toBeNull();
  });

  it("can sort by age, oldest first", () => {
    const old = { ...art(), path: "/code/repo/old" };
    const fresh = { ...art(), path: "/code/repo/fresh" };
    state.artifacts = [fresh, old];
    state.ages = new Map([
      ["/code/repo/fresh", 60 * 60 * 24],
      ["/code/repo/old", 60 * 60 * 24 * 300],
    ]);
    // Equal sizes, so only the age ordering can produce a difference --
    // which is the real case this exists for.
    state.sizes = new Map([
      ["/code/repo/fresh", 1_400_000_000],
      ["/code/repo/old", 1_400_000_000],
    ]);
    state.pending = 0;
    render(<ArtifactsPage />);
    fireEvent.change(screen.getByLabelText("Sort artifacts"), {
      target: { value: "age" },
    });
    const shown = screen.getAllByText(/\/code\/repo\/(old|fresh)/);
    expect(shown[0].textContent).toContain("/code/repo/old");
  });

  it("does not flag a directory nobody has touched", () => {
    state.artifacts = [art()];
    state.ages = new Map([["/code/repo/target", 60 * 60 * 24 * 30]]);
    render(<ArtifactsPage />);
    expect(screen.queryByText("written recently")).toBeNull();
  });

  /// An unmeasured row must render a PLACEHOLDER, never "0 B".
  ///
  /// This is the half a sort test cannot catch: zero and unmeasured
  /// order identically at the bottom, so only the rendered cell
  /// distinguishes them. Showing 0 B for a directory nobody has measured
  /// is a number the user would act on -- and the 61 GB target on the
  /// machine that prompted this feature reads 0 B for its first minute.
  it("shows a placeholder, not 0 B, for an unmeasured row", () => {
    state.artifacts = [art({ path: "/code/a/target" })];
    state.sizes = new Map();
    state.ages = new Map();
    state.pending = 1;
    state.total = 1;
    const { container } = render(<ArtifactsPage />);
    expect(screen.queryByText("0 B")).toBeNull();
    expect(container.querySelector(".animate-pulse, [class*=animate-pulse]")).toBeTruthy();
  });

  /// Ordering, which is the other half. Note a zero-sort produces the
  /// SAME order as sorting unmeasured last -- zero is the minimum, so
  /// both land at the bottom. The rendered placeholder above is what
  /// actually separates the two; this pins that the largest measured
  /// directory leads, which is the view's whole point.
  it("sorts unmeasured rows last rather than as zero", () => {
    // Three rows, and the UNMEASURED one sorts alphabetically FIRST.
    // With only two rows a zero-sort produces the same order by
    // accident, so this needs a measured row on each side of it to
    // distinguish "last" from "as zero".
    state.artifacts = [
      art({ path: "/code/a-unmeasured/target" }),
      art({ path: "/code/b-small/target" }),
      art({ path: "/code/c-large/target" }),
    ];
    state.sizes = new Map([
      ["/code/b-small/target", 1_000_000],
      ["/code/c-large/target", 9_000_000_000],
    ]);
    state.ages = new Map();
    state.pending = 0;
    render(<ArtifactsPage />);

    const paths = screen
      .getAllByText(/\/code\/[abc][^/]*\/target/)
      .map((el) => el.textContent);
    expect(paths).toEqual([
      "/code/c-large/target",
      "/code/b-small/target",
      "/code/a-unmeasured/target",
    ]);
  });
});

describe("ArtifactsPage removal", () => {
  beforeEach(() => {
    removeFn.mockClear();
    state.ages = new Map();
    state.pending = 0;
  });
  /// Nothing is offered until something is chosen: a destructive action
  /// that is always on screen is one click from being an accident.
  it("offers no removal until a row is selected", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000]]);
    state.ages = new Map();
    state.pending = 0;
    render(<ArtifactsPage />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("names the count and the size before the dialog", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 2_000_000_000]]);
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select \/code\/repo\/target/ }));
    expect(screen.getByRole("button", { name: /^Remove 1 ·/ })).toBeTruthy();
  });

  /// The dialog states the loss in the terms that matter. For build
  /// output the honest answer is that the cost is TIME, which is exactly
  /// what separates this from removing a worktree.
  it("says the cost is a rebuild, not lost work", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000]]);
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    expect(screen.getByText(/not lost work/)).toBeTruthy();
  });

  /// A directory a build is writing to will be refused by the backend.
  /// Saying so BEFORE the click is the difference between a guard the
  /// user understands and one that looks like a malfunction.
  it("warns when a selected directory was written to recently", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000]]);
    state.ages = new Map([["/code/repo/target", 30]]);
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    expect(screen.getByText(/may have a build running/)).toBeTruthy();
  });

  it("removes the selected paths on confirm", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000]]);
    state.ages = new Map();
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeFn).toHaveBeenCalledWith(["/code/repo/target"]);
  });

  it("removes nothing on cancel", () => {
    state.artifacts = [art()];
    state.sizes = new Map([["/code/repo/target", 1_000]]);
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeFn).not.toHaveBeenCalled();
  });

  /// With 178 rows an unnamed checkbox is 178 identical controls to a
  /// screen reader.
  it("names each checkbox by its path", () => {
    state.artifacts = [art({ path: "/code/a/target" }), art({ path: "/code/b/target" })];
    render(<ArtifactsPage />);
    expect(screen.getByRole("checkbox", { name: "Select /code/a/target" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select /code/b/target" })).toBeTruthy();
  });
});

describe("ArtifactsPage bulk removal and grouping", () => {
  /// The bulk button must EXCLUDE anything a build may be writing to.
  /// Those are refused at delete time anyway, so including them would
  /// only produce a failure report nobody asked for -- and the count in
  /// the label would promise more than the click delivers.
  it("leaves recently-written directories out of the bulk selection", () => {
    state.artifacts = [
      art({ path: "/code/a/target" }),
      art({ path: "/code/b/target" }),
      art({ path: "/code/busy/target" }),
    ];
    state.sizes = new Map();
    state.ages = new Map([["/code/busy/target", 30]]);
    state.pending = 0;
    render(<ArtifactsPage />);

    fireEvent.click(screen.getByRole("button", { name: /Remove all 2/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeFn).toHaveBeenCalledWith(["/code/a/target", "/code/b/target"]);
  });

  it("does not offer bulk removal for a single directory", () => {
    state.artifacts = [art()];
    state.ages = new Map();
    render(<ArtifactsPage />);
    expect(screen.queryByRole("button", { name: /Remove all/ })).toBeNull();
  });
});
