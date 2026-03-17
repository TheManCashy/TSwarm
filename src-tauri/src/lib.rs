use base64::Engine;
use blake3;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

mod fn_hotkey;

struct Session {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

struct SessionState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
}

#[derive(Serialize, Clone)]
struct TerminalData {
    id: String,
    data: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn default_root() -> Result<String, String> {
    resolve_home_dir().map(|home| home.to_string_lossy().to_string())
}

fn resolve_home_dir() -> Result<PathBuf, String> {
    let user_profile = std::env::var("USERPROFILE").ok();
    let home = std::env::var("HOME").ok();
    let home_drive = std::env::var("HOMEDRIVE").ok();
    let home_path = std::env::var("HOMEPATH").ok();

    if cfg!(windows) {
        if let Some(path) = user_profile.as_deref() {
            if !path.trim().is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
        if let (Some(drive), Some(path)) = (home_drive.as_deref(), home_path.as_deref()) {
            let combined = format!("{drive}{path}");
            if !combined.trim().is_empty() {
                return Ok(PathBuf::from(combined));
            }
        }
    }

    if let Some(path) = home.as_deref() {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    if let Some(path) = user_profile.as_deref() {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    std::env::current_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(path);
    let mut entries = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|e| e.as_secs())
            .unwrap_or(0);

        entries.push(FileEntry {
            name,
            path,
            is_dir,
            size,
            modified,
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

fn canvas_state_path(project_path: &str) -> Result<PathBuf, String> {
    let home = resolve_home_dir()?;
    let dir = PathBuf::from(home).join(".canvas-terminal").join("state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(project_path.as_bytes());
    let key = hasher.finalize().to_hex().to_string();
    Ok(dir.join(format!("{}.json", key)))
}

fn canvas_state_dir() -> Result<PathBuf, String> {
    let home = resolve_home_dir()?;
    let dir = PathBuf::from(home).join(".canvas-terminal").join("state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn claude_project_dir(project_path: &str) -> Result<PathBuf, String> {
    let home = resolve_home_dir()?;
    let trimmed = project_path.trim_end_matches('/');
    let encoded = trimmed.replace('/', "-");
    Ok(PathBuf::from(home).join(".claude").join("projects").join(encoded))
}

#[tauri::command]
fn save_canvas_state(project_path: String, state: String) -> Result<(), String> {
    let path = canvas_state_path(&project_path)?;
    fs::write(path, state).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_canvas_state(project_path: String) -> Result<Option<String>, String> {
    let path = canvas_state_path(&project_path)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct SavedProject {
    path: String,
    name: String,
    last_used: i64,
}

#[tauri::command]
fn list_saved_projects() -> Result<Vec<SavedProject>, String> {
    let dir = canvas_state_dir()?;
    let mut projects: std::collections::HashMap<String, SavedProject> = std::collections::HashMap::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let value: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let project_path = match value.get("projectPath").and_then(|v| v.as_str()) {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => continue,
        };
        let last_used = value
            .get("lastUsed")
            .and_then(|v| v.as_i64())
            .or_else(|| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
            })
            .unwrap_or(0);
        let name = project_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&project_path)
            .to_string();
        let item = SavedProject { path: project_path.clone(), name, last_used };
        match projects.get(&project_path) {
            Some(existing) if existing.last_used >= last_used => {}
            _ => {
                projects.insert(project_path.clone(), item);
            }
        }
    }
    let mut list: Vec<SavedProject> = projects.into_values().collect();
    list.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    Ok(list)
}

#[tauri::command]
fn get_codex_latest_session() -> Result<Option<String>, String> {
    let home = resolve_home_dir()?;
    let path = PathBuf::from(home).join(".codex").join("history.jsonl");
    if !path.exists() {
        return Ok(None);
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len() as i64;
    if len == 0 {
        return Ok(None);
    }
    let size = std::cmp::min(len, 65536);
    file.seek(SeekFrom::End(-size)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut last_line = None;
    for line in buf.split(|b| *b == b'\n').rev() {
        if line.is_empty() {
            continue;
        }
        last_line = Some(String::from_utf8_lossy(line).to_string());
        break;
    }
    let Some(line) = last_line else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(session_id)
}

#[tauri::command]
fn get_claude_latest_session(project_path: String) -> Result<Option<String>, String> {
    let dir = claude_project_dir(&project_path)?;
    if !dir.exists() {
        return Ok(None);
    }
    let mut newest: Option<(String, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        match &newest {
            Some((_, t)) if *t >= mtime => {}
            _ => newest = Some((name, mtime)),
        }
    }
    Ok(newest.map(|n| n.0))
}

#[tauri::command]
fn claude_session_exists(project_path: String, session_id: String) -> Result<bool, String> {
    let dir = claude_project_dir(&project_path)?;
    if !dir.exists() {
        return Ok(false);
    }
    let filename = format!("{}.jsonl", session_id.trim());
    Ok(dir.join(filename).exists())
}

#[tauri::command]
fn get_gemini_latest_session(project_path: String) -> Result<Option<String>, String> {
    let home = resolve_home_dir()?;
    let base = PathBuf::from(home).join(".gemini").join("tmp");
    if !base.exists() {
        return Ok(None);
    }
    let target = project_path.trim_end_matches('/');
    let mut project_dir: Option<PathBuf> = None;
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let marker = path.join(".project_root");
        if !marker.exists() {
            continue;
        }
        let root = fs::read_to_string(&marker).unwrap_or_default();
        if root.trim_end_matches('/') == target {
            project_dir = Some(path);
            break;
        }
    }
    let Some(dir) = project_dir else {
        return Ok(None);
    };
    let chats = dir.join("chats");
    if !chats.exists() {
        return Ok(None);
    }
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&chats).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        match &newest {
            Some((_, t)) if *t >= mtime => {}
            _ => newest = Some((path, mtime)),
        }
    }
    let Some((path, _)) = newest else {
        return Ok(None);
    };
    let data: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let session_id = data
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(session_id)
}

fn find_latest_codex_db() -> Result<Option<PathBuf>, String> {
    let home = resolve_home_dir()?;
    let base = PathBuf::from(home).join(".codex");
    if !base.exists() {
        return Ok(None);
    }
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.starts_with("state_") || !name.ends_with(".sqlite") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        match &newest {
            Some((_, t)) if *t >= mtime => {}
            _ => newest = Some((path, mtime)),
        }
    }
    Ok(newest.map(|n| n.0))
}

#[derive(Serialize)]
struct CodexSessionSummary {
    session_id: String,
    ts: i64,
}

#[derive(Serialize)]
struct CodexThreadSummary {
    session_id: String,
    updated_at: i64,
    cwd: String,
}

#[derive(Serialize)]
struct ClaudeSessionSummary {
    session_id: String,
    updated_at: i64,
}

#[tauri::command]
fn get_codex_threads_after(cwd: String, min_ts_ms: i64, limit: Option<usize>) -> Result<Vec<CodexThreadSummary>, String> {
    let Some(db_path) = find_latest_codex_db()? else {
        return Ok(vec![]);
    };
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let min_ts = if min_ts_ms > 2_000_000_000_000 { min_ts_ms / 1000 } else { min_ts_ms };
    let lim = limit.unwrap_or(50) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, updated_at FROM threads \
             WHERE (?1 = '' OR cwd = ?1) AND updated_at >= ?2 \
             ORDER BY updated_at DESC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![cwd.as_str(), min_ts, lim])
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let session_id: String = row.get(0).map_err(|e| e.to_string())?;
        let cwd_val: String = row.get(1).map_err(|e| e.to_string())?;
        let updated_at_sec: i64 = row.get(2).map_err(|e| e.to_string())?;
        let updated_at = updated_at_sec.saturating_mul(1000);
        out.push(CodexThreadSummary { session_id, updated_at, cwd: cwd_val });
    }
    Ok(out)
}

#[tauri::command]
fn get_codex_recent_sessions(limit: Option<usize>) -> Result<Vec<CodexSessionSummary>, String> {
    let home = resolve_home_dir()?;
    let path = PathBuf::from(home).join(".codex").join("history.jsonl");
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len() as i64;
    if len == 0 {
        return Ok(vec![]);
    }
    let size = std::cmp::min(len, 1024 * 1024);
    file.seek(SeekFrom::End(-size)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut sessions = Vec::new();
    for line in buf.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let session_id = match value.get("session_id").and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => continue,
        };
        let ts = value.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
        sessions.push(CodexSessionSummary { session_id, ts });
    }
    if let Some(lim) = limit {
        if sessions.len() > lim {
            sessions = sessions.split_off(sessions.len() - lim);
        }
    }
    Ok(sessions)
}

#[tauri::command]
fn get_claude_latest_session_after(project_path: String, min_ts_ms: i64) -> Result<Option<String>, String> {
    let dir = claude_project_dir(&project_path)?;
    if !dir.exists() {
        return Ok(None);
    }
    let mut newest: Option<(String, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        let mtime_ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        if mtime_ms < min_ts_ms {
            continue;
        }
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        match &newest {
            Some((_, t)) if *t >= mtime => {}
            _ => newest = Some((name, mtime)),
        }
    }
    Ok(newest.map(|n| n.0))
}

#[tauri::command]
fn get_claude_sessions(project_path: String, limit: Option<usize>) -> Result<Vec<ClaudeSessionSummary>, String> {
    let dir = claude_project_dir(&project_path)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        let mtime_ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        sessions.push(ClaudeSessionSummary { session_id: name, updated_at: mtime_ms });
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Some(lim) = limit {
        sessions.truncate(lim);
    }
    Ok(sessions)
}

#[tauri::command]
fn get_gemini_latest_session_after(project_path: String, min_ts_ms: i64) -> Result<Option<String>, String> {
    let home = resolve_home_dir()?;
    let base = PathBuf::from(home).join(".gemini").join("tmp");
    if !base.exists() {
        return Ok(None);
    }
    let target = project_path.trim_end_matches('/');
    let mut project_dir: Option<PathBuf> = None;
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let marker = path.join(".project_root");
        if !marker.exists() {
            continue;
        }
        let root = fs::read_to_string(&marker).unwrap_or_default();
        if root.trim_end_matches('/') == target {
            project_dir = Some(path);
            break;
        }
    }
    let Some(dir) = project_dir else {
        return Ok(None);
    };
    let chats = dir.join("chats");
    if !chats.exists() {
        return Ok(None);
    }
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&chats).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        let ts_ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        if ts_ms < min_ts_ms {
            continue;
        }
        match &newest {
            Some((_, t)) if *t >= mtime => {}
            _ => newest = Some((path, mtime)),
        }
    }
    let Some((path, _)) = newest else {
        return Ok(None);
    };
    let data: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let session_id = data
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(session_id)
}

#[tauri::command]
fn read_file_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Path is a directory".to_string());
    }
    let limit = max_bytes.unwrap_or(2_000_000);
    if meta.len() > limit {
        return Err(format!("File too large to preview ({} bytes).", meta.len()));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn read_file_base64(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Path is a directory".to_string());
    }
    let limit = max_bytes.unwrap_or(25_000_000);
    if meta.len() > limit {
        return Err(format!("File too large to preview ({} bytes).", meta.len()));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: tauri::State<SessionState>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    let id = Uuid::new_v4().to_string();

    let default_shell = if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    };
    let shell = shell.unwrap_or(default_shell);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "canvas-terminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_BASE_URL");
    cmd.env_remove("ANTHROPIC_MODEL");
    cmd.env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    cmd.env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL");
    cmd.env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL");
    cmd.env_remove("CLAUDE_CODE_SUBAGENT_MODEL");
    cmd.env_remove("KIMI_API_KEY");

    if !cfg!(windows) {
        if shell.ends_with("zsh") {
            cmd.arg("-l");
            cmd.arg("-i");
        } else if shell.ends_with("bash") {
            cmd.arg("-l");
            cmd.arg("-i");
        }
    }
    if let Some(cwd) = cwd {
        cmd.cwd(PathBuf::from(cwd));
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let session = Arc::new(Session {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });

    println!("created session {}", id);

    state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?
        .insert(id.clone(), session);

    let app_handle = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if n > 0 {
                        println!("session {} output {} bytes", id_clone, n);
                    }
                    if let Err(e) = app_handle.emit(
                        "terminal:data",
                        TerminalData {
                            id: id_clone.clone(),
                            data,
                        },
                    ) {
                        println!("Failed to emit terminal data: {}", e);
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(SessionInfo { id })
}

#[tauri::command]
fn write_session(
    state: tauri::State<SessionState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_session(
    state: tauri::State<SessionState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    let mut master = session
        .master
        .lock()
        .map_err(|_| "master lock poisoned".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_session(state: tauri::State<SessionState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    if let Some(session) = sessions.remove(&id) {
        let _ = session.child.lock().map_err(|_| "child lock poisoned")?.kill();
    }
    Ok(())
}

#[tauri::command]
fn log_frontend(message: String) {
    println!("[FRONTEND] {}", message);
}

#[tauri::command]
fn set_fn_hotkey_mode(app: AppHandle, mode: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        fn_hotkey::set_mode(app, &mode);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            }
            Ok(())
        })
        .manage(SessionState::new())
        .invoke_handler(tauri::generate_handler![
            default_root,
            list_dir,
            read_file_text,
            read_file_base64,
            save_canvas_state,
            load_canvas_state,
            list_saved_projects,
            get_codex_latest_session,
            get_codex_recent_sessions,
            get_codex_threads_after,
            get_claude_latest_session,
            get_gemini_latest_session,
            get_claude_latest_session_after,
            get_claude_sessions,
            get_gemini_latest_session_after,
            create_session,
            write_session,
            resize_session,
            close_session,
            log_frontend,
            set_fn_hotkey_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
