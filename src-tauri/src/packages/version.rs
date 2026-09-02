use super::model::Bump;

/// How big a jump it is from `current` to `latest`.
///
/// Deliberately NOT a semver crate. Three of the five ecosystems here do
/// not use semver:
///
/// - .NET routinely ships four-part versions (`1.2.3.4`).
/// - PEP 440 allows epochs (`1!2.0`), local versions (`1.0+local`), and
///   suffixes like `1.0rc1` that a semver parser rejects.
/// - npm and Poetry are close to semver but still see `~`, `^`, and `v`
///   prefixes in the wild.
///
/// So this compares dotted numeric components and answers `Unknown` when
/// it genuinely cannot tell. That third answer is the point: a version
/// silently classified as major would hide from a "minors only" filter,
/// and one silently classified as minor would be offered as safe. Being
/// unable to compare is a fact the user should see, not one to guess past.
pub fn bump(current: &str, latest: &str) -> Bump {
    let (Some(a), Some(b)) = (numeric_parts(current), numeric_parts(latest)) else {
        return Bump::Unknown;
    };
    if a == b {
        return Bump::Unknown;
    }

    // Compare position by position, treating a missing component as 0 so
    // `1.2` and `1.2.0` are the same version rather than incomparable.
    let len = a.len().max(b.len());
    for i in 0..len {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x == y {
            continue;
        }
        // A DOWNGRADE is not a bump. It happens when a registry yanks a
        // release, and calling it an upgrade would put it in a filtered
        // list as something safe to apply.
        if y < x {
            return Bump::Unknown;
        }
        return match i {
            0 => Bump::Major,
            1 => Bump::Minor,
            // Everything past minor is a patch. .NET's fourth component
            // is a revision, and treating it as its own tier would add a
            // category no filter asks for.
            _ => Bump::Patch,
        };
    }
    Bump::Unknown
}

/// The leading dotted numeric components of a version string.
///
/// Returns None when there is nothing comparable, which is what produces
/// `Bump::Unknown` rather than a confident wrong answer.
///
/// Stops at the first component that is not purely numeric, so `1.0rc1`
/// compares as `1.0` -- enough to place the jump, and honest about the
/// rest. A pre-release suffix that changes ordering (`1.0rc1` < `1.0`) is
/// exactly the case where "we cannot tell" beats a guess, and equal
/// numeric parts already answer Unknown.
fn numeric_parts(v: &str) -> Option<Vec<u64>> {
    // Strip what people put in front of versions: `v1.2.3`, `^1.2.3`,
    // `~1.2.3`, `>=1.2.3`. PEP 440 epochs (`1!2.0`) are dropped down to
    // the release segment, which is what is comparable across schemes.
    let v = v.trim();
    let v = v.trim_start_matches(['v', 'V', '^', '~', '=', '>', '<', ' ']);
    let v = v.split_once('!').map_or(v, |(_, rest)| rest);
    // Local versions and build metadata are not ordering information.
    let v = v.split(['+', ' ']).next().unwrap_or(v);

    let parts: Vec<u64> = v
        .split('.')
        .map_while(|p| {
            let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
            // A component that does not START with a digit ends the
            // comparable prefix: `1.x` is `1`, not `1.0`.
            if digits.is_empty() || digits.len() != p.len() {
                // Take the numeric head of this component, then stop.
                return digits.parse().ok();
            }
            digits.parse().ok()
        })
        .collect();

    (!parts.is_empty()).then_some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_ordinary_semver_jumps() {
        assert_eq!(bump("1.2.3", "2.0.0"), Bump::Major);
        assert_eq!(bump("1.2.3", "1.3.0"), Bump::Minor);
        assert_eq!(bump("1.2.3", "1.2.4"), Bump::Patch);
    }

    /// .NET ships four-part versions. The fourth is a revision, and it
    /// belongs with patch rather than in a tier of its own that no
    /// filter asks for.
    #[test]
    fn a_dotnet_revision_counts_as_a_patch() {
        assert_eq!(bump("1.2.3.4", "1.2.3.5"), Bump::Patch);
        assert_eq!(bump("1.2.3.4", "1.3.0.0"), Bump::Minor);
    }

    /// Missing components are zero, so `1.2` and `1.2.0` are the same
    /// version rather than incomparable.
    #[test]
    fn a_missing_component_reads_as_zero() {
        assert_eq!(bump("1.2", "1.2.0"), Bump::Unknown, "same version");
        assert_eq!(bump("1.2", "1.2.1"), Bump::Patch);
        assert_eq!(bump("1", "2"), Bump::Major);
    }

    /// The prefixes people actually write.
    #[test]
    fn strips_range_and_v_prefixes() {
        assert_eq!(bump("v1.2.3", "v1.2.4"), Bump::Patch);
        assert_eq!(bump("^1.2.3", "1.3.0"), Bump::Minor);
        assert_eq!(bump("~1.2.3", "2.0.0"), Bump::Major);
    }

    /// PEP 440: epochs and local versions are not ordering information
    /// a cross-ecosystem comparison can use.
    #[test]
    fn handles_pep440_shapes() {
        assert_eq!(bump("1!1.0", "1!2.0"), Bump::Major);
        assert_eq!(bump("1.0+local", "1.1+other"), Bump::Minor);
    }

    /// The third answer, and the reason it exists. A version that cannot
    /// be compared must NOT be guessed: called major it hides from a
    /// "minors only" filter, called minor it is offered as safe.
    #[test]
    fn an_uncomparable_version_is_unknown_not_guessed() {
        assert_eq!(bump("", "1.0.0"), Bump::Unknown);
        assert_eq!(bump("latest", "1.0.0"), Bump::Unknown);
        assert_eq!(bump("1.0.0", "not-a-version"), Bump::Unknown);
        assert_eq!(bump("*", "2.0.0"), Bump::Unknown);
    }

    /// A DOWNGRADE is not a bump. Registries yank releases, and calling
    /// it an upgrade would put it in a filtered list as safe to apply.
    #[test]
    fn a_downgrade_is_never_reported_as_an_upgrade() {
        assert_eq!(bump("2.0.0", "1.9.9"), Bump::Unknown);
        assert_eq!(bump("1.2.3", "1.2.2"), Bump::Unknown);
    }

    /// Equal versions are not an update at all.
    #[test]
    fn an_equal_version_is_not_a_bump() {
        assert_eq!(bump("1.2.3", "1.2.3"), Bump::Unknown);
    }

    /// A pre-release suffix is where "we cannot tell" beats a guess:
    /// `1.0rc1` orders BEFORE `1.0`, which numeric comparison cannot
    /// see. Equal numeric parts already answer Unknown, so this lands in
    /// the right place by construction rather than by accident.
    #[test]
    fn a_prerelease_suffix_does_not_produce_a_confident_answer() {
        assert_eq!(bump("1.0rc1", "1.0"), Bump::Unknown);
    }
}
