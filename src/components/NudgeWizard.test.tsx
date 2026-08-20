import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PR_FIXTURES, prWithState } from "../fixtures/prs";
import { NudgeWizard } from "./NudgeWizard";

/// Advances the wizard past the repo and filter steps to the preview step,
/// using the same "Next" button a user would click.
function openToPreview() {
  render(<NudgeWizard prs={PR_FIXTURES} />);
  fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
}

describe("NudgeWizard", () => {
  it("opens from the trigger button", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    expect(screen.getByText(/Which repositories/i)).toBeDefined();
  });

  /// The generated text gets pasted into team channels, so the user must
  /// see the exact output before it leaves the app.
  it("shows a live preview of the exact output text", () => {
    openToPreview();
    expect(screen.getByRole("textbox")).toBeDefined();
  });

  it("copies the preview to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    openToPreview();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalled();
  });

  /// Regression guard for the M4 shape: selection (what gets copied) and
  /// preview (what's shown) must come from the exact same computed list.
  /// This asserts the literal CONTENTS of the generated text -- exact PR
  /// numbers and strings -- not the shape of any filter/selection state,
  /// so a future divergence between the two paths would fail this test
  /// even if both objects still "looked" internally consistent.
  it("the copied text matches the exact PRs shown in the preview, unfiltered default", () => {
    openToPreview();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Default filters: readyOnly=true, annotate=true. PR_FIXTURES[1] is a
    // draft and PR_FIXTURES[2] is not a draft but has ci "none" -- both
    // survive `readyOnly`, since that filter only excludes drafts. Only
    // #43 (draft) is excluded by default.
    expect(textarea.value).toContain("#42");
    expect(textarea.value).toContain("Add retry to the fetch client");
    expect(textarea.value).toContain("https://github.com/octocat/hello-world/pull/42");
    expect(textarea.value).not.toContain("#43");
    expect(textarea.value).toContain("#7");
  });

  it("restricting to one repo changes both the count and the copied text together", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));

    // Step 0: repo picker -- select only spoon-knife.
    fireEvent.click(screen.getByRole("checkbox", { name: /octocat\/spoon-knife/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("#7");
    expect(textarea.value).not.toContain("#42");
    expect(textarea.value).not.toContain("#43");
    expect(screen.getByText(/^1 pull request$/)).toBeDefined();
  });

  it("Slack format uses mrkdwn link syntax instead of markdown", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    fireEvent.click(screen.getByRole("checkbox", { name: /slack format/i }));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("<https://github.com/octocat/hello-world/pull/42|");
    expect(textarea.value).not.toContain("[#42]");
  });

  it("shows a placeholder instead of an empty string when no PRs match", () => {
    render(<NudgeWizard prs={[prWithState("failure", "conflicted", "changes_requested", { is_draft: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("No pull requests match these filters.");
  });

  it("makes no network or invoke calls when composing and copying", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const fetchSpy = vi.fn(() => {
      throw new Error("NudgeWizard must never call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    openToPreview();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  /// A rejected clipboard write must NOT report success. `writeText` rejects
  /// on a denied permission or an insecure context; a button that still says
  /// "Copied!" leaves the user pasting whatever the clipboard held before,
  /// with no reason to suspect it.
  it("reports failure when the clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });

    openToPreview();
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy failed/i })).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /copied!/i })).toBeNull();
  });

  /// With nothing selected the preview shows a placeholder sentence. Copying
  /// then would put an empty string on the clipboard while the button claimed
  /// success -- screen and clipboard disagreeing is the one thing this
  /// feature cannot afford, so the button is disabled instead.
  it("disables copy when the selection is empty", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    // A filter no fixture satisfies: drafts only AND green CI.
    render(<NudgeWizard prs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const copy = screen.getByRole("button", { name: /^copy$/i });
    expect(copy.hasAttribute("disabled")).toBe(true);
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
  });

  /// #41: a repo selected in the sidebar already answers "which
  /// repositories?", so the wizard must not ask again.
  it("skips the repo step when a repo is already selected", () => {
    render(<NudgeWizard prs={PR_FIXTURES} scopedRepo="octocat/hello-world" />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));

    expect(screen.queryByText(/Which repositories/i)).toBeNull();
    // Opens directly on the filter step, and Back cannot walk into the
    // step that was skipped.
    expect(screen.getByRole("button", { name: /back/i }).hasAttribute("disabled")).toBe(true);
  });

  it("still asks which repositories when none is selected", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    expect(screen.getByText(/Which repositories/i)).toBeDefined();
  });

  /// The generated text must contain only the scoped repo's PRs -- asserting
  /// contents, not that a prop was passed.
  it("scopes the generated output to the selected repo", () => {
    render(<NudgeWizard prs={PR_FIXTURES} scopedRepo="octocat/spoon-knife" />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const preview = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(preview.value).not.toContain("octocat/hello-world");
  });

  it("resets to step 0 after closing", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    // Close via Escape, then reopen.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    expect(screen.getByText(/Which repositories/i)).toBeDefined();
  });
});
