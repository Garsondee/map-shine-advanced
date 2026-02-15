/**
 * @fileoverview Diagnostic Center Dialog (Tweakpane)
 *
 * The Diagnostic Center is a user-facing debugging tool intended to surface
 * silent failure points across the rendering pipeline.
 *
 * v1 scope:
 * - Select a tile (or fall back to scene background) and run diagnostics.
 * - Provide a copyable report with PASS/WARN/FAIL/INFO checks.
 *
 * @module ui/diagnostic-center-dialog
 */

import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry, loadAssetBundle, probeMaskFile, clearCache } from '../assets/loader.js';

const log = createLogger('DiagnosticCenter');

function _extractBasePath(src) {
  const s = String(src || '').split('?')[0].split('#')[0];
  const lastDot = s.lastIndexOf('.');
  if (lastDot > 0) return s.substring(0, lastDot);
  return s;
}

function _filename(path) {
  try {
    const p = String(path || '');
    const lastSlash = p.lastIndexOf('/');
    return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  } catch (_) {
    return '';
  }
}

async function _probeMaskFile(basePath, suffix) {
  try {
    return await probeMaskFile(basePath, suffix, { suppressProbeErrors: true });
  } catch (_) {
    return null;
  }
}

async function _copyTextToClipboard(text, okMessage, failMessage) {
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

function _getSelectedTileDoc() {
  try {
    // Foundry convention: controlled tiles live on canvas.tiles.
    const controlled = canvas?.tiles?.controlled;
    if (Array.isArray(controlled) && controlled.length > 0) {
      const t = controlled[0];
      return t?.document || t?.doc || null;
    }
  } catch (_) {
  }
  return null;
}

function _getBackgroundSrc() {
  try {
    const src = canvas?.scene?.background?.src;
    const s = (src && String(src).trim()) ? String(src).trim() : '';
    return s || '';
  } catch (_) {
    return '';
  }
}

function _mkCheck(category, id, status, message, details = null) {
  const entry = { category, id, status, message };
  if (details !== null && details !== undefined) entry.details = details;
  return entry;
}

function _summarizeChecks(checks) {
  const out = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) {
    const s = String(c?.status || '').toUpperCase();
    if (s === 'PASS') out.pass++;
    else if (s === 'WARN') out.warn++;
    else if (s === 'FAIL') out.fail++;
    else out.info++;
  }
  return out;
}

export class DiagnosticCenterDialog {
  /**
   * @param {import('./diagnostic-center.js').DiagnosticCenterManager} manager
   */
  constructor(manager) {
    this.manager = manager;

    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this._targetBar = null;

    /** @type {HTMLElement|null} */
    this._reportRoot = null;

    /** @type {boolean} */
    this.visible = false;

    this._state = {
      targetKind: 'auto', // auto | tile | background
      targetId: '',
      targetLabel: '—'
    };

    this._lastReport = null;
  }

  async initialize(parentElement = document.body) {
    if (this.pane) return;

    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    this.container = document.createElement('div');
    this.container.id = 'map-shine-diagnostic-center';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10010';
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none';
    this.container.style.minWidth = '760px';
    this.container.style.maxWidth = '1100px';
    this.container.style.maxHeight = '80vh';
    this.container.style.overflowY = 'auto';
    parentElement.appendChild(this.container);

    // Prevent pointer interaction with the scene behind the panel.
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

      const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this.pane = new Tweakpane.Pane({
      title: 'Diagnostic Center',
      container: this.container,
      expanded: true
    });

    try {
      if (this.pane?.element) {
        this.pane.element.style.maxHeight = '100%';
        this.pane.element.style.overflowY = 'auto';
      }
    } catch (_) {
    }

    const targetFolder = this.pane.addFolder({ title: 'Target', expanded: true });
    this._buildTargetBar(targetFolder);

    const actionsFolder = this.pane.addFolder({ title: 'Actions', expanded: true });

    // Compact 2-column button grid (matches shared UI shell pattern).
    {
      const contentElement = actionsFolder?.element?.querySelector?.('.tp-fldv_c') || actionsFolder?.element;
      if (contentElement) {
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gap = '4px';
        grid.style.padding = '4px 6px 6px 6px';

        const addGridButton = (label, onClick, danger = false) => {
          const btn = document.createElement('button');
          btn.textContent = label;
          btn.style.padding = '4px 8px';
          btn.style.borderRadius = '6px';
          btn.style.border = danger ? '1px solid rgba(255,80,80,0.35)' : '1px solid rgba(255,255,255,0.14)';
          btn.style.background = danger ? 'rgba(255,60,60,0.12)' : 'rgba(255,255,255,0.08)';
          btn.style.color = danger ? '#ff9090' : 'inherit';
          btn.style.cursor = 'pointer';
          btn.style.fontSize = '11px';
          btn.style.fontWeight = '500';
          btn.addEventListener('click', onClick);
          grid.appendChild(btn);
        };

        addGridButton('Select Target', async () => {
          await this._autoSelectTarget();
        });

        addGridButton('Run Diagnostics', async () => {
          await this.runDiagnostics();
        });

        addGridButton('Copy Report', async () => {
          if (!this._lastReport) {
            ui?.notifications?.warn?.('Diagnostic Center: no report yet');
            return;
          }
          await _copyTextToClipboard(JSON.stringify(this._lastReport, null, 2), 'Copied diagnostic report');
        });

        addGridButton('Clear Cache', async () => {
          try {
            clearCache();
            ui?.notifications?.info?.('Map Shine: Asset cache cleared');
          } catch (e) {
            ui?.notifications?.warn?.('Map Shine: Failed to clear asset cache (see console)');
            try {
              console.warn('[MapShine] Failed to clear asset cache', e);
            } catch (_) {
            }
          }
        }, true);

        contentElement.appendChild(grid);

        // Scope note — diagnostics are read-only, runtime-only.
        const scopeNote = document.createElement('div');
        scopeNote.textContent = 'Diagnostics are read-only and do not modify scene data.';
        scopeNote.style.fontSize = '10px';
        scopeNote.style.opacity = '0.55';
        scopeNote.style.padding = '4px 6px 2px 6px';
        scopeNote.style.fontStyle = 'italic';
        contentElement.appendChild(scopeNote);
      }
    }

    const reportFolder = this.pane.addFolder({ title: 'Report', expanded: true });
    this._reportRoot = this._getFolderContentEl(reportFolder);

    if (this._reportRoot) {
      const empty = document.createElement('div');
      empty.textContent = 'No report yet. Click “Run Diagnostics”.';
      empty.style.opacity = '0.75';
      empty.style.padding = '6px 6px 10px 6px';
      this._reportRoot.appendChild(empty);
    }

    // Resolve initial target.
    await this._autoSelectTarget();

    // Start hidden.
    this.hide();

    log.info('Diagnostic Center dialog initialized');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;

    // Refresh target label when opened.
    void this._autoSelectTarget();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
  }

  /**
   * If a tile is selected, target that. Otherwise, if a scene background image
   * exists, target the background surface.
   *
   * This matches the requested UX.
   * @private
   */
  async _autoSelectTarget() {
    const tileDoc = _getSelectedTileDoc();
    if (tileDoc?.id) {
      this._state.targetKind = 'tile';
      this._state.targetId = String(tileDoc.id);
      this._state.targetLabel = `Tile: ${tileDoc.name || tileDoc.id}`;
      this._refreshTargetBar();
      return;
    }

    const bgSrc = _getBackgroundSrc();
    if (bgSrc) {
      this._state.targetKind = 'background';
      this._state.targetId = 'scene:background';
      this._state.targetLabel = `Background: ${_filename(bgSrc)}`;
      this._refreshTargetBar();
      return;
    }

    this._state.targetKind = 'auto';
    this._state.targetId = '';
    this._state.targetLabel = 'No tile selected and scene has no background image';
    this._refreshTargetBar();
  }

  _getFolderContentEl(folder) {
    try {
      return folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element || null;
    } catch (_) {
      return null;
    }
  }

  _buildTargetBar(folder) {
    const root = this._getFolderContentEl(folder);
    if (!root) return;

    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '8px';
    bar.style.alignItems = 'center';
    bar.style.margin = '6px 6px 10px 6px';

    const label = document.createElement('div');
    label.style.fontSize = '12px';
    label.style.fontWeight = '650';
    label.style.opacity = '0.95';
    label.textContent = 'Target:';

    const value = document.createElement('div');
    value.className = 'map-shine-diagnostic-target-label';
    value.style.flex = '1 1 auto';
    value.style.minWidth = '240px';
    value.style.padding = '4px 8px';
    value.style.borderRadius = '8px';
    value.style.border = '1px solid rgba(255,255,255,0.12)';
    value.style.background = 'rgba(0,0,0,0.20)';
    value.style.whiteSpace = 'nowrap';
    value.style.overflow = 'hidden';
    value.style.textOverflow = 'ellipsis';

    bar.appendChild(label);
    bar.appendChild(value);
    root.appendChild(bar);

    this._targetBar = bar;
    this._refreshTargetBar();
  }

  _refreshTargetBar() {
    try {
      const el = this._targetBar?.querySelector?.('.map-shine-diagnostic-target-label');
      if (!el) return;
      el.textContent = String(this._state.targetLabel || '—');
    } catch (_) {
    }
  }

  async runDiagnostics() {
    if (!this.pane) return;

    // Ensure we obey the requested fallback behavior.
    if (!this._state.targetId || this._state.targetKind === 'auto') {
      await this._autoSelectTarget();
    }

    const report = await this._buildReport();
    this._lastReport = report;
    this._renderReport(report);
  }

  async _buildReport() {
    const checks = [];

    const ms = window.MapShine;
    const surfaceReport = ms?.surfaceRegistry?.refresh?.() || ms?.surfaceReport || null;

    const now = Date.now();

    // Resolve target.
    let targetKind = this._state.targetKind;
    let targetId = this._state.targetId;

    let src = '';
    let basePath = '';

    if (targetKind === 'tile') {
      const tileDoc = canvas?.scene?.tiles?.get?.(targetId);
      if (!tileDoc) {
        checks.push(_mkCheck('Tile', 'tile.exists', 'FAIL', `TileDocument not found for id=${targetId}`));
      } else {
        checks.push(_mkCheck('Tile', 'tile.exists', 'PASS', 'TileDocument found'));
        const s = tileDoc?.texture?.src ? String(tileDoc.texture.src).trim() : '';
        src = s;
        basePath = s ? _extractBasePath(s) : '';
        if (src) checks.push(_mkCheck('Tile', 'tile.texture.src', 'PASS', src));
        else checks.push(_mkCheck('Tile', 'tile.texture.src', 'FAIL', 'Tile has no texture src'));

        // Basic bypass flag.
        const moduleId = 'map-shine-advanced';
        const bypass = tileDoc?.getFlag?.(moduleId, 'bypassEffects') ?? tileDoc?.flags?.[moduleId]?.bypassEffects;
        if (bypass) {
          checks.push(_mkCheck('Flags', 'tile.flags.bypassEffects', 'WARN', 'Tile is set to bypass effects', { bypassEffects: true }));
        } else {
          checks.push(_mkCheck('Flags', 'tile.flags.bypassEffects', 'PASS', 'Tile is not bypassing effects', { bypassEffects: false }));
        }

        // Three sprite presence.
        try {
          const tm = ms?.tileManager;
          const sprite = tm?.tileSprites?.get?.(targetId)?.sprite || null;
          if (sprite) checks.push(_mkCheck('Three', 'three.sprite.exists', 'PASS', 'Three sprite exists for tile'));
          else checks.push(_mkCheck('Three', 'three.sprite.exists', 'FAIL', 'No Three sprite found for tile (TileManager may not have synced)'));
        } catch (e) {
          checks.push(_mkCheck('Three', 'three.sprite.exists', 'FAIL', 'Error checking tile Three sprite', { error: String(e?.message || e) }));
        }
      }
    } else if (targetKind === 'background') {
      const bgSrc = _getBackgroundSrc();
      if (!bgSrc) {
        checks.push(_mkCheck('Scene', 'scene.background.src', 'FAIL', 'Scene has no background src'));
      } else {
        src = bgSrc;
        basePath = _extractBasePath(bgSrc);
        checks.push(_mkCheck('Scene', 'scene.background.src', 'PASS', bgSrc));

        const hasBasePlane = !!ms?.sceneComposer?.getBasePlane?.();
        checks.push(_mkCheck('Three', 'three.background.exists', hasBasePlane ? 'PASS' : 'FAIL', hasBasePlane ? 'Base plane exists' : 'Base plane missing'));
      }

      // Surface registry entry.
      if (surfaceReport?.surfaces) {
        const entry = surfaceReport.surfaces.find((s) => s?.surfaceId === 'scene:background');
        if (entry) {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'PASS', 'Surface report includes scene:background', entry));
        } else {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'WARN', 'Surface report missing scene:background'));
        }
      } else {
        checks.push(_mkCheck('Surface', 'surface.report.exists', 'WARN', 'Surface report not available'));
      }
    }

    // BasePath / mask discovery (common).
    if (src) {
      checks.push(_mkCheck('Assets', 'asset.basePath', basePath ? 'PASS' : 'WARN', basePath || 'No basePath could be derived'));
    }

    const registry = getEffectMaskRegistry();
    const knownMaskIds = Object.keys(registry);

    if (basePath) {
      try {
        const res = await loadAssetBundle(basePath, null, {
          skipBaseTexture: true,
          suppressProbeErrors: true,
          bypassCache: true
        });
        const masks = res?.bundle?.masks || [];
        const foundIds = new Set(masks.map((m) => String(m?.id || '')).filter(Boolean));

        if (Array.isArray(res?.warnings) && res.warnings.length) {
          checks.push(_mkCheck('Assets', 'asset.bundle.warnings', 'WARN', `Asset loader warnings: ${res.warnings.length}`, {
            warnings: res.warnings
          }));
        }

        checks.push(_mkCheck('Assets', 'asset.bundle.load', 'PASS', `Loaded mask bundle for ${basePath}`, {
          found: masks.map((m) => ({ id: m?.id, suffix: m?.suffix, path: m?.path }))
        }));

        // Report key masks explicitly.
        // IMPORTANT: loader mask ids are registry keys ('specular', 'water', ...), not suffix strings.
        const keyMaskIds = ['specular', 'roughness', 'normal', 'outdoors', 'fire', 'water'];
        for (const maskId of keyMaskIds) {
          const suffix = registry?.[maskId]?.suffix || '';
          const present = foundIds.has(maskId);
          if (present) {
            const entry = masks.find((m) => m?.id === maskId) || null;
            checks.push(_mkCheck('Assets', `asset.mask.loaded.${maskId}`, 'PASS', `Loaded ${suffix || maskId}`, {
              id: maskId,
              suffix,
              path: entry?.path ?? null
            }));
          } else {
            // Probe expected filenames to detect "exists but not loaded" failure points.
            let probe = null;
            if (suffix) {
              probe = await _probeMaskFile(basePath, suffix);
            }

            if (probe?.path) {
              checks.push(_mkCheck('Assets', `asset.mask.unloaded.${maskId}`, 'FAIL', `Mask file exists but was not loaded: ${suffix}`, {
                id: maskId,
                suffix,
                probedPath: probe.path
              }));
            } else {
              checks.push(_mkCheck('Assets', `asset.mask.missing.${maskId}`, 'INFO', `Missing ${suffix || maskId}`, {
                id: maskId,
                suffix
              }));
            }
          }
        }

        // Also report any unknown-to-registry masks.
        const unknown = Array.from(foundIds).filter((id) => !knownMaskIds.includes(id));
        if (unknown.length) {
          checks.push(_mkCheck('Assets', 'asset.mask.unknown', 'INFO', `Found ${unknown.length} unregistered mask(s)`, { unknown }));
        }
      } catch (e) {
        checks.push(_mkCheck('Assets', 'asset.bundle.load', 'FAIL', `Failed to load mask bundle for ${basePath}` , {
          error: String(e?.message || e)
        }));
      }
    } else if (src) {
      checks.push(_mkCheck('Assets', 'asset.bundle.load', 'SKIP', 'No basePath available; skipping mask bundle discovery'));
    }

    // Surface report existence.
    if (surfaceReport?.surfaces) {
      checks.push(_mkCheck('Surface', 'surface.report.exists', 'PASS', 'Surface report available'));

      if (targetKind === 'tile' && targetId) {
        const entry = surfaceReport.surfaces.find((s) => s?.surfaceId === targetId);
        if (entry) {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'PASS', 'Surface report includes tile', entry));
        } else {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'WARN', 'Surface report missing tile entry'));
        }
      }
    } else {
      checks.push(_mkCheck('Surface', 'surface.report.exists', 'WARN', 'Surface report not available'));
    }

    const summary = _summarizeChecks(checks);

    return {
      version: 1,
      time: now,
      target: {
        kind: targetKind,
        id: targetId,
        src,
        basePath
      },
      summary,
      checks
    };
  }

  _renderReport(report) {
    const root = this._reportRoot;
    if (!root) return;

    try {
      root.innerHTML = '';
    } catch (_) {
      // If innerHTML fails, we still attempt to append.
    }

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.flexWrap = 'wrap';
    header.style.gap = '8px';
    header.style.alignItems = 'center';
    header.style.margin = '6px 6px 10px 6px';

    const mkChip = (text, bg, border) => {
      const chip = document.createElement('span');
      chip.textContent = String(text);
      chip.style.fontSize = '11px';
      chip.style.lineHeight = '1.0';
      chip.style.padding = '4px 8px';
      chip.style.borderRadius = '999px';
      chip.style.border = border || '1px solid rgba(255,255,255,0.12)';
      chip.style.background = bg || 'rgba(0,0,0,0.22)';
      chip.style.whiteSpace = 'nowrap';
      return chip;
    };

    const s = report?.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
    header.appendChild(mkChip(`PASS ${s.pass}`, 'rgba(70, 200, 120, 0.10)', '1px solid rgba(70, 200, 120, 0.25)'));
    header.appendChild(mkChip(`WARN ${s.warn}`, 'rgba(255, 200, 80, 0.10)', '1px solid rgba(255, 200, 80, 0.25)'));
    header.appendChild(mkChip(`FAIL ${s.fail}`, 'rgba(255, 80, 80, 0.10)', '1px solid rgba(255, 80, 80, 0.25)'));
    header.appendChild(mkChip(`INFO ${s.info}`, 'rgba(255,255,255,0.06)'));

    const targetLine = document.createElement('div');
    targetLine.style.flex = '1 1 100%';
    targetLine.style.opacity = '0.85';
    targetLine.style.fontSize = '11px';
    targetLine.style.whiteSpace = 'pre-wrap';
    targetLine.textContent = `Target: ${report?.target?.kind || '—'} | ${report?.target?.id || '—'}\n${report?.target?.src || ''}`;

    root.appendChild(header);
    root.appendChild(targetLine);

    const groups = new Map();
    for (const c of (report?.checks || [])) {
      const cat = String(c?.category || 'Other');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(c);
    }

    const order = ['Tile', 'Scene', 'Flags', 'Three', 'Surface', 'Assets', 'Other'];
    const cats = Array.from(groups.keys());
    cats.sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });

    const mkRow = (check) => {
      const row = document.createElement('div');
      row.style.margin = '6px 6px';
      row.style.padding = '6px 8px';
      row.style.borderRadius = '10px';
      row.style.border = '1px solid rgba(255,255,255,0.10)';
      row.style.background = 'rgba(255,255,255,0.03)';

      const st = String(check?.status || 'INFO').toUpperCase();
      if (st === 'FAIL') {
        row.style.border = '1px solid rgba(255,80,80,0.30)';
        row.style.background = 'rgba(255,80,80,0.06)';
      } else if (st === 'WARN') {
        row.style.border = '1px solid rgba(255,200,80,0.28)';
        row.style.background = 'rgba(255,200,80,0.05)';
      } else if (st === 'PASS') {
        row.style.border = '1px solid rgba(70,200,120,0.20)';
        row.style.background = 'rgba(70,200,120,0.04)';
      }

      const top = document.createElement('div');
      top.style.display = 'flex';
      top.style.gap = '8px';
      top.style.alignItems = 'baseline';

      const badge = document.createElement('span');
      badge.textContent = st;
      badge.style.fontSize = '10px';
      badge.style.fontWeight = '700';
      badge.style.opacity = '0.9';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '999px';
      badge.style.border = '1px solid rgba(255,255,255,0.14)';
      badge.style.background = 'rgba(0,0,0,0.18)';

      const id = document.createElement('span');
      id.textContent = String(check?.id || '');
      id.style.fontSize = '11px';
      id.style.opacity = '0.85';

      top.appendChild(badge);
      top.appendChild(id);

      const msg = document.createElement('div');
      msg.textContent = String(check?.message || '');
      msg.style.fontSize = '12px';
      msg.style.opacity = '0.95';
      msg.style.marginTop = '4px';
      msg.style.whiteSpace = 'pre-wrap';

      row.appendChild(top);
      row.appendChild(msg);

      if (check?.details !== undefined) {
        const details = document.createElement('pre');
        details.textContent = JSON.stringify(check.details, null, 2);
        details.style.margin = '6px 0 0 0';
        details.style.padding = '6px 8px';
        details.style.borderRadius = '8px';
        details.style.border = '1px solid rgba(255,255,255,0.08)';
        details.style.background = 'rgba(0,0,0,0.18)';
        details.style.fontSize = '10px';
        details.style.opacity = '0.85';
        details.style.maxHeight = '140px';
        details.style.overflow = 'auto';
        row.appendChild(details);
      }

      return row;
    };

    for (const cat of cats) {
      const catHeader = document.createElement('div');
      catHeader.textContent = cat;
      catHeader.style.margin = '14px 6px 6px 6px';
      catHeader.style.fontSize = '12px';
      catHeader.style.fontWeight = '700';
      catHeader.style.opacity = '0.9';
      root.appendChild(catHeader);

      const list = groups.get(cat) || [];
      for (const c of list) root.appendChild(mkRow(c));
    }
  }
}
