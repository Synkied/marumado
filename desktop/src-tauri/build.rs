fn main() {
    // The app's own commands, each with an allow-<command> permission: the first-run page gets connect and current
    // (capabilities/setup.json); Marumado's pages get the rest, granted at run time for its address (main.rs).
    let commands = &[
        "current",
        "connect",
        "login_token",
        "open_page",
        "hide_card",
        "fit_card",
        "working_since",
        "reconnect",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
