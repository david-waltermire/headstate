import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/hooks", () => ({
  usePollError: () => null,
  useStoreError: () => null,
  clearPollError: vi.fn(),
}));
vi.mock("../splash", () => ({ dismissSplash: vi.fn() }));
vi.mock("../api/tauri", () => ({
  getAuthState: () =>
    Promise.resolve({ ok: false, message: "gh was not found in /usr/local/bin" }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthGate } from "./AuthGate";

afterEach(cleanup);

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthGate>
        <p>app</p>
      </AuthGate>
    </QueryClientProvider>,
  );
}

/// The unauthenticated screen was well built for the FAILURE case -- a
/// real headline, the actual error from Rust naming the searched
/// directories, copy-pasteable commands, a privacy note. But it
/// explained only how to install `gh`. Nothing on it, or anywhere after
/// it, said what Headstate IS.
///
/// The one statement of scope lived in an empty-list branch most users
/// never see, so a user WITH pull requests skipped straight past it --
/// and the scoping rule is the single most important fact about the
/// data.
describe("first run", () => {
  it("says what the app tracks, not only how to install gh", async () => {
    show();
    expect(await screen.findByText(/pull requests you opened/i)).toBeTruthy();
    expect(screen.getByText(/waiting on your review/i)).toBeTruthy();
  });

  // The diagnosable error from Rust is the most useful thing on screen
  // when something is actually wrong; an intro must not displace it.
  it("still shows the real error and the install commands", async () => {
    show();
    expect(await screen.findByText(/gh was not found/)).toBeTruthy();
    expect(screen.getByText(/gh auth login/)).toBeTruthy();
  });

  it("keeps the privacy note", async () => {
    show();
    expect(await screen.findByText(/in memory only/i)).toBeTruthy();
  });
});
