(function () {
  "use strict";

  // Im Electron-Kontext macht diese Bridge nichts (natives Node.js/Electron ist bereits aktiv).
  if (
    typeof window.require === "function" &&
    window.process &&
    window.process.versions &&
    window.process.versions.electron
  ) {
    return;
  }

  const BRIDGE_ORIGIN = "http://127.0.0.1:45678";

  function rpcSync(endpoint, payload) {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BRIDGE_ORIGIN + endpoint, false);
    xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
    xhr.send(JSON.stringify(payload || {}));
    if (xhr.status >= 400) {
      let msg = xhr.responseText || ("HTTP " + xhr.status);
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (parsed && parsed.error) msg = parsed.error;
      } catch (e) {}
      const err = new Error(msg);
      throw err;
    }
    if (!xhr.responseText) return null;
    try {
      return JSON.parse(xhr.responseText);
    } catch (e) {
      return xhr.responseText;
    }
  }

  async function rpcAsync(endpoint, payload) {
    const res = await fetch(BRIDGE_ORIGIN + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = text;
    }
    if (!res.ok) {
      throw new Error((data && data.error) || text || ("HTTP " + res.status));
    }
    return data;
  }

  let appInfo = {
    version: "1.0.0",
    isPackaged: false,
    appDir: "E:\\My_Media_App",
    mediaDir: "E:\\My_Media_App\\media",
    execPath: "E:\\My_Media_App\\my-media-app.exe",
    resourcesDir: "E:\\My_Media_App",
    homeDir: "C:\\Users\\Public",
    tempDir: "C:\\Windows\\Temp"
  };

  function normalizeWinDrive(p) {
    if (!p || typeof p !== "string") return p;
    return p.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ":");
  }

  try {
    const loaded = rpcSync("/api/info", {});
    if (loaded && loaded.appDir) {
      loaded.appDir = normalizeWinDrive(loaded.appDir);
      loaded.mediaDir = normalizeWinDrive(loaded.mediaDir);
      loaded.execPath = normalizeWinDrive(loaded.execPath);
      loaded.resourcesDir = normalizeWinDrive(loaded.resourcesDir);
      appInfo = loaded;
    }
  } catch (e) {
    console.warn("[TauriBridge] Konnte /api/info nicht abrufen:", e);
  }

  window.__tauriRuntime = true;
  window.__tauriIsPackaged = Boolean(appInfo.isPackaged);
  window.__dirname = appInfo.appDir.replace(/[\\/]+$/, "") + "\\src";
  window.process = {
    execPath: appInfo.execPath,
    resourcesPath: appInfo.resourcesDir,
    platform: "win32",
    argv: [],
    env: {},
    versions: {}
  };

  // ==========================================================
  // URL / MEDIA PATH HELPER (file:/// -> http://127.0.0.1:45678/media?path=...)
  // ==========================================================
  function splitPathAndQuery(raw) {
    const clean = String(raw || "").split("#")[0];
    const qIdx = clean.indexOf("?");
    if (qIdx === -1) return { base: clean, query: "" };
    return { base: clean.slice(0, qIdx), query: clean.slice(qIdx + 1) };
  }

  function fileUrlToLocalPath(input) {
    if (!input) return "";
    const s = String(input);
    if (s.startsWith(BRIDGE_ORIGIN + "/media?")) {
      try {
        const u = new URL(s);
        return normalizeWinDrive(u.searchParams.get("path") || "");
      } catch (e) {
        return "";
      }
    }
    const base = splitPathAndQuery(s).base;
    if (base.startsWith("file://")) {
      let rest = base.slice(7);
      if (rest.startsWith("/")) rest = rest.slice(1);
      if (/^\/+[A-Za-z]:/.test(rest)) rest = rest.replace(/^\/+/, "");
      try {
        rest = decodeURIComponent(rest);
      } catch (e) {}
      return normalizeWinDrive(rest.replace(/\//g, "\\"));
    }
    return normalizeWinDrive(base);
  }

  function localPathToFileUrl(p) {
    if (!p) return "";
    let s = normalizeWinDrive(String(p)).replace(/\\/g, "/");
    if (!s.startsWith("/")) s = "/" + s;
    const parts = s.split("/").map((seg, idx) => {
      if (idx === 1 && /^[A-Za-z]:$/.test(seg)) return seg;
      return encodeURIComponent(seg);
    });
    return "file://" + parts.join("/");
  }

  function toBridgeMediaUrl(raw) {
    if (!raw) return raw;
    const s = String(raw).trim();
    if (!s) return raw;
    if (
      s.startsWith("http://") ||
      s.startsWith("https://") ||
      s.startsWith("data:") ||
      s.startsWith("blob:")
    ) {
      return raw;
    }
    if (s.startsWith("file://")) {
      const { base, query } = splitPathAndQuery(s);
      const local = fileUrlToLocalPath(base);
      return BRIDGE_ORIGIN + "/media?path=" + encodeURIComponent(local) + (query ? "&" + query : "");
    }
    if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\")) {
      const { base, query } = splitPathAndQuery(s);
      return BRIDGE_ORIGIN + "/media?path=" + encodeURIComponent(base) + (query ? "&" + query : "");
    }
    return raw;
  }

  function rewriteFileUrlsInHtmlString(str) {
    if (typeof str !== "string" || str.indexOf("file://") === -1) return str;
    return str.replace(/file:\/\/\/?[^\s"'<>`)]+/gi, (match) => {
      return toBridgeMediaUrl(match);
    });
  }

  // Transparentes Media-Routing in Tauri WebView2 (lässt localStorage file:/// Keys unverändert!)
  function patchDomWindowPrototypes(targetWin) {
    if (!targetWin || targetWin.__tauriDomPatched) return;
    targetWin.__tauriDomPatched = true;
    try {
      const patchSrcDescriptor = (Proto) => {
        if (!Proto) return;
        const desc = Object.getOwnPropertyDescriptor(Proto, "src");
        if (!desc || !desc.set || !desc.get) return;
        Object.defineProperty(Proto, "src", {
          configurable: true,
          enumerable: true,
          get() {
            return desc.get.call(this);
          },
          set(val) {
            return desc.set.call(this, toBridgeMediaUrl(val));
          }
        });
      };
      patchSrcDescriptor(targetWin.HTMLMediaElement && targetWin.HTMLMediaElement.prototype);
      patchSrcDescriptor(targetWin.HTMLImageElement && targetWin.HTMLImageElement.prototype);
      patchSrcDescriptor(targetWin.HTMLSourceElement && targetWin.HTMLSourceElement.prototype);

      const ElProto = targetWin.Element && targetWin.Element.prototype;
      if (ElProto) {
        const origSetAttr = ElProto.setAttribute;
        ElProto.setAttribute = function (name, value) {
          if (String(name).toLowerCase() === "src" && typeof value === "string") {
            value = toBridgeMediaUrl(value);
          }
          return origSetAttr.call(this, name, value);
        };

        const innerDesc = Object.getOwnPropertyDescriptor(ElProto, "innerHTML");
        if (innerDesc && innerDesc.set && innerDesc.get) {
          Object.defineProperty(ElProto, "innerHTML", {
            configurable: true,
            enumerable: true,
            get() {
              return innerDesc.get.call(this);
            },
            set(val) {
              return innerDesc.set.call(this, rewriteFileUrlsInHtmlString(val));
            }
          });
        }

        const outerDesc = Object.getOwnPropertyDescriptor(ElProto, "outerHTML");
        if (outerDesc && outerDesc.set && outerDesc.get) {
          Object.defineProperty(ElProto, "outerHTML", {
            configurable: true,
            enumerable: true,
            get() {
              return outerDesc.get.call(this);
            },
            set(val) {
              return outerDesc.set.call(this, rewriteFileUrlsInHtmlString(val));
            }
          });
        }
      }

      const NodeProto = targetWin.Node && targetWin.Node.prototype;
      if (NodeProto) {
        const textDesc = Object.getOwnPropertyDescriptor(NodeProto, "textContent");
        if (textDesc && textDesc.set && textDesc.get) {
          Object.defineProperty(NodeProto, "textContent", {
            configurable: true,
            enumerable: true,
            get() {
              return textDesc.get.call(this);
            },
            set(val) {
              if (this.tagName === "STYLE" && typeof val === "string") {
                val = rewriteFileUrlsInHtmlString(val);
              }
              return textDesc.set.call(this, val);
            }
          });
        }
      }
    } catch (e) {
      console.warn("[TauriBridge] Konnte Media-Src Patch nicht komplett anwenden:", e);
    }
  }
  window.__patchTauriDomWindow = patchDomWindowPrototypes;
  patchDomWindowPrototypes(window);

  // ==========================================================
  // NODE.JS SHIMS FÜR require(...)
  // ==========================================================
  const pathShim = {
    sep: "\\",
    delimiter: ";",
    join(...args) {
      const parts = args
        .filter((a) => typeof a === "string" && a.length > 0)
        .map((a) => a.replace(/\//g, "\\"));
      if (parts.length === 0) return ".";
      let joined = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const cur = parts[i].replace(/^\\+/, "");
        joined = joined.replace(/\\+$/, "") + "\\" + cur;
      }
      // .. und . auflösen
      return pathShim.normalize(joined);
    },
    normalize(p) {
      if (!p) return ".";
      let s = String(p).replace(/\//g, "\\");
      let drive = "";
      if (/^[A-Za-z]:/.test(s)) {
        drive = s.slice(0, 2);
        s = s.slice(2);
      }
      const isAbs = s.startsWith("\\");
      const segs = s.split(/\\+/).filter(Boolean);
      const stack = [];
      for (const seg of segs) {
        if (seg === ".") continue;
        if (seg === "..") {
          if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
          else if (!isAbs) stack.push("..");
        } else {
          stack.push(seg);
        }
      }
      let out = (drive || "") + (isAbs ? "\\" : "") + stack.join("\\");
      if (drive && isAbs && stack.length === 0) out = drive + "\\";
      return out || ".";
    },
    resolve(...args) {
      let acc = "";
      for (let i = args.length - 1; i >= 0; i--) {
        const p = args[i];
        if (!p) continue;
        acc = acc ? pathShim.join(p, acc) : p;
        if (/^[A-Za-z]:[\\/]/.test(acc) || acc.startsWith("\\\\")) break;
      }
      if (!(/^[A-Za-z]:/.test(acc) || acc.startsWith("\\\\"))) {
        acc = pathShim.join(appInfo.appDir, acc);
      }
      return pathShim.normalize(acc);
    },
    dirname(p) {
      if (!p) return ".";
      const s = String(p).replace(/\//g, "\\").replace(/\\+$/, "");
      const idx = s.lastIndexOf("\\");
      if (idx === -1) return ".";
      if (idx === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
      if (idx === 0) return "\\";
      return s.slice(0, idx);
    },
    basename(p, ext) {
      if (!p) return "";
      const s = String(p).replace(/\//g, "\\").replace(/\\+$/, "");
      const idx = s.lastIndexOf("\\");
      let base = idx === -1 ? s : s.slice(idx + 1);
      if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
      return base;
    },
    extname(p) {
      const base = pathShim.basename(p);
      const idx = base.lastIndexOf(".");
      if (idx <= 0) return "";
      return base.slice(idx);
    },
    parse(p) {
      const s = String(p || "").replace(/\//g, "\\");
      const m = s.match(/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\|\\)/);
      const root = m ? m[1] : "";
      const dir = pathShim.dirname(s);
      const base = pathShim.basename(s);
      const ext = pathShim.extname(base);
      const name = ext ? base.slice(0, base.length - ext.length) : base;
      return { root, dir, base, ext, name };
    }
  };

  const urlShim = {
    pathToFileURL(p) {
      const href = localPathToFileUrl(p);
      return {
        href,
        toString() {
          return href;
        }
      };
    },
    fileURLToPath(u) {
      return fileUrlToLocalPath(typeof u === "string" ? u : (u && u.href) || "");
    }
  };

  function wrapStat(st) {
    const mtime = new Date(st.mtimeMs || Date.now());
    return {
      size: st.size || 0,
      mtimeMs: st.mtimeMs || 0,
      birthtimeMs: st.birthtimeMs || st.mtimeMs || 0,
      mtime,
      birthtime: new Date(st.birthtimeMs || st.mtimeMs || Date.now()),
      isDirectory: () => Boolean(st.isDir),
      isFile: () => Boolean(st.isFile)
    };
  }

  function decodeBase64ToUint8(b64) {
    const bin = atob(b64 || "");
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function encodeDataToBase64(data) {
    if (typeof data === "string") {
      const bytes = new TextEncoder().encode(data);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function attachBufferHelpers(u8) {
    u8.toString = function (outEnc) {
      if (outEnc === "base64") return encodeDataToBase64(u8);
      if (outEnc === "hex") {
        let hex = "";
        for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, "0");
        return hex;
      }
      if (outEnc === "ascii" || outEnc === "latin1") {
        let s = "";
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
      }
      return new TextDecoder("utf-8").decode(u8);
    };
    return u8;
  }

  if (typeof window.Buffer === "undefined") {
    window.Buffer = {
      alloc(size) {
        return attachBufferHelpers(new Uint8Array(size || 0));
      },
      from(data, enc) {
        if (typeof data === "string") {
          if (enc === "base64") return attachBufferHelpers(decodeBase64ToUint8(data));
          return attachBufferHelpers(new TextEncoder().encode(data));
        }
        return attachBufferHelpers(new Uint8Array(data || 0));
      }
    };
  }

  let nextFd = 100;
  const openFds = new Map();

  const fsShim = {
    existsSync(target) {
      try {
        const res = rpcSync("/api/fs", { op: "exists", path: target });
        return Boolean(res && res.exists);
      } catch (e) {
        return false;
      }
    },
    readdirSync(target, options) {
      const withFileTypes = Boolean(options && options.withFileTypes);
      const res = rpcSync("/api/fs", { op: "readdir", path: target, withFileTypes });
      const items = (res && res.items) || [];
      if (!withFileTypes) return items.map((x) => (typeof x === "string" ? x : x.name));
      return items.map((x) => ({
        name: x.name,
        isDirectory: () => Boolean(x.isDir),
        isFile: () => Boolean(x.isFile)
      }));
    },
    statSync(target) {
      const res = rpcSync("/api/fs", { op: "stat", path: target });
      return wrapStat(res);
    },
    lstatSync(target) {
      return fsShim.statSync(target);
    },
    openSync(target) {
      const fd = nextFd++;
      openFds.set(fd, { path: target, pos: 0 });
      return fd;
    },
    readSync(fd, buffer, offset, length, position) {
      const entry = openFds.get(fd);
      if (!entry) throw new Error("EBADF: bad file descriptor");
      const readPos = typeof position === "number" ? position : entry.pos;
      const res = rpcSync("/api/fs", { op: "readSlice", path: entry.path, offset: readPos, length });
      const slice = decodeBase64ToUint8(res && res.base64);
      const copyLen = Math.min(slice.length, length, buffer.length - offset);
      for (let i = 0; i < copyLen; i++) buffer[offset + i] = slice[i];
      if (typeof position !== "number") entry.pos = readPos + copyLen;
      return copyLen;
    },
    closeSync(fd) {
      openFds.delete(fd);
    },
    createWriteStream(target) {
      const chunks = [];
      const listeners = {};
      return {
        write(chunk) {
          const u8 = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk || ""));
          chunks.push(u8);
          return true;
        },
        end(cb) {
          const total = chunks.reduce((a, b) => a + b.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          rpcAsync("/api/fs", { op: "writeBase64", path: target, base64: encodeDataToBase64(merged) })
            .then(() => {
              if (listeners.finish) listeners.finish.forEach((f) => f());
              if (typeof cb === "function") cb();
            })
            .catch((err) => {
              if (listeners.error) listeners.error.forEach((f) => f(err));
              if (typeof cb === "function") cb(err);
            });
        },
        close(cb) {
          if (typeof cb === "function") cb();
        },
        on(ev, fn) {
          if (!listeners[ev]) listeners[ev] = [];
          listeners[ev].push(fn);
          return this;
        }
      };
    },
    readFileSync(target, encodingOrOpts) {
      const enc = typeof encodingOrOpts === "string" ? encodingOrOpts : encodingOrOpts && encodingOrOpts.encoding;
      if (enc === "utf8" || enc === "utf-8") {
        const res = rpcSync("/api/fs", { op: "readText", path: target });
        return (res && res.text) || "";
      }
      const res = rpcSync("/api/fs", { op: "readBase64", path: target });
      return attachBufferHelpers(decodeBase64ToUint8(res && res.base64));
    },
    writeFileSync(target, data, encodingOrOpts) {
      const enc = typeof encodingOrOpts === "string" ? encodingOrOpts : encodingOrOpts && encodingOrOpts.encoding;
      if (enc === "base64" && typeof data === "string") {
        rpcSync("/api/fs", { op: "writeBase64", path: target, base64: data });
        return;
      }
      if (typeof data === "string") {
        rpcSync("/api/fs", { op: "writeText", path: target, text: data });
      } else {
        rpcSync("/api/fs", { op: "writeBase64", path: target, base64: encodeDataToBase64(data) });
      }
    },
    appendFileSync(target, data) {
      rpcSync("/api/fs", { op: "appendText", path: target, text: String(data || "") });
    },
    mkdirSync(target, options) {
      rpcSync("/api/fs", { op: "mkdir", path: target, recursive: Boolean(options && options.recursive) });
    },
    unlinkSync(target) {
      rpcSync("/api/fs", { op: "unlink", path: target });
    },
    copyFileSync(src, dest) {
      rpcSync("/api/fs", { op: "copy", src, dest });
    },
    renameSync(src, dest) {
      rpcSync("/api/fs", { op: "rename", src, dest });
    },
    promises: {
      async readdir(target, options) {
        const withFileTypes = Boolean(options && options.withFileTypes);
        const res = await rpcAsync("/api/fs", { op: "readdir", path: target, withFileTypes });
        const items = (res && res.items) || [];
        if (!withFileTypes) return items.map((x) => (typeof x === "string" ? x : x.name));
        return items.map((x) => ({
          name: x.name,
          size: typeof x.size === "number" ? x.size : 0,
          isDirectory: () => Boolean(x.isDir),
          isFile: () => Boolean(x.isFile)
        }));
      },
      async stat(target) {
        const res = await rpcAsync("/api/fs", { op: "stat", path: target });
        return wrapStat(res);
      },
      async copyFile(src, dest) {
        return rpcAsync("/api/fs", { op: "copy", src, dest });
      },
      async rename(src, dest) {
        return rpcAsync("/api/fs", { op: "rename", src, dest });
      },
      async mkdir(target, options) {
        return rpcAsync("/api/fs", { op: "mkdir", path: target, recursive: Boolean(options && options.recursive) });
      },
      async unlink(target) {
        return rpcAsync("/api/fs", { op: "unlink", path: target });
      },
      async readFile(target, enc) {
        return fsShim.readFileSync(target, enc);
      },
      async writeFile(target, data, enc) {
        return fsShim.writeFileSync(target, data, enc);
      }
    }
  };

  // Echtes RFC-1321 MD5 (UTF-8) für Thumbnail-Hashes (100% kompatibel zu Node crypto.createHash('md5'))
  function md5Hex(inputStr) {
    const bytes = new TextEncoder().encode(String(inputStr || ""));
    const n = bytes.length;
    const wordsLen = (((n + 8) >>> 6) + 1) * 16;
    const words = new Int32Array(wordsLen);
    for (let i = 0; i < n; i++) {
      words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    }
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[wordsLen - 2] = (n * 8) | 0;
    words[wordsLen - 1] = Math.floor((n * 8) / 0x100000000);

    const k = [
      -680876936,-389564586,606105819,-1044525330,-176418897,1200080426,-1473231341,-45705983,
      1770035416,-1958414417,-42063,-1990404162,1804603682,-40341101,-1502002290,1236535329,
      -165796510,-1069501632,643717713,-373897302,-701558691,38016083,-660478335,-405537848,
      568446438,-1019803690,-187363961,1163531501,-1444681467,-51403784,1735328473,-1926607734,
      -378558,-2022574463,1839030562,-35309556,-1530992060,1272893353,-155497632,-1094730640,
      681279174,-358537222,-722521979,76029189,-640364487,-421815835,530742520,-995338651,
      -198630844,1126891415,-1416354905,-57434055,1700485571,-1894986606,-1051523,-2054922799,
      1873313359,-30611744,-1560198380,1309151649,-145523070,-1120210379,718787259,-343485551
    ];
    const r = [
      7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
      5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
      6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
    ];

    let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
    for (let i = 0; i < wordsLen; i += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) {
          f = (B & C) | ((~B) & D);
          g = j;
        } else if (j < 32) {
          f = (D & B) | ((~D) & C);
          g = (5 * j + 1) % 16;
        } else if (j < 48) {
          f = B ^ C ^ D;
          g = (3 * j + 5) % 16;
        } else {
          f = C ^ (B | (~D));
          g = (7 * j) % 16;
        }
        const temp = D;
        D = C;
        C = B;
        const sum = (A + f + k[j] + words[i + g]) | 0;
        const rot = (sum << r[j]) | (sum >>> (32 - r[j]));
        B = (B + rot) | 0;
        A = temp;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    const toHexLE = (w) => {
      let s = "";
      for (let b = 0; b < 4; b++) {
        s += ((w >>> (b * 8)) & 0xff).toString(16).padStart(2, "0");
      }
      return s;
    };
    return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
  }

  const cryptoShim = {
    createHash() {
      let acc = "";
      return {
        update(d) {
          acc += String(d || "");
          return this;
        },
        digest() {
          return md5Hex(acc);
        }
      };
    },
    randomUUID() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  };

  const osShim = {
    homedir: () => appInfo.homeDir || "C:\\Users\\Public",
    tmpdir: () => appInfo.tempDir || "C:\\Windows\\Temp",
    platform: () => "win32"
  };

  const childProcessShim = {
    exec(cmd, opts, cb) {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      rpcAsync("/api/exec", { mode: "shell", command: cmd })
        .then((res) => {
          if (cb) {
            if (res && res.code !== 0 && res.code !== undefined) {
              const err = new Error(res.stderr || "Exit " + res.code);
              cb(err, res.stdout || "", res.stderr || "");
            } else {
              cb(null, (res && res.stdout) || "", (res && res.stderr) || "");
            }
          }
        })
        .catch((err) => {
          if (cb) cb(err, "", err.message);
        });
    },
    spawn(cmd, args) {
      const handlers = { dataStdout: [], dataStderr: [], close: [], error: [] };
      let jobId = null;
      let killed = false;
      let pollTimer = null;
      const proc = {
        stdout: {
          on(ev, fn) {
            if (ev === "data") handlers.dataStdout.push(fn);
          }
        },
        stderr: {
          on(ev, fn) {
            if (ev === "data") handlers.dataStderr.push(fn);
          }
        },
        on(ev, fn) {
          if (ev === "close") handlers.close.push(fn);
          if (ev === "error") handlers.error.push(fn);
        },
        kill() {
          killed = true;
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          if (jobId !== null) {
            rpcAsync("/api/exec_kill", { id: jobId }).catch(() => {});
          }
        },
        unref() {}
      };
      rpcAsync("/api/exec_start", { command: cmd, args: args || [] })
        .then((startRes) => {
          jobId = startRes && startRes.id;
          if (!jobId) throw new Error("Missing exec job id");
          if (killed) {
            rpcAsync("/api/exec_kill", { id: jobId }).catch(() => {});
            handlers.close.forEach((f) => f(1));
            return;
          }
          let inFlight = false;
          pollTimer = setInterval(async () => {
            if (inFlight) return;
            inFlight = true;
            try {
              const res = await rpcAsync("/api/exec_poll", { id: jobId });
              if (res && res.stdout) handlers.dataStdout.forEach((f) => f(res.stdout));
              if (res && res.stderr) handlers.dataStderr.forEach((f) => f(res.stderr));
              if (res && res.done) {
                clearInterval(pollTimer);
                pollTimer = null;
                handlers.close.forEach((f) => f(typeof res.code === "number" ? res.code : 0));
              }
            } catch (err) {
              clearInterval(pollTimer);
              pollTimer = null;
              handlers.error.forEach((f) => f(err));
              handlers.close.forEach((f) => f(1));
            } finally {
              inFlight = false;
            }
          }, 250);
        })
        .catch((err) => {
          handlers.error.forEach((f) => f(err));
          handlers.close.forEach((f) => f(1));
        });
      return proc;
    }
  };

  const httpShim = {
    createServer() {
      return {
        listen(port, host, cb) {
          if (typeof cb === "function") setTimeout(cb, 10);
        },
        on() {}
      };
    }
  };

  const httpsShim = {
    get(url, cb) {
      const reqErrHandlers = [];
      fetch(url)
        .then(async (res) => {
          const buf = new Uint8Array(await res.arrayBuffer());
          const ev = {};
          const fakeRes = {
            statusCode: res.status,
            on(name, fn) {
              ev[name] = fn;
              return fakeRes;
            },
            pipe(dest) {
              if (dest && typeof dest.write === "function") dest.write(buf);
              if (dest && typeof dest.end === "function") dest.end();
              return dest;
            },
            resume() {}
          };
          if (cb) cb(fakeRes);
          setTimeout(() => {
            if (ev.data) ev.data(buf);
            if (ev.end) ev.end();
          }, 0);
        })
        .catch((err) => {
          reqErrHandlers.forEach((f) => f(err));
        });
      return {
        on(name, fn) {
          if (name === "error") reqErrHandlers.push(fn);
          return this;
        }
      };
    }
  };

  const mmShim = {
    async parseFile() {
      return { common: {}, format: {} };
    }
  };

  function callNativeTauriCommand(cmd, args) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
        return window.__TAURI__.core.invoke(cmd, args);
      }
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
        return window.__TAURI_INTERNALS__.invoke(cmd, args);
      }
    } catch (e) {}
    return null;
  }

  async function performWindowAction(action, value, extra) {
    const args = { action, value, ...(extra || {}) };
    const p = callNativeTauriCommand("app_window_action", args);
    if (p) {
      try {
        return await p;
      } catch (e) {}
    }
    try {
      const tw = window.__TAURI__ && window.__TAURI__.window;
      const win = tw && typeof tw.getCurrentWindow === "function" ? tw.getCurrentWindow() : null;
      if (win) {
        if (action === "minimize") { await win.minimize(); return { ok: true }; }
        if (action === "maximize") { await win.toggleMaximize(); return { ok: true }; }
        if (action === "startDragging" || action === "unmaximizeAndDrag") { await win.startDragging(); return { ok: true }; }
        if (action === "close") { await win.hide(); return { ok: true }; }
        if (action === "setAlwaysOnTop") { await win.setAlwaysOnTop(Boolean(value)); return { value: Boolean(value) }; }
        if (action === "getAlwaysOnTop") { return { value: await win.isAlwaysOnTop() }; }
      }
    } catch (e) {}
    return rpcAsync("/api/window", args);
  }

  const ipcListeners = {};
  const ipcRendererShim = {
    send(channel, ...args) {
      if (channel === "window-minimize") performWindowAction("minimize").catch(() => {});
      else if (channel === "window-maximize") performWindowAction("maximize").catch(() => {});
      else if (channel === "window-close") performWindowAction("close").catch(() => {});
      else if (channel === "set-always-on-top")
        performWindowAction("setAlwaysOnTop", Boolean(args[0])).catch(() => {});
    },
    async invoke(channel, ...args) {
      if (channel === "set-always-on-top") {
        const res = await performWindowAction("setAlwaysOnTop", Boolean(args[0]));
        return Boolean(res && res.value);
      }
      if (channel === "get-always-on-top") {
        const res = await performWindowAction("getAlwaysOnTop");
        return Boolean(res && res.value);
      }
      if (channel === "show-save-dialog") {
        return rpcAsync("/api/dialog", { kind: "save", options: args[0] || {} });
      }
      if (channel === "pick-media-files") {
        return rpcAsync("/api/dialog", { kind: "openMediaFiles" });
      }
      if (channel === "pick-media-folder") {
        return rpcAsync("/api/dialog", { kind: "openMediaFolder" });
      }
      if (channel === "get-app-info") {
        return rpcAsync("/api/info", {});
      }
      if (channel === "check-app-update") {
        return rpcAsync("/api/updater", { action: "check", ...(args[0] || {}) });
      }
      if (channel === "download-app-update") {
        return rpcAsync("/api/updater", { action: "download", ...(args[0] || {}) });
      }
      if (channel === "pick-local-update-file") {
        return rpcAsync("/api/dialog", { kind: "openAsar" });
      }
      if (channel === "pick-ffmpeg-file") {
        return rpcAsync("/api/dialog", { kind: "openFfmpeg" });
      }
      if (channel === "run-system-check") {
        return rpcAsync("/api/system-check", args[0] || {});
      }
      if (channel === "run-system-repair") {
        return rpcAsync("/api/system-repair", args[0] || {});
      }
      if (channel === "apply-app-update") {
        return rpcAsync("/api/updater", { action: "apply", ...(args[0] || {}) });
      }
      if (channel === "check-stream-auth") {
        return rpcAsync("/api/stream-auth", { action: "check" });
      }
      if (channel === "open-stream-auth") {
        return rpcAsync("/api/stream-auth", { action: "open", platform: args[0] || "twitch" });
      }
      if (channel === "stream-logout") {
        return rpcAsync("/api/stream-auth", { action: "logout", platform: args[0] || "twitch" });
      }
      return null;
    },
    on(channel, fn) {
      if (!ipcListeners[channel]) ipcListeners[channel] = [];
      ipcListeners[channel].push(fn);
    }
  };

  window.__onTauriStreamAuthChanged = function (authState) {
    (ipcListeners["stream-auth-changed"] || []).forEach((fn) => {
      try {
        fn({}, authState);
      } catch (e) {}
    });
  };

  window.__onTauriUpdateProgress = function (data) {
    (ipcListeners["app-update-progress"] || []).forEach((fn) => {
      try {
        fn({}, data);
      } catch (e) {}
    });
  };

  const electronShim = {
    ipcRenderer: ipcRendererShim,
    shell: {
      openPath(p) {
        return rpcAsync("/api/shell", { op: "openPath", path: p });
      },
      showItemInFolder(p) {
        return rpcAsync("/api/shell", { op: "showItem", path: p });
      },
      openExternal(u) {
        return rpcAsync("/api/shell", { op: "openExternal", path: u });
      },
      trashItem(p) {
        return rpcAsync("/api/shell", { op: "trashItem", path: p });
      }
    },
    webUtils: {
      getPathForFile(file) {
        return (file && file.path) || "";
      }
    }
  };

  const modules = {
    fs: fsShim,
    path: pathShim,
    url: urlShim,
    crypto: cryptoShim,
    os: osShim,
    child_process: childProcessShim,
    http: httpShim,
    https: httpsShim,
    "music-metadata": mmShim,
    electron: electronShim
  };

  window.require = function (name) {
    if (modules[name]) return modules[name];
    throw new Error("Tauri-Bridge: Unbekanntes Modul '" + name + "'");
  };

  // Automatische Wiederherstellung von Likes, Playlists, Verlauf & Einstellungen aus media/app_state.json
  const appStatePath = pathShim.join(appInfo.mediaDir || pathShim.join(appInfo.appDir, "media"), "app_state.json");
  try {
    if (typeof localStorage !== "undefined" && !localStorage.getItem("__state_restored_v1")) {
      if (fsShim.existsSync(appStatePath)) {
        const raw = fsShim.readFileSync(appStatePath, "utf8");
        const parsed = JSON.parse(raw || "{}");
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (v !== null && v !== undefined && localStorage.getItem(k) === null) {
              localStorage.setItem(k, String(v));
            }
          }
          localStorage.setItem("__state_restored_v1", "1");
        }
      }
    }
  } catch (e) {
    console.warn("[TauriBridge] Konnte app_state.json nicht laden:", e);
  }

  // Änderungen in localStorage automatisch nach media/app_state.json sichern
  try {
    if (typeof Storage !== "undefined" && Storage.prototype) {
      let syncTimer = null;
      const scheduleSync = () => {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
          try {
            const snap = {};
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k !== "__state_restored_v1") snap[k] = localStorage.getItem(k);
            }
            rpcAsync("/api/fs", { op: "writeText", path: appStatePath, text: JSON.stringify(snap, null, 2) }).catch(() => {});
          } catch (e) {}
        }, 1200);
      };
      const origSet = Storage.prototype.setItem;
      const origRem = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        origSet.call(this, k, v);
        if (this === window.localStorage) scheduleSync();
      };
      Storage.prototype.removeItem = function (k) {
        origRem.call(this, k);
        if (this === window.localStorage) scheduleSync();
      };
    }
  } catch (e) {}

  try {
    document.documentElement.classList.add("tauri-app");
  } catch (e) {}

  function setupTauriTitlebarDragRegion() {
    try {
      const tb = document.querySelector(".titlebar");
      if (!tb) return;
      tb.removeAttribute("data-tauri-drag-region");
      const tc = document.querySelector(".title-controls");
      if (tc) {
        tc.setAttribute("data-tauri-drag-region", "false");
        tc.querySelectorAll("button").forEach((btn) => btn.setAttribute("data-tauri-drag-region", "false"));
      }

      if (tb.dataset.tauriDragInit === "1") return;
      tb.dataset.tauriDragInit = "1";

      tb.addEventListener("dblclick", (e) => {
        if (e.target.closest && e.target.closest(".title-controls, button, a, input, select, textarea")) return;
        e.preventDefault();
        performWindowAction("maximize").catch(() => {});
      });

      tb.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.detail >= 2) return;
        if (e.target.closest && e.target.closest(".title-controls, button, a, input, select, textarea")) return;
        e.preventDefault();

        const rect = tb.getBoundingClientRect();
        const relX = rect.width > 0 ? Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)) : 0.5;
        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;

        const cleanup = () => {
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", onUp, true);
        };

        const onMove = (mv) => {
          if (started) return;
          if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < 4) return;
          started = true;
          cleanup();
          performWindowAction("unmaximizeAndDrag", undefined, {
            relX,
            screenX: mv.screenX,
            screenY: mv.screenY
          }).catch(() => {});
        };

        const onUp = () => {
          cleanup();
        };

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
      });
    } catch (e) {}
  }

  function fixSidebarLogoImmediate() {
    const logoImg = document.getElementById("sidebarLogoImg");
    if (logoImg) {
      const cur = logoImg.getAttribute("src") || "";
      if (cur.includes("assets/logo.png") && !cur.startsWith("http") && !cur.startsWith("data:")) {
        logoImg.src = toBridgeMediaUrl(pathShim.join(appInfo.appDir, "assets", "logo.png"));
      }
    }
  }
  setupTauriTitlebarDragRegion();
  fixSidebarLogoImmediate();
  window.addEventListener("DOMContentLoaded", () => {
    setupTauriTitlebarDragRegion();
    fixSidebarLogoImmediate();
  });
})();
