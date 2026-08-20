import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/// Regression tests for the v1.0.0 launch hang: the app showed the splash
/// forever on a machine where `gh` was not found.
///
/// `AuthGate` renders its error screen WITHOUT mounting `App`, and the
/// dismissal effect lived in `App` -- so the splash, a fixed inset-0
/// z-index-9999 overlay, hid a perfectly good "needs the GitHub CLI"
/// message indefinitely.

const authState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../api/tauri", () => ({
  getAuthState: () => authState.current as never,
  getCached: () => Promise.resolve([]),
  refreshNow: () => Promise.reject(new Error("no auth")),
  getStats: () => Promise.reject(new Error("no auth")),
  getHistory: () => Promise.reject(new Error("no auth")),
  getMergedDetail: () => Promise.reject(new Error("no auth")),
  getPeriods: () => Promise.reject(new Error("no auth")),
}));

vi.mock("../api/hooks", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePollError: () => null,
}));

import { AuthGate } from "./AuthGate";
import { initSplash } from "../splash";

function renderGate() {
  const splash = document.createElement("div");
  splash.id = "splash";
  document.body.appendChild(splash);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthGate>
        <div>app content</div>
      </AuthGate>
    </QueryClientProvider>,
  );
}

describe("splash dismissal", () => {
  beforeEach(() => {
    document.getElementById("splash")?.remove();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Re-arm inside the fake clock. Previously both the load timestamp and
    // the failsafe were captured at import time, so these tests had to
    // wait out ~18s of REAL time.
    initSplash(Date.now());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lifts the splash when auth FAILS, so the error screen is visible", async () => {
    authState.current = Promise.resolve({ ok: false, message: "gh not found" });
    renderGate();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Headstate needs the GitHub CLI"),
    );
    // Past the 3s floor plus the fade.
    await vi.advanceTimersByTimeAsync(3600);
    expect(document.getElementById("splash")).toBeNull();
  });

  it("lifts the splash when auth succeeds", async () => {
    authState.current = Promise.resolve({ ok: true, message: "" });
    renderGate();

    await waitFor(() => expect(document.body.textContent).toContain("app content"));
    await vi.advanceTimersByTimeAsync(3600);
    expect(document.getElementById("splash")).toBeNull();
  });

  // The failsafe: no code path may leave the overlay up forever.
  it("lifts the splash even if the auth check never settles", async () => {
    authState.current = new Promise(() => {});
    renderGate();

    await vi.advanceTimersByTimeAsync(11000);
    expect(document.getElementById("splash")).toBeNull();
  });
});
