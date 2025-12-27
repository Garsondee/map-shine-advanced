/**
 * @fileoverview Texture Manager UI for Map Shine Advanced
 * Provides a dedicated interface for managing textures and material assets
 * @module ui/texture-manager
 */

import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry } from '../assets/loader.js';

const log = createLogger('TextureManager');

export class TextureManagerUI {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {Tweakpane.Pane|null} */
    this.foundPane = null;

    /** @type {Tweakpane.Pane|null} */
    this.catalogPane = null;
    
    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this.columnsContainer = null;

    /** @type {HTMLElement|null} */
    this.foundPaneContainer = null;

    /** @type {HTMLElement|null} */
    this.catalogPaneContainer = null;
    
    /** @type {HTMLElement|null} Custom header overlay for dragging */
    this.headerOverlay = null;
    
    /** @type {boolean} */
    this.visible = false;
    
    /** @type {Object} Saved state */
    this.state = {
      position: { left: '50%', top: '50%' },
      expanded: true
    };

    this._summaryState = {
      basePath: '—',
      foundTotal: 0,
      foundAssetMasks: 0,
      foundRenderTargets: 0,
      foundDerived: 0,
      warnings: ''
    };

    this._summaryBindings = {};

    this._lastReport = '';
  }

  _formatSourceLabel(source) {
    if (source === 'assetMask') return 'Asset';
    if (source === 'renderTarget') return 'RT';
    if (source === 'derived') return 'Derived';
    if (typeof source === 'string' && source) return source;
    return '';
  }

  _formatUsedByLine(usedBy) {
    const s = String(usedBy || '').trim();
    if (!s) return '';
    return `Used: ${s}`;
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

  _createPreviewElement(texture) {
    const wrap = document.createElement('div');
    wrap.style.width = '34px';
    wrap.style.height = '34px';
    wrap.style.borderRadius = '6px';
    wrap.style.overflow = 'hidden';
    wrap.style.flex = '0 0 auto';
    wrap.style.border = '1px solid rgba(255,255,255,0.15)';
    wrap.style.background = 'rgba(255,255,255,0.05)';

    const img = texture?.image;
    const canvas = document.createElement('canvas');
    canvas.width = 34;
    canvas.height = 34;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, 34, 34);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, 0, 34, 1);
      ctx.fillRect(0, 0, 1, 34);
      ctx.fillRect(0, 33, 34, 1);
      ctx.fillRect(33, 0, 1, 34);
    }
    wrap.appendChild(canvas);

    const draw = () => {
      try {
        if (!ctx || !img) return;
        const w = img.width || img.videoWidth || img.naturalWidth || 0;
        const h = img.height || img.videoHeight || img.naturalHeight || 0;
        if (!w || !h) return;
        ctx.clearRect(0, 0, 34, 34);
        const s = Math.min(w, h);
        const sx = Math.floor((w - s) / 2);
        const sy = Math.floor((h - s) / 2);
        ctx.drawImage(img, sx, sy, s, s, 0, 0, 34, 34);
      } catch (e) {
      }
    };

    if (img && typeof img === 'object') {
      if (img.complete === true || img.readyState >= 2 || img.width || img.height) {
        draw();
      } else if (typeof img.addEventListener === 'function') {
        img.addEventListener('load', draw, { once: true });
      }
    }

    return wrap;
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

    const preview = opts?.previewEl || this._createPreviewElement(opts?.texture || null);
    row.appendChild(preview);

    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.gap = '2px';
    col.style.minWidth = '0';

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

  /**
   * Initialize the Texture Manager UI
   */
  async initialize() {
    if (this.pane) return;

    log.info('Initializing Texture Manager UI...');

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'map-shine-texture-manager';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10005'; // Above main UI
    this.container.style.display = 'none';
    this.container.style.minWidth = '780px';
    this.container.style.maxWidth = '1100px';
    // Default position: bottom-right, similar to main UI
    this.container.style.right = '20px';
    this.container.style.bottom = '20px';
    document.body.appendChild(this.container);

    // Create pane
    this.pane = new Tweakpane.Pane({
      title: 'Texture Manager',
      container: this.container,
      expanded: true
    });

    // Create a transparent header overlay to act as a drag handle,
    // mirroring the behavior of the main UI
    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-texture-manager-header-overlay';
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

    this._summaryBindings.basePath = summaryFolder.addBlade({
      view: 'text',
      label: 'Base Path',
      parse: (v) => v,
      value: this._summaryState.basePath,
      disabled: true
    });

    this._summaryBindings.foundTotal = summaryFolder.addBlade({
      view: 'text',
      label: 'Found (Total)',
      parse: (v) => v,
      value: String(this._summaryState.foundTotal),
      disabled: true
    });

    this._summaryBindings.foundAssetMasks = summaryFolder.addBlade({
      view: 'text',
      label: 'Asset Masks',
      parse: (v) => v,
      value: String(this._summaryState.foundAssetMasks),
      disabled: true
    });

    this._summaryBindings.foundRenderTargets = summaryFolder.addBlade({
      view: 'text',
      label: 'Render Targets',
      parse: (v) => v,
      value: String(this._summaryState.foundRenderTargets),
      disabled: true
    });

    this._summaryBindings.foundDerived = summaryFolder.addBlade({
      view: 'text',
      label: 'Derived',
      parse: (v) => v,
      value: String(this._summaryState.foundDerived),
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

    this.columnsContainer = document.createElement('div');
    this.columnsContainer.className = 'map-shine-texture-manager-columns';
    this.columnsContainer.style.display = 'grid';
    this.columnsContainer.style.gridTemplateColumns = '1fr 1fr';
    this.columnsContainer.style.gap = '10px';
    this.columnsContainer.style.marginTop = '8px';

    const paneContent = this.pane.element.querySelector('.tp-pnlv_c') || this.pane.element;
    paneContent.appendChild(this.columnsContainer);

    this.foundPaneContainer = document.createElement('div');
    this.foundPaneContainer.className = 'map-shine-texture-manager-col map-shine-texture-manager-found';
    this.columnsContainer.appendChild(this.foundPaneContainer);

    this.catalogPaneContainer = document.createElement('div');
    this.catalogPaneContainer.className = 'map-shine-texture-manager-col map-shine-texture-manager-catalog';
    this.columnsContainer.appendChild(this.catalogPaneContainer);

    this._rebuildColumnPanes();

    // Load saved state
    await this.loadState();

    // Enable dragging
    this.makeDraggable();

    await this.refresh();

    log.info('Texture Manager UI initialized');
  }

  /**
   * Toggle visibility
   */
  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    
    if (this.visible) {
      // Ensure it's on screen
      this.constrainToScreen();

      void this.refresh();
    }
  }

  _rebuildColumnPanes() {
    try {
      if (this.foundPane) this.foundPane.dispose();
    } catch (e) {
    }
    try {
      if (this.catalogPane) this.catalogPane.dispose();
    } catch (e) {
    }

    this.foundPaneContainer.innerHTML = '';
    this.catalogPaneContainer.innerHTML = '';

    this.foundPane = new Tweakpane.Pane({
      title: 'Found Textures',
      container: this.foundPaneContainer,
      expanded: true
    });

    this.catalogPane = new Tweakpane.Pane({
      title: 'Available / Missing',
      container: this.catalogPaneContainer,
      expanded: true
    });
  }

  async refresh() {
    const mm = window.MapShine?.maskManager;
    const sceneComposer = window.MapShine?.sceneComposer;
    const basePath = sceneComposer?.currentBundle?.basePath || '—';

    const ids = (mm && typeof mm.listIds === 'function') ? mm.listIds() : [];
    const records = [];
    for (const id of ids) {
      try {
        const rec = mm.getRecord(id);
        if (rec) records.push(rec);
      } catch (e) {
      }
    }

    const counts = {
      total: records.length,
      assetMask: 0,
      renderTarget: 0,
      derived: 0
    };

    for (const r of records) {
      if (r?.source === 'assetMask') counts.assetMask++;
      else if (r?.source === 'renderTarget') counts.renderTarget++;
      else if (r?.source === 'derived') counts.derived++;
    }

    const warnings = [];
    const hasOutdoors = !!(mm && (mm.getTexture?.('outdoors.scene') || mm.getTexture?.('outdoors.screen')));
    if (!hasOutdoors) warnings.push('No _Outdoors mask found');

    this._summaryState.basePath = basePath;
    this._summaryState.foundTotal = counts.total;
    this._summaryState.foundAssetMasks = counts.assetMask;
    this._summaryState.foundRenderTargets = counts.renderTarget;
    this._summaryState.foundDerived = counts.derived;
    this._summaryState.warnings = warnings.join('; ');
    this._refreshSummaryDisplay();

    this._rebuildColumnPanes();
    this._buildFoundPane(records);
    this._buildCatalogPane(mm, basePath);

    this._lastReport = this._buildReport(records, basePath);
  }

  _refreshSummaryDisplay() {
    try {
      if (this._summaryBindings.basePath) this._summaryBindings.basePath.value = this._summaryState.basePath;
      if (this._summaryBindings.foundTotal) this._summaryBindings.foundTotal.value = String(this._summaryState.foundTotal);
      if (this._summaryBindings.foundAssetMasks) this._summaryBindings.foundAssetMasks.value = String(this._summaryState.foundAssetMasks);
      if (this._summaryBindings.foundRenderTargets) this._summaryBindings.foundRenderTargets.value = String(this._summaryState.foundRenderTargets);
      if (this._summaryBindings.foundDerived) this._summaryBindings.foundDerived.value = String(this._summaryState.foundDerived);
      if (this._summaryBindings.warnings) this._summaryBindings.warnings.value = this._summaryState.warnings || '';
    } catch (e) {
    }
  }

  _buildFoundPane(records) {
    const pane = this.foundPane;
    if (!pane) return;

    const byCategory = {
      scene: [],
      screen: [],
      other: []
    };

    for (const r of records) {
      const id = r?.id || '';
      if (id.endsWith('.scene')) byCategory.scene.push(r);
      else if (id.endsWith('.screen')) byCategory.screen.push(r);
      else byCategory.other.push(r);
    }

    const addRec = (folder, rec) => {
      const id = rec?.id || '';
      const source = rec?.source || 'unknown';
      const space = rec?.space || 'unknown';
      const size = (rec?.width && rec?.height) ? `${rec.width}x${rec.height}` : '—';
      const channels = rec?.channels || '—';
      const usedBy = this._getUsedByLabel(id);
      const usedByLine = this._formatUsedByLine(usedBy);
      const subtitle = usedByLine || '';
      const tex = rec?.texture || null;

      const chips = [];
      const srcLabel = this._formatSourceLabel(source);
      if (srcLabel) chips.push(srcLabel);
      if (size && size !== '—') chips.push(size);
      if (channels && channels !== '—' && channels !== '-') chips.push(`ch:${channels}`);
      if (id.endsWith('.scene') && space && space !== 'unknown' && space !== 'sceneUv') chips.push(space);
      if (id.endsWith('.screen') && space && space !== 'unknown' && space !== 'screenUv') chips.push(space);
      if (!id.endsWith('.scene') && !id.endsWith('.screen') && space && space !== 'unknown') chips.push(space);

      this._appendRow(folder, {
        title: id,
        subtitle,
        chips,
        texture: tex,
        onClick: (e) => {
          if (e?.shiftKey) {
            this._openMaskDebug(id);
            return;
          }
          void this._copyTextToClipboard(id, `Copied: ${id}`);
        }
      });
    };

    const sceneFolder = pane.addFolder({ title: 'Scene Masks (*.scene)', expanded: true });
    for (const r of byCategory.scene.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      addRec(sceneFolder, r);
    }

    const screenFolder = pane.addFolder({ title: 'Screen Masks (*.screen)', expanded: true });
    for (const r of byCategory.screen.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      addRec(screenFolder, r);
    }

    const otherFolder = pane.addFolder({ title: 'Other', expanded: false });
    for (const r of byCategory.other.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      addRec(otherFolder, r);
    }
  }

  _buildCatalogPane(mm, basePath) {
    const pane = this.catalogPane;
    if (!pane) return;

    const registry = getEffectMaskRegistry();
    const baseFilename = this._getBaseFilename(basePath);
    const formatHint = `${baseFilename}SUFFIX.(webp|png|jpg|jpeg)`;

    pane.addBlade({
      view: 'text',
      label: 'Pattern',
      parse: (v) => v,
      value: formatHint,
      disabled: true
    });

    const foundFolder = pane.addFolder({ title: 'Found', expanded: true });
    const missingFolder = pane.addFolder({ title: 'Missing', expanded: true });

    for (const [maskId, def] of Object.entries(registry)) {
      const suffix = def?.suffix || '';
      const expected = `${baseFilename}${suffix}.(webp|png|jpg|jpeg)`;
      const idScene = `${maskId}.scene`;
      const rec = mm?.getRecord?.(idScene) || null;
      const isFound = !!(rec || mm?.getTexture?.(idScene));
      const desc = def?.description || '';
      const usedBy = this._getCatalogUsedBy(maskId);
      const usedByLine = this._formatUsedByLine(usedBy);
      const subtitle = usedByLine ? `${desc}\n${usedByLine}` : desc;

      const folder = isFound ? foundFolder : missingFolder;
      this._appendRow(folder, {
        title: suffix,
        subtitle,
        texture: rec?.texture || null,
        onClick: (e) => {
          if (isFound && e?.shiftKey) {
            this._openMaskDebug(idScene);
            return;
          }
          void this._copyTextToClipboard(expected, `Copied: ${expected}`);
        }
      });
    }
  }

  _getBaseFilename(basePath) {
    try {
      const p = String(basePath || '');
      const lastSlash = p.lastIndexOf('/');
      return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
    } catch (e) {
      return '';
    }
  }

  _getUsedByLabel(id) {
    const map = {
      'specular.scene': 'SpecularEffect',
      'roughness.scene': 'SpecularEffect',
      'normal.scene': 'SpecularEffect',
      'iridescence.scene': 'IridescenceEffect',
      'outdoors.scene': 'WeatherController / masking',
      'fire.scene': 'FireSparksEffect',
      'windows.scene': 'WindowLightEffect',
      'structural.scene': 'WindowLightEffect (legacy)',
      'roofAlpha.screen': 'LightingEffect roof alpha',
      'outdoors.screen': 'LightingEffect outdoors prepass',
      'windowLight.screen': 'WindowLightEffect output',
      'cloudShadow.screen': 'CloudEffect output',
      'cloudShadowRaw.screen': 'CloudEffect debug',
      'cloudDensity.screen': 'CloudEffect density',
      'indoor.scene': 'Derived from outdoors.scene',
      'roofVisible.screen': 'Derived from roofAlpha.screen',
      'roofClear.screen': 'Derived from roofVisible.screen',
      'precipVisibility.screen': 'Derived from outdoors.screen + roofClear.screen'
    };

    return map[id] || '';
  }

  _getCatalogUsedBy(maskId) {
    const map = {
      specular: 'SpecularEffect',
      roughness: 'SpecularEffect',
      normal: 'SpecularEffect',
      outdoors: 'Weather + indoor/outdoor masking',
      iridescence: 'IridescenceEffect',
      windows: 'WindowLightEffect',
      structural: 'WindowLightEffect (legacy)',
      fire: 'FireSparksEffect'
    };

    return map[maskId] || '';
  }

  _buildReport(records, basePath) {
    const lines = [];
    lines.push('# Map Shine Texture Report');
    lines.push('');
    lines.push(`Base Path: ${basePath || '—'}`);
    lines.push('');
    lines.push('## Found Textures');
    for (const r of records.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const id = r?.id || '';
      const source = r?.source || 'unknown';
      const space = r?.space || 'unknown';
      const size = (r?.width && r?.height) ? `${r.width}x${r.height}` : '—';
      const channels = r?.channels || '—';
      lines.push(`- ${id} | ${source} | ${space} | ${size} | ch:${channels}`);
    }

    lines.push('');
    lines.push('## Available / Missing');
    try {
      const registry = getEffectMaskRegistry();
      const baseFilename = this._getBaseFilename(basePath);
      const mm = window.MapShine?.maskManager;
      for (const [maskId, def] of Object.entries(registry)) {
        const suffix = def?.suffix || '';
        const expected = `${baseFilename}${suffix}.(webp|png|jpg|jpeg)`;
        const isFound = !!(mm && (mm.getRecord?.(`${maskId}.scene`) || mm.getTexture?.(`${maskId}.scene`)));
        lines.push(`- ${suffix} | ${isFound ? 'Found' : 'Missing'} | ${expected}`);
      }
    } catch (e) {
    }

    lines.push('');
    return lines.join('\n');
  }

  async copyReportToClipboard() {
    const text = this._lastReport || '';
    if (!text) {
      ui?.notifications?.warn?.('No report available yet. Click Refresh first.');
      return;
    }

    await this._copyTextToClipboard(text, 'Texture report copied to clipboard');
  }

  /**
   * Make the panel draggable
   * @private
   */
  makeDraggable() {
    // Prefer the custom header overlay if present, otherwise fall back to the pane
    const dragHandle = this.headerOverlay || this.pane?.element || this.container;
    if (!dragHandle) {
      log.warn('Could not find drag handle element for Texture Manager UI');
      return;
    }

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

      // Clear constrained positioning to allow free movement
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
      this.container.style.left = `${startLeft}px`;
      this.container.style.top = `${startTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
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
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
      if (hasDragged && e) {
        e.preventDefault();
        e.stopPropagation();
      }

      this.saveState();
    };

    dragHandle.addEventListener('mousedown', onMouseDown);

    // Prevent header clicks from triggering Tweakpane's default fold behavior;
    // folding (if desired) should be controlled by explicit UI controls.
    dragHandle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * Constrain container to screen bounds
   * @private
   */
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

  /**
   * Load state from client settings
   * @private
   */
  async loadState() {
    try {
      const state = game.settings.get('map-shine-advanced', 'texture-manager-state') || {};
      
      if (state.position) {
        this.container.style.left = state.position.left || 'auto';
        this.container.style.top = state.position.top || 'auto';
        this.container.style.right = state.position.right || '20px';
        this.container.style.bottom = state.position.bottom || '20px';
      } else {
        // Default position if no state is stored yet: bottom-right
        this.container.style.right = '20px';
        this.container.style.bottom = '20px';
      }
    } catch (e) {
      log.warn('Failed to load Texture Manager state:', e);
      // Fallback to default bottom-right
      this.container.style.right = '20px';
      this.container.style.bottom = '20px';
    }
  }

  /**
   * Save state to client settings
   * @private
   */
  async saveState() {
    try {
      const state = {
        position: {
          left: this.container.style.left,
          top: this.container.style.top,
          right: this.container.style.right,
          bottom: this.container.style.bottom
        }
      };
      await game.settings.set('map-shine-advanced', 'texture-manager-state', state);
    } catch (e) {
      log.warn('Failed to save Texture Manager state:', e);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.pane) {
      this.pane.dispose();
    }
    if (this.container) {
      this.container.remove();
    }
  }
}
