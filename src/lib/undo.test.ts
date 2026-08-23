import { describe, expect, it } from "vitest";
import { inverseOf } from "./undo";

/// `enqueue`, `draft`, and `ready` apply INSTANTLY with no confirm and
/// no undo, and their exact inverses already exist in the backend. A
/// misclick on "Convert to draft" silently un-readies a pull request the
/// user's team is waiting on; the reversal existed, it was just never
/// offered at the moment of regret.
describe("inverseOf", () => {
  it("pairs draft and ready in both directions", () => {
    expect(inverseOf("draft")).toBe("ready");
    expect(inverseOf("ready")).toBe("draft");
  });

  it("pairs enqueue and dequeue in both directions", () => {
    expect(inverseOf("enqueue")).toBe("dequeue");
    expect(inverseOf("dequeue")).toBe("enqueue");
  });

  // Close has its own confirm dialog and `reopen` does NOT restore
  // everything a close discards -- offering one-click undo would imply
  // it does.
  it("offers no undo for close", () => {
    expect(inverseOf("close")).toBeNull();
  });

  // Merging is irreversible from this app's side: `reopen` cannot
  // un-merge, and a revert is a new commit, not an undo. Claiming
  // otherwise would be a lie about the one unrecoverable action.
  it("offers no undo for merge", () => {
    expect(inverseOf("merge")).toBeNull();
  });

  it("offers no undo for reopen", () => {
    expect(inverseOf("reopen")).toBeNull();
  });

  // Applying the inverse twice must return the original action, or the
  // pairing is not actually a pairing.
  it("is its own inverse for every reversible action", () => {
    for (const a of ["draft", "ready", "enqueue", "dequeue"] as const) {
      const back = inverseOf(a);
      expect(back).not.toBeNull();
      expect(inverseOf(back!)).toBe(a);
    }
  });
});
