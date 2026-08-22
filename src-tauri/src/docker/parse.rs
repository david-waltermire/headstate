//! Parsing `docker` CLI output.
//!
//! Split from the subprocess calls so every shape below is testable
//! against captured real output rather than a hand-built approximation.

use super::model::{DiskUsage, Image};
use serde_json::Value;
use std::collections::BTreeMap;

/// Parse `docker images --format '{{json .}}'`, one JSON object per line.
///
/// Rows are merged by image ID. Docker emits one row PER TAG, so an image
/// tagged both `latest` and `13901886` appears twice at its full size --
/// summing those rows would claim 2.66GB reclaimable where 1.33GB exists.
pub fn images(out: &str) -> Vec<Image> {
    let mut by_id: BTreeMap<String, Image> = BTreeMap::new();

    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            // A malformed row is skipped, not fatal: one bad line must not
            // hide every other image.
            continue;
        };
        let id = v["ID"].as_str().unwrap_or_default().to_string();
        if id.is_empty() {
            continue;
        }
        let tag = v["Tag"].as_str().unwrap_or_default().to_string();

        let entry = by_id.entry(id.clone()).or_insert_with(|| Image {
            id,
            repository: v["Repository"].as_str().unwrap_or_default().to_string(),
            tags: Vec::new(),
            created: parse_created(v["CreatedAt"].as_str().unwrap_or_default()),
            size_bytes: parse_size(v["Size"].as_str().unwrap_or_default()),
            origin: None,
            in_use: None,
            superseded: false,
        });
        // `<none>` is Docker's placeholder for an untagged image; carrying
        // it as a tag would render a row labelled "<none>".
        if !tag.is_empty() && tag != "<none>" {
            entry.tags.push(tag);
        }
    }

    let mut all: Vec<Image> = by_id.into_values().collect();
    // Newest first, which is the order the UI wants and the order
    // supersession is computed in.
    all.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    mark_superseded(&mut all);
    all
}

/// Flag every image that has a newer sibling in the same repository.
///
/// Operates on a list already sorted newest-first, so the first image
/// seen per repository is the current one.
fn mark_superseded(images: &mut [Image]) {
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    for img in images.iter_mut() {
        img.superseded = seen.insert(img.repository.clone(), ()).is_some();
    }
}

/// Docker prints local time with a zone: `2026-08-21 21:39:15 -0400 EDT`.
///
/// Returned as RFC 3339 so the UI renders it relatively. An unparsable
/// value yields an empty string rather than a fabricated date -- a wrong
/// timestamp would drive supersession, which decides what gets deleted.
fn parse_created(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Try the string as-is FIRST. Docker prints a trailing zone
    // abbreviation on a machine with a zone database -- "2026-08-21
    // 21:39:15 -0400 EDT" -- but with TZ=UTC or on a minimal Linux
    // install or container it emits "... +0000" with none. Stripping the
    // last token unconditionally then removed the OFFSET, parsing failed,
    // and an empty date broke the sort that drives supersession, which
    // decides what gets deleted.
    if let Ok(d) = chrono::DateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S %z") {
        return d.to_rfc3339();
    }
    // Only then drop a trailing ALPHABETIC token, which is what a zone
    // abbreviation looks like. A numeric offset is never stripped.
    let without_abbrev = trimmed
        .rsplit_once(' ')
        .filter(|(_, tail)| !tail.is_empty() && tail.chars().all(char::is_alphabetic))
        .map(|(head, _)| head)
        .unwrap_or(trimmed);
    chrono::DateTime::parse_from_str(without_abbrev, "%Y-%m-%d %H:%M:%S %z")
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

/// `1.33GB`, `411MB`, `58.3MB`, `23.7kB` -> bytes.
///
/// Docker uses SI units here (kB/MB/GB, powers of 1000), not binary ones.
/// Treating them as powers of 1024 would overstate every size by 7% per
/// order of magnitude, and this number is what a reclaim estimate is
/// built from.
pub(super) fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix("GB") {
        (n, 1_000_000_000.0)
    } else if let Some(n) = s.strip_suffix("MB") {
        (n, 1_000_000.0)
    } else if let Some(n) = s.strip_suffix("kB") {
        (n, 1_000.0)
    } else if let Some(n) = s.strip_suffix("B") {
        (n, 1.0)
    } else {
        return 0;
    };
    num.trim()
        .parse::<f64>()
        .map(|v| (v * mult) as u64)
        .unwrap_or(0)
}

/// Parse the `docker system df` table.
///
/// Deliberately the table rather than `--format json`: the JSON form
/// omits the reclaimable column, which is the number the whole view is
/// about.
pub fn disk_usage(out: &str) -> DiskUsage {
    let mut du = DiskUsage::default();
    for line in out.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // TYPE TOTAL ACTIVE SIZE RECLAIMABLE [(pct)]
        if cols.len() < 5 {
            continue;
        }
        match cols[0] {
            "Images" => {
                du.images_bytes = parse_size(cols[3]);
                du.images_reclaimable_bytes = parse_size(cols[4]);
            }
            "Build" => du.build_cache_bytes = parse_size(cols[4]),
            "Local" => {
                du.volumes_bytes = parse_size(cols[4]);
                du.volumes_reclaimable_bytes = parse_size(cols[5]);
            }
            _ => {}
        }
    }
    du
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a real `docker images --format '{{json .}}'`, with
    /// the registry and service names replaced. The SHAPE is what
    /// matters: a registry-prefixed repository, SHA-shaped tags, and the
    /// same image ID appearing once per tag.
    const REAL: &str = include_str!("../../tests/fixtures/docker_images.jsonl");

    /// The bug a naive parser ships with. Docker emits one row per TAG,
    /// so an image tagged both `latest` and a SHA appears twice at its
    /// full size -- 1.33GB counted as 2.66GB, advertising reclaimable
    /// space that does not exist.
    #[test]
    fn tags_sharing_an_id_are_one_image() {
        let imgs = images(REAL);
        let ids: Vec<&str> = imgs.iter().map(|i| i.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "an image ID appears twice");

        // The fixture has a two-tag image; find it and check both tags
        // survived on one row.
        let multi = imgs
            .iter()
            .find(|i| i.tags.len() > 1)
            .expect("fixture should contain a multi-tag image");
        assert!(multi.tags.iter().any(|t| t == "latest"), "{:?}", multi.tags);
    }

    /// Sizes drive the reclaim estimate, so the units have to be right.
    /// Docker uses SI here: treating GB as 1024^3 would overstate every
    /// image by 7%.
    #[test]
    fn sizes_parse_as_si_units() {
        assert_eq!(parse_size("1.33GB"), 1_330_000_000);
        assert_eq!(parse_size("411MB"), 411_000_000);
        assert_eq!(parse_size("58.3MB"), 58_300_000);
        assert_eq!(parse_size("23.7kB"), 23_700);
        // Unparsable is zero, never a guess: a fabricated size would
        // inflate a reclaim estimate the user acts on.
        assert_eq!(parse_size("nonsense"), 0);
        assert_eq!(parse_size(""), 0);
    }

    /// The first image for a repository is current; everything older is
    /// superseded. This is what the cleanup path keys off.
    #[test]
    fn only_the_newest_image_per_repository_is_current() {
        let imgs = images(REAL);
        let mut seen: std::collections::BTreeSet<&str> = Default::default();
        for img in &imgs {
            let first = seen.insert(img.repository.as_str());
            assert_eq!(
                img.superseded, !first,
                "{} {:?} supersession is wrong",
                img.repository, img.tags
            );
        }
        // The real fixture has repos with several images, so this is not
        // a vacuous pass.
        assert!(
            imgs.iter().any(|i| i.superseded),
            "fixture should contain superseded images"
        );
    }

    /// Docker prints a zone abbreviation chrono cannot parse, after the
    /// numeric offset it duplicates.
    #[test]
    fn created_parses_dockers_local_time_format() {
        let imgs = images(REAL);
        for img in &imgs {
            assert!(
                img.created.starts_with("20") && img.created.contains('T'),
                "not RFC 3339: {:?} for {:?}",
                img.created,
                img.tags
            );
        }
    }

    /// Docker omits the zone abbreviation with TZ=UTC or on a minimal
    /// install. Stripping the last token unconditionally then removed the
    /// OFFSET, and an empty date breaks the sort that drives supersession.
    #[test]
    fn created_parses_with_and_without_a_zone_abbreviation() {
        let with = r#"{"ID":"a","Repository":"r","Tag":"t","CreatedAt":"2026-08-21 21:39:15 -0400 EDT","Size":"1GB"}"#;
        let without = r#"{"ID":"b","Repository":"r","Tag":"t","CreatedAt":"2026-08-21 21:39:15 +0000","Size":"1GB"}"#;
        for (label, line) in [("with abbrev", with), ("without abbrev", without)] {
            let imgs = images(line);
            assert_eq!(imgs.len(), 1, "{label}");
            assert!(
                imgs[0].created.starts_with("2026-08-21"),
                "{label}: got {:?}",
                imgs[0].created
            );
        }
    }

    /// A malformed line must not hide every other image.
    #[test]
    fn a_broken_row_is_skipped_not_fatal() {
        let mut input = String::from("{ this is not json\n");
        input.push_str(REAL);
        assert_eq!(images(&input).len(), images(REAL).len());
    }

    /// Captured from a real `docker system df`.
    const DF: &str = include_str!("../../tests/fixtures/docker_df.txt");

    /// The row labels are not all one word -- "Local Volumes" and "Build
    /// Cache" shift every column right, so positional indexing that works
    /// for "Images" silently reads the wrong field for them.
    #[test]
    fn disk_usage_reads_every_row_despite_two_word_labels() {
        let du = disk_usage(DF);
        assert_eq!(du.images_bytes, 17_350_000_000, "images size");
        assert_eq!(
            du.images_reclaimable_bytes, 2_194_000_000,
            "images reclaimable"
        );
        assert_eq!(du.build_cache_bytes, 4_654_000_000, "build cache");
        assert_eq!(du.volumes_bytes, 4_735_000_000, "volumes size");
        assert_eq!(
            du.volumes_reclaimable_bytes, 4_735_000_000,
            "volumes reclaimable"
        );
    }

    /// Images are only part of the problem: on this real machine 17.35GB
    /// of images sat beside 9.39GB of cache and volumes. A view that
    /// listed only images would leave most of the waste invisible.
    #[test]
    fn the_non_image_waste_is_material() {
        let du = disk_usage(DF);
        let non_image = du.build_cache_bytes + du.volumes_reclaimable_bytes;
        assert!(
            non_image > du.images_reclaimable_bytes,
            "non-image reclaim {non_image} should exceed image reclaim {}",
            du.images_reclaimable_bytes
        );
    }

    /// The safety gate must fail CLOSED. A failed `docker ps` used to
    /// return an empty list via unwrap_or_default(), which reads as
    /// "nothing is in use" -- un-gating removal on images a running
    /// container holds, AND defeating remove_image's delete-time
    /// re-check, since both called the same function.
    #[test]
    fn an_unknown_in_use_state_is_never_stale() {
        use crate::docker::{Origin, OriginSource};
        let img = Image {
            id: "i".into(),
            repository: "r".into(),
            tags: vec![],
            created: String::new(),
            size_bytes: 0,
            origin: Some(Origin {
                repo_path: "/code/proj".into(),
                context: None,
                commit: "abc".into(),
                subject: "a change".into(),
                merged: true,
                source: OriginSource::TagResolution,
            }),
            // We could not ask. NOT "nothing is using it".
            in_use: None,
            superseded: true,
        };
        assert!(
            !img.is_stale(),
            "an image whose in-use state is unknown must not enter the bulk set"
        );
    }

    /// Stale is narrower than superseded: an image on a live branch may
    /// still be wanted, and only the provably-dead set is bulk-removable.
    #[test]
    fn stale_requires_superseded_merged_and_unused() {
        use crate::docker::{Origin, OriginSource};
        let origin = |merged: bool| {
            Some(Origin {
                repo_path: "/code/proj".into(),
                context: None,
                commit: "abc".into(),
                subject: "a change".into(),
                merged,
                source: OriginSource::TagResolution,
            })
        };
        let img = |superseded, in_use: Option<bool>, merged| Image {
            id: "i".into(),
            repository: "r".into(),
            tags: vec![],
            created: String::new(),
            size_bytes: 0,
            origin: origin(merged),
            in_use,
            superseded,
        };

        assert!(img(true, Some(false), true).is_stale());
        assert!(
            !img(false, Some(false), true).is_stale(),
            "current is never stale"
        );
        assert!(
            !img(true, Some(true), true).is_stale(),
            "in use is never stale"
        );
        assert!(
            !img(true, Some(false), false).is_stale(),
            "an unmerged branch may still want its image"
        );

        // Unknown provenance is not stale: we cannot prove the branch
        // landed, so it does not enter the bulk set.
        let mut unknown = img(true, Some(false), true);
        unknown.origin = None;
        assert!(!unknown.is_stale());
    }
}
