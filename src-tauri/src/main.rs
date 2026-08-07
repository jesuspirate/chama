#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const NEW_CHAMA_INSTANCE_MENU_ID: &str = "new-chama-instance";

struct BridgeSidecar(Mutex<Option<CommandChild>>);

#[derive(Clone, Debug)]
struct BridgeRuntime {
    bind: SocketAddr,
    bridge_url: String,
    auth_token: String,
    instance_id: Option<String>,
    data_dir_override: Option<PathBuf>,
}

impl BridgeSidecar {
    fn kill(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

impl Drop for BridgeSidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

fn stop_bridge_sidecar<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(sidecar) = app.try_state::<BridgeSidecar>() {
        sidecar.kill();
    }
}

fn default_bridge_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 8787))
}

fn loopback_addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

fn port_is_available(addr: SocketAddr) -> bool {
    TcpListener::bind(addr).is_ok()
}

fn ephemeral_loopback_addr() -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    drop(listener);
    Ok(addr)
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn generate_bridge_auth_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sanitize_instance_id(raw: &str) -> String {
    let sanitized = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if sanitized.is_empty() {
        "instance".to_owned()
    } else {
        sanitized
    }
}

fn choose_bridge_runtime() -> Result<BridgeRuntime, Box<dyn std::error::Error>> {
    let instance_id = optional_env("CHAMA_TAURI_INSTANCE_ID");
    let forced_port = optional_env("CHAMA_TAURI_BRIDGE_PORT")
        .map(|value| {
            value.parse::<u16>().map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid CHAMA_TAURI_BRIDGE_PORT: {value}"),
                )
            })
        })
        .transpose()?;

    let bind = if let Some(port) = forced_port {
        let forced = loopback_addr(port);
        if !port_is_available(forced) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!(
                    "Chama Fedimint bridge port {port} is already in use. Quit the stale Chama bridge or choose another CHAMA_TAURI_BRIDGE_PORT."
                ),
            )
            .into());
        }
        forced
    } else {
        let default = default_bridge_addr();
        if port_is_available(default) {
            default
        } else if instance_id.is_some() {
            // Explicit dev clone: give it a separate port + data dir keyed by
            // CHAMA_TAURI_INSTANCE_ID. Normal launches should not silently fork
            // into another wallet directory; that can make money-path smoke
            // tests look complete in one app while sats landed in another.
            ephemeral_loopback_addr()?
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "Chama is already running: the Fedimint bridge port 8787 is in use. Quit the other Chama window, or set CHAMA_TAURI_INSTANCE_ID for an intentional dev clone.",
            ).into());
        }
    };

    Ok(BridgeRuntime {
        bind,
        bridge_url: format!("http://{bind}"),
        auth_token: generate_bridge_auth_token(),
        instance_id,
        data_dir_override: optional_env("CHAMA_TAURI_BRIDGE_DATA_DIR").map(PathBuf::from),
    })
}

fn bridge_data_dir(
    app: &tauri::App,
    runtime: &BridgeRuntime,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(override_dir) = &runtime.data_dir_override {
        return if override_dir.is_absolute() {
            Ok(override_dir.clone())
        } else {
            Ok(app.path().app_data_dir()?.join(override_dir))
        };
    }

    let base = app.path().app_data_dir()?;
    if let Some(instance_id) = &runtime.instance_id {
        return Ok(base.join(format!(
            "fedimint-bridge-{}",
            sanitize_instance_id(instance_id)
        )));
    }

    if runtime.bind == default_bridge_addr() {
        Ok(base.join("fedimint-bridge"))
    } else {
        Ok(base.join(format!("fedimint-bridge-{}", runtime.bind.port())))
    }
}

fn js_string(value: &str) -> String {
    format!("{value:?}")
}

fn bridge_init_script(runtime: &BridgeRuntime) -> String {
    let bridge_url = js_string(&runtime.bridge_url);
    let auth_token = js_string(&runtime.auth_token);
    let instance_id = runtime
        .instance_id
        .as_deref()
        .map(js_string)
        .unwrap_or_else(|| "null".to_owned());

    format!(
        r#"
;window.__CHAMA_NATIVE_FEDIMINT__ = Object.freeze({{
  bridgeUrl: {bridge_url},
  authToken: {auth_token},
  instanceId: {instance_id}
}});
"#,
    )
}

fn start_bridge_sidecar(
    app: &mut tauri::App,
    runtime: &BridgeRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = bridge_data_dir(app, runtime)?;
    std::fs::create_dir_all(&data_dir)?;

    let data_dir_arg = data_dir.to_string_lossy().to_string();
    let bind_arg = runtime.bind.to_string();
    let auth_token_arg = runtime.auth_token.as_str();
    eprintln!(
        "[chama-tauri] starting Fedimint bridge at {} using {}",
        runtime.bridge_url,
        data_dir.display(),
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("chama-fedimint-bridge")?
        .args([
            "--data-dir",
            data_dir_arg.as_str(),
            "serve",
            "--bind",
            bind_arg.as_str(),
            "--auth-token",
            auth_token_arg,
            "--allowed-origin",
            "tauri://localhost",
            "--allowed-origin",
            "http://tauri.localhost",
        ])
        .spawn()?;

    app.manage(BridgeSidecar(Mutex::new(Some(child))));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprint!("[chama-fedimint-bridge] {line}");
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprint!("[chama-fedimint-bridge] {line}");
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[chama-fedimint-bridge] terminated: {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn menu_instance_id() -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("menu-{}-{now_ms}", std::process::id())
}

fn spawn_new_chama_instance() -> std::io::Result<()> {
    let exe = env::current_exe()?;
    Command::new(exe)
        .env("CHAMA_TAURI_INSTANCE_ID", menu_instance_id())
        // A menu-spawned clone should always get its own auto-selected bridge
        // port + data dir. If the parent was launched with forced dev env,
        // do not accidentally inherit those and collide with it.
        .env_remove("CHAMA_TAURI_BRIDGE_PORT")
        .env_remove("CHAMA_TAURI_BRIDGE_DATA_DIR")
        .spawn()
        .map(|_| ())
}

fn build_menu<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();
    let config = app_handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let window_menu = Submenu::with_id_and_items(
        app_handle,
        "Window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app_handle, None)?,
            &PredefinedMenuItem::maximize(app_handle, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::close_window(app_handle, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app_handle,
        "Help",
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app_handle, None, Some(about_metadata.clone()))?,
        ],
    )?;

    let menu = Menu::with_items(
        app_handle,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app_handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app_handle, None, Some(about_metadata.clone()))?,
                    &MenuItem::with_id(
                        app_handle,
                        NEW_CHAMA_INSTANCE_MENU_ID,
                        "New Chama Instance",
                        true,
                        Some("CmdOrCtrl+Shift+N"),
                    )?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::services(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::hide(app_handle, None)?,
                    &PredefinedMenuItem::hide_others(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::quit(app_handle, None)?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app_handle,
                "File",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &MenuItem::with_id(
                        app_handle,
                        NEW_CHAMA_INSTANCE_MENU_ID,
                        "New Chama Instance",
                        true,
                        Some("CmdOrCtrl+Shift+N"),
                    )?,
                    &PredefinedMenuItem::close_window(app_handle, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app_handle, None)?,
                    &PredefinedMenuItem::redo(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::cut(app_handle, None)?,
                    &PredefinedMenuItem::copy(app_handle, None)?,
                    &PredefinedMenuItem::paste(app_handle, None)?,
                    &PredefinedMenuItem::select_all(app_handle, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app_handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app_handle, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

fn main() {
    let bridge_runtime = choose_bridge_runtime().expect("failed to configure Chama bridge runtime");
    let init_script = bridge_init_script(&bridge_runtime);

    let app = tauri::Builder::default()
        .append_invoke_initialization_script(init_script)
        .menu(build_menu)
        .on_menu_event(|_app, event| {
            if event.id() == NEW_CHAMA_INSTANCE_MENU_ID {
                if let Err(error) = spawn_new_chama_instance() {
                    eprintln!("[chama-tauri] failed to spawn new Chama instance: {error}");
                }
            }
        })
        .plugin(tauri_plugin_shell::init())
        // HTTP plugin: lets the WebView's market-data fetches (BTC price, FX
        // rates) run from Rust (reqwest) instead of the WebView, which blocks
        // cross-origin requests from the custom tauri:// origin. See
        // Scope is locked to the price/FX hosts in
        // capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        // #88 desktop notifications: trade-event buzzes (counterparty locked,
        // claim ready, a dispute needs the arbiter, settled/timed out).
        .plugin(tauri_plugin_notification::init())
        // v4.1 #16: open external URLs via the OS. In the WebView `window.open`
        // is a silent no-op, so every redirect offramp + the Help links were
        // dead on desktop/APK. The frontend routes them through this plugin
        // (see src/ui/open-url.ts); scope is opener:allow-open-url.
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            start_bridge_sidecar(app, &bridge_runtime)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Chama Tauri app");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_bridge_sidecar(app_handle);
        }
        _ => {}
    });
}
