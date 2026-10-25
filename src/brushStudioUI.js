/**
 * Photoshop Brush Studio & Custom Brush Creator UI
 * Für Antigravity Media Player / Drawing App
 * 
 * Bietet professionelle Pinselspitzen, Strichdynamik, Streuung,
 * eine Photoshop-Style Live Stroke Preview und Speicherung eigener Pinsel.
 */

(function () {
    'use strict';

    // 10 professionelle Standard-Pinsel (Photoshop Classics)
    const DEFAULT_PRESETS = [
        {
            id: 'soft_round',
            name: 'Standard Rund (Weich)',
            icon: '⚪',
            isDefault: true,
            desc: 'Butterweicher Rundpinsel für sanfte Übergänge und Schattierungen.',
            settings: {
                tipType: 'round',
                hardness: 0.15,
                spacing: 0.10,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 1.0,
                smoothing: 0.35,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: true
            }
        },
        {
            id: 'hard_round',
            name: 'Standard Rund (Hart)',
            icon: '⚫',
            isDefault: true,
            desc: 'Knackig scharfer Rundpinsel für präzise Konturen und Details.',
            settings: {
                tipType: 'round',
                hardness: 1.0,
                spacing: 0.08,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 1.0,
                smoothing: 0.35,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: false
            }
        },
        {
            id: 'manga_gpen',
            name: 'Manga Inker (G-Pen)',
            icon: '🖋️',
            isDefault: true,
            desc: 'Ultrascharfe Tuschfeder mit extremer Druck-Spitzung für Manga & Comics.',
            settings: {
                tipType: 'gpen',
                hardness: 1.0,
                spacing: 0.04,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 1.0,
                smoothing: 0.55,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: false
            }
        },
        {
            id: 'draft_pencil',
            name: 'Skizzen-Bleistift (2B)',
            icon: '✏️',
            isDefault: true,
            desc: 'Körnige Graphit-Textur mit natürlicher Papierkörnung zum Skizzieren.',
            settings: {
                tipType: 'pencil',
                hardness: 0.65,
                spacing: 0.14,
                roundness: 0.90,
                angle: 30,
                sizeJitter: 0.15,
                angleJitter: 0.05,
                scatter: 0.05,
                count: 1,
                flow: 0.9,
                smoothing: 0.25,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: true
            }
        },
        {
            id: 'chisel_calligraphy',
            name: 'Kalligraphie Meißel',
            icon: '✒️',
            isDefault: true,
            desc: 'Flache, gewinkelte Meißelspitze für elegante Schrift- und Bandzüge.',
            settings: {
                tipType: 'chisel',
                hardness: 0.95,
                spacing: 0.06,
                roundness: 0.25,
                angle: 45,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 1.0,
                smoothing: 0.45,
                wetEdge: false,
                pressureSize: false,
                pressureOpacity: false
            }
        },
        {
            id: 'oil_flat',
            name: 'Ölfarben Flachpinsel',
            icon: '🖌️',
            isDefault: true,
            desc: 'Mehrere feine Borstenfasern erzeugen echte malerische Ölstrich-Strukturen.',
            settings: {
                tipType: 'bristle',
                hardness: 0.75,
                spacing: 0.07,
                roundness: 0.40,
                angle: 0,
                sizeJitter: 0.05,
                angleJitter: 0.02,
                scatter: 0.0,
                count: 1,
                flow: 1.0,
                smoothing: 0.40,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: false
            }
        },
        {
            id: 'soft_airbrush',
            name: 'Weiche Sprüh-Airbrush',
            icon: '💨',
            isDefault: true,
            desc: 'Ultraweicher Farbnebel für sanfte Verläufe und Modellierung.',
            settings: {
                tipType: 'airbrush',
                hardness: 0.0,
                spacing: 0.22,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 0.35,
                smoothing: 0.30,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: true
            }
        },
        {
            id: 'chalk_charcoal',
            name: 'Kreide & Kohle',
            icon: '🧱',
            isDefault: true,
            desc: 'Raue, abgebrochene Kanten mit Kreidepartikeln und organischer Streuung.',
            settings: {
                tipType: 'charcoal',
                hardness: 0.70,
                spacing: 0.20,
                roundness: 0.85,
                angle: 15,
                sizeJitter: 0.20,
                angleJitter: 0.15,
                scatter: 0.10,
                count: 1,
                flow: 0.85,
                smoothing: 0.20,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: true
            }
        },
        {
            id: 'ink_splatter',
            name: 'Tintenspritzer (Splatter)',
            icon: '💥',
            isDefault: true,
            desc: 'Organische Tintenspritzer und Tropfen für Grunge- & Action-Painting.',
            settings: {
                tipType: 'splatter',
                hardness: 0.90,
                spacing: 0.55,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.40,
                angleJitter: 0.50,
                scatter: 1.20,
                count: 2,
                flow: 0.90,
                smoothing: 0.15,
                wetEdge: false,
                pressureSize: true,
                pressureOpacity: false
            }
        },
        {
            id: 'watercolor_wet',
            name: 'Aquarell Nassrand',
            icon: '🌊',
            isDefault: true,
            desc: 'Klassischer Nass-in-Nass Effekt mit typischer Randpigmentierung.',
            settings: {
                tipType: 'watercolor',
                hardness: 0.50,
                spacing: 0.10,
                roundness: 1.0,
                angle: 0,
                sizeJitter: 0.0,
                angleJitter: 0.0,
                scatter: 0.0,
                count: 1,
                flow: 0.65,
                smoothing: 0.35,
                wetEdge: true,
                pressureSize: true,
                pressureOpacity: true
            }
        }
    ];

    // Aktiver Preset State
    let activePresetId = 'hard_round';
    let previewRaf = null;

    /**
     * DOM-Element Helfer: Unterstützt Popout- und Hauptfenster
     */
    function getBsElement(id) {
        if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
            try {
                const el = window.popoutEditorWindow.document.getElementById(id);
                if (el) return el;
            } catch (e) {}
        }
        return document.getElementById(id);
    }

    /**
     * Lädt benutzerdefinierte Pinsel aus dem localStorage
     */
    function loadCustomPresets() {
        try {
            const raw = localStorage.getItem('customBrushPresets');
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return [];
    }

    /**
     * Speichert benutzerdefinierte Pinsel im localStorage
     */
    function saveCustomPresets(presets) {
        try {
            localStorage.setItem('customBrushPresets', JSON.stringify(presets));
        } catch (e) {}
    }

    /**
     * Gibt alle Presets (Default + Custom) zurück
     */
    function getAllPresets() {
        const custom = loadCustomPresets();
        return [...DEFAULT_PRESETS, ...custom];
    }

    /**
     * Öffnet das Photoshop Brush Studio Modal
     */
    function openBrushStudioModal() {
        const modal = getBsElement('brushStudioModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
        }

        renderPresetList();
        syncControlsFromEngine();
        updateStrokePreview();
    }

    /**
     * Schließt das Modal
     */
    function closeBrushStudioModal() {
        const modal = getBsElement('brushStudioModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }
    }

    /**
     * Schaltet das Brush Studio Modal um
     */
    function toggleBrushStudioModal() {
        const modal = getBsElement('brushStudioModal');
        if (!modal) return;
        if (modal.classList.contains('hidden')) {
            openBrushStudioModal();
        } else {
            closeBrushStudioModal();
        }
    }

    /**
     * Rendert die Liste aller Pinsel auf der linken Seite
     */
    function renderPresetList() {
        const listContainer = getBsElement('bsPresetList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        const presets = getAllPresets();

        presets.forEach(p => {
            const item = document.createElement('div');
            const isActive = p.id === activePresetId;

            item.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                border-radius: 8px;
                border: 1px solid ${isActive ? 'var(--accent)' : '#2e2e2e'};
                background: ${isActive ? 'rgba(29, 185, 84, 0.18)' : '#1e1e1e'};
                color: ${isActive ? '#fff' : '#ccc'};
                cursor: pointer;
                transition: all 0.15s ease;
                gap: 8px;
            `;

            item.onmouseover = () => {
                if (p.id !== activePresetId) {
                    item.style.background = '#282828';
                    item.style.color = '#fff';
                }
            };
            item.onmouseout = () => {
                if (p.id !== activePresetId) {
                    item.style.background = '#1e1e1e';
                    item.style.color = '#ccc';
                }
            };

            item.onclick = () => {
                applyBrushPreset(p.id);
            };

            const leftPart = `
                <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
                    <span style="font-size: 18px; flex-shrink: 0;">${p.icon || '🖌️'}</span>
                    <div style="display: flex; flex-direction: column; overflow: hidden;">
                        <span style="font-size: 12px; font-weight: ${isActive ? 'bold' : 'normal'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.name}</span>
                        ${!p.isDefault ? '<span style="font-size: 9px; color: var(--accent); font-weight: bold;">EIGENER PINSEL</span>' : ''}
                    </div>
                </div>
            `;

            let deleteBtn = '';
            if (!p.isDefault) {
                deleteBtn = `
                    <button type="button" title="Pinsel löschen" onclick="event.stopPropagation(); window.deleteCustomBrushPreset('${p.id}')" style="background: none; border: none; color: #888; font-size: 13px; cursor: pointer; padding: 2px 4px;" onmouseover="this.style.color='#ff5252'" onmouseout="this.style.color='#888'">
                        🗑️
                    </button>
                `;
            }

            item.innerHTML = leftPart + deleteBtn;
            listContainer.appendChild(item);
        });
    }

    /**
     * Wendet ein Pinsel-Preset an
     */
    function applyBrushPreset(presetId) {
        const presets = getAllPresets();
        const found = presets.find(p => p.id === presetId);
        if (!found) return;

        activePresetId = presetId;

        if (window.BrushEngine) {
            window.BrushEngine.updateSettings(found.settings);
        }

        // Auch Toolbar-Slider synchronisieren
        if (found.settings.hardness !== undefined) {
            const sHard = getBsElement('brushHardness');
            const vHard = getBsElement('brushHardnessVal');
            if (sHard) sHard.value = found.settings.hardness;
            if (vHard) vHard.textContent = Math.round(found.settings.hardness * 100) + '%';
        }

        renderPresetList();
        syncControlsFromEngine();
        updateStrokePreview();
    }

    /**
     * Synchronisiert die Schieberegler im Modal mit den aktuellen Werten
     */
    function syncControlsFromEngine() {
        if (!window.BrushEngine) return;
        const s = window.BrushEngine.settings;

        const setVal = (id, val, textVal) => {
            const inp = getBsElement(id);
            if (inp) {
                if (inp.type === 'checkbox') inp.checked = !!val;
                else inp.value = val;
            }
            const lbl = getBsElement(id + '_val');
            if (lbl && textVal !== undefined) lbl.textContent = textVal;
        };

        setVal('bs_tipType', s.tipType || 'round');
        setVal('bs_size', s.size || 20, (s.size || 20) + 'px');
        setVal('bs_hardness', s.hardness !== undefined ? s.hardness : 0.8, Math.round((s.hardness !== undefined ? s.hardness : 0.8) * 100) + '%');
        setVal('bs_spacing', Math.round((s.spacing || 0.12) * 100), Math.round((s.spacing || 0.12) * 100) + '%');
        setVal('bs_roundness', Math.round((s.roundness !== undefined ? s.roundness : 1.0) * 100), Math.round((s.roundness !== undefined ? s.roundness : 1.0) * 100) + '%');
        setVal('bs_angle', s.angle || 0, (s.angle || 0) + '°');
        setVal('bs_sizeJitter', Math.round((s.sizeJitter || 0) * 100), Math.round((s.sizeJitter || 0) * 100) + '%');
        setVal('bs_angleJitter', Math.round((s.angleJitter || 0) * 100), Math.round((s.angleJitter || 0) * 100) + '%');
        setVal('bs_scatter', Math.round((s.scatter || 0) * 100), Math.round((s.scatter || 0) * 100) + '%');
        setVal('bs_count', s.count || 1, s.count || 1);
        setVal('bs_flow', Math.round((s.flow !== undefined ? s.flow : 1.0) * 100), Math.round((s.flow !== undefined ? s.flow : 1.0) * 100) + '%');
        setVal('bs_smoothing', Math.round((s.smoothing || 0.35) * 100), Math.round((s.smoothing || 0.35) * 100) + '%');
        setVal('bs_wetEdge', !!s.wetEdge);
        setVal('bs_pressureSize', s.pressureSize !== false);
        setVal('bs_pressureOpacity', !!s.pressureOpacity);
    }

    /**
     * Parameteränderung an Engine weiterleiten & Vorschau triggern
     */
    function onBrushParamChange(paramId, value) {
        if (!window.BrushEngine) return;

        let numVal = isNaN(value) ? value : Number(value);
        let updateObj = {};

        switch (paramId) {
            case 'bs_tipType':
                updateObj.tipType = value;
                break;
            case 'bs_size':
                updateObj.size = numVal;
                // Auch Toolbar-Slider synchronisieren
                const bSize = getBsElement('brushSize');
                const bSizeVal = getBsElement('brushSizeVal');
                if (bSize) bSize.value = numVal;
                if (bSizeVal) bSizeVal.textContent = numVal;
                break;
            case 'bs_hardness':
                updateObj.hardness = numVal;
                const bHard = getBsElement('brushHardness');
                const bHardVal = getBsElement('brushHardnessVal');
                if (bHard) bHard.value = numVal;
                if (bHardVal) bHardVal.textContent = Math.round(numVal * 100) + '%';
                break;
            case 'bs_spacing':
                updateObj.spacing = numVal / 100;
                break;
            case 'bs_roundness':
                updateObj.roundness = numVal / 100;
                break;
            case 'bs_angle':
                updateObj.angle = numVal;
                break;
            case 'bs_sizeJitter':
                updateObj.sizeJitter = numVal / 100;
                break;
            case 'bs_angleJitter':
                updateObj.angleJitter = numVal / 100;
                break;
            case 'bs_scatter':
                updateObj.scatter = numVal / 100;
                break;
            case 'bs_count':
                updateObj.count = numVal;
                break;
            case 'bs_flow':
                updateObj.flow = numVal / 100;
                break;
            case 'bs_smoothing':
                updateObj.smoothing = numVal / 100;
                const bSmooth = getBsElement('brushSmoothing');
                if (bSmooth) bSmooth.value = numVal / 100;
                break;
            case 'bs_wetEdge':
                updateObj.wetEdge = !!value;
                break;
            case 'bs_pressureSize':
                updateObj.pressureSize = !!value;
                break;
            case 'bs_pressureOpacity':
                updateObj.pressureOpacity = !!value;
                break;
        }

        window.BrushEngine.updateSettings(updateObj);

        // Label-Anzeige aktualisieren
        const lbl = getBsElement(paramId + '_val');
        if (lbl) {
            if (paramId === 'bs_size') lbl.textContent = numVal + 'px';
            else if (paramId === 'bs_angle') lbl.textContent = numVal + '°';
            else if (['bs_hardness', 'bs_spacing', 'bs_roundness', 'bs_sizeJitter', 'bs_angleJitter', 'bs_scatter', 'bs_flow', 'bs_smoothing'].includes(paramId)) {
                lbl.textContent = (paramId === 'bs_hardness' ? Math.round(numVal * 100) : numVal) + '%';
            } else if (paramId === 'bs_count') {
                lbl.textContent = numVal;
            }
        }

        updateStrokePreview();
    }

    /**
     * Aktualisiert den Photoshop Live Stroke Preview Canvas
     */
    function updateStrokePreview() {
        if (previewRaf) cancelAnimationFrame(previewRaf);
        previewRaf = requestAnimationFrame(() => {
            previewRaf = null;
            const canvas = getBsElement('bsPreviewCanvas');
            if (!canvas || !window.BrushEngine) return;

            const colorPick = getBsElement('logoColorPicker');
            const currentColor = colorPick ? colorPick.value : '#1db954';

            window.BrushEngine.renderStrokePreview(canvas, {
                color: currentColor
            });
        });
    }

    /**
     * Speichert den aktuellen Pinsel als neues benutzerdefiniertes Preset ab
     */
    function saveCurrentAsNewPreset() {
        if (!window.BrushEngine) return;

        const name = prompt('Name für deinen neuen Pinsel eingeben:', 'Mein Custom Pinsel');
        if (!name || !name.trim()) return;

        const currentSettings = { ...window.BrushEngine.settings };
        const newId = 'custom_' + Date.now();

        // Icon je nach Tip-Typ wählen
        const iconMap = {
            round: '⚪',
            gpen: '🖋️',
            pencil: '✏️',
            chisel: '✒️',
            bristle: '🖌️',
            airbrush: '💨',
            charcoal: '🧱',
            splatter: '💥',
            watercolor: '🌊'
        };

        const newPreset = {
            id: newId,
            name: name.trim(),
            icon: iconMap[currentSettings.tipType] || '🖌️',
            isDefault: false,
            desc: `Benutzerdefinierter Pinsel (${currentSettings.tipType || 'round'}, Größe ${currentSettings.size || 20}px)`,
            settings: currentSettings
        };

        const custom = loadCustomPresets();
        custom.push(newPreset);
        saveCustomPresets(custom);

        activePresetId = newId;
        renderPresetList();
        updateStrokePreview();

        alert(`Pinsel "${newPreset.name}" erfolgreich gespeichert!`);
    }

    /**
     * Löscht einen benutzerdefinierten Pinsel
     */
    function deleteCustomBrushPreset(presetId) {
        if (!confirm('Diesen Pinsel wirklich löschen?')) return;

        let custom = loadCustomPresets();
        custom = custom.filter(p => p.id !== presetId);
        saveCustomPresets(custom);

        if (activePresetId === presetId) {
            activePresetId = 'hard_round';
            applyBrushPreset('hard_round');
        } else {
            renderPresetList();
        }
    }

    // Exportieren an window
    window.openBrushStudioModal = openBrushStudioModal;
    window.closeBrushStudioModal = closeBrushStudioModal;
    window.toggleBrushStudioModal = toggleBrushStudioModal;
    window.applyBrushPreset = applyBrushPreset;
    window.onBrushParamChange = onBrushParamChange;
    window.saveCurrentAsNewPreset = saveCurrentAsNewPreset;
    window.deleteCustomBrushPreset = deleteCustomBrushPreset;
    window.updateStrokePreview = updateStrokePreview;

    // Popout-Fenster Spiegelung
    window.syncBrushStudioWithPopout = function (popoutWin) {
        if (!popoutWin) return;
        popoutWin.openBrushStudioModal = openBrushStudioModal;
        popoutWin.closeBrushStudioModal = closeBrushStudioModal;
        popoutWin.toggleBrushStudioModal = toggleBrushStudioModal;
        popoutWin.applyBrushPreset = applyBrushPreset;
        popoutWin.onBrushParamChange = onBrushParamChange;
        popoutWin.saveCurrentAsNewPreset = saveCurrentAsNewPreset;
        popoutWin.deleteCustomBrushPreset = deleteCustomBrushPreset;
        popoutWin.updateStrokePreview = updateStrokePreview;
    };

})();
