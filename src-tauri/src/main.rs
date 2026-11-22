#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, DragDropEvent, Manager, Url, WindowEvent};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static STREAM_BRIDGE_PORT: u16 = 45678;
static ALWAYS_ON_TOP_STATE: AtomicBool = AtomicBool::new(false);
static HAS_TRAY_ICON: AtomicBool = AtomicBool::new(false);
static POPOUT_COUNTER: AtomicUsize = AtomicUsize::new(1);
static STREAM_AUTH_COUNTER: AtomicUsize = AtomicUsize::new(1);

struct ExecJob {
    stdout: String,
    stderr: String,
    done: bool,
    code: i32,
    pid: Option<u32>,
}

static EXEC_JOBS: OnceLock<Mutex<HashMap<usize, Arc<Mutex<ExecJob>>>>> = OnceLock::new();
static EXEC_JOB_COUNTER: AtomicUsize = AtomicUsize::new(1);

fn exec_jobs_map() -> &'static Mutex<HashMap<usize, Arc<Mutex<ExecJob>>>> {
    EXEC_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes("Access-Control-Allow-Headers", "Content-Type, Range").unwrap(),
        Header::from_bytes("Access-Control-Allow-Private-Network", "true").unwrap(),
    ]
}

fn respond_json(req: Request, status: u16, val: Value) {
    let body = serde_json::to_string(&val).unwrap_or_else(|_| "{}".to_string());
    let mut resp = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    for h in cors_headers() {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

fn respond_html(req: Request, status: u16, html: String) {
    let mut resp = Response::from_string(html)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap());
    for h in cors_headers() {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query_param(url: &str, key: &str) -> Option<String> {
    let q_idx = url.find('?')?;
    let query = &url[q_idx + 1..];
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next().unwrap_or("");
        if k == key {
            return Some(url_decode(parts.next().unwrap_or("")));
        }
    }
    None
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "wma" => "audio/x-ms-wma",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "vtt" => "text/vtt; charset=utf-8",
        "srt" | "txt" | "json" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn resolve_app_paths() -> (PathBuf, PathBuf, PathBuf, bool) {
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("my-view.exe"));
    let exe_dir = exe_path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();

    // Wenn aus src-tauri/target/{debug,release} gestartet: Workspace-Root auflösen
    let mut app_dir = exe_dir.clone();
    let mut is_packaged = true;

    let exe_str = exe_dir.to_string_lossy().to_lowercase();
    if exe_str.contains("target\\debug") || exe_str.contains("target\\release") || exe_str.contains("target/debug") || exe_str.contains("target/release") {
        is_packaged = false;
        // Drei Ebenen hoch: .../src-tauri/target/debug -> workspace root
        let mut cur = exe_dir.as_path();
        for _ in 0..4 {
            if cur.join("src").join("index.html").exists() {
                app_dir = cur.to_path_buf();
                break;
            }
            if let Some(parent) = cur.parent() {
                cur = parent;
            }
        }
    } else if !exe_dir.join("media").exists() {
        if let Ok(cwd) = std::env::current_dir() {
            if cwd.join("src").join("index.html").exists() {
                app_dir = cwd;
                is_packaged = false;
            }
        }
    }

    let media_dir = if is_packaged {
        exe_dir.join("media")
    } else {
        app_dir.join("media")
    };

    (app_dir, media_dir, exe_path, is_packaged)
}

static MKV_REMUX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn find_ffmpeg(media_dir: &Path) -> Option<PathBuf> {
    let bundled = media_dir.join("video").join("ffmpeg.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let local = dir.join("ffmpeg.exe");
            if local.is_file() {
                return Some(local);
            }
        }
    }
    None
}

fn resolve_playable_media_path(path: &Path) -> PathBuf {
    let is_mkv = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mkv"))
        .unwrap_or(false);
    if !is_mkv {
        return path.to_path_buf();
    }

    let sibling_mp4 = path.with_extension("mp4");
    if sibling_mp4.is_file() && fs::metadata(&sibling_mp4).map(|m| m.len() > 1024).unwrap_or(false) {
        return sibling_mp4;
    }

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return path.to_path_buf(),
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key_input = format!(
        "{}|{}|{}",
        path.to_string_lossy().to_lowercase(),
        meta.len(),
        mtime_ms
    );
    let hash = fnv1a_64(key_input.as_bytes());
    let cache_dir = media_dir.join(".mkv_cache");
    let cache_mp4 = cache_dir.join(format!("{:016x}.mp4", hash));

    if cache_mp4.is_file() && fs::metadata(&cache_mp4).map(|m| m.len() > 1024).unwrap_or(false) {
        return cache_mp4;
    }

    let lock = MKV_REMUX_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    if cache_mp4.is_file() && fs::metadata(&cache_mp4).map(|m| m.len() > 1024).unwrap_or(false) {
        return cache_mp4;
    }

    if let Some(ffmpeg) = find_ffmpeg(&media_dir) {
        let _ = fs::create_dir_all(&cache_dir);
        let tmp_mp4 = cache_dir.join(format!("{:016x}.tmp.mp4", hash));
        let _ = fs::remove_file(&tmp_mp4);

        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-nostdin",
            "-err_detect",
            "ignore_err",
            "-fflags",
            "+genpts",
            "-i",
            &path.to_string_lossy(),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-y",
            &tmp_mp4.to_string_lossy(),
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(output) = cmd.output() {
            if output.status.success()
                && fs::metadata(&tmp_mp4).map(|m| m.len() > 1024).unwrap_or(false)
            {
                if fs::rename(&tmp_mp4, &cache_mp4).is_ok() && cache_mp4.is_file() {
                    return cache_mp4;
                }
            }
        }
        let _ = fs::remove_file(&tmp_mp4);
    }

    path.to_path_buf()
}

fn handle_media_stream(req: Request, url: &str) {
    let raw_path = match parse_query_param(url, "path") {
        Some(p) if !p.is_empty() => p,
        _ => {
            respond_json(req, 400, json!({ "error": "Missing path param" }));
            return;
        }
    };

    let orig_path = PathBuf::from(&raw_path);
    let path = if orig_path.is_file() {
        resolve_playable_media_path(&orig_path)
    } else if orig_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mkv"))
        .unwrap_or(false)
        && orig_path.with_extension("mp4").is_file()
    {
        orig_path.with_extension("mp4")
    } else {
        respond_json(req, 404, json!({ "error": "Media file not found" }));
        return;
    };

    let mime = guess_mime(&path);
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            respond_json(req, 500, json!({ "error": e.to_string() }));
            return;
        }
    };

    let total_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(e) => {
            respond_json(req, 500, json!({ "error": e.to_string() }));
            return;
        }
    };

    let range_header = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    if let Some(range_val) = range_header {
        if let Some(spec) = range_val.strip_prefix("bytes=") {
            let mut parts = spec.splitn(2, '-');
            let start = parts.next().unwrap_or("").trim().parse::<u64>().unwrap_or(0);
            let max_chunk: u64 = 4 * 1024 * 1024;
            let requested_end = parts
                .next()
                .unwrap_or("")
                .trim()
                .parse::<u64>()
                .ok();

            if start >= total_len && total_len > 0 {
                let mut resp = Response::empty(416)
                    .with_header(Header::from_bytes("Content-Range", format!("bytes */{}", total_len)).unwrap());
                for h in cors_headers() {
                    resp.add_header(h);
                }
                let _ = req.respond(resp);
                return;
            }

            let end = match requested_end {
                Some(e) => e.min(total_len.saturating_sub(1)).min(start + max_chunk - 1),
                None => total_len.saturating_sub(1).min(start + max_chunk - 1),
            };
            let len = end.saturating_sub(start) + 1;
            let mut buf = vec![0u8; len as usize];
            if file.seek(SeekFrom::Start(start)).is_ok() {
                let mut read_total = 0usize;
                while read_total < buf.len() {
                    match file.read(&mut buf[read_total..]) {
                        Ok(0) => break,
                        Ok(n) => read_total += n,
                        Err(_) => break,
                    }
                }
                buf.truncate(read_total);
                let actual_end = start + (read_total as u64).saturating_sub(1);
                let mut resp = Response::from_data(buf)
                    .with_status_code(StatusCode(206))
                    .with_header(Header::from_bytes("Content-Type", mime).unwrap())
                    .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap())
                    .with_header(
                        Header::from_bytes(
                            "Content-Range",
                            format!("bytes {}-{}/{}", start, actual_end, total_len),
                        )
                        .unwrap(),
                    );
                for h in cors_headers() {
                    resp.add_header(h);
                }
                let _ = req.respond(resp);
                return;
            }
        }
    }

    let mut resp = Response::from_file(file)
        .with_status_code(StatusCode(200))
        .with_header(Header::from_bytes("Content-Type", mime).unwrap())
        .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
    for h in cors_headers() {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

fn read_json_body(req: &mut Request) -> Value {
    let mut s = String::new();
    let _ = req.as_reader().read_to_string(&mut s);
    serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
}

fn handle_fs_api(req: Request, body: Value) {
    let op = body.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let path_str = body.get("path").and_then(|v| v.as_str()).unwrap_or("");

    match op {
        "exists" => {
            respond_json(req, 200, json!({ "exists": Path::new(path_str).exists() }));
        }
        "readdir" => {
            let with_types = body.get("withFileTypes").and_then(|v| v.as_bool()).unwrap_or(false);
            match fs::read_dir(path_str) {
                Ok(entries) => {
                    let mut items = Vec::new();
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if with_types {
                            let ft = entry.file_type().ok();
                            let is_dir = ft.as_ref().map(|t| t.is_dir()).unwrap_or(false);
                            let is_file = ft.as_ref().map(|t| t.is_file()).unwrap_or(false);
                            let size = if is_file {
                                entry.metadata().map(|m| m.len()).unwrap_or(0)
                            } else {
                                0
                            };
                            items.push(json!({ "name": name, "isDir": is_dir, "isFile": is_file, "size": size }));
                        } else {
                            items.push(json!(name));
                        }
                    }
                    respond_json(req, 200, json!({ "items": items }));
                }
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "stat" => match fs::metadata(path_str) {
            Ok(meta) => {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let btime_ms = meta
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(mtime_ms);
                respond_json(
                    req,
                    200,
                    json!({
                        "size": meta.len(),
                        "mtimeMs": mtime_ms,
                        "birthtimeMs": btime_ms,
                        "isDir": meta.is_dir(),
                        "isFile": meta.is_file()
                    }),
                );
            }
            Err(e) => respond_json(req, 404, json!({ "error": e.to_string() })),
        },
        "readText" => match fs::read_to_string(path_str) {
            Ok(text) => respond_json(req, 200, json!({ "text": text })),
            Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
        },
        "readBase64" => match fs::read(path_str) {
            Ok(bytes) => respond_json(req, 200, json!({ "base64": BASE64.encode(bytes) })),
            Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
        },
        "readSlice" => {
            let offset = body.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let length = body.get("length").and_then(|v| v.as_u64()).unwrap_or(0).min(1024 * 1024) as usize;
            match File::open(path_str) {
                Ok(mut f) => {
                    let _ = f.seek(SeekFrom::Start(offset));
                    let mut buf = vec![0u8; length];
                    match f.read(&mut buf) {
                        Ok(n) => {
                            buf.truncate(n);
                            respond_json(req, 200, json!({ "bytesRead": n, "base64": BASE64.encode(buf) }));
                        }
                        Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
                    }
                }
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "writeText" => {
            let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = Path::new(path_str).parent() {
                let _ = fs::create_dir_all(p);
            }
            match fs::write(path_str, text) {
                Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "writeBase64" => {
            let b64 = body.get("base64").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = Path::new(path_str).parent() {
                let _ = fs::create_dir_all(p);
            }
            match BASE64.decode(b64) {
                Ok(bytes) => match fs::write(path_str, bytes) {
                    Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                    Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
                },
                Err(e) => respond_json(req, 400, json!({ "error": e.to_string() })),
            }
        }
        "appendText" => {
            let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = Path::new(path_str).parent() {
                let _ = fs::create_dir_all(p);
            }
            match OpenOptions::new().create(true).append(true).open(path_str) {
                Ok(mut f) => match f.write_all(text.as_bytes()) {
                    Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                    Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
                },
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "mkdir" => {
            let rec = body.get("recursive").and_then(|v| v.as_bool()).unwrap_or(true);
            let res = if rec {
                fs::create_dir_all(path_str)
            } else {
                fs::create_dir(path_str)
            };
            match res {
                Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "unlink" => match fs::remove_file(path_str) {
            Ok(_) => respond_json(req, 200, json!({ "ok": true })),
            Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
        },
        "copy" => {
            let src = body.get("src").and_then(|v| v.as_str()).unwrap_or("");
            let dest = body.get("dest").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = Path::new(dest).parent() {
                let _ = fs::create_dir_all(p);
            }
            match fs::copy(src, dest) {
                Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
            }
        }
        "rename" => {
            let src = body.get("src").and_then(|v| v.as_str()).unwrap_or("");
            let dest = body.get("dest").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = Path::new(dest).parent() {
                let _ = fs::create_dir_all(p);
            }
            match fs::rename(src, dest) {
                Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                Err(_) => match fs::copy(src, dest).and_then(|_| fs::remove_file(src)) {
                    Ok(_) => respond_json(req, 200, json!({ "ok": true })),
                    Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
                },
            }
        }
        _ => respond_json(req, 400, json!({ "error": format!("Unknown fs op: {}", op) })),
    }
}

fn handle_exec_api(req: Request, body: Value) {
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("shell");
    let command = body.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let args: Vec<String> = body
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut cmd = if mode == "spawn" {
        let mut c = Command::new(command);
        c.args(&args);
        c
    } else {
        let mut c = Command::new("cmd.exe");
        c.args(["/C", command]);
        c
    };

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let code = out.status.code().unwrap_or(0);
            respond_json(req, 200, json!({ "code": code, "stdout": stdout, "stderr": stderr }));
        }
        Err(e) => respond_json(
            req,
            200,
            json!({ "code": 1, "stdout": "", "stderr": e.to_string() }),
        ),
    }
}

fn handle_exec_start(req: Request, body: Value) {
    let command = body.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let args: Vec<String> = body
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut cmd = Command::new(command);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            respond_json(req, 500, json!({ "error": e.to_string() }));
            return;
        }
    };

    let pid = Some(child.id());
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let job_id = EXEC_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let job = Arc::new(Mutex::new(ExecJob {
        stdout: String::new(),
        stderr: String::new(),
        done: false,
        code: 0,
        pid,
    }));

    if let Ok(mut map) = exec_jobs_map().lock() {
        map.insert(job_id, job.clone());
    }

    let job_out = job.clone();
    let h_out = thread::spawn(move || {
        if let Some(mut r) = stdout_pipe {
            let mut buf = [0u8; 4096];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut j) = job_out.lock() {
                            j.stdout.push_str(&s);
                        }
                    }
                }
            }
        }
    });

    let job_err = job.clone();
    let h_err = thread::spawn(move || {
        if let Some(mut r) = stderr_pipe {
            let mut buf = [0u8; 4096];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut j) = job_err.lock() {
                            j.stderr.push_str(&s);
                        }
                    }
                }
            }
        }
    });

    let job_wait = job.clone();
    thread::spawn(move || {
        let code = match child.wait() {
            Ok(st) => st.code().unwrap_or(0),
            Err(_) => 1,
        };
        let _ = h_out.join();
        let _ = h_err.join();
        if let Ok(mut j) = job_wait.lock() {
            j.code = code;
            j.pid = None;
            j.done = true;
        }
    });

    respond_json(req, 200, json!({ "id": job_id }));
}

fn handle_exec_poll(req: Request, body: Value) {
    let id = body.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let job_opt = exec_jobs_map()
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned());

    let Some(job_arc) = job_opt else {
        respond_json(req, 200, json!({ "stdout": "", "stderr": "", "done": true, "code": 0 }));
        return;
    };

    let (stdout, stderr, done, code) = if let Ok(mut j) = job_arc.lock() {
        (
            std::mem::take(&mut j.stdout),
            std::mem::take(&mut j.stderr),
            j.done,
            j.code,
        )
    } else {
        (String::new(), String::new(), false, 0)
    };

    if done {
        if let Ok(mut map) = exec_jobs_map().lock() {
            map.remove(&id);
        }
    }

    respond_json(
        req,
        200,
        json!({
            "stdout": stdout,
            "stderr": stderr,
            "done": done,
            "code": code
        }),
    );
}

fn handle_exec_kill(req: Request, body: Value) {
    let id = body.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let pid_opt = exec_jobs_map()
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned())
        .and_then(|job_arc| job_arc.lock().ok().and_then(|j| j.pid));

    if let Some(pid) = pid_opt {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(target_os = "windows")]
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.output();
    }
    respond_json(req, 200, json!({ "ok": true }));
}

fn handle_dialog_api(req: Request, body: Value) {
    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "openMediaFiles" => {
            let files = rfd::FileDialog::new()
                .set_title("Videos & Musik auswählen")
                .add_filter(
                    "Medien (Video & Audio)",
                    &[
                        "mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "ogv", "gif",
                        "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma",
                    ],
                )
                .add_filter("Alle Dateien", &["*"])
                .pick_files();
            match files {
                Some(list) => {
                    let paths: Vec<String> = list.iter().map(|p| p.to_string_lossy().to_string()).collect();
                    respond_json(req, 200, json!({ "canceled": false, "filePaths": paths }));
                }
                None => respond_json(req, 200, json!({ "canceled": true, "filePaths": [] })),
            }
        }
        "openMediaFolder" => {
            let folders = rfd::FileDialog::new()
                .set_title("Medien-Ordner auswählen")
                .pick_folders();
            match folders {
                Some(list) => {
                    let paths: Vec<String> = list.iter().map(|p| p.to_string_lossy().to_string()).collect();
                    respond_json(req, 200, json!({ "canceled": false, "folderPaths": paths }));
                }
                None => respond_json(req, 200, json!({ "canceled": true, "folderPaths": [] })),
            }
        }
        "openAsar" => {
            let file = rfd::FileDialog::new()
                .set_title("Update-Datei auswählen (my_view_app.exe / app.asar)")
                .add_filter("My View Update", &["exe", "asar"])
                .pick_file();
            match file {
                Some(p) => {
                    let original_name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let target_name = if original_name.to_lowercase().ends_with(".exe") {
                        "my_view_update.exe"
                    } else {
                        "my_view_update.asar"
                    };
                    let temp_dest = std::env::temp_dir().join(target_name);
                    let _ = fs::copy(&p, &temp_dest);
                    respond_json(
                        req,
                        200,
                        json!({
                            "success": true,
                            "canceled": false,
                            "filePath": temp_dest.to_string_lossy().to_string(),
                            "originalName": original_name
                        }),
                    );
                }
                None => respond_json(req, 200, json!({ "success": false, "canceled": true })),
            }
        }
        "save" => {
            let default_name = body
                .get("options")
                .and_then(|o| o.get("defaultPath"))
                .and_then(|v| v.as_str())
                .unwrap_or("artwork.png");
            let base = Path::new(default_name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "artwork.png".to_string());
            let saved = rfd::FileDialog::new()
                .set_file_name(&base)
                .add_filter("PNG-Bild", &["png"])
                .save_file();
            match saved {
                Some(p) => respond_json(
                    req,
                    200,
                    json!({ "canceled": false, "filePath": p.to_string_lossy().to_string() }),
                ),
                None => respond_json(req, 200, json!({ "canceled": true })),
            }
        }
        _ => respond_json(req, 400, json!({ "error": "Unknown dialog kind" })),
    }
}

fn apply_window_action(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    action: &str,
    value: Option<bool>,
    rel_x: Option<f64>,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
) -> Result<Value, String> {
    match action {
        "minimize" => {
            let _ = win.minimize();
            Ok(json!({ "ok": true }))
        }
        "maximize" => {
            let is_max = win.is_maximized().unwrap_or(false);
            if is_max {
                let _ = win.unmaximize();
            } else {
                let _ = win.maximize();
            }
            Ok(json!({ "ok": true, "maximized": !is_max }))
        }
        "startDragging" => {
            let _ = win.start_dragging();
            Ok(json!({ "ok": true }))
        }
        "unmaximizeAndDrag" => {
            let is_max = win.is_maximized().unwrap_or(false);
            if is_max {
                let _ = win.unmaximize();
                thread::sleep(Duration::from_millis(18));
                if let Ok(outer) = win.outer_size() {
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let logical_w = (outer.width as f64) / scale;
                    let rx = rel_x.unwrap_or(0.5).clamp(0.05, 0.95);
                    let sx = screen_x.unwrap_or(400.0);
                    let sy = screen_y.unwrap_or(20.0);
                    let new_x = sx - (logical_w * rx);
                    let new_y = (sy - 18.0).max(0.0);
                    let _ = win.set_position(tauri::Position::Logical(
                        tauri::LogicalPosition::new(new_x, new_y),
                    ));
                }
            }
            let _ = win.start_dragging();
            Ok(json!({ "ok": true, "unmaximized": is_max }))
        }
        "close" => {
            if HAS_TRAY_ICON.load(Ordering::Relaxed) {
                let _ = win.hide();
            } else {
                app.exit(0);
            }
            Ok(json!({ "ok": true }))
        }
        "quit" => {
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        "showAndFocus" => {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            Ok(json!({ "ok": true }))
        }
        "setAlwaysOnTop" => {
            let val = value.unwrap_or(false);
            let _ = win.set_always_on_top(val);
            ALWAYS_ON_TOP_STATE.store(val, Ordering::Relaxed);
            Ok(json!({ "value": val }))
        }
        "getAlwaysOnTop" => {
            let val = win
                .is_always_on_top()
                .unwrap_or(ALWAYS_ON_TOP_STATE.load(Ordering::Relaxed));
            Ok(json!({ "value": val }))
        }
        _ => Err(format!("Unknown window action: {}", action)),
    }
}

#[tauri::command]
fn app_window_action(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    value: Option<bool>,
    rel_x: Option<f64>,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
) -> Result<Value, String> {
    apply_window_action(&app, &window, &action, value, rel_x, screen_x, screen_y)
}

fn handle_window_api(req: Request, app: &AppHandle, body: Value) {
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let value = body.get("value").and_then(|v| v.as_bool());
    let rel_x = body.get("relX").and_then(|v| v.as_f64());
    let screen_x = body.get("screenX").and_then(|v| v.as_f64());
    let screen_y = body.get("screenY").and_then(|v| v.as_f64());
    if let Some(win) = app.get_webview_window("main") {
        match apply_window_action(app, &win, action, value, rel_x, screen_x, screen_y) {
            Ok(res) => respond_json(req, 200, res),
            Err(err) => respond_json(req, 400, json!({ "error": err })),
        }
    } else {
        respond_json(req, 404, json!({ "error": "Main window not found" }));
    }
}

fn handle_shell_api(req: Request, body: Value) {
    let op = body.get("op").and_then(|v| v.as_str()).unwrap_or("openPath");
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if op == "trashItem" {
        if target.is_empty() {
            respond_json(req, 400, json!({ "error": "Missing path" }));
            return;
        }
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:MY_VIEW_TRASH_PATH; if (Test-Path -LiteralPath $p -PathType Leaf) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } elseif (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { exit 2 }",
        ])
        .env("MY_VIEW_TRASH_PATH", target);
        #[cfg(target_os = "windows")]
        c.creation_flags(CREATE_NO_WINDOW);
        match c.status() {
            Ok(st) if st.success() => respond_json(req, 200, json!({ "ok": true })),
            Ok(st) => respond_json(
                req,
                500,
                json!({ "error": format!("trashItem failed with code {:?}", st.code()) }),
            ),
            Err(e) => respond_json(req, 500, json!({ "error": e.to_string() })),
        }
        return;
    } else if op == "showItem" {
        let mut c = Command::new("explorer.exe");
        c.args(["/select,", target]);
        #[cfg(target_os = "windows")]
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    } else if !target.is_empty() {
        let _ = open::that(target);
    }
    respond_json(req, 200, json!({ "ok": true }));
}

fn get_stream_auth_state(app: &AppHandle) -> Value {
    let mut twitch_logged_in = false;
    let mut twitch_username: Option<String> = None;
    let mut yt_logged_in = false;

    if let Some(win) = app.get_webview_window("main") {
        for raw_url in ["https://www.twitch.tv/", "https://twitch.tv/"] {
            if let Ok(u) = Url::parse(raw_url) {
                if let Ok(cookies) = win.cookies_for_url(u) {
                    for c in cookies {
                        if c.name() == "auth-token" && !c.value().is_empty() {
                            twitch_logged_in = true;
                        } else if (c.name() == "login" || c.name() == "name")
                            && !c.value().is_empty()
                            && twitch_username.is_none()
                        {
                            twitch_username = Some(c.value().to_string());
                        }
                    }
                }
            }
        }

        if let Ok(u) = Url::parse("https://www.youtube.com/") {
            if let Ok(cookies) = win.cookies_for_url(u) {
                for c in cookies {
                    if matches!(c.name(), "SID" | "__Secure-3PSID" | "LOGIN_INFO")
                        && !c.value().is_empty()
                    {
                        yt_logged_in = true;
                        break;
                    }
                }
            }
        }
    }

    json!({
        "twitch": {
            "loggedIn": twitch_logged_in,
            "username": twitch_username
        },
        "youtube": {
            "loggedIn": yt_logged_in
        }
    })
}

fn notify_stream_auth_changed(app: &AppHandle, state: &Value) {
    if let Some(win) = app.get_webview_window("main") {
        let script = format!(
            "window.__onTauriStreamAuthChanged && window.__onTauriStreamAuthChanged({});",
            state
        );
        let _ = win.eval(&script);
    }
}

fn open_stream_auth_window(app: &AppHandle, platform: &str) {
    let existing_labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|lbl| lbl.starts_with("stream-auth"))
        .cloned()
        .collect();
    for lbl in existing_labels {
        if let Some(w) = app.get_webview_window(&lbl) {
            let _ = w.close();
        }
    }

    let is_twitch = platform == "twitch";
    let auth_url_str = if is_twitch {
        "https://www.twitch.tv/login"
    } else {
        "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/"
    };
    let parsed_url = match Url::parse(auth_url_str) {
        Ok(u) => u,
        Err(_) => return,
    };

    let id = STREAM_AUTH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("stream-auth-{}", id);
    let app_for_load = app.clone();
    let app_for_destroy = app.clone();

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::External(parsed_url),
    )
    .title(if is_twitch {
        "Bei Twitch anmelden (Sub-Vorteile & Emotes)"
    } else {
        "Bei YouTube / Google anmelden"
    })
    .inner_size(620.0, 760.0)
    .center()
    .decorations(true)
    .resizable(true)
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    .on_page_load(move |win, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let cur_url = payload.url().as_str().to_string();
            let app_c = app_for_load.clone();
            let win_c = win.clone();
            thread::spawn(move || {
                let state = get_stream_auth_state(&app_c);
                notify_stream_auth_changed(&app_c, &state);
                let twitch_ok = state
                    .get("twitch")
                    .and_then(|t| t.get("loggedIn"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let yt_ok = state
                    .get("youtube")
                    .and_then(|y| y.get("loggedIn"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let should_close = if is_twitch {
                    twitch_ok
                        && !cur_url.contains("/login")
                        && !cur_url.contains("/two-factor")
                        && !cur_url.contains("passport.twitch.tv")
                } else {
                    yt_ok
                        && cur_url.contains("youtube.com")
                        && !cur_url.contains("accounts.google.com")
                };

                if should_close {
                    thread::sleep(Duration::from_millis(1200));
                    let _ = win_c.close();
                }
            });
        }
    });

    if let Ok(auth_win) = builder.build() {
        let _ = auth_win.set_focus();
        auth_win.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let app_c = app_for_destroy.clone();
                thread::spawn(move || {
                    let state = get_stream_auth_state(&app_c);
                    notify_stream_auth_changed(&app_c, &state);
                });
            }
        });
    }
}

fn logout_stream_platform(app: &AppHandle, platform: &str) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let urls: &[&str] = if platform == "twitch" {
            &[
                "https://www.twitch.tv/",
                "https://twitch.tv/",
                "https://player.twitch.tv/",
                "https://passport.twitch.tv/",
            ]
        } else {
            &[
                "https://www.youtube.com/",
                "https://youtube.com/",
                "https://accounts.google.com/",
            ]
        };
        for raw_url in urls {
            if let Ok(u) = Url::parse(raw_url) {
                if let Ok(cookies) = win.cookies_for_url(u) {
                    for c in cookies {
                        let _ = win.delete_cookie(c);
                    }
                }
            }
        }
    }
    let state = get_stream_auth_state(app);
    notify_stream_auth_changed(app, &state);
    state
}

fn handle_stream_auth_api(req: Request, app: &AppHandle, body: Value) {
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("check");
    let platform = body.get("platform").and_then(|v| v.as_str()).unwrap_or("twitch");
    match action {
        "check" => {
            let state = get_stream_auth_state(app);
            respond_json(req, 200, state);
        }
        "open" => {
            open_stream_auth_window(app, platform);
            respond_json(req, 200, json!({ "ok": true }));
        }
        "logout" => {
            let state = logout_stream_platform(app, platform);
            respond_json(req, 200, json!({ "ok": true, "authState": state }));
        }
        _ => respond_json(req, 400, json!({ "error": format!("Unknown stream-auth action: {}", action) })),
    }
}

fn compare_versions(current: &str, latest: &str) -> i32 {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .trim()
            .split('.')
            .map(|seg| {
                let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().unwrap_or(0)
            })
            .collect()
    };
    let p1 = parse(current);
    let p2 = parse(latest);
    let len = p1.len().max(p2.len()).max(3);
    for i in 0..len {
        let a = *p1.get(i).unwrap_or(&0);
        let b = *p2.get(i).unwrap_or(&0);
        if b > a {
            return 1;
        }
        if b < a {
            return -1;
        }
    }
    0
}

fn sanitize_curl_header_val(val: &str) -> String {
    val.chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '"' | '\\'))
        .collect()
}

fn is_valid_pe_exe(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() <= 100_000 {
        return false;
    }
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic).is_ok() && magic == *b"MZ"
}

fn notify_update_progress(app: &AppHandle, percent: u64, downloaded: u64, total: u64) {
    if let Some(win) = app.get_webview_window("main") {
        let payload = json!({
            "percent": percent.min(100),
            "downloadedBytes": downloaded,
            "totalBytes": total
        });
        let script = format!(
            "window.__onTauriUpdateProgress && window.__onTauriUpdateProgress({});",
            payload
        );
        let _ = win.eval(&script);
    }
}

fn clean_github_repo(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .unwrap_or(trimmed);
    stripped
        .trim_end_matches(".git")
        .trim_matches('/')
        .trim()
        .to_string()
}

fn handle_updater_api(req: Request, app: &AppHandle, body: Value) {
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match action {
        "check" => {
            let raw_repo = body
                .get("repo")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("tobiaslechert445-gif/Video-App");
            let clean_repo = clean_github_repo(raw_repo);
            if clean_repo.is_empty() || !clean_repo.contains('/') {
                respond_json(
                    req,
                    200,
                    json!({
                        "success": false,
                        "error": "Ungültiges Repository-Format. Bitte 'benutzername/repository' angeben."
                    }),
                );
                return;
            }
            let token = body
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            let api_url = format!("https://api.github.com/repos/{}/releases/latest", clean_repo);
            let mut cfg = String::from(
                "header = \"User-Agent: My-Media-App-Updater\"\nheader = \"Accept: application/vnd.github+json\"\n",
            );
            if !token.is_empty() {
                cfg.push_str(&format!(
                    "header = \"Authorization: Bearer {}\"\n",
                    sanitize_curl_header_val(token)
                ));
            }

            let mut cmd = Command::new("curl.exe");
            cmd.args(["-sS", "-L", "-w", "\n%{http_code}", "-K", "-", &api_url])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Verbindungsfehler beim Prüfen auf Updates: {}", e) }),
                    );
                    return;
                }
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(cfg.as_bytes());
            }
            let out = match child.wait_with_output() {
                Ok(o) => o,
                Err(e) => {
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Verbindungsfehler beim Prüfen auf Updates: {}", e) }),
                    );
                    return;
                }
            };

            if !out.status.success() && out.stdout.is_empty() {
                let err_txt = String::from_utf8_lossy(&out.stderr).trim().to_string();
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": format!("Verbindungsfehler beim Prüfen auf Updates: {}", err_txt) }),
                );
                return;
            }

            let stdout_str = String::from_utf8_lossy(&out.stdout);
            let trimmed = stdout_str.trim_end();
            let (body_str, code_str) = match trimmed.rsplit_once('\n') {
                Some((b, c)) => (b, c.trim()),
                None => ("", trimmed.trim()),
            };
            let status_code = code_str.parse::<u16>().unwrap_or(0);

            if status_code == 404 {
                respond_json(
                    req,
                    200,
                    json!({
                        "success": false,
                        "error": "Kein Release auf GitHub gefunden (oder das Repository ist privat und benötigt einen Zugriffs-Token)."
                    }),
                );
                return;
            }
            if status_code == 401 || status_code == 403 {
                respond_json(
                    req,
                    200,
                    json!({
                        "success": false,
                        "error": "GitHub-Zugriff verweigert (HTTP 401/403). Bitte prüfe deinen GitHub-Token (Leserecht 'Contents: Read-only' erforderlich)."
                    }),
                );
                return;
            }
            if status_code != 200 {
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": format!("GitHub API Fehler: HTTP {}", status_code) }),
                );
                return;
            }

            let data: Value = match serde_json::from_str(body_str) {
                Ok(v) => v,
                Err(e) => {
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Antwort von GitHub konnte nicht gelesen werden: {}", e) }),
                    );
                    return;
                }
            };

            let tag_name = data.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
            let latest_version = tag_name.trim_start_matches(['v', 'V']).trim();
            let current_version = app.package_info().version.to_string();
            let has_update = compare_versions(&current_version, latest_version) > 0;

            let empty_vec = Vec::new();
            let assets = data
                .get("assets")
                .and_then(|v| v.as_array())
                .unwrap_or(&empty_vec);

            let chosen = assets
                .iter()
                .find(|a| {
                    a.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.eq_ignore_ascii_case("my_view_app.exe"))
                        .unwrap_or(false)
                })
                .or_else(|| {
                    assets.iter().find(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n.to_lowercase().ends_with(".exe"))
                            .unwrap_or(false)
                    })
                })
                .or_else(|| {
                    assets.iter().find(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n.to_lowercase().ends_with(".asar"))
                            .unwrap_or(false)
                    })
                })
                .or_else(|| assets.first());

            let asset_name = chosen.and_then(|a| a.get("name")).and_then(|v| v.as_str());
            let asset_size = chosen.and_then(|a| a.get("size")).and_then(|v| v.as_u64()).unwrap_or(0);
            let download_url = chosen
                .and_then(|a| a.get("browser_download_url"))
                .and_then(|v| v.as_str());
            let asset_id = chosen.and_then(|a| a.get("id")).cloned().unwrap_or(Value::Null);

            respond_json(
                req,
                200,
                json!({
                    "success": true,
                    "hasUpdate": has_update,
                    "currentVersion": current_version,
                    "latestVersion": latest_version,
                    "releaseName": data.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(latest_version),
                    "releaseNotes": data.get("body").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("Keine Beschreibung vorhanden."),
                    "publishedAt": data.get("published_at").cloned().unwrap_or(Value::Null),
                    "assetName": asset_name,
                    "assetSize": asset_size,
                    "downloadUrl": download_url,
                    "assetId": asset_id,
                    "repo": clean_repo
                }),
            );
        }
        "download" => {
            let download_url = body.get("downloadUrl").and_then(|v| v.as_str()).unwrap_or("").trim();
            let asset_name = body.get("assetName").and_then(|v| v.as_str()).unwrap_or("my_view_app.exe");
            let total_bytes = body.get("assetSize").and_then(|v| v.as_u64()).unwrap_or(0);
            let repo_raw = body.get("repo").and_then(|v| v.as_str()).unwrap_or("");
            let clean_repo = clean_github_repo(repo_raw);
            let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("").trim();
            let asset_id_str = match body.get("assetId") {
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::String(s)) => s.trim().to_string(),
                _ => String::new(),
            };

            let is_asar = asset_name.to_lowercase().ends_with(".asar");
            let target_file = std::env::temp_dir().join(if is_asar {
                "my_view_update.asar"
            } else {
                "my_view_update.exe"
            });
            let _ = fs::remove_file(&target_file);

            let (url, has_token) = if !token.is_empty() && !asset_id_str.is_empty() && !clean_repo.is_empty() {
                (
                    format!("https://api.github.com/repos/{}/releases/assets/{}", clean_repo, asset_id_str),
                    true,
                )
            } else {
                (download_url.to_string(), false)
            };

            if url.is_empty() {
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": "Kein Download-Link für das Update vorhanden." }),
                );
                return;
            }

            let mut cfg = String::from(
                "header = \"User-Agent: My-Media-App-Updater\"\nheader = \"Accept: application/octet-stream\"\n",
            );
            if has_token || !token.is_empty() {
                cfg.push_str(&format!(
                    "header = \"Authorization: Bearer {}\"\n",
                    sanitize_curl_header_val(token)
                ));
            }

            let target_str = target_file.to_string_lossy().to_string();
            let mut cmd = Command::new("curl.exe");
            cmd.args(["-sSL", "-w", "%{http_code}", "-o", &target_str, "-K", "-", &url])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Download konnte nicht gestartet werden: {}", e) }),
                    );
                    return;
                }
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(cfg.as_bytes());
            }

            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        let cur_bytes = fs::metadata(&target_file).map(|m| m.len()).unwrap_or(0);
                        let pct = if total_bytes > 0 {
                            (cur_bytes.saturating_mul(100) / total_bytes).min(99)
                        } else {
                            0
                        };
                        notify_update_progress(app, pct, cur_bytes, total_bytes);
                        thread::sleep(Duration::from_millis(200));
                    }
                    Err(_) => break,
                }
            }

            let out = match child.wait_with_output() {
                Ok(o) => o,
                Err(e) => {
                    let _ = fs::remove_file(&target_file);
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Download fehlgeschlagen: {}", e) }),
                    );
                    return;
                }
            };

            let status_code = String::from_utf8_lossy(&out.stdout).trim().parse::<u16>().unwrap_or(0);
            if !out.status.success() || status_code != 200 {
                let _ = fs::remove_file(&target_file);
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": format!("Download fehlgeschlagen: HTTP {}", status_code) }),
                );
                return;
            }

            let final_size = fs::metadata(&target_file).map(|m| m.len()).unwrap_or(0);
            if final_size == 0 || (!is_asar && !is_valid_pe_exe(&target_file)) {
                let _ = fs::remove_file(&target_file);
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": "Heruntergeladene Update-Datei ist ungültig oder beschädigt." }),
                );
                return;
            }

            notify_update_progress(app, 100, final_size, total_bytes.max(final_size));
            respond_json(
                req,
                200,
                json!({
                    "success": true,
                    "filePath": target_str,
                    "downloadedBytes": final_size
                }),
            );
        }
        "apply" => {
            let default_temp = std::env::temp_dir().join("my_view_update.exe");
            let file_path_str = body
                .get("filePath")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(String::from)
                .unwrap_or_else(|| default_temp.to_string_lossy().to_string());
            let update_path = PathBuf::from(&file_path_str);

            if !update_path.is_file() {
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": "Die Update-Datei wurde nicht gefunden." }),
                );
                return;
            }

            if file_path_str.to_lowercase().ends_with(".asar") || !is_valid_pe_exe(&update_path) {
                respond_json(
                    req,
                    200,
                    json!({
                        "success": false,
                        "error": "Für die Tauri-App wird eine gültige Windows-.exe Update-Datei (my_view_app.exe) benötigt."
                    }),
                );
                return;
            }

            let current_exe = match std::env::current_exe() {
                Ok(p) => p,
                Err(e) => {
                    respond_json(
                        req,
                        200,
                        json!({ "success": false, "error": format!("Aktueller App-Pfad nicht ermittelbar: {}", e) }),
                    );
                    return;
                }
            };

            let bat_path = std::env::temp_dir().join("my_view_tauri_updater.bat");
            let upd_str = update_path.to_string_lossy();
            let exe_str = current_exe.to_string_lossy();
            let bat_content = format!(
                "@echo off\r\nchcp 65001 >nul\r\ntimeout /t 1 /nobreak >nul\r\nset RETRIES=0\r\n:retry\r\ncopy /y \"{}\" \"{}\" >nul 2>&1\r\nif %errorlevel% neq 0 (\r\n    set /a RETRIES+=1\r\n    if %RETRIES% leq 25 (\r\n        timeout /t 1 /nobreak >nul\r\n        goto retry\r\n    )\r\n    goto launch\r\n)\r\ndel \"{}\" >nul 2>&1\r\n:launch\r\nstart \"\" \"{}\"\r\ndel \"%~f0\" >nul 2>&1\r\nexit\r\n",
                upd_str, exe_str, upd_str, exe_str
            );

            if let Err(e) = fs::write(&bat_path, bat_content.as_bytes()) {
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": format!("Updater-Skript konnte nicht geschrieben werden: {}", e) }),
                );
                return;
            }

            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/c", &bat_path.to_string_lossy()]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Err(e) = cmd.spawn() {
                respond_json(
                    req,
                    200,
                    json!({ "success": false, "error": format!("Updater-Skript konnte nicht gestartet werden: {}", e) }),
                );
                return;
            }

            respond_json(req, 200, json!({ "success": true }));
            let app_exit = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300));
                app_exit.exit(0);
            });
        }
        _ => respond_json(
            req,
            400,
            json!({ "success": false, "error": format!("Unknown updater action: {}", action) }),
        ),
    }
}

fn start_bridge_server(app: AppHandle) {
    thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", STREAM_BRIDGE_PORT);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Bridge server bind failed on {}: {}", addr, e);
                return;
            }
        };

        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let method = req.method().clone();

            if method == Method::Options {
                let mut resp = Response::empty(204);
                for h in cors_headers() {
                    resp.add_header(h);
                }
                let _ = req.respond(resp);
                continue;
            }

            let path_only = url.split('?').next().unwrap_or(&url);

            if path_only == "/media" {
                thread::spawn(move || handle_media_stream(req, &url));
                continue;
            }

            if path_only == "/twitch" {
                let ch = parse_query_param(&url, "channel").unwrap_or_default();
                let html = format!(
                    r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Twitch Stream</title><style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:100%;height:100%;overflow:hidden;background:#000}}iframe{{width:100%;height:100%;border:none;display:block}}</style></head><body><iframe src="https://player.twitch.tv/?channel={}&parent=127.0.0.1&parent=localhost&parent=tauri.localhost&autoplay=true&muted=false" allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>"#,
                    ch
                );
                respond_html(req, 200, html);
                continue;
            }

            if path_only == "/twitch-chat" {
                let ch = parse_query_param(&url, "channel").unwrap_or_default();
                let html = format!(
                    r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Twitch Chat</title><style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:100%;height:100%;overflow:hidden;background:#18181b}}iframe{{width:100%;height:100%;border:none;display:block}}</style></head><body><iframe src="https://www.twitch.tv/embed/{}/chat?parent=127.0.0.1&parent=localhost&parent=tauri.localhost&darkpopout" allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>"#,
                    ch
                );
                respond_html(req, 200, html);
                continue;
            }

            if path_only == "/youtube" {
                let vid = parse_query_param(&url, "v").unwrap_or_default();
                let html = format!(
                    r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>YouTube Live</title><style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:100%;height:100%;overflow:hidden;background:#000}}iframe{{width:100%;height:100%;border:none;display:block}}</style></head><body><iframe src="https://www.youtube-nocookie.com/embed/{}?autoplay=1&enablejsapi=1&rel=0&modestbranding=1" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></body></html>"#,
                    vid
                );
                respond_html(req, 200, html);
                continue;
            }

            if path_only == "/youtube-chat" {
                let vid = parse_query_param(&url, "v").unwrap_or_default();
                let html = format!(
                    r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>YouTube Chat</title><style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:100%;height:100%;overflow:hidden;background:#0f0f0f}}iframe{{width:100%;height:100%;border:none;display:block}}</style></head><body><iframe src="https://www.youtube.com/live_chat?v={}&embed_domain=127.0.0.1" allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>"#,
                    vid
                );
                respond_html(req, 200, html);
                continue;
            }

            let body = read_json_body(&mut req);

            match path_only {
                "/api/info" => {
                    let (app_dir, media_dir, exe_path, is_packaged) = resolve_app_paths();
                    let home_dir = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Public".to_string());
                    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
                    respond_json(
                        req,
                        200,
                        json!({
                            "version": app.package_info().version.to_string(),
                            "isPackaged": is_packaged,
                            "appDir": app_dir.to_string_lossy().to_string(),
                            "mediaDir": media_dir.to_string_lossy().to_string(),
                            "execPath": exe_path.to_string_lossy().to_string(),
                            "resourcesDir": exe_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                            "homeDir": home_dir,
                            "tempDir": temp_dir
                        }),
                    );
                }
                "/api/fs" => handle_fs_api(req, body),
                "/api/exec" => {
                    thread::spawn(move || handle_exec_api(req, body));
                }
                "/api/exec_start" => {
                    thread::spawn(move || handle_exec_start(req, body));
                }
                "/api/exec_poll" => handle_exec_poll(req, body),
                "/api/exec_kill" => {
                    thread::spawn(move || handle_exec_kill(req, body));
                }
                "/api/dialog" => {
                    thread::spawn(move || handle_dialog_api(req, body));
                }
                "/api/window" => handle_window_api(req, &app, body),
                "/api/shell" => {
                    thread::spawn(move || handle_shell_api(req, body));
                }
                "/api/stream-auth" => {
                    let app_c = app.clone();
                    thread::spawn(move || handle_stream_auth_api(req, &app_c, body));
                }
                "/api/updater" => {
                    let app_c = app.clone();
                    thread::spawn(move || handle_updater_api(req, &app_c, body));
                }
                _ => respond_json(req, 404, json!({ "error": "Not Found" })),
            }
        }
    });
}

fn try_focus_existing_instance() -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{}", STREAM_BRIDGE_PORT).parse().unwrap();
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let payload = r#"{"action":"showAndFocus"}"#;
        let req = format!(
            "POST /api/window HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            STREAM_BRIDGE_PORT,
            payload.len(),
            payload
        );
        let _ = stream.write_all(req.as_bytes());
        let _ = stream.flush();
        let mut resp = [0u8; 256];
        let _ = stream.read(&mut resp);
        return true;
    }
    false
}

fn main() {
    if try_focus_existing_instance() {
        return;
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_window_action])
        .setup(|app| {
            let handle = app.handle().clone();
            start_bridge_server(handle.clone());

            if let Some(win_cfg) = app.config().app.windows.first() {
                let app_for_popup = app.handle().clone();
                let main_win = tauri::WebviewWindowBuilder::from_config(app, win_cfg)?
                    .use_https_scheme(true)
                    .on_new_window(move |url, features| {
                        let url_str = url.as_str();
                        if url_str == "about:blank"
                            || url.scheme() == "tauri"
                            || url.host_str() == Some("tauri.localhost")
                        {
                            let id = POPOUT_COUNTER.fetch_add(1, Ordering::Relaxed);
                            let label = format!("drawing-studio-{}", id);
                            if let Ok(parsed_blank) = "about:blank".parse() {
                                let builder = tauri::WebviewWindowBuilder::new(
                                    &app_for_popup,
                                    label,
                                    tauri::WebviewUrl::External(parsed_blank),
                                )
                                .window_features(features)
                                .inner_size(1400.0, 900.0)
                                .title("My View - Zeichenstudio (Tablet & 2. Bildschirm)");
                                if let Ok(window) = builder.build() {
                                    return tauri::webview::NewWindowResponse::Create { window };
                                }
                            }
                        }
                        tauri::webview::NewWindowResponse::Allow
                    })
                    .build()?;

                let main_win_dd = main_win.clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::DragDrop(dd) = event {
                        let payload_opt: Option<Value> = match dd {
                            DragDropEvent::Enter { paths, position } => Some(json!({
                                "type": "enter",
                                "paths": paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                                "x": position.x,
                                "y": position.y
                            })),
                            DragDropEvent::Over { position } => Some(json!({
                                "type": "over",
                                "x": position.x,
                                "y": position.y
                            })),
                            DragDropEvent::Leave => Some(json!({ "type": "leave" })),
                            DragDropEvent::Drop { paths, position } => Some(json!({
                                "type": "drop",
                                "paths": paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                                "x": position.x,
                                "y": position.y
                            })),
                            _ => None,
                        };
                        if let Some(payload) = payload_opt {
                            let script = format!(
                                "window.__onTauriDragDrop && window.__onTauriDragDrop({});",
                                payload
                            );
                            let _ = main_win_dd.eval(&script);
                        }
                    }
                });
            }

            if let Some(icon) = app.default_window_icon().cloned() {
                if let (Ok(show_i), Ok(quit_i)) = (
                    MenuItem::with_id(app, "show", "My View öffnen", true, None::<&str>),
                    MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>),
                ) {
                    if let Ok(menu) = Menu::with_items(app, &[&show_i, &quit_i]) {
                        let builder = TrayIconBuilder::new()
                            .icon(icon)
                            .tooltip("My View Media Player")
                            .menu(&menu)
                            .on_menu_event(|app, event| match event.id.as_ref() {
                                "show" => {
                                    if let Some(w) = app.get_webview_window("main") {
                                        let _ = w.unminimize();
                                        let _ = w.show();
                                        let _ = w.set_focus();
                                    }
                                }
                                "quit" => {
                                    app.exit(0);
                                }
                                _ => {}
                            })
                            .on_tray_icon_event(|tray, event| {
                                if let TrayIconEvent::Click {
                                    button: MouseButton::Left,
                                    button_state: MouseButtonState::Up,
                                    ..
                                } = event
                                {
                                    let app = tray.app_handle();
                                    if let Some(w) = app.get_webview_window("main") {
                                        let _ = w.unminimize();
                                        let _ = w.show();
                                        let _ = w.set_focus();
                                    }
                                }
                            });
                        if builder.build(app).is_ok() {
                            HAS_TRAY_ICON.store(true, Ordering::Relaxed);
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten von My View (Tauri)");
}
