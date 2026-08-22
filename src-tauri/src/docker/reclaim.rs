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

    // ONE `system df -v`, not one per volume. That call costs 1.94s cold
    // and 117ms warm, and already returns every volume's size -- the old
    // per-volume version parsed out one row and discarded the rest, so
    // 20 dangling volumes cost 2.35s for data one call contains. Same
    // shape as the quadratic worktree scan that once took ten minutes.
    //
    // Reading them together also makes the figures consistent: they now
    // come from one daemon snapshot rather than N.
    let sizes = volume_sizes().unwrap_or_default();

    Ok(names
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|name| DanglingVolume {
            name: name.to_string(),
            // Absent stays 0, which the UI renders as an em dash rather
            // than implying an empty volume.
            size_bytes: sizes.get(name).copied().unwrap_or(0),
        })
        .collect())
}

/// Every volume's size, from one `system df -v`.
fn volume_sizes() -> Option<std::collections::HashMap<String, u64>> {
    let out = docker(&["system", "df", "-v"]).ok()?;
    Some(parse_volume_table(&out))
}

/// The "Local Volumes space usage" section of `docker system df -v`.
fn parse_volume_table(out: &str) -> std::collections::HashMap<String, u64> {
    let mut sizes = std::collections::HashMap::new();
    let mut in_volumes = false;
    for line in out.lines() {
        if line.starts_with("Local Volumes space usage") {
            in_volumes = true;
            continue;
        }
        if !in_volumes {
            continue;
        }
        // A blank line ends the section; another header starts a
        // different one, and reading past it would attribute some other
        // table's numbers to volumes.
        if line.trim().is_empty() {
            break;
        }
        if line.starts_with("VOLUME NAME") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if let (Some(name), Some(size)) = (cols.first(), cols.get(2)) {
            sizes.insert((*name).to_string(), parse_size(size));
        }
    }
    sizes
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
pub fn running_containers() -> Result<Vec<String>, String> {
    // Propagates rather than defaulting: the restart dialog saying "no
    // containers are running" when it could not ask is false
    // reassurance about work the restart is going to kill.
    docker(&["ps", "--format", "{{.Names}}"]).map(|s| {
        s.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    })
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

    /// One `system df -v` for every volume, not one per volume. The
    /// section ends at a blank line: reading past it would attribute
    /// another table's numbers to volumes.
    #[test]
    fn volume_sizes_are_read_from_one_table() {
        let table = "Images space usage:\n\
                     REPOSITORY TAG IMAGE ID\n\
                     \n\
                     Local Volumes space usage:\n\
                     VOLUME NAME     LINKS     SIZE\n\
                     demo_pg_data    0         4.735GB\n\
                     other_vol       1         100MB\n\
                     \n\
                     Build cache usage: 4.654GB\n\
                     CACHE ID  SIZE\n\
                     abc123    999GB\n";
        let sizes = parse_volume_table(table);
        assert_eq!(sizes.get("demo_pg_data"), Some(&4_735_000_000));
        assert_eq!(sizes.get("other_vol"), Some(&100_000_000));
        // The build-cache row must NOT be read as a volume.
        assert_eq!(sizes.get("abc123"), None);
        assert_eq!(sizes.len(), 2);
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
