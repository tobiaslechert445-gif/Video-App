/**
 * Clip Studio Paint - Unteransicht (Reference Viewer / Sub View)
 * Antigravity Drawing Studio
 * 
 * Bietet einen professionellen Referenzbereich zum:
 * - Laden, Speichern & Verwalten von Referenzbildern (persistent über alle Projekte hinweg)
 * - Zoomen (per Schieberegler, +/- Buttons und Mausrad-Zoom)
 * - Drehen (stufenlos & 90°-Schritte) und Spiegeln (horizontal & vertikal)
 * - Farben direkt per Pipette / Eyedropper aus dem Bild picken mit Live-Farblupe
 * - Bilder per Klick als neue Ebene direkt auf die Zeichenleinwand importieren
 * - Schneller Bildwechsel via Vor/Zurück-Pfeile und Kachel-Thumbnail-Menü (nach kürzlich hinzugefügt sortiert)
 * - Drag & Drop und Zwischenablage (Strg+V) Unterstützung
 */

(function () {
    'use strict';

    // Node.js Module im Electron Renderer sicher abfragen
    let fs = null;
    let path = null;
    let webUtils = null;
    try {
        if (typeof require === 'function') {
            fs = require('fs');
            path = require('path');
            const electron = require('electron');
            webUtils = electron.webUtils;
        }
    } catch (e) {
        console.warn('Node.js Module in Unteransicht nicht verfügbar:', e);
    }

    const STORAGE_KEY = 'csp_reference_library_v2';
    const ACTIVE_ID_KEY = 'csp_reference_active_id_v2';

    // State der Unteransicht
    const refState = {
        images: [],             // Array von { id, name, path, src, width, height, addedAt }
        currentIndex: -1,
        activeImage: null,      // Image Object
        activeImageData: null,  // ImageData für pixelgenaues Color Picking
        offscreenCanvas: null,
        offscreenCtx: null,
        
        // Transformations-State
        zoom: 1.0,
        fitZoom: 1.0,
        isAtFitZoom: true,
        panX: 0,
        panY: 0,
        rotation: 0,            // Grad (-180° bis +180°)
        flipH: false,
        flipV: false,

        // Interaktion
        isEyedropperActive: true, // Pipette standardmäßig aktiv (wie in CSP blau)
        isDragging: false,
        dragStartX: 0,
        dragStartY: 0,
        startPanX: 0,
        startPanY: 0,

        // Merker für Ansichts-Umschaltung (Standard vs. Aktuell)
        lastNonFitZoom: 1.0,
        lastNonFitPanX: 0,
        lastNonFitPanY: 0
    };

    /**
     * Ermittelt das aktive Dokument (Standardfenster oder Tablet Popout-Fenster)
     */
    function getDoc() {
        if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
            return window.popoutEditorWindow.document;
        }
        return document;
    }

    /**
     * Ermittelt den Speicherpfad für persistente Referenzbilder
     */
    function getReferencesStorageDir() {
        if (!fs || !path) return null;
        try {
            const isPackaged = __dirname.includes('app.asar');
            const mBase = isPackaged
                ? path.join(path.dirname(process.execPath), 'media')
                : path.join(__dirname, '..', 'media');
            const baseDir = path.join(mBase, 'references');
            if (!fs.existsSync(baseDir)) {
                fs.mkdirSync(baseDir, { recursive: true });
            }
            return baseDir;
        } catch (e) {
            console.error('Fehler beim Erstellen des Referenz-Ordners:', e);
            return null;
        }
    }

    /**
     * Initialisiert und lädt gespeicherte Referenzbilder
     */
    function loadSavedReferences() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                refState.images = JSON.parse(raw);
            } else {
                refState.images = [];
            }
        } catch (e) {
            console.error('Fehler beim Laden der Referenzen aus localStorage:', e);
            refState.images = [];
        }

        // Nach kürzlich hinzugefügt sortieren (neueste zuerst)
        refState.images.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

        const savedActiveId = localStorage.getItem(ACTIVE_ID_KEY);
        if (savedActiveId && refState.images.length > 0) {
            const idx = refState.images.findIndex(img => img.id === savedActiveId);
            refState.currentIndex = idx !== -1 ? idx : 0;
        } else if (refState.images.length > 0) {
            refState.currentIndex = 0;
        } else {
            refState.currentIndex = -1;
        }
    }

    /**
     * Speichert die Referenzliste persistent in localStorage
     */
    function saveReferencesToStorage() {
        try {
            // Um Speicherplatz zu sparen, bereinigen wir evtl. zu große DataURLs falls Pfade vorhanden sind
            const cleanList = refState.images.map(item => ({
                id: item.id,
                name: item.name,
                path: item.path || '',
                src: item.path ? '' : (item.src ? item.src.substring(0, 1000000) : ''), // Fallback
                width: item.width || 0,
                height: item.height || 0,
                addedAt: item.addedAt || Date.now()
            }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanList));

            const cur = getCurrentReferenceItem();
            if (cur) {
                localStorage.setItem(ACTIVE_ID_KEY, cur.id);
            } else {
                localStorage.removeItem(ACTIVE_ID_KEY);
            }
        } catch (e) {
            console.warn('Konnte Referenzen nicht in localStorage sichern (möglicherweise Quota):', e);
        }
    }

    /**
     * Liefert das aktuelle Referenz-Objekt
     */
    function getCurrentReferenceItem() {
        if (refState.currentIndex >= 0 && refState.currentIndex < refState.images.length) {
            return refState.images[refState.currentIndex];
        }
        return null;
    }

    /**
     * Lädt das aktive Referenzbild und berechnet die Ansicht
     */
    function displayActiveReference(autoFit = true) {
        const item = getCurrentReferenceItem();
        const d = getDoc();
        const emptyState = d.getElementById('subviewEmptyState');
        const canvas = d.getElementById('subviewCanvas');

        if (!item) {
            refState.activeImage = null;
            refState.activeImageData = null;
            if (emptyState) emptyState.style.display = 'flex';
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            updateControlsUI();
            updateScrollIndicators();
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            refState.activeImage = img;
            item.width = img.naturalWidth || img.width;
            item.height = img.naturalHeight || img.height;

            // Offscreen Canvas für pixelgenaues Color Picking anlegen
            const off = document.createElement('canvas');
            off.width = item.width;
            off.height = item.height;
            const offCtx = off.getContext('2d', { willReadFrequently: true });
            offCtx.drawImage(img, 0, 0);
            try {
                refState.activeImageData = offCtx.getImageData(0, 0, item.width, item.height);
            } catch (err) {
                console.warn('ImageData konnte für Referenzbild nicht gelesen werden:', err);
                refState.activeImageData = null;
            }
            refState.offscreenCanvas = off;
            refState.offscreenCtx = offCtx;

            if (autoFit) {
                fitReferenceToViewport();
            } else {
                renderReferenceCanvas();
            }
            updateControlsUI();
        };

        img.onerror = (err) => {
            console.error('Fehler beim Laden des Referenzbildes:', err, item);
            if (emptyState) emptyState.style.display = 'flex';
        };

        // Source ermitteln
        if (item.path && fs && fs.existsSync(item.path)) {
            img.src = 'file:///' + item.path.replace(/\\/g, '/');
        } else if (item.src) {
            img.src = item.src;
        } else if (item.path) {
            img.src = 'file:///' + item.path.replace(/\\/g, '/');
        }
    }

    /**
     * Passt das Referenzbild exakt in das Unteransichts-Fenster ein (Fit View)
     */
    function fitReferenceToViewport() {
        const d = getDoc();
        const viewport = d.getElementById('subviewViewport');
        const img = refState.activeImage;
        if (!viewport || !img) return;

        const vpW = Math.max(10, viewport.clientWidth - 16);
        const vpH = Math.max(10, viewport.clientHeight - 16);
        const imgW = img.naturalWidth || img.width || 100;
        const imgH = img.naturalHeight || img.height || 100;

        const scaleW = vpW / imgW;
        const scaleH = vpH / imgH;
        const bestScale = Math.min(scaleW, scaleH);

        refState.zoom = Math.max(0.05, Math.min(bestScale, 1.0)); // Nicht künstlich pixelig vergrößern
        refState.fitZoom = refState.zoom;
        refState.isAtFitZoom = true;
        refState.panX = 0;
        refState.panY = 0;
        refState.rotation = 0;

        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Zeichnet das Referenzbild auf das Viewport-Canvas
     */
    function renderReferenceCanvas() {
        const d = getDoc();
        const viewport = d.getElementById('subviewViewport');
        const canvas = d.getElementById('subviewCanvas');
        if (!viewport || !canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const vpW = viewport.clientWidth;
        const vpH = viewport.clientHeight;

        if (canvas.width !== Math.floor(vpW * dpr) || canvas.height !== Math.floor(vpH * dpr)) {
            canvas.width = Math.floor(vpW * dpr);
            canvas.height = Math.floor(vpH * dpr);
            canvas.style.width = vpW + 'px';
            canvas.style.height = vpH + 'px';
        }

        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);

        // Hintergrund mit dezentem CSP Schachbrettmuster
        ctx.fillStyle = '#222222';
        ctx.fillRect(0, 0, vpW, vpH);
        drawSubtleCheckerboard(ctx, vpW, vpH);

        const img = refState.activeImage;
        if (img && img.complete && img.naturalWidth > 0) {
            const imgW = img.naturalWidth || img.width;
            const imgH = img.naturalHeight || img.height;

            ctx.save();
            // Verschiebe Ursprung in die Mitte des Viewports + Pan-Offset
            ctx.translate(vpW / 2 + refState.panX, vpH / 2 + refState.panY);

            // Drehung (in Radiant)
            ctx.rotate((refState.rotation * Math.PI) / 180);

            // Skalierung mit Spiegelung (Flip H/V)
            const sx = refState.zoom * (refState.flipH ? -1 : 1);
            const sy = refState.zoom * (refState.flipV ? -1 : 1);
            ctx.scale(sx, sy);

            // Bildglättung abhängig vom Zoomfaktor
            ctx.imageSmoothingEnabled = refState.zoom < 2.5;

            // Bild zentriert zeichnen
            ctx.drawImage(img, -imgW / 2, -imgH / 2, imgW, imgH);
            ctx.restore();
        }

        ctx.restore();
        updateScrollIndicators();
    }

    /**
     * Zeichnet ein CSP-typisches dezentes Schachbrettmuster für transparente Bereiche
     */
    function drawSubtleCheckerboard(ctx, w, h) {
        const size = 12;
        ctx.fillStyle = '#1c1c1c';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#262626';
        for (let y = 0; y < h; y += size) {
            for (let x = 0; x < w; x += size) {
                if (((x / size) + (y / size)) % 2 === 0) {
                    ctx.fillRect(x, y, size, size);
                }
            }
        }
    }

    /**
     * Aktualisiert die CSP-typischen Scrollbar-Indikatoren am Viewport-Rand
     */
    function updateScrollIndicators() {
        const d = getDoc();
        const viewport = d.getElementById('subviewViewport');
        const thumbH = d.getElementById('subviewScrollThumbH');
        const thumbV = d.getElementById('subviewScrollThumbV');
        const img = refState.activeImage;

        if (!viewport || !thumbH || !thumbV || !img) {
            if (thumbH) thumbH.style.display = 'none';
            if (thumbV) thumbV.style.display = 'none';
            return;
        }

        const vpW = viewport.clientWidth;
        const vpH = viewport.clientHeight;
        const totalW = img.naturalWidth * refState.zoom;
        const totalH = img.naturalHeight * refState.zoom;

        // Horizontale Scrollleiste
        if (totalW > vpW) {
            thumbH.style.display = 'block';
            const ratio = Math.max(0.1, Math.min(1.0, vpW / totalW));
            const thumbW = Math.max(20, vpW * ratio);
            const maxPan = (totalW - vpW) / 2 + 50;
            const normX = Math.max(-1, Math.min(1, refState.panX / maxPan));
            const left = ((vpW - thumbW) / 2) - (normX * ((vpW - thumbW) / 2));
            thumbH.style.width = thumbW + 'px';
            thumbH.style.left = Math.max(0, Math.min(vpW - thumbW, left)) + 'px';
        } else {
            thumbH.style.display = 'none';
        }

        // Vertikale Scrollleiste
        if (totalH > vpH) {
            thumbV.style.display = 'block';
            const ratio = Math.max(0.1, Math.min(1.0, vpH / totalH));
            const thumbHeight = Math.max(20, vpH * ratio);
            const maxPan = (totalH - vpH) / 2 + 50;
            const normY = Math.max(-1, Math.min(1, refState.panY / maxPan));
            const top = ((vpH - thumbHeight) / 2) - (normY * ((vpH - thumbHeight) / 2));
            thumbV.style.height = thumbHeight + 'px';
            thumbV.style.top = Math.max(0, Math.min(vpH - thumbHeight, top)) + 'px';
        } else {
            thumbV.style.display = 'none';
        }
    }

    /**
     * Transformiert Viewport-Mauskoordinaten exakt in Quellbild-Pixelkoordinaten
     * (berücksichtigt Drehung, Pan, Zoom und horizontale/vertikale Spiegelung)
     */
    function getSourcePixelCoordinates(vpX, vpY) {
        const d = getDoc();
        const viewport = d.getElementById('subviewViewport');
        const img = refState.activeImage;
        if (!viewport || !img || !img.naturalWidth) return null;

        const vpW = viewport.clientWidth;
        const vpH = viewport.clientHeight;
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;

        // 1. Relativ zum zentrierten Dreh-/Skalierungspunkt
        const dx = vpX - (vpW / 2 + refState.panX);
        const dy = vpY - (vpH / 2 + refState.panY);

        // 2. Umgekehrte Drehung (-rotation)
        const rad = (-refState.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;

        // 3. Umgekehrte Skalierung & Spiegelung
        const sx = rx / (refState.zoom * (refState.flipH ? -1 : 1));
        const sy = ry / (refState.zoom * (refState.flipV ? -1 : 1));

        // 4. Zurück auf Quellbild-Koordinaten
        const srcX = Math.floor(sx + imgW / 2);
        const srcY = Math.floor(sy + imgH / 2);

        if (srcX >= 0 && srcX < imgW && srcY >= 0 && srcY < imgH) {
            return { x: srcX, y: srcY, imgW, imgH };
        }
        return null;
    }

    /**
     * Liest die Farbe an einer Koordinate und wendet sie auf das Zeichenprogramm an
     */
    function sampleColorFromReference(vpX, vpY, applyToApp = true) {
        const pos = getSourcePixelCoordinates(vpX, vpY);
        const d = getDoc();
        const loupe = d.getElementById('subviewLoupe');
        const loupeColor = d.getElementById('subviewLoupeColor');
        const loupeHex = d.getElementById('subviewLoupeHex');

        if (!pos || !refState.activeImageData) {
            if (loupe) loupe.classList.add('hidden');
            return null;
        }

        const data = refState.activeImageData.data;
        const idx = (pos.y * pos.imgW + pos.x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        if (a === 0) {
            if (loupe) loupe.classList.add('hidden');
            return null;
        }

        const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();

        // Farblupe aktualisieren
        if (loupe && loupeColor && loupeHex) {
            loupe.classList.remove('hidden');
            loupe.style.left = (vpX + 16) + 'px';
            loupe.style.top = (vpY + 16) + 'px';
            loupeColor.style.backgroundColor = hex;
            loupeHex.innerText = hex;
        }

        if (applyToApp) {
            applySampledColor(hex);
        }

        return hex;
    }

    /**
     * Überträgt die gepickte Farbe nahtlos in die Zeichen-UI
     */
    function applySampledColor(hex) {
        const d = getDoc();
        const colorPicker = d.getElementById('logoColorPicker');
        const curDisplay = d.getElementById('currentColorDisplay');
        const valHEl = d.getElementById('valH');

        if (colorPicker) colorPicker.value = hex;
        if (curDisplay) curDisplay.style.backgroundColor = hex;
        if (valHEl) valHEl.innerText = hex;

        if (typeof window.hexToHsv === 'function') {
            window.hsv = window.hexToHsv(hex);
            if (typeof window.drawCSPColorWheel === 'function') {
                window.drawCSPColorWheel();
            }
        }

        if (typeof window.updateActiveLayerColor === 'function') {
            window.updateActiveLayerColor(hex);
        }
    }

    /**
     * UI der Slider, Labels und Toggle-Buttons synchronisieren
     */
    function updateControlsUI() {
        const d = getDoc();

        // Zoom Slider & Badge
        const zoomSlider = d.getElementById('subviewZoomSlider');
        const zoomVal = d.getElementById('subviewZoomVal');
        if (zoomSlider) {
            zoomSlider.value = Math.round(refState.zoom * 100);
        }
        if (zoomVal) {
            zoomVal.innerText = (refState.zoom * 100).toFixed(1) + '%';
        }

        // Rotate Slider & Badge
        const rotSlider = d.getElementById('subviewRotateSlider');
        const rotVal = d.getElementById('subviewRotateVal');
        if (rotSlider) {
            rotSlider.value = Math.round(refState.rotation);
        }
        if (rotVal) {
            rotVal.innerText = refState.rotation.toFixed(1) + '°';
        }

        // Flip Buttons
        const flipHBtn = d.getElementById('subviewFlipHBtn');
        const flipVBtn = d.getElementById('subviewFlipVBtn');
        if (flipHBtn) {
            flipHBtn.classList.toggle('active', refState.flipH);
        }
        if (flipVBtn) {
            flipVBtn.classList.toggle('active', refState.flipV);
        }

        // Pipette Button (blau wenn aktiv, wie im Screenshot)
        const pipetteBtn = d.getElementById('subviewEyedropperBtn');
        if (pipetteBtn) {
            pipetteBtn.classList.toggle('active', refState.isEyedropperActive);
        }

        // Fit Button State
        const fitBtn = d.getElementById('subviewFitBtn');
        if (fitBtn) {
            fitBtn.classList.toggle('active', refState.isAtFitZoom);
        }

        // Vor/Zurück Buttons State
        const prevBtn = d.getElementById('subviewPrevBtn');
        const nextBtn = d.getElementById('subviewNextBtn');
        if (prevBtn) {
            prevBtn.disabled = refState.currentIndex <= 0;
            prevBtn.style.opacity = refState.currentIndex <= 0 ? '0.4' : '1';
        }
        if (nextBtn) {
            nextBtn.disabled = refState.currentIndex >= refState.images.length - 1;
            nextBtn.style.opacity = refState.currentIndex >= refState.images.length - 1 ? '0.4' : '1';
        }

        // Viewport Cursor anpassen
        const viewport = d.getElementById('subviewViewport');
        if (viewport) {
            if (refState.isEyedropperActive) {
                viewport.style.cursor = 'crosshair';
            } else {
                viewport.style.cursor = refState.isDragging ? 'grabbing' : 'grab';
            }
        }
    }

    /**
     * Zoom-Schritt (+ oder -)
     */
    function zoomReferenceStep(direction) {
        refState.isAtFitZoom = false;
        const factor = direction > 0 ? 1.25 : 0.8;
        refState.zoom = Math.max(0.05, Math.min(10.0, refState.zoom * factor));
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Zoom-Schieberegler Handler
     */
    function onReferenceZoomSlider(val) {
        refState.isAtFitZoom = false;
        refState.zoom = Math.max(0.05, Math.min(10.0, parseFloat(val) / 100));
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Wechselt zwischen Standard-Ansicht (Einpassen) und aktueller Ansicht (100% oder letzter Zoom)
     * "der btn rechts soll wechseln zu standard ansicht und aktuelle ansicht"
     */
    function toggleReferenceFitOrActual() {
        if (!refState.activeImage) return;

        if (refState.isAtFitZoom) {
            // Zurück zu 100% oder der letzten benutzerdefinierten Ansicht
            refState.zoom = refState.lastNonFitZoom || 1.0;
            refState.panX = refState.lastNonFitPanX || 0;
            refState.panY = refState.lastNonFitPanY || 0;
            refState.isAtFitZoom = false;
        } else {
            // Speichere die aktuelle Ansicht
            refState.lastNonFitZoom = refState.zoom;
            refState.lastNonFitPanX = refState.panX;
            refState.lastNonFitPanY = refState.panY;

            // Zur Standard-Ansicht (Einpassen) wechseln
            fitReferenceToViewport();
            return;
        }

        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Drehung per Schieberegler
     */
    function onReferenceRotateSlider(val) {
        refState.rotation = parseFloat(val);
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Drehung in Schritten (+90° / -90°)
     */
    function rotateReferenceStep(step) {
        let r = refState.rotation + step;
        while (r > 180) r -= 360;
        while (r < -180) r += 360;
        refState.rotation = r;
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Drehung zurücksetzen auf 0°
     */
    function resetReferenceRotation() {
        refState.rotation = 0;
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Horizontal spiegeln (>|<)
     */
    function toggleReferenceFlipH() {
        refState.flipH = !refState.flipH;
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Vertikal spiegeln (▲▼)
     */
    function toggleReferenceFlipV() {
        refState.flipV = !refState.flipV;
        renderReferenceCanvas();
        updateControlsUI();
    }

    /**
     * Pipetten-Modus umschalten
     */
    function toggleReferenceEyedropper() {
        refState.isEyedropperActive = !refState.isEyedropperActive;
        const d = getDoc();
        const loupe = d.getElementById('subviewLoupe');
        if (!refState.isEyedropperActive && loupe) {
            loupe.classList.add('hidden');
        }
        updateControlsUI();
    }

    /**
     * Zum vorherigen Bild wechseln (sortiert nach kürzlich hinzugefügt)
     */
    function prevReferenceImage() {
        if (refState.currentIndex > 0) {
            refState.currentIndex--;
            displayActiveReference(true);
            saveReferencesToStorage();
        }
    }

    /**
     * Zum nächsten Bild wechseln
     */
    function nextReferenceImage() {
        if (refState.currentIndex < refState.images.length - 1) {
            refState.currentIndex++;
            displayActiveReference(true);
            saveReferencesToStorage();
        }
    }

    /**
     * Bringt das aktuelle Referenzbild auf die Zeichenleinwand ("Blatt mit Stift")
     */
    function importReferenceToCanvas() {
        const item = getCurrentReferenceItem();
        if (!item || !refState.activeImage) {
            alert('Kein Referenzbild zum Einfügen vorhanden.');
            return;
        }

        const name = 'Referenz - ' + (item.name || 'Bild');
        if (typeof window.addNewLayer === 'function') {
            window.addNewLayer(refState.activeImage, name);
            showSubviewToast(`"${item.name}" als neue Ebene auf die Leinwand gebracht!`);
        } else {
            console.error('addNewLayer ist nicht verfügbar.');
        }
    }

    /**
     * Löscht das aktuelle Referenzbild aus der Liste ("Tonne")
     */
    function deleteCurrentReference() {
        const item = getCurrentReferenceItem();
        if (!item) return;

        if (!confirm(`Soll das Referenzbild "${item.name}" wirklich gelöscht werden?`)) {
            return;
        }

        // Datei evtl. aus dem lokalen references-Ordner löschen
        if (fs && item.path && item.path.includes(path.join('media', 'references'))) {
            try {
                if (fs.existsSync(item.path)) {
                    fs.unlinkSync(item.path);
                }
            } catch (e) {
                console.warn('Konnte Referenzdatei auf der Festplatte nicht löschen:', e);
            }
        }

        refState.images.splice(refState.currentIndex, 1);
        if (refState.currentIndex >= refState.images.length) {
            refState.currentIndex = refState.images.length - 1;
        }

        saveReferencesToStorage();
        displayActiveReference(true);
        renderThumbsPopupGrid();
        showSubviewToast('Referenzbild gelöscht.');
    }

    /**
     * Zeigt Bildinformationen an ((i) Button)
     */
    function showReferenceInfo(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const item = getCurrentReferenceItem();
        if (!item) {
            alert('Keine Referenz geladen.');
            return;
        }

        const d = getDoc();
        let popover = d.getElementById('subviewInfoPopover');
        if (popover) {
            popover.remove();
            return;
        }

        popover = d.createElement('div');
        popover.id = 'subviewInfoPopover';
        popover.className = 'subview-info-popover';

        const dateStr = item.addedAt ? new Date(item.addedAt).toLocaleString('de-DE') : 'Unbekannt';

        popover.innerHTML = `
            <div style="font-weight: bold; color: #fff; margin-bottom: 6px; font-size: 12px; border-bottom: 1px solid #333; padding-bottom: 4px;">ℹ️ Bild-Informationen</div>
            <div class="subview-info-row"><span>Dateiname:</span><strong style="color: #ddd; word-break: break-all;">${item.name}</strong></div>
            <div class="subview-info-row"><span>Auflösung:</span><strong>${item.width || 0} × ${item.height || 0} px</strong></div>
            <div class="subview-info-row"><span>Hinzugefügt:</span><span>${dateStr}</span></div>
            <div class="subview-info-row"><span>Zoom:</span><span>${(refState.zoom * 100).toFixed(1)}%</span></div>
            <div class="subview-info-row"><span>Drehung:</span><span>${refState.rotation.toFixed(1)}°</span></div>
            <div class="subview-info-row"><span>Spiegelung:</span><span>H: ${refState.flipH ? 'Ja' : 'Nein'} | V: ${refState.flipV ? 'Ja' : 'Nein'}</span></div>
        `;

        if (e && e.target) {
            const rect = e.target.getBoundingClientRect();
            popover.style.right = (d.body.clientWidth - rect.right) + 'px';
            popover.style.top = (rect.bottom + 6) + 'px';
        } else {
            popover.style.top = '60px';
            popover.style.right = '20px';
        }

        d.body.appendChild(popover);

        const closeListener = (evt) => {
            if (!popover.contains(evt.target)) {
                popover.remove();
                d.removeEventListener('click', closeListener);
            }
        };
        setTimeout(() => d.addEventListener('click', closeListener), 20);
    }

    /**
     * Ansicht zurücksetzen (Fit)
     */
    function resetReferenceView() {
        fitReferenceToViewport();
    }

    /**
     * Kacheln-Menü umschalten ("diese kacheln öffnen ein kleines menü feld...")
     */
    function toggleReferenceThumbsPopup(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const d = getDoc();
        const popup = d.getElementById('subviewThumbsPopup');
        if (!popup) return;

        const isHidden = popup.classList.contains('hidden');
        if (isHidden) {
            renderThumbsPopupGrid();
            popup.classList.remove('hidden');

            // Positionieren über dem Kachel-Button
            const btn = d.getElementById('subviewTilesBtn');
            if (btn) {
                const rect = btn.getBoundingClientRect();
                popup.style.bottom = (d.body.clientHeight - rect.top + 8) + 'px';
                popup.style.right = (d.body.clientWidth - rect.right) + 'px';
            }

            const closePopup = (evt) => {
                if (!popup.contains(evt.target) && evt.target !== btn && !btn.contains(evt.target)) {
                    popup.classList.add('hidden');
                    d.removeEventListener('click', closePopup);
                }
            };
            setTimeout(() => d.addEventListener('click', closePopup), 20);
        } else {
            popup.classList.add('hidden');
        }
    }

    /**
     * Rendert die Thumbnails im Popup-Menü, sortiert nach kürzlich hinzugefügt
     */
    function renderThumbsPopupGrid() {
        const d = getDoc();
        const grid = d.getElementById('subviewThumbsGrid');
        const countBadge = d.getElementById('subviewThumbsCount');
        if (!grid) return;

        if (countBadge) {
            countBadge.innerText = refState.images.length;
        }

        grid.innerHTML = '';
        if (refState.images.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: #777; font-size: 11px;">Keine Referenzbilder gespeichert. Klicke auf 📁 um neue hinzuzufügen!</div>`;
            return;
        }

        refState.images.forEach((item, index) => {
            const card = d.createElement('div');
            card.className = 'subview-thumb-card' + (index === refState.currentIndex ? ' active' : '');
            card.title = `${item.name}\nHinzugefügt: ${new Date(item.addedAt).toLocaleDateString()}`;

            let imgSrc = '';
            if (item.path) {
                imgSrc = 'file:///' + item.path.replace(/\\/g, '/');
            } else if (item.src) {
                imgSrc = item.src;
            }

            card.innerHTML = `
                <div class="subview-thumb-img-wrap">
                    <img src="${imgSrc}" class="subview-thumb-img" loading="lazy" alt="${item.name}">
                    <button class="subview-thumb-del-btn" title="Dieses Bild löschen" onclick="event.stopPropagation(); window.deleteReferenceByIndex(${index});">✕</button>
                </div>
                <div class="subview-thumb-title">${item.name}</div>
            `;

            card.onclick = () => {
                refState.currentIndex = index;
                displayActiveReference(true);
                saveReferencesToStorage();
                const popup = d.getElementById('subviewThumbsPopup');
                if (popup) popup.classList.add('hidden');
            };

            grid.appendChild(card);
        });
    }

    /**
     * Löscht ein Referenzbild gezielt nach Index
     */
    function deleteReferenceByIndex(idx) {
        if (idx < 0 || idx >= refState.images.length) return;
        const item = refState.images[idx];

        if (fs && item.path && item.path.includes(path.join('media', 'references'))) {
            try {
                if (fs.existsSync(item.path)) fs.unlinkSync(item.path);
            } catch (e) {}
        }

        refState.images.splice(idx, 1);
        if (refState.currentIndex >= refState.images.length) {
            refState.currentIndex = refState.images.length - 1;
        }

        saveReferencesToStorage();
        displayActiveReference(true);
        renderThumbsPopupGrid();
    }

    /**
     * Alle Referenzen leeren (mit Bestätigung)
     */
    function clearAllReferencesPrompt() {
        if (!confirm('Möchtest du wirklich alle gespeicherten Referenzbilder löschen?')) {
            return;
        }

        if (fs) {
            refState.images.forEach(item => {
                if (item.path && item.path.includes(path.join('media', 'references'))) {
                    try {
                        if (fs.existsSync(item.path)) fs.unlinkSync(item.path);
                    } catch (e) {}
                }
            });
        }

        refState.images = [];
        refState.currentIndex = -1;
        saveReferencesToStorage();
        displayActiveReference(true);
        renderThumbsPopupGrid();
        showSubviewToast('Alle Referenzbilder wurden gelöscht.');
    }

    /**
     * Datei-Import Dialog triggern ("Ordner")
     */
    function triggerReferenceImport() {
        const d = getDoc();
        let input = d.getElementById('subviewFileInput');
        if (!input) {
            input = d.createElement('input');
            input.type = 'file';
            input.id = 'subviewFileInput';
            input.accept = 'image/*';
            input.multiple = true;
            input.style.display = 'none';
            input.onchange = handleReferenceFilesSelect;
            d.body.appendChild(input);
        }
        input.value = '';
        input.click();
    }

    /**
     * Verarbeitet ausgewählte Dateien (aus Dialog, Drag & Drop oder Clipboard)
     */
    function handleReferenceFilesSelect(e) {
        const files = e.target.files || (e.dataTransfer ? e.dataTransfer.files : []);
        if (!files || files.length === 0) return;
        addReferenceFiles(Array.from(files));
    }

    /**
     * Fügt Bilddateien zur persistenten Sammlung hinzu
     */
    function addReferenceFiles(fileList) {
        const validFiles = fileList.filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.name));
        if (validFiles.length === 0) {
            alert('Keine gültigen Bilddateien ausgewählt.');
            return;
        }

        const storageDir = getReferencesStorageDir();
        let importedCount = 0;

        validFiles.forEach((file) => {
            let sourcePath = file.path || '';
            if (!sourcePath && webUtils) {
                try {
                    sourcePath = webUtils.getPathForFile(file);
                } catch (err) {}
            }

            const refId = 'ref_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            let finalPath = '';

            // Datei in media/references kopieren falls Node.js fs verfügbar
            if (fs && storageDir) {
                try {
                    const ext = path.extname(file.name) || '.png';
                    const safeName = file.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
                    const targetFile = path.join(storageDir, `${refId}_${safeName}`);

                    if (sourcePath && fs.existsSync(sourcePath)) {
                        fs.copyFileSync(sourcePath, targetFile);
                        finalPath = targetFile;
                    } else {
                        // File via FileReader als Buffer schreiben
                        const reader = new FileReader();
                        reader.onload = (re) => {
                            try {
                                const buffer = Buffer.from(re.target.result);
                                fs.writeFileSync(targetFile, buffer);
                                insertReferenceEntry(refId, file.name, targetFile, '');
                            } catch (writeErr) {
                                console.error('Fehler beim Schreiben des Referenz-Puffers:', writeErr);
                            }
                        };
                        reader.readAsArrayBuffer(file);
                        return; // Asynchron handled
                    }
                } catch (fsErr) {
                    console.warn('Dateikopie fehlgeschlagen, verwende Pfad oder DataURL:', fsErr);
                    finalPath = sourcePath;
                }
            } else {
                finalPath = sourcePath;
            }

            if (finalPath) {
                insertReferenceEntry(refId, file.name, finalPath, '');
                importedCount++;
            } else {
                // Fallback via DataURL
                const reader = new FileReader();
                reader.onload = (re) => {
                    insertReferenceEntry(refId, file.name, '', re.target.result);
                };
                reader.readAsDataURL(file);
                importedCount++;
            }
        });

        if (importedCount > 0) {
            showSubviewToast(`${importedCount} Referenzbild(er) hinzugefügt!`);
        }
    }

    /**
     * Fügt einen Datensatz an den Anfang der Liste ein und aktiviert ihn
     */
    function insertReferenceEntry(id, name, filePath, dataUrl) {
        const newEntry = {
            id: id,
            name: name || 'Referenzbild',
            path: filePath || '',
            src: dataUrl || '',
            width: 0,
            height: 0,
            addedAt: Date.now()
        };

        // Kürzlich hinzugefügt: An erste Position setzen
        refState.images.unshift(newEntry);
        refState.currentIndex = 0;

        saveReferencesToStorage();
        displayActiveReference(true);
        renderThumbsPopupGrid();
    }

    /**
     * Kleines Toast-Feedback in der Unteransicht anzeigen
     */
    function showSubviewToast(msg) {
        const d = getDoc();
        let toast = d.getElementById('subviewToast');
        if (!toast) {
            toast = d.createElement('div');
            toast.id = 'subviewToast';
            toast.className = 'subview-toast';
            d.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.classList.remove('hidden');
        toast.classList.add('visible');

        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.classList.remove('visible');
            toast.classList.add('hidden');
        }, 2200);
    }

    /**
     * Bindet alle Maus-, Wheel-, Drag- und Touch-Events an den Viewport
     */
    function bindViewportEvents(targetDoc) {
        const viewport = targetDoc.getElementById('subviewViewport');
        if (!viewport || viewport._eventsBound) return;
        viewport._eventsBound = true;

        // --- MAUSRAD ZOOM (Zentriert auf Mauscursor) ---
        // "die ganz oben ist führ rein raus zoomen aber es soll auch für mausdrehen gehen"
        viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!refState.activeImage) return;

            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const zoomFactor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
            const oldZoom = refState.zoom;
            const newZoom = Math.max(0.05, Math.min(10.0, oldZoom * zoomFactor));

            if (newZoom !== oldZoom) {
                refState.isAtFitZoom = false;

                // Zoom zentriert auf die aktuelle Mausposition
                const vpCenterX = viewport.clientWidth / 2;
                const vpCenterY = viewport.clientHeight / 2;
                const ratio = newZoom / oldZoom;

                refState.panX = (refState.panX - (mouseX - vpCenterX)) * ratio + (mouseX - vpCenterX);
                refState.panY = (refState.panY - (mouseY - vpCenterY)) * ratio + (mouseY - vpCenterY);
                refState.zoom = newZoom;

                renderReferenceCanvas();
                updateControlsUI();
            }
        }, { passive: false });

        // --- POINTER DOWN (Pipette oder Verschieben) ---
        viewport.addEventListener('pointerdown', (e) => {
            if (!refState.activeImage) return;
            const rect = viewport.getBoundingClientRect();
            const vpX = e.clientX - rect.left;
            const vpY = e.clientY - rect.top;

            // Mittlere Maustaste oder Leertaste + Links: Immer Panning
            const isPanButton = e.button === 1 || (e.button === 0 && e.spaceKey);

            if (refState.isEyedropperActive && !isPanButton && e.button === 0) {
                // Farbe aufnehmen
                sampleColorFromReference(vpX, vpY, true);
                refState.isDragging = true;
                refState.isSampling = true;
                viewport.setPointerCapture(e.pointerId);
            } else if (e.button === 0 || e.button === 1) {
                // Bild verschieben (Pan)
                refState.isDragging = true;
                refState.isSampling = false;
                refState.dragStartX = e.clientX;
                refState.dragStartY = e.clientY;
                refState.startPanX = refState.panX;
                refState.startPanY = refState.panY;
                viewport.setPointerCapture(e.pointerId);
                viewport.style.cursor = 'grabbing';
            }
        });

        // --- POINTER MOVE (Live Pipette oder Pan Dragging) ---
        viewport.addEventListener('pointermove', (e) => {
            const rect = viewport.getBoundingClientRect();
            const vpX = e.clientX - rect.left;
            const vpY = e.clientY - rect.top;

            if (refState.isDragging) {
                if (refState.isSampling) {
                    // Fortlaufend sampeln beim Ziehen mit Pipette
                    sampleColorFromReference(vpX, vpY, true);
                } else {
                    // Panning
                    const dx = e.clientX - refState.dragStartX;
                    const dy = e.clientY - refState.dragStartY;
                    refState.panX = refState.startPanX + dx;
                    refState.panY = refState.startPanY + dy;
                    refState.isAtFitZoom = false;
                    renderReferenceCanvas();
                    updateControlsUI();
                }
            } else if (refState.isEyedropperActive) {
                // Vorschau-Farbe in Lupe anzeigen
                sampleColorFromReference(vpX, vpY, false);
            }
        });

        // --- POINTER UP / CANCEL ---
        const handlePointerUp = (e) => {
            if (refState.isDragging) {
                refState.isDragging = false;
                refState.isSampling = false;
                try {
                    viewport.releasePointerCapture(e.pointerId);
                } catch (err) {}
                updateControlsUI();
            }
        };
        viewport.addEventListener('pointerup', handlePointerUp);
        viewport.addEventListener('pointercancel', handlePointerUp);

        // --- MOUSE LEAVE (Farblupe ausblenden) ---
        viewport.addEventListener('pointerleave', () => {
            const loupe = targetDoc.getElementById('subviewLoupe');
            if (loupe) loupe.classList.add('hidden');
        });

        // --- DRAG & DROP BILDER HIER ABLEGEN ---
        viewport.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewport.classList.add('drag-over');
        });
        viewport.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewport.classList.remove('drag-over');
        });
        viewport.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewport.classList.remove('drag-over');
            handleReferenceFilesSelect(e);
        });

        // --- ZWISCHENABLAGE BILDER EINFÜGEN (Strg+V) ---
        viewport.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                    const blob = items[i].getAsFile();
                    if (blob) {
                        addReferenceFiles([blob]);
                        break;
                    }
                }
            }
        });

        // --- RESIZE OBSERVER FÜR RESPONSIBLE UNTERANSICHT ---
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => {
                if (refState.activeImage) {
                    if (refState.isAtFitZoom) {
                        fitReferenceToViewport();
                    } else {
                        renderReferenceCanvas();
                    }
                }
            });
            ro.observe(viewport);
        }
    }

    /**
     * Initialisiert die Unteransicht im Ziel-Dokument
     */
    function initReferenceViewer(targetDoc = document) {
        loadSavedReferences();
        bindViewportEvents(targetDoc);
        displayActiveReference(true);
    }

    /**
     * Spiegelt alle Funktionen und synchronisiert die Unteransicht mit dem Popout-Tablet-Fenster
     */
    window.syncReferenceViewerWithPopout = function (popoutWin) {
        if (!popoutWin || !popoutWin.document) return;
        const pDoc = popoutWin.document;

        // Funktionen an Popout-Fenster anbinden
        popoutWin.onReferenceZoomSlider = onReferenceZoomSlider;
        popoutWin.zoomReferenceStep = zoomReferenceStep;
        popoutWin.toggleReferenceFitOrActual = toggleReferenceFitOrActual;
        popoutWin.onReferenceRotateSlider = onReferenceRotateSlider;
        popoutWin.rotateReferenceStep = rotateReferenceStep;
        popoutWin.resetReferenceRotation = resetReferenceRotation;
        popoutWin.toggleReferenceFlipH = toggleReferenceFlipH;
        popoutWin.toggleReferenceFlipV = toggleReferenceFlipV;
        popoutWin.toggleReferenceEyedropper = toggleReferenceEyedropper;
        popoutWin.prevReferenceImage = prevReferenceImage;
        popoutWin.nextReferenceImage = nextReferenceImage;
        popoutWin.toggleReferenceThumbsPopup = toggleReferenceThumbsPopup;
        popoutWin.triggerReferenceImport = triggerReferenceImport;
        popoutWin.importReferenceToCanvas = importReferenceToCanvas;
        popoutWin.deleteCurrentReference = deleteCurrentReference;
        popoutWin.showReferenceInfo = showReferenceInfo;
        popoutWin.resetReferenceView = resetReferenceView;
        popoutWin.deleteReferenceByIndex = deleteReferenceByIndex;
        popoutWin.clearAllReferencesPrompt = clearAllReferencesPrompt;
        popoutWin.handleReferenceFilesSelect = handleReferenceFilesSelect;

        // Viewport-Events im Popout Dokument neu binden
        bindViewportEvents(pDoc);
        setTimeout(() => {
            displayActiveReference(true);
            updateControlsUI();
        }, 100);
    };

    /**
     * Öffnet oder schließt das Unteransicht-Panel
     */
    window.toggleReferencePanel = function () {
        if (typeof window.toggleWindowPanel === 'function') {
            window.toggleWindowPanel('referencePanel');
            return;
        }
        const d = getDoc();
        const panel = d.getElementById('referencePanel');
        if (!panel) return;

        if (panel.style.display === 'none' || panel.classList.contains('hidden')) {
            panel.classList.remove('hidden');
            panel.style.setProperty('display', 'flex', 'important');
        } else {
            panel.classList.add('hidden');
            panel.style.setProperty('display', 'none', 'important');
        }

        if (typeof window.updateWindowMenuCheckmarks === 'function') {
            window.updateWindowMenuCheckmarks();
        }
        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    };

    // Globale Exporte an window
    window.onReferenceZoomSlider = onReferenceZoomSlider;
    window.zoomReferenceStep = zoomReferenceStep;
    window.toggleReferenceFitOrActual = toggleReferenceFitOrActual;
    window.onReferenceRotateSlider = onReferenceRotateSlider;
    window.rotateReferenceStep = rotateReferenceStep;
    window.resetReferenceRotation = resetReferenceRotation;
    window.toggleReferenceFlipH = toggleReferenceFlipH;
    window.toggleReferenceFlipV = toggleReferenceFlipV;
    window.toggleReferenceEyedropper = toggleReferenceEyedropper;
    window.prevReferenceImage = prevReferenceImage;
    window.nextReferenceImage = nextReferenceImage;
    window.toggleReferenceThumbsPopup = toggleReferenceThumbsPopup;
    window.triggerReferenceImport = triggerReferenceImport;
    window.importReferenceToCanvas = importReferenceToCanvas;
    window.deleteCurrentReference = deleteCurrentReference;
    window.showReferenceInfo = showReferenceInfo;
    window.resetReferenceView = resetReferenceView;
    window.deleteReferenceByIndex = deleteReferenceByIndex;
    window.clearAllReferencesPrompt = clearAllReferencesPrompt;
    window.handleReferenceFilesSelect = handleReferenceFilesSelect;
    window.initReferenceViewer = initReferenceViewer;
    window.renderReferenceCanvas = renderReferenceCanvas;

    // Automatischer Start beim Laden des Hauptfensters
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initReferenceViewer(document));
    } else {
        setTimeout(() => initReferenceViewer(document), 50);
    }

})();
