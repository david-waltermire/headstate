//! CLAUDE.md files and the tree of files they import.
//!
//! Read-only. Nothing here writes to a file, so a wrong render costs a
//! confused reader rather than a corrupted config.
//!
//! The import resolution is the actual work; everything else is a file
//! browser. Scanning one real code root found 67 CLAUDE.md files and
//! exactly ONE import in use, so the resolver is written from the syntax
//! rather than from what happened to exist locally.
//!
//! Nothing here talks to GitHub.

pub mod imports;
pub mod tokens;

pub use imports::{resolve_tree, ImportNode};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One CLAUDE.md and the tree it pulls in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeFile {
    pub path: String,
    pub bytes: u64,
    /// Estimated tokens for this file alone.
    pub tokens: u64,
    /// Estimated tokens for this file PLUS everything it imports.
    ///
    /// The number that matters: a 2 KB CLAUDE.md pulling in 40 KB of
    /// imports is the case this view exists to surface, and the file's
    /// own size says nothing about it.
    pub total_tokens: u64,
    pub imports: Vec<ImportNode>,
}

/// Every CLAUDE.md under a repository, with its import tree resolved.
///
/// Skips the usual heavy directories -- an artifact tree can hold tens of
/// thousands of directories and none of them holds a project's
/// instructions.
pub fn scan_repo(repo: &Path) -> Vec<ClaudeFile> {
    const SKIP: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        ".terraform",
        "dist",
        "build",
    ];
    let mut out = Vec::new();
    let mut stack = vec![repo.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            if meta.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(e.path());
                }
                continue;
            }
            if !name.eq_ignore_ascii_case("CLAUDE.md") {
                continue;
            }
            if let Some(f) = read_file(&e.path()) {
                out.push(f);
            }
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// One file, with its imports resolved.
pub fn read_file(path: &Path) -> Option<ClaudeFile> {
    let text = std::fs::read_to_string(path).ok()?;
    let bytes = text.len() as u64;
    let own = tokens::estimate(&text);
    let imports = resolve_tree(path, &mut Vec::new());
    // The tree's tokens plus this file's own.
    let total = own + imports.iter().map(ImportNode::total_tokens).sum::<u64>();

    Some(ClaudeFile {
        path: path.to_string_lossy().to_string(),
        bytes,
        tokens: own,
        total_tokens: total,
        imports,
    })
}

/// Expand a leading `~` against a given home directory.
///
/// The home is a PARAMETER so the expansion can be tested without
/// mutating the process environment -- `$HOME` is global state, and a
/// test that changes it races every other test in the binary.
pub(crate) fn expand_home_in(raw: &str, home: &Path) -> Option<PathBuf> {
    let rest = raw.strip_prefix("~/")?;
    Some(home.join(rest))
}

/// The user's home directory, when there is one.
pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
