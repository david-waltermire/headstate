import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerBuild, DockerImage } from "@/types/pr";

const state = vi.hoisted(() => ({
  dockerState: { kind: "running" } as { kind: string },
  builds: [] as DockerBuild[],
  detail: null as DockerBuild | null,
  images: [] as DockerImage[],
}));

vi.mock("../api/hooks", () => ({
  useDockerState: () => ({ data: state.dockerState }),
  useDockerBuilds: () => ({ data: state.builds, isLoading: false, isError: false }),
  useDockerBuildDetail: () => ({ data: state.detail }),
  useDockerImages: () => ({ data: state.images, isLoading: false }),
}));

import { DockerBuildsPage } from "./DockerBuilds";

const build = (over: Partial<DockerBuild> = {}): DockerBuild => ({
  reference: "ns/ns/abc123",
  name: "octocat-api/docker",
  status: "Completed",
  started: "2026-08-22T01:38:49Z",
  duration_secs: 56.9,
  total_steps: 43,
  cached_steps: 21,
  context: null,
  revision: null,
  ...over,
});

beforeEach(() => {
  state.dockerState = { kind: "running" };
  state.builds = [];
  state.detail = null;
  state.images = [];
});

describe("DockerBuildsPage", () => {
  // Duration alone says "slow"; with the cache ratio it says why. Real
  // data: the same target at 48% cached took 56.9s, at 23% took 80.7s.
  it("shows the cache ratio beside the duration", () => {
    state.builds = [build()];
    render(<DockerBuildsPage />);
    expect(screen.getByText("48% cached")).toBeTruthy();
    // Whole seconds above ten: a tenth of a second is noise at that
    // scale, and the column stays narrow.
    expect(screen.getByText("57s")).toBeTruthy();
  });

  // A fully cached target finishes in 0.4s. Rounding that to "0s" would
  // hide the difference between cached and instant.
  it("keeps sub-second builds legible", () => {
    state.builds = [build({ duration_secs: 0.45 })];
    render(<DockerBuildsPage />);
    expect(screen.getByText("0.5s")).toBeTruthy();
  });

  it("formats a multi-minute build in minutes", () => {
    state.builds = [build({ duration_secs: 428 })];
    render(<DockerBuildsPage />);
    expect(screen.getByText("7m 8s")).toBeTruthy();
  });

  // Failures are as interesting as successes -- arguably more, since a
  // failing build is usually what the user came to investigate.
  it("keeps failed builds and marks them", () => {
    state.builds = [build({ status: "Error", reference: "ns/ns/failed" }), build()];
    render(<DockerBuildsPage />);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  // The grouping Docker Desktop's Builds page lacks: it shows durations
  // but never connects a build to its images.
  it("shows the images a build produced", () => {
    state.builds = [build()];
    state.detail = build({ revision: "13901886abcdef", context: "/code/octocat-api" });
    state.images = [
      {
        id: "img1",
        repository: "registry/app",
        tags: ["13901886"],
        created: "",
        size_bytes: 1_330_000_000,
        origin: null,
        in_use: false,
        superseded: false,
      },
    ];
    render(<DockerBuildsPage />);
    fireEvent.click(screen.getByRole("button", { name: /octocat-api/ }));
    expect(screen.getByText(/registry\/app:13901886/)).toBeTruthy();
  });

  // For a worktree build the context IS the worktree -- the answer to
  // "which session produced this?".
  it("names the build context", () => {
    state.builds = [build()];
    state.detail = build({ context: "/code/octocat-api-feature", revision: "abc" });
    render(<DockerBuildsPage />);
    fireEvent.click(screen.getByRole("button", { name: /octocat-api/ }));
    expect(screen.getByText("/code/octocat-api-feature")).toBeTruthy();
  });

  // A normal end state, not an error: it usually means the cleanup
  // worked. Saying nothing would read as a failure to look.
  it("says so when a build's images are gone", () => {
    state.builds = [build()];
    state.detail = build({ revision: "deadbeef1234", context: "/code/x" });
    state.images = [];
    render(<DockerBuildsPage />);
    fireEvent.click(screen.getByRole("button", { name: /octocat-api/ }));
    expect(screen.getByText(/none still on disk/i)).toBeTruthy();
  });

  // History ages out, which is different from producing nothing.
  it("distinguishes aged-out history from a build that produced nothing", () => {
    state.builds = [build()];
    state.detail = build({ revision: null });
    render(<DockerBuildsPage />);
    fireEvent.click(screen.getByRole("button", { name: /octocat-api/ }));
    expect(screen.getByText(/no longer records/i)).toBeTruthy();
  });

  it("collapses the detail when the same build is clicked again", () => {
    state.builds = [build()];
    state.detail = build({ context: "/code/x", revision: "abc" });
    render(<DockerBuildsPage />);
    const row = screen.getByRole("button", { name: /octocat-api/ });
    fireEvent.click(row);
    expect(screen.getByText("/code/x")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /octocat-api/ })[0]);
    expect(screen.queryByText("/code/x")).toBeNull();
  });
});
