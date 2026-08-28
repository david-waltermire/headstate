import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

const installFn = vi.hoisted(() =>
  vi.fn<(cb?: (d: number, t: number | null) => void) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);
vi.mock("../api/updater", () => ({ installUpdate: installFn }));

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
  /// The notes link no longer dismisses. It used to be the only action
  /// besides "Not now", so dismissing was right -- but the dialog can
  /// now install, and closing it when someone opens the notes would
  /// take the Install button away from a user who was reading before
  /// deciding.
  it("keeps the dialog open when the release notes are opened", () => {
    const onDismiss = vi.fn();
    render(<UpdateDialog version="3.4.0" open onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("link", { name: /release notes/i }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^install$/i })).toBeTruthy();
  });

  it("shows nothing when closed", () => {
    render(<UpdateDialog version="3.4.0" open={false} onDismiss={vi.fn()} />);
    expect(screen.queryByText(/3\.4\.0/)).toBeNull();
  });

  /// Reported: "the buttons were all squished and the text was split on
  /// multiple lines". Adding Install made three actions in a dialog
  /// sized for two.
  it("gives its three actions room rather than wrapping their labels", () => {
    render(<UpdateDialog version="3.4.0" open onDismiss={vi.fn()} />);
    // The dialog renders in a PORTAL, so it is not under `container`.
    const row = document.querySelector(".justify-end");
    expect(row?.className).toContain("whitespace-nowrap");
    expect(document.querySelector(".max-w-lg")).toBeTruthy();
  });

  /// The dialog used to only inform -- the user had to find the
  /// release, download it, and replace the app by hand.
  describe("installing", () => {
    it("installs and restarts", async () => {
      installFn.mockClear();
      render(<UpdateDialog version="3.4.0" open onDismiss={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      await waitFor(() => expect(installFn).toHaveBeenCalled());
    });

    /// The plugin's refusals are specific -- a signature mismatch, no
    /// bundle for this platform -- and a generic "update failed" would
    /// throw away the one part that says what happened.
    it("shows the failure in the updater's own words", async () => {
      installFn.mockRejectedValueOnce(new Error("signature mismatch"));
      render(<UpdateDialog version="3.4.0" open onDismiss={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toContain("signature mismatch");
    });

    /// A ~20 MB download is long enough on a slow connection that a
    /// dialog with no feedback reads as hung.
    it("reports download progress", async () => {
      installFn.mockImplementationOnce((cb) => {
        cb?.(5, 10);
        return new Promise(() => {});
      });
      render(<UpdateDialog version="3.4.0" open onDismiss={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      await waitFor(() => expect(screen.getByText(/50%/)).toBeTruthy());
    });

    /// Closing mid-download would leave the install running with
    /// nothing reporting it.
    it("cannot be dismissed while installing", async () => {
      const onDismiss = vi.fn();
      installFn.mockImplementationOnce(() => new Promise(() => {}));
      render(<UpdateDialog version="3.4.0" open onDismiss={onDismiss} />);
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /not now/i })).toHaveProperty(
          "disabled",
          true,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: /not now/i }));
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });
});
