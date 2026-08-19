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
/// Note: nothing wires a live count into this yet. `fetch_stats`'s derived
/// fields are always zero until the frontend defines what "needs attention"
/// means (Milestone 3); this function is deliberately pure and tested in
/// isolation so that wiring can happen later without touching this file.
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

    TrayIconBuilder::with_id("main")
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
                let _ = app.emit_to("main", "refresh-requested", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
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
