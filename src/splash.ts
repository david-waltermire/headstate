/// Dismiss the launch splash defined in `index.html`.
///
/// The splash lives in static HTML rather than React because `<body>` is
/// empty until React mounts, and the webview paints its own default white
/// in the meantime. Dismissal is app-driven, not timed: a fixed delay would
/// either uncover an empty UI on a slow machine or linger on a fast one.

const SPLASH_ID = "splash";
const HIDING = "headstate-hiding";

/// Must match the CSS transition duration in `index.html`.
const FADE_MS = 400;

export function dismissSplash(doc: Document = document, fadeMs: number = FADE_MS): void {
  const el = doc.getElementById(SPLASH_ID);
  if (!el || el.classList.contains(HIDING)) return;

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
