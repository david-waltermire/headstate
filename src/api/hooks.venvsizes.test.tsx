import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Venv } from "@/types/pr";

const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>((cmd, args) => {
    if (cmd === "size_venvs") {
      const paths = (args as { paths: string[] }).paths;
      return Promise.resolve(paths.map((p) => [p, 1024, 60]));
    }
    return Promise.resolve([]);
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useVenvSizes } from "./hooks";

const venvs = (n: number): Venv[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/cache/p${i}-AAAAAAAA-py3.13` }) as Venv);

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

/// #421: sizing was ONE query over every virtualenv, so a pass measured
/// at up to 73 seconds was a single silent wait — and one unreadable
/// path stalled every other row behind it.
describe("useVenvSizes chunking", () => {
  beforeEach(() => invoke.mockClear());

  it("splits the work into several requests rather than one", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVenvSizes(venvs(9), true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.sizes.size).toBe(9));

    const calls = invoke.mock.calls.filter((c) => c[0] === "size_venvs");
    expect(calls.length).toBeGreaterThan(1);
    // Every venv is still measured exactly once, across the chunks.
    const measured = calls.flatMap((c) => (c[1] as { paths: string[] }).paths);
    expect(new Set(measured).size).toBe(9);
  });

  /// The pair is what makes a partially-filled page legible instead of
  /// looking stuck.
  it("reports how many chunks have answered", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVenvSizes(venvs(9), true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.total).toBeGreaterThan(1));
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(result.current.measuring).toBe(false);
  });

  /// One failing chunk must not cost the others their sizes — the whole
  /// point of splitting the work.
  it("keeps the sizes from chunks that succeeded", async () => {
    let call = 0;
    invoke.mockImplementation((cmd, args) => {
      if (cmd !== "size_venvs") return Promise.resolve([]);
      call += 1;
      if (call === 1) return Promise.reject(new Error("permission denied"));
      const paths = (args as { paths: string[] }).paths;
      return Promise.resolve(paths.map((p) => [p, 2048, 30]));
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVenvSizes(venvs(8), true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.pending).toBe(0));
    // The surviving chunk's sizes are present, not lost with the failure.
    expect(result.current.sizes.size).toBeGreaterThan(0);
    expect(result.current.sizes.size).toBeLessThan(8);
  });

  /// Keyed on the chunk's OWN paths, not its position.
  ///
  /// With an index, removing a virtualenv shifts every later chunk into
  /// a key that already holds a DIFFERENT set's results -- so rows show
  /// sizes belonging to other directories. The same trap
  /// `artifact-sizes` hit with `paths.length` in the key.
  it("does not serve one chunk's sizes under another chunk's key", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderHook(() => useVenvSizes(venvs(8), true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.sizes.size).toBe(8));

    // A DIFFERENT set of the same shape. If the key were positional
    // these would hit the first set's cache and report its paths.
    const other: Venv[] = Array.from(
      { length: 8 },
      (_, i) => ({ path: `/cache/other${i}-BBBBBBBB-py3.13` }) as Venv,
    );
    const second = renderHook(() => useVenvSizes(other, true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(second.result.current.sizes.size).toBe(8));

    for (const p of second.result.current.sizes.keys()) {
      expect(p).toContain("other");
    }
  });

  /// `pending` must fall as chunks answer, or the count it feeds is
  /// decoration rather than progress.
  it("counts down as chunks answer", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "size_venvs") return [];
      call += 1;
      // Hold the FIRST chunk open; let the rest resolve.
      if (call === 1) await gate;
      return (args as { paths: string[] }).paths.map((p) => [p, 1024, 60]);
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVenvSizes(venvs(8), true), {
      wrapper: wrapper(qc),
    });

    // One chunk still outstanding while the other has answered.
    await waitFor(() => expect(result.current.sizes.size).toBeGreaterThan(0));
    expect(result.current.pending).toBeGreaterThan(0);
    expect(result.current.pending).toBeLessThan(result.current.total);

    release?.();
    await waitFor(() => expect(result.current.pending).toBe(0));
  });

  it("asks for nothing when there are no virtualenvs", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useVenvSizes([], true), { wrapper: wrapper(qc) });
    expect(invoke.mock.calls.filter((c) => c[0] === "size_venvs")).toHaveLength(0);
  });
});
