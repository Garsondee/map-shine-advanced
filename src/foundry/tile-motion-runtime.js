/**
 * foundry/tile-motion-runtime.js — the LIVE half of tile motion: persistence,
 * Foundry hooks, and the one per-frame entry point the render side calls. See
 * tile-motion.js's own header for the pure math this drives.
 *
 * PERSISTENCE SPLIT (deliberately NOT V2's one scene-wide blob) — a tile's OWN
 * motion config lives on THAT TILE's own flag (`flags.map-shine-advanced.
 * tileMotion`); only the scene-wide transport (play/pause/speed) lives on the
 * scene flag (`tileMotionTransport`). This matches the convention every other
 * `src/foundry/` reader already uses (one document, one snapshot) and — more
 * importantly — eliminates V2's entire echo-suppression apparatus
 * (`_suppressFlagReload`/`_ignoreLocalTileMotionEchoUntil`/base-transform
 * caches): V2 needed those ONLY because it mutated a live, mutable sprite
 * pose incrementally, so reloading the flag on its own write-echo had to be
 * guarded against clobbering mid-animation state. This design computes an
 * ABSOLUTE pose from ABSOLUTE inputs (rest placement + config + wall-clock
 * time) every frame — reloading a config on its own echo is always safe.
 *
 * TRANSPORT CLOCK — see tile-motion.js's own header on `computeElapsedSec`/
 * `reanchorTransport`. Every mutation here that changes RATE (speed, time
 * factor) or RESUMES from a freeze re-anchors via `reanchorTransport` so a
 * late-joining client always computes the identical pose one present the
 * whole time would.
 *
 * @module foundry/tile-motion-runtime
 */

import {
  normalizeTileMotionConfig,
  normalizeTransportState,
  computeTileWorldTransforms,
  reanchorTransport,
  buildMotionGraph,
} from './tile-motion.js';
import { wallClockMs, perfNowMs } from '../core/frame-clock.js';

const NAMESPACE = 'map-shine-advanced';
const TILE_FLAG_KEY = 'tileMotion';
const TRANSPORT_FLAG_KEY = 'tileMotionTransport';

let initialized = false;
let unwatchTransport = null;
let unwatchTiles = null;

/** @type {Map<string, import('./tile-motion.js').TileMotionConfig>} every tile with a saved config, enabled or not. */
let configCache = new Map();
/** @type {Map<string, import('./tile-motion.js').TileRestPlacement>} */
let restPoseCache = new Map();
/** @type {import('./tile-motion.js').TileMotionTransport} */
let transportCache = normalizeTransportState(null);

let externalTileEditSuppressed = false;
let lastTileEditPollMs = 0;
let cachedTileEditActive = false;

// ===========================================================================
// FOUNDRY ACCESSORS — small, local, never throw.
// ===========================================================================

/** @returns {number} `game.time.serverTime` (shared across clients), falling back to the one sanctioned wall clock. */
function nowMs() {
  const s = typeof game !== 'undefined' ? Number(game?.time?.serverTime) : NaN;
  return Number.isFinite(s) && s > 0 ? s : wallClockMs();
}

/** @returns {*|null} the active scene document, or null outside a live canvas. */
function activeScene() {
  return typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
}

/** @param {*} sceneDoc @returns {Array<object>} tolerant of a Map-like or array-like `.tiles` collection. */
function tileDocsOf(sceneDoc) {
  const tiles = sceneDoc?.tiles;
  if (!tiles) return [];
  return typeof tiles.values === 'function' ? Array.from(tiles.values()) : Array.from(tiles);
}

/** @param {string} tileId @returns {*|null} */
function getTileDoc(tileId) {
  if (!tileId) return null;
  const tiles = activeScene()?.tiles;
  try {
    return tiles?.get?.(tileId) ?? null;
  } catch (_) {
    return null;
  }
}

/** @returns {boolean} scene-level edit permission — GM, or a trusted player the scene itself grants update to. */
function canEditScene() {
  const scene = activeScene();
  const user = typeof game !== 'undefined' ? game?.user : null;
  if (!scene || !user) return false;
  if (user.isGM) return true;
  try {
    return typeof scene.canUserModify === 'function' ? scene.canUserModify(user, 'update') : false;
  } catch (_) {
    return false;
  }
}

/** @param {*} tileDoc @returns {boolean} per-tile edit permission (a genuine deviation from V2's scene-only check — see this module's header). */
function canEditTile(tileDoc) {
  if (!tileDoc) return false;
  const user = typeof game !== 'undefined' ? game?.user : null;
  if (!user) return false;
  if (user.isGM) return true;
  try {
    return typeof tileDoc.canUserModify === 'function' ? tileDoc.canUserModify(user, 'update') : false;
  } catch (_) {
    return false;
  }
}

// ===========================================================================
// PERSISTENCE — read/write/watch triples, mirroring fade-persistence.js.
// ===========================================================================

/** @param {*} tileDoc @returns {*|null} raw flag payload, or null if absent/unreadable. */
export function readTileMotionConfigRaw(tileDoc) {
  try {
    return tileDoc?.getFlag?.(NAMESPACE, TILE_FLAG_KEY) ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} tileId @param {object} patch - shallow-merged onto the current config
 *   (pivot/motion/textureMotion merge one level deep, matching V2's own `setTileConfig`).
 * @returns {Promise<{ok:boolean, reason:string|null}>}
 */
export async function writeTileMotionConfig(tileId, patch) {
  const tileDoc = getTileDoc(tileId);
  if (!tileDoc) return { ok: false, reason: 'tile not found on the active scene' };
  if (!canEditTile(tileDoc)) return { ok: false, reason: 'insufficient permission to edit this tile' };
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'patch must be an object' };

  const current = configCache.get(tileId) || normalizeTileMotionConfig(readTileMotionConfigRaw(tileDoc), tileId);
  const merged = {
    ...current,
    ...patch,
    pivot: { ...current.pivot, ...(patch.pivot || {}) },
    motion: { ...current.motion, ...(patch.motion || {}) },
    textureMotion: { ...current.textureMotion, ...(patch.textureMotion || {}) },
  };
  const normalized = normalizeTileMotionConfig(merged, tileId);

  try {
    await tileDoc.setFlag(NAMESPACE, TILE_FLAG_KEY, normalized);
    configCache.set(tileId, normalized);
    refreshRestPose(tileDoc);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `setFlag failed (GM only?): ${err?.message ?? err}` };
  }
}

/** @returns {*|null} raw scene-level transport payload. */
export function readTransportStateRaw() {
  try {
    return activeScene()?.getFlag?.(NAMESPACE, TRANSPORT_FLAG_KEY) ?? null;
  } catch (_) {
    return null;
  }
}

/** @param {import('./tile-motion.js').TileMotionTransport} state @returns {Promise<{ok:boolean, reason:string|null}>} */
export async function writeTransportState(state) {
  const scene = activeScene();
  if (!scene) return { ok: false, reason: 'no active scene to write to' };
  try {
    await scene.setFlag(NAMESPACE, TRANSPORT_FLAG_KEY, state);
    transportCache = state;
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `setFlag failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchTransportState(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = activeScene()?.id ?? null;
      if (!activeId || doc?.id !== activeId) return;
      if (!change?.flags?.[NAMESPACE] || !(TRANSPORT_FLAG_KEY in change.flags[NAMESPACE])) return;
      onChange();
    } catch (_) {
      // mid-teardown update; nothing to recover.
    }
  });
  return () => {
    try {
      Hooks.off('updateScene', id);
    } catch (_) {
      // already gone.
    }
  };
}

/**
 * Relays `createTile`/`updateTile`/`deleteTile` UNFILTERED to the caller for
 * this tile's own flag key — mirrors `scene-doors.js#watchDoorGraphics`'s
 * "relay, let the runtime decide" posture. This is also the template a future
 * trigger source (a `updateTile`-state watcher) would follow.
 * @param {(evt: {hook:string, tileId:string}) => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchTileMotionConfigs(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const ids = [
    [
      'updateTile',
      Hooks.on('updateTile', (doc, change) => {
        if (change?.flags?.[NAMESPACE] && TILE_FLAG_KEY in change.flags[NAMESPACE]) {
          onChange({ hook: 'updateTile', tileId: String(doc?.id ?? '') });
        }
      }),
    ],
    ['createTile', Hooks.on('createTile', (doc) => onChange({ hook: 'createTile', tileId: String(doc?.id ?? '') }))],
    ['deleteTile', Hooks.on('deleteTile', (doc) => onChange({ hook: 'deleteTile', tileId: String(doc?.id ?? '') }))],
  ];
  return () => {
    for (const [name, id] of ids) {
      try {
        Hooks.off(name, id);
      } catch (_) {
        // already gone.
      }
    }
  };
}

// ===========================================================================
// LIVE CACHE — populated on scene-ready, kept current incrementally by the
// hooks above (never re-scans every tile per frame).
// ===========================================================================

/** @param {*} tileDoc @returns {import('./tile-motion.js').TileRestPlacement} */
function restPoseFromTileDoc(tileDoc) {
  return {
    x: Number(tileDoc?.x) || 0,
    y: Number(tileDoc?.y) || 0,
    width: Number(tileDoc?.width) || 0,
    height: Number(tileDoc?.height) || 0,
    rotation: Number(tileDoc?.rotation) || 0,
  };
}

/** @param {*} tileDoc */
function refreshRestPose(tileDoc) {
  if (!tileDoc?.id) return;
  restPoseCache.set(tileDoc.id, restPoseFromTileDoc(tileDoc));
}

function reloadAllFromScene() {
  configCache = new Map();
  restPoseCache = new Map();
  for (const tileDoc of tileDocsOf(activeScene())) {
    if (!tileDoc?.id) continue;
    const cfg = normalizeTileMotionConfig(readTileMotionConfigRaw(tileDoc), tileDoc.id);
    configCache.set(tileDoc.id, cfg);
    refreshRestPose(tileDoc);
  }
  transportCache = normalizeTransportState(readTransportStateRaw());
}

function onTileDocChanged(evt) {
  if (evt.hook === 'deleteTile') {
    configCache.delete(evt.tileId);
    restPoseCache.delete(evt.tileId);
    return;
  }
  const tileDoc = getTileDoc(evt.tileId);
  if (!tileDoc) return;
  configCache.set(tileDoc.id, normalizeTileMotionConfig(readTileMotionConfigRaw(tileDoc), tileDoc.id));
  refreshRestPose(tileDoc);
}

// ===========================================================================
// TILE-EDIT SUPPRESSION — port of V2's `_isTilesEditContextActive`/
// `_shouldSuppressForTileEdit`. Simpler than V2 here: since poses are
// computed fresh from absolute inputs every frame (no mutable "current pose"
// to protect), suppression just short-circuits `resolveTileMotionFrame()` to
// an empty map — there is no separate "stable start" snapshot/restore dance.
// ===========================================================================

function isTilesEditContextActiveRaw() {
  try {
    if (typeof canvas === 'undefined') return false;
    if (canvas?.tiles?.active) return true;
    const activeLayer = String(canvas?.activeLayer?.options?.name || canvas?.activeLayer?.name || '').toLowerCase();
    if (activeLayer === 'tiles' || activeLayer === 'tileslayer') return true;
    const uiControls = typeof ui !== 'undefined' ? ui?.controls : null;
    const controlName = String(uiControls?.control?.name || uiControls?.activeControl || '').toLowerCase();
    if (controlName === 'tiles') return true;
    const controlLayer = String(uiControls?.control?.layer || '').toLowerCase();
    if (controlLayer === 'tiles') return true;
  } catch (_) {
    // fall through to false
  }
  return false;
}

function isTileEditContextActive() {
  if (externalTileEditSuppressed) return true;
  const now = perfNowMs();
  if (now - lastTileEditPollMs > 100) {
    lastTileEditPollMs = now;
    cachedTileEditActive = isTilesEditContextActiveRaw();
  }
  return cachedTileEditActive;
}

/** Explicit gate set by layer/control integration, checked ahead of the polled heuristic. @param {boolean} suppressed */
export function setTileEditSuppressed(suppressed) {
  externalTileEditSuppressed = suppressed === true;
}

// ===========================================================================
// DIALOG SUPPORT — the two small Foundry touches the authoring dialog needs
// (switch into the native Tiles tool; watch its native tile-selection hook).
// Live HERE, not in ui/tile-motion-dialog.js — a raw `canvas.tiles.activate()`
// or `Hooks.on(...)` outside `src/foundry/` is exactly what `foundry/
// adapter-only` exists to catch, same reasoning as every other watcher above.
// ===========================================================================

/** Switch Foundry into its own native Tiles tool, so its OWN click-to-select
 * and selection outline do the panel's "which tile am I editing" job for
 * free — see ui/rooms/remote/tile-motion-panel.js's own header for why
 * V2's redundant custom raycaster + highlight overlay are dropped, not
 * ported. */
export function activateTileMotionNativeTool() {
  try {
    if (typeof canvas === 'undefined' || typeof canvas?.tiles?.activate !== 'function') return;
    canvas.tiles.activate();
  } catch (_) {
    // best-effort — the dialog still works with the manual tile dropdown alone.
  }
}

/**
 * @param {(tileId: string) => void} onSelect
 * @returns {() => void} unsubscribe.
 */
export function watchTileMotionSelection(onSelect) {
  if (typeof onSelect !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('controlTile', (placeable) => {
    try {
      const tileId = placeable?.document?.id ?? placeable?.id ?? '';
      if (tileId) onSelect(String(tileId));
    } catch (_) {
      // a mid-teardown selection change; nothing to recover.
    }
  });
  return () => {
    try {
      Hooks.off('controlTile', id);
    } catch (_) {
      // already gone.
    }
  };
}

// ===========================================================================
// LIFECYCLE
// ===========================================================================

/**
 * Call once per scene-ready — NOT idempotent about the data (every call
 * reloads this scene's own tiles/transport, same as `scene-doors.js`'s own
 * `refreshDoors()`-on-scene-load convention: a scene SWITCH must see the new
 * scene's own tiles, not silently keep serving the previous scene's cache).
 * Idempotent only about hook REGISTRATION — calling this on every scene load
 * must never double-register the same `updateScene`/`updateTile` watchers.
 */
export function initializeTileMotionRuntime() {
  reloadAllFromScene();
  if (!initialized) {
    unwatchTransport = watchTransportState(() => {
      transportCache = normalizeTransportState(readTransportStateRaw());
    });
    unwatchTiles = watchTileMotionConfigs(onTileDocChanged);
    initialized = true;
  }

  // Autoplay must take effect even if nobody ever opens the dialog this
  // session — NOT purely lazy like camera-path. V2's own 250ms settle delay,
  // ported verbatim: let the scene graph finish settling before the first tick.
  if (transportCache.autoPlayEnabled && !transportCache.playing && canEditScene()) {
    setTimeout(() => {
      if (!initialized || transportCache.playing || !transportCache.autoPlayEnabled) return;
      void startTileMotion();
    }, 250);
  }
}

/** Idempotent. */
export function disposeTileMotionRuntime() {
  if (!initialized) return;
  unwatchTransport?.();
  unwatchTiles?.();
  unwatchTransport = null;
  unwatchTiles = null;
  configCache = new Map();
  restPoseCache = new Map();
  externalTileEditSuppressed = false;
  initialized = false;
}

// ===========================================================================
// PER-FRAME ENTRY POINT
// ===========================================================================

/**
 * @returns {Map<string, import('./tile-motion.js').TileMotionFrameTransform>}
 *   empty when uninitialized, stopped, or mid-tile-edit — "tile not in this
 *   map" means "render at rest," so stopping is free (no restore path).
 */
export function resolveTileMotionFrame() {
  if (!initialized || isTileEditContextActive()) return new Map();

  const enabledConfigs = new Map();
  for (const [id, cfg] of configCache) {
    if (cfg.enabled) enabledConfigs.set(id, cfg);
  }
  if (enabledConfigs.size === 0) return new Map();

  const { transforms } = computeTileWorldTransforms(enabledConfigs, restPoseCache, transportCache, nowMs());
  return transforms;
}

// ===========================================================================
// QUERIES
// ===========================================================================

/** @returns {Array<{id:string, label:string}>} every tile on the active scene, sorted by label. */
export function getTileMotionTileList() {
  const list = [];
  for (const tileDoc of tileDocsOf(activeScene())) {
    if (!tileDoc?.id) continue;
    const src = String(tileDoc?.texture?.src || '');
    const file = src ? src.split('/').pop() || src : '';
    list.push({ id: tileDoc.id, label: file ? `${tileDoc.id} — ${file}` : tileDoc.id });
  }
  list.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return list;
}

/** @param {string} tileId @returns {import('./tile-motion.js').TileMotionConfig} normalized, never null. */
export function getTileMotionConfig(tileId) {
  if (!tileId) return normalizeTileMotionConfig(null, '');
  const cached = configCache.get(tileId);
  if (cached)
    return {
      ...cached,
      pivot: { ...cached.pivot },
      motion: { ...cached.motion },
      textureMotion: { ...cached.textureMotion },
    };
  return normalizeTileMotionConfig(readTileMotionConfigRaw(getTileDoc(tileId)), tileId);
}

/** @returns {import('./tile-motion.js').TileMotionTransport} normalized. */
export function getTileMotionTransportState() {
  return { ...transportCache };
}

/**
 * @param {string} tileId
 * @returns {import('./tile-motion.js').TileRestPlacement|null} the tile's
 *   rest placement (`x,y,rotation` — `rotation` in DEGREES, the raw document
 *   field), for the dialog's "Pick Pivot on Canvas" to convert a world click
 *   into a local pivot offset via `tile-motion.js#worldPointToLocalPivot`.
 */
export function getTileMotionRestPose(tileId) {
  if (!tileId) return null;
  const cached = restPoseCache.get(tileId);
  if (cached) return { ...cached };
  const tileDoc = getTileDoc(tileId);
  return tileDoc ? restPoseFromTileDoc(tileDoc) : null;
}

/** @param {string} tileId @returns {{status:string, label:string}} */
export function getTileMotionRuntimeStatus(tileId) {
  if (!tileId) return { status: 'unknown', label: 'Unknown' };
  const cfg = configCache.get(tileId);
  if (!cfg?.enabled) return { status: 'disabled', label: 'Disabled' };
  if (!getTileDoc(tileId)) return { status: 'missingTile', label: 'Missing Tile' };

  const enabledConfigs = new Map();
  for (const [id, c] of configCache) if (c.enabled) enabledConfigs.set(id, c);
  const graph = buildMotionGraph(enabledConfigs);
  if (graph.invalidIds.has(tileId)) return { status: 'invalidCycle', label: 'Invalid Cycle' };
  if (graph.missingParentIds.has(tileId)) return { status: 'missingParent', label: 'Missing Parent' };

  return transportCache.playing ? { status: 'active', label: 'Active' } : { status: 'ready', label: 'Ready' };
}

/** @returns {{totalTileCount:number, enabledCount:number, playing:boolean}} for the Studio summary card. */
export function getTileMotionSummary() {
  let enabledCount = 0;
  for (const cfg of configCache.values()) if (cfg.enabled) enabledCount++;
  return { totalTileCount: configCache.size, enabledCount, playing: transportCache.playing };
}

// ===========================================================================
// MUTATIONS — the extension seam. Every future trigger source (a Region
// behavior, an `updateTile`-state watcher) calls these SAME functions; none
// of today's callers (the dialog, the popover) have any access these don't.
// ===========================================================================

/** @param {string} tileId @param {object} patch @returns {Promise<{ok:boolean, reason:string|null}>} */
export async function setTileMotionConfig(tileId, patch) {
  return writeTileMotionConfig(tileId, patch);
}

/**
 * @param {object} patch @param {{reanchor?:boolean}} [opts] - `reanchor:true`
 *   freezes elapsed time under the OLD rate before the patch takes effect
 *   (for a rate change or a resume); omit for an explicit reset (start/stop/
 *   resetPhase already state the anchor directly).
 * @returns {Promise<{ok:boolean, reason:string|null}>}
 */
async function applyTransportPatch(patch, opts = {}) {
  if (!canEditScene()) return { ok: false, reason: 'insufficient permission (GM only)' };
  const base = opts.reanchor ? reanchorTransport(transportCache, nowMs()) : transportCache;
  const next = normalizeTransportState({ ...base, ...patch });
  return writeTransportState(next);
}

/** Always resets phase to 0, matching V2's own `start()`. */
export async function startTileMotion() {
  return applyTransportPatch({
    playing: true,
    paused: false,
    pausedAtMs: null,
    anchorElapsedSec: 0,
    anchorAtMs: nowMs(),
  });
}

export async function stopTileMotion() {
  return applyTransportPatch({
    playing: false,
    paused: false,
    pausedAtMs: null,
    anchorElapsedSec: 0,
    anchorAtMs: nowMs(),
  });
}

export async function pauseTileMotion() {
  if (!transportCache.playing || transportCache.paused) return { ok: true, reason: null };
  return applyTransportPatch({ paused: true, pausedAtMs: nowMs() });
}

export async function resumeTileMotion() {
  if (!transportCache.playing || !transportCache.paused) return { ok: true, reason: null };
  return applyTransportPatch({ paused: false, pausedAtMs: null }, { reanchor: true });
}

/** Resets phase to 0 without touching play/pause state. */
export async function resetTileMotionPhase() {
  const patch = { anchorElapsedSec: 0, anchorAtMs: nowMs() };
  if (transportCache.paused) patch.pausedAtMs = nowMs();
  return applyTransportPatch(patch);
}

/** @param {number} percent 0..400 */
export async function setTileMotionSpeedPercent(percent) {
  return applyTransportPatch({ speedPercent: percent }, { reanchor: true });
}

/** @param {number} percent 0..200 */
export async function setTileMotionTimeFactorPercent(percent) {
  return applyTransportPatch({ timeFactorPercent: percent }, { reanchor: true });
}

/** @param {boolean} enabled */
export async function setTileMotionAutoPlayEnabled(enabled) {
  return applyTransportPatch({ autoPlayEnabled: enabled !== false });
}
