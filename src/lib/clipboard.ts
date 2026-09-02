/// Copy text, reporting every way it can fail.
///
/// `navigator.clipboard.writeText(...)` has TWO failure modes and the
/// obvious spelling only handles one:
///
/// - `writeText` REJECTS — the document is not focused, or permission was
///   denied. A `.then(ok, err)` catches this.
/// - `navigator.clipboard` is UNDEFINED — it is gated on a secure
///   context. Then the property access throws SYNCHRONOUSLY, before
///   either handler is attached, so neither runs and the click does
///   nothing visible at all.
///
/// That second case is what made Claudify look inert: no success toast,
/// no error toast, no clue. A copy that cannot happen has to say so, the
/// same way every other inconclusive check in this codebase refuses
/// rather than passing quietly.
///
/// Returns null on success, or a message describing what went wrong.
export async function copyText(text: string): Promise<string | null> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) {
    // Names the CAUSE, because "could not copy" alone leaves the user
    // with nothing to do. An insecure context is a real configuration
    // rather than a transient failure, so retrying will not help and the
    // message should not imply it might.
    return "This window has no clipboard access.";
  }
  try {
    await clipboard.writeText(text);
    return null;
  } catch (e: unknown) {
    // GitHub's own wording is the useful part when there is any:
    // "Document is not focused" tells the user to click the window
    // first, where a generic message does not.
    return e instanceof Error ? e.message : "The clipboard refused the copy.";
  }
}
