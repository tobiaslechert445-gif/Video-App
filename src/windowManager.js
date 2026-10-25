/**
 * Clip Studio Paint - Fenster-Manager & Studio-Paletten
 * Antigravity Drawing Studio
 * 
 * Verwaltet das "Fenster(W)"-Menü und alle Studio-Panels:
 * - Dynamisches Fenster(W)-Menü mit Häkchen-Synchronisation (✓)
 * - Navigator-Panel (Echtzeit-Minimap der Leinwand mit Ansichtsrahmen & Schnellnavigation)
 * - Protokoll-Panel (Verlauf / Undo-Redo-Aktionsliste zum direkten Anspringen von Schritten)
 * - Farbmischung-Panel (Interaktive Mischpalette zum Mischen und Aufnehmen von Farbtönen)
 * - Farbprotokoll-Panel (Kürzlich verwendete Farben mit Sofort-Auswahl)
 * - Farbenregler-Panel (Präzise RGB- und HSV-Schieberegler mit Live-Abgleich)
 * - Quick-Access-Panel (Schnellzugriff auf häufigste Zeichen-Aktionen)
 * - Ebenen-Suche (Echtzeit-Filter für Ebenen)
 * - Universelles Ein-/Ausblenden (Schließen ✕ & Einklappen ▾ für ALLE Panels ohne Einschränkung)
 * - Zen-Modus (Tab-Taste zum Ausblenden aller Paletten für freie Sicht auf die Leinwand)
 */

(function () {
    'use strict';

    const COLOR_HISTORY_KEY = 'csp_color_history_v1';
    const MAX_COLOR_HISTORY = 32;

    // Farbverlauf im Speicher
    let colorHistory = [];
    try {
        const raw = localStorage.getItem(COLOR_HISTORY_KEY);
        colorHistory = raw ? JSON.parse(raw) : [];
    } catch (e) {
        colorHistory = [];
    }
    if (!Array.isArray(colorHistory) || colorHistory.length === 0) {
        colorHistory = ['#000000', '#FFFFFF', '#1DB954', '#E74C3C', '#3498DB', '#F1C40F', '#9B59B6', '#E67E22'];
    }

    // Farbmischung-State
    const mixState = {
        tool: 'brush', // 'brush', 'smudge', 'eyedropper', 'eraser'
        size: 14,
        isDrawing: false,
        lastX: 0,
        lastY: 0
    };

    /**
     * Ermittelt das aktive Dokument (Standardfenster oder Tablet Popout-Fenster)
     */
    function getDoc() {
        if (typeof window.getActiveEditorDoc === 'function') {
            return window.getActiveEditorDoc();
        }
        if (window.isEditorPoppedOut && window.popoutEditorWindow && !window.popoutEditorWindow.closed) {
            try {
                if (window.popoutEditorWindow.document && window.popoutEditorWindow.document.body) {
                    return window.popoutEditorWindow.document;
                }
            } catch (e) {}
        }
        return document;
    }

    /**
     * Prüft zuverlässig, ob ein Element tatsächlich im DOM sichtbar ist
     */
    function isElementVisible(el) {
        if (!el) return false;
        if (el.classList.contains('hidden')) return false;
        if (el.style.display === 'none') return false;
        try {
            const win = el.ownerDocument?.defaultView || window;
            const comp = win.getComputedStyle(el);
            if (comp && comp.display === 'none') return false;
        } catch (e) {}
        return true;
    }

    /* ========================================================================== */
    /* 1. FENSTER-MENÜ & UNIVERSAL PANEL MANAGEMENT                               */
    /* ========================================================================== */

    /**
     * Schaltet ein Panel oder eine Leiste ein oder aus
     * @param {string} panelId - Die ID des Panels oder Elements
     */
    function toggleWindowPanel(panelId) {
        const d = getDoc();
        const el = d.getElementById(panelId);
        if (!el) return;

        // Prüfe ob das Element oder seine übergeordnete Sidebar versteckt/eingeklappt ist
        const sidebar = el.closest('.csp-sidebar');
        const isSidebarCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;
        const isCurrentlyVisible = isElementVisible(el) && !isSidebarCollapsed;

        if (!isCurrentlyVisible) {
            openDockPanel(panelId);
        } else {
            closeDockPanel(panelId);
        }
    }

    /**
     * Öffnet und blendet ein Panel ein
     */
    function openDockPanel(panelId) {
        const d = getDoc();
        const el = d.getElementById(panelId);
        if (!el) return;

        el.classList.remove('hidden');
        if (panelId === 'cspCommandBar' || panelId === 'brushQuickSizesPanel' || panelId === 'layerSearchContainer') {
            el.style.setProperty('display', 'flex', 'important');
        } else if (panelId === 'brushPropertiesSection' || panelId === 'brushSlidersSection') {
            el.style.setProperty('display', 'block', 'important');
        } else {
            el.style.setProperty('display', 'flex', 'important');
        }

        // Falls das Element ein Sub-Abschnitt von Tools ist, stelle sicher dass toolsPanel offen ist und tools tab aktiv ist
        if (panelId === 'brushPropertiesSection' || panelId === 'brushSlidersSection' || panelId === 'brushQuickSizesPanel') {
            const toolsPanel = d.getElementById('toolsPanel');
            if (toolsPanel) {
                toolsPanel.classList.remove('hidden');
                toolsPanel.style.setProperty('display', 'flex', 'important');
            }
            const tabBtn = d.getElementById('tabBtnTools');
            if (tabBtn && typeof window.switchLogoLeftTab === 'function') {
                window.switchLogoLeftTab('tools', tabBtn, d);
            }
        }

        // Falls das Element layerSearchContainer ist, stelle sicher dass layersPanel offen ist
        if (panelId === 'layerSearchContainer') {
            const layersPanel = d.getElementById('layersPanel');
            if (layersPanel) {
                layersPanel.classList.remove('hidden');
                layersPanel.style.setProperty('display', 'flex', 'important');
            }
        }

        // Falls das Panel in einer eingeklappten Sidebar liegt, klappe diese auf
        const sidebar = el.closest('.csp-sidebar');
        if (sidebar && sidebar.classList.contains('collapsed')) {
            sidebar.classList.remove('collapsed');
            const collapseBtn = sidebar.querySelector('.csp-collapse-btn');
            if (collapseBtn) {
                if (sidebar.id === 'logoLeftToolbar') collapseBtn.innerText = '◀';
                else if (sidebar.id === 'logoRightToolbar') collapseBtn.innerText = '▶';
                else if (sidebar.id === 'logoBottomToolbar') collapseBtn.innerText = '▼';
            }
        }

        // Falls das Panel selbst zusammengeklappt war, ausklappen
        el.classList.remove('collapsed-panel');
        const foldBtn = el.querySelector('.csp-fold-btn');
        if (foldBtn) foldBtn.innerText = '▾';

        // Spezielle Refresh-Aktionen
        if (panelId === 'navigatorPanel') {
            updateNavigatorUI();
        } else if (panelId === 'historyPanel') {
            updateHistoryPanelUI();
        } else if (panelId === 'colorSlidersPanel') {
            syncColorSlidersFromActive();
        } else if (panelId === 'colorHistoryPanel') {
            renderColorHistoryUI();
        } else if (panelId === 'referencePanel' && typeof window.renderReferenceCanvas === 'function') {
            window.renderReferenceCanvas();
        }

        updateWindowMenuCheckmarks();

        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Schließt und blendet ein Panel aus (Platz wird im Layout freigegeben)
     */
    function closeDockPanel(panelId) {
        const d = getDoc();
        const el = d.getElementById(panelId);
        if (!el) return;

        el.classList.add('hidden');
        el.style.setProperty('display', 'none', 'important');

        // Falls alle Panels in einer Sidebar geschlossen sind, Sidebar automatisch einklappen um Platz freizugeben
        const sidebar = el.closest('.csp-sidebar');
        if (sidebar) {
            const remainingVisible = Array.from(sidebar.querySelectorAll('.csp-dockable-panel')).some(p => isElementVisible(p));
            if (!remainingVisible) {
                sidebar.classList.add('collapsed');
                const collapseBtn = sidebar.querySelector('.csp-collapse-btn');
                if (collapseBtn) {
                    if (sidebar.id === 'logoLeftToolbar') collapseBtn.innerText = '▶';
                    else if (sidebar.id === 'logoRightToolbar') collapseBtn.innerText = '◀';
                    else if (sidebar.id === 'logoBottomToolbar') collapseBtn.innerText = '▲';
                }
            }
        }

        updateWindowMenuCheckmarks();

        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Klappt den Körper eines Panels ein oder aus (nur Titelleiste bleibt sichtbar)
     */
    function toggleFoldPanel(panelId, btn) {
        const d = getDoc();
        const el = d.getElementById(panelId);
        if (!el) return;

        const isCollapsed = el.classList.toggle('collapsed-panel');
        const foldBtn = btn || el.querySelector('.csp-fold-btn');
        if (foldBtn) {
            foldBtn.innerText = isCollapsed ? '▸' : '▾';
        }

        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Aktualisiert die Häkchen (✓) im "Fenster(W)"-Menü basierend auf der aktuellen Sichtbarkeit
     * Synchronisiert sowohl das Hauptdokument als auch das Popout-Fenster (falls offen).
     */
    function updateWindowMenuCheckmarks() {
        const docs = [document];
        const activeDoc = getDoc();
        if (activeDoc && activeDoc !== document) {
            docs.unshift(activeDoc);
        } else if (window.popoutEditorWindow && !window.popoutEditorWindow.closed && window.popoutEditorWindow.document) {
            if (!docs.includes(window.popoutEditorWindow.document)) {
                docs.unshift(window.popoutEditorWindow.document);
            }
        }

        const panelsMap = {
            'chk_cspCommandBar': 'cspCommandBar',
            'chk_quickAccessPanel': 'quickAccessPanel',
            'chk_brushPropertiesSection': 'brushPropertiesSection',
            'chk_brushSlidersSection': 'brushSlidersSection',
            'chk_brushQuickSizesPanel': 'brushQuickSizesPanel',
            'chk_colorPanel': 'colorPanel',
            'chk_colorSlidersPanel': 'colorSlidersPanel',
            'chk_customPalettesPanel': 'customPalettesPanel',
            'chk_colorHistoryPanel': 'colorHistoryPanel',
            'chk_colorMixingPanel': 'colorMixingPanel',
            'chk_layersPanel': 'layersPanel',
            'chk_navigatorPanel': 'navigatorPanel',
            'chk_referencePanel': 'referencePanel',
            'chk_historyPanel': 'historyPanel',
            'chk_textSettingsPanel': 'textSettingsPanel'
        };

        docs.forEach(d => {
            if (!d) return;

            for (const chkId in panelsMap) {
                const chkEl = d.getElementById(chkId);
                const targetEl = d.getElementById(panelsMap[chkId]);
                if (chkEl && targetEl) {
                    const sidebar = targetEl.closest('.csp-sidebar');
                    const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
                    let isParentVis = true;
                    if (chkId === 'chk_brushPropertiesSection' || chkId === 'chk_brushSlidersSection' || chkId === 'chk_brushQuickSizesPanel') {
                        const tp = d.getElementById('toolsPanel');
                        const tb = d.getElementById('toolsPanelBody');
                        isParentVis = (tp ? isElementVisible(tp) : true) && (tb ? isElementVisible(tb) : true);
                    }
                    const isVis = isElementVisible(targetEl) && isSidebarVis && isParentVis;
                    chkEl.innerText = isVis ? '✓' : '';
                }
            }

            // Tool (toolsPanel + toolsPanelBody) Checkmark
            const toolsChk = d.getElementById('chk_toolsPanel');
            const toolsPanel = d.getElementById('toolsPanel');
            const toolsBody = d.getElementById('toolsPanelBody');
            if (toolsChk && toolsPanel) {
                const sidebar = toolsPanel.closest('.csp-sidebar');
                const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
                const isPanelVis = isElementVisible(toolsPanel) && isSidebarVis;
                const isToolsTab = toolsBody ? isElementVisible(toolsBody) : true;
                toolsChk.innerText = (isPanelVis && isToolsTab) ? '✓' : '';
            }

            // Sub-Tool / Grafiken Tab Checkmark
            const subToolChk = d.getElementById('chk_subTool');
            const graphicsBody = d.getElementById('graphicsPanelBody');
            if (subToolChk && toolsPanel && graphicsBody) {
                const sidebar = toolsPanel.closest('.csp-sidebar');
                const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
                const isPanelVis = isElementVisible(toolsPanel) && isSidebarVis;
                const isGraphicsVis = isElementVisible(graphicsBody);
                subToolChk.innerText = (isPanelVis && isGraphicsVis) ? '✓' : '';
            }

            // Ebenen-Suche Checkmark
            const searchChk = d.getElementById('chk_layerSearch');
            const searchWrap = d.getElementById('layerSearchContainer');
            const layersPanel = d.getElementById('layersPanel');
            if (searchChk && searchWrap) {
                const sidebar = layersPanel ? layersPanel.closest('.csp-sidebar') : null;
                const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
                const isLayersVis = layersPanel ? (isElementVisible(layersPanel) && isSidebarVis) : true;
                const isSearchVis = isElementVisible(searchWrap);
                searchChk.innerText = (isLayersVis && isSearchVis) ? '✓' : '';
            }
        });
    }

    /**
     * Schaltet das Werkzeug-Panel bzw. den Werkzeug-Tab um
     */
    function toggleToolsPanel() {
        const d = getDoc();
        const toolsPanel = d.getElementById('toolsPanel');
        const toolsBody = d.getElementById('toolsPanelBody');
        const sidebar = toolsPanel ? toolsPanel.closest('.csp-sidebar') : null;
        const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
        const isPanelVisible = toolsPanel && isElementVisible(toolsPanel) && isSidebarVis;
        const isToolsTabActive = toolsBody && isElementVisible(toolsBody);

        if (isPanelVisible && isToolsTabActive) {
            closeDockPanel('toolsPanel');
        } else {
            openDockPanel('toolsPanel');
            const tabBtnTools = d.getElementById('tabBtnTools');
            if (typeof window.switchLogoLeftTab === 'function') {
                window.switchLogoLeftTab('tools', tabBtnTools, d);
            }
        }
        updateWindowMenuCheckmarks();
        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Schaltet zwischen Werkzeuge und Grafiken um
     */
    function toggleSubTools() {
        const d = getDoc();
        const toolsPanel = d.getElementById('toolsPanel');
        const graphicsBody = d.getElementById('graphicsPanelBody');
        const sidebar = toolsPanel ? toolsPanel.closest('.csp-sidebar') : null;
        const isSidebarVis = sidebar ? !sidebar.classList.contains('collapsed') : true;
        const isPanelVisible = toolsPanel && isElementVisible(toolsPanel) && isSidebarVis;
        const isGraphicsTabActive = graphicsBody && isElementVisible(graphicsBody);

        if (isPanelVisible && isGraphicsTabActive) {
            const tabBtnTools = d.getElementById('tabBtnTools');
            if (typeof window.switchLogoLeftTab === 'function') {
                window.switchLogoLeftTab('tools', tabBtnTools, d);
            }
        } else {
            openDockPanel('toolsPanel');
            const tabBtnGraphics = d.getElementById('tabBtnGraphics');
            if (typeof window.switchLogoLeftTab === 'function') {
                window.switchLogoLeftTab('graphics', tabBtnGraphics, d);
            }
        }
        updateWindowMenuCheckmarks();
        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Schaltet das Ebenen-Suchfeld ein/aus
     */
    function toggleLayerSearch() {
        const d = getDoc();
        const wrap = d.getElementById('layerSearchContainer');
        if (!wrap) return;

        const isCurrentlyHidden = !isElementVisible(wrap);
        if (isCurrentlyHidden) {
            openDockPanel('layersPanel');
            wrap.classList.remove('hidden');
            wrap.style.setProperty('display', 'flex', 'important');
            const input = d.getElementById('layerSearchInput');
            if (input) input.focus();
        } else {
            wrap.classList.add('hidden');
            wrap.style.setProperty('display', 'none', 'important');
            filterLayersList('');
        }
        updateWindowMenuCheckmarks();
        if (typeof window.saveLayout === 'function') {
            window.saveLayout(d);
        }
    }

    /**
     * Zen-Modus / Tab-Taste: Alle Seitenleisten und Panels umschalten
     */
    let zenModeActive = false;

    function toggleZenMode() {
        const d = getDoc();
        zenModeActive = !zenModeActive;

        const leftDock = d.getElementById('logoLeftToolbar');
        const rightDock = d.getElementById('logoRightToolbar');
        const bottomDock = d.getElementById('logoBottomToolbar');
        const cmdBar = d.getElementById('cspCommandBar');

        if (zenModeActive) {
            if (leftDock) leftDock.classList.add('collapsed');
            if (rightDock) rightDock.classList.add('collapsed');
            if (bottomDock) bottomDock.classList.add('collapsed');
            if (cmdBar) {
                cmdBar.classList.add('hidden');
                cmdBar.style.setProperty('display', 'none', 'important');
            }
        } else {
            if (leftDock) leftDock.classList.remove('collapsed');
            if (rightDock) rightDock.classList.remove('collapsed');
            if (bottomDock) bottomDock.classList.remove('collapsed');
            if (cmdBar) {
                cmdBar.classList.remove('hidden');
                cmdBar.style.setProperty('display', 'flex', 'important');
            }
        }

        updateWindowMenuCheckmarks();
    }

    function showAllPanels() {
        const d = getDoc();
        const panels = d.querySelectorAll('.csp-dockable-panel');
        panels.forEach(p => {
            p.classList.remove('hidden', 'collapsed-panel');
            p.style.setProperty('display', 'flex', 'important');
            const foldBtn = p.querySelector('.csp-fold-btn');
            if (foldBtn) foldBtn.innerText = '▾';
        });

        const cmdBar = d.getElementById('cspCommandBar');
        if (cmdBar) {
            cmdBar.classList.remove('hidden');
            cmdBar.style.setProperty('display', 'flex', 'important');
        }

        const propSec = d.getElementById('brushPropertiesSection');
        if (propSec) {
            propSec.classList.remove('hidden', 'collapsed-panel');
            propSec.style.setProperty('display', 'block', 'important');
        }

        const sliderSec = d.getElementById('brushSlidersSection');
        if (sliderSec) {
            sliderSec.classList.remove('hidden', 'collapsed-panel');
            sliderSec.style.setProperty('display', 'block', 'important');
        }

        const quickSizes = d.getElementById('brushQuickSizesPanel');
        if (quickSizes) {
            quickSizes.classList.remove('hidden', 'collapsed-panel');
            quickSizes.style.setProperty('display', 'flex', 'important');
        }

        ['logoLeftToolbar', 'logoRightToolbar', 'logoBottomToolbar'].forEach(id => {
            const bar = d.getElementById(id);
            if (bar) {
                bar.classList.remove('collapsed');
                const collapseBtn = bar.querySelector('.csp-collapse-btn');
                if (collapseBtn) {
                    if (id === 'logoLeftToolbar') collapseBtn.innerText = '◀';
                    else if (id === 'logoRightToolbar') collapseBtn.innerText = '▶';
                    else if (id === 'logoBottomToolbar') collapseBtn.innerText = '▼';
                }
            }
        });

        zenModeActive = false;
        updateWindowMenuCheckmarks();
        if (typeof window.saveLayout === 'function') window.saveLayout(d);
    }

    function hideAllPanels() {
        toggleZenMode();
    }

    function resetWorkspaceToDefault() {
        if (!confirm('Möchtest du den Arbeitsbereich auf das Standard-Layout zurücksetzen?')) return;
        localStorage.removeItem('logoPanelLayout_global');
        localStorage.removeItem('logoPanelLayout');
        const activeProject = window.currentEditingLogo || (typeof currentEditingLogo === 'string' ? currentEditingLogo : null);
        if (activeProject) {
            localStorage.removeItem('logoPanelLayout_project_' + encodeURIComponent(activeProject));
        }
        showAllPanels();
        alert('Standard-Arbeitsbereich wiederhergestellt.');
    }

    /* ========================================================================== */
    /* 2. NAVIGATOR (CANVAS-MINIMAP & VIEWPORT-BOX)                                */
    /* ========================================================================== */

    /**
     * Aktualisiert die Live-Vorschau und den roten Ansichtsrahmen im Navigator
     */
    function updateNavigatorUI() {
        const d = getDoc();
        const navPanel = d.getElementById('navigatorPanel');
        if (!navPanel || navPanel.style.display === 'none') return;

        const navCanvas = d.getElementById('navigatorCanvas');
        const mainLogoCanvas = d.getElementById('mainLogoCanvas');
        if (!navCanvas) return;

        const rect = navCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width || 220;
        const h = rect.height || 140;

        navCanvas.width = Math.floor(w * dpr);
        navCanvas.height = Math.floor(h * dpr);

        const ctx = navCanvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);

        // Hintergrund
        ctx.fillStyle = '#181818';
        ctx.fillRect(0, 0, w, h);

        const bW = window.baseWidth || 1000;
        const bH = window.baseHeight || 1000;

        // Skalierung für das Einpassen der Gesamtleinwand in die Minimap
        const scale = Math.min((w - 12) / bW, (h - 12) / bH);
        const mapW = bW * scale;
        const mapH = bH * scale;
        const mapX = (w - mapW) / 2;
        const mapY = (h - mapH) / 2;

        // Leinwand-Schachbrett & Umriss
        ctx.fillStyle = '#242424';
        ctx.fillRect(mapX, mapY, mapW, mapH);
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.strokeRect(mapX, mapY, mapW, mapH);

        // Hauptzeichnung verkleinert zeichnen
        if (mainLogoCanvas && mainLogoCanvas.width > 0 && mainLogoCanvas.height > 0) {
            ctx.drawImage(mainLogoCanvas, mapX, mapY, mapW, mapH);
        }

        // Roter Ansichtsrahmen (sichtbarer Ausschnitt der Zeichenleinwand)
        const cropContainer = d.getElementById('logoCropContainer');
        if (cropContainer && window.logoData) {
            const vpW = cropContainer.clientWidth;
            const vpH = cropContainer.clientHeight;
            const curZoom = window.logoData.scale || 1.0;

            // Koordinaten des sichtbaren Bildausschnitts
            const viewImgX = -window.logoData.x / curZoom;
            const viewImgY = -window.logoData.y / curZoom;
            const viewImgW = vpW / curZoom;
            const viewImgH = vpH / curZoom;

            const boxX = mapX + (viewImgX * scale);
            const boxY = mapY + (viewImgY * scale);
            const boxW = viewImgW * scale;
            const boxH = viewImgH * scale;

            ctx.strokeStyle = 'rgba(231, 76, 60, 0.95)';
            ctx.lineWidth = 2;
            ctx.strokeRect(boxX, boxY, boxW, boxH);

            ctx.fillStyle = 'rgba(231, 76, 60, 0.08)';
            ctx.fillRect(boxX, boxY, boxW, boxH);
        }

        ctx.restore();

        // Zoom-Slider im Navigator synchronisieren
        const navSlider = d.getElementById('navigatorZoomSlider');
        const navVal = d.getElementById('navigatorZoomVal');
        if (window.logoData) {
            const pct = Math.round(window.logoData.scale * 100);
            if (navSlider && d.activeElement !== navSlider) navSlider.value = pct;
            if (navVal) navVal.innerText = pct + '%';
        }
    }

    /**
     * Klick / Drag im Navigator zum schnellen Verschieben der Leinwand
     */
    function bindNavigatorEvents(targetDoc) {
        const navCanvas = targetDoc.getElementById('navigatorCanvas');
        if (!navCanvas || navCanvas._eventsBound) return;
        navCanvas._eventsBound = true;

        let isNavDragging = false;

        function handleNavClick(e) {
            const bW = window.baseWidth || 1000;
            const bH = window.baseHeight || 1000;
            const rect = navCanvas.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;

            const scale = Math.min((w - 12) / bW, (h - 12) / bH);
            const mapW = bW * scale;
            const mapH = bH * scale;
            const mapX = (w - mapW) / 2;
            const mapY = (h - mapH) / 2;

            const clickX = e.clientX - rect.left - mapX;
            const clickY = e.clientY - rect.top - mapY;

            const targetImgX = clickX / scale;
            const targetImgY = clickY / scale;

            const cropContainer = targetDoc.getElementById('logoCropContainer');
            if (cropContainer && window.logoData) {
                const vpW = cropContainer.clientWidth;
                const vpH = cropContainer.clientHeight;
                const curZoom = window.logoData.scale || 1.0;

                window.logoData.x = -(targetImgX * curZoom) + (vpW / 2);
                window.logoData.y = -(targetImgY * curZoom) + (vpH / 2);

                if (typeof window.updateLogoTransform === 'function') {
                    window.updateLogoTransform();
                }
                updateNavigatorUI();
            }
        }

        navCanvas.addEventListener('pointerdown', (e) => {
            isNavDragging = true;
            navCanvas.setPointerCapture(e.pointerId);
            handleNavClick(e);
        });

        navCanvas.addEventListener('pointermove', (e) => {
            if (isNavDragging) handleNavClick(e);
        });

        const stopNavDrag = (e) => {
            if (isNavDragging) {
                isNavDragging = false;
                try { navCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
            }
        };
        navCanvas.addEventListener('pointerup', stopNavDrag);
        navCanvas.addEventListener('pointercancel', stopNavDrag);
    }

    /* ========================================================================== */
    /* 3. PROTOKOLL (VERLAUF / UNDO-REDO ACTIONS STACK)                          */
    /* ========================================================================== */

    /**
     * Aktualisiert die Liste der durchgeführten Aktionen im Protokoll-Panel
     */
    function updateHistoryPanelUI() {
        const d = getDoc();
        const panel = d.getElementById('historyPanel');
        if (!panel || panel.style.display === 'none') return;

        const list = d.getElementById('historyListUi');
        if (!list) return;

        list.innerHTML = '';

        const hStack = window.historyStack || [];
        const rStack = window.redoStack || [];

        if (hStack.length === 0 && rStack.length === 0) {
            list.innerHTML = `<div style="padding: 16px; text-align: center; color: #666; font-size: 11px;">Noch keine Aktionen protokolliert.</div>`;
            return;
        }

        // 1. Initialer Zustand
        const initItem = d.createElement('div');
        initItem.className = 'history-item' + (hStack.length === 1 ? ' active' : '');
        initItem.innerHTML = `<span class="history-icon">📐</span><span class="history-label">Neues Dokument / Basis</span>`;
        initItem.onclick = () => jumpToHistoryState(0);
        list.appendChild(initItem);

        // 2. Durchgeführte Aktionen im historyStack
        hStack.forEach((state, idx) => {
            if (idx === 0) return; // Skip initial state already shown
            const item = d.createElement('div');
            const isLatest = (idx === hStack.length - 1 && rStack.length === 0);
            item.className = 'history-item' + (isLatest ? ' active' : '');

            const label = state._actionLabel || `Aktion #${idx}`;
            const icon = getHistoryIconForAction(label);

            item.innerHTML = `<span class="history-icon">${icon}</span><span class="history-label">${label}</span>`;
            item.onclick = () => jumpToHistoryState(idx);
            list.appendChild(item);
        });

        // 3. Redo-Schritte (ausgegraut, da in der Zukunft)
        [...rStack].reverse().forEach((state, rIdx) => {
            const item = d.createElement('div');
            item.className = 'history-item future';
            const label = state._actionLabel || `Wiederholen #${rIdx + 1}`;
            const icon = getHistoryIconForAction(label);

            item.innerHTML = `<span class="history-icon">${icon}</span><span class="history-label">${label}</span>`;
            item.onclick = () => redoUntilTarget(state);
            list.appendChild(item);
        });

        // Automatisch nach unten scrollen
        list.scrollTop = list.scrollHeight;
    }

    function getHistoryIconForAction(label) {
        if (/pinsel|brush|stroke/i.test(label)) return '🖌️';
        if (/radier|eraser/i.test(label)) return '🧽';
        if (/füll|fill|flood/i.test(label)) return '💧';
        if (/ebene|layer/i.test(label)) return '📑';
        if (/text/i.test(label)) return '🔤';
        if (/transform|scale|move|bewegen/i.test(label)) return '🖐️';
        if (/farbe|color/i.test(label)) return '🎨';
        if (/filter|fx/i.test(label)) return '✨';
        return '✏️';
    }

    /**
     * Springt im Verlauf direkt zu einem bestimmten Schritt
     */
    function jumpToHistoryState(targetIdx) {
        const hStack = window.historyStack || [];
        const rStack = window.redoStack || [];

        if (targetIdx < 0 || targetIdx >= hStack.length) return;

        // Schritte in den redoStack schieben
        while (hStack.length - 1 > targetIdx) {
            rStack.push(hStack.pop());
        }

        const targetState = hStack[hStack.length - 1];
        if (targetState && typeof window.restoreLogoState === 'function') {
            window.restoreLogoState(targetState);
        }
        updateHistoryPanelUI();
    }

    function redoUntilTarget(targetState) {
        const rStack = window.redoStack || [];
        const hStack = window.historyStack || [];

        while (rStack.length > 0) {
            const next = rStack.pop();
            hStack.push(next);
            if (next === targetState) {
                if (typeof window.restoreLogoState === 'function') {
                    window.restoreLogoState(next);
                }
                break;
            }
        }
        updateHistoryPanelUI();
    }

    /* ========================================================================== */
    /* 4. FARBMISCHUNG (INTERAKTIVE MISCHPALETTE)                                 */
    /* ========================================================================== */

    function initColorMixingCanvas(targetDoc) {
        const mixCanvas = targetDoc.getElementById('colorMixingCanvas');
        if (!mixCanvas || mixCanvas._bound) return;
        mixCanvas._bound = true;

        const ctx = mixCanvas.getContext('2d', { willReadFrequently: true });

        // Initial weißer Hintergrund
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, mixCanvas.width, mixCanvas.height);

        mixCanvas.addEventListener('pointerdown', (e) => {
            const rect = mixCanvas.getBoundingClientRect();
            mixState.isDrawing = true;
            mixState.lastX = e.clientX - rect.left;
            mixState.lastY = e.clientY - rect.top;
            mixCanvas.setPointerCapture(e.pointerId);

            if (mixState.tool === 'eyedropper') {
                pickFromMixPad(mixState.lastX, mixState.lastY);
            } else {
                drawOnMixPad(mixState.lastX, mixState.lastY, false);
            }
        });

        mixCanvas.addEventListener('pointermove', (e) => {
            if (!mixState.isDrawing) return;
            const rect = mixCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (mixState.tool === 'eyedropper') {
                pickFromMixPad(x, y);
            } else {
                drawOnMixPad(x, y, true);
            }
            mixState.lastX = x;
            mixState.lastY = y;
        });

        const stopDraw = (e) => {
            if (mixState.isDrawing) {
                mixState.isDrawing = false;
                try { mixCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
            }
        };
        mixCanvas.addEventListener('pointerup', stopDraw);
        mixCanvas.addEventListener('pointercancel', stopDraw);
    }

    function drawOnMixPad(x, y, isMove = false) {
        const d = getDoc();
        const mixCanvas = d.getElementById('colorMixingCanvas');
        if (!mixCanvas) return;
        const ctx = mixCanvas.getContext('2d', { willReadFrequently: true });

        const activeColor = (d.getElementById('logoColorPicker')?.value) || '#1DB954';
        const size = mixState.size || 14;

        if (mixState.tool === 'eraser') {
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        } else if (mixState.tool === 'smudge') {
            // Wisch- und Mischfunktion: Benachbarte Pixel leicht verschieben & weichzeichnen
            const r = Math.max(2, Math.floor(size / 2));
            const sx = Math.max(0, Math.min(mixCanvas.width - r * 2, x - r));
            const sy = Math.max(0, Math.min(mixCanvas.height - r * 2, y - r));
            try {
                const imgData = ctx.getImageData(sx, sy, r * 2, r * 2);
                ctx.globalAlpha = 0.45;
                ctx.drawImage(mixCanvas, sx, sy, r * 2, r * 2, x - r + (x - mixState.lastX) * 0.5, y - r + (y - mixState.lastY) * 0.5, r * 2, r * 2);
                ctx.globalAlpha = 1.0;
            } catch(e) {}
        } else {
            // Pinsel: Weicher runder Farbauftrag mit leichter Transparenz zum natürlichen Verblenden
            ctx.save();
            ctx.strokeStyle = activeColor;
            ctx.fillStyle = activeColor;
            ctx.lineWidth = size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.65;

            ctx.beginPath();
            if (isMove) {
                ctx.moveTo(mixState.lastX, mixState.lastY);
                ctx.lineTo(x, y);
                ctx.stroke();
            } else {
                ctx.arc(x, y, size / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    }

    function pickFromMixPad(x, y) {
        const d = getDoc();
        const mixCanvas = d.getElementById('colorMixingCanvas');
        if (!mixCanvas) return;
        const ctx = mixCanvas.getContext('2d', { willReadFrequently: true });
        try {
            const pixel = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
            if (pixel[3] > 0) {
                const hex = '#' + ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1).toUpperCase();
                applyGlobalColor(hex);
            }
        } catch(e) {}
    }

    function clearColorMixingPad() {
        const d = getDoc();
        const mixCanvas = d.getElementById('colorMixingCanvas');
        if (!mixCanvas) return;
        const ctx = mixCanvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, mixCanvas.width, mixCanvas.height);
    }

    function setColorMixingTool(toolName) {
        mixState.tool = toolName;
        const d = getDoc();
        const btns = d.querySelectorAll('.mix-tool-btn');
        btns.forEach(b => b.classList.remove('active'));
        const activeBtn = d.getElementById('mixTool_' + toolName);
        if (activeBtn) activeBtn.classList.add('active');

        const canvas = d.getElementById('colorMixingCanvas');
        if (canvas) {
            canvas.style.cursor = toolName === 'eyedropper' ? 'crosshair' : 'default';
        }
    }

    /* ========================================================================== */
    /* 5. FARBPROTOKOLL (RECENTLY USED COLORS)                                    */
    /* ========================================================================== */

    function recordColorToHistory(hex) {
        if (!hex || typeof hex !== 'string') return;
        hex = hex.toUpperCase();

        // Duplikate an die Spitze schieben
        const idx = colorHistory.indexOf(hex);
        if (idx !== -1) {
            colorHistory.splice(idx, 1);
        }
        colorHistory.unshift(hex);

        if (colorHistory.length > MAX_COLOR_HISTORY) {
            colorHistory.pop();
        }

        try {
            localStorage.setItem(COLOR_HISTORY_KEY, JSON.stringify(colorHistory));
        } catch(e) {}

        renderColorHistoryUI();
    }

    function renderColorHistoryUI() {
        const d = getDoc();
        const grid = d.getElementById('colorHistoryGrid');
        if (!grid) return;

        grid.innerHTML = '';
        const curColor = (d.getElementById('logoColorPicker')?.value || '').toUpperCase();

        colorHistory.forEach(colorHex => {
            const chip = d.createElement('div');
            chip.className = 'color-history-chip' + (colorHex === curColor ? ' active' : '');
            chip.style.backgroundColor = colorHex;
            chip.title = colorHex;
            chip.onclick = () => {
                applyGlobalColor(colorHex);
            };
            grid.appendChild(chip);
        });
    }

    function clearColorHistoryPrompt() {
        if (!confirm('Farbprotokoll wirklich leeren?')) return;
        colorHistory = [];
        try { localStorage.removeItem(COLOR_HISTORY_KEY); } catch(e) {}
        renderColorHistoryUI();
    }

    /* ========================================================================== */
    /* 6. FARBENREGLER (RGB & HSV SLIDERS)                                        */
    /* ========================================================================== */

    let colorSlidersMode = 'rgb'; // 'rgb' oder 'hsv'

    function switchColorSliderMode(mode) {
        colorSlidersMode = mode;
        const d = getDoc();
        const tabRgb = d.getElementById('csTabRgb');
        const tabHsv = d.getElementById('csTabHsv');
        const viewRgb = d.getElementById('csViewRgb');
        const viewHsv = d.getElementById('csViewHsv');

        if (tabRgb) tabRgb.classList.toggle('active', mode === 'rgb');
        if (tabHsv) tabHsv.classList.toggle('active', mode === 'hsv');
        if (viewRgb) viewRgb.style.display = mode === 'rgb' ? 'flex' : 'none';
        if (viewHsv) viewHsv.style.display = mode === 'hsv' ? 'flex' : 'none';

        syncColorSlidersFromActive();
    }

    function syncColorSlidersFromActive() {
        const d = getDoc();
        const picker = d.getElementById('logoColorPicker');
        const hex = (picker?.value || '#1DB954').toUpperCase();

        // Hex & Preview
        const preview = d.getElementById('csColorPreview');
        const hexInput = d.getElementById('csHexInput');
        if (preview) preview.style.backgroundColor = hex;
        if (hexInput && d.activeElement !== hexInput) hexInput.value = hex;

        // RGB
        const rgb = hexToRgb(hex);
        if (rgb) {
            setSliderVal('csR', rgb.r);
            setSliderVal('csG', rgb.g);
            setSliderVal('csB', rgb.b);
        }

        // HSV
        if (typeof window.hexToHsv === 'function') {
            const hsv = window.hexToHsv(hex);
            setSliderVal('csH', Math.round(hsv.h));
            setSliderVal('csS', Math.round(hsv.s * 100));
            setSliderVal('csV', Math.round(hsv.v * 100));
        }
    }

    function setSliderVal(idPrefix, val) {
        const d = getDoc();
        const slider = d.getElementById(idPrefix + 'Slider');
        const num = d.getElementById(idPrefix + 'Num');
        if (slider && d.activeElement !== slider) slider.value = val;
        if (num && d.activeElement !== num) num.value = val;
    }

    function onRgbSliderChange() {
        const d = getDoc();
        const r = parseInt(d.getElementById('csRSlider')?.value || 0, 10);
        const g = parseInt(d.getElementById('csGSlider')?.value || 0, 10);
        const b = parseInt(d.getElementById('csBSlider')?.value || 0, 10);

        setSliderVal('csR', r);
        setSliderVal('csG', g);
        setSliderVal('csB', b);

        const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
        applyGlobalColor(hex);
    }

    function onHsvSliderChange() {
        const d = getDoc();
        const h = parseInt(d.getElementById('csHSlider')?.value || 0, 10);
        const s = parseInt(d.getElementById('csSSlider')?.value || 0, 10) / 100;
        const v = parseInt(d.getElementById('csVSlider')?.value || 0, 10) / 100;

        setSliderVal('csH', h);
        setSliderVal('csS', Math.round(s * 100));
        setSliderVal('csV', Math.round(v * 100));

        const hex = hsvToHex(h, s, v);
        applyGlobalColor(hex);
    }

    function onHexInputChange(val) {
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
            applyGlobalColor(val.toUpperCase());
        }
    }

    /* ========================================================================== */
    /* 7. EBENEN-SUCHE (REALTIME LAYER FILTER)                                    */
    /* ========================================================================== */

    function filterLayersList(query) {
        const d = getDoc();
        query = (query || '').toLowerCase().trim();
        const layerItems = d.querySelectorAll('#layersListUi .layer-item');

        layerItems.forEach(item => {
            const nameEl = item.querySelector('.layer-name') || item;
            const text = (nameEl.innerText || '').toLowerCase();
            if (!query || text.includes(query)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    /* ========================================================================== */
    /* 8. HILFSFUNKTIONEN FÜR FARBEN & GLOBAL UPDATE                               */
    /* ========================================================================== */

    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    function hsvToHex(h, s, v) {
        let r, g, b;
        const i = Math.floor((h / 60) % 6);
        const f = (h / 60) - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);

        switch (i) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }

        const r8 = Math.round(r * 255);
        const g8 = Math.round(g * 255);
        const b8 = Math.round(b * 255);

        return '#' + ((1 << 24) + (r8 << 16) + (g8 << 8) + b8).toString(16).slice(1).toUpperCase();
    }

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

        // Live Synchronisierung der anderen Panels
        syncColorSlidersFromActive();
        recordColorToHistory(hex);
        if (typeof window.BrushEngine !== 'undefined' && window.BrushEngine.updateSettings) {
            window.BrushEngine.updateSettings({ color: hex });
        }
    }

    /* ========================================================================== */
    /* 9. INITIALISIERUNG & TASTENKÜRZEL                                          */
    /* ========================================================================== */

    function initWindowManager(targetDoc = document) {
        bindNavigatorEvents(targetDoc);
        initColorMixingCanvas(targetDoc);
        renderColorHistoryUI();
        syncColorSlidersFromActive();
        updateWindowMenuCheckmarks();

        // Live-Synchronisation der Häkchen beim Hovern/Klicken auf das Fenster(W)-Menü
        const winMenu = targetDoc.getElementById('cspMenuWindow');
        if (winMenu && !winMenu._menuSyncBound) {
            winMenu._menuSyncBound = true;
            winMenu.addEventListener('mouseenter', () => updateWindowMenuCheckmarks());
            winMenu.addEventListener('pointerdown', () => updateWindowMenuCheckmarks());
            winMenu.addEventListener('click', () => updateWindowMenuCheckmarks());
        }

        // Tastenkürzel für Zen-Modus (Tab-Taste)
        targetDoc.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName) && !e.target.isContentEditable) {
                e.preventDefault();
                toggleZenMode();
            }
        });

        // Klick außerhalb von Dropdowns schließt diese
        targetDoc.addEventListener('click', (e) => {
            if (!e.target.closest('.csp-menu-item')) {
                const openMenus = targetDoc.querySelectorAll('.csp-menu-dropdown.show');
                openMenus.forEach(m => m.classList.remove('show'));
            }
        });
    }

    /**
     * Popout-Synchronisation für das Tablet-Fenster
     */
    window.syncWindowManagerWithPopout = function (popoutWin) {
        if (!popoutWin || !popoutWin.document) return;
        const pDoc = popoutWin.document;

        // Methoden anbinden
        popoutWin.toggleWindowPanel = toggleWindowPanel;
        popoutWin.toggleToolsPanel = toggleToolsPanel;
        popoutWin.openDockPanel = openDockPanel;
        popoutWin.closeDockPanel = closeDockPanel;
        popoutWin.toggleFoldPanel = toggleFoldPanel;
        popoutWin.toggleZenMode = toggleZenMode;
        popoutWin.showAllPanels = showAllPanels;
        popoutWin.hideAllPanels = hideAllPanels;
        popoutWin.resetWorkspaceToDefault = resetWorkspaceToDefault;
        popoutWin.toggleSubTools = toggleSubTools;
        popoutWin.toggleLayerSearch = toggleLayerSearch;
        popoutWin.filterLayersList = filterLayersList;
        popoutWin.switchColorSliderMode = switchColorSliderMode;
        popoutWin.onRgbSliderChange = onRgbSliderChange;
        popoutWin.onHsvSliderChange = onHsvSliderChange;
        popoutWin.onHexInputChange = onHexInputChange;
        popoutWin.clearColorHistoryPrompt = clearColorHistoryPrompt;
        popoutWin.clearColorMixingPad = clearColorMixingPad;
        popoutWin.setColorMixingTool = setColorMixingTool;
        popoutWin.jumpToHistoryState = jumpToHistoryState;
        popoutWin.updateNavigatorUI = updateNavigatorUI;
        popoutWin.updateHistoryPanelUI = updateHistoryPanelUI;
        popoutWin.updateWindowMenuCheckmarks = updateWindowMenuCheckmarks;

        initWindowManager(pDoc);
        setTimeout(() => {
            updateWindowMenuCheckmarks();
            updateNavigatorUI();
            updateHistoryPanelUI();
        }, 120);
    };

    // Globale Exporte an window
    window.toggleWindowPanel = toggleWindowPanel;
    window.toggleToolsPanel = toggleToolsPanel;
    window.openDockPanel = openDockPanel;
    window.closeDockPanel = closeDockPanel;
    window.toggleFoldPanel = toggleFoldPanel;
    window.toggleZenMode = toggleZenMode;
    window.showAllPanels = showAllPanels;
    window.hideAllPanels = hideAllPanels;
    window.resetWorkspaceToDefault = resetWorkspaceToDefault;
    window.toggleSubTools = toggleSubTools;
    window.toggleLayerSearch = toggleLayerSearch;
    window.filterLayersList = filterLayersList;
    window.switchColorSliderMode = switchColorSliderMode;
    window.onRgbSliderChange = onRgbSliderChange;
    window.onHsvSliderChange = onHsvSliderChange;
    window.onHexInputChange = onHexInputChange;
    window.clearColorHistoryPrompt = clearColorHistoryPrompt;
    window.clearColorMixingPad = clearColorMixingPad;
    window.setColorMixingTool = setColorMixingTool;
    window.jumpToHistoryState = jumpToHistoryState;
    window.updateNavigatorUI = updateNavigatorUI;
    window.updateHistoryPanelUI = updateHistoryPanelUI;
    window.recordColorToHistory = recordColorToHistory;
    window.syncColorSlidersFromActive = syncColorSlidersFromActive;
    window.updateWindowMenuCheckmarks = updateWindowMenuCheckmarks;
    window.initWindowManager = initWindowManager;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initWindowManager(document));
    } else {
        setTimeout(() => initWindowManager(document), 50);
    }

})();
