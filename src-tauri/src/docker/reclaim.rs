//! Reclaiming what is not an image.
//!
//! Measured on a real machine: 17.35GB of images sat beside 4.65GB of
//! build cache and a 4.74GB orphaned volume. An images-only view would
//! have shown a 3.48GB opportunity while more than double that sat
//! untouched.

use super::cli::docker;
use super::parse::parse_size;

/// An orphaned volume: attached to nothing, holding space.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DanglingVolume {
    pub name: String,
    pub size_bytes: u64,
}

/// Volumes no container references.
///
/// Listed individually and never bulk-pruned. A dangling volume can hold
/// a database someone still wants -- a local dev Postgres between
/// `compose down` and the next `up` is exactly this shape. A wrongly
/// deleted image costs a rebuild; a wrongly deleted volume costs data,
/// so this is the most conservative action in the view.
pub fn dangling_volumes() -> Result<Vec<DanglingVolume>, String> {
    let names = docker(&["volume", "ls", "-q", "-f", "dangling=true"])?;
    let mut out = Vec::new();
    for name in names.lines().map(str::trim).filter(|l| !l.is_empty()) {
        // Size comes from `system df -v`, since `volume ls` does not
        // carry it. Absent size is 0 rather than a guess -- the UI says
        // "unknown" rather than implying an empty volume.
        out.push(DanglingVolume {
            name: name.to_string(),
            size_bytes: volume_size(name).unwrap_or(0),
        });
    }
    Ok(out)
}

fn volume_size(name: &str) -> Option<u64> {
    let out = docker(&["system", "df", "-v"]).ok()?;
    let mut in_volumes = false;
    for line in out.lines() {
        if line.starts_with("Local Volumes space usage") {
            in_volumes = true;
            continue;
        }
        if in_volumes {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.first() == Some(&name) {
                return cols.get(2).map(|s| parse_size(s));
            }
        }
    }
    None
}

/// Remove one volume by name. Never a bulk path.
pub fn remove_volume(name: &str) -> Result<(), String> {
    docker(&["volume", "rm", name]).map(|_| ())
}

/// Clear build cache older than the given duration.
///
/// Cache is not waste, it is speed: real build durations went 7m8s ->
/// 1m20s -> 56.9s as the cache warmed. Clearing it makes the next build
/// slow again, so this is a trade the user must make knowingly.
///
/// `until` defaults to a window rather than everything, because the last
/// day's cache is what makes today's builds fast while a month-old entry
/// is unlikely to be helping any current work.
pub fn prune_build_cache(until: Option<&str>) -> Result<u64, String> {
    let mut args = vec!["builder", "prune", "-f"];
    let filter;
    if let Some(u) = until {
        filter = format!("until={u}");
        args.push("--filter");
        args.push(&filter);
    }
    let out = docker(&args)?;
    Ok(parse_reclaimed(&out))
}

/// What a prune actually freed, read from its own output.
///
/// Reported rather than the estimate: the two diverge, and echoing an
/// estimate back as a result would be a small lie repeated every time.
pub fn parse_reclaimed(out: &str) -> u64 {
    out.lines()
        .find_map(|l| l.strip_prefix("Total reclaimed space:"))
        .map(|s| parse_size(s.trim()))
        .unwrap_or(0)
}

/// Restart the Docker engine.
///
/// `docker desktop restart` is an official subcommand -- verified
/// present -- so this needs no `pkill` incantation, which is the whole
/// point: it is the command nobody remembers.
///
/// Deliberately no force-kill. A SIGKILL risks corrupting the VM disk
/// image, and if the graceful restart fails, saying so is more useful
/// than escalating automatically.
pub fn restart_engine() -> Result<(), String> {
    docker(&["desktop", "restart"]).map(|_| ())
}

/// Start a stopped engine.
pub fn start_engine() -> Result<(), String> {
    docker(&["desktop", "start"]).map(|_| ())
}

/// Containers currently running, so a restart can name what it will stop.
///
/// A user may have a database up that they would otherwise notice the
/// hard way.
pub fn running_containers() -> Vec<String> {
    docker(&["ps", "--format", "{{.Names}}"])
        .map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a prune freed is read from its own output, never echoed from
    /// the estimate -- the two diverge, and reporting the guess as the
    /// result would be a small lie repeated every time.
    #[test]
    fn reclaimed_space_is_read_from_the_command_output() {
        let out =
            "Deleted build cache objects:\nabc123\ndef456\n\nTotal reclaimed space: 4.654GB\n";
        assert_eq!(parse_reclaimed(out), 4_654_000_000);
    }

    /// A prune that freed nothing says zero rather than inventing a
    /// number, so the toast cannot claim space that was never returned.
    #[test]
    fn a_prune_that_freed_nothing_reports_zero() {
        assert_eq!(parse_reclaimed("Total reclaimed space: 0B\n"), 0);
        // No total line at all -- older CLI, or an error path.
        assert_eq!(parse_reclaimed("nothing to do\n"), 0);
        assert_eq!(parse_reclaimed(""), 0);
    }
}
