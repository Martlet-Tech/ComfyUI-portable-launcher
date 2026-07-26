use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;
use std::os::windows::process::CommandExt;

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
    pub custom_args: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub instances: Vec<InstanceConfig>,
    pub proxy: Option<ProxyConfig>,
}

pub(crate) struct ProcessInfo {
    child: Child,
    log: Arc<Mutex<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct InstanceLogPayload {
    instance_id: String,
    pid: u32,
    line: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UpdateLogPayload {
    instance_id: String,
    line: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatusSnapshot {
    pub total_ram_mb: u64,
    pub used_ram_mb: u64,
    pub process_ram_mb: Option<u64>,
    pub gpu_total_mb: u64,
    pub gpu_used_mb: u64,
    pub gpu_name: String,
}

pub(crate) struct ProcessState(pub(crate) Mutex<HashMap<String, ProcessInfo>>);
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
    instance_id: String,
    path: String,
    mode: String,
    port: u16,
    custom_args: Option<String>,
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

    if let Some(ref custom) = custom_args {
        for arg in custom.split_whitespace() {
            args.push(arg.to_string());
        }
    }

    let mut cmd = Command::new(python_exe);
    cmd.args(&args);
    cmd.current_dir(&path);
    cmd.creation_flags(0x08000000);
    cmd.stdout(Stdio::piped());
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

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))?;
    let pid = child.id();
    let log = Arc::new(Mutex::new(String::new()));

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        let log_clone = log.clone();
        let iid = instance_id.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                log_clone.lock().unwrap().push_str(&line);
                log_clone.lock().unwrap().push_str("\n");
                let _ = app_clone.emit("instance-log", InstanceLogPayload {
                    instance_id: iid.clone(),
                    pid,
                    line,
                });
            }
        });
    }

    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(pid.to_string(), ProcessInfo { child, log });

    Ok(pid)
}

#[tauri::command]
async fn stop_instance(app: AppHandle, pid: u32) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(mut info) = map.remove(&pid.to_string()) {
        info.child.kill().map_err(|e| e.to_string())?;
        info.child.wait().ok();
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
fn read_instance_log(app: AppHandle, pid: u32) -> Result<String, String> {
    let state = app.state::<ProcessState>();
    let map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(info) = map.get(&pid.to_string()) {
        Ok(info.log.lock().unwrap().clone())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
async fn run_update(
    app: AppHandle,
    instance_id: String,
    path: String,
    update_type: String,
    proxy: Option<ProxyConfig>,
) -> Result<(), String> {
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
    cmd.current_dir(&path);
    cmd.creation_flags(0x08000000);
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

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        let iid = instance_id.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit("update-log", UpdateLogPayload {
                    instance_id: iid.clone(),
                    line,
                });
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let iid = instance_id.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit("update-log", UpdateLogPayload {
                    instance_id: iid.clone(),
                    line: format!("[stderr] {}", line),
                });
            }
        });
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("更新失败，详情请查看日志".to_string());
    }

    if update_type == "deps" {
        let req_path = std::path::Path::new(&path).join("ComfyUI\\requirements.txt");
        if req_path.exists() {
            let _ = app.emit("update-log", UpdateLogPayload {
                instance_id: instance_id.clone(),
                line: "--- pip install ---".to_string(),
            });

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
            pip_cmd.creation_flags(0x08000000);
            pip_cmd.stdout(Stdio::piped());
            pip_cmd.stderr(Stdio::piped());

            if let Ok(mut pip_child) = pip_cmd.spawn() {
                if let Some(ps) = pip_child.stdout.take() {
                    let app_clone = app.clone();
                    let iid = instance_id.clone();
                    std::thread::spawn(move || {
                        let reader = std::io::BufReader::new(ps);
                        for line in reader.lines().map_while(Result::ok) {
                            let _ = app_clone.emit("update-log", UpdateLogPayload {
                                instance_id: iid.clone(),
                                line,
                            });
                        }
                    });
                }
                if let Some(ps) = pip_child.stderr.take() {
                    let app_clone = app.clone();
                    let iid = instance_id.clone();
                    std::thread::spawn(move || {
                        let reader = std::io::BufReader::new(ps);
                        for line in reader.lines().map_while(Result::ok) {
                            let _ = app_clone.emit("update-log", UpdateLogPayload {
                                instance_id: iid.clone(),
                                line: format!("[stderr] {}", line),
                            });
                        }
                    });
                }
                pip_child.wait().ok();
            }
        }
    }

    Ok(())
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
fn open_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_comfyui_help(path: String) -> Result<String, String> {
    let python_exe = std::path::Path::new(&path).join("python_embeded\\python.exe");
    let main_py = std::path::Path::new(&path).join("ComfyUI\\main.py");
    if !python_exe.exists() {
        return Err("python_embeded/python.exe not found".to_string());
    }
    if !main_py.exists() {
        return Err("ComfyUI/main.py not found".to_string());
    }
    let output = Command::new(&python_exe)
        .args(["-s", &main_py.to_string_lossy(), "--help"])
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
async fn get_git_hash(path: String) -> Result<Option<String>, String> {
    let comfy_dir = std::path::Path::new(&path).join("ComfyUI");
    if !comfy_dir.join(".git").exists() {
        return Ok(None);
    }
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&comfy_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("git error: {}", e))?;
    if !output.status.success() {
        return Ok(None);
    }
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() { Ok(None) } else { Ok(Some(hash)) }
}

#[tauri::command]
async fn get_status_snapshot(pid: Option<u32>, path: Option<String>) -> Result<StatusSnapshot, String> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
    use windows::Win32::Foundation::CloseHandle;

    let (total_ram_mb, used_ram_mb, process_ram_mb) = unsafe {
        let mut memex = std::mem::zeroed::<MEMORYSTATUSEX>();
        memex.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        GlobalMemoryStatusEx(&mut memex).map_err(|e| format!("GlobalMemoryStatusEx: {}", e))?;
        let total_ram_mb = memex.ullTotalPhys / (1024 * 1024);
        let used_ram_mb = (memex.ullTotalPhys - memex.ullAvailPhys) / (1024 * 1024);

        let process_ram_mb: Option<u64> = match pid {
            Some(pid) => {
                let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
                match handle {
                    Ok(h) => {
                        let mut pmc = std::mem::zeroed::<PROCESS_MEMORY_COUNTERS>();
                        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                        let ret = GetProcessMemoryInfo(h, &mut pmc, size);
                        let _ = CloseHandle(h);
                        if ret.is_ok() && pmc.cb == size {
                            Some(pmc.WorkingSetSize as u64 / (1024 * 1024))
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            }
            None => None,
        };
        (total_ram_mb, used_ram_mb, process_ram_mb)
    };

    let (gpu_total_mb, gpu_used_mb, gpu_name) = query_gpu(path.as_deref())
        .unwrap_or((0, 0, String::new()));

    Ok(StatusSnapshot { total_ram_mb, used_ram_mb, process_ram_mb, gpu_total_mb, gpu_used_mb, gpu_name })
}

fn query_gpu(path: Option<&str>) -> Result<(u64, u64, String), String> {
    if let Ok(r) = query_nvidia_smi() {
        return Ok(r);
    }
    if let Some(p) = path {
        if let Ok(r) = query_torch_gpu(p) {
            return Ok(r);
        }
    }
    Err("no GPU info available".to_string())
}

fn query_nvidia_smi() -> Result<(u64, u64, String), String> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=index,memory.total,memory.used,name", "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("nvidia-smi: {}", e))?;
    if !output.status.success() {
        return Err("nvidia-smi exited non-zero".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, ',').collect();
        if parts.len() >= 3 {
            let total = parts[1].trim().parse::<u64>().unwrap_or(0);
            let used = parts[2].trim().parse::<u64>().unwrap_or(0);
            let name = parts.get(3).map(|s| s.trim().to_string()).unwrap_or_default();
            if total > 0 {
                return Ok((total, used, name));
            }
        }
    }
    Err("no GPU data from nvidia-smi".to_string())
}

fn query_torch_gpu(path: &str) -> Result<(u64, u64, String), String> {
    let python_exe = std::path::Path::new(&path).join("python_embeded\\python.exe");
    if !python_exe.exists() {
        return Err("python not found".to_string());
    }
    let script = "import torch, sys; free,total=torch.cuda.mem_get_info(0); print(f'{total>>20},{free>>20}')";
    let output = Command::new(&python_exe)
        .args(["-c", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("torch query: {}", e))?;
    if !output.status.success() {
        return Err("torch query failed".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    let parts: Vec<&str> = line.splitn(2, ',').collect();
    if parts.len() >= 2 {
        let total: u64 = parts[0].trim().parse().unwrap_or(0);
        let free: u64 = parts[1].trim().parse().unwrap_or(0);
        if total > 0 {
            return Ok((total, total - free, "GPU (PyTorch)".to_string()));
        }
    }
    Err("torch: no GPU".to_string())
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
                    let mut cmd = match std::process::Command::new(python_exe)
                        .args(&args)
                        .current_dir(&inst.path)
                        .creation_flags(0x08000000)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null())
                        .stdin(std::process::Stdio::null())
                        .spawn()
                    {
                        Ok(c) => c,
                        Err(_) => return,
                    };

                    let pid = cmd.id();
                    let log = Arc::new(Mutex::new(String::new()));
                    let instance_id = inst.id.clone();

                    if let Some(stdout) = cmd.stdout.take() {
                        let app_clone = app.clone();
                        let log_clone = log.clone();
                        let iid = instance_id.clone();
                        std::thread::spawn(move || {
                            let reader = std::io::BufReader::new(stdout);
                            for line in reader.lines().map_while(Result::ok) {
                                log_clone.lock().unwrap().push_str(&line);
                                log_clone.lock().unwrap().push_str("\n");
                                let _ = app_clone.emit("instance-log", InstanceLogPayload {
                                    instance_id: iid.clone(),
                                    pid,
                                    line,
                                });
                            }
                        });
                    }

                    let id_str = pid.to_string();
                    if let Ok(mut map) = app.state::<ProcessState>().0.lock() {
                        map.insert(id_str, ProcessInfo { child: cmd, log });
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
            let mut tray = TrayIconBuilder::new().menu(&menu);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let tray = tray
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
            read_instance_log,
            run_update,
            get_system_proxy,
            get_config_path,
            open_in_explorer,
            get_comfyui_help,
            get_git_hash,
            get_status_snapshot,
            rebuild_tray_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}