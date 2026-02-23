/**
 * @fileoverview Levels Authoring Dialog
 *
 * A GM-facing authoring tool for building and inspecting multi-level scenes.
 * Provides a level stack overview, tile-to-level inspector, validation
 * warnings, and quick actions for assigning tiles to elevation ranges.
 *
 * Opened from the Map Shine control panel or via `MapShine.levelsAuthoring.show()`.
 *
 * @module ui/levels-authoring-dialog
 */

import { createLogger } from '../core/log.js';
import {
  readSceneLevelsFlag,
  isLevelsEnabledForScene,
  readTileLevelsFlags,
  tileHasLevelsRange,
  readDocLevelsRange,
  getSceneBackgroundElevation,
  getSceneWeatherElevation,
} from '../foundry/levels-scene-flags.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../foundry/levels-compatibility.js';

const log = createLogger('LevelsAuthoring');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatElev(v) {
  if (v === Infinity || v === -Infinity) return String(v);
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(0) : '?';
}

function tileName(tileDoc) {
  const src = tileDoc?.texture?.src || tileDoc?.img || '';
  const lastSlash = src.lastIndexOf('/');
  const filename = lastSlash >= 0 ? src.slice(lastSlash + 1) : src;
  return filename || '(no texture)';
}

function tileSource(tileDoc) {
  return String(tileDoc?.texture?.src || tileDoc?.img || '');
}

function sourceName(src, fallback = '(no source)') {
  const path = String(src ?? '');
  const lastSlash = path.lastIndexOf('/');
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  if (!filename) return fallback;
  return filename.length > 48 ? `${filename.slice(0, 45)}...` : filename;
}

/**
 * Parse the scene's Levels data into a sorted array of level band objects.
 * Each band has { index, label, bottom, top }.
 */
function parseLevelBands(scene) {
  const raw = readSceneLevelsFlag(scene);
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

  const bands = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const bottom = Number(entry.bottom ?? entry.rangeBottom ?? -Infinity);
    const top = Number(entry.top ?? entry.rangeTop ?? Infinity);
    const label = entry.label || entry.name || `Level ${i + 1}`;
    bands.push({
      index: i,
      label,
      bottom: Number.isFinite(bottom) ? bottom : -Infinity,
      top: Number.isFinite(top) ? top : Infinity,
    });
  }

  // Sort by bottom elevation ascending
  bands.sort((a, b) => a.bottom - b.bottom);
  return bands;
}

/**
 * Determine which level band a tile belongs to based on its rangeBottom/rangeTop
 * overlapping the band. Returns the band index or -1 if unassigned.
 */
function assignTileToBand(tileDoc, bands) {
  if (!tileHasLevelsRange(tileDoc)) return -1;
  const flags = readTileLevelsFlags(tileDoc);
  const tBottom = flags.rangeBottom;
  const tTop = flags.rangeTop;

  // Find best-matching band: the band whose range most overlaps the tile's range
  let bestIdx = -1;
  let bestOverlap = -Infinity;

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const overlapBottom = Math.max(tBottom, b.bottom);
    const overlapTop = Math.min(tTop, b.top);
    const overlap = overlapTop - overlapBottom;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = b.index;
    }
  }

  // If tile center elevation is within a band, prefer that
  const tCenter = (Number.isFinite(tBottom) && Number.isFinite(tTop))
    ? (tBottom + tTop) / 2
    : tBottom;
  const containing = [];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (tCenter >= b.bottom && tCenter <= b.top) {
      const center = (Number(b.bottom) + Number(b.top)) * 0.5;
      containing.push({ band: b, distance: Math.abs(tCenter - center) });
    }
  }
  if (containing.length > 0) {
    containing.sort((a, b) => a.distance - b.distance || b.band.bottom - a.band.bottom);
    return containing[0].band.index;
  }

  return bestIdx >= 0 ? bestIdx : -1;
}

function assignDocToBand(doc, bands) {
  const range = readDocLevelsRange(doc);
  const fallback = Number(doc?.elevation ?? 0);
  const center = (Number.isFinite(range.rangeBottom) && Number.isFinite(range.rangeTop))
    ? (range.rangeBottom + range.rangeTop) * 0.5
    : (Number.isFinite(range.rangeBottom)
      ? range.rangeBottom
      : (Number.isFinite(range.rangeTop)
        ? range.rangeTop
        : (Number.isFinite(fallback) ? fallback : 0)));

  for (const b of bands) {
    if (center >= b.bottom && center <= b.top) return b.index;
  }
  return -1;
}

function docDisplayName(kind, doc) {
  const fallback = `${String(kind || 'doc').slice(0, 1).toUpperCase()}${String(kind || 'doc').slice(1)} ${doc?.id || ''}`.trim();
  const value = doc?.label ?? doc?.name ?? doc?.text ?? doc?.entry?.name ?? doc?.page?.name ?? fallback;
  const text = String(value || fallback);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function dedupeSortedElevations(values, epsilon = 0.5) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    if (!Number.isFinite(n)) continue;
    if (!out.length || Math.abs(n - out[out.length - 1]) > epsilon) {
      out.push(n);
    }
  }
  return out;
}

/**
 * Build starter `sceneLevels` from current scene content.
 * Used as a quick-start when a map has no Levels scene data yet.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<{label:string,bottom:number,top:number}>}
 */
function buildStarterSceneLevels(scene) {
  const elevations = [];
  const push = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) elevations.push(n);
  };

  try {
    for (const tileDoc of (scene?.tiles || [])) {
      push(tileDoc?.elevation);
      if (tileHasLevelsRange(tileDoc)) {
        const flags = readTileLevelsFlags(tileDoc);
        push(flags.rangeBottom);
        push(flags.rangeTop);
      }
    }

    const docSets = [scene?.lights, scene?.sounds, scene?.notes, scene?.drawings, scene?.templates];
    for (const docs of docSets) {
      for (const doc of (docs || [])) {
        const range = readDocLevelsRange(doc);
        push(range.rangeBottom);
        push(range.rangeTop);
      }
    }
  } catch (_) {
  }

  if (!elevations.length) elevations.push(0);

  const centers = dedupeSortedElevations(elevations, 0.5);
  if (!centers.length) {
    return [{ label: 'Ground', bottom: -5, top: 5 }];
  }

  if (centers.length === 1) {
    const c = centers[0];
    return [{
      label: `Ground (${c.toFixed(0)})`,
      bottom: Number((c - 5).toFixed(2)),
      top: Number((c + 5).toFixed(2)),
    }];
  }

  const levels = [];
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    const prev = centers[i - 1];
    const next = centers[i + 1];

    let bottom;
    let top;

    if (i === 0) {
      bottom = c - Math.max(1, (next - c) * 0.5);
    } else {
      bottom = (prev + c) * 0.5;
    }

    if (i === centers.length - 1) {
      top = c + Math.max(1, (c - prev) * 0.5);
    } else {
      top = (c + next) * 0.5;
    }

    if (bottom > top) {
      const t = bottom;
      bottom = top;
      top = t;
    }

    levels.push({
      label: `Level ${i + 1} (${c.toFixed(0)})`,
      bottom: Number(bottom.toFixed(2)),
      top: Number(top.toFixed(2)),
    });
  }

  return levels;
}

function nearestBandForElevation(elevation, bands) {
  if (!Number.isFinite(elevation) || !Array.isArray(bands) || bands.length === 0) return null;

  for (const b of bands) {
    if (elevation === b.bottom) return b;
  }

  for (const b of bands) {
    if (elevation >= b.bottom && elevation <= b.top) return b;
  }

  let best = null;
  let bestDist = Infinity;
  for (const b of bands) {
    const center = (Number(b.bottom) + Number(b.top)) * 0.5;
    const dist = Math.abs(elevation - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

function cloneLevelsFlags(scene) {
  return (foundry?.utils?.deepClone?.(scene?.flags?.levels || {})) || { ...(scene?.flags?.levels || {}) };
}

function matchesTileFilter(hasRange, filter) {
  if (filter === 'unassigned') return !hasRange;
  if (filter === 'assigned') return !!hasRange;
  return true;
}

function hasValidTileRangeForLevels(tileDoc) {
  if (!tileHasLevelsRange(tileDoc)) return false;
  const flags = readTileLevelsFlags(tileDoc);
  const bottom = Number(tileDoc?.elevation ?? flags.rangeBottom);
  const top = Number(flags.rangeTop);
  return Number.isFinite(bottom) && Number.isFinite(top) && top > bottom;
}

function formatLevelInputValue(value, { allowInfinity = false } = {}) {
  if (allowInfinity && value === Infinity) return 'Infinity';
  if (allowInfinity && value === -Infinity) return '-Infinity';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(2)));
}

function parseLevelInputValue(raw, { fallback = 0, allowInfinity = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;

  const normalized = text.toLowerCase();
  if (allowInfinity) {
    if (normalized === 'inf' || normalized === '+inf' || normalized === 'infinity' || normalized === '+infinity') return Infinity;
    if (normalized === '-inf' || normalized === '-infinity') return -Infinity;
  }

  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
//  Validation checks
// ---------------------------------------------------------------------------

function runValidation(scene, bands, tileAssignments) {
  const warnings = [];

  // Check for inverted ranges in bands
  for (const b of bands) {
    if (Number.isFinite(b.bottom) && Number.isFinite(b.top) && b.bottom > b.top) {
      warnings.push({ severity: 'error', message: `Level "${b.label}" has inverted range: bottom (${b.bottom}) > top (${b.top})` });
    }
  }

  // Check for overlapping bands
  for (let i = 0; i < bands.length - 1; i++) {
    const curr = bands[i];
    const next = bands[i + 1];
    if (Number.isFinite(curr.top) && Number.isFinite(next.bottom) && curr.top > next.bottom) {
      warnings.push({ severity: 'warn', message: `Levels "${curr.label}" and "${next.label}" overlap: ${curr.top} > ${next.bottom}` });
    }
  }

  // Check for gaps between bands
  for (let i = 0; i < bands.length - 1; i++) {
    const curr = bands[i];
    const next = bands[i + 1];
    if (Number.isFinite(curr.top) && Number.isFinite(next.bottom) && next.bottom - curr.top > 1) {
      warnings.push({ severity: 'info', message: `Gap between "${curr.label}" (top: ${curr.top}) and "${next.label}" (bottom: ${next.bottom})` });
    }
  }

  // Check for empty bands (no tiles assigned)
  for (const b of bands) {
    const tilesInBand = tileAssignments.filter(t => t.bandIndex === b.index);
    if (tilesInBand.length === 0) {
      warnings.push({ severity: 'info', message: `Level "${b.label}" has no tiles assigned` });
    }
  }

  // Check for unassigned tiles
  const unassigned = tileAssignments.filter(t => t.bandIndex === -1);
  if (unassigned.length > 0) {
    warnings.push({ severity: 'warn', message: `${unassigned.length} tile(s) have no Levels range flags set` });
  }

  // Check for tiles with inverted ranges
  for (const t of tileAssignments) {
    if (t.hasRange && Number.isFinite(t.bottom) && Number.isFinite(t.top) && t.bottom > t.top) {
      warnings.push({ severity: 'error', message: `Tile "${t.name}" has inverted range: bottom (${t.bottom}) > top (${t.top})` });
    }
  }

  // Check non-tile docs without ranges
  try {
    let lightsWithoutRange = 0;
    let soundsWithoutRange = 0;
    let notesWithoutRange = 0;
    let drawingsWithoutRange = 0;
    let templatesWithoutRange = 0;
    for (const light of (scene?.lights || [])) {
      const range = readDocLevelsRange(light);
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) {
        lightsWithoutRange++;
      }
    }
    for (const sound of (scene?.sounds || [])) {
      const range = readDocLevelsRange(sound);
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) {
        soundsWithoutRange++;
      }
    }
    for (const note of (scene?.notes || [])) {
      const range = readDocLevelsRange(note);
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) {
        notesWithoutRange++;
      }
    }
    for (const drawing of (scene?.drawings || [])) {
      const range = readDocLevelsRange(drawing);
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) {
        drawingsWithoutRange++;
      }
    }
    for (const template of (scene?.templates || [])) {
      const range = readDocLevelsRange(template);
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) {
        templatesWithoutRange++;
      }
    }
    if (lightsWithoutRange > 0) {
      warnings.push({ severity: 'info', message: `${lightsWithoutRange} light(s) have no elevation range (visible on all levels)` });
    }
    if (soundsWithoutRange > 0) {
      warnings.push({ severity: 'info', message: `${soundsWithoutRange} sound(s) have no elevation range (audible on all levels)` });
    }
    if (notesWithoutRange > 0) {
      warnings.push({ severity: 'info', message: `${notesWithoutRange} note(s) have no elevation range (visible on all levels)` });
    }
    if (drawingsWithoutRange > 0) {
      warnings.push({ severity: 'info', message: `${drawingsWithoutRange} drawing(s) have no elevation range (visible on all levels)` });
    }
    if (templatesWithoutRange > 0) {
      warnings.push({ severity: 'info', message: `${templatesWithoutRange} template(s) have no elevation range (visible on all levels)` });
    }
  } catch (_) {}

  return warnings;
}

// ---------------------------------------------------------------------------
//  Dialog class
// ---------------------------------------------------------------------------

export class LevelsAuthoringDialog {
  constructor() {
    /** @type {HTMLElement|null} */
    this.container = null;
    /** @type {boolean} */
    this.visible = false;
    /** @type {string} */
    this._activeTab = 'stack';
    /** @type {number|null} - Band index for "solo" mode, null = show all */
    this._soloIndex = null;
    /** @type {number|null} */
    this._sceneHookId = null;
    /** @type {number|null} */
    this._levelHookId = null;

    /** @type {'all'|'assigned'|'unassigned'} */
    this._tileFilter = 'all';

    /** @type {boolean} */
    this._eventsBound = false;

    /** @type {(e: MouseEvent) => void} */
    this._onClick = (e) => this._handleClick(e);

    // -- Drag state for movable header --
    /** @type {boolean} */
    this._dragging = false;
    /** @type {{x:number,y:number}} */
    this._dragOffset = { x: 0, y: 0 };
    /** @type {(e: MouseEvent) => void} */
    this._onDragMove = (e) => this._handleDragMove(e);
    /** @type {(e: MouseEvent) => void} */
    this._onDragEnd = () => this._handleDragEnd();
  }

  initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-levels-authoring';
    container.className = 'map-shine-levels-authoring map-shine-overlay-ui';
    container.style.display = 'none';

    // Prevent interactions from leaking to the canvas
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      container.addEventListener(type, (e) => e.stopPropagation());
    }
    container.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    container.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

    parentElement.appendChild(container);
    this.container = container;

    // Hooks to auto-refresh when scene data changes
    this._sceneHookId = Hooks.on('updateScene', (scene, changes) => {
      if (!this.visible) return;
      if (scene?.id !== canvas?.scene?.id) return;
      // Keep authoring UI synced when Levels flags OR scene image/elevation
      // fields change from outside this dialog.
      if (
        changes?.flags?.levels !== undefined ||
        changes?.tiles !== undefined ||
        'foregroundElevation' in (changes || {}) ||
        'foreground' in (changes || {}) ||
        'background' in (changes || {})
      ) {
        this._render();
      }
    });

    this._levelHookId = Hooks.on('mapShineLevelContextChanged', () => {
      if (this.visible) this._render();
    });

    log.info('Levels authoring dialog initialized');
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;
    this._render();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
    this._clearSolo();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    if (this._sceneHookId !== null) {
      Hooks.off('updateScene', this._sceneHookId);
      this._sceneHookId = null;
    }
    if (this._levelHookId !== null) {
      Hooks.off('mapShineLevelContextChanged', this._levelHookId);
      this._levelHookId = null;
    }
    this._clearSolo();
    if (this.container && this._eventsBound) {
      try {
        this.container.removeEventListener('click', this._onClick);
      } catch (_) {
      }
    }
    this._eventsBound = false;
    if (this.container) {
      try { this.container.remove(); } catch (_) {}
    }
    this.container = null;
    this.visible = false;
  }

  // -------------------------------------------------------------------------
  //  Rendering
  // -------------------------------------------------------------------------

  _render() {
    if (!this.container) return;

    const scene = canvas?.scene;
    const mode = getLevelsCompatibilityMode();
    const enabled = isLevelsEnabledForScene(scene);
    const hasSceneLevels = readSceneLevelsFlag(scene).length > 0;
    const bands = enabled ? parseLevelBands(scene) : [];
    const bgElev = getSceneBackgroundElevation(scene);
    const fgElev = Number.isFinite(Number(scene?.foregroundElevation)) ? Number(scene.foregroundElevation) : 0;
    const weatherElev = getSceneWeatherElevation(scene);
    const sceneImageAssignments = this._buildSceneImageAssignments(scene, bgElev, fgElev);

    // Build tile assignments
    const tileAssignments = [];
    try {
      for (const tileDoc of (scene?.tiles || [])) {
        const hasRange = tileHasLevelsRange(tileDoc);
        const flags = readTileLevelsFlags(tileDoc);
        const bandIndex = bands.length > 0 ? assignTileToBand(tileDoc, bands) : -1;
        tileAssignments.push({
          id: tileDoc.id,
          name: tileName(tileDoc),
          src: tileSource(tileDoc),
          hasRange,
          bottom: flags.rangeBottom,
          top: flags.rangeTop,
          bandIndex,
          elevation: tileDoc.elevation ?? 0,
          sort: tileDoc.sort ?? 0,
          overhead: (tileDoc.elevation ?? 0) >= (scene?.foregroundElevation ?? Infinity),
          showIfAbove: flags.showIfAbove === true,
          showAboveRange: flags.showAboveRange,
          isBasement: flags.isBasement === true,
          noCollision: flags.noCollision === true,
          noFogHide: flags.noFogHide === true,
          allWallBlockSight: flags.allWallBlockSight === true,
          excludeFromChecker: flags.excludeFromChecker === true,
        });
      }
    } catch (_) {}

    const docAssignments = this._buildDocAssignments(scene, bands);

    const warnings = enabled ? runValidation(scene, bands, tileAssignments) : [];

    // Count elements per band
    const bandCounts = {};
    for (const b of bands) {
      bandCounts[b.index] = { tiles: 0, lights: 0, sounds: 0, notes: 0, drawings: 0, templates: 0 };
    }
    for (const t of tileAssignments) {
      if (t.bandIndex >= 0 && bandCounts[t.bandIndex]) bandCounts[t.bandIndex].tiles++;
    }
    for (const docEntry of docAssignments) {
      if (docEntry.bandIndex < 0 || !bandCounts[docEntry.bandIndex]) continue;
      if (docEntry.kind === 'lights') bandCounts[docEntry.bandIndex].lights++;
      else if (docEntry.kind === 'sounds') bandCounts[docEntry.bandIndex].sounds++;
      else if (docEntry.kind === 'notes') bandCounts[docEntry.bandIndex].notes++;
      else if (docEntry.kind === 'drawings') bandCounts[docEntry.bandIndex].drawings++;
      else if (docEntry.kind === 'templates') bandCounts[docEntry.bandIndex].templates++;
    }

    const warnCount = warnings.filter(w => w.severity === 'warn' || w.severity === 'error').length;
    const tab = this._activeTab;

    this.container.innerHTML = `
      <div class="msa-la__header">
        <div class="msa-la__title">Levels Authoring</div>
        <div class="msa-la__mode">${escapeHtml(mode)} ${enabled ? '(active)' : '(inactive)'}</div>
        <button type="button" class="msa-la__close" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="msa-la__tabs">
        <button type="button" class="msa-la__tab ${tab === 'stack' ? 'msa-la__tab--active' : ''}" data-tab="stack">Level Stack</button>
        <button type="button" class="msa-la__tab ${tab === 'tiles' ? 'msa-la__tab--active' : ''}" data-tab="tiles">Tile Inspector</button>
        <button type="button" class="msa-la__tab ${tab === 'docs' ? 'msa-la__tab--active' : ''}" data-tab="docs">Docs Inspector</button>
        <button type="button" class="msa-la__tab ${tab === 'validation' ? 'msa-la__tab--active' : ''}" data-tab="validation">Validation${warnCount > 0 ? ` <span class="msa-la__badge">${warnCount}</span>` : ''}</button>
        <button type="button" class="msa-la__tab ${tab === 'zones' ? 'msa-la__tab--active' : ''}" data-tab="zones">Zones</button>
        <button type="button" class="msa-la__tab ${tab === 'scene' ? 'msa-la__tab--active' : ''}" data-tab="scene">Scene</button>
      </div>
      <div class="msa-la__body">
        ${!enabled ? this._renderInactiveState(mode, hasSceneLevels) :
          tab === 'stack' ? this._renderStack(bands, bandCounts, tileAssignments) :
          tab === 'tiles' ? this._renderTiles(bands, tileAssignments) :
          tab === 'docs' ? this._renderDocs(bands, docAssignments) :
          tab === 'zones' ? this._renderZones(bands) :
          tab === 'validation' ? this._renderValidation(warnings) :
          tab === 'scene' ? this._renderScene(bgElev, weatherElev, bands, sceneImageAssignments) :
          ''}
      </div>
    `;

    this._bindEvents();
  }

  _renderInactiveState(mode, hasSceneLevels) {
    const modeIsOff = mode === LEVELS_COMPATIBILITY_MODES.OFF;
    const modeHint = modeIsOff
      ? 'Compatibility mode is currently OFF. The quick-start action will switch it to Import-Only.'
      : (hasSceneLevels
        ? 'Scene has some Levels data, but it is not marked as enabled.'
        : 'Scene has no Levels bands yet. Quick-start will create starter levels from current content.');

    return `
      <div class="msa-la__empty">
        Levels compatibility is not enabled for this scene.<br>
        ${escapeHtml(modeHint)}
      </div>
      <div class="msa-la__inactive-actions">
        <button type="button" data-action="prepareLevels">Prepare Scene for Levels Authoring</button>
        <button type="button" data-action="openSettings">Open Module Settings</button>
      </div>
    `;
  }

  _buildDocAssignments(scene, bands) {
    const docs = this._iterSceneNonTileDocs(scene);
    const out = [];
    for (const entry of docs) {
      const doc = entry.doc;
      const kind = entry.kind;
      const range = readDocLevelsRange(doc);
      out.push({
        id: doc?.id,
        kind,
        name: docDisplayName(kind, doc),
        rangeBottom: range.rangeBottom,
        rangeTop: range.rangeTop,
        hasRange: Number.isFinite(range.rangeBottom) || Number.isFinite(range.rangeTop),
        bandIndex: bands.length > 0 ? assignDocToBand(doc, bands) : -1,
      });
    }
    return out;
  }

  _renderDocRow(docEntry, bands) {
    const rangeText = docEntry.hasRange
      ? `${formatElev(docEntry.rangeBottom)} &mdash; ${formatElev(docEntry.rangeTop)}`
      : '<em>no range</em>';
    const bottomInput = formatLevelInputValue(docEntry.rangeBottom, { allowInfinity: true });
    const topInput = formatLevelInputValue(docEntry.rangeTop, { allowInfinity: true });
    const bandLabel = docEntry.bandIndex >= 0
      ? (bands.find((b) => b.index === docEntry.bandIndex)?.label || `L${docEntry.bandIndex + 1}`)
      : 'Unassigned';
    const typeLabel = String(docEntry.kind || 'doc').replace(/^(\w)/, (m) => m.toUpperCase());

    return `
      <div class="msa-la__tile-row msa-la__doc-row" data-doc-type="${escapeHtml(docEntry.kind)}" data-doc-id="${escapeHtml(docEntry.id)}">
        <div class="msa-la__tile-main">
          <span class="msa-la__tile-name" title="${escapeHtml(docEntry.name)}">${escapeHtml(docEntry.name)}</span>
          <span class="msa-la__tag msa-la__tag--levels">${escapeHtml(typeLabel)}</span>
          <span class="msa-la__tile-range">${rangeText}</span>
          <span class="msa-la__tile-elev" title="Current level band">B:${escapeHtml(bandLabel)}</span>
        </div>

        <div class="msa-la__tile-editor" data-editor-for-doc="${escapeHtml(docEntry.kind)}:${escapeHtml(docEntry.id)}">
          <div class="msa-la__tile-editor-row">
            <label>Bottom
              <input type="text" data-field="bottom" value="${escapeHtml(bottomInput)}" title="Document range bottom (supports Infinity)">
            </label>
            <label>Top
              <input type="text" data-field="top" value="${escapeHtml(topInput)}" title="Document range top (supports Infinity)">
            </label>
            <label>Type
              <input type="text" value="${escapeHtml(typeLabel)}" disabled>
            </label>
          </div>

          <div class="msa-la__tile-editor-actions">
            <button type="button" data-action="saveDocLevels" data-doc-type="${escapeHtml(docEntry.kind)}" data-doc-id="${escapeHtml(docEntry.id)}" title="Apply Levels range values">Apply</button>
            <button type="button" data-action="clearDocLevels" data-doc-type="${escapeHtml(docEntry.kind)}" data-doc-id="${escapeHtml(docEntry.id)}" title="Clear document rangeBottom/rangeTop">Clear Range</button>
            <button type="button" data-action="selectDoc" data-doc-type="${escapeHtml(docEntry.kind)}" data-doc-id="${escapeHtml(docEntry.id)}" title="Select this placeable in Foundry">Sel</button>
          </div>
        </div>
      </div>`;
  }

  _renderDocs(bands, docAssignments) {
    if (docAssignments.length === 0) {
      return '<div class="msa-la__empty">No lights, sounds, notes, drawings, or templates in this scene.</div>';
    }

    const byType = new Map();
    for (const item of docAssignments) {
      const key = item.kind || 'other';
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(item);
    }

    const order = ['lights', 'sounds', 'notes', 'drawings', 'templates'];
    let html = `
      <div class="msa-la__tile-tools">
        <div class="msa-la__tile-tip">Edit Levels ranges for non-tile docs inline. Use Infinity for unbounded ranges.</div>
      </div>`;

    for (const kind of order) {
      const rows = byType.get(kind) || [];
      const label = kind.replace(/^(\w)/, (m) => m.toUpperCase());
      html += `<div class="msa-la__tile-group">
        <div class="msa-la__tile-group-header">${escapeHtml(label)} <span class="msa-la__tile-group-count">(${rows.length})</span></div>`;
      if (!rows.length) {
        html += '<div class="msa-la__tile-empty">None</div>';
      } else {
        html += '<div class="msa-la__tile-list">';
        for (const row of rows) {
          html += this._renderDocRow(row, bands);
        }
        html += '</div>';
      }
      html += '</div>';
    }

    return html;
  }

  // -------------------------------------------------------------------------
  //  Tab: Level Stack
  // -------------------------------------------------------------------------

  _renderStack(bands, bandCounts, tileAssignments) {
    if (bands.length === 0) {
      return `
        <div class="msa-la__stack-tools">
          <button type="button" data-action="addLevelBand" title="Create a new level band above the current highest level">Add Level</button>
          <button type="button" data-action="presetTwoLevels" title="Replace scene levels with a practical 0/20 setup">Preset 0/20</button>
          <button type="button" data-action="addTwentyFootLayer" title="Add a second level centered around 20ft">Add 20ft Layer</button>
          <button type="button" data-action="autoBuildLevels" title="Regenerate scene levels from current scene content">Auto-Build</button>
        </div>
        <div class="msa-la__empty">No level bands defined in scene flags.<br>Add <code>sceneLevels</code> data to the scene's Levels flags.</div>`;
    }

    // Render bottom-to-top (reversed so highest is at top visually)
    const reversed = [...bands].reverse();
    const unassigned = tileAssignments.filter(t => t.bandIndex === -1);

    let html = `
      <div class="msa-la__stack-tools">
        <button type="button" data-action="addLevelBand" title="Create a new level band above the current highest level">Add Level</button>
        <button type="button" data-action="presetTwoLevels" title="Replace scene levels with a practical 0/20 setup">Preset 0/20</button>
        <button type="button" data-action="addTwentyFootLayer" title="Add a second level centered around 20ft">Add 20ft Layer</button>
        <button type="button" data-action="autoBuildLevels" title="Regenerate scene levels from current scene content">Auto-Build</button>
      </div>
      <div class="msa-la__stack">`;
    for (const b of reversed) {
      const counts = bandCounts[b.index] || { tiles: 0, lights: 0, sounds: 0, notes: 0 };
      const isSolo = this._soloIndex === b.index;
      html += `
        <div class="msa-la__band ${isSolo ? 'msa-la__band--solo' : ''}" data-band-index="${b.index}">
          <div class="msa-la__band-header">
            <span class="msa-la__band-label">${escapeHtml(b.label)}</span>
            <span class="msa-la__band-range">${formatElev(b.bottom)} &mdash; ${formatElev(b.top)}</span>
          </div>
          <div class="msa-la__band-counts">
            <span title="Tiles">${counts.tiles} tiles</span>
            <span title="Lights">${counts.lights} lights</span>
            <span title="Sounds">${counts.sounds} sounds</span>
            <span title="Notes">${counts.notes} notes</span>
            <span title="Drawings">${counts.drawings} drawings</span>
            <span title="Templates">${counts.templates} templates</span>
          </div>
          <div class="msa-la__band-actions">
            <button type="button" data-action="solo" data-band-index="${b.index}" title="${isSolo ? 'Unsolo' : 'Solo this level'}">${isSolo ? 'Unsolo' : 'Solo'}</button>
            <button type="button" data-action="navigate" data-band-index="${b.index}" title="Navigate to this level">Go To</button>
            <button type="button" data-action="selectTiles" data-band-index="${b.index}" title="Select all tiles on this level">Select</button>
            <button type="button" data-action="assignSelectedToBand" data-band-index="${b.index}" title="Assign selected tiles to this level">Assign Sel</button>
            <button type="button" data-action="assignSelectedDocsToBand" data-band-index="${b.index}" title="Assign selected lights/sounds/notes/drawings/templates to this level">Assign Sel Docs</button>
            <button type="button" data-action="adoptUnassignedDocsToBand" data-band-index="${b.index}" title="Assign all unassigned lights/sounds/notes/drawings/templates to this level">Adopt Unassigned Docs</button>
            <button type="button" data-action="adoptUnassignedToBand" data-band-index="${b.index}" title="Assign all unassigned tiles to this level">Adopt Unassigned</button>
          </div>
          <div class="msa-la__band-editor" data-band-editor-for="${b.index}">
            <div class="msa-la__band-editor-row">
              <label>Label
                <input type="text" data-field="label" value="${escapeHtml(String(b.label || `Level ${b.index + 1}`))}" title="Level label">
              </label>
              <label>Bottom
                <input type="text" data-field="bottom" value="${escapeHtml(formatLevelInputValue(b.bottom))}" title="Level bottom elevation">
              </label>
              <label>Top
                <input type="text" data-field="top" value="${escapeHtml(formatLevelInputValue(b.top))}" title="Level top elevation">
              </label>
            </div>
            <div class="msa-la__band-editor-actions">
              <button type="button" data-action="saveBandDefinition" data-band-index="${b.index}" title="Apply label/bottom/top changes to this level">Save</button>
              <button type="button" data-action="deleteBandDefinition" data-band-index="${b.index}" title="Delete this level band">Delete</button>
            </div>
          </div>
        </div>`;
    }

    if (unassigned.length > 0) {
      html += `
        <div class="msa-la__band msa-la__band--unassigned">
          <div class="msa-la__band-header">
            <span class="msa-la__band-label">Unassigned</span>
            <span class="msa-la__band-range">no range flags</span>
          </div>
          <div class="msa-la__band-counts"><span>${unassigned.length} tiles</span></div>
        </div>`;
    }

    html += '</div>';
    return html;
  }

  // -------------------------------------------------------------------------
  //  Tab: Tile Inspector
  // -------------------------------------------------------------------------

  _renderTiles(bands, tileAssignments) {
    if (tileAssignments.length === 0) {
      return '<div class="msa-la__empty">No tiles in this scene.</div>';
    }

    const filteredAssignments = tileAssignments.filter((t) => matchesTileFilter(t.hasRange, this._tileFilter));
    const filterButton = (filterValue, label, title) => `
      <button
        type="button"
        class="msa-la__tile-filter ${this._tileFilter === filterValue ? 'msa-la__tile-filter--active' : ''}"
        data-action="setTileFilter"
        data-filter="${filterValue}"
        title="${escapeHtml(title)}"
      >${escapeHtml(label)}</button>`;

    let html = `
      <div class="msa-la__tile-tools">
        <div class="msa-la__tile-tip">Edit tile Levels values inline below, then click <strong>Apply</strong>.</div>
        <div class="msa-la__tile-filters">
          ${filterButton('all', `All (${tileAssignments.length})`, 'Show all tiles')}
          ${filterButton('unassigned', `Unassigned (${tileAssignments.filter((t) => !t.hasRange).length})`, 'Show only tiles with no Levels range')}
          ${filterButton('assigned', `Assigned (${tileAssignments.filter((t) => t.hasRange).length})`, 'Show only tiles with Levels range')}
        </div>
        <div class="msa-la__tile-bulk">
          <button type="button" data-action="selectVisibleTiles" title="Select all tiles currently visible in this list">Select Visible</button>
          <button type="button" data-action="fixVisibleTiles" title="Set valid Levels ranges for all currently visible tiles">Fix Visible</button>
        </div>
      </div>`;

    if (filteredAssignments.length === 0) {
      return `${html}<div class="msa-la__tile-empty">No tiles match the current filter.</div>`;
    }

    // Group tiles by band
    const groups = new Map();
    for (const b of bands) groups.set(b.index, []);
    groups.set(-1, []);

    for (const t of filteredAssignments) {
      const key = t.bandIndex;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    // Render each band group
    for (const b of bands) {
      const tiles = groups.get(b.index) || [];
      html += `<div class="msa-la__tile-group">
        <div class="msa-la__tile-group-header">${escapeHtml(b.label)} <span class="msa-la__tile-group-count">(${tiles.length})</span></div>`;
      if (tiles.length === 0) {
        html += '<div class="msa-la__tile-empty">No tiles</div>';
      } else {
        html += '<div class="msa-la__tile-list">';
        for (const t of tiles) {
          html += this._renderTileRow(t);
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // Unassigned
    const unassigned = groups.get(-1) || [];
    if (unassigned.length > 0) {
      html += `<div class="msa-la__tile-group msa-la__tile-group--unassigned">
        <div class="msa-la__tile-group-header">Unassigned <span class="msa-la__tile-group-count">(${unassigned.length})</span></div>
        <div class="msa-la__tile-list">`;
      for (const t of unassigned) {
        html += this._renderTileRow(t);
      }
      html += '</div></div>';
    }

    return html;
  }

  _renderTileRow(t) {
    const rangeText = t.hasRange
      ? `${formatElev(t.bottom)} &mdash; ${formatElev(t.top)}`
      : '<em>no range</em>';
    const overheadTag = t.overhead ? '<span class="msa-la__tag msa-la__tag--overhead">OH</span>' : '';
    const levelsTag = t.hasRange
      ? '<span class="msa-la__tag msa-la__tag--levels">LEVELS</span>'
      : '<span class="msa-la__tag msa-la__tag--missing">NO-LEVELS</span>';

    const bottomInput = formatLevelInputValue(t.elevation);
    const topInput = formatLevelInputValue(t.top, { allowInfinity: true });
    const showAboveRangeInput = formatLevelInputValue(t.showAboveRange, { allowInfinity: true });

    return `
      <div class="msa-la__tile-row" data-tile-id="${escapeHtml(t.id)}">
        <div class="msa-la__tile-main">
          <span class="msa-la__tile-name" title="${escapeHtml(t.src || t.name)}">${escapeHtml(t.name)}</span>
          ${overheadTag}
          ${levelsTag}
          <span class="msa-la__tile-range">${rangeText}</span>
          <span class="msa-la__tile-elev" title="Foundry elevation">E:${formatElev(t.elevation)}</span>
        </div>

        <div class="msa-la__tile-editor" data-editor-for="${escapeHtml(t.id)}">
          <div class="msa-la__tile-editor-row">
            <label>Bottom
              <input type="text" data-field="bottom" value="${escapeHtml(bottomInput)}" title="Tile bottom elevation (tile document elevation)">
            </label>
            <label>Top
              <input type="text" data-field="top" value="${escapeHtml(topInput)}" title="Tile top elevation (rangeTop; supports Infinity)">
            </label>
            <label>ShowAboveRange
              <input type="text" data-field="showAboveRange" value="${escapeHtml(showAboveRangeInput)}" title="Max distance for Show If Above (supports Infinity)">
            </label>
          </div>

          <div class="msa-la__tile-editor-flags">
            <label><input type="checkbox" data-field="showIfAbove" ${t.showIfAbove ? 'checked' : ''}> ShowIfAbove</label>
            <label><input type="checkbox" data-field="isBasement" ${t.isBasement ? 'checked' : ''}> Basement</label>
            <label><input type="checkbox" data-field="noCollision" ${t.noCollision ? 'checked' : ''}> NoCollision</label>
            <label><input type="checkbox" data-field="noFogHide" ${t.noFogHide ? 'checked' : ''}> NoFogHide</label>
            <label><input type="checkbox" data-field="allWallBlockSight" ${t.allWallBlockSight ? 'checked' : ''}> AllWallBlockSight</label>
            <label><input type="checkbox" data-field="excludeFromChecker" ${t.excludeFromChecker ? 'checked' : ''}> ExcludeFromChecker</label>
          </div>

          <div class="msa-la__tile-editor-actions">
            <button type="button" data-action="saveTileLevels" data-tile-id="${escapeHtml(t.id)}" title="Apply the Levels values above">Apply</button>
            <button type="button" data-action="clearTileLevels" data-tile-id="${escapeHtml(t.id)}" title="Clear all Levels flags for this tile">Clear Flags</button>
            <button type="button" data-action="fixTileRange" data-tile-id="${escapeHtml(t.id)}" title="Auto-fix this tile to nearest level band">Fix</button>
            <button type="button" data-action="selectTile" data-tile-id="${escapeHtml(t.id)}" title="Select on canvas">Sel</button>
          </div>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  //  Tab: Validation
  // -------------------------------------------------------------------------

  _renderValidation(warnings) {
    if (warnings.length === 0) {
      return '<div class="msa-la__empty msa-la__empty--ok">All checks passed. No validation issues detected.</div>';
    }

    let html = '<div class="msa-la__validation">';
    for (const w of warnings) {
      const icon = w.severity === 'error' ? '&#9888;' : w.severity === 'warn' ? '&#9888;' : '&#8505;';
      html += `<div class="msa-la__warn msa-la__warn--${escapeHtml(w.severity)}">
        <span class="msa-la__warn-icon">${icon}</span>
        <span>${escapeHtml(w.message)}</span>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  // -------------------------------------------------------------------------
  //  Tab: Scene
  // -------------------------------------------------------------------------

  _buildSceneImageAssignments(scene, bgElev, fgElev) {
    // Scene background/foreground are not TileDocuments, but exposing them as
    // tile-style authoring rows gives GMs one consistent elevation workflow.
    const bgSrc = (typeof scene?.background?.src === 'string') ? scene.background.src.trim() : '';

    const rawForeground = scene?.foreground;
    const fgSrc = (typeof rawForeground === 'string')
      ? rawForeground.trim()
      : ((typeof rawForeground?.src === 'string') ? rawForeground.src.trim() : '');

    const assignments = [];

    if (bgSrc) {
      assignments.push({
        id: 'scene-background',
        label: 'Background Image',
        src: bgSrc,
        bottom: bgElev,
        top: fgElev,
        topEditable: true,
      });
    }

    if (fgSrc) {
      assignments.push({
        id: 'scene-foreground',
        label: 'Foreground Image',
        src: fgSrc,
        bottom: fgElev,
        top: Infinity,
        topEditable: false,
      });
    }

    return assignments;
  }

  _renderSceneImageRow(surface) {
    const bottomInput = formatLevelInputValue(surface.bottom);
    const topInput = formatLevelInputValue(surface.top, { allowInfinity: true });
    const rangeText = `${formatElev(surface.bottom)} &mdash; ${formatElev(surface.top)}`;
    const sourceText = sourceName(surface.src, '(no source)');

    return `
      <div class="msa-la__tile-row" data-scene-surface-id="${escapeHtml(surface.id)}">
        <div class="msa-la__tile-main">
          <span class="msa-la__tile-name" title="${escapeHtml(surface.src)}">${escapeHtml(surface.label)}: ${escapeHtml(sourceText)}</span>
          <span class="msa-la__tag msa-la__tag--levels">SCENE</span>
          <span class="msa-la__tile-range">${rangeText}</span>
        </div>

        <div class="msa-la__tile-editor" data-editor-for-scene-surface="${escapeHtml(surface.id)}">
          <div class="msa-la__tile-editor-row">
            <label>Bottom
              <input type="text" data-field="bottom" value="${escapeHtml(bottomInput)}" title="Elevation bottom for this scene image surface">
            </label>
            <label>Top
              <input type="text" data-field="top" value="${escapeHtml(topInput)}" ${surface.topEditable ? '' : 'disabled'} title="${surface.topEditable ? 'For background, Top maps to scene foreground elevation' : 'Foreground top is effectively infinite'}">
            </label>
            <label>Type
              <input type="text" value="${escapeHtml(surface.id === 'scene-background' ? 'Scene Background Surface' : 'Scene Foreground Surface')}" disabled>
            </label>
          </div>
          <div class="msa-la__tile-editor-actions">
            <button type="button" data-action="saveSceneSurface" data-scene-surface-id="${escapeHtml(surface.id)}" title="Apply elevation values for this scene image">Apply</button>
          </div>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  //  Tab: Zones (Stairs / Elevators)
  // -------------------------------------------------------------------------

  _renderZones(bands) {
    // Read zones from scene flags via ZoneManager
    const zm = window.MapShine?.zoneManager;
    const existingZones = zm?.getZones?.() || [];
    const isDrawing = zm?.isDrawing === true;

    const bandOptions = bands.map((b) =>
      `<option value="${b.index}">${escapeHtml(b.label)} (${formatElev(b.bottom)}..${formatElev(b.top)})</option>`
    ).join('');

    const noBands = bands.length < 2;
    const disabledAttr = (noBands || isDrawing) ? 'disabled' : '';
    const noBandsHint = noBands
      ? '<div class="msa-la__zone-warn">At least 2 level bands are required to create stair/elevator zones. Add levels in the Level Stack tab first.</div>'
      : '';
    const drawingHint = isDrawing
      ? '<div class="msa-la__zone-warn">Drawing mode active — click on the map to place vertices. Double-click or Enter to finish, Escape to cancel.</div>'
      : '';

    // Existing zones list
    let zonesListHtml = '';
    if (existingZones.length > 0) {
      zonesListHtml = '<div class="msa-la__zone-list">';
      for (const zone of existingZones) {
        const typeLabel = zone.type === 'elevator' ? 'Elevator'
          : zone.type === 'stairUp' ? 'Stair Up'
          : zone.type === 'stairDown' ? 'Stair Down'
          : zone.type === 'slide' ? 'Slide (one-way)'
          : 'Stair';
        const fromLabel = zone.fromLevel?.label || '?';
        const toLabel = zone.toLevel?.label || '?';
        const rangeText = `${fromLabel} → ${toLabel}`;
        const extras = [];
        if (zone.oneWay) extras.push('one-way');
        if (zone.locked) extras.push('locked');
        const ptCount = zone.points?.length || 0;
        zonesListHtml += `
          <div class="msa-la__zone-row">
            <span class="msa-la__zone-name" title="${escapeHtml(zone.name)}">${escapeHtml(zone.name)}</span>
            <span class="msa-la__tag">${escapeHtml(typeLabel)}</span>
            <span class="msa-la__zone-range">${escapeHtml(rangeText)} (${ptCount}pt)</span>
            ${extras.length ? `<span class="msa-la__zone-flags">${escapeHtml(extras.join(', '))}</span>` : ''}
            <button type="button" data-action="toggleZoneLock" data-zone-id="${escapeHtml(zone.id)}" title="${zone.locked ? 'Unlock' : 'Lock'} this zone">${zone.locked ? '🔒' : '🔓'}</button>
            <button type="button" data-action="deleteZone" data-zone-id="${escapeHtml(zone.id)}" title="Delete this zone">Delete</button>
          </div>`;
      }
      zonesListHtml += '</div>';
    } else {
      zonesListHtml = '<div class="msa-la__tile-empty">No stair or elevator zones in this scene.</div>';
    }

    return `
      <div class="msa-la__zones">
        <div class="msa-la__tile-tip">
          Configure a zone below, then click a button to draw its polygon directly on the map.
          Grid snapping is on by default — hold <strong>Shift</strong> for free placement.
        </div>
        ${noBandsHint}
        ${drawingHint}

        <div class="msa-la__zone-create">
          <div class="msa-la__zone-create-header">Create New Zone</div>

          <div class="msa-la__zone-form">
            <div class="msa-la__zone-form-row">
              <label>From Level
                <select data-zone-field="fromLevel" ${disabledAttr}>${bandOptions}</select>
              </label>
              <label>To Level
                <select data-zone-field="toLevel" ${disabledAttr}>${bandOptions}</select>
              </label>
            </div>

            <div class="msa-la__zone-form-row">
              <label>Zone Name
                <input type="text" data-zone-field="zoneName" placeholder="e.g. Main Staircase" value="">
              </label>
            </div>

            <div class="msa-la__zone-form-row msa-la__zone-options">
              <label><input type="checkbox" data-zone-field="oneWay"> One-way (slide/chute — cannot reverse)</label>
              <label><input type="checkbox" data-zone-field="locked"> Locked (tokens cannot use until unlocked)</label>
            </div>
          </div>

          <div class="msa-la__zone-buttons">
            <button type="button" data-action="drawStairZone" ${disabledAttr} title="Draw a bidirectional stair polygon on the map">Draw Stair</button>
            <button type="button" data-action="drawStairUpZone" ${disabledAttr} title="Draw a stair-up polygon on the map">Draw Stair Up</button>
            <button type="button" data-action="drawStairDownZone" ${disabledAttr} title="Draw a stair-down polygon on the map">Draw Stair Down</button>
            <button type="button" data-action="drawElevatorZone" ${disabledAttr} title="Draw an elevator polygon on the map">Draw Elevator</button>
          </div>
        </div>

        <div class="msa-la__zone-existing">
          <div class="msa-la__zone-create-header">Existing Zones (${existingZones.length})</div>
          ${zonesListHtml}
        </div>
      </div>`;
  }

  _renderScene(bgElev, weatherElev, bands, sceneImageAssignments) {
    const bgText = bgElev !== 0 ? `${bgElev}` : '0 (default)';
    const weatherText = weatherElev !== null ? `${weatherElev}` : 'not set';
    const lightMaskingEnabled = canvas?.scene?.flags?.levels?.lightMasking === true;
    const lightMasking = lightMaskingEnabled ? 'enabled' : 'disabled';

    const sceneImageSection = sceneImageAssignments.length > 0
      ? `
        <div class="msa-la__scene-surfaces">
          <div class="msa-la__tile-tools">
            <div class="msa-la__tile-tip">Scene image controls use tile-style bottom/top editing. For background, <strong>Top</strong> maps to scene foreground elevation.</div>
          </div>
          <div class="msa-la__tile-list">
            ${sceneImageAssignments.map((s) => this._renderSceneImageRow(s)).join('')}
          </div>
        </div>`
      : '<div class="msa-la__tile-empty">No scene background/foreground image detected.</div>';

    return `
      <div class="msa-la__scene">
        <div class="msa-la__scene-row"><strong>Background Elevation:</strong> ${escapeHtml(bgText)}</div>
        <div class="msa-la__scene-row"><strong>Weather Elevation:</strong> ${escapeHtml(weatherText)}</div>
        <div class="msa-la__scene-row"><strong>Light Masking:</strong> ${escapeHtml(lightMasking)}</div>
        <div class="msa-la__scene-row"><strong>Foreground Elevation:</strong> ${escapeHtml(formatElev(canvas?.scene?.foregroundElevation ?? 0))}</div>
        <div class="msa-la__scene-row"><strong>Defined Levels:</strong> ${bands.length}</div>
        <div class="msa-la__scene-row"><strong>Total Tiles:</strong> ${canvas?.scene?.tiles?.size ?? 0}</div>
        <div class="msa-la__scene-row"><strong>Total Lights:</strong> ${canvas?.scene?.lights?.size ?? 0}</div>
        <div class="msa-la__scene-row"><strong>Total Sounds:</strong> ${canvas?.scene?.sounds?.size ?? 0}</div>
        <div class="msa-la__scene-row"><strong>Total Notes:</strong> ${canvas?.scene?.notes?.size ?? 0}</div>
        ${sceneImageSection}
        <div class="msa-la__scene-actions">
          <button type="button" data-action="setBackgroundToLowest" title="Set scene backgroundElevation to lowest defined level bottom">Background = Lowest Level</button>
          <button type="button" data-action="setWeatherToHighest" title="Set scene weatherElevation to highest defined level top">Weather = Highest Level</button>
          <button type="button" data-action="clearWeatherElevation" title="Clear weather elevation override">Clear Weather Elevation</button>
          <button type="button" data-action="toggleLightMasking" title="Toggle Levels light masking policy">${lightMaskingEnabled ? 'Disable' : 'Enable'} Light Masking</button>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  //  Event handling
  // -------------------------------------------------------------------------

  _bindEvents() {
    if (!this.container || this._eventsBound) return;
    this.container.addEventListener('click', this._onClick);

    // Use event delegation for the header drag so it survives innerHTML rebuilds
    this.container.addEventListener('mousedown', (e) => {
      const header = e.target?.closest?.('.msa-la__header');
      if (header) this._handleDragStart(e);
    });

    this._eventsBound = true;
  }

  // -- Draggable header handlers --

  _handleDragStart(e) {
    // Only drag on left button, and not on the close button
    if (e.button !== 0) return;
    if (e.target.closest('[data-action="close"]')) return;

    e.preventDefault();
    this._dragging = true;

    const rect = this.container.getBoundingClientRect();
    this._dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    const header = this.container.querySelector('.msa-la__header');
    if (header) header.classList.add('msa-la__header--dragging');

    document.addEventListener('mousemove', this._onDragMove);
    document.addEventListener('mouseup', this._onDragEnd);
  }

  _handleDragMove(e) {
    if (!this._dragging || !this.container) return;

    const newLeft = e.clientX - this._dragOffset.x;
    const newTop = e.clientY - this._dragOffset.y;

    // Clamp to viewport bounds
    const maxLeft = window.innerWidth - 80;
    const maxTop = window.innerHeight - 40;
    this.container.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
    this.container.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;
  }

  _handleDragEnd() {
    this._dragging = false;
    const header = this.container?.querySelector('.msa-la__header');
    if (header) header.classList.remove('msa-la__header--dragging');

    document.removeEventListener('mousemove', this._onDragMove);
    document.removeEventListener('mouseup', this._onDragEnd);
  }

  _handleClick(e) {
    const target = e.target?.closest?.('[data-action]');
    if (!target) {
      const tabBtn = e.target?.closest?.('[data-tab]');
      if (tabBtn) {
        this._activeTab = tabBtn.dataset.tab;
        this._render();
      }
      return;
    }

    const action = target.dataset.action;
    switch (action) {
      case 'close':
        this.hide();
        break;

      case 'presetTwoLevels':
        this._applyTwoLayerPreset();
        break;

      case 'addTwentyFootLayer':
        this._addTwentyFootLayer();
        break;

      case 'autoBuildLevels':
        this._autoBuildLevels();
        break;

      case 'addLevelBand':
        this._addLevelBand();
        break;

      case 'prepareLevels':
        this._prepareSceneForLevels();
        break;

      case 'openSettings':
        try {
          game?.settings?.sheet?.render?.(true);
        } catch (_) {
        }
        break;

      case 'solo': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) {
          if (this._soloIndex === idx) this._clearSolo();
          else this._applySolo(idx);
          this._render();
        }
        break;
      }

      case 'navigate': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) {
          try {
            const controller = window.MapShine?.cameraFollower || window.MapShine?.levelNavigationController;
            controller?.setActiveLevel?.(idx, { reason: 'levels-authoring-navigate' });
          } catch (_) {
          }
        }
        break;
      }

      case 'selectTiles': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._selectTilesOnBand(idx);
        break;
      }

      case 'selectTile': {
        const tileId = target.dataset.tileId;
        if (tileId) this._selectTileById(tileId);
        break;
      }

      case 'selectDoc': {
        const docType = String(target.dataset.docType || '');
        const docId = target.dataset.docId;
        if (docType && docId) this._selectDocByTypeAndId(docType, docId);
        break;
      }

      case 'saveTileLevels': {
        const tileId = target.dataset.tileId;
        if (tileId) this._saveTileLevels(tileId);
        break;
      }

      case 'clearTileLevels': {
        const tileId = target.dataset.tileId;
        if (tileId) this._clearTileLevels(tileId);
        break;
      }

      case 'saveDocLevels': {
        const docType = String(target.dataset.docType || '');
        const docId = target.dataset.docId;
        if (docType && docId) this._saveDocLevels(docType, docId);
        break;
      }

      case 'clearDocLevels': {
        const docType = String(target.dataset.docType || '');
        const docId = target.dataset.docId;
        if (docType && docId) this._clearDocLevels(docType, docId);
        break;
      }

      case 'setTileFilter': {
        const nextFilter = String(target.dataset.filter || 'all');
        if (nextFilter === 'all' || nextFilter === 'assigned' || nextFilter === 'unassigned') {
          this._tileFilter = nextFilter;
          this._render();
        }
        break;
      }

      case 'selectVisibleTiles':
        this._selectVisibleTiles();
        break;

      case 'fixVisibleTiles':
        this._fixVisibleTiles();
        break;

      case 'setBackgroundToLowest':
        this._setBackgroundToLowest();
        break;

      case 'setWeatherToHighest':
        this._setWeatherToHighest();
        break;

      case 'clearWeatherElevation':
        this._clearWeatherElevation();
        break;

      case 'toggleLightMasking':
        this._toggleLightMasking();
        break;

      case 'saveSceneSurface': {
        const surfaceId = target.dataset.sceneSurfaceId;
        if (surfaceId) this._saveSceneSurface(surfaceId);
        break;
      }

      case 'assignSelectedToBand': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._assignSelectedTilesToBand(idx);
        break;
      }

      case 'assignSelectedDocsToBand': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._assignSelectedDocsToBand(idx);
        break;
      }

      case 'adoptUnassignedDocsToBand': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._adoptUnassignedDocsToBand(idx);
        break;
      }

      case 'adoptUnassignedToBand': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._adoptUnassignedTilesToBand(idx);
        break;
      }

      case 'saveBandDefinition': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._saveBandDefinition(idx);
        break;
      }

      case 'deleteBandDefinition': {
        const idx = Number(target.dataset.bandIndex);
        if (Number.isFinite(idx)) this._deleteBandDefinition(idx);
        break;
      }

      case 'fixTileRange': {
        const tileId = target.dataset.tileId;
        if (tileId) this._fixTileRange(tileId);
        break;
      }

      case 'drawStairZone':
        this._startZoneDrawing('stair');
        break;

      case 'drawStairUpZone':
        this._startZoneDrawing('stairUp');
        break;

      case 'drawStairDownZone':
        this._startZoneDrawing('stairDown');
        break;

      case 'drawElevatorZone':
        this._startZoneDrawing('elevator');
        break;

      case 'toggleZoneLock': {
        const zoneId = target.dataset.zoneId;
        if (zoneId) this._toggleZoneLock(zoneId);
        break;
      }

      case 'deleteZone': {
        const zoneId = target.dataset.zoneId;
        if (zoneId) this._deleteZone(zoneId);
        break;
      }
    }
  }

  async _updateSceneLevels(sceneLevels, userMessage) {
    const scene = canvas?.scene;
    if (!scene) return;

    const levelsFlags = cloneLevelsFlags(scene);
    levelsFlags.enabled = true;
    levelsFlags.sceneLevels = sceneLevels;

    await scene.update({
      'flags.levels': levelsFlags,
    });

    this._refreshRuntimeAfterAuthoringEdit();
    if (userMessage) ui.notifications?.info?.(userMessage);
    this._render();
  }

  _refreshRuntimeAfterAuthoringEdit() {
    try {
      window.MapShine?.cameraFollower?.refreshLevelBands?.({ emit: true, reason: 'levels-authoring-edit' });
    } catch (_) {
    }
    try {
      window.MapShine?.tileManager?._scheduleElevationVisibilityRefresh?.();
    } catch (_) {
    }
  }

  async _applyTwoLayerPreset() {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const base = Number(getSceneBackgroundElevation(scene));
    const ground = Number.isFinite(base) ? base : 0;
    const upper = ground + 20;

    const sceneLevels = [
      { label: `Ground (${ground})`, bottom: ground, top: upper - 0.01 },
      { label: `Upper (${upper})`, bottom: upper, top: upper + 20 },
    ];

    try {
      await this._updateSceneLevels(sceneLevels, 'Applied 2-level preset (0/20 style).');
    } catch (err) {
      log.warn('Failed to apply two-layer preset', err);
      ui.notifications?.error?.('Failed to apply 2-level preset (see console).');
    }
  }

  async _addTwentyFootLayer() {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    try {
      const existingBands = parseLevelBands(scene);
      const hasTwentyLayer = existingBands.some((b) => Number.isFinite(b.bottom) && Number.isFinite(b.top) && 20 >= b.bottom && 20 <= b.top);
      if (hasTwentyLayer) {
        ui.notifications?.info?.('A level containing 20ft already exists.');
        return;
      }

      const next = existingBands.map((b) => ({ label: b.label, bottom: b.bottom, top: b.top }));
      if (next.length === 0) {
        next.push({ label: 'Ground (0)', bottom: 0, top: 19.99 });
      }
      next.push({ label: 'Upper (20)', bottom: 20, top: 40 });
      next.sort((a, b) => a.bottom - b.bottom);

      await this._updateSceneLevels(next, 'Added 20ft layer.');
    } catch (err) {
      log.warn('Failed to add 20ft layer', err);
      ui.notifications?.error?.('Failed to add 20ft layer (see console).');
    }
  }

  async _autoBuildLevels() {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    try {
      const next = buildStarterSceneLevels(scene);
      await this._updateSceneLevels(next, `Auto-built ${next.length} level band(s) from current scene content.`);
    } catch (err) {
      log.warn('Failed to auto-build levels', err);
      ui.notifications?.error?.('Failed to auto-build scene levels (see console).');
    }
  }

  _getBandEditorElement(bandIndex) {
    if (!this.container || !Number.isFinite(Number(bandIndex))) return null;
    return this.container.querySelector(`.msa-la__band[data-band-index="${Number(bandIndex)}"]`) || null;
  }

  _serializeBandsForSceneUpdate(bands) {
    if (!Array.isArray(bands)) return [];
    return bands.map((b, i) => ({
      label: String(b?.label ?? `Level ${i + 1}`),
      bottom: Number(b?.bottom ?? 0),
      top: Number(b?.top ?? 1),
    }));
  }

  async _addLevelBand() {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    const finiteTops = bands.map((b) => Number(b.top)).filter((n) => Number.isFinite(n));
    const nextBottom = finiteTops.length ? Math.max(...finiteTops) + 0.01 : 0;
    const nextTop = nextBottom + 20;

    const next = this._serializeBandsForSceneUpdate(bands);
    next.push({
      label: `Level ${next.length + 1} (${Math.round(nextBottom)})`,
      bottom: Number(nextBottom.toFixed(2)),
      top: Number(nextTop.toFixed(2)),
    });
    next.sort((a, b) => Number(a.bottom) - Number(b.bottom));

    await this._updateSceneLevels(next, 'Added a new level band.');
  }

  async _saveBandDefinition(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const row = this._getBandEditorElement(bandIndex);
    if (!row) return;

    const bands = parseLevelBands(scene);
    const target = bands.find((b) => Number(b.index) === Number(bandIndex));
    if (!target) return;

    const labelRaw = row.querySelector('[data-field="label"]')?.value;
    const bottomRaw = row.querySelector('[data-field="bottom"]')?.value;
    const topRaw = row.querySelector('[data-field="top"]')?.value;

    const nextLabel = String(labelRaw || target.label || `Level ${target.index + 1}`).trim() || `Level ${target.index + 1}`;
    const nextBottom = parseLevelInputValue(bottomRaw, { fallback: target.bottom, allowInfinity: false });
    let nextTop = parseLevelInputValue(topRaw, { fallback: target.top, allowInfinity: false });

    if (!Number.isFinite(nextBottom)) {
      ui.notifications?.warn?.('Level bottom must be a finite number.');
      return;
    }
    if (!Number.isFinite(nextTop)) nextTop = nextBottom + 1;
    if (nextTop <= nextBottom) {
      nextTop = nextBottom + 1;
      ui.notifications?.warn?.('Level top must be above bottom. Top was adjusted automatically.');
    }

    const next = this._serializeBandsForSceneUpdate(bands).map((b, i) => {
      const source = bands[i];
      if (!source || Number(source.index) !== Number(bandIndex)) return b;
      return {
        label: nextLabel,
        bottom: Number(nextBottom.toFixed(2)),
        top: Number(nextTop.toFixed(2)),
      };
    });
    next.sort((a, b) => Number(a.bottom) - Number(b.bottom));

    await this._updateSceneLevels(next, `Updated level "${nextLabel}".`);
  }

  async _deleteBandDefinition(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    if (bands.length <= 1) {
      ui.notifications?.warn?.('At least one level band must remain.');
      return;
    }

    const target = bands.find((b) => Number(b.index) === Number(bandIndex));
    if (!target) return;

    const next = this._serializeBandsForSceneUpdate(bands.filter((b) => Number(b.index) !== Number(bandIndex)));
    next.sort((a, b) => Number(a.bottom) - Number(b.bottom));

    await this._updateSceneLevels(next, `Deleted level "${target.label}".`);
  }

  async _prepareSceneForLevels() {
    if (game.user?.isGM !== true) {
      ui.notifications?.warn?.('Only the GM can prepare scene Levels data.');
      return;
    }

    const scene = canvas?.scene;
    if (!scene) {
      ui.notifications?.warn?.('No active scene available.');
      return;
    }

    let changedMode = false;
    let createdBands = 0;

    try {
      if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) {
        await game.settings.set('map-shine-advanced', 'levelsCompatibilityMode', LEVELS_COMPATIBILITY_MODES.IMPORT_ONLY);
        changedMode = true;
      }

      const existing = readSceneLevelsFlag(scene);
      const levelsFlags = cloneLevelsFlags(scene);

      levelsFlags.enabled = true;

      if (!Array.isArray(existing) || existing.length === 0) {
        const starter = buildStarterSceneLevels(scene);
        levelsFlags.sceneLevels = starter;
        createdBands = starter.length;
      }

      await scene.update({
        'flags.levels': levelsFlags,
      });

      this._refreshRuntimeAfterAuthoringEdit();

      const parts = [];
      parts.push('Scene prepared for Levels authoring.');
      if (changedMode) parts.push('Compatibility mode set to Import-Only.');
      if (createdBands > 0) parts.push(`Created ${createdBands} starter level band(s).`);
      else parts.push('Existing sceneLevels were preserved.');
      ui.notifications?.info?.(parts.join(' '));

      this._render();
    } catch (err) {
      log.warn('Failed to prepare scene for Levels authoring', err);
      ui.notifications?.error?.('Failed to prepare scene for Levels authoring (see console).');
    }
  }

  async _updateSceneLevelsFlags(patch, successMessage) {
    if (game.user?.isGM !== true) return false;
    const scene = canvas?.scene;
    if (!scene) return false;

    try {
      const levelsFlags = cloneLevelsFlags(scene);
      Object.assign(levelsFlags, patch || {});

      await scene.update({
        'flags.levels': levelsFlags,
      });

      this._refreshRuntimeAfterAuthoringEdit();
      this._render();
      if (successMessage) ui.notifications?.info?.(successMessage);
      return true;
    } catch (err) {
      log.warn('Failed to update scene Levels flags', err);
      ui.notifications?.error?.('Failed to update scene Levels settings (see console).');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  //  Solo mode — show only tiles on a given level
  // -------------------------------------------------------------------------

  _applySolo(bandIndex) {
    this._soloIndex = bandIndex;

    const scene = canvas?.scene;
    if (!scene) return;
    const bands = parseLevelBands(scene);
    const band = bands.find(b => b.index === bandIndex);
    if (!band) return;

    // Set all tile sprites' visibility based on whether they belong to this band
    try {
      const tileManager = window.MapShine?.tileManager;
      if (!tileManager?.tileSprites) return;

      for (const [id, data] of tileManager.tileSprites.entries()) {
        if (!data?.sprite || !data?.tileDoc) continue;
        const assignedBand = assignTileToBand(data.tileDoc, bands);
        data.sprite.visible = assignedBand === bandIndex;
      }
    } catch (err) {
      log.warn('Solo mode failed:', err);
    }
  }

  _clearSolo() {
    if (this._soloIndex === null) return;
    this._soloIndex = null;

    // Restore normal visibility for all tiles
    try {
      const tileManager = window.MapShine?.tileManager;
      if (!tileManager?.tileSprites) return;

      for (const [id, data] of tileManager.tileSprites.entries()) {
        if (!data?.sprite || !data?.tileDoc) continue;
        tileManager.updateSpriteVisibility(data.sprite, data.tileDoc);
      }
    } catch (err) {
      log.warn('Unsolo failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  //  Tile selection helpers
  // -------------------------------------------------------------------------

  _selectTilesOnBand(bandIndex) {
    const scene = canvas?.scene;
    if (!scene) return;
    const bands = parseLevelBands(scene);

    try {
      // Release current selection
      canvas.tiles?.releaseAll?.();

      for (const tileDoc of (scene.tiles || [])) {
        const assignedBand = assignTileToBand(tileDoc, bands);
        if (assignedBand === bandIndex) {
          const placeable = canvas.tiles?.get?.(tileDoc.id);
          if (placeable?.control) {
            placeable.control({ releaseOthers: false });
          }
        }
      }

      ui.notifications?.info?.(`Selected tiles on level ${bands[bandIndex]?.label || bandIndex}`);
    } catch (err) {
      log.warn('Select tiles on band failed:', err);
    }
  }

  _selectTileById(tileId) {
    try {
      canvas.tiles?.releaseAll?.();
      const placeable = canvas.tiles?.get?.(tileId);
      if (placeable?.control) {
        placeable.control({ releaseOthers: true });
      }
    } catch (err) {
      log.warn('Select tile failed:', err);
    }
  }

  _getTileDocById(tileId) {
    const scene = canvas?.scene;
    if (!scene || !tileId) return null;
    return scene.tiles?.get?.(tileId) || [...(scene.tiles || [])].find((t) => t?.id === tileId) || null;
  }

  _getTileEditorElement(tileId) {
    if (!this.container || !tileId) return null;
    const rows = this.container.querySelectorAll('.msa-la__tile-row');
    for (const row of rows) {
      if (row?.dataset?.tileId === tileId) return row;
    }
    return null;
  }

  _getSceneSurfaceEditorElement(surfaceId) {
    if (!this.container || !surfaceId) return null;
    const rows = this.container.querySelectorAll('.msa-la__tile-row[data-scene-surface-id]');
    for (const row of rows) {
      if (row?.dataset?.sceneSurfaceId === surfaceId) return row;
    }
    return null;
  }

  async _saveSceneSurface(surfaceId) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const row = this._getSceneSurfaceEditorElement(surfaceId);
    if (!row) return;

    if (surfaceId === 'scene-background') {
      const currentBottom = getSceneBackgroundElevation(scene);
      const currentTop = Number.isFinite(Number(scene?.foregroundElevation)) ? Number(scene.foregroundElevation) : 0;

      const bottomRaw = row.querySelector('[data-field="bottom"]')?.value;
      const topRaw = row.querySelector('[data-field="top"]')?.value;

      const bottom = parseLevelInputValue(bottomRaw, { fallback: currentBottom, allowInfinity: false });
      let top = parseLevelInputValue(topRaw, { fallback: currentTop, allowInfinity: false });

      if (!Number.isFinite(bottom)) {
        ui.notifications?.warn?.('Background bottom must be a finite number.');
        return;
      }
      if (!Number.isFinite(top)) top = currentTop;
      top = Math.max(0, Math.round(top));

      const minTop = Math.max(0, Math.ceil(bottom + 1));
      if (top < minTop) {
        top = minTop;
        ui.notifications?.warn?.('Background top maps to foreground elevation and was adjusted to remain above bottom.');
      }

      try {
        const levelsFlags = cloneLevelsFlags(scene);
        levelsFlags.backgroundElevation = bottom;
        await scene.update({
          foregroundElevation: top,
          'flags.levels': levelsFlags,
        });
        this._refreshRuntimeAfterAuthoringEdit();
        this._render();
        ui.notifications?.info?.(`Updated scene background/foreground elevations (${formatElev(bottom)}–${formatElev(top)}).`);
      } catch (err) {
        log.warn('Save scene background surface failed', err);
        ui.notifications?.error?.('Failed to save scene background surface elevations (see console).');
      }
      return;
    }

    if (surfaceId === 'scene-foreground') {
      const currentBottom = Number.isFinite(Number(scene?.foregroundElevation)) ? Number(scene.foregroundElevation) : 0;
      const bottomRaw = row.querySelector('[data-field="bottom"]')?.value;
      const next = parseLevelInputValue(bottomRaw, { fallback: currentBottom, allowInfinity: false });

      if (!Number.isFinite(next)) {
        ui.notifications?.warn?.('Foreground elevation must be a finite number.');
        return;
      }

      const clamped = Math.max(0, Math.round(next));

      try {
        await scene.update({ foregroundElevation: clamped });
        this._refreshRuntimeAfterAuthoringEdit();
        this._render();
        ui.notifications?.info?.(`Updated foreground elevation to ${formatElev(clamped)}.`);
      } catch (err) {
        log.warn('Save scene foreground surface failed', err);
        ui.notifications?.error?.('Failed to save scene foreground elevation (see console).');
      }
    }
  }

  async _saveTileLevels(tileId) {
    if (game.user?.isGM !== true) return;

    const tileDoc = this._getTileDocById(tileId);
    if (!tileDoc) return;

    const row = this._getTileEditorElement(tileId);
    if (!row) return;

    const existingFlags = readTileLevelsFlags(tileDoc);
    const currentBottom = Number(tileDoc.elevation ?? existingFlags.rangeBottom ?? 0);
    const currentTop = existingFlags.rangeTop;
    const currentShowAboveRange = existingFlags.showAboveRange;

    const bottomRaw = row.querySelector('[data-field="bottom"]')?.value;
    const topRaw = row.querySelector('[data-field="top"]')?.value;
    const showAboveRangeRaw = row.querySelector('[data-field="showAboveRange"]')?.value;

    const bottom = parseLevelInputValue(bottomRaw, { fallback: Number.isFinite(currentBottom) ? currentBottom : 0, allowInfinity: false });
    let top = parseLevelInputValue(topRaw, { fallback: currentTop, allowInfinity: true });
    const showAboveRange = parseLevelInputValue(showAboveRangeRaw, { fallback: currentShowAboveRange, allowInfinity: true });

    if (!Number.isFinite(bottom)) {
      ui.notifications?.warn?.('Tile bottom elevation must be a finite number.');
      return;
    }
    if (!Number.isFinite(top) && top !== Infinity) {
      top = bottom + 1;
    }
    if (Number.isFinite(top) && top <= bottom) {
      top = bottom + 1;
      ui.notifications?.warn?.('Top must be above bottom. Top was adjusted automatically.');
    }

    const levelsFlags = cloneLevelsFlags({ flags: { levels: tileDoc.flags?.levels || {} } });
    levelsFlags.rangeTop = top;
    levelsFlags.showIfAbove = row.querySelector('[data-field="showIfAbove"]')?.checked === true;
    levelsFlags.showAboveRange = showAboveRange;
    levelsFlags.isBasement = row.querySelector('[data-field="isBasement"]')?.checked === true;
    levelsFlags.noCollision = row.querySelector('[data-field="noCollision"]')?.checked === true;
    levelsFlags.noFogHide = row.querySelector('[data-field="noFogHide"]')?.checked === true;
    levelsFlags.allWallBlockSight = row.querySelector('[data-field="allWallBlockSight"]')?.checked === true;
    levelsFlags.excludeFromChecker = row.querySelector('[data-field="excludeFromChecker"]')?.checked === true;

    try {
      await tileDoc.update({
        elevation: bottom,
        'flags.levels': levelsFlags,
      });
      this._refreshRuntimeAfterAuthoringEdit();
      this._render();
      ui.notifications?.info?.(`Updated Levels flags for "${tileName(tileDoc)}".`);
    } catch (err) {
      log.warn('Save tile levels failed', err);
      ui.notifications?.error?.('Failed to save tile Levels values (see console).');
    }
  }

  async _clearTileLevels(tileId) {
    if (game.user?.isGM !== true) return;
    const tileDoc = this._getTileDocById(tileId);
    if (!tileDoc) return;

    try {
      await tileDoc.update({
        'flags.levels': {},
      });
      this._refreshRuntimeAfterAuthoringEdit();
      this._render();
      ui.notifications?.info?.(`Cleared Levels flags for "${tileName(tileDoc)}".`);
    } catch (err) {
      log.warn('Clear tile levels failed', err);
      ui.notifications?.error?.('Failed to clear tile Levels flags (see console).');
    }
  }

  _tileMatchesCurrentFilter(tileDoc) {
    return matchesTileFilter(tileHasLevelsRange(tileDoc), this._tileFilter);
  }

  _selectVisibleTiles() {
    const scene = canvas?.scene;
    if (!scene) return;

    try {
      canvas.tiles?.releaseAll?.();

      let selected = 0;
      for (const tileDoc of (scene.tiles || [])) {
        if (!this._tileMatchesCurrentFilter(tileDoc)) continue;
        const placeable = canvas.tiles?.get?.(tileDoc.id);
        if (placeable?.control) {
          placeable.control({ releaseOthers: false });
          selected += 1;
        }
      }

      ui.notifications?.info?.(`Selected ${selected} tile(s) from current filter.`);
    } catch (err) {
      log.warn('Select visible tiles failed:', err);
    }
  }

  async _fixVisibleTiles() {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    let changed = 0;
    for (const tileDoc of (scene.tiles || [])) {
      if (!this._tileMatchesCurrentFilter(tileDoc)) continue;
      const updated = await this._fixTileRange(tileDoc.id, { silent: true, refresh: false, reRender: false, force: false });
      if (updated) changed += 1;
    }

    this._refreshRuntimeAfterAuthoringEdit();
    this._render();

    if (changed > 0) ui.notifications?.info?.(`Fixed Levels range for ${changed} tile(s).`);
    else ui.notifications?.info?.('No tiles needed fixing for the current filter.');
  }

  async _setBackgroundToLowest() {
    const scene = canvas?.scene;
    if (!scene) return;
    const bands = parseLevelBands(scene);
    const finiteBottoms = bands.map((b) => Number(b.bottom)).filter((n) => Number.isFinite(n));
    const lowest = finiteBottoms.length ? Math.min(...finiteBottoms) : 0;

    await this._updateSceneLevelsFlags({ backgroundElevation: lowest }, `Background elevation set to ${formatElev(lowest)}.`);
  }

  async _setWeatherToHighest() {
    const scene = canvas?.scene;
    if (!scene) return;
    const bands = parseLevelBands(scene);
    const finiteTops = bands.map((b) => Number(b.top)).filter((n) => Number.isFinite(n));
    const highest = finiteTops.length ? Math.max(...finiteTops) : null;

    if (highest === null) {
      ui.notifications?.warn?.('No finite level tops are defined.');
      return;
    }

    await this._updateSceneLevelsFlags({ weatherElevation: highest }, `Weather elevation set to ${formatElev(highest)}.`);
  }

  async _clearWeatherElevation() {
    await this._updateSceneLevelsFlags({ weatherElevation: null }, 'Weather elevation cleared.');
  }

  async _toggleLightMasking() {
    const scene = canvas?.scene;
    if (!scene) return;
    const current = scene?.flags?.levels?.lightMasking === true;
    await this._updateSceneLevelsFlags({ lightMasking: !current }, `Light masking ${!current ? 'enabled' : 'disabled'}.`);
  }

  async _assignSelectedTilesToBand(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    const band = bands.find((b) => b.index === bandIndex);
    if (!band) return;

    const selected = canvas?.tiles?.controlled || [];
    if (!selected.length) {
      ui.notifications?.warn?.('No tiles selected. Select one or more tiles first.');
      return;
    }

    let changed = 0;
    for (const placeable of selected) {
      const tileDoc = placeable?.document;
      if (!tileDoc) continue;

      try {
        const flags = cloneLevelsFlags({ flags: { levels: tileDoc.flags?.levels || {} } });
        const safeTop = Number.isFinite(band.top) ? band.top : (Number(tileDoc.elevation ?? 0) + 10);
        const nextTop = safeTop <= band.bottom ? (band.bottom + 1) : safeTop;

        await tileDoc.update({
          elevation: band.bottom,
          'flags.levels': {
            ...flags,
            rangeTop: nextTop,
          },
        });
        changed += 1;
      } catch (err) {
        log.warn('Assign selected tile to band failed', err);
      }
    }

    this._refreshRuntimeAfterAuthoringEdit();
    this._render();
    if (changed > 0) ui.notifications?.info?.(`Assigned ${changed} selected tile(s) to ${band.label}.`);
  }

  _getSelectedNonTilePlaceables() {
    const buckets = [
      { kind: 'lights', placeables: canvas?.lighting?.controlled || [] },
      { kind: 'sounds', placeables: canvas?.sounds?.controlled || [] },
      { kind: 'notes', placeables: canvas?.notes?.controlled || [] },
      { kind: 'drawings', placeables: canvas?.drawings?.controlled || [] },
      { kind: 'templates', placeables: canvas?.templates?.controlled || [] },
    ];

    const selected = [];
    for (const bucket of buckets) {
      for (const placeable of bucket.placeables) {
        const doc = placeable?.document;
        if (!doc) continue;
        selected.push({ kind: bucket.kind, doc });
      }
    }
    return selected;
  }

  async _assignSelectedDocsToBand(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    const band = bands.find((b) => b.index === bandIndex);
    if (!band) return;

    const selected = this._getSelectedNonTilePlaceables();
    if (!selected.length) {
      ui.notifications?.warn?.('No supported non-tile documents selected. Select lights, sounds, notes, drawings, or templates first.');
      return;
    }

    let changed = 0;
    const counts = { lights: 0, sounds: 0, notes: 0, drawings: 0, templates: 0 };

    for (const entry of selected) {
      const doc = entry.doc;
      const kind = entry.kind;
      const safeBottom = Number.isFinite(Number(band.bottom)) ? Number(band.bottom) : 0;
      let safeTop = Number.isFinite(Number(band.top)) ? Number(band.top) : Infinity;
      if (Number.isFinite(safeTop) && safeTop <= safeBottom) safeTop = safeBottom + 1;

      try {
        const flags = cloneLevelsFlags({ flags: { levels: doc.flags?.levels || {} } });
        await doc.update({
          'flags.levels': {
            ...flags,
            rangeBottom: safeBottom,
            rangeTop: safeTop,
          },
        });
        changed += 1;
        if (counts[kind] !== undefined) counts[kind] += 1;
      } catch (err) {
        log.warn('Assign selected non-tile doc to band failed', err);
      }
    }

    this._refreshRuntimeAfterAuthoringEdit();
    this._render();

    if (changed > 0) {
      const summary = [
        counts.lights ? `${counts.lights} lights` : null,
        counts.sounds ? `${counts.sounds} sounds` : null,
        counts.notes ? `${counts.notes} notes` : null,
        counts.drawings ? `${counts.drawings} drawings` : null,
        counts.templates ? `${counts.templates} templates` : null,
      ].filter(Boolean).join(', ');
      ui.notifications?.info?.(`Assigned ${changed} selected docs to ${band.label}${summary ? ` (${summary})` : ''}.`);
    }
  }

  _iterSceneNonTileDocs(scene) {
    const out = [];
    const buckets = [
      { kind: 'lights', docs: scene?.lights || [] },
      { kind: 'sounds', docs: scene?.sounds || [] },
      { kind: 'notes', docs: scene?.notes || [] },
      { kind: 'drawings', docs: scene?.drawings || [] },
      { kind: 'templates', docs: scene?.templates || [] },
    ];

    for (const bucket of buckets) {
      for (const doc of (bucket.docs || [])) {
        if (!doc) continue;
        out.push({ kind: bucket.kind, doc });
      }
    }
    return out;
  }

  async _adoptUnassignedDocsToBand(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    const band = bands.find((b) => b.index === bandIndex);
    if (!band) return;

    const allDocs = this._iterSceneNonTileDocs(scene);
    if (!allDocs.length) {
      ui.notifications?.info?.('No non-tile docs found in this scene.');
      return;
    }

    const unassigned = allDocs.filter(({ doc }) => {
      const range = readDocLevelsRange(doc);
      return !Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop);
    });

    if (!unassigned.length) {
      ui.notifications?.info?.('No unassigned non-tile docs found.');
      return;
    }

    let changed = 0;
    const counts = { lights: 0, sounds: 0, notes: 0, drawings: 0, templates: 0 };
    const safeBottom = Number.isFinite(Number(band.bottom)) ? Number(band.bottom) : 0;
    let safeTop = Number.isFinite(Number(band.top)) ? Number(band.top) : Infinity;
    if (Number.isFinite(safeTop) && safeTop <= safeBottom) safeTop = safeBottom + 1;

    for (const entry of unassigned) {
      const doc = entry.doc;
      const kind = entry.kind;
      try {
        const flags = cloneLevelsFlags({ flags: { levels: doc.flags?.levels || {} } });
        await doc.update({
          'flags.levels': {
            ...flags,
            rangeBottom: safeBottom,
            rangeTop: safeTop,
          },
        });
        changed += 1;
        if (counts[kind] !== undefined) counts[kind] += 1;
      } catch (err) {
        log.warn('Adopt unassigned non-tile doc to band failed', err);
      }
    }

    this._refreshRuntimeAfterAuthoringEdit();
    this._render();

    if (changed > 0) {
      const summary = [
        counts.lights ? `${counts.lights} lights` : null,
        counts.sounds ? `${counts.sounds} sounds` : null,
        counts.notes ? `${counts.notes} notes` : null,
        counts.drawings ? `${counts.drawings} drawings` : null,
        counts.templates ? `${counts.templates} templates` : null,
      ].filter(Boolean).join(', ');
      ui.notifications?.info?.(`Assigned ${changed} unassigned docs to ${band.label}${summary ? ` (${summary})` : ''}.`);
    }
  }

  async _adoptUnassignedTilesToBand(bandIndex) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const bands = parseLevelBands(scene);
    const band = bands.find((b) => b.index === bandIndex);
    if (!band) return;

    let changed = 0;
    for (const tileDoc of (scene.tiles || [])) {
      if (tileHasLevelsRange(tileDoc)) continue;

      try {
        const rawTop = Number.isFinite(band.top) ? band.top : (Number(tileDoc.elevation ?? 0) + 10);
        const safeTop = rawTop <= band.bottom ? (band.bottom + 1) : rawTop;

        await tileDoc.update({
          elevation: band.bottom,
          'flags.levels': {
            ...(tileDoc.flags?.levels || {}),
            rangeTop: safeTop,
          },
        });
        changed += 1;
      } catch (err) {
        log.warn('Adopt unassigned tile to band failed', err);
      }
    }

    this._refreshRuntimeAfterAuthoringEdit();
    this._render();
    if (changed > 0) {
      ui.notifications?.info?.(`Assigned ${changed} unassigned tile(s) to ${band.label}.`);
    } else {
      ui.notifications?.info?.('No unassigned tiles found.');
    }
  }

  async _fixTileRange(tileId, options = {}) {
    const { silent = false, refresh = true, reRender = true, force = false } = options || {};
    if (game.user?.isGM !== true) return false;
    const scene = canvas?.scene;
    if (!scene) return false;

    const tileDoc = scene.tiles?.get?.(tileId) || [...(scene.tiles || [])].find((t) => t?.id === tileId);
    if (!tileDoc) return false;

    if (!force && hasValidTileRangeForLevels(tileDoc)) {
      return false;
    }

    try {
      const bands = parseLevelBands(scene);
      const elevation = Number(tileDoc.elevation ?? 0);
      const band = nearestBandForElevation(elevation, bands);

      let nextElevation = Number.isFinite(elevation) ? elevation : 0;
      let nextTop = nextElevation + 10;

      if (band) {
        nextElevation = Number.isFinite(band.bottom) ? band.bottom : nextElevation;
        nextTop = Number.isFinite(band.top) ? band.top : (nextElevation + 10);
      }
      if (!Number.isFinite(nextTop) || nextTop <= nextElevation) nextTop = nextElevation + 1;

      await tileDoc.update({
        elevation: nextElevation,
        'flags.levels': {
          ...(tileDoc.flags?.levels || {}),
          rangeTop: nextTop,
        },
      });

      if (refresh) this._refreshRuntimeAfterAuthoringEdit();
      if (reRender) this._render();
      if (!silent) {
        ui.notifications?.info?.(`Tile "${tileName(tileDoc)}" is now levels-valid (${formatElev(nextElevation)}–${formatElev(nextTop)}).`);
      }
      return true;
    } catch (err) {
      log.warn('Fix tile range failed', err);
      if (!silent) ui.notifications?.error?.('Failed to fix tile levels range (see console).');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  //  Zone creation / management (bespoke ZoneManager)
  // -------------------------------------------------------------------------

  /**
   * Read the zone creation form values from the Zones tab.
   * @returns {{fromBandIndex:number, toBandIndex:number, zoneName:string, oneWay:boolean, locked:boolean}|null}
   */
  _readZoneFormValues() {
    if (!this.container) return null;
    const fromEl = this.container.querySelector('[data-zone-field="fromLevel"]');
    const toEl = this.container.querySelector('[data-zone-field="toLevel"]');
    const nameEl = this.container.querySelector('[data-zone-field="zoneName"]');
    const oneWayEl = this.container.querySelector('[data-zone-field="oneWay"]');
    const lockedEl = this.container.querySelector('[data-zone-field="locked"]');

    const fromBandIndex = Number(fromEl?.value ?? 0);
    const toBandIndex = Number(toEl?.value ?? 0);
    const zoneName = String(nameEl?.value || '').trim();
    const oneWay = oneWayEl?.checked === true;
    const locked = lockedEl?.checked === true;

    return { fromBandIndex, toBandIndex, zoneName, oneWay, locked };
  }

  /**
   * Start the interactive polygon drawing tool for a zone.
   * Reads form values, validates, then hands off to ZoneManager.startDrawing().
   * @param {'stair'|'stairUp'|'stairDown'|'elevator'} zoneType
   */
  _startZoneDrawing(zoneType) {
    if (game.user?.isGM !== true) return;
    const scene = canvas?.scene;
    if (!scene) return;

    const zm = window.MapShine?.zoneManager;
    if (!zm) {
      ui.notifications?.error?.('Zone manager not available.');
      return;
    }

    const bands = parseLevelBands(scene);
    if (bands.length < 2) {
      ui.notifications?.warn?.('At least 2 level bands are required to create a zone.');
      return;
    }

    const form = this._readZoneFormValues();
    if (!form) return;

    const fromBand = bands.find(b => b.index === form.fromBandIndex);
    const toBand = bands.find(b => b.index === form.toBandIndex);
    if (!fromBand || !toBand) {
      ui.notifications?.warn?.('Invalid level selection.');
      return;
    }
    if (fromBand.index === toBand.index && zoneType !== 'elevator') {
      ui.notifications?.warn?.('Stair zones must connect two different levels. Select different From/To levels.');
      return;
    }

    // Resolve one-way flag based on zone type
    const effectiveOneWay = form.oneWay || zoneType === 'stairUp' || zoneType === 'stairDown';

    // Auto-generate zone name if empty
    const typeLabels = {
      stair: 'Stair',
      stairUp: 'Stair Up',
      stairDown: 'Stair Down',
      elevator: 'Elevator',
    };
    const autoName = form.zoneName ||
      `${typeLabels[zoneType] || 'Zone'}: ${fromBand.label} ↔ ${toBand.label}`;

    // Build the zone config that will be passed to ZoneManager
    const config = {
      type: zoneType,
      name: autoName,
      fromLevel: { label: fromBand.label, bottom: fromBand.bottom, top: fromBand.top },
      toLevel: { label: toBand.label, bottom: toBand.bottom, top: toBand.top },
      oneWay: effectiveOneWay,
      locked: form.locked,
    };

    // Enter drawing mode — user will draw the polygon on the map
    zm.startDrawing(config, (_zone) => {
      // Callback fires when drawing completes or cancels — re-render the zones tab
      this._render();
    });

    // Re-render to show "drawing mode active" hint
    this._render();
  }

  /**
   * Toggle the locked state of a zone.
   * @param {string} zoneId
   */
  async _toggleZoneLock(zoneId) {
    const zm = window.MapShine?.zoneManager;
    if (!zm) return;
    const zone = zm.getZone(zoneId);
    if (!zone) return;
    await zm.updateZone(zoneId, { locked: !zone.locked });
    this._render();
  }

  /**
   * Delete a zone from the scene flags.
   * @param {string} zoneId
   */
  async _deleteZone(zoneId) {
    const zm = window.MapShine?.zoneManager;
    if (!zm) return;
    const zone = zm.getZone(zoneId);
    const name = zone?.name || '(unnamed)';
    await zm.deleteZone(zoneId);
    ui.notifications?.info?.(`Deleted zone "${name}".`);
    this._render();
  }
}
