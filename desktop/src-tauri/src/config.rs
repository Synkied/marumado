//! What the app remembers: Marumado's address, its access token (for the tray, which reads the API on its own), and
//! whether to notify, and where Marumado's checkout is if not where the app was built. Kept in the app's config folder, readable by its owner only.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_URL: &str = "http://127.0.0.1:7878";

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// Marumado's origin, without a trailing slash.
    pub url: String,
    pub token: String,
    #[serde(default = "yes")]
    pub notify: bool,
    /// The Marumado checkout whose containers the app starts when the local Marumado isn't running (by default, the
    /// one the app was built from).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

pub fn load(dir: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(dir: &Path, config: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let file = path(dir);
    let text = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(file)?.write_all(text.as_bytes())
}
