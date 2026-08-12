/**
 * foundry/camera-path.js — PURE timeline math for scripted camera flythroughs
 * (author request, 2026-07-21: revive V2's camera-pass recording tool for
 * making clean map-showcase videos). No `canvas`/`Hooks`/DOM here — the live
 * half (actually driving Foundry's camera, hiding chrome, persisting to the
 * scene) is camera-path-player.js.
 *
 * DATA MODEL — deliberately NOT a port of V2's own shape. V2
 * (legacy/foundry/camera-path-types.js) grew an 8-slot "points A–H" grid plus
 * a separate "significant locations" list with three placement modes — two
 * different ways to say "stop somewhere," organically accreted rather than
 * designed. Here a `CameraPath` is just an ORDERED LIST of keyframes, each
 * optionally holding before moving on — strictly more general (any V2 shape
 * is one of these) and there is only ever one way to express "pause here."
 *
 * PLAYBACK PRIMITIVE — also deliberately NOT a port. V2's `camera-animator.js`
 * ticked its own requestAnimationFrame loop every frame and called
 * `canvas.pan({...}, duration:0)` itself — a hand-rolled interpolator sitting
 * on top of a Foundry API that already has one. Foundry's own
 * `canvas.animatePan({x,y,scale}, {duration, easing})` (client/canvas/
 * board.mjs) already tweens through `CanvasAnimation`, returns a Promise that
 * resolves on completion, and is cancellable by name
 * (`CanvasAnimation.terminateAnimation('canvas.animatePan')`). Sequencing
 * calls to Foundry's OWN animator — rather than re-deriving one — is also a
 * closer fit for "Foundry owns the camera, MSA never owns its own": this
 * feature only ever SEQUENCES native calls, it does not tick a competing
 * clock. See camera-path-player.js for where those calls actually happen.
 *
 * @module foundry/camera-path
 */

/** @typedef {{x: number, y: number, scale: number, holdMs: number, cutBefore: boolean}} CameraKeyframe */
/** @typedef {{enabled: boolean, start01: number, end01: number}} DarknessRampSettings */
/** @typedef {{sweepMs: number, easing: 'cosine'|'linear'|'trapezoidal', fadeInMs: number,
 *   fadeOutMs: number, hideUi: boolean, hideLayers: boolean, letterbox: boolean,
 *   longJumpFadeCut: boolean, darknessRamp: DarknessRampSettings}} CameraPathSettings */
/** @typedef {{keyframes: CameraKeyframe[], settings: CameraPathSettings}} CameraPath */
/** @typedef {{type: 'hold', at: {x:number,y:number,scale:number}, durationMs: number}
 *   | {type: 'sweep', from: {x:number,y:number,scale:number}, to: {x:number,y:number,scale:number},
 *      durationMs: number, easing: 'cosine'|'linear'|'trapezoidal'}
 *   | {type: 'fadecut', to: {x:number,y:number,scale:number}, holdMs: number}
 *   | {type: 'cut', to: {x:number,y:number,scale:number}, holdMs: number}} CameraPathSegment */

/** A fat-fingered hold (e.g. a stray extra zero) must never freeze playback
 * for longer than a coffee break — 10 minutes, generous for "linger on this
 * room," impossible to mistake for "playback is stuck." */
const MAX_HOLD_MS = 600_000;
const MAX_SWEEP_MS = 120_000;

/** V2's own `camera-animator.js#animateTimeline`: its "4 independent sweep
 * pairs" (A–B, C–D, E–F, G–H) were never smoothly connected to each other —
 * moving from one pair to the next was ALWAYS an instant snap ("cut"),
 * followed by a brief hold, THEN the next pair's own animated sweep began
 * (`CAMERA_PATH_SEGMENT_HOLD_MS`, verified against source: `if (clip.from)
 * this.instantPan(clip.from); await sleep(segmentHoldMs, ...)`). A flat
 * keyframe list has no "pair boundary" concept to hang that on automatically
 * — `cutBefore` on a keyframe is the explicit, authorable equivalent: "this
 * is a NEW shot, don't pan into it." Same 800ms V2 used. */
export const SHOT_CUT_HOLD_MS = 800;

/** V2's own heuristic (legacy/foundry/camera-path-types.js
 * `SIG_LOC_FADE_DISTANCE_RATIO`), ported verbatim: a pan whose distance
 * exceeds this fraction of the map's longest axis reads as a silly fast
 * whip-pan rather than a deliberate camera move, so it becomes a hard cut
 * (fade to black, snap, fade up) instead of an animated sweep. Kept as an
 * OPT-OUT per-path setting (`longJumpFadeCut`), not hardcoded always-on like
 * V2's — V2 only ever applied this to auto-inserted detours, never to a
 * deliberately-authored long pan; a flat keyframe list has no such
 * distinction, so the author gets the escape hatch instead. */
export const LONG_JUMP_FADE_RATIO = 0.33;
/** Each half of a fade-cut (fade down, fade up) — V2's own
 * `SIG_LOC_FADE_CUT_MS` was 2000; halved here since a `fadecut` segment here
 * is a single full black hold, not two independently-scheduled clips. */
export const FADE_CUT_HOLD_MS = 500;

/** The black-screen beat playCameraPath's own intro holds for, between
 * "snapped to the path's start" and "fading back up" — author request,
 * 2026-07-29: "fade to black, move the camera, pause for a second, then
 * fade back from black". Long enough to read as a deliberate beat, short
 * enough not to stall. A fixed constant, not a per-path setting, matching
 * this module's own SHOT_CUT_HOLD_MS/FADE_CUT_HOLD_MS (both also fixed) —
 * every one of these is stage-direction timing, not creative framing. */
export const INTRO_HOLD_MS = 1000;

export const DEFAULT_SETTINGS = Object.freeze({
  sweepMs: 4000,
  easing: 'cosine',
  fadeInMs: 600,
  fadeOutMs: 600,
  hideUi: true,
  hideLayers: true,
  letterbox: false,
  longJumpFadeCut: true,
  darknessRamp: Object.freeze({ enabled: false, start01: 0, end01: 1 }),
});

/** @param {*} v @param {number} min @param {number} max @param {number} fallback @returns {number} */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * @param {*} raw
 * @returns {CameraKeyframe|null} `null` for anything without a finite, real
 *   position — a keyframe with no place to point the camera is not a
 *   degenerate-but-usable one, unlike a zero hold or a clamped scale.
 */
export function normalizeKeyframe(raw) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    scale: clampNum(raw?.scale, 0.01, 100, 1),
    holdMs: clampNum(raw?.holdMs, 0, MAX_HOLD_MS, 0),
    cutBefore: raw?.cutBefore === true,
  };
}

/**
 * @param {*} raw - a scene flag blob, possibly absent/stale/hand-edited.
 * @returns {CameraPath} never throws, never null — an empty/default path is
 *   always a valid thing to hand to buildCameraTimeline (produces `[]`).
 */
export function normalizeCameraPath(raw) {
  const keyframes = Array.isArray(raw?.keyframes) ? raw.keyframes.map(normalizeKeyframe).filter(Boolean) : [];
  const s = raw?.settings ?? {};
  const dr = s.darknessRamp ?? {};
  const settings = {
    sweepMs: clampNum(s.sweepMs, 100, MAX_SWEEP_MS, DEFAULT_SETTINGS.sweepMs),
    easing: s.easing === 'linear' || s.easing === 'trapezoidal' ? s.easing : DEFAULT_SETTINGS.easing,
    fadeInMs: clampNum(s.fadeInMs, 0, 10_000, DEFAULT_SETTINGS.fadeInMs),
    fadeOutMs: clampNum(s.fadeOutMs, 0, 10_000, DEFAULT_SETTINGS.fadeOutMs),
    hideUi: s.hideUi !== undefined ? !!s.hideUi : DEFAULT_SETTINGS.hideUi,
    hideLayers: s.hideLayers !== undefined ? !!s.hideLayers : DEFAULT_SETTINGS.hideLayers,
    letterbox: s.letterbox !== undefined ? !!s.letterbox : DEFAULT_SETTINGS.letterbox,
    longJumpFadeCut: s.longJumpFadeCut !== undefined ? !!s.longJumpFadeCut : DEFAULT_SETTINGS.longJumpFadeCut,
    darknessRamp: {
      enabled: !!dr.enabled,
      start01: clampNum(dr.start01, 0, 1, DEFAULT_SETTINGS.darknessRamp.start01),
      end01: clampNum(dr.end01, 0, 1, DEFAULT_SETTINGS.darknessRamp.end01),
    },
  };
  return { keyframes, settings };
}

/** @param {CameraKeyframe} kf @returns {{x:number,y:number,scale:number}} */
function pick(kf) {
  return { x: kf.x, y: kf.y, scale: kf.scale };
}

/**
 * Euclidean distance between two views, as a fraction of the map's longest
 * axis — V2's own `computeCameraTransitionDistanceRatio`, ported verbatim
 * (camera-path-types.js). Scale-independent on purpose: a big zoom-level
 * change alone should never trigger a fade cut, only a big PAN.
 * @param {{x:number,y:number}} from @param {{x:number,y:number}} to
 * @param {{width:number,height:number}} mapDims
 * @returns {number}
 */
export function computeTransitionDistanceRatio(from, to, mapDims) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const mapSize = Math.max(mapDims?.width ?? 0, mapDims?.height ?? 0, 1);
  return distance / mapSize;
}

/**
 * Keyframes + settings → an ordered, flat list of hold/sweep/fadecut segments
 * a player can walk through with no further decisions. A single keyframe
 * with `holdMs` yields one `hold` segment (a still shot — useful on its own
 * for framing a screenshot); zero keyframes yields `[]`.
 *
 * `mapDims` is OPTIONAL — omitting it (or `settings.longJumpFadeCut:false`)
 * just means every gap becomes a plain animated `sweep`, matching the
 * pre-this-feature behaviour exactly (backward compatible with every
 * existing test/caller).
 * @param {CameraPath} path
 * @param {{width:number,height:number}} [mapDims]
 * @returns {CameraPathSegment[]}
 */
export function buildCameraTimeline(path, mapDims) {
  const { keyframes, settings } = path;
  if (keyframes.length === 0) return [];
  const segments = [];
  if (keyframes[0].holdMs > 0) segments.push({ type: 'hold', at: pick(keyframes[0]), durationMs: keyframes[0].holdMs });
  for (let i = 0; i < keyframes.length - 1; i++) {
    const from = keyframes[i];
    const to = keyframes[i + 1];
    // `cutBefore` is an explicit authored choice — takes priority over the
    // automatic long-jump heuristic for THIS gap (a short "new shot" cut
    // across the room shouldn't accidentally read as a long-jump fade
    // instead). `!from.cutBefore` ALSO exempts the very NEXT gap — a shot's
    // own first move right after landing via a hard cut — from the heuristic
    // entirely: that hard cut already establishes "this is deliberate camera
    // work," so a big sweep immediately following it can never be the
    // ACCIDENTAL far-apart pair the heuristic exists to catch. Found live,
    // 2026-07-29 — the THIRD time this exact failure mode hit the 'full'
    // preset's own edge sweeps (2026-07-21, 2026-07-28's n_to_s analogue, now
    // this): a per-path `longJumpFadeCut:false` override is too easy to lose
    // (a stale saved path, a caller that never reads `suggestedLongJumpFadeCut`,
    // hand-authored cutBefore keyframes with no preset involved at all) — a
    // shot that hard-cuts in is now structurally immune, not just by
    // convention. See the regression test below.
    const isLongJump =
      settings.longJumpFadeCut &&
      mapDims &&
      !from.cutBefore &&
      computeTransitionDistanceRatio(from, to, mapDims) > LONG_JUMP_FADE_RATIO;
    if (to.cutBefore) {
      segments.push({ type: 'cut', to: pick(to), holdMs: SHOT_CUT_HOLD_MS });
    } else if (isLongJump) {
      segments.push({ type: 'fadecut', to: pick(to), holdMs: FADE_CUT_HOLD_MS });
    } else {
      segments.push({
        type: 'sweep',
        from: pick(from),
        to: pick(to),
        durationMs: settings.sweepMs,
        easing: settings.easing,
      });
    }
    if (to.holdMs > 0) segments.push({ type: 'hold', at: pick(to), durationMs: to.holdMs });
  }
  return segments;
}

/** @param {CameraPathSegment} seg @returns {number} */
function segmentWallMs(seg) {
  if (seg.type === 'fadecut') return seg.holdMs * 2; // fade down + fade up
  if (seg.type === 'cut') return seg.holdMs; // instant snap + one hold
  return seg.durationMs;
}

/** @param {CameraPathSegment[]} segments @returns {number} total milliseconds, every segment type */
export function totalTimelineDurationMs(segments) {
  return segments.reduce((sum, seg) => sum + segmentWallMs(seg), 0);
}

/**
 * A standard trapezoidal VELOCITY profile (ramp up, cruise, ramp down),
 * ported from V2's own "fixed accel/decel, linear middle" feel
 * (legacy/foundry/camera-animator.js's `trapezoidalEase`) but re-derived from
 * the actual kinematics rather than copied, since V2's version baked in a
 * FIXED 3s wall-clock accel/decel — here `accelMs` is the same constant, but
 * expressed as a FRACTION of this segment's own duration (`f`), so a very
 * short sweep degenerates gracefully to a symmetric ramp instead of accel+
 * decel exceeding the whole segment. At the fraction's own two boundaries the
 * position function is continuous (velocity is a triangle/trapezoid in time,
 * position is its integral) — verified by the test's own boundary checks
 * rather than asserted here.
 * @param {number} durationMs
 * @param {number} [accelMs=3000]
 * @returns {(pt: number) => number} matches `CanvasAnimation`'s own easing
 *   signature (progress 0..1 in, eased progress 0..1 out).
 */
export function buildTrapezoidalEasing(durationMs, accelMs = 3000) {
  const f = durationMs > 0 ? Math.min(0.5, accelMs / durationMs) : 0;
  if (f <= 0) return (pt) => pt;
  const vmax = 1 / (1 - f);
  return (pt) => {
    const t = Math.min(1, Math.max(0, pt));
    if (t < f) return 0.5 * vmax * ((t * t) / f);
    if (t < 1 - f) return 0.5 * vmax * f + vmax * (t - f);
    const tRem = 1 - t;
    return 1 - 0.5 * vmax * ((tRem * tRem) / f);
  };
}

/**
 * @param {'cosine'|'linear'|'trapezoidal'} easing
 * @param {number} durationMs
 * @returns {((pt:number)=>number)|undefined} `undefined` for `'cosine'` (and
 *   anything unrecognized) — the caller passes that straight to
 *   `canvas.animatePan`, which then uses Foundry's OWN default
 *   (`CanvasAnimation.easeInOutCosine`) rather than this module reimplementing it.
 */
export function resolveEasingFn(easing, durationMs) {
  if (easing === 'linear') return (pt) => pt;
  if (easing === 'trapezoidal') return buildTrapezoidalEasing(durationMs);
  return undefined;
}

// ===========================================================================
// PRESET GENERATION — ported from V2's camera-path-generator.js (the
// "coordinate-path macro" framing math), UNCHANGED numerically (same zoom-fit
// formulas, same 5 presets, same letterbox inset) but returning this module's
// own flat `CameraKeyframe[]` shape instead of V2's `points.{A..H}` record —
// a generated preset is just a normal starting point the author can then
// reorder/edit/insert holds into like any hand-placed keyframe, not a
// separate "generated path" concept. EXCEPTION: the 'full' preset's own
// framing/direction numbers were revised 2026-07-21→2026-07-29 per direct
// author spec (see its own branch below) and are no longer the raw V2 port;
// s_to_n/n_to_s/w_to_e/e_to_w below remain the original V2 numbers untouched.
// ===========================================================================

/** Each letterbox bar's height as a fraction of viewport height (top+bottom
 * = 2×) — same constant the player uses for the actual CSS bars, so preset
 * framing math and the real letterbox always agree. */
export const LETTERBOX_BAR_HEIGHT_PCT = 0.06;

/** V2's own pacing: a full cinematic sweep reads right at ~15s per leg
 * (60s / 4 legs for the 'full' preset, 15s / 1 leg for a directional pan) —
 * MUCH slower than this module's own default `sweepMs` (4s, tuned for
 * hand-placed short hops), so a generated preset suggests its own sweep
 * speed rather than inheriting whatever was already set. */
export const PRESET_SUGGESTED_SWEEP_MS = 15_000;

export const CAMERA_PATH_PRESETS = Object.freeze([
  { id: 'full', label: 'Full Map Sweep (4-stage cinematic)' },
  { id: 's_to_n', label: 'South to North' },
  { id: 'n_to_s', label: 'North to South' },
  { id: 'w_to_e', label: 'West to East' },
  { id: 'e_to_w', label: 'East to West' },
  { id: 'sw_to_ne', label: 'Southwest to Northeast (diagonal)' },
  { id: 'ne_to_sw', label: 'Northeast to Southwest (diagonal)' },
]);

/** @param {number} v @param {number} [min=0.05] @param {number} [max=3] @returns {number} */
function clampZoom(v, min = 0.05, max = 3.0) {
  return Math.max(min, Math.min(max, v));
}

/**
 * @param {{sceneX:number,sceneY:number,sceneWidth:number,sceneHeight:number}} dims
 * @param {number} zoomLevel @param {number} screenW @param {number} screenH
 */
function getBoundsForZoom(dims, zoomLevel, screenW, screenH) {
  const visibleWidth = screenW / zoomLevel;
  const visibleHeight = screenH / zoomLevel;
  const centerX = dims.sceneX + dims.sceneWidth / 2;
  const centerY = dims.sceneY + dims.sceneHeight / 2;

  let xL = dims.sceneX + visibleWidth / 2;
  let xR = dims.sceneX + dims.sceneWidth - visibleWidth / 2;
  if (visibleWidth >= dims.sceneWidth) {
    xL = centerX;
    xR = centerX;
  }
  let yT = dims.sceneY + visibleHeight / 2;
  let yB = dims.sceneY + dims.sceneHeight - visibleHeight / 2;
  if (visibleHeight >= dims.sceneHeight) {
    yT = centerY;
    yB = centerY;
  }
  return { xL, xR, yT, yB, centerX, centerY };
}

/**
 * Usable viewport for framing math when letterbox bars occupy top/bottom
 * bands — ported verbatim from V2's `resolveCameraPathViewport`.
 * @param {number} screenW @param {number} screenH @param {boolean} [letterboxEnabled=false]
 */
export function resolveCameraPathViewport(screenW, screenH, letterboxEnabled = false) {
  const w = Math.max(1, screenW);
  const h = Math.max(1, screenH);
  if (!letterboxEnabled) return { width: w, height: h };
  const inset = 2 * LETTERBOX_BAR_HEIGHT_PCT;
  return { width: w, height: Math.max(1, h * (1 - inset)) };
}

/**
 * Generate a ready-to-use keyframe list for one of `CAMERA_PATH_PRESETS`.
 * Pure — the LIVE wrapper (camera-path-player.js#generatePresetKeyframes)
 * reads `canvas.scene.dimensions`/`window.innerWidth`/`innerHeight` and calls
 * this. `null` for an unrecognized preset id or degenerate (zero-area) dims.
 * @param {'full'|'s_to_n'|'n_to_s'|'w_to_e'|'e_to_w'} presetId
 * @param {object} opts
 * @param {{sceneX:number,sceneY:number,sceneWidth:number,sceneHeight:number}} opts.dims
 * @param {number} opts.screenW @param {number} opts.screenH
 * @param {number} [opts.framePadding=0.99]
 * @param {boolean} [opts.letterboxEnabled=false]
 * @returns {{keyframes: CameraKeyframe[], suggestedSweepMs: number,
 *   suggestedLongJumpFadeCut: boolean}|null}
 */
export function generateKeyframePreset(presetId, opts) {
  const dims = opts?.dims;
  if (!dims || !(dims.sceneWidth > 0) || !(dims.sceneHeight > 0)) return null;
  const framePadding = opts.framePadding ?? 0.99;
  const viewport = resolveCameraPathViewport(opts.screenW, opts.screenH, opts.letterboxEnabled === true);
  const viewW = viewport.width;
  const viewH = viewport.height;
  const kf = (x, y, scale, cutBefore = false) => ({
    x: Math.round(x),
    y: Math.round(y),
    scale: Number(scale.toFixed(4)),
    holdMs: 0,
    cutBefore,
  });

  if (presetId === 's_to_n' || presetId === 'n_to_s') {
    const zoom = clampZoom((viewW / dims.sceneWidth) * framePadding);
    const b = getBoundsForZoom(dims, zoom, viewW, viewH);
    const top = kf(b.centerX, b.yT, zoom);
    const bot = kf(b.centerX, b.yB, zoom);
    const keyframes = presetId === 's_to_n' ? [bot, top] : [top, bot];
    return { keyframes, suggestedSweepMs: PRESET_SUGGESTED_SWEEP_MS, suggestedLongJumpFadeCut: false };
  }

  if (presetId === 'w_to_e' || presetId === 'e_to_w') {
    const zoom = clampZoom((viewH / dims.sceneHeight) * framePadding);
    const b = getBoundsForZoom(dims, zoom, viewW, viewH);
    const left = kf(b.xL, b.centerY, zoom);
    const right = kf(b.xR, b.centerY, zoom);
    const keyframes = presetId === 'w_to_e' ? [left, right] : [right, left];
    return { keyframes, suggestedSweepMs: PRESET_SUGGESTED_SWEEP_MS, suggestedLongJumpFadeCut: false };
  }

  // DIAGONAL CORNER-TO-CORNER (rapid-diagonal-stress-2026-08-12) — the
  // benchmark's own deliberate worst case: a fast pass covers both axes at
  // once, so a floor's residency/paging system has to page in new content
  // from every direction simultaneously, unlike a pure N-S or W-E sweep.
  // "top"/"bottom" mean the SAME thing `n_to_s`'s own `.yT`/`.yB` already do
  // — Y increases SOUTH (`feedback_y_flip_recurring_risk`, bitten 5x
  // already; reusing `getBoundsForZoom`'s own field names rather than
  // re-deriving the axis is what keeps this preset from being a 6th).
  // Southwest = (west, south) = (xL, yB); northeast = (east, north) = (xR, yT).
  //
  // ⚠️ FIT BOTH AXES WITH REAL MARGIN, NOT A TIGHT SINGLE-AXIS FIT (found
  // live in this file's own test suite, 2026-08-12, TWICE) — n_to_s/w_to_e
  // each fit only the axis they pan along (width or height) at a TIGHT
  // ~0.99 padding, because the other axis is meant to stay centered and
  // `getBoundsForZoom` collapses a fully-visible axis to one centered point
  // by design. A diagonal pans BOTH axes at once, so it needs genuine
  // headroom on BOTH, not just "not the same axis n_to_s already uses" —
  // `Math.min(...)` at the SAME tight 0.99 padding still collapsed one axis
  // on a square scene (round 1 of this fix). The 'full' preset below solves
  // the identical problem with its own `sweepZoom` — fit to HALF the
  // narrower dimension, not the whole thing — reused here rather than
  // re-deriving a third margin constant.
  if (presetId === 'sw_to_ne' || presetId === 'ne_to_sw') {
    const zoom = clampZoom(Math.min(viewW / (dims.sceneWidth * 0.5), viewH / (dims.sceneHeight * 0.5)));
    const b = getBoundsForZoom(dims, zoom, viewW, viewH);
    const sw = kf(b.xL, b.yB, zoom);
    const ne = kf(b.xR, b.yT, zoom);
    const keyframes = presetId === 'sw_to_ne' ? [sw, ne] : [ne, sw];
    // Same "deliberately far apart, do not fade-cut it" reasoning as
    // n_to_s/w_to_e above — a corner-to-corner diagonal is the LONGEST
    // possible pair on the map, guaranteed to trip the long-jump heuristic.
    return { keyframes, suggestedSweepMs: PRESET_SUGGESTED_SWEEP_MS, suggestedLongJumpFadeCut: false };
  }

  if (presetId === 'full') {
    const fitZoom = clampZoom(Math.min(viewW / dims.sceneWidth, viewH / dims.sceneHeight) * 0.95, 0.05, 2.0);
    // "trying to frame the camera so that it can see roughly 50% of the map
    // based on zoom" (author spec, 2026-07-29) — pure width-based, matching
    // the simpler s_to_n/n_to_s presets' own formula (viewW / sceneWidth)
    // rather than the old min/max-of-both-axes 0.65 fit: both edge sweeps
    // below are vertical (south->north), so WIDTH is the dimension that
    // actually reads as "half the map" while sweeping. Supersedes the
    // original V2-ported formula for THIS preset only — see the section
    // header above.
    const sweepZoom = clampZoom(viewW / (dims.sceneWidth * 0.5), 0.05, 2.0);
    const b = getBoundsForZoom(dims, sweepZoom, viewW, viewH);
    // Four INDEPENDENT shots (V2's own A-B/C-D/E-F/G-H pairs), each its own
    // sweep — NOT one continuous pan through all 8 points. `cutBefore` marks
    // where a new shot starts (C, E, G). Revised 2026-07-29 per author spec:
    // shot 1 zooms in on the map's centre to the SAME ~50% level the edge
    // sweeps use (B); shot 2 sweeps the WEST edge south → north; shot 3
    // sweeps the EAST edge south → north TOO — the SAME direction as shot 2,
    // not V2's mirrored north→south ("we do the same to the right side");
    // shot 4 cuts back to centre at that same ~50% level ("cut to the middle
    // of the map again" — G is numerically identical to B, just cutBefore
    // instead of panned-into) and THEN zooms back out to the wide fit ("zoom
    // back out") as its own separate pure-scale sweep, not a pan.
    return {
      keyframes: [
        kf(b.centerX, b.centerY, fitZoom), // A — start zoomed out
        kf(b.centerX, b.centerY, sweepZoom), // B — shot 1: zoom IN to centre (~50%)
        kf(b.xL, b.yB, sweepZoom, true), // C — shot 2 starts: west edge, south
        kf(b.xL, b.yT, sweepZoom), //           shot 2: south → north
        kf(b.xR, b.yB, sweepZoom, true), // E — shot 3 starts: east edge, south
        kf(b.xR, b.yT, sweepZoom), //           shot 3: south → north (same direction as shot 2)
        kf(b.centerX, b.centerY, sweepZoom, true), // G — shot 4 starts: CUT back to centre (still ~50%, == B)
        kf(b.centerX, b.centerY, fitZoom), //           shot 4: zoom back OUT to the wide fit
      ],
      suggestedSweepMs: PRESET_SUGGESTED_SWEEP_MS,
      // 2026-07-21 LIVE BUG (author): shots 2 and 3 (C→D, E→F) deliberately
      // span nearly the map's full height — exactly what the long-jump
      // heuristic exists to catch on an ACCIDENTAL far-apart pair, so left
      // at its default-true it silently swapped the intended smooth sweeps
      // for instant fade-cuts ("it just immediately swaps to a different
      // position"). V2 never applied its own equivalent heuristic
      // (`shouldUseSigLocFadeCut`) to its base A-B/C-D/E-F/G-H sweeps either
      // — only to AUTO-INSERTED significant-location detours. A generated
      // preset's every point is deliberately far apart by design; the
      // heuristic has no accidental case to protect here.
      suggestedLongJumpFadeCut: false,
    };
  }

  return null;
}
