use super::model::{Bump, EcosystemReport};
use serde::{Deserialize, Serialize};

/// Which updates to include in the handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    /// Patch only. The narrowest defensible reading of "safe" -- and it
    /// IS a reading, so the UI says patch rather than claiming safety.
    Patch,
    /// Patch and minor.
    Minor,
    All,
}

impl Filter {
    fn admits(self, bump: Bump) -> bool {
        match (self, bump) {
            (Filter::All, _) => true,
            (Filter::Minor, Bump::Patch | Bump::Minor) => true,
            (Filter::Patch, Bump::Patch) => true,
            // UNKNOWN is admitted only by All, and never silently
            // dropped from the others -- see `render`, which reports how
            // many were held back. A version we cannot classify hidden
            // from a filtered list makes that list quietly wrong in the
            // direction of "nothing to do here".
            _ => false,
        }
    }
}

/// The updates as markdown, for pasting into an agent session.
///
/// Carries enough that the agent does not have to rediscover anything:
/// the package, both versions, the size of the jump, the manifest to
/// edit, and the command that ecosystem uses.
///
/// Grouped by ecosystem, because the update commands differ and a flat
/// list would force the reader to re-derive which is which.
pub fn render(repo: &str, reports: &[EcosystemReport], filter: Filter) -> String {
    let mut out = format!("# Dependency updates for `{repo}`\n");

    let mut held_back = 0usize;
    let mut any = false;
    // Tracked separately from `any`: a run where every check FAILED has
    // nothing to list, but "nothing matched this filter" would report
    // that as good news. The errors are already printed above; this
    // stops a second, contradicting sentence joining them.
    let mut all_failed = !reports.is_empty();

    for r in reports {
        // A tool that could not run is stated, never rendered as "no
        // updates". An empty list where the check failed reads as good
        // news, which is the worst available answer.
        if let Some(err) = &r.error {
            out.push_str(&format!(
                "\n## {:?}\n\n_Could not check: {err}_\n",
                r.ecosystem
            ));
            continue;
        }
        all_failed = false;

        let rows: Vec<_> = r
            .outdated
            .iter()
            .filter(|o| {
                if filter.admits(o.bump) {
                    true
                } else {
                    if o.bump == Bump::Unknown {
                        held_back += 1;
                    }
                    false
                }
            })
            .collect();

        if rows.is_empty() {
            continue;
        }
        any = true;

        out.push_str(&format!("\n## {:?}\n\n", r.ecosystem));
        out.push_str("| package | from | to | bump | manifest |\n");
        out.push_str("|---|---|---|---|---|\n");
        for o in &rows {
            out.push_str(&format!(
                "| `{}` | {} | {} | {:?} | `{}` |\n",
                o.name, o.current, o.latest, o.bump, o.manifest
            ));
        }
        out.push_str(&format!("\nUpdate with: `{}`\n", r.ecosystem.update_hint()));
    }

    if !any && !all_failed {
        out.push_str("\nNothing matched this filter.\n");
    }

    // The count of what the filter EXCLUDED for being unclassifiable.
    // Without this line a "minors only" list looks complete when it is
    // not, and the packages it hides are precisely the ones nothing
    // could vouch for.
    if held_back > 0 {
        out.push_str(&format!(
            "\n_{held_back} package(s) had versions this could not compare, and are not \
             listed. Choose \"all\" to see them._\n"
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packages::model::{Ecosystem, Outdated};

    fn pkg(name: &str, bump: Bump) -> Outdated {
        Outdated {
            name: name.into(),
            current: "1.0.0".into(),
            latest: "1.0.1".into(),
            bump,
            ecosystem: Ecosystem::Npm,
            manifest: "package.json".into(),
        }
    }

    fn report(outdated: Vec<Outdated>) -> EcosystemReport {
        EcosystemReport {
            ecosystem: Ecosystem::Npm,
            outdated,
            error: None,
        }
    }

    #[test]
    fn the_patch_filter_admits_only_patches() {
        let r = vec![report(vec![
            pkg("a", Bump::Patch),
            pkg("b", Bump::Minor),
            pkg("c", Bump::Major),
        ])];
        let out = render("o/r", &r, Filter::Patch);
        assert!(out.contains("`a`"));
        assert!(!out.contains("`b`"));
        assert!(!out.contains("`c`"));
    }

    #[test]
    fn the_minor_filter_admits_patch_and_minor() {
        let r = vec![report(vec![
            pkg("a", Bump::Patch),
            pkg("b", Bump::Minor),
            pkg("c", Bump::Major),
        ])];
        let out = render("o/r", &r, Filter::Minor);
        assert!(out.contains("`a`") && out.contains("`b`"));
        assert!(!out.contains("`c`"));
    }

    /// The line that keeps a filtered list from being quietly wrong.
    /// Packages whose versions could not be compared are exactly the
    /// ones nothing can vouch for, and hiding them silently makes the
    /// list look complete.
    #[test]
    fn says_how_many_were_held_back_as_unclassifiable() {
        let r = vec![report(vec![
            pkg("a", Bump::Patch),
            pkg("weird", Bump::Unknown),
        ])];
        let out = render("o/r", &r, Filter::Patch);
        assert!(!out.contains("`weird`"));
        assert!(out.contains("1 package(s) had versions this could not compare"));
    }

    #[test]
    fn the_all_filter_includes_the_unclassifiable() {
        let r = vec![report(vec![pkg("weird", Bump::Unknown)])];
        let out = render("o/r", &r, Filter::All);
        assert!(out.contains("`weird`"));
        assert!(!out.contains("could not compare"));
    }

    /// A tool that could not RUN must never render as "no updates".
    #[test]
    fn a_failed_check_is_stated_not_shown_as_empty() {
        let r = vec![EcosystemReport {
            ecosystem: Ecosystem::Npm,
            outdated: vec![],
            error: Some("npm was not found".into()),
        }];
        let out = render("o/r", &r, Filter::All);
        assert!(out.contains("Could not check: npm was not found"));
        assert!(
            !out.contains("Nothing matched"),
            "an error is not an empty result"
        );
    }

    /// The agent needs the manifest and the command, or it has to
    /// rediscover both.
    #[test]
    fn carries_what_an_agent_needs_to_act() {
        let out = render("o/r", &[report(vec![pkg("a", Bump::Patch)])], Filter::All);
        assert!(out.contains("`package.json`"), "the file to edit");
        assert!(out.contains("npm install"), "the command to run");
    }
}
