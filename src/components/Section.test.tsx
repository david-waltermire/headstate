import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Section } from "./Section";

describe("Section", () => {
  it("shows its content when open and removes it when collapsed", () => {
    render(
      <Section title="Checks">
        <p>a check row</p>
      </Section>,
    );
    expect(screen.getByText("a check row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /checks/i }));
    // Unmounted, not hidden: a collapsed section of fifty comments must
    // not stay in the layout.
    expect(screen.queryByText("a check row")).toBeNull();
  });

  it("starts collapsed when told to", () => {
    render(
      <Section title="Comments" defaultOpen={false}>
        <p>a comment</p>
      </Section>,
    );
    expect(screen.queryByText("a comment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /comments/i }));
    expect(screen.getByText("a comment")).toBeTruthy();
  });

  /// A collapsed section must still say how much it is hiding -- that
  /// is what makes collapsing safe rather than a way to lose things.
  it("shows the count even while collapsed", () => {
    render(
      <Section title="Comments" count={42} defaultOpen={false}>
        <p>a comment</p>
      </Section>,
    );
    expect(screen.getByText("42")).toBeTruthy();
  });

  /// The aside is a section action ("Re-run failed"). Clicking it must
  /// not collapse the section out from under the click.
  it("keeps the aside action outside the collapse toggle", () => {
    render(
      <Section title="Checks" aside={<button type="button">Re-run failed</button>}>
        <p>a check row</p>
      </Section>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-run failed" }));
    expect(screen.getByText("a check row")).toBeTruthy();
  });

  it("reports its state to assistive technology", () => {
    render(
      <Section title="Checks">
        <p>x</p>
      </Section>,
    );
    const toggle = screen.getByRole("button", { name: /checks/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
