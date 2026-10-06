//! The Marumado this app runs on this machine itself, for someone without a Marumado checkout: the published image
//! (ghcr.io, built by .github/workflows/image.yml), pinned to the app's version, started with a compose file the app
//! writes into its config folder. What `make up` and scripts/compose-mounts.sh do for a checkout, from the settings
//! the first-run page asks for: which folders hold projects, and whether Marumado may use your SSH keys.
//! Installing a newer app brings the matching Marumado: the tag changes, compose pulls it and recreates the container.
//! Docker containers run Marumado with the host's processes and network, which only Linux gives them.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the image is published; a fork builds the app with MARUMADO_IMAGE_REPO set to its own.
const REPO: &str = match option_env!("MARUMADO_IMAGE_REPO") {
    Some(r) => r,
    None => "ghcr.io/synkied/marumado",
};

/// Whether this machine can run it (see the module's comment).
pub const SUPPORTED: bool = cfg!(target_os = "linux");

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Host {
    /// The folders that hold projects (each subfolder is one), made visible read-only.
    #[serde(default)]
    pub folders: Vec<String>,
    /// Your ~/.ssh, read-only: to watch other machines (Machines) and reach agents over SSH.
    #[serde(default)]
    pub ssh: bool,
    pub secret_key: String,
    /// Another image than the app's own version's (a test build, a fork's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// The image for this version of the app, unless the settings or MARUMADO_IMAGE name another.
pub fn image(host: &Host, version: &str) -> String {
    host.image
        .clone()
        .or_else(|| std::env::var("MARUMADO_IMAGE").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| format!("{REPO}:{version}"))
}

/// A random hex string, for the access token and Django's secret key.
pub fn random(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system's random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The folder the compose file lives in: the app's config folder.
pub fn dir(config_dir: &Path) -> PathBuf {
    config_dir.join("marumado")
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(fallback))
}

fn id(flag: &str) -> String {
    Command::new("id")
        .arg(flag)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Herdr's binary on this machine, where it is usually installed.
fn herdr_bin() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("herdr"));
    std::iter::once(home().join(".local/bin/herdr")).chain(on_path).find(|p| p.is_file())
}

/// A string as YAML reads it: JSON's double-quoted strings are YAML's too.
fn q(s: impl AsRef<str>) -> String {
    serde_json::to_string(s.as_ref()).unwrap_or_default()
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A folder as written in the settings: no trailing slash, spaces around trimmed.
pub fn tidy(folder: &str) -> String {
    let f = folder.trim();
    match f.trim_end_matches('/') {
        "" => f.to_string(),
        t => t.to_string(),
    }
}

/// The compose file for these settings. Folders keep their host path in the container, so the processes' folders
/// match the projects'; only folders that exist are mounted (Docker would make them, empty and owned by root).
pub fn compose(host: &Host, token: &str, image: &str) -> String {
    let mut volumes = vec![q("/var/run/docker.sock:/var/run/docker.sock"), q("marumado-data:/app/backend/data")];
    let mut env: Vec<(&str, String)> = vec![
        ("MARUMADO_BIND", "127.0.0.1".into()),
        ("MARUMADO_PORT", "7878".into()),
        ("MARUMADO_TOKEN", token.into()),
        ("MARUMADO_SECRET_KEY", host.secret_key.clone()),
        ("MARUMADO_ALLOWED_HOSTS", "*".into()),
        ("MARUMADO_HERDR_TERMINAL", "control".into()),
    ];
    let mut folders: Vec<String> = host.folders.iter().map(|f| tidy(f)).filter(|f| f.starts_with('/')).collect();
    folders.sort();
    folders.dedup();
    folders.retain(|f| Path::new(f).is_dir());
    for f in &folders {
        volumes.push(q(format!("{f}:{f}:ro")));
    }
    env.push(("MARUMADO_PROJECT_DIRS", folders.join(",")));
    // Your home folder too, read-only, so any folder in it can be added from the app (Projects → Folders). Not
    // root's: the container's own home is /root, and it writes there (ssh keys).
    let mut visible = folders.clone();
    let home_dir = path_str(&home());
    if home_dir != "/root" && home_dir != "/" && home().is_dir() {
        volumes.push(q(format!("{home_dir}:{home_dir}:ro")));
        visible.push(home_dir.clone());
    }
    // What the app can see, for its "can't see that folder" message, and what ~ means there.
    env.push(("MARUMADO_VISIBLE_DIRS", visible.join(",")));
    env.push(("MARUMADO_HOST_HOME", home_dir));

    let ssh = home().join(".ssh");
    if host.ssh && ssh.is_dir() {
        let s = path_str(&ssh);
        volumes.push(q(format!("{s}:{s}:ro")));
        env.push(("MARUMADO_SSH_SOURCE", s));
        env.push(("MARUMADO_SSH_USER", id("-un")));
    }
    // Herdr on this machine: its folder (rather than the socket itself, which a restart of Herdr replaces) and binary.
    let herdr = xdg("XDG_CONFIG_HOME", ".config").join("herdr");
    if herdr.is_dir() {
        let h = path_str(&herdr);
        volumes.push(q(format!("{h}:{h}")));
        env.push(("MARUMADO_HERDR_SOCKET", path_str(&herdr.join("herdr.sock"))));
    }
    if let Some(bin) = herdr_bin() {
        let b = path_str(&bin);
        volumes.push(q(format!("{b}:{b}:ro")));
        env.push(("MARUMADO_HERDR_BIN", b));
    }
    // smolvm, when installed: its install and machines, at the same paths, used as you (see core/herdr.py).
    let smolvm = home().join(".smolvm");
    if smolvm.is_dir() {
        let s = path_str(&smolvm);
        volumes.push(q(format!("{s}:{s}:ro")));
        for d in [
            xdg("XDG_DATA_HOME", ".local/share").join("smolvm"),
            xdg("XDG_CACHE_HOME", ".cache").join("smolvm"),
        ] {
            if d.is_dir() {
                let d = path_str(&d);
                volumes.push(q(format!("{d}:{d}")));
            }
        }
        env.push(("MARUMADO_SMOLVM_HOME", path_str(&home())));
        env.push(("MARUMADO_SMOLVM_USER", format!("{}:{}", id("-u"), id("-g"))));
    }

    let mut out = String::from(
        "# Written by Marumado's desktop app from its settings (the first-run page): changes here are overwritten.\n\
         # As compose.yaml in Marumado's repository, with the published image instead of a build.\n\
         name: marumado\n\nservices:\n  marumado:\n",
    );
    out += &format!("    image: {}\n", q(image));
    out += "    container_name: marumado\n    restart: unless-stopped\n    network_mode: host\n    pid: host\n    cap_add:\n      - SYS_PTRACE\n";
    out += "    environment:\n";
    for (k, v) in &env {
        out += &format!("      {k}: {}\n", q(v));
    }
    out += "    volumes:\n";
    for v in &volumes {
        out += &format!("      - {v}\n");
    }
    out += "\nvolumes:\n  marumado-data:\n";
    out
}

/// Writes the compose file (readable by you only: it holds the token): whether it changed.
pub fn write(dir: &Path, text: &str) -> std::io::Result<bool> {
    let file = dir.join("compose.yaml");
    if std::fs::read_to_string(&file).is_ok_and(|old| old == text) {
        return Ok(false);
    }
    std::fs::create_dir_all(dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(file)?.write_all(text.as_bytes())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        Host {
            folders: vec!["/tmp/".into(), "/nonexistent".into(), "relative".into()],
            ssh: false,
            secret_key: "s".into(),
            image: None,
        }
    }

    #[test]
    fn the_image_follows_the_app() {
        assert!(image(&host(), "1.2.3").ends_with(":1.2.3"));
        let pinned = Host {
            image: Some("me/marumado:test".into()),
            ..host()
        };
        assert_eq!(image(&pinned, "1.2.3"), "me/marumado:test");
    }

    #[test]
    fn only_folders_that_exist_are_mounted() {
        let text = compose(&host(), "tok\"en", "img:1");
        assert!(text.contains("- \"/tmp:/tmp:ro\""));
        assert!(!text.contains("nonexistent"));
        assert!(!text.contains("relative"));
        assert!(text.contains("MARUMADO_TOKEN: \"tok\\\"en\""), "quoted for YAML");
        assert!(text.contains("image: \"img:1\""));
    }

    #[test]
    fn the_home_folder_is_visible() {
        let h = path_str(&home());
        let text = compose(&host(), "t", "img:1");
        if h != "/root" && home().is_dir() {
            assert!(text.contains(&format!("- \"{h}:{h}:ro\"")));
            assert!(text.contains(&format!("MARUMADO_VISIBLE_DIRS: \"/tmp,{h}\"")));
        } else {
            assert!(text.contains("MARUMADO_VISIBLE_DIRS: \"/tmp\""));
        }
        assert!(text.contains(&format!("MARUMADO_HOST_HOME: \"{h}\"")));
    }

    #[test]
    fn random_strings() {
        let (a, b) = (random(16), random(16));
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
