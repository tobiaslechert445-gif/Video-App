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
        "ts" | "m2ts" | "mts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "dts" | "dtshd" => "audio/vnd.dts",
        "ac3" => "audio/ac3",
        "eac3" => "audio/eac3",
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
static AUDIO_EXTRACT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SUB_EXTRACT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PLAYABLE_PATH_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
static PROBE_TRACKS_CACHE: OnceLock<Mutex<HashMap<String, ProbedTracks>>> = OnceLock::new();
static FFMPEG_PATH_CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn clear_ffmpeg_and_probe_caches() {
    if let Some(cache) = FFMPEG_PATH_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = None;
        }
    }
    if let Some(cache) = PROBE_TRACKS_CACHE.get() {
        if let Ok(mut map) = cache.lock() {
            map.clear();
        }
    }
}

fn find_ffmpeg(media_dir: &Path) -> Option<PathBuf> {
    let cache = FFMPEG_PATH_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(ref cached) = *guard {
            if cached.is_file() {
                return Some(cached.clone());
            }
        }
    }

    let mut candidates: Vec<PathBuf> = vec![
        media_dir.join("video").join("ffmpeg.exe"),
        media_dir.join("ffmpeg.exe"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("ffmpeg.exe"));
            candidates.push(exe_dir.join("media").join("video").join("ffmpeg.exe"));
            let mut cur = exe_dir.to_path_buf();
            for _ in 0..4 {
                candidates.push(cur.join("media").join("video").join("ffmpeg.exe"));
                candidates.push(cur.join("ffmpeg.exe"));
                candidates.push(
                    cur.join("My_View_Starter_Template")
                        .join("media")
                        .join("video")
                        .join("ffmpeg.exe"),
                );
                let Some(parent) = cur.parent() else {
                    break;
                };
                cur = parent.to_path_buf();
            }
        }
    }

    let mut cur_media = media_dir.to_path_buf();
    for _ in 0..4 {
        candidates.push(cur_media.join("media").join("video").join("ffmpeg.exe"));
        candidates.push(cur_media.join("ffmpeg.exe"));
        candidates.push(
            cur_media
                .join("My_View_Starter_Template")
                .join("media")
                .join("video")
                .join("ffmpeg.exe"),
        );
        let Some(parent) = cur_media.parent() else {
            break;
        };
        cur_media = parent.to_path_buf();
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(profile);
        for sub in ["Downloads", "Desktop", "Documents"] {
            let base = home.join(sub);
            candidates.push(base.join("ffmpeg.exe"));
            candidates.push(
                base.join("My_View_Starter_Template")
                    .join("media")
                    .join("video")
                    .join("ffmpeg.exe"),
            );
            candidates.push(
                base.join("My_Media_App")
                    .join("media")
                    .join("video")
                    .join("ffmpeg.exe"),
            );
        }
    }

    let mut found: Option<PathBuf> = candidates.into_iter().find(|p| p.is_file());

    if found.is_none() {
        let mut cmd = Command::new("where.exe");
        cmd.arg("ffmpeg");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let p = PathBuf::from(line.trim());
                    if p.is_file() {
                        found = Some(p);
                        break;
                    }
                }
            }
        }
    }

    if let Some(ref p) = found {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(p.clone());
        }
    }
    found
}

fn normalize_path_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim().to_lowercase()
}

fn saved_subs_dir_for_media(media_dir: &Path, media_path: &Path) -> PathBuf {
    let parent = media_path
        .parent()
        .map(normalize_path_key)
        .unwrap_or_default();
    let stem = media_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let key_input = format!("{}|{}", parent, stem);
    let hash = fnv1a_64(key_input.as_bytes());
    media_dir
        .join(".sub_cache")
        .join(format!("saved_{:016x}", hash))
}

fn find_companion_mkv_for_mp4(mp4_path: &Path) -> Option<PathBuf> {
    let mkv_twin = mp4_path.with_extension("mkv");
    if mkv_twin.is_file() {
        return Some(mkv_twin);
    }
    let target_name = mp4_path.file_stem()?.to_string_lossy().to_lowercase();
    let target_mkv = format!("{}.mkv", target_name);

    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = mp4_path.components().next() {
        let root_path = PathBuf::from(root.as_os_str());
        search_roots.push(root_path.join("Downloader").join("Downloads"));
        search_roots.push(root_path.join("Downloads"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        search_roots.push(PathBuf::from(profile).join("Downloads"));
    }
    let e_dl = PathBuf::from("E:\\Downloader\\Downloads");
    if !search_roots
        .iter()
        .any(|p| p.to_string_lossy().eq_ignore_ascii_case("E:\\Downloader\\Downloads"))
    {
        search_roots.push(e_dl);
    }

    for root in search_roots {
        if !root.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if entry.file_name().to_string_lossy().to_lowercase() == target_mkv {
                        return Some(p);
                    }
                } else if p.is_dir() {
                    if let Ok(sub_entries) = fs::read_dir(&p) {
                        for sub in sub_entries.flatten() {
                            let sp = sub.path();
                            if sp.is_file()
                                && sub.file_name().to_string_lossy().to_lowercase() == target_mkv
                            {
                                return Some(sp);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn resolve_track_source_paths(raw_path: &str) -> (Option<PathBuf>, Option<PathBuf>) {
    let orig = PathBuf::from(raw_path);
    let ext_lower = orig
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if orig.is_file() {
        let companion = if ext_lower == "mp4" || ext_lower == "m4v" {
            find_companion_mkv_for_mp4(&orig)
        } else {
            None
        };
        return (Some(orig), companion);
    }
    if ext_lower == "mkv" {
        let mp4_twin = orig.with_extension("mp4");
        if mp4_twin.is_file() {
            return (Some(mp4_twin), None);
        }
    }
    (None, None)
}

fn lang_display_name(code: &str) -> &'static str {
    match code.trim().to_lowercase().as_str() {
        "ger" | "deu" | "de" => "Deutsch",
        "eng" | "en" => "Englisch",
        "jpn" | "ja" => "Japanisch",
        "fre" | "fra" | "fr" => "Französisch",
        "spa" | "es" => "Spanisch",
        "ita" | "it" => "Italienisch",
        "por" | "pt" => "Portugiesisch",
        "rus" | "ru" => "Russisch",
        "kor" | "ko" => "Koreanisch",
        "chi" | "zho" | "zh" => "Chinesisch",
        "tur" | "tr" => "Türkisch",
        "pol" | "pl" => "Polnisch",
        "dut" | "nld" | "nl" => "Niederländisch",
        "ara" | "ar" => "Arabisch",
        "hin" | "hi" => "Hindi",
        "und" | "" => "Unbekannt",
        _ => "",
    }
}

fn is_text_subtitle_codec(codec: &str) -> bool {
    let token = codec
        .split(|c: char| c.is_whitespace() || c == '(' || c == '[' || c == ',')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    matches!(
        token.as_str(),
        "subrip"
            | "srt"
            | "ass"
            | "ssa"
            | "webvtt"
            | "vtt"
            | "mov_text"
            | "tx3g"
            | "text"
            | "microdvd"
            | "mpl2"
            | "realtext"
            | "sami"
            | "subviewer"
            | "vplayer"
            | "jacosub"
    )
}

fn extract_stream_lang(header: &str) -> String {
    if let (Some(open), Some(close)) = (header.rfind('('), header.rfind(')')) {
        if close > open + 1 {
            let code = header[open + 1..close].trim().to_lowercase();
            if !code.is_empty() {
                return code;
            }
        }
    }
    "und".to_string()
}

fn extract_stream_codec(details: &str) -> String {
    details
        .split(|c: char| c == ',' || c == '(' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_lowercase()
}

fn is_non_browser_audio_codec(codec: &str) -> bool {
    matches!(
        codec.trim().to_lowercase().as_str(),
        "dts"
            | "dca"
            | "ac3"
            | "eac3"
            | "truehd"
            | "mlp"
            | "wmav1"
            | "wmav2"
            | "wmapro"
            | "wmalossless"
            | "pcm_bluray"
            | "pcm_dvd"
    )
}

fn extract_audio_codec_display(details: &str, codec: &str) -> String {
    let c_lower = codec.trim().to_lowercase();
    let d_lower = details.to_lowercase();
    if c_lower == "dts" || c_lower == "dca" {
        if d_lower.contains("dts:x") {
            return "DTS:X".to_string();
        }
        if d_lower.contains("dts-hd ma") {
            return "DTS-HD MA".to_string();
        }
        if d_lower.contains("dts-hd hra") {
            return "DTS-HD HRA".to_string();
        }
        if d_lower.contains("dts-es") {
            return "DTS-ES".to_string();
        }
        if d_lower.contains("dts 96/24") {
            return "DTS 96/24".to_string();
        }
        return "DTS".to_string();
    }
    match c_lower.as_str() {
        "truehd" => "TrueHD".to_string(),
        "eac3" => "E-AC3".to_string(),
        "ac3" => "AC3".to_string(),
        "aac" => "AAC".to_string(),
        "flac" => "FLAC".to_string(),
        "opus" => "Opus".to_string(),
        "mp3" => "MP3".to_string(),
        _ => codec.to_uppercase(),
    }
}

fn extract_audio_channels(details: &str) -> String {
    for part in details.split(',').skip(1) {
        let low = part.trim().to_lowercase();
        if low.contains("7.1") {
            return "7.1".to_string();
        }
        if low.contains("6.1") {
            return "6.1".to_string();
        }
        if low.contains("5.1") {
            return "5.1".to_string();
        }
        if low.starts_with("quad") {
            return "4.0".to_string();
        }
        if low.contains("stereo") || low.starts_with("2 channels") {
            return "Stereo".to_string();
        }
        if low.contains("mono") || low.starts_with("1 channels") {
            return "Mono".to_string();
        }
        if low.contains("channels") {
            return part.trim().to_string();
        }
    }
    String::new()
}

#[derive(Clone)]
struct ProbedTracks {
    video_codec: String,
    audio: Vec<Value>,
    subtitles: Vec<Value>,
}

fn probe_media_tracks(media_path: &Path, media_dir: &Path) -> ProbedTracks {
    let cache_key = fs::metadata(media_path).ok().map(|m| {
        let mtime_ms = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        format!("{}|{}|{}", normalize_path_key(media_path), m.len(), mtime_ms)
    });
    if let Some(ref k) = cache_key {
        let cache = PROBE_TRACKS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(map) = cache.lock() {
            if let Some(hit) = map.get(k) {
                return hit.clone();
            }
        }
    }

    struct RawAudioEntry {
        index: usize,
        lang: String,
        codec: String,
        codec_display: String,
        channels: String,
        title: String,
        is_default: bool,
        is_forced: bool,
    }
    let mut video_codec = String::new();
    let mut audio_entries: Vec<RawAudioEntry> = Vec::new();
    let mut sub_entries: Vec<(usize, String, String, String, bool, bool, bool)> = Vec::new();

    let Some(ffmpeg) = find_ffmpeg(media_dir) else {
        return ProbedTracks {
            video_codec,
            audio: Vec::new(),
            subtitles: Vec::new(),
        };
    };

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-i", &media_path.to_string_lossy()]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let Ok(output) = cmd.output() else {
        return ProbedTracks {
            video_codec,
            audio: Vec::new(),
            subtitles: Vec::new(),
        };
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    enum ActiveStream {
        None,
        Audio(usize),
        Subtitle(usize),
    }
    let mut current = ActiveStream::None;

    for raw_line in stderr.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("Stream #") {
            if let Some(pos) = trimmed.find(": Audio:") {
                let idx = audio_entries.len();
                let header = &trimmed[..pos];
                let details = trimmed[pos + ": Audio:".len()..].trim();
                let lang = extract_stream_lang(header);
                let codec = extract_stream_codec(details);
                let codec_display = extract_audio_codec_display(details, &codec);
                let channels = extract_audio_channels(details);
                let lower = details.to_lowercase();
                let is_default = lower.contains("(default)");
                let is_forced = lower.contains("(forced)");
                audio_entries.push(RawAudioEntry {
                    index: idx,
                    lang,
                    codec,
                    codec_display,
                    channels,
                    title: String::new(),
                    is_default,
                    is_forced,
                });
                current = ActiveStream::Audio(idx);
            } else if let Some(pos) = trimmed.find(": Subtitle:") {
                let idx = sub_entries.len();
                let header = &trimmed[..pos];
                let details = trimmed[pos + ": Subtitle:".len()..].trim();
                let lang = extract_stream_lang(header);
                let codec = extract_stream_codec(details);
                let is_text = is_text_subtitle_codec(&codec);
                let lower = details.to_lowercase();
                let is_default = lower.contains("(default)");
                let is_forced = lower.contains("(forced)");
                sub_entries.push((idx, lang, codec, String::new(), is_default, is_forced, is_text));
                current = ActiveStream::Subtitle(idx);
            } else if let Some(pos) = trimmed.find(": Video:") {
                if video_codec.is_empty() && !trimmed.to_lowercase().contains("(attached pic)") {
                    let details = trimmed[pos + ": Video:".len()..].trim();
                    video_codec = extract_stream_codec(details);
                }
                current = ActiveStream::None;
            } else {
                current = ActiveStream::None;
            }
            continue;
        }

        if !raw_line.starts_with("    ") {
            current = ActiveStream::None;
            continue;
        }

        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("title") {
                let title_val = v.trim().to_string();
                if !title_val.is_empty() {
                    match current {
                        ActiveStream::Audio(i) => {
                            if let Some(entry) = audio_entries.get_mut(i) {
                                entry.title = title_val;
                            }
                        }
                        ActiveStream::Subtitle(i) => {
                            if let Some(entry) = sub_entries.get_mut(i) {
                                entry.3 = title_val;
                            }
                        }
                        ActiveStream::None => {}
                    }
                }
            }
        }
    }

    let audio = audio_entries
        .into_iter()
        .map(|entry| {
            let disp = lang_display_name(&entry.lang);
            let lang_name = if !disp.is_empty() {
                disp.to_string()
            } else {
                entry.lang.to_uppercase()
            };
            json!({
                "index": entry.index,
                "lang": entry.lang,
                "langName": lang_name,
                "codec": entry.codec,
                "codecDisplay": entry.codec_display,
                "channels": entry.channels,
                "title": entry.title,
                "isDefault": entry.is_default,
                "isForced": entry.is_forced
            })
        })
        .collect();

    let subtitles = sub_entries
        .into_iter()
        .map(|(idx, lang, codec, title, is_default, is_forced, is_text)| {
            let disp = lang_display_name(&lang);
            let lang_name = if !disp.is_empty() {
                disp.to_string()
            } else {
                lang.to_uppercase()
            };
            json!({
                "index": idx,
                "lang": lang,
                "langName": lang_name,
                "codec": codec,
                "title": title,
                "isDefault": is_default,
                "isForced": is_forced,
                "isText": is_text,
                "source": "embedded"
            })
        })
        .collect();

    let probed = ProbedTracks {
        video_codec,
        audio,
        subtitles,
    };
    if let Some(ref k) = cache_key {
        let cache = PROBE_TRACKS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(mut map) = cache.lock() {
            map.insert(k.clone(), probed.clone());
        }
    }
    probed
}

fn file_hash_key(path: &Path, extra: &str) -> u64 {
    let meta = fs::metadata(path).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime_ms = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key_input = format!("{}|{}|{}|{}", normalize_path_key(path), len, mtime_ms, extra);
    fnv1a_64(key_input.as_bytes())
}

fn store_playable_path_cache(cache_key: &str, resolved: &Path) {
    let cache = PLAYABLE_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = cache.lock() {
        map.insert(cache_key.to_string(), resolved.to_path_buf());
    }
}

fn run_ffmpeg_video_remux(
    ffmpeg: &Path,
    src: &Path,
    tmp_mp4: &Path,
    transcode_video: bool,
    is_hevc: bool,
    copy_audio: bool,
) -> bool {
    let _ = fs::remove_file(tmp_mp4);
    let src_str = src.to_string_lossy().to_string();
    let out_str = tmp_mp4.to_string_lossy().to_string();

    let mut args: Vec<&str> = vec!["-nostdin", "-err_detect", "ignore_err"];
    if transcode_video {
        args.extend(["-fflags", "+genpts"]);
    }
    args.extend([
        "-i",
        &src_str,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "0",
    ]);
    if transcode_video {
        args.extend([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
        ]);
    } else {
        args.extend(["-c:v", "copy"]);
        if is_hevc {
            args.extend(["-tag:v", "hvc1", "-strict", "unofficial"]);
        }
    }
    if copy_audio {
        args.extend(["-c:a", "copy"]);
    } else {
        args.extend([
            "-c:a",
            "aac",
            "-aac_coder",
            "fast",
            "-b:a",
            "256k",
            "-ac",
            "2",
        ]);
    }
    args.extend(["-movflags", "+faststart", "-y", &out_str]);

    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output()
        .map(|o| o.status.success() && fs::metadata(tmp_mp4).map(|m| m.len() > 1024).unwrap_or(false))
        .unwrap_or(false)
}

fn resolve_playable_media_path(path: &Path) -> PathBuf {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let is_standalone_transcode_audio =
        matches!(ext.as_str(), "dts" | "dtshd" | "ac3" | "eac3" | "wma");
    let is_always_remux_video =
        matches!(ext.as_str(), "mkv" | "ts" | "m2ts" | "mts" | "avi" | "flv" | "wmv");
    let is_probe_video = matches!(ext.as_str(), "mp4" | "m4v" | "mov" | "webm");

    if !is_standalone_transcode_audio && !is_always_remux_video && !is_probe_video {
        return path.to_path_buf();
    }

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
    let cache_key = format!("{}|{}|{}", normalize_path_key(path), meta.len(), mtime_ms);

    let mem_cache = PLAYABLE_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = mem_cache.lock() {
        if let Some(cached) = map.get(&cache_key) {
            if cached.is_file() {
                return cached.clone();
            }
        }
    }

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();

    if ext == "mkv" {
        let sibling_mp4 = path.with_extension("mp4");
        if sibling_mp4.is_file()
            && fs::metadata(&sibling_mp4)
                .map(|m| m.len() > 1024)
                .unwrap_or(false)
        {
            let sib_probed = probe_media_tracks(&sibling_mp4, &media_dir);
            let sib_codec = sib_probed
                .audio
                .first()
                .and_then(|t| t.get("codec"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !is_non_browser_audio_codec(sib_codec) {
                store_playable_path_cache(&cache_key, &sibling_mp4);
                return sibling_mp4;
            }
        }
    }

    let hash = fnv1a_64(cache_key.as_bytes());
    let cache_dir = media_dir.join(".mkv_cache");

    if is_standalone_transcode_audio {
        let cache_m4a = cache_dir.join(format!("audio_standalone_{:016x}.m4a", hash));
        if cache_m4a.is_file()
            && fs::metadata(&cache_m4a)
                .map(|m| m.len() > 128)
                .unwrap_or(false)
        {
            store_playable_path_cache(&cache_key, &cache_m4a);
            return cache_m4a;
        }

        let lock = AUDIO_EXTRACT_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

        if cache_m4a.is_file()
            && fs::metadata(&cache_m4a)
                .map(|m| m.len() > 128)
                .unwrap_or(false)
        {
            store_playable_path_cache(&cache_key, &cache_m4a);
            return cache_m4a;
        }

        if let Some(ffmpeg) = find_ffmpeg(&media_dir) {
            let _ = fs::create_dir_all(&cache_dir);
            let tmp_m4a = cache_dir.join(format!("audio_standalone_{:016x}.tmp.m4a", hash));
            let _ = fs::remove_file(&tmp_m4a);

            let mut cmd = Command::new(&ffmpeg);
            cmd.args([
                "-nostdin",
                "-err_detect",
                "ignore_err",
                "-fflags",
                "+genpts",
                "-i",
                &path.to_string_lossy(),
                "-vn",
                "-sn",
                "-dn",
                "-c:a",
                "aac",
                "-aac_coder",
                "fast",
                "-b:a",
                "320k",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                "-y",
                &tmp_m4a.to_string_lossy(),
            ]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(output) = cmd.output() {
                if output.status.success()
                    && fs::metadata(&tmp_m4a)
                        .map(|m| m.len() > 128)
                        .unwrap_or(false)
                {
                    if fs::rename(&tmp_m4a, &cache_m4a).is_ok() && cache_m4a.is_file() {
                        store_playable_path_cache(&cache_key, &cache_m4a);
                        return cache_m4a;
                    }
                }
            }
            let _ = fs::remove_file(&tmp_m4a);
        }

        return path.to_path_buf();
    }

    let probed = probe_media_tracks(path, &media_dir);
    let track0_codec = probed
        .audio
        .first()
        .and_then(|t| t.get("codec"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if is_probe_video && !is_non_browser_audio_codec(track0_codec) {
        store_playable_path_cache(&cache_key, path);
        return path.to_path_buf();
    }

    let is_hevc = probed.video_codec == "hevc" || probed.video_codec == "h265";
    let copy_audio = matches!(track0_codec, "aac" | "mp3") || probed.audio.is_empty();

    let cache_mp4 = if is_probe_video {
        cache_dir.join(format!("v3_remux_{:016x}.mp4", hash))
    } else {
        cache_dir.join(format!("v3_{:016x}.mp4", hash))
    };

    if cache_mp4.is_file()
        && fs::metadata(&cache_mp4)
            .map(|m| m.len() > 1024)
            .unwrap_or(false)
    {
        store_playable_path_cache(&cache_key, &cache_mp4);
        return cache_mp4;
    }

    let lock = MKV_REMUX_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    if cache_mp4.is_file()
        && fs::metadata(&cache_mp4)
            .map(|m| m.len() > 1024)
            .unwrap_or(false)
    {
        store_playable_path_cache(&cache_key, &cache_mp4);
        return cache_mp4;
    }

    if let Some(ffmpeg) = find_ffmpeg(&media_dir) {
        let _ = fs::create_dir_all(&cache_dir);
        let tmp_mp4 = if is_probe_video {
            cache_dir.join(format!("v3_remux_{:016x}.tmp.mp4", hash))
        } else {
            cache_dir.join(format!("v3_{:016x}.tmp.mp4", hash))
        };

        let ok = run_ffmpeg_video_remux(&ffmpeg, path, &tmp_mp4, false, is_hevc, copy_audio)
            || (copy_audio
                && run_ffmpeg_video_remux(&ffmpeg, path, &tmp_mp4, false, is_hevc, false))
            || run_ffmpeg_video_remux(&ffmpeg, path, &tmp_mp4, true, false, false);

        if ok && fs::rename(&tmp_mp4, &cache_mp4).is_ok() && cache_mp4.is_file() {
            store_playable_path_cache(&cache_key, &cache_mp4);
            return cache_mp4;
        }
        let _ = fs::remove_file(&tmp_mp4);
    }

    path.to_path_buf()
}

fn serve_file_with_ranges(req: Request, path: &Path) {
    let mime = guess_mime(path);
    let mut file = match File::open(path) {
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
            if total_len > 0 {
                let mut parts = spec.splitn(2, '-');
                let start = parts.next().unwrap_or("").trim().parse::<u64>().unwrap_or(0);
                let requested_end = parts
                    .next()
                    .unwrap_or("")
                    .trim()
                    .parse::<u64>()
                    .ok();

                if start >= total_len {
                    let mut resp = Response::empty(416)
                        .with_header(Header::from_bytes("Content-Range", format!("bytes */{}", total_len)).unwrap());
                    for h in cors_headers() {
                        resp.add_header(h);
                    }
                    let _ = req.respond(resp);
                    return;
                }

                let end = match requested_end {
                    Some(e) => e.min(total_len.saturating_sub(1)).max(start),
                    None => total_len.saturating_sub(1),
                };
                let len = end.saturating_sub(start) + 1;
                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let mut headers = vec![
                        Header::from_bytes("Content-Type", mime).unwrap(),
                        Header::from_bytes("Accept-Ranges", "bytes").unwrap(),
                        Header::from_bytes(
                            "Content-Range",
                            format!("bytes {}-{}/{}", start, end, total_len),
                        )
                        .unwrap(),
                    ];
                    headers.extend(cors_headers());
                    let resp = Response::new(
                        StatusCode(206),
                        headers,
                        file.take(len),
                        Some(len as usize),
                        None,
                    );
                    let _ = req.respond(resp);
                    return;
                }
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

    serve_file_with_ranges(req, &path);
}

fn handle_media_audio_stream(req: Request, url: &str) {
    let raw_path = match parse_query_param(url, "path") {
        Some(p) if !p.is_empty() => p,
        _ => {
            respond_json(req, 400, json!({ "error": "Missing path param" }));
            return;
        }
    };
    let track: usize = match parse_query_param(url, "track").and_then(|t| t.parse().ok()) {
        Some(t) if t < 32 => t,
        _ => {
            respond_json(req, 400, json!({ "error": "Invalid track param" }));
            return;
        }
    };

    let (primary_opt, companion_opt) = resolve_track_source_paths(&raw_path);
    let Some(primary) = primary_opt else {
        respond_json(req, 404, json!({ "error": "Media file not found" }));
        return;
    };

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
    let audio_src = if let Some(ref companion) = companion_opt {
        let primary_probe = probe_media_tracks(&primary, &media_dir);
        if track < primary_probe.audio.len() {
            primary.clone()
        } else {
            companion.clone()
        }
    } else {
        primary.clone()
    };

    let hash = file_hash_key(&audio_src, &format!("a{}", track));
    let cache_dir = media_dir.join(".mkv_cache");
    let cache_m4a = cache_dir.join(format!("audio_{:016x}_t{}.m4a", hash, track));

    if cache_m4a.is_file() && fs::metadata(&cache_m4a).map(|m| m.len() > 128).unwrap_or(false) {
        serve_file_with_ranges(req, &cache_m4a);
        return;
    }

    let lock = AUDIO_EXTRACT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    if cache_m4a.is_file() && fs::metadata(&cache_m4a).map(|m| m.len() > 128).unwrap_or(false) {
        serve_file_with_ranges(req, &cache_m4a);
        return;
    }

    let Some(ffmpeg) = find_ffmpeg(&media_dir) else {
        respond_json(req, 500, json!({ "error": "ffmpeg.exe nicht gefunden" }));
        return;
    };

    let _ = fs::create_dir_all(&cache_dir);
    let tmp_m4a = cache_dir.join(format!("audio_{:016x}_t{}.tmp.m4a", hash, track));
    let _ = fs::remove_file(&tmp_m4a);

    let map_arg = format!("0:a:{}", track);
    let audio_probed = probe_media_tracks(&audio_src, &media_dir);
    let track_codec = audio_probed
        .audio
        .get(track)
        .and_then(|t| t.get("codec"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let can_copy = track_codec == "aac";

    let run_extract = |copy_only: bool| -> bool {
        let _ = fs::remove_file(&tmp_m4a);
        let src_str = audio_src.to_string_lossy().to_string();
        let out_str = tmp_m4a.to_string_lossy().to_string();
        let mut args: Vec<&str> = Vec::new();
        args.extend(["-nostdin", "-err_detect", "ignore_err"]);
        if !copy_only {
            args.extend(["-fflags", "+genpts"]);
        }
        args.extend([
            "-i",
            &src_str,
            "-vn",
            "-sn",
            "-dn",
            "-map",
            &map_arg,
        ]);
        if copy_only {
            args.extend(["-c:a", "copy"]);
        } else {
            args.extend([
                "-c:a",
                "aac",
                "-aac_coder",
                "fast",
                "-b:a",
                "320k",
                "-ac",
                "2",
            ]);
        }
        args.extend(["-movflags", "+faststart", "-y", &out_str]);
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(&args);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|o| {
                o.status.success() && fs::metadata(&tmp_m4a).map(|m| m.len() > 128).unwrap_or(false)
            })
            .unwrap_or(false)
    };

    let ok = (can_copy && run_extract(true)) || run_extract(false);
    if ok && fs::rename(&tmp_m4a, &cache_m4a).is_ok() && cache_m4a.is_file() {
        serve_file_with_ranges(req, &cache_m4a);
        return;
    }
    let _ = fs::remove_file(&tmp_m4a);
    respond_json(req, 500, json!({ "error": "Audio track extraction failed" }));
}

fn handle_media_subtitle_stream(req: Request, url: &str) {
    let raw_path = match parse_query_param(url, "path") {
        Some(p) if !p.is_empty() => p,
        _ => {
            respond_json(req, 400, json!({ "error": "Missing path param" }));
            return;
        }
    };
    let track: usize = match parse_query_param(url, "track").and_then(|t| t.parse().ok()) {
        Some(t) if t < 32 => t,
        _ => {
            respond_json(req, 400, json!({ "error": "Invalid track param" }));
            return;
        }
    };

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
    let saved_dir = saved_subs_dir_for_media(&media_dir, Path::new(&raw_path));
    let saved_vtt = saved_dir.join(format!("sub_{}.vtt", track));
    if saved_vtt.is_file() && fs::metadata(&saved_vtt).map(|m| m.len() > 10).unwrap_or(false) {
        serve_file_with_ranges(req, &saved_vtt);
        return;
    }

    let (primary_opt, companion_opt) = resolve_track_source_paths(&raw_path);
    let Some(primary) = primary_opt else {
        respond_json(req, 404, json!({ "error": "Media file not found" }));
        return;
    };

    let sub_src = if let Some(ref companion) = companion_opt {
        let primary_probe = probe_media_tracks(&primary, &media_dir);
        if track < primary_probe.subtitles.len() {
            primary.clone()
        } else {
            companion.clone()
        }
    } else {
        primary.clone()
    };

    let hash = file_hash_key(&sub_src, &format!("s{}", track));
    let cache_dir = media_dir.join(".sub_cache");
    let cache_vtt = cache_dir.join(format!("sub_{:016x}_s{}.vtt", hash, track));

    if cache_vtt.is_file() && fs::metadata(&cache_vtt).map(|m| m.len() > 10).unwrap_or(false) {
        serve_file_with_ranges(req, &cache_vtt);
        return;
    }

    let lock = SUB_EXTRACT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    if cache_vtt.is_file() && fs::metadata(&cache_vtt).map(|m| m.len() > 10).unwrap_or(false) {
        serve_file_with_ranges(req, &cache_vtt);
        return;
    }

    let Some(ffmpeg) = find_ffmpeg(&media_dir) else {
        respond_json(req, 500, json!({ "error": "ffmpeg.exe nicht gefunden" }));
        return;
    };

    let _ = fs::create_dir_all(&cache_dir);
    let tmp_vtt = cache_dir.join(format!("sub_{:016x}_s{}.tmp.vtt", hash, track));
    let _ = fs::remove_file(&tmp_vtt);

    let map_arg = format!("0:s:{}", track);
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-nostdin",
        "-err_detect",
        "ignore_err",
        "-i",
        &sub_src.to_string_lossy(),
        "-map",
        &map_arg,
        "-c:s",
        "webvtt",
        "-y",
        &tmp_vtt.to_string_lossy(),
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(output) = cmd.output() {
        if output.status.success() && fs::metadata(&tmp_vtt).map(|m| m.len() > 10).unwrap_or(false) {
            if fs::rename(&tmp_vtt, &cache_vtt).is_ok() && cache_vtt.is_file() {
                serve_file_with_ranges(req, &cache_vtt);
                return;
            }
        }
    }
    let _ = fs::remove_file(&tmp_vtt);
    respond_json(req, 500, json!({ "error": "Subtitle track extraction failed" }));
}

fn handle_media_tracks_api(req: Request, body: Value) {
    let raw_path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if raw_path.is_empty() {
        respond_json(req, 400, json!({ "error": "Missing path" }));
        return;
    }

    let (primary_opt, companion_opt) = resolve_track_source_paths(raw_path);
    let Some(primary) = primary_opt else {
        respond_json(req, 404, json!({ "error": "Media file not found" }));
        return;
    };

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
    let mut probed = probe_media_tracks(&primary, &media_dir);

    if let Some(ref companion) = companion_opt {
        let comp_probed = probe_media_tracks(companion, &media_dir);
        if comp_probed.audio.len() > probed.audio.len() {
            probed.audio = comp_probed.audio;
        }
        if probed.subtitles.is_empty() && !comp_probed.subtitles.is_empty() {
            probed.subtitles = comp_probed.subtitles;
        }
    }

    let saved_dir = saved_subs_dir_for_media(&media_dir, Path::new(raw_path));
    if probed.subtitles.is_empty() {
        let manifest_path = saved_dir.join("manifest.json");
        if let Ok(txt) = fs::read_to_string(&manifest_path) {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&txt) {
                if !arr.is_empty() {
                    probed.subtitles = arr;
                }
            }
        }
    }

    let audio_meta_path = saved_dir.join("audio_tracks.json");
    if let Ok(txt) = fs::read_to_string(&audio_meta_path) {
        if let Ok(Value::Array(saved_audio)) = serde_json::from_str::<Value>(&txt) {
            if saved_audio.len() == probed.audio.len() {
                for (dst, src) in probed.audio.iter_mut().zip(saved_audio.iter()) {
                    if let (Some(dst_obj), Some(src_obj)) = (dst.as_object_mut(), src.as_object()) {
                        let dst_title = dst_obj.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        if dst_title.is_empty() {
                            if let Some(src_title) = src_obj.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                                dst_obj.insert("title".to_string(), json!(src_title));
                            }
                        }
                        let dst_cd = dst_obj.get("codecDisplay").and_then(|v| v.as_str()).unwrap_or("");
                        if dst_cd.is_empty() {
                            if let Some(src_cd) = src_obj.get("codecDisplay").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                                dst_obj.insert("codecDisplay".to_string(), json!(src_cd));
                            }
                        }
                        let dst_ch = dst_obj.get("channels").and_then(|v| v.as_str()).unwrap_or("");
                        if dst_ch.is_empty() {
                            if let Some(src_ch) = src_obj.get("channels").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                                dst_obj.insert("channels".to_string(), json!(src_ch));
                            }
                        }
                    }
                }
            }
        }
    }

    respond_json(
        req,
        200,
        json!({
            "ok": true,
            "path": raw_path,
            "resolvedPath": primary.to_string_lossy().to_string(),
            "ffmpegAvailable": find_ffmpeg(&media_dir).is_some(),
            "audioTracks": probed.audio,
            "subtitleTracks": probed.subtitles
        }),
    );
}

fn handle_extract_subtitles_api(req: Request, body: Value) {
    let raw_path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if raw_path.is_empty() {
        respond_json(req, 400, json!({ "error": "Missing path" }));
        return;
    }

    let src_path = {
        let direct = PathBuf::from(raw_path);
        if direct.is_file() {
            direct
        } else if let (Some(primary), _) = resolve_track_source_paths(raw_path) {
            primary
        } else {
            respond_json(req, 404, json!({ "error": "Media file not found" }));
            return;
        }
    };

    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
    let probed = probe_media_tracks(&src_path, &media_dir);
    let saved_dir = saved_subs_dir_for_media(&media_dir, Path::new(raw_path));

    let Some(ffmpeg) = find_ffmpeg(&media_dir) else {
        respond_json(req, 200, json!({ "ok": false, "count": 0, "error": "ffmpeg missing" }));
        return;
    };

    let lock = SUB_EXTRACT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _ = fs::create_dir_all(&saved_dir);

    if !probed.audio.is_empty() {
        if let Ok(audio_json) = serde_json::to_string_pretty(&probed.audio) {
            let _ = fs::write(saved_dir.join("audio_tracks.json"), audio_json);
        }
    }

    let mut manifest_entries: Vec<Value> = Vec::new();
    for item in probed.subtitles {
        let is_text = item.get("isText").and_then(|v| v.as_bool()).unwrap_or(false);
        if !is_text {
            continue;
        }
        let Some(idx) = item.get("index").and_then(|v| v.as_u64()) else {
            continue;
        };
        let vtt_name = format!("sub_{}.vtt", idx);
        let out_vtt = saved_dir.join(&vtt_name);
        let tmp_vtt = saved_dir.join(format!("sub_{}.tmp.vtt", idx));
        let _ = fs::remove_file(&tmp_vtt);

        let map_arg = format!("0:s:{}", idx);
        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-nostdin",
            "-err_detect",
            "ignore_err",
            "-i",
            &src_path.to_string_lossy(),
            "-map",
            &map_arg,
            "-c:s",
            "webvtt",
            "-y",
            &tmp_vtt.to_string_lossy(),
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(output) = cmd.output() {
            if output.status.success() && fs::metadata(&tmp_vtt).map(|m| m.len() > 10).unwrap_or(false) {
                let _ = fs::rename(&tmp_vtt, &out_vtt);
                if out_vtt.is_file() {
                    let mut entry = item.clone();
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("source".to_string(), json!("saved"));
                        obj.insert("file".to_string(), json!(vtt_name));
                    }
                    manifest_entries.push(entry);
                }
            }
        }
        let _ = fs::remove_file(&tmp_vtt);
    }

    let manifest_path = saved_dir.join("manifest.json");
    if let Ok(serialized) = serde_json::to_string_pretty(&manifest_entries) {
        let _ = fs::write(&manifest_path, serialized);
    }

    respond_json(
        req,
        200,
        json!({
            "ok": true,
            "count": manifest_entries.len(),
            "savedDir": saved_dir.to_string_lossy().to_string(),
            "subtitleTracks": manifest_entries
        }),
    );
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
                        "mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "ogv", "ts", "m2ts", "gif",
                        "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "dts", "dtshd", "ac3", "eac3",
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
        "openFfmpeg" => {
            let file = rfd::FileDialog::new()
                .set_title("ffmpeg.exe auswählen")
                .add_filter("FFmpeg Executable", &["exe"])
                .pick_file();
            match file {
                Some(p) => {
                    let (_app_dir, media_dir, _exe, _pkg) = resolve_app_paths();
                    let target_dir = media_dir.join("video");
                    let _ = fs::create_dir_all(&target_dir);
                    let dest = target_dir.join("ffmpeg.exe");
                    let copy_res = if p.to_string_lossy().eq_ignore_ascii_case(&dest.to_string_lossy()) {
                        Ok(0)
                    } else {
                        fs::copy(&p, &dest)
                    };
                    clear_ffmpeg_and_probe_caches();
                    match copy_res {
                        Ok(_) => respond_json(
                            req,
                            200,
                            json!({
                                "success": true,
                                "canceled": false,
                                "filePath": p.to_string_lossy().to_string(),
                                "installedTo": dest.to_string_lossy().to_string()
                            }),
                        ),
                        Err(e) => respond_json(
                            req,
                            200,
                            json!({
                                "success": false,
                                "canceled": false,
                                "error": format!("Konnte ffmpeg.exe nicht kopieren: {}", e)
                            }),
                        ),
                    }
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

fn build_system_check_payload(app: &AppHandle) -> Value {
    let (app_dir, media_dir, exe_path, is_packaged) = resolve_app_paths();
    let version = app.package_info().version.to_string();
    let bundled_ffmpeg = media_dir.join("video").join("ffmpeg.exe");
    let ffmpeg_opt = find_ffmpeg(&media_dir);
    let ffmpeg_bundled = bundled_ffmpeg.is_file();

    // 1. Bridge check
    let check_bridge = json!({
        "id": "bridge",
        "title": "Media-Bridge & Multi-Track-Server",
        "status": "ok",
        "summary": "Aktiv (Port 45678)",
        "detail": format!("Laufzeit: Tauri Native (my_view_app.exe v{}) – Streaming, Tonspur-Wechsel & Untertitel-Extraktion aktiv.", version)
    });

    // 2. FFmpeg check
    let mut ffmpeg_version_line = String::new();
    let mut ffmpeg_exec_ok = false;
    if let Some(ref ff) = ffmpeg_opt {
        let mut cmd = Command::new(ff);
        cmd.arg("-version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                ffmpeg_exec_ok = true;
                ffmpeg_version_line = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
            }
        }
    }
    let check_ffmpeg = match (&ffmpeg_opt, ffmpeg_exec_ok, ffmpeg_bundled) {
        (Some(ff), true, true) => json!({
            "id": "ffmpeg",
            "title": "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
            "status": "ok",
            "summary": "Bereit (im App-Ordner)",
            "detail": format!("{} ({})", ff.to_string_lossy(), ffmpeg_version_line)
        }),
        (Some(ff), true, false) => json!({
            "id": "ffmpeg",
            "title": "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
            "status": "warn",
            "summary": "Extern gefunden",
            "detail": format!("Gefunden unter {} – 'Automatisch reparieren' kopiert ffmpeg.exe fest nach media\\video\\ffmpeg.exe.", ff.to_string_lossy())
        }),
        (Some(ff), false, _) => json!({
            "id": "ffmpeg",
            "title": "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
            "status": "err",
            "summary": "Nicht ausführbar",
            "detail": format!("Datei gefunden unter {}, konnte aber nicht gestartet werden.", ff.to_string_lossy())
        }),
        (None, _, _) => json!({
            "id": "ffmpeg",
            "title": "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
            "status": "err",
            "summary": "Fehlt",
            "detail": format!("ffmpeg.exe nicht gefunden (erwartet unter {}). Multi-Audio, MKV-Konvertierung und Video-Thumbnails sind ohne FFmpeg nicht verfügbar.", bundled_ffmpeg.to_string_lossy())
        }),
    };

    // 3. Codecs check
    let mut supported_codecs: Vec<String> = Vec::new();
    let expected_codecs = ["aac", "dca", "ac3", "eac3", "subrip", "webvtt"];
    if let Some(ref ff) = ffmpeg_opt {
        if ffmpeg_exec_ok {
            let mut cmd = Command::new(ff);
            cmd.args(["-hide_banner", "-codecs"]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    let stdout_lower = String::from_utf8_lossy(&out.stdout).to_lowercase();
                    for c in expected_codecs {
                        if stdout_lower.contains(c) {
                            supported_codecs.push(c.to_string());
                        }
                    }
                }
            }
        }
    }
    let has_core_codecs = supported_codecs.iter().any(|c| c == "aac")
        && supported_codecs.iter().any(|c| c == "dca")
        && supported_codecs.iter().any(|c| c == "webvtt");
    let check_codecs = if ffmpeg_opt.is_none() || !ffmpeg_exec_ok {
        json!({
            "id": "codecs",
            "title": "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
            "status": "err",
            "summary": "Nicht prüfbar",
            "detail": "FFmpeg erforderlich, um DTS/AC3/E-AC3 zu decodieren und WebVTT/SRT-Untertitel zu extrahieren."
        })
    } else if supported_codecs.len() == expected_codecs.len() {
        json!({
            "id": "codecs",
            "title": "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
            "status": "ok",
            "summary": format!("{}/{} Codecs aktiv", supported_codecs.len(), expected_codecs.len()),
            "detail": format!("Aktiv: {} – DTS, AC3, E-AC3, AAC sowie MKV-Untertitel (SRT/ASS/WebVTT) werden voll unterstützt.", supported_codecs.join(", ").to_uppercase())
        })
    } else if has_core_codecs {
        json!({
            "id": "codecs",
            "title": "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
            "status": "warn",
            "summary": format!("{}/{} Codecs aktiv", supported_codecs.len(), expected_codecs.len()),
            "detail": format!("Erkannt: {}", supported_codecs.join(", ").to_uppercase())
        })
    } else {
        json!({
            "id": "codecs",
            "title": "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
            "status": "err",
            "summary": "Eingeschränkt",
            "detail": "Wichtige Codecs (AAC/DTS/WebVTT) fehlen in der verwendeten ffmpeg.exe."
        })
    };

    // 4. Folders & write permissions check
    let required_dirs = [
        media_dir.clone(),
        media_dir.join("video"),
        media_dir.join("music"),
        media_dir.join("covers"),
        media_dir.join(".mkv_cache"),
        media_dir.join(".sub_cache"),
    ];
    let mut folder_errors: Vec<String> = Vec::new();
    for dir in &required_dirs {
        if let Err(e) = fs::create_dir_all(dir) {
            folder_errors.push(format!("{}: {}", dir.to_string_lossy(), e));
            continue;
        }
        let probe_file = dir.join(".write_test");
        match fs::write(&probe_file, b"ok") {
            Ok(_) => {
                let _ = fs::remove_file(&probe_file);
            }
            Err(e) => {
                folder_errors.push(format!("{} (nicht beschreibbar: {})", dir.to_string_lossy(), e));
            }
        }
    }
    let check_folders = if folder_errors.is_empty() {
        json!({
            "id": "folders",
            "title": "Medien- & Cache-Ordner (.mkv_cache, .sub_cache)",
            "status": "ok",
            "summary": "Alle 6 Ordner beschreibbar",
            "detail": format!("Medienbasis: {}", media_dir.to_string_lossy())
        })
    } else {
        json!({
            "id": "folders",
            "title": "Medien- & Cache-Ordner (.mkv_cache, .sub_cache)",
            "status": "err",
            "summary": format!("{} Problem(e)", folder_errors.len()),
            "detail": folder_errors.join(" | ")
        })
    };

    // 5. Studio assets check (fonts & cursor presets)
    let font_count = fs::read_dir(media_dir.join("fonts"))
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    n.ends_with(".ttf") || n.ends_with(".otf")
                })
                .count()
        })
        .unwrap_or(0);
    let preset_count = fs::read_dir(media_dir.join("presets"))
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".png"))
                .count()
        })
        .unwrap_or(0);
    let check_assets = if font_count > 0 && preset_count > 0 {
        json!({
            "id": "assets",
            "title": "Zeichenstudio, Equalizer & Oberfläche",
            "status": "ok",
            "summary": format!("{} Fonts · {} Presets", font_count, preset_count),
            "detail": "Schriftarten, Cursor-Presets sowie AudioContext-Equalizer sind einsatzbereit."
        })
    } else {
        json!({
            "id": "assets",
            "title": "Zeichenstudio, Equalizer & Oberfläche",
            "status": "warn",
            "summary": format!("{} Fonts · {} Presets", font_count, preset_count),
            "detail": "Einige Font- oder Preset-Ressourcen in media\\fonts / media\\presets fehlen (Standard-Fallbacks aktiv)."
        })
    };

    // 6. Updater / curl.exe check
    let mut curl_cmd = Command::new("curl.exe");
    curl_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    curl_cmd.creation_flags(CREATE_NO_WINDOW);
    let check_updater = match curl_cmd.output() {
        Ok(out) if out.status.success() => {
            let line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("curl.exe verfügbar")
                .trim()
                .to_string();
            json!({
                "id": "updater",
                "title": "Online-Updater & Netzwerk-Download",
                "status": "ok",
                "summary": "Bereit",
                "detail": line
            })
        }
        _ => json!({
            "id": "updater",
            "title": "Online-Updater & Netzwerk-Download",
            "status": "err",
            "summary": "curl.exe fehlt",
            "detail": "Windows curl.exe konnte nicht ausgeführt werden."
        }),
    };

    let checks = vec![
        check_bridge,
        check_ffmpeg,
        check_codecs,
        check_folders,
        check_assets,
        check_updater,
    ];
    let all_ready = checks
        .iter()
        .all(|c| c.get("status").and_then(|s| s.as_str()) == Some("ok"));

    json!({
        "ok": true,
        "allReady": all_ready,
        "runtime": "tauri",
        "runtimeLabel": "Tauri Native (my_view_app.exe)",
        "version": version,
        "isPackaged": is_packaged,
        "appDir": app_dir.to_string_lossy().to_string(),
        "mediaDir": media_dir.to_string_lossy().to_string(),
        "exePath": exe_path.to_string_lossy().to_string(),
        "ffmpegPath": ffmpeg_opt.as_ref().map(|p| p.to_string_lossy().to_string()),
        "ffmpegBundled": ffmpeg_bundled,
        "supportedCodecs": supported_codecs,
        "checks": checks
    })
}

fn handle_system_check_api(req: Request, app: &AppHandle) {
    let payload = build_system_check_payload(app);
    respond_json(req, 200, payload);
}

fn handle_system_repair_api(req: Request, app: &AppHandle, body: Value) {
    let (_app_dir, media_dir, _exe_path, _pkg) = resolve_app_paths();
    let mut repaired_actions: Vec<String> = Vec::new();

    for sub in [
        "video",
        "music",
        "covers",
        "snapshots",
        "references",
        "logo",
        "cursor",
        "fonts",
        "presets",
        ".mkv_cache",
        ".sub_cache",
    ] {
        let dir = media_dir.join(sub);
        if !dir.is_dir() && fs::create_dir_all(&dir).is_ok() {
            repaired_actions.push(format!("Ordner erstellt: {}", dir.to_string_lossy()));
        }
    }

    clear_ffmpeg_and_probe_caches();
    let dest_ffmpeg = media_dir.join("video").join("ffmpeg.exe");
    let custom_ffmpeg = body
        .get("customFfmpegPath")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if let Some(src) = custom_ffmpeg {
        if src.is_file() && !src.to_string_lossy().eq_ignore_ascii_case(&dest_ffmpeg.to_string_lossy()) {
            if fs::copy(&src, &dest_ffmpeg).is_ok() {
                repaired_actions.push(format!(
                    "FFmpeg von {} nach {} installiert",
                    src.to_string_lossy(),
                    dest_ffmpeg.to_string_lossy()
                ));
            }
        }
    } else if !dest_ffmpeg.is_file() {
        if let Some(found) = find_ffmpeg(&media_dir) {
            if !found.to_string_lossy().eq_ignore_ascii_case(&dest_ffmpeg.to_string_lossy()) {
                if fs::copy(&found, &dest_ffmpeg).is_ok() {
                    repaired_actions.push(format!(
                        "FFmpeg automatisch von {} nach {} kopiert",
                        found.to_string_lossy(),
                        dest_ffmpeg.to_string_lossy()
                    ));
                }
            }
        }
    }

    for cache_sub in [".mkv_cache", ".sub_cache"] {
        let dir = media_dir.join(cache_sub);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains(".tmp.") && fs::remove_file(&p).is_ok() {
                        repaired_actions.push(format!("Verwaiste Temp-Datei bereinigt: {}", name));
                    }
                }
            }
        }
    }

    clear_ffmpeg_and_probe_caches();
    let mut payload = build_system_check_payload(app);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("repairedActions".to_string(), json!(repaired_actions));
    }
    respond_json(req, 200, payload);
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

            if path_only == "/media/audio" {
                thread::spawn(move || handle_media_audio_stream(req, &url));
                continue;
            }

            if path_only == "/media/subtitle" {
                thread::spawn(move || handle_media_subtitle_stream(req, &url));
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
                "/api/media/tracks" => {
                    thread::spawn(move || handle_media_tracks_api(req, body));
                }
                "/api/media/extract_subtitles" => {
                    thread::spawn(move || handle_extract_subtitles_api(req, body));
                }
                "/api/system-check" => {
                    let app_c = app.clone();
                    thread::spawn(move || handle_system_check_api(req, &app_c));
                }
                "/api/system-repair" => {
                    let app_c = app.clone();
                    thread::spawn(move || handle_system_repair_api(req, &app_c, body));
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
