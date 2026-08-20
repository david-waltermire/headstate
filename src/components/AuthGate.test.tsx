import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { AuthGate } from "./AuthGate";

afterEach(() => {
  // See src/api/hooks.test.tsx: unmount before clearing the mocked Tauri
  // IPC internals so effect cleanup doesn't call a deleted unlisten fn.
  cleanup();
  clearMocks();
});

function renderGated(authState: { ok: boolean; message: string }) {
  mockIPC((cmd) => {
    if (cmd === "get_auth_state") return authState;
    return undefined;
  }, { shouldMockEvents: true });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthGate>
        <div>protected content</div>
      </AuthGate>
    </QueryClientProvider>,
  );
}

describe("AuthGate", () => {
  it("renders children once authenticated", async () => {
    renderGated({ ok: true, message: "" });
    expect(await screen.findByText("protected content")).toBeTruthy();
  });

  it("shows the gh CLI install screen when not authenticated", async () => {
    renderGated({
      ok: false,
      message: "gh auth status: not logged in to github.com",
    });

    expect(await screen.findByText("Headstate needs the GitHub CLI")).toBeTruthy();
    expect(
      screen.getByText("gh auth status: not logged in to github.com"),
    ).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName === "PRE" && !!el.textContent?.includes("gh auth login")),
    ).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("surfaces a poll-error banner above authenticated content", async () => {
    renderGated({ ok: true, message: "" });
    await screen.findByText("protected content");

    await emit("poll-error", "GitHub API rate limit exceeded");

    await waitFor(() => {
      expect(
        screen.getByText(/Background refresh failed: GitHub API rate limit exceeded/),
      ).toBeTruthy();
    });
    // Content stays mounted -- a poll failure is not a reason to hide the
    // last-known-good cached data.
    expect(screen.getByText("protected content")).toBeTruthy();
  });
});
