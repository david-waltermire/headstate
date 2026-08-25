import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

import { UpdateDialog } from "./UpdateDialog";

afterEach(cleanup);

/// The status bar has always carried an update hint, and it is easy to
/// miss -- a small line at the bottom edge of a window that is often not
/// the one you are looking at.
describe("UpdateDialog", () => {
  it("names the version so the user knows what is on offer", () => {
    render(<UpdateDialog version="3.4.0" open onDismiss={vi.fn()} />);
    expect(screen.getByText(/3\.4\.0/)).toBeTruthy();
  });

  it("offers a way out that is not the release page", () => {
    const onDismiss = vi.fn();
    render(<UpdateDialog version="3.4.0" open onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // Opening the release page is also a decision about this version --
  // coming back to the same dialog after acting on it would be absurd.
  it("dismisses when the release is opened", () => {
    const onDismiss = vi.fn();
    render(<UpdateDialog version="3.4.0" open onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("link", { name: /see the release/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows nothing when closed", () => {
    render(<UpdateDialog version="3.4.0" open={false} onDismiss={vi.fn()} />);
    expect(screen.queryByText(/3\.4\.0/)).toBeNull();
  });
});
