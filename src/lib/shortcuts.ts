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
  /// Move a cursor through the visible list.
  onNext: () => void;
  onPrev: () => void;
  /// Open the row under the cursor.
  onOpen: () => void;
  /// Check or uncheck the row under the cursor, for a bulk action.
  onToggleSelect: () => void;
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
/// Whether this platform uses Cmd as its shortcut modifier.
///
/// Injected rather than read from `navigator` at each call site, so the
/// mapping stays testable for both platforms without mocking globals.
export function isMac(platform: string = navigator.platform ?? ""): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

export function shortcutFor(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
    target?: EventTarget | null;
  },
  mac: boolean = isMac(),
): keyof ShortcutHandlers | null {
  // Cmd on macOS, Ctrl everywhere else -- and NOT both on either. Metakey
  // is the Windows key off macOS, so gating on it alone meant no shortcut
  // fired at all there; accepting `metaKey || ctrlKey` would instead make
  // Ctrl+R fire on macOS, where it means something else.
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  // Escape closes the search field first; only hide when not typing.
  if (e.key === "Escape") return isTyping(e.target ?? null) ? null : "onHide";

  // Refresh the pull request list. Ctrl+R is a browser reload elsewhere,
  // which is why this was Cmd-only -- but a Tauri window has no browser
  // chrome to reload into, and the listener calls preventDefault, so the
  // webview never sees it. The instinct behind the original comment still
  // holds: Ctrl+R must refresh the LIST, never the page.
  if (mod && !e.altKey && e.key.toLowerCase() === "r") {
    return "onRefresh";
  }

  // Focuses search rather than opening the webview's find bar, which a
  // Tauri window does not provide.
  if (mod && !e.altKey && e.key.toLowerCase() === "f") {
    return "onFocusSearch";
  }

  // "/" focuses search, the convention on GitHub itself -- but only when
  // the user is not already typing into something.
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return isTyping(e.target ?? null) ? null : "onFocusSearch";
  }

  // Bare letters and arrows, so they must never fire while typing --
  // otherwise searching for "jack" moves the cursor four times -- and
  // never with a modifier, which means the combination belongs to the
  // platform or to another shortcut.
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target ?? null)) {
    // `j`/`k` are the convention GitHub itself uses; the arrows are for
    // everyone who does not know that.
    if (e.key === "j" || e.key === "ArrowDown") return "onNext";
    if (e.key === "k" || e.key === "ArrowUp") return "onPrev";
    if (e.key === "Enter") return "onOpen";
    if (e.key === "x") return "onToggleSelect";
  }

  return null;
}
