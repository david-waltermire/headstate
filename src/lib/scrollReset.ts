import { useEffect, useRef } from "react";

/// Scroll a container back to the top when the user NAVIGATES.
///
/// The main panel is one persistent scroll container: React swaps its
/// children on navigation but nothing touches `scrollTop`, so leaving
/// the bottom of a long PR and clicking a repo landed you at the bottom
/// of the repo list.
///
/// The important half is what this does NOT do. A poll tick refreshing
/// the list re-renders the same view, and yanking the user to the top
/// mid-read would be a worse bug than the one being fixed. So the reset
/// is keyed on a caller-supplied destination string and fires only when
/// that string CHANGES -- not on every render, and not on data changes.
///
/// Skips the first run: on mount the container is already at the top,
/// and scrolling a fresh container is a no-op that only makes the
/// behaviour harder to reason about.
export function useScrollReset(
  ref: React.RefObject<HTMLElement | null>,
  destination: string,
): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== destination) {
      const el = ref.current;
      // `scrollTo` is not universally present -- jsdom omits it, and it
      // is a DOM method rather than a property, so a webview without it
      // would throw here and take the whole render down. Assigning
      // `scrollTop` is the older, always-available equivalent, and this
      // must never be the thing that breaks a view.
      if (el && typeof el.scrollTo === "function") el.scrollTo({ top: 0 });
      else if (el) el.scrollTop = 0;
    }
    previous.current = destination;
  }, [ref, destination]);
}
