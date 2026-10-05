//! Marumado on the desktop: one window that is reused for every page, the tray, the agents' card, and notifications.
//!
//! The window loads Marumado itself (http://127.0.0.1:7878, or another machine's) rather than a bundled copy of the
//! frontend, so one build works with any Marumado. Only the first-run page (../setup) is bundled. The tray reads
//! GET /api/agents on its own every 3 s, with the access token, whether the window is open or not.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod docker;
mod icon;
mod marumado;

use config::Config;
use marumado::{Act, Entry, Look, Reading, Watch};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

const EVERY: Duration = Duration::from_secs(3);
const TRAY: &str = "marumado";
/// The card's size, in logical pixels (its height shrinks on short screens).
const CARD_WIDTH: f64 = 440.0;
const CARD_HEIGHT: f64 = 560.0;
/// Launched with the session (the autostart plugin): stay in the tray.
const HIDDEN: &str = "--hidden";
/// Opens or closes the card: `marumado-desktop --card` can be bound to a key, where the tray icon gets no clicks (GNOME).
const CARD: &str = "--card";
const NOT_CONNECTED: &str = "Not connected to a Marumado yet.";
/// What the main window keeps from one run to the next: its size and place, maximized or full screen. Not whether it
/// shows: the app decides that (it starts in the tray with the session).
fn kept() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

#[derive(Default)]
struct Desk {
    config: Mutex<Option<Config>>,
    watch: Mutex<Watch>,
    /// What the tray was last handed: it is handed something new only when it changes. A new image is a new file
    /// for AppIndicator, and a new menu closes the open one on GNOME.
    shown: Mutex<Shown>,
    /// When the card last hid: the click on the icon that took its focus away must not open it again.
    card_hid: Mutex<Option<Instant>>,
    /// Where the card was last put by: the icon's place, if the desktop said.
    card_at: Mutex<Option<IconRect>>,
    /// How tall the card's page is, in logical pixels: the window is made that tall (up to CARD_HEIGHT).
    card_height: Mutex<Option<f64>>,
    /// While the app starts Marumado's containers: the page to open once it answers.
    starting: Mutex<Option<String>>,
    /// Wakes the tray's reader early (after connecting to another Marumado).
    poke: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Default)]
struct Shown {
    look: Option<Look>,
    entries: Vec<Entry>,
    tooltip: String,
    error: String,
}

fn desk(app: &AppHandle) -> State<'_, Desk> {
    app.state::<Desk>()
}

fn config_of(app: &AppHandle) -> Option<Config> {
    desk(app).config.lock().unwrap().clone()
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn log(message: &str) {
    eprintln!("marumado-desktop: {message}");
}

// ---------- the window ----------

/// The bundled first-run page, as the webview addresses it.
fn setup_url() -> Url {
    let url = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    url.parse().expect("a valid url")
}

fn is_own(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") || url.scheme() == "about"
}

fn on_marumado(app: &AppHandle, url: &Url) -> bool {
    config_of(app).is_some_and(|c| url.origin().ascii_serialization() == c.url)
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            log(&format!("couldn't open {url}: {e}"));
        }
    }
}

/// Marumado's pages stay in the app; any other site opens in the browser.
fn keep_inside(app: &AppHandle, url: &Url) -> bool {
    if is_own(url) || on_marumado(app, url) {
        return true;
    }
    open_outside(app, url);
    false
}

/// A link that asks for a new window (target=_blank, window.open): Marumado's own pages go to the app's window.
fn follow(app: &AppHandle, url: Url) {
    let app = app.clone();
    // Not from inside the webview's callback: showing the window waits on the event loop.
    std::thread::spawn(move || {
        if on_marumado(&app, &url) {
            show_page(&app, &format!("#{}", url.fragment().unwrap_or("/")));
        } else {
            open_outside(&app, &url);
        }
    });
}

/// A window of the app: Marumado's pages stay in it, other sites open in the browser.
fn window<'a>(app: &'a AppHandle, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let (nav, new) = (app.clone(), app.clone());
    WebviewWindowBuilder::new(app, label, url)
        .on_navigation(move |url| keep_inside(&nav, url))
        .on_new_window(move |url, _| {
            follow(&new, url);
            NewWindowResponse::Deny
        })
}

/// The one main window, made on first use. It loads Marumado, or the first-run page until there is an address.
fn main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        return Ok(w);
    }
    let start = config_of(app).and_then(|c| format!("{}/", c.url).parse().ok()).unwrap_or_else(setup_url);
    let start = if desk(app).starting.lock().unwrap().is_some() {
        WebviewUrl::App("starting.html".into())
    } else if is_own(&start) {
        WebviewUrl::App("index.html".into())
    } else {
        WebviewUrl::External(start)
    };
    window(app, "main", start)
        .title("Marumado")
        .inner_size(1280.0, 840.0)
        .min_inner_size(640.0, 420.0)
        .visible(false)
        .build()
}

fn bring_forward(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn show_main(app: &AppHandle) {
    match main_window(app) {
        Ok(w) => bring_forward(&w),
        Err(e) => log(&format!("couldn't open the window: {e}")),
    }
}

/// Takes the main window to a page of Marumado (a hash route such as `#/m/agents`) and brings it to the front.
fn show_page(app: &AppHandle, hash: &str) {
    let Ok(w) = main_window(app) else { return show_main(app) };
    let hash = if hash.starts_with('#') { hash.to_string() } else { format!("#{hash}") };
    let d = desk(app);
    let mut starting = d.starting.lock().unwrap();
    if let Some(pending) = starting.as_mut() {
        // Marumado isn't up yet: the window goes there once it is.
        *pending = hash;
    } else if let Some(c) = config_of(app) {
        let here = w.url().is_ok_and(|u| u.origin().ascii_serialization() == c.url);
        if here {
            // The page is already loaded: change its route only, as a click inside it would.
            let _ = w.eval(format!("window.location.hash = {}", serde_json::to_string(&hash).unwrap_or_default()));
        } else if let Ok(url) = format!("{}/{hash}", c.url).parse() {
            let _ = w.navigate(url);
        }
    }
    drop(starting);
    bring_forward(&w);
}

/// Back to the first-run page, to connect to another Marumado or give a new token.
fn reconnect_window(app: &AppHandle) {
    if let Ok(w) = main_window(app) {
        let _ = w.navigate(setup_url());
        bring_forward(&w);
    }
}

/// Marumado's pages may call the app's commands (the card, the login, the main window), and only those.
fn allow_remote(app: &AppHandle, origin: &str) {
    let id: String = origin.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let mut cap = CapabilityBuilder::new(format!("marumado-{id}"))
        .remote(format!("{origin}/*"))
        .window("main")
        .window("card");
    for command in ["login-token", "open-page", "hide-card", "fit-card", "working-since", "reconnect"] {
        cap = cap.permission(format!("allow-{command}"));
    }
    if let Err(e) = app.add_capability(cap) {
        log(&format!("couldn't let {origin} reach the app: {e}"));
    }
}

// ---------- the card ----------

fn card_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("card") {
        return Some(w);
    }
    let c = config_of(app)?;
    let url = format!("{}/#/card", c.url).parse().ok()?;
    let built = window(app, "card", WebviewUrl::External(url))
        .title("Agents · Marumado")
        .inner_size(CARD_WIDTH, CARD_HEIGHT)
        .decorations(false)
        // Resizable, though it has no frame to resize it by: GTK keeps a fixed window at its first size.
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    built.map_err(|e| log(&format!("couldn't open the card: {e}"))).ok()
}

fn hide_card_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("card") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            *desk(app).card_hid.lock().unwrap() = Some(Instant::now());
        }
    }
}

/// The tray icon's place on screen (x, y, width, height), where the desktop reports it (Windows, macOS).
type IconRect = (f64, f64, f64, f64);

fn within(v: f64, lo: f64, hi: f64) -> f64 {
    v.min(hi).max(lo)
}

/// By the icon when its place is known; otherwise at the top right of the primary monitor (bottom right on Windows,
/// where the taskbar is), not the rightmost one.
fn place_card(app: &AppHandle, w: &WebviewWindow) {
    let icon = *desk(app).card_at.lock().unwrap();
    let wanted = desk(app).card_height.lock().unwrap().unwrap_or(CARD_HEIGHT).min(CARD_HEIGHT);
    let monitor = icon
        .and_then(|(x, y, wd, h)| app.monitor_from_point(x + wd / 2.0, y + h / 2.0).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let scale = m.scale_factor();
    let area = m.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);
    let margin = 12.0 * scale;
    let (cw, ch) = (CARD_WIDTH * scale, (wanted * scale).min(ah * 0.7));
    let (x, y) = match icon {
        Some((ix, iy, iw, ih)) => {
            let below = iy + ih / 2.0 < ay + ah / 2.0; // a menu bar or a top panel: under it; a taskbar: above it
            let y = if below { iy + ih + margin } else { iy - ch - margin };
            (
                within(ix + iw / 2.0 - cw / 2.0, ax + margin, ax + aw - cw - margin),
                within(y, ay + margin, ay + ah - ch - margin),
            )
        }
        None => (ax + aw - cw - margin, if cfg!(windows) { ay + ah - ch - margin } else { ay + margin }),
    };
    let _ = w.set_size(PhysicalSize::new(cw.round() as u32, ch.round() as u32));
    let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// A second click closes it, as a tray's own popups do.
fn toggle_card(app: &AppHandle, icon: Option<IconRect>) {
    if app.get_webview_window("card").is_some_and(|w| w.is_visible().unwrap_or(false)) {
        return hide_card_window(app);
    }
    if desk(app)
        .card_hid
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < Duration::from_millis(400))
    {
        return; // this click took the card's focus away, which closed it already
    }
    if config_of(app).is_none() {
        return show_main(app);
    }
    let Some(w) = card_window(app) else {
        return show_page(app, "#/m/agents");
    };
    *desk(app).card_at.lock().unwrap() = icon;
    place_card(app, &w);
    let _ = w.show();
    let _ = w.set_focus();
    // The page reads the agents again at once, rather than showing what it read when it was last open.
    let _ = w.eval("window.dispatchEvent(new Event('marumado:card'))");
}

// ---------- the tray ----------

fn icon_image(r: &Reading) -> Image<'static> {
    Image::new_owned(icon::draw(r), icon::SIZE, icon::SIZE)
}

/// Each entry's id says what it does, so a click on a menu replaced since still does what it said.
fn build_menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for (i, e) in entries.iter().enumerate() {
        match &e.act {
            Act::Rule => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Act::Text => menu.append(&MenuItem::with_id(app, format!("text:{i}"), &e.text, false, None::<&str>)?)?,
            Act::Card => menu.append(&MenuItem::with_id(app, format!("card:{i}"), &e.text, true, None::<&str>)?)?,
            Act::Page(hash) => menu.append(&MenuItem::with_id(app, format!("page:{hash}"), &e.text, true, None::<&str>)?)?,
        }
    }
    let notify = config_of(app).is_none_or(|c| c.notify);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(app, "notify", "Notify me", true, notify, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "autostart",
        "Start with the session",
        true,
        autostart,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, "connect", "Connect to another Marumado…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Marumado", true, None::<&str>)?)?;
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    if id.starts_with("card:") {
        return toggle_card(app, None);
    }
    if let Some(hash) = id.strip_prefix("page:") {
        return show_page(app, hash);
    }
    match id {
        "quit" => quit(app),
        "connect" => reconnect_window(app),
        "notify" => {
            let d = desk(app);
            let mut config = d.config.lock().unwrap();
            if let Some(c) = config.as_mut() {
                c.notify = !c.notify;
                if let Err(e) = config::save(&config_dir(app), c) {
                    log(&format!("couldn't save the settings: {e}"));
                }
            }
        }
        "autostart" => {
            let auto = app.autolaunch();
            let done = if auto.is_enabled().unwrap_or(false) {
                auto.disable()
            } else {
                auto.enable()
            };
            if let Err(e) = done {
                log(&format!("couldn't change starting with the session: {e}"));
            }
        }
        _ => {}
    }
}

fn icon_rect(rect: &tauri::Rect) -> IconRect {
    let (p, s) = (rect.position.to_physical::<f64>(1.0), rect.size.to_physical::<f64>(1.0));
    (p.x, p.y, s.width, s.height)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let r = Reading::failed(if config_of(app).is_some() {
        "Reading Marumado…"
    } else {
        NOT_CONNECTED
    });
    let entries = marumado::menu_model(&r);
    let menu = build_menu(app, &entries)?;
    TrayIconBuilder::with_id(TRAY)
        .icon(icon_image(&r))
        .tooltip("Marumado")
        .menu(&menu)
        // Windows and macOS: a left click opens the card by the icon, a right click the menu. Linux (AppIndicator)
        // reports no clicks: a click opens the menu, whose first entry is the card.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_card(tray.app_handle(), Some(icon_rect(&rect)));
            }
        })
        .build(app)?;
    let d = desk(app);
    let mut shown = d.shown.lock().unwrap();
    shown.look = Some(marumado::icon_look(&r));
    shown.entries = entries;
    Ok(())
}

/// Hands the tray what changed in this reading, and tells the desktop when an agent starts waiting or finishes.
fn update(app: &AppHandle, r: Reading) {
    let d = desk(app);
    let news = d.watch.lock().unwrap().observe(&r, now_ms());
    if config_of(app).is_some_and(|c| c.notify) {
        for (title, body) in news {
            if let Err(e) = app
                .notification()
                .builder()
                .title(title)
                .body(if body.is_empty() { " ".into() } else { body })
                .show()
            {
                log(&format!("couldn't notify: {e}"));
            }
        }
    }
    let entries = marumado::menu_model(&r);
    let look = marumado::icon_look(&r);
    let tooltip: String = format!("Marumado: {}", marumado::summary(&r)).chars().take(127).collect(); // Windows cuts at 128
                                                                                                      // Decide under the lock, hand over outside it: building a menu waits on the main thread, where menu clicks run.
    let (new_look, new_menu, new_tip) = {
        let mut shown = d.shown.lock().unwrap();
        if shown.error != r.error {
            log(if r.error.is_empty() { "reading Marumado" } else { &r.error });
            shown.error = r.error.clone();
        }
        let new_look = shown.look.as_ref() != Some(&look);
        let new_menu = shown.entries != entries;
        let new_tip = shown.tooltip != tooltip;
        shown.look = Some(look);
        shown.entries = entries.clone();
        shown.tooltip = tooltip.clone();
        (new_look, new_menu, new_tip)
    };
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    if new_look {
        let _ = tray.set_icon(Some(icon_image(&r)));
    }
    if new_tip {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    if new_menu {
        match build_menu(app, &entries) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log(&format!("couldn't build the menu: {e}")),
        }
    }
}

fn poll(app: AppHandle, poke: mpsc::Receiver<()>) {
    let http = marumado::http();
    loop {
        let r = match config_of(&app) {
            Some(c) => marumado::read(&http, &c.url, &c.token),
            None => Reading::failed(NOT_CONNECTED),
        };
        update(&app, r);
        if let Err(mpsc::RecvTimeoutError::Disconnected) = poke.recv_timeout(EVERY) {
            return;
        }
    }
}

/// Starts the Marumado on this machine if it isn't running. Meanwhile the main window shows the bundled
/// "Starting Marumado…" page, and goes to Marumado once it answers (to the page asked for meanwhile, if any).
fn start_marumado(app: &AppHandle) {
    let Some(c) = config_of(app) else { return };
    if !docker::will_start(&c.url, c.folder.as_deref()) {
        return;
    }
    *desk(app).starting.lock().unwrap() = Some("#/".into());
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = docker::ensure(&c.url, c.folder.as_deref()) {
            log(&e);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(format!("window.failed({})", serde_json::to_string(&e).unwrap_or_default()));
            }
            // Started some other way (`make up`), it is just as good.
            while !docker::answers(&c.url) {
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        let hash = desk(&app).starting.lock().unwrap().take().unwrap_or_default();
        poke(&app);
        // A card made meanwhile couldn't reach Marumado.
        if let Some(card) = app.get_webview_window("card") {
            let _ = card.destroy();
        }
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(url) = format!("{}/{hash}", c.url).parse() {
                let _ = w.navigate(url);
            }
        }
    });
}

/// Quits, stopping the containers the app started: out of sight first, as stopping takes a few seconds.
fn quit(app: &AppHandle) {
    for w in app.webview_windows().values() {
        let _ = w.hide();
    }
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_visible(false);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = docker::stop_started() {
            log(&format!("couldn't stop Marumado's containers: {e}"));
        }
        app.exit(0);
    });
}

fn poke(app: &AppHandle) {
    if let Some(tx) = desk(app).poke.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}

// ---------- commands ----------

#[derive(serde::Serialize)]
struct Current {
    url: String,
    connected: bool,
    autostart: bool,
}

/// For the first-run page: the address to offer, and whether the app starts with the session.
#[tauri::command]
fn current(app: AppHandle) -> Current {
    let config = config_of(&app);
    Current {
        url: config.as_ref().map_or(config::DEFAULT_URL.into(), |c| c.url.clone()),
        connected: config.is_some(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

/// Checks the address and the token by logging in (POST /api/auth), keeps them, and opens Marumado.
#[tauri::command]
async fn connect(app: AppHandle, url: String, token: String, autostart: bool) -> Result<(), String> {
    let url = marumado::normalize_url(&url)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Enter its access token.".into());
    }
    let (u, t) = (url.clone(), token.clone());
    let folder = config_of(&app).and_then(|c| c.folder);
    let f = folder.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = docker::ensure(&u, f.as_deref()) {
            log(&e);
        }
        let http = marumado::http();
        marumado::check_login(&http, &u, &t)?;
        // The login takes the browser's password too, but the tray reads the API with the access token only.
        if marumado::read(&http, &u, &t).refused {
            return Err("That is this Marumado's password: the app needs its access token (`make access-token` prints it).".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let notify = config_of(&app).is_none_or(|c| c.notify);
    let c = Config { url, token, notify, folder };
    config::save(&config_dir(&app), &c).map_err(|e| format!("Couldn't save the address ({e})."))?;
    allow_remote(&app, &c.url);
    *desk(&app).config.lock().unwrap() = Some(c);
    *desk(&app).watch.lock().unwrap() = Watch::default();
    let auto = app.autolaunch();
    if let Err(e) = if autostart { auto.enable() } else { auto.disable() } {
        log(&format!("couldn't change starting with the session: {e}"));
    }
    // A card made for the last Marumado would show it still.
    if let Some(card) = app.get_webview_window("card") {
        let _ = card.destroy();
    }
    poke(&app);
    show_page(&app, "#/");
    Ok(())
}

/// The access token, for Marumado's login page to log this window in (POST /api/auth sets its cookie).
#[tauri::command]
fn login_token(app: AppHandle) -> Result<String, String> {
    config_of(&app).map(|c| c.token).ok_or_else(|| NOT_CONNECTED.into())
}

/// From the card: show this page in the main window.
#[tauri::command]
fn open_page(app: AppHandle, hash: String) {
    hide_card_window(&app);
    show_page(&app, &hash);
}

#[tauri::command]
fn hide_card(app: AppHandle) {
    hide_card_window(&app);
}

/// From the card: its page is this tall (logical pixels). The window follows, and stays by the icon.
#[tauri::command]
fn fit_card(app: AppHandle, height: f64) {
    *desk(&app).card_height.lock().unwrap() = Some(height.ceil());
    if let Some(w) = app.get_webview_window("card") {
        place_card(&app, &w);
    }
}

/// Since when each agent has been working, as the tray saw it: `source/pane` → milliseconds since the epoch.
#[tauri::command]
fn working_since(app: AppHandle) -> HashMap<String, u64> {
    desk(&app).watch.lock().unwrap().since.clone()
}

#[tauri::command]
fn reconnect(app: AppHandle) {
    reconnect_window(&app);
}

fn page_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| a.starts_with('#')).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let hidden = args.iter().any(|a| a == HIDDEN || a == CARD);
    let card = args.iter().any(|a| a == CARD);
    let page = page_arg(&args);
    tauri::Builder::default()
        // First: a second launch hands its page to this one and ends.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| match page_arg(&argv) {
            Some(page) => show_page(app, &page),
            None if argv.iter().any(|a| a == CARD) => toggle_card(app, None),
            None if argv.iter().any(|a| a == HIDDEN) => {}
            None => show_main(app),
        }))
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(kept())
                .with_denylist(&["card"])
                .build(),
        )
        .manage(Desk::default())
        .invoke_handler(tauri::generate_handler![
            current,
            connect,
            login_token,
            open_page,
            hide_card,
            fit_card,
            working_since,
            reconnect
        ])
        .on_window_event(|window, event| match (window.label(), event) {
            // Closing the window keeps the app in the tray; Quit is in the tray's menu.
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                // The plugin writes the window's state only when the app quits: the session may end it first.
                if let Err(e) = window.app_handle().save_window_state(kept()) {
                    log(&format!("couldn't keep the window's size: {e}"));
                }
                let _ = window.hide();
            }
            ("card", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                hide_card_window(window.app_handle());
            }
            ("card", WindowEvent::Focused(false)) => hide_card_window(window.app_handle()),
            _ => {}
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let config = config::load(&config_dir(&handle));
            if let Some(c) = &config {
                allow_remote(&handle, &c.url);
            }
            let connected = config.is_some();
            *desk(&handle).config.lock().unwrap() = config;
            build_tray(&handle)?;
            let (tx, rx) = mpsc::channel();
            *desk(&handle).poke.lock().unwrap() = Some(tx);
            let reader = handle.clone();
            std::thread::spawn(move || poll(reader, rx));
            start_marumado(&handle);
            main_window(&handle)?;
            match &page {
                Some(page) if connected => show_page(&handle, page),
                _ if connected && card => toggle_card(&handle, None),
                _ if connected && hidden => {}
                _ => show_main(&handle),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Marumado's desktop app")
        .run(|app, event| match event {
            // Every window closed (the main one only hides): stay in the tray, unless asked to quit.
            RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {
                let _ = app;
            }
        });
}
