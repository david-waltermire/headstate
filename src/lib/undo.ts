import type { PrActionName } from "../api/tauri";

/// The action that reverses another, or null if nothing does.
///
/// `enqueue`, `draft`, and `ready` apply INSTANTLY with no confirm, and
/// their exact inverses already exist in the backend and are already
/// registered. A misclick on "Convert to draft" silently un-readies a
/// pull request the user's team is waiting on -- the reversal existed,
/// it was simply never offered at the moment of regret.
///
/// The omissions are the point:
///
/// - `merge` is irreversible from this app. `reopen` cannot un-merge,
///   and a revert is a NEW COMMIT, not an undo. Offering one here would
///   be a lie about the one action the user genuinely cannot take back.
/// - `close` already confirms, and `reopen` does not restore everything
///   a close discards. A one-click undo would imply it does.
/// - `reopen` is itself the undo for a close, so pairing it back to
///   `close` would offer "undo" on an action the user took to recover.
export function inverseOf(action: PrActionName): PrActionName | null {
  switch (action) {
    case "draft":
      return "ready";
    case "ready":
      return "draft";
    case "enqueue":
      return "dequeue";
    case "dequeue":
      return "enqueue";
    default:
      return null;
  }
}
