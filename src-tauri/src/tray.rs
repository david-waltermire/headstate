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
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Headstate", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Headstate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;

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

/// Write the attention count onto the tray icon.
///
/// macOS renders `set_title` text beside the template glyph, which is how a
/// monochrome template image signals a count without carrying colour. `None`
/// clears it, so a resolved queue leaves a clean icon rather than a "0".
///
/// Failure here is non-fatal and deliberately silent-but-logged: a badge is
/// an affordance, and losing it must never take down polling.
pub fn set_badge(app: &AppHandle, needs_attention: u64) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(e) = tray.set_title(badge_text(needs_attention).as_deref()) {
        eprintln!("headstate: failed to set tray badge: {e}");
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
}
