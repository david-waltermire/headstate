use std::path::{Path, PathBuf};

/// Locate a package-manager executable.
///
/// A GUI-launched `.app` does NOT inherit the shell's PATH -- `auth.rs`
/// carries the same search for `gh` and `claude`, with the comment "not
/// on PATH is the norm". Confirmed again while building this: `npm` was
/// resolvable in one shell and returned 127 in another.
///
/// The distinction that matters downstream is that `None` here means
/// "the tool is not installed", which must be reported as such. Rendering
/// it as an empty update list would say "you are up to date" about a
/// check that never ran.
pub fn find(program: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    let exe = format!("{program}{}", std::env::consts::EXE_SUFFIX);

    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(&exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in fallbacks {
        let candidate = Path::new(dir).join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Where package managers land when PATH does not carry them.
///
/// Node version managers and per-user Python installs put binaries under
/// the home directory, which is exactly what a GUI app's PATH omits.
pub fn fallback_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let h = home.to_string_lossy();
        dirs.push(format!("{h}/.local/bin"));
        dirs.push(format!("{h}/.cargo/bin"));
        dirs.push(format!("{h}/.dotnet/tools"));
        dirs.push(format!("{h}/.volta/bin"));
        dirs.push(format!("{h}/.bun/bin"));
    }
    dirs.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/usr/local/share/dotnet",
        ]
        .iter()
        .map(|d| (*d).to_string()),
    );
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback branch is the whole point, so it is tested without
    /// depending on what happens to be installed on the machine.
    #[test]
    fn finds_a_program_in_a_fallback_directory() {
        let t = tempfile::TempDir::new().unwrap();
        let exe = t
            .path()
            .join(format!("faketool{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let dir = t.path().to_string_lossy().to_string();

        let found = find("faketool", &[dir.as_str()]);
        assert_eq!(found, Some(exe));
    }

    /// `None` means "not installed", which the caller MUST report rather
    /// than rendering as an empty list of updates.
    #[test]
    fn a_missing_program_is_none_not_a_guess() {
        assert!(find("headstate-nonexistent-tool", &[]).is_none());
    }

    #[test]
    fn a_directory_with_the_right_name_is_not_a_program() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(t.path().join("faketool")).unwrap();
        let dir = t.path().to_string_lossy().to_string();
        assert!(
            find("faketool", &[dir.as_str()]).is_none(),
            "a directory is not an executable"
        );
    }
}
