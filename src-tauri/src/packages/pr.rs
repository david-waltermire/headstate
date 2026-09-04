//! Turning an update run into a pull request.
//!
//! Phase 2 of the update wizard. Phase 1 deliberately stopped at a
//! worktree so that what these resolvers actually DO could be observed
//! before anything irreversible was built on top -- and it found that
//! asking npm for `4.17.21` left `^4.17.21` in the manifest, a caret
//! RANGE rather than the pin. An update now carries the constraint's
//! own shape through, so a project that pinned exactly stays pinned.
//!
//! The body still reports requested and resolved side by side, because
//! the resolvers are the authority on what landed and this is the only
//! place the two can be compared. What changed is what a mismatch now
//! MEANS: with the shape preserved, a differing row is a genuine
//! surprise worth investigating rather than the expected result on
//! every row.

use super::apply::{RunReport, UpdateOutcome};
use super::model::Ecosystem;

/// Whether a pull request may be opened for this ecosystem.
///
/// npm and yarn only, because those are the two whose manifest is read
/// back and CONFIRMED. Poetry, uv, .NET and CocoaPods report
/// `resolved_constraint` as `None` -- reading those manifests safely
/// needs a real TOML/XML parser -- so a body could not describe what
/// landed, and the whole point of this description is that it is
/// accurate about that.
pub fn can_describe(eco: Ecosystem) -> bool {
    matches!(eco, Ecosystem::Npm | Ecosystem::Yarn)
}

/// The pull request title.
///
/// Names the packages when there are few enough to read, and counts them
/// otherwise. A title that is a wall of names is not a title.
pub fn title(results: &[UpdateOutcome]) -> String {
    let ok: Vec<&UpdateOutcome> = results.iter().filter(|r| r.error.is_none()).collect();
    match ok.as_slice() {
        [] => "chore(deps): no updates applied".to_string(),
        [one] => format!("chore(deps): update {} to {}", one.name, one.requested),
        many if many.len() <= 3 => format!(
            "chore(deps): update {}",
            many.iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        many => format!("chore(deps): update {} packages", many.len()),
    }
}

/// The pull request body.
///
/// Reports REQUESTED and RESOLVED side by side, and flags every row
/// where they differ. That difference is not an edge case: it is what
/// npm does to a pinned request every time, and a reviewer who reads
/// "4.17.21" in a description and finds "^4.17.21" in the diff has been
/// misled by the tool that opened the pull request.
pub fn body(report: &RunReport) -> String {
    let mut out = vec![
        "Dependency updates applied by Headstate.".to_string(),
        String::new(),
    ];

    let ok: Vec<&UpdateOutcome> = report
        .results
        .iter()
        .filter(|r| r.error.is_none())
        .collect();
    if !ok.is_empty() {
        out.push("| package | requested | in the manifest |".into());
        out.push("|---|---|---|".into());
        for r in &ok {
            let resolved = r.resolved_constraint.as_deref().unwrap_or("not read back");
            let differs = r
                .resolved_constraint
                .as_deref()
                .is_some_and(|c| c != r.requested);
            // The flag goes on the ROW, not in a footnote: a reviewer
            // scanning the table has to see it without reading prose.
            let note = if differs { " ⚠️" } else { "" };
            out.push(format!(
                "| `{}` | `{}` | `{}`{note} |",
                r.name, r.requested, resolved
            ));
        }
        if ok.iter().any(|r| {
            r.resolved_constraint
                .as_deref()
                .is_some_and(|c| c != r.requested)
        }) {
            out.push(String::new());
            out.push(
                "⚠️ The manifest holds something different from what was requested. \
                 A resolver reconciles the whole dependency graph, so a pinned request \
                 commonly becomes a range -- `npm install lodash@4.17.21` writes \
                 `^4.17.21`. The right-hand column is what actually landed."
                    .into(),
            );
        }
    }

    let failed: Vec<&UpdateOutcome> = report
        .results
        .iter()
        .filter(|r| r.error.is_some())
        .collect();
    if !failed.is_empty() {
        // Stated, never omitted. A pull request that silently dropped
        // the packages it could not update would read as complete.
        out.push(String::new());
        out.push("### Not applied".into());
        out.push(String::new());
        for r in &failed {
            out.push(format!(
                "- `{}` → `{}`: {}",
                r.name,
                r.requested,
                r.error.as_deref().unwrap_or("unknown error")
            ));
        }
    }

    let changed: Vec<&str> = ok
        .iter()
        .flat_map(|r| r.changed_files.iter().map(String::as_str))
        .collect();
    if changed.is_empty() && !ok.is_empty() {
        out.push(String::new());
        out.push(
            "No files changed. That usually means a constraint in the manifest \
             pinned the package below the version requested."
                .into(),
        );
    }

    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(name: &str, requested: &str, resolved: Option<&str>) -> UpdateOutcome {
        UpdateOutcome {
            name: name.into(),
            requested: requested.into(),
            changed_files: vec!["package.json".into()],
            output: String::new(),
            resolved_constraint: resolved.map(str::to_string),
            error: None,
        }
    }

    fn report(results: Vec<UpdateOutcome>) -> RunReport {
        RunReport {
            worktree: "/w".into(),
            branch: "headstate/update-x".into(),
            ecosystems: vec![Ecosystem::Npm],
            results,
        }
    }

    /// THE case phase 1 was built to discover: npm rewrites a pinned
    /// request into a caret range.
    #[test]
    fn reports_both_versions_and_flags_the_difference() {
        let b = body(&report(vec![outcome(
            "lodash",
            "4.17.21",
            Some("^4.17.21"),
        )]));
        assert!(b.contains("4.17.21"), "the requested version");
        assert!(b.contains("^4.17.21"), "and what actually landed");
        assert!(b.contains("⚠️"), "the difference must be flagged");
        assert!(b.contains("resolver"), "and explained");
    }

    /// No warning when they agree -- a flag on every row teaches nothing.
    #[test]
    fn does_not_flag_a_row_that_matches() {
        let b = body(&report(vec![outcome(
            "lodash",
            "^4.17.21",
            Some("^4.17.21"),
        )]));
        assert!(!b.contains("⚠️"));
    }

    /// An unread constraint is stated as unread, never as agreement.
    #[test]
    fn an_unreadable_constraint_says_so() {
        let b = body(&report(vec![outcome("requests", "2.32.0", None)]));
        assert!(b.contains("not read back"));
        assert!(!b.contains("⚠️"), "unknown is not a mismatch");
    }

    /// A pull request that silently dropped what it could not update
    /// would read as complete.
    #[test]
    fn failures_are_listed_not_omitted() {
        let mut failed = outcome("express", "5.0.0", None);
        failed.error = Some("peer dependency conflict".into());
        failed.changed_files.clear();
        let b = body(&report(vec![
            outcome("lodash", "4.17.21", Some("^4.17.21")),
            failed,
        ]));
        assert!(b.contains("Not applied"));
        assert!(b.contains("peer dependency conflict"));
    }

    /// Succeeded and changed nothing is a real outcome, usually a
    /// manifest constraint pinning below the request.
    #[test]
    fn says_when_nothing_changed() {
        let mut none = outcome("lodash", "5.0.0", Some("^4.17.21"));
        none.changed_files.clear();
        let b = body(&report(vec![none]));
        assert!(b.contains("No files changed"));
    }

    #[test]
    fn titles_name_a_few_packages_and_count_many() {
        assert!(title(&[outcome("lodash", "4.17.21", None)]).contains("lodash"));
        let three: Vec<_> = ["a", "b", "c"]
            .iter()
            .map(|n| outcome(n, "1.0.0", None))
            .collect();
        assert!(title(&three).contains("a, b, c"));
        let many: Vec<_> = (0..9)
            .map(|i| outcome(&format!("p{i}"), "1.0.0", None))
            .collect();
        assert!(title(&many).contains("9 packages"));
    }

    /// Only where the constraint is verifiable. The others report
    /// `resolved_constraint` as None, so the body could not describe
    /// what landed -- which is this description's entire purpose.
    #[test]
    fn only_npm_and_yarn_may_be_described() {
        assert!(can_describe(Ecosystem::Npm));
        assert!(can_describe(Ecosystem::Yarn));
        for eco in [
            Ecosystem::Poetry,
            Ecosystem::Uv,
            Ecosystem::Dotnet,
            Ecosystem::Cocoapods,
            Ecosystem::Swift,
            Ecosystem::Terraform,
        ] {
            assert!(!can_describe(eco), "{eco:?} cannot be described accurately");
        }
    }
}
