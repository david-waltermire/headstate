//! Tray icon and window behaviour.
//!
//! The tray glyph is a macOS template image: pure black plus alpha, with a
//! filename ending in `Template`. That suffix is what makes macOS invert it
//! for light and dark menu bars and highlight it on click. It therefore
//! cannot carry colour, so attention is signalled by badge text instead.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Badge text for the tray icon. `0` means nothing needs attention (no
/// badge); large counts are capped at "99+" because a three-digit badge
/// would widen the menu bar item enough to shove neighbouring icons around.
///
/// Fed by `set_badge` from the poll loop on every tick.
/// The id `setup_tray` builds the icon with, so the poll loop can find it.
pub const TRAY_ID: &str = "main";

pub fn badge_text(needs_attention: u64) -> Option<String> {
    match needs_attention {
        0 => None,
        n if n > 99 => Some("99+".to_string()),
        n => Some(n.to_string()),
    }
}

/// Build the tray icon and its menu (Show / Refresh now / Quit).
///
/// The icon is loaded from the bundled `trayTemplate@2x.png` and marked as a
/// template image so macOS handles light/dark inversion and click
/// highlighting itself -- see the module doc for why it can't carry colour.
/// The menu's count line, kept so the poll loop can rewrite it.
///
/// Managed state rather than rebuilt each tick: replacing the whole menu
/// every 2 minutes would close it under a user who had it open.
pub struct CountItem(pub MenuItem<tauri::Wry>);

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // Disabled: a status line, not an action. It is the first item so the
    // count is the first thing read when the menu opens -- which on
    // Windows and Linux is the primary way to see it at all.
    let count = MenuItem::with_id(app, "count", badge_tooltip(0), false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Headstate", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Headstate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&count, &show, &refresh, &quit])?;
    app.manage(CountItem(count));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/trayTemplate@2x.png"
        ))?)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "refresh" => {
                // Wake the Rust poll loop, which persists the snapshot,
                // emits `prs-updated`, and repaints the badge. The event
                // below only reaches a React listener mounted inside
                // `App`, so on its own it was silently dead whenever the
                // window was hidden -- which is most of the time for a
                // tray app.
                if let Some(waker) = app.try_state::<crate::poll::Waker>() {
                    waker.0.notify_one();
                }
                let _ = app.emit_to("main", "refresh-requested", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// The tooltip and menu wording for a count.
///
/// The tray's own summary line, in prose rather than a bare number: a
/// tooltip reading "3" is a worse answer than no tooltip.
pub fn badge_tooltip(needs_attention: u64) -> String {
    match needs_attention {
        0 => "Headstate — nothing needs attention".to_string(),
        1 => "Headstate — 1 pull request needs attention".to_string(),
        n => format!("Headstate — {n} pull requests need attention"),
    }
}

/// Write the attention count onto the tray.
///
/// Three carriers, because no single one works everywhere:
///
/// - `set_title` renders text beside the glyph, which is how a monochrome
///   template image signals a count without carrying colour. **macOS only**
///   -- on Windows and Linux it is a silent no-op, which is what made the
///   count simply vanish off macOS.
/// - The tooltip works on every platform, but only on hover.
/// - The menu's first item works everywhere, but only once opened.
///
/// So macOS keeps the at-a-glance badge it already had, and the other two
/// give Windows and Linux a count that exists at all. Redundant on macOS by
/// design: three cheap calls beat a `cfg` maze, and hovering the tray to
/// read the count is a reasonable thing to do there too.
///
/// Failure here is non-fatal and deliberately silent-but-logged: a badge is
/// an affordance, and losing it must never take down polling.
pub fn set_badge(app: &AppHandle, needs_attention: u64) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    // macOS only. Skipped elsewhere rather than called and ignored, so a
    // real failure on macOS is still worth logging while a platform that
    // has no such concept does not log a warning every tick.
    #[cfg(target_os = "macos")]
    if let Err(e) = tray.set_title(badge_text(needs_attention).as_deref()) {
        log::warn!("failed to set tray badge: {e}");
    }

    if let Err(e) = tray.set_tooltip(Some(badge_tooltip(needs_attention))) {
        log::warn!("failed to set tray tooltip: {e}");
    }

    if let Some(item) = app.try_state::<CountItem>() {
        if let Err(e) = item.0.set_text(badge_tooltip(needs_attention)) {
            log::warn!("failed to set tray count item: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_badge_when_nothing_needs_attention() {
        assert_eq!(badge_text(0), None);
    }

    #[test]
    fn badge_shows_the_count() {
        assert_eq!(badge_text(3).as_deref(), Some("3"));
    }

    /// A three-digit badge would widen the menu bar item enough to shove
    /// neighbouring icons around.
    #[test]
    fn large_counts_are_capped() {
        assert_eq!(badge_text(150).as_deref(), Some("99+"));
    }

    /// The tooltip is prose, not a bare number: a tooltip reading "3" is
    /// a worse answer than no tooltip at all.
    #[test]
    fn the_tooltip_reads_as_a_sentence() {
        assert_eq!(badge_tooltip(0), "Headstate — nothing needs attention");
        assert_eq!(
            badge_tooltip(1),
            "Headstate — 1 pull request needs attention"
        );
        assert_eq!(
            badge_tooltip(5),
            "Headstate — 5 pull requests need attention"
        );
    }

    /// Zero is "nothing needs attention", never "0 pull requests" -- the
    /// same rule `badge_text` follows by returning None.
    #[test]
    fn zero_is_prose_not_a_count() {
        let t = badge_tooltip(0);
        assert!(!t.contains('0'), "{t}");
        assert_eq!(badge_text(0), None);
    }

    /// Singular and plural must agree with the number. This is the kind of
    /// thing that reads as sloppy in a UI seen every two minutes.
    #[test]
    fn the_tooltip_agrees_in_number() {
        assert!(badge_tooltip(1).contains("request needs"));
        for n in [2, 17, 200] {
            assert!(badge_tooltip(n).contains("requests need"), "n={n}");
        }
    }

    /// The tooltip is NOT capped at 99+ the way the macOS badge is. That
    /// cap exists because a wide menu-bar item shoves neighbouring icons
    /// around; a tooltip has no such constraint, and "150" is more useful
    /// than "99+" when you are deciding whether to look.
    #[test]
    fn the_tooltip_reports_large_counts_exactly() {
        assert_eq!(badge_text(150).as_deref(), Some("99+"));
        assert!(badge_tooltip(150).contains("150"));
    }
}
