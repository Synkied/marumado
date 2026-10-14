//! The app's own updates. The latest GitHub release says which version is out (its latest.json, with the signed
//! bundles .github/workflows/desktop.yml publishes). Looked at a little after the app starts and every few hours, or
//! when asked from the tray; the tray then offers the update, which downloads, installs (a .deb or .rpm asks for the
//! password) and starts the app again. The new app brings its Marumado with it (host.rs).

use crate::{desk, log, notice, refresh_menu};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt as _};

/// How long after the app starts it looks first: not while it starts Marumado.
const FIRST: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub enum State {
    #[default]
    Idle,
    /// Asked from the tray: the menu says so until the answer.
    Checking,
    Found(Box<Update>),
    Installing,
}

/// What the tray's menu offers: its id (None: not clickable) and text.
pub fn menu_item(app: &AppHandle) -> (Option<&'static str>, String) {
    match &*desk(app).update.lock().unwrap() {
        State::Idle => (Some("check-update"), "Check for updates".into()),
        State::Checking => (None, "Checking for updates…".into()),
        State::Found(u) => (Some("install-update"), format!("Update to Marumado {}", u.version)),
        State::Installing => (None, "Updating Marumado…".into()),
    }
}

/// Looks now, then every few hours, for as long as the app runs.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST);
        loop {
            check(&app, false);
            std::thread::sleep(EVERY);
        }
    });
}

/// Off the caller's thread: a notification service that doesn't answer holds the call until D-Bus gives up.
fn tell(app: &AppHandle, title: String, body: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = notice::notify(&app, &title, &body) {
            log(&format!("couldn't notify: {e}"));
        }
    });
}

/// Asks GitHub whether a newer version is out. `by_hand` (from the tray) always answers, up to date or not; a check of
/// its own says only what it found, and only with notifications on.
pub fn check(app: &AppHandle, by_hand: bool) {
    let known = {
        let d = desk(app);
        let mut state = d.update.lock().unwrap();
        match &*state {
            State::Checking | State::Installing => return,
            State::Found(u) => Some(u.version.clone()),
            State::Idle => {
                if by_hand {
                    *state = State::Checking;
                }
                None
            }
        }
    };
    if by_hand {
        refresh_menu(app);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let found = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        let notify = by_hand || crate::config_of(&app).is_none_or(|c| c.notify);
        let d = desk(&app);
        let mut state = d.update.lock().unwrap();
        if matches!(*state, State::Installing) {
            return;
        }
        match found {
            Ok(Some(u)) => {
                if notify && known.as_deref() != Some(u.version.as_str()) {
                    log(&format!("Marumado {} is out", u.version));
                    tell(
                        &app,
                        format!("Marumado {} is out", u.version),
                        format!("Update to it from the tray's menu: you have {}.", u.current_version),
                    );
                }
                *state = State::Found(Box::new(u));
            }
            Ok(None) => {
                if by_hand {
                    let version = app.package_info().version.to_string();
                    tell(&app, "Marumado is up to date".into(), format!("{version} is the latest version."));
                }
                *state = State::Idle;
            }
            Err(e) => {
                log(&format!("couldn't check for updates: {e}"));
                if by_hand {
                    tell(&app, "Couldn't check for updates".into(), e.to_string());
                }
                // An update found before is still there.
                if matches!(*state, State::Checking) {
                    *state = State::Idle;
                }
            }
        }
        drop(state);
        refresh_menu(&app);
    });
}

/// Downloads and installs the update found, then starts the new app. On Windows, its installer ends this one.
pub fn install(app: &AppHandle) {
    let update = {
        let d = desk(app);
        let mut state = d.update.lock().unwrap();
        match std::mem::replace(&mut *state, State::Installing) {
            State::Found(u) => u,
            other => {
                *state = other;
                return;
            }
        }
    };
    refresh_menu(app);
    log(&format!("updating to Marumado {}", update.version));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match update.download_and_install(|_, _| {}, || {}).await {
            // Marumado's containers are left running: the new app starts its own version's in their place.
            Ok(()) => app.restart(),
            Err(e) => {
                log(&format!("couldn't update to Marumado {}: {e}", update.version));
                tell(&app, format!("Couldn't update to Marumado {}", update.version), e.to_string());
                *desk(&app).update.lock().unwrap() = State::Found(update);
                refresh_menu(&app);
            }
        }
    });
}
