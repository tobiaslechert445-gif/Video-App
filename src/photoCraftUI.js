/**
 * PhotoCraft UI Controller - Native C++ Image Adjustments & Filter Studio
 * Für Antigravity Media Player / Drawing App
 * 
 * Bietet professionelle Bildanpassungen und Filter aus PhotoCraft,
 * angetrieben durch den multithreaded SSE2/AVX C++ Kern.
 */

(function () {
    'use strict';

    // Tool-Definitionen
    const PHOTOCRAFT_TOOLS = {
        adjust: [
            {
                id: 'brightnessContrast',
                name: 'Helligkeit & Kontrast',
                icon: '☀️',
                desc: 'Steuert die Helligkeit und den linearen Kontrast auf nativer C++ Pixelebene.',
                params: [
                    { id: 'brightness', label: 'Helligkeit', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'contrast', label: 'Kontrast', min: -100, max: 100, step: 1, default: 0 }
                ]
            },
            {
                id: 'vibrance',
                name: 'Dynamik (Vibrance)',
                icon: '🎨',
                desc: 'Verstärkt selektiv gering gesättigte Farben, ohne Hauttöne zu übersteuern.',
                params: [
                    { id: 'vibrance', label: 'Dynamik', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'saturation', label: 'Sättigung', min: -100, max: 100, step: 1, default: 0 }
                ]
            },
            {
                id: 'hueSaturation',
                name: 'Farbton / Sättigung',
                icon: '🌈',
                desc: 'Vollständige HSL-Farbrotation, Sättigung und Helligkeitsverschiebung.',
                params: [
                    { id: 'hue', label: 'Farbton (Hue)', min: -180, max: 180, step: 1, default: 0, unit: '°' },
                    { id: 'saturation', label: 'Sättigung', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'lightness', label: 'Helligkeit', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'colorize', label: 'Monochrom einfärben (Colorize)', type: 'checkbox', default: false }
                ]
            },
            {
                id: 'exposure',
                name: 'Belichtung',
                icon: '💡',
                desc: 'Simuliert fotografische Belichtungsstufen (EV), Versatz und Gammakorrektur.',
                params: [
                    { id: 'exposure', label: 'Belichtung (EV)', min: -5.0, max: 5.0, step: 0.1, default: 0 },
                    { id: 'offset', label: 'Versatz (Offset)', min: -0.5, max: 0.5, step: 0.01, default: 0 },
                    { id: 'gamma', label: 'Gammakorrektur', min: 0.2, max: 5.0, step: 0.05, default: 1.0 }
                ]
            },
            {
                id: 'levels',
                name: 'Tonwertkorrektur (Levels)',
                icon: '📊',
                desc: 'Präzise Tonwertspreizung für Tiefen, Mitteltöne (Gamma) und Lichter inklusive Histogramm.',
                hasHistogram: true,
                params: [
                    { id: 'channel', label: 'Kanal', type: 'select', options: [
                        { value: 0, text: 'RGB (Gesamt)' },
                        { value: 1, text: 'Rot-Kanal' },
                        { value: 2, text: 'Grün-Kanal' },
                        { value: 3, text: 'Blau-Kanal' }
                    ], default: 0 },
                    { id: 'inBlack', label: 'Eingabe Tiefen (Schwarz)', min: 0, max: 254, step: 1, default: 0 },
                    { id: 'gamma', label: 'Mitteltöne (Gamma)', min: 0.1, max: 5.0, step: 0.02, default: 1.0 },
                    { id: 'inWhite', label: 'Eingabe Lichter (Weiß)', min: 1, max: 255, step: 1, default: 255 },
                    { id: 'outBlack', label: 'Ausgabe Tiefen', min: 0, max: 255, step: 1, default: 0 },
                    { id: 'outWhite', label: 'Ausgabe Lichter', min: 0, max: 255, step: 1, default: 255 }
                ]
            },
            {
                id: 'blackWhite',
                name: 'Schwarz & Weiß Studio',
                icon: '⚪',
                desc: 'Professionelle Schwarz-Weiß-Konvertierung mit 6 separaten Farbkanälen und Tönung.',
                params: [
                    { id: 'reds', label: 'Rote Töne', min: -200, max: 300, step: 1, default: 40 },
                    { id: 'yellows', label: 'Gelbe Töne', min: -200, max: 300, step: 1, default: 60 },
                    { id: 'greens', label: 'Grüne Töne', min: -200, max: 300, step: 1, default: 40 },
                    { id: 'cyans', label: 'Cyan Töne', min: -200, max: 300, step: 1, default: 60 },
                    { id: 'blues', label: 'Blaue Töne', min: -200, max: 300, step: 1, default: 20 },
                    { id: 'magentas', label: 'Magenta Töne', min: -200, max: 300, step: 1, default: 80 },
                    { id: 'tint', label: 'Farbtönung aktivieren', type: 'checkbox', default: false },
                    { id: 'tintHue', label: 'Tönungs-Farbton', min: 0, max: 360, step: 1, default: 30, unit: '°' },
                    { id: 'tintSat', label: 'Tönungs-Sättigung', min: 0, max: 100, step: 1, default: 25, unit: '%' }
                ]
            },
            {
                id: 'photoFilter',
                name: 'Fotofilter',
                icon: '📷',
                desc: 'Simuliert optische Kamerafilter (Warmfilter, Kaltfilter oder Wunschfarbe).',
                params: [
                    { id: 'color', label: 'Filterfarbe', type: 'color', default: '#ec8a00', presets: [
                        { name: 'Warm (85)', color: '#ec8a00' },
                        { name: 'Warm (81)', color: '#e3a936' },
                        { name: 'Kalt (80)', color: '#0072d6' },
                        { name: 'Kalt (82)', color: '#00b4d8' },
                        { name: 'Sepia', color: '#b5651d' },
                        { name: 'Smaragd', color: '#2ec4b6' },
                        { name: 'Rubin', color: '#e63946' }
                    ] },
                    { id: 'density', label: 'Filterdichte', min: 1, max: 100, step: 1, default: 25, unit: '%' },
                    { id: 'preserveLum', label: 'Luminanz erhalten', type: 'checkbox', default: true }
                ]
            },
            {
                id: 'colorBalance',
                name: 'Farbbalance',
                icon: '⚖️',
                desc: 'Farbverschiebungen getrennt in Tiefen, Mitteltönen und Lichtern korrigieren.',
                params: [
                    { id: 'toneRange', label: 'Tonwertbereich', type: 'select', options: [
                        { value: 'midtones', text: 'Mitteltöne' },
                        { value: 'shadows', text: 'Tiefen (Schatten)' },
                        { value: 'highlights', text: 'Lichter' }
                    ], default: 'midtones' },
                    { id: 'cyanRed', label: 'Cyan <-> Rot', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'magentaGreen', label: 'Magenta <-> Grün', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'yellowBlue', label: 'Gelb <-> Blau', min: -100, max: 100, step: 1, default: 0 },
                    { id: 'preserveLum', label: 'Helligkeit beibehalten', type: 'checkbox', default: true }
                ]
            },
            {
                id: 'curves',
                name: 'Gradationskurven',
                icon: '📈',
                desc: 'Monotone Fritsch-Carlson Spline-Interpolation für stufenlose Kontrast- und Dynamikprofile.',
                params: [
                    { id: 'channel', label: 'Kanal', type: 'select', options: [
                        { value: 0, text: 'RGB (Gesamt)' },
                        { value: 1, text: 'Rot' },
                        { value: 2, text: 'Grün' },
                        { value: 3, text: 'Blau' }
                    ], default: 0 },
                    { id: 'preset', label: 'Kurven-Profil', type: 'select', options: [
                        { value: 'linear', text: 'Linear (Standard)' },
                        { value: 's_curve', text: 'Kontrast steigern (S-Kurve)' },
                        { value: 'high_contrast', text: 'Starker Kontrast' },
                        { value: 'lighter', text: 'Heller' },
                        { value: 'darker', text: 'Dunkler' },
                        { value: 'invert', text: 'Negativ-Kurve' }
                    ], default: 'linear' }
                ]
            },
            {
                id: 'posterize',
                name: 'Posterisieren',
                icon: '🎴',
                desc: 'Reduziert Farbstufen für grafische Pop-Art- und Comic-Looks.',
                params: [
                    { id: 'levels', label: 'Tonwertstufen', min: 2, max: 32, step: 1, default: 4 }
                ]
            },
            {
                id: 'threshold',
                name: 'Schwellenwert (B/W)',
                icon: '⬛',
                desc: 'Harte Binarisierung in reine Schwarz- und Weißflächen.',
                params: [
                    { id: 'level', label: 'Schwellenwert', min: 1, max: 254, step: 1, default: 128 }
                ]
            },
            {
                id: 'autoContrast',
                name: 'Automatischer Kontrast',
                icon: '✨',
                desc: 'Spreizt die Tonwerte automatisch für optimalen Kontrast.',
                params: [
                    { id: 'clipPercent', label: 'Clipping-Toleranz', min: 0.1, max: 5.0, step: 0.1, default: 0.5, unit: '%' }
                ]
            },
            {
                id: 'invert',
                name: 'Invertieren',
                icon: '🔄',
                desc: 'Kehrt alle Farbkanäle der Ebene sofort um (Negativ).',
                params: []
            },
            {
                id: 'desaturate',
                name: 'Entsättigen',
                icon: '🌫️',
                desc: 'Wandelt das Bild direkt in natürliche Graustufen um.',
                params: []
            },
            {
                id: 'equalize',
                name: 'Histogramm-Angleichung',
                icon: '📐',
                desc: 'Gleicht die Tonwerte gleichmäßig über das gesamte Spektrum aus.',
                params: []
            }
        ],
        filter: [
            {
                id: 'gaussianBlur',
                name: 'Gaußscher Weichzeichner',
                icon: '💧',
                desc: 'Schneller 3-Pass Gaußscher Weichzeichnungsfilter im Multithreaded C++ Kern.',
                params: [
                    { id: 'radius', label: 'Radius', min: 1, max: 80, step: 1, default: 8, unit: 'px' }
                ]
            },
            {
                id: 'motionBlur',
                name: 'Bewegungsunschärfe (Motion Blur)',
                icon: '💨',
                desc: 'Simuliert dynamische Bewegung entlang eines frei wählbaren Winkels.',
                params: [
                    { id: 'angle', label: 'Winkel', min: 0, max: 360, step: 1, default: 0, unit: '°' },
                    { id: 'distance', label: 'Distanz', min: 1, max: 100, step: 1, default: 15, unit: 'px' }
                ]
            },
            {
                id: 'radialBlur',
                name: 'Radialer Zoom-Blur',
                icon: '🎯',
                desc: 'Erzeugt einen dynamischen Fokus- und Zoomeffekt aus der Bildmitte.',
                params: [
                    { id: 'amount', label: 'Zoom-Stärke', min: 0.02, max: 0.80, step: 0.02, default: 0.15 }
                ]
            },
            {
                id: 'twirl',
                name: 'Strudel / Wirbel (Twirl)',
                icon: '🌀',
                desc: 'Verdreht Bildpixel spiralförmig um das Zentrum.',
                params: [
                    { id: 'angle', label: 'Drehwinkel', min: -360, max: 360, step: 5, default: 90, unit: '°' },
                    { id: 'radius', label: 'Effektradius', min: 20, max: 600, step: 10, default: 200, unit: 'px' }
                ]
            },
            {
                id: 'ripple',
                name: 'Kräuseln / Wellen (Ripple)',
                icon: '🌊',
                desc: 'Erzeugt organische Wasserwellenverzerrungen.',
                params: [
                    { id: 'amplitude', label: 'Wellenhöhe (Amplitude)', min: 1, max: 50, step: 1, default: 10, unit: 'px' },
                    { id: 'wavelength', label: 'Wellenlänge', min: 10, max: 200, step: 2, default: 50, unit: 'px' }
                ]
            },
            {
                id: 'pixelate',
                name: 'Mosaik / Pixelate',
                icon: '🧱',
                desc: 'Rastert das Bild in stylische Retro-Mosaikblöcke auf.',
                params: [
                    { id: 'cellSize', label: 'Pixelblock-Größe', min: 2, max: 80, step: 1, default: 10, unit: 'px' }
                ]
            },
            {
                id: 'oilPaint',
                name: 'Ölgemälde (Oil Paint)',
                icon: '🖌️',
                desc: 'Malerischer Kuwahara-Filter für organische Pinselstriche und Ölfarben-Optik.',
                params: [
                    { id: 'radius', label: 'Pinselradius', min: 1, max: 12, step: 1, default: 4, unit: 'px' },
                    { id: 'levels', label: 'Intensitätsstufen', min: 4, max: 40, step: 1, default: 20 }
                ]
            },
            {
                id: 'highPass',
                name: 'Hochpass (High Pass)',
                icon: '🏔️',
                desc: 'Extrahiert feine Hochfrequenzdetails und Kanten (ideal zum Nachschärfen).',
                params: [
                    { id: 'radius', label: 'Radius', min: 1, max: 50, step: 1, default: 10, unit: 'px' }
                ]
            },
            {
                id: 'findEdges',
                name: 'Kanten finden (Sobel)',
                icon: '⚡',
                desc: 'Mathematische Sobel-Kantenerkennung zur Freistellung aller Konturen.',
                params: []
            }
        ]
    };

    // Interner State
    let pcActiveTab = 'adjust';
    let pcActiveTool = 'brightnessContrast';
    let pcLivePreview = true;
    let pcOriginalCanvas = null;
    let pcTargetLayer = null;
    let pcPreviewRaf = null;
    let pcToolParams = {};

    // Farbbalance Hilfszustand
    let pcColorBalanceState = {
        shadows: [0, 0, 0],
        midtones: [0, 0, 0],
        highlights: [0, 0, 0]
    };

    /**
     * DOM-Element Helfer: Unterstützt sowohl Hauptfenster als auch Zeichentablett-Popout-Fenster
     */
    function getPcElement(id) {
        if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
            try {
                const el = window.popoutEditorWindow.document.getElementById(id);
                if (el) return el;
            } catch (e) {}
        }
        return document.getElementById(id);
    }

    /**
     * Ermittelt Standardparameter für ein Tool
     */
    function getDefaultParams(tool) {
        const res = {};
        if (!tool || !tool.params) return res;
        tool.params.forEach(p => {
            if (p.default !== undefined) {
                res[p.id] = p.default;
            } else if (p.type === 'checkbox') {
                res[p.id] = false;
            } else {
                res[p.id] = 0;
            }
        });
        return res;
    }

    /**
     * Holt oder initialisiert Parameter für ein Tool
     */
    function getToolParams(toolId) {
        if (!pcToolParams[toolId]) {
            const list = [...PHOTOCRAFT_TOOLS.adjust, ...PHOTOCRAFT_TOOLS.filter];
            const tool = list.find(t => t.id === toolId);
            pcToolParams[toolId] = getDefaultParams(tool);
        }
        return pcToolParams[toolId];
    }

    /**
     * Öffnet das PhotoCraft C++ Studio Modal
     */
    function openPhotoCraftModal() {
        // Ziel-Ebene bestimmen mit robusten Fallbacks
        let layer = (typeof window.getActiveLayer === 'function' ? window.getActiveLayer() : null);
        if (!layer) {
            const layerId = (typeof window.contextLayerId !== 'undefined' && window.contextLayerId) ? window.contextLayerId : window.activeLayerId;
            const allLayers = window.layers || (typeof layers !== 'undefined' ? layers : null);
            if (allLayers && allLayers.length > 0) {
                layer = (layerId ? allLayers.find(l => l.id === layerId) : null) || allLayers[0];
            }
        }
        if (!layer && typeof getActiveLayer === 'function') {
            layer = getActiveLayer();
        }

        if (!layer) {
            alert('Bitte wähle zuerst eine Ebene im Ebenenbedienfeld aus.');
            return;
        }

        if (layer.locked) {
            alert('Diese Ebene ist gesperrt. Bitte entsperre sie vor der Bearbeitung.');
            return;
        }

        if (typeof window.setActiveLayer === 'function' && layer.id) {
            window.setActiveLayer(layer.id);
        }
        window.activeLayerId = layer.id;

        pcTargetLayer = layer;

        // Context-Menü ausblenden, falls offen
        const ctxMenu = getPcElement('layerContextMenu');
        if (ctxMenu) ctxMenu.classList.add('hidden');

        // Backup der Ebenenpixel anlegen
        pcOriginalCanvas = document.createElement('canvas');
        pcOriginalCanvas.width = layer.canvas.width;
        pcOriginalCanvas.height = layer.canvas.height;
        const bCtx = pcOriginalCanvas.getContext('2d');
        bCtx.drawImage(layer.canvas, 0, 0);

        // Standard-Tab & Tool zurücksetzen
        pcActiveTab = 'adjust';
        pcActiveTool = 'brightnessContrast';

        // Modal anzeigen
        const modal = getPcElement('photocraftModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
        }

        // Vorschau-Checkbox synchronisieren
        const previewCheck = getPcElement('pcLivePreviewCheck');
        if (previewCheck) {
            previewCheck.checked = pcLivePreview;
        }

        // Tab-Buttons aktualisieren & UI aufbauen
        updateTabButtons();
        renderToolList();
        renderToolControls();

        // Initiale Vorschau anwenden
        schedulePhotoCraftPreview();
    }

    /**
     * Schließt das PhotoCraft Modal und stellt die Originalpixel wieder her
     */
    function closePhotoCraftModal() {
        if (pcTargetLayer && pcOriginalCanvas) {
            // Restore Original
            pcTargetLayer.ctx.clearRect(0, 0, pcTargetLayer.canvas.width, pcTargetLayer.canvas.height);
            pcTargetLayer.ctx.drawImage(pcOriginalCanvas, 0, 0);
            if (typeof window.renderMainCanvas === 'function') {
                window.renderMainCanvas();
            }
        }

        pcOriginalCanvas = null;
        pcTargetLayer = null;

        const modal = getPcElement('photocraftModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }
    }

    /**
     * Wechselt zwischen Bildkorrekturen (adjust) und Filtern (filter)
     */
    function switchPhotoCraftTab(tab) {
        if (pcActiveTab === tab) return;
        pcActiveTab = tab;

        // Erstes Tool des neuen Tabs als aktiv setzen
        const tools = PHOTOCRAFT_TOOLS[tab];
        if (tools && tools.length > 0) {
            pcActiveTool = tools[0].id;
        }

        updateTabButtons();
        renderToolList();
        renderToolControls();

        schedulePhotoCraftPreview();
    }

    /**
     * Aktualisiert die Tab-Button-Klassen
     */
    function updateTabButtons() {
        const btnAdjust = getPcElement('pcTabAdjust');
        const btnFilter = getPcElement('pcTabFilter');

        if (btnAdjust) {
            if (pcActiveTab === 'adjust') {
                btnAdjust.classList.add('active');
                btnAdjust.style.background = 'var(--accent)';
                btnAdjust.style.color = '#000';
                btnAdjust.style.fontWeight = 'bold';
            } else {
                btnAdjust.classList.remove('active');
                btnAdjust.style.background = '#282828';
                btnAdjust.style.color = '#ccc';
                btnAdjust.style.fontWeight = 'normal';
            }
        }

        if (btnFilter) {
            if (pcActiveTab === 'filter') {
                btnFilter.classList.add('active');
                btnFilter.style.background = 'var(--accent)';
                btnFilter.style.color = '#000';
                btnFilter.style.fontWeight = 'bold';
            } else {
                btnFilter.classList.remove('active');
                btnFilter.style.background = '#282828';
                btnFilter.style.color = '#ccc';
                btnFilter.style.fontWeight = 'normal';
            }
        }
    }

    /**
     * Rendert die vertikale Werkzeugliste auf der linken Seite
     */
    function renderToolList() {
        const listContainer = getPcElement('pcToolList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        const tools = PHOTOCRAFT_TOOLS[pcActiveTab] || [];

        tools.forEach(tool => {
            const btn = document.createElement('button');
            const isActive = tool.id === pcActiveTool;

            btn.style.cssText = `
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 12px;
                border-radius: 8px;
                border: 1px solid ${isActive ? 'var(--accent)' : '#2e2e2e'};
                background: ${isActive ? 'rgba(29, 185, 84, 0.18)' : '#1e1e1e'};
                color: ${isActive ? '#fff' : '#bbb'};
                cursor: pointer;
                text-align: left;
                font-size: 13px;
                font-weight: ${isActive ? '600' : 'normal'};
                transition: all 0.15s ease;
            `;

            btn.onmouseover = () => {
                if (tool.id !== pcActiveTool) {
                    btn.style.background = '#282828';
                    btn.style.color = '#fff';
                }
            };
            btn.onmouseout = () => {
                if (tool.id !== pcActiveTool) {
                    btn.style.background = '#1e1e1e';
                    btn.style.color = '#bbb';
                }
            };

            btn.onclick = () => {
                selectPhotoCraftTool(tool.id);
            };

            btn.innerHTML = `
                <span style="font-size: 16px; flex-shrink: 0;">${tool.icon}</span>
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${tool.name}</span>
            `;

            listContainer.appendChild(btn);
        });
    }

    /**
     * Wählt ein Werkzeug aus und baut die Regler neu auf
     */
    function selectPhotoCraftTool(toolId) {
        pcActiveTool = toolId;
        renderToolList();
        renderToolControls();
        schedulePhotoCraftPreview();
    }

    /**
     * Rendert die Regler und Einstellungen des aktiven Werkzeugs
     */
    function renderToolControls() {
        const panel = getPcElement('pcControlsPanel');
        if (!panel) return;

        panel.innerHTML = '';

        const allTools = [...PHOTOCRAFT_TOOLS.adjust, ...PHOTOCRAFT_TOOLS.filter];
        const currentTool = allTools.find(t => t.id === pcActiveTool);
        if (!currentTool) return;

        const params = getToolParams(pcActiveTool);

        // Header mit Titel, Beschreibung & C++ Badge
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'border-bottom: 1px solid #333; padding-bottom: 14px; margin-bottom: 6px;';
        headerDiv.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 20px;">${currentTool.icon}</span>
                    <h4 style="margin: 0; font-size: 16px; color: #fff; font-weight: bold;">${currentTool.name}</h4>
                </div>
                <div style="background: rgba(29, 185, 84, 0.15); border: 1px solid var(--accent); color: var(--accent); font-size: 10px; font-weight: bold; padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px;">
                    C++ NATIVE TURBO
                </div>
            </div>
            <p style="margin: 0; font-size: 12px; color: #999; line-height: 1.5;">${currentTool.desc}</p>
        `;
        panel.appendChild(headerDiv);

        // Falls Tool ein Histogramm unterstützt (z.B. Levels), zeichne Histogramm-Canvas
        if (currentTool.hasHistogram && window.BrushEngine) {
            const histContainer = document.createElement('div');
            histContainer.style.cssText = 'background: #111; border: 1px solid #333; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px;';
            histContainer.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa;">
                    <span>Echtzeit-Histogramm (RGB & Luminanz)</span>
                    <span style="color: var(--accent); font-weight: bold;">C++ 1024-Bin</span>
                </div>
                <canvas id="pcHistogramCanvas" width="256" height="64" style="width: 100%; height: 64px; background: #0a0a0a; border-radius: 4px;"></canvas>
            `;
            panel.appendChild(histContainer);

            // Histogramm rendern
            setTimeout(() => {
                drawHistogramPreview();
            }, 20);
        }

        // Falls Tool keine Parameter hat (Ein-Klick-Effekte wie Invertieren, Entsättigen, Sobel)
        if (!currentTool.params || currentTool.params.length === 0) {
            const oneClickNotice = document.createElement('div');
            oneClickNotice.style.cssText = 'background: #232323; border: 1px solid #383838; border-radius: 8px; padding: 24px; text-align: center; color: #ddd; margin: 20px 0;';
            oneClickNotice.innerHTML = `
                <div style="font-size: 32px; margin-bottom: 12px;">⚡</div>
                <div style="font-size: 14px; font-weight: bold; margin-bottom: 6px;">Sofortiger Ein-Klick-Effekt</div>
                <div style="font-size: 12px; color: #aaa; max-width: 420px; margin: 0 auto 16px auto; line-height: 1.5;">
                    Dieser Effekt wird bei aktivierter Vorschau sofort live auf der Ebene berechnet. Klicke auf "Anwenden", um ihn dauerhaft zu übernehmen.
                </div>
                <button onclick="window.resetPhotoCraftToolParams()" class="modalBtn" style="background: #333; color: #fff; border: 1px solid #555; padding: 6px 16px; border-radius: 6px; font-size: 12px; cursor: pointer;">
                    ↺ Effekt zurücksetzen
                </button>
            `;
            panel.appendChild(oneClickNotice);
            return;
        }

        // Farbbalance Spezialbehandlung (ToneRange Switchen)
        if (currentTool.id === 'colorBalance') {
            renderColorBalanceControls(panel, currentTool, params);
            return;
        }

        // Generische Parameter-Regler
        const controlsContainer = document.createElement('div');
        controlsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 14px;';

        currentTool.params.forEach(p => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; flex-direction: column; gap: 5px;';

            if (p.type === 'select') {
                row.innerHTML = `
                    <label style="font-size: 12px; color: #ccc; font-weight: 500;">${p.label}</label>
                    <select id="pcParam_${p.id}" style="background: #252525; border: 1px solid #444; color: #fff; padding: 7px 10px; border-radius: 6px; font-size: 12px; outline: none; cursor: pointer;">
                        ${p.options.map(opt => `<option value="${opt.value}" ${params[p.id] == opt.value ? 'selected' : ''}>${opt.text}</option>`).join('')}
                    </select>
                `;
                const sel = row.querySelector('select');
                sel.onchange = (e) => {
                    const val = isNaN(e.target.value) ? e.target.value : Number(e.target.value);
                    onPhotoCraftParamChange(p.id, val);
                };
            } else if (p.type === 'checkbox') {
                row.innerHTML = `
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ddd; cursor: pointer; user-select: none; padding: 4px 0;">
                        <input type="checkbox" id="pcParam_${p.id}" ${params[p.id] ? 'checked' : ''} style="accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer;">
                        <span>${p.label}</span>
                    </label>
                `;
                const chk = row.querySelector('input');
                chk.onchange = (e) => {
                    onPhotoCraftParamChange(p.id, e.target.checked);
                };
            } else if (p.type === 'color') {
                const currentColor = params[p.id] || p.default || '#ec8a00';
                let presetHtml = '';
                if (p.presets) {
                    presetHtml = `
                        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
                            ${p.presets.map(prs => `
                                <button type="button" title="${prs.name}" onclick="window.onPhotoCraftParamChange('${p.id}', '${prs.color}')" style="background: ${prs.color}; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; padding: 3px 8px; font-size: 10px; color: #fff; text-shadow: 0 1px 2px #000; cursor: pointer;">
                                    ${prs.name}
                                </button>
                            `).join('')}
                        </div>
                    `;
                }

                row.innerHTML = `
                    <label style="font-size: 12px; color: #ccc; font-weight: 500;">${p.label}</label>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <input type="color" id="pcParam_${p.id}" value="${currentColor}" style="background: none; border: 1px solid #444; border-radius: 6px; width: 44px; height: 32px; cursor: pointer; padding: 0;">
                        <span id="pcVal_${p.id}" style="font-family: monospace; font-size: 12px; color: #aaa;">${currentColor}</span>
                    </div>
                    ${presetHtml}
                `;
                const colInput = row.querySelector('input[type="color"]');
                colInput.oninput = (e) => {
                    onPhotoCraftParamChange(p.id, e.target.value);
                    const label = row.querySelector(`#pcVal_${p.id}`);
                    if (label) label.textContent = e.target.value;
                };
            } else {
                // Range Slider
                const val = params[p.id] !== undefined ? params[p.id] : p.default;
                const unit = p.unit || '';
                const displayVal = (p.step < 1) ? Number(val).toFixed(2) : val;

                row.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #ccc;">
                        <span>${p.label}</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span id="pcVal_${p.id}" style="font-family: monospace; font-weight: bold; color: var(--accent); min-width: 45px; text-align: right;">${displayVal}${unit}</span>
                            <button type="button" title="Auf Standard (${p.default}${unit}) zurücksetzen" onclick="window.onPhotoCraftParamChange('${p.id}', ${p.default})" style="background: none; border: none; color: #666; cursor: pointer; padding: 0 2px; font-size: 11px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#666'">↺</button>
                        </div>
                    </div>
                    <input type="range" id="pcParam_${p.id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}" style="width: 100%; accent-color: var(--accent); cursor: pointer;">
                `;

                const slider = row.querySelector('input[type="range"]');
                slider.oninput = (e) => {
                    const numVal = Number(e.target.value);
                    onPhotoCraftParamChange(p.id, numVal);
                    const label = row.querySelector(`#pcVal_${p.id}`);
                    if (label) {
                        label.textContent = ((p.step < 1) ? numVal.toFixed(2) : numVal) + unit;
                    }
                };
            }

            controlsContainer.appendChild(row);
        });

        panel.appendChild(controlsContainer);

        // Reset Button am Ende
        const footerDiv = document.createElement('div');
        footerDiv.style.cssText = 'margin-top: 10px; padding-top: 10px; border-top: 1px solid #2a2a2a; display: flex; justify-content: flex-end;';
        footerDiv.innerHTML = `
            <button onclick="window.resetPhotoCraftToolParams()" class="modalBtn" style="background: #252525; color: #aaa; border: 1px solid #444; padding: 6px 14px; border-radius: 6px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 6px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#aaa'">
                <span>↺</span> Standardwerte wiederherstellen
            </button>
        `;
        panel.appendChild(footerDiv);
    }

    /**
     * Spezial-Renderer für Farbbalance (Shadows, Midtones, Highlights)
     */
    function renderColorBalanceControls(panel, tool, params) {
        const toneRange = params.toneRange || 'midtones';
        const rangeValues = pcColorBalanceState[toneRange] || [0, 0, 0];

        const container = document.createElement('div');
        container.style.cssText = 'display: flex; flex-direction: column; gap: 14px;';

        container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 5px;">
                <label style="font-size: 12px; color: #ccc; font-weight: 500;">Tonwertbereich auswählen</label>
                <div style="display: flex; gap: 6px;">
                    <button type="button" onclick="window.onPhotoCraftParamChange('toneRange', 'shadows')" class="pillBtn ${toneRange === 'shadows' ? 'active' : ''}" style="flex: 1; padding: 6px; font-size: 11px; background: ${toneRange === 'shadows' ? 'var(--accent)' : '#282828'}; color: ${toneRange === 'shadows' ? '#000' : '#ccc'}; font-weight: ${toneRange === 'shadows' ? 'bold' : 'normal'};">Tiefen (Schatten)</button>
                    <button type="button" onclick="window.onPhotoCraftParamChange('toneRange', 'midtones')" class="pillBtn ${toneRange === 'midtones' ? 'active' : ''}" style="flex: 1; padding: 6px; font-size: 11px; background: ${toneRange === 'midtones' ? 'var(--accent)' : '#282828'}; color: ${toneRange === 'midtones' ? '#000' : '#ccc'}; font-weight: ${toneRange === 'midtones' ? 'bold' : 'normal'};">Mitteltöne</button>
                    <button type="button" onclick="window.onPhotoCraftParamChange('toneRange', 'highlights')" class="pillBtn ${toneRange === 'highlights' ? 'active' : ''}" style="flex: 1; padding: 6px; font-size: 11px; background: ${toneRange === 'highlights' ? 'var(--accent)' : '#282828'}; color: ${toneRange === 'highlights' ? '#000' : '#ccc'}; font-weight: ${toneRange === 'highlights' ? 'bold' : 'normal'};">Lichter</button>
                </div>
            </div>

            <!-- Cyan / Rot Slider -->
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa;">
                    <span style="color: #00e5ff;">Cyan</span>
                    <span id="pcVal_cb_0" style="font-family: monospace; font-weight: bold; color: #fff;">${rangeValues[0]}</span>
                    <span style="color: #ff5252;">Rot</span>
                </div>
                <input type="range" id="pcSlider_cb_0" min="-100" max="100" step="1" value="${rangeValues[0]}" style="width: 100%; accent-color: #ff5252; cursor: pointer;">
            </div>

            <!-- Magenta / Grün Slider -->
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa;">
                    <span style="color: #e040fb;">Magenta</span>
                    <span id="pcVal_cb_1" style="font-family: monospace; font-weight: bold; color: #fff;">${rangeValues[1]}</span>
                    <span style="color: #69f0ae;">Grün</span>
                </div>
                <input type="range" id="pcSlider_cb_1" min="-100" max="100" step="1" value="${rangeValues[1]}" style="width: 100%; accent-color: #69f0ae; cursor: pointer;">
            </div>

            <!-- Gelb / Blau Slider -->
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa;">
                    <span style="color: #ffd740;">Gelb</span>
                    <span id="pcVal_cb_2" style="font-family: monospace; font-weight: bold; color: #fff;">${rangeValues[2]}</span>
                    <span style="color: #448aff;">Blau</span>
                </div>
                <input type="range" id="pcSlider_cb_2" min="-100" max="100" step="1" value="${rangeValues[2]}" style="width: 100%; accent-color: #448aff; cursor: pointer;">
            </div>

            <!-- Luminanz Checkbox -->
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ddd; cursor: pointer; user-select: none; margin-top: 6px;">
                <input type="checkbox" id="pcCbPreserveLum" ${params.preserveLum !== false ? 'checked' : ''} style="accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer;">
                <span>Helligkeit beibehalten (Luminanz bewahren)</span>
            </label>

            <!-- Reset Button -->
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #2a2a2a; display: flex; justify-content: flex-end;">
                <button type="button" onclick="window.resetPhotoCraftToolParams()" class="modalBtn" style="background: #252525; color: #aaa; border: 1px solid #444; padding: 6px 14px; border-radius: 6px; font-size: 11px; cursor: pointer;">
                    ↺ Farbbalance zurücksetzen
                </button>
            </div>
        `;

        panel.appendChild(container);

        // Event-Listener an die 3 Slider binden
        const s0 = container.querySelector('#pcSlider_cb_0');
        const s1 = container.querySelector('#pcSlider_cb_1');
        const s2 = container.querySelector('#pcSlider_cb_2');
        const chkLum = container.querySelector('#pcCbPreserveLum');

        const updateCb = () => {
            pcColorBalanceState[toneRange] = [Number(s0.value), Number(s1.value), Number(s2.value)];
            container.querySelector('#pcVal_cb_0').textContent = s0.value;
            container.querySelector('#pcVal_cb_1').textContent = s1.value;
            container.querySelector('#pcVal_cb_2').textContent = s2.value;
            schedulePhotoCraftPreview();
        };

        if (s0) s0.oninput = updateCb;
        if (s1) s1.oninput = updateCb;
        if (s2) s2.oninput = updateCb;
        if (chkLum) {
            chkLum.onchange = (e) => {
                params.preserveLum = e.target.checked;
                schedulePhotoCraftPreview();
            };
        }
    }

    /**
     * Parameteränderung registrieren
     */
    function onPhotoCraftParamChange(paramId, value) {
        const params = getToolParams(pcActiveTool);
        params[paramId] = value;

        // Falls wir ToneRange in ColorBalance geändert haben, Regler neu rendern
        if (pcActiveTool === 'colorBalance' && paramId === 'toneRange') {
            renderToolControls();
            return;
        }

        // Falls Preset in Curves geändert wurde
        if (pcActiveTool === 'curves' && paramId === 'preset') {
            schedulePhotoCraftPreview();
            return;
        }

        // Bei Farbänderung im PhotoFilter Label anpassen
        if (pcActiveTool === 'photoFilter' && paramId === 'color') {
            const hexLbl = getPcElement('pcVal_color');
            const colInp = getPcElement('pcParam_color');
            if (hexLbl) hexLbl.textContent = value;
            if (colInp) colInp.value = value;
        }

        schedulePhotoCraftPreview();
    }

    /**
     * Setzt die Parameter des aktuellen Werkzeugs auf Standardwerte zurück
     */
    function resetPhotoCraftToolParams() {
        const allTools = [...PHOTOCRAFT_TOOLS.adjust, ...PHOTOCRAFT_TOOLS.filter];
        const currentTool = allTools.find(t => t.id === pcActiveTool);
        if (!currentTool) return;

        if (pcActiveTool === 'colorBalance') {
            pcColorBalanceState = {
                shadows: [0, 0, 0],
                midtones: [0, 0, 0],
                highlights: [0, 0, 0]
            };
        }

        pcToolParams[pcActiveTool] = getDefaultParams(currentTool);
        renderToolControls();
        schedulePhotoCraftPreview();
    }

    /**
     * Schaltet die Live-Vorschau an oder aus
     */
    function togglePhotoCraftPreview(enabled) {
        pcLivePreview = !!enabled;
        schedulePhotoCraftPreview();
    }

    /**
     * Throttelt Vorschau-Berechnung über requestAnimationFrame
     */
    function schedulePhotoCraftPreview() {
        if (pcPreviewRaf) cancelAnimationFrame(pcPreviewRaf);
        pcPreviewRaf = requestAnimationFrame(() => {
            pcPreviewRaf = null;
            updatePhotoCraftPreview();
        });
    }

    /**
     * Führt die Vorschau auf der aktiven Ebene im C++ Kern aus
     */
    function updatePhotoCraftPreview() {
        if (!pcTargetLayer || !pcOriginalCanvas) return;

        const w = pcTargetLayer.canvas.width;
        const h = pcTargetLayer.canvas.height;
        const ctx = pcTargetLayer.ctx;

        // 1. Zuerst immer das unveränderte Backup auf die Ebene zeichnen
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(pcOriginalCanvas, 0, 0);

        // Wenn Vorschau ausgeschaltet ist, sind wir hier fertig
        if (!pcLivePreview) {
            if (typeof window.renderMainCanvas === 'function') {
                window.renderMainCanvas();
            }
            return;
        }

        // 2. Effekt im nativen C++ Kern berechnen
        applyCurrentToolToContext(ctx, w, h);

        // 3. Canvas-Compositor im Hauptfenster aktualisieren
        if (typeof window.renderMainCanvas === 'function') {
            window.renderMainCanvas();
        }

        // Falls Levels aktiv ist, Histogramm aktualisieren
        const histCanvas = getPcElement('pcHistogramCanvas');
        if (histCanvas) {
            drawHistogramPreview();
        }
    }

    /**
     * Wendet das aktive Tool mit den aktuellen Parametern auf einen 2D-Kontext an
     */
    function applyCurrentToolToContext(ctx, w, h) {
        if (!window.BrushEngine) return false;

        const params = getToolParams(pcActiveTool);

        if (pcActiveTab === 'adjust') {
            let options = {};

            switch (pcActiveTool) {
                case 'brightnessContrast':
                    options = {
                        brightness: params.brightness || 0,
                        contrast: params.contrast || 0
                    };
                    break;
                case 'vibrance':
                    options = {
                        vibrance: params.vibrance || 0,
                        saturation: params.saturation || 0
                    };
                    break;
                case 'hueSaturation':
                    options = {
                        hue: params.hue || 0,
                        saturation: params.saturation || 0,
                        lightness: params.lightness || 0,
                        colorize: !!params.colorize
                    };
                    break;
                case 'exposure':
                    options = {
                        exposure: params.exposure || 0,
                        offset: params.offset || 0,
                        gamma: params.gamma !== undefined ? params.gamma : 1.0
                    };
                    break;
                case 'levels':
                    options = {
                        channel: params.channel || 0,
                        inBlack: params.inBlack || 0,
                        inWhite: params.inWhite !== undefined ? params.inWhite : 255,
                        gamma: params.gamma !== undefined ? params.gamma : 1.0,
                        outBlack: params.outBlack || 0,
                        outWhite: params.outWhite !== undefined ? params.outWhite : 255
                    };
                    break;
                case 'blackWhite':
                    options = {
                        weights: [
                            params.reds !== undefined ? params.reds : 40,
                            params.yellows !== undefined ? params.yellows : 60,
                            params.greens !== undefined ? params.greens : 40,
                            params.cyans !== undefined ? params.cyans : 60,
                            params.blues !== undefined ? params.blues : 20,
                            params.magentas !== undefined ? params.magentas : 80
                        ],
                        tint: !!params.tint,
                        tintHue: params.tintHue || 30,
                        tintSat: params.tintSat !== undefined ? params.tintSat : 25
                    };
                    break;
                case 'photoFilter':
                    options = {
                        color: params.color || '#ec8a00',
                        density: params.density !== undefined ? params.density : 25,
                        preserveLum: params.preserveLum !== false
                    };
                    break;
                case 'colorBalance':
                    options = {
                        shadows: pcColorBalanceState.shadows || [0, 0, 0],
                        midtones: pcColorBalanceState.midtones || [0, 0, 0],
                        highlights: pcColorBalanceState.highlights || [0, 0, 0],
                        preserveLum: params.preserveLum !== false
                    };
                    break;
                case 'curves':
                    const preset = params.preset || 'linear';
                    let xs = [0, 255];
                    let ys = [0, 255];

                    if (preset === 's_curve') {
                        xs = [0, 64, 192, 255];
                        ys = [0, 48, 208, 255];
                    } else if (preset === 'high_contrast') {
                        xs = [0, 64, 128, 192, 255];
                        ys = [0, 32, 128, 224, 255];
                    } else if (preset === 'lighter') {
                        xs = [0, 128, 255];
                        ys = [0, 175, 255];
                    } else if (preset === 'darker') {
                        xs = [0, 128, 255];
                        ys = [0, 80, 255];
                    } else if (preset === 'invert') {
                        xs = [0, 255];
                        ys = [255, 0];
                    }

                    options = {
                        channel: params.channel || 0,
                        xs: xs,
                        ys: ys
                    };
                    break;
                case 'posterize':
                    options = { levels: params.levels || 4 };
                    break;
                case 'threshold':
                    options = { level: params.level !== undefined ? params.level : 128 };
                    break;
                case 'autoContrast':
                    options = { clipPercent: params.clipPercent || 0.5 };
                    break;
                case 'invert':
                case 'desaturate':
                case 'equalize':
                    options = {};
                    break;
            }

            return window.BrushEngine.applyPhotoCraftAdjustment(ctx, w, h, pcActiveTool, options);
        } else {
            // Filter Menu
            let options = {};

            switch (pcActiveTool) {
                case 'gaussianBlur':
                    options = { radius: params.radius || 8 };
                    break;
                case 'motionBlur':
                    options = {
                        angle: params.angle || 0,
                        distance: params.distance || 15
                    };
                    break;
                case 'radialBlur':
                    options = {
                        centerX: w / 2,
                        centerY: h / 2,
                        amount: params.amount || 0.15
                    };
                    break;
                case 'twirl':
                    options = {
                        centerX: w / 2,
                        centerY: h / 2,
                        radius: params.radius || Math.min(w, h) / 2,
                        angle: params.angle !== undefined ? params.angle : 90
                    };
                    break;
                case 'ripple':
                    options = {
                        amplitude: params.amplitude || 10,
                        wavelength: params.wavelength || 50
                    };
                    break;
                case 'pixelate':
                    options = { cellSize: params.cellSize || 10 };
                    break;
                case 'oilPaint':
                    options = {
                        radius: params.radius || 4,
                        levels: params.levels || 20
                    };
                    break;
                case 'highPass':
                    options = { radius: params.radius || 10 };
                    break;
                case 'findEdges':
                    options = {};
                    break;
            }

            return window.BrushEngine.applyPhotoCraftFilter(ctx, w, h, pcActiveTool, options);
        }
    }

    /**
     * Zeichnet das Live-Histogramm auf den Canvas
     */
    function drawHistogramPreview() {
        const histCanvas = getPcElement('pcHistogramCanvas');
        if (!histCanvas || !pcTargetLayer || !window.BrushEngine) return;

        const hist = window.BrushEngine.getCanvasHistogram(pcTargetLayer.ctx, pcTargetLayer.canvas.width, pcTargetLayer.canvas.height);
        if (!hist || hist.length < 1024) return;

        const hCtx = histCanvas.getContext('2d');
        const cw = histCanvas.width;
        const ch = histCanvas.height;

        hCtx.clearRect(0, 0, cw, ch);

        // Maxima für Skalierung finden
        let maxVal = 1;
        for (let i = 0; i < 256; i++) {
            const lum = hist[768 + i];
            if (lum > maxVal) maxVal = lum;
        }

        // Hintergrundraster
        hCtx.fillStyle = '#141414';
        hCtx.fillRect(0, 0, cw, ch);

        // Gitterlinien
        hCtx.strokeStyle = '#222';
        hCtx.lineWidth = 1;
        for (let x = 64; x < 256; x += 64) {
            hCtx.beginPath();
            hCtx.moveTo(x, 0);
            hCtx.lineTo(x, ch);
            hCtx.stroke();
        }

        // Kanäle zeichnen: Rot, Grün, Blau, Luminanz
        const drawChannel = (offset, color) => {
            hCtx.fillStyle = color;
            for (let i = 0; i < 256; i++) {
                const count = hist[offset + i];
                const barH = (count / maxVal) * (ch - 4);
                if (barH > 0) {
                    hCtx.fillRect(i, ch - barH, 1, barH);
                }
            }
        };

        // Überblendete RGB-Histogramme
        drawChannel(0, 'rgba(255, 60, 60, 0.35)');
        drawChannel(256, 'rgba(60, 255, 60, 0.35)');
        drawChannel(512, 'rgba(60, 160, 255, 0.35)');
        // Luminanz-Gipfel
        drawChannel(768, 'rgba(255, 255, 255, 0.5)');
    }

    /**
     * Wendet den Effekt endgültig an, speichert den Zustand im Undo-Stack und schließt das Modal
     */
    function applyPhotoCraftEffect() {
        if (!pcTargetLayer || !pcOriginalCanvas) {
            closePhotoCraftModal();
            return;
        }

        const w = pcTargetLayer.canvas.width;
        const h = pcTargetLayer.canvas.height;
        const ctx = pcTargetLayer.ctx;

        // Falls Live-Vorschau nicht aktiv war, jetzt auf die Ebene berechnen
        if (!pcLivePreview) {
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(pcOriginalCanvas, 0, 0);
            applyCurrentToolToContext(ctx, w, h);
        }

        // Text-Ebenen automatisch rastern
        if (pcTargetLayer.isTextLayer) {
            pcTargetLayer.isTextLayer = false;
            delete pcTargetLayer.textProps;
            delete pcTargetLayer.textContent;
            delete pcTargetLayer.textHTML;
            if (typeof window.renderLayersUI === 'function') {
                window.renderLayersUI();
            }
        }

        // Im History-Stack (Undo/Redo) sichern
        if (typeof window.saveLogoState === 'function') {
            window.saveLogoState();
        }

        if (typeof window.renderMainCanvas === 'function') {
            window.renderMainCanvas();
        }

        // Bereinigen & Schließen
        pcOriginalCanvas = null;
        pcTargetLayer = null;

        const modal = getPcElement('photocraftModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }

        console.log(`[PhotoCraft FX] Effekt '${pcActiveTool}' erfolgreich im C++ Kern berechnet & angewendet.`);
    }

    // Funktionen an das globale window-Objekt exportieren
    window.openPhotoCraftModal = openPhotoCraftModal;
    window.closePhotoCraftModal = closePhotoCraftModal;
    window.switchPhotoCraftTab = switchPhotoCraftTab;
    window.selectPhotoCraftTool = selectPhotoCraftTool;
    window.onPhotoCraftParamChange = onPhotoCraftParamChange;
    window.resetPhotoCraftToolParams = resetPhotoCraftToolParams;
    window.togglePhotoCraftPreview = togglePhotoCraftPreview;
    window.applyPhotoCraftEffect = applyPhotoCraftEffect;

    // Falls Popout-Fenster geöffnet wird, Funktionen auch dorthin spiegeln
    window.syncPhotoCraftWithPopout = function (popoutWin) {
        if (!popoutWin) return;
        popoutWin.openPhotoCraftModal = openPhotoCraftModal;
        popoutWin.closePhotoCraftModal = closePhotoCraftModal;
        popoutWin.switchPhotoCraftTab = switchPhotoCraftTab;
        popoutWin.selectPhotoCraftTool = selectPhotoCraftTool;
        popoutWin.onPhotoCraftParamChange = onPhotoCraftParamChange;
        popoutWin.resetPhotoCraftToolParams = resetPhotoCraftToolParams;
        popoutWin.togglePhotoCraftPreview = togglePhotoCraftPreview;
        popoutWin.applyPhotoCraftEffect = applyPhotoCraftEffect;
    };

})();
