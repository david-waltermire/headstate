/// Dismiss the launch splash defined in `index.html`.
///
/// The splash lives in static HTML rather than React because `<body>` is
/// empty until React mounts, and the webview paints its own default white
/// in the meantime. Dismissal is app-driven, not timed: a fixed delay would
/// either uncover an empty UI on a slow machine or linger on a fast one.
///
/// It is also floored at MIN_VISIBLE_MS. The app can reach first paint in
/// well under a second, which made the splash flash past and read as a
/// glitch. The floor is PURELY COSMETIC and gates nothing: queries, the
/// poll loop, and React all start when they start. It only delays removing
/// an overlay from a UI that is already live underneath.

const SPLASH_ID = "splash";
const HIDING = "headstate-hiding";

/// Must match the CSS transition duration in `index.html`.
const FADE_MS = 400;

/// Minimum time the splash stays up, measured from module load (the
/// earliest moment this code can observe, and within a few ms of the
/// webview painting the splash).
const MIN_VISIBLE_MS = 3000;

const loadedAt = Date.now();

/// Hard ceiling on how long the splash may EVER stay up.
///
/// The v1.0.0 hang was not a slow launch: `AuthGate` renders its error
/// screen without mounting `App`, so the dismissal effect never ran and a
/// fixed, inset-0, z-index-9999 overlay hid a perfectly good error message
/// forever. Callers are now correct, but a splash that can outlive every
/// code path is a trap, so it also removes itself unconditionally.
const MAX_VISIBLE_MS = 10_000;

/// Milliseconds still owed to the floor, never negative.
function remainingFloor(now: number, minVisibleMs: number): number {
  return Math.max(0, minVisibleMs - (now - loadedAt));
}

/// Arm the unconditional failsafe. Called once at module load, so it holds
/// even if no caller ever reaches `dismissSplash`.
function armFailsafe(): void {
  if (typeof document === "undefined") return;
  setTimeout(() => {
    const el = document.getElementById(SPLASH_ID);
    // Only acts if something else has not already dismissed it.
    if (el) dismissSplash(document, FADE_MS, 0);
  }, MAX_VISIBLE_MS);
}

armFailsafe();

export function dismissSplash(
  doc: Document = document,
  fadeMs: number = FADE_MS,
  minVisibleMs: number = MIN_VISIBLE_MS,
): void {
  const el = doc.getElementById(SPLASH_ID);
  if (!el || el.classList.contains(HIDING)) return;

  const owed = remainingFloor(Date.now(), minVisibleMs);
  if (owed > 0) {
    // Re-enter after the floor rather than fading now. The guard above is
    // re-checked on that pass, so overlapping calls still collapse to one
    // dismissal.
    setTimeout(() => dismissSplash(doc, fadeMs, 0), owed);
    return;
  }

  el.classList.add(HIDING);

  const remove = () => el.remove();
  // `transitionend` never fires for an unrendered element -- a background
  // window, or prefers-reduced-motion disabling the transition. The timeout
  // guarantees removal either way. Removal matters: a fixed inset-0 element
  // left in place swallows every click even at zero opacity.
  el.addEventListener("transitionend", remove, { once: true });
  // Deliberately not cleared when `transitionend` wins the race: `remove` is
  // idempotent, so the late timer is a harmless no-op. Do not copy this
  // pattern for a callback that is not idempotent.
  setTimeout(remove, fadeMs + 100);
}
