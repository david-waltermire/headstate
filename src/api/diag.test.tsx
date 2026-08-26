import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useReviewingDiag, timed } from "./diag";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const lines = () =>
  vi.mocked(invoke).mock.calls.map((c) => (c[1] as { line: string }).line);

beforeEach(() => vi.mocked(invoke).mockClear());

/// These assert the diagnostics REACH the log, not merely that they
/// compile. The whole point of the release is a log the user collects on
/// another machine; a hook that silently logs nothing would look
/// identical here and be worthless there.
describe("diagnostic logging", () => {
  it("reports the query state that distinguishes disabled from empty", () => {
    renderHook(() =>
      useReviewingDiag({ enabled: false, status: "pending", fetchStatus: "idle", count: undefined }),
    );
    expect(lines()).toEqual(["reviewing state enabled=false status=pending fetch=idle n=-"]);
  });

  it("logs once per state CHANGE, not once per render", () => {
    const props = { enabled: true, status: "success", fetchStatus: "idle", count: 3 };
    const { rerender } = renderHook((p) => useReviewingDiag(p), { initialProps: props });
    rerender({ ...props });
    expect(lines()).toHaveLength(1);
    rerender({ ...props, count: 4 });
    expect(lines()).toHaveLength(2);
  });

  it("times a successful query and reports its item count", async () => {
    await timed("reviewing", () => Promise.resolve([1, 2]))();
    expect(lines()[0]).toBe("query reviewing start");
    expect(lines()[1]).toMatch(/^query reviewing ok \d+ms n=2$/);
  });

  it("rethrows a failure, and logs no part of the error message", async () => {
    const boom = new Error("secret-org/secret-repo exploded");
    await expect(timed("reviewing", () => Promise.reject(boom))()).rejects.toBe(boom);
    expect(lines()[1]).toMatch(/^query reviewing failed \d+ms$/);
    expect(lines().join("\n")).not.toContain("secret");
  });
});
