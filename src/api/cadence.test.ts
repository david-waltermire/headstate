import { describe, expect, it, vi } from "vitest";

const setNeeds = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./tauri", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  setViewNeedsGithub: setNeeds,
}));

const { useViewCadence } = await import("./hooks");
const { renderHook } = await import("@testing-library/react");

describe("useViewCadence", () => {
  it("tells the loop a PR view needs live data", () => {
    setNeeds.mockClear();
    renderHook(() => useViewCadence("my-prs"));
    expect(setNeeds).toHaveBeenCalledWith(true);
  });

  it("tells the loop the worktrees view does not", () => {
    setNeeds.mockClear();
    renderHook(() => useViewCadence("worktrees"));
    expect(setNeeds).toHaveBeenCalledWith(false);
  });

  it("treats the review view as needing live data", () => {
    setNeeds.mockClear();
    renderHook(() => useViewCadence("to-review"));
    expect(setNeeds).toHaveBeenCalledWith(true);
  });

  // Cadence is an optimisation; failing to set it must never break the
  // page, matching how the event listeners tolerate a missing host.
  it("survives a host without the command", () => {
    setNeeds.mockClear();
    setNeeds.mockImplementationOnce(() => Promise.reject(new Error("no such command")));
    expect(() => renderHook(() => useViewCadence("my-prs"))).not.toThrow();
  });
});
