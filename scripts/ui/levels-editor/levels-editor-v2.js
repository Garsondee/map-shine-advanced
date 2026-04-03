/**
 * @fileoverview Levels Editor V2
 * @module ui/levels-editor/levels-editor-v2
 */
import { isGmLike } from '../../core/gm-parity.js';


import { createLogger } from '../../core/log.js';
import { getSceneBackgroundElevation, getSceneForegroundElevationTop } from '../../foundry/levels-scene-flags.js';
import {
  TILE_LEVEL_ROLES,
  normalizeSceneLevelBands,
  buildTileRoleRecords,
  createTileBandProjectionUpdate,
  createTileRoleFlagUpdate,
  migrateSceneTileRoles,
} from './levels-domain.js';
import { getUseLevelsEditorV2 } from '../../settings/scene-settings.js';

const log = createLogger('LevelsEditorV2');

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tileTitle(record) {
  const raw = String(record?.name || 'Tile');
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  return name || `Tile ${record?.id ?? ''}`;
}

function roleLabel(role) {
  if (role === TILE_LEVEL_ROLES.FLOOR) return 'Floor';
  if (role === TILE_LEVEL_ROLES.CEILING) return 'Ceiling';
  if (role === TILE_LEVEL_ROLES.FILLER) return 'Filler';
  return 'None';
}

function _toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatElev(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : '?';
}

function formatElevRange(lo, hi) {
  const a = formatElev(lo);
  const n = Number(hi);
  const b = (n === Infinity || n === -Infinity) ? '∞' : formatElev(hi);
  return `${a}..${b}`;
}

function sourceName(src, fallback = '(none)') {
  const path = String(src ?? '');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  if (!name) return fallback;
  return name.length > 64 ? `${name.slice(0, 61)}...` : name;
}

function deepCloneObject(value) {
  try {
    if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  } catch (_) {}
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch (_) {
    return { ...(value || {}) };
  }
}

/**
 * Partition tiles for vertical display: ceiling (top), mid (filler/none), floor (bottom).
 * @param {Array<object>} items
 * @returns {{ ceiling: Array, mid: Array, floor: Array }}
 */
function partitionTilesForVerticalStack(items) {
  const ceiling = [];
  const mid = [];
  const floor = [];
  for (const t of items) {
    if (t.role === TILE_LEVEL_ROLES.CEILING) ceiling.push(t);
    else if (t.role === TILE_LEVEL_ROLES.FLOOR) floor.push(t);
    else mid.push(t);
  }
  const sortFn = (a, b) => tileTitle(a).localeCompare(tileTitle(b));
  ceiling.sort(sortFn);
  mid.sort(sortFn);
  floor.sort(sortFn);
  return { ceiling, mid, floor };
}

export class LevelsEditorV2 {
  constructor() {
    this._visible = false;
    this._el = null;
    this._selectedTileId = null;
    this._migratedSceneId = null;
    this._boundLevelChanged = this._onLevelChanged.bind(this);
    this._boundClick = this._onClick.bind(this);
    this._boundChange = this._onChange.bind(this);
  }

  initialize() {
    Hooks.on('mapShineLevelContextChanged', this._boundLevelChanged);
  }

  destroy() {
    try {
      Hooks.off('mapShineLevelContextChanged', this._boundLevelChanged);
    } catch (_) {}
    if (this._el?.parentElement) this._el.parentElement.removeChild(this._el);
    this._el = null;
    this._visible = false;
  }

  show() {
    this._visible = true;
    const scene = this._currentScene();
    const sceneId = String(scene?.id || '');
    if (scene && sceneId && this._migratedSceneId !== sceneId) {
      this._migratedSceneId = sceneId;
      migrateSceneTileRoles(scene).catch((err) => {
        log.warn('Tile role migration skipped', err);
      });
    }
    this.render();
  }

  hide() {
    this._visible = false;
    if (this._el) this._el.style.display = 'none';
  }

  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  _onLevelChanged() {
    if (this._visible) this.render();
  }

  _ensureEl() {
    if (this._el) return this._el;
    const el = document.createElement('section');
    el.id = 'map-shine-levels-editor-v2';
    el.className = 'msa-levels-editor';
    el.addEventListener('click', this._boundClick);
    el.addEventListener('change', this._boundChange);
    document.body.appendChild(el);
    this._el = el;
    return el;
  }

  _currentScene() {
    return canvas?.scene ?? null;
  }

  _readSceneBackgroundSrc(scene) {
    return String(scene?.background?.src || scene?.img || '');
  }

  _readSceneForegroundSrc(scene) {
    const fg = scene?.foreground;
    if (typeof fg === 'string') return fg;
    if (fg && typeof fg === 'object' && typeof fg.src === 'string') return fg.src;
    return '';
  }

  _serializeBandsForSceneUpdate(bands) {
    if (!Array.isArray(bands)) return [];
    return bands.map((b, i) => ({
      label: String(b?.label ?? `Level ${i + 1}`),
      bottom: _toFinite(b?.bottom, 0),
      top: _toFinite(b?.top, 1),
    }));
  }

  _refreshRuntimeAfterAuthoringEdit() {
    try {
      window.MapShine?.cameraFollower?.refreshLevelBands?.({ emit: true, reason: 'levels-editor-v2-edit' });
    } catch (_) {}
    try {
      window.MapShine?.tileManager?._scheduleElevationVisibilityRefresh?.();
    } catch (_) {}
  }

  async _updateSceneLevels(sceneLevels, userMessage = '') {
    const scene = this._currentScene();
    if (!scene) return;
    if (!isGmLike()) {
      ui.notifications?.warn?.('Only the GM can edit level definitions.');
      return;
    }

    const levelsFlags = deepCloneObject(scene?.flags?.levels || {});
    levelsFlags.enabled = true;
    levelsFlags.sceneLevels = sceneLevels;

    await scene.update({ 'flags.levels': levelsFlags });
    this._refreshRuntimeAfterAuthoringEdit();
    if (userMessage) ui.notifications?.info?.(userMessage);
    this.render();
  }

  async _addLevelBand() {
    const scene = this._currentScene();
    if (!scene) return;
    const bands = normalizeSceneLevelBands(scene);
    const nextBottom = bands.length > 0
      ? Number((_toFinite(bands[bands.length - 1].top, 0) + 0.01).toFixed(2))
      : 0;
    const nextTop = Number((nextBottom + 20).toFixed(2));

    const next = this._serializeBandsForSceneUpdate(bands);
    next.push({
      label: `Level ${next.length + 1} (${Math.round(nextBottom)})`,
      bottom: nextBottom,
      top: nextTop,
    });
    await this._updateSceneLevels(next, 'Added a new level.');
  }

  async _saveBandDefinition(bandIndex) {
    const scene = this._currentScene();
    if (!scene) return;
    const row = this._el?.querySelector?.(`.msa-levels-editor__band[data-band-index="${Number(bandIndex)}"]`);
    if (!row) return;
    const bands = normalizeSceneLevelBands(scene);
    const target = bands[Number(bandIndex)];
    if (!target) return;

    const labelRaw = String(row.querySelector('[data-field="label"]')?.value ?? '').trim();
    const bottomRaw = row.querySelector('[data-field="bottom"]')?.value;
    const topRaw = row.querySelector('[data-field="top"]')?.value;
    const nextLabel = labelRaw || target.label || `Level ${target.index + 1}`;
    const nextBottom = Number(bottomRaw);
    let nextTop = Number(topRaw);

    if (!Number.isFinite(nextBottom)) {
      ui.notifications?.warn?.('Level bottom must be a number.');
      return;
    }
    if (!Number.isFinite(nextTop)) nextTop = nextBottom + 1;
    if (nextTop <= nextBottom) {
      nextTop = nextBottom + 1;
      ui.notifications?.warn?.('Level top must be above bottom. Top was adjusted.');
    }

    const next = this._serializeBandsForSceneUpdate(bands).map((b, i) => {
      if (i !== Number(bandIndex)) return b;
      return {
        label: nextLabel,
        bottom: Number(nextBottom.toFixed(2)),
        top: Number(nextTop.toFixed(2)),
      };
    });
    next.sort((a, b) => Number(a.bottom) - Number(b.bottom));
    await this._updateSceneLevels(next, `Saved level "${nextLabel}".`);
  }

  async _deleteBandDefinition(bandIndex) {
    const scene = this._currentScene();
    if (!scene) return;
    const bands = normalizeSceneLevelBands(scene);
    const idx = Number(bandIndex);
    const target = bands[idx];
    if (!target) return;
    const next = this._serializeBandsForSceneUpdate(bands.filter((_, i) => i !== idx));
    next.sort((a, b) => Number(a.bottom) - Number(b.bottom));
    await this._updateSceneLevels(next, `Deleted level "${target.label}".`);
  }

  async _saveGroundBackground() {
    const scene = this._currentScene();
    if (!scene) return;
    if (!isGmLike()) {
      ui.notifications?.warn?.('Only the GM can edit scene image elevations.');
      return;
    }
    const zone = this._el?.querySelector?.('.msa-levels-editor__zone--scene-floor');
    if (!zone) return;
    const bottom = Number(zone.querySelector('[data-field="bgBottom"]')?.value);
    let top = Number(zone.querySelector('[data-field="bgTop"]')?.value);
    if (!Number.isFinite(bottom)) {
      ui.notifications?.warn?.('Background bottom must be a number.');
      return;
    }
    if (!Number.isFinite(top)) {
      ui.notifications?.warn?.('Background top must be a number.');
      return;
    }
    if (top <= bottom) {
      top = Number((bottom + 0.01).toFixed(2));
      ui.notifications?.warn?.('Background top must be above bottom. Top was adjusted.');
    }
    const levelsFlags = deepCloneObject(scene?.flags?.levels || {});
    levelsFlags.backgroundElevation = Number(bottom.toFixed(2));
    try {
      await scene.update({
        foregroundElevation: Number(top.toFixed(2)),
        'flags.levels': levelsFlags,
      });
      this._refreshRuntimeAfterAuthoringEdit();
      ui.notifications?.info?.(`Scene background band saved (${formatElev(bottom)}..${formatElev(top)}).`);
      this.render();
    } catch (err) {
      log.warn('saveGroundBackground failed', err);
      ui.notifications?.error?.('Failed to save scene background elevations.');
    }
  }

  async _saveGroundForeground() {
    const scene = this._currentScene();
    if (!scene) return;
    if (!isGmLike()) {
      ui.notifications?.warn?.('Only the GM can edit scene image elevations.');
      return;
    }
    const zone = this._el?.querySelector?.('.msa-levels-editor__zone--scene-ceiling');
    if (!zone) return;
    const bottom = Number(zone.querySelector('[data-field="fgBottom"]')?.value);
    const topRaw = String(zone.querySelector('[data-field="fgTop"]')?.value ?? '').trim();
    let top = topRaw === '' ? Infinity : Number(topRaw);

    if (!Number.isFinite(bottom)) {
      ui.notifications?.warn?.('Foreground bottom must be a number.');
      return;
    }
    if (topRaw !== '' && !Number.isFinite(top)) {
      ui.notifications?.warn?.('Foreground top must be a number or empty (∞).');
      return;
    }

    const bgLo = getSceneBackgroundElevation(scene);
    if (bottom < bgLo) {
      ui.notifications?.warn?.('Foreground bottom is below background bottom; boundary may look wrong.');
    }

    if (Number.isFinite(top) && top <= bottom) {
      top = Number((bottom + 0.01).toFixed(2));
      ui.notifications?.warn?.('Foreground top must be above bottom. Top was adjusted.');
    }

    const levelsFlags = deepCloneObject(scene?.flags?.levels || {});
    if (!Number.isFinite(top) || top === Infinity) {
      delete levelsFlags.foregroundElevationTop;
    } else {
      levelsFlags.foregroundElevationTop = Number(top.toFixed(2));
    }

    try {
      await scene.update({
        foregroundElevation: Number(bottom.toFixed(2)),
        'flags.levels': levelsFlags,
      });
      this._refreshRuntimeAfterAuthoringEdit();
      const topMsg = Number.isFinite(top) && top !== Infinity ? formatElev(top) : '∞';
      ui.notifications?.info?.(`Scene foreground band saved (${formatElev(bottom)}..${topMsg}).`);
      this.render();
    } catch (err) {
      log.warn('saveGroundForeground failed', err);
      ui.notifications?.error?.('Failed to save scene foreground elevations.');
    }
  }

  _collectViewModel() {
    const scene = this._currentScene();
    const bands = normalizeSceneLevelBands(scene);
    const tiles = buildTileRoleRecords(scene);
    const byBand = new Map();
    for (let i = 0; i < bands.length; i += 1) byBand.set(i, []);
    for (const t of tiles) {
      const idx = Number.isInteger(t.bandIndex) ? t.bandIndex : -1;
      if (!byBand.has(idx)) byBand.set(idx, []);
      byBand.get(idx).push(t);
    }
    for (const arr of byBand.values()) {
      arr.sort((a, b) => String(a.role).localeCompare(String(b.role)) || tileTitle(a).localeCompare(tileTitle(b)));
    }
    const bgElevation = getSceneBackgroundElevation(scene);
    const fgElevation = _toFinite(scene?.foregroundElevation, 0);
    const fgElevationTop = getSceneForegroundElevationTop(scene);
    const backgroundSrc = this._readSceneBackgroundSrc(scene);
    const foregroundSrc = this._readSceneForegroundSrc(scene);
    if (!this._selectedTileId && tiles.length > 0) this._selectedTileId = tiles[0].id;
    return {
      scene,
      bands,
      tiles,
      byBand,
      bgElevation,
      fgElevation,
      fgElevationTop,
      backgroundSrc,
      foregroundSrc,
    };
  }

  render() {
    if (!this._visible) return;
    if (!getUseLevelsEditorV2()) return;
    const el = this._ensureEl();
    const vm = this._collectViewModel();
    const selected = vm.tiles.find((t) => t.id === this._selectedTileId) || null;
    el.style.display = '';

    const renderTileCard = (t) => {
      const selectedCls = t.id === this._selectedTileId ? ' is-selected' : '';
      const roleCls = ` role-${esc(t.role)}`;
      return [
        `<article class="msa-levels-editor__tile${selectedCls}${roleCls}" data-tile-id="${esc(t.id)}">`,
        `<div class="msa-levels-editor__tile-title">${esc(tileTitle(t))}</div>`,
        `<div class="msa-levels-editor__tile-meta">${esc(roleLabel(t.role))} | ${esc(`${t.rangeBottom}..${t.rangeTop}`)}</div>`,
        '<div class="msa-levels-editor__tile-actions">',
        `<button type="button" data-action="moveTile" data-tile-id="${esc(t.id)}" data-dir="1" title="Move to level above (higher elevation)">↑ Level</button>`,
        `<button type="button" data-action="moveTile" data-tile-id="${esc(t.id)}" data-dir="-1" title="Move to level below (lower elevation)">↓ Level</button>`,
        '</div>',
        '</article>',
      ].join('');
    };

    const renderZone = (label, tiles, emptyHint) => {
      const inner = tiles.length
        ? tiles.map((t) => renderTileCard(t)).join('')
        : `<div class="msa-levels-editor__zone-empty">${esc(emptyHint)}</div>`;
      return `<div class="msa-levels-editor__zone"><div class="msa-levels-editor__zone-label">${esc(label)}</div>${inner}</div>`;
    };

    const renderBandSection = (band, idx) => {
      const items = vm.byBand.get(idx) || [];
      const { ceiling, mid, floor } = partitionTilesForVerticalStack(items);
      const floorCount = floor.length;
      const ceilingCount = ceiling.length;
      const fillerCount = items.filter((t) => t.role === TILE_LEVEL_ROLES.FILLER).length;
      return [
        `<section class="msa-levels-editor__band msa-levels-editor__band--stacked" data-band-index="${idx}">`,
        `<header class="msa-levels-editor__band-header">`,
        `<div class="msa-levels-editor__band-label">${esc(band.label)}</div>`,
        `<div class="msa-levels-editor__band-range">${esc(`${band.bottom}..${band.top}`)} <span class="msa-levels-editor__band-range-hint">elevation</span></div>`,
        '</header>',
        '<div class="msa-levels-editor__band-editor">',
        `<label>Label <input type="text" data-field="label" value="${esc(band.label)}"></label>`,
        `<label>Bottom <input type="number" step="0.01" data-field="bottom" value="${esc(formatElev(band.bottom))}"></label>`,
        `<label>Top <input type="number" step="0.01" data-field="top" value="${esc(formatElev(band.top))}"></label>`,
        `<button type="button" data-action="saveLevel" data-band-index="${idx}">Save Level</button>`,
        `<button type="button" data-action="deleteLevel" data-band-index="${idx}" title="Remove this level">Delete Level</button>`,
        '</div>',
        `<div class="msa-levels-editor__band-stats">Tiles: ${items.length} | Floors: ${floorCount} | Ceilings: ${ceilingCount} | Fillers: ${fillerCount}</div>`,
        '<div class="msa-levels-editor__band-actions">',
        `<button type="button" data-action="assignRoleToSelected" data-role="floor" data-band-index="${idx}">Set Floor</button>`,
        `<button type="button" data-action="assignRoleToSelected" data-role="ceiling" data-band-index="${idx}">Set Ceiling</button>`,
        `<button type="button" data-action="assignRoleToSelected" data-role="filler" data-band-index="${idx}">Set Filler</button>`,
        '</div>',
        '<div class="msa-levels-editor__band-vertical">',
        renderZone('Ceiling (top of this level)', ceiling, 'No ceiling tiles'),
        renderZone('Between floor & ceiling', mid, 'No in-level tiles'),
        renderZone('Floor (bottom of this level)', floor, 'No floor tiles'),
        '</div>',
        '</section>',
      ].join('');
    };

    // Higher elevation toward top of panel; ground at bottom (architectural cross-section).
    const bandIndicesDesc = vm.bands.map((_, i) => i).reverse();
    const stack = bandIndicesDesc.map((idx) => renderBandSection(vm.bands[idx], idx)).join('');

    const unassigned = vm.byBand.get(-1) || [];
    const unassignedCards = unassigned.map((t) => {
      const selectedCls = t.id === this._selectedTileId ? ' is-selected' : '';
      return [
        `<article class="msa-levels-editor__tile${selectedCls}" data-tile-id="${esc(t.id)}">`,
        `<div class="msa-levels-editor__tile-title">${esc(tileTitle(t))}</div>`,
        `<div class="msa-levels-editor__tile-meta">Unassigned | ${esc(roleLabel(t.role))}</div>`,
        '</article>',
      ].join('');
    }).join('');

    const fgTopInputVal = Number.isFinite(vm.fgElevationTop) ? formatElev(vm.fgElevationTop) : '';

    const groundLayer = [
      '<section class="msa-levels-editor__ground-layer">',
      '<header class="msa-levels-editor__ground-header">',
      '<div class="msa-levels-editor__band-label">Ground (bottom of stack)</div>',
      '<div class="msa-levels-editor__band-range-hint">Scene images · boundary = foreground elevation</div>',
      '</header>',
      '<div class="msa-levels-editor__ground-vertical">',
      '<div class="msa-levels-editor__zone msa-levels-editor__zone--scene-ceiling">',
      '<div class="msa-levels-editor__zone-label">Scene foreground image</div>',
      `<div class="msa-levels-editor__ground-file">${esc(sourceName(vm.foregroundSrc, '(no foreground image)'))}</div>`,
      `<div class="msa-levels-editor__ground-range-hint">${esc(formatElevRange(vm.fgElevation, vm.fgElevationTop))}</div>`,
      '<div class="msa-levels-editor__ground-editor">',
      `<label>Bottom <input type="number" step="0.01" data-field="fgBottom" value="${esc(formatElev(vm.fgElevation))}" title="Lower bound; same as scene foreground elevation (overhead threshold)"></label>`,
      `<label>Top <input type="number" step="0.01" data-field="fgTop" value="${esc(fgTopInputVal)}" placeholder="∞" title="Upper bound; leave empty for unbounded (infinity)"></label>`,
      '<button type="button" data-action="saveGroundForeground">Save</button>',
      '</div>',
      '</div>',
      '<div class="msa-levels-editor__zone msa-levels-editor__zone--scene-floor">',
      '<div class="msa-levels-editor__zone-label">Scene background image</div>',
      `<div class="msa-levels-editor__ground-file">${esc(sourceName(vm.backgroundSrc, '(no scene background)'))}</div>`,
      `<div class="msa-levels-editor__ground-range-hint">${esc(formatElevRange(vm.bgElevation, vm.fgElevation))}</div>`,
      '<div class="msa-levels-editor__ground-editor">',
      `<label>Bottom <input type="number" step="0.01" data-field="bgBottom" value="${esc(formatElev(vm.bgElevation))}" title="Levels background elevation"></label>`,
      `<label>Top <input type="number" step="0.01" data-field="bgTop" value="${esc(formatElev(vm.fgElevation))}" title="Top of background band; sets scene foreground elevation (boundary with foreground image)"></label>`,
      '<button type="button" data-action="saveGroundBackground">Save</button>',
      '</div>',
      '</div>',
      '</div>',
      '</section>',
    ].join('');

    const toolbar = [
      '<div class="msa-levels-editor__toolbar">',
      '<button type="button" data-action="addLevel">Add Level</button>',
      `<div class="msa-levels-editor__toolbar-note">Levels: ${vm.bands.length} | Tiles: ${vm.tiles.length} | Unassigned: ${unassigned.length}</div>`,
      '</div>',
    ].join('');

    const inspector = selected
      ? [
        `<div><strong>${esc(tileTitle(selected))}</strong></div>`,
        `<div>ID: ${esc(selected.id)}</div>`,
        `<div>Role: ${esc(roleLabel(selected.role))}</div>`,
        `<div>Band: ${Number.isInteger(selected.bandIndex) ? esc(vm.bands[selected.bandIndex]?.label || 'Unknown') : 'Unassigned'}</div>`,
        `<div>Elevation: ${esc(formatElev(selected.elevation))}</div>`,
        `<div>Range: ${esc(`${formatElev(selected.rangeBottom)}..${formatElev(selected.rangeTop)}`)}</div>`,
        '<div class="msa-levels-editor__inspector-actions">',
        `<button type="button" data-action="setRole" data-tile-id="${esc(selected.id)}" data-role="none">Clear Role</button>`,
        `<button type="button" data-action="setRole" data-tile-id="${esc(selected.id)}" data-role="floor">Floor</button>`,
        `<button type="button" data-action="setRole" data-tile-id="${esc(selected.id)}" data-role="ceiling">Ceiling</button>`,
        `<button type="button" data-action="setRole" data-tile-id="${esc(selected.id)}" data-role="filler">Filler</button>`,
        '</div>',
      ].join('')
      : '<div>Select a tile card to edit role and level.</div>';

    const stackLegend = '<div class="msa-levels-editor__stack-legend">↑ Higher elevation · Ground at bottom</div>';
    const unassignedSection = [
      '<section class="msa-levels-editor__band msa-levels-editor__band--unassigned">',
      '<header class="msa-levels-editor__band-header">',
      '<div class="msa-levels-editor__band-label">Unassigned (no level band)</div>',
      `<div class="msa-levels-editor__band-range">${unassigned.length}</div>`,
      '</header>',
      `<div class="msa-levels-editor__band-body">${unassignedCards || '<div class="msa-levels-editor__empty">No unassigned tiles.</div>'}</div>`,
      '</section>',
    ].join('');

    el.innerHTML = [
      '<header class="msa-levels-editor__header">',
      '<h2>Levels Editor V2</h2>',
      '<div class="msa-levels-editor__subtitle">Vertical stack: higher levels at top, ground at bottom · each level shows ceiling → between → floor</div>',
      '<button type="button" data-action="close">Close</button>',
      '</header>',
      '<main class="msa-levels-editor__main">',
      `<section class="msa-levels-editor__stack msa-levels-editor__stack--vertical">${toolbar}${stackLegend}${unassignedSection}${stack || '<div class="msa-levels-editor__empty">No levels configured yet. Use "Add Level".</div>'}${groundLayer}</section>`,
      `<aside class="msa-levels-editor__inspector">${inspector}</aside>`,
      '</main>',
    ].join('');
  }

  async _applyRoleAndBand(tileId, role, bandIndex = null) {
    const scene = this._currentScene();
    const tileDoc = scene?.tiles?.get?.(tileId);
    if (!tileDoc) return;
    const band = Number.isInteger(bandIndex) ? normalizeSceneLevelBands(scene)[bandIndex] : null;
    const update = createTileRoleFlagUpdate(role, bandIndex);
    if (band) {
      const bandUpdate = createTileBandProjectionUpdate(tileDoc, band);
      update.elevation = bandUpdate.elevation;
      update.flags = {
        ...(bandUpdate.flags || {}),
        ...(update.flags || {}),
        levels: {
          ...(bandUpdate.flags?.levels || {}),
          ...(update.flags?.levels || {}),
        },
      };
    }
    await tileDoc.update(update);
  }

  async _moveTile(tileId, dir) {
    const scene = this._currentScene();
    const bands = normalizeSceneLevelBands(scene);
    const records = buildTileRoleRecords(scene);
    const r = records.find((it) => it.id === tileId);
    if (!r) return;
    const from = Number.isInteger(r.bandIndex) ? r.bandIndex : 0;
    const to = Math.max(0, Math.min(bands.length - 1, from + (dir >= 0 ? 1 : -1)));
    await this._applyRoleAndBand(tileId, r.role, to);
  }

  async _onClick(event) {
    const target = event.target?.closest?.('[data-action], [data-tile-id]');
    if (!target) return;
    const action = target.dataset.action;
    if (!action && target.dataset.tileId) {
      this._selectedTileId = String(target.dataset.tileId);
      this.render();
      return;
    }

    if (action === 'close') {
      this.hide();
      return;
    }
    if (action === 'setRole') {
      await this._applyRoleAndBand(String(target.dataset.tileId || ''), String(target.dataset.role || TILE_LEVEL_ROLES.NONE));
      this.render();
      return;
    }
    if (action === 'addLevel') {
      await this._addLevelBand();
      this.render();
      return;
    }
    if (action === 'saveLevel') {
      await this._saveBandDefinition(Number(target.dataset.bandIndex));
      this.render();
      return;
    }
    if (action === 'deleteLevel') {
      await this._deleteBandDefinition(Number(target.dataset.bandIndex));
      this.render();
      return;
    }
    if (action === 'assignRoleToSelected') {
      if (!this._selectedTileId) return;
      await this._applyRoleAndBand(
        this._selectedTileId,
        String(target.dataset.role || TILE_LEVEL_ROLES.NONE),
        Number(target.dataset.bandIndex)
      );
      this.render();
      return;
    }
    if (action === 'moveTile') {
      await this._moveTile(String(target.dataset.tileId || ''), Number(target.dataset.dir || 0));
      this.render();
      return;
    }
    if (action === 'saveGroundBackground') {
      await this._saveGroundBackground();
      return;
    }
    if (action === 'saveGroundForeground') {
      await this._saveGroundForeground();
    }
  }

  _onChange() {}
}

