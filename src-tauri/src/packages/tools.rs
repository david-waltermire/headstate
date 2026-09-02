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
    // LAST: ask the user's own login shell.
    //
    // A fixed fallback list cannot find a version-managed runtime,
    // because the path contains the version. Measured on a real machine:
    // npm and yarn both live at
    // `~/.nvm/versions/node/v24.3.0/bin/` -- and TWO node versions are
    // installed, so guessing which is current would run the wrong
    // toolchain against a lockfile.
    //
    // A login shell runs the user's own profile, so nvm/fnm/asdf/volta
    // all resolve exactly as they do in their terminal. It is the only
    // approach that is right by construction rather than by enumeration.
    //
    // Costs ~1.3s measured, which is why the result is cached for the
    // process lifetime: a version manager's active version does not
    // change while the app is open, and paying it once per program is
    // acceptable where paying it per repository would not be.
    ask_login_shell(program)
}

/// Cached results of asking the login shell, per program name.
///
/// `None` is cached too. A tool that is genuinely absent should not cost
/// a 1.3s shell spawn on every repository the user clicks.
static SHELL_LOOKUPS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Option<PathBuf>>>,
> = std::sync::OnceLock::new();

/// Where the user's own login shell says a program is.
///
/// `-l` reads the profile (which is where a version manager installs its
/// shims), `-i` makes it interactive (which some setups require to load
/// them at all), and `-c` runs one command.
fn ask_login_shell(program: &str) -> Option<PathBuf> {
    let cache =
        SHELL_LOOKUPS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(program) {
            return hit.clone();
        }
    }

    let found = run_login_shell(program);

    if let Ok(mut map) = cache.lock() {
        map.insert(program.to_string(), found.clone());
    }
    found
}

fn run_login_shell(program: &str) -> Option<PathBuf> {
    // Windows has no login-shell equivalent, and no version manager that
    // hides binaries the way nvm does on unix.
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").ok()?;
    // The program name is passed as an ARGUMENT to `command -v`, not
    // interpolated into the script, so a name containing shell
    // metacharacters cannot become a command. The names are ours
    // (`Ecosystem::program`), but that is a property of the caller
    // rather than of this function.
    let out = std::process::Command::new(shell)
        .args(["-lic", "command -v \"$1\"", "--", program])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        // A profile can print banners, so take the LAST line that looks
        // like a path rather than the first line of output.
        .rfind(|l| l.starts_with('/'))?
        .to_string();
    let p = PathBuf::from(path);
    p.is_file().then_some(p)
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

    /// The login-shell fallback must be LAST.
    ///
    /// It costs ~1.3s measured, so a tool already on PATH or in a
    /// fallback directory must never pay for it. This asserts the
    /// ordering by giving `find` a fallback that WILL match: if the
    /// shell were consulted first the result would be the shell's answer
    /// (or None), not the fallback's.
    #[test]
    fn a_fallback_hit_does_not_reach_the_login_shell() {
        let t = tempfile::TempDir::new().unwrap();
        // A name nothing real could resolve, so only the fallback can
        // produce a hit.
        let name = "headstate-fake-tool-xyz";
        let exe = t
            .path()
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let dir = t.path().to_string_lossy().to_string();

        let t0 = std::time::Instant::now();
        assert_eq!(find(name, &[dir.as_str()]), Some(exe));
        assert!(
            t0.elapsed().as_millis() < 500,
            "a fallback hit must not spawn a login shell"
        );
    }

    /// A missing tool is cached as missing.
    ///
    /// Without this, every repository the user clicks pays a ~1.3s shell
    /// spawn to re-learn that a tool they do not have is still not
    /// installed.
    #[test]
    fn a_missing_tool_is_not_looked_up_twice() {
        let name = "headstate-definitely-absent-tool";
        let first = std::time::Instant::now();
        assert!(find(name, &[]).is_none());
        let first_ms = first.elapsed().as_millis();

        let second = std::time::Instant::now();
        assert!(find(name, &[]).is_none());
        assert!(
            second.elapsed().as_millis() <= first_ms.max(50),
            "the second lookup must come from the cache"
        );
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
