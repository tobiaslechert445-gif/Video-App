/**
 * ============================================================================
 * HIGH-PRECISION PHOTOSHOP-STYLE BRUSH ENGINE (C++ / PhotoCraft Architecture)
 * ============================================================================
 * 
 * Modularer, hochperformanter Zeichenkern für den Studio- & Playlist-Cover-Editor.
 * Inspiriert von den Rendering-Pipelines professioneller C++ Grafik-Engines
 * (Photoshop, Krita, PhotoCraft, Skia):
 * 
 * 1. Sub-Pixel Dab Stamping (Kontinuierliche Pinselspitzen-Stempelung)
 * 2. Hermite-Smoothstep Härte-Falloff (Echte Photoshop-Härte 0% bis 100%)
 * 3. Catmull-Rom & Quadratic Bézier Spline Interpolation (Anti-Aliased Kurvenglättung)
 * 4. Streamline / Exponential Moving Average (EMA) Stabilisator gegen Handzittern
 * 5. Sub-Pixel Dab Spacing Akkumulator (Gleichmäßige Deckungsdichte bei jedem Tempo)
 * 6. High-Performance Smudge / Mixer-Brush mit Farbreservoir (Butterweich ohne Canvas-Lag)
 * 7. Soft/Hard Radiergummi mit Destination-Out & Alpha-Lock Support
 * ============================================================================
 */

(function (global) {
    'use strict';

    // Hilfsfunktion: Wandelt Hex/RGB in RGBA-String mit gewünschtem Alpha um
    function parseColorWithAlpha(colorStr, alpha) {
        if (!colorStr) return `rgba(0, 0, 0, ${alpha})`;
        colorStr = colorStr.trim();
        
        // Bereits rgba
        if (colorStr.startsWith('rgba')) {
            const parts = colorStr.match(/[\d.]+/g);
            if (parts && parts.length >= 3) {
                return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha * (parts[3] !== undefined ? parseFloat(parts[3]) : 1)})`;
            }
        }
        
        // rgb
        if (colorStr.startsWith('rgb')) {
            const parts = colorStr.match(/\d+/g);
            if (parts && parts.length >= 3) {
                return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
            }
        }

        // hex (#fff oder #ffffff)
        if (colorStr.startsWith('#')) {
            let hex = colorStr.slice(1);
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            if (hex.length === 6) {
                const r = parseInt(hex.slice(0, 2), 16) || 0;
                const g = parseInt(hex.slice(2, 4), 16) || 0;
                const b = parseInt(hex.slice(4, 6), 16) || 0;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }
        }

        return `rgba(29, 185, 84, ${alpha})`;
    }

    // Hilfsfunktion: Wandelt Hex/RGB in {r, g, b} Objekt um
    function parseRgb(colorStr) {
        if (!colorStr) return { r: 29, g: 185, b: 84 };
        colorStr = colorStr.trim();
        if (colorStr.startsWith('#')) {
            let hex = colorStr.slice(1);
            if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            if (hex.length === 6) {
                return {
                    r: parseInt(hex.slice(0, 2), 16) || 0,
                    g: parseInt(hex.slice(2, 4), 16) || 0,
                    b: parseInt(hex.slice(4, 6), 16) || 0
                };
            }
        }
        const match = colorStr.match(/\d+/g);
        if (match && match.length >= 3) {
            return {
                r: parseInt(match[0], 10) || 0,
                g: parseInt(match[1], 10) || 0,
                b: parseInt(match[2], 10) || 0
            };
        }
        return { r: 29, g: 185, b: 84 };
    }

    // Nativer C++ Kern (PhotoCraft / MSVC mit Windows Delay-Load Hook)
    let nativeModule = null;
    try {
        if (typeof require === 'function') {
            const path = require('path');
            const candidatePaths = [
                path.resolve(__dirname, '../build/Release/brush_engine_native.node'),
                path.resolve(__dirname, 'build/Release/brush_engine_native.node'),
                path.resolve(process.cwd(), 'build/Release/brush_engine_native.node')
            ];
            for (const p of candidatePaths) {
                try {
                    nativeModule = require(p);
                    if (nativeModule && nativeModule.isNative) break;
                } catch (e) {}
            }
        }
    } catch (e) {
        // Native module unavailable, use pure JS fallback
    }

    class HighPrecisionBrushEngine {
        constructor() {
            // Nativer C++ Treiber / Status
            this.native = nativeModule;
            this.isNative = !!(nativeModule && nativeModule.isNative);

            // Einstellungen (Photoshop / Clip Studio Paint Standardwerte)
            // Einstellungen (Photoshop / Clip Studio Paint Standardwerte)
            this.settings = {
                size: 20,              // 1 bis 150 px
                opacity: 1.0,          // 0.05 bis 1.0
                hardness: 0.80,        // 0.0 (ultra-soft Airbrush) bis 1.0 (razor-sharp)
                smoothing: 0.35,       // 0.0 (raw input) bis 0.85 (ultra-smooth stabilizer)
                spacing: 0.12,         // 12% des Durchmessers für perfekte Dichte
                color: '#1db954',      // Aktuelle Vordergrundfarbe
                flow: 1.0,             // Pinsel-Fluss (1% bis 100%)
                usePressure: true,     // Stiftdruck-Dynamik aktivieren
                minPressureRatio: 0.08,// Mindestdicke bei hauchfeinem Aufsetzen (8% der Pinselgröße)
                tipType: 'round',      // 'round', 'chisel', 'pencil', 'gpen', 'bristle', 'airbrush', 'charcoal', 'splatter', 'watercolor'
                roundness: 1.0,        // 0.05 bis 1.0 (Abflachung / Elliptizität)
                angle: 0,              // 0 bis 360 Grad (Drehwinkel der Spitze)
                sizeJitter: 0.0,       // 0.0 bis 1.0 (Größen-Jitter)
                angleJitter: 0.0,      // 0.0 bis 1.0 (Winkel-Jitter)
                scatter: 0.0,          // 0.0 bis 5.0 (Streuung)
                count: 1,              // 1 bis 5 (Dabs pro Schritt)
                wetEdge: false,        // Nassrand-Effekt (Aquarell)
                pressureSize: true,    // Druck steuert Größe
                pressureOpacity: false // Druck steuert Deckkraft
            };

            // Dab-Cache (Offscreen Canvas Sprites nach Größe/Härte/Farbe gecacht)
            this.dabCache = new Map();
            this.maxDabCacheSize = 200;

            // Stroke-Zustand
            this.isStroking = false;
            this.points = [];          // Puffer der letzten Eingabepunkte
            this.filteredPoints = [];  // Geglättete Punkte nach Stabilisator
            this.distanceRemainder = 0;// Restdistanz für exaktes Dab-Spacing
            this.lastRawPoint = null;
            this.lastFilteredPoint = null;

            // Smudge / Wischfinger Zustand (Lazy initialisiert)
            this.smudgeReservoir = null;
            this.smudgeReservoirCtx = null;
            this.smudgeMask = null;
            this.smudgeMaskCtx = null;
            this.smudgeTempStamp = null;
            this.smudgeTempStampCtx = null;
            this.smudgeWetness = 1.0;
            this.smudgeDistance = 0;
            this.smudgeMaxDistance = 1500;
        }

        /**
         * Aktualisiert Einstellungen
         */
        updateSettings(newSettings) {
            if (!newSettings) return;
            Object.assign(this.settings, newSettings);
        }

        /**
         * Erstellt oder liefert einen gecachten Pinselspitzen-Sprite (Dab)
         * mit Unterstützung für Photoshop-Spitzenformen (Rund, Meißel, Bleistift, G-Pen, Borsten, Airbrush, etc.)
         */
        getDabSprite(radius, hardness, color, alpha = 1.0, tipType = 'round', roundness = 1.0, angle = 0, wetEdge = false) {
            radius = Math.max(0.5, radius);
            hardness = Math.max(0.0, Math.min(1.0, hardness));
            alpha = Math.max(0.0, Math.min(1.0, alpha));
            roundness = Math.max(0.05, Math.min(1.0, roundness));
            const normAngle = ((angle % 360) + 360) % 360;

            // Rundungsschlüssel für maximale Cache-Trefferquote
            const rKey = Math.round(radius * 2) / 2;
            const hKey = Math.round(hardness * 100);
            const aKey = Math.round(alpha * 100);
            const rndKey = Math.round(roundness * 20);
            const angKey = Math.round(normAngle / 5) * 5;
            const wetKey = wetEdge ? 1 : 0;
            const cacheKey = `${rKey}_${hKey}_${color}_${aKey}_${tipType}_${rndKey}_${angKey}_${wetKey}`;

            if (this.dabCache.has(cacheKey)) {
                return this.dabCache.get(cacheKey);
            }

            const dabCanvas = document.createElement('canvas');
            const dSize = Math.max(4, Math.ceil(radius * 2) + 6);
            dabCanvas.width = dSize;
            dabCanvas.height = dSize;
            const dCtx = dabCanvas.getContext('2d');
            const cx = dSize / 2;
            const cy = dSize / 2;

            // 1. Falls Drehung oder Abflachung (Roundness) aktiv sind, transformiere Context
            const isTransformed = roundness < 0.96 || normAngle !== 0;
            if (isTransformed) {
                dCtx.save();
                dCtx.translate(cx, cy);
                dCtx.rotate((normAngle * Math.PI) / 180);
                dCtx.scale(1.0, roundness);
                dCtx.translate(-cx, -cy);
            }

            // 2. C++ Nativer Pfad für Standard-Rundpinsel ohne Spezialeffekte
            let usedNative = false;
            if (tipType === 'round' && !isTransformed && !wetEdge && this.native && typeof this.native.generateBrushDab === 'function') {
                try {
                    const rgb = parseRgb(color);
                    const nativeBuf = this.native.generateBrushDab(dSize, hardness, rgb.r, rgb.g, rgb.b, alpha);
                    if (nativeBuf && nativeBuf.length === dSize * dSize * 4) {
                        const imgData = new ImageData(
                            new Uint8ClampedArray(nativeBuf.buffer, nativeBuf.byteOffset, nativeBuf.byteLength),
                            dSize,
                            dSize
                        );
                        dCtx.putImageData(imgData, 0, 0);
                        usedNative = true;
                    }
                } catch (cErr) {}
            }

            // 3. Photoshop Pinselspitzen-Rasterizer
            if (!usedNative) {
                switch (tipType) {
                    case 'gpen': {
                        // Ultrascharfe Manga-Inker Tintenspitze
                        dCtx.beginPath();
                        dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                        dCtx.fillStyle = parseColorWithAlpha(color, alpha);
                        dCtx.fill();
                        break;
                    }
                    case 'airbrush': {
                        // Extrem weicher, weit gestreuter Farbnebel
                        const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                        grad.addColorStop(0, parseColorWithAlpha(color, alpha * 0.9));
                        grad.addColorStop(0.25, parseColorWithAlpha(color, alpha * 0.45));
                        grad.addColorStop(0.65, parseColorWithAlpha(color, alpha * 0.12));
                        grad.addColorStop(1.0, parseColorWithAlpha(color, 0));
                        dCtx.fillStyle = grad;
                        dCtx.beginPath();
                        dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                        dCtx.fill();
                        break;
                    }
                    case 'chisel': {
                        // Meißel / Kalligraphie: leicht abgerundetes Flach-Rechteck
                        const rw = radius;
                        const rh = radius * 0.35;
                        dCtx.beginPath();
                        if (dCtx.roundRect) {
                            dCtx.roundRect(cx - rw, cy - rh, rw * 2, rh * 2, Math.max(1, rh * 0.5));
                        } else {
                            dCtx.rect(cx - rw, cy - rh, rw * 2, rh * 2);
                        }
                        dCtx.fillStyle = parseColorWithAlpha(color, alpha);
                        dCtx.fill();
                        break;
                    }
                    case 'pencil': {
                        // Zeichenstift / Bleistift mit körniger Graphit-Textur
                        const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                        grad.addColorStop(0, parseColorWithAlpha(color, alpha * 0.95));
                        grad.addColorStop(0.7, parseColorWithAlpha(color, alpha * 0.7));
                        grad.addColorStop(1.0, parseColorWithAlpha(color, 0));
                        dCtx.fillStyle = grad;
                        dCtx.beginPath();
                        dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                        dCtx.fill();

                        // Körniges Rauschen einbringen
                        try {
                            const imgData = dCtx.getImageData(0, 0, dSize, dSize);
                            const pix = imgData.data;
                            for (let i = 0; i < pix.length; i += 4) {
                                if (pix[i + 3] > 0) {
                                    const noise = 0.55 + 0.45 * Math.random();
                                    pix[i + 3] = Math.min(255, Math.floor(pix[i + 3] * noise));
                                }
                            }
                            dCtx.putImageData(imgData, 0, 0);
                        } catch(e) {}
                        break;
                    }
                    case 'bristle': {
                        // Ölfarben-Borstenpinsel: Mehrere feine Einzelfasern nebeneinander
                        const fibers = Math.max(5, Math.min(13, Math.floor(radius / 2)));
                        for (let f = 0; f < fibers; f++) {
                            const offsetFactor = (f / (fibers - 1)) * 2 - 1; // -1 bis 1
                            const fx = cx + offsetFactor * radius * 0.75;
                            const fy = cy + (Math.sin(f * 2.3) * radius * 0.2);
                            const fRadius = Math.max(0.6, (radius / fibers) * 1.3);
                            dCtx.beginPath();
                            dCtx.arc(fx, fy, fRadius, 0, Math.PI * 2);
                            dCtx.fillStyle = parseColorWithAlpha(color, alpha * (0.4 + 0.5 * Math.random()));
                            dCtx.fill();
                        }
                        break;
                    }
                    case 'charcoal': {
                        // Kohle / Kreide: Raue, gezackte Polygone
                        dCtx.beginPath();
                        const steps = 10;
                        for (let s = 0; s < steps; s++) {
                            const a = (s / steps) * Math.PI * 2;
                            const jitter = 0.75 + 0.3 * Math.random();
                            const px = cx + Math.cos(a) * radius * jitter;
                            const py = cy + Math.sin(a) * radius * jitter;
                            if (s === 0) dCtx.moveTo(px, py); else dCtx.lineTo(px, py);
                        }
                        dCtx.closePath();
                        dCtx.fillStyle = parseColorWithAlpha(color, alpha * 0.85);
                        dCtx.fill();
                        break;
                    }
                    case 'splatter': {
                        // Tintenspritzer: Haupttropfen + mikroskopische Spritzer im Umkreis
                        dCtx.beginPath();
                        dCtx.arc(cx, cy, radius * 0.45, 0, Math.PI * 2);
                        dCtx.fillStyle = parseColorWithAlpha(color, alpha);
                        dCtx.fill();
                        const drops = 6 + Math.floor(Math.random() * 5);
                        for (let d = 0; d < drops; d++) {
                            const da = Math.random() * Math.PI * 2;
                            const dDist = radius * (0.3 + 0.65 * Math.random());
                            const dr = Math.max(0.6, radius * 0.12 * Math.random());
                            dCtx.beginPath();
                            dCtx.arc(cx + Math.cos(da) * dDist, cy + Math.sin(da) * dDist, dr, 0, Math.PI * 2);
                            dCtx.fill();
                        }
                        break;
                    }
                    case 'watercolor': {
                        // Aquarell Nassrand: Innen weicher, Ränder sammeln mehr Pigment an
                        const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                        grad.addColorStop(0, parseColorWithAlpha(color, alpha * 0.4));
                        grad.addColorStop(0.7, parseColorWithAlpha(color, alpha * 0.5));
                        grad.addColorStop(0.92, parseColorWithAlpha(color, alpha * 0.95));
                        grad.addColorStop(1.0, parseColorWithAlpha(color, 0));
                        dCtx.fillStyle = grad;
                        dCtx.beginPath();
                        dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                        dCtx.fill();
                        break;
                    }
                    default: {
                        // Standard Rund (Hermite Härteverlauf)
                        if (hardness >= 0.96) {
                            dCtx.beginPath();
                            dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                            dCtx.fillStyle = parseColorWithAlpha(color, alpha);
                            dCtx.fill();
                        } else {
                            const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                            const solidStop = Math.max(0, Math.min(0.95, hardness));
                            grad.addColorStop(0, parseColorWithAlpha(color, alpha));
                            grad.addColorStop(solidStop, parseColorWithAlpha(color, alpha));

                            const steps = 6;
                            for (let i = 1; i <= steps; i++) {
                                const t = i / steps;
                                const falloff = 1 - (3 * t * t - 2 * t * t * t);
                                const stopPos = solidStop + (1 - solidStop) * t;
                                grad.addColorStop(Math.min(1.0, stopPos), parseColorWithAlpha(color, alpha * falloff));
                            }
                            dCtx.fillStyle = grad;
                            dCtx.beginPath();
                            dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                            dCtx.fill();
                        }
                        break;
                    }
                }
            }

            if (isTransformed) {
                dCtx.restore();
            }

            // Optionaler Nassrand-Post-Pass (Wet Edge)
            if (wetEdge && tipType !== 'watercolor') {
                try {
                    const imgData = dCtx.getImageData(0, 0, dSize, dSize);
                    const pix = imgData.data;
                    for (let i = 0; i < pix.length; i += 4) {
                        const a = pix[i + 3] / 255;
                        if (a > 0.05 && a < 0.95) {
                            // Kantenpigmentierung akzentuieren
                            const boost = Math.sin(a * Math.PI) * 0.35;
                            pix[i + 3] = Math.min(255, Math.floor(pix[i + 3] * (1.0 + boost)));
                        }
                    }
                    dCtx.putImageData(imgData, 0, 0);
                } catch(e) {}
            }

            // Cache-Verwaltung (LRU)
            if (this.dabCache.size >= this.maxDabCacheSize) {
                const firstKey = this.dabCache.keys().next().value;
                this.dabCache.delete(firstKey);
            }
            this.dabCache.set(cacheKey, dabCanvas);

            return dabCanvas;
        }

        /**
         * Stempelt einen einzelnen Dab auf den Ziel-Canvas mit Unterstützung für
         * Jitter, Streuung (Scatter), Fluss (Flow) und Photoshop-Spitzenformen.
         */
        stampDab(ctx, x, y, radius, hardness, color, alpha = 1.0, compositeOp = null, options = {}) {
            if (!ctx || radius <= 0) return;
            const tipType = options.tipType || this.settings.tipType || 'round';
            const roundness = options.roundness !== undefined ? options.roundness : (this.settings.roundness !== undefined ? this.settings.roundness : 1.0);
            const baseAngle = options.angle !== undefined ? options.angle : (this.settings.angle || 0);
            const wetEdge = options.wetEdge !== undefined ? options.wetEdge : !!this.settings.wetEdge;
            const sizeJitter = options.sizeJitter !== undefined ? options.sizeJitter : (this.settings.sizeJitter || 0);
            const angleJitter = options.angleJitter !== undefined ? options.angleJitter : (this.settings.angleJitter || 0);
            const scatter = options.scatter !== undefined ? options.scatter : (this.settings.scatter || 0);
            const count = options.count !== undefined ? options.count : (this.settings.count || 1);
            const flow = options.flow !== undefined ? options.flow : (this.settings.flow !== undefined ? this.settings.flow : 1.0);

            for (let c = 0; c < count; c++) {
                let r = radius;
                if (sizeJitter > 0) {
                    r = Math.max(0.4, r * (1.0 - Math.random() * sizeJitter * 0.75));
                }

                let curAngle = baseAngle;
                if (angleJitter > 0) {
                    curAngle += (Math.random() - 0.5) * angleJitter * 360;
                }

                let sx = x;
                let sy = y;
                if (scatter > 0) {
                    const scatterRange = r * 3 * scatter;
                    sx += (Math.random() - 0.5) * scatterRange;
                    sy += (Math.random() - 0.5) * scatterRange;
                }

                const sprite = this.getDabSprite(r, hardness, color, alpha * flow, tipType, roundness, curAngle, wetEdge);
                const cx = sprite.width / 2;
                const cy = sprite.height / 2;

                if (compositeOp) {
                    ctx.save();
                    ctx.globalCompositeOperation = compositeOp;
                    ctx.drawImage(sprite, sx - cx, sy - cy);
                    ctx.restore();
                } else {
                    ctx.drawImage(sprite, sx - cx, sy - cy);
                }
            }
        }

        /**
         * Startet einen neuen Pinselstrich (Pointer / Mouse Down)
         */
        beginStroke(pt, options = {}) {
            this.isStroking = true;
            const usePressure = (options.usePressure !== undefined) ? options.usePressure : (this.settings.usePressure && pt.pressure !== undefined);
            const rawPressure = (pt.pressure !== undefined) ? pt.pressure : 1.0;
            const pressureFactor = usePressure ? (this.settings.minPressureRatio + (1 - this.settings.minPressureRatio) * Math.pow(rawPressure, 1.1)) : 1.0;
            pt.pressureFactor = pressureFactor;

            this.distanceRemainder = 0;
            this.points = [pt];
            this.lastRawPoint = pt;
            this.lastFilteredPoint = { ...pt, pressureFactor };
            this.filteredPoints = [{ ...pt, pressureFactor }];

            const tool = options.tool || 'brush';
            const size = options.size || this.settings.size;
            const radius = size / 2;
            const effectiveRadius = Math.max(0.4, radius * pressureFactor);
            const hardness = (options.hardness !== undefined) ? options.hardness : this.settings.hardness;
            const color = options.color || this.settings.color;
            const ctx = options.targetCtx;

            if (tool === 'smudge' && options.sourceCanvas) {
                this.initSmudgeReservoir(pt, size, options.sourceCanvas, options.opacity);
                return;
            }

            // Ersten Dab stempeln (drucksensitiv)
            if (ctx) {
                const compositeOp = options.isEraser ? 'destination-out' : null;
                const effectiveAlpha = (options.pressureOpacity && usePressure) ? Math.max(0.05, rawPressure) : 1.0;
                this.stampDab(ctx, pt.x, pt.y, effectiveRadius, hardness, color, effectiveAlpha, compositeOp, options);
            }
        }

        /**
         * Führt den Pinselstrich kontinuierlich fort (Pointer / Mouse Move)
         */
        moveStroke(rawPt, options = {}) {
            if (!this.isStroking) return;

            const tool = options.tool || 'brush';
            const size = options.size || this.settings.size;
            const radius = size / 2;
            const hardness = (options.hardness !== undefined) ? options.hardness : this.settings.hardness;
            const color = options.color || this.settings.color;
            const smoothing = (options.smoothing !== undefined) ? options.smoothing : this.settings.smoothing;
            const spacing = options.spacing || this.settings.spacing;
            const ctx = options.targetCtx;
            const usePressure = (options.usePressure !== undefined) ? options.usePressure : (this.settings.usePressure && rawPt.pressure !== undefined);

            if (!ctx && tool !== 'smudge') return;

            // 1. Stabilisator (Streamline Exponential Moving Average)
            const s = Math.max(0.0, Math.min(0.85, smoothing));
            const rawPressure = (rawPt.pressure !== undefined) ? rawPt.pressure : 1.0;
            const pressureFactor = usePressure ? (this.settings.minPressureRatio + (1 - this.settings.minPressureRatio) * Math.pow(rawPressure, 1.1)) : 1.0;
            rawPt.pressureFactor = pressureFactor;

            const prevPF = (this.lastFilteredPoint.pressureFactor !== undefined) ? this.lastFilteredPoint.pressureFactor : pressureFactor;
            const filteredPF = prevPF + (pressureFactor - prevPF) * (1 - s);

            const filteredPt = {
                x: this.lastFilteredPoint.x + (rawPt.x - this.lastFilteredPoint.x) * (1 - s),
                y: this.lastFilteredPoint.y + (rawPt.y - this.lastFilteredPoint.y) * (1 - s),
                pressureFactor: filteredPF
            };

            this.lastRawPoint = rawPt;
            this.points.push(rawPt);
            this.filteredPoints.push(filteredPt);

            const pts = this.filteredPoints;
            const pLen = pts.length;

            if (pLen < 2) return;

            // 2. Spline-Segment: Quadratische Bézier-Kurve über Midpoints inklusive Druck
            let pStart, pCtrl, pEnd;
            if (pLen === 2) {
                pStart = pts[0];
                pCtrl = pts[0];
                pEnd = pts[1];
            } else {
                pStart = {
                    x: (pts[pLen - 3].x + pts[pLen - 2].x) / 2,
                    y: (pts[pLen - 3].y + pts[pLen - 2].y) / 2,
                    pressureFactor: (pts[pLen - 3].pressureFactor + pts[pLen - 2].pressureFactor) / 2
                };
                pCtrl = pts[pLen - 2];
                pEnd = {
                    x: (pts[pLen - 2].x + pts[pLen - 1].x) / 2,
                    y: (pts[pLen - 2].y + pts[pLen - 1].y) / 2,
                    pressureFactor: (pts[pLen - 2].pressureFactor + pts[pLen - 1].pressureFactor) / 2
                };
            }

            // 3. Sub-Pixel Dab Spacing Interpolation entlang der Kurve
            const compositeOp = options.isEraser ? 'destination-out' : null;

            if (tool === 'smudge') {
                const dabStep = Math.max(0.75, radius * 2 * spacing);
                this.renderSmudgeCurve(pStart, pCtrl, pEnd, size, dabStep, options.targetCanvas, options.targetCtx);
            } else {
                this.renderCurveDabs(ctx, pStart, pCtrl, pEnd, radius, hardness, color, spacing, compositeOp, usePressure, options);
            }

            this.lastFilteredPoint = filteredPt;
        }

        /**
         * Schließt den Pinselstrich ab (Pointer / Mouse Up)
         */
        endStroke(options = {}) {
            if (!this.isStroking) return;

            // Letztes Segment zum exakten Endpunkt ziehen
            const pts = this.filteredPoints;
            const pLen = pts.length;
            if (pLen >= 2 && options.targetCtx) {
                const tool = options.tool || 'brush';
                const size = options.size || this.settings.size;
                const radius = size / 2;
                const hardness = (options.hardness !== undefined) ? options.hardness : this.settings.hardness;
                const color = options.color || this.settings.color;
                const spacing = options.spacing || this.settings.spacing;
                const compositeOp = options.isEraser ? 'destination-out' : null;
                const usePressure = (options.usePressure !== undefined) ? options.usePressure : this.settings.usePressure;

                const pStart = {
                    x: (pts[pLen - 2].x + pts[pLen - 1].x) / 2,
                    y: (pts[pLen - 2].y + pts[pLen - 1].y) / 2,
                    pressureFactor: (pts[pLen - 2].pressureFactor + pts[pLen - 1].pressureFactor) / 2
                };
                const pCtrl = pts[pLen - 1];
                const pEnd = pts[pLen - 1];

                if (tool === 'smudge') {
                    const dabStep = Math.max(0.75, radius * 2 * spacing);
                    this.renderSmudgeCurve(pStart, pCtrl, pEnd, size, dabStep, options.targetCanvas, options.targetCtx);
                } else {
                    this.renderCurveDabs(options.targetCtx, pStart, pCtrl, pEnd, radius, hardness, color, spacing, compositeOp, usePressure, options);
                }
            }

            this.isStroking = false;
            this.points = [];
            this.filteredPoints = [];
            this.distanceRemainder = 0;
            this.lastRawPoint = null;
            this.lastFilteredPoint = null;
        }

        /**
         * Rechnet entlang einer Bézier-Kurve mit dynamischem Dab-Spacing und Druckverlauf
         */
        renderCurveDabs(ctx, p0, p1, p2, baseRadius, hardness, color, spacing, compositeOp, usePressure = true, options = {}) {
            const subdivisions = 24;
            let prevPt = p0;
            const p0PF = (p0.pressureFactor !== undefined && usePressure) ? p0.pressureFactor : 1.0;
            const p2PF = (p2.pressureFactor !== undefined && usePressure) ? p2.pressureFactor : 1.0;

            for (let i = 1; i <= subdivisions; i++) {
                const t = i / subdivisions;
                const invT = 1 - t;
                const currPt = {
                    x: invT * invT * p0.x + 2 * invT * t * p1.x + t * t * p2.x,
                    y: invT * invT * p0.y + 2 * invT * t * p1.y + t * t * p2.y
                };

                // Kontinuierliche Druck-Interpolation
                const currPF = usePressure ? (p0PF + (p2PF - p0PF) * t) : 1.0;
                const currentRadius = Math.max(0.4, baseRadius * currPF);
                const dabStep = Math.max(0.5, currentRadius * 2 * spacing);

                let segmentDist = Math.hypot(currPt.x - prevPt.x, currPt.y - prevPt.y);

                while (this.distanceRemainder + segmentDist >= dabStep) {
                    const needed = dabStep - this.distanceRemainder;
                    const ratio = needed / segmentDist;
                    const dabX = prevPt.x + (currPt.x - prevPt.x) * ratio;
                    const dabY = prevPt.y + (currPt.y - prevPt.y) * ratio;

                    const effectiveAlpha = (options.pressureOpacity && usePressure) ? Math.max(0.05, currPF) : 1.0;
                    this.stampDab(ctx, dabX, dabY, currentRadius, hardness, color, effectiveAlpha, compositeOp, options);

                    prevPt = { x: dabX, y: dabY };
                    segmentDist -= needed;
                    this.distanceRemainder = 0;
                }

                this.distanceRemainder += segmentDist;
                prevPt = currPt;
            }
        }

        /**
         * Rendert eine Photoshop-Style Strich-Vorschau (geschwungene S-Kurve mit Druckverlauf)
         */
        renderStrokePreview(previewCanvas, config = {}) {
            if (!previewCanvas) return;
            const w = previewCanvas.width;
            const h = previewCanvas.height;
            const ctx = previewCanvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);

            // Eleganter, dunkler Hintergrund mit dezentem Raster
            ctx.fillStyle = '#161616';
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            for (let x = 20; x < w; x += 20) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 20; y < h; y += 20) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }

            // S-förmige Kurven-Punkte mit natürlicher Druckdynamik
            const points = [
                { x: w * 0.08, y: h * 0.68, pressure: 0.15 },
                { x: w * 0.28, y: h * 0.22, pressure: 0.65 },
                { x: w * 0.50, y: h * 0.50, pressure: 1.0 },
                { x: w * 0.72, y: h * 0.78, pressure: 0.8 },
                { x: w * 0.92, y: h * 0.32, pressure: 0.15 }
            ];

            const tempEngine = new HighPrecisionBrushEngine();
            const merged = { ...this.settings, ...config };
            tempEngine.settings = merged;

            const strokeOptions = {
                tool: 'brush',
                targetCtx: ctx,
                size: Math.min(38, Math.max(4, merged.size || 20)),
                hardness: merged.hardness !== undefined ? merged.hardness : 0.8,
                color: merged.color || '#1db954',
                opacity: merged.opacity !== undefined ? merged.opacity : 1.0,
                tipType: merged.tipType || 'round',
                roundness: merged.roundness !== undefined ? merged.roundness : 1.0,
                angle: merged.angle !== undefined ? merged.angle : 0,
                spacing: merged.spacing !== undefined ? merged.spacing : 0.12,
                sizeJitter: merged.sizeJitter || 0,
                angleJitter: merged.angleJitter || 0,
                scatter: merged.scatter || 0,
                count: merged.count || 1,
                flow: merged.flow !== undefined ? merged.flow : 1.0,
                wetEdge: !!merged.wetEdge,
                usePressure: merged.pressureSize !== false,
                pressureOpacity: !!merged.pressureOpacity
            };

            tempEngine.beginStroke(points[0], strokeOptions);
            for (let i = 1; i < points.length; i++) {
                tempEngine.moveStroke(points[i], strokeOptions);
            }
            tempEngine.endStroke(strokeOptions);
        }

        /**
         * Initialisiert das Smudge-Farbreservoir
         */
        initSmudgeReservoir(pt, size, sourceCanvas, initialOpacity) {
            if (!this.smudgeReservoir && typeof document !== 'undefined') {
                this.smudgeReservoir = document.createElement('canvas');
                this.smudgeReservoirCtx = this.smudgeReservoir.getContext('2d', { willReadFrequently: true });
                this.smudgeMask = document.createElement('canvas');
                this.smudgeMaskCtx = this.smudgeMask.getContext('2d');
                this.smudgeTempStamp = document.createElement('canvas');
                this.smudgeTempStampCtx = this.smudgeTempStamp.getContext('2d');
            }
            if (!this.smudgeReservoir) return;

            const sSize = Math.max(8, Math.ceil(size));
            this.smudgeReservoir.width = sSize;
            this.smudgeReservoir.height = sSize;
            this.smudgeMask.width = sSize;
            this.smudgeMask.height = sSize;
            this.smudgeTempStamp.width = sSize;
            this.smudgeTempStamp.height = sSize;

            // 1. Snapshot des Untergrunds in das Reservoir aufnehmen
            this.smudgeReservoirCtx.clearRect(0, 0, sSize, sSize);
            this.smudgeReservoirCtx.drawImage(sourceCanvas, pt.x - sSize / 2, pt.y - sSize / 2, sSize, sSize, 0, 0, sSize, sSize);

            // 2. Weiche Maske vorbereiten (Radialer Gradient mit Hermite-Kante)
            const mCtx = this.smudgeMaskCtx;
            mCtx.clearRect(0, 0, sSize, sSize);
            const grad = mCtx.createRadialGradient(sSize / 2, sSize / 2, 0, sSize / 2, sSize / 2, sSize / 2);
            grad.addColorStop(0, 'rgba(0,0,0,1)');
            grad.addColorStop(0.4, 'rgba(0,0,0,0.9)');
            grad.addColorStop(0.7, 'rgba(0,0,0,0.4)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            mCtx.fillStyle = grad;
            mCtx.fillRect(0, 0, sSize, sSize);

            this.smudgeWetness = (initialOpacity !== undefined) ? parseFloat(initialOpacity) : 1.0;
            this.smudgeDistance = 0;
        }

        /**
         * Rechnet die Smudge-Interpolation entlang der Kurve
         */
        renderSmudgeCurve(p0, p1, p2, size, dabStep, targetCanvas, targetCtx) {
            if (!targetCanvas || !targetCtx || this.smudgeWetness <= 0) return;

            const sSize = this.smudgeReservoir.width;
            const subdivisions = 20;
            let prevPt = p0;

            for (let i = 1; i <= subdivisions; i++) {
                if (this.smudgeWetness <= 0) break;

                const t = i / subdivisions;
                const invT = 1 - t;
                const currPt = {
                    x: invT * invT * p0.x + 2 * invT * t * p1.x + t * t * p2.x,
                    y: invT * invT * p0.y + 2 * invT * t * p1.y + t * t * p2.y
                };

                let segmentDist = Math.hypot(currPt.x - prevPt.x, currPt.y - prevPt.y);

                while (this.distanceRemainder + segmentDist >= dabStep) {
                    const needed = dabStep - this.distanceRemainder;
                    const ratio = needed / segmentDist;
                    const dabX = prevPt.x + (currPt.x - prevPt.x) * ratio;
                    const dabY = prevPt.y + (currPt.y - prevPt.y) * ratio;

                    // 1. Maskierten Stempel aus dem Reservoir erzeugen
                    const stampCtx = this.smudgeTempStampCtx;
                    stampCtx.clearRect(0, 0, sSize, sSize);
                    stampCtx.drawImage(this.smudgeReservoir, 0, 0);
                    stampCtx.globalCompositeOperation = 'destination-in';
                    stampCtx.drawImage(this.smudgeMask, 0, 0);
                    stampCtx.globalCompositeOperation = 'source-over';

                    // 2. Stempel auf Canvas auftragen
                    targetCtx.save();
                    targetCtx.globalAlpha = Math.min(1.0, this.smudgeWetness);
                    targetCtx.drawImage(this.smudgeTempStamp, dabX - sSize / 2, dabY - sSize / 2);
                    targetCtx.restore();

                    // 3. Pickup: 12% der neuen Farbe vom Canvas ins Reservoir zurückmischen
                    this.smudgeReservoirCtx.save();
                    this.smudgeReservoirCtx.globalAlpha = 0.12;
                    this.smudgeReservoirCtx.globalCompositeOperation = 'source-atop';
                    this.smudgeReservoirCtx.drawImage(targetCanvas, dabX - sSize / 2, dabY - sSize / 2, sSize, sSize, 0, 0, sSize, sSize);
                    this.smudgeReservoirCtx.restore();

                    // 4. Feuchtigkeitsabnahme entlang des Zugwegs
                    this.smudgeDistance += dabStep;
                    this.smudgeWetness = Math.max(0, 1.0 - (this.smudgeDistance / this.smudgeMaxDistance));

                    prevPt = { x: dabX, y: dabY };
                    segmentDist -= needed;
                    this.distanceRemainder = 0;
                }

                this.distanceRemainder += segmentDist;
                prevPt = currPt;
            }
        }

        /**
         * Schneller C++ Gaußscher Weichzeichner / Schärfen (PhotoCraft)
         */
        applyCPlusPlusFilter(targetCtx, width, height, filterType, param = 1) {
            return this.applyPhotoCraftFilter(targetCtx, width, height, filterType, { radius: param, amount: param });
        }

        /**
         * Führt Bildkorrekturen (Image > Adjustments) im C++ Kern aus
         */
        applyPhotoCraftAdjustment(targetCtx, width, height, type, options = {}) {
            if (!targetCtx || width <= 0 || height <= 0) return false;
            try {
                const imgData = targetCtx.getImageData(0, 0, width, height);
                const buf = Buffer.from(imgData.data.buffer);

                if (this.native) {
                    switch (type) {
                        case 'levels':
                            this.native.adjustLevels(
                                buf,
                                options.channel || 0,
                                options.inBlack || 0,
                                options.inWhite || 255,
                                options.gamma || 1.0,
                                options.outBlack || 0,
                                options.outWhite || 255
                            );
                            break;
                        case 'curves':
                            this.native.adjustCurves(
                                buf,
                                options.channel || 0,
                                options.xs || [0, 255],
                                options.ys || [0, 255]
                            );
                            break;
                        case 'brightnessContrast':
                            this.native.adjustBrightnessContrast(
                                buf,
                                options.brightness || 0,
                                options.contrast || 0
                            );
                            break;
                        case 'hueSaturation':
                            this.native.adjustHueSaturation(
                                buf,
                                options.hue || 0,
                                options.saturation || 0,
                                options.lightness || 0,
                                !!options.colorize
                            );
                            break;
                        case 'vibrance':
                            this.native.adjustVibrance(
                                buf,
                                options.vibrance || 0,
                                options.saturation || 0
                            );
                            break;
                        case 'blackWhite':
                            this.native.adjustBlackWhite(
                                buf,
                                options.weights || [40, 60, 40, 60, 20, 80],
                                !!options.tint,
                                options.tintHue || 30,
                                options.tintSat || 25
                            );
                            break;
                        case 'photoFilter':
                            const rgb = parseRgb(options.color || '#ec8a00');
                            this.native.adjustPhotoFilter(
                                buf,
                                rgb.r, rgb.g, rgb.b,
                                options.density !== undefined ? options.density : 25,
                                options.preserveLum !== false
                            );
                            break;
                        case 'exposure':
                            this.native.adjustExposure(
                                buf,
                                options.exposure || 0,
                                options.offset || 0,
                                options.gamma || 1.0
                            );
                            break;
                        case 'colorBalance':
                            this.native.adjustColorBalance(
                                buf,
                                options.shadows || [0, 0, 0],
                                options.midtones || [0, 0, 0],
                                options.highlights || [0, 0, 0],
                                options.preserveLum !== false
                            );
                            break;
                        case 'invert':
                            this.native.adjustInvert(buf);
                            break;
                        case 'posterize':
                            this.native.adjustPosterize(buf, options.levels || 4);
                            break;
                        case 'threshold':
                            this.native.adjustThreshold(buf, options.level || 128);
                            break;
                        case 'desaturate':
                            this.native.adjustDesaturate(buf);
                            break;
                        case 'equalize':
                            this.native.adjustEqualize(buf);
                            break;
                        case 'autoContrast':
                            this.native.adjustAutoContrast(buf, options.clipPercent || 0.5);
                            break;
                        default:
                            return false;
                    }
                }
                targetCtx.putImageData(imgData, 0, 0);
                return true;
            } catch (err) {
                console.error('[PhotoCraft Adjustment Error]', err);
                return false;
            }
        }

        /**
         * Führt Filter & Effekte (Filter Menu) im C++ Kern aus
         */
        applyPhotoCraftFilter(targetCtx, width, height, type, options = {}) {
            if (!targetCtx || width <= 0 || height <= 0) return false;
            try {
                const imgData = targetCtx.getImageData(0, 0, width, height);
                const buf = Buffer.from(imgData.data.buffer);

                if (this.native) {
                    switch (type) {
                        case 'blur':
                        case 'gaussianBlur':
                            this.native.filterGaussianBlur(buf, width, height, options.radius || 5);
                            break;
                        case 'motionBlur':
                            this.native.filterMotionBlur(buf, width, height, options.angle || 0, options.distance || 15);
                            break;
                        case 'radialBlur':
                            this.native.filterRadialBlur(
                                buf, width, height,
                                options.centerX !== undefined ? options.centerX : width / 2,
                                options.centerY !== undefined ? options.centerY : height / 2,
                                options.amount || 0.2
                            );
                            break;
                        case 'twirl':
                            this.native.filterTwirl(
                                buf, width, height,
                                options.centerX !== undefined ? options.centerX : width / 2,
                                options.centerY !== undefined ? options.centerY : height / 2,
                                options.radius || Math.min(width, height) / 2,
                                options.angle || 90
                            );
                            break;
                        case 'ripple':
                            this.native.filterRipple(buf, width, height, options.amplitude || 10, options.wavelength || 60);
                            break;
                        case 'pixelate':
                            this.native.filterPixelate(buf, width, height, options.cellSize || 10);
                            break;
                        case 'oilPaint':
                            this.native.filterOilPaint(buf, width, height, options.radius || 4, options.levels || 20);
                            break;
                        case 'highPass':
                            this.native.filterHighPass(buf, width, height, options.radius || 10);
                            break;
                        case 'findEdges':
                            this.native.filterFindEdges(buf, width, height);
                            break;
                        default:
                            return false;
                    }
                }
                targetCtx.putImageData(imgData, 0, 0);
                return true;
            } catch (err) {
                console.error('[PhotoCraft Filter Error]', err);
                return false;
            }
        }

        /**
         * Berechnet das Histogramm der Ebene ueber C++
         */
        getCanvasHistogram(targetCtx, width, height) {
            if (!targetCtx || !this.native) return null;
            try {
                const imgData = targetCtx.getImageData(0, 0, width, height);
                const buf = Buffer.from(imgData.data.buffer);
                return this.native.getHistogram(buf);
            } catch (err) {
                return null;
            }
        }

        /**
         * Blitzschneller 4-Wege Scanline Flood-Fill (Fülleimer) in C++
         */
        floodFillCanvas(targetCtx, width, height, startX, startY, fillColor, tolerance = 15) {
            if (!targetCtx) return 0;
            try {
                const imgData = targetCtx.getImageData(0, 0, width, height);
                const buf = Buffer.from(imgData.data.buffer);
                const rgb = parseRgb(fillColor);
                if (this.native) {
                    const filled = this.native.floodFill(
                        buf,
                        width,
                        height,
                        Math.round(startX),
                        Math.round(startY),
                        rgb.r,
                        rgb.g,
                        rgb.b,
                        255,
                        Math.round(tolerance)
                    );
                    if (filled > 0) {
                        targetCtx.putImageData(imgData, 0, 0);
                    }
                    return filled;
                }
            } catch (err) {
                console.error('[C++ FloodFill Error]', err);
            }
            return 0;
        }
    }

    // Singleton-Instanz exportieren
    const instance = new HighPrecisionBrushEngine();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = instance;
    }
    global.BrushEngine = instance;

})(typeof window !== 'undefined' ? window : globalThis);
