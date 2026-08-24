import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { ExternalLink } from "./ExternalLink";

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

/// A plain `target="_blank"` anchor does NOTHING in a packaged Tauri
/// window -- there is no browser context to open a tab in. Every
/// external link in the app was inert, and it went unnoticed because it
/// works in `tauri dev`, where the webview IS a browser.
describe("ExternalLink", () => {
  it("opens the URL through the OS rather than the webview", () => {
    render(<ExternalLink href="https://example.com/x">go</ExternalLink>);
    fireEvent.click(screen.getByText("go"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  // The webview must not try to navigate itself: in a packaged app that
  // either does nothing or replaces the app's own UI.
  it("prevents the webview from navigating", () => {
    render(<ExternalLink href="https://example.com/x">go</ExternalLink>);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("go").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  // Inside a clickable row, opening a link must not also open the row.
  it("does not bubble to a clickable parent", () => {
    const onParent = vi.fn();
    render(
      <div onClick={onParent}>
        <ExternalLink href="https://example.com/x">go</ExternalLink>
      </div>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(onParent).not.toHaveBeenCalled();
  });

  // A menu item needs to close its menu as well as open the link.
  it("runs a caller's onClick and still opens the URL", () => {
    const onClick = vi.fn();
    render(
      <ExternalLink href="https://example.com/x" onClick={onClick}>
        go
      </ExternalLink>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(onClick).toHaveBeenCalledOnce();
    // The open is the point: a caller must not be able to suppress it.
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  // Keeps the real href: the accessible role, the hover affordance, and
  // copy-link-address all depend on it.
  it("is still a real link", () => {
    render(<ExternalLink href="https://example.com/x">go</ExternalLink>);
    expect(screen.getByRole("link", { name: "go" }).getAttribute("href")).toBe(
      "https://example.com/x",
    );
  });
});
