const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, session, dialog } = require("electron")
const path = require("path")
const fs = require("fs")
const os = require("os")
const { spawn, spawnSync } = require("child_process")
const { pipeline } = require("stream/promises")
const { Readable, Transform } = require("stream")

const http = require("http")

let mainWindow
let tray = null
let streamBridgeServer = null
const STREAM_BRIDGE_PORT = 45678

let cachedFfmpegPath = null
const probeTracksCache = new Map()
const inFlightMediaJobs = new Map()

function getBridgePaths() {
  const isPackaged = Boolean(app && app.isPackaged)
  const appDir = isPackaged ? path.dirname(process.execPath) : __dirname
  const mediaDir = path.join(appDir, "media")
  return { isPackaged, appDir, mediaDir }
}

function clearFfmpegAndProbeCaches() {
  cachedFfmpegPath = null
  probeTracksCache.clear()
}

function fnv1a64Hex(str) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const buf = Buffer.from(String(str || ""), "utf8")
  for (let i = 0; i < buf.length; i++) {
    hash ^= BigInt(buf[i])
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, "0")
}

function normalizePathKey(p) {
  return String(p || "").replace(/\//g, "\\").trim().toLowerCase()
}

function savedSubsDirForMedia(mediaDir, rawPath) {
  const parsed = path.parse(String(rawPath || ""))
  const parent = normalizePathKey(parsed.dir)
  const stem = String(parsed.name || "").toLowerCase()
  const hash = fnv1a64Hex(`${parent}|${stem}`)
  return path.join(mediaDir, ".sub_cache", `saved_${hash}`)
}

function fileHashHex(filePath, extra = "") {
  let size = 0
  let mtimeMs = 0
  try {
    const st = fs.statSync(filePath)
    size = st.size
    mtimeMs = Math.floor(st.mtimeMs)
  } catch (e) {}
  return fnv1a64Hex(`${normalizePathKey(filePath)}|${size}|${mtimeMs}|${extra}`)
}

function findFfmpeg(mediaDir) {
  if (cachedFfmpegPath && fs.existsSync(cachedFfmpegPath)) {
    return cachedFfmpegPath
  }
  const candidates = [
    path.join(mediaDir, "video", "ffmpeg.exe"),
    path.join(mediaDir, "ffmpeg.exe")
  ]
  const exeDir = path.dirname(process.execPath)
  candidates.push(path.join(exeDir, "ffmpeg.exe"))
  candidates.push(path.join(exeDir, "media", "video", "ffmpeg.exe"))

  for (const seed of [exeDir, mediaDir]) {
    let cur = seed
    for (let i = 0; i < 4 && cur; i++) {
      candidates.push(path.join(cur, "media", "video", "ffmpeg.exe"))
      candidates.push(path.join(cur, "ffmpeg.exe"))
      candidates.push(path.join(cur, "My_View_Starter_Template", "media", "video", "ffmpeg.exe"))
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }

  const home = os.homedir()
  if (home) {
    for (const sub of ["Downloads", "Desktop", "Documents"]) {
      const base = path.join(home, sub)
      candidates.push(path.join(base, "ffmpeg.exe"))
      candidates.push(path.join(base, "My_View_Starter_Template", "media", "video", "ffmpeg.exe"))
      candidates.push(path.join(base, "My_Media_App", "media", "video", "ffmpeg.exe"))
    }
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
        cachedFfmpegPath = c
        return c
      }
    } catch (e) {}
  }

  try {
    const whereRes = spawnSync("where.exe", ["ffmpeg"], { windowsHide: true, encoding: "utf8" })
    if (whereRes.status === 0 && whereRes.stdout) {
      for (const line of whereRes.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed && fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
          cachedFfmpegPath = trimmed
          return trimmed
        }
      }
    }
  } catch (e) {}
  return null
}

function guessBridgeMime(filePath) {
  const ext = path.extname(String(filePath || "")).replace(".", "").toLowerCase()
  const map = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    ogv: "video/ogg",
    ts: "video/mp2t",
    m2ts: "video/mp2t",
    mts: "video/mp2t",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/mp4",
    dts: "audio/vnd.dts",
    dtshd: "audio/vnd.dts",
    ac3: "audio/ac3",
    eac3: "audio/eac3",
    wma: "audio/x-ms-wma",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    vtt: "text/vtt; charset=utf-8",
    srt: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    json: "text/plain; charset=utf-8"
  }
  return map[ext] || "application/octet-stream"
}

function sendBridgeJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range"
  })
  res.end(JSON.stringify(obj))
}

function readBridgeJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        resolve({})
      }
    })
    req.on("error", () => resolve({}))
  })
}

function serveBridgeFileWithRanges(req, res, filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (e) {
    sendBridgeJson(res, 500, { error: e.message })
    return
  }
  const totalLen = stat.size
  const mime = guessBridgeMime(filePath)
  const rangeHeader = req.headers.range
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range"
  }

  if (rangeHeader && String(rangeHeader).startsWith("bytes=") && totalLen > 0) {
    const spec = String(rangeHeader).slice(6)
    const parts = spec.split("-")
    const start = parseInt((parts[0] || "").trim(), 10) || 0
    const reqEnd = parts[1] && parts[1].trim() !== "" ? parseInt(parts[1].trim(), 10) : totalLen - 1
    if (start >= totalLen) {
      res.writeHead(416, { ...cors, "Content-Range": `bytes */${totalLen}` })
      res.end()
      return
    }
    const end = Math.max(start, Math.min(totalLen - 1, isNaN(reqEnd) ? totalLen - 1 : reqEnd))
    const len = end - start + 1
    res.writeHead(206, {
      ...cors,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${totalLen}`,
      "Content-Length": len
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    ...cors,
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Length": totalLen
  })
  fs.createReadStream(filePath).pipe(res)
}

function langDisplayName(code) {
  const c = String(code || "").trim().toLowerCase()
  const map = {
    ger: "Deutsch", deu: "Deutsch", de: "Deutsch",
    eng: "Englisch", en: "Englisch",
    jpn: "Japanisch", ja: "Japanisch",
    fre: "Französisch", fra: "Französisch", fr: "Französisch",
    spa: "Spanisch", es: "Spanisch",
    ita: "Italienisch", it: "Italienisch",
    por: "Portugiesisch", pt: "Portugiesisch",
    rus: "Russisch", ru: "Russisch",
    kor: "Koreanisch", ko: "Koreanisch",
    chi: "Chinesisch", zho: "Chinesisch", zh: "Chinesisch",
    tur: "Türkisch", tr: "Türkisch",
    pol: "Polnisch", pl: "Polnisch",
    dut: "Niederländisch", nld: "Niederländisch", nl: "Niederländisch",
    ara: "Arabisch", ar: "Arabisch",
    hin: "Hindi", hi: "Hindi",
    und: "Unbekannt", "": "Unbekannt"
  }
  return map[c] !== undefined ? map[c] : ""
}

function isTextSubtitleCodec(codec) {
  const tok = String(codec || "").split(/[\s(,[]/)[0].trim().toLowerCase()
  return [
    "subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text",
    "tx3g", "text", "microdvd", "mpl2", "realtext", "sami",
    "subviewer", "vplayer", "jacosub"
  ].includes(tok)
}

function extractAudioCodecDisplay(details, codec) {
  const cLower = String(codec || "").trim().toLowerCase()
  const dLower = String(details || "").toLowerCase()
  if (cLower === "dts" || cLower === "dca") {
    if (dLower.includes("dts:x")) return "DTS:X"
    if (dLower.includes("dts-hd ma")) return "DTS-HD MA"
    if (dLower.includes("dts-hd hra")) return "DTS-HD HRA"
    if (dLower.includes("dts-es")) return "DTS-ES"
    if (dLower.includes("dts 96/24")) return "DTS 96/24"
    return "DTS"
  }
  const map = { truehd: "TrueHD", eac3: "E-AC3", ac3: "AC3", aac: "AAC", flac: "FLAC", opus: "Opus", mp3: "MP3" }
  return map[cLower] || String(codec || "").toUpperCase()
}

function extractAudioChannels(details) {
  const parts = String(details || "").split(",").slice(1)
  for (const part of parts) {
    const low = part.trim().toLowerCase()
    if (low.includes("7.1")) return "7.1"
    if (low.includes("6.1")) return "6.1"
    if (low.includes("5.1")) return "5.1"
    if (low.startsWith("quad")) return "4.0"
    if (low.includes("stereo") || low.startsWith("2 channels")) return "Stereo"
    if (low.includes("mono") || low.startsWith("1 channels")) return "Mono"
    if (low.includes("channels")) return part.trim()
  }
  return ""
}

function isNonBrowserAudioCodec(codec) {
  return [
    "dts", "dca", "ac3", "eac3", "truehd", "mlp",
    "wmav1", "wmav2", "wmapro", "wmalossless", "pcm_bluray", "pcm_dvd"
  ].includes(String(codec || "").trim().toLowerCase())
}

function findCompanionMkvForMp4(mp4Path) {
  const parsed = path.parse(mp4Path)
  const twin = path.join(parsed.dir, `${parsed.name}.mkv`)
  try {
    if (fs.existsSync(twin) && fs.statSync(twin).isFile()) return twin
  } catch (e) {}
  const targetMkv = `${parsed.name.toLowerCase()}.mkv`
  const roots = []
  const drive = parsed.root
  if (drive) {
    roots.push(path.join(drive, "Downloader", "Downloads"))
    roots.push(path.join(drive, "Downloads"))
  }
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, "Downloads"))
  }
  if (!roots.some((r) => r.toLowerCase() === "e:\\downloader\\downloads")) {
    roots.push("E:\\Downloader\\Downloads")
  }
  for (const root of roots) {
    try {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase() === targetMkv) {
          return path.join(root, entry.name)
        }
        if (entry.isDirectory()) {
          const subDir = path.join(root, entry.name)
          try {
            for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
              if (sub.isFile() && sub.name.toLowerCase() === targetMkv) {
                return path.join(subDir, sub.name)
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return null
}

function resolveTrackSourcePaths(rawPath) {
  const extLower = path.extname(String(rawPath || "")).replace(".", "").toLowerCase()
  try {
    if (fs.existsSync(rawPath) && fs.statSync(rawPath).isFile()) {
      const companion = extLower === "mp4" || extLower === "m4v" ? findCompanionMkvForMp4(rawPath) : null
      return { primary: rawPath, companion }
    }
  } catch (e) {}
  if (extLower === "mkv") {
    const parsed = path.parse(rawPath)
    const twin = path.join(parsed.dir, `${parsed.name}.mp4`)
    try {
      if (fs.existsSync(twin) && fs.statSync(twin).isFile()) return { primary: twin, companion: null }
    } catch (e) {}
  }
  return { primary: null, companion: null }
}

function runCommandAsync(binPath, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(binPath, args, { windowsHide: true })
      const out = []
      const err = []
      child.stdout.on("data", (d) => out.push(d))
      child.stderr.on("data", (d) => err.push(d))
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8")
        })
      })
      child.on("error", () => resolve({ ok: false, code: -1, stdout: "", stderr: "" }))
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: "", stderr: "" })
    }
  })
}

async function probeMediaTracksAsync(mediaPath, mediaDir) {
  let cacheKey = null
  try {
    const st = fs.statSync(mediaPath)
    cacheKey = `${normalizePathKey(mediaPath)}|${st.size}|${Math.floor(st.mtimeMs)}`
    if (probeTracksCache.has(cacheKey)) {
      return JSON.parse(JSON.stringify(probeTracksCache.get(cacheKey)))
    }
  } catch (e) {}

  const ffmpeg = findFfmpeg(mediaDir)
  if (!ffmpeg) {
    return { videoCodec: "", audio: [], subtitles: [] }
  }
  const res = await runCommandAsync(ffmpeg, ["-hide_banner", "-i", mediaPath])
  const audioEntries = []
  const subEntries = []
  let videoCodec = ""
  let active = null

  for (const rawLine of (res.stderr || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith("Stream #")) {
      const audioPos = trimmed.indexOf(": Audio:")
      const subPos = trimmed.indexOf(": Subtitle:")
      const vidPos = trimmed.indexOf(": Video:")
      if (audioPos !== -1) {
        const header = trimmed.slice(0, audioPos)
        const details = trimmed.slice(audioPos + 8).trim()
        const mLang = header.match(/\(([^)]+)\)(?!.*\()/)
        const lang = mLang && mLang[1] ? mLang[1].trim().toLowerCase() : "und"
        const codec = (details.split(/[\s,(]/).find(Boolean) || "").toLowerCase()
        const lower = details.toLowerCase()
        const idx = audioEntries.length
        audioEntries.push({
          index: idx,
          lang,
          langName: langDisplayName(lang) || lang.toUpperCase(),
          codec,
          codecDisplay: extractAudioCodecDisplay(details, codec),
          channels: extractAudioChannels(details),
          title: "",
          isDefault: lower.includes("(default)"),
          isForced: lower.includes("(forced)")
        })
        active = audioEntries[idx]
      } else if (subPos !== -1) {
        const header = trimmed.slice(0, subPos)
        const details = trimmed.slice(subPos + 11).trim()
        const mLang = header.match(/\(([^)]+)\)(?!.*\()/)
        const lang = mLang && mLang[1] ? mLang[1].trim().toLowerCase() : "und"
        const codec = (details.split(/[\s,(]/).find(Boolean) || "").toLowerCase()
        const lower = details.toLowerCase()
        const idx = subEntries.length
        subEntries.push({
          index: idx,
          lang,
          langName: langDisplayName(lang) || lang.toUpperCase(),
          codec,
          title: "",
          isDefault: lower.includes("(default)"),
          isForced: lower.includes("(forced)"),
          isText: isTextSubtitleCodec(codec),
          source: "embedded"
        })
        active = subEntries[idx]
      } else if (vidPos !== -1) {
        if (!videoCodec && !trimmed.toLowerCase().includes("(attached pic)")) {
          const details = trimmed.slice(vidPos + 8).trim()
          videoCodec = (details.split(/[\s,(]/).find(Boolean) || "").toLowerCase()
        }
        active = null
      } else {
        active = null
      }
      continue
    }
    if (!rawLine.startsWith("    ")) {
      active = null
      continue
    }
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx > 0 && active) {
      const k = trimmed.slice(0, colonIdx).trim().toLowerCase()
      const v = trimmed.slice(colonIdx + 1).trim()
      if (k === "title" && v) {
        active.title = v
      }
    }
  }

  const probed = { videoCodec, audio: audioEntries, subtitles: subEntries }
  if (cacheKey) {
    probeTracksCache.set(cacheKey, JSON.parse(JSON.stringify(probed)))
  }
  return probed
}

function runSerializedMediaJob(key, fn) {
  if (inFlightMediaJobs.has(key)) return inFlightMediaJobs.get(key)
  const p = Promise.resolve().then(fn).finally(() => {
    inFlightMediaJobs.delete(key)
  })
  inFlightMediaJobs.set(key, p)
  return p
}

async function resolvePlayableMediaPathAsync(origPath, mediaDir) {
  const ext = path.extname(origPath).replace(".", "").toLowerCase()
  const isStandaloneTranscodeAudio = ["dts", "dtshd", "ac3", "eac3", "wma"].includes(ext)
  const isAlwaysRemuxVideo = ["mkv", "avi", "flv", "wmv", "ts", "m2ts"].includes(ext)
  if (isStandaloneTranscodeAudio) {
    const ffmpeg = findFfmpeg(mediaDir)
    if (!ffmpeg) return origPath
    const cacheDir = path.join(mediaDir, ".mkv_cache")
    const outM4a = path.join(cacheDir, `audio_only_${fileHashHex(origPath, "aac256")}.m4a`)
    if (fs.existsSync(outM4a) && fs.statSync(outM4a).size > 128) return outM4a
    return runSerializedMediaJob(outM4a, async () => {
      if (fs.existsSync(outM4a) && fs.statSync(outM4a).size > 128) return outM4a
      fs.mkdirSync(cacheDir, { recursive: true })
      const tmp = path.join(cacheDir, `audio_only_${fileHashHex(origPath, "aac256")}.tmp.m4a`)
      try { fs.unlinkSync(tmp) } catch (e) {}
      const r = await runCommandAsync(ffmpeg, [
        "-nostdin", "-err_detect", "ignore_err", "-fflags", "+genpts",
        "-i", origPath, "-vn", "-sn", "-dn",
        "-c:a", "aac", "-aac_coder", "fast", "-b:a", "256k", "-ac", "2",
        "-movflags", "+faststart", "-y", tmp
      ])
      if (r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 128) {
        fs.renameSync(tmp, outM4a)
        return outM4a
      }
      try { fs.unlinkSync(tmp) } catch (e) {}
      return origPath
    })
  }

  let probed = null
  if (["mp4", "m4v", "mov"].includes(ext)) {
    probed = await probeMediaTracksAsync(origPath, mediaDir)
    const needsAudio = probed.audio.length > 0 && isNonBrowserAudioCodec(probed.audio[0].codec)
    const needsVideo = probed.videoCodec === "mpeg2video" || probed.videoCodec === "mpeg1video" || probed.videoCodec === "wmv3"
    if (!needsAudio && !needsVideo) return origPath
  } else if (!isAlwaysRemuxVideo) {
    return origPath
  }

  if (!probed) probed = await probeMediaTracksAsync(origPath, mediaDir)
  const ffmpeg = findFfmpeg(mediaDir)
  if (!ffmpeg) return origPath
  const cacheDir = path.join(mediaDir, ".mkv_cache")
  const outMp4 = path.join(cacheDir, `v3_${fileHashHex(origPath, "remux")}.mp4`)
  if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1024) return outMp4

  return runSerializedMediaJob(outMp4, async () => {
    if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1024) return outMp4
    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = path.join(cacheDir, `v3_${fileHashHex(origPath, "remux")}.tmp.mp4`)
    const firstAudioCodec = probed.audio[0] ? probed.audio[0].codec : ""
    const copyAudio = firstAudioCodec === "aac" || firstAudioCodec === "mp3"
    const isHevc = probed.videoCodec === "hevc" || probed.videoCodec === "h265"
    const runRemux = async (transcodeVideo, audioCopy) => {
      try { fs.unlinkSync(tmp) } catch (e) {}
      const args = ["-nostdin", "-err_detect", "ignore_err"]
      if (transcodeVideo) args.push("-fflags", "+genpts")
      args.push("-i", origPath, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0")
      if (transcodeVideo) {
        args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p")
      } else {
        args.push("-c:v", "copy")
        if (isHevc) args.push("-tag:v", "hvc1", "-strict", "unofficial")
      }
      if (audioCopy) {
        args.push("-c:a", "copy")
      } else {
        args.push("-c:a", "aac", "-aac_coder", "fast", "-b:a", "256k", "-ac", "2")
      }
      args.push("-movflags", "+faststart", "-y", tmp)
      const r = await runCommandAsync(ffmpeg, args)
      return r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024
    }
    const ok = (await runRemux(false, copyAudio)) ||
      (copyAudio && (await runRemux(false, false))) ||
      (await runRemux(true, false))
    if (ok) {
      fs.renameSync(tmp, outMp4)
      return outMp4
    }
    try { fs.unlinkSync(tmp) } catch (e) {}
    return origPath
  })
}

function buildSystemCheckPayload() {
  const { isPackaged, appDir, mediaDir } = getBridgePaths()
  const version = app ? app.getVersion() : "1.0.0"
  const bundledFfmpeg = path.join(mediaDir, "video", "ffmpeg.exe")
  const ffmpegOpt = findFfmpeg(mediaDir)
  const ffmpegBundled = fs.existsSync(bundledFfmpeg) && fs.statSync(bundledFfmpeg).isFile()

  const checkBridge = {
    id: "bridge",
    title: "Media-Bridge & Multi-Track-Server",
    status: "ok",
    summary: `Aktiv (Port ${STREAM_BRIDGE_PORT})`,
    detail: `Laufzeit: Electron Desktop (v${version}) – Streaming, Tonspur-Wechsel & Untertitel-Extraktion aktiv.`
  }

  let ffmpegExecOk = false
  let ffmpegVersionLine = ""
  if (ffmpegOpt) {
    try {
      const r = spawnSync(ffmpegOpt, ["-version"], { windowsHide: true, encoding: "utf8" })
      if (r.status === 0) {
        ffmpegExecOk = true
        ffmpegVersionLine = String(r.stdout || "").split(/\r?\n/)[0].trim()
      }
    } catch (e) {}
  }

  let checkFfmpeg
  if (!ffmpegOpt) {
    checkFfmpeg = {
      id: "ffmpeg",
      title: "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
      status: "err",
      summary: "Fehlt",
      detail: `ffmpeg.exe nicht gefunden (erwartet unter ${bundledFfmpeg}). Klicke auf 'Automatisch reparieren', um ffmpeg.exe direkt von GitHub herunterzuladen und einzurichten.`
    }
  } else if (!ffmpegExecOk) {
    checkFfmpeg = {
      id: "ffmpeg",
      title: "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
      status: "err",
      summary: "Nicht ausführbar",
      detail: `Datei gefunden unter ${ffmpegOpt}, konnte aber nicht gestartet werden.`
    }
  } else if (ffmpegBundled) {
    checkFfmpeg = {
      id: "ffmpeg",
      title: "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
      status: "ok",
      summary: "Bereit (im App-Ordner)",
      detail: `${ffmpegOpt} (${ffmpegVersionLine})`
    }
  } else {
    checkFfmpeg = {
      id: "ffmpeg",
      title: "FFmpeg-Engine (MKV, Tonspuren & Thumbnails)",
      status: "warn",
      summary: "Extern gefunden",
      detail: `Gefunden unter ${ffmpegOpt} – 'Automatisch reparieren' kopiert ffmpeg.exe fest nach media\\video\\ffmpeg.exe.`
    }
  }

  const expectedCodecs = ["aac", "dca", "ac3", "eac3", "subrip", "webvtt"]
  const supportedCodecs = []
  if (ffmpegOpt && ffmpegExecOk) {
    try {
      const r = spawnSync(ffmpegOpt, ["-hide_banner", "-codecs"], { windowsHide: true, encoding: "utf8" })
      if (r.status === 0) {
        const lower = String(r.stdout || "").toLowerCase()
        for (const c of expectedCodecs) {
          if (lower.includes(c)) supportedCodecs.push(c)
        }
      }
    } catch (e) {}
  }

  let checkCodecs
  if (!ffmpegOpt || !ffmpegExecOk) {
    checkCodecs = {
      id: "codecs",
      title: "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
      status: "err",
      summary: "Nicht prüfbar",
      detail: "FFmpeg erforderlich, um DTS/AC3/E-AC3 zu decodieren und WebVTT/SRT-Untertitel zu extrahieren."
    }
  } else if (supportedCodecs.length === expectedCodecs.length) {
    checkCodecs = {
      id: "codecs",
      title: "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
      status: "ok",
      summary: `${supportedCodecs.length}/${expectedCodecs.length} Codecs aktiv`,
      detail: `Aktiv: ${supportedCodecs.join(", ").toUpperCase()} – DTS, AC3, E-AC3, AAC sowie MKV-Untertitel (SRT/ASS/WebVTT) werden voll unterstützt.`
    }
  } else if (supportedCodecs.includes("aac") && supportedCodecs.includes("dca") && supportedCodecs.includes("webvtt")) {
    checkCodecs = {
      id: "codecs",
      title: "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
      status: "warn",
      summary: `${supportedCodecs.length}/${expectedCodecs.length} Codecs aktiv`,
      detail: `Erkannt: ${supportedCodecs.join(", ").toUpperCase()}`
    }
  } else {
    checkCodecs = {
      id: "codecs",
      title: "Audio- & Untertitel-Codecs (AAC, DTS, AC3, WebVTT)",
      status: "err",
      summary: "Eingeschränkt",
      detail: "Wichtige Codecs (AAC/DTS/WebVTT) fehlen in der verwendeten ffmpeg.exe."
    }
  }

  const folderErrors = []
  for (const dir of [
    mediaDir,
    path.join(mediaDir, "video"),
    path.join(mediaDir, "music"),
    path.join(mediaDir, "covers"),
    path.join(mediaDir, ".mkv_cache"),
    path.join(mediaDir, ".sub_cache")
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, ".write_test")
      fs.writeFileSync(probe, "ok", "utf8")
      fs.unlinkSync(probe)
    } catch (e) {
      folderErrors.push(`${dir}: ${e.message}`)
    }
  }
  const checkFolders = folderErrors.length === 0
    ? {
        id: "folders",
        title: "Medien- & Cache-Ordner (.mkv_cache, .sub_cache)",
        status: "ok",
        summary: "Alle 6 Ordner beschreibbar",
        detail: `Medienbasis: ${mediaDir}`
      }
    : {
        id: "folders",
        title: "Medien- & Cache-Ordner (.mkv_cache, .sub_cache)",
        status: "err",
        summary: `${folderErrors.length} Problem(e)`,
        detail: folderErrors.join(" | ")
      }

  let fontCount = 0
  let presetCount = 0
  try {
    fontCount = fs.readdirSync(path.join(mediaDir, "fonts")).filter((n) => /\.(ttf|otf)$/i.test(n)).length
  } catch (e) {}
  try {
    presetCount = fs.readdirSync(path.join(mediaDir, "presets")).filter((n) => /\.png$/i.test(n)).length
  } catch (e) {}
  const checkAssets = fontCount >= 9 && presetCount >= 7
    ? {
        id: "assets",
        title: "Zeichenstudio, Equalizer & Oberfläche",
        status: "ok",
        summary: `${fontCount} Fonts · ${presetCount} Presets`,
        detail: "Alle Schriftarten, Cursor-Presets sowie AudioContext-Equalizer sind einsatzbereit."
      }
    : {
        id: "assets",
        title: "Zeichenstudio, Equalizer & Oberfläche",
        status: "warn",
        summary: `${fontCount}/9 Fonts · ${presetCount}/7 Presets`,
        detail: "Einige Font- oder Preset-Ressourcen in media\\fonts / media\\presets fehlen – klicke auf 'Automatisch reparieren', um sie automatisch von GitHub nachzuladen."
      }

  let updaterStatus = "err"
  let updaterSummary = "Nicht verfügbar"
  let updaterDetail = "Fetch / Netzwerkmodul fehlt."
  if (typeof fetch === "function") {
    updaterStatus = "ok"
    updaterSummary = isPackaged ? "Bereit (app.asar Patcher)" : "Bereit (Entwicklungsmodus)"
    updaterDetail = "Integrierter HTTP-Download (Node Fetch) & Patch-Updater aktiv."
  }
  const checkUpdater = {
    id: "updater",
    title: "Online-Updater & Netzwerk-Download",
    status: updaterStatus,
    summary: updaterSummary,
    detail: updaterDetail
  }

  const checks = [checkBridge, checkFfmpeg, checkCodecs, checkFolders, checkAssets, checkUpdater]
  const allReady = checks.every((c) => c.status === "ok")

  return {
    ok: true,
    allReady,
    runtime: "electron",
    runtimeLabel: "Electron Desktop",
    version,
    isPackaged,
    appDir,
    mediaDir,
    execPath: process.execPath,
    ffmpegPath: ffmpegOpt || null,
    ffmpegBundled,
    supportedCodecs,
    checks
  }
}

function notifyElectronRepairProgress(label, percent, downloadedBytes, totalBytes) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const payload = JSON.stringify({
        label,
        percent: Math.min(100, Math.max(0, Math.round(percent || 0))),
        downloadedBytes: downloadedBytes || 0,
        totalBytes: totalBytes || 0
      })
      mainWindow.webContents.executeJavaScript(`window.__onSystemRepairProgress && window.__onSystemRepairProgress(${payload});`).catch(() => {})
    }
  } catch (e) {}
}

async function downloadGithubAssetElectron(cleanRepo, token, assetName, destFile, expectedSize, label) {
  try { fs.unlinkSync(destFile) } catch (e) {}
  let url = `https://github.com/${cleanRepo}/releases/latest/download/${assetName}`
  const headers = { "User-Agent": "My-Media-App-Updater" }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
    const relRes = await fetch(`https://api.github.com/repos/${cleanRepo}/releases?per_page=8`, {
      headers: { ...headers, Accept: "application/vnd.github.v3+json" }
    })
    if (relRes.ok) {
      const releases = await relRes.json()
      for (const rel of (Array.isArray(releases) ? releases : [])) {
        const found = (rel.assets || []).find((a) => String(a.name || "").toLowerCase() === assetName.toLowerCase())
        if (found) {
          url = `https://api.github.com/repos/${cleanRepo}/releases/assets/${found.id}`
          headers["Accept"] = "application/octet-stream"
          if (found.size > 0) expectedSize = found.size
          break
        }
      }
    }
  }

  let res = await fetch(url, { headers, redirect: "follow" })
  if (!res.ok && !token) {
    const relRes = await fetch(`https://api.github.com/repos/${cleanRepo}/releases?per_page=8`, {
      headers: { "User-Agent": "My-Media-App-Updater", Accept: "application/vnd.github.v3+json" }
    })
    if (relRes.ok) {
      const releases = await relRes.json()
      for (const rel of (Array.isArray(releases) ? releases : [])) {
        const found = (rel.assets || []).find((a) => String(a.name || "").toLowerCase() === assetName.toLowerCase())
        if (found && found.browser_download_url) {
          if (found.size > 0) expectedSize = found.size
          res = await fetch(found.browser_download_url, { headers, redirect: "follow" })
          break
        }
      }
    }
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  const totalBytes = parseInt(res.headers.get("content-length") || "0", 10) || expectedSize || 0
  let downloadedBytes = 0
  notifyElectronRepairProgress(label, 1, 0, totalBytes)

  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length
      const pct = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes * 100) / totalBytes)) : 50
      notifyElectronRepairProgress(label, pct, downloadedBytes, totalBytes)
      callback(null, chunk)
    }
  })

  await pipeline(Readable.fromWeb(res.body), progressStream, fs.createWriteStream(destFile))
  const finalSize = fs.existsSync(destFile) ? fs.statSync(destFile).size : 0
  if (finalSize < 256) {
    try { fs.unlinkSync(destFile) } catch (e) {}
    throw new Error("Heruntergeladene Datei ist leer")
  }
  notifyElectronRepairProgress(label, 100, finalSize, Math.max(totalBytes, finalSize))
  return finalSize
}

function copyMissingFilesInDirNode(srcDir, dstDir) {
  let copied = 0
  try {
    if (!fs.existsSync(srcDir)) return 0
    fs.mkdirSync(dstDir, { recursive: true })
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const dest = path.join(dstDir, entry.name)
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(srcDir, entry.name), dest)
          copied++
        }
      }
    }
  } catch (e) {}
  return copied
}

function extractZipArchiveNode(zipPath, extractDir) {
  try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch (e) {}
  fs.mkdirSync(extractDir, { recursive: true })
  try {
    const r = spawnSync("tar.exe", ["-xf", zipPath, "-C", extractDir], { windowsHide: true })
    if (r.status === 0) return true
  } catch (e) {}
  try {
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true })
    return r.status === 0
  } catch (e) {
    return false
  }
}

async function runSystemRepairAsync(opts = {}) {
  const { appDir, mediaDir } = getBridgePaths()
  const repairedActions = []
  const rawRepo = String((opts && opts.repo) || "tobiaslechert445-gif/Video-App").trim()
  const cleanRepo = rawRepo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").trim()
  const token = String((opts && opts.token) || "").trim()
  const customFfmpegPath = opts && opts.customFfmpegPath

  for (const sub of ["video", "music", "covers", "snapshots", "references", "logo", "cursor", "fonts", "presets", ".mkv_cache", ".sub_cache"]) {
    const d = path.join(mediaDir, sub)
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true })
        repairedActions.push(`Ordner erstellt: ${d}`)
      } catch (e) {}
    }
  }
  try { fs.mkdirSync(path.join(appDir, "assets"), { recursive: true }) } catch (e) {}

  clearFfmpegAndProbeCaches()
  const destFfmpeg = path.join(mediaDir, "video", "ffmpeg.exe")
  const custom = String(customFfmpegPath || "").trim()
  if (custom && fs.existsSync(custom) && fs.statSync(custom).isFile()) {
    if (normalizePathKey(custom) !== normalizePathKey(destFfmpeg)) {
      fs.copyFileSync(custom, destFfmpeg)
      repairedActions.push(`FFmpeg von ${custom} nach ${destFfmpeg} installiert`)
    }
  } else if (!fs.existsSync(destFfmpeg)) {
    const found = findFfmpeg(mediaDir)
    if (found && normalizePathKey(found) !== normalizePathKey(destFfmpeg)) {
      fs.copyFileSync(found, destFfmpeg)
      repairedActions.push(`FFmpeg automatisch lokal von ${found} nach ${destFfmpeg} kopiert`)
    }
  }

  if (!fs.existsSync(destFfmpeg) && cleanRepo) {
    const tmpFfmpeg = path.join(mediaDir, "video", "ffmpeg.download.tmp.exe")
    try {
      const bytes = await downloadGithubAssetElectron(
        cleanRepo,
        token,
        "ffmpeg.exe",
        tmpFfmpeg,
        101060096,
        "⬇️ Lade fehlende ffmpeg.exe von GitHub herunter…"
      )
      const head = Buffer.alloc(2)
      const fd = fs.openSync(tmpFfmpeg, "r")
      fs.readSync(fd, head, 0, 2, 0)
      fs.closeSync(fd)
      if (head.toString("ascii") === "MZ") {
        fs.renameSync(tmpFfmpeg, destFfmpeg)
        repairedActions.push(`ffmpeg.exe automatisch von GitHub heruntergeladen (${(bytes / (1024 * 1024)).toFixed(1)} MB) & installiert`)
      } else {
        try { fs.unlinkSync(tmpFfmpeg) } catch (e) {}
      }
    } catch (e) {
      try { fs.unlinkSync(tmpFfmpeg) } catch (err) {}
      repairedActions.push(`FFmpeg GitHub-Download fehlgeschlagen: ${e.message}`)
    }
  }

  const countAssets = () => {
    let f = 0, p = 0
    try { f = fs.readdirSync(path.join(mediaDir, "fonts")).filter((n) => /\.(ttf|otf)$/i.test(n)).length } catch (e) {}
    try { p = fs.readdirSync(path.join(mediaDir, "presets")).filter((n) => /\.png$/i.test(n)).length } catch (e) {}
    return { f, p }
  }

  let { f: fontCount, p: presetCount } = countAssets()
  if ((fontCount < 9 || presetCount < 7 || !fs.existsSync(path.join(appDir, "assets", "logo.png")) || (opts && opts.forceGithubAssets)) && cleanRepo) {
    const tmpZip = path.join(os.tmpdir(), "my_view_assets_repair.zip")
    const extractDir = path.join(os.tmpdir(), "my_view_assets_extract")
    try {
      await downloadGithubAssetElectron(
        cleanRepo,
        token,
        "my_view_assets.zip",
        tmpZip,
        1160000,
        "⬇️ Lade fehlende Studio-Ressourcen (Fonts & Presets) von GitHub…"
      )
      if (extractZipArchiveNode(tmpZip, extractDir)) {
        const cf = copyMissingFilesInDirNode(path.join(extractDir, "fonts"), path.join(mediaDir, "fonts"))
        const cp = copyMissingFilesInDirNode(path.join(extractDir, "presets"), path.join(mediaDir, "presets"))
        const cv = copyMissingFilesInDirNode(path.join(extractDir, "video"), path.join(mediaDir, "video"))
        const ca = copyMissingFilesInDirNode(path.join(extractDir, "assets"), path.join(appDir, "assets"))
        repairedActions.push(`Studio-Ressourcen von GitHub geladen (${cf} Fonts, ${cp} Presets, ${cv + ca} Hilfsdateien ergänzt)`)
      }
    } catch (e) {}
    try { fs.unlinkSync(tmpZip) } catch (e) {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch (e) {}
  }

  for (const sub of [".mkv_cache", ".sub_cache"]) {
    const d = path.join(mediaDir, sub)
    try {
      for (const name of fs.readdirSync(d)) {
        if (name.toLowerCase().includes(".tmp.")) {
          try {
            fs.unlinkSync(path.join(d, name))
            repairedActions.push(`Verwaiste Temp-Datei bereinigt: ${name}`)
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  clearFfmpegAndProbeCaches()
  const payload = buildSystemCheckPayload()
  payload.repairedActions = repairedActions
  return payload
}

// Local HTTP Bridge Server for Twitch, YouTube, Multi-Audio/Subtitles & Diagnostics
function startStreamBridgeServer() {
  if (streamBridgeServer) return;
  try {
    streamBridgeServer = http.createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Range'
        });
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url, `http://127.0.0.1:${STREAM_BRIDGE_PORT}`);
      const pathname = parsedUrl.pathname;
      const { appDir, mediaDir, isPackaged } = getBridgePaths();

      if (pathname === '/api/info') {
        sendBridgeJson(res, 200, {
          version: app ? app.getVersion() : '1.0.0',
          isPackaged,
          appDir,
          mediaDir,
          execPath: process.execPath,
          resourcesDir: process.resourcesPath || appDir,
          homeDir: os.homedir(),
          tempDir: os.tmpdir()
        });
        return;
      }

      if (pathname === '/api/system-check') {
        sendBridgeJson(res, 200, buildSystemCheckPayload());
        return;
      }

      if (pathname === '/api/system-repair') {
        const body = await readBridgeJsonBody(req);
        sendBridgeJson(res, 200, await runSystemRepairAsync(body));
        return;
      }

      if (pathname === '/api/media/tracks') {
        const body = await readBridgeJsonBody(req);
        const rawPath = String(body.path || '').trim();
        if (!rawPath) {
          sendBridgeJson(res, 400, { error: 'Missing path' });
          return;
        }
        const { primary, companion } = resolveTrackSourcePaths(rawPath);
        if (!primary) {
          sendBridgeJson(res, 404, { error: 'Media file not found' });
          return;
        }
        const probed = await probeMediaTracksAsync(primary, mediaDir);
        if (companion) {
          const comp = await probeMediaTracksAsync(companion, mediaDir);
          if (comp.audio.length > probed.audio.length) probed.audio = comp.audio;
          if (probed.subtitles.length === 0 && comp.subtitles.length > 0) probed.subtitles = comp.subtitles;
        }
        const savedDir = savedSubsDirForMedia(mediaDir, rawPath);
        if (probed.subtitles.length === 0) {
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(savedDir, 'manifest.json'), 'utf8'));
            if (Array.isArray(manifest) && manifest.length > 0) probed.subtitles = manifest;
          } catch (e) {}
        }
        try {
          const savedAudio = JSON.parse(fs.readFileSync(path.join(savedDir, 'audio_tracks.json'), 'utf8'));
          if (Array.isArray(savedAudio) && savedAudio.length === probed.audio.length) {
            probed.audio.forEach((dst, idx) => {
              const src = savedAudio[idx] || {};
              if (!dst.title && src.title) dst.title = src.title;
              if (!dst.codecDisplay && src.codecDisplay) dst.codecDisplay = src.codecDisplay;
              if (!dst.channels && src.channels) dst.channels = src.channels;
            });
          }
        } catch (e) {}
        sendBridgeJson(res, 200, {
          ok: true,
          path: rawPath,
          resolvedPath: primary,
          ffmpegAvailable: Boolean(findFfmpeg(mediaDir)),
          audioTracks: probed.audio,
          subtitleTracks: probed.subtitles
        });
        return;
      }

      if (pathname === '/api/media/extract_subtitles') {
        const body = await readBridgeJsonBody(req);
        const rawPath = String(body.path || '').trim();
        if (!rawPath) {
          sendBridgeJson(res, 400, { error: 'Missing path' });
          return;
        }
        let srcPath = fs.existsSync(rawPath) && fs.statSync(rawPath).isFile() ? rawPath : resolveTrackSourcePaths(rawPath).primary;
        if (!srcPath) {
          sendBridgeJson(res, 404, { error: 'Media file not found' });
          return;
        }
        const ffmpeg = findFfmpeg(mediaDir);
        if (!ffmpeg) {
          sendBridgeJson(res, 200, { ok: false, count: 0, error: 'ffmpeg missing' });
          return;
        }
        const probed = await probeMediaTracksAsync(srcPath, mediaDir);
        const savedDir = savedSubsDirForMedia(mediaDir, rawPath);
        fs.mkdirSync(savedDir, { recursive: true });
        if (probed.audio.length > 0) {
          try { fs.writeFileSync(path.join(savedDir, 'audio_tracks.json'), JSON.stringify(probed.audio, null, 2), 'utf8'); } catch (e) {}
        }
        const manifest = [];
        for (const item of probed.subtitles) {
          if (!item.isText) continue;
          const vttName = `sub_${item.index}.vtt`;
          const outVtt = path.join(savedDir, vttName);
          const tmpVtt = path.join(savedDir, `sub_${item.index}.tmp.vtt`);
          try { fs.unlinkSync(tmpVtt); } catch (e) {}
          const r = await runCommandAsync(ffmpeg, [
            '-nostdin', '-err_detect', 'ignore_err', '-i', srcPath,
            '-map', `0:s:${item.index}`, '-c:s', 'webvtt', '-y', tmpVtt
          ]);
          if (r.ok && fs.existsSync(tmpVtt) && fs.statSync(tmpVtt).size > 10) {
            fs.renameSync(tmpVtt, outVtt);
            manifest.push({ ...item, source: 'saved', file: vttName });
          } else {
            try { fs.unlinkSync(tmpVtt); } catch (e) {}
          }
        }
        try { fs.writeFileSync(path.join(savedDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); } catch (e) {}
        sendBridgeJson(res, 200, { ok: true, count: manifest.length, savedDir, subtitleTracks: manifest });
        return;
      }

      if (pathname === '/media') {
        const rawPath = parsedUrl.searchParams.get('path') || '';
        if (!rawPath) { sendBridgeJson(res, 400, { error: 'Missing path param' }); return; }
        let target = null;
        if (fs.existsSync(rawPath) && fs.statSync(rawPath).isFile()) {
          target = await resolvePlayableMediaPathAsync(rawPath, mediaDir);
        } else if (rawPath.toLowerCase().endsWith('.mkv')) {
          const parsed = path.parse(rawPath);
          const twin = path.join(parsed.dir, `${parsed.name}.mp4`);
          if (fs.existsSync(twin) && fs.statSync(twin).isFile()) target = twin;
        }
        if (!target) { sendBridgeJson(res, 404, { error: 'Media file not found' }); return; }
        serveBridgeFileWithRanges(req, res, target);
        return;
      }

      if (pathname === '/media/audio') {
        const rawPath = parsedUrl.searchParams.get('path') || '';
        const track = parseInt(parsedUrl.searchParams.get('track') || '', 10);
        if (!rawPath || isNaN(track) || track < 0 || track >= 32) {
          sendBridgeJson(res, 400, { error: 'Invalid track or path param' });
          return;
        }
        const { primary, companion } = resolveTrackSourcePaths(rawPath);
        if (!primary) { sendBridgeJson(res, 404, { error: 'Media file not found' }); return; }
        let audioSrc = primary;
        if (companion) {
          const pProbe = await probeMediaTracksAsync(primary, mediaDir);
          if (track >= pProbe.audio.length) audioSrc = companion;
        }
        const cacheDir = path.join(mediaDir, '.mkv_cache');
        const cacheM4a = path.join(cacheDir, `audio_${fileHashHex(audioSrc, `a${track}`)}_t${track}.m4a`);
        if (fs.existsSync(cacheM4a) && fs.statSync(cacheM4a).size > 128) {
          serveBridgeFileWithRanges(req, res, cacheM4a);
          return;
        }
        const ffmpeg = findFfmpeg(mediaDir);
        if (!ffmpeg) { sendBridgeJson(res, 500, { error: 'ffmpeg.exe nicht gefunden' }); return; }
        const ok = await runSerializedMediaJob(cacheM4a, async () => {
          if (fs.existsSync(cacheM4a) && fs.statSync(cacheM4a).size > 128) return true;
          fs.mkdirSync(cacheDir, { recursive: true });
          const tmpM4a = path.join(cacheDir, `audio_${fileHashHex(audioSrc, `a${track}`)}_t${track}.tmp.m4a`);
          const aProbed = await probeMediaTracksAsync(audioSrc, mediaDir);
          const codec = aProbed.audio[track] ? aProbed.audio[track].codec : '';
          const canCopy = codec === 'aac';
          const extract = async (copyOnly) => {
            try { fs.unlinkSync(tmpM4a); } catch (e) {}
            const args = ['-nostdin', '-err_detect', 'ignore_err'];
            if (!copyOnly) args.push('-fflags', '+genpts');
            args.push('-i', audioSrc, '-vn', '-sn', '-dn', '-map', `0:a:${track}`);
            if (copyOnly) args.push('-c:a', 'copy');
            else args.push('-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '320k', '-ac', '2');
            args.push('-movflags', '+faststart', '-y', tmpM4a);
            const r = await runCommandAsync(ffmpeg, args);
            return r.ok && fs.existsSync(tmpM4a) && fs.statSync(tmpM4a).size > 128;
          };
          if ((canCopy && (await extract(true))) || (await extract(false))) {
            fs.renameSync(tmpM4a, cacheM4a);
            return true;
          }
          try { fs.unlinkSync(tmpM4a); } catch (e) {}
          return false;
        });
        if (ok && fs.existsSync(cacheM4a)) {
          serveBridgeFileWithRanges(req, res, cacheM4a);
        } else {
          sendBridgeJson(res, 500, { error: 'Audio track extraction failed' });
        }
        return;
      }

      if (pathname === '/media/subtitle') {
        const rawPath = parsedUrl.searchParams.get('path') || '';
        const track = parseInt(parsedUrl.searchParams.get('track') || '', 10);
        if (!rawPath || isNaN(track) || track < 0 || track >= 32) {
          sendBridgeJson(res, 400, { error: 'Invalid track or path param' });
          return;
        }
        const savedDir = savedSubsDirForMedia(mediaDir, rawPath);
        const savedVtt = path.join(savedDir, `sub_${track}.vtt`);
        if (fs.existsSync(savedVtt) && fs.statSync(savedVtt).size > 10) {
          serveBridgeFileWithRanges(req, res, savedVtt);
          return;
        }
        const { primary, companion } = resolveTrackSourcePaths(rawPath);
        if (!primary) { sendBridgeJson(res, 404, { error: 'Media file not found' }); return; }
        let subSrc = primary;
        if (companion) {
          const pProbe = await probeMediaTracksAsync(primary, mediaDir);
          if (track >= pProbe.subtitles.length) subSrc = companion;
        }
        const cacheDir = path.join(mediaDir, '.sub_cache');
        const cacheVtt = path.join(cacheDir, `sub_${fileHashHex(subSrc, `s${track}`)}_s${track}.vtt`);
        if (fs.existsSync(cacheVtt) && fs.statSync(cacheVtt).size > 10) {
          serveBridgeFileWithRanges(req, res, cacheVtt);
          return;
        }
        const ffmpeg = findFfmpeg(mediaDir);
        if (!ffmpeg) { sendBridgeJson(res, 500, { error: 'ffmpeg.exe nicht gefunden' }); return; }
        const ok = await runSerializedMediaJob(cacheVtt, async () => {
          if (fs.existsSync(cacheVtt) && fs.statSync(cacheVtt).size > 10) return true;
          fs.mkdirSync(cacheDir, { recursive: true });
          const tmpVtt = path.join(cacheDir, `sub_${fileHashHex(subSrc, `s${track}`)}_s${track}.tmp.vtt`);
          try { fs.unlinkSync(tmpVtt); } catch (e) {}
          const r = await runCommandAsync(ffmpeg, [
            '-nostdin', '-err_detect', 'ignore_err', '-i', subSrc,
            '-map', `0:s:${track}`, '-c:s', 'webvtt', '-y', tmpVtt
          ]);
          if (r.ok && fs.existsSync(tmpVtt) && fs.statSync(tmpVtt).size > 10) {
            fs.renameSync(tmpVtt, cacheVtt);
            return true;
          }
          try { fs.unlinkSync(tmpVtt); } catch (e) {}
          return false;
        });
        if (ok && fs.existsSync(cacheVtt)) {
          serveBridgeFileWithRanges(req, res, cacheVtt);
        } else {
          sendBridgeJson(res, 500, { error: 'Subtitle track extraction failed' });
        }
        return;
      }

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

ipcMain.handle("run-system-check", async () => {
  try {
    return buildSystemCheckPayload();
  } catch (err) {
    return { ok: false, allReady: false, error: err.message, checks: [] };
  }
});

ipcMain.handle("run-system-repair", async (event, opts = {}) => {
  try {
    return await runSystemRepairAsync(opts || {});
  } catch (err) {
    return { ok: false, allReady: false, error: err.message, checks: [], repairedActions: [] };
  }
});

ipcMain.handle("pick-ffmpeg-file", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: "ffmpeg.exe auswählen",
      filters: [{ name: "FFmpeg Executable", extensions: ["exe"] }],
      properties: ["openFile"]
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const chosenFile = res.filePaths[0];
    const { mediaDir } = getBridgePaths();
    const targetDir = path.join(mediaDir, "video");
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = path.join(targetDir, "ffmpeg.exe");
    if (normalizePathKey(chosenFile) !== normalizePathKey(dest)) {
      fs.copyFileSync(chosenFile, dest);
    }
    clearFfmpegAndProbeCaches();
    return { success: true, canceled: false, filePath: chosenFile, installedTo: dest };
  } catch (err) {
    return { success: false, canceled: false, error: err.message };
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