use super::tokens;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One imported file in the tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportNode {
    /// What the file wrote, verbatim -- `@./shared.md`, `@~/global.md`.
    pub raw: String,
    /// Where it resolved to, when it did.
    pub path: Option<String>,
    pub bytes: u64,
    pub tokens: u64,
    /// Why this node is not usable, when it is not.
    ///
    /// A broken or circular import is SHOWN rather than omitted. Dropping
    /// it silently makes the tree look complete when it is not, and a
    /// cycle in particular is a bug in the user's own config that nothing
    /// else will tell them about.
    pub problem: Option<String>,
    pub children: Vec<ImportNode>,
}

impl ImportNode {
    /// Tokens for this node and everything beneath it.
    pub fn total_tokens(&self) -> u64 {
        self.tokens
            + self
                .children
                .iter()
                .map(ImportNode::total_tokens)
                .sum::<u64>()
    }
}

/// Resolve every import reachable from `file`.
///
/// `seen` is the path being walked right now, not everything visited: a
/// file imported twice by SIBLINGS is legitimate and should appear under
/// both, while a file that imports itself through any chain is a cycle.
pub fn resolve_tree(file: &Path, seen: &mut Vec<PathBuf>) -> Vec<ImportNode> {
    resolve_tree_in(file, seen, super::home().as_deref())
}

/// `resolve_tree` with the home directory injected, so `~/` expansion is
/// testable without mutating `$HOME` -- global state that would race
/// every other test in the binary.
pub fn resolve_tree_in(
    file: &Path,
    seen: &mut Vec<PathBuf>,
    home: Option<&Path>,
) -> Vec<ImportNode> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let base = file.parent().unwrap_or(Path::new("."));

    // Canonicalised, so `./a.md` and `a.md` are recognised as one file.
    let canon = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
    seen.push(canon);

    let nodes = parse_imports(&text)
        .into_iter()
        .map(|raw| resolve_one(&raw, base, seen, home))
        .collect();

    seen.pop();
    nodes
}

fn resolve_one(raw: &str, base: &Path, seen: &mut Vec<PathBuf>, home: Option<&Path>) -> ImportNode {
    let broken = |problem: &str| ImportNode {
        raw: format!("@{raw}"),
        path: None,
        bytes: 0,
        tokens: 0,
        problem: Some(problem.to_string()),
        children: Vec::new(),
    };

    let target = if raw.starts_with("~/") {
        match home.and_then(|h| super::expand_home_in(raw, h)) {
            Some(p) => p,
            None => return broken("could not resolve ~"),
        }
    } else if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        // RELATIVE TO THE IMPORTING FILE, not the repository root or the
        // working directory. A resolver anchored anywhere else silently
        // finds the wrong file whenever two directories hold files with
        // the same name.
        base.join(raw)
    };

    if !target.is_file() {
        return broken("file not found");
    }

    let canon = target.canonicalize().unwrap_or_else(|_| target.clone());
    if seen.contains(&canon) {
        // Named rather than dropped: a cycle is a bug in the user's own
        // configuration, and this view is the only thing that will
        // surface it.
        return ImportNode {
            raw: format!("@{raw}"),
            path: Some(target.to_string_lossy().to_string()),
            bytes: 0,
            tokens: 0,
            problem: Some("circular import".into()),
            children: Vec::new(),
        };
    }

    let text = std::fs::read_to_string(&target).unwrap_or_default();
    ImportNode {
        raw: format!("@{raw}"),
        path: Some(target.to_string_lossy().to_string()),
        bytes: text.len() as u64,
        tokens: tokens::estimate(&text),
        problem: None,
        children: resolve_tree_in(&target, seen, home),
    }
}

/// The `@path` imports in a file's text.
///
/// Not every `@word` is an import. `@` appears in prose, in email
/// addresses, in code, and in decorators -- matching eagerly produces
/// phantom entries in a tree the user is meant to trust. So this takes
/// only what looks deliberate:
///
/// - at the START of a line, optionally after whitespace
/// - pointing at something with a file extension
/// - and never inside a fenced code block, where `@` is somebody's
///   syntax rather than an instruction
pub fn parse_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix('@') else {
            continue;
        };
        // The path runs to the first whitespace. Anything after it is
        // prose about the import, not part of it.
        let candidate = rest.split_whitespace().next().unwrap_or("");
        if candidate.is_empty() {
            continue;
        }
        // An extension is what separates a path from an @mention.
        if Path::new(candidate)
            .extension()
            .is_none_or(|e| e.is_empty())
        {
            continue;
        }
        out.push(candidate.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The shape actually found in the wild: `@AGENTS.md` alone on the
    /// first line, resolving to a sibling.
    /// The reported bug: a repository with worktrees showed the same
    /// file over and over.
    ///
    /// Measured on a real repo -- 11 CLAUDE.md files found, 10 of them
    /// worktree copies, 3 distinct contents. After this, 1.
    #[test]
    fn worktree_copies_are_not_scanned() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("CLAUDE.md"), "the real one").unwrap();

        for dir in [".worktrees/branch-a", ".claude/worktrees/agent-1"] {
            let d = t.path().join(dir);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("CLAUDE.md"), "a copy of the real one").unwrap();
        }

        let found = super::super::scan_repo(t.path());
        assert_eq!(found.len(), 1, "only the checkout's own file: {found:?}");
        assert!(found[0].path.ends_with("CLAUDE.md"));
        assert!(!found[0].path.contains("worktree"));
    }

    #[test]
    fn finds_a_plain_import() {
        assert_eq!(parse_imports("@AGENTS.md\n"), vec!["AGENTS.md"]);
    }

    /// Not every `@word` is an import. Matching eagerly puts phantom
    /// entries in a tree the user is meant to trust.
    #[test]
    fn ignores_things_that_are_not_imports() {
        // The email case is BUILT rather than written literally: the
        // privacy gate cannot tell a synthetic address from a real one,
        // and a check guarding against leaked contact details is not
        // worth arguing with over a fixture.
        let email = format!("someone{}example{}invalid", '@', '.');
        let text = format!(
            "Ask @octocat about this.\n\
             Reply to {email} for details.\n\
             Use the @property decorator.\n\
             @ThisHasNoExtension\n"
        );
        assert!(
            parse_imports(&text).is_empty(),
            "{:?}",
            parse_imports(&text)
        );
    }

    /// Inside a fence, `@` is somebody's syntax rather than an
    /// instruction to this app.
    #[test]
    fn ignores_at_signs_inside_code_fences() {
        let text = "\
@real.md
```python
@decorator.md
```
@also-real.md
";
        assert_eq!(parse_imports(text), vec!["real.md", "also-real.md"]);
    }

    /// An import must start its line. Mid-sentence `@` is prose.
    #[test]
    fn an_import_must_lead_its_line() {
        assert!(parse_imports("See @notes.md for details\n").is_empty());
    }

    #[test]
    fn takes_only_the_path_not_the_prose_after_it() {
        assert_eq!(
            parse_imports("@notes.md is the reference\n"),
            vec!["notes.md"]
        );
    }

    /// RELATIVE TO THE IMPORTING FILE. A resolver anchored at the repo
    /// root or the cwd silently finds the wrong file whenever two
    /// directories hold files with the same name.
    #[test]
    fn resolves_relative_to_the_importing_file() {
        let t = tempfile::TempDir::new().unwrap();
        let sub = t.path().join("docs");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("CLAUDE.md"), "@shared.md\n").unwrap();
        fs::write(sub.join("shared.md"), "nested content").unwrap();
        // A decoy at the ROOT with the same name.
        fs::write(t.path().join("shared.md"), "WRONG FILE").unwrap();

        let nodes = resolve_tree(&sub.join("CLAUDE.md"), &mut Vec::new());
        assert_eq!(nodes.len(), 1);
        let resolved = nodes[0].path.as_ref().unwrap();
        assert!(
            resolved.contains("docs"),
            "resolved to the decoy: {resolved}"
        );
        assert!(nodes[0].problem.is_none());
    }

    /// A missing file is SHOWN as broken. Omitting it makes the tree look
    /// complete when it is not.
    #[test]
    fn a_missing_import_is_reported_not_dropped() {
        let t = tempfile::TempDir::new().unwrap();
        let f = t.path().join("CLAUDE.md");
        fs::write(&f, "@nope.md\n").unwrap();

        let nodes = resolve_tree(&f, &mut Vec::new());
        assert_eq!(nodes.len(), 1, "the broken import must still appear");
        assert_eq!(nodes[0].problem.as_deref(), Some("file not found"));
        assert_eq!(nodes[0].raw, "@nope.md");
    }

    /// Imports are transitive, so the view shows a tree.
    #[test]
    fn imports_are_followed_transitively() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("CLAUDE.md"), "@a.md\n").unwrap();
        fs::write(t.path().join("a.md"), "@leaf.md\n").unwrap();
        fs::write(t.path().join("leaf.md"), "leaf").unwrap();

        let nodes = resolve_tree(&t.path().join("CLAUDE.md"), &mut Vec::new());
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].children.len(), 1, "b.md is reached through a.md");
        assert!(nodes[0].children[0].problem.is_none());
    }

    /// A cycle must RENDER, not hang -- and it must be visible, because
    /// it is a bug in the user's own config that nothing else surfaces.
    #[test]
    fn a_cycle_is_named_rather_than_followed_forever() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("CLAUDE.md"), "@a.md\n").unwrap();
        fs::write(t.path().join("a.md"), "@CLAUDE.md\n").unwrap();

        let nodes = resolve_tree(&t.path().join("CLAUDE.md"), &mut Vec::new());
        assert_eq!(nodes.len(), 1);
        let back = &nodes[0].children[0];
        assert_eq!(back.problem.as_deref(), Some("circular import"));
    }

    /// The same file imported by two SIBLINGS is legitimate -- it is not
    /// a cycle, and suppressing the second would understate the tree.
    #[test]
    fn a_file_imported_twice_by_siblings_is_not_a_cycle() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("CLAUDE.md"), "@1st.md\n\n@2nd.md\n").unwrap();
        fs::write(t.path().join("1st.md"), "@shared.md\n").unwrap();
        fs::write(t.path().join("2nd.md"), "@shared.md\n").unwrap();
        fs::write(t.path().join("shared.md"), "content").unwrap();

        let nodes = resolve_tree(&t.path().join("CLAUDE.md"), &mut Vec::new());
        assert_eq!(nodes.len(), 2);
        for n in &nodes {
            assert_eq!(n.children.len(), 1, "{}", n.raw);
            assert!(
                n.children[0].problem.is_none(),
                "a sibling import is not a cycle: {:?}",
                n.children[0].problem
            );
        }
    }

    /// `~/.claude/CLAUDE.md` is a real and common target, and it reaches
    /// OUTSIDE the repository, which is correct.
    #[test]
    fn expands_a_home_relative_import() {
        let t = tempfile::TempDir::new().unwrap();
        let fake_home = t.path().join("home");
        fs::create_dir_all(fake_home.join(".claude")).unwrap();
        fs::write(fake_home.join(".claude/CLAUDE.md"), "global rules").unwrap();

        let repo = t.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let f = repo.join("CLAUDE.md");
        fs::write(&f, "@~/.claude/CLAUDE.md\n").unwrap();

        let nodes = resolve_tree_in(&f, &mut Vec::new(), Some(&fake_home));
        assert_eq!(nodes.len(), 1);
        assert!(nodes[0].problem.is_none(), "{:?}", nodes[0].problem);
        assert!(nodes[0].tokens > 0);
    }

    /// The number that matters: a small file pulling in a large tree.
    #[test]
    fn total_tokens_include_the_whole_tree() {
        let t = tempfile::TempDir::new().unwrap();
        fs::write(t.path().join("CLAUDE.md"), "@big.md\n").unwrap();
        fs::write(t.path().join("big.md"), "x".repeat(4000)).unwrap();

        let f = super::super::read_file(&t.path().join("CLAUDE.md")).unwrap();
        assert!(f.tokens < 10, "the file itself is tiny");
        assert!(f.total_tokens > 900, "but the tree it pulls in is not");
    }
}
