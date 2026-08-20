import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

function key(k: string, mods: Partial<KeyboardEvent> = {}, target?: EventTarget | null) {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    target,
  } as never;
}

describe("shortcutFor", () => {
  it("maps Cmd+R to refresh", () => {
    expect(shortcutFor(key("r", { metaKey: true }))).toBe("onRefresh");
    expect(shortcutFor(key("R", { metaKey: true }))).toBe("onRefresh");
  });

  // Ctrl+R is a browser reload elsewhere; claiming it would surprise.
  it("does not claim Ctrl+R", () => {
    expect(shortcutFor(key("r", { ctrlKey: true }))).toBeNull();
  });

  it("maps Cmd+F and / to the search field", () => {
    expect(shortcutFor(key("f", { metaKey: true }))).toBe("onFocusSearch");
    expect(shortcutFor(key("/"))).toBe("onFocusSearch");
  });

  it("maps Escape to hide", () => {
    expect(shortcutFor(key("Escape"))).toBe("onHide");
  });

  // The guard that keeps shortcuts from eating real input.
  it("stays out of the way while the user is typing", () => {
    const input = document.createElement("input");
    expect(shortcutFor(key("/", {}, input))).toBeNull();
    expect(shortcutFor(key("Escape", {}, input))).toBeNull();
  });

  it("still allows Cmd+R while typing, since it is unambiguous", () => {
    const input = document.createElement("input");
    expect(shortcutFor(key("r", { metaKey: true }, input))).toBe("onRefresh");
  });

  it("ignores plain letters", () => {
    expect(shortcutFor(key("a"))).toBeNull();
    expect(shortcutFor(key("Enter"))).toBeNull();
  });
});
