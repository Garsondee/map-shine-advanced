/**
 * @fileoverview Shared types and normalizers for Camera Path timeline playback.
 *
 * @module foundry/camera-path-types
 */

/** @typedef {'sweep'|'sigHold'|'transition'} CameraTimelineClipType */

/**
 * @typedef {Object} CameraView
 * @property {number} x
 * @property {number} y
 * @property {number} scale
 */

/** @typedef {'auto'|'interstitial'|'split'} SigLocPlacementMode */

/**
 * @typedef {Object} SignificantLocation
 * @property {string} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} scale
 * @property {number} [holdSec]
 * @property {SigLocPlacementMode} [placementMode]
 * @property {string} [placementTarget] Sweep pair key, e.g. `A-B`
 */

/** @typedef {'pan'|'fade'} CameraTransitionStyle */

/** When pan distance exceeds this fraction of map size, use a fade cut instead. */
export const SIG_LOC_FADE_DISTANCE_RATIO = 0.33;

/** Fade-out / fade-in duration (ms) for significant-location cut transitions. */
export const SIG_LOC_FADE_CUT_MS = 2000;

/**
 * @typedef {Object} SceneMapDimensions
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} CameraTimelineClip
 * @property {CameraTimelineClipType} type
 * @property {string} label
 * @property {number} durationMs
 * @property {CameraView} [from]
 * @property {CameraView} [to]
 * @property {CameraView} [view]
 * @property {string} [sigLocId]
 * @property {string} [sweepPair]
 * @property {number} [sweepPart]
 * @property {CameraTransitionStyle} [transitionStyle]
 */

/**
 * @typedef {Object} CameraTimelineSummaryItem
 * @property {string} id
 * @property {CameraTimelineClipType} type
 * @property {string} label
 * @property {number} durationMs
 * @property {number} [startMs]
 * @property {string} colorClass
 * @property {string} [sigLocId]
 */

/**
 * @typedef {Object} CameraTimelineBuildResult
 * @property {CameraTimelineClip[]} clips
 * @property {CameraTimelineSummaryItem[]} summary
 * @property {number} visibleMotionMs
 * @property {number} totalMs
 * @property {string[]} unplacedSigLocIds
 */

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function asCameraNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {number} t
 * @param {CameraView} a
 * @param {CameraView} b
 * @returns {CameraView}
 */
export function lerpCameraView(t, a, b) {
  const tt = Math.max(0, Math.min(1, Number(t) || 0));
  return {
    x: a.x + (b.x - a.x) * tt,
    y: a.y + (b.y - a.y) * tt,
    scale: a.scale + (b.scale - a.scale) * tt,
  };
}

/**
 * @param {unknown} raw
 * @returns {SignificantLocation|null}
 */
export function normalizeSignificantLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof src.id === 'string' && src.id ? src.id : null;
  const name = typeof src.name === 'string' && src.name.trim() ? src.name.trim() : null;
  if (!id || !name) return null;

  const x = asCameraNumber(src.x, NaN);
  const y = asCameraNumber(src.y, NaN);
  const scale = asCameraNumber(src.scale, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;

  /** @type {SignificantLocation} */
  const loc = { id, name, x, y, scale };
  const holdSec = asCameraNumber(src.holdSec, NaN);
  if (Number.isFinite(holdSec) && holdSec > 0) loc.holdSec = holdSec;

  const modeRaw = typeof src.placementMode === 'string' ? src.placementMode : 'auto';
  if (modeRaw === 'interstitial' || modeRaw === 'split') {
    loc.placementMode = modeRaw;
  } else {
    loc.placementMode = 'auto';
  }
  if (typeof src.placementTarget === 'string' && src.placementTarget.trim()) {
    loc.placementTarget = src.placementTarget.trim();
  }

  return loc;
}

/**
 * @param {unknown} raw
 * @returns {SignificantLocation[]}
 */
export function normalizeSignificantLocations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const loc = normalizeSignificantLocation(item);
    if (loc) out.push(loc);
  }
  return out;
}

/**
 * @returns {string}
 */
export function createSignificantLocationId() {
  try {
    if (typeof foundry?.utils?.randomID === 'function') {
      return foundry.utils.randomID();
    }
  } catch (_) {}
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {CameraTimelineClipType} type
 * @returns {string}
 */
export function timelineClipColorClass(type, clip = null) {
  if (type === 'transition' && clip?.transitionStyle === 'fade') {
    return 'msa-cpath__tl-fadecut';
  }
  switch (type) {
    case 'sigHold': return 'msa-cpath__tl-hold';
    case 'transition': return 'msa-cpath__tl-transition';
    default: return 'msa-cpath__tl-sweep';
  }
}

/**
 * @param {{ mapWidth?: number, mapHeight?: number }} [options]
 * @returns {SceneMapDimensions}
 */
export function resolveSceneMapDimensions(options = {}) {
  const w = asCameraNumber(options.mapWidth, NaN);
  const h = asCameraNumber(options.mapHeight, NaN);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  try {
    const dims = globalThis.canvas?.dimensions;
    if (dims?.width > 0 && dims?.height > 0) {
      return { width: dims.width, height: dims.height };
    }
  } catch (_) {}
  return { width: 5000, height: 5000 };
}

/**
 * Euclidean pan distance as a fraction of the scene's longest axis (world units).
 *
 * @param {CameraView} from
 * @param {CameraView} to
 * @param {SceneMapDimensions} mapDims
 * @returns {number}
 */
export function computeCameraTransitionDistanceRatio(from, to, mapDims) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const mapSize = Math.max(mapDims.width, mapDims.height, 1);
  return distance / mapSize;
}

/**
 * @param {CameraView} from
 * @param {CameraView} to
 * @param {SceneMapDimensions} mapDims
 * @param {number} [threshold=SIG_LOC_FADE_DISTANCE_RATIO]
 * @returns {boolean}
 */
export function shouldUseSigLocFadeCut(from, to, mapDims, threshold = SIG_LOC_FADE_DISTANCE_RATIO) {
  return computeCameraTransitionDistanceRatio(from, to, mapDims) > threshold;
}

/**
 * @param {SignificantLocation} loc
 * @param {{ interstitialPairs?: string[], splitPairs?: string[] }} [available]
 * @returns {SignificantLocation}
 */
export function normalizeSigLocPlacement(loc, available = {}) {
  const interstitial = new Set(available.interstitialPairs || []);
  const split = new Set(available.splitPairs || []);
  const mode = loc.placementMode || 'auto';
  const target = loc.placementTarget || '';

  if (mode === 'interstitial') {
    if (!target || !interstitial.has(target)) {
      return { ...loc, placementMode: 'auto', placementTarget: undefined };
    }
    return { ...loc, placementMode: 'interstitial', placementTarget: target };
  }

  if (mode === 'split') {
    if (!target || !split.has(target)) {
      return { ...loc, placementMode: 'auto', placementTarget: undefined };
    }
    return { ...loc, placementMode: 'split', placementTarget: target };
  }

  return { ...loc, placementMode: 'auto', placementTarget: undefined };
}

/**
 * @param {CameraTimelineClip[]} clips
 * @returns {number}
 */
export function computeTimelineVisibleMotionMs(clips) {
  if (!Array.isArray(clips)) return 0;
  return clips.reduce((sum, clip) => sum + Math.max(0, Number(clip?.durationMs) || 0), 0);
}

/**
 * Wall-clock duration for cinematic/continuous render windows (ms).
 *
 * @param {number} logicalMs
 * @returns {number}
 */
export function scalePlaybackWallDurationMs(logicalMs) {
  return Math.max(0, Number(logicalMs) || 0);
}

/**
 * Estimate total wall-clock cinematic window for a camera-path playback session.
 *
 * @param {object} opts
 * @param {CameraTimelineClip[]} opts.timelineClips
 * @param {number} opts.visibleMotionMs
 * @param {number} opts.pathMotionMs
 * @param {number} opts.preHoldMs
 * @param {number} opts.segmentHoldMs
 * @param {boolean} opts.fadeFromBlack
 * @param {boolean} opts.fadeToBlack
 * @param {number} opts.fadeMs
 * @param {number} opts.fadeHoldMs
 * @param {number} [opts.paddingMs=3000]
 * @returns {number}
 */
export function computePlaybackCinematicWallMs(opts) {
  const clips = Array.isArray(opts.timelineClips) ? opts.timelineClips : [];
  const sweepCount = clips.filter((clip) => clip?.type === 'sweep').length;
  const clipsLogicalMs = Math.max(0, Number(opts.visibleMotionMs) || Number(opts.pathMotionMs) || 0);
  const timelineLogicalMs = clipsLogicalMs
    + Math.max(0, Number(opts.preHoldMs) || 0)
    + Math.max(0, sweepCount - 1) * Math.max(0, Number(opts.segmentHoldMs) || 0);

  let wallMs = scalePlaybackWallDurationMs(timelineLogicalMs);

  const fadeMs = Math.max(0, Number(opts.fadeMs) || 0);
  const fadeHoldMs = Math.max(0, Number(opts.fadeHoldMs) || 0);
  if (opts.fadeFromBlack === true) {
    wallMs += scalePlaybackWallDurationMs(fadeHoldMs) + fadeMs;
  }
  if (opts.fadeToBlack === true) {
    wallMs += fadeMs + scalePlaybackWallDurationMs(fadeHoldMs);
  }

  return wallMs + Math.max(0, Number(opts.paddingMs) || 0);
}
