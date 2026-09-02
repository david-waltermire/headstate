import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const original = globalThis.navigator?.clipboard;

afterEach(() => {
  Object.assign(navigator, { clipboard: original });
});

describe("copyText", () => {
  it("returns null when the copy lands", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyText("hello")).toBeNull();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  /// The bug this exists for. An absent clipboard throws SYNCHRONOUSLY
  /// on property access, so `.then(ok, err)` attaches neither handler
  /// and the click produces no toast of either kind.
  it("reports an absent clipboard instead of throwing", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const msg = await copyText("hello");
    expect(msg).toMatch(/no clipboard access/i);
  });

  /// The case the old code DID handle: the document is not focused,
  /// which is a real state in a desktop webview.
  it("passes a rejection's reason through", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: () => Promise.reject(new Error("Document is not focused")) },
    });
    expect(await copyText("hello")).toMatch(/not focused/i);
  });

  it("still reports something when the rejection carries no message", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: () => Promise.reject("nope") },
    });
    const msg = await copyText("hello");
    expect(msg).toBeTruthy();
  });
});
