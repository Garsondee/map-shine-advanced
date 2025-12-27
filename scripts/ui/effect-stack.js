import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry, loadAssetBundle } from '../assets/loader.js';

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
    this._lastReport = '';

    this._selectedMaskId = 'specular.scene';
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
    document.body.appendChild(this.container);

    this.pane = new Tweakpane.Pane({
      title: 'Effect Stack',
      container: this.container,
      expanded: true
    });

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

    this._tilesFolder = this.pane.addFolder({ title: 'Tiles', expanded: true });

    await this.loadState();
    this.makeDraggable();

    await this.refresh();

    log.info('Effect Stack UI initialized');
  }

  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';

    if (this.visible) {
      this.constrainToScreen();
      void this.refresh();
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

    this._rebuildTilesFolder();

    const tileRows = await this._buildTileRows(tiles, maskCompositeInfo);
    this._lastReport = this._buildReport(tileRows, bundle, { maskCompositeInfo, albedoCompositeInfo });
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

    for (const tileDoc of tiles) {
      const src = tileDoc?.texture?.src ? String(tileDoc.texture.src) : '';
      const basePath = src ? this._extractBasePath(src) : '';

      const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
      const fgElev = Number.isFinite(canvas?.scene?.foregroundElevation) ? canvas.scene.foregroundElevation : Number.POSITIVE_INFINITY;
      const isOverhead = Number.isFinite(fgElev) ? (elev >= fgElev) : false;

      let compositeSegment = false;
      if (maskCompositeInfo?.enabled && Array.isArray(maskCompositeInfo.segments) && basePath) {
        compositeSegment = maskCompositeInfo.segments.some((s) => s?.basePath === basePath);
      }

      let found = [];
      let missing = [];
      let loadError = null;

      if (basePath) {
        try {
          const res = await loadAssetBundle(basePath, null, { skipBaseTexture: true });
          const masks = res?.bundle?.masks || [];
          const foundIds = new Set(masks.map((m) => m?.id).filter(Boolean));

          for (const id of maskIds) {
            if (foundIds.has(id)) found.push(id);
            else missing.push(id);
          }
        } catch (e) {
          loadError = e;
        }
      }

      const title = src ? this._filename(src) : '(no src)';

      const chips = [];
      if (isOverhead) chips.push('overhead');
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

      this._appendRow(this._tilesFolder, {
        title,
        subtitle,
        chips,
        onClick: (e) => {
          e?.preventDefault?.();
          e?.stopPropagation?.();
          if (e?.shiftKey && basePath) {
            void this._copyTextToClipboard(basePath, `Copied: ${basePath}`);
            return;
          }
          if (basePath) {
            void this._copyTextToClipboard(`${this._filename(basePath)}.(webp|png|jpg|jpeg)`, 'Copied expected pattern');
          }
        }
      });

      results.push({ tileId: tileDoc?.id || null, src, basePath, isOverhead, compositeSegment, found, missing, loadError: !!loadError });
    }

    return results;
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
        }
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
