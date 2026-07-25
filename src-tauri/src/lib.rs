use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstanceConfig {
    pub id: String,
    pub path: String,
    pub alias: Option<String>,
    pub port: Option<u16>,
    pub output_directory: Option<String>,
    pub input_directory: Option<String>,
    pub temp_directory: Option<String>,
    pub user_directory: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub instances: Vec<InstanceConfig>,
    pub proxy: Option<ProxyConfig>,
}

pub struct ProcessState(pub Mutex<HashMap<String, Child>>);
pub struct TrayHolder(pub Mutex<Option<TrayIcon>>);

fn config_dir() -> std::path::PathBuf {
    let home =
        std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
    std::path::PathBuf::from(home).join(".comfylauncher")
}

fn config_path() -> std::path::PathBuf {
    config_dir().join("config.json")
}

#[tauri::command]
fn read_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(AppConfig {
            instances: Vec::new(),
            proxy: None,
        });
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_config(config: AppConfig) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn select_folder(app: AppHandle) -> Result<Option<String>, String> {
    let file = app.dialog().file().blocking_pick_folder();
    Ok(file.map(|p| p.to_string()))
}

#[tauri::command]
async fn launch_instance(
    app: AppHandle,
    path: String,
    mode: String,
    port: u16,
    output_directory: Option<String>,
    input_directory: Option<String>,
    temp_directory: Option<String>,
    user_directory: Option<String>,
    proxy: Option<ProxyConfig>,
) -> Result<u32, String> {
    let python_exe = std::path::Path::new(&path).join("python_embeded\\python.exe");
    let main_py = std::path::Path::new(&path).join("ComfyUI\\main.py");

    if !python_exe.exists() {
        return Err("python_embeded/python.exe not found".to_string());
    }
    if !main_py.exists() {
        return Err("ComfyUI/main.py not found".to_string());
    }

    let mut args = vec!["-s".to_string(), main_py.to_string_lossy().to_string()];
    args.push("--windows-standalone-build".to_string());

    match mode.as_str() {
        "cpu" => args.push("--cpu".to_string()),
        "gpu_fastfp16" => {
            args.push("--fast".to_string());
            args.push("fp16_accumulation".to_string());
        }
        _ => {}
    }

    args.push("--port".to_string());
    args.push(port.to_string());

    for (flag, val) in [
        ("--output-directory", &output_directory),
        ("--input-directory", &input_directory),
        ("--temp-directory", &temp_directory),
        ("--user-directory", &user_directory),
    ] {
        if let Some(d) = val {
            if !d.is_empty() {
                args.push(flag.to_string());
                args.push(d.clone());
            }
        }
    }

    let mut cmd = Command::new(python_exe);
    cmd.args(&args);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.stdin(Stdio::null());

    if let Some(ref p) = proxy {
        if p.enabled {
            if let (Some(ref h), Some(port)) = (&p.host, p.port) {
                let proxy_str = format!("http://{}:{}", h, port);
                cmd.env("HTTP_PROXY", &proxy_str);
                cmd.env("HTTPS_PROXY", &proxy_str);
            }
        }
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))?;
    let pid = child.id();

    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(pid.to_string(), child);

    Ok(pid)
}

#[tauri::command]
async fn stop_instance(app: AppHandle, pid: u32) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = map.remove(&pid.to_string()) {
        child.kill().map_err(|e| e.to_string())?;
        child.wait().ok();
        Ok(())
    } else {
        Err("Process not found".to_string())
    }
}

#[tauri::command]
async fn check_port(port: u16) -> Result<bool, String> {
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{}", port)
        .parse::<std::net::SocketAddr>()
        .map_err(|e| e.to_string())?;
    match TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn check_paths(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths
        .iter()
        .map(|p| std::path::Path::new(p).exists())
        .collect())
}

#[tauri::command]
async fn run_update(
    path: String,
    update_type: String,
    proxy: Option<ProxyConfig>,
) -> Result<String, String> {
    let python_exe = std::path::Path::new(&path).join("python_embeded\\python.exe");
    let update_py = std::path::Path::new(&path).join("update\\update.py");
    let comfy_dir = std::path::Path::new(&path).join("ComfyUI");

    if !python_exe.exists() {
        return Err("python_embeded/python.exe not found".to_string());
    }
    if !update_py.exists() {
        return Err("update/update.py not found".to_string());
    }

    let mut args = vec![
        "-s".to_string(),
        update_py.to_string_lossy().to_string(),
        comfy_dir.to_string_lossy().to_string(),
    ];

    if update_type == "stable" {
        args.push("--stable".to_string());
    }

    let mut cmd = Command::new(&python_exe);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(ref p) = proxy {
        if p.enabled {
            if let (Some(ref h), Some(port)) = (&p.host, p.port) {
                let proxy_str = format!("http://{}:{}", h, port);
                cmd.env("HTTP_PROXY", &proxy_str);
                cmd.env("HTTPS_PROXY", &proxy_str);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run update: {}", e))?;

    let mut stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let mut stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let mut output = String::new();

    let mut out_buf = String::new();
    stdout.read_to_string(&mut out_buf).ok();
    output.push_str(&out_buf);

    let mut err_buf = String::new();
    stderr.read_to_string(&mut err_buf).ok();
    if !err_buf.is_empty() {
        output.push_str(&format!("\n--- stderr ---\n{}", err_buf));
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Update failed:\n{}", output));
    }

    if update_type == "deps" {
        let req_path = std::path::Path::new(&path).join("ComfyUI\\requirements.txt");
        if req_path.exists() {
            let pip_args = vec![
                "-s".to_string(),
                "-m".to_string(),
                "pip".to_string(),
                "install".to_string(),
                "-r".to_string(),
                req_path.to_string_lossy().to_string(),
                "torch".to_string(),
                "torchvision".to_string(),
                "torchaudio".to_string(),
                "--extra-index-url".to_string(),
                "https://download.pytorch.org/whl/cu130".to_string(),
            ];

            let mut pip_cmd = Command::new(python_exe);
            pip_cmd.args(&pip_args);
            pip_cmd.stdout(Stdio::piped());
            pip_cmd.stderr(Stdio::piped());

            if let Ok(mut pip_child) = pip_cmd.spawn() {
                if let Some(ref mut ps) = pip_child.stdout {
                    let mut pip_output = String::new();
                    ps.read_to_string(&mut pip_output).ok();
                    output.push_str(&format!("\n--- pip install ---\n{}", pip_output));
                }
                pip_child.wait().ok();
            }
        }
    }

    Ok(output)
}

#[tauri::command]
fn get_system_proxy() -> Result<Option<ProxyConfig>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    let key = match hkcu.open_subkey(key_path) {
        Ok(k) => k,
        Err(_) => return Ok(None),
    };

    let proxy_enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if proxy_enable == 0 {
        return Ok(Some(ProxyConfig {
            enabled: false,
            host: None,
            port: None,
        }));
    }

    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    if server.is_empty() {
        return Ok(Some(ProxyConfig {
            enabled: true,
            host: None,
            port: None,
        }));
    }

    if let Some(idx) = server.find(':') {
        let host = server[..idx].to_string();
        let port: u16 = server[idx + 1..].parse().unwrap_or(8080);
        Ok(Some(ProxyConfig {
            enabled: true,
            host: Some(host),
            port: Some(port),
        }))
    } else {
        Ok(Some(ProxyConfig {
            enabled: true,
            host: Some(server),
            port: Some(8080),
        }))
    }
}

#[tauri::command]
fn get_config_path() -> Result<String, String> {
    Ok(config_path().to_string_lossy().to_string())
}

#[tauri::command]
fn rebuild_tray_menu(app: AppHandle) -> Result<(), String> {
    let config = read_config()?;
    let menu = build_tray_menu(&app, &config).map_err(|e| e.to_string())?;
    let state = app.state::<TrayHolder>();
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_tray_menu(app: &AppHandle, config: &AppConfig) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let mut builder = MenuBuilder::new(app);
    for inst in &config.instances {
        let label = inst.alias.clone().unwrap_or_else(|| inst.path.clone());
        let item = MenuItemBuilder::with_id(&inst.id, &label).build(app)?;
        builder = builder.item(&item);
    }
    if !config.instances.is_empty() {
        builder = builder.separator();
    }
    let show = MenuItemBuilder::with_id("show", "Show Launcher").build(app)?;
    let exit = MenuItemBuilder::with_id("exit", "Exit").build(app)?;
    builder = builder.item(&show).separator().item(&exit);
    builder.build()
}

fn handle_tray_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
                window.set_focus().ok();
            }
        }
        "exit" => {
            app.exit(0);
        }
        id => {
            if let Ok(config) = read_config() {
                if let Some(inst) = config.instances.iter().find(|i| i.id == id) {
                    let port = inst.port.unwrap_or(8188);
                    let python_exe =
                        std::path::Path::new(&inst.path).join("python_embeded\\python.exe");
                    let main_py =
                        std::path::Path::new(&inst.path).join("ComfyUI\\main.py");
                    let args = vec![
                        "-s".to_string(),
                        main_py.to_string_lossy().to_string(),
                        "--windows-standalone-build".to_string(),
                        "--port".to_string(),
                        port.to_string(),
                    ];
                    let cmd = std::process::Command::new(python_exe)
                        .args(&args)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .stdin(std::process::Stdio::null())
                        .spawn();
                    if let Ok(child) = cmd {
                        let id_str = child.id().to_string();
                        if let Ok(mut map) = app.state::<ProcessState>().0.lock() {
                            map.insert(id_str, child);
                        }
                    }
                }
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessState(Mutex::new(HashMap::new())))
        .manage(TrayHolder(Mutex::new(None)))
        .setup(|app| {
            let empty = AppConfig {
                instances: vec![],
                proxy: None,
            };
            let menu = build_tray_menu(app.handle(), &empty)?;
            let tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(handle_tray_event)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                })
                .build(app)?;
            *app.state::<TrayHolder>().0.lock().unwrap() = Some(tray);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_config,
            select_folder,
            launch_instance,
            stop_instance,
            check_port,
            check_paths,
            run_update,
            get_system_proxy,
            get_config_path,
            rebuild_tray_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}