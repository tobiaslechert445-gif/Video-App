const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, session, dialog } = require("electron")
const path = require("path")
const fs = require("fs")
const { spawn } = require("child_process")
const { pipeline } = require("stream/promises")
const { Readable, Transform } = require("stream")

const http = require("http")

let mainWindow
let tray = null
let streamBridgeServer = null
const STREAM_BRIDGE_PORT = 45678

// Local HTTP Bridge Server for Twitch and YouTube live playback
function startStreamBridgeServer() {
  if (streamBridgeServer) return;
  try {
    streamBridgeServer = http.createServer((req, res) => {
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

    streamBridgeServer.listen(STREAM_BRIDGE_PORT, '127.0.0.1', () => {
      console.log(`Stream Bridge running on http://127.0.0.1:${STREAM_BRIDGE_PORT}`);
    });

    streamBridgeServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        console.error('Stream bridge error:', err);
      }
    });
  } catch (e) {
    console.error('Failed to start stream bridge:', e);
  }
}

// Helper for finding a media file argument
function getFilePathFromArgs(args) {
  if (!args || args.length < 2) return null
  
  const videoExtensions = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts']
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', '.wma', '.dts', '.dtshd', '.ac3', '.eac3']
  const allExtensions = [...videoExtensions, ...audioExtensions]
  
  let startIndex = 1
  if (process.defaultApp || args[0].endsWith('electron.exe') || args[0].endsWith('electron')) {
    startIndex = 2
  }
  
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) continue
    
    try {
      const ext = path.extname(arg).toLowerCase()
      if (allExtensions.includes(ext) && fs.existsSync(arg)) {
        return arg
      }
    } catch (e) {
      // ignore
    }
  }
  return null
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      
      const filePath = getFilePathFromArgs(commandLine)
      if (filePath) {
        mainWindow.webContents.send("open-file", filePath)
      }
    }
  })

  app.whenReady().then(() => {
    startStreamBridgeServer();

    // Setze sauberen modernen Browser User-Agent ohne Electron-Marker
    const cleanUserAgent = (session.defaultSession.getUserAgent() || "")
      .replace(/Electron\/[0-9\.]+\s?/gi, "")
      .replace(/My_Media_App\/[0-9\.]+\s?/gi, "") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    session.defaultSession.setUserAgent(cleanUserAgent);

    // Erlaube nahtloses Einbetten von Twitch & YouTube
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = Object.assign({}, details.requestHeaders);
      const u = details.url;

      requestHeaders['User-Agent'] = cleanUserAgent;
      delete requestHeaders['X-Requested-With'];

      if (u.startsWith('https://player.twitch.tv/') || u.startsWith('http://player.twitch.tv/')) {
        requestHeaders['Referer'] = 'https://www.twitch.tv/';
      } else if (u.includes('youtube.com') || u.includes('youtube-nocookie.com')) {
        requestHeaders['Referer'] = 'https://www.youtube.com/';
        requestHeaders['Origin'] = 'https://www.youtube.com';
      }
      callback({ cancel: false, requestHeaders });
    });

      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = Object.assign({}, details.responseHeaders);
        for (const k of Object.keys(responseHeaders)) {
          const lower = k.toLowerCase();
          if (lower === 'x-frame-options') {
            delete responseHeaders[k];
          } else if (lower.includes('content-security-policy')) {
            responseHeaders[k] = responseHeaders[k].map(v => v.replace(/frame-ancestors[^;]+;?/gi, ''));
          }
        }
        callback({ cancel: false, responseHeaders });
      });

    createWindow()
    createTray()
    registerGlobalShortcuts()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false,            // ❗ native Windows bar aus
    alwaysOnTop: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  })

  mainWindow.setAlwaysOnTop(false, 'normal')
  mainWindow.maximize()
  mainWindow.loadFile("src/index.html")

  // Erlaube native Child-Fenster (für Zeichentablett / 2. Monitor) mit eigenem Windows-Rahmen
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: true,            // Native Windows-Titelleiste zum einfachen Verschieben auf Zweitbildschirm
        autoHideMenuBar: true,
        backgroundColor: '#181818',
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      }
    }
  })

  mainWindow.webContents.once("did-finish-load", () => {
    const filePath = getFilePathFromArgs(process.argv)
    if (filePath) {
      mainWindow.webContents.send("open-file", filePath)
    }
  })
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "logo.png")
  tray = new Tray(iconPath)
  
  const contextMenu = Menu.buildFromTemplate([
    { label: "My View öffnen", click: () => mainWindow.show() },
    { type: "separator" },
    { label: "Wiedergabe / Pause", click: () => mainWindow.webContents.send("media-play-pause") },
    { label: "Nächster Titel", click: () => mainWindow.webContents.send("media-next") },
    { label: "Vorheriger Titel", click: () => mainWindow.webContents.send("media-prev") },
    { type: "separator" },
    { label: "Beenden", click: () => {
        app.isQuitting = true
        app.quit()
      } 
    }
  ])
  
  tray.setToolTip("My View Media Player")
  tray.setContextMenu(contextMenu)
  
  tray.on("double-click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
    }
  })
}

function registerGlobalShortcuts() {
  globalShortcut.register("MediaPlayPause", () => {
    mainWindow.webContents.send("media-play-pause")
  })
  globalShortcut.register("MediaNextTrack", () => {
    mainWindow.webContents.send("media-next")
  })
  globalShortcut.register("MediaPreviousTrack", () => {
    mainWindow.webContents.send("media-prev")
  })
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll()
})

//////////////////////////////////////////////////
// WINDOW CONTROLS
//////////////////////////////////////////////////

ipcMain.on("window-minimize",()=>{
  mainWindow.minimize()
})

ipcMain.on("window-maximize",()=>{
  if(mainWindow.isMaximized()){
    mainWindow.unmaximize()
  }else{
    mainWindow.maximize()
  }
})

ipcMain.on("window-close",()=>{
  // Fenster nur verstecken, damit die Musik weitergespielt werden kann (Beenden über Tray)
  mainWindow.hide()
})

try { ipcMain.removeHandler("set-always-on-top"); } catch (e) {}
ipcMain.handle("set-always-on-top", (event, shouldBeOnTop = false) => {
  if (!mainWindow) return false
  const enable = Boolean(shouldBeOnTop)
  if (enable) {
    mainWindow.setAlwaysOnTop(true, "floating")
  } else {
    mainWindow.setAlwaysOnTop(false, "normal")
  }
  return mainWindow.isAlwaysOnTop()
})

ipcMain.on("set-always-on-top", (event, shouldBeOnTop = false) => {
  if (!mainWindow) return
  const enable = Boolean(shouldBeOnTop)
  if (enable) {
    mainWindow.setAlwaysOnTop(true, "floating")
  } else {
    mainWindow.setAlwaysOnTop(false, "normal")
  }
})

try { ipcMain.removeHandler("get-always-on-top"); } catch (e) {}
ipcMain.handle("get-always-on-top", () => {
  if (!mainWindow) return false
  return mainWindow.isAlwaysOnTop()
})

try { ipcMain.removeHandler("show-save-dialog"); } catch (e) {}
ipcMain.handle("show-save-dialog", async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return await dialog.showSaveDialog(win, options);
});

try { ipcMain.removeHandler("pick-media-files"); } catch (e) {}
ipcMain.handle("pick-media-files", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const res = await dialog.showOpenDialog(win, {
    title: "Videos & Musik auswählen",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Medien (Video & Audio)", extensions: ["mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "ogv", "ts", "m2ts", "gif", "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "dts", "dtshd", "ac3", "eac3"] },
      { name: "Alle Dateien", extensions: ["*"] }
    ]
  });
  return { canceled: res.canceled, filePaths: res.filePaths || [] };
});

try { ipcMain.removeHandler("pick-media-folder"); } catch (e) {}
ipcMain.handle("pick-media-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const res = await dialog.showOpenDialog(win, {
    title: "Medien-Ordner auswählen",
    properties: ["openDirectory", "multiSelections"]
  });
  return { canceled: res.canceled, folderPaths: res.filePaths || [] };
});

// ============================================================
// STREAM AUTHENTICATION & SUB BENEFIT IPC HANDLERS
// ============================================================
let authWindow = null;

async function checkStreamAuthCookies() {
  try {
    const twitchCookies = await session.defaultSession.cookies.get({ domain: ".twitch.tv", name: "auth-token" });
    const isTwitchLoggedIn = Boolean(twitchCookies && twitchCookies.length > 0 && twitchCookies[0].value);
    
    // Check Twitch username
    let twitchUsername = null;
    const twitchLoginCookie = await session.defaultSession.cookies.get({ domain: ".twitch.tv", name: "login" });
    if (twitchLoginCookie && twitchLoginCookie.length > 0 && twitchLoginCookie[0].value) {
      twitchUsername = twitchLoginCookie[0].value;
    } else {
      const nameCookie = await session.defaultSession.cookies.get({ domain: ".twitch.tv", name: "name" });
      if (nameCookie && nameCookie.length > 0 && nameCookie[0].value) {
        twitchUsername = nameCookie[0].value;
      }
    }

    // Check YouTube login (SID, SSID or LOGIN_INFO)
    const ytCookies = await session.defaultSession.cookies.get({ domain: ".youtube.com", name: "SID" });
    const isYtLoggedIn = Boolean(ytCookies && ytCookies.length > 0 && ytCookies[0].value);

    return {
      twitch: { loggedIn: isTwitchLoggedIn, username: twitchUsername },
      youtube: { loggedIn: isYtLoggedIn }
    };
  } catch (e) {
    return { twitch: { loggedIn: false }, youtube: { loggedIn: false } };
  }
}

ipcMain.handle("check-stream-auth", async () => {
  return await checkStreamAuthCookies();
});

ipcMain.handle("open-stream-auth", async (event, platform) => {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return;
  }

  const isTwitch = platform === "twitch";
  const authUrl = isTwitch 
    ? "https://www.twitch.tv/login" 
    : "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/";

  authWindow = new BrowserWindow({
    width: 620,
    height: 760,
    parent: mainWindow,
    modal: true,
    title: isTwitch ? "Bei Twitch anmelden (Sub-Vorteile & Emotes)" : "Bei YouTube / Google anmelden",
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      session: session.defaultSession, // Persistent shared session!
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Bereinige User-Agent von Electron-Kennungen, damit Google & Twitch nicht "Unsicherer Browser" blockieren
  const cleanUa = (session.defaultSession.getUserAgent() || "")
    .replace(/Electron\/[0-9\.]+\s?/gi, "")
    .replace(/My_Media_App\/[0-9\.]+\s?/gi, "");
  authWindow.webContents.setUserAgent(cleanUa || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  authWindow.loadURL(authUrl);

  const checkAndNotify = async () => {
    try {
      const authState = await checkStreamAuthCookies();
      mainWindow?.webContents.send("stream-auth-changed", authState);
      const curUrl = authWindow?.webContents?.getURL() || "";
      if (isTwitch && authState.twitch.loggedIn && !curUrl.includes('/login') && !curUrl.includes('/two-factor')) {
        setTimeout(() => {
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
        }, 1200);
      } else if (!isTwitch && authState.youtube.loggedIn && curUrl.includes('youtube.com') && !curUrl.includes('accounts.google.com')) {
        setTimeout(() => {
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
        }, 1200);
      }
    } catch (e) {}
  };

  authWindow.webContents.on("did-navigate", checkAndNotify);
  authWindow.webContents.on("did-navigate-in-page", checkAndNotify);

  authWindow.on("closed", async () => {
    authWindow = null;
    const authState = await checkStreamAuthCookies();
    mainWindow?.webContents.send("stream-auth-changed", authState);
  });
});

ipcMain.handle("stream-logout", async (event, platform) => {
  try {
    if (platform === "twitch") {
      const cookies = await session.defaultSession.cookies.get({ domain: ".twitch.tv" });
      for (const c of cookies) {
        const protocol = c.secure ? "https:" : "http:";
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        await session.defaultSession.cookies.remove(`${protocol}//${domain}${c.path}`, c.name);
      }
    } else if (platform === "youtube") {
      const cookies = await session.defaultSession.cookies.get({ domain: ".youtube.com" });
      for (const c of cookies) {
        const protocol = c.secure ? "https:" : "http:";
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        await session.defaultSession.cookies.remove(`${protocol}//${domain}${c.path}`, c.name);
      }
    }
    const authState = await checkStreamAuthCookies();
    mainWindow?.webContents.send("stream-auth-changed", authState);
    return true;
  } catch (e) {
    console.error("Fehler beim Abmelden:", e);
    return false;
  }
});

// ============================================================
// APP IN-APP PATCH UPDATER (GITHUB RELEASES & LOCAL ASAR)
// ============================================================
function compareAppVersions(v1, v2) {
  const parse = v => String(v || '').replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const p1 = parse(v1);
  const p2 = parse(v2);
  const len = Math.max(p1.length, p2.length, 3);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num2 > num1) return 1;
    if (num2 < num1) return -1;
  }
  return 0;
}

ipcMain.handle("get-app-info", () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath
  };
});

ipcMain.handle("check-app-update", async (event, { repo = "tobiaslechert445-gif/Video-App", token = "" } = {}) => {
  try {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').trim();
    if (!cleanRepo || !cleanRepo.includes('/')) {
      return { success: false, error: "Ungültiges Repository-Format. Bitte 'benutzername/repository' angeben." };
    }

    const apiUrl = `https://api.github.com/repos/${cleanRepo}/releases/latest`;
    const headers = {
      'User-Agent': 'My-Media-App-Updater',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token && token.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    const res = await fetch(apiUrl, { headers });
    if (!res.ok) {
      if (res.status === 404) {
        return { 
          success: false, 
          error: "Kein Release auf GitHub gefunden (oder das Repository ist privat und benötigt einen Zugriffs-Token)." 
        };
      }
      return { success: false, error: `GitHub API Fehler: HTTP ${res.status}` };
    }

    const data = await res.json();
    const latestVersion = (data.tag_name || "").replace(/^v/i, '').trim();
    const currentVersion = app.getVersion();
    const hasUpdate = compareAppVersions(currentVersion, latestVersion) > 0;

    const assets = Array.isArray(data.assets) ? data.assets : [];
    const asarAsset = assets.find(a => a.name.toLowerCase().endsWith('.asar')) ||
                      assets.find(a => a.name.toLowerCase().includes('asar')) ||
                      assets[0] || null;

    return {
      success: true,
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseName: data.name || `Version ${latestVersion}`,
      releaseNotes: data.body || "Keine Beschreibung vorhanden.",
      publishedAt: data.published_at,
      assetName: asarAsset ? asarAsset.name : null,
      assetSize: asarAsset ? asarAsset.size : 0,
      downloadUrl: asarAsset ? asarAsset.browser_download_url : null,
      assetId: asarAsset ? asarAsset.id : null,
      repo: cleanRepo
    };
  } catch (err) {
    return { success: false, error: "Verbindungsfehler beim Prüfen auf Updates: " + err.message };
  }
});

ipcMain.handle("download-app-update", async (event, { downloadUrl, assetId, repo, token = "" }) => {
  try {
    const tempDir = app.getPath("temp");
    const tempFile = path.join(tempDir, "my_view_update.asar");

    let url = downloadUrl;
    const headers = { 'User-Agent': 'My-Media-App-Updater' };
    if (token && token.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
      if (assetId && repo) {
        url = `https://api.github.com/repos/${repo}/releases/assets/${assetId}`;
        headers['Accept'] = 'application/octet-stream';
      }
    }

    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen: HTTP ${res.status} ${res.statusText}`);
    }

    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
    let downloadedBytes = 0;

    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          event.sender.send("app-update-progress", {
            percent,
            downloadedBytes,
            totalBytes
          });
        }
        callback(null, chunk);
      }
    });

    const webStream = Readable.fromWeb(res.body);
    const fileStream = fs.createWriteStream(tempFile);

    await pipeline(webStream, progressStream, fileStream);

    return { success: true, filePath: tempFile, downloadedBytes };
  } catch (err) {
    console.error("Update-Download Fehler:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("pick-local-update-file", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: "Update-Datei auswählen (app.asar)",
      filters: [{ name: "App-Paket", extensions: ["asar"] }],
      properties: ["openFile"]
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const chosenFile = res.filePaths[0];
    const tempDir = app.getPath("temp");
    const tempFile = path.join(tempDir, "my_view_update.asar");
    fs.copyFileSync(chosenFile, tempFile);
    return { success: true, filePath: tempFile, originalName: path.basename(chosenFile) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("apply-app-update", async (event, { filePath } = {}) => {
  try {
    const tempFile = filePath || path.join(app.getPath("temp"), "my_view_update.asar");
    if (!fs.existsSync(tempFile)) {
      return { success: false, error: "Die Update-Datei wurde nicht gefunden." };
    }

    if (!app.isPackaged) {
      return { 
        success: false, 
        error: "Entwicklungsmodus aktiv (nicht gepackt). Das Update kann nur in einer installierten/entpackten App angewendet werden." 
      };
    }

    const resourcesDir = process.resourcesPath;
    const targetAsar = path.join(resourcesDir, "app.asar");
    const appExe = process.execPath;
    const updaterBat = path.join(app.getPath("temp"), "my_view_updater.bat");

    const batScript = `@echo off
chcp 65001 >nul
timeout /t 1 /nobreak >nul
set RETRIES=0
:retry
copy /y "${tempFile}" "${targetAsar}" >nul 2>&1
if %errorlevel% neq 0 (
    set /a RETRIES+=1
    if %RETRIES% leq 15 (
        timeout /t 1 /nobreak >nul
        goto retry
    )
)
del "${tempFile}" >nul 2>&1
start "" "${appExe}"
del "%~f0" >nul 2>&1
exit
`;

    fs.writeFileSync(updaterBat, batScript, "utf8");

    const child = spawn("cmd.exe", ["/c", updaterBat], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    app.isQuitting = true;
    setTimeout(() => {
      app.quit();
    }, 200);

    return { success: true };
  } catch (err) {
    console.error("Fehler beim Anwenden des Updates:", err);
    return { success: false, error: err.message };
  }
});

// Global Exception & Crash Handlers for Main Process
process.on('uncaughtException', (err) => {
  console.error("Main Process uncaughtException:", err);
  try {
    const isPackaged = __dirname.includes('app.asar');
    const mediaBase = isPackaged 
      ? path.join(path.dirname(process.execPath), "media") 
      : path.join(__dirname, "media");
    const logPath = path.join(mediaBase, "debug_log.txt");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [CRASH-MAIN] uncaughtException: ${err.stack || err}\n`);
  } catch(e) {}
});

app.on('render-process-gone', (event, webContents, details) => {
  console.error("Render process gone:", details);
  try {
    const isPackaged = __dirname.includes('app.asar');
    const mediaBase = isPackaged 
      ? path.join(path.dirname(process.execPath), "media") 
      : path.join(__dirname, "media");
    const logPath = path.join(mediaBase, "debug_log.txt");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [CRASH-RENDERER] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}\n`);
  } catch(e) {}
});

app.on('child-process-gone', (event, details) => {
  console.error("Child process gone:", details);
  try {
    const isPackaged = __dirname.includes('app.asar');
    const mediaBase = isPackaged 
      ? path.join(path.dirname(process.execPath), "media") 
      : path.join(__dirname, "media");
    const logPath = path.join(mediaBase, "debug_log.txt");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [CRASH-CHILD] child-process-gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}\n`);
  } catch(e) {}
});