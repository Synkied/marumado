//! Starts the Marumado on this machine when it isn't running, so opening the app is enough: its containers come up as
//! `make up` would bring them up. Only for a local address, and only from a Marumado checkout (its `compose.yaml`).
//! Quitting the app stops what it started, and only that: a Marumado started otherwise keeps running.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The checkout the app was built from, unless the config names another.
const BUILT_FROM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
/// Docker may still be starting with the session: how long to keep trying, and how long Marumado may take to answer.
const PATIENCE: Duration = Duration::from_secs(90);

/// One start at a time (the app's start and the first-run page's Connect may both ask).
static STARTING: Mutex<()> = Mutex::new(());
/// The checkout whose containers the app started, to stop them when it quits.
static STARTED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The Marumado checkout whose containers to start: the configured one, else the one the app was built from.
pub fn folder(configured: Option<&str>) -> Option<PathBuf> {
    let dir = PathBuf::from(configured.unwrap_or(BUILT_FROM));
    let dir = dir.canonicalize().unwrap_or(dir);
    dir.join("compose.yaml").is_file().then_some(dir)
}

fn address(url: &str) -> Option<(String, u16)> {
    let u = url::Url::parse(url).ok()?;
    Some((u.host_str()?.trim_matches(['[', ']']).to_string(), u.port_or_known_default()?))
}

/// Whether the address is this machine's.
pub fn is_local(url: &str) -> bool {
    address(url).is_some_and(|(host, _)| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

/// Whether something listens at the address.
pub fn answers(url: &str) -> bool {
    let Some((host, port)) = address(url) else { return false };
    let addrs: Vec<SocketAddr> = (host.as_str(), port).to_socket_addrs().map(Iterator::collect).unwrap_or_default();
    addrs.iter().any(|a| TcpStream::connect_timeout(a, Duration::from_secs(1)).is_ok())
}

fn run(dir: &Path, program: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim().to_string())
}

/// Whether `ensure` will start Marumado: it is local, not answering, and there is a checkout to start it from.
pub fn will_start(url: &str, configured: Option<&str>) -> bool {
    is_local(url) && folder(configured).is_some() && !answers(url)
}

/// Starts the containers if Marumado is local and not answering, then waits for it: whether it was started.
pub fn ensure(url: &str, configured: Option<&str>) -> Result<bool, String> {
    if !is_local(url) {
        return Ok(false);
    }
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if answers(url) {
        return Ok(false);
    }
    let Some(dir) = folder(configured) else { return Ok(false) };
    let until = Instant::now() + PATIENCE;
    loop {
        // Never set up here yet: `make up` writes .env and the folder mounts first.
        let started = if dir.join(".env").is_file() {
            run(&dir, "docker", &["compose", "up", "-d"])
        } else {
            run(&dir, "make", &["up"])
        };
        match started {
            Ok(()) => {
                *STARTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.clone());
                break;
            }
            Err(e) if Instant::now() > until => return Err(format!("couldn't start Marumado's containers in {}: {e}", dir.display())),
            Err(_) => sleep(Duration::from_secs(5)),
        }
    }
    while !answers(url) {
        if Instant::now() > until {
            return Err("Marumado's containers started but it doesn't answer yet".into());
        }
        sleep(Duration::from_millis(500));
    }
    Ok(true)
}

/// Stops the containers the app started (`docker compose stop`: kept, and quick to start again), if it did.
pub fn stop_started() -> Result<(), String> {
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    match STARTED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(dir) => run(&dir, "docker", &["compose", "stop"]),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_addresses() {
        assert!(is_local("http://127.0.0.1:7878"));
        assert!(is_local("http://localhost:7878"));
        assert!(is_local("http://[::1]:7878"));
        assert!(!is_local("http://192.168.1.20:7878"));
        assert!(!is_local("https://marumado.example"));
    }

    #[test]
    fn the_checkout_built_from() {
        assert!(folder(None).is_some_and(|d| d.join("desktop").is_dir()));
        assert!(folder(Some("/nonexistent")).is_none());
    }
}
