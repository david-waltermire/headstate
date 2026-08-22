import { describe, expect, it, vi } from "vitest";
import { safeUnlisten } from "./unlisten";

/// Regression tests for three unhandled rejections logged on every dev
/// startup (#246).
///
/// React 19 StrictMode double-mounts effects on purpose. When the first
/// mount is torn down before its `listen()` promise resolves, the cleanup
/// calls the resulting `unlisten` against a listener Tauri has already
/// removed, and its internal `listeners[eventId]` lookup is undefined.
/// Nothing leaks -- it is the teardown that fails, after the listener is
/// already gone -- but it buried the console in stack traces during
/// exactly the debugging sessions where the console matters.
describe("safeUnlisten", () => {
  it("swallows a throw from a listener Tauri already removed", () => {
    const boom = () => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    };
    expect(() => safeUnlisten(boom)).not.toThrow();
  });

  it("swallows a rejected promise, which is how the dev error actually surfaced", async () => {
    const rejects = () => Promise.reject(new TypeError("handlerId"));
    const returned = safeUnlisten(rejects);
    // An unhandled rejection here is the bug -- awaiting must resolve.
    await expect(Promise.resolve(returned)).resolves.toBeUndefined();
  });

  it("still calls through, so listeners are actually removed", () => {
    const fn = vi.fn();
    safeUnlisten(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("tolerates being handed nothing, for the not-yet-resolved case", () => {
    expect(() => safeUnlisten(undefined)).not.toThrow();
  });
});
