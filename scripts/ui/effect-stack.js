import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry, loadAssetBundle } from '../assets/loader.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';

const log = createLogger('EffectStack');

export class EffectStackUI {
  constructor() {
    this.pane = null;
    this.container = null;
    this.headerOverlay = null;

    this.visible = false;

    this._summaryBindings = {};
    this._summaryState = {
      albedoSource: '—',
      maskSource: '—',
      compositeEnabled: '—',
      compositeSegments: '—',
      tileCount: 0,
      warnings: ''
    };

    this._tilesFolder = null;
    this._effectsFolder = null;
    this._lastReport = '';

    this._selectedMaskId = 'specular.scene';

    this._tileFilterState = {
      query: '',
      issuesOnly: false,
      showGround: true,
      showOverhead: true,
      showRoof: true,
      expanded: {
        ground: true,
        overhead: true,
        roof: true
      }
    };

    this._bundleMaskCache = new Map();
    this._refreshDebounce = null;

    this._effectFilterState = {
      query: '',
      enabledOnly: false,
      expanded: {}
    };
  }

  async initialize() {
    if (this.pane) return;

    this.container = document.createElement('div');
    this.container.id = 'map-shine-effect-stack';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10005';
    this.container.style.display = 'none';
    this.container.style.minWidth = '780px';
    this.container.style.maxWidth = '1100px';
    this.container.style.right = '20px';
    this.container.style.bottom = '20px';
    this.container.style.maxHeight = '80vh';
    this.container.style.overflowY = 'auto';
    document.body.appendChild(this.container);

    {
      const stop = (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
      };

      const stopAndPrevent = (e) => {
        try {
          e.preventDefault();
        } catch (_) {
        }
        stop(e);
      };

      const events = [
        'pointerdown',
        'mousedown',
        'click',
        'dblclick',
        'wheel'
      ];

      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }

      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this.pane = new Tweakpane.Pane({
      title: 'Effect Stack',
      container: this.container,
      expanded: true
    });

    try {
      if (this.pane?.element) {
        this.pane.element.style.maxHeight = '100%';
        this.pane.element.style.overflowY = 'auto';
      }
    } catch (e) {
    }

    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-effect-stack-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10006';
    this.container.appendChild(this.headerOverlay);

    const summaryFolder = this.pane.addFolder({ title: 'Summary', expanded: true });

    this._summaryBindings.albedoSource = summaryFolder.addBlade({
      view: 'text',
      label: 'Albedo',
      parse: (v) => v,
      value: this._summaryState.albedoSource,
      disabled: true
    });

    this._summaryBindings.maskSource = summaryFolder.addBlade({
      view: 'text',
      label: 'Masks',
      parse: (v) => v,
      value: this._summaryState.maskSource,
      disabled: true
    });

    this._summaryBindings.compositeEnabled = summaryFolder.addBlade({
      view: 'text',
      label: 'Composite',
      parse: (v) => v,
      value: this._summaryState.compositeEnabled,
      disabled: true
    });

    this._summaryBindings.compositeSegments = summaryFolder.addBlade({
      view: 'text',
      label: 'Segments',
      parse: (v) => v,
      value: this._summaryState.compositeSegments,
      disabled: true
    });

    this._summaryBindings.tileCount = summaryFolder.addBlade({
      view: 'text',
      label: 'Tiles',
      parse: (v) => v,
      value: String(this._summaryState.tileCount),
      disabled: true
    });

    this._summaryBindings.warnings = summaryFolder.addBlade({
      view: 'text',
      label: 'Warnings',
      parse: (v) => v,
      value: this._summaryState.warnings,
      disabled: true
    });

    summaryFolder.addButton({ title: 'Refresh Now' }).on('click', () => {
      void this.refresh();
    });

    summaryFolder.addButton({ title: 'Copy Report' }).on('click', () => {
      void this.copyReportToClipboard();
    });

    const debugFolder = this.pane.addFolder({ title: 'Mask Debug', expanded: true });

    const options = this._getMaskDebugOptions();
    const state = { maskId: this._selectedMaskId };

    debugFolder.addBinding(state, 'maskId', {
      label: 'Mask',
      options
    }).on('change', (ev) => {
      this._selectedMaskId = ev.value;
    });

    debugFolder.addButton({ title: 'Enable Mask Debug' }).on('click', () => {
      this._openMaskDebug(this._selectedMaskId);
    });

    debugFolder.addButton({ title: 'Disable Mask Debug' }).on('click', () => {
      this._setMaskDebugEnabled(false);
    });

    this._effectsFolder = this.pane.addFolder({ title: 'Effects', expanded: true });
    this._tilesFolder = this.pane.addFolder({ title: 'Tiles', expanded: true });

    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;
    if (_isDbg) _dlp.begin('es.loadState', 'finalize');
    await this.loadState();
    if (_isDbg) _dlp.end('es.loadState');
    this.makeDraggable();

    // NOTE: refresh() is intentionally NOT called here. The panel starts hidden
    // (this.visible = false) and toggle() already calls refresh() when it becomes
    // visible. Calling refresh() here was loading asset bundles for every tile
    // base path (~59s of HTTP probing) during startup for a panel nobody is viewing.

    log.info('Effect Stack UI initialized (refresh deferred to first toggle)');
  }

  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';

    if (this.visible) {
      this.constrainToScreen();
      void this.refresh();
    }
  }

  _rebuildEffectsFolder() {
    if (!this.pane) return;

    if (!this._effectsFolder) {
      this._effectsFolder = this.pane.addFolder({ title: 'Effects', expanded: true });
      return;
    }

    try {
      const content = this._effectsFolder?.element?.querySelector?.('.tp-fldv_c') || this._effectsFolder?.element;
      if (content) content.innerHTML = '';
    } catch (e) {
    }
  }

  _buildEffectRows() {
    const folder = this._effectsFolder;
    if (!folder) return;

    const root = folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element;
    if (!root) return;

    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '8px';
    bar.style.alignItems = 'center';
    bar.style.margin = '6px 6px 10px 6px';

    const search = document.createElement('input');
    search.type = 'text';
    search.value = String(this._effectFilterState.query || '');
    search.placeholder = 'Search effects (id)…';
    search.style.flex = '1 1 280px';
    search.style.minWidth = '240px';
    search.style.padding = '4px 8px';
    search.style.borderRadius = '8px';
    search.style.border = '1px solid rgba(255,255,255,0.12)';
    search.style.background = 'rgba(0,0,0,0.20)';
    search.style.color = 'inherit';

    const mkToggle = (label, key) => {
      const wrap = document.createElement('label');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.style.padding = '2px 8px';
      wrap.style.borderRadius = '999px';
      wrap.style.border = '1px solid rgba(255,255,255,0.12)';
      wrap.style.background = 'rgba(0,0,0,0.20)';
      wrap.style.cursor = 'pointer';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!this._effectFilterState[key];
      cb.style.cursor = 'pointer';

      const txt = document.createElement('span');
      txt.textContent = label;
      txt.style.fontSize = '11px';
      txt.style.opacity = '0.9';

      wrap.appendChild(cb);
      wrap.appendChild(txt);

      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        this._effectFilterState[key] = cb.checked;
        void this.saveState();
        this._scheduleRefresh();
      });
      return wrap;
    };

    search.addEventListener('keydown', (e) => e.stopPropagation());
    search.addEventListener('mousedown', (e) => e.stopPropagation());
    search.addEventListener('input', () => {
      this._effectFilterState.query = search.value;
      void this.saveState();
      this._scheduleRefresh();
    });

    bar.appendChild(search);
    bar.appendChild(mkToggle('Enabled', 'enabledOnly'));
    root.appendChild(bar);

    const makeSection = (id, titleText) => {
      const wrap = document.createElement('div');
      wrap.style.margin = '0 6px 10px 6px';
      wrap.style.border = '1px solid rgba(255,255,255,0.10)';
      wrap.style.borderRadius = '10px';
      wrap.style.background = 'rgba(255,255,255,0.03)';

      const head = document.createElement('div');
      head.style.display = 'flex';
      head.style.alignItems = 'center';
      head.style.justifyContent = 'space-between';
      head.style.padding = '6px 8px';
      head.style.cursor = 'pointer';

      const title = document.createElement('div');
      title.textContent = titleText;
      title.style.fontSize = '12px';
      title.style.fontWeight = '650';
      title.style.opacity = '0.95';

      const count = document.createElement('div');
      count.textContent = '0';
      count.style.fontSize = '11px';
      count.style.opacity = '0.7';

      head.appendChild(title);
      head.appendChild(count);

      const body = document.createElement('div');
      body.style.padding = '4px 0 6px 0';
      const expanded = (this._effectFilterState.expanded && Object.prototype.hasOwnProperty.call(this._effectFilterState.expanded, id))
        ? !!this._effectFilterState.expanded[id]
        : true;
      body.style.display = expanded ? 'block' : 'none';

      head.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      head.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = body.style.display === 'none';
        body.style.display = next ? 'block' : 'none';
        if (!this._effectFilterState.expanded) this._effectFilterState.expanded = {};
        this._effectFilterState.expanded[id] = next;
        void this.saveState();
      });

      wrap.appendChild(head);
      wrap.appendChild(body);
      root.appendChild(wrap);

      return { body, count };
    };

    const composer = window.MapShine?.effectComposer;
    const effectsMap = composer?.effects;
    if (!effectsMap || typeof effectsMap.values !== 'function') {
      this._appendRow(folder, {
        title: 'No EffectComposer',
        subtitle: 'Effect list unavailable. (Scene may still be initializing.)',
        chips: ['unavailable'],
        onClick: () => {}
      });
      return;
    }

    const scene = canvas?.scene;
    const effective = scene ? sceneSettings.getEffectiveSettings(scene) : null;
    const effectiveEffects = effective?.effects || {};

    const effects = Array.from(effectsMap.values());

    const layerInfos = new Map();
    for (const effect of effects) {
      const name = String(effect?.layer?.name || 'Other');
      const order = Number.isFinite(effect?.layer?.order) ? effect.layer.order : 9999;
      const prev = layerInfos.get(name);
      if (!prev || order < prev.order) {
        layerInfos.set(name, { name, order });
      }
    }

    const layersSorted = Array.from(layerInfos.values()).sort((a, b) => {
      const ao = Number(a?.order) || 0;
      const bo = Number(b?.order) || 0;
      if (ao !== bo) return ao - bo;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });

    const sections = new Map();
    for (const li of layersSorted) {
      const id = `layer:${li.name}`;
      sections.set(li.name, makeSection(id, li.name));
    }

    const query = String(this._effectFilterState.query || '').trim().toLowerCase();

    const effectsSorted = Array.from(effects);
    effectsSorted.sort((a, b) => {
      const ao = Number.isFinite(a?.layer?.order) ? a.layer.order : 9999;
      const bo = Number.isFinite(b?.layer?.order) ? b.layer.order : 9999;
      if (ao !== bo) return ao - bo;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

    const sectionCounts = new Map();

    for (const effect of effectsSorted) {
      const effectId = String(effect?.id || '');
      if (!effectId) continue;

      const savedEnabled = (effectiveEffects?.[effectId]?.enabled);
      const isEnabled = (typeof savedEnabled === 'boolean') ? savedEnabled : !!effect.enabled;

      if (this._effectFilterState.enabledOnly && !isEnabled) continue;
      if (query && !effectId.toLowerCase().includes(query)) continue;

      const chips = [];
      if (effect?.layer?.name) chips.push(String(effect.layer.name));
      chips.push(isEnabled ? 'enabled' : 'disabled');

      const subtitle = `id: ${effectId}`;

      const layerName = String(effect?.layer?.name || 'Other');
      const sec = sections.get(layerName) || { body: root, count: null };

      const row = this._appendToggleRow(sec.body, {
        title: effectId,
        subtitle,
        chips,
        value: isEnabled,
        onToggle: async (next) => {
          await this._applyEffectEnabled(effectId, next);
          await this._persistEffectEnabled(effectId, next);
        }
      });

      if (!row) continue;

      sectionCounts.set(layerName, (sectionCounts.get(layerName) || 0) + 1);
    }

    for (const [layerName, count] of sectionCounts.entries()) {
      const sec = sections.get(layerName);
      if (sec?.count) sec.count.textContent = String(count);
    }
  }

  async _applyEffectEnabled(effectId, enabled) {
    try {
      const composer = window.MapShine?.effectComposer;
      const effect = composer?.effects?.get?.(effectId);
      if (!effect) return;

      if (typeof effect.applyParamChange === 'function') {
        effect.applyParamChange('enabled', !!enabled);
      } else {
        effect.enabled = !!enabled;
      }
    } catch (e) {
    }
  }

  async _persistEffectEnabled(effectId, enabled) {
    try {
      const scene = canvas?.scene;
      if (!scene) return;

      if (game.user?.isGM) {
        const allSettings = scene.getFlag('map-shine-advanced', 'settings') || {
          mapMaker: { enabled: true, effects: {} },
          gm: null,
          player: {}
        };

        const mode = window.MapShine?.uiManager?.settingsMode || 'mapMaker';
        if (mode === 'gm') {
          if (!allSettings.gm) allSettings.gm = { effects: {} };
          if (!allSettings.gm.effects) allSettings.gm.effects = {};
          const prev = allSettings.gm.effects[effectId] || {};
          allSettings.gm.effects[effectId] = { ...prev, enabled: !!enabled };
        } else {
          if (!allSettings.mapMaker) allSettings.mapMaker = { enabled: true, effects: {} };
          if (!allSettings.mapMaker.effects) allSettings.mapMaker.effects = {};
          const prev = allSettings.mapMaker.effects[effectId] || {};
          allSettings.mapMaker.effects[effectId] = { ...prev, enabled: !!enabled };
        }

        await scene.setFlag('map-shine-advanced', 'settings', allSettings);
      } else {
        const playerOverrides = sceneSettings.getPlayerOverrides(scene);
        playerOverrides[effectId] = !!enabled;
        await sceneSettings.savePlayerOverrides(scene, playerOverrides);
      }
    } catch (e) {
    }
  }

  _getMaskDebugOptions() {
    const registry = getEffectMaskRegistry();
    const out = {};

    for (const [maskId, def] of Object.entries(registry)) {
      const label = `${def?.suffix || maskId}`;
      out[label] = `${maskId}.scene`;
    }

    out['roofAlpha.screen'] = 'roofAlpha.screen';
    out['outdoors.screen'] = 'outdoors.screen';
    out['indoor.scene'] = 'indoor.scene';
    out['precipVisibility.screen'] = 'precipVisibility.screen';

    out['cloudShadow.screen'] = 'cloudShadow.screen';
    out['cloudShadowRaw.screen'] = 'cloudShadowRaw.screen';
    out['cloudDensity.screen'] = 'cloudDensity.screen';
    out['cloudShadowBlocker.screen'] = 'cloudShadowBlocker.screen';
    out['cloudTopBlocker.screen'] = 'cloudTopBlocker.screen';

    out['rainFlowMap.scene'] = 'rainFlowMap.scene';

    return out;
  }

  _setMaskDebugEnabled(enabled) {
    try {
      const composer = window.MapShine?.effectComposer;
      const effect = composer?.effects?.get?.('mask-debug');
      if (!effect) return;
      effect.applyParamChange?.('enabled', !!enabled);
    } catch (e) {
    }
  }

  _openMaskDebug(maskId) {
    try {
      const composer = window.MapShine?.effectComposer;
      const effect = composer?.effects?.get?.('mask-debug');
      if (!effect) {
        ui?.notifications?.warn?.('Mask Debug effect not available');
        return;
      }
      effect.applyParamChange?.('enabled', true);
      effect.applyParamChange?.('maskId', maskId);
      ui?.notifications?.info?.(`Mask Debug: ${maskId}`);
    } catch (e) {
      ui?.notifications?.warn?.('Failed to open Mask Debug');
    }
  }

  async refresh() {
    const sceneComposer = window.MapShine?.sceneComposer;
    const bundle = sceneComposer?.currentBundle;

    const maskCompositeInfo = sceneComposer?._maskCompositeInfo || null;
    const albedoCompositeInfo = sceneComposer?._albedoCompositeInfo || null;

    const warnings = [];

    const hasBackground = !!(canvas?.scene?.background?.src && String(canvas.scene.background.src).trim());
    const albedoSource = hasBackground ? 'Scene Background' : (albedoCompositeInfo?.enabled ? 'Composite Tiles' : 'None');

    this._summaryState.albedoSource = albedoSource;
    this._summaryState.maskSource = bundle?.basePath ? String(bundle.basePath) : '—';
    const maskCompositeEnabled = maskCompositeInfo?.enabled ? 'Yes' : 'No';
    const albedoCompositeEnabled = albedoCompositeInfo?.enabled ? 'Yes' : 'No';
    this._summaryState.compositeEnabled = `Masks:${maskCompositeEnabled} Albedo:${albedoCompositeEnabled}`;
    const segCount = (
      (maskCompositeInfo?.segments?.length || 0) ||
      (albedoCompositeInfo?.segments?.length || 0)
    );
    this._summaryState.compositeSegments = String(segCount || 0);

    const tiles = canvas?.scene?.tiles ? Array.from(canvas.scene.tiles) : [];
    this._summaryState.tileCount = tiles.length;

    if (!tiles.length) warnings.push('Scene has no tiles');

    if (!bundle?.masks?.length) warnings.push('No masks loaded in bundle');

    this._summaryState.warnings = warnings.join('; ');
    this._refreshSummaryDisplay();

    this._rebuildEffectsFolder();
    this._rebuildTilesFolder();

    this._buildEffectRows();
    const __dlp = debugLoadingProfiler;
    if (__dlp.debugMode) __dlp.begin('es.buildTileRows', 'finalize');
    const tileRows = await this._buildTileRows(tiles, maskCompositeInfo);
    if (__dlp.debugMode) __dlp.end('es.buildTileRows');
    this._lastReport = this._buildReport(tileRows, bundle, { maskCompositeInfo, albedoCompositeInfo });

    try {
      this.constrainToScreen();
    } catch (e) {
    }
  }

  _refreshSummaryDisplay() {
    try {
      if (this._summaryBindings.albedoSource) this._summaryBindings.albedoSource.value = this._summaryState.albedoSource;
      if (this._summaryBindings.maskSource) this._summaryBindings.maskSource.value = this._summaryState.maskSource;
      if (this._summaryBindings.compositeEnabled) this._summaryBindings.compositeEnabled.value = this._summaryState.compositeEnabled;
      if (this._summaryBindings.compositeSegments) this._summaryBindings.compositeSegments.value = this._summaryState.compositeSegments;
      if (this._summaryBindings.tileCount) this._summaryBindings.tileCount.value = String(this._summaryState.tileCount);
      if (this._summaryBindings.warnings) this._summaryBindings.warnings.value = this._summaryState.warnings || '';
    } catch (e) {
    }
  }

  _rebuildTilesFolder() {
    if (!this.pane) return;

    if (!this._tilesFolder) {
      this._tilesFolder = this.pane.addFolder({ title: 'Tiles', expanded: true });
      return;
    }

    try {
      const content = this._tilesFolder?.element?.querySelector?.('.tp-fldv_c') || this._tilesFolder?.element;
      if (content) content.innerHTML = '';
    } catch (e) {
    }
  }

  async _buildTileRows(tiles, maskCompositeInfo) {
    const registry = getEffectMaskRegistry();
    const maskIds = Object.keys(registry);

    const results = [];

    const folderEl = this._tilesFolder;
    const root = folderEl?.element?.querySelector?.('.tp-fldv_c') || folderEl?.element;
    if (!root) return results;

    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '8px';
    bar.style.alignItems = 'center';
    bar.style.margin = '6px 6px 10px 6px';

    const search = document.createElement('input');
    search.type = 'text';
    search.value = String(this._tileFilterState.query || '');
    search.placeholder = 'Search tiles (name, basePath, id)…';
    search.style.flex = '1 1 280px';
    search.style.minWidth = '240px';
    search.style.padding = '4px 8px';
    search.style.borderRadius = '8px';
    search.style.border = '1px solid rgba(255,255,255,0.12)';
    search.style.background = 'rgba(0,0,0,0.20)';
    search.style.color = 'inherit';

    const mkToggle = (label, key) => {
      const wrap = document.createElement('label');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.style.padding = '2px 8px';
      wrap.style.borderRadius = '999px';
      wrap.style.border = '1px solid rgba(255,255,255,0.12)';
      wrap.style.background = 'rgba(0,0,0,0.20)';
      wrap.style.cursor = 'pointer';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!this._tileFilterState[key];
      cb.style.cursor = 'pointer';

      const txt = document.createElement('span');
      txt.textContent = label;
      txt.style.fontSize = '11px';
      txt.style.opacity = '0.9';

      wrap.appendChild(cb);
      wrap.appendChild(txt);

      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        this._tileFilterState[key] = cb.checked;
        void this.saveState();
        this._scheduleRefresh();
      });
      return wrap;
    };

    search.addEventListener('keydown', (e) => e.stopPropagation());
    search.addEventListener('mousedown', (e) => e.stopPropagation());
    search.addEventListener('input', () => {
      this._tileFilterState.query = search.value;
      void this.saveState();
      this._scheduleRefresh();
    });

    bar.appendChild(search);
    bar.appendChild(mkToggle('Issues', 'issuesOnly'));
    bar.appendChild(mkToggle('Ground', 'showGround'));
    bar.appendChild(mkToggle('Overhead', 'showOverhead'));
    bar.appendChild(mkToggle('Roof', 'showRoof'));

    root.appendChild(bar);

    const makeSection = (id, titleText) => {
      const wrap = document.createElement('div');
      wrap.style.margin = '0 6px 10px 6px';
      wrap.style.border = '1px solid rgba(255,255,255,0.10)';
      wrap.style.borderRadius = '10px';
      wrap.style.background = 'rgba(255,255,255,0.03)';

      const head = document.createElement('div');
      head.style.display = 'flex';
      head.style.alignItems = 'center';
      head.style.justifyContent = 'space-between';
      head.style.padding = '6px 8px';
      head.style.cursor = 'pointer';

      const title = document.createElement('div');
      title.textContent = titleText;
      title.style.fontSize = '12px';
      title.style.fontWeight = '650';
      title.style.opacity = '0.95';

      const count = document.createElement('div');
      count.textContent = '0';
      count.style.fontSize = '11px';
      count.style.opacity = '0.7';

      head.appendChild(title);
      head.appendChild(count);

      const body = document.createElement('div');
      body.style.padding = '4px 0 6px 0';
      body.style.display = this._tileFilterState.expanded?.[id] ? 'block' : 'none';

      head.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      head.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !(this._tileFilterState.expanded?.[id]);
        if (!this._tileFilterState.expanded) this._tileFilterState.expanded = {};
        this._tileFilterState.expanded[id] = next;
        body.style.display = next ? 'block' : 'none';
        void this.saveState();
      });

      wrap.appendChild(head);
      wrap.appendChild(body);
      root.appendChild(wrap);

      return { wrap, head, body, count };
    };

    const secGround = makeSection('ground', 'Ground Tiles');
    const secOverhead = makeSection('overhead', 'Overhead Tiles');
    const secRoof = makeSection('roof', 'Roof Tiles');

    const fgElev = Number.isFinite(canvas?.scene?.foregroundElevation)
      ? canvas.scene.foregroundElevation
      : Number.POSITIVE_INFINITY;

    const basePaths = Array.from(new Set(
      tiles
        .map((t) => {
          const src = t?.texture?.src ? String(t.texture.src) : '';
          return src ? this._extractBasePath(src) : '';
        })
        .filter((p) => String(p || '').trim())
    ));

    for (const bp of basePaths) {
      if (this._bundleMaskCache.has(bp)) continue;
      const __dlp = debugLoadingProfiler;
      const __bpLabel = bp.split('/').pop() || bp;
      if (__dlp.debugMode) __dlp.begin(`es.loadBundle[${__bpLabel}]`, 'finalize');
      try {
        const res = await loadAssetBundle(bp, null, { skipBaseTexture: true, suppressProbeErrors: true });
        const masks = res?.bundle?.masks || [];
        const foundIds = new Set(masks.map((m) => m?.id).filter(Boolean));
        this._bundleMaskCache.set(bp, { foundIds, loadError: null });
      } catch (e) {
        this._bundleMaskCache.set(bp, { foundIds: new Set(), loadError: e });
      }
      if (__dlp.debugMode) __dlp.end(`es.loadBundle[${__bpLabel}]`);
    }

    const query = String(this._tileFilterState.query || '').trim().toLowerCase();

    const classify = (tileDoc) => {
      const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
      const isOverhead = Number.isFinite(fgElev) ? (elev >= fgElev) : false;
      const roofFlag = tileDoc?.getFlag?.('map-shine-advanced', 'overheadIsRoof') ?? tileDoc?.flags?.['map-shine-advanced']?.overheadIsRoof;
      const isRoof = isOverhead && !!roofFlag;
      const kind = isRoof ? 'roof' : (isOverhead ? 'overhead' : 'ground');
      return { elev, isOverhead, isRoof, kind };
    };

    const tilesSorted = Array.from(tiles);
    tilesSorted.sort((a, b) => {
      const sa = classify(a);
      const sb = classify(b);
      const order = (k) => (k === 'ground' ? 0 : (k === 'overhead' ? 1 : 2));
      const ok = order(sa.kind) - order(sb.kind);
      if (ok !== 0) return ok;
      const an = String(a?.texture?.src || '');
      const bn = String(b?.texture?.src || '');
      return an.localeCompare(bn);
    });

    let groundCount = 0;
    let overheadCount = 0;
    let roofCount = 0;

    for (const tileDoc of tilesSorted) {
      const src = tileDoc?.texture?.src ? String(tileDoc.texture.src) : '';
      const basePath = src ? this._extractBasePath(src) : '';

      const cls = classify(tileDoc);
      const elev = cls.elev;
      const isOverhead = cls.isOverhead;
      const kind = cls.kind;

      let compositeSegment = false;
      if (maskCompositeInfo?.enabled && Array.isArray(maskCompositeInfo.segments) && basePath) {
        compositeSegment = maskCompositeInfo.segments.some((s) => s?.basePath === basePath);
      }

      let found = [];
      let missing = [];
      let loadError = null;

      if (basePath) {
        const cached = this._bundleMaskCache.get(basePath) || null;
        const foundIds = cached?.foundIds || null;
        loadError = cached?.loadError || null;
        if (foundIds) {
          for (const id of maskIds) {
            if (foundIds.has(id)) found.push(id);
            else missing.push(id);
          }
        }
      }

      const title = src ? this._filename(src) : '(no src)';

      const chips = [];
      chips.push(kind);
      chips.push(`elev:${elev}`);
      if (tileDoc?.hidden) chips.push('hidden');
      if (compositeSegment) chips.push('composite');
      if (found.length) chips.push(`found:${found.length}`);
      if (missing.length) chips.push(`missing:${missing.length}`);
      if (loadError) chips.push('load-failed');

      const subtitleLines = [];
      if (basePath) subtitleLines.push(basePath);
      if (found.length) subtitleLines.push(`Found: ${found.map((id) => registry[id]?.suffix || id).join(' ')}`);
      if (loadError) subtitleLines.push('Failed to load masks for this tile');

      const subtitle = subtitleLines.join('\n');

      const moduleId = 'map-shine-advanced';
      const bypassFlag = tileDoc?.getFlag?.(moduleId, 'bypassEffects') ?? tileDoc?.flags?.[moduleId]?.bypassEffects;
      const cloudShadowsFlag = tileDoc?.getFlag?.(moduleId, 'cloudShadowsEnabled') ?? tileDoc?.flags?.[moduleId]?.cloudShadowsEnabled;
      const cloudTopsFlag = tileDoc?.getFlag?.(moduleId, 'cloudTopsEnabled') ?? tileDoc?.flags?.[moduleId]?.cloudTopsEnabled;
      const roofFlag = tileDoc?.getFlag?.(moduleId, 'overheadIsRoof') ?? tileDoc?.flags?.[moduleId]?.overheadIsRoof;
      const occludesWaterFlag = tileDoc?.getFlag?.(moduleId, 'occludesWater') ?? tileDoc?.flags?.[moduleId]?.occludesWater;
      const bypassEnabled = !!bypassFlag;
      const cloudShadowsEnabled = (cloudShadowsFlag === undefined) ? true : !!cloudShadowsFlag;
      const cloudTopsEnabled = (cloudTopsFlag === undefined) ? true : !!cloudTopsFlag;
      const overheadIsRoof = !!roofFlag;
      const occludesWater = (occludesWaterFlag === undefined) ? false : !!occludesWaterFlag;

      if (bypassEnabled) chips.push('bypass');
      if (!cloudShadowsEnabled) chips.push('noCloudShadow');
      if (!cloudTopsEnabled) chips.push('noCloudTop');

      const issues = !!loadError || (missing.length > 0);
      const matchQuery = !query || (
        title.toLowerCase().includes(query) ||
        basePath.toLowerCase().includes(query) ||
        String(tileDoc?.id || '').toLowerCase().includes(query)
      );

      if (!matchQuery) {
        results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
        continue;
      }
      if (this._tileFilterState.issuesOnly && !issues) {
        results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
        continue;
      }
      if (kind === 'ground' && !this._tileFilterState.showGround) {
        results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
        continue;
      }
      if (kind === 'overhead' && !this._tileFilterState.showOverhead) {
        results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
        continue;
      }
      if (kind === 'roof' && !this._tileFilterState.showRoof) {
        results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
        continue;
      }

      const targetBody = (kind === 'ground') ? secGround.body : (kind === 'overhead' ? secOverhead.body : secRoof.body);

      const rowEl = this._appendRowWithToggles(targetBody, {
        title,
        subtitle,
        chips,
        issueLevel: loadError ? 2 : (missing.length ? 1 : 0),
        toggles: [
          {
            id: 'bypassEffects',
            label: 'Bypass',
            value: bypassEnabled,
            onToggle: async (next) => {
              await tileDoc?.setFlag?.(moduleId, 'bypassEffects', !!next);
              try {
                const tm = window.MapShine?.tileManager;
                const data = tm?.tileSprites?.get?.(tileDoc?.id);
                if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
              } catch (e) {
              }
            }
          },
          ...(isOverhead ? [
            {
              id: 'overheadIsRoof',
              label: 'IsRoof',
              value: overheadIsRoof,
              onToggle: async (next) => {
                await tileDoc?.setFlag?.(moduleId, 'overheadIsRoof', !!next);
                try {
                  const tm = window.MapShine?.tileManager;
                  const data = tm?.tileSprites?.get?.(tileDoc?.id);
                  if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
                } catch (e) {
                }
              }
            }
          ] : []),
          {
            id: 'occludesWater',
            label: 'WaterOccludes',
            value: occludesWater,
            onToggle: async (next) => {
              await tileDoc?.setFlag?.(moduleId, 'occludesWater', !!next);
              try {
                const tm = window.MapShine?.tileManager;
                const data = tm?.tileSprites?.get?.(tileDoc?.id);
                if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
              } catch (e) {
              }
            }
          },
          {
            id: 'cloudShadowsEnabled',
            label: 'CloudShadows',
            value: cloudShadowsEnabled,
            onToggle: async (next) => {
              const v = !!next;
              const prior = cloudShadowsEnabled;
              try {
                if (tileDoc) {
                  if (!tileDoc.flags) tileDoc.flags = {};
                  if (!tileDoc.flags[moduleId]) tileDoc.flags[moduleId] = {};
                  tileDoc.flags[moduleId].cloudShadowsEnabled = v;
                }
              } catch (e) {
              }

              try {
                const tm = window.MapShine?.tileManager;
                const data = tm?.tileSprites?.get?.(tileDoc?.id);
                if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
              } catch (e) {
              }

              try {
                await tileDoc?.setFlag?.(moduleId, 'cloudShadowsEnabled', v);
              } catch (e) {
                try {
                  if (tileDoc) {
                    if (!tileDoc.flags) tileDoc.flags = {};
                    if (!tileDoc.flags[moduleId]) tileDoc.flags[moduleId] = {};
                    tileDoc.flags[moduleId].cloudShadowsEnabled = prior;
                  }
                } catch (_) {
                }
                try {
                  const tm = window.MapShine?.tileManager;
                  const data = tm?.tileSprites?.get?.(tileDoc?.id);
                  if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
                } catch (_) {
                }
                throw e;
              }
            }
          },
          {
            id: 'cloudTopsEnabled',
            label: 'CloudTops',
            value: cloudTopsEnabled,
            onToggle: async (next) => {
              const v = !!next;
              const prior = cloudTopsEnabled;
              try {
                if (tileDoc) {
                  if (!tileDoc.flags) tileDoc.flags = {};
                  if (!tileDoc.flags[moduleId]) tileDoc.flags[moduleId] = {};
                  tileDoc.flags[moduleId].cloudTopsEnabled = v;
                }
              } catch (e) {
              }

              try {
                const tm = window.MapShine?.tileManager;
                const data = tm?.tileSprites?.get?.(tileDoc?.id);
                if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
              } catch (e) {
              }

              try {
                await tileDoc?.setFlag?.(moduleId, 'cloudTopsEnabled', v);
              } catch (e) {
                try {
                  if (tileDoc) {
                    if (!tileDoc.flags) tileDoc.flags = {};
                    if (!tileDoc.flags[moduleId]) tileDoc.flags[moduleId] = {};
                    tileDoc.flags[moduleId].cloudTopsEnabled = prior;
                  }
                } catch (_) {
                }
                try {
                  const tm = window.MapShine?.tileManager;
                  const data = tm?.tileSprites?.get?.(tileDoc?.id);
                  if (data?.sprite) tm.updateSpriteTransform(data.sprite, tileDoc);
                } catch (_) {
                }
                throw e;
              }
            }
          }
        ],
        onClick: (e) => {
          e?.preventDefault?.();
          e?.stopPropagation?.();
          if (e?.shiftKey && basePath) {
            void this._copyTextToClipboard(basePath, `Copied: ${basePath}`);
            return;
          }
          if (e?.ctrlKey || e?.metaKey) {
            try {
              tileDoc?.sheet?.render?.(true);
            } catch (_) {
            }
            return;
          }
          if (e?.altKey) {
            try {
              const st = window.MapShine?.tileManager?.tileSprites?.get?.(tileDoc?.id)?.sprite;
              if (st) {
                st.visible = true;
              }
            } catch (_) {
            }
          }
          try {
            const cx = (Number(tileDoc?.x) || 0) + (Number(tileDoc?.width) || 0) / 2;
            const cy = (Number(tileDoc?.y) || 0) + (Number(tileDoc?.height) || 0) / 2;
            canvas?.animatePan?.({ x: cx, y: cy, duration: 250 });
          } catch (_) {
          }
          if (basePath) {
            void this._copyTextToClipboard(`${this._filename(basePath)}.(webp|png|jpg|jpeg)`, 'Copied expected pattern');
          }
        }
      });

      if (kind === 'ground') groundCount++;
      else if (kind === 'overhead') overheadCount++;
      else roofCount++;

      results.push({ tileId: tileDoc?.id || null, src, basePath, kind, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
    }

    secGround.count.textContent = String(groundCount);
    secOverhead.count.textContent = String(overheadCount);
    secRoof.count.textContent = String(roofCount);

    return results;
  }

  _scheduleRefresh() {
    try {
      if (this._refreshDebounce) clearTimeout(this._refreshDebounce);
      this._refreshDebounce = setTimeout(() => {
        this._refreshDebounce = null;
        void this.refresh();
      }, 120);
    } catch (_) {
      void this.refresh();
    }
  }

  _appendRowWithToggles(folder, opts) {
    const content = folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element || folder;
    if (!content) return null;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'flex-start';
    row.style.gap = '8px';
    row.style.padding = '6px 6px';
    row.style.margin = '4px 0';
    row.style.borderRadius = '8px';
    row.style.border = '1px solid rgba(255,255,255,0.10)';
    row.style.background = 'rgba(255,255,255,0.04)';
    row.style.cursor = 'pointer';
    row.style.userSelect = 'none';

    const issueLevel = Number(opts?.issueLevel) || 0;
    if (issueLevel >= 2) {
      row.style.border = '1px solid rgba(255,80,80,0.30)';
      row.style.background = 'rgba(255,80,80,0.06)';
    } else if (issueLevel === 1) {
      row.style.border = '1px solid rgba(255,200,80,0.22)';
      row.style.background = 'rgba(255,200,80,0.05)';
    }

    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.gap = '2px';
    col.style.minWidth = '0';
    col.style.width = '100%';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.alignItems = 'baseline';
    top.style.gap = '6px';
    top.style.minWidth = '0';

    const title = document.createElement('div');
    title.textContent = String(opts?.title || '');
    title.style.fontSize = '12px';
    title.style.fontWeight = '600';
    title.style.opacity = '0.95';
    title.style.whiteSpace = 'nowrap';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.minWidth = '0';
    title.style.flex = '1 1 auto';

    const chips = Array.isArray(opts?.chips) ? opts.chips.filter((c) => String(c || '').trim()) : [];
    const chipWrap = document.createElement('div');
    chipWrap.style.display = 'flex';
    chipWrap.style.flex = '0 0 auto';
    chipWrap.style.flexWrap = 'wrap';
    chipWrap.style.gap = '4px';
    chipWrap.style.justifyContent = 'flex-end';
    chipWrap.style.opacity = '0.9';

    const toggles = Array.isArray(opts?.toggles) ? opts.toggles : [];
    for (const t of toggles) {
      const label = String(t?.label || t?.id || '').trim();
      if (!label) continue;

      const pill = document.createElement('label');
      pill.style.display = 'inline-flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '4px';
      pill.style.fontSize = '10px';
      pill.style.lineHeight = '1.0';
      pill.style.padding = '2px 6px';
      pill.style.borderRadius = '999px';
      pill.style.border = '1px solid rgba(255,255,255,0.12)';
      pill.style.background = 'rgba(0,0,0,0.22)';
      pill.style.whiteSpace = 'nowrap';
      pill.style.cursor = 'pointer';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!t.value;
      cb.style.cursor = 'pointer';
      cb.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      cb.addEventListener('change', async () => {
        const prev = !cb.checked;
        try {
          if (typeof t?.onToggle === 'function') {
            await t.onToggle(cb.checked);
          }
          this._scheduleRefresh();
        } catch (e) {
          cb.checked = prev;
          try {
            const labelSafe = String(label || t?.id || 'toggle');
            ui.notifications?.error?.(`Map Shine: Failed to update ${labelSafe}. Check console.`);
          } catch (_) {
          }
          try {
            console.error('Map Shine tile toggle failed:', { toggle: label, id: t?.id }, e);
          } catch (_) {
          }
        }
      });

      const text = document.createElement('span');
      text.textContent = label;

      pill.appendChild(cb);
      pill.appendChild(text);
      chipWrap.appendChild(pill);
    }

    for (const c of chips) {
      const chip = document.createElement('span');
      chip.textContent = String(c);
      chip.style.fontSize = '10px';
      chip.style.lineHeight = '1.0';
      chip.style.padding = '2px 6px';
      chip.style.borderRadius = '999px';
      chip.style.border = '1px solid rgba(255,255,255,0.12)';
      chip.style.background = 'rgba(0,0,0,0.22)';
      chip.style.whiteSpace = 'nowrap';
      chipWrap.appendChild(chip);
    }

    top.appendChild(title);
    top.appendChild(chipWrap);

    const sub = document.createElement('div');
    sub.textContent = String(opts?.subtitle || '');
    sub.style.fontSize = '11px';
    sub.style.opacity = '0.65';
    sub.style.whiteSpace = 'pre-line';
    sub.style.overflow = 'hidden';
    sub.style.textOverflow = 'ellipsis';

    col.appendChild(top);
    col.appendChild(sub);
    row.appendChild(col);

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof opts?.onClick === 'function') {
          opts.onClick(e);
        }
      } catch (e) {
      }
    });

    row.addEventListener('mouseenter', () => {
      if (issueLevel >= 2) row.style.background = 'rgba(255,80,80,0.09)';
      else if (issueLevel === 1) row.style.background = 'rgba(255,200,80,0.08)';
      else row.style.background = 'rgba(255,255,255,0.06)';
    });
    row.addEventListener('mouseleave', () => {
      if (issueLevel >= 2) row.style.background = 'rgba(255,80,80,0.06)';
      else if (issueLevel === 1) row.style.background = 'rgba(255,200,80,0.05)';
      else row.style.background = 'rgba(255,255,255,0.04)';
    });

    content.appendChild(row);
    return row;
  }

  _buildReport(tileRows, bundle, compositeInfo) {
    const lines = [];

    lines.push('# Map Shine Effect Stack Report');
    lines.push('');

    const basePath = bundle?.basePath || '—';
    lines.push(`Bundle basePath: ${basePath}`);

    const maskInfo = compositeInfo?.maskCompositeInfo || null;
    const albedoInfo = compositeInfo?.albedoCompositeInfo || null;

    lines.push(`Composite masks: ${maskInfo?.enabled ? 'Yes' : 'No'}`);
    if (maskInfo?.enabled && Array.isArray(maskInfo.segments)) {
      lines.push(`Mask segments: ${maskInfo.segments.length}`);
      for (const s of maskInfo.segments) {
        lines.push(`- ${s?.basePath || '—'} | ${s?.src || '—'} | x ${s?.segX0 ?? '?'}..${s?.segX1 ?? '?'}`);
      }
    }

    lines.push(`Composite albedo: ${albedoInfo?.enabled ? 'Yes' : 'No'}`);
    if (albedoInfo?.enabled && Array.isArray(albedoInfo.segments)) {
      lines.push(`Albedo segments: ${albedoInfo.segments.length}`);
      for (const s of albedoInfo.segments) {
        lines.push(`- ${s?.basePath || '—'} | ${s?.src || '—'} | x ${s?.segX0 ?? '?'}..${s?.segX1 ?? '?'}`);
      }
    }

    lines.push('');
    lines.push('## Tiles');

    for (const r of tileRows) {
      const src = r?.src || '—';
      const bp = r?.basePath || '—';
      const flags = [
        r?.kind ? String(r.kind) : null,
        r?.isOverhead ? 'overhead' : null,
        r?.compositeSegment ? 'composite' : null,
        r?.loadError ? 'load-failed' : null
      ].filter(Boolean).join(', ');

      lines.push(`- ${src} | ${bp} | ${flags}`);
      if (Array.isArray(r?.found) && r.found.length) lines.push(`  - found: ${r.found.join(', ')}`);
      if (Array.isArray(r?.missing) && r.missing.length) lines.push(`  - missing: ${r.missing.join(', ')}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  _filename(path) {
    try {
      const p = String(path || '');
      const lastSlash = p.lastIndexOf('/');
      return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
    } catch (e) {
      return '';
    }
  }

  _extractBasePath(src) {
    const s = String(src || '');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > 0) return s.substring(0, lastDot);
    return s;
  }

  async _copyTextToClipboard(text, okMessage, failMessage) {
    const toCopy = String(text || '');
    if (!toCopy) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(toCopy);
        ui?.notifications?.info?.(okMessage || 'Copied to clipboard');
        return;
      }
      throw new Error('Clipboard API not available');
    } catch (error) {
      try {
        const ta = document.createElement('textarea');
        ta.value = toCopy;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        ui?.notifications?.info?.(okMessage || 'Copied to clipboard');
      } catch (e) {
        ui?.notifications?.warn?.(failMessage || 'Could not copy to clipboard. See console.');
        console.log(toCopy);
      }
    }
  }

  _appendRow(folder, opts) {
    const content = folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element;
    if (!content) return;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'flex-start';
    row.style.gap = '8px';
    row.style.padding = '6px 6px';
    row.style.margin = '4px 0';
    row.style.borderRadius = '8px';
    row.style.border = '1px solid rgba(255,255,255,0.10)';
    row.style.background = 'rgba(255,255,255,0.04)';
    row.style.cursor = 'pointer';
    row.style.userSelect = 'none';

    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.gap = '2px';
    col.style.minWidth = '0';
    col.style.width = '100%';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.alignItems = 'baseline';
    top.style.gap = '6px';
    top.style.minWidth = '0';

    const title = document.createElement('div');
    title.textContent = String(opts?.title || '');
    title.style.fontSize = '12px';
    title.style.fontWeight = '600';
    title.style.opacity = '0.95';
    title.style.whiteSpace = 'nowrap';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.minWidth = '0';
    title.style.flex = '1 1 auto';

    const chips = Array.isArray(opts?.chips) ? opts.chips.filter((c) => String(c || '').trim()) : [];
    const chipWrap = document.createElement('div');
    chipWrap.style.display = chips.length ? 'flex' : 'none';
    chipWrap.style.flex = '0 0 auto';
    chipWrap.style.flexWrap = 'wrap';
    chipWrap.style.gap = '4px';
    chipWrap.style.justifyContent = 'flex-end';
    chipWrap.style.opacity = '0.9';

    for (const c of chips) {
      const chip = document.createElement('span');
      chip.textContent = String(c);
      chip.style.fontSize = '10px';
      chip.style.lineHeight = '1.0';
      chip.style.padding = '2px 6px';
      chip.style.borderRadius = '999px';
      chip.style.border = '1px solid rgba(255,255,255,0.12)';
      chip.style.background = 'rgba(0,0,0,0.22)';
      chip.style.whiteSpace = 'nowrap';
      chipWrap.appendChild(chip);
    }

    top.appendChild(title);
    top.appendChild(chipWrap);

    const sub = document.createElement('div');
    sub.textContent = String(opts?.subtitle || '');
    sub.style.fontSize = '11px';
    sub.style.opacity = '0.65';
    sub.style.whiteSpace = 'pre-line';
    sub.style.overflow = 'hidden';
    sub.style.textOverflow = 'ellipsis';

    col.appendChild(top);
    col.appendChild(sub);

    row.appendChild(col);

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof opts?.onClick === 'function') {
          opts.onClick(e);
        }
      } catch (err) {
      }
    });

    row.addEventListener('mouseenter', () => {
      row.style.background = 'rgba(255,255,255,0.06)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'rgba(255,255,255,0.04)';
    });

    content.appendChild(row);
  }

  _appendToggleRow(folder, opts) {
    const content = folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element || folder;
    if (!content) return null;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'flex-start';
    row.style.gap = '8px';
    row.style.padding = '6px 6px';
    row.style.margin = '4px 0';
    row.style.borderRadius = '8px';
    row.style.border = '1px solid rgba(255,255,255,0.10)';
    row.style.background = 'rgba(255,255,255,0.04)';
    row.style.userSelect = 'none';

    const toggleWrap = document.createElement('div');
    toggleWrap.style.flex = '0 0 auto';
    toggleWrap.style.paddingTop = '2px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!opts?.value;
    checkbox.style.cursor = 'pointer';
    toggleWrap.appendChild(checkbox);

    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.gap = '2px';
    col.style.minWidth = '0';
    col.style.width = '100%';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.alignItems = 'baseline';
    top.style.gap = '6px';
    top.style.minWidth = '0';

    const title = document.createElement('div');
    title.textContent = String(opts?.title || '');
    title.style.fontSize = '12px';
    title.style.fontWeight = '600';
    title.style.opacity = '0.95';
    title.style.whiteSpace = 'nowrap';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.minWidth = '0';
    title.style.flex = '1 1 auto';

    const chips = Array.isArray(opts?.chips) ? opts.chips.filter((c) => String(c || '').trim()) : [];
    const chipWrap = document.createElement('div');
    chipWrap.style.display = chips.length ? 'flex' : 'none';
    chipWrap.style.flex = '0 0 auto';
    chipWrap.style.flexWrap = 'wrap';
    chipWrap.style.gap = '4px';
    chipWrap.style.justifyContent = 'flex-end';
    chipWrap.style.opacity = '0.9';

    for (const c of chips) {
      const chip = document.createElement('span');
      chip.textContent = String(c);
      chip.style.fontSize = '10px';
      chip.style.lineHeight = '1.0';
      chip.style.padding = '2px 6px';
      chip.style.borderRadius = '999px';
      chip.style.border = '1px solid rgba(255,255,255,0.12)';
      chip.style.background = 'rgba(0,0,0,0.22)';
      chip.style.whiteSpace = 'nowrap';
      chipWrap.appendChild(chip);
    }

    top.appendChild(title);
    top.appendChild(chipWrap);

    const sub = document.createElement('div');
    sub.textContent = String(opts?.subtitle || '');
    sub.style.fontSize = '11px';
    sub.style.opacity = '0.65';
    sub.style.whiteSpace = 'pre-line';
    sub.style.overflow = 'hidden';
    sub.style.textOverflow = 'ellipsis';

    col.appendChild(top);
    col.appendChild(sub);

    row.appendChild(toggleWrap);
    row.appendChild(col);

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    checkbox.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    checkbox.addEventListener('change', async () => {
      const prev = !checkbox.checked;
      try {
        if (typeof opts?.onToggle === 'function') {
          await opts.onToggle(checkbox.checked);
        }
        this._scheduleRefresh();
      } catch (e) {
        checkbox.checked = prev;
        try {
          ui.notifications?.error?.('Map Shine: Failed to update effect toggle. Check console.');
        } catch (_) {
        }
        try {
          console.error('Map Shine effect toggle failed:', opts?.title, e);
        } catch (_) {
        }
      }
    });

    row.addEventListener('mouseenter', () => {
      row.style.background = 'rgba(255,255,255,0.06)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'rgba(255,255,255,0.04)';
    });

    content.appendChild(row);
    return row;
  }

  async copyReportToClipboard() {
    const text = this._lastReport || '';
    if (!text) {
      ui?.notifications?.warn?.('No report available yet. Click Refresh first.');
      return;
    }

    await this._copyTextToClipboard(text, 'Effect stack report copied to clipboard');
  }

  makeDraggable() {
    const dragHandle = this.headerOverlay || this.pane?.element || this.container;
    if (!dragHandle) return;

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.style.cursor = 'move';

    const onMouseDown = (e) => {
      isDragging = true;
      hasDragged = false;
      startX = e.clientX;
      startY = e.clientY;

      const rect = this.container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
      this.container.style.left = `${startLeft}px`;
      this.container.style.top = `${startTop}px`;

      document.addEventListener('mousemove', onMouseMove, { capture: true });
      document.addEventListener('mouseup', onMouseUp, { capture: true });
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDragged = true;
      }

      this.container.style.left = `${startLeft + dx}px`;
      this.container.style.top = `${startTop + dy}px`;
    };

    const onMouseUp = (e) => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove, { capture: true });
      document.removeEventListener('mouseup', onMouseUp, { capture: true });

      if (hasDragged && e) {
        e.preventDefault();
        e.stopPropagation();
      }

      this.saveState();
    };

    dragHandle.addEventListener('mousedown', onMouseDown);

    dragHandle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  constrainToScreen() {
    const rect = this.container.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    if (rect.right > winWidth) {
      this.container.style.left = `${winWidth - rect.width - 20}px`;
    }
    if (rect.bottom > winHeight) {
      this.container.style.top = `${winHeight - rect.height - 20}px`;
    }
    if (rect.left < 0) {
      this.container.style.left = '20px';
    }
    if (rect.top < 0) {
      this.container.style.top = '20px';
    }
  }

  async loadState() {
    try {
      const state = game.settings.get('map-shine-advanced', 'effect-stack-state') || {};

      if (state.position) {
        this.container.style.left = state.position.left || 'auto';
        this.container.style.top = state.position.top || 'auto';
        this.container.style.right = state.position.right || '20px';
        this.container.style.bottom = state.position.bottom || '20px';
      } else {
        this.container.style.right = '20px';
        this.container.style.bottom = '20px';
      }

      if (state.tileFilterState && typeof state.tileFilterState === 'object') {
        const s = state.tileFilterState;
        this._tileFilterState.query = String(s.query || '');
        this._tileFilterState.issuesOnly = !!s.issuesOnly;
        this._tileFilterState.showGround = (s.showGround === undefined) ? true : !!s.showGround;
        this._tileFilterState.showOverhead = (s.showOverhead === undefined) ? true : !!s.showOverhead;
        this._tileFilterState.showRoof = (s.showRoof === undefined) ? true : !!s.showRoof;
        if (s.expanded && typeof s.expanded === 'object') {
          this._tileFilterState.expanded = { ...this._tileFilterState.expanded, ...s.expanded };
        }
      }

      if (state.effectFilterState && typeof state.effectFilterState === 'object') {
        const s = state.effectFilterState;
        this._effectFilterState.query = String(s.query || '');
        this._effectFilterState.enabledOnly = !!s.enabledOnly;
        if (s.expanded && typeof s.expanded === 'object') {
          this._effectFilterState.expanded = { ...this._effectFilterState.expanded, ...s.expanded };
        }
      }

      if (state.selectedMaskId) {
        this._selectedMaskId = String(state.selectedMaskId);
      }
    } catch (e) {
      this.container.style.right = '20px';
      this.container.style.bottom = '20px';
    }
  }

  async saveState() {
    try {
      const state = {
        position: {
          left: this.container.style.left,
          top: this.container.style.top,
          right: this.container.style.right,
          bottom: this.container.style.bottom
        },
        tileFilterState: this._tileFilterState,
        effectFilterState: this._effectFilterState,
        selectedMaskId: this._selectedMaskId
      };
      await game.settings.set('map-shine-advanced', 'effect-stack-state', state);
    } catch (e) {
    }
  }

  dispose() {
    if (this.pane) {
      this.pane.dispose();
    }
    if (this.container) {
      this.container.remove();
    }
  }
}
