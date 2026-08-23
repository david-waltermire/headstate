import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const ev = (over: Partial<KeyboardEvent> & { key: string }) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }) as never;

const typing = { target: Object.assign(document.createElement("input"), {}) };

/// The app had three shortcuts -- refresh, hide, focus-search -- and no
/// list navigation at all. With 13 PRs needing attention, every triage
/// decision was a mouse round-trip: move to row, click kebab, read menu,
/// click item.
describe("list navigation", () => {
  it("moves down with j and up with k", () => {
    expect(shortcutFor(ev({ key: "j" }))).toBe("onNext");
    expect(shortcutFor(ev({ key: "k" }))).toBe("onPrev");
  });

  it("accepts the arrow keys for the same moves", () => {
    expect(shortcutFor(ev({ key: "ArrowDown" }))).toBe("onNext");
    expect(shortcutFor(ev({ key: "ArrowUp" }))).toBe("onPrev");
  });

  it("opens the cursor row with Enter", () => {
    expect(shortcutFor(ev({ key: "Enter" }))).toBe("onOpen");
  });

  it("toggles selection with x", () => {
    expect(shortcutFor(ev({ key: "x" }))).toBe("onToggleSelect");
  });

  // Every one of these is a bare letter, so typing "jack" in the search
  // box must not move the cursor four times.
  it("fires none of them while the user is typing", () => {
    for (const key of ["j", "k", "x", "Enter", "ArrowDown", "ArrowUp"]) {
      expect(shortcutFor(ev({ key, ...typing }))).toBeNull();
    }
  });

  // A modifier means the combination belongs to the platform or to
  // another shortcut, not to list navigation.
  it("ignores them when a modifier is held", () => {
    expect(shortcutFor(ev({ key: "j", metaKey: true }), true)).toBeNull();
    expect(shortcutFor(ev({ key: "x", ctrlKey: true }), false)).toBeNull();
    expect(shortcutFor(ev({ key: "j", altKey: true }))).toBeNull();
  });

  // The existing three must keep working exactly as before.
  it("leaves the original shortcuts intact", () => {
    expect(shortcutFor(ev({ key: "r", metaKey: true }), true)).toBe("onRefresh");
    expect(shortcutFor(ev({ key: "Escape" }))).toBe("onHide");
    expect(shortcutFor(ev({ key: "/" }))).toBe("onFocusSearch");
  });

  it("still lets Escape close a search field rather than hiding", () => {
    expect(shortcutFor(ev({ key: "Escape", ...typing }))).toBeNull();
  });
});
