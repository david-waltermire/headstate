//! The switch behind the verbose `[diag]` timing log.
//!
//! Added in v3.5.3 to diagnose a slow review query on one machine, and
//! kept as a setting rather than removed: the next "it is slow on my
//! machine" report wants exactly this log, and asking someone to
//! install a special build to produce it is far worse than a checkbox.

use std::sync::atomic::{AtomicBool, Ordering};

/// A process-global flag rather than a value threaded through.
///
/// The call sites span the poll loop, the Tauri commands, and
/// `github::client` -- and the client has no `AppHandle` and no
/// business acquiring one just to decide whether to log. A single
/// atomic read is also cheap enough to sit in a per-request path, which
/// a settings lookup would not be.
///
/// This is deliberately NOT the pattern used for the refused-field
/// count, which was a global counter and had to be replaced because it
/// raced across polls and across tests. The difference is that this is
/// a single write on a settings change and a read everywhere else, with
/// no accumulation to lose.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Apply the user's preference. Called at startup and whenever settings
/// are saved.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Whether `[diag]` lines should be written.
///
/// `Relaxed` is right: nothing else is ordered against this, and a log
/// line landing one request either side of a settings change carries no
/// consequence.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Log a `[diag]` line, but only when diagnostics are on.
///
/// A macro rather than a function so the arguments are not formatted
/// when logging is off -- these lines interpolate elapsed times and
/// counts on every request, and paying that cost for output nobody
/// asked for is the thing the switch exists to avoid.
#[macro_export]
macro_rules! diag {
    ($($arg:tt)*) => {
        if $crate::diag::enabled() {
            log::info!($($arg)*);
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Defaults OFF, so a user who never opens Settings never pays for
    /// a diagnosis they did not ask for.
    ///
    /// Asserted on `UiPrefs::default()` rather than on the static: the
    /// static is process-global and other tests in this binary flip it,
    /// so reading it here would be a race, not a guarantee. The
    /// preference is what actually decides the startup value, so it is
    /// the honest thing to pin.
    #[test]
    fn diagnostics_default_to_off() {
        assert!(!crate::poll::UiPrefs::default().diagnostic_logging);
    }

    /// The macro must actually consult the switch.
    ///
    /// Asserted by installing a REAL logger and counting records.
    /// Counting argument evaluation instead does not work: `log::info!`
    /// has its own level check and skips formatting when no logger is
    /// installed, so an ungated macro and a gated one both evaluate
    /// nothing in a bare unit test -- a version of this test that
    /// counted arguments passed even with the gate deleted.
    #[test]
    fn the_macro_writes_nothing_while_off() {
        use std::sync::atomic::AtomicUsize;

        static RECORDS: AtomicUsize = AtomicUsize::new(0);
        struct Counting;
        impl log::Log for Counting {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, _: &log::Record) {
                RECORDS.fetch_add(1, Ordering::Relaxed);
            }
            fn flush(&self) {}
        }

        // `set_boxed_logger` is process-global and one-shot. If another
        // test already installed one this returns Err, and counting
        // would then measure nothing -- so skip rather than assert
        // against a logger we do not own.
        if log::set_boxed_logger(Box::new(Counting)).is_err() {
            return;
        }
        log::set_max_level(log::LevelFilter::Info);

        set_enabled(false);
        crate::diag!("[diag] must not be written");
        assert_eq!(
            RECORDS.load(Ordering::Relaxed),
            0,
            "a diag line was written while diagnostics were off"
        );

        set_enabled(true);
        crate::diag!("[diag] must be written");
        assert_eq!(RECORDS.load(Ordering::Relaxed), 1);
        set_enabled(false);
    }

    #[test]
    fn the_switch_round_trips() {
        set_enabled(true);
        assert!(enabled());
        set_enabled(false);
        assert!(!enabled());
    }
}
