const fs = require("fs");
const path = require("path");
let editorTargetContext = 'logo'; // Global editor target context: 'logo' | 'cursor' | 'cover'
let coverChangePlaylist = { plName: '', type: '' }; // Global temp container for playlist cover data
const { pathToFileURL, fileURLToPath } = require("url");
const { exec, spawn } = require("child_process");
const http = require("http");
const mm = require("music-metadata");
const { ipcRenderer, shell } = require("electron");
const isPackaged = __dirname.includes('app.asar') || Boolean(window.__tauriIsPackaged);
const mediaBase = isPackaged 
  ? path.join(path.dirname(process.execPath), "media") 
  : path.join(__dirname, "..", "media");

const coverFolder = path.join(mediaBase, "covers");
if (!fs.existsSync(coverFolder)) fs.mkdirSync(coverFolder, { recursive: true });
const fontsFolder = path.join(mediaBase, "fonts");
if (!fs.existsSync(fontsFolder)) fs.mkdirSync(fontsFolder, { recursive: true });

// MEDIA FOLDER
const musicFolder = path.join(mediaBase, "music");
if (!fs.existsSync(musicFolder)) fs.mkdirSync(musicFolder, { recursive: true });

const videoFolder = path.join(mediaBase, "video");
if (!fs.existsSync(videoFolder)) fs.mkdirSync(videoFolder, { recursive: true });

const ffmpegPath = path.join(videoFolder, "ffmpeg.exe");
let cachedFrontendFfmpegPath = "";
function resolveFfmpegExecutable() {
  if (cachedFrontendFfmpegPath && fs.existsSync(cachedFrontendFfmpegPath)) {
    return cachedFrontendFfmpegPath;
  }
  const candidates = [ffmpegPath, path.join(mediaBase, "ffmpeg.exe")];
  try {
    if (typeof process !== "undefined" && process.execPath) {
      const exeDir = path.dirname(process.execPath);
      candidates.push(path.join(exeDir, "ffmpeg.exe"));
      candidates.push(path.join(exeDir, "media", "video", "ffmpeg.exe"));
    }
  } catch (e) {}
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        cachedFrontendFfmpegPath = c;
        return c;
      }
    } catch (e) {}
  }
  return ffmpegPath;
}
const crypto = require("crypto");

// Sicherer Pfad-Resolver für File-Objekte (Electron 41+ webUtils & Tauri kompatibel)
window.getNativeFilePath = function(file) {
  if (!file) return "";
  if (typeof file === "string") return file;
  if (file.path && typeof file.path === "string") return file.path;
  try {
    const el = require("electron");
    if (el && el.webUtils && typeof el.webUtils.getPathForFile === "function") {
      return el.webUtils.getPathForFile(file) || "";
    }
  } catch (e) {}
  return "";
};

// ============================================================
// SYSTEM LOGGING & DIAGNOSTICS ENGINE (User Consent Controlled)
// ============================================================
const AppLogger = {
    getLogPath() {
        return path.join(mediaBase, "debug_log.txt");
    },
    isEnabled() {
        return localStorage.getItem("enableDebugLogging") === "true";
    },
    setEnabled(enable) {
        localStorage.setItem("enableDebugLogging", enable ? "true" : "false");
        if (enable) {
            this.write("LOGGER", "INFO", "=== Erweiterte Fehlerprotokollierung (Debug-Logs) vom Benutzer aktiviert ===");
        } else {
            this.write("LOGGER", "INFO", "=== Erweiterte Fehlerprotokollierung (Debug-Logs) vom Benutzer deaktiviert ===");
        }
    },
    write(tag, level, message, details = null) {
        if (!this.isEnabled()) return;
        try {
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 23);
            let line = `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${message}`;
            if (details) {
                line += ` | Details: ${typeof details === 'object' ? JSON.stringify(details) : details}`;
            }
            line += "\n";
            fs.appendFileSync(this.getLogPath(), line, "utf8");
        } catch (e) {
            console.error("Logger error:", e);
        }
    },
    info(tag, msg, details) {
        this.write(tag, "INFO", msg, details);
    },
    warn(tag, msg, details) {
        this.write(tag, "WARN", msg, details);
    },
    error(tag, msg, details) {
        this.write(tag, "ERROR", msg, details);
    },
    getRecentLogs(maxLines = 300) {
        const p = this.getLogPath();
        if (!fs.existsSync(p)) return "Keine Logs vorhanden. (Aktiviere die Protokollierung oben, um Ereignisse aufzuzeichnen)";
        try {
            const content = fs.readFileSync(p, "utf8");
            const lines = content.trim().split(/\r?\n/);
            if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
                return "Das Protokoll ist derzeit leer.";
            }
            return lines.slice(-maxLines).join("\n");
        } catch (e) {
            return "Fehler beim Lesen der Logdatei: " + e.message;
        }
    },
    clear() {
        try {
            fs.writeFileSync(this.getLogPath(), "", "utf8");
            return true;
        } catch (e) {
            return false;
        }
    },
    getFileSizeBytes() {
        const p = this.getLogPath();
        if (!fs.existsSync(p)) return 0;
        try {
            return fs.statSync(p).size;
        } catch (e) {
            return 0;
        }
    }
};

window.AppLogger = AppLogger;

// Globale Renderer-Fehler automatisch fangen & protokollieren
window.addEventListener("error", (event) => {
    AppLogger.error("RENDERER-ERROR", event.message, {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack
    });
});

window.addEventListener("unhandledrejection", (event) => {
    AppLogger.error("RENDERER-PROMISE-REJECT", event.reason?.message || String(event.reason), {
        stack: event.reason?.stack
    });
});

// ============================================================
// MULTI-WINDOW DOM PROXY (Für Popout-Editor / Zeichentablett)
// ============================================================
window.isEditorPoppedOut = false;
window.popoutEditorWindow = null;

const _origDocGetElementById = Document.prototype.getElementById;
Document.prototype.getElementById = function(id) {
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            const popEl = _origDocGetElementById.call(window.popoutEditorWindow.document, id);
            if (popEl) return popEl;
        } catch (e) {}
    }
    return _origDocGetElementById.call(this, id);
};

const _origDocQuerySelector = Document.prototype.querySelector;
Document.prototype.querySelector = function(selector) {
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            const popEl = _origDocQuerySelector.call(window.popoutEditorWindow.document, selector);
            if (popEl) return popEl;
        } catch (e) {}
    }
    return _origDocQuerySelector.call(this, selector);
};

const _origDocQuerySelectorAll = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function(selector) {
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            const res = _origDocQuerySelectorAll.call(window.popoutEditorWindow.document, selector);
            if (res && res.length > 0) return res;
        } catch (e) {}
    }
    return _origDocQuerySelectorAll.call(this, selector);
};

// DOM ELEMENTE
const musicGrid = document.getElementById("musicGrid");
const videoList = document.getElementById("videoList");
const likedGrid = document.getElementById("likedGrid");
const player = document.getElementById("audioPlayer");
const videoPlayer = document.getElementById("videoPlayer");
const videoAltAudio = document.getElementById("videoAltAudio");
const progressBar = document.getElementById("progressBar");
const shuffleBtn = document.getElementById("shuffleBtn");
const volume = document.getElementById("volume");
const playBtn = document.getElementById("playBtn");
const likeBtn = document.getElementById("likeBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const speedMenu = document.getElementById("speedMenu");
const menuBtn = document.getElementById("menuBtn");
const videoMenu = document.getElementById("videoMenu");
const record = document.querySelector(".record");
const canvas = document.getElementById("visualizer");
const ctx = canvas.getContext("2d");
const visualizer = document.getElementById("visualizer");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const ambientBtn = document.getElementById("ambientBtn");
const nowPlaying = document.getElementById("nowPlaying");

canvas.width = 150;
canvas.height = 44;

//////////////////////////////////////////////////
// WINDOW CONTROLS (Minimize / Maximize / Close)
//////////////////////////////////////////////////
document.getElementById("minBtn").addEventListener("click", () => {
  ipcRenderer.send("window-minimize");
});
document.getElementById("maxBtn").addEventListener("click", () => {
  ipcRenderer.send("window-maximize");
});
document.getElementById("closeBtn").addEventListener("click", () => {
  ipcRenderer.send("window-close");
});

// GLOBALE VARIABLEN & DATA
let musicList = [];
let videoListData = [];
let liked = JSON.parse(localStorage.getItem("liked") || "{}");
let likedView = "music";
let currentIndex = 0;
let currentPlaybackList = [];
let shuffle = false;
let activeType = "music";
let history = JSON.parse(localStorage.getItem("history") || "[]");
let visualizerVisible = true;
let playlists = JSON.parse(localStorage.getItem("playlists") || '{"music": {}, "video": {}}');
let playlistView = "music"; 
let currentOpenPlaylist = { name: "", type: "" };
let conversionQueue = [];
let isConverting = false;
let currentConvData = { file: "", progress: 0, eta: "Berechne...", durationSec: 0 };
let cropBox = { x: 0, y: 0, w: 500, h: 500 };

////////////////////////////////////////////////////////////
// KEYBOARD SHORTCUTS (HOTKEYS)
////////////////////////////////////////////////////////////

const defaultLogoShortcuts = {
    move: "KeyH",
    layerMove: "KeyV",
    brush: "KeyB",
    eraser: "KeyE",
    smudge: "KeyS",
    fill: "KeyG",
    lasso: "KeyL",
    eyedropper: "KeyI",
    text: "KeyT",
    shape: "KeyU",
    gradient: "Shift+KeyG",
    clone: "Shift+KeyS",
    undo: "Ctrl+KeyY",
    redo: "Ctrl+KeyZ",
    zoomIn: "Ctrl+Equal",
    zoomOut: "Ctrl+Minus",
    zoomReset: "Ctrl+Digit0",
    save: "Ctrl+KeyS",
    newLayer: "Ctrl+KeyN",
    deleteLayer: "Delete",
    layerUp: "Ctrl+ArrowUp",
    layerDown: "Ctrl+ArrowDown",
    toggleLeftSidebar: "F3",
    toggleRightSidebar: "F4",
    toggleBottomSidebar: "F6"
};

let logoShortcuts = JSON.parse(localStorage.getItem("logoShortcuts") || "null") || { ...defaultLogoShortcuts };

const shortcutLabels = {
    move: "Leinwand verschieben",
    layerMove: "Ebene verschieben",
    brush: "Pinsel",
    eraser: "Radiergummi",
    smudge: "Verwischen",
    fill: "Füllen",
    lasso: "Lasso füllen",
    eyedropper: "Pipette",
    text: "Text",
    shape: "Rechteck",
    gradient: "Verlaufswerkzeug",
    clone: "Klonstempel",
    undo: "Rückgängig",
    redo: "Wiederholen",
    zoomIn: "Vergrößern (Zoom In)",
    zoomOut: "Verkleinern (Zoom Out)",
    zoomReset: "Zoom zurücksetzen",
    save: "Speichern / Exportieren",
    newLayer: "Neue Ebene erstellen",
    deleteLayer: "Aktive Ebene löschen",
    layerUp: "Ebene nach oben",
    layerDown: "Ebene nach unten",
    toggleLeftSidebar: "Linke Seitenleiste umschalten",
    toggleRightSidebar: "Rechte Seitenleiste umschalten",
    toggleBottomSidebar: "Untere Seitenleiste umschalten"
};

let currentlyBindingTool = null;

function formatKeyName(code) {
    if (!code) return "Keines";
    const parts = code.split("+");
    const formattedParts = parts.map(part => {
        if (part === "Ctrl") return "Strg";
        if (part === "Shift") return "Umschalt";
        if (part === "Alt") return "Alt";
        if (part.startsWith("Key")) return part.substring(3);
        if (part.startsWith("Digit")) return part.substring(5);
        if (part === "Space") return "Leertaste";
        if (part === "ArrowUp") return "↑";
        if (part === "ArrowDown") return "↓";
        if (part === "ArrowLeft") return "←";
        if (part === "ArrowRight") return "→";
        return part;
    });
    return formattedParts.join(" + ");
}

window.openShortcutModal = function() {
    currentlyBindingTool = null;
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const modal = edDoc.getElementById("logoShortcutModal") || document.getElementById("logoShortcutModal");
    if (modal) {
        modal.classList.remove("hidden");
    }
    renderShortcutList();
};

window.closeShortcutModal = function() {
    currentlyBindingTool = null;
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const modal = edDoc.getElementById("logoShortcutModal") || document.getElementById("logoShortcutModal");
    if (modal) {
        modal.classList.add("hidden");
    }
};

window.resetShortcutsToDefault = function() {
    logoShortcuts = { ...defaultLogoShortcuts };
    localStorage.setItem("logoShortcuts", JSON.stringify(logoShortcuts));
    currentlyBindingTool = null;
    renderShortcutList();
    updateTooltips();
};

function renderShortcutList() {
    const container = document.getElementById("shortcutListContainer");
    if (!container) return;
    
    container.innerHTML = "";
    
    for (const tool in logoShortcuts) {
        const key = logoShortcuts[tool];
        const isBinding = currentlyBindingTool === tool;
        
        const row = document.createElement("div");
        row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; transition: all 0.2s;";
        
        const label = document.createElement("span");
        label.innerText = shortcutLabels[tool] || tool;
        label.style.cssText = "font-size: 14px; color: #ddd;";
        
        const btn = document.createElement("button");
        btn.style.cssText = isBinding 
            ? "background: rgba(221, 161, 110, 0.15); border: 1px solid #dda16e; color: #dda16e; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; min-width: 120px; text-align: center; animation: pulse-border 1.5s infinite; outline: none;"
            : "background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; min-width: 120px; text-align: center; transition: all 0.2s; outline: none;";
        
        btn.innerText = isBinding ? "Taste drücken..." : formatKeyName(key);
        
        btn.onclick = () => {
            currentlyBindingTool = tool;
            renderShortcutList();
        };
        
        row.appendChild(label);
        row.appendChild(btn);
        container.appendChild(row);
    }
}

function updateTooltips() {
    const toolToId = {
        move: { id: "toolMove", name: "Leinwand verschieben" },
        layerMove: { id: "toolLayerMove", name: "Ebene verschieben" },
        brush: { id: "toolBrush", name: "Pinsel" },
        eraser: { id: "toolEraser", name: "Radiergummi" },
        smudge: { id: "toolSmudge", name: "Verwischen / Smudge" },
        fill: { id: "toolFill", name: "Füllen" },
        lasso: { id: "toolLasso", name: "Lasso füllen" },
        eyedropper: { id: "toolEyedropper", name: "Pipette" },
        text: { id: "toolText", name: "Text-Werkzeug" },
        shape: { id: "toolShape", name: "Rechteck" }
    };
    
    for (const tool in logoShortcuts) {
        const key = logoShortcuts[tool];
        const info = toolToId[tool];
        if (info) {
            const btn = document.getElementById(info.id);
            if (btn) {
                btn.setAttribute("title", `${info.name} (${formatKeyName(key)})`);
            }
        }
    }
}

function showShortcutNotification(tool, key, swappedWithTool) {
    const oldToast = document.getElementById("shortcut-toast");
    if (oldToast) oldToast.remove();
    
    const toast = document.createElement("div");
    toast.id = "shortcut-toast";
    toast.style.cssText = "position: fixed; bottom: 25px; left: 50%; transform: translateX(-50%); background: rgba(24, 24, 24, 0.9); backdrop-filter: blur(10px); border: 1px solid #dda16e; border-radius: 8px; padding: 12px 24px; color: #fff; font-size: 13px; z-index: 12000; box-shadow: 0 10px 25px rgba(0,0,0,0.5); pointer-events: none; transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0; transform: translate(-50%, 20px);";
    
    let text = `Tastenkürzel für <strong>${shortcutLabels[tool]}</strong> auf <strong>${formatKeyName(key)}</strong> gesetzt.`;
    if (swappedWithTool) {
        text += ` <span style="color: #aaa;">(Zuvor belegt durch ${shortcutLabels[swappedWithTool]}, getauscht auf ${formatKeyName(logoShortcuts[swappedWithTool])})</span>`;
    }
    
    toast.innerHTML = text;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translate(-50%, 0)";
    }, 10);
    
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translate(-50%, -20px)";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Injektion der Pulse-Border Animation für den Rebind-Zustand
if (!document.getElementById("shortcut-custom-styles")) {
    const style = document.createElement("style");
    style.id = "shortcut-custom-styles";
    style.innerHTML = `
        @keyframes pulse-border {
            0% { border-color: rgba(221, 161, 110, 0.4); box-shadow: 0 0 0 rgba(221, 161, 110, 0); }
            50% { border-color: rgba(221, 161, 110, 1); box-shadow: 0 0 8px rgba(221, 161, 110, 0.3); }
            100% { border-color: rgba(221, 161, 110, 0.4); box-shadow: 0 0 0 rgba(221, 161, 110, 0); }
        }
    `;
    document.head.appendChild(style);
}

// Globaler Capture-Phase Keydown Listener für Shortcuts Rebinding
document.addEventListener("keydown", (e) => {
    if (currentlyBindingTool) {
        e.preventDefault();
        e.stopPropagation();
        
        const pressedKey = e.code;
        
        // Verhindere das Binden von Escape, F12
        if (pressedKey === "Escape" || pressedKey === "F12") {
            currentlyBindingTool = null;
            renderShortcutList();
            return;
        }
        
        if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(pressedKey)) {
            return;
        }
        
        let combo = [];
        if (e.ctrlKey) combo.push("Ctrl");
        if (e.shiftKey) combo.push("Shift");
        if (e.altKey) combo.push("Alt");
        combo.push(pressedKey);
        
        const shortcutString = combo.join("+");
        const tool = currentlyBindingTool;
        
        // Konflikterkennung und automatische Vertauschung
        let existingTool = null;
        for (const t in logoShortcuts) {
            if (logoShortcuts[t] === shortcutString && t !== tool) {
                existingTool = t;
                break;
            }
        }
        
        if (existingTool) {
            logoShortcuts[existingTool] = logoShortcuts[tool];
        }
        
        logoShortcuts[tool] = shortcutString;
        localStorage.setItem("logoShortcuts", JSON.stringify(logoShortcuts));
        
        currentlyBindingTool = null;
        renderShortcutList();
        updateTooltips();
        
        showShortcutNotification(tool, shortcutString, existingTool);
    }
}, true);

let spaceHeld = false;
let spaceTimeout;

let arrowHoldKey = null;
let arrowHoldStartTime = 0;
let arrowSeekToastTimer = null;

function showSeekToast(isFwd, stepSeconds, currentSec, durationSec) {
  const toast = document.getElementById("videoSeekToast");
  const icon = document.getElementById("videoSeekIcon");
  const delta = document.getElementById("videoSeekDelta");
  const time = document.getElementById("videoSeekTime");
  if (!toast) return;

  if (icon) icon.innerText = isFwd ? "⏩" : "⏪";
  if (delta) delta.innerText = (isFwd ? "+" : "-") + Math.round(stepSeconds) + "s";
  if (time && durationSec > 0) {
    const curStr = typeof formatTime === "function" ? formatTime(currentSec) : "0:00";
    const durStr = typeof formatTime === "function" ? formatTime(durationSec) : "0:00";
    time.innerText = `(${curStr} / ${durStr})`;
  } else if (time) {
    time.innerText = "";
  }

  toast.classList.remove("hidden");
  clearTimeout(arrowSeekToastTimer);
  arrowSeekToastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 1000);
}

// ============================================================
// HOVER MEDIA TRACKING & FULLSCREEN CONTROLS
// ============================================================
let activeHoveredMediaElement = null;
let activeHoveredMediaPath = null;

document.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".mediaCard, [data-file-path], .playlist-item, .likeIcon");
    if (card) {
        activeHoveredMediaElement = card;
        activeHoveredMediaPath = card.dataset.filePath || 
                                 card.dataset.path || 
                                 card.dataset.src || 
                                 card.querySelector?.(".likeIcon")?.dataset?.src ||
                                 card.querySelector?.("[data-file-path]")?.dataset?.filePath ||
                                 null;
    }
}, { passive: true });

document.addEventListener("mouseout", (e) => {
    const card = e.target.closest(".mediaCard, [data-file-path], .playlist-item, .likeIcon");
    if (card && card === activeHoveredMediaElement) {
        if (!e.relatedTarget || !card.contains(e.relatedTarget)) {
            activeHoveredMediaElement = null;
            activeHoveredMediaPath = null;
        }
    }
}, { passive: true });

function toggleVideoFullscreen() {
    const fsTarget = document.getElementById("videoMainContainer") || videoPlayer || document.documentElement;
    if (!document.fullscreenElement) {
        if (videoPlayer) videoPlayer.controls = false;
        if (fsTarget && fsTarget.requestFullscreen) {
            fsTarget.requestFullscreen().catch(() => {
                if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
            });
        } else if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    }
}
window.toggleVideoFullscreen = toggleVideoFullscreen;

function onEditorKeyDown(e) {
  // Global Shortcut: Sidebar ein-/ausklappen (Ctrl+B)
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyB" || e.key === "b" || e.key === "B")) {
    e.preventDefault();
    if (typeof window.toggleMainSidebar === "function") window.toggleMainSidebar();
    return;
  }

  // --- LOGO EDITOR TASTENSTEUERUNG UND SHORTCUTS ---
  const logoModal = document.getElementById("logoEditorModal");
  const isLogoModalOpen = (logoModal && !logoModal.classList.contains("hidden")) || window.isEditorPoppedOut;
  
  if (isLogoModalOpen) {
      if (currentlyBindingTool) return; // Blockiere Shortcuts während dem Rebinding
      
      // F5 Shortcut für Photoshop Pinsel-Studio
      if (e.key === "F5" || e.code === "F5") {
          e.preventDefault();
          if (typeof window.toggleBrushStudioModal === "function") {
              window.toggleBrushStudioModal();
          }
          return;
      }

      if (e.key === "Escape") {
          const targetDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) ? window.popoutEditorWindow.document : document;
          // Schließe Brush Studio wenn geöffnet
          const studioModal = targetDoc.getElementById("brushStudioModal") || document.getElementById("brushStudioModal");
          if (studioModal && !studioModal.classList.contains("hidden")) {
              if (typeof window.closeBrushStudioModal === "function") {
                  window.closeBrushStudioModal();
              } else {
                  studioModal.classList.add("hidden");
                  studioModal.style.display = "none";
              }
              e.preventDefault();
              return;
          }

          // Schließe PhotoCraft Modal wenn geöffnet
          const pcModal = targetDoc.getElementById("photocraftModal") || document.getElementById("photocraftModal");
          if (pcModal && !pcModal.classList.contains("hidden")) {
              if (typeof window.closePhotoCraftModal === "function") {
                  window.closePhotoCraftModal();
              } else {
                  pcModal.classList.add("hidden");
                  pcModal.style.display = "none";
              }
              e.preventDefault();
              return;
          }

          // Schließe den Shortcut-Modal wenn geöffnet
          const shortcutModal = document.getElementById("logoShortcutModal");
          if (shortcutModal && !shortcutModal.classList.contains("hidden")) {
              closeShortcutModal();
              e.preventDefault();
              return;
          }
          const textInput = document.getElementById("canvasTextInput");
          if (textInput && textInput.style.display === "block") {
              textInput.style.display = "none";
              e.preventDefault();
              return;
          }
          if (document.activeElement) {
              document.activeElement.blur();
              e.preventDefault();
              return;
          }
      }
      
      const activeEl = document.activeElement;
      if (activeEl && (
          activeEl.tagName === "INPUT" || 
          activeEl.tagName === "TEXTAREA" || 
          activeEl.tagName === "SELECT" || 
          activeEl.isContentEditable || 
          activeEl.id === "canvasTextBox" || 
          (typeof activeEl.closest === "function" && activeEl.closest("#textFloatingToolbar"))
      )) {
          return; // Nutzer schreibt in ein Eingabefeld, keine Shortcuts abfangen!
      }
      
      if (e.code === "KeyC") {
          const eligibleTools = ["brush", "airbrush", "raster", "lasso", "fill"];
          if (eligibleTools.includes(activeTool)) {
              window.isEraserToggleMode = !window.isEraserToggleMode;
              window.updateEraserBadge();
              updateCursor();
              e.preventDefault();
              return;
          }
      }
      
      // Leertaste gedrückt halten für Canvas-Bewegen-Modus
      if (e.code === "Space") {
          e.preventDefault();
          if (!isSpaceDown) {
              isSpaceDown = true;
              updateCursor();
              // Cursor-Vorschau ausblenden im Bewegen-Modus
              const preview = document.getElementById("brushCursorPreview");
              if (preview) preview.style.display = "none";
          }
          return;
      }
      
      // Baue das gedrückte Combo-String auf, um es mit logoShortcuts zu vergleichen
      let combo = [];
      if (e.ctrlKey) combo.push("Ctrl");
      if (e.shiftKey) combo.push("Shift");
      if (e.altKey) combo.push("Alt");
      
      const pressedKey = e.code;
      if (!["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(pressedKey)) {
          combo.push(pressedKey);
      }
      
      const pressedComboString = combo.join("+");
      
      let matchedTool = null;
      for (const tool in logoShortcuts) {
          if (logoShortcuts[tool] === pressedComboString) {
              matchedTool = tool;
              break;
          }
      }
      
      if (matchedTool) {
          e.preventDefault();
          
          // Tools
          if (["move", "layerMove", "brush", "eraser", "smudge", "fill", "lasso", "eyedropper", "text", "shape", "gradient", "clone"].includes(matchedTool)) {
              if (typeof window.setLogoTool === "function") window.setLogoTool(matchedTool);
          } 
          // Operations
          else if (matchedTool === "undo") {
              if (typeof window.undoLogoAction === "function") window.undoLogoAction();
          } 
          else if (matchedTool === "redo") {
              if (typeof window.redoLogoAction === "function") window.redoLogoAction();
          } 
          else if (matchedTool === "zoomIn") {
              if (typeof window.zoomLogoIn === "function") window.zoomLogoIn();
          } 
          else if (matchedTool === "zoomOut") {
              if (typeof window.zoomLogoOut === "function") window.zoomLogoOut();
          } 
          else if (matchedTool === "zoomReset") {
              if (typeof window.zoomLogoReset === "function") window.zoomLogoReset();
          } 
          else if (matchedTool === "save") {
              if (typeof window.saveLogoEditor === "function") window.saveLogoEditor(false);
          }
          // Layer Management
          else if (matchedTool === "newLayer") {
              if (typeof addNewLayer === "function") addNewLayer();
          } 
          else if (matchedTool === "deleteLayer") {
              if (typeof deleteLayer === "function") deleteLayer(activeLayerId);
          } 
          else if (matchedTool === "layerUp") {
              if (typeof window.moveActiveLayerUp === "function") window.moveActiveLayerUp();
          } 
          else if (matchedTool === "layerDown") {
              if (typeof window.moveActiveLayerDown === "function") window.moveActiveLayerDown();
          }
          // Sidebar Collapses
          else if (matchedTool === "toggleLeftSidebar") {
              const dock = document.getElementById("logoLeftToolbar");
              if (dock) {
                  const btn = dock.querySelector(".csp-collapse-btn");
                  if (typeof window.togglePanel === "function") window.togglePanel("logoLeftToolbar", btn);
              }
          } 
          else if (matchedTool === "toggleRightSidebar") {
              const dock = document.getElementById("logoRightToolbar");
              if (dock) {
                  const btn = dock.querySelector(".csp-collapse-btn");
                  if (typeof window.togglePanel === "function") window.togglePanel("logoRightToolbar", btn);
              }
          } 
          else if (matchedTool === "toggleBottomSidebar") {
              const dock = document.getElementById("logoBottomToolbar");
              if (dock) {
                  const btn = dock.querySelector(".csp-collapse-btn");
                  if (typeof window.togglePanel === "function") window.togglePanel("logoBottomToolbar", btn);
              }
          }
          return;
      }
      
      // Blockiere alle Tasten der normalen Mediensteuerung, während der Editor geöffnet ist!
      if (["Space", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "KeyM", "KeyN", "KeyF"].includes(pressedKey)) {
          e.preventDefault();
      }
      return;
  }

  // 1. ESCAPE ZUM SCHLIESSEN VON FENSTERN (MUSS GANZ OBEN STEHEN!)
  if (e.key === "Escape") {
      e.preventDefault(); // Verhindert Standard-Browser-Aktionen
      
      // Nimmt den Fokus von Color-Pickern oder Textfeldern
      if (document.activeElement) {
          document.activeElement.blur(); 
      }
      
      // Schließt rigoros alle offenen Modals & Filter-Menüs
      ['settingsModal', 'playlistModal', 'customConfirmModal', 'convertModal', 'coverEditorModal', 'shortcutsHelpModal', 'searchFilterMenu'].forEach(id => {
          const m = document.getElementById(id);
          if (m && !m.classList.contains("hidden")) {
              m.classList.add("hidden");
          }
      });
      document.getElementById("searchFilterBtn")?.classList.remove("active");
      if (!document.fullscreenElement && typeof window.closeEqualizerModal === "function") {
          window.closeEqualizerModal();
      }
      return; // Sofort abbrechen, damit nichts anderes passiert!
  }

  // MEGA-WICHTIG: Prüft, wo dein Cursor gerade ist!
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
    // Wenn du in einem Textfeld bist, brich die Hotkeys ab und lass den Nutzer in Ruhe tippen!
    if(e.code === "Enter") {
      // Erlaubt das Speichern mit Enter im Playlist-Feld
      if(activeEl.id === "newPlaylistName") saveToPlaylists();
    }
    return; 
  }

  // --- TASTENKÜRZEL-ÜBERSICHT: '?' ODER 'F1' ---
  if ((e.key === "?" || e.key === "F1" || e.code === "F1" || (e.shiftKey && (e.key === "/" || e.code === "Slash"))) && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (typeof window.toggleShortcutsHelpModal === "function") {
      window.toggleShortcutsHelpModal();
    }
    return;
  }

  // --- TASTE 'F': HOVER-LIKE FÜR MEDIEN ODER FULLSCREEN ---
  if (e.code === "KeyF") {
    e.preventDefault();
    if (activeHoveredMediaPath) {
      toggleLike(activeHoveredMediaPath);
      if (activeHoveredMediaElement) {
        const heart = activeHoveredMediaElement.querySelector?.(".likeIcon") || 
                      (activeHoveredMediaElement.classList.contains("likeIcon") ? activeHoveredMediaElement : null);
        if (heart) {
          heart.innerText = isLiked(activeHoveredMediaPath) ? "❤" : "🤍";
          heart.classList.remove("heart-pulse");
          void heart.offsetWidth;
          heart.classList.add("heart-pulse");
        }
      }
      return;
    }

    // Wenn nicht über einer spezifischen Mediendatei gehovert wird ("auf nichts ist") oder im Video/Playlist: Fullscreen
    toggleVideoFullscreen();
    return;
  }

  const activePlayer = activeType === "video" ? videoPlayer : player;
  if (!activePlayer || !activePlayer.src) return;

  switch(e.code) {
    case "Space":
      e.preventDefault(); // Verhindert, dass die Seite beim Drücken der Leertaste runterscrollt
      // e.repeat ist true, wenn man die Taste gedrückt hält
      if (!e.repeat) {
        // Starte einen Timer. Wenn die Taste 300ms gedrückt bleibt, ist es ein "Hold"
        spaceTimeout = setTimeout(() => {
          spaceHeld = true;
          activePlayer.playbackRate = 2.0; // Doppelte Geschwindigkeit
          if(speedValue) speedValue.innerText = "2.00x";
        }, 300); 
      }
      break;

    case "ArrowRight":
    case "ArrowLeft": {
      e.preventDefault();
      const isFwd = e.code === "ArrowRight";
      const now = Date.now();

      if (arrowHoldKey !== e.code) {
        arrowHoldKey = e.code;
        arrowHoldStartTime = now;
      }

      const heldDuration = now - arrowHoldStartTime;
      let step = 5; // Standard: 5 Sekunden
      if (heldDuration > 5000) {
        step = 35; // Lange gedrückt: Schnellvorlauf für lange Videos
      } else if (heldDuration > 2500) {
        step = 20;
      } else if (heldDuration > 1000) {
        step = 10;
      }

      if (isFwd) {
        activePlayer.currentTime = Math.min(activePlayer.duration || Infinity, activePlayer.currentTime + step);
      } else {
        activePlayer.currentTime = Math.max(0, activePlayer.currentTime - step);
      }

      showSeekToast(isFwd, step, activePlayer.currentTime, activePlayer.duration);
      break;
    }
      
    case "ArrowUp":
      e.preventDefault();
      volume.value = Math.min(1.5, Math.round((parseFloat(volume.value) + 0.05) * 100) / 100);
      volume.dispatchEvent(new Event("input")); // Löst den Lautstärke-Balken aus
      break;

    case "ArrowDown":
      e.preventDefault();
      volume.value = Math.max(0, Math.round((parseFloat(volume.value) - 0.05) * 100) / 100);
      volume.dispatchEvent(new Event("input"));
      break;

    case "KeyM":
      e.preventDefault();
      if (activePlayer.volume > 0) {
        activePlayer.dataset.lastVolume = volume.value; // Speichert letzte Lautstärke
        volume.value = 0;
      } else {
        volume.value = activePlayer.dataset.lastVolume || 1; // Stellt sie wieder her
      }
      volume.dispatchEvent(new Event("input"));
      break;

    case "KeyN":
      e.preventDefault();
      if(nextBtn) nextBtn.click();
      break;

    case "KeyQ":
      e.preventDefault();
      if (typeof window.toggleQueueDrawer === "function") window.toggleQueueDrawer();
      break;

    case "KeyS":
      if (activeType === "video") {
        e.preventDefault();
        if (typeof window.takeVideoSnapshot === "function") window.takeVideoSnapshot();
      }
      break;

    case "KeyE":
      if (activeType === "video") {
        e.preventDefault();
        if (typeof window.stepVideoFrame === "function") window.stepVideoFrame(true);
      }
      break;

    case "Comma":
      if (activeType === "video") {
        e.preventDefault();
        if (typeof window.stepVideoFrame === "function") window.stepVideoFrame(false);
      }
      break;

    case "Period":
      if (activeType === "video") {
        e.preventDefault();
        if (typeof window.stepVideoFrame === "function") window.stepVideoFrame(true);
      }
      break;

    case "KeyL":
      e.preventDefault();
      if (typeof window.toggleAbLoop === "function") window.toggleAbLoop();
      break;
  }
}

document.addEventListener("keydown", onEditorKeyDown);

// Wenn die Taste wieder losgelassen wird (wichtig für die Leertaste)
function onEditorKeyUp(e) {
  const logoModal = document.getElementById("logoEditorModal");
  const isLogoModalOpen = (logoModal && !logoModal.classList.contains("hidden")) || window.isEditorPoppedOut;
  
  if (isLogoModalOpen) {
      if (e.code === "Space") {
          e.preventDefault();
          isSpaceDown = false;
          updateCursor();
      }
      return;
  }

  if(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  
  if(e.code === "Space") {
    e.preventDefault();
    clearTimeout(spaceTimeout); // Bricht den Hold-Timer ab
    
    if (spaceHeld) {
      // Wurde gedrückt gehalten? Dann jetzt wieder auf normale Geschwindigkeit setzen
      const activePlayer = activeType === "video" ? videoPlayer : player;
      const normalSpeed = speedSlider ? parseFloat(speedSlider.value) : 1;
      activePlayer.playbackRate = normalSpeed;
      if(speedValue) speedValue.innerText = normalSpeed.toFixed(2) + "x";
      spaceHeld = false;
    } else {
      // Nur kurz gedrückt? Dann Play/Pause auslösen!
      if(playBtn) playBtn.click();
    }
  }

  if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
    arrowHoldKey = null;
    arrowHoldStartTime = 0;
  }
}

document.addEventListener("keyup", onEditorKeyUp);

////////////////////////////////////////////////////////////
// VIDEO MENU
////////////////////////////////////////////////////////////

if(menuBtn){
  menuBtn.addEventListener("click",(e)=>{
    e.stopPropagation()

    if (typeof backToMenu === "function") backToMenu();

    videoMenu.classList.toggle("show")
  })
}

document.addEventListener("click",(e)=>{

if(!videoMenu.contains(e.target) && e.target !== menuBtn && !(e.target.closest && (e.target.closest('#fsMenuBtn') || e.target.closest('#tracksQuickBtn') || e.target.closest('#fsTracksBtn')))){

videoMenu.classList.remove("show")

}

})

////////////////////////////////////////////////////////////
// TAB SWITCH
////////////////////////////////////////////////////////////

function showTab(tab){
    document.getElementById("musicTab").classList.add("hidden")
    document.getElementById("videoTab").classList.add("hidden")
    document.getElementById("likedTab").classList.add("hidden")
    document.getElementById("historyTab")?.classList.add("hidden")
    document.getElementById("playlistsTab")?.classList.add("hidden");
    document.getElementById("playlistDetailTab")?.classList.add("hidden");
    document.getElementById("streamsTab")?.classList.add("hidden");

    if(tab === "music") document.getElementById("musicTab").classList.remove("hidden")
    if(tab === "videos") document.getElementById("videoTab").classList.remove("hidden")
    if(tab === "liked") document.getElementById("likedTab").classList.remove("hidden")
    if(tab === "history") document.getElementById("historyTab").classList.remove("hidden")
    if(tab === "playlists"){
        document.getElementById("playlistsTab").classList.remove("hidden");
        renderPlaylists();
    }
    if(tab === "playlistDetail") document.getElementById("playlistDetailTab").classList.remove("hidden");
    if(tab === "streams"){
        document.getElementById("streamsTab")?.classList.remove("hidden");
        if (typeof renderStreamsTab === "function") renderStreamsTab();
    }

    document.querySelectorAll(".navGroup button").forEach(btn => btn.classList.remove("active"))

    // FIX: Die Map hat die Playlists und Streams jetzt drin!
    const activeMap = {
        music: 'button[onclick="showTab(\'music\')"]',
        videos: 'button[onclick="showTab(\'videos\')"]',
        streams: 'button[onclick="showTab(\'streams\')"]',
        tagManager: 'button[onclick="showTab(\'tagManager\')"]',
        liked: 'button[onclick="showTab(\'liked\')"]',
        history: 'button[onclick="showTab(\'history\')"]',
        playlists: 'button[onclick="showTab(\'playlists\')"]' 
    }

    const activeBtn = document.querySelector(activeMap[tab])
    if(activeBtn) activeBtn.classList.add("active")

    const main = document.querySelector(".main")
    if(main) main.scrollTop = 0

    updateVideoControls()
    if (typeof renderDynamicTagChips === "function") renderDynamicTagChips();
    if (typeof performEnhancedSearch === "function") performEnhancedSearch();
}

////////////////////////////////////////////////////////////
// HILFSFUNKTIONEN (DIE FEHLENDEN WERKZEUGE)
////////////////////////////////////////////////////////////

function getMediaTitle(src) {
    if (!src) return "";
    // Falls es ein Live-Stream ist
    if (
        src.startsWith("http://localhost") ||
        src.includes("127.0.0.1:45678/twitch") ||
        src.includes("127.0.0.1:45678/youtube") ||
        src.includes("player.twitch.tv") ||
        src.includes("youtube-nocookie.com")
    ) {
        return "Live-Stream läuft...";
    }
    const real = fromMediaKey(src);
    const file = real.split("/").pop().split("\\").pop();
    return file.replace(/\.[^/.]+$/, "");
}

function updateNowPlaying() {
    const src = activeType === "video" ? videoPlayer.src : player.src;
    if (!src) return;

    // Wenn es ein Stream ist, haben wir den Namen bereits manuell gesetzt
    if (
        src.startsWith("http://localhost") ||
        src.includes("127.0.0.1:45678/twitch") ||
        src.includes("127.0.0.1:45678/youtube") ||
        src.includes("player.twitch.tv") ||
        src.includes("youtube-nocookie.com")
    ) return;

    // Ansonsten normal aus dem Pfad lesen
    nowPlaying.textContent = getMediaTitle(src);
    if (typeof window.recordMediaLastPlayed === "function") {
        window.recordMediaLastPlayed(src);
    }
}
// --- HILFSFUNKTIONEN FÜR PFADE (Sicher & Einzigartig) ---
function toMediaKey(value) {
    if (!value) return "";
    if (String(value).includes("/media?path=")) value = fromMediaKey(value);
    if (String(value).startsWith("file://")) return value;
    return pathToFileURL(value).href;
}

function fromMediaKey(value) {
    if (!value) return "";
    let s = String(value);
    if (s.includes("/media?path=")) {
        try {
            const u = new URL(s);
            s = u.searchParams.get("path") || s;
        } catch (e) {
            const idx = s.indexOf("path=");
            if (idx !== -1) s = s.slice(idx + 5).split("&")[0];
        }
    }
    try {
        // fileURLToPath aus Node.js kümmert sich automatisch um %20 und Leerzeichen!
        if (s.startsWith("file://")) {
            return fileURLToPath(s);
        }
        return decodeURIComponent(s);
    } catch(e) {
        return s;
    }
}

function isLiked(value) {
    return !!liked[toMediaKey(value)];
}

function formatTime(sec) {
    if (!sec) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" + s : s);
}

////////////////////////////////////////////////////////////
// LOAD MUSIC
////////////////////////////////////////////////////////////

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function renderVirtualFilesFolderCard(filesList, type, container) {
  const card = document.createElement("div");
  card.className = "mediaCard folder-card";
  card.style.cssText = "min-height: 80px; justify-content: center; position: relative;";
  
  card.innerHTML = `
    <div class="mediaBadge" style="background: #dda16e; color: black; font-weight: bold;">Lokal Dateien</div>
    <div style="font-size: 32px; text-align: center; margin-bottom: 4px;">🔗</div>
    <div class="mediaTitle" style="text-align: center; font-size: 13px;">Verknüpfte Einzeldateien</div>
    <div style="font-size: 10px; color: var(--text-muted); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${filesList.length} Datei(en)</div>
  `;
  
  const contentsGrid = document.createElement("div");
  contentsGrid.className = "folderContentsGrid hidden";
  contentsGrid.style.cssText = "grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 12px; padding: 12px; background: rgba(0,0,0,0.15); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.1); margin-top: 5px; margin-bottom: 15px; width: 100%;";
  
  card.onclick = () => {
    const isHidden = contentsGrid.classList.contains("hidden");
    if (isHidden) {
      contentsGrid.classList.remove("hidden");
      card.style.borderColor = "var(--accent)";
      
      let mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");
      
      filesList.forEach(fullPath => {
        const file = path.basename(fullPath);
        const name = file.replace(/\.[^/.]+$/, "");
        const key = toMediaKey(fullPath);
        const currentTag = mediaTags[key] || "";
        const displayTag = currentTag !== "" ? currentTag : (type === 'music' ? 'Musik' : 'Video');
        
        const fileCard = document.createElement("div");
        fileCard.className = `mediaCard ${type}`;
        fileCard.style.minHeight = type === 'music' ? '90px' : 'auto';
        fileCard.dataset.filePath = fullPath;
        fileCard.dataset.mediaType = type;
        fileCard.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, fullPath, type);
        };
        
        if (type === 'music') {
          fileCard.innerHTML = `
            <div class="musicCardInner">
              ${getMediaThumbHtml(key, 'music')}
              <div class="musicCardContent">
                <div class="mediaTitle" title="${name}">${name}</div>
                <div class="musicMetaRow">
                  <span class="mediaBadge" title="${fullPath}">${displayTag}</span>
                  <span class="mediaMeta">Song</span>
                </div>
              </div>
              <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
            </div>
          `;
        } else {
          fileCard.innerHTML = `
            <div class="mediaBadge" title="${fullPath}">${displayTag}</div>
            <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
            ${getMediaThumbHtml(key, type)}
            <div class="mediaTitle">${name}</div>
          `;
        }
        
        setupMediaThumbListeners(fileCard, key, type);
        
        fileCard.onclick = (e) => {
          e.stopPropagation();
          
          if (type === 'music') {
            currentPlaybackList = [];
            videoPlayer.pause();
            activeType = "music";
            musicList = filesList;
            currentIndex = filesList.indexOf(fullPath);
            
            player.src = fullPath;
            ensureAudioContext();
            player.play();
            syncRecordGlow();
            playBtn.innerText = "⏸";
            updateLikeButton();
            updateVideoControls();
            updateNowPlaying();
          } else {
            currentPlaybackList = [];
            document.querySelectorAll(".mediaCard").forEach(v => v.classList.remove("active"));
            fileCard.classList.add("active");
            if (player) player.pause();
            activeType = "video";
            videoListData = filesList;
            currentIndex = filesList.indexOf(fullPath);
            
            videoPlayer.src = fullPath;
            videoPlayer.currentTime = 0;
            ensureAudioContext();
            videoPlayer.play();
            if (playBtn) playBtn.innerText = "⏸";
            saveToHistory(fullPath);
            updateLikeButton();
            updateVideoControls();
            updateNowPlaying();
          }
        };
        
        contentsGrid.appendChild(fileCard);
      });
    } else {
      contentsGrid.classList.add("hidden");
      card.style.borderColor = "transparent";
      contentsGrid.innerHTML = "";
    }
  };
  
  container.appendChild(card);
  container.appendChild(contentsGrid);
}

function renderFolderCard(folderPath, type, idx, container) {
  const folderName = path.basename(folderPath);
  const card = document.createElement("div");
  card.className = "mediaCard folder-card";
  card.style.cssText = "min-height: 80px; justify-content: center; position: relative;";
  card.dataset.folderPath = folderPath;
  card.dataset.mediaType = type;
  card.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showFolderContextMenu(e, folderPath, type);
  };
  
  card.innerHTML = `
    <div class="mediaBadge" style="background: var(--folder-color, #dda16e); color: black; font-weight: bold;">Lokal Ordner</div>
    <div style="display: flex; justify-content: center; margin-bottom: 4px; padding-top: 6px;">
      <svg class="folder-icon" viewBox="0 0 24 24" width="32" height="32" fill="var(--folder-color, #dda16e)"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
    </div>
    <div class="mediaTitle" style="text-align: center; font-size: 13px;">${folderName}</div>
    <div style="font-size: 10px; color: var(--text-muted); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${folderPath}">${folderPath}</div>
  `;
  
  const contentsGridId = `folder-contents-${type}-${idx}`;
  const contentsGrid = document.createElement("div");
  contentsGrid.id = contentsGridId;
  contentsGrid.className = "folderContentsGrid hidden";
  contentsGrid.style.cssText = "grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 12px; padding: 12px; background: rgba(0,0,0,0.15); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.1); margin-top: 5px; margin-bottom: 15px; width: 100%;";
  
  card.onclick = () => {
    const isHidden = contentsGrid.classList.contains("hidden");
    if (isHidden) {
      contentsGrid.classList.remove("hidden");
      card.style.borderColor = "var(--accent)";
      
      contentsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 10px; font-size: 12px;">Ordner wird gescannt...</div>`;
      
      setTimeout(() => {
        try {
          if (!fs.existsSync(folderPath)) {
            contentsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #ff6b6b; padding: 10px; font-size: 12px;">Ordner wurde nicht gefunden oder ist nicht verfügbar.</div>`;
            return;
          }
          
          const files = fs.readdirSync(folderPath);
          const extPattern = type === 'music' 
            ? /\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i 
            : /\.(mp4|webm|mkv|avi|mov|flv|ogv|m4v|ts|m2ts)$/i;
          const lowerFileSet = new Set(files.map(x => x.toLowerCase()));
            
          const mediaFiles = files.filter(f => {
            if (!f.match(extPattern)) return false;
            if (type === 'video' && f.toLowerCase().endsWith('.mkv') && !f.includes('_FEHLER')) {
              const mp4Name = f.slice(0, -4).toLowerCase() + '.mp4';
              if (lowerFileSet.has(mp4Name)) return false;
            }
            return true;
          });
          
          if (mediaFiles.length === 0) {
            contentsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 10px; font-size: 12px;">Keine Mediendateien in diesem Ordner gefunden.</div>`;
            return;
          }
          
          contentsGrid.innerHTML = "";
          
          let folderMediaList = [];
          mediaFiles.forEach(file => {
            const fullPath = path.join(folderPath, file);
            folderMediaList.push(fullPath);
          });
          
          let mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");
          
          mediaFiles.forEach(file => {
            const fullPath = path.join(folderPath, file);
            const name = file.replace(/\.[^/.]+$/, "");
            const key = toMediaKey(fullPath);
            const currentTag = mediaTags[key] || "";
            const displayTag = currentTag !== "" ? currentTag : (type === 'music' ? 'Musik' : 'Video');
            
            const fileCard = document.createElement("div");
            fileCard.className = `mediaCard ${type}`;
            fileCard.dataset.filePath = fullPath;
            fileCard.dataset.mediaType = type;
            fileCard.oncontextmenu = (e) => {
              e.preventDefault();
              e.stopPropagation();
              showFileContextMenu(e, fullPath, type);
            };
            
            if (type === 'music') {
              fileCard.innerHTML = `
                <div class="musicCardInner">
                  ${getMediaThumbHtml(key, 'music')}
                  <div class="musicCardContent">
                    <div class="mediaTitle" title="${name}">${name}</div>
                    <div class="musicMetaRow">
                      <span class="mediaBadge" title="${fullPath}">${displayTag}</span>
                      <span class="mediaMeta">Song</span>
                    </div>
                  </div>
                  <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
                </div>
              `;
            } else {
              fileCard.innerHTML = `
                <div class="mediaBadge" title="${fullPath}">${displayTag}</div>
                <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
                ${getMediaThumbHtml(key, type)}
                <div class="mediaTitle">${name}</div>
              `;
            }
            
            setupMediaThumbListeners(fileCard, key, type);
            
            fileCard.onclick = (e) => {
              e.stopPropagation();
              
              if (type === 'music') {
                currentPlaybackList = [];
                videoPlayer.pause();
                activeType = "music";
                musicList = folderMediaList;
                currentIndex = folderMediaList.indexOf(fullPath);
                
                player.src = fullPath;
                ensureAudioContext();
                player.play();
                syncRecordGlow();
                playBtn.innerText = "⏸";
                updateLikeButton();
                updateVideoControls();
                updateNowPlaying();
              } else {
                currentPlaybackList = [];
                document.querySelectorAll(".mediaCard").forEach(v => v.classList.remove("active"));
                fileCard.classList.add("active");
                if (player) player.pause();
                activeType = "video";
                videoListData = folderMediaList;
                currentIndex = folderMediaList.indexOf(fullPath);
                
                videoPlayer.src = fullPath;
                videoPlayer.currentTime = 0;
                ensureAudioContext();
                videoPlayer.play();
                if (playBtn) playBtn.innerText = "⏸";
                saveToHistory(fullPath);
                updateLikeButton();
                updateVideoControls();
                updateNowPlaying();
              }
            };
            
            contentsGrid.appendChild(fileCard);
          });
        } catch (err) {
          console.error("Error reading folder contents:", err);
          contentsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #ff6b6b; padding: 10px; font-size: 12px;">Fehler beim Lesen des Ordnerinhalts.</div>`;
        }
      }, 50);
    } else {
      contentsGrid.classList.add("hidden");
      card.style.borderColor = "transparent";
      contentsGrid.innerHTML = "";
    }
  };
  
  container.appendChild(card);
  container.appendChild(contentsGrid);
}

function loadMusic() {
    musicList = [];
    musicGrid.innerHTML = "";
    
    // Create header for Library
    const libHeader = document.createElement("h3");
    libHeader.innerText = "Bibliothek";
    libHeader.style.cssText = "grid-column: 1 / -1; margin: 15px 0 10px 0; color: #fff; font-size: 16px; display: flex; align-items: center; gap: 8px;";
    musicGrid.appendChild(libHeader);
    
    // 1. App's music folder (Internal Library)
    const localFiles = fs.existsSync(musicFolder) ? fs.readdirSync(musicFolder) : [];
    const localPaths = localFiles
      .filter(file => file.match(/\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i))
      .map(file => path.join(musicFolder, file));

    localPaths.forEach(filePath => {
      musicList.push(filePath);
    });

    let mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");

    if (localPaths.length === 0) {
      const emptyText = document.createElement("div");
      emptyText.innerText = "Keine Musikdateien in der Mediathek.";
      emptyText.style.cssText = "grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; padding: 10px 0;";
      musicGrid.appendChild(emptyText);
    } else {
      localPaths.forEach(fullPath => {
        const name = path.basename(fullPath).replace(/\.[^/.]+$/, "");
        const key = toMediaKey(fullPath);
        const currentTag = mediaTags[key] || "";
        const displayTag = currentTag !== "" ? currentTag : "Musik";

        const card = document.createElement("div");
        card.className = "mediaCard music";
        card.dataset.filePath = fullPath;
        card.dataset.mediaType = "music";
        card.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, fullPath, "music");
        };
        card.innerHTML = `
          <div class="musicCardInner">
            ${getMediaThumbHtml(key, 'music')}
            <div class="musicCardContent">
              <div class="mediaTitle" title="${name}">${name}</div>
              <div class="musicMetaRow">
                <span class="mediaBadge" title="${fullPath}">${displayTag}</span>
                <span class="mediaMeta">Song</span>
              </div>
            </div>
            <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
          </div>
        `;

        setupMediaThumbListeners(card, key, 'music');

        card.onclick = () => {
            currentPlaybackList = [];
            videoPlayer.pause();
            activeType = "music";
            musicList = localPaths;
            currentIndex = musicList.indexOf(fullPath);
            player.src = fullPath;
            ensureAudioContext();
            player.play();
            syncRecordGlow();
            playBtn.innerText = "⏸";
            updateLikeButton();
            updateVideoControls();
            updateNowPlaying();
        };
        musicGrid.appendChild(card);
      });
    }

    // Create header for External Linked Items
    const extHeader = document.createElement("h3");
    extHeader.innerText = "Lokal abrufen (Verknüpft)";
    extHeader.style.cssText = "grid-column: 1 / -1; margin: 25px 0 10px 0; color: #fff; font-size: 16px; display: flex; align-items: center; gap: 8px;";
    musicGrid.appendChild(extHeader);

    // 2. Library folders (linked folders)
    const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
    
    // 3. Library files (linked individual files)
    const libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]")
      .filter(f => f.match(/\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i) && fs.existsSync(f));

    if (libraryFolders.length === 0 && libraryFiles.length === 0) {
      const emptyText = document.createElement("div");
      emptyText.innerText = "Keine externen Ordner oder Dateien verknüpft.";
      emptyText.style.cssText = "grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; padding: 10px 0;";
      musicGrid.appendChild(emptyText);
    } else {
      libraryFolders.forEach((folder, idx) => {
        const types = JSON.parse(localStorage.getItem("libraryFolderTypes") || "{}");
        const typeOfFolder = types[folder] || "both";
        if (typeOfFolder === "music" || typeOfFolder === "both") {
          renderFolderCard(folder, 'music', idx, musicGrid);
        }
      });

      if (libraryFiles.length > 0) {
        renderVirtualFilesFolderCard(libraryFiles, 'music', musicGrid);
      }
    }
}

shuffleBtn.onclick = ()=>{

shuffle = !shuffle

if(shuffle){

shuffleBtn.style.color="#1db954"

}else{

shuffleBtn.style.color="white"

}

}
////////////////////////////////////////////////////////////
// LOAD VIDEOS
////////////////////////////////////////////////////////////


function cleanupOldBuffers(currentFile) {
    try {
        const files = fs.readdirSync(videoFolder);
        files.forEach(f => {
            const fullP = path.join(videoFolder, f);
            // Wir löschen alles, was mit "buffer_" anfängt und NICHT die aktuelle Datei ist
            if (f.startsWith("buffer_") && fullP !== currentFile) {
                try {
                    fs.unlinkSync(fullP);
                } catch(e) {
                    // Datei ist noch gesperrt? Kein Problem, beim nächsten Mal dann.
                }
            }
        });
    } catch (err) {
        console.error("Cleanup Fehler:", err);
    }
}

////////////////////////////////////////////////////////////
// HINTERGRUND-KONVERTER (MIT UI & BERECHNUNG)
////////////////////////////////////////////////////////////

function getKeepOriginalMkv() {
    return localStorage.getItem("keepOriginalMkv") !== "false";
}

function syncKeepOriginalMkvUI() {
    const keep = getKeepOriginalMkv();
    const chk = document.getElementById("keepOriginalMkvToggle");
    const hint = document.getElementById("keepOriginalMkvHint");
    if (chk) chk.checked = keep;
    if (hint) {
        hint.textContent = keep
            ? "AN — Original-.mkv bleibt erhalten (MP4 wird zusätzlich erstellt)"
            : "AUS — Original-.mkv wird nach erfolgreicher MP4-Umwandlung gelöscht (Papierkorb)";
    }
}

window.toggleKeepOriginalMkv = function(checked) {
    const keep = Boolean(checked);
    localStorage.setItem("keepOriginalMkv", keep ? "true" : "false");
    syncKeepOriginalMkvUI();
    if (typeof showVideoToast === "function") {
        showVideoToast(keep ? "💾 Original-MKV wird nach Konvertierung beibehalten" : "🗑️ Original-MKV wird nach Konvertierung gelöscht");
    }
};

function toggleConvertModal() {
    document.getElementById("convertModal").classList.toggle("hidden");
    syncKeepOriginalMkvUI();
    updateConvertUI();
}

function updateConvertUI() {
    const btn = document.getElementById("convertBtn");
    const modalBody = document.getElementById("convertModalBody");

    // --- TEIL 1: ICON-LOGIK (Für den Punkt oben rechts) ---
    if (btn) {
        // Erstmal alles zurücksetzen
        btn.classList.remove("active", "queued");

        if (isConverting) {
            // Es wird gearbeitet -> GRÜNER Punkt
            btn.classList.add("active");
        } else if (conversionQueue.length > 0) {
            // Warteschlange voll, aber pausiert/wartend -> BLAUER Punkt
            btn.classList.add("queued");
        }
    }

    if (typeof window.BgTaskManager !== "undefined") {
        window.BgTaskManager.update();
    }

    // --- TEIL 2: DEIN SCHÖNES MODAL-DESIGN (Beibehalten) ---
    if (!modalBody) return;

    // Wenn nichts zu tun ist
    if (!isConverting && conversionQueue.length === 0) {
        modalBody.innerHTML = `
            <div style="text-align: center; color: #b3b3b3; padding: 20px 0;">
                <span style="font-size: 2rem; display: block; margin-bottom: 10px;">✨</span>
                Alles sauber! Keine MKVs zum Umwandeln gefunden.
            </div>`;
        return;
    }

    // Wenn er gerade arbeitet (Die "Active Card")
    let html = `
        <div class="convert-active-card">
            <div style="color: #b3b3b3; font-size: 0.95rem; margin-bottom: 8px;">Wird aktuell umgewandelt:</div>
            <div class="convert-filename">${currentConvData.file}</div>
            
            <div class="progress-bg">
                <div class="progress-fill" style="width: ${currentConvData.progress}%"></div>
            </div>
            
            <div class="convert-stats">
                <span>Fortschritt: ${currentConvData.progress.toFixed(1)}%</span>
                <span>Restzeit: ca. ${currentConvData.eta}</span>
            </div>
        </div>
    `;

    // Warteschlange anzeigen
    if (conversionQueue.length > 0) {
        html += `
        <div class="convert-queue">
            <h4>Warteschlange (${conversionQueue.length})</h4>
            <ul>
        `;
        conversionQueue.forEach(f => {
            html += `<li>⏳ ${path.basename(f).replace(/\.mkv$/i, "")}</li>`;
        });
        html += `</ul></div>`;
    } else {
        html += `
            <div style="text-align: center; color: #b3b3b3; margin-top: 25px;">
                Keine weiteren Videos in der Warteschlange.
            </div>`;
    }

    modalBody.innerHTML = html;
}

////////////////////////////////////////////////////////////
// HINTERGRUND-KONVERTER (MIT SCHUTZSCHILD & FEHLER-RETTUNG)
////////////////////////////////////////////////////////////

function resolveMkvTargetMp4Path(fullMkvPath) {
    const siblingMp4 = fullMkvPath.replace(/\.mkv$/i, ".mp4");
    if (fs.existsSync(siblingMp4)) {
        try {
            if (fs.statSync(siblingMp4).size > 1024) return siblingMp4;
        } catch (e) {}
    }
    const fallbackMp4 = path.join(videoFolder, path.basename(fullMkvPath).replace(/\.mkv$/i, ".mp4"));
    const parentDir = path.dirname(fullMkvPath);
    if (parentDir.toLowerCase() === videoFolder.toLowerCase()) return siblingMp4;
    try {
        const probePath = path.join(parentDir, `.myview_wtest_${Date.now()}`);
        fs.writeFileSync(probePath, "", "utf8");
        fs.unlinkSync(probePath);
        return siblingMp4;
    } catch (e) {
        if (!fs.existsSync(videoFolder)) {
            try { fs.mkdirSync(videoFolder, { recursive: true }); } catch (e2) {}
        }
        return fallbackMp4;
    }
}

function updateLibraryAfterMkvConversion(fullMkvPath, fullMp4Path) {
    try {
        let libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
        const mkvLower = fullMkvPath.toLowerCase();
        const mp4Lower = fullMp4Path.toLowerCase();
        const inVideoFolder = path.dirname(fullMp4Path).toLowerCase() === videoFolder.toLowerCase();
        let changed = false;

        if (libraryFiles.some(f => String(f).toLowerCase() === mkvLower)) {
            libraryFiles = libraryFiles.filter(f => String(f).toLowerCase() !== mkvLower);
            changed = true;
            if (!inVideoFolder && !libraryFiles.some(f => String(f).toLowerCase() === mp4Lower)) {
                libraryFiles.push(fullMp4Path);
            }
        }
        if (changed) {
            localStorage.setItem("libraryFiles", JSON.stringify(libraryFiles));
        }
    } catch (e) {}
}

function preserveMkvSubtitlesBeforeDelete(mkvPath, done) {
    const finish = typeof done === "function" ? done : () => {};
    if (!mkvPath || typeof fetch !== "function") {
        finish();
        return;
    }
    let settled = false;
    const safeDone = () => {
        if (settled) return;
        settled = true;
        finish();
    };
    const timer = setTimeout(safeDone, 12000);
    fetch("http://127.0.0.1:45678/api/media/extract_subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: mkvPath })
    }).catch(() => {}).finally(() => {
        clearTimeout(timer);
        safeDone();
    });
}

function runNextMkvConversion() {
    if (conversionQueue.length === 0) {
        isConverting = false;
        currentConvData = { file: "", fullPath: "", progress: 0, eta: "Berechne...", durationSec: 0 };
        updateConvertUI();
        if (activeType !== "music") {
            loadVideos();
        } else {
            // Video-Mediathek-Liste still aktualisieren, ohne Musik abzubrechen
            try {
                const wasPlaying = player && !player.paused;
                const prevTime = player ? player.currentTime : 0;
                loadVideos();
                if (wasPlaying && player) {
                    player.currentTime = prevTime;
                    player.play().catch(() => {});
                }
            } catch (e) {}
        }
        if (typeof showVideoToast === "function") {
            showVideoToast("✅ MKV-Umwandlung abgeschlossen!");
        }
        return;
    }

    isConverting = true;
    const rawItem = conversionQueue.shift();
    const fullMkvPath = path.isAbsolute(rawItem) ? rawItem : path.join(videoFolder, rawItem);
    const mkvBaseName = path.basename(fullMkvPath);
    const fullMp4Path = resolveMkvTargetMp4Path(fullMkvPath);

    currentConvData = {
        file: mkvBaseName.replace(/\.mkv$/i, ""),
        fullPath: fullMkvPath,
        progress: 0,
        eta: "Berechne...",
        durationSec: 0
    };
    updateConvertUI();

    if (!fs.existsSync(fullMkvPath)) {
        runNextMkvConversion();
        return;
    }

    if (fs.existsSync(fullMp4Path)) {
        let validMp4 = false;
        try {
            validMp4 = fs.statSync(fullMp4Path).size > 1024;
        } catch (e) {}
        if (validMp4) {
            updateLibraryAfterMkvConversion(fullMkvPath, fullMp4Path);
            if (getKeepOriginalMkv()) {
                preserveMkvSubtitlesBeforeDelete(fullMkvPath);
                runNextMkvConversion();
            } else {
                preserveMkvSubtitlesBeforeDelete(fullMkvPath, () => {
                    deleteMkvFile(fullMkvPath, runNextMkvConversion);
                });
            }
            return;
        }
    }

    const activeFfmpeg = resolveFfmpegExecutable();
    if (!fs.existsSync(activeFfmpeg)) {
        console.error("ffmpeg.exe nicht gefunden unter:", activeFfmpeg);
        if (typeof showVideoToast === "function") {
            showVideoToast("⚠️ ffmpeg.exe fehlt – MKV wird per Direkt-Stream wiedergegeben.");
        }
        runNextMkvConversion();
        return;
    }

    const proc = spawn(activeFfmpeg, [
        '-nostdin',
        '-err_detect', 'ignore_err', // 🛡️ Zwingt FFmpeg, Fehler zu ignorieren!
        '-fflags', '+genpts',        // 🛡️ Repariert kaputte Zeitstempel während der Umwandlung
        '-i', fullMkvPath,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-map_metadata', '0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-aac_coder', 'fast',
        '-b:a', '320k',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y',
        fullMp4Path
    ]);

    proc.stderr.on('data', (data) => {
        const str = data.toString();

        if (currentConvData.durationSec === 0) {
            const durMatches = Array.from(str.matchAll(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g));
            const durMatch = durMatches.length ? durMatches[durMatches.length - 1] : null;
            if (durMatch) {
                currentConvData.durationSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
            }
        }

        const timeMatches = Array.from(str.matchAll(/time=\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g));
        const timeMatch = timeMatches.length ? timeMatches[timeMatches.length - 1] : null;
        const speedMatches = Array.from(str.matchAll(/speed=\s*([\d.]+)x/g));
        const speedMatch = speedMatches.length ? speedMatches[speedMatches.length - 1] : null;

        if (timeMatch && currentConvData.durationSec > 0) {
            const curSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
            currentConvData.progress = Math.min((curSec / currentConvData.durationSec) * 100, 100);

            if (speedMatch) {
                const speed = parseFloat(speedMatch[1]);
                if (speed > 0) {
                    const remainingSec = (currentConvData.durationSec - curSec) / speed;
                    currentConvData.eta = formatTime(remainingSec) + " Min.";
                }
            }

            if (!proc.updateTimeout) {
                proc.updateTimeout = setTimeout(() => {
                    updateConvertUI();
                    proc.updateTimeout = null;
                }, 400);
            }
        }
    });

    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
        if (proc.updateTimeout) {
            clearTimeout(proc.updateTimeout);
            proc.updateTimeout = null;
        }
        let isFinished = currentConvData.progress >= 95;
        if (!isFinished && code === 0 && fs.existsSync(fullMp4Path)) {
            try {
                if (fs.statSync(fullMp4Path).size > 1024) isFinished = true;
            } catch (e) {}
        }

        if (code === 0 && fs.existsSync(fullMp4Path) && isFinished) {
            currentConvData.progress = 100;
            updateConvertUI();
            updateLibraryAfterMkvConversion(fullMkvPath, fullMp4Path);
            if (getKeepOriginalMkv()) {
                preserveMkvSubtitlesBeforeDelete(fullMkvPath);
                runNextMkvConversion();
            } else {
                preserveMkvSubtitlesBeforeDelete(fullMkvPath, () => {
                    deleteMkvFile(fullMkvPath, runNextMkvConversion);
                });
            }
        } else {
            console.error(`Fehler! Umwandlung bei ${currentConvData.progress.toFixed(1)}% gestoppt.`);
            if (fs.existsSync(fullMp4Path)) {
                try { fs.unlinkSync(fullMp4Path); } catch (e) {}
            }
            if (fs.existsSync(fullMkvPath)) {
                try {
                    const errorPath = fullMkvPath.replace(/\.mkv$/i, "_FEHLER.mkv");
                    fs.renameSync(fullMkvPath, errorPath);
                } catch (e) {}
            }
            runNextMkvConversion();
        }
    });

    proc.on('error', (err) => {
        console.error("FFmpeg Prozess Fehler:", err);
        runNextMkvConversion();
    });
}

function enqueueMkvConversions(mkvPaths) {
    if (!Array.isArray(mkvPaths) || mkvPaths.length === 0) return 0;
    const existingLower = new Set(conversionQueue.map(p => String(p).toLowerCase()));
    if (isConverting && currentConvData && currentConvData.fullPath) {
        existingLower.add(String(currentConvData.fullPath).toLowerCase());
    }

    let added = 0;
    const keepOriginal = getKeepOriginalMkv();
    for (const rawPath of mkvPaths) {
        if (!rawPath) continue;
        const fullPath = path.isAbsolute(rawPath) ? rawPath : path.join(videoFolder, rawPath);
        if (!fullPath.toLowerCase().endsWith(".mkv") || fullPath.includes("_FEHLER")) continue;
        if (!fs.existsSync(fullPath)) continue;

        const targetMp4 = fullPath.replace(/\.mkv$/i, ".mp4");
        const fallbackMp4 = path.join(videoFolder, path.basename(fullPath).replace(/\.mkv$/i, ".mp4"));
        const hasValidMp4 = [targetMp4, fallbackMp4].some(mp4 => {
            try { return fs.existsSync(mp4) && fs.statSync(mp4).size > 1024; } catch (e) { return false; }
        });
        if (hasValidMp4 && keepOriginal) {
            continue;
        }

        const key = fullPath.toLowerCase();
        if (existingLower.has(key)) continue;
        existingLower.add(key);
        conversionQueue.push(fullPath);
        added++;
    }

    if (added > 0 || isConverting) {
        updateConvertUI();
        if (!isConverting && conversionQueue.length > 0) {
            runNextMkvConversion();
        }
    }
    return added;
}

function processMKVsInBackground() {
    if (!fs.existsSync(videoFolder)) return;
    const files = fs.readdirSync(videoFolder);

    // Müllabfuhr für alte Puffer
    files.forEach(f => {
        if (f.startsWith("buffer_") || f.startsWith("temp_")) {
            try { fs.unlinkSync(path.join(videoFolder, f)); } catch (e) {}
        }
    });

    const mkvFullPaths = files
        .filter(f => f.toLowerCase().endsWith(".mkv") && !f.includes("_FEHLER"))
        .map(f => path.join(videoFolder, f));

    enqueueMkvConversions(mkvFullPaths);
    if (!isConverting && conversionQueue.length === 0) {
        updateConvertUI();
    }
}

// Hilfsfunktion: Versucht erst den Papierkorb, dann die Notfall-Löschung
function deleteMkvFile(filePath, callback) {
    const done = typeof callback === "function" ? callback : () => {};
    if (shell && typeof shell.trashItem === "function") {
        Promise.resolve(shell.trashItem(filePath)).then(() => {
            done();
        }).catch((err) => {
            console.warn("Papierkorb-Fallback: Lösche Datei direkt:", err);
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (e) {
                console.error("Konnte Datei gar nicht löschen:", e);
            }
            done();
        });
    } else {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            console.error("Konnte Datei gar nicht löschen:", e);
        }
        done();
    }
}

////////////////////////////////////////////////////////////
// LOAD VIDEOS (SIMPEL & PERFEKT)
////////////////////////////////////////////////////////////

function loadVideos() {
    if (player) player.pause();
    videoListData = [];
    videoList.innerHTML = "";
    
    // Create header for Library
    const libHeader = document.createElement("h3");
    libHeader.innerText = "Mediathek";
    libHeader.style.cssText = "grid-column: 1 / -1; margin: 15px 0 10px 0; color: #fff; font-size: 16px; display: flex; align-items: center; gap: 8px;";
    videoList.appendChild(libHeader);
    
    // 1. App's video folder (Internal Mediathek)
    const localFiles = fs.existsSync(videoFolder) ? fs.readdirSync(videoFolder) : [];
    const localLowerSet = new Set(localFiles.map(x => x.toLowerCase()));
    const localPaths = localFiles
      .filter(file => {
        if (!file.match(/\.(mp4|webm|mkv|avi|mov|flv|ogv|m4v|ts|m2ts)$/i) || file.startsWith("buffer_") || file.startsWith("temp_")) return false;
        if (file.toLowerCase().endsWith(".mkv") && !file.includes("_FEHLER")) {
          const mp4Twin = file.slice(0, -4).toLowerCase() + ".mp4";
          if (localLowerSet.has(mp4Twin)) return false;
        }
        return true;
      })
      .map(file => path.join(videoFolder, file));

    localPaths.forEach(filePath => {
      videoListData.push(filePath);
    });

    let mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");

    if (localPaths.length === 0) {
      const emptyText = document.createElement("div");
      emptyText.innerText = "Keine Videodateien in der Mediathek.";
      emptyText.style.cssText = "grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; padding: 10px 0;";
      videoList.appendChild(emptyText);
    } else {
      localPaths.forEach(fullPath => {
        const file = path.basename(fullPath);
        const name = file.replace(/\.[^/.]+$/, "");
        const key = toMediaKey(fullPath);
        const currentTag = mediaTags[key] || "";
        const displayTag = currentTag !== "" ? currentTag : "Video";

        const itemEl = document.createElement("div");
        itemEl.className = "mediaCard video";
        itemEl.dataset.filePath = fullPath;
        itemEl.dataset.mediaType = "video";
        itemEl.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, fullPath, "video");
        };
        itemEl.innerHTML = `
            <div class="mediaBadge" title="${fullPath}">${displayTag}</div>
            <div class="likeIcon" data-src="${fullPath}">${isLiked(fullPath) ? "❤" : "🤍"}</div>
            ${getMediaThumbHtml(key, 'video')}
            <div class="mediaTitle">${name}</div>
        `;

        setupMediaThumbListeners(itemEl, key, 'video');

        itemEl.onclick = () => {
            currentPlaybackList = [];
            document.querySelectorAll(".mediaCard").forEach(v => v.classList.remove("active"));
            itemEl.classList.add("active");
            if (player) player.pause();
            activeType = "video";
            videoListData = localPaths;
            currentIndex = videoListData.indexOf(fullPath);
            videoPlayer.src = fullPath;
            videoPlayer.currentTime = 0;
            if (typeof window.probeAndLoadVideoTracks === "function") {
              window.probeAndLoadVideoTracks(fullPath);
            }
            ensureAudioContext();
            videoPlayer.play();
            if (playBtn) playBtn.innerText = "⏸";
            saveToHistory(fullPath);
            updateLikeButton();
            updateVideoControls();
            updateNowPlaying();
        };
        videoList.appendChild(itemEl);
      });
    }

    // Create header for External Linked Items
    const extHeader = document.createElement("h3");
    extHeader.innerText = "Lokal abrufen (Verknüpft)";
    extHeader.style.cssText = "grid-column: 1 / -1; margin: 25px 0 10px 0; color: #fff; font-size: 16px; display: flex; align-items: center; gap: 8px;";
    videoList.appendChild(extHeader);

    // 2. Library folders
    const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
    
    // 3. Library files
    const libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]")
      .filter(f => f.match(/\.(mp4|webm|mkv|avi|mov|flv|ogv|m4v|ts|m2ts)$/i) && fs.existsSync(f));

    if (libraryFolders.length === 0 && libraryFiles.length === 0) {
      const emptyText = document.createElement("div");
      emptyText.innerText = "Keine externen Ordner oder Videos verknüpft.";
      emptyText.style.cssText = "grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; padding: 10px 0;";
      videoList.appendChild(emptyText);
    } else {
      libraryFolders.forEach((folder, idx) => {
        const types = JSON.parse(localStorage.getItem("libraryFolderTypes") || "{}");
        const typeOfFolder = types[folder] || "both";
        if (typeOfFolder === "video" || typeOfFolder === "both") {
          renderFolderCard(folder, 'video', idx, videoList);
        }
      });

      if (libraryFiles.length > 0) {
        renderVirtualFilesFolderCard(libraryFiles, 'video', videoList);
      }
    }
}

function startVideoPlayback(pathToPlay, displayName, originalPathForHistory) {
    videoPlayer.src = pathToPlay;
    videoPlayer.currentTime = 0;
    if (typeof window.probeAndLoadVideoTracks === "function") {
        window.probeAndLoadVideoTracks(resolveRawVideoFilePath(originalPathForHistory || pathToPlay));
    }
    
    // Wir setzen den Titel direkt, damit "localhost" niemals oben auftaucht
    if (nowPlaying) nowPlaying.textContent = displayName;
    
    ensureAudioContext();
    videoPlayer.play().catch(e => console.log("Warte auf Stream-Daten..."));
    syncRecordGlow();
    
    if (playBtn) playBtn.innerText = "⏸";
    
    // In der History speichern wir natürlich den echten Pfad zur Datei
    saveToHistory(originalPathForHistory);
    updateLikeButton();
    updateVideoControls();
}


////////////////////////////////////////////////////////////
// PROGRESS
////////////////////////////////////////////////////////////

function updateProgress(){

const activePlayer = activeType==="video" ? videoPlayer : player

if(!activePlayer.duration) return

// A-B Schleifen-Wiederholung
if (typeof abLoop !== "undefined" && abLoop.active && abLoop.b !== null && activePlayer.currentTime >= abLoop.b) {
  activePlayer.currentTime = abLoop.a;
}

// Untertitel-Aktualisierung bei Videos
if (activeType === "video" && typeof updateSubtitles === "function") {
  updateSubtitles();
}

if (activePlayer.duration) {
  const pct = (activePlayer.currentTime / activePlayer.duration) * 100;
  progressBar.value = pct;
  progressBar.style.setProperty('--progress', `${pct}%`);
} else {
  progressBar.value = 0;
  progressBar.style.setProperty('--progress', '0%');
}

currentTimeEl.innerText = formatTime(activePlayer.currentTime)
durationEl.innerText = formatTime(activePlayer.duration)

}

player.addEventListener("timeupdate",updateProgress)
videoPlayer.addEventListener("timeupdate",updateProgress)

// 👉 PLAY / PAUSE EVENTS (NEU)
player.addEventListener("play",()=>{
  playBtn.innerText="❚❚"
  record.classList.add("spin") // Zwingt die Platte sich zu drehen
  syncRecordGlow()
})

player.addEventListener("pause",()=>{
  playBtn.innerText="▶"
  record.classList.remove("spin") // Stoppt die Platte
  syncRecordGlow()
})

videoPlayer.addEventListener("play",()=>{
  playBtn.innerText="❚❚"
  record.classList.add("spin") // Dreht sich auch beim Video (solange Ton/Bild läuft)
  syncRecordGlow()
})

videoPlayer.addEventListener("pause",()=>{
  playBtn.innerText="▶"
  record.classList.remove("spin") // Stoppt beim Video
  syncRecordGlow()
})

// 👉 PROGRESS bleibt gleich
progressBar.addEventListener("input",()=>{

  const activePlayer = activeType==="video" ? videoPlayer : player

  progressBar.style.setProperty('--progress', `${progressBar.value}%`);
  if(activePlayer.duration){
    activePlayer.currentTime =
    (progressBar.value/100)*activePlayer.duration
  }

})

////////////////////////////////////////////////////////////
// PLAY BUTTON
////////////////////////////////////////////////////////////

playBtn.onclick = ()=>{

  const activePlayer = activeType==="video" ? videoPlayer : player

  if(activePlayer.paused){

    ensureAudioContext()

    if(activeType==="video"){
      player.pause()
    }else{
      videoPlayer.pause()
      record.classList.add("spin")
    }

    activePlayer.play()
    playBtn.innerText="❚❚"

  }else{

    activePlayer.pause()
    playBtn.innerText="▶"
    record.classList.remove("spin")
  }

  syncRecordGlow()
  updateNowPlaying()
}
////////////////////////////////////////////////////////////
// LIKE
////////////////////////////////////////////////////////////

function updateLikeButton() {
    const current = activeType === "video" ? videoPlayer.src : player.src;
    const isVidLiked = isLiked(current);
    
    likeBtn.innerText = isVidLiked ? "❤" : "🤍";
    
    // NEU: Färbt das Herz im Player in der Theme-Farbe ein!
    if (isVidLiked) {
        const rootStyles = getComputedStyle(document.documentElement);
        likeBtn.style.color = rootStyles.getPropertyValue('--heart-color').trim() || "var(--accent)";
        likeBtn.style.textShadow = `0 0 10px ${likeBtn.style.color}`;
    } else {
        likeBtn.style.color = "var(--text-muted)";
        likeBtn.style.textShadow = "none";
    }
}

function toggleLike(src){
  const key = toMediaKey(src)

  liked[key] = !liked[key]
  localStorage.setItem("liked", JSON.stringify(liked))

  updateLikeButton()
  renderLiked()
  loadMusic()
  loadVideos()
  renderHistory()
}

likeBtn.onclick = () => {
  const current = activeType === "video" ? videoPlayer.src : player.src
  toggleLike(current)
}

function renderLiked(){
  likedGrid.innerHTML = ""

  const likedItems = Object.keys(liked).filter(key => liked[key])

  const filtered = likedItems.filter(key => {
    if(likedView === "music" && !key.match(/\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i)) return false
    if(likedView === "video" && !key.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i)) return false
    return true
  })

  const empty = document.getElementById("likedEmpty")
  if(empty){
    empty.classList.toggle("hidden", filtered.length !== 0)
  }

  let mediaTags = {};
  try {
    mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");
  } catch (e) {}

  filtered.forEach(key => {
    const realPath = fromMediaKey(key)
    const isVideo = !!realPath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i)
    const normKey = toMediaKey(realPath)
    const currentTag = mediaTags[normKey] || ""
    const displayTag = currentTag !== "" ? currentTag : (isVideo ? "Video" : "Musik")

    let name = decodeURIComponent(realPath.split("/").pop().split("\\").pop())
    name = name.replace(/\.[^/.]+$/, "")

    const card = document.createElement("div")
    card.className = isVideo ? "mediaCard video" : "mediaCard music"
    card.dataset.filePath = realPath;
    card.dataset.mediaType = isVideo ? "video" : "music";
    card.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFileContextMenu(e, realPath, isVideo ? "video" : "music");
    };

    if (isVideo) {
      card.innerHTML = `
        <div class="mediaBadge" title="${realPath}">${displayTag}</div>
        <div class="likeIcon" data-src="${realPath}">❤</div>
        ${getMediaThumbHtml(normKey, 'video')}
        <div class="mediaTitle" title="${name}">${name}</div>
        <div class="mediaMeta">Gespeichert als Video</div>
      `
    } else {
      card.innerHTML = `
        <div class="musicCardInner">
          ${getMediaThumbHtml(normKey, 'music')}
          <div class="musicCardContent">
            <div class="mediaTitle" title="${name}">${name}</div>
            <div class="musicMetaRow">
              <span class="mediaBadge" title="${realPath}">${displayTag}</span>
              <span class="mediaMeta">Gespeichert als Song</span>
            </div>
          </div>
          <div class="likeIcon" data-src="${realPath}">❤</div>
        </div>
      `
    }

    setupMediaThumbListeners(card, normKey, isVideo ? 'video' : 'music');

    const heart = card.querySelector(".likeIcon")
    heart.onclick = (e) => {
      e.stopPropagation()
      toggleLike(realPath)
    }

    card.onclick = () => {
      currentPlaybackList = []; // Reset active playlist on standard click
      document.querySelectorAll(".mediaCard").forEach(v => v.classList.remove("active"))
      card.classList.add("active")

      if(isVideo){
        if (player) player.pause()
        record.classList.remove("spin")

        showTab("videos")
        activeType = "video"
        videoPlayer.src = realPath; // Use absolute path directly
        videoPlayer.currentTime = 0
        ensureAudioContext()
        videoPlayer.play()
        
        if (playBtn) playBtn.innerText = "⏸"
        saveToHistory(realPath); // Register playback in history using absolute path
        updateLikeButton()
        updateVideoControls()
        updateNowPlaying()
      } else {
        if (videoPlayer) videoPlayer.pause()

        showTab("music")
        activeType = "music"
        player.src = realPath; // Use absolute path directly
        player.currentTime = 0
        ensureAudioContext()
        player.play()
        record.classList.add("spin")
        
        if (playBtn) playBtn.innerText = "⏸"
        saveToHistory(realPath); // Register playback in history using absolute path
        updateLikeButton()
        updateNowPlaying()
      }
    }

    likedGrid.appendChild(card)
  })
}
function showLiked(type){

likedView = type

document.getElementById("likedMusicBtn").classList.remove("active")
document.getElementById("likedVideoBtn").classList.remove("active")

if(type === "music"){
document.getElementById("likedMusicBtn").classList.add("active")
}

if(type === "video"){
document.getElementById("likedVideoBtn").classList.add("active")
}

renderLiked()

}
////////////////////////////////////////////////////////////
// NEXT
////////////////////////////////////////////////////////////


player.addEventListener("ended", () => {
  handleMediaEnded();
})

////////////////////////////////////////////////////////////
// FULLSCREEN
////////////////////////////////////////////////////////////

fullscreenBtn.onclick = () => {
  toggleVideoFullscreen();
};

function toggleFullscreenPlayPause() {
  if (!videoPlayer) return;
  if (videoPlayer.paused) {
    if (player) player.pause();
    if (typeof record !== "undefined" && record) record.classList.remove("spin");
    if (typeof ensureAudioContext === "function") ensureAudioContext();
    videoPlayer.play().catch(() => {});
  } else {
    videoPlayer.pause();
  }
  if (typeof syncRecordGlow === "function") syncRecordGlow();
  if (typeof updateNowPlaying === "function") updateNowPlaying();
}
window.toggleFullscreenPlayPause = toggleFullscreenPlayPause;

(function initFullscreenHud() {
  const container = document.getElementById("videoMainContainer");
  const videoMenuEl = document.getElementById("videoMenu");
  const origMenuWrapper = videoMenuEl ? videoMenuEl.parentElement : null;
  const fsMenuWrapper = document.getElementById("fsMenuWrapper");
  if (!container || !videoPlayer) return;

  videoPlayer.controls = false;
  let fsIdleTimer = null;

  function wakeFullscreenHud() {
    container.classList.remove("fs-idle");
    if (fsIdleTimer) clearTimeout(fsIdleTimer);
    if (document.fullscreenElement === container) {
      fsIdleTimer = setTimeout(() => {
        const menuOpen = videoMenuEl && videoMenuEl.classList.contains("show");
        const eqModalEl = document.getElementById("equalizerModal");
        const eqOpen = Boolean(eqModalEl && !eqModalEl.classList.contains("hidden"));
        if (!videoPlayer.paused && !menuOpen && !eqOpen) {
          container.classList.add("fs-idle");
        }
      }, 2500);
    }
  }
  window.wakeFullscreenHud = wakeFullscreenHud;

  function syncFullscreenHudState() {
    const fsPlayIcon = document.getElementById("fsPlayIcon");
    const fsTitle = document.getElementById("fsVideoTitle");
    const fsTime = document.getElementById("fsTimeDisplay");
    const fsProg = document.getElementById("fsProgressBar");
    const fsVol = document.getElementById("fsVolumeSlider");
    const fsLike = document.getElementById("fsLikeBtn");
    const fsLoop = document.getElementById("fsAbLoopBtn");
    const fsLoopBadge = document.getElementById("fsAbLoopBadge");
    const fsAmb = document.getElementById("fsAmbientBtn");
    const fsEqBtn = document.getElementById("fsEqBtn");

    if (fsPlayIcon) {
      fsPlayIcon.innerHTML = videoPlayer.paused
        ? '<polygon points="6 4 20 12 6 20 6 4"></polygon>'
        : '<rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect>';
    }
    if (fsTitle) {
      const cleanTitle = videoPlayer && videoPlayer.src ? getMediaTitle(videoPlayer.src) : "";
      fsTitle.innerText = cleanTitle || (typeof nowPlaying !== "undefined" && nowPlaying && nowPlaying.textContent) || "Video";
    }
    if (fsProg && fsTime) {
      const cur = videoPlayer.currentTime || 0;
      const dur = videoPlayer.duration && isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      fsProg.value = pct;
      fsProg.style.setProperty("--fs-prog", pct + "%");
      fsTime.innerText = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
    const mainVol = document.getElementById("volumeSlider");
    if (fsVol && mainVol) fsVol.value = mainVol.value;

    if (fsLike) {
      const likedNow = typeof likeBtn !== "undefined" && likeBtn && likeBtn.innerText === "❤";
      fsLike.classList.toggle("active", likedNow);
      const svg = fsLike.querySelector("svg");
      if (svg) svg.setAttribute("fill", likedNow ? "currentColor" : "none");
    }
    if (fsLoop) {
      const abBtn = document.getElementById("abLoopBtn");
      const abBadge = document.getElementById("abLoopText");
      const activeLoop = Boolean(abBtn && abBtn.classList.contains("active"));
      fsLoop.classList.toggle("active", activeLoop);
      if (fsLoopBadge && abBadge) {
        fsLoopBadge.innerText = abBadge.innerText;
        fsLoopBadge.classList.toggle("hidden", abBadge.classList.contains("hidden"));
      }
    }
    if (fsAmb) {
      const ambBtn = document.getElementById("ambientBtn");
      fsAmb.classList.toggle("active", Boolean(ambBtn && ambBtn.classList.contains("active")));
    }
    if (fsEqBtn) {
      const eqModalEl = document.getElementById("equalizerModal");
      fsEqBtn.classList.toggle("active", Boolean(eqModalEl && !eqModalEl.classList.contains("hidden")));
    }
  }

  document.addEventListener("fullscreenchange", () => {
    videoPlayer.controls = false;
    const eqModalEl = document.getElementById("equalizerModal");
    if (document.fullscreenElement === container) {
      if (videoMenuEl && fsMenuWrapper) {
        fsMenuWrapper.appendChild(videoMenuEl);
      }
      if (eqModalEl) {
        container.appendChild(eqModalEl);
      }
      if (typeof window.clampEqualizerModalPosition === "function") {
        window.clampEqualizerModalPosition();
      }
      syncFullscreenHudState();
      wakeFullscreenHud();
    } else {
      if (fsIdleTimer) clearTimeout(fsIdleTimer);
      container.classList.remove("fs-idle");
      if (videoMenuEl && origMenuWrapper) {
        videoMenuEl.classList.remove("show");
        origMenuWrapper.appendChild(videoMenuEl);
      }
      if (eqModalEl && eqModalEl.parentElement !== document.body) {
        document.body.appendChild(eqModalEl);
      }
      if (typeof window.clampEqualizerModalPosition === "function") {
        window.clampEqualizerModalPosition();
      }
    }
  });

  const fsMenuBtn = document.getElementById("fsMenuBtn");
  if (fsMenuBtn && videoMenuEl) {
    fsMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof backToMenu === "function") backToMenu();
      videoMenuEl.classList.toggle("show");
      wakeFullscreenHud();
    });
  }

  const fsProg = document.getElementById("fsProgressBar");
  if (fsProg) {
    fsProg.addEventListener("input", () => {
      fsProg.style.setProperty("--fs-prog", fsProg.value + "%");
      if (videoPlayer.duration && isFinite(videoPlayer.duration)) {
        videoPlayer.currentTime = (parseFloat(fsProg.value) / 100) * videoPlayer.duration;
      }
    });
  }

  const fsVol = document.getElementById("fsVolumeSlider");
  if (fsVol) {
    fsVol.addEventListener("input", () => {
      const mainVol = document.getElementById("volumeSlider");
      if (mainVol) {
        mainVol.value = fsVol.value;
        mainVol.dispatchEvent(new Event("input"));
      } else {
        videoPlayer.volume = Math.min(1, parseFloat(fsVol.value));
      }
    });
  }

  ["play", "pause", "timeupdate", "loadedmetadata", "volumechange"].forEach(ev => {
    videoPlayer.addEventListener(ev, () => {
      if (document.fullscreenElement === container) {
        syncFullscreenHudState();
        if (ev === "pause") container.classList.remove("fs-idle");
      }
    });
  });

  ["likeBtn", "abLoopBtn", "ambientBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => setTimeout(syncFullscreenHudState, 30));
  });

  container.addEventListener("mousemove", wakeFullscreenHud);
  container.addEventListener("mousedown", wakeFullscreenHud);
})();

////////////////////////////////////////////////////////////
// VIDEO CLICK
////////////////////////////////////////////////////////////

videoPlayer.addEventListener("click",(e)=>{
  e.stopPropagation()

  if(videoPlayer.paused){
    player.pause()
    record.classList.remove("spin")
    ensureAudioContext()
    videoPlayer.play()
  }else{
    videoPlayer.pause()
  }

  syncRecordGlow()
  updateNowPlaying()
})

videoPlayer.addEventListener("dblclick", (e) => {
  e.stopPropagation();
  toggleVideoFullscreen();
});

const videoMainContainer = document.querySelector(".video-main");
if (videoMainContainer) {
  videoMainContainer.addEventListener("dblclick", (e) => {
    toggleVideoFullscreen();
  });
}

// Doppelklick auf freie Flächen im Video-Tab oder Playlist schaltet ebenfalls Fullscreen
const videoTabContainer = document.getElementById("videoTab");
if (videoTabContainer) {
  videoTabContainer.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".mediaCard, button, input, select, .custom-context-menu")) {
      toggleVideoFullscreen();
    }
  });
}

////////////////////////////////////////////////////////////
// SPEED MENU
////////////////////////////////////////////////////////////

function changeSpeed(){
  const main = document.getElementById("menuMain");
  const speed = document.getElementById("speedPanel");

  main.classList.add("hidden");
  speed.classList.remove("hidden");
}

function showSleepTimerPanel(){
  const main = document.getElementById("menuMain");
  const timer = document.getElementById("sleepTimerPanel");

  if (main) main.classList.add("hidden");
  if (timer) timer.classList.remove("hidden");
}

function backToMenu(){
  const main = document.getElementById("menuMain");
  const speed = document.getElementById("speedPanel");
  const timer = document.getElementById("sleepTimerPanel");
  const sync = document.getElementById("syncPanel");
  const adj = document.getElementById("videoAdjustPanel");
  const eq = document.getElementById("equalizerPanel");
  const tracks = document.getElementById("tracksPanel");

  if (speed) speed.classList.add("hidden");
  if (timer) timer.classList.add("hidden");
  if (sync) sync.classList.add("hidden");
  if (adj) adj.classList.add("hidden");
  if (eq) eq.classList.add("hidden");
  if (tracks) tracks.classList.add("hidden");
  if (main) main.classList.remove("hidden");
}

if(speedSlider){

speedSlider.addEventListener("input",()=>{

const speed=parseFloat(speedSlider.value)

videoPlayer.playbackRate=speed
player.playbackRate=speed

speedValue.innerText=speed.toFixed(2)+"x"

document.querySelectorAll(".speed-pill").forEach(pill => {
  const val = parseFloat(pill.innerText);
  pill.classList.toggle("active", Math.abs(val - speed) < 0.05);
});

})

}

const slider = document.getElementById("speedSlider");

function updateSliderFill(){
  const percent = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty("--value", percent + "%");
}

slider.addEventListener("input", updateSliderFill);

// direkt beim Start
updateSliderFill();

////////////////////////////////////////////////////////////
// PiP
////////////////////////////////////////////////////////////

async function togglePiP(){

videoMenu.classList.remove("show")

try{

if(document.pictureInPictureElement){

await document.exitPictureInPicture()

}else{

await videoPlayer.requestPictureInPicture()

}

}catch(err){

console.log("PiP nicht verfügbar",err)

}

}

////////////////////////////////////////////////////////////
// CONTROLS VISIBILITY (MIT ABSOLUTER GEWALT)
////////////////////////////////////////////////////////////

function updateVideoControls() {
    // Prüfen, welche Tabs gerade sichtbar sind
    const videoTabVisible = !document.getElementById("videoTab").classList.contains("hidden");
    const musicTabVisible = !document.getElementById("musicTab").classList.contains("hidden");
    
    const mpBtn = document.getElementById("miniPlaylistBtn");

    // 1. LOGIK FÜR DEN PLAYLIST-KNOPF
    if (videoTabVisible || musicTabVisible) {
        if (mpBtn) {
            mpBtn.classList.remove("hidden");
            mpBtn.style.display = "";
        }
    } else {
        if (mpBtn) {
            mpBtn.classList.add("hidden");
            mpBtn.style.display = "none";
        }
        if (typeof miniPlaylistOpen !== "undefined" && miniPlaylistOpen) {
            toggleMiniPlaylist(); 
        }
    }

    // 2. LOGIK FÜR DIE VIDEO-SPEZIFISCHEN KNÖPFE & GRUPPEN
    const stepBack = document.getElementById("stepBackBtn");
    const stepFwd = document.getElementById("stepForwardBtn");
    const snap = document.getElementById("snapshotBtn");
    const tracksBtn = document.getElementById("tracksQuickBtn");
    const videoToolsGroup = document.getElementById("videoToolsGroup");

    // Effekt- & Optionen-Menü (Equalizer, Speed, Sleep-Timer, Hilfe) bleibt für Musik & Video nutzbar
    if (menuBtn) {
        menuBtn.classList.remove("hidden");
        menuBtn.style.display = "";
    }

    if (videoTabVisible) {
        if (videoToolsGroup) { videoToolsGroup.classList.remove("hidden"); videoToolsGroup.style.display = ""; }
        if (fullscreenBtn) { fullscreenBtn.classList.remove("hidden"); fullscreenBtn.style.display = ""; }
        if (ambientBtn) { ambientBtn.classList.remove("hidden"); ambientBtn.style.display = ""; }
        if (stepBack) { stepBack.classList.remove("hidden"); stepBack.style.display = ""; }
        if (stepFwd) { stepFwd.classList.remove("hidden"); stepFwd.style.display = ""; }
        if (snap) { snap.classList.remove("hidden"); snap.style.display = ""; }
        if (tracksBtn) { tracksBtn.classList.remove("hidden"); tracksBtn.style.display = ""; }
    } else {
        if (videoToolsGroup) { videoToolsGroup.classList.add("hidden"); videoToolsGroup.style.display = "none"; }
        if (fullscreenBtn) { fullscreenBtn.classList.add("hidden"); fullscreenBtn.style.display = "none"; }
        if (ambientBtn) { ambientBtn.classList.add("hidden"); ambientBtn.style.display = "none"; }
        if (stepBack) { stepBack.classList.add("hidden"); stepBack.style.display = "none"; }
        if (stepFwd) { stepFwd.classList.add("hidden"); stepFwd.style.display = "none"; }
        if (snap) { snap.classList.add("hidden"); snap.style.display = "none"; }
        if (tracksBtn) { tracksBtn.classList.add("hidden"); tracksBtn.style.display = "none"; }
    }
}

////////////////////////////////////////////////////////////
// TRANSPORT BUTTONS (VORHERIGER & NÄCHSTER TRACK)
////////////////////////////////////////////////////////////

const prevBtn = document.getElementById("prevBtn");
if (prevBtn) {
  prevBtn.onclick = () => {
    const activePlayer = activeType === "video" ? videoPlayer : player;
    if (activePlayer && activePlayer.currentTime > 3) {
      activePlayer.currentTime = 0;
      return;
    }
    if (typeof handleMediaPrevious === "function") {
      handleMediaPrevious();
      if (playBtn) playBtn.innerText = "❚❚";
    }
  };
}

const nextBtn = document.getElementById("nextBtn");

if (nextBtn) {
  nextBtn.onclick = () => {
    const activeList = (currentPlaybackList && currentPlaybackList.length > 0)
      ? currentPlaybackList
      : (activeType === "video" ? videoListData : musicList);
    if (!activeList || activeList.length === 0) return;

    handleMediaEnded();
    if (playBtn) playBtn.innerText = "❚❚";
  };
}



////////////////////////////////////////////////////////////
// VISUALIZER
////////////////////////////////////////////////////////////

const audioCtx = new AudioContext()

const musicAnalyser = audioCtx.createAnalyser()
const videoAnalyser = audioCtx.createAnalyser()

// Create Equalizer Filters for Music and Video (5-Band)
const eqBands = [60, 230, 910, 4000, 14000];

const musicFilters = eqBands.map(freq => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = freq <= 60 ? 'lowshelf' : (freq >= 14000 ? 'highshelf' : 'peaking');
    filter.frequency.value = freq;
    filter.gain.value = 0; // Default flat
    return filter;
});

const videoFilters = eqBands.map(freq => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = freq <= 60 ? 'lowshelf' : (freq >= 14000 ? 'highshelf' : 'peaking');
    filter.frequency.value = freq;
    filter.gain.value = 0; // Default flat
    return filter;
});

const musicSource = audioCtx.createMediaElementSource(player)
const videoSource = audioCtx.createMediaElementSource(videoPlayer)
const videoAltAudioSource = (videoAltAudio && typeof audioCtx.createMediaElementSource === "function")
    ? audioCtx.createMediaElementSource(videoAltAudio)
    : null;

// --- MISCHPULT AUDIO NODES SETUP ---
// 1. Preamp Nodes
const musicPreamp = audioCtx.createGain();
const videoPreamp = audioCtx.createGain();
musicPreamp.gain.value = 1.0; // 0 dB
videoPreamp.gain.value = 1.0;

// 2. Panner Nodes (Balance)
const musicPanner = audioCtx.createStereoPanner();
const videoPanner = audioCtx.createStereoPanner();
musicPanner.pan.value = 0; // Center
videoPanner.pan.value = 0;

// 3. Delay & Feedback Loop Nodes (Echo)
const musicDelay = audioCtx.createDelay(1.0);
const musicDelayFeedback = audioCtx.createGain();
const musicDelayWet = audioCtx.createGain();
musicDelay.delayTime.value = 0.3; // 300 ms
musicDelayFeedback.gain.value = 0.3; // 30% feedback
musicDelayWet.gain.value = 0.0; // Dry (0% Wet)

musicDelay.connect(musicDelayFeedback);
musicDelayFeedback.connect(musicDelay);

const videoDelay = audioCtx.createDelay(1.0);
const videoDelayFeedback = audioCtx.createGain();
const videoDelayWet = audioCtx.createGain();
videoDelay.delayTime.value = 0.3;
videoDelayFeedback.gain.value = 0.3;
videoDelayWet.gain.value = 0.0;

videoDelay.connect(videoDelayFeedback);
videoDelayFeedback.connect(videoDelay);

// --- CONNECT MUSIC CHAIN ---
// Source -> EQ -> Panner -> Preamp -> Analyser -> Destination
let currentMusicNode = musicSource;
musicFilters.forEach(filter => {
    currentMusicNode.connect(filter);
    currentMusicNode = filter;
});
currentMusicNode.connect(musicPanner);
musicPanner.connect(musicPreamp);

// Main channel route
musicPreamp.connect(musicAnalyser);

// Parallel Echo/Delay route
musicPreamp.connect(musicDelay);
musicDelay.connect(musicDelayWet);
musicDelayWet.connect(musicAnalyser);

musicAnalyser.connect(audioCtx.destination);

// --- CONNECT VIDEO CHAIN ---
// Source -> EQ -> Panner -> Preamp -> AudioSyncDelay -> Analyser -> Destination
const videoAudioSyncDelay = audioCtx.createDelay(5.0);
videoAudioSyncDelay.delayTime.value = 0.0;

let currentVideoNode = videoSource;
videoFilters.forEach(filter => {
    currentVideoNode.connect(filter);
    currentVideoNode = filter;
});
if (videoAltAudioSource && videoFilters.length > 0) {
    videoAltAudioSource.connect(videoFilters[0]);
}
currentVideoNode.connect(videoPanner);
videoPanner.connect(videoPreamp);

// Main channel route with live Audio Delay Sync
videoPreamp.connect(videoAudioSyncDelay);
videoAudioSyncDelay.connect(videoAnalyser);

// Parallel Echo/Delay route
videoAudioSyncDelay.connect(videoDelay);
videoDelay.connect(videoDelayWet);
videoDelayWet.connect(videoAnalyser);

videoAnalyser.connect(audioCtx.destination);

musicAnalyser.fftSize = 128
videoAnalyser.fftSize = 128

function ensureAudioContext(){
  if(audioCtx.state === "suspended"){
    audioCtx.resume()
  }
}

function getActiveAnalyser(){
  return activeType === "video" ? videoAnalyser : musicAnalyser
}

function drawMixerVUMeter() {
    const vuCanvas = document.getElementById("mixerVUMeter");
    if (!vuCanvas) return;
    
    const vuCtx = vuCanvas.getContext("2d");
    const analyser = getActiveAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    
    let sumL = 0;
    let sumR = 0;
    
    const half = Math.floor(data.length / 2);
    for (let i = 0; i < half; i++) sumL += data[i];
    const avgL = sumL / half;
    
    for (let i = half; i < data.length; i++) sumR += data[i];
    const avgR = sumR / (data.length - half);
    
    const activePlayer = activeType === "video" ? videoPlayer : player;
    const isPlaying = !activePlayer.paused && !activePlayer.ended;
    
    const valL = isPlaying ? Math.min(1.0, (avgL / 160) * (0.95 + Math.random() * 0.1)) : 0;
    const valR = isPlaying ? Math.min(1.0, (avgR / 160) * (0.95 + Math.random() * 0.1)) : 0;
    
    vuCtx.clearRect(0, 0, vuCanvas.width, vuCanvas.height);
    
    // Draw background tracks
    vuCtx.fillStyle = "rgba(255, 255, 255, 0.05)";
    vuCtx.fillRect(10, 3, vuCanvas.width - 20, 5);
    vuCtx.fillRect(10, 12, vuCanvas.width - 20, 5);
    
    const maxW = vuCanvas.width - 20;
    const wL = valL * maxW;
    const wR = valR * maxW;
    
    const grad = vuCtx.createLinearGradient(10, 0, vuCanvas.width - 10, 0);
    grad.addColorStop(0, "#1db954");
    grad.addColorStop(0.65, "#fbbf24");
    grad.addColorStop(0.85, "#ff4d4d");
    
    vuCtx.fillStyle = grad;
    if (wL > 0) vuCtx.fillRect(10, 3, wL, 5);
    if (wR > 0) vuCtx.fillRect(10, 12, wR, 5);
    
    vuCtx.fillStyle = "rgba(0, 0, 0, 0.3)";
    for (let x = 20; x < vuCanvas.width - 10; x += 20) {
        vuCtx.fillRect(x, 0, 1.5, vuCanvas.height);
    }
}

function drawVisualizer() {
    requestAnimationFrame(drawVisualizer);
    
    // Call our mixing board VU meter draw
    drawMixerVUMeter();

    const analyser = getActiveAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const rootStyles = getComputedStyle(document.documentElement);
    const visColor = rootStyles.getPropertyValue('--visualizer-color').trim() || "#1db954";

    const barWidth = 3;
    const gap = 1;

    for (let i = 0; i < data.length; i++) {
        const x = i * (barWidth + gap);
        if (x > canvas.width) break;

        const height = Math.pow(data[i] / 255, 2) * canvas.height;
        ctx.fillStyle = visColor;
        ctx.fillRect(x, canvas.height - height, barWidth, height);
    }
}

drawVisualizer()

if(record){
  record.style.cursor = "pointer"

  record.addEventListener("click", ()=>{
    visualizerVisible = !visualizerVisible

    if(visualizerVisible){
      visualizer.classList.remove("hidden")
    }else{
      visualizer.classList.add("hidden")
    }
  })
}

////////////////////////////////////////////////////////////
// VIDEO AMBIENT LIGHT
////////////////////////////////////////////////////////////

const ambientCanvas = document.getElementById("videoAmbient")
const ambientCtx = ambientCanvas ? ambientCanvas.getContext("2d") : null
let lastAmbientDrawMs = 0;

function drawAmbient(){
  requestAnimationFrame(drawAmbient)
  if(!ambientEnabled) return
  if(!ambientCtx) return
  if(activeType !== "video") return
  if(videoPlayer.paused || videoPlayer.ended) return // CPU-Schonung, wenn das Video pausiert ist
  if(videoPlayer.readyState < 2) return

  const now = performance.now();
  if (now - lastAmbientDrawMs < 66) return;
  lastAmbientDrawMs = now;

  // Feste niedrige Auflösung für extreme Performance!
  // Da CSS einen Weichzeichner (blur) anwendet, reichen 64x64px völlig aus.
  if (ambientCanvas.width !== 64 || ambientCanvas.height !== 64) {
      ambientCanvas.width = 64;
      ambientCanvas.height = 64;
  }

  ambientCtx.drawImage(videoPlayer, 0, 0, 64, 64)
}

drawAmbient()

////////////////////////////////////////////////////////////
// ============================================================
// PHASE 2: ADVANCED SEARCH FILTER POPOVER, SORTING & SHORTCUTS
// ============================================================

window.toggleShortcutsHelpModal = function() {
  const modal = document.getElementById("shortcutsHelpModal");
  if (!modal) return;
  modal.classList.toggle("hidden");
};

// Modal-Backdrop Klick schließt das Shortcut-Fenster
document.getElementById("shortcutsHelpModal")?.addEventListener("click", (e) => {
  if (e.target.id === "shortcutsHelpModal") {
    window.toggleShortcutsHelpModal();
  }
});

window.activeMediaFilterChip = 'all';
window.activeDurationFilter = 'all';
window.activeDateAddedFilter = 'all';
window.activeTagFilter = 'all';
window.activeSortOrder = 'default';

const search = document.getElementById("search");

// --- CACHES FÜR DATEI-EIGENSCHAFTEN (DAUER, HINZUGEFÜGT AM, ZULETZT GESEHEN) ---
const mediaFileStatsCache = new Map();
let mediaDurationCache = {};
try {
  mediaDurationCache = JSON.parse(localStorage.getItem("mediaDurationCache") || "{}");
} catch (e) {
  mediaDurationCache = {};
}

let lastPlayedTimestamps = {};
try {
  lastPlayedTimestamps = JSON.parse(localStorage.getItem("lastPlayedTimestamps") || "{}");
} catch (e) {
  lastPlayedTimestamps = {};
}

let durationSaveTimer = null;
function saveDurationCacheDebounced() {
  clearTimeout(durationSaveTimer);
  durationSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem("mediaDurationCache", JSON.stringify(mediaDurationCache));
    } catch (e) {}
  }, 600);
}

window.recordMediaLastPlayed = function(rawPath) {
  if (!rawPath || rawPath.startsWith("http://localhost")) return;
  const realPath = fromMediaKey(rawPath);
  const key = toMediaKey(realPath);
  if (!key) return;
  lastPlayedTimestamps[key] = Date.now();
  try {
    localStorage.setItem("lastPlayedTimestamps", JSON.stringify(lastPlayedTimestamps));
  } catch (e) {}
};

function getMediaLastPlayedMs(filePath) {
  if (!filePath) return 0;
  const realPath = fromMediaKey(filePath);
  const key = toMediaKey(realPath);
  if (lastPlayedTimestamps[key]) return lastPlayedTimestamps[key];
  // Fallback: check history array
  if (Array.isArray(history)) {
    const idx = history.findIndex(h => {
      const hp = typeof h === 'string' ? h : h?.path;
      return hp && (hp === realPath || toMediaKey(hp) === key);
    });
    if (idx !== -1) {
      const entry = history[idx];
      if (entry && entry.timestamp) return entry.timestamp;
      return Date.now() - (idx * 60000);
    }
  }
  return 0;
}

function getMediaFileAddedMs(filePath) {
  if (!filePath) return 0;
  const realPath = fromMediaKey(filePath);
  if (mediaFileStatsCache.has(realPath)) {
    return mediaFileStatsCache.get(realPath);
  }
  try {
    if (fs.existsSync(realPath)) {
      const stat = fs.statSync(realPath);
      const addedMs = Math.max(stat.birthtimeMs || 0, stat.mtimeMs || 0);
      mediaFileStatsCache.set(realPath, addedMs);
      return addedMs;
    }
  } catch (e) {}
  mediaFileStatsCache.set(realPath, 0);
  return 0;
}

const pendingDurationProbes = new Set();
const videoProbeQueue = [];
let isVideoProbing = false;

function processVideoProbeQueue() {
  if (isVideoProbing || videoProbeQueue.length === 0) return;
  isVideoProbing = true;
  const { realPath, key } = videoProbeQueue.shift();

  const tempVid = document.createElement("video");
  tempVid.preload = "metadata";
  tempVid.muted = true;

  const cleanup = () => {
    tempVid.removeAttribute("src");
    tempVid.load();
    pendingDurationProbes.delete(key);
    isVideoProbing = false;
    setTimeout(processVideoProbeQueue, 30);
  };

  const timeoutId = setTimeout(() => {
    cleanup();
  }, 4000);

  tempVid.onloadedmetadata = () => {
    clearTimeout(timeoutId);
    if (tempVid.duration && isFinite(tempVid.duration)) {
      mediaDurationCache[key] = Math.round(tempVid.duration);
      saveDurationCacheDebounced();
      if (window.activeDurationFilter !== "all") {
        window.performEnhancedSearch();
      }
    }
    cleanup();
  };

  tempVid.onerror = () => {
    clearTimeout(timeoutId);
    cleanup();
  };

  tempVid.src = key;
}

function probeMediaDurationAsync(filePath) {
  if (!filePath) return;
  const realPath = fromMediaKey(filePath);
  const key = toMediaKey(realPath);
  if (!key || mediaDurationCache[key] !== undefined || pendingDurationProbes.has(key)) return;

  pendingDurationProbes.add(key);
  const isAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i.test(realPath);

  if (isAudio && typeof mm !== "undefined" && typeof mm.parseFile === "function") {
    mm.parseFile(realPath, { duration: true, skipCovers: true }).then(meta => {
      pendingDurationProbes.delete(key);
      if (meta && meta.format && meta.format.duration) {
        mediaDurationCache[key] = Math.round(meta.format.duration);
        saveDurationCacheDebounced();
        if (window.activeDurationFilter !== "all") {
          window.performEnhancedSearch();
        }
      }
    }).catch(() => {
      pendingDurationProbes.delete(key);
    });
  } else {
    if (/\.(mkv|ts|m2ts|avi|flv|wmv)$/i.test(realPath)) {
      pendingDurationProbes.delete(key);
      return;
    }
    videoProbeQueue.push({ realPath, key });
    processVideoProbeQueue();
  }
}

function getCardMediaPath(item) {
  return item.dataset.filePath ||
         item.dataset.src ||
         item.querySelector?.(".likeIcon")?.dataset?.src ||
         item.querySelector?.(".mediaBadge")?.getAttribute("title") ||
         null;
}

function getCardMediaDurationSec(item, filePath) {
  if (!filePath) return null;
  const key = toMediaKey(fromMediaKey(filePath));
  if (mediaDurationCache[key] !== undefined) {
    return mediaDurationCache[key];
  }
  const vidThumb = item.querySelector?.("video.mediaThumb");
  if (vidThumb && vidThumb.duration && isFinite(vidThumb.duration)) {
    mediaDurationCache[key] = Math.round(vidThumb.duration);
    saveDurationCacheDebounced();
    return mediaDurationCache[key];
  }
  probeMediaDurationAsync(filePath);
  return null;
}

// Store duration when active player loads metadata
player?.addEventListener("loadedmetadata", () => {
  if (player.src && player.duration && isFinite(player.duration)) {
    const key = toMediaKey(fromMediaKey(player.src));
    mediaDurationCache[key] = Math.round(player.duration);
    saveDurationCacheDebounced();
  }
});

videoPlayer?.addEventListener("loadedmetadata", () => {
  if (videoPlayer.src && videoPlayer.duration && isFinite(videoPlayer.duration) && !videoPlayer.src.startsWith("http://localhost")) {
    const key = toMediaKey(fromMediaKey(videoPlayer.src));
    mediaDurationCache[key] = Math.round(videoPlayer.duration);
    saveDurationCacheDebounced();
  }
});

// --- FILTER POPOVER MENU CONTROLS ---
window.toggleSearchFilterMenu = function(e) {
  if (e && typeof e.stopPropagation === "function") e.stopPropagation();
  const menu = document.getElementById("searchFilterMenu");
  const btn = document.getElementById("searchFilterBtn");
  if (!menu) return;

  const willOpen = menu.classList.contains("hidden");
  if (willOpen) {
    window.renderDynamicTagChips();
    menu.classList.remove("hidden");
    btn?.classList.add("active");
  } else {
    menu.classList.add("hidden");
    btn?.classList.remove("active");
  }
};

document.addEventListener("click", (e) => {
  const menu = document.getElementById("searchFilterMenu");
  const btn = document.getElementById("searchFilterBtn");
  if (!menu || menu.classList.contains("hidden")) return;
  if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
    menu.classList.add("hidden");
    btn?.classList.remove("active");
  }
});

function updateSearchFilterBadge() {
  let count = 0;
  if (window.activeSortOrder && window.activeSortOrder !== "default") count++;
  if (window.activeMediaFilterChip && window.activeMediaFilterChip !== "all") count++;
  if (window.activeDurationFilter && window.activeDurationFilter !== "all") count++;
  if (window.activeDateAddedFilter && window.activeDateAddedFilter !== "all") count++;
  if (window.activeTagFilter && window.activeTagFilter !== "all") count++;

  const badge = document.getElementById("searchFilterBadge");
  const btn = document.getElementById("searchFilterBtn");
  if (badge) {
    badge.innerText = String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  if (btn) {
    btn.classList.toggle("has-active-filters", count > 0);
  }
}

window.setMediaSortOption = function(sortVal) {
  window.activeSortOrder = sortVal || 'default';
  document.querySelectorAll("#searchFilterMenu [data-sort]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.sort === window.activeSortOrder);
  });
  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.onMediaSortChange = window.setMediaSortOption;

window.setMediaFilterChip = function(filter) {
  window.activeMediaFilterChip = filter || 'all';

  document.querySelectorAll("#searchFilterMenu [data-filter], .filter-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.filter === window.activeMediaFilterChip);
  });

  // Wenn auf Musik, Video oder Liked geklickt wird, Tab passend wechseln
  if (filter === "music") {
    const musicTab = document.getElementById("musicTab");
    if (musicTab && musicTab.classList.contains("hidden")) showTab("music");
  } else if (filter === "video") {
    const videoTab = document.getElementById("videoTab");
    if (videoTab && videoTab.classList.contains("hidden")) showTab("videos");
  } else if (filter === "liked") {
    const likedTab = document.getElementById("likedTab");
    if (likedTab && likedTab.classList.contains("hidden")) showTab("liked");
  }

  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.setMediaDurationFilter = function(dur) {
  window.activeDurationFilter = dur || 'all';
  document.querySelectorAll("#searchFilterMenu [data-duration]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.duration === window.activeDurationFilter);
  });
  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.setMediaDateAddedFilter = function(dateRange) {
  window.activeDateAddedFilter = dateRange || 'all';
  document.querySelectorAll("#searchFilterMenu [data-date]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.date === window.activeDateAddedFilter);
  });
  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.setMediaTagFilter = function(tag) {
  if (tag !== 'all' && window.activeTagFilter === tag) {
    window.activeTagFilter = 'all';
  } else {
    window.activeTagFilter = tag || 'all';
  }
  document.querySelectorAll("#filterMenuTagsList [data-tag]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tag === window.activeTagFilter);
  });
  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.resetAllMediaFilters = function() {
  window.activeSortOrder = 'default';
  window.activeMediaFilterChip = 'all';
  window.activeDurationFilter = 'all';
  window.activeDateAddedFilter = 'all';
  window.activeTagFilter = 'all';

  document.querySelectorAll("#searchFilterMenu [data-sort]").forEach(b => b.classList.toggle("active", b.dataset.sort === "default"));
  document.querySelectorAll("#searchFilterMenu [data-filter]").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
  document.querySelectorAll("#searchFilterMenu [data-duration]").forEach(b => b.classList.toggle("active", b.dataset.duration === "all"));
  document.querySelectorAll("#searchFilterMenu [data-date]").forEach(b => b.classList.toggle("active", b.dataset.date === "all"));
  document.querySelectorAll("#filterMenuTagsList [data-tag]").forEach(b => b.classList.toggle("active", b.dataset.tag === "all"));

  updateSearchFilterBadge();
  window.performEnhancedSearch();
};

window.renderDynamicTagChips = function() {
  const container = document.getElementById("filterMenuTagsList") || document.getElementById("dynamicTagChips");
  if (!container) return;

  try {
    const mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");
    const uniqueTags = new Set(["Chill", "Workout", "Fokus", "Party", "Favoriten"]);
    Object.values(mediaTags).forEach(tag => {
      if (tag && tag.trim() !== "" && tag !== "Musik" && tag !== "Video") {
        uniqueTags.add(tag.trim());
      }
    });

    container.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.className = `sfm-pill ${window.activeTagFilter === 'all' ? 'active' : ''}`;
    allBtn.dataset.tag = "all";
    allBtn.innerText = "Alle Tags";
    allBtn.onclick = () => window.setMediaTagFilter("all");
    container.appendChild(allBtn);

    uniqueTags.forEach(tag => {
      const chip = document.createElement("button");
      chip.className = `sfm-pill ${window.activeTagFilter === tag ? 'active' : ''}`;
      chip.dataset.tag = tag;
      chip.innerText = `🏷️ ${tag}`;
      chip.onclick = () => window.setMediaTagFilter(tag);
      container.appendChild(chip);
    });
  } catch (e) {
    console.error("Fehler beim Laden der Tag-Chips:", e);
  }
};

window.performEnhancedSearch = function() {
  const term = (search?.value || "").toLowerCase().trim();
  const filter = window.activeMediaFilterChip || 'all';
  const durFilter = window.activeDurationFilter || 'all';
  const dateFilter = window.activeDateAddedFilter || 'all';
  const tagFilter = window.activeTagFilter || 'all';
  const sortOrder = window.activeSortOrder || 'default';

  const activeTab = document.querySelector(".tab:not(.hidden)");
  if (!activeTab) return;

  const cards = Array.from(activeTab.querySelectorAll(".mediaCard, .pm-card, .logo-card, .font-card, .videoItem"));
  const hasAnyPropertyFilter = (filter !== 'all' || durFilter !== 'all' || dateFilter !== 'all' || tagFilter !== 'all');
  const now = Date.now();

  cards.forEach((item, index) => {
    if (item.dataset.origIdx === undefined) {
      item.dataset.origIdx = String(index);
    }

    if (item.classList.contains("folder-card")) {
      const hideFolder = term !== "" || hasAnyPropertyFilter;
      item.style.display = hideFolder ? "none" : "";
      item.classList.toggle("fade-out", hideFolder);
      return;
    }

    const titleEl = item.querySelector(".mediaTitle, .logo-name, .font-name, .videoTitle");
    const textToSearch = titleEl ? titleEl.innerText : item.innerText;
    const textMatches = term === "" || textToSearch.toLowerCase().includes(term);

    const filePath = getCardMediaPath(item);

    // 1. Medientyp / Status Filter
    let typeMatches = true;
    if (filter === "music") {
      typeMatches = item.classList.contains("music") || item.dataset.mediaType === "music";
    } else if (filter === "video") {
      typeMatches = item.classList.contains("video") || item.dataset.mediaType === "video";
    } else if (filter === "liked") {
      typeMatches = Boolean(filePath && typeof isLiked === "function" && isLiked(filePath));
    } else if (filter.startsWith("tag:")) {
      const targetTag = filter.slice(4).toLowerCase();
      const badge = item.querySelector(".mediaBadge");
      typeMatches = Boolean(badge && badge.innerText.trim().toLowerCase() === targetTag);
    }

    // 2. Tag Filter
    let tagMatches = true;
    if (tagFilter !== "all") {
      const badge = item.querySelector(".mediaBadge");
      const badgeText = badge ? badge.innerText.trim().toLowerCase() : "";
      tagMatches = badgeText === tagFilter.toLowerCase();
    }

    // 3. Länge / Dauer Filter
    let durationMatches = true;
    if (durFilter !== "all") {
      const durSec = getCardMediaDurationSec(item, filePath);
      if (durSec === null) {
        // Noch beim Auslesen im Hintergrund -> vorerst sichtbar lassen, wird automatisch aktualisiert
        durationMatches = true;
      } else if (durFilter === "short") {
        durationMatches = durSec < 180;
      } else if (durFilter === "medium") {
        durationMatches = durSec >= 180 && durSec <= 900;
      } else if (durFilter === "long") {
        durationMatches = durSec > 900;
      }
    }

    // 4. Hinzugefügt am Filter
    let dateMatches = true;
    if (dateFilter !== "all") {
      const addedMs = getMediaFileAddedMs(filePath);
      if (!addedMs) {
        dateMatches = false;
      } else {
        const diffMs = now - addedMs;
        if (dateFilter === "today") {
          const addedDate = new Date(addedMs);
          const todayDate = new Date(now);
          const sameDay = addedDate.getFullYear() === todayDate.getFullYear() &&
                          addedDate.getMonth() === todayDate.getMonth() &&
                          addedDate.getDate() === todayDate.getDate();
          dateMatches = sameDay || diffMs <= 24 * 3600 * 1000;
        } else if (dateFilter === "week") {
          dateMatches = diffMs <= 7 * 24 * 3600 * 1000;
        } else if (dateFilter === "month") {
          dateMatches = diffMs <= 30 * 24 * 3600 * 1000;
        }
      }
    }

    if (textMatches && typeMatches && tagMatches && durationMatches && dateMatches) {
      item.style.display = "";
      item.classList.remove("fade-out");
    } else {
      item.style.display = "none";
      item.classList.add("fade-out");
    }
  });

  // Sortierung anwenden (nur auf die Haupt-Medienkarten der aktiven Grid-Ansicht)
  const grid = activeTab.querySelector("#musicGrid, #videoList, #likedGrid, #historyGrid, #playlistDetailGrid");
  if (grid) {
    const directCards = Array.from(grid.children).filter(c => c.classList.contains("mediaCard") && !c.classList.contains("folder-card"));
    if (directCards.length > 1) {
      // Merke den Ankerpunkt vor dem ersten mediaCard-Element (z.B. die "Bibliothek"/"Mediathek" Überschrift)
      const firstCard = directCards[0];
      const parent = firstCard.parentNode;
      const extHeader = Array.from(grid.querySelectorAll("h3")).find(h => h.innerText.includes("Lokal abrufen"));

      directCards.sort((a, b) => {
        if (sortOrder === "default") {
          return (parseInt(a.dataset.origIdx || "0", 10)) - (parseInt(b.dataset.origIdx || "0", 10));
        }
        const titleA = (a.querySelector(".mediaTitle")?.innerText || "").toLowerCase();
        const titleB = (b.querySelector(".mediaTitle")?.innerText || "").toLowerCase();
        if (sortOrder === "name-asc") {
          return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortOrder === "name-desc") {
          return titleB.localeCompare(titleA, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortOrder === "date-added") {
          const addedA = getMediaFileAddedMs(getCardMediaPath(a));
          const addedB = getMediaFileAddedMs(getCardMediaPath(b));
          return addedB - addedA; // Neueste zuerst
        }
        if (sortOrder === "recently-watched") {
          const playedA = getMediaLastPlayedMs(getCardMediaPath(a));
          const playedB = getMediaLastPlayedMs(getCardMediaPath(b));
          if (playedB !== playedA) return playedB - playedA;
          return titleA.localeCompare(titleB);
        }
        return 0;
      });

      directCards.forEach(c => {
        if (extHeader && extHeader.parentNode === parent) {
          parent.insertBefore(c, extHeader);
        } else {
          parent.appendChild(c);
        }
      });
    }
  }
};

search?.addEventListener("input", () => {
  window.performEnhancedSearch();
});

////////////////////////////////////////////////////////////
// HISTORY
/////////////////////////////////////////////////////////////

function saveToHistory(video) {
  if (typeof window.recordMediaLastPlayed === "function") {
    window.recordMediaLastPlayed(video);
  }

  const entry = {
    path: video,
    time: videoPlayer.currentTime,
    date: new Date().toLocaleDateString(),
    timestamp: Date.now()
  };

  history = history.filter(v => v.path !== video);

  history.unshift(entry);

  if (history.length > 24) {
    history.pop();
  }

  localStorage.setItem("history", JSON.stringify(history));

  renderHistory();
}

const historyGrid = document.getElementById("historyGrid")

////////////////////////////////////////////////////////////
// HISTORY (GEFIXT - Versteht jetzt file:// Pfade)
/////////////////////////////////////////////////////////////
function renderHistory() {
    const historyGrid = document.getElementById("historyGrid");
    if (!historyGrid) return;
    
    historyGrid.innerHTML = "";

    // 1. Pfad-Reparatur: Filtert nur ungültige lokale Dateien, behält Netzwerk-Streams!
    const validHistory = [];
    history.forEach(entry => {
        const rawPath = typeof entry === 'string' ? entry : entry?.path;
        if (!rawPath) return;
        
        const realPath = fromMediaKey(rawPath); 
        const isLocal = rawPath.startsWith("file://") || !rawPath.match(/^https?:\/\//i);
        
        if (!isLocal || fs.existsSync(realPath)) {
            validHistory.push(typeof entry === 'string' ? { path: rawPath, time: 0, date: "Unbekannt" } : entry);
        }
    });

    if (validHistory.length !== history.length) {
    history = validHistory;
        localStorage.setItem("history", JSON.stringify(history));
    }

    if (history.length === 0) {
        historyGrid.innerHTML = "<div style='color:#888; grid-column: 1/-1; padding: 20px;'>Noch nichts geschaut.</div>";
        return;
    }

    history.forEach(entry => {
        const rawPath = entry.path;
        const realPath = fromMediaKey(rawPath);
        const isVideo = realPath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
        let name = path.basename(realPath).replace(/\.[^/.]+$/, "");

        const card = document.createElement("div");
        card.className = "mediaCard video";
        card.dataset.filePath = realPath;
        card.dataset.mediaType = isVideo ? "video" : "music";
        card.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, realPath, isVideo ? "video" : "music");
        };
        
        const key = toMediaKey(realPath);
        card.innerHTML = `
          <div class="mediaBadge">Zuletzt</div>
          <div class="likeIcon" data-src="${realPath}">${isLiked(realPath) ? "❤" : "🤍"}</div>
          ${getMediaThumbHtml(key, isVideo ? 'video' : 'music')}
          <div class="mediaTitle" title="${name}">${name}</div>
          <div class="mediaMeta">${entry.date}</div>
        `;

        setupMediaThumbListeners(card, key, isVideo ? 'video' : 'music');

        card.onclick = () => {
            currentPlaybackList = []; // Reset active playlist
            document.querySelectorAll(".mediaCard").forEach(v => v.classList.remove("active"))
            card.classList.add("active")

            if (player) player.pause();
            record.classList.remove("spin");
            
            if(isVideo) {
                showTab("videos");
                activeType = "video";
                videoPlayer.src = realPath; // Use absolute path directly
                videoPlayer.currentTime = entry.time;
                ensureAudioContext();
                videoPlayer.play();
                
                if (playBtn) playBtn.innerText = "⏸"
                updateLikeButton()
                updateVideoControls()
                updateNowPlaying()
            } else {
                if (videoPlayer) videoPlayer.pause();
                
                showTab("music");
                activeType = "music";
                player.src = realPath; // Use absolute path directly
                player.currentTime = entry.time;
                ensureAudioContext();
                player.play();
                record.classList.add("spin");
                
                if (playBtn) playBtn.innerText = "⏸"
                updateLikeButton()
                updateNowPlaying()
            }
        };
        
        const heart = card.querySelector(".likeIcon");
        if (heart) {
            heart.onclick = (e) => {
                e.stopPropagation();
                toggleLike(realPath);
            };
        }
        
        historyGrid.appendChild(card);
    });
}

function cleanPlaylists() {
  let changed = false;
  for (const type of ["music", "video"]) {
    for (const plName in playlists[type]) {
      const originalList = playlists[type][plName];
      // Behalte nur Dateien, die noch auf dem PC existieren
      const cleanedList = originalList.filter(key => fs.existsSync(fromMediaKey(key)));
      
      if (cleanedList.length !== originalList.length) {
        changed = true;
        if (cleanedList.length === 0) {
          delete playlists[type][plName]; // Löscht Playlist komplett, wenn leer
        } else {
          playlists[type][plName] = cleanedList;
        }
      }
    }
  }
  if (changed) {
    localStorage.setItem("playlists", JSON.stringify(playlists));
  }
}

////////////////////////////////////////////////////////////
// PLAYLISTS RENDERN (NUR EIGENE PLAYLISTS)
////////////////////////////////////////////////////////////

let miniPlaylistOpen = false;

window.changePlaylistCover = function() {
    changePlaylistCoverFromSettings(currentOpenPlaylist.name, currentOpenPlaylist.type);
};

window.changePlaylistCoverFromSettings = function(plName, type) {
    coverChangePlaylist = { plName, type };
    editorTargetContext = 'cover';
    
    // Update modal text for Cover Erstellen
    const title = document.getElementById("assetModalTitle");
    const sub = document.getElementById("assetModalSubtitle");
    const imgTitle = document.getElementById("assetOptionImageTitle");
    const imgDesc = document.getElementById("assetOptionImageDesc");
    const drawTitle = document.getElementById("assetOptionDrawTitle");
    const drawDesc = document.getElementById("assetOptionDrawDesc");
    
    if (title) title.innerText = "Cover Erstellen";
    if (sub) sub.innerText = "Wähle aus, wie du dein neues Playlist-Cover erstellen möchtest:";
    if (imgTitle) imgTitle.innerText = "Cover aus Bild erstellen";
    if (imgDesc) imgDesc.innerText = "Wähle ein vorhandenes Bild von deiner Festplatte aus und bearbeite es.";
    if (drawTitle) drawTitle.innerText = "Cover Selbst erstellen";
    if (drawDesc) drawDesc.innerText = "Konfiguriere eine leere Leinwand und zeichne dein eigenes Playlist-Cover.";
    
    const modal = document.getElementById("logoCreationOptionsModal");
    if (modal) modal.classList.remove("hidden");
};

function renderPlaylists() {
    if (typeof cleanPlaylists === "function") cleanPlaylists();
    
    const grid = document.getElementById("playlistsGrid");
    const emptyMsg = document.getElementById("playlistsEmpty");
    if (!grid) return;
    
    grid.innerHTML = "";
    
    const typePlaylists = playlists[playlistView] || {};
    const playlistNames = Object.keys(typePlaylists);
    
    if (playlistNames.length === 0) {
        if (emptyMsg) emptyMsg.style.display = "flex";
        return;
    } else {
        if (emptyMsg) emptyMsg.style.display = "none";
    }
    
    const covers = JSON.parse(localStorage.getItem("playlistCovers") || "{}");
    
    playlistNames.forEach(plName => {
        const list = typePlaylists[plName] || [];
        const count = list.length;
        const coverPath = covers[`${playlistView}_${plName}`];
        
        let coverSrc = "";
        if (coverPath && fs.existsSync(coverPath)) {
            coverSrc = pathToFileURL(coverPath).href;
        }
        
        const card = document.createElement("div");
        card.className = "playlistCard";
        card.innerHTML = `
            <div class="aspect-square">
                ${coverSrc ? `<img class="playlistCoverPreview" src="${coverSrc}?t=${Date.now()}">` : `<div class="playlistCoverPreview" style="display: flex; align-items: center; justify-content: center; font-size: 40px; background: rgba(0,0,0,0.2); width:100%; height:100%;">${playlistView === 'video' ? '🎬' : '🎵'}</div>`}
                <div class="quickPlayOverlay">
                    <button class="quickPlayBtn" title="Playlist abspielen">▶</button>
                </div>
            </div>
            <div class="mediaTitle" title="${plName}">${plName}</div>
            <div class="mediaMeta">${count} Titel</div>
        `;
        
        card.onclick = () => {
            openPlaylistDetail(plName, playlistView);
        };
        
        const playBtn = card.querySelector(".quickPlayBtn");
        if (playBtn) {
            playBtn.onclick = (e) => {
                e.stopPropagation();
                window.playEntirePlaylist(plName, playlistView);
            };
        }
        
        grid.appendChild(card);
    });
}

function openPlaylistDetail(plName, type) {
    currentOpenPlaylist = { name: plName, type: type };
    showTab("playlistDetail");
    
    const titleEl = document.getElementById("playlistDetailTitle");
    if (titleEl) titleEl.innerText = plName;
    
    const grid = document.getElementById("playlistDetailGrid");
    if (!grid) return;
    grid.innerHTML = "";
    
    const list = playlists[type][plName] || [];
    if (list.length === 0) {
        grid.innerHTML = `<div class="text-muted p-4 text-center w-full">Diese Playlist ist leer.</div>`;
        return;
    }
    
    list.forEach((key, index) => {
        const filePath = fromMediaKey(key);
        const baseName = path.basename(filePath).replace(/\.[^/.]+$/, "");
        
        const card = document.createElement("div");
        card.className = "mediaCard video";
        card.style.position = "relative";
        card.dataset.filePath = filePath;
        card.dataset.mediaType = type;
        card.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFileContextMenu(e, filePath, type);
        };

        card.innerHTML = `
            <button class="delete-track-btn" title="Titel entfernen">X</button>
            ${getMediaThumbHtml(key, type)}
            <div class="mediaTitle" title="${baseName}">${baseName}</div>
        `;

        setupMediaThumbListeners(card, key, type);
        
        card.onclick = () => {
            currentPlaybackList = list.map(k => fromMediaKey(k));
            currentIndex = index;
            
            if (type === 'video') {
                if (player) player.pause();
                if (record) record.classList.remove("spin");
                activeType = "video";
                videoPlayer.src = filePath; // Use absolute path directly
                videoPlayer.currentTime = 0;
                ensureAudioContext();
                videoPlayer.play();
                showTab("videos");
                
                const playBtn = document.getElementById("playBtn");
                if (playBtn) playBtn.innerText = "⏸";
                saveToHistory(filePath); // Use absolute path directly
                updateLikeButton();
                updateVideoControls();
                updateNowPlaying();
            } else {
                if (videoPlayer) videoPlayer.pause();
                activeType = "music";
                player.src = filePath; // Use absolute path directly
                player.currentTime = 0;
                ensureAudioContext();
                player.play();
                if (record) record.classList.add("spin");
                showTab("music");
                
                const playBtn = document.getElementById("playBtn");
                if (playBtn) playBtn.innerText = "⏸";
                saveToHistory(filePath); // Use absolute path directly
                updateLikeButton();
                updateNowPlaying();
            }
            if (miniPlaylistOpen) renderMiniPlaylist();
        };
        
        const delBtn = card.querySelector(".delete-track-btn");
        if (delBtn) {
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm("Möchtest du diesen Titel wirklich aus der Playlist entfernen?")) {
                    playlists[type][plName].splice(index, 1);
                    if (playlists[type][plName].length === 0) {
                        delete playlists[type][plName];
                        localStorage.setItem("playlists", JSON.stringify(playlists));
                        showTab("playlists");
                    } else {
                        localStorage.setItem("playlists", JSON.stringify(playlists));
                        openPlaylistDetail(plName, type);
                    }
                    if (miniPlaylistOpen) renderMiniPlaylist();
                }
            };
        }
        grid.appendChild(card);
    });
}

function deleteCurrentPlaylist() {
    if (!currentOpenPlaylist.name || !currentOpenPlaylist.type) return;
    
    if (confirm(`Möchtest du die Playlist "${currentOpenPlaylist.name}" wirklich unwiderruflich löschen?`)) {
        const { name, type } = currentOpenPlaylist;
        if (playlists[type] && playlists[type][name]) {
            delete playlists[type][name];
            
            // Delete custom cover too
            const covers = JSON.parse(localStorage.getItem("playlistCovers") || "{}");
            const coverPath = covers[`${type}_${name}`];
            if (coverPath && fs.existsSync(coverPath)) {
                try { fs.unlinkSync(coverPath); } catch (e) {}
            }
            delete covers[`${type}_${name}`];
            localStorage.setItem("playlistCovers", JSON.stringify(covers));
            
            localStorage.setItem("playlists", JSON.stringify(playlists));
            showTab("playlists");
        }
    }
}

function loadSettingsPlaylists(type) {
    const listContainer = document.getElementById("settingsPlaylistGrid");
    if (!listContainer) return;
    listContainer.innerHTML = "";
    
    const typePlaylists = playlists[type] || {};
    const playlistNames = Object.keys(typePlaylists);
    
    if (playlistNames.length === 0) {
        listContainer.innerHTML = `<div class="text-muted text-xs p-2">Keine Playlists vorhanden.</div>`;
        return;
    }
    
    const covers = JSON.parse(localStorage.getItem("playlistCovers") || "{}");
    
    playlistNames.forEach(plName => {
        const count = (typePlaylists[plName] || []).length;
        const coverPath = covers[`${type}_${plName}`];
        
        let coverSrc = "";
        if (coverPath && fs.existsSync(coverPath)) {
            coverSrc = pathToFileURL(coverPath).href;
        }
        
        const row = document.createElement("div");
        row.style.background = "rgba(0,0,0,0.2)";
        row.style.border = "1px solid rgba(255,255,255,0.05)";
        row.style.borderRadius = "8px";
        row.style.padding = "10px";
        row.style.display = "flex";
        row.style.flexDirection = "column";
        row.style.gap = "10px";
        row.innerHTML = `
            <div style="width: 100%; aspect-ratio: 1; background: rgba(0,0,0,0.4); border-radius: 4px; overflow: hidden; display: flex; align-items: center; justify-content: center;">
                ${coverSrc ? `<img style="width: 100%; height: 100%; object-fit: cover;" src="${coverSrc}?t=${Date.now()}">` : `<span style="font-size: 40px;">${type === 'video' ? '🎬' : '🎵'}</span>`}
            </div>
            <div>
                <span style="display: block; font-size: 14px; font-weight: bold; color: white;">${plName}</span>
                <span style="display: block; font-size: 12px; color: var(--text-muted);">${count} Titel (${type === 'video' ? 'Video' : 'Musik'})</span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: auto;">
                <button class="settings-delete-btn" style="padding: 6px 12px; border-radius: 4px; background: rgba(220,38,38,0.2); color: white; border: none; cursor: pointer; font-size: 12px; transition: 0.2s;" onmouseover="this.style.background='rgba(220,38,38,0.8)'" onmouseout="this.style.background='rgba(220,38,38,0.2)'">Löschen</button>
                <button class="settings-cover-btn" style="padding: 6px 12px; border-radius: 4px; background: rgba(255,255,255,0.1); color: white; border: none; cursor: pointer; font-size: 12px; transition: 0.2s;" onmouseover="this.style.background='var(--accent)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">Cover</button>
            </div>
        `;
        
        row.querySelector(".settings-cover-btn").onclick = () => {
            window.changePlaylistCoverFromSettings(plName, type);
        };
        
        row.querySelector(".settings-delete-btn").onclick = () => {
            if (confirm(`Möchtest du die Playlist "${plName}" wirklich löschen?`)) {
                delete playlists[type][plName];
                
                // Delete custom cover
                const coverPath = covers[`${type}_${plName}`];
                if (coverPath && fs.existsSync(coverPath)) {
                    try { fs.unlinkSync(coverPath); } catch (e) {}
                }
                delete covers[`${type}_${plName}`];
                localStorage.setItem("playlistCovers", JSON.stringify(covers));
                
                localStorage.setItem("playlists", JSON.stringify(playlists));
                loadSettingsPlaylists(type);
                
                if (miniPlaylistOpen) renderMiniPlaylist();
            }
        };
        
        listContainer.appendChild(row);
    });
}

function showPlaylists(type) {
    playlistView = type;
    
    const musicBtn = document.getElementById("plMusicBtn");
    const videoBtn = document.getElementById("plVideoBtn");
    
    if (musicBtn && videoBtn) {
        if (type === "music") {
            musicBtn.classList.add("active");
            videoBtn.classList.remove("active");
        } else {
            videoBtn.classList.add("active");
            musicBtn.classList.remove("active");
        }
    }
    
    renderPlaylists();
}

function toggleMiniPlaylist() {
    const mp = document.getElementById("miniPlaylist");
    if (!mp) return;
    
    miniPlaylistOpen = !miniPlaylistOpen;
    if (miniPlaylistOpen) {
        mp.classList.add("show");
        renderMiniPlaylist();
    } else {
        mp.classList.remove("show");
    }
}

function renderMiniPlaylist() {
    const container = document.getElementById("mpItems");
    const titleEl = document.getElementById("mpTitle");
    if (!container) return;
    
    if (!currentPlaybackList || currentPlaybackList.length === 0) {
        container.innerHTML = `<div class="text-muted text-xs p-3 text-center">Keine aktive Wiedergabeliste.</div>`;
        return;
    }
    
    if (titleEl) {
        titleEl.innerText = (currentOpenPlaylist && currentOpenPlaylist.name) ? currentOpenPlaylist.name : "Wiedergabeliste";
    }
    
    container.innerHTML = "";
    
    currentPlaybackList.forEach((filePath, i) => {
        const isVideo = filePath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
        const name = path.basename(filePath).replace(/\.[^/.]+$/, "");
        const isActive = (i === currentIndex);
        
        const el = document.createElement("div");
        el.className = "mp-item flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all border border-transparent text-xs hover:bg-white/5 " + (isActive ? "active text-accent bg-accent/10 border-accent/20 font-semibold" : "text-white/80");
        el.innerHTML = `
            <div class="flex items-center gap-2 truncate">
                <span class="w-4 text-center text-muted font-normal">${i + 1}</span>
                <span class="truncate" title="${name}">${name}</span>
            </div>
            ${isActive ? '<span class="text-accent text-[10px] animate-pulse">● LÄUFT</span>' : ''}
        `;
        
        el.onclick = () => {
            currentIndex = i;
            
            if (isVideo) {
                if (player) player.pause();
                if (record) record.classList.remove("spin");
                activeType = "video";
                videoPlayer.src = filePath; // Use absolute path directly
                videoPlayer.currentTime = 0;
                ensureAudioContext();
                videoPlayer.play();
                showTab("videos");
                
                const playBtn = document.getElementById("playBtn");
                if (playBtn) playBtn.innerText = "⏸";
                saveToHistory(filePath); // Use absolute path directly
                updateLikeButton();
                updateVideoControls();
                updateNowPlaying();
            } else {
                if (videoPlayer) videoPlayer.pause();
                activeType = "music";
                player.src = filePath; // Use absolute path directly
                player.currentTime = 0;
                ensureAudioContext();
                player.play();
                if (record) record.classList.add("spin");
                showTab("music");
                
                const playBtn = document.getElementById("playBtn");
                if (playBtn) playBtn.innerText = "⏸";
                saveToHistory(filePath); // Use absolute path directly
                updateLikeButton();
                updateNowPlaying();
            }
            
            renderMiniPlaylist();
        };
        
        container.appendChild(el);
    });
}

// Bind to window for HTML access
window.renderPlaylists = renderPlaylists;
window.openPlaylistDetail = openPlaylistDetail;
window.deleteCurrentPlaylist = deleteCurrentPlaylist;
window.loadSettingsPlaylists = loadSettingsPlaylists;
window.showPlaylists = showPlaylists;
window.toggleMiniPlaylist = toggleMiniPlaylist;
window.renderMiniPlaylist = renderMiniPlaylist;

// GLOBALE FUNKTION: Eine komplette Playlist sofort starten
window.playEntirePlaylist = function(plName, type) {
    if (!playlists[type] || !playlists[type][plName] || playlists[type][plName].length === 0) return;

    // Setze die globale Playlist und fange bei 0 an
    currentOpenPlaylist = { name: plName, type: type };
    currentPlaybackList = playlists[type][plName].map(k => fromMediaKey(k));
    currentIndex = 0;

    const firstPath = currentPlaybackList[0];
    const isVideo = firstPath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);

    // Tab wechseln und Player starten
    if (isVideo) {
        player.pause();
        record.classList.remove("spin");
        activeType = "video";
        videoPlayer.src = firstPath;
        videoPlayer.currentTime = 0;
        ensureAudioContext();
        videoPlayer.play();
        showTab("videos");
    } else {
        videoPlayer.pause();
        activeType = "music";
        player.src = firstPath;
        player.currentTime = 0;
        ensureAudioContext();
        player.play();
        record.classList.add("spin");
        showTab("music");
    }

    updateLikeButton();
    updateNowPlaying();
    if (miniPlaylistOpen) renderMiniPlaylist(); // Falls die kleine Liste offen ist, sofort updaten
};

////////////////////////////////////////////////////////////
// VOLUME
////////////////////////////////////////////////////////////

const volumeValue = document.getElementById("volumeValue");

function applyAppVolume(rawVal) {
  let val = parseFloat(rawVal);
  if (isNaN(val)) val = 1.0;
  val = Math.max(0, Math.min(1.5, val));

  // HTML5 audio/video element volume supports [0, 1]
  const elementVol = Math.min(1.0, val);
  player.volume = elementVol;
  videoPlayer.volume = elementVol;
  if (typeof videoAltAudio !== "undefined" && videoAltAudio) {
    videoAltAudio.volume = elementVol;
  }

  // Web Audio preamp gain handles overboost from 1.0 up to 1.5
  const boostGain = Math.max(1.0, val);
  if (typeof musicPreamp !== "undefined" && musicPreamp?.gain) {
    musicPreamp.gain.value = boostGain;
  }
  if (typeof videoPreamp !== "undefined" && videoPreamp?.gain) {
    videoPreamp.gain.value = boostGain;
  }

  const percent = Math.round(val * 100);
  const vVal = document.getElementById("volumeValue");
  if (vVal) {
    vVal.innerText = percent + "%";
    vVal.style.color = percent > 100 ? "#ff8c00" : "var(--text-main)";
    vVal.style.fontWeight = percent > 100 ? "bold" : "normal";
  }

  const boostBadge = document.getElementById("volumeBoostBadge");
  if (boostBadge) {
    boostBadge.classList.toggle("hidden", percent <= 100);
  }

  // Dynamic SVG Volume Icon
  const volSvg = document.getElementById("volumeIconSvg");
  if (volSvg) {
    if (percent === 0) {
      volSvg.innerHTML = `
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <line x1="23" y1="9" x2="17" y2="15"></line>
        <line x1="17" y1="9" x2="23" y2="15"></line>
      `;
      volSvg.style.color = "var(--text-muted)";
    } else if (percent <= 50) {
      volSvg.innerHTML = `
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path class="vol-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      `;
      volSvg.style.color = "var(--text-main)";
    } else if (percent <= 100) {
      volSvg.innerHTML = `
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path class="vol-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        <path class="vol-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
      `;
      volSvg.style.color = "var(--text-main)";
    } else {
      volSvg.innerHTML = `
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path class="vol-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        <path class="vol-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
      `;
      volSvg.style.color = "#ff9d2b";
    }
  }

  // Update dynamic gradient fill on volume slider
  if (volume) {
    const volPct = Math.min(100, Math.max(0, Math.round((val / 1.5) * 100)));
    volume.style.setProperty('--vol-fill', `${volPct}%`);
  }
}

window.applyAppVolume = applyAppVolume;
window.setQuickVolume = function(val) {
  if (volume) {
    volume.value = val;
    applyAppVolume(val);
  }
};

volume.addEventListener("input", () => {
  applyAppVolume(volume.value);
});

////////////////////////////////////////////////////////////
// VOLUME PANEL
////////////////////////////////////////////////////////////

const volumeIcon = document.querySelector(".volumeIcon")
const volumePanel = document.querySelector(".volumePanel")

volumeIcon.addEventListener("click",(e)=>{
  e.stopPropagation()
  volumePanel.classList.toggle("show")
  volumePanel.classList.toggle("hidden")
})

document.addEventListener("click",(e)=>{
  if(!volumePanel.contains(e.target) && !volumeIcon.contains(e.target)){
    volumePanel.classList.remove("show")
    volumePanel.classList.add("hidden")
  }
})

// Wheel volume adjustment directly on volume icon/box
const volBox = document.querySelector(".volumeBox");
if (volBox) {
  volBox.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!volume) return;
    const current = parseFloat(volume.value) || 1.0;
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    const newVal = Math.max(0, Math.min(1.5, Math.round((current + delta) * 100) / 100));
    volume.value = newVal;
    applyAppVolume(newVal);
  }, { passive: false });
}

////////////////////////////////////////////////////////////
// AMBIENT LIGHT
////////////////////////////////////////////////////////////

var ambientEnabled = true

ambientBtn.onclick = ()=>{

ambientEnabled = !ambientEnabled

ambientBtn.classList.toggle("active")

if(!ambientEnabled){

ambientCanvas.style.display = "none"

}else{

ambientCanvas.style.display = "block"

}

}

function syncRecordGlow(){
  const activePlayer = activeType === "video" ? videoPlayer : player
  record.classList.toggle("playing", !activePlayer.paused)
}

//////////////////////////////////////////////////////////////
// PARTICLES
//////////////////////////////////////////////////////////////

function spawnParticles(button){

const rect = button.getBoundingClientRect()

for(let i=0;i<8;i++){

const p = document.createElement("div")

p.className="particle"

const angle = Math.random()*Math.PI*2
const distance = 20 + Math.random()*20

const x = Math.cos(angle)*distance
const y = Math.sin(angle)*distance

p.style.left = rect.width/2 + "px"
p.style.top = rect.height/2 + "px"

p.style.setProperty("--x",x+"px")
p.style.setProperty("--y",y+"px")

button.appendChild(p)

setTimeout(()=>p.remove(),600)

}

}

// Bundled Premium Fonts (Google Fonts, OFL-Lizenz)
const BUNDLED_FONTS = [
    { name: "Inter", file: "Inter-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf" },
    { name: "Playfair Display", file: "PlayfairDisplay-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" },
    { name: "Bebas Neue", file: "BebasNeue-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" },
    { name: "Pacifico", file: "Pacifico-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/pacifico/Pacifico-Regular.ttf" },
    { name: "Source Code Pro", file: "SourceCodePro-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/sourcecodepro/SourceCodePro%5Bwght%5D.ttf" },
    { name: "Josefin Sans", file: "JosefinSans-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/josefinsans/JosefinSans%5Bwght%5D.ttf" },
    { name: "Dancing Script", file: "DancingScript-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/dancingscript/DancingScript%5Bwght%5D.ttf" },
    { name: "Orbitron", file: "Orbitron-Regular.ttf", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf" },
];

function initFonts() {
    const style = document.getElementById('dynamic-fonts') || document.createElement('style');
    style.id = 'dynamic-fonts';
    if (!style.parentElement) {
        document.head.appendChild(style);
    }
    
    // Purge corrupted or invalid files on startup to avoid OTS parsing errors!
    if (fs.existsSync(fontsFolder)) {
        try {
            const files = fs.readdirSync(fontsFolder);
            files.forEach(f => {
                const fullPath = path.join(fontsFolder, f);
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    if (stat.size < 1000) {
                        // Under 1KB is definitely not a valid font
                        try { fs.unlinkSync(fullPath); } catch(e){}
                        return;
                    }
                    
                    try {
                        const fd = fs.openSync(fullPath, 'r');
                        const buf = Buffer.alloc(4);
                        fs.readSync(fd, buf, 0, 4, 0);
                        fs.closeSync(fd);
                        
                        const hex = buf.toString('hex');
                        const text = buf.toString('ascii');
                        
                        // Valid font signatures: TrueType (00010000), OpenType (OTTO), Apple (true), WOFF (wOFF), WOFF2 (wOF2)
                        const isValid = (hex === '00010000' || text === 'OTTO' || text === 'true' || text === 'wOFF' || text === 'wOF2');
                        if (!isValid) {
                            console.log("🗑️ Purging corrupt/invalid font file (invalid signature):", f);
                            try { fs.unlinkSync(fullPath); } catch(e){}
                        }
                    } catch(err) {
                        console.error("Error checking font file:", f, err);
                    }
                }
            });
        } catch (e) {
            console.error("Error purging corrupt fonts:", e);
        }
    }
    
    loadAndInjectFonts();
    installBundledFonts();
    
    const savedFont = localStorage.getItem("appFont") || "";
    setAppFont(savedFont);
}

function installBundledFonts() {
    const https = require("https");
    let pendingDownloads = 0;
    
    BUNDLED_FONTS.forEach(fontDef => {
        const destPath = path.join(fontsFolder, fontDef.file);
        if (fs.existsSync(destPath)) return;
        
        console.log("⬇️ Lade Font herunter:", fontDef.name, "...");
        pendingDownloads++;
        
        const file = fs.createWriteStream(destPath);
        https.get(fontDef.url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        console.log("✅ Font installiert:", fontDef.name);
                        pendingDownloads--;
                        if (pendingDownloads === 0) {
                            loadAndInjectFonts();
                        }
                    });
                });
            } else {
                response.resume();
                file.close(() => {
                    try { fs.unlinkSync(destPath); } catch(e) {}
                    console.warn("⚠️ Fehler beim Laden von", fontDef.name, ": HTTP", response.statusCode);
                    pendingDownloads--;
                    if (pendingDownloads === 0) {
                        loadAndInjectFonts();
                    }
                });
            }
        }).on('error', (err) => {
            file.close(() => {
                try { fs.unlinkSync(destPath); } catch(e) {}
                console.warn("⚠️ Netzwerkfehler für Font", fontDef.name, ":", err.message);
                pendingDownloads--;
                if (pendingDownloads === 0) {
                    loadAndInjectFonts();
                }
            });
        });
    });
}

function loadAndInjectFonts() {
    const styleEl = document.getElementById('dynamic-fonts');
    if (!styleEl) {
        const newStyle = document.createElement('style');
        newStyle.id = 'dynamic-fonts';
        document.head.appendChild(newStyle);
    }
    
    let files = [];
    try {
        if (fs.existsSync(fontsFolder)) {
            files = fs.readdirSync(fontsFolder).filter(f => f.match(/\.(ttf|otf|woff|woff2)$/i));
            console.log("✅ Schriftarten gefunden:", files);
        } else {
            console.warn("⚠️ fontsFolder existiert nicht:", fontsFolder);
            fs.mkdirSync(fontsFolder, { recursive: true });
        }
    } catch (err) {
        console.error("❌ Fehler beim Lesen des Fonts-Ordners:", err);
    }

    let css = '';
    
    files.forEach(file => {
        const fontName = file.replace(/\.[^/.]+$/, "");
        const fullPath = path.join(fontsFolder, file);
        
        try {
            const fontBuffer = fs.readFileSync(fullPath);
            const base64Data = fontBuffer.toString('base64');
            
            const ext = path.extname(file).toLowerCase();
            let mimeType = 'font/truetype';
            let formatStr = 'truetype';
            
            if (ext === '.otf') { mimeType = 'font/opentype'; formatStr = 'opentype'; }
            else if (ext === '.woff') { mimeType = 'font/woff'; formatStr = 'woff'; }
            else if (ext === '.woff2') { mimeType = 'font/woff2'; formatStr = 'woff2'; }

            css += `
                @font-face {
                    font-family: "${fontName}";
                    src: url(data:${mimeType};charset=utf-8;base64,${base64Data}) format("${formatStr}");
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                }
            `;
        } catch (err) {
            console.error("❌ Fehler beim Laden der Schrift:", file, err);
        }
    });
    
    const styleElement = document.getElementById('dynamic-fonts');
    if (styleElement) {
        styleElement.innerHTML = css;
        console.log("✅ Fonts injiziert:", css ? "Ja" : "Nein");
    }
    
    renderFontsGrid(files);
    populateTextToolFontDropdown(files);
}

function populateTextToolFontDropdown(files) {
    const dropdown = document.getElementById("ttFont");
    if (!dropdown) return;
    
    const systemFonts = [
        { name: "Arial", label: "Arial" },
        { name: "Times New Roman", label: "Times New Roman" },
        { name: "Courier New", label: "Courier New" },
        { name: "Georgia", label: "Georgia" },
        { name: "Trebuchet MS", label: "Trebuchet MS" },
        { name: "Verdana", label: "Verdana" },
        { name: "Impact", label: "Impact" },
    ];
    
    dropdown.innerHTML = "";
    
    const sysGroup = document.createElement("optgroup");
    sysGroup.label = "System-Schriften";
    systemFonts.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.label;
        sysGroup.appendChild(opt);
    });
    dropdown.appendChild(sysGroup);
    
    if (files.length > 0) {
        const customGroup = document.createElement("optgroup");
        customGroup.label = "Premium-Schriften";
        files.forEach(file => {
            const fontName = file.replace(/\.[^/.]+$/, "");
            const opt = document.createElement("option");
            opt.value = fontName;
            opt.textContent = fontName;
            customGroup.appendChild(opt);
        });
        dropdown.appendChild(customGroup);
    }
}

function renderFontsGrid(files) {
    const grid = document.getElementById("fontsGrid");
    if (!grid) return;
    
    grid.innerHTML = "";
    
    const savedFont = localStorage.getItem("appFont") || "";
    const fontScales = JSON.parse(localStorage.getItem("fontScales") || "{}");
    
    const defaultCard = document.createElement("div");
    defaultCard.className = "font-card" + (savedFont === "" ? " active" : "");
    defaultCard.innerHTML = `
        <div class="font-preview" style="font-family: sans-serif;">AaBbCc</div>
        <div style="font-size: 14px; font-weight: bold;">System Standard</div>
    `;
    defaultCard.onclick = () => setAppFont("");
    grid.appendChild(defaultCard);

    files.forEach(file => {
        const fontName = file.replace(/\.[^/.]+$/, "");
        
        let scale = fontScales[fontName] || 100; 
        if (scale > 300) scale = 300; 
        if (scale < 50) scale = 50;
        
        const previewSize = Math.round(32 * (scale / 100));
        
        const card = document.createElement("div");
        card.className = "font-card" + (savedFont === fontName ? " active" : "");
        
        card.innerHTML = `
            <button class="delete-font-btn" title="Schriftart löschen">🗑️</button>
            <div class="font-preview" id="preview-${fontName}" style="font-family: '${fontName}', sans-serif; padding: 5px 0 15px; font-size: ${previewSize}px;">Aa</div>
            <div style="font-size: 13px; font-weight: bold; word-break: break-all; margin-bottom: 15px; color: var(--text-main);">${fontName}</div>
            <div class="font-slider-box" onclick="event.stopPropagation()">
                <div class="font-slider-header">
                    <span>Schriftgröße</span>
                    <span id="scale-val-${fontName}" style="color: var(--text-main); font-weight: bold;">${scale}%</span>
                </div>
                <input type="range" class="custom-font-slider" min="50" max="300" step="5" value="${scale}">
            </div>
        `;
        
        const deleteBtn = card.querySelector(".delete-font-btn");
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteFont(file);
        };
        
        const slider = card.querySelector(".custom-font-slider");
        slider.oninput = (e) => {
            const val = e.target.value;
            document.getElementById(`scale-val-${fontName}`).innerText = val + "%";
            document.getElementById(`preview-${fontName}`).style.fontSize = Math.round(32 * (val / 100)) + "px";
            window.saveFontScale(fontName, val);
        };

        card.onclick = () => setAppFont(fontName);
        grid.appendChild(card);
    });
}

// Wendet die Schrift und die Skalierung als CSS-Variable an
function setAppFont(fontName) {
    if (fontName === "") {
        document.documentElement.style.removeProperty('--app-font');
        document.documentElement.style.setProperty('--text-scale', '1'); // Standardgröße
        localStorage.removeItem("appFont");
    } else {
        document.documentElement.style.setProperty('--app-font', `"${fontName}"`);
        localStorage.setItem("appFont", fontName);
        
        const fontScales = JSON.parse(localStorage.getItem("fontScales") || "{}");
let scale = fontScales[fontName] || 100;
if (scale > 300) scale = 300; // Bis 300% erlauben
if (scale < 50) scale = 50;
        
        // HIER: Setzt die CSS Variable für die Schriftgröße, anstatt die App zu zoomen!
        document.documentElement.style.setProperty('--text-scale', scale / 100);
    }

    document.querySelectorAll('.font-card').forEach(card => {
        card.classList.remove('active');
        if (fontName === "" && card.innerText.includes("System Standard")) {
            card.classList.add('active');
        } else if (fontName !== "" && card.innerText.includes(fontName)) {
            card.classList.add('active');
        }
    });
}

// Speichert den Slider-Wert und wendet ihn live an
window.saveFontScale = function(fontName, scale) {
    const fontScales = JSON.parse(localStorage.getItem("fontScales") || "{}");
    fontScales[fontName] = parseInt(scale);
    localStorage.setItem("fontScales", JSON.stringify(fontScales));
    
    if (localStorage.getItem("appFont") === fontName) {
        // HIER: Wendet ihn sofort live auf den Text an
        document.documentElement.style.setProperty('--text-scale', scale / 100);
    }
};

function deleteFont(fileName) {
    const filePath = path.join(fontsFolder, fileName);
    try {
        fs.unlinkSync(filePath);
        const currentFont = localStorage.getItem("appFont");
        const fontName = fileName.replace(/\.[^/.]+$/, "");
        
        // Auch die gespeicherte Größe aus dem Speicher löschen
        const fontScales = JSON.parse(localStorage.getItem("fontScales") || "{}");
        delete fontScales[fontName];
        localStorage.setItem("fontScales", JSON.stringify(fontScales));
        
        if (currentFont === fontName) {
            setAppFont(""); 
        } else {
            loadAndInjectFonts();
        }
    } catch (e) {
        console.error("Fehler beim Löschen:", e);
    }
}

// --- FEHLENDER FONT IMPORTER ---
window.openFontImporter = function() {
    document.getElementById("fontImporter").click();
};

document.getElementById("fontImporter").addEventListener("change", (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    let webUtils;
    try { webUtils = require('electron').webUtils; } catch(e) {}

    if (!fs.existsSync(fontsFolder)) fs.mkdirSync(fontsFolder, { recursive: true });

    for (let i = 0; i < files.length; i++) {
        let sourcePath = window.getNativeFilePath(files[i]);
        if (!sourcePath && webUtils) sourcePath = webUtils.getPathForFile(files[i]);
        if (!sourcePath) continue;

        const ext = path.extname(sourcePath).toLowerCase();
        const fileName = path.basename(sourcePath);

        if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
            const dest = path.join(fontsFolder, fileName);
            try {
                fs.copyFileSync(sourcePath, dest);
            } catch (err) {
                console.error("Fehler beim Kopieren der Schrift:", err);
            }
        }
    }

    loadAndInjectFonts();
    event.target.value = ""; 
});

// AM ENDE VON renderer.js, VOR dem START-Kommentar
function initFontTab() {
    const fontsTab = document.getElementById("tab-fonts");
    const fontsGrid = document.getElementById("fontsGrid");
    
    if (!fontsGrid) {
        console.error("❌ fontsGrid nicht gefunden!");
        return;
    }
    
    // Stelle sicher, dass der Tab existiert
    if (!fontsTab) {
        console.error("❌ tab-fonts nicht gefunden!");
        return;
    }
    
    // Fonts laden beim ersten Öffnen des Tabs
    loadAndInjectFonts();
}

// Rufe dies beim Start auf
window.addEventListener("DOMContentLoaded", () => {
    initFonts();
    initFontTab(); // NEU!
});

////////////////////////////////////////////////////////////
// LOGO BEARBEITUNG: EBENEN, FARBRAD, FÜLLWERKZEUG
////////////////////////////////////////////////////////////

const logoFolder = path.join(mediaBase, "logo");
if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });

let logoData = { x: 0, y: 0, scale: 1, isDragging: false, startX: 0, startY: 0 };
let currentEditingLogo = null; 

let activeTool = "move"; 
let previousTool = "move"; 
let isDrawing = false;
let isSpaceDown = false;
let lassoPoints = [];

const logoCropContainer = document.getElementById("logoCropContainer");
const logoTransformWrapper = document.getElementById("logoTransformWrapper");
const layersContainer = document.getElementById("layersContainer");
const lassoCanvas = document.getElementById("lassoCanvas");
const logoZoomSlider = document.getElementById("logoZoom");
const actualLogoImg = document.querySelector(".logoBox img");
const brushSizeSlider = document.getElementById("brushSize");
const brushOpacitySlider = document.getElementById("brushOpacity");
const colorPicker = document.getElementById("logoColorPicker");
const currentColorDisplay = document.getElementById("currentColorDisplay");
const layerOpacitySlider = document.getElementById("layerOpacity");
const layerBlendModeSelect = document.getElementById("layerBlendMode");
const colorWheelCanvas = document.getElementById("colorWheelCanvas");

// --- EXPERTEN LOGO EDITOR GLOBALE VARIABLEN ---
let isCropLocked = false;
let isCanvasLocked = false;
let isCropBoxVisible = true;

// Smudge Mixer-Brush Offscreen Canvases & Variablen
const smudgeReservoirCanvas = document.createElement("canvas");
const smudgeReservoirCtx = smudgeReservoirCanvas.getContext("2d", { willReadFrequently: true });
const smudgeStampCanvas = document.createElement("canvas");
const smudgeStampCtx = smudgeStampCanvas.getContext("2d", { willReadFrequently: true });
const smudgeBgCanvas = document.createElement("canvas");
const smudgeBgCtx = smudgeBgCanvas.getContext("2d", { willReadFrequently: true });

let smudgeTotalDistance = 0;
let smudgeStartOpacity = 1.0;

// Tracking der Originalbild-Dimensionen für Reset
window.originalImageWidth = 500;
window.originalImageHeight = 500;

// --- DYNAMISCHE HILFSFUNKTIONEN ---

// 1. Cursor aktualisieren
function updateCursor() {
    const container = document.getElementById("logoCropContainer");
    if (!container) return;
    if (isSpaceDown) {
        container.style.cursor = logoData.isDragging ? "grabbing" : "grab";
    } else if (activeTool === "move") {
        container.style.cursor = logoData.isDragging ? "grabbing" : "grab";
    } else if (activeTool === "layerMove") {
        container.style.cursor = "move";
    } else if (activeTool === "brush" || activeTool === "airbrush" || activeTool === "raster" || activeTool === "eraser" || activeTool === "smudge" || activeTool === "lasso" || activeTool === "shape" || activeTool === "gradient" || activeTool === "clone") {
        container.style.cursor = window.isEraserToggleMode ? "cell" : "crosshair";
    } else if (activeTool === "fill") {
        container.style.cursor = "cell";
    } else if (activeTool === "eyedropper") {
        container.style.cursor = "copy";
    } else if (activeTool === "text") {
        container.style.cursor = "text";
    } else {
        container.style.cursor = "default";
    }
}

// 2. Exportrahmen und handles visualisieren
function updateCropBoxUI() {
    let cropFrame = document.getElementById("cropBoxFrame");
    if (!cropFrame && logoTransformWrapper) {
        cropFrame = document.createElement("div");
        cropFrame.id = "cropBoxFrame";
        cropFrame.style.position = "absolute";
        cropFrame.style.border = "2px dashed #dda16e";
        cropFrame.style.boxSizing = "border-box";
        cropFrame.style.pointerEvents = "none";
        logoTransformWrapper.appendChild(cropFrame);
    }
    
    if (cropFrame) {
        cropFrame.style.left = cropBox.x + "px";
        cropFrame.style.top = cropBox.y + "px";
        cropFrame.style.width = cropBox.w + "px";
        cropFrame.style.height = cropBox.h + "px";
        cropFrame.style.display = isCropBoxVisible ? "block" : "none";
    }
    
    let cropHandle = document.getElementById("cropHandle");
    if (!cropHandle && logoTransformWrapper) {
        cropHandle = document.createElement("div");
        cropHandle.id = "cropHandle";
        cropHandle.className = "resize-handle";
        cropHandle.style.position = "absolute";
        cropHandle.style.pointerEvents = "auto";
        cropHandle.title = "Export-Rahmen skalieren";
        logoTransformWrapper.appendChild(cropHandle);
    }
    
    if (cropHandle) {
        cropHandle.style.left = (cropBox.x + cropBox.w - 8) + "px";
        cropHandle.style.top = (cropBox.y + cropBox.h - 8) + "px";
        cropHandle.style.display = (isCropBoxVisible && !isCropLocked) ? "block" : "none";
    }
    
    let canvasHandle = document.getElementById("canvasHandle");
    if (!canvasHandle && logoTransformWrapper) {
        canvasHandle = document.createElement("div");
        canvasHandle.id = "canvasHandle";
        canvasHandle.className = "resize-handle canvas-handle";
        canvasHandle.style.position = "absolute";
        canvasHandle.style.pointerEvents = "auto";
        canvasHandle.title = "Leinwand vergrößern";
        logoTransformWrapper.appendChild(canvasHandle);
    }
    
    if (canvasHandle) {
        canvasHandle.style.left = (baseWidth - 8) + "px";
        canvasHandle.style.top = (baseHeight - 8) + "px";
        canvasHandle.style.display = !isCanvasLocked ? "block" : "none";
    }
    
    const cropW = document.getElementById("cropW");
    const cropH = document.getElementById("cropH");
    if (cropW) cropW.value = Math.round(cropBox.w);
    if (cropH) cropH.value = Math.round(cropBox.h);
}

// 3. Zoom-Transformation anwenden
function updateLogoTransform() {
    let wrapper = null;
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            wrapper = window.popoutEditorWindow.document.getElementById("logoTransformWrapper");
        } catch(e) {}
    }
    if (!wrapper) {
        wrapper = document.getElementById("logoTransformWrapper");
    }
    if (wrapper) {
        wrapper.style.transform = `translate(${logoData.x}px, ${logoData.y}px) scale(${logoData.scale})`;
    }
    if (typeof window.updateNavigatorUI === "function") {
        window.updateNavigatorUI();
    }
}
window.updateLogoTransform = updateLogoTransform;

// 4. Sperr-Status umschalten
window.toggleLock = function(type) {
    const lockedSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg>';
    const unlockedSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v1"></path></svg>';
    
    if (type === 'crop') {
        isCropLocked = !isCropLocked;
        const icon = document.getElementById("lockCropIcon");
        if (icon) icon.outerHTML = isCropLocked ? lockedSvg.replace('<svg ', '<svg id="lockCropIcon" ') : unlockedSvg.replace('<svg ', '<svg id="lockCropIcon" ');
    } else if (type === 'canvas') {
        isCanvasLocked = !isCanvasLocked;
        const icon = document.getElementById("lockCanvasIcon");
        if (icon) icon.outerHTML = isCanvasLocked ? lockedSvg.replace('<svg ', '<svg id="lockCanvasIcon" ') : unlockedSvg.replace('<svg ', '<svg id="lockCanvasIcon" ');
    }
    updateCropBoxUI();
};

/**
 * Ermittelt das aktive Dokument (Standardfenster oder Tablet Popout-Fenster)
 */
function getActiveEditorDoc() {
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            if (window.popoutEditorWindow.document && window.popoutEditorWindow.document.body) {
                return window.popoutEditorWindow.document;
            }
        } catch (e) {}
    }
    return document;
}
window.getActiveEditorDoc = getActiveEditorDoc;

function getActiveColor() {
    const d = getActiveEditorDoc();
    const cp = d.getElementById("logoColorPicker");
    if (cp && cp.value) return cp.value;
    const topPicker = document.getElementById("logoColorPicker");
    if (topPicker && topPicker.value) return topPicker.value;
    if (typeof hsv !== 'undefined' && typeof hsvToHex === 'function') return hsvToHex(hsv.h, hsv.s, hsv.v);
    return "#1db954";
}
window.getActiveColor = getActiveColor;

function getActiveBrushSize() {
    const d = getActiveEditorDoc();
    const el = d.getElementById("brushSize") || (typeof brushSizeSlider !== "undefined" && brushSizeSlider ? brushSizeSlider : null);
    return el ? parseFloat(el.value) : 20;
}
window.getActiveBrushSize = getActiveBrushSize;

function getActiveBrushOpacity() {
    const d = getActiveEditorDoc();
    const el = d.getElementById("brushOpacity") || (typeof brushOpacitySlider !== "undefined" && brushOpacitySlider ? brushOpacitySlider : null);
    return el ? parseFloat(el.value) : 1;
}
window.getActiveBrushOpacity = getActiveBrushOpacity;

function getActiveBrushHardness() {
    const d = getActiveEditorDoc();
    const el = d.getElementById("brushHardness") || document.getElementById("brushHardness");
    return el ? parseFloat(el.value) : 0.8;
}
window.getActiveBrushHardness = getActiveBrushHardness;

function getActiveBrushSmoothing() {
    const d = getActiveEditorDoc();
    const el = d.getElementById("brushSmoothing") || document.getElementById("brushSmoothing");
    return el ? parseFloat(el.value) : 0.4;
}
window.getActiveBrushSmoothing = getActiveBrushSmoothing;

// QoL Sidebar Toggling / Sidebars ein- und ausklappen
window.togglePanel = function(panelId, btn) {
    const targetDoc = getActiveEditorDoc();
    const panel = targetDoc.getElementById(panelId);
    if (!panel) return;
    
    const isCollapsed = panel.classList.toggle("collapsed");
    
    // Update all buttons targeting this panel to keep arrows and text in sync
    const allButtons = targetDoc.querySelectorAll(`button[onclick*="${panelId}"]`);
    allButtons.forEach(button => {
        if (panelId === "logoLeftToolbar") {
            if (button.classList.contains("csp-collapse-btn")) {
                button.innerText = isCollapsed ? "▶" : "◀";
            } else {
                button.innerText = isCollapsed ? "Werkzeuge ▶" : "◀ Werkzeuge";
            }
        } else if (panelId === "logoRightToolbar") {
            if (button.classList.contains("csp-collapse-btn")) {
                button.innerText = isCollapsed ? "◀" : "▶";
            } else {
                button.innerText = isCollapsed ? "◀ Ebenen" : "Ebenen ▶";
            }
        } else if (panelId === "logoBottomToolbar") {
            button.innerText = isCollapsed ? "▲" : "▼";
        }
    });
    
    if (typeof window.saveLayout === "function") window.saveLayout(targetDoc);
    if (typeof window.updateWindowMenuCheckmarks === "function") window.updateWindowMenuCheckmarks();
};

// Expand collapsed sidebars when panels are dropped/docked onto them
window.expandSidebar = function(sidebarId) {
    const targetDoc = getActiveEditorDoc();
    const sidebar = targetDoc.getElementById(sidebarId);
    if (!sidebar) return;
    if (sidebar.classList.contains("collapsed")) {
        sidebar.classList.remove("collapsed");
        const allButtons = targetDoc.querySelectorAll(`button[onclick*="${sidebarId}"]`);
        allButtons.forEach(button => {
            if (sidebarId === "logoLeftToolbar") {
                if (button.classList.contains("csp-collapse-btn")) {
                    button.innerText = "◀";
                } else {
                    button.innerText = "◀ Werkzeuge";
                }
            } else if (sidebarId === "logoRightToolbar") {
                if (button.classList.contains("csp-collapse-btn")) {
                    button.innerText = "▶";
                } else {
                    button.innerText = "Ebenen ▶";
                }
            } else if (sidebarId === "logoBottomToolbar") {
                button.innerText = "▼";
            }
        });
        if (typeof window.saveLayout === "function") window.saveLayout(targetDoc);
        if (typeof window.updateWindowMenuCheckmarks === "function") window.updateWindowMenuCheckmarks();
    }
};


// =====================================================
// LOGO EDITOR V3 - PREMIUM LOGICS & INTEGRATIONS
// =====================================================

// Tab-Umschaltfunktion links (Werkzeuge / Grafiken)
window.switchLogoLeftTab = function(tabName, btn, doc) {
    const targetDoc = doc || getActiveEditorDoc();
    const cleanName = tabName === "toolsPanel" ? "tools" : (tabName === "graphicsPanel" ? "graphics" : tabName);
    const toolsBody = targetDoc.getElementById("toolsPanelBody");
    const graphicsBody = targetDoc.getElementById("graphicsPanelBody");

    if (cleanName === "tools") {
        if (toolsBody) toolsBody.style.display = "flex";
        if (graphicsBody) graphicsBody.style.display = "none";
    } else if (cleanName === "graphics") {
        if (toolsBody) toolsBody.style.display = "none";
        if (graphicsBody) graphicsBody.style.display = "flex";
        // Pre-populate vector graphics SVG grid
        if (typeof window.filterLogoGraphics === "function") {
            window.filterLogoGraphics();
        }
    }

    const tabBtns = targetDoc.querySelectorAll('.logo-tab-btn');
    tabBtns.forEach(b => {
        b.classList.remove('active');
        b.style.background = 'none';
        b.style.color = '#888';
    });

    const activeBtn = btn || (cleanName === "tools" ? targetDoc.getElementById("tabBtnTools") : targetDoc.getElementById("tabBtnGraphics"));
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.background = 'var(--accent)';
        activeBtn.style.color = '#000';
    }

    if (typeof window.updateWindowMenuCheckmarks === "function") {
        window.updateWindowMenuCheckmarks();
    }
};

// Vektorgrafiken Asset-Bibliothek (Path2D kompatible 0-100 Pfade)
const LOGO_GRAPHICS = {
    "Kreis": "M 50,50 m -40,0 a 40,40 0 1,0 80,0 a 40,40 0 1,0 -80,0",
    "Quadrat": "M 15,15 L 85,15 L 85,85 L 15,85 Z",
    "Dreieck": "M 50,15 L 85,85 L 15,85 Z",
    "Stern": "M 50,10 L 62,38 L 92,38 L 68,56 L 77,85 L 50,67 L 23,85 L 32,56 L 8,38 L 38,38 Z",
    "Herz": "M 50,30 C 50,10 20,10 20,35 C 20,60 50,85 50,85 C 50,85 80,60 80,35 C 80,10 50,10 50,30 Z",
    "Schild": "M 15,15 L 50,8 L 85,15 C 85,50 70,80 50,92 C 30,80 15,50 15,15 Z",
    "Schild Tech": "M 15,15 L 50,5 L 85,15 L 80,50 L 50,95 L 20,50 Z",
    "Krone": "M 10,80 L 15,35 L 35,55 L 50,20 L 65,55 L 85,35 L 90,80 Z",
    "Krone Royal": "M 10,80 L 20,30 L 40,55 L 50,20 L 60,55 L 80,30 L 90,80 Z M 50,20 A 4,4 0 1,1 50,12 A 4,4 0 1,1 50,20 M 20,30 A 3,3 0 1,1 20,24 A 3,3 0 1,1 20,30 M 80,30 A 3,3 0 1,1 80,24 A 3,3 0 1,1 80,30 M 10,80 L 90,80 L 90,90 L 10,90 Z",
    "Diamant": "M 50,10 L 90,50 L 50,90 L 10,50 Z",
    "Hexagon": "M 50,10 L 85,30 L 85,70 L 50,90 L 15,70 L 15,30 Z",
    "Oktagon": "M 35,15 L 65,15 L 85,35 L 85,65 L 65,85 L 35,85 L 15,65 L 15,35 Z",
    "Mond": "M 50,15 C 70,15 85,30 85,50 C 85,70 70,85 50,85 C 62,85 72,75 72,50 C 72,25 62,15 50,15 Z",
    "Sonne": "M 50,30 A 20,20 0 1,0 50,70 A 20,20 0 1,0 50,30 M 50,10 L 50,20 M 50,80 L 50,90 M 10,50 L 20,50 M 80,50 L 90,50 M 22,22 L 29,29 M 71,71 L 78,78 M 22,78 L 29,71 M 71,22 L 78,29",
    "Play": "M 30,20 L 80,50 L 30,80 Z",
    "Zahnrad": "M 50,35 A 15,15 0 1,0 50,65 A 15,15 0 1,0 50,35 M 48,10 L 52,10 L 54,20 L 46,20 Z M 48,80 L 52,80 L 54,90 L 46,90 Z M 10,48 L 10,52 L 20,54 L 20,46 Z M 80,48 L 80,52 L 90,54 L 90,46 Z M 22,22 L 25,25 L 32,18 L 29,15 Z M 75,75 L 78,78 L 85,71 L 82,68 Z M 22,78 L 25,75 L 18,68 L 15,71 Z M 78,22 L 75,25 L 68,18 L 71,15 Z",
    "Blitz": "M 60,10 L 20,55 L 48,55 L 40,90 L 80,45 L 52,45 Z",
    "Flamme": "M 50,90 C 75,90 85,70 80,45 C 75,25 50,10 50,10 C 50,10 40,35 45,50 C 40,40 30,35 25,45 C 15,60 25,90 50,90 Z",
    "Blatt": "M 15,85 C 30,70 50,70 85,15 C 70,50 70,70 15,85 M 15,85 L 85,15",
    "Sparkles": "M 50,15 Q 50,50 15,50 Q 50,50 50,85 Q 50,50 85,50 Q 50,50 50,15 Z",
    "Schleife": "M 25,50 L 25,90 L 50,75 L 75,90 L 75,50 L 50,60 Z M 25,50 A 25,25 0 1,1 75,50 A 25,25 0 1,1 25,50",
    "Pokal": "M 30,15 L 70,15 L 65,55 C 65,70 35,70 35,55 Z M 35,55 L 25,55 C 15,55 15,30 25,30 L 30,30 M 65,55 L 75,55 C 85,55 85,30 75,30 L 70,30 M 50,65 L 50,80 L 35,80 L 35,90 L 65,90 L 65,80 L 50,80",
    "Fliege": "M 50,45 C 40,25 20,25 30,50 C 40,65 50,45 50,45 C 50,45 60,65 70,50 C 80,25 60,25 50,45 M 50,45 L 35,85 M 50,45 L 65,85",
    "Musik": "M 35,75 A 10,10 0 1,1 25,65 A 10,10 0 1,1 35,75 M 35,25 L 35,75 M 75,65 A 10,10 0 1,1 65,55 A 10,10 0 1,1 75,65 M 75,15 L 75,65 M 35,25 L 75,15 L 75,25 L 35,35 Z",
    "Lorbeerkranz": "M 50,85 C 30,85 20,70 20,50 C 20,30 30,15 50,15 C 45,25 35,35 35,50 C 35,65 45,75 50,85 M 50,85 C 70,85 80,70 80,50 C 80,30 70,15 50,15 C 55,25 65,35 65,50 C 65,65 55,75 50,85 Z",
    "Unendlich": "M 30,35 C 15,35 15,65 30,65 C 42,65 50,53 50,50 C 50,47 58,35 70,35 C 85,35 85,65 70,65 C 58,65 50,53 50,50 C 50,47 42,35 30,35 Z",
    "Schluessel": "M 35,50 A 15,15 0 1,1 65,50 A 15,15 0 1,1 35,50 M 60,50 L 90,50 L 90,65 L 80,65 L 80,50 L 75,50 L 75,65 L 65,65",
    "Anker": "M 50,10 A 5,5 0 1,1 50,20 A 5,5 0 1,1 50,10 M 50,20 L 50,75 M 35,35 L 65,35 M 20,50 C 20,75 80,75 80,50 M 20,50 L 15,45 M 80,50 L 85,45 M 50,75 A 5,5 0 1,1 50,85 A 5,5 0 1,1 50,75",
    "Wolke": "M 25,65 C 15,65 15,50 25,50 C 25,35 45,30 50,40 C 55,30 75,30 75,45 C 85,45 85,65 75,65 Z",
    "Kompass": "M 50,15 A 35,35 0 1,0 50,85 A 35,35 0 1,0 50,15 M 50,30 L 60,50 L 50,70 L 40,50 Z",
    "Code": "M 35,30 L 15,50 L 35,70 M 65,30 L 85,50 L 65,70 M 55,20 L 45,80",
    "Schild Haken": "M 15,15 L 50,8 L 85,15 C 85,50 70,80 50,92 C 30,80 15,50 15,15 Z M 35,50 L 45,60 L 65,40",
    "Tropfen": "M 50,10 C 50,10 80,45 80,60 C 80,76 66,90 50,90 C 34,90 20,76 20,60 C 20,45 50,10 50,10 Z",
    "Blume": "M 50,40 C 45,20 55,20 50,40 C 30,35 30,45 50,40 C 55,60 45,60 50,40 C 70,45 70,35 50,40 Z M 50,50 A 10,10 0 1,1 50,30 A 10,10 0 1,1 50,50",
    "Baum": "M 50,10 C 65,10 75,25 70,40 C 80,40 85,55 75,70 C 80,70 70,90 50,80 C 30,90 20,70 25,70 C 15,55 20,40 30,40 C 25,25 35,10 50,10 Z M 46,75 L 46,90 L 54,90 L 54,75 Z",
    "Weltkugel": "M 50,15 A 35,35 0 1,0 50,85 A 35,35 0 1,0 50,15 M 50,15 A 15,35 0 1,0 50,85 A 15,35 0 1,0 50,15 M 15,50 L 85,50 M 20,32 L 80,32 M 20,68 L 80,68",
    "Feder": "M 85,15 C 75,30 50,50 25,70 C 20,75 15,85 10,90 C 15,85 25,80 30,75 C 50,50 70,25 85,15 M 40,55 L 30,50 M 50,45 L 40,40 M 60,35 L 50,30",
    "Rakete": "M 50,10 C 60,25 65,45 60,65 L 68,78 L 50,72 L 32,78 L 40,65 C 35,45 40,25 50,10 Z M 50,40 A 5,5 0 1,1 50,30 A 5,5 0 1,1 50,40 M 40,65 L 25,72 L 32,55 M 60,65 L 75,72 L 68,55",
    "Sichel": "M 50,20 C 66,20 80,34 80,50 C 80,66 66,80 50,80 C 60,70 65,55 60,40 C 56,28 48,22 50,20 Z",
    "Retro Stern": "M 50,10 L 60,40 L 90,50 L 60,60 L 50,90 L 40,60 L 10,50 L 40,40 Z",
    "Badge": "M 50,5 L 63,14 L 78,9 L 83,24 L 97,27 L 93,42 L 100,55 L 90,67 L 90,82 L 75,85 L 67,97 L 50,92 L 33,97 L 25,85 L 10,82 L 10,67 L 0,55 L 7,42 L 3,27 L 17,24 L 22,9 L 37,14 Z",
    "Crescent": "M 50,5 A 45,45 0 1,0 95,50 A 35,45 0 1,1 50,5 Z"
};

// Filtert und rendert Vektorgrafiken
window.filterLogoGraphics = function() {
    const grid = document.getElementById("graphicsGrid");
    if (!grid) return;
    grid.innerHTML = "";
    
    const searchVal = (document.getElementById("graphicsSearch")?.value || "").toLowerCase();
    
    Object.keys(LOGO_GRAPHICS).forEach(name => {
        if (searchVal && !name.toLowerCase().includes(searchVal)) return;
        
        const pathData = LOGO_GRAPHICS[name];
        
        const item = document.createElement("div");
        item.style.background = "#222";
        item.style.border = "1px solid #333";
        item.style.borderRadius = "6px";
        item.style.padding = "8px";
        item.style.cursor = "pointer";
        item.style.display = "flex";
        item.style.flexDirection = "column";
        item.style.alignItems = "center";
        item.style.justifyContent = "center";
        item.style.gap = "6px";
        item.style.transition = "all 0.2s";
        
        item.onmouseover = () => { item.style.borderColor = "var(--accent)"; item.style.background = "#2c2c2c"; };
        item.onmouseout = () => { item.style.borderColor = "#333"; item.style.background = "#222"; };
        item.onclick = () => window.addVectorLayer(name, pathData);
        
        const previewCanvas = document.createElement("canvas");
        previewCanvas.width = 50;
        previewCanvas.height = 50;
        const pCtx = previewCanvas.getContext("2d");
        pCtx.save();
        pCtx.translate(5, 5);
        pCtx.scale(0.4, 0.4);
        pCtx.fillStyle = "#ffffff";
        const path2D = new Path2D(pathData);
        pCtx.fill(path2D);
        pCtx.restore();
        
        const label = document.createElement("span");
        label.style.fontSize = "10px";
        label.style.color = "#aaa";
        label.style.textAlign = "center";
        label.style.wordBreak = "break-all";
        label.textContent = name;
        
        item.appendChild(previewCanvas);
        item.appendChild(label);
        grid.appendChild(item);
    });
};

// Initialisiert und rendert Vektorebene
window.addVectorLayer = function(name, pathData, color) {
    layerCounter++;
    const id = "layer_" + layerCounter;
    
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.width = 200;
    canvas.height = 200;
    
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    const layerObj = {
        id: id,
        name: name,
        canvas: canvas,
        ctx: ctx,
        visible: true,
        opacity: 1,
        blendMode: "source-over",
        x: (baseWidth - 200) / 2,
        y: (baseHeight - 200) / 2,
        scale: 1,
        clippedToBelow: false,
        alphaLocked: false,
        isTextLayer: false,
        textContent: "",
        textProps: {},
        isVectorLayer: true,
        vectorPath: pathData,
        vectorColor: color || colorPicker?.value || "#ffffff"
    };
    
    renderVectorLayer(layerObj);
    
    layers.unshift(layerObj);
    setActiveLayer(id);
    saveLogoState();
    renderMainCanvas();
};

function renderVectorLayer(layer) {
    if (!layer || !layer.isVectorLayer) return;
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    
    ctx.save();
    ctx.translate(10, 10);
    ctx.scale(1.8, 1.8);
    ctx.fillStyle = layer.vectorColor || "#ffffff";
    const path2D = new Path2D(layer.vectorPath);
    ctx.fill(path2D);
    ctx.restore();
}

// Selektives Textstyling via document.execCommand oder global
window.applyStyleToTextBox = function(command, value) {
    const textBox = document.getElementById("canvasTextBox");
    if (!textBox || textBox.style.display === "none") return;
    
    const sel = window.getSelection();
    let hasSelection = false;
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (!range.collapsed && textBox.contains(range.startContainer) && textBox.contains(range.endContainer)) {
            hasSelection = true;
        }
    }
    
    if (hasSelection) {
        if (command === "bold") {
            document.execCommand("bold", false, null);
        } else if (command === "italic") {
            document.execCommand("italic", false, null);
        } else if (command === "underline") {
            document.execCommand("underline", false, null);
        } else if (command === "color") {
            document.execCommand("foreColor", false, value);
        } else if (command === "font") {
            document.execCommand("fontName", false, value);
        } else if (command === "size") {
            const span = document.createElement("span");
            span.style.fontSize = value + "px";
            const range = sel.getRangeAt(0);
            try {
                range.surroundContents(span);
            } catch(e) {
                document.execCommand("fontSize", false, "7");
                const fonts = textBox.querySelectorAll("font[size='7']");
                fonts.forEach(f => {
                    f.removeAttribute("size");
                    f.style.fontSize = value + "px";
                });
            }
        }
    } else {
        // Globaler Fallback
        if (command === "bold") {
            const btn = document.getElementById("ttBold");
            if (btn) btn.classList.toggle("tt-active");
        } else if (command === "italic") {
            const btn = document.getElementById("ttItalic");
            if (btn) btn.classList.toggle("tt-active");
        } else if (command === "underline") {
            const btn = document.getElementById("ttUnderline");
            if (btn) btn.classList.toggle("tt-active");
        } else if (command === "color") {
            const picker = document.getElementById("ttColor");
            if (picker) {
                picker.value = value;
                const disp = document.getElementById("ttColorDisplay");
                if (disp) disp.style.background = value;
            }
        } else if (command === "font") {
            const fontSelect = document.getElementById("ttFont");
            if (fontSelect) fontSelect.value = value;
        } else if (command === "size") {
            const sizeInput = document.getElementById("ttSize");
            if (sizeInput) sizeInput.value = value;
        }
        
        syncTextBoxStyles();
    }
    
    // Echtzeit Synchronisierung in die Ebene
    const layer = getActiveLayer();
    if (layer && layer.isTextLayer) {
        layer.textHTML = textBox.innerHTML;
        const temp = document.createElement("div");
        temp.innerHTML = textBox.innerHTML;
        layer.textContent = (temp.innerText || temp.textContent || "").replace(/\r\n/g, "\n");
        renderTextLayer(layer);
        renderMainCanvas();
    }
};

// Automatischer Formatierungs-Reset am Satzende / Zeilenumbruch
window.resetTypingStyle = function() {
    const textBox = document.getElementById("canvasTextBox");
    if (!textBox || textBox.style.display === "none") return;
    
    if (document.queryCommandState("bold")) document.execCommand("bold", false, null);
    if (document.queryCommandState("italic")) document.execCommand("italic", false, null);
    if (document.queryCommandState("underline")) document.execCommand("underline", false, null);
    
    const activeLayer = getActiveLayer();
    const defaultColor = activeLayer?.textProps?.color || "#ffffff";
    document.execCommand("foreColor", false, defaultColor);
    
    // UI aktualisieren
    const btnBold = document.getElementById("ttBold");
    if (btnBold) btnBold.classList.remove("tt-active");
    const btnItalic = document.getElementById("ttItalic");
    if (btnItalic) btnItalic.classList.remove("tt-active");
    const btnUnderline = document.getElementById("ttUnderline");
    if (btnUnderline) btnUnderline.classList.remove("tt-active");
    
    const colorPicker = document.getElementById("ttColor");
    if (colorPicker) {
        colorPicker.value = defaultColor;
        const colorDisp = document.getElementById("ttColorDisplay");
        if (colorDisp) colorDisp.style.background = defaultColor;
    }
};

// Live Color-Wechsel für Vektoren & Texte über die Palette
window.updateActiveLayerColor = function(hex) {
    const layer = getActiveLayer();
    if (!layer) return;
    
    if (layer.isVectorLayer) {
        layer.vectorColor = hex;
        renderVectorLayer(layer);
        renderMainCanvas();
    } else if (layer.isTextLayer) {
        if (!layer.textProps) layer.textProps = {};
        layer.textProps.color = hex;
        
        const colorPicker = document.getElementById("ttColor");
        if (colorPicker) colorPicker.value = hex;
        const colorDisplay = document.getElementById("ttColorDisplay");
        if (colorDisplay) colorDisplay.style.background = hex;
        
        const textBox = document.getElementById("canvasTextBox");
        if (textBox && textBox.style.display !== "none") {
            window.applyStyleToTextBox("color", hex);
        } else {
            renderTextLayer(layer);
            renderMainCanvas();
        }
    }
};

// Templates Helpers und Loader
function addVectorLayerDirectly(name, pathData, color, x, y, scale) {
    layerCounter++;
    const id = "layer_" + layerCounter;
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    const layerObj = {
        id: id,
        name: name,
        canvas: canvas,
        ctx: ctx,
        visible: true,
        opacity: 1,
        blendMode: "source-over",
        x: x,
        y: y,
        scale: scale || 1,
        clippedToBelow: false,
        alphaLocked: false,
        isTextLayer: false,
        textContent: "",
        textProps: {},
        isVectorLayer: true,
        vectorPath: pathData,
        vectorColor: color
    };
    renderVectorLayer(layerObj);
    layers.push(layerObj);
}

function addTextLayerDirectly(text, color, x, y, size, font, bold, italic, underline, effect) {
    layerCounter++;
    const id = "layer_" + layerCounter;
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.width = baseWidth;
    canvas.height = baseHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    const layerObj = {
        id: id,
        name: text.substring(0, 15),
        canvas: canvas,
        ctx: ctx,
        visible: true,
        opacity: 1,
        blendMode: "source-over",
        x: 0,
        y: 0,
        scale: 1,
        clippedToBelow: false,
        alphaLocked: false,
        isTextLayer: true,
        textContent: text,
        textHTML: `<span style="font-family: '${font}', sans-serif; font-size: ${size}px; color: ${color}; ${bold ? 'font-weight: bold;' : ''} ${italic ? 'font-style: italic;' : ''} ${underline ? 'text-decoration: underline;' : ''}">${text}</span>`,
        textProps: {
            x: x,
            y: y,
            size: size,
            font: font,
            bold: bold,
            italic: italic,
            underline: underline,
            color: color,
            spacing: 0,
            lineHeight: 1.2,
            align: "center",
            effect: effect || "none",
            shadow: false
        }
    };
    renderTextLayer(layerObj);
    layers.push(layerObj);
}

window.loadLogoTemplate = function(templateId) {
    if (!confirm("Möchtest du das aktuelle Logo verwerfen und diese Vorlage laden?")) return;
    
    layers = [];
    layerCounter = 0;
    
    const cw = baseWidth;
    const ch = baseHeight;
    
    if (templateId === "retro") {
        addVectorLayerDirectly("Retro Ring", LOGO_GRAPHICS["Badge"], "#f28f3b", (cw - 300)/2, (ch - 300)/2, 1.5);
        addVectorLayerDirectly("Retro Star", LOGO_GRAPHICS["Stern"], "#fcbf49", (cw - 100)/2, (ch - 100)/2, 0.5);
        addTextLayerDirectly("RETRO BRAND", "#f4d35e", cw/2, ch/2 - 140, 48, "Georgia", true, false, false);
        addTextLayerDirectly("EST. 1985", "#ffffff", cw/2, ch/2 + 100, 24, "Arial", true, false, false);
    }
    else if (templateId === "tech") {
        addVectorLayerDirectly("Tech Shield", LOGO_GRAPHICS["Schild Tech"], "#00f3ff", (cw - 300)/2, (ch - 300)/2 - 20, 1.5);
        addVectorLayerDirectly("Lightning Bolt", LOGO_GRAPHICS["Blitz"], "#d000ff", (cw - 120)/2, (ch - 120)/2 - 20, 0.6);
        addTextLayerDirectly("CYBER SEC", "#00f3ff", cw/2, ch/2 + 110, 44, "Courier New", true, false, false, "neon");
    }
    else if (templateId === "organic") {
        addVectorLayerDirectly("Organic Leaf", LOGO_GRAPHICS["Blatt"], "#81b29a", (cw - 240)/2, (ch - 240)/2 - 50, 1.2);
        addVectorLayerDirectly("Organic Sun", LOGO_GRAPHICS["Sonne"], "#f2cc8f", (cw - 120)/2, (ch - 120)/2 - 50, 0.6);
        addTextLayerDirectly("Pure Organic", "#f4f1de", cw/2, ch/2 + 80, 50, "Times New Roman", false, true, false);
    }
    else if (templateId === "royal") {
        addVectorLayerDirectly("Royal Ring", LOGO_GRAPHICS["Crescent"], "#c5a059", (cw - 300)/2, (ch - 300)/2 - 30, 1.5);
        addVectorLayerDirectly("Royal Crown", LOGO_GRAPHICS["Krone Royal"], "#e5c178", (cw - 160)/2, (ch - 160)/2 - 30, 0.8);
        addTextLayerDirectly("MONARCHY", "#c5a059", cw/2, ch/2 + 110, 42, "Georgia", true, false, true);
    }
    else if (templateId === "minimal") {
        addVectorLayerDirectly("Hexagon Pink", LOGO_GRAPHICS["Hexagon"], "#f4a261", (cw - 240)/2 - 30, (ch - 240)/2 - 30, 1.2);
        addVectorLayerDirectly("Hexagon Orange", LOGO_GRAPHICS["Hexagon"], "#e76f51", (cw - 240)/2 + 30, (ch - 240)/2 + 30, 1.2);
        addTextLayerDirectly("MINIMALIST", "#ffffff", cw/2, ch/2 + 120, 54, "Arial", true, false, false, "outline");
    }
    
    if (layers.length > 0) {
        setActiveLayer(layers[0].id);
    } else {
        activeLayerId = null;
    }
    
    saveLogoState();
    renderMainCanvas();
};

// --- Custom Color Palettes ---
let customPalettes = JSON.parse(localStorage.getItem('logoCustomPalettes')) || [
    { id: 'default', name: 'Palette 1', colors: [] }
];
let activePaletteIndex = 0;

window.renderPaletteSelect = function() {
    const select = document.getElementById('paletteSelect');
    if (!select) return;
    select.innerHTML = '';
    customPalettes.forEach((p, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = p.name;
        if (idx === activePaletteIndex) opt.selected = true;
        select.appendChild(opt);
    });
};

window.switchCustomPalette = function() {
    const select = document.getElementById('paletteSelect');
    if (!select) return;
    activePaletteIndex = parseInt(select.value, 10);
    renderPaletteColors();
};

window.createNewPalette = function() {
    if (customPalettes.length >= 20) {
        alert("Maximal 20 Paletten erlaubt!");
        return;
    }
    const name = prompt("Name der neuen Palette:", "Palette " + (customPalettes.length + 1));
    if (!name) return;
    customPalettes.push({ id: Date.now().toString(), name: name, colors: [] });
    activePaletteIndex = customPalettes.length - 1;
    window.savePalettes();
    window.renderPaletteSelect();
    window.renderPaletteColors();
};

window.deleteCurrentPalette = function() {
    if (customPalettes.length <= 1) {
        alert("Du kannst die letzte Palette nicht löschen.");
        return;
    }
    if (confirm("Wirklich '" + customPalettes[activePaletteIndex].name + "' löschen?")) {
        customPalettes.splice(activePaletteIndex, 1);
        activePaletteIndex = 0;
        window.savePalettes();
        window.renderPaletteSelect();
        window.renderPaletteColors();
    }
};

window.addColorToPalette = function() {
    const p = customPalettes[activePaletteIndex];
    if (p.colors.length >= 15) {
        alert("Maximal 15 Farben pro Palette!");
        return;
    }
    const colorPicker = document.getElementById("logoColorPicker");
    if (colorPicker && colorPicker.value) {
        p.colors.push(colorPicker.value);
        window.savePalettes();
        window.renderPaletteColors();
    }
};

window.removeColorFromPalette = function(idx, e) {
    e.stopPropagation();
    customPalettes[activePaletteIndex].colors.splice(idx, 1);
    window.savePalettes();
    window.renderPaletteColors();
};

window.applyColorFromPalette = function(color) {
    const colorPicker = document.getElementById("logoColorPicker");
    if (colorPicker) {
        colorPicker.value = color;
        colorPicker.dispatchEvent(new Event('input'));
        colorPicker.dispatchEvent(new Event('change'));
        if (typeof window.updateColorUI === 'function') window.updateColorUI(color);
    }
};

window.renderPaletteColors = function() {
    const grid = document.getElementById('paletteColorsGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const p = customPalettes[activePaletteIndex];
    for (let i = 0; i < 15; i++) {
        const slot = document.createElement('div');
        slot.className = 'palette-color-slot';
        if (i < p.colors.length) {
            const color = p.colors[i];
            slot.style.backgroundColor = color;
            slot.title = color;
            slot.onclick = () => window.applyColorFromPalette(color);
            
            const delBtn = document.createElement('div');
            delBtn.className = 'delete-color-btn';
            delBtn.innerHTML = '✕';
            delBtn.title = "Farbe löschen";
            delBtn.onclick = (e) => window.removeColorFromPalette(i, e);
            slot.appendChild(delBtn);
        } else {
            slot.classList.add('empty-slot');
        }
        grid.appendChild(slot);
    }
};

window.savePalettes = function() {
    localStorage.setItem('logoCustomPalettes', JSON.stringify(customPalettes));
};

window.initCustomPalettes = function() {
    window.renderPaletteSelect();
    window.renderPaletteColors();
};

// Layout Drag-and-Drop and docking functions (Clip Studio Paint style)
let draggedPanelId = null;

window.initSidebarResizers = function(targetDoc = document) {
    const sidebars = targetDoc.querySelectorAll('.csp-sidebar');
    sidebars.forEach(sidebar => {
        const oldResizer = sidebar.querySelector('.sidebar-resizer');
        if (oldResizer) oldResizer.remove();

        const isLeft = sidebar.classList.contains('left');
        const isRight = sidebar.classList.contains('right');
        const isBottom = sidebar.classList.contains('bottom');
        if (!isLeft && !isRight && !isBottom) return;
        
        const doc = sidebar.ownerDocument || targetDoc || document;
        const resizer = doc.createElement('div');
        resizer.className = 'sidebar-resizer ' + (isLeft ? 'right-resizer' : isRight ? 'left-resizer' : 'top-resizer');
        sidebar.appendChild(resizer);
        
        let startX, startY, startWidth, startHeight;
        
        const onDragStart = (e) => {
            e.preventDefault();
            e.stopPropagation();
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = sidebar.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            
            resizer.classList.add('active');
            const win = doc.defaultView || window;
            doc.body.style.cursor = isBottom ? 'ns-resize' : 'ew-resize';
            
            const onMouseMove = (moveEvent) => {
                if (isLeft) {
                    const newWidth = Math.max(50, Math.min(450, startWidth + (moveEvent.clientX - startX)));
                    sidebar.style.width = newWidth + 'px';
                    sidebar.style.minWidth = newWidth + 'px';
                } else if (isRight) {
                    const newWidth = Math.max(150, Math.min(650, startWidth - (moveEvent.clientX - startX)));
                    sidebar.style.width = newWidth + 'px';
                    sidebar.style.minWidth = newWidth + 'px';
                } else if (isBottom) {
                    const newHeight = Math.max(50, Math.min(500, startHeight - (moveEvent.clientY - startY)));
                    sidebar.style.height = newHeight + 'px';
                    sidebar.style.minHeight = newHeight + 'px';
                    const content = sidebar.querySelector('.csp-sidebar-content');
                    if (content) content.style.height = '100%';
                }
            };
            
            const onMouseUp = () => {
                resizer.classList.remove('active');
                doc.body.style.cursor = '';
                win.removeEventListener('pointermove', onMouseMove);
                win.removeEventListener('pointerup', onMouseUp);
                win.removeEventListener('pointercancel', onMouseUp);
                win.removeEventListener('mousemove', onMouseMove);
                win.removeEventListener('mouseup', onMouseUp);
                doc.removeEventListener('mousemove', onMouseMove);
                doc.removeEventListener('mouseup', onMouseUp);
                if (win !== window) {
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                }
                if (typeof window.saveLayout === "function") window.saveLayout(doc);
            };
            
            win.addEventListener('pointermove', onMouseMove);
            win.addEventListener('pointerup', onMouseUp);
            win.addEventListener('pointercancel', onMouseUp);
            win.addEventListener('mousemove', onMouseMove);
            win.addEventListener('mouseup', onMouseUp);
            doc.addEventListener('mousemove', onMouseMove);
            doc.addEventListener('mouseup', onMouseUp);
            if (win !== window) {
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            }
        };

        resizer.addEventListener('pointerdown', onDragStart);
        resizer.addEventListener('mousedown', onDragStart);
    });
};

window.initPanelDragAndDrop = function(targetDoc = document) {
    const doc = targetDoc || (typeof window.getActiveEditorDoc === "function" ? window.getActiveEditorDoc() : document);
    const panels = doc.querySelectorAll('.csp-dockable-panel');
    panels.forEach(panel => {
        panel.setAttribute('draggable', 'true');
        
        panel.addEventListener('dragstart', (e) => {
            // Verify if drag started in the header
            const header = panel.querySelector('.csp-panel-header');
            if (header) {
                const rect = header.getBoundingClientRect();
                const insideHeader = e.clientX >= rect.left && e.clientX <= rect.right &&
                                     e.clientY >= rect.top && e.clientY <= rect.bottom;
                if (!insideHeader) {
                    e.preventDefault();
                    return;
                }
            }
            draggedPanelId = panel.id;
            panel.classList.add('dragging');
            e.dataTransfer.setData('text/plain', panel.id);
            e.dataTransfer.effectAllowed = 'move';
        });

        panel.addEventListener('dragend', () => {
            panel.classList.remove('dragging');
            draggedPanelId = null;
            doc.querySelectorAll('.csp-sidebar-content').forEach(c => {
                c.classList.remove('drag-over');
            });
        });
    });

    const sidebars = doc.querySelectorAll('.csp-sidebar');
    sidebars.forEach(sidebar => {
        sidebar.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            // Auto-expand on hover
            if (sidebar.classList.contains('collapsed')) {
                sidebar.classList.remove('collapsed');
                // Trigger transition layout updates if necessary
                if (typeof updateCropBoxUI === 'function') setTimeout(updateCropBoxUI, 300);
            }
        });

        sidebar.addEventListener('dragenter', (e) => {
            e.preventDefault();
            const contentZone = sidebar.querySelector('.csp-sidebar-content');
            if (contentZone) contentZone.classList.add('drag-over');
        });

        sidebar.addEventListener('dragleave', (e) => {
            // Only remove drag-over if leaving the sidebar completely
            if (!sidebar.contains(e.relatedTarget)) {
                const contentZone = sidebar.querySelector('.csp-sidebar-content');
                if (contentZone) contentZone.classList.remove('drag-over');
            }
        });

        sidebar.addEventListener('drop', (e) => {
            e.preventDefault();
            const contentZone = sidebar.querySelector('.csp-sidebar-content');
            if (contentZone) contentZone.classList.remove('drag-over');
            
            const panelId = e.dataTransfer.getData('text/plain') || draggedPanelId;
            if (panelId) {
                const panel = doc.getElementById(panelId);
                if (panel && panel !== e.target) {
                    const sidebar = contentZone.closest('.csp-sidebar');
                    if (sidebar) {
                        window.expandSidebar(sidebar.id);
                    }
                    
                    const targetPanel = e.target.closest('.csp-dockable-panel');
                    if (targetPanel && targetPanel.parentNode === contentZone) {
                        contentZone.insertBefore(panel, targetPanel);
                    } else {
                        contentZone.appendChild(panel);
                    }
                    window.saveLayout(doc);
                    if (typeof window.initPanelResizers === "function") window.initPanelResizers(doc);
                    if (typeof window.updateWindowMenuCheckmarks === "function") window.updateWindowMenuCheckmarks();
                }
            }
        });
    });
}

window.showDockMenu = function(panelId, event) {
    event.preventDefault();
    event.stopPropagation();

    const targetDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) ? window.popoutEditorWindow.document : document;

    let popover = targetDoc.getElementById("csp-dock-popover");
    if (popover) popover.remove();

    popover = targetDoc.createElement("div");
    popover.id = "csp-dock-popover";
    popover.style.cssText = `
        position: fixed;
        z-index: 110000;
        background: rgba(30, 30, 30, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
        border-radius: 8px;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        width: 190px;
    `;

    popover.style.left = `${event.clientX}px`;
    popover.style.top = `${event.clientY}px`;

    const options = [
        { label: "✥ Links anheften", action: () => window.dockPanel(panelId, "logoLeftToolbar") },
        { label: "✥ Rechts anheften", action: () => window.dockPanel(panelId, "logoRightToolbar") },
        { label: "✥ Unten anheften", action: () => window.dockPanel(panelId, "logoBottomToolbar") },
        { divider: true },
        { label: "↑ Nach oben verschieben", action: () => window.reorderPanel(panelId, -1) },
        { label: "↓ Nach unten verschieben", action: () => window.reorderPanel(panelId, 1) },
        { divider: true },
        { label: "✕ Schließen / Ausblenden", action: () => {
            if (typeof window.closeDockPanel === "function") window.closeDockPanel(panelId);
            else {
                const p = targetDoc.getElementById(panelId);
                if (p) p.style.display = "none";
            }
        }}
    ];

    options.forEach(opt => {
        if (opt.divider) {
            const hr = targetDoc.createElement("hr");
            hr.style.cssText = "border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 4px 0;";
            popover.appendChild(hr);
        } else {
            const btn = targetDoc.createElement("button");
            btn.innerText = opt.label;
            btn.style.cssText = `
                background: none;
                border: none;
                color: #ddd;
                padding: 8px 12px;
                text-align: left;
                font-size: 12px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s, color 0.2s;
                font-weight: 500;
            `;
            btn.onmouseover = () => {
                btn.style.background = "rgba(221, 161, 110, 0.15)";
                btn.style.color = "#fff";
            };
            btn.onmouseout = () => {
                btn.style.background = "none";
                btn.style.color = "#ddd";
            };
            btn.onclick = () => {
                opt.action();
                popover.remove();
            };
            popover.appendChild(btn);
        }
    });

    targetDoc.body.appendChild(popover);

    const closeListener = () => {
        popover.remove();
        targetDoc.removeEventListener("click", closeListener);
        document.removeEventListener("click", closeListener);
    };
    setTimeout(() => {
        targetDoc.addEventListener("click", closeListener);
        document.addEventListener("click", closeListener);
    }, 10);
};

window.dockPanel = function(panelId, targetDockId) {
    const targetDoc = (typeof window.getActiveEditorDoc === "function") ? window.getActiveEditorDoc() : document;
    const panel = targetDoc.getElementById(panelId);
    const dock = targetDoc.getElementById(targetDockId);
    if (panel && dock) {
        const contentZone = dock.querySelector('.csp-sidebar-content');
        if (contentZone) {
            window.expandSidebar(targetDockId);
            contentZone.appendChild(panel);
            window.saveLayout(targetDoc);
            if (typeof window.initPanelResizers === "function") window.initPanelResizers(targetDoc);
            if (typeof window.updateWindowMenuCheckmarks === "function") window.updateWindowMenuCheckmarks();
        }
    }
};

window.reorderPanel = function(panelId, direction) {
    const targetDoc = (typeof window.getActiveEditorDoc === "function") ? window.getActiveEditorDoc() : document;
    const panel = targetDoc.getElementById(panelId);
    if (!panel) return;
    const parent = panel.parentNode;
    if (!parent) return;
    const children = Array.from(parent.children);
    const index = children.indexOf(panel);
    if (index === -1) return;

    const newIndex = index + direction;
    if (newIndex >= 0 && newIndex < children.length) {
        if (direction === -1) {
            parent.insertBefore(panel, children[newIndex]);
        } else {
            parent.insertBefore(panel, children[newIndex].nextSibling);
        }
        window.saveLayout(targetDoc);
    }
};

window.saveLayout = function(doc) {
    const targetDoc = doc || (typeof window.getActiveEditorDoc === "function" ? window.getActiveEditorDoc() : document);
    if (!targetDoc) return;

    const layout = {
        sidebars: {},
        panels: {},
        sections: {},
        tools: {}
    };
    
    // 1. Save Sidebar configurations
    const sidebarIds = ["logoLeftToolbar", "logoRightToolbar", "logoBottomToolbar"];
    sidebarIds.forEach(sidebarId => {
        const dock = targetDoc.getElementById(sidebarId);
        if (dock) {
            const contentZone = dock.querySelector('.csp-sidebar-content');
            layout.sidebars[sidebarId] = {
                collapsed: dock.classList.contains("collapsed"),
                width: dock.style.width || "",
                minWidth: dock.style.minWidth || "",
                height: dock.style.height || "",
                minHeight: dock.style.minHeight || "",
                panels: contentZone ? Array.from(contentZone.querySelectorAll('.csp-dockable-panel')).map(p => p.id) : []
            };
        }
    });

    // 2. Save Dockable Panel configurations
    const panels = targetDoc.querySelectorAll('.csp-dockable-panel');
    panels.forEach(p => {
        if (!p.id) return;
        let isVis = p.style.display !== "none" && !p.classList.contains("hidden");
        try {
            const win = targetDoc.defaultView || window;
            if (win.getComputedStyle(p).display === "none") isVis = false;
        } catch(e) {}
        layout.panels[p.id] = {
            height: p.style.height || "",
            flex: p.style.flex || "",
            visible: isVis,
            collapsed: p.classList.contains("collapsed-panel")
        };
    });

    // 3. Save Standalone Sections & Bars
    const sectionIds = ["cspCommandBar", "brushPropertiesSection", "brushSlidersSection", "brushQuickSizesPanel", "layerSearchContainer"];
    sectionIds.forEach(secId => {
        const secEl = targetDoc.getElementById(secId);
        if (secEl) {
            let isVis = secEl.style.display !== "none" && !secEl.classList.contains("hidden");
            try {
                const win = targetDoc.defaultView || window;
                if (win.getComputedStyle(secEl).display === "none") isVis = false;
            } catch(e) {}
            layout.sections[secId] = {
                visible: isVis,
                collapsed: secEl.classList.contains("collapsed-panel")
            };
        }
    });

    // 4. Save Left Tab State (tools vs graphics)
    const graphicsBody = targetDoc.getElementById("graphicsPanelBody");
    layout.tools.activeTab = (graphicsBody && graphicsBody.style.display !== "none") ? "graphics" : "tools";

    // 5. Write to LocalStorage: both globally and project-specific
    const layoutStr = JSON.stringify(layout);
    localStorage.setItem("logoPanelLayout_global", layoutStr);
    
    const activeProject = window.currentEditingLogo || (typeof currentEditingLogo === "string" ? currentEditingLogo : null);
    if (activeProject) {
        localStorage.setItem("logoPanelLayout_project_" + encodeURIComponent(activeProject), layoutStr);
    }
};

window.restoreLayout = function(doc) {
    const targetDoc = doc || (typeof window.getActiveEditorDoc === "function" ? window.getActiveEditorDoc() : document);
    if (!targetDoc) return;

    let layoutStr = null;
    const activeProject = window.currentEditingLogo || (typeof currentEditingLogo === "string" ? currentEditingLogo : null);
    if (activeProject) {
        layoutStr = localStorage.getItem("logoPanelLayout_project_" + encodeURIComponent(activeProject));
    }
    if (!layoutStr) {
        layoutStr = localStorage.getItem("logoPanelLayout_global") || localStorage.getItem("logoPanelLayout");
    }
    if (!layoutStr) return;
    
    try {
        const layout = JSON.parse(layoutStr);
        
        // 1. Restore Sidebars
        if (layout.sidebars) {
            for (const sidebarId in layout.sidebars) {
                const dock = targetDoc.getElementById(sidebarId);
                const config = layout.sidebars[sidebarId];
                if (dock && config) {
                    if (config.collapsed) {
                        dock.classList.add("collapsed");
                    } else {
                        dock.classList.remove("collapsed");
                    }
                    
                    if (config.width) {
                        dock.style.width = config.width;
                        dock.style.minWidth = config.minWidth || config.width;
                    } else {
                        dock.style.width = "";
                        dock.style.minWidth = "";
                    }
                    
                    if (config.height) {
                        dock.style.height = config.height;
                        dock.style.minHeight = config.minHeight || config.height;
                    } else {
                        dock.style.height = "";
                        dock.style.minHeight = "";
                    }
                    
                    // Panels wieder in gespeicherter Reihenfolge anordnen
                    const contentZone = dock.querySelector('.csp-sidebar-content');
                    if (contentZone && Array.isArray(config.panels)) {
                        config.panels.forEach(panelId => {
                            const panel = targetDoc.getElementById(panelId);
                            if (panel) {
                                contentZone.appendChild(panel);
                            }
                        });
                    }
                    
                    // Pfeilsymbole anpassen
                    const allButtons = targetDoc.querySelectorAll(`button[onclick*="${sidebarId}"]`);
                    allButtons.forEach(button => {
                        const isCollapsed = config.collapsed;
                        if (sidebarId === "logoLeftToolbar") {
                            if (button.classList.contains("csp-collapse-btn")) {
                                button.innerText = isCollapsed ? "▶" : "◀";
                            } else {
                                button.innerText = isCollapsed ? "Werkzeuge ▶" : "◀ Werkzeuge";
                            }
                        } else if (sidebarId === "logoRightToolbar") {
                            if (button.classList.contains("csp-collapse-btn")) {
                                button.innerText = isCollapsed ? "◀" : "▶";
                            } else {
                                button.innerText = isCollapsed ? "◀ Ebenen" : "Ebenen ▶";
                            }
                        } else if (sidebarId === "logoBottomToolbar") {
                            button.innerText = isCollapsed ? "▲" : "▼";
                        }
                    });
                }
            }
        }
        
        // 2. Restore Dockable Panels size & flex & visibility & collapsed
        if (layout.panels) {
            for (const panelId in layout.panels) {
                const panel = targetDoc.getElementById(panelId);
                const config = layout.panels[panelId];
                if (panel && config) {
                    if (config.height) panel.style.height = config.height;
                    if (config.flex) panel.style.flex = config.flex;
                    if (config.visible !== undefined) {
                        if (config.visible) {
                            panel.classList.remove("hidden");
                            panel.style.setProperty("display", "flex", "important");
                        } else {
                            panel.classList.add("hidden");
                            panel.style.setProperty("display", "none", "important");
                        }
                    }
                    if (config.collapsed !== undefined) {
                        panel.classList.toggle("collapsed-panel", !!config.collapsed);
                        const foldBtn = panel.querySelector(".csp-fold-btn");
                        if (foldBtn) foldBtn.innerText = config.collapsed ? "▸" : "▾";
                    }
                }
            }
        }

        // 3. Restore Standalone Sections & Bars
        if (layout.sections) {
            for (const secId in layout.sections) {
                const secEl = targetDoc.getElementById(secId);
                const config = layout.sections[secId];
                if (secEl && config) {
                    if (config.visible !== undefined) {
                        if (config.visible) {
                            secEl.classList.remove("hidden");
                            if (secId === "cspCommandBar" || secId === "brushQuickSizesPanel" || secId === "layerSearchContainer") {
                                secEl.style.setProperty("display", "flex", "important");
                            } else if (secId === "brushPropertiesSection" || secId === "brushSlidersSection") {
                                secEl.style.setProperty("display", "block", "important");
                            } else {
                                secEl.style.removeProperty("display");
                            }
                        } else {
                            secEl.classList.add("hidden");
                            secEl.style.setProperty("display", "none", "important");
                        }
                    }
                    if (config.collapsed !== undefined) {
                        secEl.classList.toggle("collapsed-panel", !!config.collapsed);
                        const foldBtn = secEl.querySelector(".csp-fold-btn");
                        if (foldBtn) foldBtn.innerText = config.collapsed ? "▸" : "▾";
                    }
                }
            }
        }

        // 4. Restore Left Tab (tools vs graphics)
        if (layout.tools && layout.tools.activeTab) {
            const activeTab = layout.tools.activeTab;
            const tabBtn = (activeTab === "graphics") ? targetDoc.getElementById("tabBtnGraphics") : targetDoc.getElementById("tabBtnTools");
            if (typeof window.switchLogoLeftTab === "function") {
                window.switchLogoLeftTab(activeTab, tabBtn, targetDoc);
            }
        }

        // 5. Sicherstellen, dass die Unteransicht (referencePanel) auch bei älteren gespeicherten Layouts sichtbar bleibt
        const refPanel = targetDoc.getElementById("referencePanel");
        if (refPanel) {
            let foundInSaved = false;
            if (layout.sidebars) {
                for (const sId in layout.sidebars) {
                    if (layout.sidebars[sId]?.panels?.includes("referencePanel")) {
                        foundInSaved = true;
                        break;
                    }
                }
            }
            if (!foundInSaved) {
                const rightContentZone = targetDoc.querySelector('#logoRightToolbar .csp-sidebar-content');
                if (rightContentZone && !rightContentZone.contains(refPanel)) {
                    const colorPanelEl = targetDoc.getElementById("colorPanel");
                    if (colorPanelEl && colorPanelEl.parentNode === rightContentZone) {
                        rightContentZone.insertBefore(refPanel, colorPanelEl);
                    } else {
                        rightContentZone.insertBefore(refPanel, rightContentZone.firstChild);
                    }
                }
            }
        }
        
        if (typeof window.initPanelResizers === "function") window.initPanelResizers(targetDoc);
        if (typeof window.updateWindowMenuCheckmarks === "function") window.updateWindowMenuCheckmarks();
    } catch (e) {
        console.error("Fehler beim Wiederherstellen des Layouts:", e);
    }
};

// Workspace Actions Helpers (Zoom & Ebenen verschieben)
window.zoomLogoIn = function() {
    let newScale = Math.min(10.0, logoData.scale * 1.15);
    logoData.scale = newScale;
    if (logoZoomSlider) logoZoomSlider.value = newScale;
    updateLogoTransform();
};

window.zoomLogoOut = function() {
    let newScale = Math.max(0.1, logoData.scale / 1.15);
    logoData.scale = newScale;
    if (logoZoomSlider) logoZoomSlider.value = newScale;
    updateLogoTransform();
};

window.zoomLogoReset = function() {
    logoData.scale = 1.0;
    logoData.x = 50; // default centered offset
    logoData.y = 50;
    if (logoZoomSlider) logoZoomSlider.value = 1.0;
    updateLogoTransform();
};

window.moveActiveLayerUp = function() {
    const index = layers.findIndex(l => l.id === activeLayerId);
    if (index > 0) {
        const temp = layers[index];
        layers[index] = layers[index - 1];
        layers[index - 1] = temp;
        renderLayersUI();
        saveLogoState();
        renderMainCanvas();
    }
};

window.moveActiveLayerDown = function() {
    const index = layers.findIndex(l => l.id === activeLayerId);
    if (index !== -1 && index < layers.length - 1) {
        const temp = layers[index];
        layers[index] = layers[index + 1];
        layers[index + 1] = temp;
        renderLayersUI();
        saveLogoState();
        renderMainCanvas();
    }
};

// 5. Exportrahmen an/aus
window.toggleCropBox = function() {
    isCropBoxVisible = !isCropBoxVisible;
    const btn = document.getElementById("toggleFrameVisBtn");
    if (btn) {
        btn.style.background = isCropBoxVisible ? "#dda16e" : "#444";
        btn.style.color = isCropBoxVisible ? "#000" : "#fff";
    }
    updateCropBoxUI();
};

// 6. Exportrahmen manuell skalieren
window.resizeCropBox = function() {
    const wVal = parseInt(document.getElementById("cropW").value);
    const hVal = parseInt(document.getElementById("cropH").value);
    if (!isNaN(wVal) && !isNaN(hVal)) {
        cropBox.w = Math.max(50, Math.min(wVal, baseWidth - cropBox.x));
        cropBox.h = Math.max(50, Math.min(hVal, baseHeight - cropBox.y));
        updateCropBoxUI();
    }
};

// 7. Komplette Leinwand skalieren (Helper)
function resizeLogoCanvas(newW, newH) {
    if (newW === baseWidth && newH === baseHeight) return;
    
    layers.forEach(layer => {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = newW;
        tempCanvas.height = newH;
        const tempCtx = tempCanvas.getContext("2d");
        tempCtx.drawImage(layer.canvas, 0, 0);
        
        layer.canvas.width = newW;
        layer.canvas.height = newH;
        layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
        layer.ctx.clearRect(0, 0, newW, newH);
        layer.ctx.drawImage(tempCanvas, 0, 0);
    });
    
    baseWidth = newW;
    baseHeight = newH;
    
    const mainLogoCanvas = document.getElementById("mainLogoCanvas");
    if (mainLogoCanvas) {
        mainLogoCanvas.width = newW;
        mainLogoCanvas.height = newH;
    }
    
    draftCanvas.width = newW;
    draftCanvas.height = newH;
    
    if (lassoCanvas) {
        lassoCanvas.width = newW;
        lassoCanvas.height = newH;
    }
    
    if (logoTransformWrapper) {
        logoTransformWrapper.style.width = newW + "px";
        logoTransformWrapper.style.height = newH + "px";
    }
    
    const canvasW = document.getElementById("canvasW");
    const canvasH = document.getElementById("canvasH");
    if (canvasW) canvasW.value = newW;
    if (canvasH) canvasH.value = newH;
    
    cropBox.w = Math.min(cropBox.w, newW - cropBox.x);
    cropBox.h = Math.min(cropBox.h, newH - cropBox.y);
    
    renderMainCanvas();
    saveLogoState();
    updateCropBoxUI();
}

// 8. Leinwand manuell skalieren
window.confirmCanvasResizeInput = function() {
    const wVal = parseInt(document.getElementById("canvasW").value);
    const hVal = parseInt(document.getElementById("canvasH").value);
    if (!isNaN(wVal) && !isNaN(hVal)) {
        resizeLogoCanvas(wVal, hVal);
    }
};

// 9. Leinwand-Größe zurücksetzen
window.resetCanvasSize = function() {
    if (window.originalImageWidth && window.originalImageHeight) {
        resizeLogoCanvas(window.originalImageWidth, window.originalImageHeight);
    }
};

// 10. Werkzeug aktivieren
window.isEraserToggleMode = false;

window.updateEraserBadge = function() {
    const badge = document.getElementById("eraserModeBadge");
    if (!badge) return;
    
    const eligibleTools = ["brush", "airbrush", "raster", "lasso", "fill"];
    const isDrawing = eligibleTools.includes(activeTool);
    
    if (isDrawing) {
        badge.style.display = "flex";
        if (window.isEraserToggleMode) {
            badge.style.background = "rgba(220, 70, 70, 0.95)";
            badge.style.color = "#fff";
            badge.querySelector("span:last-child").textContent = "Radier-Modus (C)";
            const dot = badge.querySelector(".badge-dot");
            if (dot) {
                dot.style.background = "#fff";
                dot.style.color = "#fff";
            }
        } else {
            badge.style.background = "rgba(29, 185, 84, 0.95)";
            badge.style.color = "#000";
            badge.querySelector("span:last-child").textContent = "Zeichnen-Modus (C)";
            const dot = badge.querySelector(".badge-dot");
            if (dot) {
                dot.style.background = "#000";
                dot.style.color = "#000";
            }
        }
    } else {
        badge.style.display = "none";
    }
};

window.setLogoTool = function(tool) {
    previousTool = activeTool;
    activeTool = tool;
    
    const buttons = document.querySelectorAll(".logo-tool-btn");
    buttons.forEach(btn => btn.classList.remove("active"));
    
    const toolToId = {
        "move": "toolMove",
        "layerMove": "toolLayerMove",
        "brush": "toolBrush",
        "airbrush": "toolAirbrush",
        "raster": "toolRaster",
        "eraser": "toolEraser",
        "smudge": "toolSmudge",
        "fill": "toolFill",
        "lasso": "toolLasso",
        "eyedropper": "toolEyedropper",
        "text": "toolText",
        "shape": "toolShape",
        "transform": "toolTransform",
        "gradient": "toolGradient",
        "clone": "toolClone"
    };
    
    if (tool !== "gradient") {
        isDrawingGradient = false;
        gradientStartPos = null;
    }
    
    const targetDoc = (typeof window.getActiveEditorDoc === "function") ? window.getActiveEditorDoc() : document;
    const activeBtnId = toolToId[tool];
    if (activeBtnId) {
        const btn = targetDoc.getElementById(activeBtnId);
        if (btn) btn.classList.add("active");
    }
    
    const frameGrabToggle = targetDoc.getElementById("frameGrabToggle");
    if (frameGrabToggle) {
        frameGrabToggle.checked = (tool === "cropMove");
    }
    
    // Text-Settings-Panel: Beim Aktivieren des Text-Tools einblenden, aber nicht zwangsweise schließen beim Toolwechsel
    const textPanel = targetDoc.getElementById("textSettingsPanel");
    if (textPanel && tool === "text") {
        textPanel.style.display = "flex";
        textPanel.classList.remove("hidden");
        const sidebar = textPanel.closest('.csp-sidebar');
        if (sidebar && sidebar.classList.contains('collapsed')) {
            sidebar.classList.remove('collapsed');
        }
        if (typeof window.updateWindowMenuCheckmarks === "function") {
            window.updateWindowMenuCheckmarks();
        }
    }
    
    // Wenn Text-Tool verlassen: Textbox committen und Toolbar verstecken
    if (tool !== "text") {
        const textBox = targetDoc.getElementById("canvasTextBox");
        if (textBox && textBox.style.display !== "none") {
            commitCanvasText();
        }
        const toolbar = targetDoc.getElementById("textFloatingToolbar");
        if (toolbar) toolbar.style.display = "none";
    }
    
    // Reset eraser toggle mode if switching to non-drawing tool
    const eligibleTools = ["brush", "airbrush", "raster", "lasso", "fill"];
    if (!eligibleTools.includes(tool)) {
        window.isEraserToggleMode = false;
    }
    window.updateEraserBadge();
    
    updateCursor();
    updateCropBoxUI();
};


// 11. Logo Editor / Separates Tablett-Fenster öffnen
window.openLogoEditor = function(sourcePath) {
    if (typeof AppLogger !== 'undefined') {
        AppLogger.info("LogoEditor", `openLogoEditor aufgerufen mit: ${sourcePath}`);
    }
    console.log("📂 openLogoEditor aufgerufen mit:", sourcePath);
    currentEditingLogo = sourcePath;
    window.currentEditingLogo = sourcePath;
    
    // Hide settings modal if open
    const settingsModal = document.getElementById("settingsModal");
    if (settingsModal && !settingsModal.classList.contains("hidden")) {
        window.hadSettingsOpen = true;
        settingsModal.classList.add("hidden");
    } else {
        window.hadSettingsOpen = false;
    }
    
    // Restore project-specific or global layout
    if (typeof window.restoreLayout === "function") window.restoreLayout();
    
    layers = [];
    historyStack = [];
    redoStack = [];
    window.layers = layers;
    window.historyStack = historyStack;
    window.redoStack = redoStack;
    activeLayerId = null;
    layerCounter = 0;
    
    const img = new Image();
    if (window.__tauriRuntime && sourcePath && !sourcePath.startsWith("data:")) {
        img.crossOrigin = "anonymous";
    }
    img.onload = () => {
        baseWidth = img.width;
        baseHeight = img.height;
        window.originalImageWidth = img.width;
        window.originalImageHeight = img.height;
        cropBox = { x: 0, y: 0, w: baseWidth, h: baseHeight };
        logoData = { x: 50, y: 50, scale: 1, isDragging: false, startX: 0, startY: 0 };
        
        // Öffnet das Zeichenprogramm sofort und dauerhaft als völlig eigenständiges Fenster
        window.openPopoutEditorWindow(sourcePath, img);
    };
    img.onerror = (err) => {
        if (typeof AppLogger !== 'undefined') {
            AppLogger.error("LogoEditor", `Fehler beim Laden des Bildes: ${err}`);
        }
        alert("Fehler beim Laden des Bildes: " + err);
    };
    
    if (sourcePath.startsWith("http") || sourcePath.startsWith("data:") || sourcePath.startsWith("file:")) {
        img.src = sourcePath;
    } else {
        try {
            img.src = pathToFileURL(sourcePath).href;
        } catch (e) {
            img.src = "file://" + sourcePath;
        }
    }
};

// 12. Koordinaten-Normalisierung (Mathematisch exakt, mit Zoom/Pan/Ebenen-Scale & Stiftdruck)
function getCanvasPos(e, absolute = false) {
    let wrapper = null;
    if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            wrapper = window.popoutEditorWindow.document.getElementById("logoTransformWrapper");
        } catch(err) {}
    }
    if (!wrapper) {
        wrapper = document.getElementById("logoTransformWrapper");
    }
    if (!wrapper) return { x: 0, y: 0, pressure: 1.0 };
    
    const rect = wrapper.getBoundingClientRect();
    const currentScale = (logoData && logoData.scale > 0) ? logoData.scale : 1;
    const absX = (e.clientX - rect.left) / currentScale;
    const absY = (e.clientY - rect.top) / currentScale;
    
    // Stiftdruck ermitteln (Wacom, Huion, Apple Pencil, Windows Ink)
    let pressure = 1.0;
    if (window.isPenPressureActive !== false && e) {
        if (e.pointerType === "pen") {
            pressure = (e.pressure !== undefined && e.pressure > 0) ? e.pressure : 0.5;
        } else if (e.pressure !== undefined && e.pressure > 0 && e.pressure !== 0.5) {
            // Tablet-Treiber mit kontinuierlichem Druck
            pressure = e.pressure;
        }
    }

    if (absolute) {
        return { x: absX, y: absY, pressure };
    } else {
        const layer = getActiveLayer();
        if (layer) {
            const lScale = (layer.scale && layer.scale > 0) ? layer.scale : 1;
            return {
                x: (absX - (layer.x || 0)) / lScale,
                y: (absY - (layer.y || 0)) / lScale,
                pressure
            };
        }
        return { x: absX, y: absY, pressure };
    }
}

// DOM-Parser: Zerlegt HTML aus dem contenteditable in styled Tokens
function parseHTMLToTokens(htmlString, baseProps) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlString;
    
    const tokens = [];
    
    const initialStyle = {
        bold: baseProps.bold || false,
        italic: baseProps.italic || false,
        underline: baseProps.underline || false,
        color: baseProps.color || "#ffffff",
        font: baseProps.font || "Arial",
        size: baseProps.size || 60,
    };
    
    function walk(node, currentStyle) {
        if (node.nodeType === Node.TEXT_NODE) {
            let text = node.textContent;
            // Zero-Width Space für caret tracking ignorieren, aber sonstige Zeichen behalten
            text = text.replace(/\u200B/g, "");
            if (text.length > 0) {
                tokens.push({
                    text: text,
                    bold: currentStyle.bold,
                    italic: currentStyle.italic,
                    underline: currentStyle.underline,
                    color: currentStyle.color,
                    font: currentStyle.font,
                    size: currentStyle.size
                });
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName;
            
            if (tagName === "BR") {
                tokens.push({ isLineBreak: true });
                return;
            }
            
            const newStyle = { ...currentStyle };
            
            if (tagName === "B" || tagName === "STRONG" || node.style.fontWeight === "bold") {
                newStyle.bold = true;
            }
            if (tagName === "I" || tagName === "EM" || node.style.fontStyle === "italic") {
                newStyle.italic = true;
            }
            if (tagName === "U" || node.style.textDecoration.includes("underline")) {
                newStyle.underline = true;
            }
            if (node.style.color) {
                newStyle.color = node.style.color;
            }
            if (node.style.fontFamily) {
                newStyle.font = node.style.fontFamily.replace(/['"]/g, "");
            }
            if (node.style.fontSize) {
                newStyle.size = parseInt(node.style.fontSize) || currentStyle.size;
            }
            if (tagName === "FONT") {
                const colorAttr = node.getAttribute("color");
                if (colorAttr) newStyle.color = colorAttr;
                const faceAttr = node.getAttribute("face");
                if (faceAttr) newStyle.font = faceAttr;
            }
            
            const isBlock = (tagName === "DIV" || tagName === "P");
            if (isBlock && tokens.length > 0 && !tokens[tokens.length - 1].isLineBreak) {
                tokens.push({ isLineBreak: true });
            }
            
            for (let i = 0; i < node.childNodes.length; i++) {
                walk(node.childNodes[i], newStyle);
            }
            
            if (isBlock && node.nextSibling) {
                if (tokens.length > 0 && !tokens[tokens.length - 1].isLineBreak) {
                    tokens.push({ isLineBreak: true });
                }
            }
        }
    }
    
    for (let i = 0; i < tempDiv.childNodes.length; i++) {
        walk(tempDiv.childNodes[i], initialStyle);
    }
    
    return tokens;
}

// Hilfsfunktion: Text-Ebene neu rendern (synchron und flackerfrei)
function renderTextLayer(layer) {
    if (!layer || !layer.isTextLayer || !layer.textProps) return;
    
    const ctx = layer.ctx;
    const props = layer.textProps;
    
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    
    const size    = props.size       || 60;
    const font    = props.font       || "Arial";
    const bold    = props.bold       || false;
    const italic  = props.italic     || false;
    const color   = props.color      || "#ffffff";
    const opacity = props.opacity    !== undefined ? props.opacity : 1.0;
    const spacing = props.spacing    || 0;
    const align   = props.align      || "left";
    const lh      = props.lineHeight || 1.2;
    const underline   = props.underline   || false;
    const shadow      = props.shadow      || false;
    const shadowColor = props.shadowColor || "rgba(0,0,0,0.5)";
    const shadowBlur  = props.shadowBlur  !== undefined ? props.shadowBlur : 4;
    const shadowOffX  = props.shadowOffsetX !== undefined ? props.shadowOffsetX : 2;
    const shadowOffY  = props.shadowOffsetY !== undefined ? props.shadowOffsetY : 2;
    const effect      = props.effect      || "none";
    
    ctx.save();
    
    // Parse character-level HTML tokens (Fallstein zu plain text)
    const tokens = parseHTMLToTokens(layer.textHTML || layer.textContent || "", props);
    
    // Tokens in Zeilen zerlegen
    const lines = [];
    let currentLine = [];
    tokens.forEach(tok => {
        if (tok.isLineBreak) {
            lines.push(currentLine);
            currentLine = [];
        } else {
            currentLine.push(tok);
        }
    });
    lines.push(currentLine);
    
    // Zeilenbreite für jede Zeile messen
    lines.forEach(line => {
        let w = 0;
        line.forEach(tok => {
            let fontStyle = "";
            if (tok.italic) fontStyle += "italic ";
            if (tok.bold)   fontStyle += "bold ";
            ctx.font = `${fontStyle}${tok.size}px "${tok.font}"`.trim();
            ctx.letterSpacing = spacing + "px";
            w += ctx.measureText(tok.text).width;
        });
        line.width = w;
    });
    
    let currentY = props.y;
    
    // Globaler Text-Schatten (falls aktiv und nicht neon)
    if (shadow && effect !== "neon") {
        ctx.shadowColor   = shadowColor;
        ctx.shadowBlur    = shadowBlur;
        ctx.shadowOffsetX = shadowOffX;
        ctx.shadowOffsetY = shadowOffY;
    }
    
    lines.forEach((line) => {
        if (line.length === 0) {
            currentY += size * lh;
            return;
        }
        
        // Finde die größte Textgröße in dieser Zeile
        const maxLineSize = line.reduce((max, tok) => Math.max(max, tok.size), size);
        const lineH = maxLineSize * lh;
        
        // Start X für Ausrichtung ermitteln
        let drawX = props.x;
        const canvasW = layer.canvas.width;
        if (align === "center") {
            drawX = (canvasW / 2) - (line.width / 2);
        } else if (align === "right") {
            drawX = canvasW - 20 - line.width;
        }
        
        let currentX = drawX;
        
        line.forEach(tok => {
            ctx.save();
            
            let fontStyle = "";
            if (tok.italic) fontStyle += "italic ";
            if (tok.bold)   fontStyle += "bold ";
            ctx.font = `${fontStyle}${tok.size}px "${tok.font}"`.trim();
            ctx.fillStyle = tok.color;
            ctx.textBaseline = "top";
            ctx.textAlign = "left";
            ctx.globalAlpha = parseFloat(opacity);
            ctx.letterSpacing = spacing + "px";
            
            // SYSTEM 2: Premium Text Effects
            if (effect === "neon") {
                ctx.shadowColor = tok.color;
                ctx.shadowBlur = 20;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
                
                ctx.fillText(tok.text, currentX, currentY);
                ctx.shadowBlur = 10;
                ctx.fillText(tok.text, currentX, currentY);
                ctx.shadowBlur = 4;
                ctx.fillText(tok.text, currentX, currentY);
            } 
            else if (effect === "synthwave") {
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
                
                // 3D pink/magenta Schatten zeichnen
                ctx.fillStyle = "#ff007f";
                ctx.fillText(tok.text, currentX + 5, currentY + 5);
                
                // Originaltext zeichnen
                ctx.fillStyle = tok.color;
                ctx.fillText(tok.text, currentX, currentY);
            } 
            else if (effect === "outline") {
                ctx.strokeStyle = tok.color;
                ctx.lineWidth = Math.max(1.5, tok.size / 15);
                ctx.strokeText(tok.text, currentX, currentY);
            } 
            else {
                ctx.fillText(tok.text, currentX, currentY);
            }
            
            // Unterstreichung manuell zeichnen
            if (tok.underline) {
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
                
                const textW = ctx.measureText(tok.text).width;
                ctx.strokeStyle = tok.color;
                ctx.lineWidth = Math.max(1, tok.size / 20);
                ctx.beginPath();
                ctx.moveTo(currentX, currentY + tok.size + 2);
                ctx.lineTo(currentX + textW, currentY + tok.size + 2);
                ctx.stroke();
            }
            
            currentX += ctx.measureText(tok.text).width;
            ctx.restore();
        });
        
        currentY += lineH;
    });
    
    ctx.restore();
}

// 13. Live-Update des Text-Layers aus dem Floating Toolbar
function updateActiveTextLayerFromToolbar() {
    const layer = getActiveLayer();
    if (!layer || !layer.isTextLayer || editingTextLayerId !== null) return;
    
    const textBox = document.getElementById("canvasTextBox");
    if (textBox && textBox.style.display !== "none") return;
    
    const props = getTextPropsFromToolbar();
    Object.assign(layer.textProps, props);
    
    renderTextLayer(layer);
    renderMainCanvas();
}

// Hilfsfunktion: Alle Props aus dem Floating Toolbar auslesen
function getTextPropsFromToolbar() {
    const size        = parseInt(document.getElementById("ttSize")?.value) || 60;
    const font        = document.getElementById("ttFont")?.value || "Arial";
    const bold        = document.getElementById("ttBold")?.classList.contains("tt-active") || false;
    const italic      = document.getElementById("ttItalic")?.classList.contains("tt-active") || false;
    const underline   = document.getElementById("ttUnderline")?.classList.contains("tt-active") || false;
    const shadow      = document.getElementById("ttShadow")?.classList.contains("tt-active") || false;
    const color       = document.getElementById("ttColor")?.value || "#ffffff";
    const lineHeight  = parseFloat(document.getElementById("ttLineHeight")?.value) || 1.2;
    const spacing     = parseFloat(document.getElementById("ttSpacing")?.value) || 0;
    const shadowColor = document.getElementById("ttShadowColor")?.value || "#000000";
    const shadowBlur  = parseFloat(document.getElementById("ttShadowBlur")?.value) || 4;
    const shadowOffX  = parseFloat(document.getElementById("ttShadowX")?.value) || 2;
    const shadowOffY  = parseFloat(document.getElementById("ttShadowY")?.value) || 2;
    const opacity     = parseFloat(document.getElementById("ttOpacity")?.value) || 1.0;
    const effect      = document.getElementById("ttEffect")?.value || "none";
    
    let align = "left";
    if (document.getElementById("ttAlignCenter")?.classList.contains("tt-active")) align = "center";
    else if (document.getElementById("ttAlignRight")?.classList.contains("tt-active")) align = "right";
    
    return { size, font, bold, italic, underline, shadow, color, lineHeight, spacing, 
             align, shadowColor, shadowBlur, shadowOffsetX: shadowOffX, shadowOffsetY: shadowOffY, opacity, effect };
}

// Shadow-Panel Slider Echtzeit-Labels
["ttShadowBlur", "ttShadowX", "ttShadowY"].forEach(id => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + "Val");
    if (el && valEl) {
        el.addEventListener("input", () => {
            valEl.textContent = el.value;
            updateActiveTextLayerFromToolbar();
        });
    }
});
const ttOpacityEl = document.getElementById("ttOpacity");
const ttOpacityValEl = document.getElementById("ttOpacityVal");
if (ttOpacityEl && ttOpacityValEl) {
    ttOpacityEl.addEventListener("input", () => {
        ttOpacityValEl.textContent = Math.round(parseFloat(ttOpacityEl.value) * 100) + "%";
        updateActiveTextLayerFromToolbar();
    });
}



if (logoZoomSlider) {
    logoZoomSlider.addEventListener("input", () => {
        logoData.scale = parseFloat(logoZoomSlider.value);
        updateLogoTransform();
    });
}

// QoL: Pinselgröße und Deckkraft Kreis-Anzeigen dynamisch aktualisieren
if (brushSizeSlider) {
    brushSizeSlider.addEventListener("input", () => {
        const valDiv = document.getElementById("brushSizeVal");
        if (valDiv) valDiv.innerText = brushSizeSlider.value;
        if (typeof BrushEngine !== 'undefined') {
            BrushEngine.updateSettings({ size: parseFloat(brushSizeSlider.value) });
        }
        // Cursor Vorschau synchronisieren
        const preview = document.getElementById("brushCursorPreview");
        if (preview) {
            const size = parseFloat(brushSizeSlider.value);
            preview.style.width = size + "px";
            preview.style.height = size + "px";
        }
    });
    // Initiale Anzeige aktualisieren
    const valDiv = document.getElementById("brushSizeVal");
    if (valDiv) valDiv.innerText = brushSizeSlider.value;
}
if (brushOpacitySlider) {
    brushOpacitySlider.addEventListener("input", () => {
        const valDiv = document.getElementById("brushOpacityVal");
        if (valDiv) valDiv.innerText = Math.round(parseFloat(brushOpacitySlider.value) * 100) + "%";
        if (typeof BrushEngine !== 'undefined') {
            BrushEngine.updateSettings({ opacity: parseFloat(brushOpacitySlider.value) });
        }
    });
    // Initiale Anzeige aktualisieren
    const valDiv = document.getElementById("brushOpacityVal");
    if (valDiv) valDiv.innerText = Math.round(parseFloat(brushOpacitySlider.value) * 100) + "%";
}

const brushHardnessSlider = document.getElementById("brushHardness");
if (brushHardnessSlider) {
    brushHardnessSlider.addEventListener("input", () => {
        const valDiv = document.getElementById("brushHardnessVal");
        if (valDiv) valDiv.innerText = Math.round(parseFloat(brushHardnessSlider.value) * 100) + "%";
        if (typeof BrushEngine !== 'undefined') {
            BrushEngine.updateSettings({ hardness: parseFloat(brushHardnessSlider.value) });
        }
    });
    const valDiv = document.getElementById("brushHardnessVal");
    if (valDiv) valDiv.innerText = Math.round(parseFloat(brushHardnessSlider.value) * 100) + "%";
}

const brushSmoothingSlider = document.getElementById("brushSmoothing");
if (brushSmoothingSlider) {
    brushSmoothingSlider.addEventListener("input", () => {
        const valDiv = document.getElementById("brushSmoothingVal");
        if (valDiv) valDiv.innerText = Math.round(parseFloat(brushSmoothingSlider.value) * 100) + "%";
        if (typeof BrushEngine !== 'undefined') {
            BrushEngine.updateSettings({ smoothing: parseFloat(brushSmoothingSlider.value) });
        }
    });
    const valDiv = document.getElementById("brushSmoothingVal");
    if (valDiv) valDiv.innerText = Math.round(parseFloat(brushSmoothingSlider.value) * 100) + "%";
}

// QoL: Mausrad-Zoom und Alt + Mausrad für Pinselgröße auf dem Arbeitsbereich
if (logoCropContainer) {
    logoCropContainer.addEventListener("wheel", (e) => {
        const logoModal = document.getElementById("logoEditorModal");
        const isLogoModalOpen = logoModal && !logoModal.classList.contains("hidden");
        if (!isLogoModalOpen) return;
        
        e.preventDefault();
        
        if (e.altKey) {
            // ALT + Scrollen: Pinselgröße ändern
            let currentSize = parseInt(brushSizeSlider.value);
            currentSize += e.deltaY < 0 ? 2 : -2;
            currentSize = Math.max(1, Math.min(150, currentSize));
            brushSizeSlider.value = currentSize;
            brushSizeSlider.dispatchEvent(new Event("input"));
        } else {
            // Normales Scrollen: Professionelles Zoomen auf Mausposition (wie Photoshop/Krita)
            const rect = logoCropContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            // Relativer Punkt im Wrapper vor dem Zoomen ermitteln
            const wrapperX = (mouseX - logoData.x) / logoData.scale;
            const wrapperY = (mouseY - logoData.y) / logoData.scale;
            
            let newScale = logoData.scale;
            if (e.deltaY < 0) {
                newScale = Math.min(10.0, logoData.scale * 1.1); // Ranzoomen
            } else {
                newScale = Math.max(0.1, logoData.scale / 1.1); // Rauszoomen
            }
            
            // X und Y so anpassen, dass der relative Punkt exakt unter der Maus bleibt
            logoData.x = mouseX - wrapperX * newScale;
            logoData.y = mouseY - wrapperY * newScale;
            logoData.scale = newScale;
            
            if (logoZoomSlider) {
                logoZoomSlider.value = newScale;
            }
            updateLogoTransform();
        }
    }, { passive: false });
}

// ============================================================
// DYNAMISCHE PINSEL-CURSOR VORSCHAU & STIFTDRUCK-TRACKING
// ============================================================
function updateBrushCursorTracker(e, targetDoc = document) {
    if (!e) return;
    const isPopout = targetDoc !== document;
    const logoModal = targetDoc.getElementById("logoEditorModal");
    const isModalVisible = isPopout || (logoModal && !logoModal.classList.contains("hidden"));
    if (!isModalVisible) return;

    const preview = targetDoc.getElementById("brushCursorPreview");
    if (!preview) return;

    const isDrawingTool = activeTool === "brush" || activeTool === "airbrush" || 
                         activeTool === "eraser" || activeTool === "smudge" || 
                         activeTool === "clone";

    const container = targetDoc.getElementById("logoCropContainer");

    if (!isDrawingTool || isSpaceDown || (typeof spaceHeld !== "undefined" && spaceHeld)) {
        preview.style.display = "none";
        if (container) {
            container.style.cursor = isSpaceDown ? (logoData && logoData.isDragging ? "grabbing" : "grab") : "default";
        }
        return;
    }

    if (container) {
        container.style.cursor = "none";
    }

    const canvasPos = getCanvasPos(e, true);
    preview.style.display = "block";
    preview.style.left = canvasPos.x + "px";
    preview.style.top = canvasPos.y + "px";

    // Pinselgröße ermitteln
    const sizeInp = targetDoc.getElementById("brushSize") || brushSizeSlider;
    const baseSize = Math.max(2, parseFloat(sizeInp ? sizeInp.value : 20));

    // Stiftdruck ermitteln (e.pressure oder canvasPos.pressure)
    let pressure = 1.0;
    if (canvasPos && typeof canvasPos.pressure === "number") {
        pressure = canvasPos.pressure;
    } else if (e.pressure !== undefined && e.pressure > 0) {
        pressure = e.pressure;
    }

    const isDrawingNow = (e.buttons > 0 || (e.pressure !== undefined && e.pressure > 0 && e.pointerType === "pen"));
    const minRatio = (typeof BrushEngine !== "undefined" && BrushEngine.settings) ? 
                     BrushEngine.settings.minPressureRatio : 0.08;

    // Druckstufen-Faktor: Wenn gezeichnet/gedrückt wird, reagiert der innere Ring live
    const pressureFactor = isDrawingNow
        ? Math.max(minRatio, minRatio + (1 - minRatio) * Math.pow(pressure, 1.1))
        : 1.0;
    const pressureDiameter = Math.max(2, baseSize * pressureFactor);

    // DOM-Ringe aktualisieren
    let outerRing = preview.querySelector(".bcp-outer-ring");
    let innerPressure = preview.querySelector(".bcp-inner-pressure");

    // Falls die Unter-Elemente noch nicht im DOM existieren:
    if (!outerRing || !innerPressure) {
        preview.innerHTML = `
            <div class="bcp-outer-ring"></div>
            <div class="bcp-inner-pressure"></div>
            <div class="bcp-center-dot"></div>
        `;
        outerRing = preview.querySelector(".bcp-outer-ring");
        innerPressure = preview.querySelector(".bcp-inner-pressure");
    }

    // Äußerer Ring: Maximale Pinselgröße
    if (outerRing) {
        outerRing.style.width = baseSize + "px";
        outerRing.style.height = baseSize + "px";
    }

    // Innerer Ring: Aktuelle Druckstufe (skaliert dynamisch in Echtzeit)
    if (innerPressure) {
        innerPressure.style.width = pressureDiameter + "px";
        innerPressure.style.height = pressureDiameter + "px";
        innerPressure.style.opacity = isDrawingNow ? "1" : "0.45";
        const activeColor = colorPicker ? colorPicker.value : "var(--accent, #1db954)";
        innerPressure.style.borderColor = activeTool === "eraser" ? "#ff5555" : activeColor;
        innerPressure.style.backgroundColor = activeTool === "eraser" 
            ? "rgba(255, 85, 85, 0.25)" 
            : `color-mix(in srgb, ${activeColor} 25%, transparent)`;
    }
}
window.updateBrushCursorTracker = updateBrushCursorTracker;

if (logoCropContainer) {
    logoCropContainer.addEventListener("pointermove", (e) => updateBrushCursorTracker(e, document));
    logoCropContainer.addEventListener("mousemove", (e) => updateBrushCursorTracker(e, document));
    logoCropContainer.addEventListener("pointerenter", (e) => updateBrushCursorTracker(e, document));
    logoCropContainer.addEventListener("pointerleave", () => {
        const preview = document.getElementById("brushCursorPreview");
        if (preview) preview.style.display = "none";
        logoCropContainer.style.cursor = "default";
    });
}

let lassoCtx = lassoCanvas.getContext("2d");

let layers = [];
try {
    Object.defineProperty(window, 'layers', {
        get: () => layers,
        set: (v) => { layers = v; },
        configurable: true
    });
} catch(e) {}

let transformState = {
    mode: null,          // "rotate", "scale-tl/tr/br/bl", "skew-l/r/t/b", "move"
    initialX: 0, initialY: 0,
    initialScale: 1, initialRotate: 0, initialSkewX: 0, initialSkewY: 0,
    startMouseX: 0, startMouseY: 0,
    center: { x: 0, y: 0 }
};
let modalLayerBackup = null;
let modalLayerId = null;
let activeLayerId = null;
try {
    Object.defineProperty(window, 'activeLayerId', {
        get: () => activeLayerId,
        set: (v) => { activeLayerId = v; },
        configurable: true
    });
} catch(e) {}
let layerCounter = 0;
let baseWidth = 500;
let baseHeight = 500;
let historyStack = [];
let redoStack = [];
const draftCanvas = document.createElement("canvas");
const draftCtx = draftCanvas.getContext("2d");
let dragLayerData = null; 

// --- NEUER HAUPT-CANVAS FÜR COMPOSITING (CLIPPING MASK FIX) ---
function renderMainCanvas() {
    const edDoc = getActiveEditorDoc();
    const targetCanvases = [];
    const mainCanvasEd = edDoc.getElementById("mainLogoCanvas");
    if (mainCanvasEd) targetCanvases.push(mainCanvasEd);
    const mainCanvasTop = document.getElementById("mainLogoCanvas");
    if (mainCanvasTop && mainCanvasTop !== mainCanvasEd) targetCanvases.push(mainCanvasTop);
    if (targetCanvases.length === 0) return;

    // Wir rendern von unten nach oben, also Array umdrehen
    const reversed = [...layers].reverse();

    // Gruppiere Ebenen für echte Schnittmasken (Photoshop-Stil)
    let groups = [];
    let currentGroup = null;

    reversed.forEach((layer) => {
        if (!layer.visible) return;

        // Eine Schnittmaske (clippedToBelow === true) gehört zur Gruppe der ersten darunterliegenden Basis-Ebene
        if (layer.clippedToBelow && currentGroup) {
            currentGroup.clipped.push(layer);
        } else {
            // Basis-Ebene (nicht geclipped, oder die unterste Ebene im Stapel)
            currentGroup = {
                base: layer,
                clipped: []
            };
            groups.push(currentGroup);
        }
    });

    function drawLayerToCtx(ctx, l, ox = 0, oy = 0) {
        ctx.save();
        ctx.globalAlpha = l.opacity !== undefined ? l.opacity : 1;

        // Apply filters
        let filterParts = [];
        if (l.brightness !== undefined && l.brightness !== 1) filterParts.push(`brightness(${l.brightness})`);
        if (l.contrast !== undefined && l.contrast !== 1) filterParts.push(`contrast(${l.contrast})`);
        if (l.saturation !== undefined && l.saturation !== 1) filterParts.push(`saturate(${l.saturation})`);
        if (l.blur !== undefined && l.blur !== 0) filterParts.push(`blur(${l.blur}px)`);
        
        if (filterParts.length > 0) {
            ctx.filter = filterParts.join(" ");
        } else {
            ctx.filter = "none";
        }

        const dw = l.canvas.width * (l.scale || 1);
        const dh = l.canvas.height * (l.scale || 1);

        const cx = (l.x - ox) + dw / 2;
        const cy = (l.y - oy) + dh / 2;
        ctx.translate(cx, cy);

        if (l.rotate) {
            ctx.rotate(l.rotate);
        }
        if (l.skewX || l.skewY) {
            ctx.transform(1, Math.tan(l.skewY || 0), Math.tan(l.skewX || 0), 1, 0, 0);
        }
        if (l.flipH || l.flipV) {
            ctx.scale(l.flipH ? -1 : 1, l.flipV ? -1 : 1);
        }
        
        ctx.drawImage(l.canvas, -dw / 2, -dh / 2, dw, dh);

        ctx.restore();
    }

    targetCanvases.forEach(mainLogoCanvas => {
        const mCtx = mainLogoCanvas.getContext("2d");
        mCtx.clearRect(0, 0, baseWidth, baseHeight);

        groups.forEach(group => {
            const baseLayer = group.base;

            if (group.clipped.length === 0) {
                // Normales Zeichnen einer einzelnen Ebene ohne Schnittmaske
                mCtx.save();
                mCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
                drawLayerToCtx(mCtx, baseLayer);
                mCtx.restore();
            } else {
                // Wir haben eine Schnittmaskengruppe! 
                // Erstelle temporären Offscreen-Canvas für die Gruppe
                const tempCanvas = document.createElement("canvas");
                tempCanvas.width = baseWidth;
                tempCanvas.height = baseHeight;
                const tempCtx = tempCanvas.getContext("2d");

                // 1. Basis-Ebene auf den temporären Canvas zeichnen
                drawLayerToCtx(tempCtx, baseLayer);

                // 2. Jede darüberliegende Schnittmaske mit source-atop drüberzeichnen
                group.clipped.forEach(clippedLayer => {
                    tempCtx.save();
                    tempCtx.globalCompositeOperation = "source-atop";
                    drawLayerToCtx(tempCtx, clippedLayer);
                    tempCtx.restore();
                });

                // 3. Den temporären Canvas mit dem BlendMode der Basis-Ebene auf den Hauptcanvas zeichnen
                mCtx.save();
                mCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
                mCtx.drawImage(tempCanvas, 0, 0);
                mCtx.restore();
            }
        });

        if (isDrawing && (activeTool === "brush" || activeTool === "airbrush")) {
            if (!window.isEraserToggleMode) {
                const opacity = getActiveBrushOpacity();
                mCtx.globalAlpha = opacity;
                mCtx.drawImage(draftCanvas, 0, 0);
                mCtx.globalAlpha = 1.0;
            }
        }
    });

    // Call transform overlay render if transform tool is active
    if (activeTool === "transform") {
        drawTransformOverlay();
    } else {
        if (lassoCtx && activeTool !== "lasso" && (!lassoPoints || lassoPoints.length === 0)) {
            lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        }
    }

    if (typeof window.updateNavigatorUI === "function") {
        window.updateNavigatorUI();
    }
}
window.renderMainCanvas = renderMainCanvas;

// ---------------------------------------------------------
// =========================================================
// FARBRAD & FARBPICKER (Clip Studio Paint Engine: Kreis- & Dreieck-Modus)
// =========================================================
let hsv = { h: 140, s: 85, v: 72 };
let colorWheelMode = localStorage.getItem("colorWheelMode") || "circle"; // "circle" oder "triangle"
let draggingArea = null; // 'ring' | 'inner'
let activeDraggingCanvas = null;

function hsvToHex(h, s, v) {
    s /= 100; v /= 100;
    let c = v * s;
    let x = c * (1 - Math.abs((h / 60) % 2 - 1));
    let m = v - c;
    let r = 0, g = 0, b = 0;
    
    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else if (300 <= h && h <= 360) { r = c; g = 0; b = x; }
    
    r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
    g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
    b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

function hexToHsv(hex) {
    if (!hex || hex.length < 7) return { h: 140, s: 85, v: 72 };
    let r = parseInt(hex.slice(1,3), 16) / 255;
    let g = parseInt(hex.slice(3,5), 16) / 255;
    let b = parseInt(hex.slice(5,7), 16) / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    let d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) { h = 0; } 
    else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
}

function hsvToRgbObj(h, s, v) {
    s /= 100; v /= 100;
    let c = v * s;
    let x = c * (1 - Math.abs((h / 60) % 2 - 1));
    let m = v - c;
    let r = 0, g = 0, b = 0;
    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else if (300 <= h && h <= 360) { r = c; g = 0; b = x; }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

function getActiveColorWheelCanvases() {
    const list = [];
    const mainCanvas = document.getElementById("colorWheelCanvas");
    if (mainCanvas) list.push({ canvas: mainCanvas, doc: document, win: window });
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            const popCanvas = window.popoutEditorWindow.document.getElementById("colorWheelCanvas");
            if (popCanvas && popCanvas !== mainCanvas) {
                list.push({ canvas: popCanvas, doc: window.popoutEditorWindow.document, win: window.popoutEditorWindow });
            }
        } catch (e) {}
    }
    return list;
}

window.toggleColorWheelMode = function() {
    colorWheelMode = (colorWheelMode === "circle") ? "triangle" : "circle";
    localStorage.setItem("colorWheelMode", colorWheelMode);
    updateColorWheelModeButtonUI();
    drawCSPColorWheel();
};

function updateColorWheelModeButtonUI() {
    const docs = [document];
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try { docs.push(window.popoutEditorWindow.document); } catch (e) {}
    }
    const isCircle = (colorWheelMode === "circle");
    for (const d of docs) {
        const btn = d.getElementById("colorWheelModeBtn");
        const icon = d.getElementById("colorWheelModeIcon");
        const text = d.getElementById("colorWheelModeText");
        if (icon) icon.textContent = isCircle ? "⚪" : "🔺";
        if (text) text.textContent = isCircle ? "Kreis" : "Dreieck";
        if (btn) btn.title = isCircle ? "Farbrad-Modus: Kreis-Form (Klicken für Dreieck)" : "Farbrad-Modus: Dreieck-Form (Klicken für Kreis)";
    }
}

function applyColorWheelSelection() {
    const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
    const docs = [document];
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try { docs.push(window.popoutEditorWindow.document); } catch (e) {}
    }

    for (const d of docs) {
        const picker = d.getElementById("logoColorPicker");
        if (picker) picker.value = hex;
        const curDisplay = d.getElementById("currentColorDisplay");
        if (curDisplay) curDisplay.style.backgroundColor = hex;
        const valHEl = d.getElementById("valH");
        if (valHEl) valHEl.innerText = hex.toUpperCase();
        const hexInp = d.getElementById('csHexInput');
        if (hexInp && d.activeElement !== hexInp) hexInp.value = hex.toUpperCase();
        const csPreview = d.getElementById('csColorPreview');
        if (csPreview) csPreview.style.backgroundColor = hex;
    }

    drawCSPColorWheel();

    if (typeof window.updateActiveLayerColor === "function") {
        window.updateActiveLayerColor(hex);
    }

    if (typeof window.syncColorSlidersFromActive === "function") {
        window.syncColorSlidersFromActive();
    }
    if (typeof window.recordColorToHistory === "function") {
        window.recordColorToHistory(hex);
    }
    if (typeof BrushEngine !== 'undefined' && BrushEngine.updateSettings) {
        BrushEngine.updateSettings({ color: hex });
    }
}
window.applyColorWheelSelection = applyColorWheelSelection;
window.drawCSPColorWheel = drawCSPColorWheel;
window.hexToHsv = hexToHsv;

function applyGlobalColor(hex) {
    if (!hex || typeof hex !== 'string') return;
    hex = hex.toUpperCase();
    if (!hex.startsWith('#')) hex = '#' + hex;

    const docs = [document];
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) {
        try { docs.push(window.popoutEditorWindow.document); } catch (e) {}
    }

    for (const d of docs) {
        const picker = d.getElementById('logoColorPicker');
        const curDisplay = d.getElementById('currentColorDisplay');
        const valHEl = d.getElementById('valH');
        const hexInp = d.getElementById('csHexInput');
        const csPreview = d.getElementById('csColorPreview');

        if (picker) picker.value = hex;
        if (curDisplay) curDisplay.style.backgroundColor = hex;
        if (valHEl) valHEl.innerText = hex;
        if (hexInp && d.activeElement !== hexInp) hexInp.value = hex;
        if (csPreview) csPreview.style.backgroundColor = hex;
    }

    if (typeof window.hexToHsv === 'function') {
        window.hsv = window.hexToHsv(hex);
        if (typeof window.drawCSPColorWheel === 'function') {
            window.drawCSPColorWheel();
        }
    }

    if (typeof window.updateActiveLayerColor === 'function') {
        window.updateActiveLayerColor(hex);
    }

    if (typeof window.syncColorSlidersFromActive === 'function') {
        window.syncColorSlidersFromActive();
    }
    if (typeof window.recordColorToHistory === 'function') {
        window.recordColorToHistory(hex);
    }
    if (typeof BrushEngine !== 'undefined' && BrushEngine.updateSettings) {
        BrushEngine.updateSettings({ color: hex });
    }
}
window.applyGlobalColor = applyGlobalColor;
window.hsvToHex = hsvToHex;

function drawCSPColorWheel() {
    const targets = getActiveColorWheelCanvases();
    if (targets.length === 0) return;

    for (const { canvas } of targets) {
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        const w = canvas.width || 200;
        const h = canvas.height || 200;
        const cx = w / 2;
        const cy = h / 2;
        const outerRadius = 96;
        const innerRadius = 74;

        ctx.clearRect(0, 0, w, h);

        // Äußerer Farbton-Ring
        for (let angle = 0; angle < 360; angle++) {
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, outerRadius, (angle - 0.5) * Math.PI / 180, (angle + 1.5) * Math.PI / 180);
            ctx.lineTo(cx, cy);
            ctx.fillStyle = `hsl(${angle}, 100%, 50%)`;
            ctx.fill();
        }

        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";

        ctx.beginPath();
        ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Farbton-Marker auf dem Ring
        const hueAngle = hsv.h * Math.PI / 180;
        const indRadius = (innerRadius + outerRadius) / 2;
        const indX = cx + Math.cos(hueAngle) * indRadius;
        const indY = cy + Math.sin(hueAngle) * indRadius;

        ctx.beginPath();
        ctx.arc(indX, indY, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 2;
        ctx.stroke();

        if (colorWheelMode === "triangle") {
            // DREIECK-MODUS (Clip Studio Paint / SAI Style)
            const R_tri = 70;
            const Phue = {
                x: cx + R_tri * Math.cos(hueAngle),
                y: cy + R_tri * Math.sin(hueAngle)
            };
            const M = {
                x: cx - (R_tri * 0.5) * Math.cos(hueAngle),
                y: cy - (R_tri * 0.5) * Math.sin(hueAngle)
            };
            const wTri = (Math.sqrt(3) / 2) * R_tri;
            const Pwhite = {
                x: M.x + wTri * Math.sin(hueAngle),
                y: M.y - wTri * Math.cos(hueAngle)
            };
            const Pblack = {
                x: M.x - wTri * Math.sin(hueAngle),
                y: M.y + wTri * Math.cos(hueAngle)
            };

            const imgData = ctx.getImageData(0, 0, w, h);
            const data = imgData.data;
            const v0x = Pblack.x - Pwhite.x, v0y = Pblack.y - Pwhite.y;
            const v1x = Phue.x - Pwhite.x, v1y = Phue.y - Pwhite.y;
            const denom = v0x * v1y - v1x * v0y;
            const pureHueRgb = hsvToRgbObj(hsv.h, 100, 100);

            const minX = Math.max(0, Math.floor(Math.min(Phue.x, Pwhite.x, Pblack.x) - 1));
            const maxX = Math.min(w, Math.ceil(Math.max(Phue.x, Pwhite.x, Pblack.x) + 1));
            const minY = Math.max(0, Math.floor(Math.min(Phue.y, Pwhite.y, Pblack.y) - 1));
            const maxY = Math.min(h, Math.ceil(Math.max(Phue.y, Pwhite.y, Pblack.y) + 1));

            for (let py = minY; py < maxY; py++) {
                for (let px = minX; px < maxX; px++) {
                    const v2x = px - Pwhite.x, v2y = py - Pwhite.y;
                    const lBlack = (v2x * v1y - v1x * v2y) / denom;
                    const lHue = (v0x * v2y - v2x * v0y) / denom;
                    const lWhite = 1 - lBlack - lHue;

                    if (lBlack >= -0.01 && lHue >= -0.01 && lWhite >= -0.01) {
                        const clB = Math.max(0, lBlack);
                        const clH = Math.max(0, lHue);
                        const clW = Math.max(0, lWhite);
                        const sum = clB + clH + clW;
                        const nB = clB / sum, nH = clH / sum, nW = clW / sum;

                        const r = Math.round(nH * pureHueRgb.r + nW * 255);
                        const g = Math.round(nH * pureHueRgb.g + nW * 255);
                        const b = Math.round(nH * pureHueRgb.b + nW * 255);

                        const idx = (py * w + px) * 4;
                        data[idx] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = 255;
                    }
                }
            }
            ctx.putImageData(imgData, 0, 0);

            ctx.beginPath();
            ctx.moveTo(Phue.x, Phue.y);
            ctx.lineTo(Pwhite.x, Pwhite.y);
            ctx.lineTo(Pblack.x, Pblack.y);
            ctx.closePath();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const lBlack = 1 - (hsv.v / 100);
            const lHue = (hsv.s / 100) * (hsv.v / 100);
            const lWhite = (1 - hsv.s / 100) * (hsv.v / 100);
            const hx = lHue * Phue.x + lWhite * Pwhite.x + lBlack * Pblack.x;
            const hy = lHue * Phue.y + lWhite * Pwhite.y + lBlack * Pblack.y;

            ctx.beginPath();
            ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            ctx.fillStyle = (hsv.v > 65 && hsv.s < 45) ? "#000" : "#fff";
            ctx.fill();
            ctx.strokeStyle = (hsv.v > 65 && hsv.s < 45) ? "#fff" : "#000";
            ctx.lineWidth = 2;
            ctx.stroke();

        } else {
            // KREIS-MODUS
            const R_disc = 67;
            
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, R_disc, 0, Math.PI * 2);
            ctx.clip();

            ctx.fillStyle = `hsl(${hsv.h}, 100%, 50%)`;
            ctx.fillRect(cx - R_disc, cy - R_disc, R_disc * 2, R_disc * 2);

            const gradWhite = ctx.createLinearGradient(cx - R_disc, cy, cx + R_disc, cy);
            gradWhite.addColorStop(0, "rgba(255, 255, 255, 1)");
            gradWhite.addColorStop(1, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = gradWhite;
            ctx.fillRect(cx - R_disc, cy - R_disc, R_disc * 2, R_disc * 2);

            const gradBlack = ctx.createLinearGradient(cx, cy + R_disc, cx, cy - R_disc);
            gradBlack.addColorStop(0, "rgba(0, 0, 0, 1)");
            gradBlack.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = gradBlack;
            ctx.fillRect(cx - R_disc, cy - R_disc, R_disc * 2, R_disc * 2);
            ctx.restore();

            ctx.beginPath();
            ctx.arc(cx, cy, R_disc, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const nx = (hsv.s / 100) * 2 - 1;
            const ny = 1 - (hsv.v / 100) * 2;
            let hx = cx + nx * (R_disc - 2);
            let hy = cy + ny * (R_disc - 2);

            const distCenter = Math.hypot(hx - cx, hy - cy);
            if (distCenter > R_disc - 3) {
                hx = cx + ((hx - cx) / distCenter) * (R_disc - 3);
                hy = cy + ((hy - cy) / distCenter) * (R_disc - 3);
            }

            ctx.beginPath();
            ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            ctx.fillStyle = (hsv.v > 65 && hsv.s < 45) ? "#000" : "#fff";
            ctx.fill();
            ctx.strokeStyle = (hsv.v > 65 && hsv.s < 45) ? "#fff" : "#000";
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }
}

function handleColorWheelPointerEvent(e, canvas) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const outerRadius = 96;
    const innerRadius = 74;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);

    if (e.type === "pointerdown" || e.type === "mousedown") {
        if (dist >= innerRadius - 4 && dist <= outerRadius + 8) {
            draggingArea = 'ring';
        } else if (dist < innerRadius) {
            draggingArea = 'inner';
        } else {
            draggingArea = null;
        }
        activeDraggingCanvas = canvas;
    }

    if (!draggingArea) return;

    if (draggingArea === 'ring') {
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        hsv.h = angle;
    } else if (draggingArea === 'inner') {
        if (colorWheelMode === "triangle") {
            const hueAngle = hsv.h * Math.PI / 180;
            const R_tri = 70;
            const Phue = { x: cx + R_tri * Math.cos(hueAngle), y: cy + R_tri * Math.sin(hueAngle) };
            const M = { x: cx - (R_tri * 0.5) * Math.cos(hueAngle), y: cy - (R_tri * 0.5) * Math.sin(hueAngle) };
            const wTri = (Math.sqrt(3) / 2) * R_tri;
            const Pwhite = { x: M.x + wTri * Math.sin(hueAngle), y: M.y - wTri * Math.cos(hueAngle) };
            const Pblack = { x: M.x - wTri * Math.sin(hueAngle), y: M.y + wTri * Math.cos(hueAngle) };

            const v0x = Pblack.x - Pwhite.x, v0y = Pblack.y - Pwhite.y;
            const v1x = Phue.x - Pwhite.x, v1y = Phue.y - Pwhite.y;
            const denom = v0x * v1y - v1x * v0y;

            const v2x = x - Pwhite.x, v2y = y - Pwhite.y;
            let lBlack = (v2x * v1y - v1x * v2y) / denom;
            let lHue = (v0x * v2y - v2x * v0y) / denom;
            let lWhite = 1 - lBlack - lHue;

            lBlack = Math.max(0, lBlack);
            lHue = Math.max(0, lHue);
            lWhite = Math.max(0, lWhite);
            const sum = lBlack + lHue + lWhite;
            if (sum > 0) {
                lBlack /= sum;
                lHue /= sum;
                lWhite /= sum;
            }

            const V = Math.max(0, Math.min(100, (1 - lBlack) * 100));
            const S = (V > 0) ? Math.max(0, Math.min(100, (lHue / (1 - lBlack)) * 100)) : 0;
            hsv.s = Math.round(S);
            hsv.v = Math.round(V);
        } else {
            const R_disc = 67;
            let cdx = dx, cdy = dy;
            const cdist = Math.hypot(cdx, cdy);
            if (cdist > R_disc) {
                cdx = (cdx / cdist) * R_disc;
                cdy = (cdy / cdist) * R_disc;
            }
            const nx = cdx / R_disc;
            const ny = cdy / R_disc;
            const S = Math.max(0, Math.min(100, ((nx + 1) / 2) * 100));
            const V = Math.max(0, Math.min(100, (1 - (ny + 1) / 2) * 100));
            hsv.s = Math.round(S);
            hsv.v = Math.round(V);
        }
    }

    applyColorWheelSelection();
}

function bindColorWheelEvents(targetDoc, targetWin) {
    if (!targetDoc) return;
    const canvas = targetDoc.getElementById("colorWheelCanvas");
    if (!canvas) return;

    canvas.addEventListener("pointerdown", (e) => {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        handleColorWheelPointerEvent(e, canvas);
    });

    canvas.addEventListener("pointermove", (e) => {
        if (draggingArea) handleColorWheelPointerEvent(e, canvas);
    });

    const releaseHandler = (e) => {
        if (draggingArea) {
            try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
            draggingArea = null;
            activeDraggingCanvas = null;
        }
    };
    canvas.addEventListener("pointerup", releaseHandler);
    canvas.addEventListener("pointercancel", releaseHandler);
    if (targetWin) {
        targetWin.addEventListener("pointerup", releaseHandler);
        targetWin.addEventListener("mouseup", releaseHandler);
    }

    const picker = targetDoc.getElementById("logoColorPicker");
    if (picker) {
        picker.addEventListener("input", (e) => {
            hsv = hexToHsv(e.target.value);
            applyColorWheelSelection();
        });
    }
}

// Initialisierung im Hauptfenster
bindColorWheelEvents(document, window);
updateColorWheelModeButtonUI();
setTimeout(drawCSPColorWheel, 100);

window.deleteActiveLayer = function() {
    if (activeLayerId !== null && typeof deleteLayer === "function") {
        deleteLayer(activeLayerId);
    }
};

// ---------------------------------------------------------
// PIPETTE
// ---------------------------------------------------------
function pickColorFromView(pos) {
    const tempCanvas = document.createElement('canvas'); tempCanvas.width = 1; tempCanvas.height = 1;
    const tCtx = tempCanvas.getContext('2d');
    const reversedLayers = [...layers].reverse();
    
    reversedLayers.forEach(l => {
        if(l.visible) {
            tCtx.globalAlpha = l.opacity; 
            tCtx.globalCompositeOperation = l.blendMode === "source-over" ? "normal" : l.blendMode;
            tCtx.drawImage(l.canvas, -pos.x + l.x, -pos.y + l.y);
        }
    });
    
    const data = tCtx.getImageData(0,0,1,1).data;
    if(data[3] > 0) { 
        const hex = "#" + (1 << 24 | data[0] << 16 | data[1] << 8 | data[2]).toString(16).slice(1);
        
        if (colorPicker) colorPicker.value = hex;
        if (currentColorDisplay) currentColorDisplay.style.backgroundColor = hex;
        
        const valHEl = document.getElementById("valH");
        if(valHEl) valHEl.innerText = hex.toUpperCase();
        
        if (typeof hexToHsv === "function") {
            hsv = hexToHsv(hex);
            drawCSPColorWheel();
        }
        
        window.updateActiveLayerColor(hex);
        if (typeof window.syncColorSlidersFromActive === "function") window.syncColorSlidersFromActive();
        if (typeof window.recordColorToHistory === "function") window.recordColorToHistory(hex);
    }
}

// ---------------------------------------------------------
// EBENEN VERWALTUNG & RECHTSKLICK-MENÜ
// ---------------------------------------------------------
let contextLayerId = null;
const layerContextMenu = document.getElementById("layerContextMenu");
let editingTextLayerId = null; 
let savedSelectionRange = null;

function saveTextBoxSelection() {
    const textBox = document.getElementById("canvasTextBox");
    if (!textBox || textBox.style.display === "none") return;
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && textBox.contains(sel.anchorNode)) {
        savedSelectionRange = sel.getRangeAt(0);
    }
}

function restoreTextBoxSelection() {
    const textBox = document.getElementById("canvasTextBox");
    if (!textBox || textBox.style.display === "none") return;
    
    textBox.focus();
    
    const sel = window.getSelection();
    if (savedSelectionRange && textBox.contains(savedSelectionRange.commonAncestorContainer)) {
        sel.removeAllRanges();
        sel.addRange(savedSelectionRange);
    } else {
        // Fallback: cursor to the end
        const range = document.createRange();
        range.selectNodeContents(textBox);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

// Global selectionchange listener for text editor box
document.addEventListener("selectionchange", () => {
    const textBox = document.getElementById("canvasTextBox");
    if (textBox && textBox.style.display !== "none" && document.activeElement === textBox) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && textBox.contains(sel.anchorNode)) {
            savedSelectionRange = sel.getRangeAt(0);
        }
    }
});

document.addEventListener("mousedown", (e) => {
    if (layerContextMenu && !layerContextMenu.classList.contains("hidden") && !layerContextMenu.contains(e.target)) {
        layerContextMenu.classList.add("hidden");
    }
});

function addNewLayer(imgObj = null, name = null) {
    layerCounter++;
    const id = "layer_" + layerCounter;
    
    const canvas = document.createElement("canvas");
    canvas.id = id; canvas.width = baseWidth; canvas.height = baseHeight;
    
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (imgObj) {
        ctx.drawImage(imgObj, 0, 0, baseWidth, baseHeight);
    }
    
    const layerObj = { 
        id: id, name: name || `Ebene ${layerCounter}`, canvas: canvas, ctx: ctx, 
        visible: true, opacity: 1, blendMode: "source-over", x: 0, y: 0, scale: 1, 
        clippedToBelow: false, alphaLocked: false, 
        isTextLayer: false, textContent: "", textProps: {} 
    };    
    
    layers.unshift(layerObj);
    setActiveLayer(id);
    saveLogoState(); 
    renderMainCanvas();
}

function setActiveLayer(id) {
    activeLayerId = id;
    const layer = layers.find(l => l.id === activeLayerId);
    if (!layer) return; 

    const opSlider = document.getElementById("layerOpacity");
    const blendSelect = document.getElementById("layerBlendMode");
    const scaleSlider = document.getElementById("layerScaleSlider"); 
    
    if (opSlider && layer.opacity !== undefined) opSlider.value = layer.opacity;
    if (blendSelect && layer.blendMode !== undefined) blendSelect.value = layer.blendMode;
    if (scaleSlider && layer.scale !== undefined) scaleSlider.value = layer.scale; 

    // Setze die Slider-Werte für die Helligkeit, den Kontrast, die Sättigung und die Unschärfe der Ebene
    const brightnessSlider = document.getElementById("layerBrightness");
    const contrastSlider = document.getElementById("layerContrast");
    const saturationSlider = document.getElementById("layerSaturation");
    const blurSlider = document.getElementById("layerBlur");

    if (brightnessSlider) brightnessSlider.value = layer.brightness !== undefined ? layer.brightness : 1;
    if (contrastSlider) contrastSlider.value = layer.contrast !== undefined ? layer.contrast : 1;
    if (saturationSlider) saturationSlider.value = layer.saturation !== undefined ? layer.saturation : 1;
    if (blurSlider) blurSlider.value = layer.blur !== undefined ? layer.blur : 0;
    
    renderLayersUI();
}

window.updateActiveLayerProps = function() {
    const layer = layers.find(l => l.id === activeLayerId);
    if (!layer) return; 

    const opSlider = document.getElementById("layerOpacity");
    const blendSelect = document.getElementById("layerBlendMode");
    
    if (opSlider) layer.opacity = parseFloat(opSlider.value);
    if (blendSelect) layer.blendMode = blendSelect.value;
    
    // Lies die Filterwerte aus den Slidern aus
    const brightnessSlider = document.getElementById("layerBrightness");
    const contrastSlider = document.getElementById("layerContrast");
    const saturationSlider = document.getElementById("layerSaturation");
    const blurSlider = document.getElementById("layerBlur");

    if (brightnessSlider) layer.brightness = parseFloat(brightnessSlider.value);
    if (contrastSlider) layer.contrast = parseFloat(contrastSlider.value);
    if (saturationSlider) layer.saturation = parseFloat(saturationSlider.value);
    if (blurSlider) layer.blur = parseFloat(blurSlider.value);

    renderMainCanvas();
    saveLogoState();
}

function toggleLayerVisibility(id) {
    const layer = layers.find(l => l.id === id);
    if(layer) { 
        layer.visible = !layer.visible; 
        renderLayersUI(); 
        renderMainCanvas();
    }
}

function deleteLayer(id) {
    if(layers.length <= 1) return;
    const index = layers.findIndex(l => l.id === id);
    if(index > -1) {
        layers.splice(index, 1);
        if(activeLayerId === id) setActiveLayer(layers[0].id);
        else renderLayersUI();
        
        renderMainCanvas();
        saveLogoState();
    }
}

function getActiveCtx() { return layers.find(l => l.id === activeLayerId)?.ctx; }
function getActiveLayer() { return layers.find(l => l.id === activeLayerId); }

window.addNewLayer = addNewLayer;
window.setActiveLayer = setActiveLayer;
window.toggleLayerVisibility = toggleLayerVisibility;
window.deleteLayer = deleteLayer;
window.getActiveCtx = getActiveCtx;
window.getActiveLayer = getActiveLayer;

function renderLayersUI() {
    const ui = document.getElementById("layersListUi");
    if(!ui) return;
    ui.innerHTML = "";
    
    layers.forEach((layer, index) => {
        const item = document.createElement("div");
        item.className = "layer-item" + (activeLayerId === layer.id ? " active" : "");
        item.draggable = true;
        
        if(layer.clippedToBelow) {
            item.style.borderLeft = "4px solid var(--accent)";
            item.style.marginLeft = "10px"; 
        }
        
        item.ondragstart = () => { dragLayerData = index; setTimeout(() => item.style.opacity = "0.5", 0); };
        item.ondragend = () => { item.style.opacity = "1"; document.querySelectorAll('.layer-item').forEach(c => c.classList.remove('drag-over')); };
        item.ondragover = (e) => { e.preventDefault(); item.classList.add("drag-over"); };
        item.ondragleave = () => item.classList.remove("drag-over");
        item.ondrop = (e) => {
            e.preventDefault(); item.classList.remove("drag-over");
            if (dragLayerData !== null && dragLayerData !== index) {
                const movedLayer = layers.splice(dragLayerData, 1)[0];
                layers.splice(index, 0, movedLayer);
                renderLayersUI(); 
                saveLogoState();
                renderMainCanvas();
            }
        };

        item.onclick = () => setActiveLayer(layer.id);
        
        item.ondblclick = (e) => {
            e.stopPropagation();
            window.renameLayerPrompt(layer.id);
        };
        
        item.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            setActiveLayer(layer.id); 
            contextLayerId = layer.id;
            
            const textBtn = document.getElementById("ctxEditTextBtn");
            if (textBtn) textBtn.style.display = layer.isTextLayer ? "block" : "none";

            // Lock Button Text anpassen
            const lockBtn = document.getElementById("ctxLockBtn");
            if (lockBtn) {
                lockBtn.innerHTML = layer.locked ? "🔓 Ebene entsperren" : "🔒 Ebene sperren";
            }

            // Slider-Werte befüllen & Labels aktualisieren
            const sOpacity = document.getElementById("ctxSliderOpacity");
            const sBrightness = document.getElementById("ctxSliderBrightness");
            const sContrast = document.getElementById("ctxSliderContrast");
            const sSaturation = document.getElementById("ctxSliderSaturation");
            const sBlur = document.getElementById("ctxSliderBlur");

            if (sOpacity) { 
                sOpacity.value = layer.opacity !== undefined ? layer.opacity : 1; 
                document.getElementById("ctxValOpacity").textContent = Math.round(sOpacity.value * 100) + "%"; 
            }
            if (sBrightness) { 
                sBrightness.value = layer.brightness !== undefined ? layer.brightness : 1; 
                document.getElementById("ctxValBrightness").textContent = parseFloat(sBrightness.value).toFixed(2); 
            }
            if (sContrast) { 
                sContrast.value = layer.contrast !== undefined ? layer.contrast : 1; 
                document.getElementById("ctxValContrast").textContent = parseFloat(sContrast.value).toFixed(2); 
            }
            if (sSaturation) { 
                sSaturation.value = layer.saturation !== undefined ? layer.saturation : 1; 
                document.getElementById("ctxValSaturation").textContent = parseFloat(sSaturation.value).toFixed(2); 
            }
            if (sBlur) { 
                sBlur.value = layer.blur !== undefined ? layer.blur : 0; 
                document.getElementById("ctxValBlur").textContent = sBlur.value + "px"; 
            }

            const cMenu = document.getElementById("layerContextMenu");
            if (cMenu) {
                cMenu.style.left = e.clientX + "px";
                cMenu.style.top = e.clientY + "px";
                cMenu.classList.remove("hidden");
                cMenu.style.display = "flex";
            }
        };
        
        const eyeIconSvg = layer.visible
            ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-opacity="0.4"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

        item.innerHTML = `
            <div class="layer-item-eye" onclick="event.stopPropagation(); toggleLayerVisibility('${layer.id}')" title="Sichtbarkeit umschalten">${eyeIconSvg}</div>
            <div class="layer-item-name" title="Doppelklick zum Umbenennen: ${layer.name}" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;">
                ${layer.clippedToBelow ? '↳ ' : ''}${layer.isTextLayer ? '📝 ' : ''}${layer.name}
            </div>
            <button onclick="event.stopPropagation(); setActiveLayer('${layer.id}'); window.openAdjustmentsModalForActiveLayer('${layer.id}');" class="layer-adjust-btn" title="Ebenen-Effekte & Anpassungen bearbeiten (Deckkraft, Helligkeit, Kontrast, Blur)" style="background: rgba(29,185,84,0.15); border: 1px solid var(--accent); color: var(--accent); border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 3px; margin-right: 4px; flex-shrink: 0; transition: transform 0.1s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                <span>🎨 Effekte</span>
            </button>
            <div style="display: flex; align-items: center; gap: 3px; margin-right: 4px; flex-shrink: 0;">
                <button onclick="event.stopPropagation(); window.toggleLayerLock('${layer.id}')" title="${layer.locked ? 'Ebene entsperren' : 'Ebene sperren'}" style="background:none; border:none; color:${layer.locked ? '#ff5555' : '#777'}; cursor:pointer; font-size:11px; padding:0 2px;">
                    ${layer.locked ? '🔒' : '🔓'}
                </button>
                ${layer.alphaLocked ? '<span title="Transparenz gesperrt" style="font-size: 10px; font-weight: bold; opacity: 0.9; color: var(--accent); background: rgba(29,185,84,0.15); padding: 1px 3px; border-radius: 2px;">A</span>' : ''}
            </div>
            <div class="layer-item-reorder" style="display: flex; gap: 2px; margin-right: 4px; flex-shrink: 0;">
                <button onclick="event.stopPropagation(); window.moveLayerUp('${layer.id}')" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#888'" title="Ebene nach oben verschieben" style="background:none; border:none; color:#888; font-size:10px; cursor:pointer; padding:0 2px; transition:color 0.1s;">▲</button>
                <button onclick="event.stopPropagation(); window.moveLayerDown('${layer.id}')" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#888'" title="Ebene nach unten verschieben" style="background:none; border:none; color:#888; font-size:10px; cursor:pointer; padding:0 2px; transition:color 0.1s;">▼</button>
            </div>
            <div class="layer-item-delete" onclick="event.stopPropagation(); deleteLayer('${layer.id}')" title="Ebene löschen">✖</div>
        `;
        ui.appendChild(item);
    });
}

window.toggleLayerLock = function(id) {
    const layer = layers.find(l => l.id === id);
    if(layer) { 
        layer.locked = !layer.locked; 
        renderLayersUI(); 
        saveLogoState(); 
    }
};

window.renameLayerPrompt = function(id) {
    const layer = layers.find(l => l.id === id);
    if(!layer) return;
    const newName = prompt("Ebene umbenennen:", layer.name);
    if (newName && newName.trim()) {
        layer.name = newName.trim();
        renderLayersUI();
        saveLogoState();
    }
};

// --- EBENEN-VERSCHIEBUNG & SHIFT-HANDLERS ---
window.moveLayerUp = function(id) {
    const idx = layers.findIndex(l => l.id === id);
    if (idx > 0) {
        const moved = layers.splice(idx, 1)[0];
        layers.splice(idx - 1, 0, moved);
        renderLayersUI();
        saveLogoState();
        renderMainCanvas();
    }
};

window.moveLayerDown = function(id) {
    const idx = layers.findIndex(l => l.id === id);
    if (idx > -1 && idx < layers.length - 1) {
        const moved = layers.splice(idx, 1)[0];
        layers.splice(idx + 1, 0, moved);
        renderLayersUI();
        saveLogoState();
        renderMainCanvas();
    }
};

// --- RECHTSKLICK-FUNKTIONEN ---
window.ctxLayerDelete = function() { deleteLayer(contextLayerId); };
window.ctxLayerDuplicate = function() {
    const sourceLayer = layers.find(l => l.id === contextLayerId);
    if(!sourceLayer) return;
    addNewLayer(sourceLayer.canvas, sourceLayer.name + " Kopie");
    const newL = layers[0];
    newL.isTextLayer = sourceLayer.isTextLayer;
    newL.textContent = sourceLayer.textContent;
    newL.textProps = JSON.parse(JSON.stringify(sourceLayer.textProps));
    newL.scale = sourceLayer.scale || 1;
    newL.rotate = sourceLayer.rotate || 0;
    newL.skewX = sourceLayer.skewX || 0;
    newL.skewY = sourceLayer.skewY || 0;
};
window.ctxLayerMergeDown = function() {
    const index = layers.findIndex(l => l.id === contextLayerId);
    if(index >= layers.length - 1) return; 
    
    const sourceLayer = layers[index];     
    const targetLayer = layers[index + 1]; 
    
    targetLayer.ctx.save();
    targetLayer.ctx.globalAlpha = sourceLayer.opacity;
    targetLayer.ctx.globalCompositeOperation = sourceLayer.blendMode === "source-over" ? "source-over" : sourceLayer.blendMode;
    
    // Apply source layer filters/mirrors if active
    let filterParts = [];
    if (sourceLayer.brightness !== undefined && sourceLayer.brightness !== 1) filterParts.push(`brightness(${sourceLayer.brightness})`);
    if (sourceLayer.contrast !== undefined && sourceLayer.contrast !== 1) filterParts.push(`contrast(${sourceLayer.contrast})`);
    if (sourceLayer.saturation !== undefined && sourceLayer.saturation !== 1) filterParts.push(`saturate(${sourceLayer.saturation})`);
    if (sourceLayer.blur !== undefined && sourceLayer.blur !== 0) filterParts.push(`blur(${sourceLayer.blur}px)`);
    if (filterParts.length > 0) targetLayer.ctx.filter = filterParts.join(" ");
    
    const dw = sourceLayer.canvas.width * (sourceLayer.scale || 1);
    const dh = sourceLayer.canvas.height * (sourceLayer.scale || 1);
    
    const cx = (sourceLayer.x - targetLayer.x) + dw / 2;
    const cy = (sourceLayer.y - targetLayer.y) + dh / 2;
    targetLayer.ctx.translate(cx, cy);
    
    if (sourceLayer.rotate) {
        targetLayer.ctx.rotate(sourceLayer.rotate);
    }
    if (sourceLayer.skewX || sourceLayer.skewY) {
        targetLayer.ctx.transform(1, Math.tan(sourceLayer.skewY || 0), Math.tan(sourceLayer.skewX || 0), 1, 0, 0);
    }
    if (sourceLayer.flipH || sourceLayer.flipV) {
        targetLayer.ctx.scale(sourceLayer.flipH ? -1 : 1, sourceLayer.flipV ? -1 : 1);
    }
    
    targetLayer.ctx.drawImage(sourceLayer.canvas, -dw / 2, -dh / 2, dw, dh);
    
    targetLayer.ctx.restore();
    
    deleteLayer(sourceLayer.id); 
    saveLogoState();
    renderMainCanvas();
};
window.ctxLayerToggleClip = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) { 
        layer.clippedToBelow = !layer.clippedToBelow; 
        renderLayersUI(); saveLogoState(); renderMainCanvas();
    }
};
window.ctxLayerToggleAlphaLock = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) { layer.alphaLocked = !layer.alphaLocked; renderLayersUI(); saveLogoState(); }
};
window.ctxLayerToggleLock = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) { 
        layer.locked = !layer.locked; 
        renderLayersUI(); 
        saveLogoState(); 
    }
};
window.ctxLayerFlipH = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) {
        layer.flipH = !layer.flipH;
        renderMainCanvas();
        saveLogoState();
    }
};
window.ctxLayerFlipV = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) {
        layer.flipV = !layer.flipV;
        renderMainCanvas();
        saveLogoState();
    }
};
window.ctxLayerCenter = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if(layer) {
        const dw = layer.canvas.width * (layer.scale || 1);
        const dh = layer.canvas.height * (layer.scale || 1);
        layer.x = (baseWidth - dw) / 2;
        layer.y = (baseHeight - dh) / 2;
        renderMainCanvas();
        saveLogoState();
    }
};

// --- DYNAMISCHE CONTEXT SLIDER EVENT REGISTER ---
function setupContextMenuSliderEvents() {
    const sOpacity = document.getElementById("ctxSliderOpacity");
    const sBrightness = document.getElementById("ctxSliderBrightness");
    const sContrast = document.getElementById("ctxSliderContrast");
    const sSaturation = document.getElementById("ctxSliderSaturation");
    const sBlur = document.getElementById("ctxSliderBlur");

    if (sOpacity) {
        sOpacity.addEventListener("input", (e) => {
            const layer = layers.find(l => l.id === contextLayerId);
            if (!layer) return;
            layer.opacity = parseFloat(e.target.value);
            document.getElementById("ctxValOpacity").textContent = Math.round(layer.opacity * 100) + "%";
            if (layer.id === activeLayerId) {
                const rSlider = document.getElementById("layerOpacity");
                if (rSlider) rSlider.value = layer.opacity;
            }
            renderMainCanvas();
        });
        sOpacity.addEventListener("change", () => { saveLogoState(); });
    }

    if (sBrightness) {
        sBrightness.addEventListener("input", (e) => {
            const layer = layers.find(l => l.id === contextLayerId);
            if (!layer) return;
            layer.brightness = parseFloat(e.target.value);
            document.getElementById("ctxValBrightness").textContent = layer.brightness.toFixed(2);
            if (layer.id === activeLayerId) {
                const rSlider = document.getElementById("layerBrightness");
                if (rSlider) rSlider.value = layer.brightness;
            }
            renderMainCanvas();
        });
        sBrightness.addEventListener("change", () => { saveLogoState(); });
    }

    if (sContrast) {
        sContrast.addEventListener("input", (e) => {
            const layer = layers.find(l => l.id === contextLayerId);
            if (!layer) return;
            layer.contrast = parseFloat(e.target.value);
            document.getElementById("ctxValContrast").textContent = layer.contrast.toFixed(2);
            if (layer.id === activeLayerId) {
                const rSlider = document.getElementById("layerContrast");
                if (rSlider) rSlider.value = layer.contrast;
            }
            renderMainCanvas();
        });
        sContrast.addEventListener("change", () => { saveLogoState(); });
    }

    if (sSaturation) {
        sSaturation.addEventListener("input", (e) => {
            const layer = layers.find(l => l.id === contextLayerId);
            if (!layer) return;
            layer.saturation = parseFloat(e.target.value);
            document.getElementById("ctxValSaturation").textContent = layer.saturation.toFixed(2);
            if (layer.id === activeLayerId) {
                const rSlider = document.getElementById("layerSaturation");
                if (rSlider) rSlider.value = layer.saturation;
            }
            renderMainCanvas();
        });
        sSaturation.addEventListener("change", () => { saveLogoState(); });
    }

    if (sBlur) {
        sBlur.addEventListener("input", (e) => {
            const layer = layers.find(l => l.id === contextLayerId);
            if (!layer) return;
            layer.blur = parseFloat(e.target.value);
            document.getElementById("ctxValBlur").textContent = layer.blur + "px";
            if (layer.id === activeLayerId) {
                const rSlider = document.getElementById("layerBlur");
                if (rSlider) rSlider.value = layer.blur;
            }
            renderMainCanvas();
        });
        sBlur.addEventListener("change", () => { saveLogoState(); });
    }
}

// Initialisierung der Event-Listener
setupContextMenuSliderEvents();

window.ctxLayerEditText = function() {
    const layer = layers.find(l => l.id === contextLayerId);
    if (!layer || !layer.isTextLayer || layer.locked) return;
    
    layerContextMenu.classList.add("hidden");
    editingTextLayerId = layer.id;
    setLogoTool('text');
    
    // Toolbar mit den gespeicherten Props der Ebene befüllen
    loadTextPropsIntoToolbar(layer.textProps);
    
    // Textbox befüllen und positionieren
    const textBox = document.getElementById("canvasTextBox");
    if (textBox) {
        textBox.innerText = layer.textContent || "";
        
        const currentRawX = (layer.x || 0) + (layer.textProps.x || 0) * (layer.scale || 1);
        const currentRawY = (layer.y || 0) + (layer.textProps.y || 0) * (layer.scale || 1);
        textBox.style.left = currentRawX + "px";
        textBox.style.top  = currentRawY + "px";
        textBox.style.display = "block";
        
        syncTextBoxStyles();
        positionTextToolbar();
    }
    
    // Ebene während der Bearbeitung leeren (Text kommt aus dem WYSIWYG-Div)
    layer.ctx.clearRect(0, 0, baseWidth, baseHeight);
    renderMainCanvas();
    
    setTimeout(() => {
        const tb = document.getElementById("canvasTextBox");
        if (tb) {
            tb.focus();
            // Cursor ans Ende setzen
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(tb);
            range.collapse(false);
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    }, 50);
};


// --- DYNAMISCHE EBENEN-ANPASSUNGEN MODAL LOGIK ---
window.openAdjustmentsModalForActiveLayer = function(targetLayerId = null) {
    if (targetLayerId) {
        activeLayerId = targetLayerId;
        renderLayersUI();
    }
    const layer = layers.find(l => l.id === activeLayerId);
    if (!layer) return;
    modalLayerId = layer.id;
    modalLayerBackup = {
        opacity: layer.opacity !== undefined ? layer.opacity : 1,
        brightness: layer.brightness !== undefined ? layer.brightness : 1,
        contrast: layer.contrast !== undefined ? layer.contrast : 1,
        saturation: layer.saturation !== undefined ? layer.saturation : 1,
        blur: layer.blur !== undefined ? layer.blur : 0
    };
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const sOpacity = edDoc.getElementById("modalSliderOpacity");
    const sBrightness = edDoc.getElementById("modalSliderBrightness");
    const sContrast = edDoc.getElementById("modalSliderContrast");
    const sSaturation = edDoc.getElementById("modalSliderSaturation");
    const sBlur = edDoc.getElementById("modalSliderBlur");

    if (sOpacity) sOpacity.value = modalLayerBackup.opacity;
    if (sBrightness) sBrightness.value = modalLayerBackup.brightness;
    if (sContrast) sContrast.value = modalLayerBackup.contrast;
    if (sSaturation) sSaturation.value = modalLayerBackup.saturation;
    if (sBlur) sBlur.value = modalLayerBackup.blur;

    const vOpacity = edDoc.getElementById("modalValOpacity");
    const vBrightness = edDoc.getElementById("modalValBrightness");
    const vContrast = edDoc.getElementById("modalValContrast");
    const vSaturation = edDoc.getElementById("modalValSaturation");
    const vBlur = edDoc.getElementById("modalValBlur");

    if (vOpacity) vOpacity.textContent = Math.round(modalLayerBackup.opacity * 100) + "%";
    if (vBrightness) vBrightness.textContent = modalLayerBackup.brightness.toFixed(2);
    if (vContrast) vContrast.textContent = modalLayerBackup.contrast.toFixed(2);
    if (vSaturation) vSaturation.textContent = modalLayerBackup.saturation.toFixed(2);
    if (vBlur) vBlur.textContent = modalLayerBackup.blur + "px";

    const modal = edDoc.getElementById("logoAdjustmentsModal");
    if (modal) {
        modal.classList.remove("hidden");
        if (!modal.style.top || modal.style.top === "100px") {
            modal.style.top = "80px";
            modal.style.right = "40px";
        }
    }
};

window.ctxOpenAdjustmentsModal = function() {
    const layerId = (typeof contextLayerId !== 'undefined' && contextLayerId) ? contextLayerId : activeLayerId;
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const contextMenu = edDoc.getElementById("layerContextMenu") || document.getElementById("layerContextMenu");
    if (contextMenu) {
        contextMenu.classList.add("hidden");
        contextMenu.style.display = "none";
    }
    window.openAdjustmentsModalForActiveLayer(layerId);
};

window.onAdjustmentSliderInput = function(prop, val) {
    const layer = layers.find(l => l.id === modalLayerId);
    if (!layer) return;
    const floatVal = parseFloat(val);
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    if (prop === "opacity") {
        layer.opacity = floatVal;
        const v = edDoc.getElementById("modalValOpacity"); if (v) v.textContent = Math.round(floatVal * 100) + "%";
        const leg = edDoc.getElementById("layerOpacity"); if (leg) leg.value = floatVal;
    } else if (prop === "brightness") {
        layer.brightness = floatVal;
        const v = edDoc.getElementById("modalValBrightness"); if (v) v.textContent = floatVal.toFixed(2);
        const leg = edDoc.getElementById("layerBrightness"); if (leg) leg.value = floatVal;
    } else if (prop === "contrast") {
        layer.contrast = floatVal;
        const v = edDoc.getElementById("modalValContrast"); if (v) v.textContent = floatVal.toFixed(2);
        const leg = edDoc.getElementById("layerContrast"); if (leg) leg.value = floatVal;
    } else if (prop === "saturation") {
        layer.saturation = floatVal;
        const v = edDoc.getElementById("modalValSaturation"); if (v) v.textContent = floatVal.toFixed(2);
        const leg = edDoc.getElementById("layerSaturation"); if (leg) leg.value = floatVal;
    } else if (prop === "blur") {
        layer.blur = floatVal;
        const v = edDoc.getElementById("modalValBlur"); if (v) v.textContent = floatVal + "px";
        const leg = edDoc.getElementById("layerBlur"); if (leg) leg.value = floatVal;
    }
    renderMainCanvas();
};

window.cancelAdjustmentsModal = function() {
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const modal = edDoc.getElementById("logoAdjustmentsModal") || document.getElementById("logoAdjustmentsModal");
    if (modal) modal.classList.add("hidden");
    const layer = layers.find(l => l.id === modalLayerId);
    if (layer && modalLayerBackup) {
        layer.opacity = modalLayerBackup.opacity;
        layer.brightness = modalLayerBackup.brightness;
        layer.contrast = modalLayerBackup.contrast;
        layer.saturation = modalLayerBackup.saturation;
        layer.blur = modalLayerBackup.blur;
        const op = edDoc.getElementById("layerOpacity"); if (op) op.value = layer.opacity;
        const br = edDoc.getElementById("layerBrightness"); if (br) br.value = layer.brightness;
        const co = edDoc.getElementById("layerContrast"); if (co) co.value = layer.contrast;
        const sa = edDoc.getElementById("layerSaturation"); if (sa) sa.value = layer.saturation;
        const bl = edDoc.getElementById("layerBlur"); if (bl) bl.value = layer.blur;
        renderMainCanvas();
    }
    modalLayerBackup = null;
    modalLayerId = null;
};

window.confirmAdjustmentsModal = function() {
    const edDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) ? window.popoutEditorWindow.document : document;
    const modal = edDoc.getElementById("logoAdjustmentsModal") || document.getElementById("logoAdjustmentsModal");
    if (modal) modal.classList.add("hidden");
    saveLogoState();
    modalLayerBackup = null;
    modalLayerId = null;
};

// --- DOCKABLE PANEL RESIZERS ---
window.initPanelResizers = function(targetDoc = document) {
    const panels = targetDoc.querySelectorAll('.csp-dockable-panel');
    panels.forEach(panel => {
        const sidebar = panel.closest('.csp-sidebar');
        const isBottom = sidebar && (sidebar.classList.contains('bottom') || sidebar.id === 'logoBottomToolbar');
        const oldResizer = panel.querySelector('.csp-panel-resizer-h');
        if (oldResizer) oldResizer.remove();

        if (isBottom) {
            panel.style.height = '';
            panel.style.flex = '';
        } else {
            const doc = panel.ownerDocument || targetDoc || document;
            const win = doc.defaultView || window;
            const resizer = doc.createElement('div');
            resizer.className = 'csp-panel-resizer-h';
            resizer.title = 'Höhe skalieren (Ziehen zum Anpassen)';
            panel.appendChild(resizer);

            const onDragStart = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.target.setPointerCapture && e.pointerId !== undefined) {
                    try { e.target.setPointerCapture(e.pointerId); } catch(err) {}
                }
                const startY = e.clientY;
                const startHeight = panel.getBoundingClientRect().height;
                resizer.classList.add('active');

                const onMouseMove = (moveEvent) => {
                    const deltaY = moveEvent.clientY - startY;
                    const newHeight = Math.max(90, startHeight + deltaY);
                    panel.style.height = newHeight + 'px';
                    panel.style.flex = 'none';
                };

                const onMouseUp = () => {
                    resizer.classList.remove('active');
                    if (e.target.releasePointerCapture && e.pointerId !== undefined) {
                        try { e.target.releasePointerCapture(e.pointerId); } catch(err) {}
                    }
                    win.removeEventListener('pointermove', onMouseMove);
                    win.removeEventListener('pointerup', onMouseUp);
                    win.removeEventListener('pointercancel', onMouseUp);
                    win.removeEventListener('mousemove', onMouseMove);
                    win.removeEventListener('mouseup', onMouseUp);
                    doc.removeEventListener('pointermove', onMouseMove);
                    doc.removeEventListener('pointerup', onMouseUp);
                    doc.removeEventListener('mousemove', onMouseMove);
                    doc.removeEventListener('mouseup', onMouseUp);
                    if (win !== window) {
                        window.removeEventListener('pointermove', onMouseMove);
                        window.removeEventListener('pointerup', onMouseUp);
                        window.removeEventListener('mousemove', onMouseMove);
                        window.removeEventListener('mouseup', onMouseUp);
                    }
                    if (typeof window.saveLayout === "function") window.saveLayout(doc);
                };

                win.addEventListener('pointermove', onMouseMove);
                win.addEventListener('pointerup', onMouseUp);
                win.addEventListener('pointercancel', onMouseUp);
                win.addEventListener('mousemove', onMouseMove);
                win.addEventListener('mouseup', onMouseUp);
                doc.addEventListener('pointermove', onMouseMove);
                doc.addEventListener('pointerup', onMouseUp);
                doc.addEventListener('mousemove', onMouseMove);
                doc.addEventListener('mouseup', onMouseUp);
                if (win !== window) {
                    window.addEventListener('pointermove', onMouseMove);
                    window.addEventListener('pointerup', onMouseUp);
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                }
            };

            resizer.addEventListener('pointerdown', onDragStart);
            resizer.addEventListener('mousedown', onDragStart);
        }
    });
};

// --- FREE TRANSFORM MATH & OVERLAY ---
function screenToLocal(sx, sy, layer) {
    const dw = layer.canvas.width * (layer.scale || 1);
    const dh = layer.canvas.height * (layer.scale || 1);
    const cx = layer.x + dw / 2;
    const cy = layer.y + dh / 2;
    let x1 = sx - cx;
    let y1 = sy - cy;
    const rotate = layer.rotate || 0;
    let x2 = x1 * Math.cos(-rotate) - y1 * Math.sin(-rotate);
    let y2 = x1 * Math.sin(-rotate) + y1 * Math.cos(-rotate);
    const tx = Math.tan(layer.skewX || 0);
    const ty = Math.tan(layer.skewY || 0);
    let D = 1 - tx * ty;
    if (Math.abs(D) < 0.0001) D = 0.0001;
    let ly = (y2 - x2 * ty) / D;
    let lx = x2 - ly * tx;
    if (layer.flipH) lx = -lx;
    if (layer.flipV) ly = -ly;
    return { lx, ly };
}

function getHandleAtLocal(lx, ly, dw, dh) {
    const threshold = 12;
    if (Math.hypot(lx - 0, ly - (-dh / 2 - 25)) <= threshold) return "rotate";
    if (Math.hypot(lx - (-dw / 2), ly - (-dh / 2)) <= threshold) return "scale-tl";
    if (Math.hypot(lx - (dw / 2), ly - (-dh / 2)) <= threshold) return "scale-tr";
    if (Math.hypot(lx - (-dw / 2), ly - (dh / 2)) <= threshold) return "scale-bl";
    if (Math.hypot(lx - (dw / 2), ly - (dh / 2)) <= threshold) return "scale-br";
    if (Math.hypot(lx - (-dw / 2), ly - 0) <= threshold) return "skew-l";
    if (Math.hypot(lx - (dw / 2), ly - 0) <= threshold) return "skew-r";
    if (Math.hypot(lx - 0, ly - (-dh / 2)) <= threshold) return "skew-t";
    if (Math.hypot(lx - 0, ly - (dh / 2)) <= threshold) return "skew-b";
    if (lx >= -dw / 2 && lx <= dw / 2 && ly >= -dh / 2 && ly <= dh / 2) return "move";
    
    // Any area outside the bounding box + handle threshold is rotation area
    const margin = threshold + 5;
    if (lx < -dw/2 - margin || lx > dw/2 + margin || ly < -dh/2 - margin || ly > dh/2 + margin) {
        return "rotate";
    }
    
    return null;
}

function drawTransformOverlay() {
    lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
    const layer = getActiveLayer();
    if (!layer || layer.locked) return;
    if (layer.rotate === undefined) layer.rotate = 0;
    if (layer.skewX === undefined) layer.skewX = 0;
    if (layer.skewY === undefined) layer.skewY = 0;
    if (layer.scale === undefined) layer.scale = 1;

    const dw = layer.canvas.width * layer.scale;
    const dh = layer.canvas.height * layer.scale;
    const cx = layer.x + dw / 2;
    const cy = layer.y + dh / 2;

    lassoCtx.save();
    lassoCtx.translate(cx, cy);
    if (layer.rotate) lassoCtx.rotate(layer.rotate);
    if (layer.skewX || layer.skewY) lassoCtx.transform(1, Math.tan(layer.skewY), Math.tan(layer.skewX), 1, 0, 0);
    if (layer.flipH || layer.flipV) lassoCtx.scale(layer.flipH ? -1 : 1, layer.flipV ? -1 : 1);

    lassoCtx.strokeStyle = "var(--accent, #1db954)";
    lassoCtx.lineWidth = 1.5;
    lassoCtx.setLineDash([4, 4]);
    lassoCtx.strokeRect(-dw / 2, -dh / 2, dw, dh);
    lassoCtx.restore();

    lassoCtx.save();
    lassoCtx.translate(cx, cy);
    if (layer.rotate) lassoCtx.rotate(layer.rotate);
    if (layer.skewX || layer.skewY) lassoCtx.transform(1, Math.tan(layer.skewY), Math.tan(layer.skewX), 1, 0, 0);
    if (layer.flipH || layer.flipV) lassoCtx.scale(layer.flipH ? -1 : 1, layer.flipV ? -1 : 1);

    lassoCtx.strokeStyle = "var(--accent, #1db954)";
    lassoCtx.lineWidth = 1.5;
    lassoCtx.setLineDash([]);
    lassoCtx.beginPath();
    lassoCtx.moveTo(0, -dh / 2);
    lassoCtx.lineTo(0, -dh / 2 - 25);
    lassoCtx.stroke();

    lassoCtx.fillStyle = "#2ecc71";
    lassoCtx.strokeStyle = "#ffffff";
    lassoCtx.lineWidth = 1.5;
    lassoCtx.beginPath();
    lassoCtx.arc(0, -dh / 2 - 25, 6, 0, Math.PI * 2);
    lassoCtx.fill();
    lassoCtx.stroke();

    lassoCtx.fillStyle = "#ffffff";
    lassoCtx.strokeStyle = "var(--accent, #1db954)";
    const handleSize = 8;
    const halfH = handleSize / 2;
    lassoCtx.fillRect(-dw / 2 - halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(-dw / 2 - halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.fillRect(dw / 2 - halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(dw / 2 - halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.fillRect(-dw / 2 - halfH, dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(-dw / 2 - halfH, dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.fillRect(dw / 2 - halfH, dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(dw / 2 - halfH, dh / 2 - halfH, handleSize, handleSize);

    lassoCtx.fillStyle = "#00f3ff";
    lassoCtx.strokeStyle = "#ffffff";
    lassoCtx.fillRect(-dw / 2 - halfH, -halfH, handleSize, handleSize);
    lassoCtx.strokeRect(-dw / 2 - halfH, -halfH, handleSize, handleSize);
    lassoCtx.fillRect(dw / 2 - halfH, -halfH, handleSize, handleSize);
    lassoCtx.strokeRect(dw / 2 - halfH, -halfH, handleSize, handleSize);
    lassoCtx.fillRect(-halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(-halfH, -dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.fillRect(-halfH, dh / 2 - halfH, handleSize, handleSize);
    lassoCtx.strokeRect(-halfH, dh / 2 - halfH, handleSize, handleSize);

    lassoCtx.restore();
}


// ---------------------------------------------------------
// FÜLLWERKZEUG (Flood Fill Algorithmus)
// ---------------------------------------------------------
function hexToRgbaArray(hex) {
    let r=0,g=0,b=0;
    if (hex.length == 4) { r=parseInt(hex[1]+hex[1],16); g=parseInt(hex[2]+hex[2],16); b=parseInt(hex[3]+hex[3],16); } 
    else if (hex.length == 7) { r=parseInt(hex.substring(1,3),16); g=parseInt(hex.substring(3,5),16); b=parseInt(hex.substring(5,7),16); }
    return [r, g, b, 255]; 
}

function floodFill(ctx, startX, startY, fillHex) {
    const width = ctx.canvas.width; const height = ctx.canvas.height;
    startX = Math.floor(startX); startY = Math.floor(startY);
    if(startX < 0 || startX >= width || startY < 0 || startY >= height) return;

    // 1. Schneller C++ Scanline Flood-Fill (PhotoCraft)
    if (window.BrushEngine && window.BrushEngine.isNative) {
        try {
            const filled = window.BrushEngine.floodFillCanvas(ctx, width, height, startX, startY, fillHex, 15);
            if (filled > 0) return;
        } catch(e) {}
    }

    const imageData = ctx.getImageData(0, 0, width, height); const data = imageData.data;
    const fillRgb = hexToRgbaArray(fillHex);
    const targetPos = (startY * width + startX) * 4;
    const targetR = data[targetPos], targetG = data[targetPos+1], targetB = data[targetPos+2], targetA = data[targetPos+3];

    if(targetR === fillRgb[0] && targetG === fillRgb[1] && targetB === fillRgb[2] && targetA === fillRgb[3]) return;

    function matchStartColor(pos) { return data[pos] === targetR && data[pos+1] === targetG && data[pos+2] === targetB && data[pos+3] === targetA; }
    function colorPixel(pos) { data[pos] = fillRgb[0]; data[pos+1] = fillRgb[1]; data[pos+2] = fillRgb[2]; data[pos+3] = fillRgb[3]; }

    let pixelStack = [[startX, startY]];
    
    while(pixelStack.length) {
        let newPos, x, y, pixelPos, reachLeft, reachRight;
        newPos = pixelStack.pop();
        x = newPos[0]; y = newPos[1];
        pixelPos = (y * width + x) * 4;
        
        while(y-- >= 0 && matchStartColor(pixelPos)) { pixelPos -= width * 4; }
        pixelPos += width * 4; ++y; reachLeft = false; reachRight = false;
        
        while(y++ < height-1 && matchStartColor(pixelPos)) {
            colorPixel(pixelPos);
            if(x > 0) {
                if(matchStartColor(pixelPos - 4)) { if(!reachLeft) { pixelStack.push([x - 1, y]); reachLeft = true; } } 
                else if(reachLeft) { reachLeft = false; }
            }
            if(x < width-1) {
                if(matchStartColor(pixelPos + 4)) { if(!reachRight) { pixelStack.push([x + 1, y]); reachRight = true; } } 
                else if(reachRight) { reachRight = false; }
            }
            pixelPos += width * 4;
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

function floodFillTransparent(ctx, startX, startY) {
    const width = ctx.canvas.width; const height = ctx.canvas.height;
    startX = Math.floor(startX); startY = Math.floor(startY);
    if(startX < 0 || startX >= width || startY < 0 || startY >= height) return;

    if (window.BrushEngine && window.BrushEngine.native && typeof window.BrushEngine.native.floodFill === 'function') {
        try {
            const imgData = ctx.getImageData(0, 0, width, height);
            const buf = Buffer.from(imgData.data.buffer);
            const filled = window.BrushEngine.native.floodFill(buf, width, height, startX, startY, 0, 0, 0, 0, 15);
            if (filled > 0) {
                ctx.putImageData(imgData, 0, 0);
                return;
            }
        } catch(e) {}
    }

    const imageData = ctx.getImageData(0, 0, width, height); const data = imageData.data;
    const targetPos = (startY * width + startX) * 4;
    const targetR = data[targetPos], targetG = data[targetPos+1], targetB = data[targetPos+2], targetA = data[targetPos+3];

    if (targetA === 0) return;

    function matchStartColor(pos) { return data[pos] === targetR && data[pos+1] === targetG && data[pos+2] === targetB && data[pos+3] === targetA; }
    function colorPixel(pos) { data[pos] = 0; data[pos+1] = 0; data[pos+2] = 0; data[pos+3] = 0; }

    let pixelStack = [[startX, startY]];
    
    while(pixelStack.length) {
        let newPos, x, y, pixelPos, reachLeft, reachRight;
        newPos = pixelStack.pop();
        x = newPos[0]; y = newPos[1];
        pixelPos = (y * width + x) * 4;
        
        while(y-- >= 0 && matchStartColor(pixelPos)) { pixelPos -= width * 4; }
        pixelPos += width * 4; ++y; reachLeft = false; reachRight = false;
        
        while(y++ < height-1 && matchStartColor(pixelPos)) {
            colorPixel(pixelPos);
            if(x > 0) {
                if(matchStartColor(pixelPos - 4)) { if(!reachLeft) { pixelStack.push([x - 1, y]); reachLeft = true; } } 
                else if(reachLeft) { reachLeft = false; }
            }
            if(x < width-1) {
                if(matchStartColor(pixelPos + 4)) { if(!reachRight) { pixelStack.push([x + 1, y]); reachRight = true; } } 
                else if(reachRight) { reachRight = false; }
            }
            pixelPos += width * 4;
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

// =====================================================
// FLOATING TEXT TOOLBAR - Event System
// =====================================================

// Hilfsfunktion: Textbox-Styles aus Toolbar in das contenteditable-Div übertragen (WYSIWYG)
function syncTextBoxStyles() {
    const box = document.getElementById("canvasTextBox");
    if (!box || box.style.display === "none") return;
    
    const size      = parseInt(document.getElementById("ttSize")?.value) || 60;
    const font      = document.getElementById("ttFont")?.value || "Arial";
    const bold      = document.getElementById("ttBold")?.classList.contains("tt-active");
    const italic    = document.getElementById("ttItalic")?.classList.contains("tt-active");
    const underline = document.getElementById("ttUnderline")?.classList.contains("tt-active");
    const color     = document.getElementById("ttColor")?.value || "#ffffff";
    const spacing   = parseFloat(document.getElementById("ttSpacing")?.value) || 0;
    const lh        = document.getElementById("ttLineHeight")?.value || "1.2";
    const opacity   = parseFloat(document.getElementById("ttOpacity")?.value) || 1.0;
    let align = "left";
    if (document.getElementById("ttAlignCenter")?.classList.contains("tt-active")) align = "center";
    else if (document.getElementById("ttAlignRight")?.classList.contains("tt-active")) align = "right";
    
    box.style.fontFamily      = `"${font}", sans-serif`;
    box.style.fontSize        = size + "px";
    box.style.fontWeight      = bold ? "bold" : "normal";
    box.style.fontStyle       = italic ? "italic" : "normal";
    box.style.textDecoration  = underline ? "underline" : "none";
    box.style.color           = color;
    box.style.letterSpacing   = spacing + "px";
    box.style.lineHeight      = lh;
    box.style.textAlign       = align;
    box.style.opacity         = opacity;
    box.style.minWidth        = Math.max(60, size * 3) + "px";
    box.style.minHeight       = (size * parseFloat(lh) + 12) + "px";
}

// Toolbar Floating Position über der Textbox setzen
function positionTextToolbar() {
    const toolbar = document.getElementById("textFloatingToolbar");
    const box = document.getElementById("canvasTextBox");
    if (!toolbar || !box || box.style.display === "none") return;
    
    const boxLeft = parseFloat(box.style.left) || 0;
    const boxTop  = parseFloat(box.style.top) || 0;
    const toolbarH = 50; // Toolbar Höhe in Pixeln
    
    toolbar.style.left = boxLeft + "px";
    toolbar.style.top  = Math.max(2, boxTop - toolbarH - 8) + "px";
    toolbar.style.display = "block";
}

// Toggle-Buttons für Bold, Italic, Underline, Alignment, Shadow
function setupTextToolbarEvents() {
    // Hilfsfunktion zur Fokus-Wiederherstellung im Textfeld
    const refillFocus = () => {
        setTimeout(() => {
            restoreTextBoxSelection();
        }, 50);
    };

    // Toggle-Buttons für Bold, Italic, Underline
    ["ttBold", "ttItalic", "ttUnderline"].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); // Verhindert Fokusverlust
        });
        btn.addEventListener("click", () => {
            const command = id.substring(2).toLowerCase(); // bold, italic, underline
            window.applyStyleToTextBox(command);
            refillFocus();
        });
    });
    
    // Shadow Toggle (Layer/Toolbar-Level)
    const btnShadow = document.getElementById("ttShadow");
    if (btnShadow) {
        btnShadow.addEventListener("mousedown", (e) => { e.preventDefault(); });
        btnShadow.addEventListener("click", () => {
            btnShadow.classList.toggle("tt-active");
            updateActiveTextLayerFromToolbar();
            refillFocus();
        });
    }
    
    // Ausrichtungs-Buttons (exklusiv)
    ["ttAlignLeft", "ttAlignCenter", "ttAlignRight"].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); // Verhindert Fokusverlust
        });
        btn.addEventListener("click", () => {
            ["ttAlignLeft", "ttAlignCenter", "ttAlignRight"].forEach(b => {
                document.getElementById(b)?.classList.remove("tt-active");
            });
            btn.classList.add("tt-active");
            syncTextBoxStyles();
            updateActiveTextLayerFromToolbar();
            refillFocus();
        });
    });
    
    // Font-Dropdown
    document.getElementById("ttFont")?.addEventListener("change", (e) => {
        window.applyStyleToTextBox("font", e.target.value);
        refillFocus();
    });

    // Explicit event shielding to prevent parent/global handlers from blocking dropdown clicks
    ["ttFont", "ttLineHeight", "ttEffect"].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("mousedown", (e) => {
                e.stopPropagation();
            });
            el.addEventListener("click", (e) => {
                e.stopPropagation();
            });
        }
    });
    
    // Schriftgröße-Buttons
    document.getElementById("ttSizeUp")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
    });
    document.getElementById("ttSizeUp")?.addEventListener("click", () => {
        const inp = document.getElementById("ttSize");
        if (inp) {
            const val = Math.min(600, (parseInt(inp.value) || 60) + 2);
            inp.value = val;
            window.applyStyleToTextBox("size", val);
        }
        refillFocus();
    });
    
    document.getElementById("ttSizeDown")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
    });
    document.getElementById("ttSizeDown")?.addEventListener("click", () => {
        const inp = document.getElementById("ttSize");
        if (inp) {
            const val = Math.max(4, (parseInt(inp.value) || 60) - 2);
            inp.value = val;
            window.applyStyleToTextBox("size", val);
        }
        refillFocus();
    });
    
    document.getElementById("ttSize")?.addEventListener("input", (e) => {
        window.applyStyleToTextBox("size", parseInt(e.target.value) || 60);
    });
    document.getElementById("ttSize")?.addEventListener("change", refillFocus);
    
    // Spacing & Line Height & Text Effect Dropdown
    document.getElementById("ttSpacing")?.addEventListener("input", () => {
        syncTextBoxStyles();
        updateActiveTextLayerFromToolbar();
    });
    document.getElementById("ttSpacing")?.addEventListener("change", refillFocus);
    
    document.getElementById("ttLineHeight")?.addEventListener("change", () => {
        syncTextBoxStyles();
        updateActiveTextLayerFromToolbar();
        refillFocus();
    });

    document.getElementById("ttEffect")?.addEventListener("change", () => {
        updateActiveTextLayerFromToolbar();
        refillFocus();
    });
    
    // Farbe
    const ttColor = document.getElementById("ttColor");
    const ttColorDisplay = document.getElementById("ttColorDisplay");
    if (ttColor) {
        ttColor.addEventListener("input", () => {
            if (ttColorDisplay) ttColorDisplay.style.background = ttColor.value;
            window.applyStyleToTextBox("color", ttColor.value);
        });
        ttColor.addEventListener("change", () => {
            refillFocus();
        });
    }
    if (ttColorDisplay) {
        ttColorDisplay.addEventListener("mousedown", (e) => {
            e.preventDefault(); // Verhindert Fokusverlust
        });
        ttColorDisplay.addEventListener("click", () => {
            ttColor?.click();
        });
    }
    
    // Commit-Button
    document.getElementById("ttCommit")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
    });
    document.getElementById("ttCommit")?.addEventListener("click", () => {
        commitCanvasText();
    });
    
    const toolbar = document.getElementById("textFloatingToolbar");
    if (toolbar) {
        toolbar.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });
    }
    
    // Keyboard Shortcuts im Textfeld (Bold, Italic, Underline)
    const box = document.getElementById("canvasTextBox");
    if (box) {
        // Mousedown-Propagation stoppen, damit das Canvas-Interface nicht dazwischenfunkt
        box.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });

        // Auswahl speichern bei jeder Änderung
        ["keyup", "mouseup", "input"].forEach(evt => {
            box.addEventListener(evt, () => {
                saveTextBoxSelection();
            });
        });

        // Live input sync to active layer
        box.addEventListener("input", () => {
            const layer = getActiveLayer();
            if (layer && layer.isTextLayer) {
                layer.textHTML = box.innerHTML;
                const temp = document.createElement("div");
                temp.innerHTML = box.innerHTML;
                layer.textContent = (temp.innerText || temp.textContent || "").replace(/\r\n/g, "\n");
                renderTextLayer(layer);
                renderMainCanvas();
            }
        });

        // Automatischer Reset bei Satzende (Eingabe von Leerzeichen nach . , ! oder ?)
        box.addEventListener("keyup", (e) => {
            if (e.key === " ") {
                const sel = window.getSelection();
                if (sel && sel.anchorNode) {
                    const text = sel.anchorNode.textContent || "";
                    const offset = sel.anchorOffset;
                    if (offset >= 2) {
                        const prevChar = text.charAt(offset - 2);
                        if (prevChar === "." || prevChar === "!" || prevChar === "?") {
                            window.resetTypingStyle();
                        }
                    }
                }
            }
        });

        box.addEventListener("keydown", (e) => {
            // Reset bei Enter (neue Zeile)
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                setTimeout(() => {
                    window.resetTypingStyle();
                }, 0);
            }

            if (e.ctrlKey || e.metaKey) {
                if (e.key === "b" || e.key === "B") {
                    e.preventDefault();
                    window.applyStyleToTextBox("bold");
                } else if (e.key === "i" || e.key === "I") {
                    e.preventDefault();
                    window.applyStyleToTextBox("italic");
                } else if (e.key === "u" || e.key === "U") {
                    e.preventDefault();
                    window.applyStyleToTextBox("underline");
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    commitCanvasText();
                }
            }
            if (e.key === "Escape") {
                const textBox2 = document.getElementById("canvasTextBox");
                if (textBox2) textBox2.style.display = "none";
                const tb = document.getElementById("textFloatingToolbar");
                if (tb) tb.style.display = "none";
                editingTextLayerId = null;
            }
        });
    }
}

// Setup beim Laden
setupTextToolbarEvents();

// Toolbar mit Props aus einer Text-Ebene befüllen
function loadTextPropsIntoToolbar(props) {
    if (!props) return;
    
    if (props.font) { const sel = document.getElementById("ttFont"); if (sel) sel.value = props.font; }
    if (props.size) { const inp = document.getElementById("ttSize"); if (inp) inp.value = props.size; }
    if (props.effect) { const sel = document.getElementById("ttEffect"); if (sel) sel.value = props.effect; }
    
    const setToggle = (id, val) => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle("tt-active", !!val);
    };
    setToggle("ttBold", props.bold);
    setToggle("ttItalic", props.italic);
    setToggle("ttUnderline", props.underline);
    setToggle("ttShadow", props.shadow);
    
    // Ausrichtung
    ["ttAlignLeft", "ttAlignCenter", "ttAlignRight"].forEach(id => {
        document.getElementById(id)?.classList.remove("tt-active");
    });
    const alignMap = { "left": "ttAlignLeft", "center": "ttAlignCenter", "right": "ttAlignRight" };
    document.getElementById(alignMap[props.align] || "ttAlignLeft")?.classList.add("tt-active");
    
    if (props.color) {
        const tc = document.getElementById("ttColor");
        const tcd = document.getElementById("ttColorDisplay");
        if (tc) tc.value = props.color;
        if (tcd) tcd.style.background = props.color;
    }
    if (props.lineHeight) { const sel = document.getElementById("ttLineHeight"); if (sel) sel.value = props.lineHeight; }
    if (props.spacing !== undefined) { const inp = document.getElementById("ttSpacing"); if (inp) inp.value = props.spacing; }
    if (props.opacity !== undefined) {
        const inp = document.getElementById("ttOpacity");
        const val = document.getElementById("ttOpacityVal");
        if (inp) inp.value = props.opacity;
        if (val) val.textContent = Math.round(props.opacity * 100) + "%";
    }
    if (props.shadowColor) { const inp = document.getElementById("ttShadowColor"); if (inp) inp.value = props.shadowColor; }
    if (props.shadowBlur !== undefined) {
        const inp = document.getElementById("ttShadowBlur");
        const val = document.getElementById("ttShadowBlurVal");
        if (inp) inp.value = props.shadowBlur;
        if (val) val.textContent = props.shadowBlur;
    }
    if (props.shadowOffsetX !== undefined) {
        const inp = document.getElementById("ttShadowX");
        const val = document.getElementById("ttShadowXVal");
        if (inp) inp.value = props.shadowOffsetX;
        if (val) val.textContent = props.shadowOffsetX;
    }
    if (props.shadowOffsetY !== undefined) {
        const inp = document.getElementById("ttShadowY");
        const val = document.getElementById("ttShadowYVal");
        if (inp) inp.value = props.shadowOffsetY;
        if (val) val.textContent = props.shadowOffsetY;
    }
}

function commitCanvasText() {
    const textBox = document.getElementById("canvasTextBox");
    if (!textBox || textBox.style.display === "none") return;
    
    // Textinhalt aus contenteditable lesen (innerText preserviert Zeilenumbrüche)
    const text = (textBox.innerText || textBox.textContent || "").replace(/\r\n/g, "\n");
    
    textBox.style.display = "none";
    const toolbar = document.getElementById("textFloatingToolbar");
    if (toolbar) toolbar.style.display = "none";
    
    if (text.trim() === "") { editingTextLayerId = null; return; }
    
    let layer;
    if (editingTextLayerId) {
        layer = layers.find(l => l.id === editingTextLayerId);
        if (!layer) { editingTextLayerId = null; return; }
        layer.name = text.substring(0, 15) + (text.length > 15 ? "..." : "");
    } else {
        addNewLayer(null, text.substring(0, 15) + (text.length > 15 ? "..." : ""));
        layer = getActiveLayer();
    }
    
    // Props aus dem Floating Toolbar lesen
    const toolbarProps = getTextPropsFromToolbar();
    
    let x, y;
    if (editingTextLayerId && layer.textProps && layer.textProps.x !== undefined) {
        x = layer.textProps.x;
        y = layer.textProps.y;
    } else {
        const rawX = parseFloat(textBox.style.left) || 0;
        const rawY = parseFloat(textBox.style.top) || 0;
        x = (rawX - (layer.x || 0)) / (layer.scale || 1);
        y = (rawY - (layer.y || 0)) / (layer.scale || 1);
    }
    
    layer.isTextLayer = true;
    layer.textContent = text;
    layer.textProps = { ...toolbarProps, x, y };
    
    renderTextLayer(layer);
    editingTextLayerId = null;
    saveLogoState();
    renderMainCanvas();
}



// ---------------------------------------------------------
// MAUS & TABLET INTERAKTION (Interpoliertes Zeichnen, Live-Text & Wasserfarbe)
// ---------------------------------------------------------
let lastDrawPos = null;
let shapeStartPos = null;
let isResizingCrop = false;
let isResizingCanvas = false;

// PRO-SMUDGE VARIABLEN (Wasserfarbe)
const smudgeCanvas = document.createElement("canvas");
const smudgeCtx = smudgeCanvas.getContext("2d", { willReadFrequently: true });
let currentTransferOpacity = 1.0; 

// GRADIENT & CLONE STAMP TOOL STATE (Photoshop Tools)
let gradientStartPos = null;
let isDrawingGradient = false;
let cloneSourcePos = null;
let cloneOffset = null;
let isCloning = false;

function applyCloneStampDab(targetPos) {
    const layer = getActiveLayer();
    if (!layer || !cloneSourcePos || !cloneOffset) return;
    
    const size = getActiveBrushSize() / (layer.scale || 1);
    const r = Math.max(1, size / 2);
    const opacity = getActiveBrushOpacity();
    
    const srcX = targetPos.x + cloneOffset.dx;
    const srcY = targetPos.y + cloneOffset.dy;
    
    layer.ctx.save();
    layer.ctx.globalAlpha = opacity;
    if (layer.alphaLocked) layer.ctx.globalCompositeOperation = "source-atop";
    
    layer.ctx.beginPath();
    layer.ctx.arc(targetPos.x, targetPos.y, r, 0, Math.PI * 2);
    layer.ctx.closePath();
    layer.ctx.clip();
    
    layer.ctx.drawImage(
        layer.canvas,
        srcX - r, srcY - r, size, size,
        targetPos.x - r, targetPos.y - r, size, size
    );
    layer.ctx.restore();
    
    if (lassoCanvas && lassoCtx) {
        lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        lassoCtx.save();
        lassoCtx.strokeStyle = "rgba(0, 243, 255, 0.8)";
        lassoCtx.lineWidth = 1.5;
        const sScreenX = (srcX * (layer.scale || 1)) + layer.x;
        const sScreenY = (srcY * (layer.scale || 1)) + layer.y;
        lassoCtx.beginPath();
        lassoCtx.arc(sScreenX, sScreenY, 8, 0, Math.PI * 2);
        lassoCtx.moveTo(sScreenX - 12, sScreenY);
        lassoCtx.lineTo(sScreenX + 12, sScreenY);
        lassoCtx.moveTo(sScreenX, sScreenY - 12);
        lassoCtx.lineTo(sScreenX, sScreenY + 12);
        lassoCtx.stroke();
        lassoCtx.restore();
    }
}

function applyCloneStampStroke(fromPos, toPos) {
    if (!fromPos) {
        applyCloneStampDab(toPos);
        return;
    }
    const layer = getActiveLayer();
    if (!layer) return;
    const size = getActiveBrushSize() / (layer.scale || 1);
    const step = Math.max(2, size * 0.25);
    const dist = Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y);
    const steps = Math.ceil(dist / step);
    
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpPos = {
            x: fromPos.x + (toPos.x - fromPos.x) * t,
            y: fromPos.y + (toPos.y - fromPos.y) * t,
            pressure: toPos.pressure
        };
        applyCloneStampDab(interpPos);
    }
}

function onEditorPointerDown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "BUTTON" || 
        e.target.closest?.("button") || e.target.closest?.(".sidebar-panel") || 
        e.target.closest?.("#textFloatingToolbar") || e.target.closest?.("#canvasTextBox") ||
        e.target.closest?.(".csp-dockable-panel"))) {
        return; 
    } 
    
    if (e.target && e.target.id === "cropHandle") { if(isCropLocked) return; isResizingCrop = true; e.stopPropagation(); return; }
    if (e.target && e.target.id === "canvasHandle") { if(isCanvasLocked) return; isResizingCanvas = true; e.stopPropagation(); return; }

    if (e.preventDefault) e.preventDefault(); 
    if (e.stopPropagation) e.stopPropagation();
    try {
        const cropTarget = e.currentTarget || document.getElementById("logoCropContainer");
        if (e.pointerId !== undefined && cropTarget && cropTarget.setPointerCapture) {
            cropTarget.setPointerCapture(e.pointerId);
        }
    } catch(err) {}

    const pos = getCanvasPos(e); const absolutePos = getCanvasPos(e, true); 

    const targetDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed)
        ? (e.view && e.view.document ? e.view.document : window.popoutEditorWindow.document)
        : document;
    if (typeof updateBrushCursorTracker === "function") updateBrushCursorTracker(e, targetDoc);

    if (e.button === 2) { pickColorFromView(absolutePos); return; }

    if (activeTool === "transform") {
        const layer = getActiveLayer();
        if (layer && !layer.locked) {
            if (layer.rotate === undefined) layer.rotate = 0;
            if (layer.skewX === undefined) layer.skewX = 0;
            if (layer.skewY === undefined) layer.skewY = 0;
            if (layer.scale === undefined) layer.scale = 1;
            const dw = layer.canvas.width * layer.scale;
            const dh = layer.canvas.height * layer.scale;
            const local = screenToLocal(absolutePos.x, absolutePos.y, layer);
            const handle = getHandleAtLocal(local.lx, local.ly, dw, dh);
            if (handle) {
                transformState.mode = handle;
                transformState.initialX = layer.x;
                transformState.initialY = layer.y;
                transformState.initialScale = layer.scale;
                transformState.initialRotate = layer.rotate;
                transformState.initialSkewX = layer.skewX;
                transformState.initialSkewY = layer.skewY;
                transformState.startMouseX = absolutePos.x;
                transformState.startMouseY = absolutePos.y;
                transformState.center = { x: layer.x + dw / 2, y: layer.y + dh / 2 };
                e.stopPropagation();
                e.preventDefault();
                return;
            }
        }
    }

    if (activeTool === "move" || isSpaceDown) {
        logoData.isDragging = true; logoData.startX = e.clientX - logoData.x; logoData.startY = e.clientY - logoData.y; updateCursor();
    }
    else if (activeTool === "cropMove") {
        logoData.isDraggingCrop = true;
        logoData.startCropX = absolutePos.x - cropBox.x;
        logoData.startCropY = absolutePos.y - cropBox.y;
    }
    else if (activeTool === "layerMove") {
        const layer = getActiveLayer();
        if(layer) { 
            if (layer.locked) return;
            layer.isDragging = true; 
            layer.startX = absolutePos.x - layer.x; 
            layer.startY = absolutePos.y - layer.y; 
        }
    }
    else if (activeTool === "fill") {
        const ctx = getActiveCtx();
        const layer = getActiveLayer();
        if(ctx && layer) {
            if (layer.locked) return;
            if (layer.alphaLocked) {
                const pixel = ctx.getImageData(pos.x, pos.y, 1, 1).data;
                if (pixel[3] === 0) return;
            }
            if (window.isEraserToggleMode) {
                floodFillTransparent(ctx, pos.x, pos.y);
            } else {
                floodFill(ctx, pos.x, pos.y, getActiveColor());
            }
            saveLogoState(); renderMainCanvas();
        }
    }
    else if (activeTool === "eyedropper") { pickColorFromView(absolutePos); }
    else if (activeTool === "text") {
        const textBox = document.getElementById("canvasTextBox");
        if (textBox && textBox.style.display !== "none") {
            return;
        } else {
            const layer = getActiveLayer();
            if (layer && layer.locked) return;
            
            editingTextLayerId = null;
            if (textBox) {
                textBox.innerText = "";
                textBox.style.left = absolutePos.x + "px";
                textBox.style.top  = absolutePos.y + "px";
                textBox.style.display = "block";
                syncTextBoxStyles();
                positionTextToolbar();
                setTimeout(() => {
                    textBox.focus();
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.selectNodeContents(textBox);
                    range.collapse(false);
                    sel?.removeAllRanges();
                    sel?.addRange(range);
                }, 50);
            }
        }
    }
    else if (activeTool === "gradient") {
        const layer = getActiveLayer();
        if (layer && !layer.locked) {
            gradientStartPos = { x: pos.x, y: pos.y };
            isDrawingGradient = true;
        }
    }
    else if (activeTool === "clone") {
        const layer = getActiveLayer();
        if (layer && !layer.locked) {
            if (e.altKey) {
                cloneSourcePos = { x: pos.x, y: pos.y };
                if (lassoCanvas && lassoCtx) {
                    lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
                    lassoCtx.save();
                    lassoCtx.strokeStyle = "#00f3ff";
                    lassoCtx.lineWidth = 2;
                    const sScreenX = (pos.x * layer.scale) + layer.x;
                    const sScreenY = (pos.y * layer.scale) + layer.y;
                    lassoCtx.beginPath();
                    lassoCtx.arc(sScreenX, sScreenY, 14, 0, Math.PI * 2);
                    lassoCtx.moveTo(sScreenX - 20, sScreenY);
                    lassoCtx.lineTo(sScreenX + 20, sScreenY);
                    lassoCtx.moveTo(sScreenX, sScreenY - 20);
                    lassoCtx.lineTo(sScreenX, sScreenY + 20);
                    lassoCtx.stroke();
                    lassoCtx.restore();
                    setTimeout(() => { if (lassoCtx) lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height); }, 800);
                }
                return;
            }
            if (!cloneSourcePos) {
                alert("Klonstempel: Bitte zuerst mit gedrückter Alt-Taste auf die Quellstelle klicken!");
                return;
            }
            cloneOffset = {
                dx: cloneSourcePos.x - pos.x,
                dy: cloneSourcePos.y - pos.y
            };
            isCloning = true;
            lastDrawPos = pos;
            applyCloneStampDab(pos);
            renderMainCanvas();
        }
    }
    else {
        const layer = getActiveLayer();
        if (layer && layer.locked) return;
        const ctx = getActiveCtx(); if(!ctx) return;
        isDrawing = true;
        
        if (activeTool === "smudge") {
            const layer = getActiveLayer();
            if (layer) {
                const size = getActiveBrushSize() / layer.scale;
                const opacity = getActiveBrushOpacity();
                if (typeof BrushEngine !== 'undefined') {
                    BrushEngine.beginStroke(pos, {
                        tool: 'smudge',
                        size: size,
                        sourceCanvas: layer.canvas,
                        opacity: opacity
                    });
                }
                lastDrawPos = pos;
            }
        }
        else if (activeTool === "lasso") { lassoPoints = []; lassoPoints.push(absolutePos); drawLassoPreview(); } 
        else if (activeTool === "shape") { shapeStartPos = pos; } 
        else if (activeTool === "eraser" || activeTool === "brush" || activeTool === "airbrush" || activeTool === "raster") { 
            if (activeTool !== "raster" && activeTool !== "eraser" && !window.isEraserToggleMode) {
                draftCanvas.width = baseWidth; draftCanvas.height = baseHeight;
                draftCtx.clearRect(0, 0, baseWidth, baseHeight);
                draftCanvas.style.opacity = getActiveBrushOpacity();
            }
            drawOnCanvas(pos, false); 
        }
    }
}

if (logoCropContainer) {
    logoCropContainer.addEventListener("pointerdown", onEditorPointerDown);
}


function onEditorPointerMove(e) {
    const pos = getCanvasPos(e); const absolutePos = getCanvasPos(e, true);
    
    const targetDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed)
        ? (e.view && e.view.document ? e.view.document : window.popoutEditorWindow.document)
        : document;
    if (typeof updateBrushCursorTracker === "function") updateBrushCursorTracker(e, targetDoc);

    if (activeTool === "transform" && !transformState.mode) {
        const layer = getActiveLayer();
        if (layer && !layer.locked) {
            const dw = layer.canvas.width * (layer.scale || 1);
            const dh = layer.canvas.height * (layer.scale || 1);
            const local = screenToLocal(absolutePos.x, absolutePos.y, layer);
            const handle = getHandleAtLocal(local.lx, local.ly, dw, dh);
            const container = document.getElementById("logoCropContainer");
            if (handle === "rotate") container.style.cursor = "crosshair";
            else if (handle === "scale-tl" || handle === "scale-br") container.style.cursor = "nwse-resize";
            else if (handle === "scale-tr" || handle === "scale-bl") container.style.cursor = "nesw-resize";
            else if (handle === "skew-t" || handle === "skew-b") container.style.cursor = "ew-resize";
            else if (handle === "skew-l" || handle === "skew-r") container.style.cursor = "ns-resize";
            else if (handle === "move") container.style.cursor = "move";
            else container.style.cursor = "default";
        }
    }

    if (activeTool === "transform" && transformState.mode) {
        const layer = getActiveLayer();
        if (layer) {
            const dx = absolutePos.x - transformState.startMouseX;
            const dy = absolutePos.y - transformState.startMouseY;
            if (transformState.mode === "move") {
                layer.x = transformState.initialX + dx;
                layer.y = transformState.initialY + dy;
            }
            else if (transformState.mode === "rotate") {
                const center = transformState.center;
                const initialAngle = Math.atan2(transformState.startMouseY - center.y, transformState.startMouseX - center.x);
                const currentAngle = Math.atan2(absolutePos.y - center.y, absolutePos.x - center.x);
                let angleDiff = currentAngle - initialAngle;
                if (e.shiftKey) {
                    const snapAngle = Math.PI / 12;
                    let targetAngle = transformState.initialRotate + angleDiff;
                    targetAngle = Math.round(targetAngle / snapAngle) * snapAngle;
                    layer.rotate = targetAngle;
                } else {
                    layer.rotate = transformState.initialRotate + angleDiff;
                }
            }
            else if (transformState.mode.startsWith("scale")) {
                const center = transformState.center;
                const initialDist = Math.hypot(transformState.startMouseY - center.y, transformState.startMouseX - center.x);
                const currentDist = Math.hypot(absolutePos.y - center.y, absolutePos.x - center.x);
                let scaleRatio = currentDist / Math.max(10, initialDist);
                layer.scale = Math.max(0.1, Math.min(10, transformState.initialScale * scaleRatio));
            }
            else if (transformState.mode.startsWith("skew")) {
                const mode = transformState.mode;
                if (mode === "skew-l" || mode === "skew-r") {
                    const factor = mode === "skew-l" ? -1 : 1;
                    layer.skewX = transformState.initialSkewX + factor * (dx / 100);
                } else if (mode === "skew-t" || mode === "skew-b") {
                    const factor = mode === "skew-t" ? -1 : 1;
                    layer.skewY = transformState.initialSkewY + factor * (dy / 100);
                }
            }
            renderMainCanvas();
            return;
        }
    }

    if (isResizingCrop) {
        let newW = absolutePos.x - cropBox.x; let newH = absolutePos.y - cropBox.y;
        cropBox.w = Math.max(50, Math.min(newW, baseWidth - cropBox.x)); cropBox.h = Math.max(50, Math.min(newH, baseHeight - cropBox.y));
        updateCropBoxUI(); return;
    }
    if (isResizingCanvas) {
        let newW = Math.max(100, absolutePos.x); let newH = Math.max(100, absolutePos.y);
        logoTransformWrapper.style.width = newW + "px"; logoTransformWrapper.style.height = newH + "px";
        document.getElementById("canvasW").value = Math.round(newW); document.getElementById("canvasH").value = Math.round(newH);
        return;
    }

    if ((activeTool === "move" || isSpaceDown) && logoData.isDragging) {
        logoData.x = e.clientX - logoData.startX; logoData.y = e.clientY - logoData.startY; updateLogoTransform();
    } 
    else if (activeTool === "cropMove" && logoData.isDraggingCrop) {
        let newX = absolutePos.x - logoData.startCropX; let newY = absolutePos.y - logoData.startCropY;
        cropBox.x = Math.max(0, Math.min(newX, baseWidth - cropBox.w)); cropBox.y = Math.max(0, Math.min(newY, baseHeight - cropBox.h));
        updateCropBoxUI();
    }
    else if (activeTool === "layerMove") {
        const layer = getActiveLayer();
        if(layer && layer.isDragging) {
            let targetX = absolutePos.x - layer.startX;
            let targetY = absolutePos.y - layer.startY;
            
            const lw = layer.canvas.width * (layer.scale || 1);
            const lh = layer.canvas.height * (layer.scale || 1);
            
            let snapX = null;
            let snapY = null;
            
            const threshold = 6;
            
            // Collect snap points of canvas and other visible layers:
            const targetsX = [];
            const targetsY = [];
            
            // Canvas boundaries
            targetsX.push({ val: 0, type: 'left', label: 'Canvas Left' });
            targetsX.push({ val: baseWidth / 2, type: 'center', label: 'Canvas Center X' });
            targetsX.push({ val: baseWidth, type: 'right', label: 'Canvas Right' });
            
            targetsY.push({ val: 0, type: 'top', label: 'Canvas Top' });
            targetsY.push({ val: baseHeight / 2, type: 'center', label: 'Canvas Center Y' });
            targetsY.push({ val: baseHeight, type: 'bottom', label: 'Canvas Bottom' });
            
            // Other visible layers
            layers.forEach(other => {
                if (other.id === layer.id || !other.visible) return;
                const oW = other.canvas.width * (other.scale || 1);
                const oH = other.canvas.height * (other.scale || 1);
                
                targetsX.push({ val: other.x, type: 'left', label: other.name });
                targetsX.push({ val: other.x + oW / 2, type: 'center', label: other.name });
                targetsX.push({ val: other.x + oW, type: 'right', label: other.name });
                
                targetsY.push({ val: other.y, type: 'top', label: other.name });
                targetsY.push({ val: other.y + oH / 2, type: 'center', label: other.name });
                targetsY.push({ val: other.y + oH, type: 'bottom', label: other.name });
            });
            
            // Find closest X snap
            let minDiffX = Infinity;
            let bestTargetX = null;
            let activeSnapTypeX = null;
            
            const activePointsX = [
                { val: targetX, type: 'left' },
                { val: targetX + lw / 2, type: 'center' },
                { val: targetX + lw, type: 'right' }
            ];
            
            activePointsX.forEach(ap => {
                targetsX.forEach(t => {
                    const diff = Math.abs(ap.val - t.val);
                    if (diff < threshold && diff < minDiffX) {
                        minDiffX = diff;
                        if (ap.type === 'left') {
                            bestTargetX = t.val;
                        } else if (ap.type === 'center') {
                            bestTargetX = t.val - lw / 2;
                        } else if (ap.type === 'right') {
                            bestTargetX = t.val - lw;
                        }
                        activeSnapTypeX = { activeVal: ap.val, targetVal: t.val, activeType: ap.type, targetType: t.type };
                    }
                });
            });
            
            if (bestTargetX !== null) {
                targetX = bestTargetX;
                snapX = activeSnapTypeX;
            }
            
            // Find closest Y snap
            let minDiffY = Infinity;
            let bestTargetY = null;
            let activeSnapTypeY = null;
            
            const activePointsY = [
                { val: targetY, type: 'top' },
                { val: targetY + lh / 2, type: 'center' },
                { val: targetY + lh, type: 'bottom' }
            ];
            
            activePointsY.forEach(ap => {
                targetsY.forEach(t => {
                    const diff = Math.abs(ap.val - t.val);
                    if (diff < threshold && diff < minDiffY) {
                        minDiffY = diff;
                        if (ap.type === 'top') {
                            bestTargetY = t.val;
                        } else if (ap.type === 'center') {
                            bestTargetY = t.val - lh / 2;
                        } else if (ap.type === 'bottom') {
                            bestTargetY = t.val - lh;
                        }
                        activeSnapTypeY = { activeVal: ap.val, targetVal: t.val, activeType: ap.type, targetType: t.type };
                    }
                });
            });
            
            if (bestTargetY !== null) {
                targetY = bestTargetY;
                snapY = activeSnapTypeY;
            }
            
            layer.x = targetX;
            layer.y = targetY;
            
            renderMainCanvas();
            
            lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
            
            if (snapX || snapY) {
                lassoCtx.save();
                lassoCtx.strokeStyle = "#00f3ff"; // Neon-turquoise
                lassoCtx.lineWidth = 1.5;
                lassoCtx.setLineDash([4, 4]); // Dashed line
                
                if (snapX) {
                    lassoCtx.beginPath();
                    lassoCtx.moveTo(snapX.targetVal, 0);
                    lassoCtx.lineTo(snapX.targetVal, lassoCanvas.height);
                    lassoCtx.stroke();
                }
                
                if (snapY) {
                    lassoCtx.beginPath();
                    lassoCtx.moveTo(0, snapY.targetVal);
                    lassoCtx.lineTo(lassoCanvas.width, snapY.targetVal);
                    lassoCtx.stroke();
                }
                
                lassoCtx.restore();
            }
        }
    }
    else if (isDrawingGradient && gradientStartPos) {
        const layer = getActiveLayer();
        if (layer && lassoCanvas && lassoCtx) {
            lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
            const sX = (gradientStartPos.x * (layer.scale || 1)) + layer.x;
            const sY = (gradientStartPos.y * (layer.scale || 1)) + layer.y;
            const cX = (pos.x * (layer.scale || 1)) + layer.x;
            const cY = (pos.y * (layer.scale || 1)) + layer.y;
            
            lassoCtx.save();
            lassoCtx.strokeStyle = "#ffffff";
            lassoCtx.lineWidth = 1.5;
            lassoCtx.setLineDash([4, 4]);
            lassoCtx.beginPath();
            lassoCtx.moveTo(sX, sY);
            lassoCtx.lineTo(cX, cY);
            lassoCtx.stroke();
            
            lassoCtx.setLineDash([]);
            lassoCtx.fillStyle = getActiveColor();
            lassoCtx.strokeStyle = "#000";
            lassoCtx.beginPath();
            lassoCtx.arc(sX, sY, 6, 0, Math.PI * 2);
            lassoCtx.fill();
            lassoCtx.stroke();
            
            lassoCtx.fillStyle = "#ffffff";
            lassoCtx.beginPath();
            lassoCtx.arc(cX, cY, 5, 0, Math.PI * 2);
            lassoCtx.fill();
            lassoCtx.stroke();
            lassoCtx.restore();
        }
    }
    else if (isCloning && cloneSourcePos && cloneOffset) {
        applyCloneStampStroke(lastDrawPos, pos);
        lastDrawPos = pos;
        renderMainCanvas();
    }
    else if (isDrawing) {
        if (activeTool === "lasso") { lassoPoints.push(absolutePos); drawLassoPreview(); } 
        else if (activeTool === "shape" && shapeStartPos) {
            const layer = getActiveLayer();
            draftCtx.clearRect(0, 0, baseWidth, baseHeight); 
            draftCtx.strokeStyle = getActiveColor(); draftCtx.lineWidth = parseInt(getActiveBrushSize());
            
            let sX = (shapeStartPos.x * layer.scale) + layer.x; let sY = (shapeStartPos.y * layer.scale) + layer.y;
            let currX = (pos.x * layer.scale) + layer.x; let currY = (pos.y * layer.scale) + layer.y;
            draftCtx.strokeRect(sX, sY, currX - sX, currY - sY);
        }
        else if (activeTool === "smudge") {
            const layer = getActiveLayer();
            if (layer) {
                const size = getActiveBrushSize() / layer.scale;
                const smoothing = getActiveBrushSmoothing();
                if (typeof BrushEngine !== 'undefined') {
                    BrushEngine.moveStroke(pos, {
                        tool: 'smudge',
                        size: size,
                        smoothing: smoothing,
                        targetCanvas: layer.canvas,
                        targetCtx: layer.ctx
                    });
                }
                lastDrawPos = pos;
                renderMainCanvas();
            }
        }
        else if (activeTool === "eraser" || activeTool === "brush" || activeTool === "airbrush" || activeTool === "raster") { drawOnCanvas(pos, true); }
    }
}

window.addEventListener("pointermove", onEditorPointerMove);

function onEditorPointerUp(e) {
    const pos = getCanvasPos(e);
    const absolutePos = getCanvasPos(e, true);

    const targetDoc = (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed)
        ? (e.view && e.view.document ? e.view.document : window.popoutEditorWindow.document)
        : document;
    if (typeof updateBrushCursorTracker === "function") updateBrushCursorTracker(e, targetDoc);

    try {
        const cropTarget = e.currentTarget || document.getElementById("logoCropContainer");
        if (e.pointerId !== undefined && cropTarget && cropTarget.releasePointerCapture) {
            cropTarget.releasePointerCapture(e.pointerId);
        }
    } catch(err) {}
    if (activeTool === "transform" && transformState.mode) {
        transformState.mode = null;
        saveLogoState();
        renderMainCanvas();
    }
    if (isResizingCrop) { isResizingCrop = false; }
    if (isResizingCanvas) { 
        isResizingCanvas = false; 
        const newW = parseInt(document.getElementById("canvasW").value);
        const newH = parseInt(document.getElementById("canvasH").value);
        if(confirm(`Leinwand auf ${newW}x${newH} skalieren?`)) { executeCanvasResize(newW, newH); } 
        else { executeCanvasResize(baseWidth, baseHeight); }
    }

    if(logoData.isDraggingCrop) logoData.isDraggingCrop = false;
    if(logoData.isDragging) { logoData.isDragging = false; updateCursor(); }
    const layer = getActiveLayer(); if(layer && layer.isDragging) { layer.isDragging = false; saveLogoState(); }
    if (activeTool === "layerMove") {
        lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
    }
    
    if (isDrawingGradient && gradientStartPos) {
        const layer = getActiveLayer();
        if (layer && !layer.locked) {
            const dx = pos.x - gradientStartPos.x;
            const dy = pos.y - gradientStartPos.y;
            const dist = Math.hypot(dx, dy);
            
            const gradEndX = dist < 5 ? gradientStartPos.x + 100 : pos.x;
            const gradEndY = dist < 5 ? gradientStartPos.y + 100 : pos.y;
            
            const grad = layer.ctx.createLinearGradient(gradientStartPos.x, gradientStartPos.y, gradEndX, gradEndY);
            const col = getActiveColor();
            const opacity = getActiveBrushOpacity();
            const rgb = hexToRgbaArray(col);
            
            grad.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})`);
            grad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
            
            layer.ctx.save();
            if (layer.alphaLocked) layer.ctx.globalCompositeOperation = "source-atop";
            layer.ctx.fillStyle = grad;
            layer.ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
            layer.ctx.restore();
            
            saveLogoState();
            renderMainCanvas();
        }
        if (lassoCtx) lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        isDrawingGradient = false;
        gradientStartPos = null;
    }
    if (isCloning) {
        isCloning = false;
        if (lassoCtx) lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        saveLogoState();
        renderMainCanvas();
    }
    
    if (isDrawing) {
        isDrawing = false;
        if (activeTool === "lasso") {
            const ctx = getActiveCtx();
            if(ctx && lassoPoints.length > 2) {
                ctx.save();
                ctx.beginPath(); 
                ctx.moveTo((lassoPoints[0].x - layer.x)/layer.scale, (lassoPoints[0].y - layer.y)/layer.scale);
                for(let i=1; i<lassoPoints.length; i++) { ctx.lineTo((lassoPoints[i].x - layer.x)/layer.scale, (lassoPoints[i].y - layer.y)/layer.scale); }
                ctx.closePath(); 
                
                if (window.isEraserToggleMode) {
                    ctx.globalCompositeOperation = "destination-out";
                    ctx.fillStyle = "rgba(0,0,0,1)";
                    ctx.globalAlpha = getActiveBrushOpacity();
                } else {
                    const rgb = hexToRgbaArray(getActiveColor());
                    ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${getActiveBrushOpacity()})`; 
                }
                ctx.fill(); 
                ctx.restore();
                saveLogoState(); renderMainCanvas();
            }
            lassoPoints = []; lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        }
        else if (activeTool === "shape" && shapeStartPos) {
            const ctx = getActiveCtx();
            if(ctx) {
                ctx.strokeStyle = getActiveColor(); 
                ctx.lineWidth = parseInt(getActiveBrushSize()) / layer.scale; 
                ctx.globalAlpha = getActiveBrushOpacity();
                ctx.strokeRect(shapeStartPos.x, shapeStartPos.y, pos.x - shapeStartPos.x, pos.y - shapeStartPos.y); 
                saveLogoState(); renderMainCanvas();
            }
            shapeStartPos = null; draftCtx.clearRect(0, 0, baseWidth, baseHeight);
        }
        else if (activeTool === "brush" || activeTool === "airbrush") {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.endStroke({
                    tool: activeTool,
                    size: getActiveBrushSize(),
                    targetCtx: draftCtx
                });
            }
            if (layer) {
                if (!window.isEraserToggleMode) {
                    const opacity = getActiveBrushOpacity();
                    layer.ctx.globalAlpha = opacity;
                    if (layer.alphaLocked) layer.ctx.globalCompositeOperation = "source-atop";
                    
                    layer.ctx.drawImage(draftCanvas, -layer.x / layer.scale, -layer.y / layer.scale, baseWidth / layer.scale, baseHeight / layer.scale); 
                        
                    layer.ctx.globalAlpha = 1.0; layer.ctx.globalCompositeOperation = "source-over";
                    draftCtx.clearRect(0, 0, baseWidth, baseHeight); draftCanvas.style.opacity = 1;
                }
                saveLogoState(); renderMainCanvas();
            }
        } 
        else if (activeTool === "eraser" || activeTool === "smudge" || activeTool === "raster") { 
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.endStroke({
                    tool: activeTool,
                    size: getActiveBrushSize() / (layer ? layer.scale : 1),
                    targetCtx: layer ? layer.ctx : null,
                    targetCanvas: layer ? layer.canvas : null
                });
            }
            saveLogoState(); 
            renderMainCanvas(); 
        }
    }
}

window.addEventListener("pointerup", onEditorPointerUp);

function drawOnCanvas(pos, isMoving) {
    const layer = getActiveLayer();
    if (!layer) return;

    if (draftCanvas.width !== baseWidth || draftCanvas.height !== baseHeight) { 
        draftCanvas.width = baseWidth; 
        draftCanvas.height = baseHeight; 
    }

    const size = getActiveBrushSize();
    const scaledSize = size / layer.scale; 
    const hardness = getActiveBrushHardness();
    const smoothing = getActiveBrushSmoothing();
    const color = getActiveColor();

    if (activeTool === "eraser") {
        if (!isMoving) { 
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.beginStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: hardness,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos; 
        } else if (lastDrawPos) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.moveStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: hardness,
                    smoothing: smoothing,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos;
        }
        renderMainCanvas();
    } 
    else if (activeTool === "brush" && window.isEraserToggleMode) {
        // Pinsel in Eraser Mode
        if (!isMoving) { 
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.beginStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: hardness,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos; 
        } else if (lastDrawPos) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.moveStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: hardness,
                    smoothing: smoothing,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos;
        }
        renderMainCanvas();
    }
    else if (activeTool === "airbrush" && window.isEraserToggleMode) {
        // Airbrush in Eraser Mode
        if (!isMoving) { 
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.beginStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: 0.05,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos; 
        } else if (lastDrawPos) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.moveStroke(pos, {
                    tool: 'eraser',
                    size: scaledSize,
                    hardness: 0.05,
                    smoothing: smoothing,
                    targetCtx: layer.ctx,
                    isEraser: true
                });
            }
            lastDrawPos = pos;
        }
        renderMainCanvas();
    }
    else if (activeTool === "raster") {
        // Standalone Raster (Screentone) tool
        const ctx = layer.ctx;
        ctx.save();
        if (window.isEraserToggleMode) {
            ctx.globalCompositeOperation = "destination-out";
            ctx.fillStyle = "rgba(0,0,0,1)";
        } else {
            ctx.globalCompositeOperation = "source-over";
            if (layer.alphaLocked) ctx.globalCompositeOperation = "source-atop";
            ctx.fillStyle = getActiveColor();
        }
        ctx.globalAlpha = 1.0;
        
        const spacing = 10;
        const rBrush = scaledSize / 2;
        const dotMaxRadius = spacing * 0.4;
        const opacity = getActiveBrushOpacity();
        const dotRadius = Math.max(0.5, dotMaxRadius * opacity);
        
        const minX = Math.floor((pos.x - rBrush) / spacing) * spacing;
        const maxX = Math.ceil((pos.x + rBrush) / spacing) * spacing;
        const minY = Math.floor((pos.y - rBrush) / spacing) * spacing;
        const maxY = Math.ceil((pos.y + rBrush) / spacing) * spacing;
        
        for (let gx = minX; gx <= maxX; gx += spacing) {
            for (let gy = minY; gy <= maxY; gy += spacing) {
                const dx = gx - pos.x;
                const dy = gy - pos.y;
                if (dx * dx + dy * dy <= rBrush * rBrush) {
                    ctx.beginPath();
                    ctx.arc(gx, gy, dotRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
        ctx.restore();
        lastDrawPos = pos;
        renderMainCanvas();
    }
    else if (activeTool === "airbrush") {
        // High-Precision Soft Airbrush via BrushEngine
        let draftPos = { x: (pos.x * layer.scale) + layer.x, y: (pos.y * layer.scale) + layer.y, pressure: pos.pressure };
        if (!isMoving) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.beginStroke(draftPos, {
                    tool: 'airbrush',
                    size: size,
                    hardness: 0.06,
                    color: color,
                    targetCtx: draftCtx
                });
            }
            lastDrawPos = pos;
        } else if (lastDrawPos) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.moveStroke(draftPos, {
                    tool: 'airbrush',
                    size: size,
                    hardness: 0.06,
                    color: color,
                    smoothing: smoothing,
                    targetCtx: draftCtx
                });
            }
            lastDrawPos = pos;
        }
        renderMainCanvas();
    }
    else {
        // High-Precision Standard & Hardness Brush (activeTool === "brush")
        let draftPos = { x: (pos.x * layer.scale) + layer.x, y: (pos.y * layer.scale) + layer.y, pressure: pos.pressure };
        const engineSettings = (typeof BrushEngine !== 'undefined' && BrushEngine.settings) ? BrushEngine.settings : {};
        const strokeOpts = {
            ...engineSettings,
            tool: 'brush',
            size: size,
            hardness: hardness,
            color: color,
            smoothing: smoothing,
            targetCtx: draftCtx
        };
        if (!isMoving) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.beginStroke(draftPos, strokeOpts);
            }
            lastDrawPos = pos;
        } else if (lastDrawPos) {
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.moveStroke(draftPos, strokeOpts);
            }
            lastDrawPos = pos;
        }
        renderMainCanvas();
    }
}

function drawLassoPreview() {
    lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
    if (lassoPoints.length === 0) return;
    lassoCtx.beginPath(); lassoCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for(let i=1; i<lassoPoints.length; i++) { lassoCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y); }
    lassoCtx.strokeStyle = "#fff"; lassoCtx.setLineDash([4, 4]); lassoCtx.lineWidth = 2; lassoCtx.stroke();
}

window.closeLogoEditor = function() { 
    if (typeof AppLogger !== 'undefined') {
        AppLogger.info("LogoEditor", "closeLogoEditor aufgerufen - Zeichenfenster wird geschlossen");
    }
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
        try {
            window.popoutEditorWindow.onbeforeunload = null;
            window.popoutEditorWindow.close();
        } catch (e) {}
    }
    window.popoutEditorWindow = null;
    popoutEditorWindow = null;
    window.isEditorPoppedOut = false;

    const modal = document.getElementById("logoEditorModal");
    if (modal) {
        modal.classList.add("hidden");
        modal.style.setProperty("display", "none", "important");
    }
    
    if (window.hadSettingsOpen) {
        const settingsModal = document.getElementById("settingsModal");
        if (settingsModal) settingsModal.classList.remove("hidden");
        window.hadSettingsOpen = false;
    }
};

////////////////////////////////////////////////////////////
// POP-OUT FENSTER FÜR ZEICHENTABLETT / 2. MONITOR
////////////////////////////////////////////////////////////
let popoutEditorWindow = window.popoutEditorWindow;
let isDockingInProgress = false;

function bridgePopoutEnvironment(childWin) {
    if (!childWin || childWin.closed) return;

    if (typeof window.__patchTauriDomWindow === "function") {
        window.__patchTauriDomWindow(childWin);
    }

    // 1. Alle Funktionen von window auf childWin spiegeln (aber native Fenster-Methoden des Popouts niemals überschreiben!)
    const skipProps = new Set([
        'window', 'document', 'top', 'parent', 'frames', 'self', 'location', 
        'navigator', 'history', 'customElements', 'screen', 'devicePixelRatio',
        'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'screenX', 'screenY',
        'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
        'close', 'closed', 'focus', 'blur', 'opener'
    ]);

    for (const prop of Object.getOwnPropertyNames(window)) {
        if (skipProps.has(prop)) continue;
        try {
            const desc = Object.getOwnPropertyDescriptor(window, prop);
            if (desc && typeof desc.value === 'function') {
                childWin[prop] = window[prop].bind(window);
            } else if (desc && (desc.get || desc.set)) {
                Object.defineProperty(childWin, prop, {
                    get: () => window[prop],
                    set: (val) => { window[prop] = val; },
                    configurable: true,
                    enumerable: true
                });
            } else if (desc && desc.value !== undefined && typeof desc.value === 'object') {
                childWin[prop] = window[prop];
            }
        } catch (e) {}
    }

    // 2. Explizite Kernfunktionen für Menüs, Buttons und Werkzeuge sicherstellen
    const coreFuncs = [
        'setLogoTool', 'undoLogoAction', 'redoLogoAction', 'addNewLayer', 'deleteLayer',
        'setActiveLayer', 'getActiveLayer', 'getActiveCtx', 'renderLayersUI',
        'toggleLayerVisibility', 'toggleLayerLock', 'toggleLayerAlphaLock',
        'moveActiveLayerUp', 'moveActiveLayerDown', 'mergeLayerDown', 'duplicateLayer',
        'updateActiveLayerProps', 'openAdjustmentsModalForActiveLayer', 'showDockMenu',
        'togglePanel', 'switchLogoLeftTab', 'filterLogoGraphics', 'addVectorGraphicToCanvas',
        'editorPerformSave', 'closeEditorSaveOptions', 'openEditorSaveOptions', 'showEditorSaveOptions',
        'assetCreationChoose', 'closeLogoCreationOptions', 'applyCanvasPreset',
        'onCanvasSetupSizeChange', 'closeCanvasSetup', 'submitCanvasSetup',
        'executeCanvasResize', 'saveLogoEditor', 'closeLogoEditor', 'togglePenPressure',
        'togglePopoutEditorWindow', 'dockEditorBack', 'zoomLogoIn', 'zoomLogoOut',
        'zoomLogoReset', 'updateCursor', 'updateCropBoxUI', 'renderMainCanvas',
        'saveLogoState', 'getCanvasPos', 'pickColorFromView', 'commitCanvasText',
        'openBrushStudioModal', 'closeBrushStudioModal', 'toggleBrushStudioModal',
        'applyBrushPreset', 'onBrushParamChange', 'saveCurrentAsNewPreset',
        'deleteCustomBrushPreset', 'updateStrokePreview', 'openPhotoCraftModal',
        'closePhotoCraftModal', 'openShortcutModal', 'closeShortcutModal',
        'onEditorPointerDown', 'onEditorPointerMove', 'onEditorPointerUp',
        'onEditorKeyDown', 'onEditorKeyUp', 'onAdjustmentSliderInput',
        'cancelAdjustmentsModal', 'confirmAdjustmentsModal', 'renameLayerPrompt',
        'toggleColorWheelMode', 'deleteActiveLayer', 'scaleActiveLayer',
        'resizeCropBox', 'resetCanvasSize', 'confirmCanvasResizeInput',
        'toggleCropBox', 'toggleLock',
        'toggleReferencePanel', 'triggerReferenceImport', 'handleReferenceFilesSelect',
        'onReferenceZoomSlider', 'zoomReferenceStep', 'toggleReferenceFitOrActual',
        'onReferenceRotateSlider', 'rotateReferenceStep', 'resetReferenceRotation',
        'toggleReferenceFlipH', 'toggleReferenceFlipV', 'toggleReferenceEyedropper',
        'prevReferenceImage', 'nextReferenceImage', 'toggleReferenceThumbsPopup',
        'importReferenceToCanvas', 'deleteCurrentReference', 'showReferenceInfo',
        'resetReferenceView', 'deleteReferenceByIndex', 'clearAllReferencesPrompt',
        'toggleWindowPanel', 'openDockPanel', 'closeDockPanel', 'toggleFoldPanel',
        'toggleZenMode', 'showAllPanels', 'hideAllPanels', 'resetWorkspaceToDefault',
        'toggleSubTools', 'toggleToolsPanel', 'toggleLayerSearch', 'filterLayersList', 'switchColorSliderMode',
        'onRgbSliderChange', 'onHsvSliderChange', 'onHexInputChange', 'clearColorHistoryPrompt',
        'clearColorMixingPad', 'setColorMixingTool', 'jumpToHistoryState', 'updateNavigatorUI',
        'updateHistoryPanelUI', 'updateWindowMenuCheckmarks',
        'saveLayout', 'restoreLayout', 'getActiveEditorDoc',
        'getActiveColor', 'getActiveBrushSize', 'getActiveBrushOpacity', 'getActiveBrushHardness', 'getActiveBrushSmoothing',
        'applyGlobalColor', 'applyColorWheelSelection',
        'dockPanel', 'reorderPanel', 'expandSidebar', 'initPanelResizers', 'initSidebarResizers', 'initPanelDragAndDrop'
    ];

    coreFuncs.forEach(fn => {
        try {
            if (typeof window[fn] === 'function') {
                childWin[fn] = window[fn].bind(window);
            }
        } catch (err) {}
    });

    if (typeof window.syncWindowManagerWithPopout === 'function') {
        window.syncWindowManagerWithPopout(childWin);
    }

    // Module & Globals
    if (window.BrushEngine) childWin.BrushEngine = window.BrushEngine;
    if (window.BrushStudioUI) childWin.BrushStudioUI = window.BrushStudioUI;

    // Reaktive Variablen spiegeln
    const reactiveVars = [
        'activeTool', 'previousTool', 'isDrawing', 'isSpaceDown', 'isPenPressureActive',
        'isEraserToggleMode', 'logoData', 'cropBox', 'baseWidth', 'baseHeight',
        'layers', 'activeLayerId', 'currentLayerIndex', 'logoShortcuts',
        'cloneSourcePos', 'cloneOffset', 'isCloning', 'isDrawingGradient', 'gradientStartPos',
        'modalLayerId', 'modalLayerBackup'
    ];

    reactiveVars.forEach(v => {
        try {
            Object.defineProperty(childWin, v, {
                get: () => window[v],
                set: (val) => { window[v] = val; },
                configurable: true,
                enumerable: true
            });
        } catch (e) {}
    });

    // 3. Pointer- und Tastaturevents an das Child-Fenster anbinden
    childWin.addEventListener("pointermove", onEditorPointerMove);
    childWin.addEventListener("pointerup", onEditorPointerUp);
    childWin.addEventListener("pointercancel", onEditorPointerUp);
    childWin.addEventListener("mousemove", onEditorPointerMove);
    childWin.addEventListener("mouseup", onEditorPointerUp);
    childWin.document.addEventListener("keydown", onEditorKeyDown);
    childWin.document.addEventListener("keyup", onEditorKeyUp);

    // Pinsel-Slider im Popout-Dokument anbinden & mit Hauptdokument synchronisieren
    const childBrushSize = childWin.document.getElementById("brushSize");
    if (childBrushSize) {
        childBrushSize.addEventListener("input", () => {
            const val = childBrushSize.value;
            const valDiv = childWin.document.getElementById("brushSizeVal");
            if (valDiv) valDiv.innerText = val;
            if (typeof brushSizeSlider !== "undefined" && brushSizeSlider) brushSizeSlider.value = val;
            const mainValDiv = document.getElementById("brushSizeVal");
            if (mainValDiv) mainValDiv.innerText = val;
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.updateSettings({ size: parseFloat(val) });
            }
        });
        if (typeof brushSizeSlider !== "undefined" && brushSizeSlider) {
            childBrushSize.value = brushSizeSlider.value;
            const valDiv = childWin.document.getElementById("brushSizeVal");
            if (valDiv) valDiv.innerText = brushSizeSlider.value;
        }
    }
    const childBrushOpacity = childWin.document.getElementById("brushOpacity");
    if (childBrushOpacity) {
        childBrushOpacity.addEventListener("input", () => {
            const val = childBrushOpacity.value;
            const pct = Math.round(parseFloat(val) * 100) + "%";
            const valDiv = childWin.document.getElementById("brushOpacityVal");
            if (valDiv) valDiv.innerText = pct;
            if (typeof brushOpacitySlider !== "undefined" && brushOpacitySlider) brushOpacitySlider.value = val;
            const mainValDiv = document.getElementById("brushOpacityVal");
            if (mainValDiv) mainValDiv.innerText = pct;
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.updateSettings({ opacity: parseFloat(val) });
            }
        });
        if (typeof brushOpacitySlider !== "undefined" && brushOpacitySlider) {
            childBrushOpacity.value = brushOpacitySlider.value;
            const valDiv = childWin.document.getElementById("brushOpacityVal");
            if (valDiv) valDiv.innerText = Math.round(parseFloat(brushOpacitySlider.value) * 100) + "%";
        }
    }
    const childBrushHardness = childWin.document.getElementById("brushHardness");
    if (childBrushHardness) {
        childBrushHardness.addEventListener("input", () => {
            const val = childBrushHardness.value;
            const pct = Math.round(parseFloat(val) * 100) + "%";
            const valDiv = childWin.document.getElementById("brushHardnessVal");
            if (valDiv) valDiv.innerText = pct;
            const mainH = document.getElementById("brushHardness");
            if (mainH) mainH.value = val;
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.updateSettings({ hardness: parseFloat(val) });
            }
        });
    }
    const childBrushSmoothing = childWin.document.getElementById("brushSmoothing");
    if (childBrushSmoothing) {
        childBrushSmoothing.addEventListener("input", () => {
            const val = childBrushSmoothing.value;
            const pct = Math.round(parseFloat(val) * 100) + "%";
            const valDiv = childWin.document.getElementById("brushSmoothingVal");
            if (valDiv) valDiv.innerText = pct;
            const mainS = document.getElementById("brushSmoothing");
            if (mainS) mainS.value = val;
            if (typeof BrushEngine !== 'undefined') {
                BrushEngine.updateSettings({ smoothing: parseFloat(val) });
            }
        });
    }

    // Klick außerhalb des Ebenen-Kontextmenüs im Child-Dokument schließt das Menü
    childWin.document.addEventListener("mousedown", (e) => {
        const cMenu = childWin.document.getElementById("layerContextMenu");
        if (cMenu && !cMenu.classList.contains("hidden") && !cMenu.contains(e.target)) {
            cMenu.classList.add("hidden");
            cMenu.style.display = "none";
        }
    });

    // Canvas Pointerdown & Zoom im Popout-Fenster
    const childCropContainer = childWin.document.getElementById("logoCropContainer");
    if (childCropContainer) {
        childCropContainer.addEventListener("pointerdown", onEditorPointerDown);
        
        // Mausrad-Zoom für Zeichentablett / 2. Monitor
        childCropContainer.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (e.deltaY < 0) {
                window.zoomLogoIn();
            } else {
                window.zoomLogoOut();
            }
        }, { passive: false });
        
        // Pinsel-Vorschau Circle & Druckstufen-Tracking auf dem Zeichentablett
        const preview = childWin.document.getElementById("brushCursorPreview");
        if (preview) {
            childCropContainer.addEventListener("pointermove", (e) => updateBrushCursorTracker(e, childWin.document));
            childCropContainer.addEventListener("mousemove", (e) => updateBrushCursorTracker(e, childWin.document));
            childCropContainer.addEventListener("pointerenter", (e) => updateBrushCursorTracker(e, childWin.document));
            childCropContainer.addEventListener("pointerleave", () => {
                preview.style.display = "none";
                childCropContainer.style.cursor = "default";
            });
        }
    }

    // Draggable Modal im Popout-Dokument
    if (typeof window.initDraggableModal === "function") {
        window.initDraggableModal(childWin.document);
    }

    // Resizers im Popout-Dokument aktivieren
    if (typeof window.initSidebarResizers === "function") {
        window.initSidebarResizers(childWin.document);
    }
    if (typeof window.initPanelResizers === "function") {
        window.initPanelResizers(childWin.document);
    }

    // 4. PhotoCraft & BrushStudio synchronisieren
    if (typeof window.syncPhotoCraftWithPopout === "function") {
        window.syncPhotoCraftWithPopout(childWin);
    }
    if (typeof window.syncBrushStudioWithPopout === "function") {
        window.syncBrushStudioWithPopout(childWin);
    }
    if (typeof window.syncReferenceViewerWithPopout === "function") {
        window.syncReferenceViewerWithPopout(childWin);
    }
}

window.togglePopoutEditorWindow = function() {
    window.openPopoutEditorWindow();
};

window.openPopoutEditorWindow = function(sourcePath = null, initialImg = null) {
    if (typeof AppLogger !== 'undefined') {
        AppLogger.info("LogoEditor", "openPopoutEditorWindow aufgerufen");
    }

    if (popoutEditorWindow && !popoutEditorWindow.closed) {
        window.popoutEditorWindow = popoutEditorWindow;
        window.isEditorPoppedOut = true;
        popoutEditorWindow.focus();
        setupPopoutCanvasAndLayers(initialImg);
        return;
    }

    const modal = document.getElementById("logoEditorModal");
    const modalContent = modal?.querySelector(".logo-modal-content");
    if (!modal || !modalContent) {
        if (typeof AppLogger !== 'undefined') {
            AppLogger.error("LogoEditor", "Konnte logoEditorModal nicht finden");
        }
        return;
    }

    popoutEditorWindow = window.open('', 'DrawingTabletWindow', 'width=1400,height=900');
    if (!popoutEditorWindow) {
        if (typeof AppLogger !== 'undefined') {
            AppLogger.warn("LogoEditor", "window.open lieferte null - starte Zeichenstudio im Hauptfenster");
        }
        window.isEditorPoppedOut = false;
        window.popoutEditorWindow = null;
        popoutEditorWindow = null;

        modal.classList.remove("hidden");
        modal.style.setProperty("display", "flex", "important");

        if (typeof window.initSidebarResizers === "function") window.initSidebarResizers(document);
        if (typeof window.initPanelResizers === "function") window.initPanelResizers(document);
        if (typeof window.initPanelDragAndDrop === "function") window.initPanelDragAndDrop(document);
        if (typeof window.initDraggableModal === "function") window.initDraggableModal(document);

        bindColorWheelEvents(document, window);
        updateColorWheelModeButtonUI();
        setTimeout(drawCSPColorWheel, 60);

        if (typeof window.restoreLayout === "function") {
            window.restoreLayout(document);
        }
        setupPopoutCanvasAndLayers(initialImg, document);
        return;
    }

    window.popoutEditorWindow = popoutEditorWindow;
    window.isEditorPoppedOut = true;

    popoutEditorWindow.document.title = "My View - Zeichenstudio (Tablet & 2. Bildschirm)";

    if (typeof window.__patchTauriDomWindow === "function") {
        window.__patchTauriDomWindow(popoutEditorWindow);
    }

    const baseEl = popoutEditorWindow.document.createElement("base");
    baseEl.href = window.location.href;
    popoutEditorWindow.document.head.appendChild(baseEl);

    // Stylesheets synchron als Inline-<style> injizieren (umgeht about:blank Cross-Origin-Blockierung in WebView2)
    let injectedMainCss = "";
    try {
        const cssFile = path.join(__dirname, "style.css");
        if (fs.existsSync(cssFile)) {
            injectedMainCss = fs.readFileSync(cssFile, "utf8");
        }
    } catch (e) {}

    if (!injectedMainCss) {
        try {
            injectedMainCss = Array.from(document.styleSheets)
                .map(sheet => {
                    try {
                        return Array.from(sheet.cssRules || []).map(r => r.cssText).join("\n");
                    } catch (e) {
                        return "";
                    }
                })
                .filter(Boolean)
                .join("\n");
        } catch (e) {}
    }

    if (injectedMainCss) {
        const mainStyleEl = popoutEditorWindow.document.createElement("style");
        mainStyleEl.id = "injectedPopoutMainCss";
        mainStyleEl.textContent = injectedMainCss;
        popoutEditorWindow.document.head.appendChild(mainStyleEl);
    }

    // Dynamische Inline-Styles (Fonts, Theme, Cursor) synchron ins Popout kopieren
    Array.from(document.querySelectorAll("style")).forEach(node => {
        try {
            popoutEditorWindow.document.head.appendChild(node.cloneNode(true));
        } catch (e) {}
    });

    // Theme & Body Styling
    popoutEditorWindow.document.documentElement.className = document.documentElement.className;
    popoutEditorWindow.document.documentElement.style.cssText = document.documentElement.style.cssText;
    popoutEditorWindow.document.body.className = document.body.className;
    popoutEditorWindow.document.body.style.margin = "0";
    popoutEditorWindow.document.body.style.padding = "0";
    popoutEditorWindow.document.body.style.width = "100vw";
    popoutEditorWindow.document.body.style.height = "100vh";
    popoutEditorWindow.document.body.style.overflow = "hidden";
    popoutEditorWindow.document.body.style.background = "#181818";
    popoutEditorWindow.document.body.style.display = "flex";
    popoutEditorWindow.document.body.style.flexDirection = "column";

    // 100% sauberer Klon via outerHTML: Original im Hauptdokument bleibt unberührt!
    // Dadurch stürzt Chromium niemals durch zerstörte V8-Kontexte beim Schließen ab!
    popoutEditorWindow.document.body.innerHTML = modalContent.outerHTML;

    // Modals und Dialoge in das Popout-Fenster klonen (immer initial versteckt)
    const popoutModals = [
        "photocraftModal",
        "brushStudioModal",
        "layerContextMenu",
        "logoShortcutModal",
        "logoAdjustmentsModal",
        "canvasSetupModal",
        "editorSaveOptionsModal"
    ];
    popoutModals.forEach(modalId => {
        if (!popoutEditorWindow.document.getElementById(modalId)) {
            const orig = document.getElementById(modalId);
            if (orig) {
                const cloned = orig.cloneNode(true);
                cloned.classList.add("hidden");
                if (modalId === "layerContextMenu" || modalId === "editorSaveOptionsModal") {
                    cloned.style.display = "none";
                }
                popoutEditorWindow.document.body.appendChild(cloned);
            }
        }
    });

    const mounted = popoutEditorWindow.document.querySelector(".logo-modal-content");
    if (mounted) {
        mounted.style.display = "flex";
        mounted.style.flexDirection = "column";
        mounted.style.position = "relative";
        mounted.style.width = "100vw";
        mounted.style.maxWidth = "none";
        mounted.style.height = "100vh";
        mounted.style.maxHeight = "none";
        mounted.style.border = "none";
        mounted.style.borderRadius = "0";
        mounted.style.boxSizing = "border-box";
        mounted.style.padding = "0";
        mounted.style.margin = "0";
        mounted.style.flex = "1";
    }

    const ws = popoutEditorWindow.document.getElementById("cspWorkspaceArea") || popoutEditorWindow.document.querySelector(".logo-modal-content > div:nth-child(2)");
    if (ws) {
        ws.style.flex = "1";
        ws.style.height = "calc(100vh - 75px)";
        ws.style.minHeight = "0";
    }

    // Sauberes Schließen ohne Re-Docking:
    popoutEditorWindow.onbeforeunload = function() {
        if (typeof AppLogger !== 'undefined') {
            AppLogger.info("LogoEditor", "Tablet-Fenster wird geschlossen");
        }
        window.isEditorPoppedOut = false;
        window.popoutEditorWindow = null;
        popoutEditorWindow = null;
        if (window.hadSettingsOpen) {
            const sm = document.getElementById("settingsModal");
            if (sm) sm.classList.remove("hidden");
            window.hadSettingsOpen = false;
        }
    };

    // Tablettfenster Skalierung / Resize Listener
    popoutEditorWindow.addEventListener("resize", () => {
        updateLogoTransform();
        renderMainCanvas();
        updateCursor();
    });

    // Umgebung & Event-Verbindungen für das Tablettfenster schalten
    bridgePopoutEnvironment(popoutEditorWindow);

    // Resizer, Drag-and-Drop und Modals im Popout-Dokument initialisieren
    if (typeof window.initSidebarResizers === "function") window.initSidebarResizers(popoutEditorWindow.document);
    if (typeof window.initPanelResizers === "function") window.initPanelResizers(popoutEditorWindow.document);
    if (typeof window.initPanelDragAndDrop === "function") window.initPanelDragAndDrop(popoutEditorWindow.document);
    if (typeof window.initDraggableModal === "function") window.initDraggableModal(popoutEditorWindow.document);
    if (typeof window.syncCursorToPopout === "function") window.syncCursorToPopout(popoutEditorWindow);

    // Farbrad für das separate Fenster aktivieren, Modus synchronisieren und rendern
    bindColorWheelEvents(popoutEditorWindow.document, popoutEditorWindow);
    updateColorWheelModeButtonUI();
    setTimeout(drawCSPColorWheel, 60);

    // Unteransicht / Referenz-Viewer für das separate Fenster aktivieren
    if (typeof window.syncReferenceViewerWithPopout === "function") {
        window.syncReferenceViewerWithPopout(popoutEditorWindow);
    }

    // Fenster-Manager & Paletten für das separate Fenster aktivieren
    if (typeof window.syncWindowManagerWithPopout === "function") {
        window.syncWindowManagerWithPopout(popoutEditorWindow);
    }

    if (typeof window.restoreLayout === "function") {
        window.restoreLayout(popoutEditorWindow.document);
    }

    setupPopoutCanvasAndLayers(initialImg);

    [80, 200].forEach(delay => {
        setTimeout(() => {
            if (!popoutEditorWindow || popoutEditorWindow.closed) return;
            try {
                updateLogoTransform();
                renderMainCanvas();
                drawCSPColorWheel();
                if (typeof window.updateNavigatorUI === "function") window.updateNavigatorUI();
            } catch (e) {}
        }, delay);
    });
};

function setupPopoutCanvasAndLayers(initialImg, targetDoc = null) {
    const pDoc = targetDoc || (popoutEditorWindow && !popoutEditorWindow.closed ? popoutEditorWindow.document : null);
    if (!pDoc) return;

    const transWrapper = pDoc.getElementById("logoTransformWrapper");
    if (transWrapper) {
        transWrapper.style.width = baseWidth + "px";
        transWrapper.style.height = baseHeight + "px";
    }

    const canvasW = pDoc.getElementById("canvasW");
    const canvasH = pDoc.getElementById("canvasH");
    if (canvasW) canvasW.value = baseWidth;
    if (canvasH) canvasH.value = baseHeight;

    const lassoCanv = pDoc.getElementById("lassoCanvas");
    if (lassoCanv) {
        lassoCanv.width = baseWidth;
        lassoCanv.height = baseHeight;
    }

    const lLayersContainer = pDoc.getElementById("layersContainer");
    if (lLayersContainer) {
        lLayersContainer.innerHTML = "";
        const mainLogoCanvas = pDoc.createElement("canvas");
        mainLogoCanvas.id = "mainLogoCanvas";
        mainLogoCanvas.width = baseWidth;
        mainLogoCanvas.height = baseHeight;
        mainLogoCanvas.style.position = "absolute";
        mainLogoCanvas.style.top = "0";
        mainLogoCanvas.style.left = "0";
        mainLogoCanvas.style.pointerEvents = "none";
        lLayersContainer.appendChild(mainLogoCanvas);
    }

    if (initialImg) {
        addNewLayer(initialImg, "Hintergrund");
    } else if (layers.length === 0) {
        addNewLayer(null, "Hintergrund");
    }
    if (layers.length > 0 && !activeLayerId) {
        setActiveLayer(layers[0].id);
    }

    updateCropBoxUI();
    updateLogoTransform();

    window.setLogoTool("move");

    if (typeof window.filterLogoGraphics === "function") {
        window.filterLogoGraphics();
    }

    setTimeout(() => {
        updateLogoTransform();
        renderMainCanvas();
        renderLayersUI();
        drawCSPColorWheel();
        if (typeof window.restoreLayout === 'function') window.restoreLayout(pDoc);
        if (typeof window.renderReferenceCanvas === 'function') window.renderReferenceCanvas();
        if (typeof window.updateNavigatorUI === 'function') window.updateNavigatorUI();
        if (typeof window.updateHistoryPanelUI === 'function') window.updateHistoryPanelUI();
        if (typeof window.updateWindowMenuCheckmarks === 'function') window.updateWindowMenuCheckmarks();
    }, 50);
}

window.dockEditorBack = function() {
    window.closeLogoEditor();
};

function updatePopoutBtnUI() {
    // Docking buttons are permanently disabled; no-op
}

////////////////////////////////////////////////////////////
// STIFTDRUCK / DRUCKEMPFINDLICHKEIT (ZEICHENTABLETT)
////////////////////////////////////////////////////////////
window.isPenPressureActive = true;

window.togglePenPressure = function() {
    window.isPenPressureActive = !window.isPenPressureActive;
    updatePenPressureBtnUI();
};

function updatePenPressureBtnUI() {
    const btn = document.getElementById("penPressureToggleBtn");
    if (!btn) return;
    if (window.isPenPressureActive) {
        btn.title = "Stiftdruck-Dynamik: AN (Drucksensitiv für Zeichentablett)";
        btn.style.borderColor = "var(--accent)";
        btn.style.color = "var(--accent)";
        btn.style.boxShadow = "0 0 8px var(--accent-glow, rgba(29, 185, 84, 0.4))";
    } else {
        btn.title = "Stiftdruck-Dynamik: AUS (Gleichmäßige Pinselbreite)";
        btn.style.borderColor = "rgba(255,255,255,0.2)";
        btn.style.color = "#888";
        btn.style.boxShadow = "none";
    }
}

function saveLogoState(actionLabel) {
    if (!actionLabel) {
        if (typeof activeTool !== "undefined") {
            const toolNames = {
                brush: "Pinselstrich",
                airbrush: "Airbrush",
                eraser: "Radierer",
                fill: "Fläche füllen",
                lasso: "Lasso füllen",
                smudge: "Verwischen",
                raster: "Rasterstift",
                shape: "Form zeichnen",
                text: "Textebene",
                gradient: "Verlauf",
                transform: "Transformation",
                layerMove: "Ebene verschieben"
            };
            actionLabel = toolNames[activeTool] || "Bearbeitung";
        } else {
            actionLabel = "Bearbeitung";
        }
    }

    const state = layers.map(l => ({
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode, x: l.x, y: l.y, scale: l.scale || 1, 
        clippedToBelow: l.clippedToBelow, alphaLocked: l.alphaLocked, data: l.canvas.toDataURL(),
        isTextLayer: l.isTextLayer, textContent: l.textContent, textProps: JSON.parse(JSON.stringify(l.textProps)) // NEU FÜR TEXT
    }));
    state._actionLabel = actionLabel;
    state._timestamp = Date.now();
    historyStack.push(state); 
    if(historyStack.length > 50) historyStack.shift(); 
    redoStack = []; 
    window.historyStack = historyStack;
    window.redoStack = redoStack;
    if (typeof window.updateHistoryPanelUI === "function") window.updateHistoryPanelUI();
}
window.saveLogoState = saveLogoState;

window.undoLogoAction = function() { 
    if (historyStack.length > 1) { 
        redoStack.push(historyStack.pop()); 
        restoreLogoState(historyStack[historyStack.length - 1]); 
        window.historyStack = historyStack;
        window.redoStack = redoStack;
        if (typeof window.updateHistoryPanelUI === "function") window.updateHistoryPanelUI();
    }
};

window.redoLogoAction = function() { 
    if (redoStack.length > 0) { 
        const nextState = redoStack.pop(); 
        historyStack.push(nextState); 
        restoreLogoState(nextState); 
        window.historyStack = historyStack;
        window.redoStack = redoStack;
        if (typeof window.updateHistoryPanelUI === "function") window.updateHistoryPanelUI();
    }
};

function restoreLogoState(state) {
    const currentProps = {};
    layers.forEach(l => { currentProps[l.id] = { visible: l.visible, opacity: l.opacity, blendMode: l.blendMode, name: l.name, clippedToBelow: l.clippedToBelow, alphaLocked: l.alphaLocked, scale: l.scale }; });

    let loadedImages = 0;
    const newLayers = [];
    
    state.forEach(layerData => {
        const props = currentProps[layerData.id] || layerData; 
        const canvas = document.createElement("canvas"); 
        canvas.id = layerData.id; canvas.width = baseWidth; canvas.height = baseHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        
        const img = new Image();
        img.onload = () => {
            ctx.clearRect(0, 0, baseWidth, baseHeight); ctx.drawImage(img, 0, 0); loadedImages++;
            
            if(loadedImages === state.length) {
                // Stabile DOM-Referenz: Wir tauschen den Canvas nicht aus, sondern zeichnen ihn nur neu!
                let mainLogoCanvas = document.getElementById("mainLogoCanvas");
                if (!mainLogoCanvas) {
                    layersContainer.innerHTML = "";
                    mainLogoCanvas = document.createElement("canvas");
                    mainLogoCanvas.id = "mainLogoCanvas";
                    mainLogoCanvas.width = baseWidth; mainLogoCanvas.height = baseHeight;
                    mainLogoCanvas.style.position = "absolute"; mainLogoCanvas.style.top = "0"; mainLogoCanvas.style.left = "0"; mainLogoCanvas.style.pointerEvents = "none";
                    layersContainer.appendChild(mainLogoCanvas);
                } else if (mainLogoCanvas.width !== baseWidth || mainLogoCanvas.height !== baseHeight) {
                    mainLogoCanvas.width = baseWidth;
                    mainLogoCanvas.height = baseHeight;
                }
                
                layers = newLayers;
                window.layers = layers;
                renderLayersUI();
                if(layers.length > 0 && !layers.find(l => l.id === activeLayerId)) setActiveLayer(layers[0].id);
                renderMainCanvas();
                if (typeof window.updateNavigatorUI === "function") window.updateNavigatorUI();
            }
        };
        img.src = layerData.data;
        
        newLayers.push({ 
            id: layerData.id, name: props.name, canvas: canvas, ctx: ctx, 
            visible: props.visible, opacity: props.opacity, blendMode: props.blendMode, 
            clippedToBelow: props.clippedToBelow, alphaLocked: props.alphaLocked, x: layerData.x, y: layerData.y, scale: layerData.scale || 1,
            isTextLayer: layerData.isTextLayer, textContent: layerData.textContent, textProps: layerData.textProps
        });
    });
}
window.restoreLogoState = restoreLogoState;

// Hilfsfunktion, um eine Ebene im Canvas-Kontext zu zeichnen (global wiederverwendbar)
function drawLayerToCtx(ctx, l, ox = 0, oy = 0) {
    ctx.save();
    ctx.globalAlpha = l.opacity !== undefined ? l.opacity : 1;

    let filterParts = [];
    if (l.brightness !== undefined && l.brightness !== 1) filterParts.push(`brightness(${l.brightness})`);
    if (l.contrast !== undefined && l.contrast !== 1) filterParts.push(`contrast(${l.contrast})`);
    if (l.saturation !== undefined && l.saturation !== 1) filterParts.push(`saturate(${l.saturation})`);
    if (l.blur !== undefined && l.blur !== 0) filterParts.push(`blur(${l.blur}px)`);
    
    if (filterParts.length > 0) {
        ctx.filter = filterParts.join(" ");
    } else {
        ctx.filter = "none";
    }

    const dw = l.canvas.width * (l.scale || 1);
    const dh = l.canvas.height * (l.scale || 1);

    const cx = (l.x - ox) + dw / 2;
    const cy = (l.y - oy) + dh / 2;
    ctx.translate(cx, cy);

    if (l.rotate) {
        ctx.rotate(l.rotate);
    }
    if (l.skewX || l.skewY) {
        ctx.transform(1, Math.tan(l.skewY || 0), Math.tan(l.skewX || 0), 1, 0, 0);
    }
    if (l.flipH || l.flipV) {
        ctx.scale(l.flipH ? -1 : 1, l.flipV ? -1 : 1);
    }
    
    ctx.drawImage(l.canvas, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
}

window.saveLogoEditor = function(overwrite = false) {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = cropBox.w; 
    exportCanvas.height = cropBox.h; 
    const eCtx = exportCanvas.getContext("2d");

    const reversedLayers = [...layers].reverse();

    // Gruppiere Ebenen für echte Schnittmasken (Photoshop-Stil)
    let groups = [];
    let currentGroup = null;

    reversedLayers.forEach((layer) => {
        if (!layer.visible) return;

        if (layer.clippedToBelow && currentGroup) {
            currentGroup.clipped.push(layer);
        } else {
            currentGroup = {
                base: layer,
                clipped: []
            };
            groups.push(currentGroup);
        }
    });

    groups.forEach(group => {
        const baseLayer = group.base;

        if (group.clipped.length === 0) {
            eCtx.save();
            eCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
            drawLayerToCtx(eCtx, baseLayer, cropBox.x, cropBox.y);
            eCtx.restore();
        } else {
            // Wir haben eine Schnittmaskengruppe im Export!
            // Erstelle temporären Offscreen-Canvas mit den Maßen des Crop-Bereichs
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = cropBox.w;
            tempCanvas.height = cropBox.h;
            const tempCtx = tempCanvas.getContext("2d");

            // 1. Basis-Ebene auf den temporären Canvas zeichnen (offset um cropBox)
            drawLayerToCtx(tempCtx, baseLayer, cropBox.x, cropBox.y);

            // 2. Jede darüberliegende Schnittmaske mit source-atop drüberzeichnen (offset um cropBox)
            group.clipped.forEach(clippedLayer => {
                tempCtx.save();
                tempCtx.globalCompositeOperation = "source-atop";
                drawLayerToCtx(tempCtx, clippedLayer, cropBox.x, cropBox.y);
                tempCtx.restore();
            });

            // 3. Den temporären Canvas mit dem BlendMode der Basis-Ebene auf den Export-Canvas zeichnen
            eCtx.save();
            eCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
            eCtx.drawImage(tempCanvas, 0, 0);
            eCtx.restore();
        }
    });

    const base64Data = exportCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    if (!base64Data) {
        if (typeof showEditorToast === "function") showEditorToast("❌ Konnte Grafik nicht exportieren (leere Leinwand).", true);
        return;
    }
    let isInLogoFolder = currentEditingLogo && currentEditingLogo.startsWith(logoFolder);
    let destPath = (overwrite && currentEditingLogo && isInLogoFolder) ? currentEditingLogo : path.join(logoFolder, `logo_${Date.now()}.png`);

    try {
        if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });
        fs.writeFileSync(destPath, base64Data, 'base64');
        currentEditingLogo = destPath;
        window.currentEditingLogo = destPath;
        setActiveLogo(destPath);
        if (typeof showEditorToast === "function") {
            showEditorToast("✅ Grafik gespeichert und als App-Logo aktiviert!");
        }
    } catch (err) {
        if (typeof showEditorToast === "function") {
            showEditorToast("❌ Fehler beim Speichern: " + err.message, true);
        }
    }
};

window.scaleActiveLayer = function(val) {
    const layer = layers.find(l => l.id === activeLayerId);
    if (!layer) return;
    layer.scale = parseFloat(val);
    renderMainCanvas();
};

// ---------------------------------------------------------
// LOGO IMPORTIEREN (Öffnet das Datei-Fenster)
// ---------------------------------------------------------
window.importNewLogo = function() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png, image/jpeg, image/webp, image/svg+xml";

    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        let sourcePath = window.getNativeFilePath(file);
        if (!sourcePath) { try { sourcePath = require('electron').webUtils.getPathForFile(file); } catch(err) {} }

        if (sourcePath) { window.openLogoEditor(sourcePath); } else { alert("Fehler: Konnte den Dateipfad nicht lesen."); }
    };
    input.click();
};

function renderLogosGrid() {
    const grid = document.getElementById("logosGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });
    
    const files = fs.readdirSync(logoFolder).filter(f => f.match(/\.(png|jpg|jpeg|svg|webp)$/i));
    const activeLogo = localStorage.getItem("appCustomLogo") || "";

    const isDefaultActive = !activeLogo || !fs.existsSync(activeLogo);
    const defaultLogoAbsPath = path.join(__dirname, "..", "assets", "logo.png");
    const safeDefaultLogoUrl = pathToFileURL(defaultLogoAbsPath).href;
    
    const defaultCard = document.createElement("div");
    defaultCard.className = "logo-card" + (isDefaultActive ? " active" : "");
    defaultCard.innerHTML = `
        <button class="edit-logo-btn" title="Logo bearbeiten">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        </button>
        <div class="logo-preview-box">
            <img src="${safeDefaultLogoUrl}" style="max-width: 80%; max-height: 80%; object-fit: contain; filter: drop-shadow(0 0 10px rgba(255,255,255,0.2));">
        </div>
        <div class="logo-info">
            <span class="logo-name">Standard Logo</span>
            ${isDefaultActive ? '<span class="logo-badge">Aktiv</span>' : ''}
        </div>
    `;
    
    defaultCard.onclick = () => setActiveLogo("");
    defaultCard.querySelector(".edit-logo-btn").onclick = (e) => { e.stopPropagation(); window.openLogoEditor(defaultLogoAbsPath); };
    grid.appendChild(defaultCard);

    files.forEach(file => {
        const fullPath = path.join(logoFolder, file);
        const isActive = activeLogo === fullPath;
        const safeCustomLogoUrl = pathToFileURL(fullPath).href;
        
        const baseName = file.replace(/\.[^/.]+$/, "");
        const lastUnderscore = baseName.lastIndexOf("_");
        let displayName = "Benutzerdefiniert";
        if (lastUnderscore !== -1) {
            displayName = baseName.substring(0, lastUnderscore).replace(/_/g, " ");
        } else {
            displayName = baseName.replace(/_/g, " ");
        }
        
        const card = document.createElement("div");
        card.className = "logo-card" + (isActive ? " active" : "");
        card.innerHTML = `
            <button class="edit-logo-btn" title="Logo bearbeiten">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="delete-logo-btn" title="Logo löschen">🗑️</button>
            <div class="logo-preview-box">
                <img src="${safeCustomLogoUrl}?t=${Date.now()}" style="max-width: 90%; max-height: 90%; object-fit: contain; filter: drop-shadow(0 0 10px rgba(0,0,0,0.5));">
            </div>
            <div class="logo-info">
                <span class="logo-name" title="${file}">${displayName}</span>
                ${isActive ? '<span class="logo-badge" style="background: var(--accent); color: #000;">Aktiv</span>' : ''}
            </div>
        `;
        
        card.onclick = () => setActiveLogo(fullPath);
        card.querySelector(".edit-logo-btn").onclick = (e) => { e.stopPropagation(); window.openLogoEditor(fullPath); };
        card.querySelector(".delete-logo-btn").onclick = (e) => { e.stopPropagation(); deleteLogo(fullPath); };
        grid.appendChild(card); 
    });

    const addCard = document.createElement("div");
    addCard.className = "logo-card";
    addCard.style.display = "flex";
    addCard.style.flexDirection = "column";
    addCard.style.alignItems = "center";
    addCard.style.justifyContent = "center";
    addCard.style.cursor = "pointer";
    addCard.style.border = "2px dashed rgba(255,255,255,0.2)";
    addCard.style.background = "rgba(0,0,0,0.2)";
    addCard.innerHTML = `<div style="font-size: 40px; color: var(--text-muted); font-weight: 300;">+</div><div style="color: var(--text-muted); font-weight: bold; margin-top: 10px; font-size: 13px;">Logo Erstellen</div>`;
    addCard.onmouseover = () => { addCard.style.borderColor = "var(--accent)"; addCard.style.color = "var(--accent)"; };
    addCard.onmouseout = () => { addCard.style.borderColor = "rgba(255,255,255,0.2)"; addCard.style.color = "var(--text-muted)"; };
    addCard.onclick = () => openLogoCreationOptions();
    grid.appendChild(addCard);
}

function setActiveLogo(customPath) {
    if (!customPath || !fs.existsSync(customPath)) {
        localStorage.removeItem("appCustomLogo");
        const defaultLogoAbsPath = path.join(__dirname, "..", "assets", "logo.png");
        if (actualLogoImg) {
            actualLogoImg.src = pathToFileURL(defaultLogoAbsPath).href;
        }
    } else {
        localStorage.setItem("appCustomLogo", customPath);
        if (actualLogoImg) {
            actualLogoImg.src = `${pathToFileURL(customPath).href}?t=${Date.now()}`;
        }
    }
    renderLogosGrid();
}

function deleteLogo(filePath) {
    try {
        fs.unlinkSync(filePath);
        if (localStorage.getItem("appCustomLogo") === filePath) setActiveLogo(""); 
        else renderLogosGrid();
    } catch(e) { console.error("Fehler beim Löschen des Logos", e); }
}

////////////////////////////////////////////////////////////
// ============================================================================
// DYNAMISCHE APPEARANCE & CUSTOM MEDIA THUMBNAILS ENGINE
// ============================================================================
let mediaCustomThumbnails = {};
try {
    mediaCustomThumbnails = JSON.parse(localStorage.getItem("mediaCustomThumbnails") || "{}");
} catch(e) {}

function applyThumbnailSettings() {
    const format = localStorage.getItem("thumbnailFormat") || "square";
    const plFormat = localStorage.getItem("playlistCoverFormat") || "square";
    const logoFormat = localStorage.getItem("logoFormat") || "square";
    
    const size = localStorage.getItem("thumbnailSize") || "medium";
    const showTitles = localStorage.getItem("showMediaTitles") !== "false";
    const showThumbs = localStorage.getItem("showMediaThumbs") !== "false";
    
    let css = "";
    
    // 1. Media Thumbnails Format
    if (format === "square") {
        css += `
            .mediaCard .mediaThumb, .mediaCard .mediaThumbVideo, .tm-thumb {
                aspect-ratio: 1 / 1 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (format === "rectangle") {
        css += `
            .mediaCard .mediaThumb, .mediaCard .mediaThumbVideo, .tm-thumb {
                aspect-ratio: 16 / 9 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (format === "oval") {
        css += `
            .mediaCard .mediaThumb, .mediaCard .mediaThumbVideo, .tm-thumb {
                aspect-ratio: 4 / 3 !important;
                border-radius: 40px !important;
                object-fit: cover !important;
            }
        `;
    } else if (format === "circle") {
        css += `
            .mediaCard .mediaThumb, .mediaCard .mediaThumbVideo, .tm-thumb {
                aspect-ratio: 1 / 1 !important;
                border-radius: 50% !important;
                object-fit: cover !important;
            }
        `;
    }
    
    // 2. Playlist Cover Format
    if (plFormat === "square") {
        css += `
            .playlist-thumb, .playlistCoverPreview, .playlistCard .aspect-square, .pm-thumb {
                aspect-ratio: 1 / 1 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (plFormat === "rectangle") {
        css += `
            .playlist-thumb, .playlistCoverPreview, .playlistCard .aspect-square, .pm-thumb {
                aspect-ratio: 16 / 9 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (plFormat === "oval") {
        css += `
            .playlist-thumb, .playlistCoverPreview, .playlistCard .aspect-square, .pm-thumb {
                aspect-ratio: 4 / 3 !important;
                border-radius: 40px !important;
                object-fit: cover !important;
            }
        `;
    } else if (plFormat === "circle") {
        css += `
            .playlist-thumb, .playlistCoverPreview, .playlistCard .aspect-square, .pm-thumb {
                aspect-ratio: 1 / 1 !important;
                border-radius: 50% !important;
                object-fit: cover !important;
            }
        `;
    }
    
    // 3. App Logo Format
    if (logoFormat === "square") {
        css += `
            .logoBox img, .logo-preview-box img {
                aspect-ratio: 1 / 1 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (logoFormat === "rectangle") {
        css += `
            .logoBox img, .logo-preview-box img {
                aspect-ratio: 16 / 9 !important;
                border-radius: 8px !important;
                object-fit: cover !important;
            }
        `;
    } else if (logoFormat === "oval") {
        css += `
            .logoBox img, .logo-preview-box img {
                aspect-ratio: 4 / 3 !important;
                border-radius: 20px !important;
                object-fit: cover !important;
            }
        `;
    } else if (logoFormat === "circle") {
        css += `
            .logoBox img, .logo-preview-box img {
                aspect-ratio: 1 / 1 !important;
                border-radius: 50% !important;
                object-fit: cover !important;
            }
        `;
    }
    
    // 4. Grid Size Scale
    let colWidth = "220px";
    if (size === "compact") colWidth = "150px";
    else if (size === "large") colWidth = "300px";
    
    css += `
        .videoGrid, #playlistsGrid, #musicGrid, #videoList, #historyGrid, .likedGrid, #playlistDetailGrid {
            grid-template-columns: repeat(auto-fill, minmax(${colWidth}, 1fr)) !important;
        }
    `;
    
    // 5. Show/Hide Titles (ONLY for video files/cards as requested: .mediaCard.video)
    if (!showTitles) {
        css += `
            .mediaCard.video .mediaTitle {
                display: none !important;
            }
            .mediaCard.video {
                padding-bottom: 12px !important;
            }
        `;
    }
    
    // 6. Show/Hide Thumbnails
    if (!showThumbs) {
        css += `
            .mediaCard .mediaThumb, .mediaCard .mediaThumbVideo, .playlistCoverPreview, .playlistCard .aspect-square, .tm-thumb {
                display: none !important;
            }
            .mediaCard {
                min-height: unset !important;
            }
        `;
    }
    
    let styleTag = document.getElementById("dynamic-thumbnail-settings");
    if (!styleTag) {
        styleTag = document.createElement("style");
        styleTag.id = "dynamic-thumbnail-settings";
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = css;
}

function initThumbnailSettingsUI() {
    const format = localStorage.getItem("thumbnailFormat") || "square";
    const plFormat = localStorage.getItem("playlistCoverFormat") || "square";
    const logoFormat = localStorage.getItem("logoFormat") || "square";
    
    const size = localStorage.getItem("thumbnailSize") || "medium";
    const showTitles = localStorage.getItem("showMediaTitles") !== "false";
    const showThumbs = localStorage.getItem("showMediaThumbs") !== "false";
    
    // 1. Media Thumbnails Format
    ["square", "rectangle", "oval", "circle"].forEach(f => {
        const btn = document.getElementById(`btnThumbFormat-${f}`);
        if (btn) btn.classList.toggle("active", f === format);
    });
    
    // 2. Playlist Covers Format
    ["square", "rectangle", "oval", "circle"].forEach(f => {
        const btn = document.getElementById(`btnPlaylistFormat-${f}`);
        if (btn) btn.classList.toggle("active", f === plFormat);
    });
    
    // 3. App Logos Format
    ["square", "rectangle", "oval", "circle"].forEach(f => {
        const btn = document.getElementById(`btnLogoFormat-${f}`);
        if (btn) btn.classList.toggle("active", f === logoFormat);
    });
    
    // Size & Switches
    ["compact", "medium", "large"].forEach(s => {
        const btn = document.getElementById(`btnThumbSize-${s}`);
        if (btn) btn.classList.toggle("active", s === size);
    });
    
    const chkTitles = document.getElementById("chkShowMediaTitles");
    if (chkTitles) chkTitles.checked = showTitles;
    
    const chkThumbs = document.getElementById("chkShowMediaThumbs");
    if (chkThumbs) chkThumbs.checked = showThumbs;
}

window.changeThumbnailFormat = function(format) {
    localStorage.setItem("thumbnailFormat", format);
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

window.changePlaylistFormat = function(format) {
    localStorage.setItem("playlistCoverFormat", format);
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

window.changeLogoFormat = function(format) {
    localStorage.setItem("logoFormat", format);
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

window.changeThumbnailSize = function(size) {
    localStorage.setItem("thumbnailSize", size);
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

window.toggleMediaTitles = function(checked) {
    localStorage.setItem("showMediaTitles", checked ? "true" : "false");
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

window.toggleMediaThumbs = function(checked) {
    localStorage.setItem("showMediaThumbs", checked ? "true" : "false");
    applyThumbnailSettings();
    initThumbnailSettingsUI();
};

// ============================================================
// PERMANENT THUMBNAIL CACHE & PRELOADER ENGINE
// ============================================================
const thumbsDir = path.join(mediaBase, "covers", "thumbs");
if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

let _thumbCacheSet = null;
function getThumbCacheSet() {
    if (!_thumbCacheSet) {
        _thumbCacheSet = new Set();
        try {
            if (fs.existsSync(thumbsDir)) {
                fs.readdirSync(thumbsDir).forEach(f => {
                    if (f.endsWith(".jpg")) _thumbCacheSet.add(f.toLowerCase());
                });
            }
        } catch (e) {}
    }
    return _thumbCacheSet;
}

const ThumbnailPreloader = {
    getThumbKey(filePath) {
        if (!filePath) return "unknown";
        return crypto.createHash("md5").update(filePath.toLowerCase()).digest("hex");
    },
    getThumbPath(filePath) {
        if (!filePath) return null;
        return path.join(thumbsDir, `${this.getThumbKey(filePath)}.jpg`);
    },
    hasThumb(filePath) {
        if (!filePath) return false;
        const key = `${this.getThumbKey(filePath)}.jpg`.toLowerCase();
        const set = getThumbCacheSet();
        if (set.has(key)) return true;
        const tp = this.getThumbPath(filePath);
        const exists = tp && fs.existsSync(tp);
        if (exists) set.add(key);
        return exists;
    },
    extractVideoThumbnail(videoPath, thumbPath) {
        return new Promise((resolve) => {
            const activeFfmpeg = resolveFfmpegExecutable();
            if (!fs.existsSync(activeFfmpeg)) {
                if (typeof AppLogger !== 'undefined') AppLogger.warn("Preloader", `ffmpeg nicht gefunden unter: ${activeFfmpeg}`);
                return resolve(false);
            }
            const args = [
                "-ss", "00:00:02",
                "-i", videoPath,
                "-vf", "scale=480:-1",
                "-vframes", "1",
                "-q:v", "3",
                thumbPath,
                "-y"
            ];
            const proc = spawn(activeFfmpeg, args);
            proc.on("close", (code) => {
                if (code === 0 && fs.existsSync(thumbPath)) {
                    getThumbCacheSet().add(path.basename(thumbPath).toLowerCase());
                    resolve(true);
                } else {
                    const fallbackArgs = [
                        "-ss", "00:00:00.5",
                        "-i", videoPath,
                        "-vf", "scale=480:-1",
                        "-vframes", "1",
                        "-q:v", "3",
                        thumbPath,
                        "-y"
                    ];
                    const fbProc = spawn(activeFfmpeg, fallbackArgs);
                    fbProc.on("close", (fbCode) => {
                        const ok = fbCode === 0 && fs.existsSync(thumbPath);
                        if (ok) getThumbCacheSet().add(path.basename(thumbPath).toLowerCase());
                        resolve(ok);
                    });
                    fbProc.on("error", () => resolve(false));
                }
            });
            proc.on("error", (err) => {
                if (typeof AppLogger !== 'undefined') AppLogger.error("Preloader", `ffmpeg Spawn-Fehler für ${videoPath}: ${err.message}`);
                resolve(false);
            });
        });
    },
    async extractAudioCover(audioPath, thumbPath) {
        try {
            const metadata = await mm.parseFile(audioPath);
            if (metadata.common && metadata.common.picture && metadata.common.picture.length > 0) {
                const pic = metadata.common.picture[0];
                fs.writeFileSync(thumbPath, pic.data);
                getThumbCacheSet().add(path.basename(thumbPath).toLowerCase());
                return true;
            }
        } catch (e) {
            // No embedded cover
        }
        return false;
    },
    async preloadAllThumbnailsPermanently() {
        if (ThumbnailPreloader.isRunning) {
            ThumbnailPreloader._pendingRescan = true;
            return;
        }
        if (typeof AppLogger !== 'undefined') AppLogger.info("Preloader", "Starte permanenten Thumbnail-Preload für Mediathek & verknüpfte Ordner...");
        
        const videoExts = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts'];
        const audioExts = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', '.wma', '.dts', '.dtshd', '.ac3', '.eac3'];
        const tasksMap = new Map();

        // 1. Dateien aus aktuellem State
        if (Array.isArray(videoListData)) {
            videoListData.forEach(p => { if (fs.existsSync(p)) tasksMap.set(p, 'video'); });
        }
        if (Array.isArray(musicList)) {
            musicList.forEach(p => { if (fs.existsSync(p)) tasksMap.set(p, 'audio'); });
        }

        // 2. Lokale Mediathek-Ordner scannen
        if (fs.existsSync(videoFolder)) {
            try {
                const vFiles = fs.readdirSync(videoFolder);
                for (const file of vFiles) {
                    const full = path.join(videoFolder, file);
                    const ext = path.extname(file).toLowerCase();
                    if (videoExts.includes(ext) && fs.existsSync(full)) {
                        tasksMap.set(full, 'video');
                    }
                }
            } catch (e) {}
        }

        if (fs.existsSync(musicFolder)) {
            try {
                const mFiles = fs.readdirSync(musicFolder);
                for (const file of mFiles) {
                    const full = path.join(musicFolder, file);
                    const ext = path.extname(file).toLowerCase();
                    if (audioExts.includes(ext) && fs.existsSync(full)) {
                        tasksMap.set(full, 'audio');
                    }
                }
            } catch (e) {}
        }

        // 3. ALLE verknüpften Ordner (libraryFolders) rekursiv / strukturiert scannen!
        try {
            const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
            libraryFolders.forEach(folder => {
                if (fs.existsSync(folder)) {
                    try {
                        const fEntries = fs.readdirSync(folder);
                        for (const file of fEntries) {
                            const full = path.join(folder, file);
                            try {
                                const stat = fs.statSync(full);
                                if (stat.isFile()) {
                                    const ext = path.extname(file).toLowerCase();
                                    if (videoExts.includes(ext)) tasksMap.set(full, 'video');
                                    else if (audioExts.includes(ext)) tasksMap.set(full, 'audio');
                                }
                            } catch(err) {}
                        }
                    } catch(e) {}
                }
            });
        } catch(e) {}

        // 4. Einzeln verknüpfte Dateien (libraryFiles) scannen!
        try {
            const libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
            libraryFiles.forEach(file => {
                if (fs.existsSync(file)) {
                    const ext = path.extname(file).toLowerCase();
                    if (videoExts.includes(ext)) tasksMap.set(file, 'video');
                    else if (audioExts.includes(ext)) tasksMap.set(file, 'audio');
                }
            });
        } catch(e) {}

        const allTasks = [];
        tasksMap.forEach((type, p) => allTasks.push({ path: p, type }));

        // Blitzschneller O(1) Memory-Cache-Check für fehlende Thumbnails
        const missing = allTasks.filter(t => !this.hasThumb(t.path));
        if (typeof AppLogger !== 'undefined') {
            AppLogger.info("Preloader", `Medien insgesamt: ${allTasks.length}, bereits im Cache: ${allTasks.length - missing.length}, noch zu generieren: ${missing.length}`);
        }

        if (missing.length === 0) {
            if (typeof AppLogger !== 'undefined') AppLogger.info("Preloader", "Alle Medien befinden sich bereits vollständig im permanenten Cache.");
            return;
        }

        let completed = 0;
        const total = missing.length;
        ThumbnailPreloader.isRunning = true;
        ThumbnailPreloader.completed = completed;
        ThumbnailPreloader.total = total;
        if (typeof window.BgTaskManager !== 'undefined') window.BgTaskManager.update();

        const updateProgress = () => {
            ThumbnailPreloader.completed = completed;
            if (typeof window.BgTaskManager !== 'undefined') window.BgTaskManager.update();
        };
        updateProgress();

        // Concurrency 2: CPU/RAM-schonend im Hintergrund
        const concurrency = 2;
        let index = 0;

        const worker = async () => {
            while (index < missing.length) {
                const currentTask = missing[index++];
                const targetThumb = this.getThumbPath(currentTask.path);
                try {
                    let success = false;
                    if (currentTask.type === 'video') {
                        success = await this.extractVideoThumbnail(currentTask.path, targetThumb);
                    } else if (currentTask.type === 'audio') {
                        success = await this.extractAudioCover(currentTask.path, targetThumb);
                    }
                    if (success && fs.existsSync(targetThumb)) {
                        // Live-Update von im UI bereits gerenderten Karten (inkl. sofortigem Austausch im Videos-Tab)
                        const safeThumbUrl = `${pathToFileURL(targetThumb).href}?t=${Date.now()}`;
                        const normTaskPath = currentTask.path.replace(/\//g, "\\").toLowerCase();
                        document.querySelectorAll(`.mediaCard[data-file-path]`).forEach(card => {
                            const normCardPath = (card.dataset.filePath || "").replace(/\//g, "\\").toLowerCase();
                            if (normCardPath === normTaskPath) {
                                if (currentTask.type === 'video') {
                                    const oldThumb = card.querySelector(".mediaThumb, .mediaThumbVideo, .videoPlaceholderThumb");
                                    if (oldThumb) {
                                        const newImg = document.createElement("img");
                                        newImg.className = "mediaThumb staticThumb";
                                        newImg.style.cssText = "width: 100%; height: 100%; object-fit: cover; border-radius: 8px; margin-bottom: 10px; aspect-ratio: 16 / 9;";
                                        newImg.loading = "lazy";
                                        newImg.src = safeThumbUrl;
                                        oldThumb.replaceWith(newImg);
                                        setupMediaThumbListeners(card, toMediaKey(currentTask.path), currentTask.type);
                                    }
                                } else {
                                    const thumbBox = card.querySelector(".musicCardThumb");
                                    if (thumbBox) {
                                        thumbBox.className = "musicCardThumb";
                                        thumbBox.innerHTML = `<img class="mediaThumb staticThumb musicThumbImg" src="${safeThumbUrl}" loading="lazy">`;
                                    }
                                }
                            }
                        });
                    }
                } catch (err) {
                    if (typeof AppLogger !== 'undefined') AppLogger.error("Preloader", `Fehler für ${currentTask.path}: ${err.message}`);
                }
                completed++;
                updateProgress();
            }
        };

        const workers = [];
        for (let i = 0; i < concurrency; i++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        ThumbnailPreloader.isRunning = false;
        if (typeof window.BgTaskManager !== 'undefined') window.BgTaskManager.update();

        if (typeof AppLogger !== 'undefined') AppLogger.info("Preloader", `Preload fertig: ${completed} neue Thumbnails dauerhaft im Cache gesichert.`);

        if (ThumbnailPreloader._pendingRescan) {
            ThumbnailPreloader._pendingRescan = false;
            setTimeout(() => ThumbnailPreloader.preloadAllThumbnailsPermanently().catch(() => {}), 50);
        }
    }
};

window.ThumbnailPreloader = ThumbnailPreloader;

// --- CUSTOM & PERMANENT MEDIA THUMBNAIL HELPERS ---
function getMediaThumbHtml(key, type) {
    const customPath = mediaCustomThumbnails[key];
    if (customPath && fs.existsSync(customPath)) {
        const safeUrl = pathToFileURL(customPath).href;
        if (type === 'music') {
            return `<div class="musicCardThumb"><img class="mediaThumb staticThumb musicThumbImg" src="${safeUrl}?t=${Date.now()}" onerror="this.onerror=null;this.parentElement.className='musicCardThumb musicNoteFallbackBox';this.parentElement.innerHTML='<span class=\\'musicNoteFallback\\'>🎵</span>';"></div>`;
        }
        return `<img class="mediaThumb" style="object-fit: cover;" src="${safeUrl}?t=${Date.now()}">`;
    }

    const mediaPath = fromMediaKey(key);
    const cachedThumb = ThumbnailPreloader.getThumbPath(mediaPath);
    if (cachedThumb && fs.existsSync(cachedThumb)) {
        const safeUrl = pathToFileURL(cachedThumb).href;
        if (type === 'music') {
            return `<div class="musicCardThumb"><img class="mediaThumb staticThumb musicThumbImg" src="${safeUrl}" loading="lazy" onerror="this.onerror=null;this.parentElement.className='musicCardThumb musicNoteFallbackBox';this.parentElement.innerHTML='<span class=\\'musicNoteFallback\\'>🎵</span>';"></div>`;
        }
        return `<img class="mediaThumb staticThumb" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; margin-bottom: 10px; aspect-ratio: 16 / 9;" src="${safeUrl}" loading="lazy">`;
    }
    
    if (type === 'video') {
        return `<div class="mediaThumb videoPlaceholderThumb" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 38px; background: rgba(0,0,0,0.3); border-radius: 8px; margin-bottom: 10px; aspect-ratio: 16 / 9; cursor: pointer;">🎬</div>`;
    } else {
        return `<div class="musicCardThumb musicNoteFallbackBox"><span class="musicNoteFallback">🎵</span></div>`;
    }
}

function setupMediaThumbListeners(card, key, type) {
    const customPath = mediaCustomThumbnails[key];
    if (customPath && fs.existsSync(customPath)) return;
    
    const mediaPath = fromMediaKey(key);

    if (type === 'video') {
        if (/\.(mkv|ts|m2ts|avi|flv|wmv)$/i.test(mediaPath)) return;
        // Hover-Video-Vorschau bei Bedarf dynamisch erzeugen (kein RAM-Overhead beim Scrollen!)
        let hoverTimeout = null;
        let previewVideo = null;
        const targetContainer = card.querySelector(".staticThumb, .videoPlaceholderThumb") || card;

        card.addEventListener("mouseenter", () => {
            hoverTimeout = setTimeout(() => {
                if (!card.querySelector(".hoverPreviewVideo")) {
                    previewVideo = document.createElement("video");
                    previewVideo.className = "hoverPreviewVideo";
                    try {
                        previewVideo.src = pathToFileURL(mediaPath).href;
                    } catch(e) {
                        previewVideo.src = mediaPath;
                    }
                    previewVideo.muted = true;
                    previewVideo.style.cssText = "width: 100%; height: 100%; object-fit: cover; border-radius: 8px; position: absolute; top: 0; left: 0; aspect-ratio: 16 / 9; z-index: 2; pointer-events: none;";
                    previewVideo.addEventListener("loadedmetadata", () => {
                        previewVideo.currentTime = previewVideo.duration * 0.15;
                        previewVideo.play().catch(() => {});
                    });
                    const imgContainer = targetContainer.parentElement || card;
                    if (imgContainer.style.position !== "relative" && imgContainer.style.position !== "absolute") {
                        imgContainer.style.position = "relative";
                    }
                    imgContainer.appendChild(previewVideo);
                }
            }, 200);
        });

        card.addEventListener("mouseleave", () => {
            if (hoverTimeout) clearTimeout(hoverTimeout);
            const vid = card.querySelector(".hoverPreviewVideo");
            if (vid) {
                try { vid.pause(); } catch(e) {}
                vid.remove();
            }
        });
    }
}

// --- TAGS DETAILS PANEL THUMBNAIL TRIGGERS ---
function renderTmCustomThumbnailPanel() {
    const section = document.getElementById("tmThumbnailSection");
    const previewContainer = document.getElementById("tmThumbPreviewContainer");
    const removeBtn = document.getElementById("btnRemoveCustomThumb");
    
    if (!section || !previewContainer || !activeTmSelection) return;
    
    section.style.display = "block";
    previewContainer.innerHTML = "";
    
    const key = activeTmSelection.key;
    const customPath = mediaCustomThumbnails[key];
    
    if (customPath && fs.existsSync(customPath)) {
        const safeUrl = pathToFileURL(customPath).href;
        previewContainer.innerHTML = `<img src="${safeUrl}?t=${Date.now()}" style="width: 100%; height: 100%; object-fit: cover;">`;
        if (removeBtn) removeBtn.style.display = "block";
    } else {
        const filePath = fromMediaKey(key);
        const cachedThumb = (typeof ThumbnailPreloader !== "undefined" && typeof ThumbnailPreloader.getThumbPath === "function")
            ? ThumbnailPreloader.getThumbPath(filePath)
            : null;
        if (cachedThumb && fs.existsSync(cachedThumb)) {
            const safeUrl = pathToFileURL(cachedThumb).href;
            previewContainer.innerHTML = `<img src="${safeUrl}" style="width: 100%; height: 100%; object-fit: cover;">`;
        } else if (activeTmSelection.type === 'video') {
            previewContainer.innerHTML = `<video muted preload="metadata" src="${filePath}" style="width: 100%; height: 100%; object-fit: cover;"></video>`;
            const v = previewContainer.querySelector("video");
            v.addEventListener('loadedmetadata', () => { v.currentTime = v.duration * 0.15; });
            v.addEventListener('seeked', () => { v.pause(); });
        } else {
            previewContainer.innerHTML = `<div style="font-size: 40px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: rgba(0,0,0,0.2);">🎵</div>`;
        }
        if (removeBtn) removeBtn.style.display = "none";
    }
}

window.selectCustomThumbFromFile = function() {
    if (!activeTmSelection) return;
    
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png, image/jpeg, image/webp";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        let sourcePath = window.getNativeFilePath(file);
        if (!sourcePath) {
            try { sourcePath = require('electron').webUtils.getPathForFile(file); } catch(err) {}
        }
        
        if (sourcePath) {
            saveCustomThumb(sourcePath);
        } else {
            alert("Fehler beim Lesen des Dateipfades.");
        }
    };
    input.click();
};

function saveCustomThumb(imagePath) {
    if (!activeTmSelection) return;
    
    const key = activeTmSelection.key;
    const coversFolder = path.join(mediaBase, "covers");
    if (!fs.existsSync(coversFolder)) fs.mkdirSync(coversFolder, { recursive: true });
    
    const ext = path.extname(imagePath) || ".png";
    const destName = `thumb_${Date.now()}${ext}`;
    const destPath = path.join(coversFolder, destName);
    
    try {
        fs.copyFileSync(imagePath, destPath);
        
        const prev = mediaCustomThumbnails[key];
        if (prev && fs.existsSync(prev)) {
            try { fs.unlinkSync(prev); } catch(e) {}
        }
        
        mediaCustomThumbnails[key] = destPath;
        localStorage.setItem("mediaCustomThumbnails", JSON.stringify(mediaCustomThumbnails));
        
        renderTmCustomThumbnailPanel();
        
        loadMusic();
        loadVideos();
        renderHistory();
        if (typeof renderPlaylists === "function") renderPlaylists();
        if (typeof loadTM === "function") loadTM(activeTmCategory);
        
        alert("Individuelles Thumbnail erfolgreich gespeichert!");
    } catch(err) {
        alert("Fehler beim Kopieren des Thumbnails: " + err.message);
    }
}

window.openCustomThumbEditor = function() {
    if (!activeTmSelection) return;
    
    editorTargetContext = 'mediaThumb';
    
    const key = activeTmSelection.key;
    const customPath = mediaCustomThumbnails[key];
    
    if (customPath && fs.existsSync(customPath)) {
        window.openLogoEditor(customPath);
    } else {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = 512;
        tempCanvas.height = 512;
        const ctx = tempCanvas.getContext("2d");
        ctx.clearRect(0, 0, 512, 512);
        
        window.openLogoEditor(tempCanvas.toDataURL("image/png"));
    }
};

window.removeCustomThumb = function() {
    if (!activeTmSelection) return;
    
    const key = activeTmSelection.key;
    const customPath = mediaCustomThumbnails[key];
    
    if (customPath && fs.existsSync(customPath)) {
        try { fs.unlinkSync(customPath); } catch(e) {}
    }
    
    delete mediaCustomThumbnails[key];
    localStorage.setItem("mediaCustomThumbnails", JSON.stringify(mediaCustomThumbnails));
    
    renderTmCustomThumbnailPanel();
    
    loadMusic();
    loadVideos();
    renderHistory();
    if (typeof renderPlaylists === "function") renderPlaylists();
    if (typeof loadTM === "function") loadTM(activeTmCategory);
    
    alert("Individuelles Thumbnail entfernt!");
};

// START (BOMBENSICHER)
////////////////////////////////////////////////////////////
console.log("🔍 Font-Check:");
console.log("  fontsFolder:", fontsFolder);
console.log("  Existiert:", fs.existsSync(fontsFolder));

function discoverSystemFolders() {
  const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
  let updated = false;
  
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const sysMusic = path.join(userProfile, "Music");
    const sysVideos = path.join(userProfile, "Videos");
    
    if (fs.existsSync(sysMusic) && !libraryFolders.includes(sysMusic)) {
      libraryFolders.push(sysMusic);
      updated = true;
    }
    if (fs.existsSync(sysVideos) && !libraryFolders.includes(sysVideos)) {
      libraryFolders.push(sysVideos);
      updated = true;
    }
  }
  
  const drives = ['C', 'D', 'E', 'F', 'G', 'H'];
  drives.forEach(drive => {
    const driveMusic = `${drive}:\\Music`;
    const driveVideos = `${drive}:\\Videos`;
    
    try {
      if (fs.existsSync(driveMusic) && !libraryFolders.includes(driveMusic)) {
        libraryFolders.push(driveMusic);
        updated = true;
      }
      if (fs.existsSync(driveVideos) && !libraryFolders.includes(driveVideos)) {
        libraryFolders.push(driveVideos);
        updated = true;
      }
    } catch(e) {}
  });
  
  if (updated) {
    localStorage.setItem("libraryFolders", JSON.stringify(libraryFolders));
  }
}

// ==========================================
// CUSTOM CONTEXT MENU & FILE OPERATIONS
// ==========================================

function updateMediaReferences(oldPath, newPath) {
  const oldKey = toMediaKey(oldPath);
  const newKey = toMediaKey(newPath);

  // 1. Liked
  let liked = JSON.parse(localStorage.getItem("liked") || "{}");
  if (liked[oldKey] !== undefined) {
    liked[newKey] = liked[oldKey];
    delete liked[oldKey];
    localStorage.setItem("liked", JSON.stringify(liked));
  }

  // 2. Playlists
  let playlists = JSON.parse(localStorage.getItem("playlists") || '{"music": {}, "video": {}}');
  let plUpdated = false;
  ['music', 'video'].forEach(type => {
    if (playlists[type]) {
      for (const plName in playlists[type]) {
        let list = playlists[type][plName];
        if (Array.isArray(list)) {
          const idx = list.indexOf(oldKey);
          if (idx !== -1) {
            list[idx] = newKey;
            plUpdated = true;
          }
        }
      }
    }
  });
  if (plUpdated) {
    localStorage.setItem("playlists", JSON.stringify(playlists));
  }

  // 3. History
  let history = JSON.parse(localStorage.getItem("history") || "[]");
  let histUpdated = false;
  history.forEach(entry => {
    if (entry.path === oldPath || entry.path === oldKey || fromMediaKey(entry.path) === oldPath) {
      entry.path = newKey;
      histUpdated = true;
    }
  });
  if (histUpdated) {
    localStorage.setItem("history", JSON.stringify(history));
  }

  // 4. Tags
  let mediaTags = JSON.parse(localStorage.getItem("mediaTags") || "{}");
  if (mediaTags[oldKey] !== undefined) {
    mediaTags[newKey] = mediaTags[oldKey];
    delete mediaTags[oldKey];
    localStorage.setItem("mediaTags", JSON.stringify(mediaTags));
  }

  // 5. Custom Thumbnails
  let mediaCustomThumbnails = JSON.parse(localStorage.getItem("mediaCustomThumbnails") || "{}");
  if (mediaCustomThumbnails[oldKey] !== undefined) {
    mediaCustomThumbnails[newKey] = mediaCustomThumbnails[oldKey];
    delete mediaCustomThumbnails[oldKey];
    localStorage.setItem("mediaCustomThumbnails", JSON.stringify(mediaCustomThumbnails));
  }

  // 6. Library Files
  let libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
  const libFileIdx = libraryFiles.indexOf(oldPath);
  if (libFileIdx !== -1) {
    libraryFiles[libFileIdx] = newPath;
    localStorage.setItem("libraryFiles", JSON.stringify(libraryFiles));
  }
}

function handleFileCopyMove(oldPath, mediaType, isMove) {
  if (!fs.existsSync(oldPath)) {
    alert("Fehler: Die Quelldatei existiert nicht.");
    return;
  }

  const destFolder = mediaType === 'music' ? musicFolder : videoFolder;
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

  const ext = path.extname(oldPath);
  const baseName = path.basename(oldPath, ext);
  let destPath = path.join(destFolder, path.basename(oldPath));
  
  if (fs.existsSync(destPath)) {
    let count = 1;
    while (fs.existsSync(path.join(destFolder, `${baseName}_${count}${ext}`))) {
      count++;
    }
    destPath = path.join(destFolder, `${baseName}_${count}${ext}`);
  }

  try {
    if (isMove) {
      try {
        fs.renameSync(oldPath, destPath);
      } catch (err) {
        // Fallback for cross-device move
        fs.copyFileSync(oldPath, destPath);
        fs.unlinkSync(oldPath);
      }
      updateMediaReferences(oldPath, destPath);
      alert(`Erfolgreich verschoben nach: ${path.basename(destPath)}`);
    } else {
      fs.copyFileSync(oldPath, destPath);
      alert(`Erfolgreich kopiert nach: ${path.basename(destPath)}`);
    }

    loadMusic();
    loadVideos();
    renderHistory();
    if (typeof renderPlaylists === "function") renderPlaylists();
  } catch (err) {
    alert("Operation fehlgeschlagen: " + err.message);
  }
}

function showFolderContextMenu(e, folderPath, currentType) {
  const menu = document.getElementById("mediaContextMenu");
  if (!menu) return;

  menu.innerHTML = `
    <button class="context-menu-item" id="ctx-folder-music">
      Als Musik-Ordner festlegen
    </button>
    <button class="context-menu-item" id="ctx-folder-video">
      Als Video-Ordner festlegen
    </button>
    <button class="context-menu-item" id="ctx-folder-both">
      Beide Typen anzeigen
    </button>
    <div class="context-menu-divider"></div>
    <button class="context-menu-item" id="ctx-folder-unlink" style="color: #ff4444;">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px; vertical-align: middle; display: inline-block;">
        <path d="M10 8.5H7a4 4 0 0 0-4 4v0a4 4 0 0 0 4 4h3" stroke="currentColor"></path>
        <path d="M14 15.5h3a4 4 0 0 0 4-4v0a4 4 0 0 0-4-4h-3" stroke="currentColor"></path>
        <line x1="10" y1="5" x2="14" y2="19" stroke="#ff4444" stroke-width="2.5"></line>
      </svg>
      Verknüpfung aufheben
    </button>
  `;

  // Highlight active option
  const types = JSON.parse(localStorage.getItem("libraryFolderTypes") || "{}");
  const folderType = types[folderPath] || "both";
  if (folderType === 'music') {
    menu.querySelector("#ctx-folder-music").style.background = "rgba(255,255,255,0.08)";
    menu.querySelector("#ctx-folder-music").style.fontWeight = "bold";
  } else if (folderType === 'video') {
    menu.querySelector("#ctx-folder-video").style.background = "rgba(255,255,255,0.08)";
    menu.querySelector("#ctx-folder-video").style.fontWeight = "bold";
  } else if (folderType === 'both') {
    menu.querySelector("#ctx-folder-both").style.background = "rgba(255,255,255,0.08)";
    menu.querySelector("#ctx-folder-both").style.fontWeight = "bold";
  }

  // Click handlers
  menu.querySelector("#ctx-folder-music").onclick = () => {
    types[folderPath] = 'music';
    localStorage.setItem("libraryFolderTypes", JSON.stringify(types));
    menu.classList.add("hidden");
    loadMusic();
    loadVideos();
  };
  menu.querySelector("#ctx-folder-video").onclick = () => {
    types[folderPath] = 'video';
    localStorage.setItem("libraryFolderTypes", JSON.stringify(types));
    menu.classList.add("hidden");
    loadMusic();
    loadVideos();
  };
  menu.querySelector("#ctx-folder-both").onclick = () => {
    types[folderPath] = 'both';
    localStorage.setItem("libraryFolderTypes", JSON.stringify(types));
    menu.classList.add("hidden");
    loadMusic();
    loadVideos();
  };
  menu.querySelector("#ctx-folder-unlink").onclick = () => {
    let folders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
    folders = folders.filter(f => f !== folderPath);
    localStorage.setItem("libraryFolders", JSON.stringify(folders));
    
    // Also cleanup types map
    delete types[folderPath];
    localStorage.setItem("libraryFolderTypes", JSON.stringify(types));
    
    menu.classList.add("hidden");
    loadMusic();
    loadVideos();
  };

  // Position and show menu
  positionContextMenu(e, menu);
}

function showFileContextMenu(e, filePath, mediaType) {
  const menu = document.getElementById("mediaContextMenu");
  if (!menu) return;

  const isAlreadyInApp = filePath.startsWith(musicFolder) || filePath.startsWith(videoFolder);
  const fileName = path.basename(filePath);
  const liked = typeof isLiked === "function" ? isLiked(filePath) : false;

  menu.innerHTML = `
    <div style="padding: 8px 12px; font-size: 11px; font-weight: bold; color: var(--accent); border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px;">
      ${fileName}
    </div>
    <button class="context-menu-item" id="ctx-play-now" style="display: flex; align-items: center; gap: 8px;">
      <span>▶</span> <span>Jetzt abspielen</span>
    </button>
    <button class="context-menu-item" id="ctx-play-next" style="display: flex; align-items: center; gap: 8px; color: var(--accent);">
      <span>⏭</span> <span>Als Nächstes abspielen</span>
    </button>
    <button class="context-menu-item" id="ctx-add-queue" style="display: flex; align-items: center; gap: 8px;">
      <span>📑</span> <span>An Warteschlange anhängen</span>
    </button>
    <button class="context-menu-item" id="ctx-add-playlist" style="display: flex; align-items: center; gap: 8px;">
      <span>➕</span> <span>In Playlist speichern</span>
    </button>
    <button class="context-menu-item" id="ctx-toggle-like" style="display: flex; align-items: center; gap: 8px;">
      <span>${liked ? "💔" : "❤️"}</span> <span>${liked ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}</span>
    </button>
    <button class="context-menu-item" id="ctx-show-explorer" style="display: flex; align-items: center; gap: 8px;">
      <span>📁</span> <span>Im Explorer anzeigen</span>
    </button>
    ${!isAlreadyInApp ? `
      <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0;"></div>
      <button class="context-menu-item" id="ctx-file-copy">
        In App-Ordner kopieren
      </button>
      <button class="context-menu-item" id="ctx-file-move">
        In App-Ordner verschieben
      </button>
    ` : ''}
  `;

  menu.querySelector("#ctx-play-now").onclick = () => {
    menu.classList.add("hidden");
    const isVid = mediaType === "video" || filePath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
    if (isVid) playVideo(filePath);
    else playMusic(filePath);
  };

  menu.querySelector("#ctx-play-next").onclick = () => {
    menu.classList.add("hidden");
    if (typeof window.playNextInQueue === "function") window.playNextInQueue(filePath);
  };

  menu.querySelector("#ctx-add-queue").onclick = () => {
    menu.classList.add("hidden");
    if (typeof window.addToQueueList === "function") window.addToQueueList(filePath);
  };

  menu.querySelector("#ctx-add-playlist").onclick = () => {
    menu.classList.add("hidden");
    if (typeof openPlaylistModal === "function") openPlaylistModal(filePath);
  };

  menu.querySelector("#ctx-toggle-like").onclick = () => {
    menu.classList.add("hidden");
    if (typeof toggleLike === "function") toggleLike(filePath);
    if (typeof loadMusic === "function" && mediaType === "music") loadMusic();
    if (typeof loadVideos === "function" && mediaType === "video") loadVideos();
  };

  menu.querySelector("#ctx-show-explorer").onclick = () => {
    menu.classList.add("hidden");
    shell.showItemInFolder(filePath);
  };

  if (!isAlreadyInApp) {
    const copyBtn = menu.querySelector("#ctx-file-copy");
    if (copyBtn) {
      copyBtn.onclick = () => {
        menu.classList.add("hidden");
        handleFileCopyMove(filePath, mediaType, false);
      };
    }
    const moveBtn = menu.querySelector("#ctx-file-move");
    if (moveBtn) {
      moveBtn.onclick = () => {
        menu.classList.add("hidden");
        handleFileCopyMove(filePath, mediaType, true);
      };
    }
  }

  // Position and show menu
  positionContextMenu(e, menu);
}

function positionContextMenu(e, menu) {
  menu.classList.remove("hidden");
  
  // Align positions
  const menuWidth = menu.offsetWidth || 200;
  const menuHeight = menu.offsetHeight || 150;
  
  let x = e.clientX;
  let y = e.clientY;
  
  // Boundary check
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 10;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 10;
  }
  
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

// Global Context Menu Triggers
document.addEventListener("contextmenu", (e) => {
  // Hide context menu by default if clicking outside
  const menu = document.getElementById("mediaContextMenu");
  if (menu) menu.classList.add("hidden");

  // Find closest mediaCard
  const card = e.target.closest(".mediaCard");
  if (!card) return;

  // Folder right-click
  if (card.classList.contains("folder-card") && card.dataset.folderPath) {
    e.preventDefault();
    e.stopPropagation();
    showFolderContextMenu(e, card.dataset.folderPath, card.dataset.mediaType);
  }
  // File right-click
  else if (card.dataset.filePath && card.dataset.mediaType) {
    e.preventDefault();
    e.stopPropagation();
    showFileContextMenu(e, card.dataset.filePath, card.dataset.mediaType);
  }
});

document.addEventListener("click", (e) => {
  const menu = document.getElementById("mediaContextMenu");
  if (menu && !menu.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

function initApp() {
    console.log("🚀 App wird jetzt initialisiert...");
    if (typeof AppLogger !== 'undefined') {
        AppLogger.info("Init", "App wird initialisiert");
    }

    initFonts(); 
    initFontTab(); 
    
    discoverSystemFolders();
    loadMusic();
    loadVideos();
    syncKeepOriginalMkvUI();
    processMKVsInBackground(); 
    loadSavedTheme(); 
    initEqualizer();
    initCustomCursorSystem();
    
    const savedLogo = localStorage.getItem("appCustomLogo") || "";
    setActiveLogo(savedLogo);
    
    renderLiked();
    renderHistory();
    renderCustomThemes();
    
    showTab("music");
    updateVideoControls();
    updateLikeButton();
    updateNowPlaying();

    // Custom thumbnail settings & tag preloading
    applyThumbnailSettings();
    initThumbnailSettingsUI();
    if (typeof loadTM === "function") loadTM(activeTmCategory);

    // Permanenter Thumbnail-Preload beim App-Start (erzeugt und cacht alle Thumbnails dauerhaft)
    if (typeof ThumbnailPreloader !== 'undefined') {
        setTimeout(() => {
            ThumbnailPreloader.preloadAllThumbnailsPermanently().catch(err => {
                if (typeof AppLogger !== 'undefined') AppLogger.error("Init", "Preloader-Fehler: " + err.message);
            });
        }, 150);
    }

    // CSP-Style Sidebar-Layout und Drag-and-Drop initialisieren
    if (typeof window.restoreLayout === "function") window.restoreLayout();
    if (typeof window.initPanelDragAndDrop === "function") window.initPanelDragAndDrop();
    if (typeof window.initSidebarResizers === "function") window.initSidebarResizers();
    if (typeof window.initCustomPalettes === "function") window.initCustomPalettes();
    if (typeof window.initPanelResizers === "function") window.initPanelResizers();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}

// Modal Draggable Logic
window.initDraggableModal = function(targetDoc = document) {
    const modal = targetDoc.getElementById('logoAdjustmentsModal');
    const header = targetDoc.getElementById('logoAdjustmentsHeader');
    if (!modal || !header) return;
    if (header._hasDragInit) return;
    header._hasDragInit = true;
    
    let isDraggingModal = false, modalStartX = 0, modalStartY = 0, modalInitialX = 0, modalInitialY = 0;
    const doc = header.ownerDocument || targetDoc || document;
    const win = doc.defaultView || window;
    
    header.addEventListener('mousedown', (e) => {
        isDraggingModal = true;
        modalStartX = e.clientX;
        modalStartY = e.clientY;
        const rect = modal.getBoundingClientRect();
        modalInitialX = rect.left;
        modalInitialY = rect.top;
        modal.style.right = 'auto';
        modal.style.left = modalInitialX + 'px';
        modal.style.top = modalInitialY + 'px';
        e.preventDefault();
    });
    
    const onMouseMove = (e) => {
        if (!isDraggingModal) return;
        const dx = e.clientX - modalStartX;
        const dy = e.clientY - modalStartY;
        modal.style.left = (modalInitialX + dx) + 'px';
        modal.style.top = (modalInitialY + dy) + 'px';
    };
    
    const onMouseUp = () => { isDraggingModal = false; };
    
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('mouseup', onMouseUp);
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', onMouseUp);
    if (win !== window) {
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }
};
window.initDraggableModal(document);

// ==========================================================================
// PREMIUM FEATURES: EQUALIZER, SLEEP-TIMER & CANVAS SETUP IMPLEMENTATION
// ==========================================================================

// --- 1. AUDIO-EQUALIZER LOGIC ---
const eqPresets = {
    flat: [0, 0, 0, 0, 0],
    bassboost: [6, 4, 0, 0, -2],
    vocalboost: [-2, 0, 3, 4, 1],
    rock: [4, 2, -1, 2, 4],
    pop: [-1, 2, 3, 1, -1],
    classical: [3, 2, 0, 2, 3]
};

let isMixerMuted = false;
let previousPreampGain = 1.0;
let isLowCutActive = false;

function toggleMixerMute() {
    isMixerMuted = !isMixerMuted;
    const muteBtn = document.getElementById("mixerMute");
    const muteLed = document.getElementById("muteLed");
    
    if (isMixerMuted) {
        previousPreampGain = musicPreamp.gain.value;
        musicPreamp.gain.value = 0;
        videoPreamp.gain.value = 0;
        
        if (muteBtn) {
            muteBtn.style.background = "#ff4d4d";
            muteBtn.style.color = "#000";
            muteBtn.innerText = "MUTED";
        }
        if (muteLed) {
            muteLed.style.background = "#ff0000";
            muteLed.style.boxShadow = "0 0 10px #ff0000, 0 0 20px #ff0000";
        }
    } else {
        musicPreamp.gain.value = previousPreampGain;
        videoPreamp.gain.value = previousPreampGain;
        
        if (muteBtn) {
            muteBtn.style.background = "rgba(255,0,0,0.1)";
            muteBtn.style.color = "#ff4d4d";
            muteBtn.innerText = "MUTE";
        }
        if (muteLed) {
            muteLed.style.background = "#4a1515";
            muteLed.style.boxShadow = "0 0 6px #ff000030";
        }
    }
}

function toggleMixerLowCut() {
    isLowCutActive = !isLowCutActive;
    const lcBtn = document.getElementById("mixerLowCut");
    const lcLed = document.getElementById("lcLed");
    
    if (isLowCutActive) {
        musicFilters[0].type = 'highpass';
        musicFilters[0].frequency.value = 80;
        videoFilters[0].type = 'highpass';
        videoFilters[0].frequency.value = 80;
        
        if (lcBtn) {
            lcBtn.style.background = "var(--accent)";
            lcBtn.style.color = "#000";
        }
        if (lcLed) {
            lcLed.style.background = "#00aaff";
            lcLed.style.boxShadow = "0 0 10px #00aaff, 0 0 20px #00aaff";
        }
    } else {
        musicFilters[0].type = 'lowshelf';
        musicFilters[0].frequency.value = 60;
        videoFilters[0].type = 'lowshelf';
        videoFilters[0].frequency.value = 60;
        
        if (lcBtn) {
            lcBtn.style.background = "rgba(0,0,0,0.3)";
            lcBtn.style.color = "var(--text-muted)";
        }
        if (lcLed) {
            lcLed.style.background = "#153e4a";
            lcLed.style.boxShadow = "0 0 6px #00aaff30";
        }
    }
}

window.toggleMixerMute = toggleMixerMute;
window.toggleMixerLowCut = toggleMixerLowCut;

function initEqualizer() {
    // 1. 5-Band EQ Sliders
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`eqSlider-${i}`);
        const valText = document.getElementById(`eqVal-${i}`);
        
        if (slider && valText) {
            slider.addEventListener("input", (e) => {
                const val = parseInt(e.target.value);
                valText.innerText = (val > 0 ? "+" : "") + val + " dB";
                
                if (i === 0 && isLowCutActive) return;
                
                musicFilters[i].gain.value = val;
                videoFilters[i].gain.value = val;
                
                const presetSelect = document.getElementById("eqPresets");
                if (presetSelect) presetSelect.value = "custom";
            });
        }
    }
    
    // 2. Preset Select
    const select = document.getElementById("eqPresets");
    if (select) {
        if (!select.querySelector('option[value="custom"]')) {
            const opt = document.createElement("option");
            opt.value = "custom";
            opt.text = "Benutzerdefiniert";
            select.appendChild(opt);
        }
        
        select.addEventListener("change", (e) => {
            const presetName = e.target.value;
            if (presetName === "custom") return;
            
            const gains = eqPresets[presetName];
            if (gains) {
                for (let i = 0; i < 5; i++) {
                    const slider = document.getElementById(`eqSlider-${i}`);
                    const valText = document.getElementById(`eqVal-${i}`);
                    
                    if (slider && valText) {
                        slider.value = gains[i];
                        valText.innerText = (gains[i] > 0 ? "+" : "") + gains[i] + " dB";
                    }
                    
                    if (i === 0 && isLowCutActive) continue;
                    
                    musicFilters[i].gain.value = gains[i];
                    videoFilters[i].gain.value = gains[i];
                }
            }
        });
    }
    
    // 3. Preamp Control
    const preampSlider = document.getElementById("mixerPreamp");
    const preampVal = document.getElementById("mixerPreampVal");
    if (preampSlider && preampVal) {
        preampSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            preampVal.innerText = (val > 0 ? "+" : "") + val.toFixed(1) + " dB";
            
            const amplitude = Math.pow(10, val / 20);
            if (!isMixerMuted) {
                musicPreamp.gain.value = amplitude;
                videoPreamp.gain.value = amplitude;
            } else {
                previousPreampGain = amplitude;
            }
        });
    }
    
    // 4. Pan Control
    const panSlider = document.getElementById("mixerPan");
    const panVal = document.getElementById("mixerPanVal");
    if (panSlider && panVal) {
        panSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            musicPanner.pan.value = val;
            videoPanner.pan.value = val;
            
            if (val === 0) {
                panVal.innerText = "Mitte";
            } else if (val < 0) {
                panVal.innerText = Math.round(Math.abs(val) * 100) + "% Links";
            } else {
                panVal.innerText = Math.round(val * 100) + "% Rechts";
            }
        });
    }
    
    // 5. Echo Delay Controls
    const delayTimeSlider = document.getElementById("mixerDelayTime");
    const delayTimeVal = document.getElementById("mixerDelayTimeVal");
    if (delayTimeSlider && delayTimeVal) {
        delayTimeSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            musicDelay.delayTime.value = val;
            videoDelay.delayTime.value = val;
            delayTimeVal.innerText = Math.round(val * 1000) + " ms";
        });
    }
    
    const delayFeedbackSlider = document.getElementById("mixerDelayFeedback");
    const delayFeedbackVal = document.getElementById("mixerDelayFeedbackVal");
    if (delayFeedbackSlider && delayFeedbackVal) {
        delayFeedbackSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            musicDelayFeedback.gain.value = val;
            videoDelayFeedback.gain.value = val;
            delayFeedbackVal.innerText = Math.round(val * 100) + "%";
        });
    }
    
    const delayWetSlider = document.getElementById("mixerDelayWet");
    const delayWetVal = document.getElementById("mixerDelayWetVal");
    if (delayWetSlider && delayWetVal) {
        delayWetSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            musicDelayWet.gain.value = val;
            videoDelayWet.gain.value = val;
            delayWetVal.innerText = Math.round((val / 0.8) * 100) + "%";
        });
    }
}

// --- 2. SLEEP-TIMER LOGIC ---
let sleepTimerId = null;
let sleepTimerCountdownInterval = null;
let sleepTimerTargetTime = null;

function setSleepTimer(minutes) {
    if (sleepTimerId) clearTimeout(sleepTimerId);
    if (sleepTimerCountdownInterval) clearInterval(sleepTimerCountdownInterval);
    
    const badge = document.getElementById("sleepTimerBadge");
    const valText = document.getElementById("sleepTimerValue");
    
    if (minutes === 0) {
        window.sleepTimerAtTrackEnd = false;
        if (badge) badge.style.display = "none";
        if (valText) valText.innerText = "Aus";
        if (videoMenu) videoMenu.classList.remove("show");
        return;
    }
    
    if (minutes === "end") {
        window.sleepTimerAtTrackEnd = true;
        if (badge) {
            badge.innerText = "🔕";
            badge.style.display = "block";
            badge.title = "Stoppt nach dem aktuellen Titel";
        }
        if (valText) valText.innerText = "Nach aktuellem Titel";
        if (videoMenu) videoMenu.classList.remove("show");
        return;
    }
    
    window.sleepTimerAtTrackEnd = false;
    const msDelay = minutes * 60 * 1000;
    sleepTimerTargetTime = Date.now() + msDelay;
    
    if (badge) {
        badge.style.display = "block";
        const updateBadge = () => {
            const diff = sleepTimerTargetTime - Date.now();
            if (diff <= 0) {
                badge.style.display = "none";
                clearInterval(sleepTimerCountdownInterval);
                return;
            }
            const minLeft = Math.ceil(diff / 60000);
            badge.innerText = minLeft + "m";
            badge.title = `${minLeft} Minuten verbleibend`;
        };
        updateBadge();
        sleepTimerCountdownInterval = setInterval(updateBadge, 30000);
    }
    
    if (valText) {
        valText.innerText = minutes + " Min";
    }
    
    sleepTimerId = setTimeout(() => {
        fadeOutAndPause(10);
    }, msDelay);
    
    if (videoMenu) videoMenu.classList.remove("show");
}

function fadeOutAndPause(durationSeconds) {
    const activePlayer = activeType === "video" ? videoPlayer : player;
    const originalVolume = activePlayer.volume;
    const steps = 20;
    const intervalTime = (durationSeconds * 1000) / steps;
    let currentStep = 0;
    
    const fadeInterval = setInterval(() => {
        currentStep++;
        const newVol = originalVolume * (1 - currentStep / steps);
        if (newVol > 0) {
            activePlayer.volume = newVol;
        } else {
            clearInterval(fadeInterval);
            if (activeType === "video") {
                videoPlayer.pause();
            } else {
                player.pause();
                if (record) record.classList.remove("spin");
            }
            
            const playBtn = document.getElementById("playBtn");
            if (playBtn) playBtn.innerText = "▶";
            
            activePlayer.volume = originalVolume;
            
            const badge = document.getElementById("sleepTimerBadge");
            if (badge) badge.style.display = "none";
        }
    }, intervalTime);
}

// --- 3. DYNAMIC CUSTOM CURSOR GALLERY & LOGO SETUP MODALS ---

const cursorFolder = path.join(mediaBase, "cursor");
if (!fs.existsSync(cursorFolder)) {
    fs.mkdirSync(cursorFolder, { recursive: true });
}

// Global active custom cursor path (stored physically)
let activeCustomCursorPath = localStorage.getItem("activeCustomCursorPath") || "";

// Custom Cursors Gallery Rendering
function renderCursorsGrid() {
    const grid = document.getElementById("customCursorsGrid");
    if (!grid) return;
    grid.innerHTML = "";
    
    if (!fs.existsSync(cursorFolder)) fs.mkdirSync(cursorFolder, { recursive: true });
    
    // Read all png custom cursor files
    const files = fs.readdirSync(cursorFolder).filter(f => f.match(/\.png$/i));
    const activeCursor = localStorage.getItem("activeCursorName") || "auto";
    const currentCustomPath = localStorage.getItem("activeCustomCursorPath") || "";
    
    files.forEach(file => {
        const fullPath = path.join(cursorFolder, file);
        const isSelected = (activeCursor === "custom_file" && currentCustomPath === fullPath);
        const safeCursorUrl = pathToFileURL(fullPath).href;
        
        // Parse name and timestamp
        const baseName = file.replace(/\.[^/.]+$/, "");
        const lastUnderscore = baseName.lastIndexOf("_");
        let displayName = "Eigener Zeiger";
        if (lastUnderscore !== -1) {
            displayName = baseName.substring(0, lastUnderscore).replace(/_/g, " ");
        } else {
            displayName = baseName.replace(/_/g, " ");
        }
        
        const card = document.createElement("div");
        card.className = "cursor-preset-card rounded-xl p-3 flex flex-col items-center justify-between gap-2 border cursor-pointer transition-all" + (isSelected ? " active" : "");
        card.style.minHeight = "120px";
        card.innerHTML = `
            <button class="delete-cursor-btn absolute top-2 right-2 bg-red-600/20 hover:bg-red-600/80 border border-red-500/30 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs transition-all" title="Mauszeiger löschen">🗑️</button>
            <div class="cursor-preview flex items-center justify-center h-12 w-full rounded-lg p-2" style="background: rgba(0,0,0,0.25);">
                <img src="${safeCursorUrl}?t=${Date.now()}" style="max-width: 32px; max-height: 32px; object-fit: contain; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5));">
            </div>
            <div class="text-center w-full mt-1">
                <span class="block text-xs font-semibold truncate text-white" title="${displayName}">${displayName}</span>
            </div>
        `;
        
        card.onclick = () => selectCustomPhysicalCursor(fullPath);
        const delBtn = card.querySelector(".delete-cursor-btn");
        if (delBtn) {
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteCustomCursor(fullPath);
            };
        }
        grid.appendChild(card);
    });
    
    // Append Creator Card for custom cursor drawing
    const addCard = document.createElement("div");
    addCard.className = "cursor-preset-card rounded-xl p-3 flex flex-col items-center justify-center gap-2 border cursor-pointer transition-all";
    addCard.style.minHeight = "120px";
    addCard.style.borderStyle = "dashed";
    addCard.style.borderColor = "rgba(255,255,255,0.2)";
    addCard.style.background = "rgba(0,0,0,0.2)";
    addCard.innerHTML = `
        <div style="font-size: 32px; color: var(--text-muted); font-weight: 300;">+</div>
        <span class="block text-xs font-bold text-center text-muted" style="color: var(--text-muted);">Zeiger Erstellen</span>
    `;
    addCard.onmouseover = () => { addCard.style.borderColor = "var(--accent)"; addCard.style.color = "var(--accent)"; };
    addCard.onmouseout = () => { addCard.style.borderColor = "rgba(255,255,255,0.2)"; addCard.style.color = "var(--text-muted)"; };
    addCard.onclick = () => window.openCursorDrawingEditor();
    grid.appendChild(addCard);
}

function selectCustomPhysicalCursor(filePath) {
    if (!fs.existsSync(filePath)) {
        alert("Fehler: Diese Mauszeiger-Datei existiert physisch nicht mehr.");
        return;
    }
    
    localStorage.setItem("activeCursorName", "custom_file");
    localStorage.setItem("activeCustomCursorPath", filePath);
    
    document.querySelectorAll(".cursor-preset-card").forEach(c => c.classList.remove("active"));
    
    const size = parseInt(document.getElementById("cursorSizeSlider").value || "32");
    const safeUrl = pathToFileURL(filePath).href;
    applyCustomCursor(safeUrl, size, 0, 0);
    
    const previewContainer = document.getElementById("cursorLivePreviewContainer");
    const previewName = document.getElementById("cursorPreviewName");
    if (previewContainer && previewName) {
        previewContainer.innerHTML = `<img src="${safeUrl}?t=${Date.now()}" style="max-width: 48px; max-height: 48px; filter: drop-shadow(0 4px 10px var(--accent-glow)); object-fit: contain;">`;
        const baseName = path.basename(filePath, ".png");
        const lastUnderscore = baseName.lastIndexOf("_");
        let name = "Eigener Zeiger";
        if (lastUnderscore !== -1) {
            name = baseName.substring(0, lastUnderscore).replace(/_/g, " ");
        } else {
            name = baseName.replace(/_/g, " ");
        }
        previewName.innerText = name;
    }
    
    renderCursorsGrid();
}

function deleteCustomCursor(filePath) {
    if (confirm("Möchtest du diesen Mauszeiger wirklich unwiderruflich löschen?")) {
        try {
            fs.unlinkSync(filePath);
            const currentPath = localStorage.getItem("activeCustomCursorPath") || "";
            if (currentPath === filePath) {
                localStorage.setItem("activeCursorName", "auto");
                localStorage.removeItem("activeCustomCursorPath");
                selectPresetCursor("auto");
            }
            renderCursorsGrid();
        } catch (err) {
            alert("Fehler beim Löschen des Zeigers: " + err.message);
        }
    }
}

// --- LOGO CREATION MODAL LOGIC (CHOICE BETWEEN IMPORT & DRAW NEW) ---
function openLogoCreationOptions() {
    editorTargetContext = 'logo';
    
    // Update modal text for Logo Erstellen
    const title = document.getElementById("assetModalTitle");
    const sub = document.getElementById("assetModalSubtitle");
    const imgTitle = document.getElementById("assetOptionImageTitle");
    const imgDesc = document.getElementById("assetOptionImageDesc");
    const drawTitle = document.getElementById("assetOptionDrawTitle");
    const drawDesc = document.getElementById("assetOptionDrawDesc");
    
    if (title) title.innerText = "Logo Erstellen";
    if (sub) sub.innerText = "Wähle aus, wie du dein neues App-Logo erstellen möchtest:";
    if (imgTitle) imgTitle.innerText = "Logo aus Bild erstellen";
    if (imgDesc) imgDesc.innerText = "Wähle ein vorhandenes Bild von deiner Festplatte aus und bearbeite es.";
    if (drawTitle) drawTitle.innerText = "Logo Selbst erstellen";
    if (drawDesc) drawDesc.innerText = "Konfiguriere eine leere Leinwand und zeichne dein eigenes Logo.";
    
    const modal = document.getElementById("logoCreationOptionsModal");
    if (modal) modal.classList.remove("hidden");
}

// Helper function to close modal
function closeLogoCreationOptions() {
    const modal = document.getElementById("logoCreationOptionsModal");
    if (modal) modal.classList.add("hidden");
}

function assetCreationChoose(mode) {
    closeLogoCreationOptions();
    if (mode === 'image') {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png, image/jpeg, image/webp, image/svg+xml";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            let sourcePath = window.getNativeFilePath(file);
            if (!sourcePath) { 
                try { 
                    sourcePath = require('electron').webUtils.getPathForFile(file); 
                } catch(err) {} 
            }

            if (sourcePath) { 
                window.openLogoEditor(sourcePath); 
            } else { 
                const reader = new FileReader();
                reader.onload = (event) => {
                    window.openLogoEditor(event.target.result);
                };
                reader.readAsDataURL(file); 
            }
        };
        input.click();
    } else if (mode === 'draw') {
        openCanvasSetup();
    }
}

// --- CANVAS SETUP MODAL (CLIP STUDIO PAINT STYLE) ---
function openCanvasSetup() {
    const modal = document.getElementById("canvasSetupModal");
    if (modal) {
        modal.classList.remove("hidden");
        
        // Dynamically select target-appropriate preset and size
        const presetSelect = document.getElementById("canvasPresetSelect");
        if (presetSelect) {
            if (editorTargetContext === 'cursor') {
                presetSelect.value = "48x48";
                applyCanvasPreset("48x48");
            } else if (editorTargetContext === 'cover') {
                presetSelect.value = "800x800";
                applyCanvasPreset("800x800");
            } else {
                presetSelect.value = "256x256";
                applyCanvasPreset("256x256");
            }
        }
        
        updateCanvasSetupPreview();
    }
}

function closeCanvasSetup() {
    const modal = document.getElementById("canvasSetupModal");
    if (modal) modal.classList.add("hidden");
}

function applyCanvasPreset(val) {
    const widthInput = document.getElementById("canvasSetupWidth");
    const heightInput = document.getElementById("canvasSetupHeight");
    if (!widthInput || !heightInput) return;
    
    if (val === 'custom') return;
    
    const parts = val.split("x");
    if (parts.length === 2) {
        widthInput.value = parts[0];
        heightInput.value = parts[1];
        updateCanvasSetupPreview();
    }
}

function updateCanvasSetupPreview() {
    const wVal = parseInt(document.getElementById("canvasSetupWidth").value || "512");
    const hVal = parseInt(document.getElementById("canvasSetupHeight").value || "512");
    const previewBox = document.getElementById("canvasSetupPreviewBox");
    if (!previewBox) return;
    
    const maxPreviewW = 180;
    const maxPreviewH = 180;
    
    let displayW, displayH;
    if (wVal >= hVal) {
        displayW = maxPreviewW;
        displayH = Math.max(30, Math.round((hVal / wVal) * maxPreviewW));
    } else {
        displayH = maxPreviewH;
        displayW = Math.max(30, Math.round((wVal / hVal) * maxPreviewH));
    }
    
    previewBox.style.width = displayW + "px";
    previewBox.style.height = displayH + "px";
    
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = gcd(wVal, hVal);
    const aspectString = divisor > 0 ? `${wVal / divisor}:${hVal / divisor}` : "1:1";
    previewBox.setAttribute("data-ratio", `${wVal} x ${hVal}\n(${aspectString})`);
}

function submitCanvasSetup() {
    const wVal = parseInt(document.getElementById("canvasSetupWidth").value || "512");
    const hVal = parseInt(document.getElementById("canvasSetupHeight").value || "512");
    
    if (isNaN(wVal) || wVal < 16 || wVal > 4096 || isNaN(hVal) || hVal < 16 || hVal > 4096) {
        alert("Fehler: Die Abmessungen müssen zwischen 16px und 4096px liegen!");
        return;
    }
    
    closeCanvasSetup();
    openNewBlankDrawingEditor(wVal, hVal);
}

function openNewBlankDrawingEditor(width, height) {
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    const ctx = tempCanvas.getContext("2d");
    
    ctx.clearRect(0, 0, width, height);
    
    const blankUrl = tempCanvas.toDataURL("image/png");
    window.openLogoEditor(blankUrl);
}

// Hook functions into window for HTML access
window.openLogoCreationOptions = openLogoCreationOptions;
window.closeLogoCreationOptions = closeLogoCreationOptions;
window.assetCreationChoose = assetCreationChoose;
window.openCanvasSetup = openCanvasSetup;
window.closeCanvasSetup = closeCanvasSetup;
window.applyCanvasPreset = applyCanvasPreset;
window.updateCanvasSetupPreview = updateCanvasSetupPreview;
window.submitCanvasSetup = submitCanvasSetup;
window.renderCursorsGrid = renderCursorsGrid;
window.selectCustomPhysicalCursor = selectCustomPhysicalCursor;
window.deleteCustomCursor = deleteCustomCursor;
window.onCanvasSetupSizeChange = updateCanvasSetupPreview;

// CUSTOM CURSOR SYSTEM -> ausgelagert nach src/cursorEngine.js (Cursor-Sets mit Zustaenden, Klick-Frames & Animationen)

// Helper: Merged crop box layer drawing
function getMergedCroppedCanvas() {
    const exportCanvas = document.createElement("canvas");
    const exportW = (cropBox && cropBox.w > 0) ? cropBox.w : (baseWidth || 500);
    const exportH = (cropBox && cropBox.h > 0) ? cropBox.h : (baseHeight || 500);
    const cropX = (cropBox && typeof cropBox.x === 'number') ? cropBox.x : 0;
    const cropY = (cropBox && typeof cropBox.y === 'number') ? cropBox.y : 0;
    exportCanvas.width = exportW; 
    exportCanvas.height = exportH; 
    const eCtx = exportCanvas.getContext("2d");

    const reversedLayers = [...layers].reverse();
    let groups = [];
    let currentGroup = null;

    reversedLayers.forEach((layer) => {
        if (!layer.visible) return;
        if (layer.clippedToBelow && currentGroup) {
            currentGroup.clipped.push(layer);
        } else {
            currentGroup = { base: layer, clipped: [] };
            groups.push(currentGroup);
        }
    });

    groups.forEach(group => {
        const baseLayer = group.base;
        if (group.clipped.length === 0) {
            eCtx.save();
            eCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
            drawLayerToCtx(eCtx, baseLayer, cropX, cropY);
            eCtx.restore();
        } else {
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = exportW;
            tempCanvas.height = exportH;
            const tempCtx = tempCanvas.getContext("2d");
            drawLayerToCtx(tempCtx, baseLayer, cropX, cropY);
            group.clipped.forEach(clippedLayer => {
                tempCtx.save();
                tempCtx.globalCompositeOperation = "source-atop";
                drawLayerToCtx(tempCtx, clippedLayer, cropX, cropY);
                tempCtx.restore();
            });
            eCtx.save();
            eCtx.globalCompositeOperation = baseLayer.blendMode === "source-over" ? "source-over" : (baseLayer.blendMode || "source-over");
            eCtx.drawImage(tempCanvas, 0, 0);
            eCtx.restore();
        }
    });
    return exportCanvas;
}

// Drawing Editor Direct Launcher for Cursor
window.openCursorDrawingEditor = function() {
    editorTargetContext = 'cursor';
    
    // Update modal text for Mauszeiger Erstellen
    const title = document.getElementById("assetModalTitle");
    const sub = document.getElementById("assetModalSubtitle");
    const imgTitle = document.getElementById("assetOptionImageTitle");
    const imgDesc = document.getElementById("assetOptionImageDesc");
    const drawTitle = document.getElementById("assetOptionDrawTitle");
    const drawDesc = document.getElementById("assetOptionDrawDesc");
    
    if (title) title.innerText = "Mauszeiger Erstellen";
    if (sub) sub.innerText = "Wähle aus, wie du deinen neuen Mauszeiger erstellen möchtest:";
    if (imgTitle) imgTitle.innerText = "Mauszeiger aus Bild erstellen";
    if (imgDesc) imgDesc.innerText = "Wähle ein vorhandenes Bild von deiner Festplatte aus und bearbeite es.";
    if (drawTitle) drawTitle.innerText = "Mauszeiger Selbst erstellen";
    if (drawDesc) drawDesc.innerText = "Konfiguriere eine leere Leinwand und zeichne deinen eigenen Mauszeiger.";
    
    const modal = document.getElementById("logoCreationOptionsModal");
    if (modal) modal.classList.remove("hidden");
};

// Speichern-Unter Modal Steuerung
window.openEditorSaveOptions = function() {
    const edDoc = getActiveEditorDoc();
    const modal = edDoc.getElementById("editorSaveOptionsModal") || document.getElementById("editorSaveOptionsModal");
    if (modal) {
        modal.classList.remove("hidden");
        modal.style.display = "flex";
        
        // Context-aware & general save options
        const logoBtn = edDoc.getElementById("editorSaveLogoBtn") || document.getElementById("editorSaveLogoBtn");
        const galleryBtn = edDoc.getElementById("editorSaveGalleryBtn") || document.getElementById("editorSaveGalleryBtn");
        const cursorBtn = edDoc.getElementById("editorSaveCursorBtn") || document.getElementById("editorSaveCursorBtn");
        const coverBtn = edDoc.getElementById("editorSaveCoverBtn") || document.getElementById("editorSaveCoverBtn");
        const thumbBtn = edDoc.getElementById("editorSaveThumbBtn") || document.getElementById("editorSaveThumbBtn");
        const fileBtn = edDoc.getElementById("editorSaveFileBtn") || document.getElementById("editorSaveFileBtn");
        
        if (logoBtn) logoBtn.style.display = 'flex';
        if (galleryBtn) galleryBtn.style.display = 'flex';
        if (cursorBtn) cursorBtn.style.display = 'flex';
        if (fileBtn) fileBtn.style.display = 'flex';
        
        if (coverBtn) coverBtn.style.display = (editorTargetContext === 'cover' || (typeof coverChangePlaylist !== 'undefined' && coverChangePlaylist)) ? 'flex' : 'none';
        if (thumbBtn) thumbBtn.style.display = (editorTargetContext === 'mediaThumb' || (typeof activeTmSelection !== 'undefined' && activeTmSelection)) ? 'flex' : 'none';
    }
};

window.closeEditorSaveOptions = function() {
    const docs = [document];
    if (window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) {
        try { docs.push(window.popoutEditorWindow.document); } catch (e) {}
    }
    for (const d of docs) {
        const modal = d.getElementById("editorSaveOptionsModal");
        if (modal) {
            modal.classList.add("hidden");
            modal.style.display = "none";
        }
    }
};

function showEditorToast(message, isError = false) {
    try {
        const docs = [];
        const edDoc = typeof getActiveEditorDoc === "function" ? getActiveEditorDoc() : document;
        if (edDoc && edDoc.body) docs.push(edDoc);
        if (document.body && edDoc !== document) docs.push(document);

        docs.forEach((targetDoc) => {
            const existing = targetDoc.getElementById("editorSaveToast");
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            const toast = targetDoc.createElement("div");
            toast.id = "editorSaveToast";
            toast.className = "editor-save-toast" + (isError ? " error" : "");
            toast.textContent = message;
            targetDoc.body.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 3200);
        });
    } catch (e) {}
    if (typeof showVideoToast === "function") {
        showVideoToast(message);
    }
}

// Context-aware Perform Save Routing with Custom Asset Naming, Strict 48x48 Scaling, and Playlist Cover injection
window.editorPerformSave = async function(target) {
    const exportCanvas = getMergedCroppedCanvas();
    if (!exportCanvas || exportCanvas.width <= 0 || exportCanvas.height <= 0) {
        showEditorToast("❌ Konnte Grafik nicht exportieren (ungültige Leinwand).", true);
        return;
    }

    // Read and sanitize custom name input
    const edDoc = getActiveEditorDoc();
    const nameInput = edDoc.getElementById("editorAssetNameInput") || document.getElementById("editorAssetNameInput");
    let assetName = nameInput ? nameInput.value.trim() : "";
    assetName = assetName.replace(/[^a-zA-Z0-9_\-\s]/g, "").replace(/\s+/g, "_");

    if (target === 'logo') {
        if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });
        const base64Data = exportCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
        if (!base64Data) {
            showEditorToast("❌ Konnte Grafik nicht als PNG kodieren.", true);
            return;
        }
        const isDataUrl = currentEditingLogo && currentEditingLogo.startsWith("data:");
        const isInLogoFolder = currentEditingLogo && currentEditingLogo.toLowerCase().startsWith(logoFolder.toLowerCase());

        const destPath = assetName
            ? path.join(logoFolder, `${assetName}_${Date.now()}.png`)
            : ((!isDataUrl && isInLogoFolder && currentEditingLogo)
                ? currentEditingLogo
                : path.join(logoFolder, `logo_${Date.now()}.png`));

        try {
            fs.writeFileSync(destPath, base64Data, 'base64');
            if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
                throw new Error("Gespeicherte Logo-Datei ist leer.");
            }
            currentEditingLogo = destPath;
            window.currentEditingLogo = destPath;
            if (typeof setActiveLogo === "function") {
                setActiveLogo(destPath);
            }
            if (typeof renderLogosGrid === "function") {
                renderLogosGrid();
            }
            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();
            showEditorToast("✅ Grafik gespeichert und als App-Logo aktiviert!");
        } catch (err) {
            showEditorToast("❌ Fehler beim Speichern: " + err.message, true);
        }
    }
    else if (target === 'gallery') {
        if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });
        const base64Data = exportCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
        if (!base64Data) {
            showEditorToast("❌ Konnte Grafik nicht als PNG kodieren.", true);
            return;
        }
        const destPath = path.join(logoFolder, `${assetName || 'artwork'}_${Date.now()}.png`);

        try {
            fs.writeFileSync(destPath, base64Data, 'base64');
            if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
                throw new Error("Gespeicherte Bilddatei ist leer.");
            }
            currentEditingLogo = destPath;
            window.currentEditingLogo = destPath;
            if (typeof renderLogosGrid === "function") {
                renderLogosGrid();
            }
            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();
            showEditorToast("✅ Bild erfolgreich in deiner App-Galerie gespeichert!");
        } catch (err) {
            showEditorToast("❌ Fehler beim Speichern in der Galerie: " + err.message, true);
        }
    }
    else if (target === 'mediaThumb') {
        if (!activeTmSelection) {
            showEditorToast("⚠️ Kein Medium ausgewählt.", true);
            return;
        }

        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.width = 512;
        scaleCanvas.height = 512;
        const sCtx = scaleCanvas.getContext("2d");
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = "high";
        sCtx.drawImage(exportCanvas, 0, 0, 512, 512);

        const dataUrl = scaleCanvas.toDataURL("image/png");
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

        const key = activeTmSelection.key;
        const coversFolder = path.join(mediaBase, "covers");
        if (!fs.existsSync(coversFolder)) fs.mkdirSync(coversFolder, { recursive: true });

        const destName = `thumb_${Date.now()}.png`;
        const destPath = path.join(coversFolder, destName);

        try {
            fs.writeFileSync(destPath, base64Data, 'base64');

            const prev = mediaCustomThumbnails[key];
            if (prev && fs.existsSync(prev)) {
                try { fs.unlinkSync(prev); } catch (e) {}
            }

            mediaCustomThumbnails[key] = destPath;
            localStorage.setItem("mediaCustomThumbnails", JSON.stringify(mediaCustomThumbnails));

            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();

            loadMusic();
            loadVideos();
            renderHistory();
            if (typeof renderPlaylists === "function") renderPlaylists();
            if (typeof loadTM === "function") loadTM(activeTmCategory);

            showEditorToast("✅ Individuelles Media-Thumbnail gespeichert & angewendet!");
        } catch (err) {
            showEditorToast("❌ Fehler beim Speichern des Thumbnails: " + err.message, true);
        }
    }
    else if (target === 'cursor') {
        if (!fs.existsSync(cursorFolder)) fs.mkdirSync(cursorFolder, { recursive: true });
        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.width = 48;
        scaleCanvas.height = 48;
        const sCtx = scaleCanvas.getContext("2d");
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = "high";
        sCtx.drawImage(exportCanvas, 0, 0, 48, 48);

        const dataUrl = scaleCanvas.toDataURL("image/png");
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

        const cursorName = assetName || "eigen_zeiger";
        const destPath = path.join(cursorFolder, `${cursorName}_${Date.now()}.png`);

        try {
            fs.writeFileSync(destPath, base64Data, 'base64');
            selectCustomPhysicalCursor(destPath);
            if (typeof renderCursorsGrid === "function") {
                renderCursorsGrid();
            }
            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();
            showEditorToast("✅ Mauszeiger '" + cursorName.replace(/_/g, " ") + "' gespeichert & angewendet!");
        } catch (err) {
            showEditorToast("❌ Fehler beim Speichern des Zeigers: " + err.message, true);
        }
    }
    else if (target === 'cover') {
        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.width = 800;
        scaleCanvas.height = 800;
        const sCtx = scaleCanvas.getContext("2d");

        sCtx.fillStyle = "#000000";
        sCtx.fillRect(0, 0, 800, 800);

        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = "high";
        sCtx.drawImage(exportCanvas, 0, 0, 800, 800);

        const dataUrl = scaleCanvas.toDataURL("image/jpeg", 0.9);
        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");

        const safeName = `pl_${coverChangePlaylist.type}_${coverChangePlaylist.plName.replace(/\s+/g, '_')}.jpg`;
        const destPath = path.join(coverFolder, safeName);

        try {
            fs.writeFileSync(destPath, base64Data, 'base64');

            let covers = JSON.parse(localStorage.getItem("playlistCovers") || "{}");
            covers[`${coverChangePlaylist.type}_${coverChangePlaylist.plName}`] = destPath;
            localStorage.setItem("playlistCovers", JSON.stringify(covers));

            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();

            if (!document.getElementById("playlistsTab")?.classList.contains("hidden")) renderPlaylists();
            if (!document.getElementById("tab-playlists")?.classList.contains("hidden")) loadSettingsPlaylists(coverChangePlaylist.type);

            showEditorToast("✅ Playlist-Cover gespeichert & angewendet!");
        } catch (err) {
            showEditorToast("❌ Fehler beim Speichern des Covers: " + err.message, true);
        }
    }
    else if (target === 'file') {
        const base64Data = exportCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
        const downloadName = assetName || "mein_werk";

        let savedPath = null;
        try {
            const res = await ipcRenderer.invoke("show-save-dialog", {
                title: "Grafik auf PC speichern",
                defaultPath: `${downloadName}_${Date.now()}.png`,
                filters: [{ name: "PNG-Grafik (*.png)", extensions: ["png"] }]
            });
            if (res && !res.canceled && res.filePath) {
                fs.writeFileSync(res.filePath, base64Data, 'base64');
                savedPath = res.filePath;
            } else if (res && res.canceled) {
                return;
            }
        } catch (e) {
            try {
                const os = require("os");
                const picturesDir = path.join(os.homedir(), "Pictures");
                const fallbackDir = fs.existsSync(picturesDir) ? picturesDir : path.join(mediaBase, "artworks");
                if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
                const fallbackPath = path.join(fallbackDir, `${downloadName}_${Date.now()}.png`);
                fs.writeFileSync(fallbackPath, base64Data, 'base64');
                savedPath = fallbackPath;
            } catch (err2) {}
        }

        if (savedPath) {
            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();
            showEditorToast(`✅ Datei gespeichert: ${path.basename(savedPath)}`);
        } else {
            const dataUrl = exportCanvas.toDataURL("image/png");
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = `${downloadName}_${Date.now()}.png`;
            edDoc.body.appendChild(a);
            a.click();
            edDoc.body.removeChild(a);
            if (nameInput) nameInput.value = "";
            window.closeEditorSaveOptions();
            showEditorToast(`✅ Download als "${downloadName}.png" gestartet.`);
        }
    }
};

// =========================================================================
// 4. GLOBAL WINDOW BINDINGS EXPORTS
// =========================================================================
window.openLogoCreationOptions = openLogoCreationOptions;
window.closeLogoCreationOptions = closeLogoCreationOptions;
window.assetCreationChoose = assetCreationChoose; // Unified launcher
window.openCanvasSetup = openCanvasSetup;
window.closeCanvasSetup = closeCanvasSetup;
window.applyCanvasPreset = applyCanvasPreset;
window.updateCanvasSetupPreview = updateCanvasSetupPreview;
window.submitCanvasSetup = submitCanvasSetup;
window.renderCursorsGrid = renderCursorsGrid;
window.selectCustomPhysicalCursor = selectCustomPhysicalCursor;
window.deleteCustomCursor = deleteCustomCursor;
window.onCanvasSetupSizeChange = updateCanvasSetupPreview;


// =========================================================================
// THEME SYSTEM, SETTINGS, PLAYLISTS, AND TAG MANAGER RECOVERY
// =========================================================================

const themePresets = {
    spotify: {
        '--accent': '#1db954',
        '--accent-glow': '#1ed760',
        '--bg-main': '#121212',
        '--bg-sidebar': '#07140c',
        '--bg-player': '#0c0c0c',
        '--bg-card': '#181818',
        '--bg-card-hover': '#282828',
        '--text-main': '#ffffff',
        '--text-muted': '#b3b3b3',
        '--heart-color': '#1db954',
        '--visualizer-color': '#1db954',
        '--search-bg': '#0f2f1d',
        '--nowplaying-bg': 'rgba(12, 12, 12, 0.85)',
        '--nowplaying-border': 'rgba(29, 185, 84, 0.2)',
        '--pill-bg-active': '#1db954',
        '--pill-text-active': '#08120d',
        '--eyebrow-color': '#8bcfa0',
        '--record-color': '#248235',
        '--badge-bg': '#102418',
        '--badge-text': '#9be2bd',
        '--folder-color': '#1db954'
    },
    netflix: {
        '--accent': '#e50914',
        '--accent-glow': '#f41f2a',
        '--bg-main': '#141414',
        '--bg-sidebar': '#000000',
        '--bg-player': '#080808',
        '--bg-card': '#1c1c1c',
        '--bg-card-hover': '#2a2a2a',
        '--text-main': '#ffffff',
        '--text-muted': '#aaaaaa',
        '--heart-color': '#e50914',
        '--visualizer-color': '#e50914',
        '--search-bg': '#32090c',
        '--nowplaying-bg': 'rgba(8, 8, 8, 0.85)',
        '--nowplaying-border': 'rgba(229, 9, 20, 0.2)',
        '--pill-bg-active': '#e50914',
        '--pill-text-active': '#ffffff',
        '--eyebrow-color': '#f7797e',
        '--record-color': '#a8070d',
        '--badge-bg': '#240a0b',
        '--badge-text': '#ff9ea2',
        '--folder-color': '#e50914'
    },
    ocean: {
        '--accent': '#00aaff',
        '--accent-glow': '#33bbff',
        '--bg-main': '#0b131a',
        '--bg-sidebar': '#05090d',
        '--bg-player': '#070d12',
        '--bg-card': '#111d28',
        '--bg-card-hover': '#1a2c3d',
        '--text-main': '#e6f4ff',
        '--text-muted': '#8ab4d6',
        '--heart-color': '#00aaff',
        '--visualizer-color': '#00aaff',
        '--search-bg': '#062a40',
        '--nowplaying-bg': 'rgba(7, 13, 18, 0.85)',
        '--nowplaying-border': 'rgba(0, 170, 255, 0.2)',
        '--pill-bg-active': '#00aaff',
        '--pill-text-active': '#0b131a',
        '--eyebrow-color': '#7dd3fc',
        '--record-color': '#0088cc',
        '--badge-bg': '#082133',
        '--badge-text': '#8fd6ff',
        '--folder-color': '#00aaff'
    },
    cyberpunk: {
        '--accent': '#ff007f',
        '--accent-glow': '#ff3399',
        '--bg-main': '#0c0812',
        '--bg-sidebar': '#14051a',
        '--bg-player': '#0f0214',
        '--bg-card': '#22092c',
        '--bg-card-hover': '#351543',
        '--text-main': '#00ffff',
        '--text-muted': '#c084fc',
        '--heart-color': '#ff007f',
        '--visualizer-color': '#00ffff',
        '--search-bg': '#300736',
        '--nowplaying-bg': 'rgba(15, 2, 20, 0.85)',
        '--nowplaying-border': 'rgba(255, 0, 127, 0.2)',
        '--pill-bg-active': '#ff007f',
        '--pill-text-active': '#0c0812',
        '--eyebrow-color': '#f472b6',
        '--record-color': '#c20063',
        '--badge-bg': '#26042b',
        '--badge-text': '#ff9ee2',
        '--folder-color': '#ff007f'
    },
    bloodmoon: {
        '--accent': '#ff4d4d',
        '--accent-glow': '#ff6666',
        '--bg-main': '#1a0f0f',
        '--bg-sidebar': '#100505',
        '--bg-player': '#150808',
        '--bg-card': '#2a1717',
        '--bg-card-hover': '#3d2222',
        '--text-main': '#ffe6e6',
        '--text-muted': '#d99e9e',
        '--heart-color': '#ff4d4d',
        '--visualizer-color': '#ff4d4d',
        '--search-bg': '#380c0c',
        '--nowplaying-bg': 'rgba(21, 8, 8, 0.85)',
        '--nowplaying-border': 'rgba(255, 77, 77, 0.2)',
        '--pill-bg-active': '#ff4d4d',
        '--pill-text-active': '#1a0f0f',
        '--eyebrow-color': '#fca5a5',
        '--record-color': '#cc3d3d',
        '--badge-bg': '#2b0b0b',
        '--badge-text': '#ffa3a3',
        '--folder-color': '#ff4d4d'
    },
    forest: {
        '--accent': '#a3e635',
        '--accent-glow': '#bef264',
        '--bg-main': '#0d170a',
        '--bg-sidebar': '#060b05',
        '--bg-player': '#0a1108',
        '--bg-card': '#182a13',
        '--bg-card-hover': '#243f1d',
        '--text-main': '#f0fdf4',
        '--text-muted': '#a7f3d0',
        '--heart-color': '#a3e635',
        '--visualizer-color': '#a3e635',
        '--search-bg': '#182910',
        '--nowplaying-bg': 'rgba(10, 17, 8, 0.85)',
        '--nowplaying-border': 'rgba(163, 230, 53, 0.2)',
        '--pill-bg-active': '#a3e635',
        '--pill-text-active': '#0d170a',
        '--eyebrow-color': '#bef264',
        '--record-color': '#7dbb1a',
        '--badge-bg': '#12240b',
        '--badge-text': '#d4fc9f',
        '--folder-color': '#a3e635'
    },
    lavender: {
        '--accent': '#c084fc',
        '--accent-glow': '#d8b4fe',
        '--bg-main': '#130f1c',
        '--bg-sidebar': '#0a0710',
        '--bg-player': '#100c17',
        '--bg-card': '#221b30',
        '--bg-card-hover': '#302744',
        '--text-main': '#faf5ff',
        '--text-muted': '#d8b4fe',
        '--heart-color': '#c084fc',
        '--visualizer-color': '#c084fc',
        '--search-bg': '#2b173c',
        '--nowplaying-bg': 'rgba(16, 12, 23, 0.85)',
        '--nowplaying-border': 'rgba(192, 132, 252, 0.2)',
        '--pill-bg-active': '#c084fc',
        '--pill-text-active': '#130f1c',
        '--eyebrow-color': '#e9d5ff',
        '--record-color': '#a05bf5',
        '--badge-bg': '#1c122b',
        '--badge-text': '#ebd4ff',
        '--folder-color': '#c084fc'
    },
    luxury: {
        '--accent': '#fbbf24',
        '--accent-glow': '#fcd34d',
        '--bg-main': '#1c1917',
        '--bg-sidebar': '#0c0a09',
        '--bg-player': '#141210',
        '--bg-card': '#292524',
        '--bg-card-hover': '#3f3935',
        '--text-main': '#fafaf9',
        '--text-muted': '#d6d3d1',
        '--heart-color': '#fbbf24',
        '--visualizer-color': '#fbbf24',
        '--search-bg': '#3c2f10',
        '--nowplaying-bg': 'rgba(20, 18, 16, 0.85)',
        '--nowplaying-border': 'rgba(251, 191, 36, 0.2)',
        '--pill-bg-active': '#fbbf24',
        '--pill-text-active': '#1c1917',
        '--eyebrow-color': '#fcd34d',
        '--record-color': '#d99e1a',
        '--badge-bg': '#241b08',
        '--badge-text': '#ffe6a3',
        '--folder-color': '#fbbf24'
    },
    sakura: {
        '--accent': '#ffb7b2',
        '--accent-glow': '#ffd1cf',
        '--bg-main': '#231819',
        '--bg-sidebar': '#140c0d',
        '--bg-player': '#1c1112',
        '--bg-card': '#332224',
        '--bg-card-hover': '#442f31',
        '--text-main': '#fff0f1',
        '--text-muted': '#fbc4c7',
        '--heart-color': '#ffb7b2',
        '--visualizer-color': '#ffb7b2',
        '--search-bg': '#3f2225',
        '--nowplaying-bg': 'rgba(28, 17, 18, 0.85)',
        '--nowplaying-border': 'rgba(255, 183, 178, 0.2)',
        '--pill-bg-active': '#ffb7b2',
        '--pill-text-active': '#231819',
        '--eyebrow-color': '#ffd1cf',
        '--record-color': '#fca19a',
        '--badge-bg': '#2e1518',
        '--badge-text': '#ffd1cf',
        '--folder-color': '#ffb7b2'
    },
    galaxy: {
        '--accent': '#8a2be2',
        '--accent-glow': '#9d4edd',
        '--bg-main': '#060212',
        '--bg-sidebar': '#020008',
        '--bg-player': '#04010b',
        '--bg-card': '#110829',
        '--bg-card-hover': '#1c0d42',
        '--text-main': '#f3e8ff',
        '--text-muted': '#c084fc',
        '--heart-color': '#8a2be2',
        '--visualizer-color': '#8a2be2',
        '--search-bg': '#1d0738',
        '--nowplaying-bg': 'rgba(4, 1, 11, 0.85)',
        '--nowplaying-border': 'rgba(138, 43, 226, 0.2)',
        '--pill-bg-active': '#8a2be2',
        '--pill-text-active': '#060212',
        '--eyebrow-color': '#d8b4fe',
        '--record-color': '#6a1cb8',
        '--badge-bg': '#150529',
        '--badge-text': '#ebd4ff',
        '--folder-color': '#8a2be2'
    },
    steampunk: {
        '--accent': '#d4a373',
        '--accent-glow': '#e3c099',
        '--bg-main': '#1f1915',
        '--bg-sidebar': '#100b08',
        '--bg-player': '#16110d',
        '--bg-card': '#2e251f',
        '--bg-card-hover': '#3f332a',
        '--text-main': '#fefae0',
        '--text-muted': '#cca785',
        '--heart-color': '#d4a373',
        '--visualizer-color': '#d4a373',
        '--search-bg': '#3c2817',
        '--nowplaying-bg': 'rgba(22, 17, 13, 0.85)',
        '--nowplaying-border': 'rgba(212, 163, 115, 0.2)',
        '--pill-bg-active': '#d4a373',
        '--pill-text-active': '#1f1915',
        '--eyebrow-color': '#e3c099',
        '--record-color': '#b88a5c',
        '--badge-bg': '#24180d',
        '--badge-text': '#fad6b4',
        '--folder-color': '#d4a373'
    },
    nightsky: {
        '--accent': '#f6f1d3',
        '--accent-glow': '#ffffff',
        '--bg-main': '#0a0b10',
        '--bg-sidebar': '#030406',
        '--bg-player': '#06070a',
        '--bg-card': '#12141f',
        '--bg-card-hover': '#1c1e2d',
        '--text-main': '#ffffff',
        '--text-muted': '#a5aabf',
        '--heart-color': '#f6f1d3',
        '--visualizer-color': '#f6f1d3',
        '--search-bg': '#0e1627',
        '--nowplaying-bg': 'rgba(6, 7, 10, 0.85)',
        '--nowplaying-border': 'rgba(246, 241, 211, 0.2)',
        '--pill-bg-active': '#f6f1d3',
        '--pill-text-active': '#0a0b10',
        '--eyebrow-color': '#fcfad7',
        '--record-color': '#dad3ab',
        '--badge-bg': '#0b1221',
        '--badge-text': '#fcfad7',
        '--folder-color': '#f6f1d3'
    }
};

function applyTheme(themeName, customVars = null) {
    let variables = customVars;
    if (!variables) {
        variables = themePresets[themeName.toLowerCase() || themeName];
    }
    
    if (!variables) {
        try {
            const customThemes = JSON.parse(localStorage.getItem('customThemes') || '[]');
            const custom = customThemes.find(t => t.name.toLowerCase() === themeName.toLowerCase());
            if (custom) {
                variables = custom.variables;
            }
        } catch(e) {}
    }
    
    if (!variables) {
        console.warn("Theme not found:", themeName);
        return;
    }
    
    const style = document.documentElement.style;
    Object.keys(variables).forEach(key => {
        style.setProperty(key, variables[key]);
    });
    
    localStorage.setItem('activeThemeName', themeName);
    
    // Also dye player heart dynamically
    const heart = document.getElementById("likeBtn");
    if (heart) {
        const isCurrentlyLiked = heart.innerText === "♥";
        heart.style.color = isCurrentlyLiked ? (variables['--heart-color'] || variables['--accent'] || '#1db954') : 'white';
    }
    
    console.log("Theme " + themeName + " applied!");
    if (typeof window.refreshCursorTheme === "function") {
        window.refreshCursorTheme();
    }
}

function loadSavedTheme() {
    const savedName = localStorage.getItem('activeThemeName') || 'spotify';
    if (savedName === 'custom') {
        let customOverrides = {};
        try {
            customOverrides = JSON.parse(localStorage.getItem('customThemeOverrides') || '{}');
        } catch(e) {}
        const style = document.documentElement.style;
        Object.keys(customOverrides).forEach(key => {
            style.setProperty(key, customOverrides[key]);
        });
        return;
    }
    
    let customVars = null;
    try {
        const customThemes = JSON.parse(localStorage.getItem('customThemes') || '[]');
        const custom = customThemes.find(t => t.name.toLowerCase() === savedName.toLowerCase());
        if (custom) {
            customVars = custom.variables;
        }
    } catch(e) {}
    
    applyTheme(savedName, customVars);
}

function saveCustomTheme() {
    const nameInput = document.getElementById('customThemeName');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) {
        alert('Bitte gib einen Namen für dein Theme ein!');
        return;
    }
    
    const vars = [
        '--accent', '--accent-glow', '--bg-main', '--bg-sidebar', '--bg-player',
        '--bg-card', '--bg-card-hover', '--text-main', '--text-muted', '--heart-color',
        '--visualizer-color', '--search-bg', '--nowplaying-bg', '--nowplaying-border',
        '--pill-bg-active', '--pill-text-active', '--eyebrow-color', '--record-color',
        '--badge-bg', '--badge-text', '--folder-color'
    ];
    
    const themeObj = { name, variables: {} };
    const styles = getComputedStyle(document.documentElement);
    vars.forEach(v => {
        themeObj.variables[v] = styles.getPropertyValue(v).trim();
    });
    
    let customThemes = [];
    try {
        customThemes = JSON.parse(localStorage.getItem('customThemes') || '[]');
    } catch(e) {}
    
    customThemes = customThemes.filter(t => t.name.toLowerCase() !== name.toLowerCase());
    customThemes.push(themeObj);
    localStorage.setItem('customThemes', JSON.stringify(customThemes));
    
    nameInput.value = '';
    renderCustomThemes();
    alert('Theme "' + name + '" wurde erfolgreich gespeichert!');
}

function renderCustomThemes() {
    const grid = document.getElementById('customThemesGrid');
    if (!grid) return;
    
    let customThemes = [];
    try {
        customThemes = JSON.parse(localStorage.getItem('customThemes') || '[]');
    } catch(e) {}
    
    grid.innerHTML = '';
    
    if (customThemes.length === 0) {
        grid.innerHTML = '<p style="grid-column: span 2; color: var(--text-muted); font-size: 13px; text-align: center; margin: 10px 0;">Keine eigenen Themes.</p>';
        return;
    }
    
    customThemes.forEach(theme => {
        const themeBtn = document.createElement('div');
        themeBtn.style.display = 'flex';
        themeBtn.style.alignItems = 'center';
        themeBtn.style.justifyContent = 'space-between';
        themeBtn.style.padding = '8px 12px';
        themeBtn.style.borderRadius = '8px';
        themeBtn.style.background = 'rgba(255,255,255,0.05)';
        themeBtn.style.border = '1px solid rgba(255,255,255,0.1)';
        themeBtn.style.cursor = 'pointer';
        themeBtn.style.transition = 'all 0.2s ease';
        
        themeBtn.onmouseenter = () => {
            themeBtn.style.background = 'rgba(255,255,255,0.1)';
            themeBtn.style.borderColor = theme.variables['--accent'] || 'var(--accent)';
        };
        themeBtn.onmouseleave = () => {
            themeBtn.style.background = 'rgba(255,255,255,0.05)';
            themeBtn.style.borderColor = 'rgba(255,255,255,0.1)';
        };
        
        const infoDiv = document.createElement('div');
        infoDiv.style.display = 'flex';
        infoDiv.style.alignItems = 'center';
        infoDiv.style.gap = '8px';
        infoDiv.onclick = () => {
            applyTheme(theme.name, theme.variables);
        };
        
        const dot = document.createElement('span');
        dot.style.width = '12px';
        dot.style.height = '12px';
        dot.style.borderRadius = '50%';
        dot.style.background = theme.variables['--accent'] || '#1db954';
        dot.style.boxShadow = '0 0 8px ' + (theme.variables['--accent'] || '#1db954');
        
        const label = document.createElement('span');
        label.textContent = theme.name;
        label.style.color = 'white';
        label.style.fontWeight = '500';
        label.style.fontSize = '13px';
        
        infoDiv.appendChild(dot);
        infoDiv.appendChild(label);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.style.background = 'none';
        deleteBtn.style.border = 'none';
        deleteBtn.style.color = '#ef4444';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.style.padding = '4px 8px';
        deleteBtn.style.borderRadius = '4px';
        deleteBtn.style.fontSize = '14px';
        
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Möchtest du das Theme "' + theme.name + '" wirklich löschen?')) {
                deleteCustomTheme(theme.name);
            }
        };
        
        themeBtn.appendChild(infoDiv);
        themeBtn.appendChild(deleteBtn);
        grid.appendChild(themeBtn);
    });
}

function deleteCustomTheme(name) {
    let customThemes = [];
    try {
        customThemes = JSON.parse(localStorage.getItem('customThemes') || '[]');
    } catch(e) {}
    customThemes = customThemes.filter(t => t.name.toLowerCase() !== name.toLowerCase());
    localStorage.setItem('customThemes', JSON.stringify(customThemes));
    renderCustomThemes();
}

function updateCustomColor(varName, value) {
    document.documentElement.style.setProperty(varName, value);
    localStorage.setItem('activeThemeName', 'custom');
    
    let customOverrides = {};
    try {
        customOverrides = JSON.parse(localStorage.getItem('customThemeOverrides') || '{}');
    } catch(e) {}
    customOverrides[varName] = value;
    localStorage.setItem('customThemeOverrides', JSON.stringify(customOverrides));
}

function updateColorPickersFromCSS() {
    const mapping = {
        'colorAccent': '--accent',
        'colorAccentGlow': '--accent-glow',
        'colorText': '--text-main',
        'colorTextMuted': '--text-muted',
        'colorBgMain': '--bg-main',
        'colorBgSidebar': '--bg-sidebar',
        'colorTitlebarBg': '--titlebar-bg',
        'colorTitlebarText': '--titlebar-text',
        'colorCloseHover': '--close-hover',
        'colorBgPlayer': '--bg-player',
        'colorNowPlayingBg': '--nowplaying-bg',
        'colorNowPlayingBorder': '--nowplaying-border',
        'colorRecord': '--record-color',
        'colorVisualizer': '--visualizer-color',
        'colorBgCard': '--bg-card',
        'colorCardHover': '--bg-card-hover',
        'colorHeart': '--heart-color',
        'colorSearchBg': '--search-bg',
        'colorPillBg': '--pill-bg-active',
        'colorPillTextActive': '--pill-text-active',
        'colorEyebrow': '--eyebrow-color',
        'colorBadgeBg': '--badge-bg',
        'colorBadgeText': '--badge-text',
        'colorPlaylistBg': '--playlist-color',
        'colorFolder': '--folder-color'
    };
    
    const styles = getComputedStyle(document.documentElement);
    Object.keys(mapping).forEach(id => {
        const picker = document.getElementById(id);
        if (picker) {
            let val = styles.getPropertyValue(mapping[id]).trim();
            if (val.startsWith('rgb')) {
                val = rgbToHex(val);
            }
            if (val.startsWith('#') && (val.length === 4 || val.length === 7)) {
                picker.value = val;
            }
        }
    });
}

function rgbToHex(rgbStr) {
    const match = rgbStr.match(/\d+/g);
    if (!match || match.length < 3) return '#1db954';
    const r = parseInt(match[0]);
    const g = parseInt(match[1]);
    const b = parseInt(match[2]);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function toggleSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        renderCustomThemes();
        updateColorPickersFromCSS();
        syncAlwaysOnTopToggleUI();
    }
}

window.openHelpInSettings = function() {
    if (videoMenu) videoMenu.classList.remove('show');
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('hidden');
        renderCustomThemes();
        updateColorPickersFromCSS();
        syncAlwaysOnTopToggleUI();
    }
    switchSettingsTab('help');
};

function syncAlwaysOnTopToggleUI() {
    const isAlwaysOnTop = localStorage.getItem('alwaysOnTop_v2') === 'true';
    const chk = document.getElementById('chkAlwaysOnTop');
    const lbl = document.getElementById('alwaysOnTopStatusLabel');
    if (chk) chk.checked = isAlwaysOnTop;
    if (lbl) {
        lbl.textContent = isAlwaysOnTop ? 'An (Im Vordergrund)' : 'Aus (Standard)';
        lbl.style.color = isAlwaysOnTop ? 'var(--accent)' : 'var(--text-muted)';
    }

    const pinBtn = document.getElementById('titlePinBtn');
    if (pinBtn) {
        pinBtn.classList.toggle('active', isAlwaysOnTop);
        pinBtn.title = isAlwaysOnTop ? 'Fenster ist im Vordergrund angeheftet (Klicken zum Lösen)' : 'Fenster im Vordergrund anheften (Always on Top)';
    }
}

window.toggleAlwaysOnTopFromTitlebar = function() {
    const current = localStorage.getItem('alwaysOnTop_v2') === 'true';
    window.toggleAlwaysOnTopSetting(!current);
};

window.toggleAlwaysOnTopSetting = async function(enabled) {
    const isEnabled = Boolean(enabled);
    localStorage.setItem('alwaysOnTop_v2', isEnabled ? 'true' : 'false');
    localStorage.setItem('alwaysOnTop', isEnabled ? 'true' : 'false');
    try {
        if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
            await ipcRenderer.invoke('set-always-on-top', isEnabled).catch(() => {
                try { ipcRenderer.send('set-always-on-top', isEnabled); } catch(err) {}
            });
        } else if (ipcRenderer) {
            ipcRenderer.send('set-always-on-top', isEnabled);
        }
    } catch (e) {
        try { ipcRenderer.send('set-always-on-top', isEnabled); } catch(err) {}
    }
    syncAlwaysOnTopToggleUI();
    if (typeof showVideoToast === 'function') {
        showVideoToast(isEnabled ? '📌 Fenster bleibt im Vordergrund' : '🔓 Normaler Fenstermodus (andere Apps wieder im Vordergrund)');
    }
};

function initAlwaysOnTopSetting() {
    // Standardmäßig IMMER deaktiviert (false), außer der Nutzer hat es in v2 explizit aktiviert
    let isAlwaysOnTop = localStorage.getItem('alwaysOnTop_v2');
    if (isAlwaysOnTop === null) {
        // Erstmalige Initialisierung: Force default to FALSE
        localStorage.setItem('alwaysOnTop_v2', 'false');
        localStorage.setItem('alwaysOnTop', 'false');
        isAlwaysOnTop = false;
    } else {
        isAlwaysOnTop = isAlwaysOnTop === 'true';
    }
    try {
        if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
            ipcRenderer.invoke('set-always-on-top', isAlwaysOnTop).catch(() => {
                try { ipcRenderer.send('set-always-on-top', isAlwaysOnTop); } catch(e) {}
            });
        } else if (ipcRenderer) {
            ipcRenderer.send('set-always-on-top', isAlwaysOnTop);
        }
    } catch (e) {
        try { ipcRenderer.send('set-always-on-top', isAlwaysOnTop); } catch(err) {}
    }
    syncAlwaysOnTopToggleUI();
}

function switchSettingsTab(tabName) {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        if (tab.id === 'tabBtn-' + tabName) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    const panels = document.querySelectorAll('.settings-panel');
    panels.forEach(panel => {
        if (panel.id === 'tab-' + tabName) {
            panel.classList.remove('hidden');
            panel.classList.add('active');
        } else {
            panel.classList.add('hidden');
            panel.classList.remove('active');
        }
    });
    const subGroup = document.getElementById('plSubGroup');
    const chevron = document.getElementById('plGroupChevron');
    if (tabName === 'playlists' || tabName === 'playlistManager') {
        if (subGroup) subGroup.style.display = 'block';
        if (chevron) chevron.innerText = '▼';
    } else {
        if (subGroup) subGroup.style.display = 'none';
        if (chevron) chevron.innerText = '▶';
    }

    const appSubGroup = document.getElementById('appSubGroup');
    const appChevron = document.getElementById('appGroupChevron');
    if (tabName === 'appearance' || tabName === 'thumbnails' || tabName === 'snapshots') {
        if (appSubGroup) appSubGroup.style.display = 'block';
        if (appChevron) appChevron.innerText = '▼';
    } else {
        if (appSubGroup) appSubGroup.style.display = 'none';
        if (appChevron) appChevron.innerText = '▶';
    }
    
    // Auto-load/render tab-specific data when tab is clicked
    if (tabName === 'playlists') {
        loadSettingsPlaylists('music');
        const spMusicBtn = document.getElementById("spMusicBtn");
        const spVideoBtn = document.getElementById("spVideoBtn");
        if (spMusicBtn) spMusicBtn.classList.add("active");
        if (spVideoBtn) spVideoBtn.classList.remove("active");
    } else if (tabName === 'snapshots') {
        if (typeof window.loadSnapshotsGallery === 'function') window.loadSnapshotsGallery();
    } else if (tabName === 'equalizer') {
        if (typeof window.closeEqualizerModal === 'function') window.closeEqualizerModal();
        if (typeof window.syncEqualizerModalUI === 'function') window.syncEqualizerModalUI();
    } else if (tabName === 'logos') {
        renderLogosGrid();
    } else if (tabName === 'cursor') {
        renderCursorsGrid();
        if (typeof window.renderCursorThemeGallery === "function") window.renderCursorThemeGallery();
        if (typeof window.renderCursorStateStrip === "function") window.renderCursorStateStrip();
    } else if (tabName === 'diagnostics') {
        if (typeof window.refreshLogViewerUI === "function") window.refreshLogViewerUI();
    } else if (tabName === 'appearance') {
        syncAlwaysOnTopToggleUI();
    } else if (tabName === 'tags') {
        loadTM(activeTmCategory || 'music');
    } else if (tabName === 'updates') {
        if (typeof window.runAppSystemCheck === 'function') window.runAppSystemCheck(true);
    }
}

// ============================================================
// DIAGNOSE & DEBUG-LOGGING UI HANDLERS
// ============================================================
window.toggleLoggingSetting = function() {
    const currentState = AppLogger.isEnabled();
    const newState = !currentState;
    AppLogger.setEnabled(newState);
    window.refreshLogViewerUI();
};

window.openLogFileInEditor = function() {
    const logPath = AppLogger.getLogPath();
    if (!fs.existsSync(logPath)) {
        try {
            fs.writeFileSync(logPath, `[${new Date().toISOString()}] [INFO] [INIT] Logdatei initialisiert.\n`, "utf8");
        } catch(e) {}
    }
    shell.openPath(logPath);
};

window.openLogFolderInExplorer = function() {
    const logPath = AppLogger.getLogPath();
    if (!fs.existsSync(logPath)) {
        try {
            fs.writeFileSync(logPath, `[${new Date().toISOString()}] [INFO] [INIT] Logdatei initialisiert.\n`, "utf8");
        } catch(e) {}
    }
    shell.showItemInFolder(logPath);
};

window.clearDebugLogFile = function() {
    if (confirm("Möchtest du das aktuelle Fehlerprotokoll (debug_log.txt) wirklich leeren?")) {
        AppLogger.clear();
        window.refreshLogViewerUI();
    }
};

window.refreshLogViewerUI = function() {
    const isEnabled = AppLogger.isEnabled();
    const btn = document.getElementById("btnToggleLogging");
    const statusText = document.getElementById("logStatusText");
    const sizeText = document.getElementById("logFileSizeText");
    const pathText = document.getElementById("logPathShortText");
    const viewer = document.getElementById("liveLogViewer");

    if (btn) {
        if (isEnabled) {
            btn.textContent = "Aktiviert";
            btn.style.background = "var(--accent)";
            btn.style.color = "#000";
            btn.style.borderColor = "var(--accent)";
        } else {
            btn.textContent = "Deaktiviert";
            btn.style.background = "rgba(255,255,255,0.1)";
            btn.style.color = "#ddd";
            btn.style.borderColor = "rgba(255,255,255,0.2)";
        }
    }

    if (statusText) {
        if (isEnabled) {
            statusText.textContent = "Aktiv (Zeichnet Fehler & Aktivitäten auf)";
            statusText.style.color = "var(--accent)";
        } else {
            statusText.textContent = "Inaktiv (Kein Speicherverbrauch)";
            statusText.style.color = "#888";
        }
    }

    const bytes = AppLogger.getFileSizeBytes();
    if (sizeText) {
        if (bytes < 1024) {
            sizeText.textContent = bytes + " Bytes";
        } else if (bytes < 1024 * 1024) {
            sizeText.textContent = (bytes / 1024).toFixed(1) + " KB";
        } else {
            sizeText.textContent = (bytes / (1024 * 1024)).toFixed(2) + " MB";
        }
    }

    if (pathText) {
        pathText.textContent = AppLogger.getLogPath();
        pathText.title = AppLogger.getLogPath();
    }

    if (viewer) {
        viewer.textContent = AppLogger.getRecentLogs(300);
        viewer.scrollTop = viewer.scrollHeight;
    }
};

function openPlaylistModal() {
    const modal = document.getElementById("playlistModal");
    if (!modal) return;
    
    let activePath = currentPlaybackList[currentIndex];
    if (!activePath) {
        const activeList = (activeType === "video" ? videoListData : musicList);
        if (activeList && activeList[currentIndex]) {
            activePath = activeList[currentIndex];
        }
    }
    if (!activePath) {
        const src = (activeType === "video") ? videoPlayer.src : player.src;
        if (src && src.startsWith("file:///")) {
            try {
                let cleanPath = decodeURIComponent(new URL(src).pathname);
                if (cleanPath.charAt(2) === ':' || cleanPath.charAt(1) === ':') {
                    if (cleanPath.startsWith('/')) {
                        cleanPath = cleanPath.slice(1);
                    }
                }
                activePath = cleanPath;
            } catch (e) {
                console.error("Error parsing player src URL:", e);
            }
        }
    }
    
    if (!activePath) {
        alert("Es wird gerade kein Titel abgespielt!");
        return;
    }
    
    const optionsDiv = document.getElementById("playlistOptions");
    if (optionsDiv) {
        optionsDiv.innerHTML = "";
        const typePlaylists = playlists[activeType] || {};
        const names = Object.keys(typePlaylists);
        
        if (names.length === 0) {
            optionsDiv.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">Keine Playlists vorhanden. Erstelle eine neue unten!</p>';
        } else {
            names.forEach(name => {
                const checked = typePlaylists[name].includes(toMediaKey(activePath)) ? "checked" : "";
                const wrapper = document.createElement("div");
                wrapper.style.display = "flex";
                wrapper.style.alignItems = "center";
                wrapper.style.gap = "8px";
                wrapper.style.marginBottom = "8px";
                
                wrapper.innerHTML = '<input type="checkbox" id="plOpt-' + name + '" value="' + name + '" ' + checked + ' style="cursor: pointer;">' +
                                    '<label for="plOpt-' + name + '" style="color: white; cursor: pointer; font-size: 13px;">' + name + '</label>';
                optionsDiv.appendChild(wrapper);
            });
        }
    }
    
    modal.classList.remove("hidden");
}

function closePlaylistModal() {
    const modal = document.getElementById("playlistModal");
    if (modal) modal.classList.add("hidden");
    
    const input = document.getElementById("newPlaylistName");
    if (input) input.value = "";
}

function saveToPlaylists() {
    let activePath = currentPlaybackList[currentIndex];
    if (!activePath) {
        const activeList = (activeType === "video" ? videoListData : musicList);
        if (activeList && activeList[currentIndex]) {
            activePath = activeList[currentIndex];
        }
    }
    if (!activePath) {
        const src = (activeType === "video") ? videoPlayer.src : player.src;
        if (src && src.startsWith("file:///")) {
            try {
                let cleanPath = decodeURIComponent(new URL(src).pathname);
                if (cleanPath.charAt(2) === ':' || cleanPath.charAt(1) === ':') {
                    if (cleanPath.startsWith('/')) {
                        cleanPath = cleanPath.slice(1);
                    }
                }
                activePath = cleanPath;
            } catch (e) {
                console.error("Error parsing player src URL:", e);
            }
        }
    }
    if (!activePath) return;
    const mediaKey = toMediaKey(activePath);
    
    const newNameInput = document.getElementById("newPlaylistName");
    const newName = newNameInput ? newNameInput.value.trim() : "";
    
    if (newName) {
        if (!playlists[activeType][newName]) {
            playlists[activeType][newName] = [];
        }
        if (!playlists[activeType][newName].includes(mediaKey)) {
            playlists[activeType][newName].push(mediaKey);
        }
    }
    
    const optionsDiv = document.getElementById("playlistOptions");
    if (optionsDiv) {
        const checkboxes = optionsDiv.querySelectorAll("input[type='checkbox']");
        checkboxes.forEach(cb => {
            const plName = cb.value;
            if (cb.checked) {
                if (!playlists[activeType][plName].includes(mediaKey)) {
                    playlists[activeType][plName].push(mediaKey);
                }
            } else {
                playlists[activeType][plName] = playlists[activeType][plName].filter(k => k !== mediaKey);
            }
        });
    }
    
    localStorage.setItem("playlists", JSON.stringify(playlists));
    closePlaylistModal();
    renderPlaylists();
}

const IMPORT_VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.gif']);
const IMPORT_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.dts', '.dtshd', '.ac3', '.eac3']);

function getSelectedImportMode() {
    const sel = document.getElementById("importModeSelect");
    return sel ? sel.value : "link";
}

function getUniqueDestPath(destFolder, fileName) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = path.join(destFolder, fileName);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(destFolder, `${base}_${counter}${ext}`);
        counter++;
    }
    return candidate;
}

function collectMediaPathsRecursive(dirPath, outFiles) {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                collectMediaPathsRecursive(full, outFiles);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (IMPORT_VIDEO_EXTS.has(ext) || IMPORT_AUDIO_EXTS.has(ext)) {
                    outFiles.push(full);
                }
            }
        }
    } catch (err) {
        console.error("Fehler beim Scannen von Ordner " + dirPath + ":", err);
    }
}

async function importFilePathsBatch(inputPaths, modeOverride = null) {
    if (!inputPaths || inputPaths.length === 0) return { imported: 0, foldersLinked: 0 };
    const mode = modeOverride || getSelectedImportMode();
    const progBox = document.getElementById("mediaImportProgressBox");
    const progText = document.getElementById("mediaImportProgressText");
    const progPct = document.getElementById("mediaImportProgressPercent");
    const progBar = document.getElementById("mediaImportProgressBar");

    const fileQueue = [];
    const folderQueue = [];

    for (const rawPath of inputPaths) {
        if (!rawPath || !fs.existsSync(rawPath)) continue;
        try {
            const st = fs.statSync(rawPath);
            if (st.isDirectory()) {
                folderQueue.push(rawPath);
            } else {
                const ext = path.extname(rawPath).toLowerCase();
                if (IMPORT_VIDEO_EXTS.has(ext) || IMPORT_AUDIO_EXTS.has(ext)) {
                    fileQueue.push(rawPath);
                }
            }
        } catch (err) {}
    }

    let imported = 0;
    let foldersLinked = 0;
    const mkvToConvert = [];

    if (mode === "link") {
        let libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
        for (const folderPath of folderQueue) {
            if (!libraryFolders.includes(folderPath)) {
                libraryFolders.push(folderPath);
                foldersLinked++;
            }
            const folderFiles = [];
            collectMediaPathsRecursive(folderPath, folderFiles);
            folderFiles.forEach(fp => {
                if (fp.toLowerCase().endsWith(".mkv") && !fp.includes("_FEHLER")) {
                    mkvToConvert.push(fp);
                }
            });
        }
        if (foldersLinked > 0) {
            localStorage.setItem("libraryFolders", JSON.stringify(libraryFolders));
        }

        let libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
        for (const filePath of fileQueue) {
            if (filePath.toLowerCase().endsWith(".mkv") && !filePath.includes("_FEHLER")) {
                mkvToConvert.push(filePath);
            }
            if (!libraryFiles.includes(filePath)) {
                libraryFiles.push(filePath);
                imported++;
            }
        }
        if (imported > 0) {
            localStorage.setItem("libraryFiles", JSON.stringify(libraryFiles));
        }
    } else {
        for (const folderPath of folderQueue) {
            collectMediaPathsRecursive(folderPath, fileQueue);
        }
        if (fileQueue.length > 0) {
            if (!fs.existsSync(musicFolder)) fs.mkdirSync(musicFolder, { recursive: true });
            if (!fs.existsSync(videoFolder)) fs.mkdirSync(videoFolder, { recursive: true });
            if (progBox) progBox.classList.remove("hidden");

            for (let i = 0; i < fileQueue.length; i++) {
                const filePath = fileQueue[i];
                const ext = path.extname(filePath).toLowerCase();
                const destFolder = IMPORT_AUDIO_EXTS.has(ext) ? musicFolder : videoFolder;
                const destPath = getUniqueDestPath(destFolder, path.basename(filePath));
                const pct = Math.round(((i) / fileQueue.length) * 100);
                if (progText) progText.innerText = `Kopiere: ${path.basename(filePath)} (${i + 1}/${fileQueue.length})`;
                if (progPct) progPct.innerText = `${pct}%`;
                if (progBar) progBar.style.width = `${pct}%`;

                await new Promise(r => setTimeout(r, 0));
                try {
                    if (fs.promises && typeof fs.promises.copyFile === "function") {
                        await fs.promises.copyFile(filePath, destPath);
                    } else {
                        fs.copyFileSync(filePath, destPath);
                    }
                    if (destPath.toLowerCase().endsWith(".mkv") && !destPath.includes("_FEHLER")) {
                        mkvToConvert.push(destPath);
                    }
                    imported++;
                } catch (err) {
                    console.error("Fehler beim Kopieren von " + filePath + ":", err);
                }
            }
            if (progPct) progPct.innerText = "100%";
            if (progBar) progBar.style.width = "100%";
            if (progText) progText.innerText = `Fertig! ${imported} Datei(en) kopiert.`;
            setTimeout(() => { if (progBox) progBox.classList.add("hidden"); }, 1800);
        }
    }

    if (typeof loadMusic === "function") loadMusic();
    if (typeof loadVideos === "function") loadVideos();
    if (typeof ThumbnailPreloader !== "undefined") {
        ThumbnailPreloader.preloadAllThumbnailsPermanently().catch(() => {});
    }

    let queuedMkv = 0;
    if (mkvToConvert.length > 0 && typeof enqueueMkvConversions === "function") {
        queuedMkv = enqueueMkvConversions(mkvToConvert);
    }

    const parts = [];
    if (imported > 0) parts.push(`${imported} Datei(en)`);
    if (foldersLinked > 0) parts.push(`${foldersLinked} Ordner`);
    if (queuedMkv > 0 && typeof showVideoToast === "function") {
        showVideoToast(`🎬 ${queuedMkv} MKV-Datei(en) werden in MP4 umgewandelt...`);
    } else if (parts.length > 0 && typeof showVideoToast === "function") {
        showVideoToast(`✅ ${parts.join(" & ")} erfolgreich ${mode === 'link' ? 'verknüpft' : 'importiert'}!`);
    }
    return { imported, foldersLinked, queuedMkv };
}

async function openMediaImporter() {
    try {
        if (typeof ipcRenderer !== "undefined" && ipcRenderer.invoke) {
            const res = await ipcRenderer.invoke("pick-media-files");
            if (res && !res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
                await importFilePathsBatch(res.filePaths);
                return;
            }
            if (res && res.canceled) return;
        }
    } catch (err) {
        console.warn("Nativer Datei-Dialog Fallback:", err);
    }
    const input = document.getElementById("fileImporter");
    if (input) {
        input.value = "";
        input.click();
    }
}

async function openFolderImporter() {
    try {
        if (typeof ipcRenderer !== "undefined" && ipcRenderer.invoke) {
            const res = await ipcRenderer.invoke("pick-media-folder");
            if (res && !res.canceled && Array.isArray(res.folderPaths) && res.folderPaths.length > 0) {
                await importFilePathsBatch(res.folderPaths);
                return;
            }
        }
    } catch (err) {
        console.error("Fehler beim Ordner-Import:", err);
    }
}

async function handleMediaImport(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const paths = Array.from(files).map(f => window.getNativeFilePath(f)).filter(Boolean);
    if (paths.length === 0) {
        if (typeof showVideoToast === "function") showVideoToast("⚠️ Dateipfade konnten nicht gelesen werden.");
        return;
    }
    await importFilePathsBatch(paths);
    if (e.target) e.target.value = "";
}

function setImportDropZoneHighlight(active) {
    const dz = document.getElementById("importDropZone");
    if (!dz) return;
    dz.style.borderColor = active ? "var(--accent)" : "rgba(255,255,255,0.18)";
    dz.style.background = active ? "rgba(29, 185, 84, 0.1)" : "rgba(255,255,255,0.02)";
}

// Drop-Zone innerhalb des Import-Modals aktivieren
(function initImportModalDropZone() {
    const dz = document.getElementById("importDropZone");
    if (!dz) return;
    dz.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setImportDropZoneHighlight(true);
    });
    dz.addEventListener("dragleave", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setImportDropZoneHighlight(false);
    });
    dz.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setImportDropZoneHighlight(false);
        const droppedPaths = Array.from(e.dataTransfer?.files || [])
            .map(f => window.getNativeFilePath(f))
            .filter(Boolean);
        if (droppedPaths.length > 0 && typeof handleDroppedNativePaths === "function") {
            await handleDroppedNativePaths(droppedPaths, true);
        }
    });
})();
window.openFolderImporter = openFolderImporter;

let activePmCategory = 'music';
let activePmPlaylists = { Left: '', Right: '' };

function switchPmCategory(cat) {
    activePmCategory = cat;
    document.getElementById('pmCatMusicBtn').classList.toggle('active', cat === 'music');
    document.getElementById('pmCatVideoBtn').classList.toggle('active', cat === 'video');
    closePmSide('Left');
    closePmSide('Right');
}

function openPmSelector(side) {
    const emptyDiv = document.getElementById('pm' + side + 'Empty');
    const selectorDiv = document.getElementById('pm' + side + 'Selector');
    const contentDiv = document.getElementById('pm' + side + 'Content');
    const grid = document.getElementById('pm' + side + 'SelectorGrid');
    
    if (!emptyDiv || !selectorDiv || !contentDiv || !grid) return;
    
    emptyDiv.classList.add('hidden');
    contentDiv.classList.add('hidden');
    selectorDiv.classList.remove('hidden');
    
    grid.innerHTML = '';
    const typePlaylists = playlists[activePmCategory] || {};
    const names = Object.keys(typePlaylists);
    
    if (names.length === 0) {
        grid.innerHTML = '<p style="grid-column: span 2; color: var(--text-muted); font-size: 13px; text-align: center; margin: 20px 0;">Keine Playlists vorhanden.</p>';
        return;
    }
    
    names.forEach(plName => {
        const otherSide = side === 'Left' ? 'Right' : 'Left';
        if (activePmPlaylists[otherSide] === plName) return;
        
        const card = document.createElement('div');
        card.style.background = 'rgba(255,255,255,0.05)';
        card.style.border = '1px solid rgba(255,255,255,0.1)';
        card.style.borderRadius = '8px';
        card.style.padding = '12px';
        card.style.cursor = 'pointer';
        card.style.textAlign = 'center';
        card.style.transition = 'all 0.2s';
        
        card.onmouseenter = () => { card.style.borderColor = 'var(--accent)'; card.style.background = 'rgba(255,255,255,0.1)'; };
        card.onmouseleave = () => { card.style.borderColor = 'rgba(255,255,255,0.1)'; card.style.background = 'rgba(255,255,255,0.05)'; };
        
        const icon = activePmCategory === 'video' ? '🎬' : '🎵';
        card.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">' + icon + '</div>' +
                         '<div class="truncate" style="font-weight: 600; font-size: 12px; color: white;" title="' + plName + '">' + plName + '</div>' +
                         '<div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">' + typePlaylists[plName].length + ' Titel</div>';
        
        card.onclick = () => {
            selectPmPlaylist(side, plName);
        };
        
        grid.appendChild(card);
    });
}

function selectPmPlaylist(side, plName) {
    activePmPlaylists[side] = plName;
    const selectorDiv = document.getElementById('pm' + side + 'Selector');
    const contentDiv = document.getElementById('pm' + side + 'Content');
    if (selectorDiv) selectorDiv.classList.add('hidden');
    if (contentDiv) contentDiv.classList.remove('hidden');
    
    const titleEl = document.getElementById('pm' + side + 'Title');
    if (titleEl) titleEl.innerText = plName;
    
    renderPmPlaylistGrid(side);
}

function closePmSide(side) {
    activePmPlaylists[side] = '';
    const emptyDiv = document.getElementById('pm' + side + 'Empty');
    const selectorDiv = document.getElementById('pm' + side + 'Selector');
    const contentDiv = document.getElementById('pm' + side + 'Content');
    
    if (emptyDiv) emptyDiv.classList.remove('hidden');
    if (selectorDiv) selectorDiv.classList.add('hidden');
    if (contentDiv) contentDiv.classList.add('hidden');
}

function renderPmPlaylistGrid(side) {
    const plName = activePmPlaylists[side];
    const grid = document.getElementById('pm' + side + 'Grid');
    if (!grid || !plName) return;
    
    grid.innerHTML = '';
    const trackKeys = playlists[activePmCategory][plName] || [];
    
    if (trackKeys.length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">Diese Playlist ist leer.</div>';
        return;
    }
    
    const otherSide = side === 'Left' ? 'Right' : 'Left';
    const otherPlName = activePmPlaylists[otherSide];
    
    trackKeys.forEach((key, idx) => {
        const filePath = fromMediaKey(key);
        const name = path.basename(filePath).replace(/\.[^/.]+$/, "");
        
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.padding = '8px 10px';
        item.style.borderRadius = '6px';
        item.style.background = 'rgba(255,255,255,0.02)';
        item.style.border = '1px solid rgba(255,255,255,0.05)';
        item.style.marginBottom = '6px';
        item.style.gap = '8px';
        
        const nameSpan = document.createElement('span');
        nameSpan.innerText = (idx + 1) + '. ' + name;
        nameSpan.className = 'truncate';
        nameSpan.style.color = 'white';
        nameSpan.style.fontSize = '12px';
        nameSpan.style.flex = '1';
        nameSpan.title = name;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '4px';
        
        if (otherPlName) {
            const transferBtn = document.createElement('button');
            transferBtn.innerHTML = side === 'Left' ? '👉' : '👈';
            transferBtn.title = 'In "' + otherPlName + '" kopieren';
            transferBtn.className = 'pillBtn';
            transferBtn.style.padding = '2px 6px';
            transferBtn.style.fontSize = '12px';
            transferBtn.style.background = 'rgba(29, 185, 84, 0.15)';
            transferBtn.style.border = 'none';
            transferBtn.style.cursor = 'pointer';
            transferBtn.style.borderRadius = '4px';
            transferBtn.onclick = () => {
                if (!playlists[activePmCategory][otherPlName].includes(key)) {
                    playlists[activePmCategory][otherPlName].push(key);
                    localStorage.setItem('playlists', JSON.stringify(playlists));
                    renderPmPlaylistGrid(otherSide);
                    alert('"' + name + '" in "' + otherPlName + '" kopiert!');
                } else {
                    alert('"' + name + '" ist bereits in "' + otherPlName + '" enthalten.');
                }
            };
            actionsDiv.appendChild(transferBtn);
        }
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.title = 'Titel entfernen';
        delBtn.style.background = 'none';
        delBtn.style.border = 'none';
        delBtn.style.color = '#ff4444';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '12px';
        delBtn.style.padding = '2px 4px';
        delBtn.onclick = () => {
            playlists[activePmCategory][plName] = playlists[activePmCategory][plName].filter(k => k !== key);
            localStorage.setItem('playlists', JSON.stringify(playlists));
            renderPmPlaylistGrid(side);
            renderPlaylists();
        };
        
        actionsDiv.appendChild(delBtn);
        
        item.appendChild(nameSpan);
        item.appendChild(actionsDiv);
        grid.appendChild(item);
    });
}

let activeTmCategory = 'music';
let activeTmSelection = null;
let activeTmSubPlaylist = null;

function getAllTmMediaFiles(category) {
    const isMusic = category === 'music';
    const extPattern = isMusic
        ? /\.(mp3|wav|ogg|flac|m4a|aac|wma|dts|dtshd|ac3|eac3)$/i
        : /\.(mp4|webm|mkv|avi|mov|flv|ogv|m4v|ts|m2ts)$/i;
    const seenKeys = new Set();
    const results = [];

    function addFile(filePath, customName) {
        if (!filePath || typeof filePath !== 'string') return;
        const realPath = fromMediaKey(filePath);
        if (!realPath.match(extPattern)) return;
        const base = path.basename(realPath);
        if (!isMusic && (base.startsWith("buffer_") || base.startsWith("temp_"))) return;
        const key = toMediaKey(realPath);
        if (!key || seenKeys.has(key)) return;
        if (!fs.existsSync(realPath)) return;
        seenKeys.add(key);
        results.push({
            key,
            path: realPath,
            name: customName || base.replace(/\.[^/.]+$/, "")
        });
    }

    // 1. Interne Mediathek-Ordner
    const baseFolder = isMusic ? musicFolder : videoFolder;
    if (baseFolder && fs.existsSync(baseFolder)) {
        try {
            const localFiles = fs.readdirSync(baseFolder);
            localFiles.forEach(file => addFile(path.join(baseFolder, file)));
        } catch (e) {}
    }

    // 2. Aktuell geladene Listen (musicList / videoListData)
    const activeList = isMusic ? musicList : videoListData;
    if (Array.isArray(activeList)) {
        activeList.forEach(item => {
            const p = (item && typeof item === 'object') ? item.path : item;
            const n = (item && typeof item === 'object') ? (item.title || item.name) : null;
            addFile(p, n);
        });
    }

    // 3. Verknüpfte Ordner (libraryFolders)
    try {
        const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
        const folderTypes = JSON.parse(localStorage.getItem("libraryFolderTypes") || "{}");
        libraryFolders.forEach(folder => {
            const typeOfFolder = folderTypes[folder] || "both";
            if (typeOfFolder === category || typeOfFolder === "both") {
                if (fs.existsSync(folder)) {
                    try {
                        const files = fs.readdirSync(folder);
                        files.forEach(file => addFile(path.join(folder, file)));
                    } catch (e) {}
                }
            }
        });
    } catch (e) {}

    // 4. Verknüpfte Einzeldateien (libraryFiles)
    try {
        const libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
        libraryFiles.forEach(file => addFile(file));
    } catch (e) {}

    return results;
}

function loadTM(category) {
    activeTmCategory = category;
    document.getElementById('tmMusicBtn')?.classList.toggle('active', category === 'music');
    document.getElementById('tmVideoBtn')?.classList.toggle('active', category === 'video');
    document.getElementById('tmPlaylistBtn')?.classList.toggle('active', category === 'playlist');
    
    const backBtn = document.getElementById('tmBackBtn');
    const grid = document.getElementById('tmGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    if (category === 'playlist' && !activeTmSubPlaylist) {
        if (backBtn) backBtn.classList.add('hidden');
        
        const typePlaylists = { ...playlists.music, ...playlists.video };
        const names = Object.keys(typePlaylists);
        
        if (names.length === 0) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--text-muted); text-align: center; padding: 20px;">Keine Playlists vorhanden.</div>';
            return;
        }
        
        names.forEach(plName => {
            const card = document.createElement('div');
            card.style.background = 'rgba(255,255,255,0.05)';
            card.style.border = '1px solid rgba(255,255,255,0.1)';
            card.style.borderRadius = '8px';
            card.style.padding = '12px';
            card.style.cursor = 'pointer';
            card.style.transition = 'all 0.2s';
            card.style.textAlign = 'center';
            
            card.onmouseenter = () => { card.style.borderColor = 'var(--accent)'; card.style.background = 'rgba(255,255,255,0.1)'; };
            card.onmouseleave = () => { card.style.borderColor = 'rgba(255,255,255,0.1)'; card.style.background = 'rgba(255,255,255,0.05)'; };
            
            card.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">📂</div>' +
                             '<div class="truncate" style="font-weight: 600; font-size: 12px; color: white;" title="' + plName + '">' + plName + '</div>';
            
            card.onclick = () => {
                activeTmSubPlaylist = plName;
                loadTM('playlist');
            };
            
            grid.appendChild(card);
        });
    } else if (category === 'playlist' && activeTmSubPlaylist) {
        if (backBtn) {
            backBtn.classList.remove('hidden');
            backBtn.onclick = () => {
                activeTmSubPlaylist = null;
                loadTM('playlist');
            };
        }
        
        const isMusic = playlists.music[activeTmSubPlaylist] !== undefined;
        const list = playlists[isMusic ? 'music' : 'video'][activeTmSubPlaylist] || [];
        
        if (list.length === 0) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--text-muted); text-align: center; padding: 20px;">Diese Playlist ist leer.</div>';
            return;
        }
        
        list.forEach(key => {
            const filePath = fromMediaKey(key);
            const name = path.basename(filePath).replace(/\.[^/.]+$/, "");
            renderTmItem(grid, toMediaKey(filePath), isMusic ? 'music' : 'video', name);
        });
    } else {
        if (backBtn) backBtn.classList.add('hidden');
        activeTmSubPlaylist = null;
        
        if (category === 'music') {
            const items = getAllTmMediaFiles('music');
            if (items.length === 0) {
                grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--text-muted); text-align: center; padding: 20px;">Keine Musikdateien.</div>';
                return;
            }
            items.forEach(m => {
                renderTmItem(grid, m.key, 'music', m.name);
            });
        } else if (category === 'video') {
            const items = getAllTmMediaFiles('video');
            if (items.length === 0) {
                grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--text-muted); text-align: center; padding: 20px;">Keine Videodateien.</div>';
                return;
            }
            items.forEach(v => {
                renderTmItem(grid, v.key, 'video', v.name);
            });
        }
    }
}

function renderTmItem(grid, key, type, name) {
    const card = document.createElement('div');
    card.className = "mediaCard video";
    const filePath = fromMediaKey(key);
    card.dataset.filePath = filePath;
    card.dataset.mediaType = type;
    
    const isSelected = activeTmSelection && activeTmSelection.key === key;
    if (isSelected) {
        card.style.borderColor = 'var(--accent)';
        card.style.background = 'color-mix(in srgb, var(--accent) 14%, transparent)';
    }

    let assignedTag = '';
    try {
        const mediaTags = JSON.parse(localStorage.getItem('mediaTags') || '{}');
        assignedTag = mediaTags[key] || '';
    } catch (e) {}

    const badgeHtml = assignedTag
        ? `<div class="mediaBadge" style="font-size: 10px; padding: 2px 8px; margin-bottom: 2px;">${assignedTag}</div>`
        : '';
    
    card.innerHTML = badgeHtml + getMediaThumbHtml(key, type) + '<div class="mediaTitle" title="' + name + '">' + name + '</div>';

    setupMediaThumbListeners(card, key, type);

    card.onclick = () => {
        selectTmItem(key, type, name);
        loadTM(activeTmCategory);
    };
    
    grid.appendChild(card);
}

function selectTmItem(key, type, name) {
    activeTmSelection = { key, type, name };
    const titleEl = document.getElementById('tmRightTitle');
    const descEl = document.getElementById('tmSelectedText');
    if (titleEl) titleEl.innerText = name;
    if (descEl) descEl.innerText = 'Tag-Zuweisung für diese ' + (type === 'video' ? 'Videodatei' : 'Musikdatei') + '.';
    renderTmTagsList();
    renderTmCustomThumbnailPanel();
}

function renderTmTagsList() {
    const tagsList = document.getElementById('tmTagsList');
    if (!tagsList || !activeTmSelection) return;
    
    tagsList.innerHTML = '';
    let mediaTags = {};
    try {
        mediaTags = JSON.parse(localStorage.getItem('mediaTags') || '{}');
    } catch(e) {}
    
    const currentTag = mediaTags[activeTmSelection.key] || '';
    let allTags = ['Chill', 'Workout', 'Fokus', 'Party', 'Favoriten'];
    Object.values(mediaTags).forEach(t => {
        if (t && !allTags.includes(t)) allTags.push(t);
    });
    
    allTags.forEach(tag => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.padding = '8px 10px';
        item.style.borderRadius = '6px';
        item.style.background = 'rgba(255,255,255,0.03)';
        item.style.border = '1px solid rgba(255,255,255,0.05)';
        
        const isAssigned = (tag === currentTag);
        item.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;">' +
                         '<input type="radio" name="tmTagRadio" id="tmTag-' + tag + '" ' + (isAssigned ? 'checked' : '') + ' style="cursor: pointer;">' +
                         '<label for="tmTag-' + tag + '" style="color: white; font-size: 12px; cursor: pointer;">' + tag + '</label>' +
                         '</div>';
        
        const radio = item.querySelector('input[type="radio"]');
        radio.onclick = () => {
            assignTag(tag);
        };
        
        tagsList.appendChild(item);
    });
    
    if (currentTag) {
        const removeBtn = document.createElement('button');
        removeBtn.innerText = 'Tag entfernen';
        removeBtn.className = 'pillBtn';
        removeBtn.style.width = '100%';
        removeBtn.style.padding = '8px';
        removeBtn.style.marginTop = '10px';
        removeBtn.style.background = 'rgba(255,0,0,0.1)';
        removeBtn.style.border = '1px solid rgba(255,0,0,0.2)';
        removeBtn.style.color = '#ff4444';
        removeBtn.style.cursor = 'pointer';
        removeBtn.onclick = () => {
            assignTag('');
        };
        tagsList.appendChild(removeBtn);
    }
}

function assignTag(tag) {
    if (!activeTmSelection) return;
    let mediaTags = {};
    try {
        mediaTags = JSON.parse(localStorage.getItem('mediaTags') || '{}');
    } catch(e) {}
    
    if (tag === '') {
        delete mediaTags[activeTmSelection.key];
    } else {
        mediaTags[activeTmSelection.key] = tag;
    }
    
    localStorage.setItem('mediaTags', JSON.stringify(mediaTags));
    renderTmTagsList();
    loadMusic();
    loadVideos();
    if (typeof renderLiked === 'function') renderLiked();
    if (typeof loadTM === 'function') loadTM(activeTmCategory);
}

function saveNewTag() {
    const input = document.getElementById('newTagName');
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
        alert('Bitte gib einen Namen für den Tag ein!');
        return;
    }
    if (!activeTmSelection) {
        alert('Bitte wähle zuerst links eine Datei aus!');
        return;
    }
    assignTag(name);
    input.value = '';
}

function closeCoverEditor() {
    const modal = document.getElementById("coverEditorModal");
    if (modal) modal.classList.add("hidden");
}

function saveCoverEditor() {
    closeCoverEditor();
}

// BIND TO WINDOW FOR INLINE HTML ONCLICK HANDLERS ACCESS
window.toggleSettingsModal = toggleSettingsModal;
window.switchSettingsTab = switchSettingsTab;
window.applyTheme = applyTheme;
window.saveCustomTheme = saveCustomTheme;
window.renderCustomThemes = renderCustomThemes;
window.updateCustomColor = updateCustomColor;
window.openPlaylistModal = openPlaylistModal;
window.closePlaylistModal = closePlaylistModal;
window.saveToPlaylists = saveToPlaylists;
window.openMediaImporter = openMediaImporter;
window.handleMediaImport = handleMediaImport;
window.switchPmCategory = switchPmCategory;
window.openPmSelector = openPmSelector;
window.closePmSide = closePmSide;
window.loadTM = loadTM;
window.saveNewTag = saveNewTag;
window.closeCoverEditor = closeCoverEditor;
window.saveCoverEditor = saveCoverEditor;
window.changeThumbnailFormat = changeThumbnailFormat;
window.changeThumbnailSize = changeThumbnailSize;
window.toggleMediaTitles = toggleMediaTitles;
window.toggleMediaThumbs = toggleMediaThumbs;
window.selectCustomThumbFromFile = selectCustomThumbFromFile;
window.openCustomThumbEditor = openCustomThumbEditor;
window.removeCustomThumb = removeCustomThumb;

////////////////////////////////////////////////////////////
// FILE ASSOCIATION & MEDIA CONTROL INTEGRATION
////////////////////////////////////////////////////////////

function playMediaFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  
  const ext = path.extname(filePath).toLowerCase();
  const videoExtensions = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', '.wma', '.dts', '.dtshd', '.ac3', '.eac3'];
  
  const isVideo = videoExtensions.includes(ext);
  const isAudio = audioExtensions.includes(ext);
  
  if (!isVideo && !isAudio) return; // unsupported format
  
  // Build a playback list from the directory of the file
  try {
    const dir = path.dirname(filePath);
    const files = fs.readdirSync(dir);
    const mediaFiles = files
      .map(file => path.join(dir, file))
      .filter(f => {
        try {
          const stat = fs.statSync(f);
          if (!stat.isFile()) return false;
          const e = path.extname(f).toLowerCase();
          return isVideo ? videoExtensions.includes(e) : audioExtensions.includes(e);
        } catch (e) {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      
    currentPlaybackList = mediaFiles;
    currentIndex = mediaFiles.indexOf(filePath);
    if (currentIndex === -1) {
      currentPlaybackList = [filePath];
      currentIndex = 0;
    }
  } catch (err) {
    console.error("Error reading directory files:", err);
    currentPlaybackList = [filePath];
    currentIndex = 0;
  }
  
  // Play the file
  if (isVideo) {
    if (player) player.pause();
    if (record) record.classList.remove("spin");
    activeType = "video";
    videoPlayer.src = filePath;
    videoPlayer.currentTime = 0;
    ensureAudioContext();
    videoPlayer.play().catch(e => console.log("Video play error:", e));
    showTab("videos");
    
    if (playBtn) playBtn.innerText = "⏸";
    saveToHistory(filePath);
    updateLikeButton();
    updateVideoControls();
    updateNowPlaying();
  } else {
    if (videoPlayer) videoPlayer.pause();
    activeType = "music";
    player.src = filePath;
    player.currentTime = 0;
    ensureAudioContext();
    player.play().catch(e => console.log("Audio play error:", e));
    if (record) record.classList.add("spin");
    showTab("music");
    
    if (playBtn) playBtn.innerText = "⏸";
    saveToHistory(filePath);
    updateLikeButton();
    updateNowPlaying();
  }
}

function handleMediaEnded() {
  const activeList = (currentPlaybackList && currentPlaybackList.length > 0) ? currentPlaybackList : (activeType === "video" ? videoListData : musicList);
  if (!activeList || activeList.length === 0) return;
  
  if (shuffle) {
    currentIndex = Math.floor(Math.random() * activeList.length);
  } else {
    currentIndex = (currentIndex + 1) % activeList.length;
  }
  
  const filePath = activeList[currentIndex];
  playMediaFile(filePath);
}

function handleMediaPrevious() {
  const activeList = (currentPlaybackList && currentPlaybackList.length > 0) ? currentPlaybackList : (activeType === "video" ? videoListData : musicList);
  if (!activeList || activeList.length === 0) return;
  
  if (shuffle) {
    currentIndex = Math.floor(Math.random() * activeList.length);
  } else {
    currentIndex = (currentIndex - 1 + activeList.length) % activeList.length;
  }
  
  const filePath = activeList[currentIndex];
  playMediaFile(filePath);
}

// ==========================================
// DYNAMIC PC MEDIA FINDER STATE & CONTROLS
// ==========================================
let isScanningActive = false;
let foundMediaFiles = [];
let mfActiveDrive = 'C';
let detectedDrivesList = ['C'];
let mfMode = 'link'; // 'link' or 'move_select'
let mfSubMode = 'manual'; // 'manual' or 'auto'
let checkedMfPaths = new Set();
let scannedDirectoriesCount = 0;
let mfSearchQuery = "";
let mfActiveTab = 'all';

const IGNORED_FOLDERS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'appdata',
  'node_modules',
  '.git',
  'local',
  'roaming',
  'microsoft',
  'package cache',
  'temp',
  'tmp',
  'cache',
  'dist',
  'build'
]);

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.dts', '.dtshd', '.ac3', '.eac3']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.ogv', '.m4v', '.ts', '.m2ts']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

function detectDrives() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const found = [];
      for (let code = 67; code <= 90; code++) { // C..Z
        const letter = String.fromCharCode(code);
        try {
          if (fs.existsSync(`${letter}:\\`)) found.push(letter);
        } catch (e) {}
      }
      if (found.length > 0) {
        resolve(found);
        return;
      }
      exec("powershell -Command \"Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name\"", (err, stdout) => {
        if (err || !stdout) {
          resolve(['C']);
        } else {
          const drives = stdout.split('\n')
            .map(d => d.trim())
            .filter(d => d.length === 1 && d.match(/[a-zA-Z]/));
          resolve(drives.length > 0 ? drives : ['C']);
        }
      });
    } else {
      resolve(['/']);
    }
  });
}

async function openMediaFinder() {
  const convertModal = document.getElementById("convertModal");
  if (convertModal) convertModal.classList.add("hidden");
  
  const modal = document.getElementById("mediaFinderModal");
  if (!modal) return;
  
  modal.classList.remove("hidden");
  
  // Center and resize modal for selection views
  const modalContent = document.getElementById("mfModalContent");
  if (modalContent) {
    modalContent.style.height = "auto";
    modalContent.style.width = "720px";
  }
  
  // Show initial view
  document.getElementById("mfTypeSelectionView").classList.remove("hidden");
  document.getElementById("mfMethodSelectionView").classList.add("hidden");
  document.getElementById("mfWarningView").classList.add("hidden");
  document.getElementById("mfMainFinderView").classList.add("hidden");
  
  isScanningActive = false;
  foundMediaFiles = [];
  checkedMfPaths.clear();
  mfSearchQuery = "";
  document.getElementById("mfSearchInput").value = "";
  
  document.getElementById("mfStatusText").innerText = "Laufwerke werden gesucht...";
  document.getElementById("mfDetailText").innerText = "Bitte warten...";
  
  const drives = await detectDrives();
  detectedDrivesList = drives;
  mfActiveDrive = drives[0] || 'C';
  
  const drivesContainer = document.getElementById("mfDrivesList");
  if (drivesContainer) {
    drivesContainer.innerHTML = "";
    drives.forEach(drive => {
      const btn = document.createElement("button");
      btn.className = "pillBtn" + (drive === mfActiveDrive ? " active" : "");
      btn.style.width = "100%";
      btn.style.textAlign = "center";
      btn.innerText = drive.length === 1 ? `${drive}:\\` : drive;
      btn.onclick = () => {
        mfActiveDrive = drive;
        drivesContainer.querySelectorAll("button").forEach(b => {
          b.classList.toggle("active", b.innerText.startsWith(drive));
        });
        cancelMediaScan();
        startMediaScan();
      };
      drivesContainer.appendChild(btn);
    });
  }
}

function closeMediaFinder() {
  cancelMediaScan();
  if (typeof mfDriveCache !== "undefined") mfDriveCache.clear();
  foundMediaFiles = [];
  checkedMfPaths.clear();
  const modal = document.getElementById("mediaFinderModal");
  if (modal) modal.classList.add("hidden");
}

function selectMfSearchType(type) {
  mfSubMode = type; // 'manual' or 'auto'
  document.getElementById("mfTypeSelectionView").classList.add("hidden");
  document.getElementById("mfMethodSelectionView").classList.remove("hidden");
  const modalContent = document.getElementById("mfModalContent");
  if (modalContent) {
    modalContent.style.height = "auto";
    modalContent.style.width = "720px";
  }
}

function selectMfImportMethod(method) {
  mfMode = method; // 'link' or 'move'
  document.getElementById("mfMethodSelectionView").classList.add("hidden");
  if (mfSubMode === 'auto' && mfMode === 'move') {
    document.getElementById("mfWarningView").classList.remove("hidden");
    const modalContent = document.getElementById("mfModalContent");
    if (modalContent) {
      modalContent.style.height = "auto";
      modalContent.style.width = "720px";
    }
  } else {
    document.getElementById("mfMainFinderView").classList.remove("hidden");
    const modalContent = document.getElementById("mfModalContent");
    if (modalContent) {
      modalContent.style.height = "85vh";
      modalContent.style.width = "920px";
    }
    const typeText = mfSubMode === 'auto' ? 'Automatisch' : 'Manuell';
    const methodText = mfMode === 'link' ? 'Verknüpfen' : 'Verschieben';
    document.getElementById("mfTitleText").innerText = `PC durchsuchen: ${methodText} (${typeText})`;
    startMediaScan();
  }
}

function confirmMfWarning() {
  document.getElementById("mfWarningView").classList.add("hidden");
  document.getElementById("mfMainFinderView").classList.remove("hidden");
  const modalContent = document.getElementById("mfModalContent");
  if (modalContent) {
    modalContent.style.height = "85vh";
    modalContent.style.width = "920px";
  }
  document.getElementById("mfTitleText").innerText = "PC durchsuchen: Verschieben (Automatisch)";
  startMediaScan();
}

function cancelMfWarning() {
  document.getElementById("mfWarningView").classList.add("hidden");
  document.getElementById("mfMethodSelectionView").classList.remove("hidden");
  const modalContent = document.getElementById("mfModalContent");
  if (modalContent) {
    modalContent.style.height = "auto";
    modalContent.style.width = "720px";
  }
}

function goBackToMfMode() {
  cancelMediaScan();
  const modalContent = document.getElementById("mfModalContent");
  if (modalContent) {
    modalContent.style.height = "auto";
    modalContent.style.width = "720px";
  }
  if (!document.getElementById("mfMainFinderView").classList.contains("hidden")) {
    document.getElementById("mfMainFinderView").classList.add("hidden");
    document.getElementById("mfMethodSelectionView").classList.remove("hidden");
  } else if (!document.getElementById("mfMethodSelectionView").classList.contains("hidden")) {
    document.getElementById("mfMethodSelectionView").classList.add("hidden");
    document.getElementById("mfTypeSelectionView").classList.remove("hidden");
  }
}

function updateDiskSpaceInfo(driveLetter) {
  const diskTextEl = document.getElementById("mfDiskSpaceText");
  if (!diskTextEl) return;
  
  if (process.platform === 'win32') {
    exec(`powershell -Command "Get-Volume -DriveLetter ${driveLetter} | Select-Object SizeRemaining, Size"`, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length >= 2) {
          const stats = lines[1].split(/\\s+/);
          if (stats.length >= 2) {
            const freeBytes = parseInt(stats[0]);
            const totalBytes = parseInt(stats[1]);
            if (!isNaN(freeBytes) && !isNaN(totalBytes)) {
              diskTextEl.innerText = `Speicherplatz auf Laufwerk ${driveLetter}:\\\\: \${formatBytes(freeBytes)} frei von \${formatBytes(totalBytes)}`;
              return;
            }
          }
        }
      }
      diskTextEl.innerText = `Laufwerk ${driveLetter}:\\\\ ausgewählt`;
    });
  } else {
    diskTextEl.innerText = "";
  }
}

async function scanDirectory(dirPath, onFileFound, onStatusUpdate, depth = 0) {
  if (depth > 20) return;
  
  // Game path filtering if checked
  const filterGames = document.getElementById("mfOptFilterGames") && document.getElementById("mfOptFilterGames").checked;
  if (filterGames) {
    const pathLower = dirPath.toLowerCase();
    const gameKeywords = ['steam', 'steamlibrary', 'steamapps', 'epic games', 'gog', 'riot games', 'ubisoft', 'battle.net', 'origin', 'uplay', 'unity', 'unreal'];
    if (gameKeywords.some(kw => pathLower.includes(kw))) {
      return; // Skip this directory entirely!
    }
  }
  
  scannedDirectoriesCount++;
  if (scannedDirectoriesCount % 50 === 0) {
    onStatusUpdate(dirPath);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  let files;
  try {
    files = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return;
  }
  
  for (const file of files) {
    if (!isScanningActive) return;
    
    const nameLower = file.name.toLowerCase();
    if (file.isDirectory()) {
      if (IGNORED_FOLDERS.has(nameLower) || file.name.startsWith('.') || file.name.startsWith('$')) {
        continue;
      }
      const subPath = path.join(dirPath, file.name);
      await scanDirectory(subPath, onFileFound, onStatusUpdate, depth + 1);
    } else if (file.isFile()) {
      const ext = path.extname(file.name).toLowerCase();
      const wantVideos = !document.getElementById("mfFilterVideos") || document.getElementById("mfFilterVideos").checked;
      const wantAudio = Boolean(document.getElementById("mfFilterAudio") && document.getElementById("mfFilterAudio").checked);
      const wantImages = Boolean(document.getElementById("mfFilterImages") && document.getElementById("mfFilterImages").checked);

      const isVid = wantVideos && VIDEO_EXTS.has(ext);
      const isAud = wantAudio && AUDIO_EXTS.has(ext);
      const isImg = wantImages && IMAGE_EXTS.has(ext);

      if (isVid || isAud || isImg) {
        const filePath = path.join(dirPath, file.name);
        
        // File size filtering for games/system sound assets
        if (filterGames) {
          try {
            const size = typeof file.size === "number" ? file.size : fs.statSync(filePath).size;
            if (isAud && size < 512000) continue; // Skip audio < 500KB
            if (isVid && size < 1048576) continue; // Skip video < 1MB
            if (isImg && size < 5120) continue; // Skip tiny system icons < 5KB
          } catch(e) {
            continue; // Skip if we can't read stats
          }
        }
        
        const fType = isAud ? 'music' : (isImg ? 'image' : 'video');
        onFileFound({
          name: file.name,
          path: filePath,
          dir: dirPath,
          type: fType
        });
      }
    }
  }
}

const mfDriveCache = new Map();
let mfRenderLimit = 200;

function getMfCacheKey(driveLetter) {
  const v = !document.getElementById("mfFilterVideos") || document.getElementById("mfFilterVideos").checked ? "V" : "";
  const a = document.getElementById("mfFilterAudio") && document.getElementById("mfFilterAudio").checked ? "A" : "";
  const i = document.getElementById("mfFilterImages") && document.getElementById("mfFilterImages").checked ? "I" : "";
  const g = document.getElementById("mfOptFilterGames") && document.getElementById("mfOptFilterGames").checked ? "G" : "";
  return `${String(driveLetter).toUpperCase()}_${v}${a}${i}${g}`;
}

async function startMediaScan(forceRefresh = false) {
  if (isScanningActive) {
    cancelMediaScan();
    return;
  }
  
  const selectedDrive = mfActiveDrive.toUpperCase();
  const rootPath = mfActiveDrive.length === 1 ? `${mfActiveDrive}:\\` : mfActiveDrive;
  const cacheKey = getMfCacheKey(selectedDrive);
  mfRenderLimit = 200;
  
  updateDiskSpaceInfo(selectedDrive);
  document.getElementById("mfScanBtn").disabled = false;

  // Wenn das Laufwerk bereits in dieser Session gescannt wurde, sofort ohne Neuladen anzeigen!
  if (!forceRefresh && mfDriveCache.has(cacheKey)) {
    foundMediaFiles = mfDriveCache.get(cacheKey);
    const statusText = document.getElementById("mfStatusText");
    if (statusText) statusText.innerText = "Zwischengespeichert (Sofort geladen)";
    const detailText = document.getElementById("mfDetailText");
    if (detailText) detailText.innerText = `${foundMediaFiles.length} Mediendateien auf ${rootPath} (aus Cache).`;
    renderMediaFinderResults();
    updateMfImportButtonCount();
    return;
  }
  
  isScanningActive = true;
  foundMediaFiles = [];
  scannedDirectoriesCount = 0;
  updateMfImportButtonCount();
  
  const scanBtn = document.getElementById("mfScanBtn");
  scanBtn.innerText = "Abbrechen";
  scanBtn.style.background = "#ff4444";
  scanBtn.style.color = "#fff";
  
  const statusText = document.getElementById("mfStatusText");
  statusText.innerText = "Suche läuft...";
  
  const resultsContainer = document.getElementById("mfResultsList");
  resultsContainer.style.display = "flex";
  resultsContainer.style.flexDirection = "column";
  resultsContainer.innerHTML = `
    <div style="text-align: center; margin-top: 50px;">
      <div class="record spin" style="width: 40px; height: 40px; margin: 0 auto 15px auto;"></div>
      <p style="color: var(--text-muted); font-size: 13px;">Scanne Verzeichnisse. Bitte warten...</p>
    </div>
  `;
  
  let lastUiUpdate = 0;
  let scanCompletedNormally = true;
  try {
    await scanDirectory(
      rootPath, 
      (fileObj) => {
        foundMediaFiles.push(fileObj);
        const now = Date.now();
        if (now - lastUiUpdate > 150) {
          lastUiUpdate = now;
          document.getElementById("mfDetailText").innerText = `${foundMediaFiles.length} Mediendateien gefunden...`;
        }
        
        if (mfMode === 'move_select' && mfSubMode === 'auto') {
          checkedMfPaths.add(fileObj.path);
        }
      },
      (currentDir) => {
        document.getElementById("mfStatusText").innerText = `Scanne: ${path.basename(currentDir) || currentDir}`;
      }
    );
  } catch (err) {
    scanCompletedNormally = false;
    console.error("Scan failed:", err);
  }

  const wasCancelled = !isScanningActive;
  isScanningActive = false;
  scanBtn.innerText = "Aktualisieren";
  scanBtn.style.background = "rgba(255, 255, 255, 0.08)";
  scanBtn.style.color = "#fff";

  if (!wasCancelled && scanCompletedNormally) {
    mfDriveCache.set(cacheKey, foundMediaFiles);
    statusText.innerText = "Suche abgeschlossen";
    document.getElementById("mfDetailText").innerText = `${foundMediaFiles.length} Mediendateien auf ${rootPath} gefunden.`;
  }
  
  renderMediaFinderResults();
  updateMfImportButtonCount();
}

function cancelMediaScan() {
  if (isScanningActive) {
    isScanningActive = false;
    const scanBtn = document.getElementById("mfScanBtn");
    if (scanBtn) {
      scanBtn.innerText = "Aktualisieren";
      scanBtn.style.background = "rgba(255, 255, 255, 0.08)";
      scanBtn.style.color = "#fff";
    }
    const statusText = document.getElementById("mfStatusText");
    if (statusText) statusText.innerText = "Suche abgebrochen";
  }
}

window.restartMediaFinderScan = function() {
  mfRenderLimit = 200;
  cancelMediaScan();
  setTimeout(() => startMediaScan(false), 30);
};

function onMfSearchInput() {
  const input = document.getElementById("mfSearchInput");
  if (input) {
    mfSearchQuery = input.value;
    renderMediaFinderResults();
  }
}

function switchMfTab(tab) {
  mfActiveTab = tab;
  document.getElementById("mfTabAll").classList.toggle("active", tab === 'all');
  document.getElementById("mfTabFolders").classList.toggle("active", tab === 'folders');
  renderMediaFinderResults();
}

function onMfCheckboxChange(filePath, checked) {
  if (checked) {
    checkedMfPaths.add(filePath);
  } else {
    checkedMfPaths.delete(filePath);
  }
  updateMfImportButtonCount();
}

function toggleMfFolderAll(folderId, isChecked) {
  const container = document.getElementById(folderId);
  if (container) {
    const checkboxes = container.querySelectorAll(".mf-file-checkbox");
    checkboxes.forEach(cb => {
      cb.checked = isChecked;
      const path = cb.getAttribute("data-path");
      if (isChecked) {
        checkedMfPaths.add(path);
      } else {
        checkedMfPaths.delete(path);
      }
    });
  }
  updateMfImportButtonCount();
}

function toggleMfFolderExpand(folderId) {
  const el = document.getElementById(folderId);
  if (el) {
    if (el.style.display === "none") {
      el.style.display = "flex";
    } else {
      el.style.display = "none";
    }
  }
}

function updateMfImportButtonCount() {
  const btn = document.getElementById("mfImportBtn");
  if (btn) {
    let totalSize = 0;
    checkedMfPaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          totalSize += fs.statSync(filePath).size;
        }
      } catch(e) {}
    });
    
    btn.disabled = checkedMfPaths.size === 0;
    const actionText = mfMode === 'link' ? 'verknüpfen' : 'importieren';
    const sizeStr = checkedMfPaths.size > 0 ? ` - ${formatBytes(totalSize)}` : "";
    btn.innerText = `Ausgewählte ${actionText} (${checkedMfPaths.size})${sizeStr}`;
  }
}

function toggleAllMfSelections(isChecked) {
  const query = (mfSearchQuery || "").trim().toLowerCase();
  const filtered = foundMediaFiles.filter(file => {
    if (!query) return true;
    return file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query);
  });
  
  filtered.forEach(file => {
    if (isChecked) {
      checkedMfPaths.add(file.path);
    } else {
      checkedMfPaths.delete(file.path);
    }
  });
  
  const checkboxes = document.querySelectorAll("#mfResultsList .mf-file-checkbox");
  checkboxes.forEach(cb => {
    const p = cb.getAttribute("data-path");
    cb.checked = checkedMfPaths.has(p);
  });
  
  if (mfActiveTab === 'folders') {
    const folderCheckboxes = document.querySelectorAll("#mfResultsList input[id^='mf-chk-folder-']");
    folderCheckboxes.forEach(cb => {
      cb.checked = isChecked;
    });
  }
  
  updateMfImportButtonCount();
}

function linkFolder(folderPath) {
  let folders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
  if (!folders.includes(folderPath)) {
    folders.push(folderPath);
    localStorage.setItem("libraryFolders", JSON.stringify(folders));
    alert(`Ordner erfolgreich verknüpft: ${folderPath}`);
    
    loadMusic();
    loadVideos();
    
    closeMediaFinder();
  } else {
    alert(`Dieser Ordner ist bereits verknüpft.`);
  }
}

function toggleBlockPath(pathStr) {
  let list = JSON.parse(localStorage.getItem("blockedMediaPaths") || "[]");
  if (list.includes(pathStr)) {
    list = list.filter(p => p !== pathStr);
  } else {
    list.push(pathStr);
  }
  localStorage.setItem("blockedMediaPaths", JSON.stringify(list));
  
  // Uncheck any files inside this blocked folder
  const queryFiltered = foundMediaFiles.filter(file => {
    return file.dir === pathStr || file.path === pathStr || file.path.startsWith(pathStr + path.sep);
  });
  queryFiltered.forEach(file => {
    checkedMfPaths.delete(file.path);
  });
  
  renderMediaFinderResults();
  updateMfImportButtonCount();
}

let mfSelectedExts = new Set();
let mfCustomExtQuery = "";

function syncMfExtChipsUI() {
  const chips = document.querySelectorAll("#mfExtFilterBar .mf-ext-chip");
  const isAll = mfSelectedExts.size === 0;
  chips.forEach((chip) => {
    const extsAttr = chip.getAttribute("data-exts") || "";
    if (extsAttr === "all") {
      chip.classList.toggle("active", isAll);
    } else {
      const list = extsAttr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const active = list.length > 0 && list.every(ext => mfSelectedExts.has(ext));
      chip.classList.toggle("active", active);
    }
  });
}

window.toggleMfExtChip = function(extsStr, btnEl) {
  if (!extsStr || extsStr === "all") {
    mfSelectedExts.clear();
    syncMfExtChipsUI();
    mfRenderLimit = 200;
    renderMediaFinderResults();
    return;
  }

  const list = extsStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const allAlreadySelected = list.every(ext => mfSelectedExts.has(ext));
  if (allAlreadySelected) {
    list.forEach(ext => mfSelectedExts.delete(ext));
  } else {
    list.forEach(ext => mfSelectedExts.add(ext));
  }
  syncMfExtChipsUI();

  const kind = btnEl ? (btnEl.getAttribute("data-kind") || "") : "";
  let needRescan = false;
  if (!allAlreadySelected) {
    if (kind === "video") {
      const cb = document.getElementById("mfFilterVideos");
      if (cb && !cb.checked) { cb.checked = true; needRescan = true; }
    } else if (kind === "audio") {
      const cb = document.getElementById("mfFilterAudio");
      if (cb && !cb.checked) { cb.checked = true; needRescan = true; }
    } else if (kind === "image") {
      const cb = document.getElementById("mfFilterImages");
      if (cb && !cb.checked) { cb.checked = true; needRescan = true; }
    }
  }

  mfRenderLimit = 200;
  if (needRescan) {
    restartMediaFinderScan();
  } else {
    renderMediaFinderResults();
  }
};

window.onMfCustomExtInput = function(val) {
  mfCustomExtQuery = String(val || "").trim().toLowerCase();
  mfRenderLimit = 200;
  renderMediaFinderResults();
};

function matchesMfExtFilter(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (mfSelectedExts.size > 0 && !mfSelectedExts.has(ext)) {
    return false;
  }
  if (mfCustomExtQuery) {
    const tokens = mfCustomExtQuery
      .split(/[\s,;]+/)
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => (t.startsWith(".") ? t : "." + t));
    if (tokens.length > 0 && !tokens.some(tok => ext === tok || ext.startsWith(tok))) {
      return false;
    }
  }
  return true;
}

function renderMediaFinderResults() {
  const container = document.getElementById("mfResultsList");
  container.innerHTML = "";
  
  const query = (mfSearchQuery || "").trim().toLowerCase();
  
  const queryFiltered = foundMediaFiles.filter(file => {
    if (!matchesMfExtFilter(file.path)) return false;
    if (!query) return true;
    return file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query);
  });

  const blockedList = JSON.parse(localStorage.getItem("blockedMediaPaths") || "[]");
  const libraryFolders = JSON.parse(localStorage.getItem("libraryFolders") || "[]");
  function isPathBlocked(p) {
    return blockedList.some(bp => p === bp || p.startsWith(bp + path.sep));
  }

  const deduplicate = document.getElementById("mfOptDeduplicate") && document.getElementById("mfOptDeduplicate").checked;

  if (mfActiveTab === 'all') {
    container.style.display = "grid";
    container.style.gridTemplateColumns = "repeat(auto-fill, minmax(130px, 1fr))";
    container.style.gap = "12px";
    
    // Completely hide blocked paths in All Files view
    let filtered = queryFiltered.filter(file => !isPathBlocked(file.path));

    let processedFiles = [];
    if (deduplicate) {
      const seenFiles = new Map();
      filtered.forEach(file => {
        let size = 0;
        try { size = fs.statSync(file.path).size; } catch(e) {}
        const key = `${file.name.toLowerCase()}_${size}`;
        if (!seenFiles.has(key)) {
          seenFiles.set(key, file);
          processedFiles.push(file);
        }
      });
    } else {
      processedFiles = filtered;
    }

    processedFiles.sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById("mfCountText").innerText = `${processedFiles.length} Dateien gefunden`;
    
    const limit = typeof mfRenderLimit === "number" ? mfRenderLimit : 200;
    const visibleFiles = processedFiles.slice(0, limit);
    visibleFiles.forEach(file => {
      const key = toMediaKey(file.path);
      const isChecked = checkedMfPaths.has(file.path);
      const isCheckedHtml = isChecked ? "checked" : "";
      
      const checkboxHtml = `
        <div style="position: absolute; top: 8px; right: 8px; z-index: 10; background: rgba(0,0,0,0.6); border-radius: 4px; padding: 2px; line-height: 0;">
          <input type="checkbox" class="mf-file-checkbox" data-path="${file.path}" data-type="${file.type}" style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent);" ${isCheckedHtml} onchange="onMfCheckboxChange('${file.path.replace(/\\/g, '\\\\')}', this.checked); event.stopPropagation();">
        </div>
      `;
      
      const displayTag = file.type === 'music' ? 'Musik' : (file.type === 'image' ? 'Bild' : 'Video');
      const extUpper = path.extname(file.name).replace(/^\./, "").toUpperCase();
      const fullBadge = extUpper ? `${displayTag} · ${extUpper}` : displayTag;
      const card = document.createElement("div");
      card.className = `mediaCard ${file.type}`;
      card.style.position = "relative";
      card.style.minHeight = file.type === 'music' ? '90px' : 'auto';
      
      const thumbPreviewHtml = file.type === 'image'
        ? `<img class="mediaThumb staticThumb" src="${pathToFileURL(file.path).href}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; margin-bottom: 10px; aspect-ratio: 16 / 9;">`
        : getMediaThumbHtml(key, file.type);

      card.innerHTML = `
        ${checkboxHtml}
        <div class="mediaBadge" style="pointer-events: none;">${fullBadge}</div>
        ${thumbPreviewHtml}
        <div class="mediaTitle" title="${file.name}">${file.name.replace(/\.[^/.]+$/, "")}</div>
      `;
      
      setupMediaThumbListeners(card, key, file.type);
      
      card.onclick = (e) => {
        if (e.target.tagName.toLowerCase() === 'input') return;
        const cb = card.querySelector('.mf-file-checkbox');
        if (cb) {
          cb.checked = !cb.checked;
          onMfCheckboxChange(file.path, cb.checked);
        }
      };
      
      container.appendChild(card);
    });

    if (processedFiles.length > limit) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "pillBtn";
      moreBtn.style.cssText = "grid-column: 1 / -1; margin: 12px auto; padding: 8px 20px; font-weight: bold;";
      moreBtn.innerText = `Mehr anzeigen (${processedFiles.length - limit} weitere)`;
      moreBtn.onclick = () => {
        mfRenderLimit = limit + 200;
        renderMediaFinderResults();
      };
      container.appendChild(moreBtn);
    }
  } else {
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "10px";
    
    const foldersMap = {};
    queryFiltered.forEach(file => {
      if (!foldersMap[file.dir]) {
        foldersMap[file.dir] = [];
      }
      foldersMap[file.dir].push(file);
    });
    
    let foldersList = Object.keys(foldersMap).sort((a, b) => a.localeCompare(b));
    
    // Sort blocked folders to the bottom
    const unblockedFolders = [];
    const blockedFolders = [];
    foldersList.forEach(folder => {
      if (blockedList.includes(folder)) {
        blockedFolders.push(folder);
      } else {
        unblockedFolders.push(folder);
      }
    });
    foldersList = [...unblockedFolders, ...blockedFolders];
    document.getElementById("mfCountText").innerText = `${foldersList.length} Ordner gefunden`;
    
    foldersList.forEach((folder, folderIdx) => {
      const files = foldersMap[folder];
      const folderId = `mf-folder-files-${folderIdx}`;
      const isBlocked = blockedList.includes(folder);
      
      const groupDiv = document.createElement("div");
      groupDiv.className = "mf-folder-group" + (isBlocked ? " blocked-folder" : "");
      groupDiv.style.background = isBlocked ? "rgba(255,255,255,0.005)" : "rgba(255,255,255,0.02)";
      groupDiv.style.border = isBlocked ? "1px solid rgba(255,255,255,0.02)" : "1px solid rgba(255,255,255,0.05)";
      groupDiv.style.opacity = isBlocked ? "0.35" : "1";
      groupDiv.style.borderRadius = "8px";
      groupDiv.style.padding = "8px 12px";
      
      let processedFiles = [];
      if (deduplicate) {
        const seenFiles = new Map();
        files.forEach(file => {
          let size = 0;
          try { size = fs.statSync(file.path).size; } catch(e) {}
          const key = `${file.name.toLowerCase()}_${size}`;
          if (!seenFiles.has(key)) {
            seenFiles.set(key, file);
            processedFiles.push(file);
          }
        });
      } else {
        processedFiles = files;
      }
      
      const checkedInFolderCount = processedFiles.filter(f => checkedMfPaths.has(f.path)).length;
      const allChecked = processedFiles.length > 0 && checkedInFolderCount === processedFiles.length;
      
      const isAlreadyLinked = libraryFolders.includes(folder);
      const linkedBadge = isAlreadyLinked 
        ? `<span style="background: rgba(29, 185, 84, 0.2); color: var(--accent); font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; margin-right: 8px;">Bereits verknüpft</span>`
        : '';
      
      const linkBtnHtml = mfMode === 'link' && !isBlocked && !isAlreadyLinked
        ? `<button onclick="linkFolder('${folder.replace(/\\/g, '\\\\')}'); event.stopPropagation();" style="background: var(--accent); color: black; border: none; padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; cursor: pointer; transition: 0.2s; margin-right: 10px;">Ordner verknüpfen</button>`
        : '';
        
      const blockBtnText = isBlocked ? "✓ Reaktivieren" : "✕ Ignorieren";
      const blockBtnColor = isBlocked ? "#dda16e" : "#ff4444";
      const blockBtnHtml = `<button onclick="toggleBlockPath('${folder.replace(/\\/g, '\\\\')}'); event.stopPropagation();" style="background: none; border: 1px solid ${blockBtnColor}; color: ${blockBtnColor}; padding: 3px 6px; border-radius: 4px; font-size: 9px; font-weight: bold; cursor: pointer; transition: 0.2s; margin-right: 10px;">${blockBtnText}</button>`;
        
      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
      header.style.paddingBottom = "6px";
      header.style.marginBottom = "6px";
      header.style.cursor = "pointer";
      
      header.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
          <svg class="folder-icon" viewBox="0 0 24 24" width="16" height="16" fill="var(--folder-color, #dda16e)" style="flex-shrink: 0; vertical-align: middle; margin-right: 4px; display: inline-block;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span style="font-weight: bold; color: #fff; font-size: 13px;" class="truncate" title="${folder}">${path.basename(folder) || folder}</span>
          <span style="font-size: 10px; color: var(--text-muted); cursor: help;" class="truncate" title="${folder}">(${folder})</span>
          ${linkedBadge}
        </div>
        <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;" onclick="event.stopPropagation();">
          ${blockBtnHtml}
          ${linkBtnHtml}
          <span style="font-size: 11px; color: var(--text-muted);">${processedFiles.length} Dateien</span>
          <input type="checkbox" id="mf-chk-folder-${folderIdx}" style="cursor: pointer; accent-color: var(--accent);" ${allChecked ? 'checked' : ''} ${isBlocked ? 'disabled' : ''} onchange="toggleMfFolderAll('${folderId}', this.checked)">
        </div>
      `;
      
      header.onclick = () => toggleMfFolderExpand(folderId);
      
      const filesContainer = document.createElement("div");
      filesContainer.id = folderId;
      filesContainer.style.display = "none";
      filesContainer.style.flexDirection = "column";
      filesContainer.style.gap = "4px";
      filesContainer.style.paddingLeft = "10px";
      
      processedFiles.forEach(file => {
        const isFileChecked = checkedMfPaths.has(file.path);
        
        const label = document.createElement("label");
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.justifyContent = "space-between";
        label.style.fontSize = "12px";
        label.style.color = "var(--text-muted)";
        label.style.cursor = isBlocked ? "not-allowed" : "pointer";
        label.style.padding = "4px 6px";
        label.style.borderRadius = "4px";
        label.style.transition = "background 0.2s";
        
        if (!isBlocked) {
          label.onmouseenter = () => { label.style.background = "rgba(255,255,255,0.03)"; };
          label.onmouseleave = () => { label.style.background = "none"; };
        }
        
        let thumbHtml = "";
        if (file.type === "video") {
          const cachedMfThumb = (typeof ThumbnailPreloader !== "undefined" && ThumbnailPreloader.hasThumb(file.path))
            ? ThumbnailPreloader.getThumbPath(file.path)
            : null;
          if (cachedMfThumb && fs.existsSync(cachedMfThumb)) {
            thumbHtml = `<img src="${pathToFileURL(cachedMfThumb).href}" loading="lazy" style="width: 48px; height: 27px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); margin-right: 4px; aspect-ratio: 16/9;">`;
          } else {
            thumbHtml = `<span style="font-size: 14px; width: 48px; display: inline-flex; justify-content: center; flex-shrink: 0;">🎬</span>`;
          }
        } else if (file.type === "image") {
          thumbHtml = `<img src="${pathToFileURL(file.path).href}" loading="lazy" style="width: 48px; height: 27px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); margin-right: 4px; aspect-ratio: 16/9;">`;
        } else {
          thumbHtml = `<span style="font-size: 14px; width: 48px; display: inline-flex; justify-content: center; flex-shrink: 0;">🎵</span>`;
        }
        
        label.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
            ${thumbHtml}
            <span class="truncate" style="max-width: 400px;" title="${file.name}">${file.name}</span>
          </div>
          <input type="checkbox" class="mf-file-checkbox" data-path="${file.path}" data-type="${file.type}" style="cursor: pointer; accent-color: var(--accent); flex-shrink: 0;" ${isFileChecked ? 'checked' : ''} ${isBlocked ? 'disabled' : ''} onchange="onMfCheckboxChange('${file.path.replace(/\\/g, '\\\\')}', this.checked)">
        `;
        
        filesContainer.appendChild(label);
      });
      
      groupDiv.appendChild(header);
      groupDiv.appendChild(filesContainer);
      container.appendChild(groupDiv);
    });
  }
}

function importSelectedMfFiles() {
  if (checkedMfPaths.size === 0) return;
  
  const appDrive = (path.parse(mediaBase).root[0] || "C").toUpperCase();
  const selectedDrive = (mfActiveDrive || appDrive).toUpperCase();
  const isCrossDrive = selectedDrive !== appDrive;
  
  let count = 0;
  const mkvToConvert = [];
  
  if (mfMode === 'link') {
    let libraryFiles = JSON.parse(localStorage.getItem("libraryFiles") || "[]");
    checkedMfPaths.forEach(filePath => {
      if (fs.existsSync(filePath)) {
        if (filePath.toLowerCase().endsWith(".mkv") && !filePath.includes("_FEHLER")) {
          mkvToConvert.push(filePath);
        }
        if (!libraryFiles.includes(filePath)) {
          libraryFiles.push(filePath);
          count++;
        }
      }
    });
    localStorage.setItem("libraryFiles", JSON.stringify(libraryFiles));
    if (typeof showVideoToast === "function") showVideoToast(`✅ ${count} Datei(en) verknüpft!`);
  } else {
    if (!fs.existsSync(musicFolder)) fs.mkdirSync(musicFolder, { recursive: true });
    if (!fs.existsSync(videoFolder)) fs.mkdirSync(videoFolder, { recursive: true });
    if (!fs.existsSync(logoFolder)) fs.mkdirSync(logoFolder, { recursive: true });
    
    checkedMfPaths.forEach(filePath => {
      if (!fs.existsSync(filePath)) return;
      
      const ext = path.extname(filePath).toLowerCase();
      const type = AUDIO_EXTS.has(ext) ? 'music' : (IMAGE_EXTS.has(ext) ? 'image' : 'video');
      const destFolder = type === 'music' ? musicFolder : (type === 'image' ? logoFolder : videoFolder);
      const destPath = getUniqueDestPath(destFolder, path.basename(filePath));
      
      try {
        if (isCrossDrive) {
          fs.copyFileSync(filePath, destPath);
        } else {
          try {
            fs.renameSync(filePath, destPath);
          } catch (renameErr) {
            fs.copyFileSync(filePath, destPath);
          }
        }
        if (destPath.toLowerCase().endsWith(".mkv") && !destPath.includes("_FEHLER")) {
          mkvToConvert.push(destPath);
        }
        count++;
      } catch (err) {
        console.error(`Fehler beim Importieren von ${filePath}:`, err);
      }
    });
    
    const actionWord = isCrossDrive ? "in die App kopiert" : "verschoben";
    if (typeof showVideoToast === "function") showVideoToast(`✅ ${count} Datei(en) erfolgreich ${actionWord}!`);
  }
  
  closeMediaFinder();
  loadMusic();
  loadVideos();
  if (typeof renderLogosGrid === "function") renderLogosGrid();
  if (mkvToConvert.length > 0 && typeof enqueueMkvConversions === "function") {
    enqueueMkvConversions(mkvToConvert);
  }
  if (typeof ThumbnailPreloader !== "undefined") {
    ThumbnailPreloader.preloadAllThumbnailsPermanently().catch(() => {});
  }
}

window.openMediaFinder = openMediaFinder;
window.closeMediaFinder = closeMediaFinder;
window.startMediaScan = startMediaScan;
window.toggleAllMfSelections = toggleAllMfSelections;
window.importSelectedMfFiles = importSelectedMfFiles;
window.toggleMfFolderExpand = toggleMfFolderExpand;
window.toggleMfFolderAll = toggleMfFolderAll;
window.updateMfImportButtonCount = updateMfImportButtonCount;
window.selectMfSearchType = selectMfSearchType;
window.selectMfImportMethod = selectMfImportMethod;
window.confirmMfWarning = confirmMfWarning;
window.cancelMfWarning = cancelMfWarning;
window.goBackToMfMode = goBackToMfMode;
window.switchMfTab = switchMfTab;
window.onMfCheckboxChange = onMfCheckboxChange;
window.linkFolder = linkFolder;

// ============================================================
// VLC REDESIGN & COLLAPSIBLE SIDEBAR SYSTEM
// ============================================================

// --- 1. COLLAPSIBLE SIDEBAR ---
function initMainSidebar() {
  const isCollapsed = localStorage.getItem("mainSidebarCollapsed") === "true";
  const sidebar = document.getElementById("mainSidebar");
  const app = document.querySelector(".app");
  if (isCollapsed) {
    sidebar?.classList.add("collapsed");
    app?.classList.add("sidebar-collapsed");
  }

  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if (toggleBtn) {
    toggleBtn.title = isCollapsed ? "Sidebar ausklappen (Ctrl+B)" : "Sidebar einklappen (Ctrl+B)";
    toggleBtn.addEventListener("click", () => {
      toggleMainSidebar();
    });
  }
}

function toggleMainSidebar() {
  const sidebar = document.getElementById("mainSidebar");
  const app = document.querySelector(".app");
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if (!sidebar) return;

  const willCollapse = !sidebar.classList.contains("collapsed");
  sidebar.classList.toggle("collapsed", willCollapse);
  app?.classList.toggle("sidebar-collapsed", willCollapse);
  localStorage.setItem("mainSidebarCollapsed", willCollapse ? "true" : "false");
  if (toggleBtn) {
    toggleBtn.title = willCollapse ? "Sidebar ausklappen (Ctrl+B)" : "Sidebar einklappen (Ctrl+B)";
  }
}
window.toggleMainSidebar = toggleMainSidebar;

// --- 1.5 BACKGROUND TASK MANAGER (LOADER & 3-SECOND HOVER POPOVER) ---
const BgTaskManager = {
  hoverTimer: null,
  isHovering: false,

  init() {
    const container = document.getElementById("bgTaskIndicatorContainer");
    const popover = document.getElementById("bgTaskPopover");
    if (!container) return;

    container.addEventListener("mouseenter", () => {
      this.isHovering = true;
      if (!this.hasActiveTasks()) return;

      // Pop over only when sustained hover lasts ~3 seconds
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => {
        if (this.isHovering && this.hasActiveTasks()) {
          this.showPopover();
        }
      }, 3000);
    });

    container.addEventListener("mouseleave", () => {
      this.isHovering = false;
      clearTimeout(this.hoverTimer);
      setTimeout(() => {
        if (!this.isHovering) this.hidePopover();
      }, 300);
    });

    if (popover) {
      popover.addEventListener("mouseenter", () => {
        this.isHovering = true;
      });
      popover.addEventListener("mouseleave", () => {
        this.isHovering = false;
        setTimeout(() => {
          if (!this.isHovering) this.hidePopover();
        }, 300);
      });
    }

    this.update();
  },

  hasActiveTasks() {
    const isThumb = typeof ThumbnailPreloader !== "undefined" && ThumbnailPreloader.isRunning && (ThumbnailPreloader.total || 0) > 0 && (ThumbnailPreloader.completed || 0) < ThumbnailPreloader.total;
    const isConv = (typeof isConverting !== "undefined" && isConverting) || (typeof conversionQueue !== "undefined" && conversionQueue.length > 0);
    return isThumb || isConv;
  },

  update() {
    const container = document.getElementById("bgTaskIndicatorContainer");
    const badge = document.getElementById("bgTaskBadge");
    if (!container) return;

    const active = this.hasActiveTasks();
    if (active) {
      container.classList.remove("hidden");
      container.style.display = "inline-flex";

      let count = 0;
      if (typeof ThumbnailPreloader !== "undefined" && ThumbnailPreloader.isRunning) {
        count += ((ThumbnailPreloader.total || 0) - (ThumbnailPreloader.completed || 0));
      }
      if (typeof conversionQueue !== "undefined") {
        count += conversionQueue.length + (typeof isConverting !== "undefined" && isConverting ? 1 : 0);
      }

      if (badge) {
        if (count > 1) {
          badge.textContent = count > 99 ? "99+" : count;
          badge.style.display = "block";
        } else {
          badge.style.display = "none";
        }
      }

      const popover = document.getElementById("bgTaskPopover");
      if (popover && !popover.classList.contains("hidden")) {
        this.renderPopoverContent();
      }
    } else {
      container.classList.add("hidden");
      container.style.display = "none";
      this.hidePopover();
    }
  },

  showPopover() {
    const popover = document.getElementById("bgTaskPopover");
    if (!popover || !this.hasActiveTasks()) return;
    this.renderPopoverContent();
    popover.classList.remove("hidden");
    popover.style.display = "block";
  },

  hidePopover() {
    const popover = document.getElementById("bgTaskPopover");
    if (!popover) return;
    popover.classList.add("hidden");
    popover.style.display = "none";
  },

  renderPopoverContent() {
    const body = document.getElementById("bgTaskPopoverContent");
    if (!body) return;

    let itemsHtml = "";

    // 1. Thumbnail Generator Status
    if (typeof ThumbnailPreloader !== "undefined" && ThumbnailPreloader.isRunning) {
      const comp = ThumbnailPreloader.completed || 0;
      const tot = ThumbnailPreloader.total || 0;
      const pct = tot > 0 ? Math.round((comp / tot) * 100) : 0;
      itemsHtml += `
        <div class="bg-task-item">
          <div class="bg-task-item-header">
            <span>⚡ Medien-Thumbnails werden vorbereitet</span>
            <span class="bg-task-item-count">${comp} / ${tot}</span>
          </div>
          <div class="bg-task-progress-track">
            <div class="bg-task-progress-bar" style="width: ${pct}%"></div>
          </div>
          <div class="bg-task-item-sub">Vorschaubilder für flüssiges Scrollen werden gecacht (${pct}%)</div>
        </div>
      `;
    }

    // 2. Conversion Status
    const isConv = typeof isConverting !== "undefined" && isConverting;
    const qLen = typeof conversionQueue !== "undefined" ? conversionQueue.length : 0;
    if (isConv || qLen > 0) {
      const activeFile = typeof currentConvData !== "undefined" && currentConvData && currentConvData.file ? currentConvData.file : "Video-Datei";
      const convPct = typeof currentConvData !== "undefined" && currentConvData && typeof currentConvData.progress === "number" ? Math.round(currentConvData.progress) : 0;
      itemsHtml += `
        <div class="bg-task-item">
          <div class="bg-task-item-header">
            <span>🔄 Video-Konvertierung aktiv</span>
            <span class="bg-task-item-count">${qLen > 0 ? qLen + ' in Warteschlange' : 'Aktiv'}</span>
          </div>
          <div class="bg-task-progress-track">
            <div class="bg-task-progress-bar" style="width: ${convPct}%"></div>
          </div>
          <div class="bg-task-item-sub">${activeFile} (${convPct}%)</div>
        </div>
      `;
    }

    if (!itemsHtml) {
      itemsHtml = `<div class="bg-task-empty">Keine laufenden Hintergrundaufgaben</div>`;
    }

    body.innerHTML = itemsHtml;
  }
};
window.BgTaskManager = BgTaskManager;

// --- 2. SCRUBBER HOVER PREVIEW ---
function initScrubberHoverPreview() {
  const bar = document.getElementById("progressBar");
  const badge = document.getElementById("scrubberHoverBadge");
  const timeEl = document.getElementById("scrubberHoverTime");
  const canvasEl = document.getElementById("scrubberHoverCanvas");
  if (!bar || !badge) return;

  let previewVideo = null;
  let isSeeking = false;

  bar.addEventListener("pointermove", (e) => {
    const activePlayer = activeType === "video" ? videoPlayer : player;
    if (!activePlayer.duration) return;

    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const hoverTime = ratio * activePlayer.duration;

    const xPos = Math.max(25, Math.min(rect.width - 25, e.clientX - rect.left));
    badge.style.left = `${xPos}px`;
    badge.classList.remove("hidden");
    if (timeEl) timeEl.innerText = formatTime(hoverTime);

    // If video is active and has source, render preview snapshot to canvas (skip heavy MKV/TS/AVI seeks)
    const rawPreviewPath = (videoPlayer && videoPlayer.src) ? resolveRawVideoFilePath(videoPlayer.src) : "";
    if (activeType === "video" && videoPlayer && videoPlayer.src && canvasEl && !/\.(mkv|ts|m2ts|avi|flv|wmv)$/i.test(rawPreviewPath)) {
      canvasEl.classList.remove("hidden");
      if (!previewVideo) {
        previewVideo = document.createElement("video");
        previewVideo.muted = true;
        previewVideo.preload = "auto";
      }
      if (previewVideo.src !== videoPlayer.src) {
        previewVideo.src = videoPlayer.src;
      }
      if (!isSeeking && Math.abs(previewVideo.currentTime - hoverTime) > 0.4) {
        isSeeking = true;
        previewVideo.currentTime = hoverTime;
        previewVideo.onseeked = () => {
          isSeeking = false;
          try {
            const ctx = canvasEl.getContext("2d");
            ctx.drawImage(previewVideo, 0, 0, canvasEl.width, canvasEl.height);
          } catch (err) {}
        };
      }
    } else if (canvasEl) {
      canvasEl.classList.add("hidden");
    }
  });

  bar.addEventListener("pointerleave", () => {
    badge.classList.add("hidden");
  });
}

// --- 3. A-B LOOP REPEAT ---
let abLoop = { a: null, b: null, active: false };

window.toggleAbLoop = function() {
  const activePlayer = activeType === "video" ? videoPlayer : player;
  if (!activePlayer.duration) {
    showVideoToast("⚠️ Bitte zuerst ein Medium abspielen");
    return;
  }

  const btn = document.getElementById("abLoopBtn");
  const txt = document.getElementById("abLoopText");
  const highlight = document.getElementById("abLoopTrackHighlight");

  if (abLoop.a === null) {
    // 1st click: set Point A
    abLoop.a = activePlayer.currentTime;
    abLoop.b = null;
    abLoop.active = false;
    btn?.classList.add("point-a");
    btn?.classList.remove("active-loop");
    if (txt) {
      txt.innerText = "A";
      txt.classList.remove("hidden");
    }
    if (highlight) highlight.classList.add("hidden");
    showVideoToast(`📍 Schleife Punkt [A] gesetzt (${formatTime(abLoop.a)})`);
  } else if (abLoop.b === null) {
    // 2nd click: set Point B
    if (activePlayer.currentTime <= abLoop.a) {
      showVideoToast("⚠️ Punkt [B] muss hinter Punkt [A] liegen!");
      return;
    }
    abLoop.b = activePlayer.currentTime;
    abLoop.active = true;
    btn?.classList.remove("point-a");
    btn?.classList.add("active-loop");
    if (txt) {
      txt.innerText = "A-B";
      txt.classList.remove("hidden");
    }

    if (highlight) {
      const leftPct = (abLoop.a / activePlayer.duration) * 100;
      const widthPct = ((abLoop.b - abLoop.a) / activePlayer.duration) * 100;
      highlight.style.left = `${leftPct}%`;
      highlight.style.width = `${widthPct}%`;
      highlight.classList.remove("hidden");
    }
    showVideoToast(`🔁 Schleife [A-B] aktiv (${formatTime(abLoop.a)} bis ${formatTime(abLoop.b)})`);
  } else {
    // 3rd click: Reset
    abLoop = { a: null, b: null, active: false };
    btn?.classList.remove("point-a", "active-loop");
    if (txt) {
      txt.innerText = "";
      txt.classList.add("hidden");
    }
    if (highlight) highlight.classList.add("hidden");
    showVideoToast("⏹️ A-B Schleife beendet");
  }
};

document.getElementById("abLoopBtn")?.addEventListener("click", () => {
  window.toggleAbLoop();
});

// --- 4. SPEED PRESETS ---
window.setSpeedPreset = function(speed) {
  speed = parseFloat(speed);
  if (isNaN(speed)) return;
  const activePlayer = activeType === "video" ? videoPlayer : player;
  activePlayer.playbackRate = speed;
  if (speedSlider) {
    speedSlider.value = speed;
    updateSliderFill();
  }
  if (speedValue) speedValue.innerText = speed.toFixed(2) + "x";

  document.querySelectorAll(".speed-pill").forEach(pill => {
    const val = parseFloat(pill.innerText);
    pill.classList.toggle("active", Math.abs(val - speed) < 0.05);
  });
};

// --- 5. AUDIO & SUBTITLE SYNC DECK ---
let currentAudioDelayMs = 0;
let currentSubtitleDelayMs = 0;
let subtitleDelaySec = 0;
let currentSubtitles = [];

window.showSyncPanel = function() {
  const main = document.getElementById("menuMain");
  const sync = document.getElementById("syncPanel");
  const tracks = document.getElementById("tracksPanel");
  if (tracks) tracks.classList.add("hidden");
  if (main) main.classList.add("hidden");
  if (sync) sync.classList.remove("hidden");
};

window.adjustAudioDelay = function(delta) {
  currentAudioDelayMs = Math.max(-3000, Math.min(3000, currentAudioDelayMs + delta));
  const slider = document.getElementById("audioDelaySlider");
  const val = document.getElementById("audioDelayValue");
  if (slider) slider.value = currentAudioDelayMs;
  if (val) val.innerText = `${currentAudioDelayMs > 0 ? '+' : ''}${currentAudioDelayMs} ms`;
  applyAudioDelayNode();
};

window.resetAudioDelay = function() {
  currentAudioDelayMs = 0;
  const slider = document.getElementById("audioDelaySlider");
  const val = document.getElementById("audioDelayValue");
  if (slider) slider.value = 0;
  if (val) val.innerText = "0 ms";
  applyAudioDelayNode();
};

function applyAudioDelayNode() {
  if (typeof videoAudioSyncDelay !== "undefined" && videoAudioSyncDelay) {
    videoAudioSyncDelay.delayTime.value = Math.max(0, currentAudioDelayMs / 1000);
  }
}

document.getElementById("audioDelaySlider")?.addEventListener("input", (e) => {
  currentAudioDelayMs = parseInt(e.target.value, 10) || 0;
  const val = document.getElementById("audioDelayValue");
  if (val) val.innerText = `${currentAudioDelayMs > 0 ? '+' : ''}${currentAudioDelayMs} ms`;
  applyAudioDelayNode();
});

window.adjustSubtitleDelay = function(delta) {
  currentSubtitleDelayMs = Math.max(-5000, Math.min(5000, currentSubtitleDelayMs + delta));
  subtitleDelaySec = currentSubtitleDelayMs / 1000;
  const slider = document.getElementById("subtitleDelaySlider");
  const val = document.getElementById("subtitleDelayValue");
  if (slider) slider.value = currentSubtitleDelayMs;
  if (val) val.innerText = `${currentSubtitleDelayMs > 0 ? '+' : ''}${currentSubtitleDelayMs} ms`;
  updateSubtitles();
};

window.resetSubtitleDelay = function() {
  currentSubtitleDelayMs = 0;
  subtitleDelaySec = 0;
  const slider = document.getElementById("subtitleDelaySlider");
  const val = document.getElementById("subtitleDelayValue");
  if (slider) slider.value = 0;
  if (val) val.innerText = "0 ms";
  updateSubtitles();
};

document.getElementById("subtitleDelaySlider")?.addEventListener("input", (e) => {
  currentSubtitleDelayMs = parseInt(e.target.value, 10) || 0;
  subtitleDelaySec = currentSubtitleDelayMs / 1000;
  const val = document.getElementById("subtitleDelayValue");
  if (val) val.innerText = `${currentSubtitleDelayMs > 0 ? '+' : ''}${currentSubtitleDelayMs} ms`;
  updateSubtitles();
});

function parseSubtitles(text) {
  const cues = [];
  if (!text || typeof text !== "string") return cues;
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const head = lines[0].trim();
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/i.test(head) && !lines.some(l => l.includes('-->'))) continue;

    let timeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIdx = i;
        break;
      }
    }
    if (timeLineIdx === -1) continue;

    const timeMatch = lines[timeLineIdx].match(/(\d{1,2}:)?(\d{1,2}):(\d{2})[,\.](\d{2,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[,\.](\d{2,3})/);
    if (!timeMatch) continue;

    const parseTime = (h, m, s, ms) => {
      const hours = h ? parseInt(h.replace(':', ''), 10) : 0;
      const mins = parseInt(m, 10);
      const secs = parseInt(s, 10);
      const millis = parseInt(ms.padEnd(3, '0').slice(0, 3), 10);
      return (hours * 3600) + (mins * 60) + secs + (millis / 1000);
    };

    const start = parseTime(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const end = parseTime(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
    const textContent = lines
      .slice(timeLineIdx + 1)
      .join('\n')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\\N/gi, '\n')
      .trim();

    if (textContent) {
      cues.push({ start, end, text: textContent });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function updateSubtitles() {
  const overlay = document.getElementById("videoSubtitleOverlay");
  const textEl = document.getElementById("videoSubtitleText");
  if (!overlay || !textEl) return;

  if (!currentSubtitles || currentSubtitles.length === 0) {
    overlay.classList.add("hidden");
    return;
  }

  const cur = videoPlayer.currentTime;
  const activeCue = currentSubtitles.find(cue => {
    const s = cue.start + subtitleDelaySec;
    const e = cue.end + subtitleDelaySec;
    return cur >= s && cur <= e;
  });

  if (activeCue) {
    textEl.innerText = activeCue.text;
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

// ============================================================
// TONSPUR- & UNTERTITEL-MANAGER (MKV/MP4 MULTI-TRACK)
// ============================================================
const BRIDGE_MEDIA_BASE = "http://127.0.0.1:45678";
const AUTO_SUBS_STORAGE_KEY = "myview_auto_embedded_subs";
const TRACK_PREFS_STORAGE_KEY = "myview_video_track_prefs";

function getAutoEmbeddedSubtitles() {
  try {
    const v = localStorage.getItem(AUTO_SUBS_STORAGE_KEY);
    return v === null ? true : v === "1";
  } catch (e) {
    return true;
  }
}

function setAutoEmbeddedSubtitles(enabled) {
  try {
    localStorage.setItem(AUTO_SUBS_STORAGE_KEY, enabled ? "1" : "0");
  } catch (e) {}
}

function loadVideoTrackPrefsMap() {
  try {
    const raw = localStorage.getItem(TRACK_PREFS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function getMediaStemPrefKey(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const norm = rawPath.replace(/\//g, "\\").trim().toLowerCase();
  return norm.replace(/\.(mkv|mp4|m4v|webm|avi|mov|flv|ogv|ts|m2ts|dts|dtshd|ac3|eac3)$/i, "");
}

function getSavedTrackPrefs(rawPath) {
  const key = getMediaStemPrefKey(rawPath);
  if (!key) return null;
  const map = loadVideoTrackPrefsMap();
  return map[key] || null;
}

function saveTrackPrefs(rawPath, patch) {
  const key = getMediaStemPrefKey(rawPath);
  if (!key) return;
  try {
    const map = loadVideoTrackPrefsMap();
    map[key] = Object.assign({}, map[key] || {}, patch);
    localStorage.setItem(TRACK_PREFS_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {}
}

function resolveRawVideoFilePath(src) {
  if (!src || typeof src !== "string") return "";
  let raw = src.trim();
  if (raw.startsWith(BRIDGE_MEDIA_BASE + "/media?") || raw.includes("/media?")) {
    try {
      const u = new URL(raw, BRIDGE_MEDIA_BASE);
      const p = u.searchParams.get("path");
      if (p) return p;
    } catch (e) {}
  }
  if (raw.startsWith("file://")) {
    try {
      if (typeof fileURLToPath === "function") return fileURLToPath(raw);
    } catch (e) {}
    try {
      raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, ""));
      if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
      return raw.replace(/\//g, "\\");
    } catch (e) {}
  }
  return raw;
}

const videoTrackState = {
  mediaPath: "",
  mediaKey: "",
  audioTracks: [],
  subtitleTracks: [],
  activeAudioIndex: 0,
  activeSubtitleKey: "off", // "off" | "emb:<idx>" | "external"
  externalFileName: "",
  externalCues: [],
  isProbing: false,
  probeToken: 0,
  audioSwitchToken: 0,
  pendingAudioLoad: null,
  altAudioReady: false,
  ffmpegMissing: false,
  bridgeError: false
};

function isAltAudioActive() {
  return Boolean(
    typeof videoAltAudio !== "undefined" &&
    videoAltAudio &&
    videoTrackState.activeAudioIndex > 0 &&
    videoTrackState.altAudioReady
  );
}

function resetAltAudioElement() {
  videoTrackState.audioSwitchToken++;
  videoTrackState.pendingAudioLoad = null;
  videoTrackState.altAudioReady = false;
  if (typeof videoAltAudio !== "undefined" && videoAltAudio) {
    try {
      videoAltAudio.pause();
      videoAltAudio.removeAttribute("src");
      videoAltAudio.load();
    } catch (e) {}
  }
  if (videoPlayer) {
    videoPlayer.muted = false;
  }
}

function formatTrackTitle(track, fallbackPrefix) {
  const parts = [];
  if (track.title && track.title.trim()) {
    parts.push(track.title.trim());
  }
  const langLabel = track.langName && track.langName !== "Unbekannt"
    ? track.langName
    : (track.lang && track.lang !== "und" ? track.lang.toUpperCase() : "");
  if (langLabel && !parts.some(p => p.toLowerCase().includes(langLabel.toLowerCase()))) {
    parts.push(langLabel);
  }
  if (parts.length === 0) {
    return `${fallbackPrefix} ${Number(track.index) + 1}`;
  }
  return parts.join(" · ");
}

function formatTrackSubtext(track) {
  const tags = [];
  if (track.lang && track.lang !== "und") tags.push(track.lang.toUpperCase());
  const codecTag = track.codecDisplay || (track.codec ? track.codec.toUpperCase() : "");
  if (codecTag) tags.push(codecTag);
  if (track.channels) tags.push(track.channels);
  if (track.isDefault) tags.push("Standard");
  if (track.isForced) tags.push("Erzwungen");
  if (track.source === "saved") tags.push("Gesichert");
  return tags.join(" · ") || "Standardspur";
}

function updateTracksBadges() {
  const audioCount = videoTrackState.audioTracks.length;
  const subCount = videoTrackState.subtitleTracks.filter(s => s.isText !== false).length + (videoTrackState.externalCues.length > 0 ? 1 : 0);
  const activeSub = videoTrackState.activeSubtitleKey !== "off";
  const activeAltAudio = videoTrackState.activeAudioIndex > 0;
  const totalBadge = audioCount > 1 ? `${audioCount}🔊` : (subCount > 0 ? "CC" : "");

  const quickBtn = document.getElementById("tracksQuickBtn");
  const quickBadge = document.getElementById("tracksQuickBadge");
  if (quickBtn) {
    quickBtn.classList.toggle("active", activeAltAudio || activeSub);
  }
  if (quickBadge) {
    if (totalBadge) {
      quickBadge.innerText = totalBadge;
      quickBadge.classList.remove("hidden");
    } else {
      quickBadge.classList.add("hidden");
    }
  }

  const fsBtn = document.getElementById("fsTracksBtn");
  const fsBadge = document.getElementById("fsTracksBadge");
  if (fsBtn) {
    fsBtn.classList.toggle("active", activeAltAudio || activeSub);
  }
  if (fsBadge) {
    if (totalBadge) {
      fsBadge.innerText = totalBadge;
      fsBadge.classList.remove("hidden");
    } else {
      fsBadge.classList.add("hidden");
    }
  }

  const summaryEl = document.getElementById("menuTracksSummary");
  if (summaryEl) {
    if (audioCount > 1 || subCount > 0) {
      const pieces = [];
      if (audioCount > 0) pieces.push(`${audioCount} Ton`);
      if (subCount > 0) pieces.push(`${subCount} UT`);
      summaryEl.innerText = pieces.join(" · ");
    } else {
      summaryEl.innerText = "";
    }
  }
}

function renderTracksUI() {
  const toggleEl = document.getElementById("autoEmbeddedSubtitlesToggle");
  if (toggleEl) {
    toggleEl.checked = getAutoEmbeddedSubtitles();
  }

  const audioListEl = document.getElementById("audioTrackList");
  if (audioListEl) {
    let diagBanner = null;
    if (videoTrackState.bridgeError || videoTrackState.ffmpegMissing) {
      diagBanner = document.createElement("div");
      diagBanner.className = "tracks-diag-banner";
      diagBanner.innerHTML = videoTrackState.bridgeError
        ? `<div>⚠️ Lokaler Media-Server (Port 45678) nicht erreichbar. Spur-Analyse ist deaktiviert.</div>`
        : `<div>⚠️ <strong>ffmpeg.exe fehlt</strong> – Tonspur-Erkennung, MKV-Audio-Wechsel &amp; interne Untertitel sind nicht verfügbar.</div>`;
      const fixBtn = document.createElement("button");
      fixBtn.type = "button";
      fixBtn.className = "tracks-diag-btn";
      fixBtn.innerText = "🩺 System-Check & Reparatur öffnen";
      fixBtn.onclick = (e) => {
        e.stopPropagation();
        if (typeof window.openUpdatesSystemCheck === "function") window.openUpdatesSystemCheck();
      };
      diagBanner.appendChild(fixBtn);
    }

    if (videoTrackState.isProbing && videoTrackState.audioTracks.length === 0) {
      audioListEl.innerHTML = `<div class="tracks-empty">Spuren werden analysiert…</div>`;
    } else if (videoTrackState.audioTracks.length === 0) {
      audioListEl.innerHTML = "";
      if (diagBanner) audioListEl.appendChild(diagBanner);
      const emptyEl = document.createElement("div");
      emptyEl.className = "tracks-empty";
      emptyEl.innerText = "Standard-Tonspur aktiv";
      audioListEl.appendChild(emptyEl);
    } else {
      audioListEl.innerHTML = "";
      if (diagBanner) audioListEl.appendChild(diagBanner);
      videoTrackState.audioTracks.forEach((tr) => {
        const btn = document.createElement("button");
        const isActive = videoTrackState.activeAudioIndex === tr.index;
        const isLoading = isActive && tr.index > 0 && !videoTrackState.altAudioReady;
        btn.className = "track-option-btn" + (isActive ? " active" : "");
        btn.onclick = (e) => {
          e.stopPropagation();
          window.selectVideoAudioTrack(tr.index);
        };
        const badgeText = isLoading ? "Lade…" : (isActive ? "Aktiv" : `Spur ${tr.index + 1}`);
        btn.innerHTML = `
          <div class="track-option-main">
            <span class="track-option-title">🔊 ${escapeHtmlTrack(formatTrackTitle(tr, "Audiospur"))}</span>
            <span class="track-option-sub">${escapeHtmlTrack(formatTrackSubtext(tr))}</span>
          </div>
          <span class="track-option-badge">${escapeHtmlTrack(badgeText)}</span>
        `;
        audioListEl.appendChild(btn);
      });
    }
  }

  const subListEl = document.getElementById("subtitleTrackList");
  if (subListEl) {
    subListEl.innerHTML = "";

    const offBtn = document.createElement("button");
    offBtn.className = "track-option-btn" + (videoTrackState.activeSubtitleKey === "off" ? " active" : "");
    offBtn.onclick = (e) => {
      e.stopPropagation();
      window.selectVideoSubtitleTrack("off");
    };
    offBtn.innerHTML = `
      <div class="track-option-main">
        <span class="track-option-title">🚫 Aus (Keine Untertitel)</span>
      </div>
      <span class="track-option-badge">${videoTrackState.activeSubtitleKey === "off" ? "Aktiv" : "Aus"}</span>
    `;
    subListEl.appendChild(offBtn);

    if (videoTrackState.externalCues.length > 0) {
      const extBtn = document.createElement("button");
      const isExtActive = videoTrackState.activeSubtitleKey === "external";
      extBtn.className = "track-option-btn" + (isExtActive ? " active" : "");
      extBtn.onclick = (e) => {
        e.stopPropagation();
        window.selectVideoSubtitleTrack("external");
      };
      extBtn.innerHTML = `
        <div class="track-option-main">
          <span class="track-option-title">📁 ${escapeHtmlTrack(videoTrackState.externalFileName || "Externe Datei")}</span>
          <span class="track-option-sub">Extern (${videoTrackState.externalCues.length} Zeilen)</span>
        </div>
        <span class="track-option-badge">${isExtActive ? "Aktiv" : "Extern"}</span>
      `;
      subListEl.appendChild(extBtn);
    }

    if (videoTrackState.subtitleTracks.length === 0) {
      const emptyNote = document.createElement("div");
      emptyNote.className = "tracks-empty";
      emptyNote.innerText = videoTrackState.isProbing
        ? "Suche eingebettete Untertitel…"
        : "Keine eingebetteten Untertitel in dieser Datei";
      subListEl.appendChild(emptyNote);
    } else {
      videoTrackState.subtitleTracks.forEach((sub) => {
        const key = `emb:${sub.index}`;
        const isActive = videoTrackState.activeSubtitleKey === key;
        const canSelect = sub.isText !== false;
        const btn = document.createElement("button");
        btn.className = "track-option-btn" + (isActive ? " active" : "");
        btn.disabled = !canSelect;
        btn.onclick = (e) => {
          e.stopPropagation();
          if (canSelect) window.selectVideoSubtitleTrack(key);
        };
        const subMeta = canSelect
          ? formatTrackSubtext(sub)
          : `${formatTrackSubtext(sub)} · Bild-Untertitel (PGS/VobSub)`;
        btn.innerHTML = `
          <div class="track-option-main">
            <span class="track-option-title">💬 ${escapeHtmlTrack(formatTrackTitle(sub, "Untertitel"))}</span>
            <span class="track-option-sub">${escapeHtmlTrack(subMeta)}</span>
          </div>
          <span class="track-option-badge">${canSelect ? (isActive ? "Aktiv" : "Intern") : "N/A"}</span>
        `;
        subListEl.appendChild(btn);
      });
    }
  }

  updateTracksBadges();
}

function escapeHtmlTrack(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.showTracksPanel = function() {
  const main = document.getElementById("menuMain");
  const speed = document.getElementById("speedPanel");
  const timer = document.getElementById("sleepTimerPanel");
  const sync = document.getElementById("syncPanel");
  const adj = document.getElementById("videoAdjustPanel");
  const eq = document.getElementById("equalizerPanel");
  const tracks = document.getElementById("tracksPanel");
  if (main) main.classList.add("hidden");
  if (speed) speed.classList.add("hidden");
  if (timer) timer.classList.add("hidden");
  if (sync) sync.classList.add("hidden");
  if (adj) adj.classList.add("hidden");
  if (eq) eq.classList.add("hidden");
  if (tracks) tracks.classList.remove("hidden");

  const currentRaw = resolveRawVideoFilePath(videoPlayer?.currentSrc || videoPlayer?.src || "");
  if (!videoTrackState.isProbing && currentRaw && !/^https?:\/\//i.test(currentRaw)) {
    if (videoTrackState.audioTracks.length === 0 || currentRaw !== videoTrackState.mediaPath) {
      if (typeof window.probeAndLoadVideoTracks === "function") {
        window.probeAndLoadVideoTracks(currentRaw);
      }
    }
  }
  renderTracksUI();
};

window.openTracksMenuDirect = function(e) {
  if (e && typeof e.stopPropagation === "function") e.stopPropagation();
  const menuEl = document.getElementById("videoMenu");
  if (!menuEl) return;
  const tracksEl = document.getElementById("tracksPanel");
  const isAlreadyShowingTracks = menuEl.classList.contains("show") && tracksEl && !tracksEl.classList.contains("hidden");
  if (isAlreadyShowingTracks) {
    menuEl.classList.remove("show");
  } else {
    window.showTracksPanel();
    menuEl.classList.add("show");
  }
  if (typeof wakeFullscreenHud === "function") wakeFullscreenHud();
};

window.toggleAutoEmbeddedSubtitles = function(enabled) {
  const isOn = Boolean(enabled);
  setAutoEmbeddedSubtitles(isOn);
  renderTracksUI();
  if (isOn && videoTrackState.activeSubtitleKey === "off" && videoTrackState.subtitleTracks.length > 0) {
    const best = pickBestEmbeddedSubtitleTrack(videoTrackState.subtitleTracks);
    if (best) {
      window.selectVideoSubtitleTrack(`emb:${best.index}`, { silent: false });
      return;
    }
  }
  if (typeof showVideoToast === "function") {
    showVideoToast(isOn ? "💬 MKV-Untertitel automatisch laden: AN" : "💬 MKV-Untertitel automatisch laden: AUS");
  }
};

function pickBestEmbeddedSubtitleTrack(subTracks) {
  const textSubs = (subTracks || []).filter(s => s.isText !== false);
  if (textSubs.length === 0) return null;
  const defTrack = textSubs.find(s => s.isDefault);
  if (defTrack) return defTrack;
  const deTrack = textSubs.find(s => /^(ger|deu|de)$/i.test(s.lang || ""));
  if (deTrack) return deTrack;
  return textSubs[0];
}

window.selectVideoAudioTrack = function(trackIndex, opts = {}) {
  const idx = parseInt(trackIndex, 10) || 0;
  const rawPath = videoTrackState.mediaPath;
  if (!rawPath) return;

  if (!opts.skipSave) {
    saveTrackPrefs(rawPath, { audioIndex: idx });
  }

  if (idx <= 0 || typeof videoAltAudio === "undefined" || !videoAltAudio) {
    videoTrackState.activeAudioIndex = 0;
    resetAltAudioElement();
    renderTracksUI();
    if (!opts.silent && typeof showVideoToast === "function") {
      const tr = videoTrackState.audioTracks.find(t => t.index === 0);
      showVideoToast(`🔊 Audiospur: ${tr ? formatTrackTitle(tr, "Spur") : "Spur 1"}`);
    }
    return;
  }

  ensureAudioContext();
  const token = ++videoTrackState.audioSwitchToken;
  videoTrackState.activeAudioIndex = idx;
  videoTrackState.altAudioReady = false;
  videoTrackState.pendingAudioLoad = { token, trackIndex: idx, mediaPath: rawPath, silent: Boolean(opts.silent) };
  renderTracksUI();

  if (!opts.silent && typeof showVideoToast === "function") {
    showVideoToast(`⏳ Lade Audiospur ${idx + 1}…`);
  }

  const audioUrl = `${BRIDGE_MEDIA_BASE}/media/audio?path=${encodeURIComponent(rawPath)}&track=${idx}`;
  try {
    videoAltAudio.pause();
    videoAltAudio.crossOrigin = "anonymous";
    videoAltAudio.src = audioUrl;
    videoAltAudio.load();
  } catch (e) {
    console.warn("Alternativer Audio-Load fehlgeschlagen:", e);
    videoTrackState.activeAudioIndex = 0;
    resetAltAudioElement();
    renderTracksUI();
  }
};

window.selectVideoSubtitleTrack = async function(subKey, opts = {}) {
  const rawPath = videoTrackState.mediaPath;
  videoTrackState.activeSubtitleKey = subKey || "off";
  if (rawPath && !opts.skipSave && subKey !== "external") {
    saveTrackPrefs(rawPath, { subKey: videoTrackState.activeSubtitleKey });
  }

  if (subKey === "off") {
    currentSubtitles = [];
    updateSubtitles();
    renderTracksUI();
    if (!opts.silent && typeof showVideoToast === "function") {
      showVideoToast("💬 Untertitel ausgeblendet");
    }
    return;
  }

  if (subKey === "external") {
    currentSubtitles = videoTrackState.externalCues || [];
    updateSubtitles();
    renderTracksUI();
    if (!opts.silent && typeof showVideoToast === "function") {
      showVideoToast(`💬 Externe Untertitel aktiv (${currentSubtitles.length} Zeilen)`);
    }
    return;
  }

  if (typeof subKey === "string" && subKey.startsWith("emb:")) {
    const idx = parseInt(subKey.slice(4), 10);
    if (!rawPath || isNaN(idx)) return;
    const token = videoTrackState.probeToken;
    renderTracksUI();
    try {
      const resp = await fetch(`${BRIDGE_MEDIA_BASE}/media/subtitle?path=${encodeURIComponent(rawPath)}&track=${idx}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const vttText = await resp.text();
      if (token !== videoTrackState.probeToken) return;
      const cues = parseSubtitles(vttText);
      currentSubtitles = cues;
      videoTrackState.activeSubtitleKey = subKey;
      updateSubtitles();
      renderTracksUI();
      if (!opts.silent && typeof showVideoToast === "function") {
        const subMeta = videoTrackState.subtitleTracks.find(s => s.index === idx);
        const label = subMeta ? formatTrackTitle(subMeta, "Untertitel") : `Spur ${idx + 1}`;
        showVideoToast(`💬 Untertitel geladen: ${label} (${cues.length})`);
      }
    } catch (err) {
      console.warn("Konnte eingebetteten Untertitel nicht laden:", err);
      videoTrackState.activeSubtitleKey = "off";
      currentSubtitles = [];
      updateSubtitles();
      renderTracksUI();
      if (!opts.silent && typeof showVideoToast === "function") {
        showVideoToast("⚠️ Untertitelspur konnte nicht geladen werden");
      }
    }
  }
};

window.probeAndLoadVideoTracks = async function(explicitPath) {
  const rawPath = explicitPath || resolveRawVideoFilePath(videoPlayer?.currentSrc || videoPlayer?.src || "");
  if (!rawPath || /^https?:\/\//i.test(rawPath)) {
    return;
  }
  const mediaKey = getMediaStemPrefKey(rawPath);
  if (
    videoTrackState.mediaPath === rawPath &&
    videoTrackState.isProbing &&
    Date.now() - (videoTrackState.probeStartedAt || 0) < 4000
  ) {
    return;
  }

  const isNewVideo = mediaKey !== videoTrackState.mediaKey;
  videoTrackState.mediaPath = rawPath;
  videoTrackState.mediaKey = mediaKey;
  videoTrackState.isProbing = true;
  videoTrackState.probeStartedAt = Date.now();
  const myToken = ++videoTrackState.probeToken;

  if (isNewVideo) {
    resetAltAudioElement();
    videoTrackState.audioTracks = [];
    videoTrackState.subtitleTracks = [];
    videoTrackState.activeAudioIndex = 0;
    videoTrackState.activeSubtitleKey = "off";
    videoTrackState.externalCues = [];
    videoTrackState.externalFileName = "";
    videoTrackState.bridgeError = false;
    currentSubtitles = [];
    updateSubtitles();
  }
  renderTracksUI();

  try {
    const resp = await fetch(`${BRIDGE_MEDIA_BASE}/api/media/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: rawPath })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (myToken !== videoTrackState.probeToken) return;

    videoTrackState.audioTracks = Array.isArray(data.audioTracks) ? data.audioTracks : [];
    videoTrackState.subtitleTracks = Array.isArray(data.subtitleTracks) ? data.subtitleTracks : [];
    videoTrackState.ffmpegMissing = (data.ffmpegAvailable === false);
    videoTrackState.bridgeError = false;
    videoTrackState.isProbing = false;

    const saved = getSavedTrackPrefs(rawPath);

    // 1. Gespeicherte oder Standard-Audiospur wiederherstellen
    const desiredAudioIdx = saved && typeof saved.audioIndex === "number" ? saved.audioIndex : 0;
    if (desiredAudioIdx > 0 && videoTrackState.audioTracks.some(t => t.index === desiredAudioIdx)) {
      window.selectVideoAudioTrack(desiredAudioIdx, { silent: true, skipSave: true });
    } else {
      videoTrackState.activeAudioIndex = 0;
      resetAltAudioElement();
    }

    // 2. Untertitel: externe nicht ueberschreiben; sonst gespeicherte Wahl oder Auto-Erkennung
    if (videoTrackState.activeSubtitleKey !== "external") {
      if (saved && typeof saved.subKey === "string") {
        if (saved.subKey === "off") {
          videoTrackState.activeSubtitleKey = "off";
        } else if (saved.subKey.startsWith("emb:")) {
          const idx = parseInt(saved.subKey.slice(4), 10);
          if (videoTrackState.subtitleTracks.some(s => s.index === idx && s.isText !== false)) {
            await window.selectVideoSubtitleTrack(saved.subKey, { silent: true, skipSave: true });
          }
        }
      } else if (getAutoEmbeddedSubtitles()) {
        const bestSub = pickBestEmbeddedSubtitleTrack(videoTrackState.subtitleTracks);
        if (bestSub) {
          await window.selectVideoSubtitleTrack(`emb:${bestSub.index}`, { silent: false, skipSave: true });
        }
      }
    }

    renderTracksUI();
  } catch (err) {
    if (myToken === videoTrackState.probeToken) {
      videoTrackState.isProbing = false;
      videoTrackState.bridgeError = true;
      renderTracksUI();
    }
  }
};

// Synchronisation von videoAltAudio mit videoPlayer
if (typeof videoAltAudio !== "undefined" && videoAltAudio) {
  videoAltAudio.addEventListener("canplay", () => {
    const pending = videoTrackState.pendingAudioLoad;
    if (!pending || pending.token !== videoTrackState.audioSwitchToken) return;
    if (videoTrackState.activeAudioIndex !== pending.trackIndex) return;
    videoTrackState.pendingAudioLoad = null;
    videoTrackState.altAudioReady = true;

    videoPlayer.muted = true;
    const volSlider = document.getElementById("volume");
    const volVal = volSlider ? parseFloat(volSlider.value) : 1.0;
    videoAltAudio.volume = Math.min(1.0, isNaN(volVal) ? 1.0 : volVal);
    videoAltAudio.playbackRate = videoPlayer.playbackRate || 1.0;
    try {
      videoAltAudio.currentTime = videoPlayer.currentTime || 0;
    } catch (e) {}

    if (!videoPlayer.paused) {
      ensureAudioContext();
      videoAltAudio.play().catch(() => {});
    }
    renderTracksUI();

    if (!pending.silent && typeof showVideoToast === "function") {
      const tr = videoTrackState.audioTracks.find(t => t.index === pending.trackIndex);
      showVideoToast(`🔊 Audiospur gewechselt: ${tr ? formatTrackTitle(tr, "Spur") : `Spur ${pending.trackIndex + 1}`}`);
    }
  });

  videoAltAudio.addEventListener("error", () => {
    const pending = videoTrackState.pendingAudioLoad;
    if (!pending || pending.token !== videoTrackState.audioSwitchToken) return;
    videoTrackState.pendingAudioLoad = null;
    videoTrackState.activeAudioIndex = 0;
    videoTrackState.altAudioReady = false;
    videoPlayer.muted = false;
    renderTracksUI();
    if (!pending.silent && typeof showVideoToast === "function") {
      showVideoToast("⚠️ Audiospur konnte nicht geladen werden – Standardspur aktiv.");
    }
  });
}

if (videoPlayer) {
  let lastAltAudioDriftFixMs = 0;
  videoPlayer.addEventListener("loadstart", () => {
    window.probeAndLoadVideoTracks();
  });
  videoPlayer.addEventListener("loadedmetadata", () => {
    window.probeAndLoadVideoTracks();
  });
  videoPlayer.addEventListener("play", () => {
    if (isAltAudioActive()) {
      ensureAudioContext();
      videoAltAudio.playbackRate = videoPlayer.playbackRate || 1.0;
      if (Math.abs((videoAltAudio.currentTime || 0) - (videoPlayer.currentTime || 0)) > 0.12) {
        try { videoAltAudio.currentTime = videoPlayer.currentTime || 0; } catch (e) {}
      }
      videoAltAudio.play().catch(() => {});
    }
  });
  videoPlayer.addEventListener("playing", () => {
    if (isAltAudioActive()) {
      ensureAudioContext();
      videoAltAudio.playbackRate = videoPlayer.playbackRate || 1.0;
      if (Math.abs((videoAltAudio.currentTime || 0) - (videoPlayer.currentTime || 0)) > 0.12) {
        try { videoAltAudio.currentTime = videoPlayer.currentTime || 0; } catch (e) {}
      }
      videoAltAudio.play().catch(() => {});
    }
  });
  videoPlayer.addEventListener("pause", () => {
    if (typeof videoAltAudio !== "undefined" && videoAltAudio && !videoAltAudio.paused) {
      videoAltAudio.pause();
    }
  });
  videoPlayer.addEventListener("ended", () => {
    if (typeof videoAltAudio !== "undefined" && videoAltAudio && !videoAltAudio.paused) {
      videoAltAudio.pause();
    }
  });
  videoPlayer.addEventListener("waiting", () => {
    if (isAltAudioActive() && !videoAltAudio.paused) {
      videoAltAudio.pause();
    }
  });
  videoPlayer.addEventListener("seeking", () => {
    if (isAltAudioActive() && !videoAltAudio.paused) {
      videoAltAudio.pause();
    }
  });
  videoPlayer.addEventListener("seeked", () => {
    if (isAltAudioActive()) {
      try { videoAltAudio.currentTime = videoPlayer.currentTime || 0; } catch (e) {}
      if (!videoPlayer.paused) {
        videoAltAudio.playbackRate = videoPlayer.playbackRate || 1.0;
        videoAltAudio.play().catch(() => {});
      }
    }
  });
  videoPlayer.addEventListener("ratechange", () => {
    if (typeof videoAltAudio !== "undefined" && videoAltAudio) {
      videoAltAudio.playbackRate = videoPlayer.playbackRate || 1.0;
    }
  });
  videoPlayer.addEventListener("timeupdate", () => {
    if (!isAltAudioActive() || videoPlayer.seeking) return;
    const now = Date.now();
    const drift = Math.abs((videoAltAudio.currentTime || 0) - (videoPlayer.currentTime || 0));
    if (drift > 0.40 && now - lastAltAudioDriftFixMs > 1500) {
      lastAltAudioDriftFixMs = now;
      try { videoAltAudio.currentTime = videoPlayer.currentTime || 0; } catch (e) {}
    }
    if (!videoPlayer.paused && videoAltAudio.paused && videoAltAudio.readyState >= 2) {
      videoAltAudio.play().catch(() => {});
    }
  });
}

if (player) {
  player.addEventListener("play", () => {
    if (typeof videoAltAudio !== "undefined" && videoAltAudio && !videoAltAudio.paused) {
      videoAltAudio.pause();
    }
  });
}

renderTracksUI();

// Subtitle File Picker & Drag and Drop
const subFileInput = document.getElementById("subtitleFileInput");
if (subFileInput) {
  subFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const parsed = parseSubtitles(evt.target.result);
        currentSubtitles = parsed;
        videoTrackState.externalFileName = file.name;
        videoTrackState.externalCues = parsed;
        videoTrackState.activeSubtitleKey = "external";
        updateSubtitles();
        renderTracksUI();
        showVideoToast(`💬 ${currentSubtitles.length} Untertitel geladen!`);
      };
      reader.readAsText(file);
    }
  });
}

const videoContainerEl = document.getElementById("videoMainContainer");
if (videoContainerEl) {
  videoContainerEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  videoContainerEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.match(/\.(srt|vtt)$/i)) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const parsed = parseSubtitles(evt.target.result);
          currentSubtitles = parsed;
          videoTrackState.externalFileName = file.name;
          videoTrackState.externalCues = parsed;
          videoTrackState.activeSubtitleKey = "external";
          updateSubtitles();
          renderTracksUI();
          showVideoToast(`💬 ${currentSubtitles.length} Untertitel aus "${file.name}" geladen!`);
        };
        reader.readAsText(file);
      }
    }
  });
}

// --- 6. VIDEO QUICK ADJUSTMENTS (PICTURE & ASPECT RATIO) ---
let videoAdjustSettings = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  aspect: 'auto'
};

window.showVideoAdjustPanel = function() {
  const main = document.getElementById("menuMain");
  const adj = document.getElementById("videoAdjustPanel");
  if (main) main.classList.add("hidden");
  if (adj) adj.classList.remove("hidden");
};

function applyVideoAdjustments() {
  if (!videoPlayer) return;
  videoPlayer.style.filter = `brightness(${videoAdjustSettings.brightness}%) contrast(${videoAdjustSettings.contrast}%) saturate(${videoAdjustSettings.saturate}%)`;
}

window.resetVideoAdjustments = function() {
  videoAdjustSettings = { brightness: 100, contrast: 100, saturate: 100, aspect: 'auto' };
  applyVideoAdjustments();
  setVideoAspect('auto');
  const bS = document.getElementById("videoBrightSlider");
  const cS = document.getElementById("videoContrastSlider");
  const sS = document.getElementById("videoSaturateSlider");
  if (bS) bS.value = 100;
  if (cS) cS.value = 100;
  if (sS) sS.value = 100;
  const bV = document.getElementById("videoBrightVal");
  const cV = document.getElementById("videoContrastVal");
  const sV = document.getElementById("videoSaturateVal");
  if (bV) bV.innerText = "100%";
  if (cV) cV.innerText = "100%";
  if (sV) sV.innerText = "100%";
  showVideoToast("🎨 Bildkorrektur zurückgesetzt");
};

window.setVideoAspect = function(aspect) {
  videoAdjustSettings.aspect = aspect;
  if (!videoPlayer) return;
  if (aspect === 'auto') {
    videoPlayer.style.objectFit = 'contain';
    videoPlayer.style.aspectRatio = '';
  } else if (aspect === 'cover') {
    videoPlayer.style.objectFit = 'cover';
    videoPlayer.style.aspectRatio = '';
  } else {
    videoPlayer.style.objectFit = 'fill';
    videoPlayer.style.aspectRatio = aspect;
  }
  document.querySelectorAll(".aspect-pill").forEach(pill => {
    pill.classList.toggle("active", pill.getAttribute("onclick")?.includes(aspect));
  });
};

document.getElementById("videoBrightSlider")?.addEventListener("input", (e) => {
  videoAdjustSettings.brightness = parseInt(e.target.value, 10);
  const v = document.getElementById("videoBrightVal");
  if (v) v.innerText = `${videoAdjustSettings.brightness}%`;
  applyVideoAdjustments();
});

document.getElementById("videoContrastSlider")?.addEventListener("input", (e) => {
  videoAdjustSettings.contrast = parseInt(e.target.value, 10);
  const v = document.getElementById("videoContrastVal");
  if (v) v.innerText = `${videoAdjustSettings.contrast}%`;
  applyVideoAdjustments();
});

document.getElementById("videoSaturateSlider")?.addEventListener("input", (e) => {
  videoAdjustSettings.saturate = parseInt(e.target.value, 10);
  const v = document.getElementById("videoSaturateVal");
  if (v) v.innerText = `${videoAdjustSettings.saturate}%`;
  applyVideoAdjustments();
});

// --- 7. FRAME-BY-FRAME STEPPING & VIDEO SNAPSHOT ---
window.stepVideoFrame = function(forward = true) {
  if (activeType !== "video" || !videoPlayer.duration) return;
  videoPlayer.pause();
  const step = 1 / 30; // standard 30fps
  videoPlayer.currentTime = forward 
    ? Math.min(videoPlayer.duration, videoPlayer.currentTime + step)
    : Math.max(0, videoPlayer.currentTime - step);
};

document.getElementById("stepBackBtn")?.addEventListener("click", () => window.stepVideoFrame(false));
document.getElementById("stepForwardBtn")?.addEventListener("click", () => window.stepVideoFrame(true));

window.takeVideoSnapshot = function() {
  if (activeType !== "video" || !videoPlayer.videoWidth) {
    showVideoToast("⚠️ Kein aktives Video für Snapshot!");
    return;
  }

  // Camera flash animation
  const flash = document.getElementById("videoFlashOverlay");
  if (flash) {
    flash.classList.add("flash");
    setTimeout(() => flash.classList.remove("flash"), 140);
  }

  // High-res canvas capture
  const snapCanvas = document.createElement("canvas");
  snapCanvas.width = videoPlayer.videoWidth;
  snapCanvas.height = videoPlayer.videoHeight;
  const snapCtx = snapCanvas.getContext("2d");
  snapCtx.drawImage(videoPlayer, 0, 0, snapCanvas.width, snapCanvas.height);

  try {
    const dataUrl = snapCanvas.toDataURL("image/png");
    const snapshotsDir = path.join(mediaBase, "snapshots");
    if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

    const filename = `Snapshot_${Date.now()}.png`;
    const fullPath = path.join(snapshotsDir, filename);
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(fullPath, base64Data, 'base64');

    showVideoToast(`📸 Gespeichert als ${filename}`);
  } catch (err) {
    const a = document.createElement("a");
    a.href = snapCanvas.toDataURL("image/png");
    a.download = `Snapshot_${Date.now()}.png`;
    a.click();
    showVideoToast("📸 Screenshot heruntergeladen!");
  }
};

document.getElementById("snapshotBtn")?.addEventListener("click", () => window.takeVideoSnapshot());

function showVideoToast(text) {
  const toast = document.getElementById("videoSnapshotToast");
  if (!toast) return;
  toast.innerText = text;
  toast.classList.remove("hidden");
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2600);
}

// --- 8. EQUALIZER 5-BAND PRESETS & SLIDERS ---
window.showEqualizerPanel = function() {
  if (typeof window.openEqualizerModal === "function") {
    window.openEqualizerModal();
  }
};

const eqPresetValues = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 1, -1, -2],
  vocal: [-2, 1, 4, 3, 0],
  rock: [5, 2, -1, 3, 5],
  boost: [4, 4, 4, 4, 4]
};

window.setEqPreset = function(name) {
  const values = eqPresetValues[name] || eqPresetValues.flat;
  const ids = ["eqSlider60", "eqSlider230", "eqSlider910", "eqSlider4k", "eqSlider14k"];
  const valIds = ["eqVal60", "eqVal230", "eqVal910", "eqVal4k", "eqVal14k"];

  values.forEach((val, i) => {
    const sl = document.getElementById(ids[i]);
    const vl = document.getElementById(valIds[i]);
    if (sl) sl.value = val;
    if (vl) vl.innerText = `${val > 0 ? '+' : ''}${val}dB`;
    if (musicFilters && musicFilters[i]) musicFilters[i].gain.value = val;
    if (videoFilters && videoFilters[i]) videoFilters[i].gain.value = val;
  });

  document.querySelectorAll(".eq-pill").forEach(pill => {
    pill.classList.toggle("active", pill.getAttribute("onclick")?.includes(name));
  });
};

["60", "230", "910", "4k", "14k"].forEach((freqName, idx) => {
  const sl = document.getElementById(`eqSlider${freqName}`);
  const vl = document.getElementById(`eqVal${freqName}`);
  if (sl) {
    sl.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      if (vl) vl.innerText = `${val > 0 ? '+' : ''}${val}dB`;
      if (musicFilters && musicFilters[idx]) musicFilters[idx].gain.value = val;
      if (videoFilters && videoFilters[idx]) videoFilters[idx].gain.value = val;
      document.querySelectorAll(".eq-pill").forEach(pill => pill.classList.remove("active"));
    });
  }
});

// --- 9. UP NEXT / QUEUE DRAWER ---
let queueDrawerOpen = false;

window.toggleQueueDrawer = function() {
  const drawer = document.getElementById("queueDrawer");
  const backdrop = document.getElementById("queueDrawerBackdrop");
  if (!drawer) return;
  queueDrawerOpen = !queueDrawerOpen;
  drawer.classList.toggle("hidden", !queueDrawerOpen);
  backdrop?.classList.toggle("hidden", !queueDrawerOpen);
  if (queueDrawerOpen) {
    renderQueueDrawer();
  }
};

document.getElementById("queueDrawerBtn")?.addEventListener("click", () => {
  window.toggleQueueDrawer();
});

let queueDragSrcIndex = null;

window.playNextInQueue = function(filePath) {
  if (!filePath) return;
  if (!currentPlaybackList || currentPlaybackList.length === 0) {
    currentPlaybackList = [filePath];
    currentIndex = 0;
    const isVid = filePath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
    if (isVid) playVideo(filePath);
    else playMusic(filePath);
  } else {
    const existingIdx = currentPlaybackList.indexOf(filePath);
    if (existingIdx !== -1) {
      currentPlaybackList.splice(existingIdx, 1);
      if (existingIdx <= currentIndex && currentIndex > 0) currentIndex--;
    }
    const insertIdx = Math.min(currentPlaybackList.length, currentIndex + 1);
    currentPlaybackList.splice(insertIdx, 0, filePath);
  }
  if (typeof renderQueueDrawer === "function") renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
  const name = path.basename(filePath);
  showVideoToast(`⏭️ Als Nächstes vorgemerkt: "${name}"`);
};

window.addToQueueList = function(filePath) {
  if (!filePath) return;
  if (!currentPlaybackList || currentPlaybackList.length === 0) {
    currentPlaybackList = [filePath];
    currentIndex = 0;
    const isVid = filePath.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
    if (isVid) playVideo(filePath);
    else playMusic(filePath);
  } else {
    if (!currentPlaybackList.includes(filePath)) {
      currentPlaybackList.push(filePath);
    }
  }
  if (typeof renderQueueDrawer === "function") renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
  const name = path.basename(filePath);
  showVideoToast(`📑 An Warteschlange angehängt: "${name}"`);
};

window.shuffleQueueList = function() {
  if (!currentPlaybackList || currentPlaybackList.length <= currentIndex + 2) {
    showVideoToast("Zu wenige Titel zum Mischen!");
    return;
  }
  const played = currentPlaybackList.slice(0, currentIndex + 1);
  const upNext = currentPlaybackList.slice(currentIndex + 1);
  
  for (let i = upNext.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [upNext[i], upNext[j]] = [upNext[j], upNext[i]];
  }

  currentPlaybackList = played.concat(upNext);
  renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
  showVideoToast("🔀 Warteschlange gemischt!");
};

window.moveQueueItem = function(fromIdx, direction) {
  if (!currentPlaybackList || currentPlaybackList.length < 2) return;
  const toIdx = fromIdx + direction;
  if (toIdx < 0 || toIdx >= currentPlaybackList.length) return;

  const item = currentPlaybackList.splice(fromIdx, 1)[0];
  currentPlaybackList.splice(toIdx, 0, item);

  if (fromIdx === currentIndex) {
    currentIndex = toIdx;
  } else if (fromIdx < currentIndex && toIdx >= currentIndex) {
    currentIndex--;
  } else if (fromIdx > currentIndex && toIdx <= currentIndex) {
    currentIndex++;
  }

  renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
};

window.renderQueueDrawer = function() {
  const container = document.getElementById("queueDrawerItems");
  const meta = document.getElementById("queueDrawerMeta");
  const badge = document.getElementById("queueBadge");
  if (!container) return;

  if (!currentPlaybackList || currentPlaybackList.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 45px 18px; line-height: 1.6;">
        <div style="font-size: 40px; margin-bottom: 12px; opacity: 0.6;">📑</div>
        <div style="font-weight: bold; color: #fff; font-size: 15px; margin-bottom: 8px;">Deine Warteschlange ist leer</div>
        <div style="font-size: 12px; color: var(--text-muted); max-width: 290px; margin: 0 auto; line-height: 1.5;">
          Klicke mit der <strong>rechten Maustaste</strong> auf einen Song oder ein Video und wähle:<br>
          <span style="color: var(--accent); font-weight: bold;">• Als Nächstes abspielen</span> (direkt danach)<br>
          <span style="color: #fff; font-weight: bold;">• An Warteschlange anhängen</span> (ans Ende)
        </div>
      </div>
    `;
    if (meta) meta.innerText = "0 Titel";
    if (badge) { badge.classList.add("hidden"); badge.innerText = "0"; }
    return;
  }

  const remaining = Math.max(0, currentPlaybackList.length - currentIndex - 1);
  if (meta) meta.innerText = `${currentPlaybackList.length} Titel • Noch ${remaining} folgend`;
  if (badge) {
    badge.innerText = remaining;
    badge.classList.toggle("hidden", remaining === 0);
  }

  container.innerHTML = "";

  currentPlaybackList.forEach((fileKey, idx) => {
    const fileName = path.basename(fileKey);
    const isCurrent = idx === currentIndex;
    const isPast = idx < currentIndex;

    const item = document.createElement("div");
    item.className = `queue-item ${isCurrent ? 'current-track' : ''}`;
    item.draggable = true;
    if (isPast) item.style.opacity = "0.5";

    const isVid = fileKey.match(/\.(mp4|mkv|webm|avi|mov|flv|ogv|m4v|ts|m2ts)$/i);
    const icon = isVid ? '🎬' : '🎵';

    item.innerHTML = `
      <div class="queue-drag-handle" title="Ziehen zum Umsortieren">⋮⋮</div>
      <div class="queue-item-idx">${idx + 1}</div>
      <div class="queue-item-thumb" style="display:flex; align-items:center; justify-content:center; font-size:16px;">${icon}</div>
      <div class="queue-item-info">
        <div class="queue-item-title" title="${fileName}">${fileName}</div>
        <div class="queue-item-sub">${isCurrent ? '▶ Aktuell läuft' : (isPast ? 'Bereits gespielt' : 'Wartet in Reihe')}</div>
      </div>
      <div style="display: flex; gap: 2px; align-items: center;" onclick="event.stopPropagation();">
        <button class="queue-move-btn" onclick="moveQueueItem(${idx}, -1)" title="Nach oben schieben" ${idx === 0 ? 'disabled style="opacity:0.2;"' : ''}>▲</button>
        <button class="queue-move-btn" onclick="moveQueueItem(${idx}, 1)" title="Nach unten schieben" ${idx === currentPlaybackList.length - 1 ? 'disabled style="opacity:0.2;"' : ''}>▼</button>
        <button class="queue-item-remove" title="Aus Warteschlange entfernen" onclick="removeQueueItem(${idx});">✕</button>
      </div>
    `;

    item.addEventListener("dragstart", (e) => {
      queueDragSrcIndex = idx;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", idx);
    });

    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("drag-over");
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("drag-over");
    });

    item.addEventListener("dragend", () => {
      document.querySelectorAll(".queue-item").forEach(el => el.classList.remove("dragging", "drag-over"));
      queueDragSrcIndex = null;
    });

    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drag-over");
      if (queueDragSrcIndex !== null && queueDragSrcIndex !== idx) {
        const movedItem = currentPlaybackList.splice(queueDragSrcIndex, 1)[0];
        currentPlaybackList.splice(idx, 0, movedItem);
        if (queueDragSrcIndex === currentIndex) {
          currentIndex = idx;
        } else if (queueDragSrcIndex < currentIndex && idx >= currentIndex) {
          currentIndex--;
        } else if (queueDragSrcIndex > currentIndex && idx <= currentIndex) {
          currentIndex++;
        }
        renderQueueDrawer();
        if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
      }
    });

    item.onclick = () => {
      currentIndex = idx;
      if (isVid) playVideo(fileKey);
      else playMusic(fileKey);
      renderQueueDrawer();
    };

    container.appendChild(item);
  });
};

window.removeQueueItem = function(idx) {
  if (!currentPlaybackList || idx < 0 || idx >= currentPlaybackList.length) return;
  currentPlaybackList.splice(idx, 1);
  if (idx < currentIndex) currentIndex--;
  renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
};

window.clearQueueList = function() {
  if (!currentPlaybackList || currentPlaybackList.length === 0) return;
  const currentItem = currentPlaybackList[currentIndex];
  currentPlaybackList = currentItem ? [currentItem] : [];
  currentIndex = 0;
  renderQueueDrawer();
  if (typeof renderMiniPlaylist === "function") renderMiniPlaylist();
  showVideoToast("🧹 Warteschlange geleert");
};

window.saveQueueAsPlaylist = function() {
  if (!currentPlaybackList || currentPlaybackList.length === 0) {
    alert("Die Warteschlange ist leer!");
    return;
  }
  const name = prompt("Name für die neue Playlist aus der Warteschlange:");
  if (!name || !name.trim()) return;

  const type = activeType === "video" ? "video" : "music";
  if (!playlists[type]) playlists[type] = {};
  playlists[type][name.trim()] = currentPlaybackList.map(p => toMediaKey(p));
  localStorage.setItem("playlists", JSON.stringify(playlists));
  showVideoToast(`💾 Playlist "${name}" erfolgreich gespeichert!`);
  if (typeof renderPlaylists === "function") renderPlaylists();
};

// ============================================================
// SCREENSHOTS & SNAPSHOTS GALLERY CONTROLLER
// ============================================================
window.openSnapshotsFolder = function() {
  const snapshotsDir = path.join(mediaBase, "snapshots");
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }
  shell.openPath(snapshotsDir);
};

window.copySnapshotToClipboard = function(fullPath) {
  try {
    const { nativeImage, clipboard } = require("electron");
    const img = nativeImage.createFromPath(fullPath);
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      showVideoToast("📋 Screenshot in Zwischenablage kopiert!");
    } else {
      showVideoToast("⚠️ Screenshot konnte nicht kopiert werden");
    }
  } catch (err) {
    console.error("Clipboard copy error:", err);
  }
};

window.deleteSnapshot = function(fullPath) {
  if (!confirm("Diesen Screenshot wirklich löschen?")) return;
  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      showVideoToast("🗑️ Screenshot gelöscht");
      window.loadSnapshotsGallery();
    }
  } catch (err) {
    console.error("Delete snapshot error:", err);
  }
};

window.loadSnapshotsGallery = function() {
  const grid = document.getElementById("snapshotsGalleryGrid");
  if (!grid) return;

  const snapshotsDir = path.join(mediaBase, "snapshots");
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }

  let files = [];
  try {
    files = fs.readdirSync(snapshotsDir)
      .filter(f => f.match(/\.(png|jpe?g|webp)$/i))
      .map(f => {
        const fullPath = path.join(snapshotsDir, f);
        const stat = fs.statSync(fullPath);
        return { name: f, fullPath, stat, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    console.error("Error reading snapshots:", err);
  }

  if (files.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <div style="font-size: 48px; margin-bottom: 14px; opacity: 0.5;">📸</div>
        <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">Noch keine Screenshots aufgenommen</div>
        <div style="font-size: 13px; max-width: 380px; margin: 0 auto; line-height: 1.5;">
          Spiele ein beliebiges Video ab und drücke die Taste <strong>S</strong> oder klicke auf das Kamera-Icon, um hochauflösende Screenshots zu erstellen!
        </div>
      </div>
    `;
    return;
  }

  grid.innerHTML = "";
  files.forEach(f => {
    const card = document.createElement("div");
    card.className = "snapshot-card";

    const dateStr = new Date(f.mtime).toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    const sizeKB = Math.round(f.size / 1024);
    const sizeStr = sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + " MB" : sizeKB + " KB";
    const fileUrl = toMediaKey(f.fullPath);

    card.innerHTML = `
      <div class="snapshot-thumb-wrapper" onclick="shell.openPath('${f.fullPath.replace(/\\/g, "\\\\")}')" title="Klicken zum Öffnen im Bildbetrachter">
        <img class="snapshot-thumb-img" src="${fileUrl}" alt="${f.name}" loading="lazy">
      </div>
      <div class="snapshot-card-info">
        <div class="snapshot-card-title" title="${f.name}">${f.name}</div>
        <div class="snapshot-card-meta">
          <span>📅 ${dateStr}</span>
          <span>💾 ${sizeStr}</span>
        </div>
      </div>
      <div class="snapshot-card-actions">
        <button class="snapshot-btn" onclick="copySnapshotToClipboard('${f.fullPath.replace(/\\/g, "\\\\")}')" title="In Zwischenablage kopieren">
          📋 Kopieren
        </button>
        <button class="snapshot-btn" onclick="shell.showItemInFolder('${f.fullPath.replace(/\\/g, "\\\\")}')" title="Im Explorer anzeigen">
          📁 Ordner
        </button>
        <button class="snapshot-btn danger" onclick="deleteSnapshot('${f.fullPath.replace(/\\/g, "\\\\")}')" title="Löschen">
          🗑️
        </button>
      </div>
    `;

    grid.appendChild(card);
  });
};

// ============================================================
// STUDIO EQUALIZER POP-UP MODAL CONTROLLER
// ============================================================
let mixerModalAnimId = null;

function syncEqHostAndButton() {
  const modal = document.getElementById("equalizerModal");
  const container = document.getElementById("videoMainContainer");
  const fsEqBtn = document.getElementById("fsEqBtn");
  const isOpen = Boolean(modal && !modal.classList.contains("hidden"));

  if (modal) {
    if (container && document.fullscreenElement === container) {
      if (modal.parentElement !== container) container.appendChild(modal);
    } else if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
  }
  if (fsEqBtn) {
    fsEqBtn.classList.toggle("active", isOpen);
  }
}

function clampEqWindowToBounds(winEl) {
  if (!winEl || winEl.dataset.dragged !== "1") return;
  const rect = winEl.getBoundingClientRect();
  const w = rect.width || winEl.offsetWidth || 880;
  const minLeft = -(w - 120);
  const maxLeft = Math.max(0, window.innerWidth - 120);
  const minTop = document.fullscreenElement ? 0 : 36;
  const maxTop = Math.max(minTop, window.innerHeight - 48);

  const curLeft = parseFloat(winEl.style.left);
  const curTop = parseFloat(winEl.style.top);
  if (!isNaN(curLeft)) {
    winEl.style.left = Math.max(minLeft, Math.min(maxLeft, curLeft)) + "px";
  }
  if (!isNaN(curTop)) {
    winEl.style.top = Math.max(minTop, Math.min(maxTop, curTop)) + "px";
  }
}

window.clampEqualizerModalPosition = function() {
  const win = document.getElementById("equalizerModalWindow");
  if (win) clampEqWindowToBounds(win);
};

function initDraggableEqualizerModal() {
  const win = document.getElementById("equalizerModalWindow");
  const header = document.getElementById("equalizerModalHeader");
  if (!win || !header || header.dataset.dragInit === "1") return;
  header.dataset.dragInit = "1";

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, select, input, canvas, option")) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = win.getBoundingClientRect();
    win.style.transform = "none";
    win.style.left = rect.left + "px";
    win.style.top = rect.top + "px";
    win.dataset.dragged = "1";

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const rect = win.getBoundingClientRect();
    const w = rect.width || win.offsetWidth || 880;
    const minLeft = -(w - 120);
    const maxLeft = Math.max(0, window.innerWidth - 120);
    const minTop = document.fullscreenElement ? 0 : 36;
    const maxTop = Math.max(minTop, window.innerHeight - 48);

    win.style.left = Math.max(minLeft, Math.min(maxLeft, origLeft + dx)) + "px";
    win.style.top = Math.max(minTop, Math.min(maxTop, origTop + dy)) + "px";
    if (typeof window.wakeFullscreenHud === "function") window.wakeFullscreenHud();
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.style.userSelect = "";
  });

  window.addEventListener("resize", () => {
    clampEqWindowToBounds(win);
  });
}

window.openEqualizerModal = function() {
  const modal = document.getElementById("equalizerModal");
  if (!modal) return;

  if (typeof videoMenu !== "undefined" && videoMenu) {
    videoMenu.classList.remove("show");
  }

  if (!modal.classList.contains("hidden")) {
    window.closeEqualizerModal();
    return;
  }

  modal.classList.remove("hidden");
  syncEqHostAndButton();
  initDraggableEqualizerModal();
  const win = document.getElementById("equalizerModalWindow");
  if (win) clampEqWindowToBounds(win);
  if (typeof window.wakeFullscreenHud === "function") window.wakeFullscreenHud();

  syncEqualizerModalValues();
  startEqualizerModalVUMeter();
};

window.closeEqualizerModal = function() {
  const modal = document.getElementById("equalizerModal");
  if (modal) modal.classList.add("hidden");
  syncEqHostAndButton();
  if (mixerModalAnimId) {
    cancelAnimationFrame(mixerModalAnimId);
    mixerModalAnimId = null;
  }
  if (typeof window.wakeFullscreenHud === "function") window.wakeFullscreenHud();
};

function syncEqualizerModalValues() {
  const preampSlider = document.getElementById("eqModalPreamp");
  const preampVal = document.getElementById("eqModalPreampVal");
  const mainPreampSlider = document.getElementById("mixerPreamp");
  const currentPreamp = mainPreampSlider ? parseFloat(mainPreampSlider.value) : 0;
  if (preampSlider) preampSlider.value = currentPreamp;
  if (preampVal) preampVal.innerText = (currentPreamp > 0 ? "+" : "") + currentPreamp.toFixed(1) + " dB";

  const panSlider = document.getElementById("eqModalPan");
  const panVal = document.getElementById("eqModalPanVal");
  const mainPanSlider = document.getElementById("mixerPan");
  const currentPan = mainPanSlider ? parseFloat(mainPanSlider.value) : 0;
  if (panSlider) panSlider.value = currentPan;
  if (panVal) {
    if (currentPan === 0) panVal.innerText = "Mitte";
    else if (currentPan < 0) panVal.innerText = Math.round(Math.abs(currentPan) * 100) + "% L";
    else panVal.innerText = Math.round(currentPan * 100) + "% R";
  }

  const muteBtn = document.getElementById("eqModalMute");
  const muteLed = document.getElementById("eqModalMuteLed");
  if (muteBtn && muteLed) {
    muteBtn.classList.toggle("active", Boolean(isMixerMuted));
    muteLed.className = "eq-led " + (isMixerMuted ? "lit-red" : "");
  }
  const lcBtn = document.getElementById("eqModalLowCut");
  const lcLed = document.getElementById("eqModalLcLed");
  if (lcBtn && lcLed) {
    lcBtn.classList.toggle("active", Boolean(isLowCutActive));
    lcLed.className = "eq-led " + (isLowCutActive ? "lit-blue" : "");
  }

  for (let i = 0; i < 5; i++) {
    const sl = document.getElementById(`eqModalSlider-${i}`);
    const vl = document.getElementById(`eqModalVal-${i}`);
    const mainSl = document.getElementById(`eqSlider-${i}`);
    const val = mainSl ? parseFloat(mainSl.value) : (typeof musicFilters !== "undefined" && musicFilters[i] ? musicFilters[i].gain.value : 0);
    if (sl) sl.value = val;
    if (vl) vl.innerText = (val > 0 ? "+" : "") + val + " dB";
  }
}

window.onEqModalPanInput = function(val) {
  val = parseFloat(val);
  const panVal = document.getElementById("eqModalPanVal");
  if (panVal) {
    if (val === 0) panVal.innerText = "Mitte";
    else if (val < 0) panVal.innerText = Math.round(Math.abs(val) * 100) + "% L";
    else panVal.innerText = Math.round(val * 100) + "% R";
  }
  if (typeof musicPanner !== "undefined" && musicPanner) musicPanner.pan.value = val;
  if (typeof videoPanner !== "undefined" && videoPanner) videoPanner.pan.value = val;
  const mainPan = document.getElementById("mixerPan");
  const mainPanVal = document.getElementById("mixerPanVal");
  if (mainPan) mainPan.value = val;
  if (mainPanVal) mainPanVal.innerText = panVal ? panVal.innerText : "Mitte";
};

window.onEqModalPreampInput = function(val) {
  val = parseFloat(val);
  const preampVal = document.getElementById("eqModalPreampVal");
  if (preampVal) preampVal.innerText = (val > 0 ? "+" : "") + val.toFixed(1) + " dB";
  const amplitude = Math.pow(10, val / 20);
  if (!isMixerMuted) {
    if (typeof musicPreamp !== "undefined" && musicPreamp) musicPreamp.gain.value = amplitude;
    if (typeof videoPreamp !== "undefined" && videoPreamp) videoPreamp.gain.value = amplitude;
  } else {
    previousPreampGain = amplitude;
  }
  const mainPreamp = document.getElementById("mixerPreamp");
  const mainPreampVal = document.getElementById("mixerPreampVal");
  if (mainPreamp) mainPreamp.value = val;
  if (mainPreampVal) mainPreampVal.innerText = preampVal ? preampVal.innerText : "0.0 dB";
};

window.onEqModalBandInput = function(idx, val) {
  val = parseFloat(val);
  const vl = document.getElementById(`eqModalVal-${idx}`);
  if (vl) vl.innerText = (val > 0 ? "+" : "") + val + " dB";
  if (typeof musicFilters !== "undefined" && musicFilters[idx]) musicFilters[idx].gain.value = val;
  if (typeof videoFilters !== "undefined" && videoFilters[idx]) videoFilters[idx].gain.value = val;
  const mainSl = document.getElementById(`eqSlider-${idx}`);
  const mainVl = document.getElementById(`eqVal-${idx}`);
  if (mainSl) mainSl.value = val;
  if (mainVl) mainVl.innerText = (val > 0 ? "+" : "") + val + " dB";
};

window.applyEqPresetFromModal = function(name) {
  const presets = {
    flat: [0, 0, 0, 0, 0],
    bassboost: [6, 4, 1, -1, -2],
    vocalboost: [-2, 1, 4, 3, 0],
    rock: [5, 2, -1, 3, 5],
    pop: [-1, 2, 5, 2, -1],
    classical: [4, 2, 0, 2, 4],
    boost: [4, 4, 4, 4, 4]
  };
  const gains = presets[name] || presets.flat;
  for (let i = 0; i < 5; i++) {
    window.onEqModalBandInput(i, gains[i]);
    const sl = document.getElementById(`eqModalSlider-${i}`);
    if (sl) sl.value = gains[i];
  }
};

window.resetEqualizerModalSettings = function() {
  window.applyEqPresetFromModal("flat");
  window.onEqModalPreampInput(0);
  const prSl = document.getElementById("eqModalPreamp");
  if (prSl) prSl.value = 0;
  window.onEqModalPanInput(0);
  const panSl = document.getElementById("eqModalPan");
  if (panSl) panSl.value = 0;
  const sel = document.getElementById("eqModalPresets");
  if (sel) sel.value = "flat";
  showVideoToast("🎚️ Equalizer auf Standard zurückgesetzt");
};

function startEqualizerModalVUMeter() {
  const canvas = document.getElementById("mixerModalVUMeter");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  
  function draw() {
    const modal = document.getElementById("equalizerModal");
    if (!modal || modal.classList.contains("hidden")) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const activePlayer = activeType === "video" ? videoPlayer : player;
    let levelL = 0;
    let levelR = 0;

    if (activePlayer && !activePlayer.paused && typeof musicAnalyser !== "undefined" && musicAnalyser) {
      const data = new Uint8Array(musicAnalyser.frequencyBinCount);
      musicAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      levelL = Math.min(1, (avg / 128) * 1.2);
      levelR = Math.min(1, levelL * (0.9 + Math.random() * 0.2));
    }

    const w = canvas.width;
    const h = canvas.height;
    const barH = (h - 2) / 2;

    const gradL = ctx.createLinearGradient(0, 0, w, 0);
    gradL.addColorStop(0, "#1db954");
    gradL.addColorStop(0.7, "#fbbf24");
    gradL.addColorStop(1, "#ff4444");

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, 0, w, barH);
    ctx.fillRect(0, barH + 2, w, barH);

    ctx.fillStyle = gradL;
    ctx.fillRect(0, 0, w * levelL, barH);
    ctx.fillRect(0, barH + 2, w * levelR, barH);

    mixerModalAnimId = requestAnimationFrame(draw);
  }

  if (mixerModalAnimId) cancelAnimationFrame(mixerModalAnimId);
  mixerModalAnimId = requestAnimationFrame(draw);
}

// ============================================================
// PHASE 1: HARDWARE MEDIA KEYS & OS FILE-ASSOCIATION LISTENER
// ============================================================
ipcRenderer.on("media-play-pause", () => {
  const pBtn = document.getElementById("playBtn");
  if (pBtn) pBtn.click();
});

ipcRenderer.on("media-next", () => {
  const nBtn = document.getElementById("nextBtn");
  if (nBtn) nBtn.click();
});

ipcRenderer.on("media-prev", () => {
  const pBtn = document.getElementById("prevBtn");
  if (pBtn) {
    pBtn.click();
  } else if (typeof handleMediaPrevious === "function") {
    handleMediaPrevious();
  }
});

ipcRenderer.on("open-file", (event, filePath) => {
  if (filePath && typeof playMediaFile === "function") {
    playMediaFile(filePath);
    showVideoToast(`📂 Geöffnet: ${path.basename(filePath)}`);
  }
});

// ============================================================
// PHASE 1: MAUSRAD-LAUTSTÄRKEREGELUNG
// ============================================================
function initVolumeWheelControl() {
  const volBox = document.querySelector(".volumeBox");
  if (!volBox) return;

  volBox.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    const volSlider = document.getElementById("volume");
    if (!volSlider) return;

    const currentVol = parseFloat(volSlider.value);
    const newVol = Math.max(0, Math.min(1.5, Math.round((currentVol + delta) * 100) / 100));
    volSlider.value = newVol;
    volSlider.dispatchEvent(new Event("input"));
  }, { passive: false });
}

// ============================================================
// PHASE 3: GLOBAL DRAG & DROP FILE IMPORT (Electron & Tauri)
// ============================================================
let globalDragCounter = 0;
const globalDropOverlay = document.getElementById("globalDropOverlay");

async function handleDroppedNativePaths(droppedPaths, isFromImportModal = false) {
  if (!Array.isArray(droppedPaths) || droppedPaths.length === 0) return;

  const validPlayable = [];
  const mkvFiles = [];
  const otherPlayable = [];
  const foldersToLink = [];

  for (const p of droppedPaths) {
    if (!p) continue;
    try {
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) {
        foldersToLink.push(p);
      } else {
        const ext = path.extname(p).toLowerCase();
        if (IMPORT_VIDEO_EXTS.has(ext) || IMPORT_AUDIO_EXTS.has(ext)) {
          validPlayable.push(p);
          if (ext === ".mkv" && !p.includes("_FEHLER")) {
            mkvFiles.push(p);
          } else {
            otherPlayable.push(p);
          }
        }
      }
    } catch (err) {}
  }

  if (validPlayable.length === 0 && foldersToLink.length === 0) {
    if (typeof showVideoToast === "function") {
      showVideoToast("⚠️ Keine unterstützten Video- oder Audio-Dateien erkannt.");
    }
    return;
  }

  const allTargets = [...foldersToLink, ...validPlayable];
  const res = await importFilePathsBatch(allTargets, isFromImportModal ? null : "link");

  if (!isFromImportModal) {
    if (otherPlayable.length > 0) {
      if (typeof playMediaFile === "function") {
        playMediaFile(otherPlayable[0]);
      }
      if (otherPlayable.length > 1) {
        if (!currentPlaybackList) currentPlaybackList = [];
        otherPlayable.slice(1).forEach(p => {
          if (!currentPlaybackList.includes(p)) currentPlaybackList.push(p);
        });
        if (typeof renderQueueDrawer === "function") renderQueueDrawer();
      }
    } else if ((mkvFiles.length > 0 || (res && res.queuedMkv > 0)) && foldersToLink.length === 0) {
      const convertModalEl = document.getElementById("convertModal");
      if (convertModalEl && convertModalEl.classList.contains("hidden")) {
        convertModalEl.classList.remove("hidden");
        if (typeof syncKeepOriginalMkvUI === "function") syncKeepOriginalMkvUI();
        if (typeof updateConvertUI === "function") updateConvertUI();
      }
    }
  }
}

window.__onTauriDragDrop = async function(ev) {
  if (!ev || !ev.type) return;
  const convertModalEl = document.getElementById("convertModal");
  const isConvertModalOpen = Boolean(convertModalEl && !convertModalEl.classList.contains("hidden"));

  if (ev.type === "enter" || ev.type === "over") {
    if (isConvertModalOpen) {
      if (typeof setImportDropZoneHighlight === "function") setImportDropZoneHighlight(true);
    } else if (globalDropOverlay) {
      globalDropOverlay.classList.remove("hidden");
    }
  } else if (ev.type === "leave") {
    if (typeof setImportDropZoneHighlight === "function") setImportDropZoneHighlight(false);
    if (globalDropOverlay) globalDropOverlay.classList.add("hidden");
  } else if (ev.type === "drop") {
    if (typeof setImportDropZoneHighlight === "function") setImportDropZoneHighlight(false);
    if (globalDropOverlay) globalDropOverlay.classList.add("hidden");
    const paths = Array.isArray(ev.paths) ? ev.paths : [];
    if (paths.length > 0) {
      await handleDroppedNativePaths(paths, isConvertModalOpen);
    }
  }
};

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  globalDragCounter++;
  if (globalDropOverlay && e.dataTransfer.types && e.dataTransfer.types.includes("Files")) {
    globalDropOverlay.classList.remove("hidden");
  }
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  globalDragCounter--;
  if (globalDragCounter <= 0 && globalDropOverlay) {
    globalDragCounter = 0;
    globalDropOverlay.classList.add("hidden");
  }
});

window.addEventListener("drop", async (e) => {
  e.preventDefault();
  globalDragCounter = 0;
  if (globalDropOverlay) globalDropOverlay.classList.add("hidden");

  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;

  const droppedPaths = files.map(f => window.getNativeFilePath(f)).filter(Boolean);
  if (droppedPaths.length === 0) return;

  await handleDroppedNativePaths(droppedPaths, false);
});

// Initial calls on app start
initMainSidebar();
if (typeof BgTaskManager !== "undefined") BgTaskManager.init();
initScrubberHoverPreview();
initVolumeWheelControl();
initAlwaysOnTopSetting();
updateVideoControls();
if (typeof renderDynamicTagChips === "function") renderDynamicTagChips();

// ============================================================
// LIVE STREAMS CONTROLLER (TWITCH & YOUTUBE LIVE)
// ============================================================
const STREAM_BRIDGE_PORT = 45678;
let currentStreamPlatform = 'twitch';
let currentActiveStream = null;
let rendererBridgeServer = null;

// DIAGNOSTICS & LOGGING SYSTEM
let streamLogs = [];
const MAX_STREAM_LOGS = 100;

function addStreamLog(level, tag, message) {
  const cleanTag = tag || 'SYSTEM';
  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) return;

  // Verhindere sich wiederholende Spam-Einträge: Nur bei echten Änderungen loggen!
  if (streamLogs.length > 0) {
    const last = streamLogs[streamLogs.length - 1];
    if (last.tag === cleanTag && last.message === cleanMsg) {
      return; // Keine Änderung -> nichts doppelt protokollieren
    }
  }

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const entry = {
    id: Date.now() + Math.random(),
    time: timeStr,
    level: level || 'info', // 'info' | 'start' | 'ok' | 'warn' | 'err'
    tag: cleanTag,
    message: cleanMsg
  };

  streamLogs.push(entry);
  if (streamLogs.length > MAX_STREAM_LOGS) {
    streamLogs.shift();
  }

  renderStreamLogs();
}
window.addStreamLog = addStreamLog;

function renderStreamLogs() {
  const listEl = document.getElementById("streamLogList");
  const counterEl = document.getElementById("streamLogCounter");
  if (!listEl) return;

  if (counterEl) {
    counterEl.textContent = `${streamLogs.length} Ereignisse`;
  }

  if (streamLogs.length === 0) {
    listEl.innerHTML = `<div style="color: #666; font-style: italic;">Noch keine Protokolleinträge. Starte einen Stream, um Vorgänge und Diagnosedaten live zu verfolgen.</div>`;
    return;
  }

  listEl.innerHTML = streamLogs.map(log => {
    return `<div class="stream-log-row ${log.level}">
      <span class="stream-log-time">${log.time}</span>
      <span class="stream-log-badge ${log.level}">[${escapeStreamHtml(log.tag)}]</span>
      <span class="stream-log-msg">${escapeStreamHtml(log.message)}</span>
    </div>`;
  }).join("");

  listEl.scrollTop = listEl.scrollHeight;
}
window.renderStreamLogs = renderStreamLogs;

window.clearStreamLogs = function() {
  streamLogs = [];
  renderStreamLogs();
  showVideoToast("🗑 Diagnose-Logs geleert");
};

window.copyStreamLogs = function() {
  if (streamLogs.length === 0) {
    showVideoToast("Keine Logs zum Kopieren");
    return;
  }
  const text = streamLogs.map(l => `[${l.time}] [${l.tag}] ${l.message}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    showVideoToast("📋 Logs in Zwischenablage kopiert!");
  }).catch(() => {
    showVideoToast("Fehler beim Kopieren");
  });
};

window.toggleStreamLogCollapse = function() {
  const box = document.getElementById("streamLogBox");
  const btn = document.getElementById("streamLogToggleBtn");
  if (!box) return;
  const isCollapsed = box.classList.toggle("collapsed");
  if (btn) btn.textContent = isCollapsed ? "▲ Ausklappen" : "▼ Einklappen";
};

// STREAM VERLAUF / HISTORY SYSTEM
function getStreamHistory() {
  try {
    const raw = localStorage.getItem("streamHistory");
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveStreamHistory(list) {
  try {
    localStorage.setItem("streamHistory", JSON.stringify(list.slice(0, 30)));
  } catch (e) {
    console.error("Fehler beim Speichern des Stream-Verlaufs:", e);
  }
}

function addStreamToHistory(streamObj) {
  if (!streamObj || !streamObj.id) return;
  const history = getStreamHistory();
  const filtered = history.filter(h => !(h.platform === streamObj.platform && h.id.toLowerCase() === streamObj.id.toLowerCase()));
  const now = new Date();
  const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  
  filtered.unshift({
    platform: streamObj.platform,
    id: streamObj.id,
    name: streamObj.name || streamObj.id,
    date: dateStr,
    timestamp: Date.now()
  });

  saveStreamHistory(filtered);
  renderStreamHistory();
}

window.clearStreamHistory = function() {
  localStorage.removeItem("streamHistory");
  renderStreamHistory();
  addStreamLog("info", "VERLAUF", "Stream-Verlauf wurde geleert");
  showVideoToast("🗑 Stream-Verlauf geleert");
};

window.deleteStreamHistoryItem = function(index) {
  const history = getStreamHistory();
  if (index >= 0 && index < history.length) {
    const removed = history.splice(index, 1);
    saveStreamHistory(history);
    renderStreamHistory();
    addStreamLog("info", "VERLAUF", `Stream "${removed[0]?.name || 'Unbekannt'}" aus Verlauf entfernt`);
  }
};

window.renderStreamHistory = function() {
  const grid = document.getElementById("streamHistoryGrid");
  const empty = document.getElementById("streamHistoryEmpty");
  if (!grid) return;

  const history = getStreamHistory();
  grid.innerHTML = "";
  if (history.length === 0) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");

  history.forEach((item, idx) => {
    const isTwitch = item.platform === "twitch";
    const card = document.createElement("div");
    card.className = "stream-card";
    const bannerGradient = isTwitch ? "linear-gradient(135deg, #772ce8 0%, #20093b 100%)" : "linear-gradient(135deg, #cc0000 0%, #3d0000 100%)";
    const badgeClass = isTwitch ? "stream-badge-twitch" : "stream-badge-youtube";
    const initial = (item.name || item.id).charAt(0).toUpperCase();

    card.innerHTML = `
      <div class="stream-card-banner" style="background: ${bannerGradient};">
        <span class="${badgeClass}">${isTwitch ? 'TWITCH' : 'YOUTUBE'}</span>
        <div class="stream-card-avatar-wrap">
          <span>${initial}</span>
        </div>
      </div>
      <div class="stream-card-body">
        <div>
          <div class="stream-card-name" title="${escapeStreamHtml(item.name)}">${escapeStreamHtml(item.name)}</div>
          <div class="stream-card-desc">Geschaut am ${escapeStreamHtml(item.date)}</div>
        </div>
        <div class="stream-card-footer">
          <span style="color: var(--accent); font-weight: bold;">▶ Erneut starten</span>
          <button class="stream-card-del-btn" title="Aus Verlauf entfernen" onclick="event.stopPropagation(); deleteStreamHistoryItem(${idx})">✕</button>
        </div>
      </div>
    `;
    card.onclick = () => window.playStreamPreset(item.platform, item.id, item.name);
    grid.appendChild(card);
  });
};

// STREAM BRIDGE SERVER (Fallback direkt im Renderer)
function ensureStreamBridgeServer() {
  if (rendererBridgeServer) return;
  try {
    rendererBridgeServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${STREAM_BRIDGE_PORT}`);
      const pathname = parsedUrl.pathname;
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (pathname === '/twitch') {
        const channel = parsedUrl.searchParams.get('channel') || '';
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Twitch Stream</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  </style>
</head>
<body>
  <iframe src="https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=127.0.0.1&parent=localhost&autoplay=true&muted=false" allow="autoplay; fullscreen" allowfullscreen></iframe>
  <script>
    var twitchSignaled = false;
    window.addEventListener('message', function(e) {
      try {
        if (!twitchSignaled && e.origin && e.origin.includes('twitch.tv')) {
          twitchSignaled = true;
          window.parent.postMessage({ type: 'stream-diag', level: 'ok', tag: 'TWITCH', msg: 'Twitch Player Signal empfangen' }, '*');
        }
      } catch(err) {}
    });
  </script>
</body>
</html>`);
      } else if (pathname === '/twitch-chat') {
        const channel = parsedUrl.searchParams.get('channel') || '';
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Twitch Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #18181b; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  </style>
</head>
<body>
  <iframe src="https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat?parent=127.0.0.1&parent=localhost&darkpopout" allow="autoplay; fullscreen" allowfullscreen></iframe>
</body>
</html>`);
      } else if (pathname === '/youtube') {
        const videoId = parsedUrl.searchParams.get('v') || '';
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YouTube Live</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  </style>
</head>
<body>
  <iframe id="ytFrame" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&enablejsapi=1&rel=0&modestbranding=1" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
  <script>
    window.addEventListener('message', function(e) {
      try {
        var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d && d.event === 'onError') {
          window.parent.postMessage({ type: 'stream-diag', level: 'err', tag: 'YOUTUBE', msg: 'YouTube meldet Fehlercode: ' + d.info }, '*');
        } else if (d && d.event === 'onReady') {
          window.parent.postMessage({ type: 'stream-diag', level: 'ok', tag: 'YOUTUBE', msg: 'YouTube Player bereit und initialisiert' }, '*');
        }
      } catch(err) {}
    });
  </script>
</body>
</html>`);
      } else if (pathname === '/youtube-chat') {
        const videoId = parsedUrl.searchParams.get('v') || '';
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YouTube Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0f0f0f; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  </style>
</head>
<body>
  <iframe src="https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&embed_domain=127.0.0.1" allow="autoplay; fullscreen" allowfullscreen></iframe>
</body>
</html>`);
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });

    rendererBridgeServer.listen(STREAM_BRIDGE_PORT, '127.0.0.1', () => {
      addStreamLog("ok", "BRIDGE", `Stream-Bridge Server aktiv auf http://127.0.0.1:${STREAM_BRIDGE_PORT}`);
    });

    rendererBridgeServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        addStreamLog("warn", "BRIDGE", `Bridge-Hinweis: ${err.message}`);
      } else {
        addStreamLog("ok", "BRIDGE", `Stream-Bridge Port ${STREAM_BRIDGE_PORT} aktiv und verbunden`);
      }
    });
  } catch (e) {
    addStreamLog("warn", "BRIDGE", `Bridge-Init: ${e.message}`);
  }
}
ensureStreamBridgeServer();

// Global listener for diagnostic events from stream embeds
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'stream-diag') {
    addStreamLog(e.data.level, e.data.tag, e.data.msg);
    if (e.data.level === 'err') {
      showVideoToast(`⚠️ ${e.data.msg}`);
    }
  }
});

function escapeStreamHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Presets for popular and 24/7 channels
const STREAM_PRESETS = [
  {
    platform: 'twitch',
    id: 'papaplatte',
    name: 'Papaplatte',
    desc: 'Just Chatting, Gaming, Events & Entertainment',
    banner: 'linear-gradient(135deg, #9146ff 0%, #451093 100%)',
    avatar: 'P'
  },
  {
    platform: 'twitch',
    id: 'shroud',
    name: 'Shroud',
    desc: 'FPS Legend, High-Skill Gameplay & Variety',
    banner: 'linear-gradient(135deg, #1f6feb 0%, #0d274d 100%)',
    avatar: 'S'
  },
  {
    platform: 'twitch',
    id: 'eliasn97',
    name: 'EliasN97',
    desc: 'FIFA, Gaming, Talk & Community Events',
    banner: 'linear-gradient(135deg, #d32f2f 0%, #5d0909 100%)',
    avatar: 'E'
  },
  {
    platform: 'twitch',
    id: 'trymacs',
    name: 'Trymacs',
    desc: 'Entertainment, Reacts, Gaming & Community',
    banner: 'linear-gradient(135deg, #ff9800 0%, #7c3a00 100%)',
    avatar: 'T'
  },
  {
    platform: 'twitch',
    id: 'eslcs',
    name: 'ESL Counter-Strike',
    desc: '24/7 CS Pro League & Esports Broadcasts',
    banner: 'linear-gradient(135deg, #00b0ff 0%, #003e6b 100%)',
    avatar: 'CS'
  },
  {
    platform: 'youtube',
    id: 'jfKfPfyJRdk',
    name: 'Lofi Girl',
    desc: '24/7 lofi hip hop radio - beats to relax/study to',
    banner: 'linear-gradient(135deg, #e91e63 0%, #4a0e23 100%)',
    avatar: '☕'
  },
  {
    platform: 'youtube',
    id: '5yx6BWlEVcY',
    name: 'Chillhop Radio',
    desc: '24/7 jazzy & lofi hip hop beats',
    banner: 'linear-gradient(135deg, #009688 0%, #003833 100%)',
    avatar: '🦝'
  },
  {
    platform: 'youtube',
    id: '7NOSDKb0HlU',
    name: 'Monstercat 24/7',
    desc: 'Non-stop Electronic Music, Gaming Soundtracks',
    banner: 'linear-gradient(135deg, #00bcd4 0%, #004d40 100%)',
    avatar: '🐱'
  },
  {
    platform: 'youtube',
    id: '21X5lGlDOfg',
    name: 'NASA Live Stream',
    desc: 'Official Stream of Earth from Space (ISS Views)',
    banner: 'linear-gradient(135deg, #3f51b5 0%, #1a237e 100%)',
    avatar: '🚀'
  }
];

function getStreamFavorites() {
  try {
    const raw = localStorage.getItem("streamFavorites");
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveStreamFavorites(list) {
  try {
    localStorage.setItem("streamFavorites", JSON.stringify(list));
  } catch (e) {
    console.error("Fehler beim Speichern der Stream-Favoriten:", e);
  }
}

window.selectStreamPlatform = function(platform) {
  currentStreamPlatform = platform;
  const pfTwitch = document.getElementById("pfTwitch");
  const pfYoutube = document.getElementById("pfYoutube");
  const input = document.getElementById("streamUrlInput");
  if (platform === "twitch") {
    pfTwitch?.classList.add("active");
    pfYoutube?.classList.remove("active");
    if (input) input.placeholder = "Twitch-Kanal (z. B. shroud, papaplatte, eliasn97) eingeben...";
    addStreamLog("info", "PLATTFORM", "Plattform auf Twitch umgestellt");
  } else {
    pfYoutube?.classList.add("active");
    pfTwitch?.classList.remove("active");
    if (input) input.placeholder = "YouTube Live-URL oder Video-ID (z. B. https://youtube.com/watch?v=...)...";
    addStreamLog("info", "PLATTFORM", "Plattform auf YouTube Live umgestellt");
  }
};

function parseTwitchChannel(input) {
  if (!input) return "";
  let clean = input.trim();
  clean = clean.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, "");
  clean = clean.replace(/^@/, "");
  clean = clean.split("/")[0].split("?")[0].trim().toLowerCase();
  return clean;
}

function parseYoutubeVideoId(input) {
  if (!input) return "";
  let clean = input.trim();
  const vMatch = clean.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch && vMatch[1]) return vMatch[1];
  const shortMatch = clean.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch && shortMatch[1]) return shortMatch[1];
  const liveMatch = clean.match(/\/live\/([a-zA-Z0-9_-]{11})/);
  if (liveMatch && liveMatch[1]) return liveMatch[1];
  const embedMatch = clean.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch && embedMatch[1]) return embedMatch[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  return clean;
}

window.startStreamPlayback = function(customInput, customPlatform) {
  const platform = customPlatform || currentStreamPlatform;
  const inputVal = customInput || document.getElementById("streamUrlInput")?.value || "";

  if (!inputVal.trim()) {
    showVideoToast("⚠️ Bitte gib einen Kanalnamen oder eine URL ein!");
    addStreamLog("warn", "INPUT", "Wiedergabe abgebrochen: Kein Kanalname / keine URL eingegeben");
    return;
  }

  // Stoppe lokale Musik / Video, damit Ton nicht überlappt
  if (audioPlayer && !audioPlayer.paused) {
    audioPlayer.pause();
    updatePlayButton();
    addStreamLog("info", "AUDIO", "Lokale Musik pausiert für Stream-Wiedergabe");
  }
  if (videoPlayer && !videoPlayer.paused) {
    videoPlayer.pause();
    updatePlayButton();
    addStreamLog("info", "VIDEO", "Lokales Video pausiert für Stream-Wiedergabe");
  }

  let embedUrl = "";
  let chatUrl = "";
  let displayName = "";
  const isTauriHttps = Boolean(
    window.__tauriRuntime &&
    window.location &&
    window.location.protocol === "https:" &&
    window.location.hostname === "tauri.localhost"
  );

  if (platform === "twitch") {
    const channel = parseTwitchChannel(inputVal);
    if (!channel) {
      showVideoToast("⚠️ Ungültiger Twitch-Kanal!");
      addStreamLog("err", "TWITCH", `Ungültiger Kanalname: "${inputVal}"`);
      return;
    }
    displayName = channel;
    if (isTauriHttps) {
      embedUrl = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=tauri.localhost&autoplay=true&muted=false`;
      chatUrl = `https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat?parent=tauri.localhost&darkpopout`;
    } else {
      embedUrl = `http://127.0.0.1:${STREAM_BRIDGE_PORT}/twitch?channel=${encodeURIComponent(channel)}`;
      chatUrl = `http://127.0.0.1:${STREAM_BRIDGE_PORT}/twitch-chat?channel=${encodeURIComponent(channel)}`;
    }
    currentActiveStream = { platform: 'twitch', id: channel, name: channel };
    addStreamLog("start", "TWITCH", `Starte Twitch-Stream für Kanal: "${channel}"`);
  } else {
    const videoId = parseYoutubeVideoId(inputVal);
    if (!videoId) {
      showVideoToast("⚠️ Ungültige YouTube-URL oder ID!");
      addStreamLog("err", "YOUTUBE", `Ungültige YouTube-Eingabe: "${inputVal}"`);
      return;
    }
    displayName = customInput && customInput === inputVal ? inputVal : `YouTube (${videoId})`;
    if (isTauriHttps) {
      embedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&enablejsapi=1&rel=0&modestbranding=1`;
      chatUrl = `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&embed_domain=tauri.localhost`;
    } else {
      embedUrl = `http://127.0.0.1:${STREAM_BRIDGE_PORT}/youtube?v=${encodeURIComponent(videoId)}`;
      chatUrl = `http://127.0.0.1:${STREAM_BRIDGE_PORT}/youtube-chat?v=${encodeURIComponent(videoId)}`;
    }
    currentActiveStream = { platform: 'youtube', id: videoId, name: displayName };
    addStreamLog("start", "YOUTUBE", `Starte YouTube Live-Stream für Video-ID: "${videoId}"`);
  }

  const stage = document.getElementById("streamStageContainer");
  const iframe = document.getElementById("streamIframe");
  const chatIframe = document.getElementById("streamChatIframe");
  const stageName = document.getElementById("streamStageChannelName");
  const badge = document.getElementById("streamStagePlatformBadge");
  const activeBadge = document.getElementById("activeStreamBadge");
  const activeTitle = document.getElementById("activeStreamTitle");

  if (stageName) stageName.textContent = displayName;

  if (badge) {
    badge.className = platform === "twitch" ? "stream-badge-twitch" : "stream-badge-youtube";
    badge.textContent = platform === "twitch" ? "TWITCH" : "YOUTUBE";
  }

  if (activeBadge) activeBadge.classList.remove("hidden");
  if (activeTitle) activeTitle.textContent = displayName;
  if (stage) stage.classList.remove("hidden");

  // Hook loading diagnostics
  if (iframe) {
    addStreamLog("info", "LOAD", `Lade Stream-URL in Player-Frame...`);
    iframe.onload = () => {
      addStreamLog("ok", "LOAD", `Player-Frame erfolgreich geladen`);
    };
    iframe.onerror = (e) => {
      addStreamLog("err", "LOAD", `Fehler im Player-Frame: ${e}`);
    };
    iframe.src = embedUrl;
  }

  if (chatIframe) {
    addStreamLog("info", "CHAT", `Verbinde mit Live-Chat...`);
    chatIframe.onload = () => {
      addStreamLog("ok", "CHAT", `Live-Chat erfolgreich verbunden`);
    };
    chatIframe.onerror = (e) => {
      addStreamLog("warn", "CHAT", `Chat-Ladehinweis: ${e}`);
    };
    chatIframe.src = chatUrl;
  }

  addStreamToHistory(currentActiveStream);

  const mainEl = document.querySelector(".main");
  if (mainEl && stage) {
    mainEl.scrollTo({ top: Math.max(0, stage.offsetTop - 15), behavior: "smooth" });
  }
  if (window.scrollY > 0) {
    window.scrollTo(0, 0);
  }
  showVideoToast(`🔴 Starte Stream: ${displayName}`);
};

window.openCurrentStreamInBrowser = function() {
  if (!currentActiveStream || !currentActiveStream.id) {
    showVideoToast("⚠️ Kein aktiver Stream ausgewählt!");
    addStreamLog("warn", "BROWSER", "Öffnen im Browser abgebrochen: Kein aktiver Stream");
    return;
  }
  let targetUrl = "";
  if (currentActiveStream.platform === "twitch") {
    targetUrl = `https://www.twitch.tv/${encodeURIComponent(currentActiveStream.id)}`;
  } else {
    targetUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(currentActiveStream.id)}`;
  }
  try {
    shell.openExternal(targetUrl);
    addStreamLog("ok", "BROWSER", `Stream extern geöffnet: ${targetUrl}`);
    showVideoToast("🌐 Öffne Stream im Standard-Browser...");
  } catch (e) {
    addStreamLog("err", "BROWSER", `Fehler beim Öffnen: ${e.message}`);
  }
};

window.playStreamPreset = function(platform, id, name) {
  selectStreamPlatform(platform);
  const input = document.getElementById("streamUrlInput");
  if (input) input.value = id;
  addStreamLog("info", "PRESET", `Schnellauswahl aufgerufen: ${name || id} (${platform.toUpperCase()})`);
  startStreamPlayback(id, platform);
  if (currentActiveStream && name) {
    currentActiveStream.name = name;
    const stageName = document.getElementById("streamStageChannelName");
    const activeTitle = document.getElementById("activeStreamTitle");
    if (stageName) stageName.textContent = name;
    if (activeTitle) activeTitle.textContent = name;
  }
};

window.toggleStreamChat = function() {
  const view = document.getElementById("streamStageView");
  const btn = document.getElementById("streamToggleChatBtn");
  if (!view) return;
  const hasChat = view.classList.toggle("with-chat");
  btn?.classList.toggle("active", hasChat);
  addStreamLog("info", "CHAT", `Live-Chat ${hasChat ? 'eingeblendet' : 'ausgeblendet'}`);
};

window.toggleStreamTheaterMode = function() {
  const stage = document.getElementById("streamStageContainer");
  if (!stage) return;
  const isTheater = stage.classList.toggle("theater-mode");
  addStreamLog("info", "THEATER", `Theater-Modus ${isTheater ? 'aktiviert' : 'deaktiviert'}`);
};

window.closeStreamStage = function() {
  const stage = document.getElementById("streamStageContainer");
  const iframe = document.getElementById("streamIframe");
  const chatIframe = document.getElementById("streamChatIframe");
  const activeBadge = document.getElementById("activeStreamBadge");

  if (iframe) iframe.src = "about:blank";
  if (chatIframe) chatIframe.src = "about:blank";
  if (stage) {
    stage.classList.add("hidden");
    stage.classList.remove("theater-mode");
  }
  if (activeBadge) activeBadge.classList.add("hidden");
  addStreamLog("info", "STOP", `Stream "${currentActiveStream?.name || 'Unbekannt'}" beendet`);
  currentActiveStream = null;
  showVideoToast("⏹ Stream beendet");
};

window.saveCurrentStreamFavorite = function() {
  let target = currentActiveStream;
  if (!target) {
    const inputVal = document.getElementById("streamUrlInput")?.value?.trim();
    if (inputVal) {
      if (currentStreamPlatform === "twitch") {
        const ch = parseTwitchChannel(inputVal);
        target = { platform: 'twitch', id: ch, name: ch };
      } else {
        const vid = parseYoutubeVideoId(inputVal);
        target = { platform: 'youtube', id: vid, name: `YouTube (${vid})` };
      }
    }
  }

  if (!target || !target.id) {
    showVideoToast("⚠️ Kein Stream zum Favorisieren angegeben!");
    addStreamLog("warn", "FAVORIT", "Favorisieren abgebrochen: Kein Stream angegeben");
    return;
  }

  const favs = getStreamFavorites();
  const exists = favs.find(f => f.platform === target.platform && f.id.toLowerCase() === target.id.toLowerCase());
  if (exists) {
    showVideoToast(`⭐ "${target.name}" ist bereits in den Favoriten!`);
    addStreamLog("info", "FAVORIT", `Stream "${target.name}" existiert bereits in Favoriten`);
    return;
  }

  favs.unshift({
    platform: target.platform,
    id: target.id,
    name: target.name || target.id,
    addedAt: Date.now()
  });

  saveStreamFavorites(favs);
  renderStreamsTab();
  addStreamLog("ok", "FAVORIT", `Stream "${target.name}" zu Favoriten hinzugefügt`);
  showVideoToast(`⭐ "${target.name}" zu Stream-Favoriten hinzugefügt!`);
};

window.deleteStreamFavorite = function(index) {
  const favs = getStreamFavorites();
  if (index >= 0 && index < favs.length) {
    const deleted = favs.splice(index, 1);
    saveStreamFavorites(favs);
    renderStreamsTab();
    addStreamLog("info", "FAVORIT", `Stream "${deleted[0]?.name || 'Unbekannt'}" aus Favoriten gelöscht`);
    showVideoToast(`🗑 "${deleted[0]?.name || 'Stream'}" entfernt`);
  }
};

window.renderStreamsTab = function() {
  checkStreamAuthStatus();
  renderStreamLogs();
  renderStreamHistory();

  const favGrid = document.getElementById("streamFavoritesGrid");
  const favEmpty = document.getElementById("streamFavoritesEmpty");
  const presetGrid = document.getElementById("streamPresetsGrid");

  // Favoriten rendern
  const favs = getStreamFavorites();
  if (favGrid) {
    favGrid.innerHTML = "";
    if (favs.length === 0) {
      if (favEmpty) favEmpty.classList.remove("hidden");
    } else {
      if (favEmpty) favEmpty.classList.add("hidden");
      favs.forEach((fav, idx) => {
        const isTwitch = fav.platform === "twitch";
        const card = document.createElement("div");
        card.className = "stream-card";
        const bannerGradient = isTwitch ? "linear-gradient(135deg, #9146ff 0%, #2a0845 100%)" : "linear-gradient(135deg, #ff0000 0%, #4a0000 100%)";
        const badgeClass = isTwitch ? "stream-badge-twitch" : "stream-badge-youtube";
        const platformLabel = isTwitch ? "TWITCH" : "YOUTUBE";
        const initial = (fav.name || fav.id).charAt(0).toUpperCase();

        card.innerHTML = `
          <div class="stream-card-banner" style="background: ${bannerGradient};">
            <span class="${badgeClass}">${platformLabel}</span>
            <div class="stream-card-avatar-wrap">
              <span>${initial}</span>
            </div>
          </div>
          <div class="stream-card-body">
            <div>
              <div class="stream-card-name" title="${escapeStreamHtml(fav.name)}">${escapeStreamHtml(fav.name)}</div>
              <div class="stream-card-desc">Gespeicherter ${isTwitch ? 'Twitch-Kanal' : 'YouTube Live Stream'}</div>
            </div>
            <div class="stream-card-footer">
              <span style="color: var(--accent); font-weight: bold;">▶ Jetzt ansehen</span>
              <button class="stream-card-del-btn" title="Aus Favoriten entfernen" onclick="event.stopPropagation(); deleteStreamFavorite(${idx})">✕</button>
            </div>
          </div>
        `;
        card.onclick = () => window.playStreamPreset(fav.platform, fav.id, fav.name);
        favGrid.appendChild(card);
      });
    }
  }

  // Presets rendern (nur wenn leer)
  if (presetGrid && presetGrid.children.length === 0) {
    presetGrid.innerHTML = "";
    STREAM_PRESETS.forEach(preset => {
      const isTwitch = preset.platform === "twitch";
      const card = document.createElement("div");
      card.className = "stream-card";
      const badgeClass = isTwitch ? "stream-badge-twitch" : "stream-badge-youtube";
      const platformLabel = isTwitch ? "TWITCH" : "YOUTUBE 24/7";

      card.innerHTML = `
        <div class="stream-card-banner" style="background: ${preset.banner};">
          <span class="${badgeClass}">${platformLabel}</span>
          <div class="stream-card-avatar-wrap">
            <span>${preset.avatar}</span>
          </div>
        </div>
        <div class="stream-card-body">
          <div>
            <div class="stream-card-name" title="${escapeStreamHtml(preset.name)}">${escapeStreamHtml(preset.name)}</div>
            <div class="stream-card-desc">${escapeStreamHtml(preset.desc)}</div>
          </div>
          <div class="stream-card-footer">
            <span style="color: var(--accent); font-weight: bold;">▶ Live ansehen</span>
            <span style="color: #888; font-size: 10px;">🔴 LIVE</span>
          </div>
        </div>
      `;
      card.onclick = () => window.playStreamPreset(preset.platform, preset.id, preset.name);
      presetGrid.appendChild(card);
    });
  }
};

// ============================================================
// STREAM AUTHENTICATION & SUBSCRIBER BENEFITS
// ============================================================
function updateStreamAuthUI(authState) {
  const twitchPill = document.getElementById("twitchAuthPill");
  const twitchLabel = document.getElementById("twitchAuthLabel");
  const twitchBtn = document.getElementById("twitchAuthBtn");

  if (twitchPill && twitchLabel && twitchBtn) {
    if (authState?.twitch?.loggedIn) {
      twitchPill.classList.add("logged-in");
      const name = authState.twitch.username ? `@${authState.twitch.username}` : "Angemeldet";
      twitchLabel.innerHTML = `Twitch: <b>${escapeStreamHtml(name)}</b> <span style="color:#7ee787; font-size:11px;">(Sub-Vorteile aktiv ✨)</span>`;
      twitchBtn.className = "stream-auth-action-btn logout";
      twitchBtn.textContent = "Abmelden";
      twitchBtn.onclick = () => window.logoutStream("twitch");
    } else {
      twitchPill.classList.remove("logged-in");
      twitchLabel.textContent = "Twitch: Nicht angemeldet";
      twitchBtn.className = "stream-auth-action-btn";
      twitchBtn.textContent = "🔑 Anmelden";
      twitchBtn.onclick = () => window.openStreamLogin("twitch");
    }
  }

  const ytPill = document.getElementById("youtubeAuthPill");
  const ytLabel = document.getElementById("youtubeAuthLabel");
  const ytBtn = document.getElementById("youtubeAuthBtn");

  if (ytPill && ytLabel && ytBtn) {
    if (authState?.youtube?.loggedIn) {
      ytPill.classList.add("logged-in");
      ytLabel.innerHTML = `Google / YT: <b>Verbunden</b> <span style="color:#7ee787; font-size:11px;">(Mitgliedschaften &amp; Abo aktiv ✨)</span>`;
      ytBtn.className = "stream-auth-action-btn logout";
      ytBtn.textContent = "Abmelden";
      ytBtn.onclick = () => window.logoutStream("youtube");
    } else {
      ytPill.classList.remove("logged-in");
      ytLabel.textContent = "Google / YT: Nicht angemeldet";
      ytBtn.className = "stream-auth-action-btn";
      ytBtn.textContent = "🔑 Anmelden";
      ytBtn.onclick = () => window.openStreamLogin("youtube");
    }
  }
}

async function checkStreamAuthStatus() {
  try {
    const authState = await ipcRenderer.invoke("check-stream-auth");
    updateStreamAuthUI(authState);
    return authState;
  } catch (e) {
    console.error("Fehler beim Prüfen des Stream-Auth-Status:", e);
  }
}

window.checkStreamAuthStatus = checkStreamAuthStatus;

window.openStreamLogin = async function(platform) {
  const platName = platform === "twitch" ? "Twitch" : "YouTube";
  addStreamLog("info", "AUTH", `Öffne Anmeldedialog für ${platName}...`);
  showVideoToast(`🔑 Anmeldefenster für ${platName} wird geöffnet...`);
  try {
    await ipcRenderer.invoke("open-stream-auth", platform);
  } catch (e) {
    addStreamLog("err", "AUTH", `Fehler beim Öffnen des Anmeldefensters: ${e.message}`);
  }
};

window.logoutStream = async function(platform) {
  const platName = platform === "twitch" ? "Twitch" : "YouTube";
  addStreamLog("info", "AUTH", `Melde von ${platName} ab...`);
  try {
    await ipcRenderer.invoke("stream-logout", platform);
    showVideoToast(`👋 Von ${platName} abgemeldet`);
    addStreamLog("ok", "AUTH", `Erfolgreich von ${platName} abgemeldet`);
  } catch (e) {
    addStreamLog("err", "AUTH", `Fehler beim Abmelden von ${platName}: ${e.message}`);
  }
};

ipcRenderer.on("stream-auth-changed", (event, authState) => {
  updateStreamAuthUI(authState);
  if (authState?.twitch?.loggedIn) {
    addStreamLog("ok", "AUTH", `Twitch-Konto verbunden! (${authState.twitch.username ? '@' + authState.twitch.username : 'Eingeloggt'})`);
    showVideoToast(`✅ Twitch-Konto verbunden! Sub-Vorteile & Emotes aktiv.`);
  }
  if (authState?.youtube?.loggedIn) {
    addStreamLog("ok", "AUTH", `YouTube/Google-Konto verbunden!`);
    showVideoToast(`✅ YouTube-Konto verbunden!`);
  }

  // Falls aktuell ein Stream läuft, lade den Chat & Player neu, damit Cookies & Perks sofort greifen
  if (typeof currentActiveStream !== "undefined" && currentActiveStream) {
    const iframe = document.getElementById("streamIframe");
    const chatIframe = document.getElementById("streamChatIframe");
    if (iframe && iframe.src && iframe.src !== "about:blank") {
      iframe.src = iframe.src;
    }
    if (chatIframe && chatIframe.src && chatIframe.src !== "about:blank") {
      chatIframe.src = chatIframe.src;
    }
    addStreamLog("info", "AUTH", "Stream-Player und Chat mit neuen Anmeldedaten aktualisiert.");
  }
});

// Initiale Auth-Prüfung beim Start
setTimeout(() => {
  checkStreamAuthStatus();
}, 1000);

////////////////////////////////////////////////////////////
// APP IN-APP PATCH UPDATER SYSTEM (GITHUB & ASAR)
////////////////////////////////////////////////////////////
let currentUpdateData = null;

function getUpdateRepo() {
  return localStorage.getItem("updateGithubRepo") || "tobiaslechert445-gif/Video-App";
}
function setUpdateRepo(val) {
  localStorage.setItem("updateGithubRepo", (val || "").trim());
}
function getUpdateToken() {
  return localStorage.getItem("updateGithubToken") || "";
}
function setUpdateToken(val) {
  localStorage.setItem("updateGithubToken", (val || "").trim());
}
function isAutoUpdateEnabled() {
  return localStorage.getItem("autoCheckUpdatesOnStartup") !== "false";
}
function setAutoUpdateEnabled(val) {
  localStorage.setItem("autoCheckUpdatesOnStartup", val ? "true" : "false");
}

window.saveUpdateRepoSetting = function(val) {
  setUpdateRepo(val);
  showVideoToast("💾 GitHub-Repository gespeichert");
};
window.saveUpdateTokenSetting = function(val) {
  setUpdateToken(val);
  showVideoToast("💾 GitHub-Token gespeichert");
};
window.toggleAutoUpdateOnStartup = function(val) {
  setAutoUpdateEnabled(val);
};

function initUpdateUI() {
  const repoInp = document.getElementById("inpUpdateRepo");
  if (repoInp) repoInp.value = getUpdateRepo();
  const tokenInp = document.getElementById("inpUpdateToken");
  if (tokenInp) tokenInp.value = getUpdateToken();
  const autoChk = document.getElementById("chkAutoUpdateOnStartup");
  if (autoChk) autoChk.checked = isAutoUpdateEnabled();

  // Lade aktuelle Versionsnummer aus der App
  if (typeof ipcRenderer !== 'undefined' && ipcRenderer.invoke) {
    ipcRenderer.invoke("get-app-info").then(info => {
      if (info && info.version) {
        const badge = document.getElementById("updateCurrentVersionBadge");
        if (badge) badge.innerText = "v" + info.version;
      }
    }).catch(() => {});
  }
  if (typeof window.runAppSystemCheck === "function") {
    window.runAppSystemCheck(true);
  }
}

window.openUpdatesSystemCheck = function() {
  if (typeof videoMenu !== "undefined" && videoMenu) videoMenu.classList.remove("show");
  const modal = document.getElementById("settingsModal");
  if (modal) {
    modal.classList.remove("hidden");
    if (typeof renderCustomThemes === "function") renderCustomThemes();
    if (typeof updateColorPickersFromCSS === "function") updateColorPickersFromCSS();
    if (typeof syncAlwaysOnTopToggleUI === "function") syncAlwaysOnTopToggleUI();
  }
  if (typeof switchSettingsTab === "function") {
    switchSettingsTab("updates");
  }
  if (typeof window.runAppSystemCheck === "function") {
    window.runAppSystemCheck(false);
  }
  const card = document.getElementById("updateSystemCheckCard");
  if (card && typeof card.scrollIntoView === "function") {
    setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
  }
};

window.renderSystemCheckResults = function(res) {
  const badge = document.getElementById("sysCheckSummaryBadge");
  const grid = document.getElementById("sysCheckItemsGrid");
  const meta = document.getElementById("sysCheckRuntimeMeta");
  const pickBtn = document.getElementById("btnPickFfmpegFile");

  if (!res || !Array.isArray(res.checks)) {
    if (badge) {
      badge.className = "sys-check-badge err";
      badge.innerText = "Diagnose fehlgeschlagen";
    }
    if (grid) {
      grid.innerHTML = `<div class="sys-check-item err"><div class="sys-check-icon">❌</div><div class="sys-check-info"><div class="sys-check-title">Media-Bridge / Diagnose nicht erreichbar</div><div class="sys-check-detail">${escapeHtmlTrack((res && res.error) || "Der lokale System-Check-Dienst hat nicht geantwortet.")}</div></div></div>`;
    }
    if (pickBtn) pickBtn.classList.remove("hidden");
    return;
  }

  if (res.ffmpegPath) {
    cachedFrontendFfmpegPath = res.ffmpegPath;
    videoTrackState.ffmpegMissing = false;
  } else {
    videoTrackState.ffmpegMissing = true;
  }

  const errCount = res.checks.filter(c => c.status === "err").length;
  const warnCount = res.checks.filter(c => c.status === "warn").length;

  if (badge) {
    if (errCount > 0) {
      badge.className = "sys-check-badge err";
      badge.innerText = `${errCount} Problem(e) erkannt`;
    } else if (warnCount > 0) {
      badge.className = "sys-check-badge warn";
      badge.innerText = `${warnCount} Hinweis(e)`;
    } else {
      badge.className = "sys-check-badge ok";
      badge.innerText = "Alles bereit (6/6)";
    }
  }

  if (pickBtn) {
    const ffCheck = res.checks.find(c => c.id === "ffmpeg");
    if (!res.ffmpegPath || (ffCheck && ffCheck.status !== "ok")) {
      pickBtn.classList.remove("hidden");
    } else {
      pickBtn.classList.add("hidden");
    }
  }

  if (grid) {
    grid.innerHTML = "";
    res.checks.forEach(item => {
      const st = item.status === "ok" ? "ok" : (item.status === "warn" ? "warn" : "err");
      const icon = st === "ok" ? "✅" : (st === "warn" ? "⚠️" : "❌");
      const el = document.createElement("div");
      el.className = `sys-check-item ${st}`;
      el.innerHTML = `
        <div class="sys-check-icon">${icon}</div>
        <div class="sys-check-info">
          <div class="sys-check-title">${escapeHtmlTrack(item.title || item.id)}</div>
          <div class="sys-check-detail">${escapeHtmlTrack(item.detail || "")}</div>
        </div>
        <span class="sys-check-badge ${st}">${escapeHtmlTrack(item.summary || st.toUpperCase())}</span>
      `;
      grid.appendChild(el);
    });
  }

  if (meta) {
    const parts = [];
    if (res.runtimeLabel) parts.push(`Laufzeit: ${res.runtimeLabel}`);
    if (res.appDir) parts.push(`App-Ordner: ${res.appDir}`);
    if (res.mediaDir) parts.push(`Medien-Ordner: ${res.mediaDir}`);
    meta.innerText = parts.join("  ·  ");
  }
};

async function invokeSystemCheckEndpoint(endpoint, channelName, payload = {}) {
  if (typeof ipcRenderer !== "undefined" && ipcRenderer.invoke) {
    try {
      const ipcRes = await ipcRenderer.invoke(channelName, payload);
      if (ipcRes && typeof ipcRes === "object") return ipcRes;
    } catch (e) {}
  }
  const resp = await fetch(`${BRIDGE_MEDIA_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

window.runAppSystemCheck = async function(silent = true) {
  const btn = document.getElementById("btnRunSysCheck");
  const badge = document.getElementById("sysCheckSummaryBadge");
  if (btn) btn.disabled = true;
  if (badge && !silent) {
    badge.className = "sys-check-badge";
    badge.innerText = "Prüfe…";
  }
  try {
    const res = await invokeSystemCheckEndpoint("/api/system-check", "run-system-check", {});
    window.renderSystemCheckResults(res);
    if (!silent && typeof showVideoToast === "function") {
      if (res && res.allReady) {
        showVideoToast("✅ System-Check: Alle 6 Funktionsbereiche sind bereit!");
      } else {
        showVideoToast("⚠️ System-Check: Bitte Hinweise im Updater prüfen.");
      }
    }
    return res;
  } catch (err) {
    window.renderSystemCheckResults({ ok: false, error: err.message, checks: null });
    if (!silent && typeof showVideoToast === "function") {
      showVideoToast("❌ System-Check fehlgeschlagen: " + err.message);
    }
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.runAppSystemRepair = async function() {
  const btn = document.getElementById("btnRepairSysCheck");
  const badge = document.getElementById("sysCheckSummaryBadge");
  if (btn) btn.disabled = true;
  if (badge) {
    badge.className = "sys-check-badge";
    badge.innerText = "Repariere…";
  }
  try {
    const res = await invokeSystemCheckEndpoint("/api/system-repair", "run-system-repair", {});
    window.renderSystemCheckResults(res);
    const actions = Array.isArray(res && res.repairedActions) ? res.repairedActions : [];
    if (typeof showVideoToast === "function") {
      if (actions.length > 0) {
        showVideoToast(`🔧 Repariert (${actions.length}): ${actions[0]}`);
      } else if (res && res.allReady) {
        showVideoToast("✅ Alles bereits in Ordnung – Caches & Pfade aktualisiert.");
      } else {
        showVideoToast("⚠️ Konnte nicht alle Probleme automatisch lösen (z. B. fehlende ffmpeg.exe).");
      }
    }
    if (videoTrackState && videoTrackState.mediaPath && typeof window.probeAndLoadVideoTracks === "function") {
      window.probeAndLoadVideoTracks(videoTrackState.mediaPath);
    }
    return res;
  } catch (err) {
    if (typeof showVideoToast === "function") {
      showVideoToast("❌ Reparatur fehlgeschlagen: " + err.message);
    }
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.pickAndInstallFfmpeg = async function() {
  try {
    const res = await ipcRenderer.invoke("pick-ffmpeg-file");
    if (!res || res.canceled) return;
    if (!res.success) {
      alert("FFmpeg konnte nicht installiert werden: " + (res.error || "Unbekannter Fehler"));
      return;
    }
    if (typeof showVideoToast === "function") {
      showVideoToast(`✅ ffmpeg.exe installiert nach ${res.installedTo || "media\\video\\ffmpeg.exe"}`);
    }
    await window.runAppSystemRepair();
  } catch (err) {
    alert("Fehler beim Auswählen von ffmpeg.exe: " + err.message);
  }
};

window.manualCheckAppUpdate = async function(isSilentStartup = false) {
  const btn = document.getElementById("btnCheckAppUpdate");
  const dot = document.getElementById("updateStatusDot");
  const text = document.getElementById("updateStatusText");
  const lastCheck = document.getElementById("updateLastCheckedText");
  const availableCard = document.getElementById("updateAvailableCard");

  if (btn) btn.disabled = true;
  if (dot) dot.style.background = "#eab308";
  if (text) text.innerText = "Prüfe...";

  try {
    if (typeof window.runAppSystemCheck === "function") {
      window.runAppSystemCheck(true);
    }
    const repo = getUpdateRepo();
    const token = getUpdateToken();
    const res = await ipcRenderer.invoke("check-app-update", { repo, token });

    if (lastCheck) {
      const now = new Date();
      lastCheck.innerText = `Zuletzt geprüft: heute um ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    if (!res.success) {
      if (dot) dot.style.background = "#ef4444";
      if (text) text.innerText = "Fehler";
      if (!isSilentStartup) {
        alert("Update-Prüfung fehlgeschlagen:\n" + res.error);
      }
      return;
    }

    if (res.hasUpdate) {
      currentUpdateData = res;
      if (dot) dot.style.background = "#1db954";
      if (text) text.innerText = `v${res.latestVersion} verfügbar!`;

      if (availableCard) {
        availableCard.classList.remove("hidden");
        const title = document.getElementById("updateNewVersionTitle");
        const sub = document.getElementById("updateNewVersionSub");
        const notes = document.getElementById("updateReleaseNotesBox");
        const size = document.getElementById("updateAssetSizeText");

        if (title) title.innerText = `Neues Update v${res.latestVersion} verfügbar!`;
        if (sub) sub.innerText = res.releaseName || `Version ${res.latestVersion}`;
        if (notes) notes.innerText = res.releaseNotes || "Keine Update-Notizen vorhanden.";
        if (size && res.assetSize) {
          const fallbackName = window.__tauriRuntime ? 'my_view_app.exe' : 'app.asar';
          size.innerText = `Dateigröße: ${(res.assetSize / (1024 * 1024)).toFixed(1)} MB (${res.assetName || fallbackName})`;
        }
      }

      if (isSilentStartup) {
        showVideoToast(`🎉 Neues App-Update verfügbar (v${res.latestVersion})! In Einstellungen ansehen.`);
      }
    } else {
      if (dot) dot.style.background = "#1db954";
      if (text) text.innerText = "Aktuell";
      if (availableCard) availableCard.classList.add("hidden");
      if (!isSilentStartup) {
        showVideoToast(`✅ Du verwendest bereits die neueste Version (v${res.currentVersion})!`);
      }
    }
  } catch (err) {
    if (dot) dot.style.background = "#ef4444";
    if (text) text.innerText = "Fehler";
    if (!isSilentStartup) {
      alert("Fehler bei der Update-Prüfung: " + err.message);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.startAppUpdateDownload = async function() {
  if (!currentUpdateData || !currentUpdateData.downloadUrl) {
    alert("Kein Download-Link für das Update gefunden.");
    return;
  }

  const progCont = document.getElementById("updateDownloadProgressCont");
  const progBar = document.getElementById("updateProgressBar");
  const progPercent = document.getElementById("updateProgressPercent");
  const progStatus = document.getElementById("updateProgressStatus");
  const dlBtn = document.getElementById("btnStartDownloadUpdate");

  if (progCont) progCont.classList.remove("hidden");
  if (dlBtn) dlBtn.disabled = true;

  try {
    const res = await ipcRenderer.invoke("download-app-update", {
      downloadUrl: currentUpdateData.downloadUrl,
      assetId: currentUpdateData.assetId,
      assetSize: currentUpdateData.assetSize || 0,
      assetName: currentUpdateData.assetName || "",
      repo: currentUpdateData.repo,
      token: getUpdateToken()
    });

    if (!res.success) {
      throw new Error(res.error || "Download fehlgeschlagen");
    }

    if (progStatus) progStatus.innerText = "Download abgeschlossen! Wende Update an & starte neu...";
    if (progBar) progBar.style.width = "100%";
    if (progPercent) progPercent.innerText = "100%";

    setTimeout(async () => {
      const applyRes = await ipcRenderer.invoke("apply-app-update", { filePath: res.filePath });
      if (!applyRes.success) {
        alert("Hinweis: " + applyRes.error);
        if (dlBtn) dlBtn.disabled = false;
      }
    }, 600);
  } catch (err) {
    alert("Fehler beim Herunterladen des Updates: " + err.message);
    if (dlBtn) dlBtn.disabled = false;
    if (progCont) progCont.classList.add("hidden");
  }
};

if (typeof ipcRenderer !== 'undefined' && ipcRenderer.on) {
  ipcRenderer.on("app-update-progress", (event, data) => {
    const progBar = document.getElementById("updateProgressBar");
    const progPercent = document.getElementById("updateProgressPercent");
    const progStatus = document.getElementById("updateProgressStatus");

    if (progBar) progBar.style.width = `${data.percent}%`;
    if (progPercent) progPercent.innerText = `${data.percent}%`;
    if (progStatus && data.totalBytes > 0) {
      const dlMB = (data.downloadedBytes / (1024 * 1024)).toFixed(1);
      const totMB = (data.totalBytes / (1024 * 1024)).toFixed(1);
      progStatus.innerText = `Lade Update herunter... (${dlMB} MB von ${totMB} MB)`;
    }
  });
}

window.installLocalUpdateAsar = async function() {
  try {
    const res = await ipcRenderer.invoke("pick-local-update-file");
    if (res.canceled) return;
    if (!res.success) {
      alert("Fehler bei der Dateiauswahl: " + res.error);
      return;
    }

    if (!confirm(`Möchtest du das Update "${res.originalName}" jetzt installieren und die App neu starten?`)) {
      return;
    }

    const applyRes = await ipcRenderer.invoke("apply-app-update", { filePath: res.filePath });
    if (!applyRes.success) {
      alert("Hinweis: " + applyRes.error);
    }
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

// Startup Initialisierung
setTimeout(() => {
  initUpdateUI();
  if (isAutoUpdateEnabled()) {
    setTimeout(() => {
      manualCheckAppUpdate(true);
    }, 3000);
  }
}, 1500);


