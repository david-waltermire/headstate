import { describe, expect, it } from "vitest";
import { isMac, shortcutFor } from "./shortcuts";

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

// These cases were written for macOS and use Cmd throughout, so they pass
// mac=true explicitly. Before the platform argument existed they relied on
// the implicit assumption -- which is exactly the assumption that left
// Windows and Linux with no working shortcuts.
describe("shortcutFor (macOS)", () => {
  it("maps Cmd+R to refresh", () => {
    expect(shortcutFor(key("r", { metaKey: true }), true)).toBe("onRefresh");
    expect(shortcutFor(key("R", { metaKey: true }), true)).toBe("onRefresh");
  });

  // Ctrl+R is a browser reload elsewhere; claiming it would surprise.
  it("does not claim Ctrl+R", () => {
    expect(shortcutFor(key("r", { ctrlKey: true }), true)).toBeNull();
  });

  it("maps Cmd+F and / to the search field", () => {
    expect(shortcutFor(key("f", { metaKey: true }), true)).toBe("onFocusSearch");
    expect(shortcutFor(key("/"), true)).toBe("onFocusSearch");
  });

  it("maps Escape to hide", () => {
    expect(shortcutFor(key("Escape"), true)).toBe("onHide");
  });

  // The guard that keeps shortcuts from eating real input.
  it("stays out of the way while the user is typing", () => {
    const input = document.createElement("input");
    expect(shortcutFor(key("/", {}, input), true)).toBeNull();
    expect(shortcutFor(key("Escape", {}, input), true)).toBeNull();
  });

  it("still allows Cmd+R while typing, since it is unambiguous", () => {
    const input = document.createElement("input");
    expect(shortcutFor(key("r", { metaKey: true }, input), true)).toBe("onRefresh");
  });

  it("ignores plain letters", () => {
    expect(shortcutFor(key("a"), true)).toBeNull();
    expect(shortcutFor(key("Enter"), true)).toBeNull();
  });

  // The bug: metaKey is Cmd on macOS but the WINDOWS KEY elsewhere, so
  // gating on it meant no modifier shortcut fired at all on Windows or
  // Linux. Win+R opened the OS Run dialog instead of refreshing.
  describe("platform modifier", () => {
    const R = { key: "r", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

    it("uses Cmd on macOS", () => {
      expect(shortcutFor({ ...R, metaKey: true }, true)).toBe("onRefresh");
    });

    it("uses Ctrl off macOS", () => {
      expect(shortcutFor({ ...R, ctrlKey: true }, false)).toBe("onRefresh");
    });

    // Not "accept either modifier everywhere": Ctrl+R on macOS means
    // something else, and Cmd is the Windows key off macOS.
    it("ignores Ctrl on macOS", () => {
      expect(shortcutFor({ ...R, ctrlKey: true }, true)).toBeNull();
    });

    it("ignores the Windows key off macOS", () => {
      expect(shortcutFor({ ...R, metaKey: true }, false)).toBeNull();
    });

    it("applies the same rule to the search shortcut", () => {
      const F = { ...R, key: "f" };
      expect(shortcutFor({ ...F, metaKey: true }, true)).toBe("onFocusSearch");
      expect(shortcutFor({ ...F, ctrlKey: true }, false)).toBe("onFocusSearch");
      expect(shortcutFor({ ...F, ctrlKey: true }, true)).toBeNull();
      expect(shortcutFor({ ...F, metaKey: true }, false)).toBeNull();
    });

    // These two check no modifier, so they were the only shortcuts that
    // worked off macOS before this change. They must keep working on both.
    it("leaves the modifier-free shortcuts working on every platform", () => {
      for (const mac of [true, false]) {
        expect(
          shortcutFor(
            { key: "/", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
            mac,
          ),
        ).toBe("onFocusSearch");
        expect(
          shortcutFor(
            { key: "Escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
            mac,
          ),
        ).toBe("onHide");
      }
    });
  });

  describe("isMac", () => {
    it("recognises the platforms that use Cmd", () => {
      expect(isMac("MacIntel")).toBe(true);
      expect(isMac("iPhone")).toBe(true);
    });

    it("treats everything else as a Ctrl platform", () => {
      expect(isMac("Win32")).toBe(false);
      expect(isMac("Linux x86_64")).toBe(false);
      // An empty platform string must not accidentally read as macOS --
      // Ctrl is the safer default, since Cmd-only would leave a user with
      // no working shortcuts at all.
      expect(isMac("")).toBe(false);
    });
  });
});
