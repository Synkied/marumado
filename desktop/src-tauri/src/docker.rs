//! Starts the Marumado on this machine when it isn't running, so opening the app is enough. Two kinds:
//! - a Marumado checkout (its `compose.yaml`): its containers come up as `make up` would bring them up;
//! - the app's own (host.rs): the published image, from the compose file the app writes.
//!
//! Only for a local address. Quitting the app stops what it started, and only that: a Marumado started otherwise keeps
//! running.

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

/// What to start Marumado from.
#[derive(Clone, Debug, PartialEq)]
pub enum Stack {
    /// A Marumado checkout's folder.
    Checkout(PathBuf),
    /// The folder of the compose file the app wrote (host.rs), and the image it names.
    Hosted { dir: PathBuf, image: String },
}

impl Stack {
    fn dir(&self) -> &Path {
        match self {
            Stack::Checkout(dir) | Stack::Hosted { dir, .. } => dir,
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Stack::Checkout(dir) => format!("in {}", dir.display()),
            Stack::Hosted { image, .. } => format!("from {image}"),
        }
    }
}

/// One start at a time (the app's start and the first-run page's Connect may both ask).
static STARTING: Mutex<()> = Mutex::new(());
/// What the app started, to stop it when it quits.
static STARTED: Mutex<Option<Stack>> = Mutex::new(None);

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
    let out = Command::new(program).args(args).current_dir(dir).output().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{program} isn't installed"),
        _ => format!("{program}: {e}"),
    })?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim().to_string())
}

/// Whether Docker, with its compose plugin, is installed and answers: why not, if it doesn't.
pub fn check() -> Result<(), String> {
    let here = Path::new(".");
    run(here, "docker", &["compose", "version"]).map_err(|e| {
        if e.ends_with("isn't installed") {
            "Docker isn't installed: Marumado runs in it. Install Docker Engine, then try again".to_string()
        } else {
            format!("Docker's compose plugin is missing ({e}): install docker-compose-plugin, then try again")
        }
    })?;
    run(here, "docker", &["info", "--format", "{{.ServerVersion}}"]).map_err(|e| {
        if e.contains("permission denied") {
            "Docker refuses you: add yourself to the docker group (sudo usermod -aG docker $USER), log out and back in".to_string()
        } else {
            format!("Docker isn't running ({e})")
        }
    })
}

/// Whether the image is on this machine already (else starting downloads it first).
pub fn has_image(image: &str) -> bool {
    run(Path::new("."), "docker", &["image", "inspect", "--format", "{{.Id}}", image]).is_ok()
}

fn up(stack: &Stack) -> Result<(), String> {
    match stack {
        // Never set up here yet: `make up` writes .env and the folder mounts first.
        Stack::Checkout(dir) if !dir.join(".env").is_file() => run(dir, "make", &["up"]),
        // Pulls the image first when this version's isn't here; recreates the container when the file changed.
        _ => run(stack.dir(), "docker", &["compose", "up", "-d"]),
    }
}

/// Starts the containers if Marumado is local and not answering (or always, with `force`: its settings or version
/// changed), then waits for it: whether it was started.
pub fn ensure(url: &str, stack: Option<&Stack>, force: bool) -> Result<bool, String> {
    if !is_local(url) {
        return Ok(false);
    }
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if !force && answers(url) {
        return Ok(false);
    }
    let Some(stack) = stack else { return Ok(false) };
    let until = Instant::now() + PATIENCE;
    loop {
        match up(stack) {
            Ok(()) => {
                *STARTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(stack.clone());
                break;
            }
            Err(e) if Instant::now() > until => return Err(format!("couldn't start Marumado {}: {e}", stack.describe())),
            Err(_) => sleep(Duration::from_secs(5)),
        }
    }
    while !answers(url) {
        if Instant::now() > until {
            return Err("Marumado's container started but it doesn't answer yet".into());
        }
        sleep(Duration::from_millis(500));
    }
    Ok(true)
}

/// Stops the containers the app started (`docker compose stop`: kept, and quick to start again), if it did.
pub fn stop_started() -> Result<(), String> {
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    match STARTED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(stack) => run(stack.dir(), "docker", &["compose", "stop"]),
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
