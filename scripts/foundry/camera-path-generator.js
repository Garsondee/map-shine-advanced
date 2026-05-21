/**
 * @fileoverview Auto-generates camera path waypoints from scene dimensions.
 *
 * Port of the coordinate-path macro framing math.
 *
 * @module foundry/camera-path-generator
 */

/** @typedef {'full'|'s_to_n'|'n_to_s'|'w_to_e'|'e_to_w'} CameraPathPresetId */

/** @typedef {Object} CameraPathPoint
 * @property {number|null} x
 * @property {number|null} y
 * @property {number|null} scale
 */

const EMPTY_POINT = Object.freeze({ x: null, y: null, scale: null });

/** Each letterbox bar height as a fraction of viewport height (top + bottom = 2×). */
export const CAMERA_PATH_LETTERBOX_BAR_HEIGHT_PCT = 0.06;

/**
 * Usable viewport for framing math when letterbox bars occupy top/bottom bands.
 *
 * @param {number} screenW
 * @param {number} screenH
 * @param {boolean} [letterboxEnabled=false]
 * @returns {{ width: number, height: number, letterboxEnabled: boolean }}
 */
export function resolveCameraPathViewport(screenW, screenH, letterboxEnabled = false) {
  const w = Math.max(1, screenW);
  const h = Math.max(1, screenH);
  if (!letterboxEnabled) {
    return { width: w, height: h, letterboxEnabled: false };
  }
  const inset = 2 * CAMERA_PATH_LETTERBOX_BAR_HEIGHT_PCT;
  return {
    width: w,
    height: Math.max(1, h * (1 - inset)),
    letterboxEnabled: true,
  };
}

/**
 * @param {object} dims
 * @param {number} zoomLevel
 * @param {number} screenW
 * @param {number} screenH
 */
function getBoundsForZoom(dims, zoomLevel, screenW, screenH) {
  const visibleWidth = screenW / zoomLevel;
  const visibleHeight = screenH / zoomLevel;

  const centerX = dims.sceneX + dims.sceneWidth / 2;
  const centerY = dims.sceneY + dims.sceneHeight / 2;

  let xL = dims.sceneX + (visibleWidth / 2);
  let xR = dims.sceneX + dims.sceneWidth - (visibleWidth / 2);
  if (visibleWidth >= dims.sceneWidth) { xL = centerX; xR = centerX; }

  let yT = dims.sceneY + (visibleHeight / 2);
  let yB = dims.sceneY + dims.sceneHeight - (visibleHeight / 2);
  if (visibleHeight >= dims.sceneHeight) { yT = centerY; yB = centerY; }

  return { xL, xR, yT, yB, centerX, centerY };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampZoom(value, min = 0.05, max = 3.0) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {CameraPathPresetId} type
 * @param {object} [options]
 * @param {number} [options.screenW=window.innerWidth]
 * @param {number} [options.screenH=window.innerHeight]
 * @param {number} [options.framePadding=0.99]
 * @param {boolean} [options.letterboxEnabled=false]
 * @returns {{ points: Record<string, CameraPathPoint>, settings: { duration: number } }|null}
 */
export function generateCameraPathPreset(type, options = {}) {
  const dims = canvas?.scene?.dimensions;
  if (!dims?.sceneWidth || !dims?.sceneHeight) return null;

  const screenW = options.screenW ?? window.innerWidth;
  const screenH = options.screenH ?? window.innerHeight;
  const framePadding = options.framePadding ?? 0.99;
  const letterboxEnabled = options.letterboxEnabled === true;
  const viewport = resolveCameraPathViewport(screenW, screenH, letterboxEnabled);
  const viewW = viewport.width;
  const viewH = viewport.height;

  /** @type {Record<string, CameraPathPoint>} */
  const points = {
    A: { ...EMPTY_POINT },
    B: { ...EMPTY_POINT },
    C: { ...EMPTY_POINT },
    D: { ...EMPTY_POINT },
    E: { ...EMPTY_POINT },
    F: { ...EMPTY_POINT },
    G: { ...EMPTY_POINT },
    H: { ...EMPTY_POINT },
  };

  let defaultDuration = 15;

  if (type === 's_to_n' || type === 'n_to_s') {
    let widthFitZoom = (viewW / dims.sceneWidth) * framePadding;
    widthFitZoom = clampZoom(widthFitZoom);

    const bounds = getBoundsForZoom(dims, widthFitZoom, viewW, viewH);
    const topPt = {
      x: Math.round(bounds.centerX),
      y: Math.round(bounds.yT),
      scale: Number(widthFitZoom.toFixed(4)),
    };
    const botPt = {
      x: Math.round(bounds.centerX),
      y: Math.round(bounds.yB),
      scale: Number(widthFitZoom.toFixed(4)),
    };

    if (type === 's_to_n') {
      points.A = botPt;
      points.B = topPt;
    } else {
      points.A = topPt;
      points.B = botPt;
    }
    defaultDuration = 15;
  } else if (type === 'w_to_e' || type === 'e_to_w') {
    let heightFitZoom = (viewH / dims.sceneHeight) * framePadding;
    heightFitZoom = clampZoom(heightFitZoom);

    const bounds = getBoundsForZoom(dims, heightFitZoom, viewW, viewH);
    const leftPt = {
      x: Math.round(bounds.xL),
      y: Math.round(bounds.centerY),
      scale: Number(heightFitZoom.toFixed(4)),
    };
    const rightPt = {
      x: Math.round(bounds.xR),
      y: Math.round(bounds.centerY),
      scale: Number(heightFitZoom.toFixed(4)),
    };

    if (type === 'w_to_e') {
      points.A = leftPt;
      points.B = rightPt;
    } else {
      points.A = rightPt;
      points.B = leftPt;
    }
    defaultDuration = 15;
  } else if (type === 'full') {
    let fitZoom = Math.min(viewW / dims.sceneWidth, viewH / dims.sceneHeight) * 0.95;
    fitZoom = clampZoom(fitZoom, 0.05, 2.0);

    let sweepZoom = Math.max(
      viewW / (dims.sceneWidth * 0.65),
      viewH / (dims.sceneHeight * 0.65),
    );
    sweepZoom = clampZoom(sweepZoom, 0.05, 2.0);

    let introZoom = sweepZoom * 1.15;
    introZoom = clampZoom(introZoom, 0.05, 3.0);

    const bounds = getBoundsForZoom(dims, sweepZoom, viewW, viewH);

    points.A = { x: Math.round(bounds.centerX), y: Math.round(bounds.centerY), scale: Number(fitZoom.toFixed(4)) };
    points.B = { x: Math.round(bounds.centerX), y: Math.round(bounds.centerY), scale: Number(introZoom.toFixed(4)) };
    points.C = { x: Math.round(bounds.xL), y: Math.round(bounds.yB), scale: Number(sweepZoom.toFixed(4)) };
    points.D = { x: Math.round(bounds.xL), y: Math.round(bounds.yT), scale: Number(sweepZoom.toFixed(4)) };
    points.E = { x: Math.round(bounds.xR), y: Math.round(bounds.yT), scale: Number(sweepZoom.toFixed(4)) };
    points.F = { x: Math.round(bounds.xR), y: Math.round(bounds.yB), scale: Number(sweepZoom.toFixed(4)) };
    points.G = { x: Math.round(bounds.centerX), y: Math.round(bounds.yB), scale: Number(sweepZoom.toFixed(4)) };
    points.H = { x: Math.round(bounds.centerX), y: Math.round(bounds.centerY), scale: Number(fitZoom.toFixed(4)) };

    defaultDuration = 60;
  } else {
    return null;
  }

  return {
    points,
    settings: { duration: defaultDuration },
  };
}

export const CAMERA_PATH_PRESET_OPTIONS = Object.freeze([
  { id: 'full', label: 'Full Map Sweep (4-Stage Cinematic)' },
  { id: 's_to_n', label: 'South to North (Frames Entire Map Width)' },
  { id: 'n_to_s', label: 'North to South (Frames Entire Map Width)' },
  { id: 'w_to_e', label: 'West to East (Frames Entire Map Height)' },
  { id: 'e_to_w', label: 'East to West (Frames Entire Map Height)' },
]);

export const CAMERA_PATH_POINT_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
