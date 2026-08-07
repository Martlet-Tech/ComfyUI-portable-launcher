use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxyConfig {
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResolvedProxy {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub scheme: String,
}

fn apply_proxy(cmd: &mut Command, proxy: &Option<ResolvedProxy>) {
    if let Some(ref p) = proxy {
        let proxy_str = format!("{}://{}:{}", p.scheme, p.host, p.port);
        cmd.env("HTTP_PROXY", &proxy_str);
        cmd.env("HTTPS_PROXY", &proxy_str);
        cmd.env("ALL_PROXY", &proxy_str);
    }
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

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProcessReadyPayload {
    instance_id: String,
    pid: u32,
    port: u16,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProcessExitedPayload {
    instance_id: String,
    pid: u32,
    exit_code: i32,
}

pub(crate) struct ProcessInfo {
    pid: u32,
    port: u16,
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

// ── Win32 helpers for PID management ─────────────────────────────────────

#[repr(C)]
struct MIB_TCPROW_OWNER_PID {
    state: u32,
    local_addr: u32,
    local_port: u32,
    remote_addr: u32,
    remote_port: u32,
    owning_pid: u32,
}

const AF_INET: u32 = 2;
const TCP_TABLE_OWNER_PID_ALL: u32 = 5;

#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        p_tcp_table: *mut std::ffi::c_void,
        pdw_size: *mut u32,
        b_order: i32,
        ul_af: u32,
        table_class: u32,
        reserved: u32,
    ) -> u32;
}

fn find_pids_by_port(target_port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let ret = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            false as i32,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != 122 {
            return pids;
        }

        let mut buf: Vec<u8> = vec![0u8; size as usize];
        if GetExtendedTcpTable(
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut size,
            false as i32,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        ) != 0
        {
            return pids;
        }

        let num_entries = *(buf.as_ptr() as *const u32);
        let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
        for i in 0..num_entries {
            let offset = std::mem::size_of::<u32>() + (i as usize) * row_size;
            if offset + row_size > buf.len() {
                break;
            }
            let row = &*(buf.as_ptr().add(offset) as *const MIB_TCPROW_OWNER_PID);
            let port_host = u16::from_be(row.local_port as u16);
            if port_host == target_port {
                pids.push(row.owning_pid);
            }
        }
    }
    pids
}

fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid);
        match handle {
            Ok(h) => {
                let mut exit_code = 0u32;
                let ok = GetExitCodeProcess(h, &mut exit_code).is_ok();
                let _ = CloseHandle(h);
                ok && exit_code == 259
            }
            Err(_) => false,
        }
    }
}

fn kill_process(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid);
        if let Ok(h) = handle {
            let _ = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
        }
    }
}

// ── Config ──────────────────────────────────────────────────────────────

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

// ── Launch / Monitor / Stop ─────────────────────────────────────────────

fn check_port_sync(port: u16) -> bool {
    use std::net::TcpStream;
    if let Ok(addr) = format!("127.0.0.1:{}", port).parse::<std::net::SocketAddr>() {
        TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
    } else {
        false
    }
}

#[tauri::command]
async fn check_port(port: u16) -> Result<bool, String> {
    Ok(check_port_sync(port))
}

fn spawn_log_reader<R, F>(reader: R, emit: F)
where
    R: std::io::BufRead + Send + 'static,
    F: Fn(String) + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = Vec::with_capacity(4096);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let decoded = String::from_utf8_lossy(&buf);
                    let line = decoded.trim_end_matches(|c| c == '\r' || c == '\n');
                    emit(line.to_string());
                }
                Err(_) => break,
            }
        }
    });
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
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))?;
    let pid = child.id();
    let log = Arc::new(Mutex::new(String::new()));

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        let log_clone = log.clone();
        let iid = instance_id.clone();
        spawn_log_reader(std::io::BufReader::new(stdout), move |line| {
            log_clone.lock().unwrap().push_str(&line);
            log_clone.lock().unwrap().push_str("\n");
            let _ = app_clone.emit("instance-log", InstanceLogPayload {
                instance_id: iid.clone(),
                pid,
                line,
            });
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let log_clone = log.clone();
        let iid = instance_id.clone();
        spawn_log_reader(std::io::BufReader::new(stderr), move |line| {
            log_clone.lock().unwrap().push_str(&line);
            log_clone.lock().unwrap().push_str("\n");
            let _ = app_clone.emit("instance-log", InstanceLogPayload {
                instance_id: iid.clone(),
                pid,
                line: format!("[stderr] {}", line),
            });
        });
    }

    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(pid.to_string(), ProcessInfo { pid, port, log });

    spawn_process_monitor(app.clone(), instance_id.clone(), pid, port);

    Ok(pid)
}

fn spawn_process_monitor(
    app: AppHandle,
    instance_id: String,
    mut pid: u32,
    port: u16,
) {
    std::thread::spawn(move || {
        let mut ready_emitted = false;
        let mut dead_emitted = false;
        let mut grace_start: Option<Instant> = None;
        const GRACE_PERIOD: Duration = Duration::from_secs(30);

        loop {
            let tracked = {
                let state = app.state::<ProcessState>();
                let locked = state.0.lock();
                match locked {
                    Ok(map) => map.contains_key(&pid.to_string()),
                    Err(_) => false,
                }
            };
            if !tracked {
                break;
            }

            let port_open = check_port_sync(port);

            if port_open {
                grace_start = None;

                let current_pids = find_pids_by_port(port);
                if let Some(current_pid) = current_pids.into_iter().next() {
                    if current_pid != pid {
                        let state = app.state::<ProcessState>();
                        if let Ok(mut map) = state.0.lock() {
                            if let Some(info) = map.remove(&pid.to_string()) {
                                map.insert(current_pid.to_string(), ProcessInfo {
                                    pid: current_pid,
                                    port,
                                    log: info.log,
                                });
                            }
                        }
                        pid = current_pid;
                    }
                }

                if !ready_emitted || dead_emitted {
                    let _ = app.emit("process-ready", ProcessReadyPayload {
                        instance_id: instance_id.clone(),
                        pid,
                        port,
                    });
                    ready_emitted = true;
                    dead_emitted = false;
                }
            } else if !is_process_alive(pid) {
                match grace_start {
                    None => grace_start = Some(Instant::now()),
                    Some(start) if start.elapsed() >= GRACE_PERIOD => {
                        if !dead_emitted {
                            let _ = app.emit("process-exited", ProcessExitedPayload {
                                instance_id: instance_id.clone(),
                                pid,
                                exit_code: -1,
                            });
                            dead_emitted = true;
                        }
                    }
                    _ => {}
                }
            } else {
                grace_start = None;
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
async fn stop_instance(app: AppHandle, pid: u32) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(info) = map.remove(&pid.to_string()) {
        let port = info.port;
        drop(map);

        kill_process(pid);
        for p in find_pids_by_port(port) {
            if p != pid {
                kill_process(p);
            }
        }

        Ok(())
    } else {
        Err("Process not found".to_string())
    }
}

// ── Misc commands ───────────────────────────────────────────────────────

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
    proxy: Option<ResolvedProxy>,
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
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");

    apply_proxy(&mut cmd, &proxy);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run update: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        let iid = instance_id.clone();
        spawn_log_reader(std::io::BufReader::new(stdout), move |line| {
            let _ = app_clone.emit("update-log", UpdateLogPayload {
                instance_id: iid.clone(),
                line,
            });
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let iid = instance_id.clone();
        spawn_log_reader(std::io::BufReader::new(stderr), move |line| {
            let _ = app_clone.emit("update-log", UpdateLogPayload {
                instance_id: iid.clone(),
                line: format!("[stderr] {}", line),
            });
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
            pip_cmd.env("PYTHONIOENCODING", "utf-8");
            pip_cmd.env("PYTHONUTF8", "1");

            if let Ok(mut pip_child) = pip_cmd.spawn() {
                if let Some(ps) = pip_child.stdout.take() {
                    let app_clone = app.clone();
                    let iid = instance_id.clone();
                    spawn_log_reader(std::io::BufReader::new(ps), move |line| {
                        let _ = app_clone.emit("update-log", UpdateLogPayload {
                            instance_id: iid.clone(),
                            line,
                        });
                    });
                }
                if let Some(ps) = pip_child.stderr.take() {
                    let app_clone = app.clone();
                    let iid = instance_id.clone();
                    spawn_log_reader(std::io::BufReader::new(ps), move |line| {
                        let _ = app_clone.emit("update-log", UpdateLogPayload {
                            instance_id: iid.clone(),
                            line: format!("[stderr] {}", line),
                        });
                    });
                }
                pip_child.wait().ok();
            }
        }
    }

    Ok(())
}

fn parse_proxy_url(url: &str) -> Option<ResolvedProxy> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let (scheme, rest) = match url.find("://") {
        Some(i) => (&url[..i], &url[i + 3..]),
        None => ("http", url),
    };
    let scheme = scheme.to_lowercase();
    if scheme != "http" && scheme != "socks5" {
        return None;
    }
    let (host, port_str) = match rest.rfind(':') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let port: u16 = port_str.parse().unwrap_or(8080);
    Some(ResolvedProxy {
        host: host.to_string(),
        port,
        scheme,
    })
}

fn env_proxy() -> Option<ResolvedProxy> {
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        if let Ok(val) = std::env::var(key) {
            if let Some(p) = parse_proxy_url(&val) {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
fn get_system_proxy() -> Result<Option<ResolvedProxy>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    let key = match hkcu.open_subkey(key_path) {
        Ok(k) => k,
        Err(_) => return Ok(env_proxy()),
    };

    let proxy_enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if proxy_enable == 0 {
        return Ok(env_proxy());
    }

    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    if server.is_empty() {
        return Ok(env_proxy());
    }

    if let Some(idx) = server.find(':') {
        let host = server[..idx].to_string();
        let port: u16 = server[idx + 1..].parse().unwrap_or(8080);
        Ok(Some(ResolvedProxy {
            host,
            port,
            scheme: "http".to_string(),
        }))
    } else {
        Ok(Some(ResolvedProxy {
            host: server,
            port: 8080,
            scheme: "http".to_string(),
        }))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GitProxyTestResult {
    ok: bool,
    message: String,
    duration_ms: u64,
}

#[tauri::command]
async fn test_git_proxy(path: String, proxy: Option<ResolvedProxy>) -> Result<GitProxyTestResult, String> {
    let python_exe = std::path::Path::new(&path).join("python_embeded\\python.exe");
    let comfy_dir = std::path::Path::new(&path).join("ComfyUI");
    if !python_exe.exists() {
        return Err("python_embeded/python.exe not found".to_string());
    }
    if !comfy_dir.exists() {
        return Err("ComfyUI directory not found".to_string());
    }
    let script = r#"
import sys, time, pygit2
t = time.time()
try:
    repo = pygit2.Repository(sys.argv[1])
    refs = repo.remotes['origin'].ls_remotes()
    print('OK {} refs in {:.1f}s'.format(len(refs), time.time() - t))
except Exception as e:
    print('FAIL {} ({:.1f}s)'.format(e, time.time() - t))
    sys.exit(1)
"#;
    let start = Instant::now();
    let mut cmd = Command::new(&python_exe);
    cmd.args(["-s", "-c", script.trim()]);
    cmd.arg(&comfy_dir);
    cmd.creation_flags(0x08000000);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    apply_proxy(&mut cmd, &proxy);
    let output = cmd.output().map_err(|e| format!("Failed to run test: {}", e))?;
    let duration_ms = start.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(GitProxyTestResult { ok: true, message: stdout, duration_ms })
    } else {
        let msg = if !stdout.is_empty() { stdout } else { stderr };
        Ok(GitProxyTestResult { ok: false, message: msg, duration_ms })
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
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .creation_flags(0x08000000)
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
            let state = app.state::<ProcessState>();
            if let Ok(map) = state.0.lock() {
                for (_, info) in map.iter() {
                    kill_process(info.pid);
                }
            }
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
                        .stderr(std::process::Stdio::piped())
                        .stdin(std::process::Stdio::null())
                        .env("PYTHONIOENCODING", "utf-8")
                        .env("PYTHONUTF8", "1")
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
                        spawn_log_reader(std::io::BufReader::new(stdout), move |line| {
                            log_clone.lock().unwrap().push_str(&line);
                            log_clone.lock().unwrap().push_str("\n");
                            let _ = app_clone.emit("instance-log", InstanceLogPayload {
                                instance_id: iid.clone(),
                                pid,
                                line,
                            });
                        });
                    }

                    if let Some(stderr) = cmd.stderr.take() {
                        let app_clone = app.clone();
                        let log_clone = log.clone();
                        let iid = instance_id.clone();
                        spawn_log_reader(std::io::BufReader::new(stderr), move |line| {
                            log_clone.lock().unwrap().push_str(&line);
                            log_clone.lock().unwrap().push_str("\n");
                            let _ = app_clone.emit("instance-log", InstanceLogPayload {
                                instance_id: iid.clone(),
                                pid,
                                line: format!("[stderr] {}", line),
                            });
                        });
                    }

                    let id_str = pid.to_string();
                    if let Ok(mut map) = app.state::<ProcessState>().0.lock() {
                        map.insert(id_str, ProcessInfo { pid, port, log });
                    }
                    spawn_process_monitor(app.clone(), instance_id, pid, port);
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
            test_git_proxy,
            get_config_path,
            open_in_explorer,
            open_url,
            get_comfyui_help,
            get_git_hash,
            get_status_snapshot,
            rebuild_tray_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
