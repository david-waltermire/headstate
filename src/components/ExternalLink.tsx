import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/// A link that actually opens the user's browser.
///
/// A plain `target="_blank"` anchor does NOTHING in a packaged Tauri
/// window: there is no browser context for it to open a tab in, and
/// without the opener plugin the webview has nowhere to send it. Every
/// external link in the app was inert -- "View on GitHub", the PR title,
/// the update notice, "Report this".
///
/// It works in `tauri dev`, where the webview IS a browser context,
/// which is why this survived so long: the one environment where it was
/// tested was the one environment where it worked.
///
/// Still an `<a>` with a real `href`: it keeps the accessible role, the
/// hover affordance, and the ability to copy the address. The click is
/// intercepted rather than the element replaced.
export function ExternalLink({
  href,
  className,
  title,
  role,
  onClick,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  /// For a link that is also a menu item.
  role?: string;
  /// Runs BEFORE the URL opens -- closing a menu, clearing state. It
  /// cannot suppress the open: this component's whole purpose is that
  /// the link works, and a caller silently disabling that is the bug it
  /// exists to fix.
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      title={title}
      role={role}
      className={className}
      onClick={(e) => {
        // Both: `preventDefault` stops the webview trying to navigate
        // itself, and `stopPropagation` keeps a click inside a clickable
        // row from also opening the row.
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
        void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}
