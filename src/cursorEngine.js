// ==========================================================================
// CURSOR ENGINE – Komplette Zeiger-Sets mit Zuständen, Klick-Frames & Animationen
// --------------------------------------------------------------------------
// Jedes Set liefert eigene Frames für alle Standard-Zustände:
//   Normal, Klickbar (Hand), Gedrückt, Text, Verschieben, Greifen, Ziehen,
//   Präzision, Gesperrt, Größe ändern (↔ ↕ ⤡ ⤢), Laden (animiert), Beschäftigt (animiert)
// Die Zustände werden per CSS-Selektoren automatisch zugeordnet – auch für
// Elemente, deren Cursor per Inline-Style / JavaScript gesetzt wird.
// ==========================================================================

const _ceFs = (typeof fs !== "undefined" ? fs : (typeof require !== "undefined" ? (function() { try { return require("fs"); } catch(e){ return null; } })() : null));
const _cePath = (typeof path !== "undefined" ? path : (typeof require !== "undefined" ? (function() { try { return require("path"); } catch(e){ return null; } })() : null));
const _cePathToFileURL = (typeof pathToFileURL !== "undefined" ? pathToFileURL : (typeof require !== "undefined" ? (function() { try { return require("url").pathToFileURL; } catch(e){ return (p) => ({ href: p }); } })() : (p) => ({ href: p })));

const CURSOR_THEMES = {
    auto:     { name: "System-Standard", desc: "Originale Windows-Zeiger", system: true },
    neon:     { name: "Neon Akzent",     desc: "Leuchtet in deiner Akzentfarbe", fill: "#0b0b0b", stroke: "accent", accent: "accent", glow: true },
    clean:    { name: "Minimal Weiß",    desc: "Klar, hell & elegant",           fill: "#ffffff", stroke: "#111111", accent: "#3b82f6" },
    midnight: { name: "Midnight",        desc: "Dunkel mit hellem Rand",         fill: "#121212", stroke: "#f5f5f5", accent: "#1db954" },
    cyber:    { name: "Cyber Pink",      desc: "Neon-Pink mit Cyan-Glow",        fill: "#ff007f", stroke: "#ffffff", accent: "#00f0ff", glow: true },
    ocean:    { name: "Ozean",           desc: "Kühles Blau mit Schimmer",       fill: "#38bdf8", stroke: "#06283d", accent: "#22d3ee", glow: true },
    gold:     { name: "Royal Gold",      desc: "Warm & edel",                    fill: "#fbbf24", stroke: "#3b2603", accent: "#f59e0b" },
    retro:    { name: "Retro Pixel",     desc: "8-Bit Arcade-Look",              fill: "#ffffff", stroke: "#000000", accent: "#fbbf24", pixel: true },
    paws:     { name: "Pfötchen",        desc: "Pfote statt Hand beim Klicken",  fill: "#ffb3d1", stroke: "#5a2340", accent: "#ff4f9a", paw: true }
};

// Alte Einzel-Zeiger auf neue Sets abbilden (Migration bestehender Einstellungen)
const LEGACY_CURSOR_MAP = {
    neon_ring: "neon", crosshair: "neon", laser_point: "neon",
    cyber_arrow: "cyber", retro_sword: "retro", paw: "paws", cat_paw: "paws"
};

// Zustände für Testfläche / Vorschau (cssCursor = Inline-Cursor zum Ausprobieren)
const CURSOR_STATE_INFO = [
    { key: "default",        label: "Normal",       cssCursor: "default" },
    { key: "pointer",        label: "Klickbar",     cssCursor: "pointer" },
    { key: "pointerPressed", label: "Gedrückt",     cssCursor: "pointer", hint: "Klicken & halten" },
    { key: "text",           label: "Text",         cssCursor: "text" },
    { key: "move",           label: "Verschieben",  cssCursor: "move" },
    { key: "grab",           label: "Greifen",      cssCursor: "grab" },
    { key: "grabbing",       label: "Ziehen",       cssCursor: "grabbing" },
    { key: "precision",      label: "Präzision",    cssCursor: "crosshair" },
    { key: "notAllowed",     label: "Gesperrt",     cssCursor: "not-allowed" },
    { key: "ew",             label: "Breite",       cssCursor: "ew-resize" },
    { key: "ns",             label: "Höhe",         cssCursor: "ns-resize" },
    { key: "nwse",           label: "Diagonal ⤡",   cssCursor: "nwse-resize" },
    { key: "nesw",           label: "Diagonal ⤢",   cssCursor: "nesw-resize" },
    { key: "progress",       label: "Lädt",         cssCursor: "progress", animated: true },
    { key: "wait",           label: "Beschäftigt",  cssCursor: "wait", animated: true }
];

const CURSOR_FALLBACKS = {
    default: "default", defaultPressed: "default", pointer: "pointer", pointerPressed: "pointer",
    text: "text", move: "move", grab: "grab", grabbing: "grabbing", precision: "crosshair",
    notAllowed: "not-allowed", ew: "ew-resize", ns: "ns-resize", nwse: "nwse-resize", nesw: "nesw-resize",
    progress: "progress", wait: "wait"
};

// --------------------------------------------------------------------------
// CSS-Selektoren je Zustand
// --------------------------------------------------------------------------
const sAttr = (v) => `[style*="cursor: ${v}"], [style*="cursor:${v}"]`;
const sAttrDeep = (v) => `${sAttr(v)}, [style*="cursor: ${v}"] *, [style*="cursor:${v}"] *`;

const CURSOR_SELECTORS = {
    default: `html, body, *`,
    defaultInline: sAttr("default"),
    grab: `[draggable="true"], .csp-panel-header, ${sAttrDeep("grab")}`,
    move: `${sAttrDeep("move")}, ${sAttr("all-scroll")}`,
    pointer: [
        "a", "a *", "button", "button *", "select", "summary", "label[for]",
        "[onclick]", "[onclick] *", '[role="button"]', '[role="button"] *',
        'input[type="checkbox"]', 'input[type="radio"]', 'input[type="range"]', 'input[type="color"]',
        'input[type="file"]', 'input[type="button"]', 'input[type="submit"]',
        ".pillBtn", ".pillBtn *", ".modalBtn", ".modalBtn *", ".settings-tab", ".settings-tab *",
        ".mediaCard", ".mediaCard *", ".cursor-preset-card", ".cursor-preset-card *",
        ".cursor-theme-card", ".cursor-theme-card *", ".cursor-toggle", ".cursor-toggle *",
        sAttrDeep("pointer")
    ].join(", "),
    text: [
        "input:not([type])", 'input[type="text"]', 'input[type="search"]', 'input[type="number"]',
        'input[type="password"]', 'input[type="email"]', 'input[type="url"]', "textarea",
        '[contenteditable="true"]', '[contenteditable="true"] *', '[contenteditable=""]',
        sAttrDeep("text")
    ].join(", "),
    precision: `${sAttrDeep("crosshair")}, ${sAttrDeep("cell")}, ${sAttrDeep("copy")}`,
    ew: `.sidebar-resizer.right-resizer, .sidebar-resizer.left-resizer, ${sAttrDeep("ew-resize")}, ${sAttrDeep("col-resize")}`,
    ns: `.sidebar-resizer.top-resizer, ${sAttrDeep("ns-resize")}, ${sAttrDeep("row-resize")}`,
    nwse: `${sAttrDeep("nwse-resize")}, ${sAttrDeep("nw-resize")}, ${sAttrDeep("se-resize")}`,
    nesw: `${sAttrDeep("nesw-resize")}, ${sAttrDeep("ne-resize")}, ${sAttrDeep("sw-resize")}`,
    grabbing: sAttrDeep("grabbing"),
    notAllowed: `:disabled, [disabled], :disabled *, ${sAttrDeep("not-allowed")}`,
    none: `#videoMainContainer:fullscreen.fs-idle, #videoMainContainer:fullscreen.fs-idle *, ${sAttrDeep("none")}`
};

// --------------------------------------------------------------------------
// SVG-Bausteine (32×32 Raster)
// --------------------------------------------------------------------------
const CE_ARROW = `<path d="M5 3 L5 24.5 L10.3 19.6 L13.8 27.4 L17.6 25.8 L14.1 18.2 L21.2 18.2 Z"/>`;
const CE_HAND = `<rect x="10" y="2.5" width="4.6" height="16" rx="2.3"/><rect x="14.3" y="10" width="4.3" height="9" rx="2.15"/><rect x="18.3" y="11" width="4.2" height="8.5" rx="2.1"/><rect x="22" y="12.6" width="3.8" height="7.5" rx="1.9"/><rect x="9.6" y="15.5" width="16.2" height="13" rx="5.5"/><rect x="4.6" y="14" width="4.4" height="10" rx="2.2" transform="rotate(-38 6.8 19)"/>`;
const CE_PAW = `<ellipse cx="16" cy="21" rx="6.6" ry="5.6"/><circle cx="8.6" cy="13.6" r="2.9"/><circle cx="13" cy="8.6" r="2.9"/><circle cx="19" cy="8.6" r="2.9"/><circle cx="23.4" cy="13.6" r="2.9"/>`;
const CE_GRAB = `<rect x="8.4" y="7.5" width="3.8" height="12" rx="1.9"/><rect x="12.4" y="5" width="3.8" height="13" rx="1.9"/><rect x="16.4" y="5.5" width="3.8" height="13" rx="1.9"/><rect x="20.4" y="8.5" width="3.6" height="11" rx="1.8"/><rect x="8" y="14" width="16.4" height="14" rx="5.5"/><rect x="3.6" y="14.5" width="4.2" height="9" rx="2.1" transform="rotate(-40 5.7 19)"/>`;
const CE_GRABBING = `<rect x="8.4" y="11.5" width="3.8" height="7" rx="1.9"/><rect x="12.4" y="10.5" width="3.8" height="7.5" rx="1.9"/><rect x="16.4" y="10.5" width="3.8" height="7.5" rx="1.9"/><rect x="20.4" y="11.5" width="3.6" height="7" rx="1.8"/><rect x="8" y="14" width="16.4" height="13" rx="5.5"/><rect x="5.2" y="16" width="4.2" height="7" rx="2.1" transform="rotate(-20 7.3 19.5)"/>`;
const CE_MOVE = `<path d="M16 2 L21 7.5 H18 V14 H24.5 V11 L30 16 L24.5 21 V18 H18 V24.5 H21 L16 30 L11 24.5 H14 V18 H7.5 V21 L2 16 L7.5 11 V14 H14 V7.5 H11 Z"/>`;
const CE_RESIZE = `<path d="M2.5 16 L8.5 10 V13.6 H23.5 V10 L29.5 16 L23.5 22 V18.4 H8.5 V22 Z"/>`;

function ceSvg(inner) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>${inner}</svg>`;
}

// Gefüllte Form mit vereinigtem Außenrand (+ optionalem Glow)
function ceSolid(shapes, p, sw = 2.6) {
    const glow = p.glow
        ? `<g filter="url(#gl)" opacity="0.9"><g fill="${p.accent}" stroke="${p.accent}" stroke-width="${sw + 2.2}" stroke-linejoin="round">${shapes}</g></g>`
        : "";
    return `${glow}<g fill="${p.stroke}" stroke="${p.stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">${shapes}</g><g fill="${p.fill}">${shapes}</g>`;
}

// Linien-Form mit Außenrand (I-Beam, Fadenkreuz)
function ceLine(d, p, w = 2.2) {
    const glow = p.glow
        ? `<path d="${d}" fill="none" stroke="${p.accent}" stroke-width="${w + 4}" stroke-linecap="round" filter="url(#gl)" opacity="0.9"/>`
        : "";
    return `${glow}<path d="${d}" fill="none" stroke="${p.stroke}" stroke-width="${w + 2.8}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${p.fill}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function ceSpinner(cx, cy, r, w, p, angle) {
    const circ = 2 * Math.PI * r;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.stroke}" stroke-width="${w + 3}"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.fill}" stroke-width="${w}" opacity="0.45"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.accent}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${(circ * 0.32).toFixed(2)} ${(circ * 0.68).toFixed(2)}" transform="rotate(${angle} ${cx} ${cy})"/>`;
}

function ceResolvePalette(theme) {
    let accent = "#1db954";
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        if (v) accent = v;
    } catch (e) {}
    const res = (c) => (c === "accent" ? accent : c);
    return { fill: res(theme.fill), stroke: res(theme.stroke), accent: res(theme.accent), glow: !!theme.glow };
}

// Liefert alle Zustände als { svg, hx, hy } bzw. Frame-Arrays
function ceStateDefs(theme) {
    const p = ceResolvePalette(theme);
    const pointerShapes = theme.paw ? CE_PAW : CE_HAND;
    const pointerHot = theme.paw ? [16, 7] : [12.3, 3];
    const sparks = `<path d="M${pointerHot[0] - 6} ${pointerHot[1] + 1} l2.2 1.1 M${pointerHot[0] + 6} ${pointerHot[1] + 1} l-2.2 1.1 M${pointerHot[0] - 4.6} ${pointerHot[1] + 6} l2 -0.4 M${pointerHot[0] + 4.6} ${pointerHot[1] + 6} l-2 -0.4" stroke="${p.accent}" stroke-width="1.7" stroke-linecap="round"/>`;
    const scaleAt = (x, y, s, inner) => `<g transform="translate(${x} ${y}) scale(${s}) translate(${-x} ${-y})">${inner}</g>`;

    const defs = {
        default:        { svg: ceSvg(ceSolid(CE_ARROW, p)), hx: 5, hy: 3 },
        defaultPressed: { svg: ceSvg(scaleAt(5, 3, 0.88, ceSolid(CE_ARROW, p)) + `<circle cx="5" cy="3" r="2" fill="${p.accent}"/>`), hx: 5, hy: 3 },
        pointer:        { svg: ceSvg(ceSolid(pointerShapes, p)), hx: pointerHot[0], hy: pointerHot[1] },
        pointerPressed: { svg: ceSvg(scaleAt(pointerHot[0], pointerHot[1], 0.86, ceSolid(pointerShapes, p)) + sparks), hx: pointerHot[0], hy: pointerHot[1] },
        text:           { svg: ceSvg(ceLine("M11 5h2.6c1.4 0 2.4 1 2.4 2.4C16 6 17 5 18.4 5H21 M16 7.4v17.2 M11 27h2.6c1.4 0 2.4-1 2.4-2.4C16 26 17 27 18.4 27H21", p, 2)), hx: 16, hy: 16 },
        move:           { svg: ceSvg(ceSolid(CE_MOVE, p, 2.4)), hx: 16, hy: 16 },
        grab:           { svg: ceSvg(ceSolid(CE_GRAB, p)), hx: 16, hy: 16 },
        grabbing:       { svg: ceSvg(ceSolid(CE_GRABBING, p)), hx: 16, hy: 16 },
        precision:      { svg: ceSvg(ceLine("M16 3v7.5M16 21.5v7.5M3 16h7.5M21.5 16h7.5", p, 2) +
                              `<circle cx="16" cy="16" r="5.5" fill="none" stroke="${p.stroke}" stroke-width="4.4"/><circle cx="16" cy="16" r="5.5" fill="none" stroke="${p.accent}" stroke-width="1.8"/><circle cx="16" cy="16" r="1.6" fill="${p.accent}"/>`), hx: 16, hy: 16 },
        notAllowed:     { svg: ceSvg(`<circle cx="16" cy="16" r="10" fill="rgba(0,0,0,0.18)" stroke="${p.stroke}" stroke-width="7"/><path d="M9 9 L23 23" stroke="${p.stroke}" stroke-width="7" stroke-linecap="round"/><circle cx="16" cy="16" r="10" fill="none" stroke="#ef4444" stroke-width="3.6"/><path d="M9 9 L23 23" stroke="#ef4444" stroke-width="3.6" stroke-linecap="round"/>`), hx: 16, hy: 16 },
        ew:             { svg: ceSvg(ceSolid(CE_RESIZE, p, 2.4)), hx: 16, hy: 16 },
        ns:             { svg: ceSvg(`<g transform="rotate(90 16 16)">${ceSolid(CE_RESIZE, p, 2.4)}</g>`), hx: 16, hy: 16 },
        nwse:           { svg: ceSvg(`<g transform="rotate(45 16 16)">${ceSolid(CE_RESIZE, p, 2.4)}</g>`), hx: 16, hy: 16 },
        nesw:           { svg: ceSvg(`<g transform="rotate(-45 16 16)">${ceSolid(CE_RESIZE, p, 2.4)}</g>`), hx: 16, hy: 16 },
        wait: [],
        progress: []
    };
    for (let i = 0; i < 8; i++) {
        const a = i * 45;
        defs.wait.push({ svg: ceSvg(ceSpinner(16, 16, 10, 3.6, p, a)), hx: 16, hy: 16 });
        defs.progress.push({ svg: ceSvg(scaleAt(0, 0, 0.82, ceSolid(CE_ARROW, p)) + ceSpinner(24, 24, 5, 2.4, p, a)), hx: 4, hy: 2.5 });
    }
    return defs;
}

// --------------------------------------------------------------------------
// Rasterisierung (SVG → PNG Data-URL, Retro-Modus mit echtem Pixel-Look)
// --------------------------------------------------------------------------
function ceLoadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function ceRasterize(src, px, pixel = false, isSvg = true, scale = 1) {
    const img = await ceLoadImage(isSvg ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src) : src);
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (pixel) {
        const lo = document.createElement("canvas");
        lo.width = 16; lo.height = 16;
        const lctx = lo.getContext("2d");
        lctx.drawImage(img, 0, 0, 16, 16);
        const data = lctx.getImageData(0, 0, 16, 16);
        for (let i = 3; i < data.data.length; i += 4) data.data[i] = data.data[i] > 100 ? 255 : 0;
        lctx.putImageData(data, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(lo, 0, 0, px, px);
    } else if (!isSvg) {
        // Eigene PNG-Zeiger: proportional einpassen (oben links verankert = Hotspot 0/0)
        const ratio = Math.min(px / img.width, px / img.height) * scale;
        ctx.drawImage(img, 0, 0, img.width * ratio, img.height * ratio);
    } else {
        ctx.drawImage(img, 0, 0, px, px);
    }
    return canvas.toDataURL("image/png");
}

async function ceBuildState(def, size, pixel) {
    const f = size / 32;
    return {
        x1: await ceRasterize(def.svg, size, pixel),
        x2: await ceRasterize(def.svg, size * 2, pixel),
        hx: Math.max(0, Math.min(size - 1, Math.round(def.hx * f))),
        hy: Math.max(0, Math.min(size - 1, Math.round(def.hy * f)))
    };
}

const ceThemeCache = new Map();

async function ceBuildTheme(key, size) {
    const theme = CURSOR_THEMES[key];
    const pal = ceResolvePalette(theme);
    const cacheKey = `${key}|${size}|${pal.accent}`;
    if (ceThemeCache.has(cacheKey)) return ceThemeCache.get(cacheKey);

    const defs = ceStateDefs(theme);
    const states = {};
    for (const [name, def] of Object.entries(defs)) {
        if (Array.isArray(def)) {
            states[name] = [];
            for (const frame of def) states[name].push(await ceBuildState(frame, size, theme.pixel));
        } else {
            states[name] = await ceBuildState(def, size, theme.pixel);
        }
    }
    ceThemeCache.set(cacheKey, states);
    return states;
}

async function ceBuildCustom(url, size) {
    const mk = async (scale) => ({
        x1: await ceRasterize(url, size, false, false, scale),
        x2: await ceRasterize(url, size * 2, false, false, scale),
        hx: 0, hy: 0
    });
    const normal = await mk(1);
    const pressed = await mk(0.86);
    const states = {};
    Object.keys(CURSOR_FALLBACKS).forEach(k => { states[k] = CURSOR_FALLBACKS[k]; });
    states.default = normal;
    states.pointer = normal;
    states.defaultPressed = pressed;
    states.pointerPressed = pressed;
    return states;
}

// --------------------------------------------------------------------------
// CSS-Erzeugung
// --------------------------------------------------------------------------
function ceDecl(st, fallback) {
    if (!st) return "";
    if (typeof st === "string") return `cursor: ${st} !important;`;
    return `cursor: url("${st.x1}") ${st.hx} ${st.hy}, ${fallback} !important; ` +
           `cursor: -webkit-image-set(url("${st.x1}") 1x, url("${st.x2}") 2x) ${st.hx} ${st.hy}, ${fallback} !important;`;
}

function ceBuildMainCss(states, opts) {
    const S = CURSOR_SELECTORS;
    const rule = (sel, key) => `${sel} { ${ceDecl(states[key], CURSOR_FALLBACKS[key])} }\n`;
    let css = "";
    css += rule(S.default, "default");
    css += rule(S.defaultInline, "default");
    css += rule(S.grab, "grab");
    css += rule(S.move, "move");
    css += rule(S.pointer, "pointer");
    css += rule(S.text, "text");
    css += rule(S.precision, "precision");
    css += rule(S.ew, "ew");
    css += rule(S.ns, "ns");
    css += rule(S.nwse, "nwse");
    css += rule(S.nesw, "nesw");
    css += rule(S.grabbing, "grabbing");
    css += rule(S.notAllowed, "notAllowed");
    if (opts.clickFrame) {
        // :where() hält die Spezifität niedrig, damit z.B. Textfelder ihren I-Beam behalten
        css += rule(`:where(html.cursor-pressed) *`, "defaultPressed");
        css += rule(`:where(html.cursor-pressed) :is(${S.pointer})`, "pointerPressed");
        css += rule(`:where(html.cursor-pressed) :is(${S.grab})`, "grabbing");
    }
    css += `${S.none} { cursor: none !important; }\n`;
    return css;
}

function ceBuildAnimCss(states, frame) {
    const pick = (key) => {
        const v = states[key];
        return Array.isArray(v) ? v[frame % v.length] : v;
    };
    return `:where(html.cursor-busy, html.cursor-busy *) { ${ceDecl(pick("progress"), "progress")} }\n` +
           `${sAttrDeep("progress")} { ${ceDecl(pick("progress"), "progress")} }\n` +
           `${sAttrDeep("wait")} { ${ceDecl(pick("wait"), "wait")} }\n`;
}

// --------------------------------------------------------------------------
// Laufzeit-Zustand
// --------------------------------------------------------------------------
const CursorEngine = {
    states: null,          // aktuelle Zustands-Frames (null = System)
    mode: "auto",          // Theme-Key | "custom_file"
    frame: 0,
    animTimer: null,
    busyCount: 0,
    hoverAnimated: false,
    applyToken: 0,

    getSize() { return parseInt(localStorage.getItem("activeCursorSize") || "32", 10) || 32; },
    clickFrameOn() { return localStorage.getItem("cursorClickFrame") !== "false"; },
    rippleOn() { return localStorage.getItem("cursorClickRipple") !== "false"; },

    ensureStyleEls(doc = document) {
        let main = doc.getElementById("customCursorStyle");
        if (!main) {
            main = doc.createElement("style");
            main.id = "customCursorStyle";
            doc.head.appendChild(main);
        }
        let anim = doc.getElementById("customCursorAnimStyle");
        if (!anim) {
            anim = doc.createElement("style");
            anim.id = "customCursorAnimStyle";
            doc.head.appendChild(anim);
        }
        return { main, anim };
    },

    writeCss() {
        const docs = [document];
        try {
            if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) docs.push(window.popoutEditorWindow.document);
        } catch (e) {}
        const mainCss = this.states ? ceBuildMainCss(this.states, { clickFrame: this.clickFrameOn() }) : "";
        const animCss = this.states ? ceBuildAnimCss(this.states, this.frame) : "";
        docs.forEach(doc => {
            const { main, anim } = this.ensureStyleEls(doc);
            main.textContent = mainCss;
            anim.textContent = animCss;
        });
    },

    writeAnimOnly() {
        if (!this.states) return;
        const css = ceBuildAnimCss(this.states, this.frame);
        const { anim } = this.ensureStyleEls(document);
        anim.textContent = css;
        try {
            if (window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
                this.ensureStyleEls(window.popoutEditorWindow.document).anim.textContent = css;
            }
        } catch (e) {}
    },

    updateAnimLoop() {
        const hasFrames = this.states && Array.isArray(this.states.wait);
        const need = hasFrames && (this.busyCount > 0 || this.hoverAnimated);
        if (need && !this.animTimer) {
            this.animTimer = setInterval(() => {
                this.frame = (this.frame + 1) % 8;
                this.writeAnimOnly();
            }, 110);
        } else if (!need && this.animTimer) {
            clearInterval(this.animTimer);
            this.animTimer = null;
        }
    },

    async applyTheme(key) {
        const token = ++this.applyToken;
        if (!CURSOR_THEMES[key]) key = "auto";
        this.mode = key;
        if (CURSOR_THEMES[key].system) {
            this.states = null;
        } else {
            const states = await ceBuildTheme(key, this.getSize());
            if (token !== this.applyToken) return; // überholt durch neuere Auswahl
            this.states = states;
        }
        this.writeCss();
        this.updateAnimLoop();
        ceRefreshUi();
    },

    async applyCustom(url) {
        const token = ++this.applyToken;
        this.mode = "custom_file";
        try {
            const states = await ceBuildCustom(url, this.getSize());
            if (token !== this.applyToken) return;
            this.states = states;
        } catch (e) {
            this.states = null;
            if (typeof AppLogger !== "undefined") AppLogger.warn("Cursor", "Eigener Zeiger konnte nicht geladen werden: " + url);
        }
        this.writeCss();
        this.updateAnimLoop();
        ceRefreshUi();
    },

    reapply() {
        const name = localStorage.getItem("activeCursorName") || "auto";
        if (name === "custom_file") {
            const fp = localStorage.getItem("activeCustomCursorPath") || "";
            if (fp && _ceFs && _ceFs.existsSync(fp)) return this.applyCustom(_cePathToFileURL(fp).href);
            return this.applyTheme("auto");
        }
        return this.applyTheme(LEGACY_CURSOR_MAP[name] || name);
    }
};

window.CursorEngine = CursorEngine;

// Hintergrund-Aktivität signalisieren (Pfeil + animierter Lade-Kreis)
window.setCursorBusy = function (on) {
    CursorEngine.busyCount = Math.max(0, CursorEngine.busyCount + (on ? 1 : -1));
    document.documentElement.classList.toggle("cursor-busy", CursorEngine.busyCount > 0);
    CursorEngine.updateAnimLoop();
};

// --------------------------------------------------------------------------
// Klick-Frame & Klick-Welle
// --------------------------------------------------------------------------
function ceSpawnRipple(x, y) {
    const r = document.createElement("div");
    r.className = "cursor-click-ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 500);
}

function ceBindInteraction(doc) {
    if (doc._ceBound) return;
    doc._ceBound = true;
    const root = doc.documentElement;
    doc.addEventListener("pointerdown", (e) => {
        if (CursorEngine.clickFrameOn()) root.classList.add("cursor-pressed");
        if (doc === document && CursorEngine.rippleOn() && e.button === 0) ceSpawnRipple(e.clientX, e.clientY);
    }, true);
    const release = () => root.classList.remove("cursor-pressed");
    doc.addEventListener("pointerup", release, true);
    doc.addEventListener("pointercancel", release, true);
    (doc.defaultView || window).addEventListener("blur", release);

    // Animierte Zeiger nur animieren, solange man über einem Lade-/Warte-Element ist
    doc.addEventListener("mouseover", (e) => {
        const t = e.target;
        const over = !!(t && t.closest && t.closest('[style*="cursor: wait"], [style*="cursor: progress"], [style*="cursor:wait"], [style*="cursor:progress"]'));
        if (over !== CursorEngine.hoverAnimated) {
            CursorEngine.hoverAnimated = over;
            CursorEngine.updateAnimLoop();
        }
    }, true);
}

// --------------------------------------------------------------------------
// Einstellungs-UI
// --------------------------------------------------------------------------
const cePreviewCache = new Map();

async function ceThemePreviewFrames(key) {
    const theme = CURSOR_THEMES[key];
    const pal = ceResolvePalette(theme);
    const cacheKey = `${key}|${pal.accent}`;
    if (cePreviewCache.has(cacheKey)) return cePreviewCache.get(cacheKey);
    const defs = ceStateDefs(theme);
    const frames = [];
    for (const k of ["default", "pointer", "text", "grab"]) {
        frames.push(await ceRasterize(defs[k].svg, 64, theme.pixel));
    }
    cePreviewCache.set(cacheKey, frames);
    return frames;
}

function ceActiveKey() {
    const name = localStorage.getItem("activeCursorName") || "auto";
    return name === "custom_file" ? "custom_file" : (LEGACY_CURSOR_MAP[name] || (CURSOR_THEMES[name] ? name : "auto"));
}

window.renderCursorThemeGallery = async function () {
    const grid = document.getElementById("cursorThemeGrid");
    if (!grid) return;
    const active = ceActiveKey();
    grid.innerHTML = "";
    for (const [key, theme] of Object.entries(CURSOR_THEMES)) {
        const card = document.createElement("div");
        card.className = "cursor-theme-card" + (key === active ? " active" : "");
        card.dataset.theme = key;
        card.innerHTML = `
            <div class="ctc-frames">${theme.system
                ? `<span class="ctc-system">🖱️</span>`
                : `<span class="ctc-loading"></span>`}</div>
            <div class="ctc-meta">
                <span class="ctc-name">${theme.name}</span>
                <span class="ctc-desc">${theme.desc || ""}</span>
            </div>
            <span class="ctc-check">✓</span>`;
        card.onclick = () => window.selectPresetCursor(key);
        grid.appendChild(card);
        if (!theme.system) {
            ceThemePreviewFrames(key).then(frames => {
                const holder = card.querySelector(".ctc-frames");
                if (holder) holder.innerHTML = frames.map(src => `<img src="${src}" draggable="false">`).join("");
            }).catch(() => {});
        }
    }
};

let ceStripAnimTimer = null;

window.renderCursorStateStrip = function () {
    const strip = document.getElementById("cursorStateStrip");
    if (!strip) return;
    const states = CursorEngine.states;
    strip.innerHTML = "";
    CURSOR_STATE_INFO.forEach(info => {
        const tile = document.createElement("div");
        tile.className = "cursor-state-tile";
        tile.style.cursor = info.cssCursor;
        let visual = `<span class="cst-keyword">${info.cssCursor}</span>`;
        const st = states ? states[info.key] : null;
        if (st && typeof st === "object") {
            const first = Array.isArray(st) ? st[0] : st;
            visual = `<img src="${first.x2}" draggable="false" ${info.animated ? `data-anim="${info.key}"` : ""}>`;
        }
        tile.innerHTML = `
            <div class="cst-visual" style="pointer-events: none;">${visual}</div>
            <span class="cst-label" style="pointer-events: none;">${info.label}</span>
            ${info.hint ? `<span class="cst-hint" style="pointer-events: none;">${info.hint}</span>` : ""}`;
        tile.setAttribute("title", info.label + (info.hint ? ` (${info.hint})` : ""));
        strip.appendChild(tile);
    });

    // Lade-Frames in den Vorschau-Kacheln abspielen (nur solange sichtbar)
    if (ceStripAnimTimer) clearInterval(ceStripAnimTimer);
    let f = 0;
    ceStripAnimTimer = setInterval(() => {
        const s = document.getElementById("cursorStateStrip");
        if (!s || !s.offsetParent || !CursorEngine.states) return;
        f = (f + 1) % 8;
        s.querySelectorAll("img[data-anim]").forEach(img => {
            const frames = CursorEngine.states[img.dataset.anim];
            if (Array.isArray(frames)) img.src = frames[f].x2;
        });
    }, 110);
};

function ceRefreshUi() {
    const active = ceActiveKey();
    document.querySelectorAll(".cursor-theme-card").forEach(c => c.classList.toggle("active", c.dataset.theme === active));

    const preview = document.getElementById("cursorLivePreviewContainer");
    const nameEl = document.getElementById("cursorPreviewName");
    if (preview && nameEl) {
        if (active === "custom_file") {
            const fp = localStorage.getItem("activeCustomCursorPath") || "";
            const href = _cePathToFileURL ? _cePathToFileURL(fp).href : fp;
            preview.innerHTML = fp ? `<img src="${href}?t=${Date.now()}" draggable="false" style="max-width: 48px; max-height: 48px; object-fit: contain;">` : "🖱️";
            const base = (fp && _cePath) ? _cePath.basename(fp, ".png") : "Eigener Zeiger";
            const idx = base.lastIndexOf("_");
            nameEl.innerText = (idx !== -1 ? base.substring(0, idx) : base).replace(/_/g, " ");
        } else {
            const theme = CURSOR_THEMES[active] || CURSOR_THEMES.auto;
            nameEl.innerText = theme.name;
            preview.innerHTML = CursorEngine.states && CursorEngine.states.pointer && typeof CursorEngine.states.pointer === "object"
                ? `<div class="cursor-dual-preview"><div class="cdp-item"><img src="${CursorEngine.states.default.x2}" draggable="false"><span class="cdp-lbl">Normal</span></div><div class="cdp-item"><img src="${CursorEngine.states.pointer.x2}" draggable="false"><span class="cdp-lbl">Klick</span></div></div>`
                : `<span style="font-size: 32px;">🖱️</span>`;
        }
    }
    window.renderCursorStateStrip();
}

// --------------------------------------------------------------------------
// Öffentliche API (kompatibel zu bestehenden Aufrufen aus renderer.js / HTML)
// --------------------------------------------------------------------------
window.selectPresetCursor = function (presetName) {
    const key = LEGACY_CURSOR_MAP[presetName] || (CURSOR_THEMES[presetName] ? presetName : "auto");
    localStorage.setItem("activeCursorName", key);
    if (typeof AppLogger !== "undefined") AppLogger.info("Cursor", `Zeiger-Set gewählt: ${key}`);
    ceRefreshUi();
    return CursorEngine.applyTheme(key);
};

// Wird von renderer.js für eigene PNG-Zeiger verwendet
window.applyCustomCursor = function (cursorUrl) {
    if (!cursorUrl || cursorUrl === "auto") return CursorEngine.applyTheme("auto");
    return CursorEngine.applyCustom(cursorUrl);
};

window.initCustomCursorSystem = async function () {
    ceBindInteraction(document);

    const size = CursorEngine.getSize();
    const slider = document.getElementById("cursorSizeSlider");
    const valText = document.getElementById("cursorSizeVal");
    if (slider && valText && !slider._ceBound) {
        slider._ceBound = true;
        slider.value = size;
        valText.innerText = size + " px";
        let debounce = null;
        slider.addEventListener("input", (e) => {
            const v = parseInt(e.target.value, 10);
            valText.innerText = v + " px";
            localStorage.setItem("activeCursorSize", v);
            clearTimeout(debounce);
            debounce = setTimeout(() => CursorEngine.reapply(), 120);
        });
    }

    const frameToggle = document.getElementById("cursorClickFrameToggle");
    if (frameToggle && !frameToggle._ceBound) {
        frameToggle._ceBound = true;
        frameToggle.checked = CursorEngine.clickFrameOn();
        frameToggle.addEventListener("change", () => {
            localStorage.setItem("cursorClickFrame", frameToggle.checked ? "true" : "false");
            CursorEngine.writeCss();
        });
    }
    const rippleToggle = document.getElementById("cursorClickRippleToggle");
    if (rippleToggle && !rippleToggle._ceBound) {
        rippleToggle._ceBound = true;
        rippleToggle.checked = CursorEngine.rippleOn();
        rippleToggle.addEventListener("change", () => {
            localStorage.setItem("cursorClickRipple", rippleToggle.checked ? "true" : "false");
        });
    }

    await CursorEngine.reapply();
    window.renderCursorThemeGallery();
};

// Zeichen-Fenster (Popout) bekommt dieselben Zeiger + Klick-Frames
window.syncCursorToPopout = function (childWin) {
    if (!childWin || childWin.closed) return;
    try {
        ceBindInteraction(childWin.document);
        CursorEngine.writeCss();
    } catch (e) {}
};

// Akzentfarbe geändert? → "Neon Akzent" neu einfärben
window.refreshCursorTheme = function () {
    cePreviewCache.clear();
    CursorEngine.reapply();
    window.renderCursorThemeGallery();
};

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            window.initCustomCursorSystem().catch(() => {});
        });
    } else {
        setTimeout(() => {
            window.initCustomCursorSystem().catch(() => {});
        }, 0);
    }
}

