//! Talking to the `docker` CLI.
//!
//! Shelling out rather than adding an API client: the CLI is already
//! installed and authenticated, and it hides the unix-socket versus
//! named-pipe difference across the three platforms this now ships to.
//! `--format '{{json .}}'` gives structured output with no dependency.

use super::model::DockerState;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Docker calls are bounded, like every other subprocess here. A daemon
/// mid-restart can leave the CLI waiting indefinitely, and a wedged view
/// is exactly what this feature exists to help with.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Where Docker installs beyond `PATH`.
///
/// A GUI-launched app does not inherit the login shell's PATH -- the trap
/// that broke v1.0.0's `gh` lookup, and Docker Desktop's binaries live
/// inside the .app bundle where nothing else looks.
#[cfg(target_os = "macos")]
const FALLBACK_DIRS: &[&str] = &[
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
];

#[cfg(all(unix, not(target_os = "macos")))]
const FALLBACK_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin", "/snap/bin"];

#[cfg(windows)]
const FALLBACK_DIRS: &[&str] = &[
    r"C:\Program Files\Docker\Docker\resources\bin",
    r"C:\ProgramData\DockerDesktop\version-bin",
];

/// Locate the `docker` binary, or `None`.
pub fn find_docker() -> Option<PathBuf> {
    find_docker_in(FALLBACK_DIRS)
}

/// `find_docker` with the fallback list injected, so the fallback branch
/// is testable without depending on what is installed on the runner.
pub fn find_docker_in(fallbacks: &[&str]) -> Option<PathBuf> {
    let exe = format!("docker{}", std::env::consts::EXE_SUFFIX);

    if let Ok(explicit) = std::env::var("HEADSTATE_DOCKER") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
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

/// Run a docker subcommand, bounded.
///
/// Returns stderr on failure rather than a summary: `docker rmi`'s
/// refusal names the container holding the image, which is the useful
/// part.
pub fn docker(args: &[&str]) -> Result<String, String> {
    let bin = find_docker().ok_or_else(|| "docker was not found".to_string())?;
    run_bounded(&bin, args)
}

fn run_bounded(bin: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // Poll rather than block: `wait_timeout` would be another dependency
    // for one call site, and the granularity here is irrelevant against a
    // 20s ceiling.
    let deadline = std::time::Instant::now() + CALL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!(
                    "docker did not respond within {}s",
                    CALL_TIMEOUT.as_secs()
                ));
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Whether Docker can be talked to.
///
/// A stopped daemon is NORMAL, not an error: unlike git, Docker is
/// frequently off. Reporting it as a failure -- or worse, as an empty
/// image list -- would say "your machine is clean" when the truth is "we
/// could not ask".
pub fn state() -> DockerState {
    if find_docker().is_none() {
        return DockerState::NotInstalled;
    }
    match docker(&["info", "--format", "{{.ServerVersion}}"]) {
        Ok(v) if !v.trim().is_empty() => DockerState::Running,
        // `docker info` succeeding with no server version means the CLI
        // answered but the daemon did not.
        Ok(_) => DockerState::NotRunning,
        Err(e) if is_daemon_down(&e) => DockerState::NotRunning,
        // The single most common Linux Docker failure: the user is not in
        // the `docker` group. It used to fall through to Unknown, which
        // the UI rendered as "not running" with a Start button that
        // cannot help -- and the actionable fix was never surfaced.
        Err(e) if is_permission_denied(&e) => DockerState::PermissionDenied,
        Err(e) => DockerState::Unknown(e),
    }
}

/// Whether an error means "the daemon is not up" rather than something
/// the user should chase.
/// Whether the daemon refused us rather than being absent.
fn is_permission_denied(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("permission denied") && e.contains("docker")
}

fn is_daemon_down(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("cannot connect to the docker daemon")
        || e.contains("is the docker daemon running")
        || e.contains("error during connect")
        || e.contains("the system cannot find the file specified")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_docker(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(format!("docker{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&p, "#!/bin/sh\necho ok\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    /// A GUI app does not inherit the login shell's PATH -- the v1.0.0
    /// bug -- and Docker Desktop's binaries live inside the .app bundle.
    #[test]
    fn finds_docker_outside_path_via_fallbacks() {
        let tmp = std::env::temp_dir().join(format!("hs-dk-fb-{}", std::process::id()));
        let want = fake_docker(&tmp);
        let empty = std::env::temp_dir().join(format!("hs-dk-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();

        temp_env::with_vars(
            [
                ("PATH", Some(empty.to_str().unwrap())),
                ("HEADSTATE_DOCKER", None),
            ],
            || {
                let fallbacks = [tmp.to_str().unwrap()];
                assert_eq!(find_docker_in(&fallbacks), Some(want.clone()));
            },
        );
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    /// The override is the escape hatch for a non-standard install, and
    /// the only thing a user can act on themselves.
    #[test]
    fn the_override_wins_over_path() {
        let a = std::env::temp_dir().join(format!("hs-dk-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("hs-dk-b-{}", std::process::id()));
        fake_docker(&a);
        let want = fake_docker(&b);
        temp_env::with_vars(
            [
                ("PATH", Some(a.to_str().unwrap())),
                ("HEADSTATE_DOCKER", Some(want.to_str().unwrap())),
            ],
            || assert_eq!(find_docker_in(&[]), Some(want.clone())),
        );
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    /// Fallback paths must belong to this platform: searching a Windows
    /// path on macOS is wasted work, and vice versa.
    #[test]
    fn fallback_dirs_belong_to_this_platform() {
        for dir in FALLBACK_DIRS {
            if cfg!(windows) {
                assert!(dir.contains(':'), "{dir} is not a Windows path");
            } else {
                assert!(dir.starts_with('/'), "{dir} is not a Unix path");
            }
        }
    }

    /// A stopped daemon is a STATE, not a failure. Reporting it as an
    /// error -- or as an empty image list -- would tell the user their
    /// machine is clean when the truth is that we could not ask.
    #[test]
    fn a_stopped_daemon_reads_as_not_running() {
        for msg in [
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            "error during connect: Get \"http://.../version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
        ] {
            assert!(is_daemon_down(msg), "should be recognised: {msg}");
        }
    }

    /// But a genuine failure must not be mistaken for a stopped daemon,
    /// or a real problem renders as "just start Docker".
    #[test]
    fn other_failures_are_not_mistaken_for_a_stopped_daemon() {
        for msg in [
            "permission denied while trying to connect to the Docker daemon socket",
            "invalid reference format",
        ] {
            assert!(!is_daemon_down(msg), "should not be a down-daemon: {msg}");
        }
    }

    /// The most common Linux failure gets its own state, because its fix
    /// -- joining the docker group -- is nothing like "start Docker".
    #[test]
    fn a_permissions_failure_is_its_own_state() {
        assert!(is_permission_denied(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
        ));
        // Not every permission error is Docker's.
        assert!(!is_permission_denied("permission denied: /etc/shadow"));
        assert!(!is_permission_denied("invalid reference format"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Against the real daemon. Run manually:
    /// `cargo test --lib live_docker -- --ignored --nocapture`
    /// Reported: "the Docker images page is still missing the button to
    /// remove all superseded images". The button exists but is gated on
    /// `superseded > stale`, so this prints BOTH counts from the real
    /// classifier -- the gate cannot be reasoned about from the
    /// docker output alone, since `stale` also depends on origin
    /// resolution and container state.
    #[test]
    #[ignore]
    fn live_superseded_versus_stale_counts() {
        // The REPO LIST matters: origin resolution needs it, and
        // `is_stale` requires an origin whose branch merged. Passing the
        // real scanned directories is what makes this reflect the page.
        let repos: Vec<std::path::PathBuf> = std::fs::read_dir(
            std::path::Path::new(&std::env::var("HOME").unwrap()).join("code/enclave"),
        )
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
        let imgs = crate::docker::classify(&repos).expect("docker must be running");
        let superseded = imgs
            .iter()
            .filter(|i| i.superseded && i.in_use == Some(false))
            .count();
        let stale = imgs.iter().filter(|i| i.is_stale()).count();
        let unknown_use = imgs.iter().filter(|i| i.in_use.is_none()).count();
        let with_origin = imgs.iter().filter(|i| i.origin.is_some()).count();
        println!(
            "total={} superseded_unused={} stale={} unknown_use={} with_origin={}",
            imgs.len(),
            superseded,
            stale,
            unknown_use,
            with_origin
        );
        println!(
            "button shows when superseded > stale: {}",
            superseded > stale
        );
    }

    #[test]
    #[ignore]
    fn live_docker_state_and_images() {
        println!("state: {:?}", state());
        let out = docker(&["images", "--format", "{{json .}}"]).unwrap();
        let imgs = crate::docker::images(&out);
        println!("{} distinct images", imgs.len());
        for i in imgs.iter().take(5) {
            println!(
                "  {:12} {:>10}  superseded={}  tags={:?}",
                &i.id[..12.min(i.id.len())],
                i.size_bytes,
                i.superseded,
                i.tags
            );
        }
        let df = docker(&["system", "df"]).unwrap();
        println!("{:#?}", crate::docker::disk_usage(&df));
    }
}
