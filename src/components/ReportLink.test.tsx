import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("3.1.3") }));
vi.mock("../api/tauri", () => ({ buildTarget: () => Promise.resolve(["macos", "aarch64"]) }));

import { ReportLink } from "./ReportLink";

afterEach(cleanup);

describe("ReportLink", () => {
  it("opens a prefilled issue form rather than submitting", async () => {
    render(<ReportLink error="Serde Error: expected value" />);
    const link = await screen.findByRole("link", { name: /report this/i });
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("pktstorm/headstate/issues/new");
    expect(href).toContain(encodeURIComponent("Serde Error"));
  });

  it("carries the environment the error text cannot", async () => {
    render(<ReportLink error="boom" />);
    const href = (await screen.findByRole("link", { name: /report this/i })).getAttribute("href") ?? "";
    const body = decodeURIComponent(href);
    expect(body).toContain("3.1.3");
    expect(body).toContain("macos");
  });

  // A link that does nothing when clicked is worse than none: it is not
  // rendered until the URL exists.
  it("shows nothing until the report is ready", () => {
    render(<ReportLink error="boom" />);
    expect(screen.queryByRole("link", { name: /report this/i })).toBeNull();
  });

  it("scrubs a token before it reaches the URL", async () => {
    render(<ReportLink error="bad credentials for ghp_abcdefghijklmnopqrst" />);
    await waitFor(() => expect(screen.getByRole("link", { name: /report this/i })).toBeTruthy());
    const href = screen.getByRole("link", { name: /report this/i }).getAttribute("href") ?? "";
    expect(decodeURIComponent(href)).not.toContain("ghp_abcdefghijklmnopqrst");
  });
});
