import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pollError = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../api/tauri", () => ({
  getAuthState: () => Promise.resolve({ ok: true, message: "" }),
}));

vi.mock("../api/hooks", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePollError: () => pollError.current,
}));

import { AuthGate } from "./AuthGate";

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthGate>
        <div>content</div>
      </AuthGate>
    </QueryClientProvider>,
  );
}

describe("expired-token guidance", () => {
  // The token is read once at startup, so a revoked one 401s forever with
  // the list silently going stale and no path back to the setup screen.
  it("tells the user what to do about a 401", async () => {
    pollError.current = "GitHub request failed: 401 Unauthorized";
    renderGate();
    expect(await screen.findByText(/token may have expired/i)).toBeTruthy();
    expect(screen.getByText(/gh auth login/)).toBeTruthy();
  });

  // A network blip is not an auth problem, and must not send the user off
  // to re-authenticate for no reason.
  it("does not blame the token for an unrelated failure", async () => {
    pollError.current = "GitHub request timed out after 90s";
    renderGate();
    expect(await screen.findByText(/timed out/i)).toBeTruthy();
    expect(screen.queryByText(/token may have expired/i)).toBeNull();
  });
});
