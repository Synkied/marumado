//! What reaches the desktop outside the app's windows: notifications, and the count on the app's icon in the taskbar
//! or dock (the agents waiting on you).
//!
//! Linux goes to D-Bus itself. The notification plugin there drops what the notification service answers, so a
//! notification it refused went unseen; and Tauri's badge only reaches Unity, where docks (KDE, Ubuntu's, Dash to Dock)
//! listen for the LauncherEntry signal.

use tauri::AppHandle;

/// The app's desktop entry, as the .deb and .rpm install it (usr/share/applications/Marumado.desktop).
#[cfg(target_os = "linux")]
const DESKTOP_ENTRY: &str = "Marumado";

#[cfg(target_os = "linux")]
pub fn notify(_app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    notify_rust::Notification::new()
        .appname("Marumado")
        .summary(title)
        .body(body)
        .icon("marumado-desktop")
        .hint(notify_rust::Hint::DesktopEntry(DESKTOP_ENTRY.into()))
        .show()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
pub fn notify(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt as _;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Puts `count` on the app's icon in the taskbar or dock; 0 takes it off.
#[cfg(target_os = "linux")]
pub fn badge(_app: &AppHandle, count: usize) -> Result<(), String> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use zbus::zvariant::Value;
    static BUS: Mutex<Option<zbus::blocking::Connection>> = Mutex::new(None);
    let mut bus = BUS.lock().unwrap();
    if bus.is_none() {
        *bus = Some(zbus::blocking::Connection::session().map_err(|e| e.to_string())?);
    }
    let props: HashMap<&str, Value> = HashMap::from([
        ("count", Value::from(count as i64)),
        ("count-visible", Value::from(count > 0)),
    ]);
    let sent = bus.as_ref().unwrap().emit_signal(
        None::<&str>,
        "/dev/marumado/desktop",
        "com.canonical.Unity.LauncherEntry",
        "Update",
        &(format!("application://{DESKTOP_ENTRY}.desktop"), props),
    );
    if sent.is_err() {
        *bus = None; // the session bus went away: connect again next time
    }
    sent.map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub fn badge(app: &AppHandle, count: usize) -> Result<(), String> {
    use tauri::Manager as _;
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    w.set_badge_count((count > 0).then_some(count as i64)).map_err(|e| e.to_string())
}

/// Windows has no count on taskbar buttons: a small persimmon disc with the count is laid over the icon. The button
/// is there only while the window shows, so this is done again when it does.
#[cfg(windows)]
pub fn badge(app: &AppHandle, count: usize) -> Result<(), String> {
    use tauri::Manager as _;
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    let overlay = (count > 0).then(|| tauri::image::Image::new_owned(crate::icon::badge(count), crate::icon::SIZE, crate::icon::SIZE));
    w.set_overlay_icon(overlay).map_err(|e| e.to_string())
}
