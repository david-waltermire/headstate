import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerImage, DockerState } from "@/types/pr";

const state = vi.hoisted(() => ({
  docker: { kind: "running" } as DockerState,
  images: [] as DockerImage[],
  imagesFailed: false,
  diskFailed: false,
  volumes: [] as { name: string; size_bytes: number }[],
}));

type Outcome = { id: string; error: string | null };
const removeImagesFn = vi.hoisted(() =>
  vi.fn<(ids: string[]) => Promise<Outcome[]>>((ids) =>
    Promise.resolve(ids.map((id) => ({ id, error: null }))),
  ),
);
const pruneFn = vi.hoisted(() => vi.fn(() => Promise.resolve(4_654_000_000)));
const removeVolumeFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../api/hooks", () => ({
  useDockerState: () => ({ data: state.docker }),
  useDockerImages: () => ({
    data: state.images,
    isLoading: false,
    isError: state.imagesFailed,
    error: "permission denied while trying to connect to the Docker daemon socket",
    refetch: vi.fn(),
  }),
  useDockerDiskUsage: () => ({
    isError: state.diskFailed,
    data: {
      images_bytes: 17_350_000_000,
      images_reclaimable_bytes: 2_194_000_000,
      build_cache_bytes: 4_654_000_000,
      volumes_bytes: 4_735_000_000,
      volumes_reclaimable_bytes: 4_735_000_000,
    },
  }),
  useDockerVolumes: () => ({ data: state.volumes }),
  useRemoveImages: () => removeImagesFn,
  useRemoveVolume: () => removeVolumeFn,
  usePruneCache: () => pruneFn,
}));

const restartFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const startFn = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const containersFn = vi.hoisted(() => vi.fn(() => Promise.resolve<string[]>([])));
vi.mock("../api/tauri", () => ({
  dockerRestart: restartFn,
  dockerStart: startFn,
  dockerRunningContainers: containersFn,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { DockerPage } from "./DockerPage";

const img = (over: Partial<DockerImage> = {}): DockerImage => ({
  id: "abc123",
  repository: "registry/app",
  tags: ["13901886"],
  created: "2026-08-21T21:39:15-04:00",
  size_bytes: 1_330_000_000,
  origin: {
    repo_path: "/code/app",
    context: null,
    commit: "13901886",
    subject: "add retry to the client",
    merged: true,
    source: "tag_resolution",
  },
  in_use: false,
  superseded: true,
  ...over,
});

beforeEach(() => {
  state.docker = { kind: "running" };
  state.images = [];
  state.imagesFailed = false;
  state.diskFailed = false;
  state.volumes = [];
  removeImagesFn.mockClear();
  pruneFn.mockClear();
  removeVolumeFn.mockClear();
  restartFn.mockClear();
  containersFn.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("DockerPage", () => {
  // Docker being off is NORMAL, unlike git. An empty image list would
  // say "your machine is clean" when the truth is we could not ask --
  // the distinction #190 and #191 established for polling.
  it("says Docker is not running rather than showing an empty list", () => {
    state.docker = { kind: "not_running" };
    render(<DockerPage />);
    expect(screen.getByText(/docker is not running/i)).toBeTruthy();
    expect(screen.queryByText(/no images/i)).toBeNull();
    expect(screen.getByRole("button", { name: /start docker/i })).toBeTruthy();
  });

  // A missing binary is a different problem with a different fix, and
  // offering "Start Docker" for it would send the user in circles.
  it("distinguishes not-installed from not-running", () => {
    state.docker = { kind: "not_installed" };
    render(<DockerPage />);
    expect(screen.getByText(/was not found/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start docker/i })).toBeNull();
  });

  it("shows the commit subject, which is what makes a hex tag mean something", () => {
    state.images = [img()];
    render(<DockerPage />);
    expect(screen.getByText(/add retry to the client/)).toBeTruthy();
  });

  // An image a container holds must never be offered: docker rmi would
  // refuse it anyway, and offering-then-failing is worse than not
  // offering.
  it("never offers to remove an image in use", () => {
    state.images = [img({ in_use: true })];
    render(<DockerPage />);
    const btn = screen.getByRole("button", { name: /^remove$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("offers bulk removal only for provably dead images", () => {
    state.images = [
      img({ id: "dead1" }),
      img({ id: "dead2" }),
      // Superseded but its branch is still open -- may still be wanted.
      img({ id: "live", origin: { ...img().origin!, merged: false } }),
      img({ id: "current", superseded: false }),
    ];
    render(<DockerPage />);
    expect(screen.getByRole("button", { name: /remove 2 stale images/i })).toBeTruthy();
  });

  /// The reported gap: "just showing the hash makes it hard to tell
  /// what it is from and if I should remove it". An untagged image is
  /// exactly the one that cannot be identified, and it is what
  /// accumulates from repeated rebuilds.
  it("names an untagged image by its repository, not a bare hash", () => {
    state.images = [img({ tags: [], repository: "registry/app", id: "deadbeef1234" })];
    render(<DockerPage />);
    expect(screen.getByText(/registry\/app@deadbeef1234/)).toBeTruthy();
  });

  it("shows the full identity and provenance when a row is expanded", () => {
    state.images = [
      img({ tags: [], id: "deadbeef1234", repository: "registry/app" }),
    ];
    render(<DockerPage />);
    // Collapsed: the long fields are absent, so the row stays one line.
    expect(screen.queryByText("Built from")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Image ID")).toBeTruthy();
    expect(screen.getByText("Built from")).toBeTruthy();
    // The commit line, which only the expanded detail renders.
    expect(screen.getByText(/13901886 — add retry to the client/)).toBeTruthy();
  });

  /// "unknown" alone reads as a missing feature. Saying WHY there is
  /// nothing to show is the difference between a gap and a fact.
  it("explains why an unattributed image has no provenance", () => {
    state.images = [img({ origin: null })];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/could not be traced to a commit/i)).toBeTruthy();
  });

  /// The reported gap: "there needs to be a button to remove all
  /// superseded images". One existed, but it required the branch to
  /// have MERGED, so on a real machine it under-counted badly -- most
  /// superseded images have no branch attribution at all.
  /// Measured on a real machine: 18 stale against 19 superseded. Two
  /// buttons one apart in count, doing near-identical things, is why
  /// this was reported as "missing" -- it rendered and was invisible.
  /// One entry point now, with the wider set as an opt-in.
  it("offers the wider set inside the confirmation, not as a second button", () => {
    state.images = [
      img({ id: "dead" }),
      img({ id: "unattributed", origin: null }),
      img({ id: "live", origin: { ...img().origin!, merged: false } }),
    ];
    render(<DockerPage />);
    // No competing button on the page.
    expect(screen.queryByRole("button", { name: /remove all .* superseded/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /remove 1 stale image/i }));
    const dialog = screen.getByRole("dialog");
    // The opt-in names the DIFFERENCE, so the choice has a reason.
    expect(within(dialog).getByText(/Also remove 2 superseded images/i)).toBeTruthy();
  });

  it("stays with the conservative set unless the opt-in is ticked", async () => {
    state.images = [
      img({ id: "dead" }),
      img({ id: "unattributed", origin: null }),
      img({ id: "held", in_use: null }),
    ];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 1 stale image/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /remove 1 image/i }));
    await waitFor(() => expect(removeImagesFn).toHaveBeenCalled());
    expect(removeImagesFn.mock.calls[0][0]).toEqual(["dead"]);
  });

  it("widens the removal when the opt-in is ticked", async () => {
    state.images = [
      img({ id: "dead" }),
      img({ id: "unattributed", origin: null }),
      // `in_use: null` means "we could not ask" and is excluded from
      // BOTH sets, ticked or not.
      img({ id: "held", in_use: null }),
    ];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 1 stale image/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: /remove 2 images/i }));
    await waitFor(() => expect(removeImagesFn).toHaveBeenCalled());
    expect(removeImagesFn.mock.calls[0][0]).toEqual(["dead", "unattributed"]);
  });

  /// Silence when the wide set adds nothing -- an opt-in that widens by
  /// zero is a checkbox that does nothing.
  it("hides the opt-in when it would cover no more", () => {
    state.images = [img({ id: "dead1" }), img({ id: "dead2" })];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 2 stale images/i }));
    expect(within(screen.getByRole("dialog")).queryByRole("checkbox")).toBeNull();
  });

  it("lists every image in the bulk confirmation, not just a count", () => {
    state.images = [img({ id: "a", tags: ["aaa1111"] }), img({ id: "b", tags: ["bbb2222"] })];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 2 stale images/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/aaa1111/)).toBeTruthy();
    expect(within(dialog).getByText(/bbb2222/)).toBeTruthy();
    expect(removeImagesFn).not.toHaveBeenCalled();
  });

  it("submits only the stale images", async () => {
    state.images = [
      img({ id: "dead" }),
      img({ id: "live", origin: { ...img().origin!, merged: false } }),
      img({ id: "held", in_use: true }),
    ];
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 1 stale image/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /remove 1 image/i }),
    );
    await waitFor(() => expect(removeImagesFn).toHaveBeenCalled());
    expect(removeImagesFn.mock.calls[0][0]).toEqual(["dead"]);
  });

  // Partial failure is normal: docker rmi refuses an image whose layers
  // another image depends on.
  it("reports partial failure rather than a bare success", async () => {
    state.images = [img({ id: "a" }), img({ id: "b" })];
    removeImagesFn.mockResolvedValueOnce([
      { id: "a", error: null },
      { id: "b", error: "image is being used by stopped container xyz" },
    ]);
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /remove 2 stale images/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /remove 2 images/i }),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect((toastError.mock.calls[0] as [string])[0]).toMatch(/1 of 2/);
  });

  // Restarting kills every running container, and the user may have a
  // database up they would otherwise notice the hard way.
  it("names the containers a restart would stop", async () => {
    containersFn.mockResolvedValueOnce(["postgres-dev", "redis-dev"]);
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /restart docker/i }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/postgres-dev, redis-dev/)).toBeTruthy();
    expect(restartFn).not.toHaveBeenCalled();
  });

  it("restarts only after confirmation", async () => {
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /restart docker/i }));
    await screen.findByRole("dialog");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^restart$/i }),
    );
    await waitFor(() => expect(restartFn).toHaveBeenCalled());
  });

  // Images are only part of the waste: on a real machine 17.35GB of
  // images sat beside 4.65GB of cache and a 4.74GB volume.
  it("surfaces build cache and volumes, not only images", () => {
    render(<DockerPage />);
    expect(screen.getByText(/build cache/i)).toBeTruthy();
    expect(screen.getByText(/volumes/i)).toBeTruthy();
  });

  it("reports what a prune actually freed", async () => {
    render(<DockerPage />);
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect((toastSuccess.mock.calls[0] as [string])[0]).toMatch(/4\.7 GB|4\.65 GB/);
  });

  // On a disk-cleanup tool, "No images." reads as "your machine is
  // clean" when the truth is "we could not ask".
  it("reports a failed listing rather than an empty one", () => {
    state.imagesFailed = true;
    render(<DockerPage />);
    expect(screen.queryByText(/no images/i)).toBeNull();
    expect(screen.getByText(/could not read docker images/i)).toBeTruthy();
    expect(screen.getByText(/permission denied/i)).toBeTruthy();
  });

  // The panel leads the page and is the argument for the feature
  // existing; vanishing silently is a wrong answer by omission.
  it("says so when disk usage cannot be read, rather than vanishing", () => {
    state.diskFailed = true;
    render(<DockerPage />);
    expect(screen.getByText(/could not read docker disk usage/i)).toBeTruthy();
  });

  // A failed `docker ps` used to read as "nothing is in use", un-gating
  // removal on images a running container holds.
  it("refuses removal when it cannot tell whether an image is in use", () => {
    state.images = [img({ in_use: null })];
    render(<DockerPage />);
    const btn = screen.getByRole("button", { name: /^remove$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/cannot tell if it is in use/i)).toBeTruthy();
  });

  it("keeps an unknown-use image out of the bulk set", () => {
    state.images = [img({ id: "known", in_use: false }), img({ id: "unknown", in_use: null })];
    render(<DockerPage />);
    expect(screen.getByRole("button", { name: /remove 1 stale image/i })).toBeTruthy();
  });

  // Unknown carries the real message and used to be rendered as "not
  // running" with a Start button that cannot help.
  it("shows the real reason when Docker cannot be reached", () => {
    state.docker = {
      kind: "unknown",
      detail: "permission denied while trying to connect to the Docker daemon socket",
    } as DockerState;
    render(<DockerPage />);
    expect(screen.getByText(/could not talk to docker/i)).toBeTruthy();
    expect(screen.getByText(/permission denied/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start docker/i })).toBeNull();
  });

  // The actionable remedy for the most common Linux Docker failure.
  it("names the docker group fix for a permission error", () => {
    state.docker = {
      kind: "unknown",
      detail: "permission denied while trying to connect to the Docker daemon socket",
    } as DockerState;
    render(<DockerPage />);
    expect(screen.getByText(/usermod -aG docker/)).toBeTruthy();
  });
});
