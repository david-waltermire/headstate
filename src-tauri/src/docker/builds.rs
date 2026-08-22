//! Build history: what was built, how long it took, and from where.
//!
//! Docker Desktop has a Builds page showing durations. What it does not
//! do -- and the reason this earns its place -- is connect a build to the
//! images it produced or the worktree it came from.

use super::cli::docker;
use super::origin::parse_build_inspect;
use serde::Serialize;
use serde_json::Value;

/// One build.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Build {
    /// The opaque ref buildx identifies it by.
    pub reference: String,
    /// The build target, e.g. `octocat-api/docker`.
    pub name: String,
    pub status: String,
    /// RFC 3339.
    pub started: String,
    pub duration_secs: f64,
    pub total_steps: u64,
    pub cached_steps: u64,
    /// The build context directory, and the revision it built. Resolved
    /// lazily via `inspect`, which is slower than the listing.
    pub context: Option<String>,
    pub revision: Option<String>,
}

impl Build {
    /// What fraction of steps came from cache, 0-100.
    ///
    /// Shown WITH the duration rather than instead of it: duration alone
    /// says "slow", but duration plus cache ratio says why. Real data
    /// shows the same target going 7m8s -> 1m20s -> 56.9s as the cache
    /// warms, and a sudden return to 7 minutes means something
    /// invalidated it.
    pub fn cache_percent(&self) -> u64 {
        if self.total_steps == 0 {
            return 0;
        }
        self.cached_steps * 100 / self.total_steps
    }

    /// Whether the build failed. Failures are as interesting as
    /// successes -- arguably more -- so they are never filtered out.
    pub fn failed(&self) -> bool {
        self.status != "Completed"
    }
}

/// Parse `docker buildx history ls --format '{{json .}}'`.
pub fn parse_history(out: &str) -> Vec<Build> {
    let mut all: Vec<Build> = out
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let created = v["created_at"].as_str()?;
            let completed = v["completed_at"].as_str().unwrap_or(created);
            Some(Build {
                reference: v["ref"].as_str()?.to_string(),
                name: v["name"].as_str().unwrap_or_default().to_string(),
                status: v["status"].as_str().unwrap_or_default().to_string(),
                started: created.to_string(),
                duration_secs: duration_between(created, completed),
                total_steps: v["total_steps"].as_u64().unwrap_or(0),
                cached_steps: v["cached_steps"].as_u64().unwrap_or(0),
                context: None,
                revision: None,
            })
        })
        .collect();
    all.sort_by(|a, b| b.started.cmp(&a.started));
    all
}

fn duration_between(start: &str, end: &str) -> f64 {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (parse(start), parse(end)) {
        (Some(a), Some(b)) => (b - a).num_milliseconds() as f64 / 1000.0,
        // An unparsable timestamp yields zero rather than a guess: a
        // fabricated duration is worse than an obviously absent one.
        _ => 0.0,
    }
}

/// Fill in the build context and revision for one build.
///
/// Separate from the listing because `inspect` is a subprocess per build
/// -- fetching it for 50 builds up front would make the page slow for
/// data only the selected build needs.
pub fn enrich(build: &mut Build) {
    // `history ls` reports a namespaced ref; `inspect` wants the last
    // segment.
    let id = build
        .reference
        .rsplit('/')
        .next()
        .unwrap_or(&build.reference);
    if let Ok(out) = docker(&["buildx", "history", "inspect", id]) {
        if let Some((context, revision)) = parse_build_inspect(&out) {
            build.context = Some(context);
            build.revision = Some(revision);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a real `docker buildx history ls`, with target names
    /// replaced. 50 builds including two failures.
    const HISTORY: &str = include_str!("../../tests/fixtures/buildx_history.jsonl");

    /// Duration alone says "slow". Duration WITH the cache ratio says
    /// why -- and a target that suddenly returns to its cold time means
    /// something invalidated the cache.
    #[test]
    fn cache_percentage_comes_from_the_step_counts() {
        let builds = parse_history(HISTORY);
        let b = builds
            .iter()
            .find(|b| b.total_steps == 43)
            .expect("fixture has a 43-step build");
        assert_eq!(b.cached_steps, 21);
        assert_eq!(b.cache_percent(), 48);
    }

    /// A build with no steps must not divide by zero.
    #[test]
    fn a_build_with_no_steps_reports_no_cache_rather_than_panicking() {
        let b = Build {
            reference: "r".into(),
            name: "n".into(),
            status: "Completed".into(),
            started: String::new(),
            duration_secs: 0.0,
            total_steps: 0,
            cached_steps: 0,
            context: None,
            revision: None,
        };
        assert_eq!(b.cache_percent(), 0);
    }

    /// Failed builds are as interesting as successful ones -- arguably
    /// more, since a failing build is what the user is investigating.
    /// The real fixture contains two.
    #[test]
    fn failed_builds_are_kept_not_filtered() {
        let builds = parse_history(HISTORY);
        let failed: Vec<&Build> = builds.iter().filter(|b| b.failed()).collect();
        assert!(
            !failed.is_empty(),
            "the fixture has Error builds; they must survive parsing"
        );
        assert!(builds.len() > failed.len(), "not everything failed");
    }

    /// Durations come from the timestamp pair, and the real data spans
    /// sub-second to multi-minute.
    #[test]
    fn durations_are_computed_from_the_timestamps() {
        let builds = parse_history(HISTORY);
        let longest = builds
            .iter()
            .max_by(|a, b| a.duration_secs.total_cmp(&b.duration_secs))
            .unwrap();
        assert!(
            longest.duration_secs > 60.0,
            "expected a multi-minute build, got {}",
            longest.duration_secs
        );
        assert!(builds.iter().all(|b| b.duration_secs >= 0.0));
    }

    /// Newest first, which is the order the page wants.
    #[test]
    fn builds_are_newest_first() {
        let builds = parse_history(HISTORY);
        for pair in builds.windows(2) {
            assert!(pair[0].started >= pair[1].started);
        }
    }

    /// A malformed line must not hide every other build.
    #[test]
    fn a_broken_row_is_skipped_not_fatal() {
        let mut input = String::from("{ not json\n");
        input.push_str(HISTORY);
        assert_eq!(parse_history(&input).len(), parse_history(HISTORY).len());
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// `cargo test --lib live_builds -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_builds_with_context() {
        let out = docker(&["buildx", "history", "ls", "--format", "{{json .}}"]).unwrap();
        let mut builds = parse_history(&out);
        println!("{} builds", builds.len());
        for b in builds.iter_mut().take(4) {
            enrich(b);
            println!(
                "  {:24} {:>7.1}s  {:>3}% cached  {}  ctx={:?}",
                b.name,
                b.duration_secs,
                b.cache_percent(),
                b.status,
                b.context
                    .as_deref()
                    .map(|c| c.rsplit('/').next().unwrap_or(c))
            );
        }
    }
}
