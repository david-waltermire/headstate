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

/// The tray glyph for this platform.
///
/// macOS gets the template image -- pure black plus alpha -- which the OS
/// inverts for light and dark menu bars. Windows and Linux do no such
/// inversion, so they get a white glyph with a soft dark rim: the rim
/// separates it from a light panel, the white body from a dark one.
///
/// Verified on the shipped macOS asset: 90 opaque pixels, 0 of them
/// non-black. That is correct as a template and unreadable as anything
/// else.
fn tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes = include_bytes!("../icons/trayTemplate@2x.png").as_slice();
    // 32px rather than 16: both platforms scale down cleanly and the
    // larger source survives a HiDPI panel.
    #[cfg(not(target_os = "macos"))]
    let bytes = include_bytes!("../icons/tray-32.png").as_slice();

    tauri::image::Image::from_bytes(bytes)
}

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
        .icon(tray_icon()?)
        // Template inversion is a macOS concept: the OS renders a
        // pure-black-plus-alpha image against the menu bar and inverts it
        // per theme. Setting it elsewhere is a no-op, and the asset it
        // implies -- an all-black glyph -- is invisible on a dark Windows
        // taskbar or GNOME panel.
        .icon_as_template(cfg!(target_os = "macos"))
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

    /// Windows builds embed `icon.ico` as a resource via `tauri_build`.
    /// Without it the build script fails before compiling a line of app
    /// code -- which is how the first Windows CI run died, because the
    /// Makefile deleted the file and .gitignore ignored it as leftovers
    /// "this macOS-only app never uses".
    ///
    /// A unit test rather than trusting the build: on macOS the file's
    /// absence is invisible until someone builds for Windows.
    #[test]
    fn the_windows_icon_is_present_and_is_a_real_ico() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.ico");
        let bytes = std::fs::read(path)
            .unwrap_or_else(|e| panic!("icons/icon.ico is missing ({e}); Windows builds need it"));

        // ICONDIR: reserved=0, type=1 (icon), then the image count.
        assert!(bytes.len() > 6, "icon.ico is truncated");
        assert_eq!(&bytes[0..4], &[0, 0, 1, 0], "not an ICO header");
        let count = u16::from_le_bytes([bytes[4], bytes[5]]);
        assert!(count > 0, "icon.ico declares no images");

        // Windows picks a size per context (taskbar, alt-tab, Explorer),
        // so a single-size .ico gets scaled and looks it.
        assert!(
            count >= 4,
            "icon.ico has only {count} size(s); Windows scales what it lacks"
        );
    }

    /// Both tray assets must decode. `Image::from_bytes` is what the app
    /// itself calls, so this fails for the same reason the app would.
    #[test]
    fn both_tray_assets_decode() {
        for (name, bytes) in [
            (
                "trayTemplate@2x.png",
                include_bytes!("../icons/trayTemplate@2x.png").as_slice(),
            ),
            (
                "tray-32.png",
                include_bytes!("../icons/tray-32.png").as_slice(),
            ),
        ] {
            let img = tauri::image::Image::from_bytes(bytes)
                .unwrap_or_else(|e| panic!("{name} does not decode: {e}"));
            assert!(img.width() > 0 && img.height() > 0, "{name} is empty");
        }
    }

    /// The Windows/Linux asset must not be a template image.
    ///
    /// Neither platform inverts anything, so an all-black glyph is
    /// invisible on a dark taskbar -- which is what shipped before #186
    /// (verified on the macOS asset: 90 opaque pixels, 0 non-black).
    /// `Image::from_bytes` hands back RGBA, so the check is direct.
    #[test]
    fn the_desktop_tray_icon_is_visible_on_a_dark_panel() {
        let img = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-32.png")).unwrap();
        let rgba = img.rgba();

        let opaque: Vec<&[u8]> = rgba.chunks(4).filter(|p| p[3] > 0).collect();
        assert!(!opaque.is_empty(), "no opaque pixels at all");

        let bright = opaque
            .iter()
            .filter(|p| p[..3].iter().any(|&c| c > 200))
            .count();
        assert!(
            bright > 0,
            "every opaque pixel is dark; this would be invisible on a dark panel"
        );
        // A handful of light pixels would pass while still reading as a
        // dark blob, so the body has to be a real share of the glyph.
        assert!(
            bright * 10 > opaque.len(),
            "only {bright} of {} opaque pixels are light; the glyph would read as a smudge",
            opaque.len()
        );
    }

    /// And the macOS asset must STAY a template image: pure black plus
    /// alpha is what makes the OS invert it per menu-bar theme.
    #[test]
    fn the_macos_tray_icon_is_still_a_template_image() {
        let img = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))
            .unwrap();
        let rgba = img.rgba();
        let coloured = rgba
            .chunks(4)
            .filter(|p| p[3] > 0 && p[..3].iter().any(|&c| c >= 40))
            .count();
        assert_eq!(
            coloured, 0,
            "a template image must be pure black; {coloured} pixels are not"
        );
    }
}
