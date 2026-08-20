/// Keyboard shortcuts for the main window.
///
/// The app had zero keyboard affordances: no shortcuts, no accelerators,
/// and no Escape-to-hide, so every action required the mouse. These three
/// are the cheapest meaningful wins and need no backend change --
/// `refresh-requested` and the hide behaviour already exist.
///
/// Deliberately narrow. Nothing fires while the user is typing in a field,
/// or while a modifier combination belongs to the platform.
export interface ShortcutHandlers {
  onRefresh: () => void;
  onHide: () => void;
  onFocusSearch: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/// Returns which action a key event should trigger, or null.
///
/// Split from the listener so the mapping is testable without a DOM: the
/// interesting rules are the guards, not the wiring.
export function shortcutFor(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
    target?: EventTarget | null;
  },
): keyof ShortcutHandlers | null {
  // Escape closes the search field first; only hide when not typing.
  if (e.key === "Escape") return isTyping(e.target ?? null) ? null : "onHide";

  // Cmd+R: refresh. Never Ctrl+R, which is a browser reload on other
  // platforms and would be surprising here.
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") {
    return "onRefresh";
  }

  // Cmd+F focuses search rather than opening the webview's find bar,
  // which a Tauri window does not provide.
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
    return "onFocusSearch";
  }

  // "/" focuses search, the convention on GitHub itself -- but only when
  // the user is not already typing into something.
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return isTyping(e.target ?? null) ? null : "onFocusSearch";
  }

  return null;
}
