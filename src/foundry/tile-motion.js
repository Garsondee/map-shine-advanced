/**
 * foundry/tile-motion.js — PURE motion math for tile motion (V2 port +
 * replan, author request 2026-08-27: full feature parity, replanned for V4's
 * own rendering model). No `canvas`/`Hooks`/DOM here — the live half
 * (persistence, hooks, per-frame entry point) is tile-motion-runtime.js.
 * Mirrors camera-path.js's pure/live split.
 *
 * ROTATION CONVENTION — verified against `scene-geometry.js#computeQuadCorners`,
 * V4's own authoritative rule for how a tile's static `rotation` maps to world
 * space: `x' = x + cos(a)*lx - sin(a)*ly, y' = y + sin(a)*lx + cos(a)*ly`, `a`
 * in radians from degrees, straight in Foundry's Y-down canvas space, NO Y
 * negation. V2's equivalent (`_rotateFoundryLocalToWorld`) negates local Y
 * first because it targets a Y-up Three.js scene; ported here WITHOUT that
 * negation so an animated tile's spin direction matches what dragging that
 * SAME tile's native Foundry rotation handle would produce — a correctness
 * bar V2's own internal convention can't give us on its own, since we don't
 * inherit whatever second negation elsewhere in V2's pipeline cancelled it
 * back out. See this module's own tests for the regression check.
 *
 * GPU COMPOSITION — the render side (vt-pan-viewer.js) applies ONE rigid
 * transform to every vertex of a tile, however many it has (a plain quad or a
 * coverage-tessellated grid, vt/coverage-mesh.js):
 *   v' = pivotWorld + Rot(deltaRotationRad) * (v - pivotWorld) + translateWorld
 * where `v` is the vertex's own REST-pose world position (already baked with
 * the tile's static rotation by computeQuadCorners). `computeTileWorldTransforms`
 * is the one function that resolves this per-tile, per-frame, INCLUDING
 * parent/child hierarchy — see `combineRigidDeltas`'s own header for why a
 * naive "just add up the angles" approach is NOT the same as this and gets a
 * passenger tile's own quad corners rotated around the wrong point.
 *
 * @module foundry/tile-motion
 */

export const MOTION_TYPES = Object.freeze(['rotation', 'orbit', 'pingPong', 'sine']);
const MOTION_TYPE_SET = new Set(MOTION_TYPES);

export const ROTATION_EASING_TYPES = Object.freeze([
  'linear',
  'easeInSine',
  'easeOutSine',
  'easeInOutSine',
  'easeInOutCubic',
  'easeInOutBack',
  'easeOutBounce',
  'easeInOutElastic',
  'clockwork',
  'clockwork-chaos',
]);
const EASING_SET = new Set(ROTATION_EASING_TYPES);

export const CURRENT_TILE_CONFIG_VERSION = 1;
export const CURRENT_TRANSPORT_VERSION = 1;

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;

// ===========================================================================
// NUMBER / SHAPE HELPERS
// ===========================================================================

/** @param {*} v @param {number} fallback @returns {number} */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {*} v @param {number} min @param {number} max @param {number} fallback @returns {number} */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** @param {*} raw @param {number} fx @param {number} fy @returns {{x:number,y:number}} */
function point(raw, fx = 0, fy = 0) {
  if (Array.isArray(raw) && raw.length >= 2) return { x: num(raw[0], fx), y: num(raw[1], fy) };
  if (raw && typeof raw === 'object') return { x: num(raw.x, fx), y: num(raw.y, fy) };
  return { x: fx, y: fy };
}

// ===========================================================================
// NORMALIZATION — never throws on stale/hand-edited/absent data, matching
// camera-path.js's own normalizer posture.
// ===========================================================================

/** @typedef {{x:number, y:number, snapToGrid:boolean}} TileMotionPivot */
/** @typedef {{type:'rotation'|'orbit'|'pingPong'|'sine', speed:number, phase:number,
 *   rotationEasing:string, easeStrength:number, clockworkSteps:number, clockworkHold:number,
 *   clockworkJank:number, loopMode:'loop'|'pingPong', radius:number, pointA:{x:number,y:number},
 *   pointB:{x:number,y:number}, amplitudeX:number, amplitudeY:number, amplitudeRot:number}} TileMotionParams */
/** @typedef {{scrollU:number, scrollV:number, rotateSpeed:number, pivotU:number, pivotV:number}} TileTextureMotion */
/** @typedef {{version:number, enabled:boolean, shadowProjectionEnabled:boolean, renderAboveTokens:boolean,
 *   mode:'transform'|'texture', parentId:string|null, pivot:TileMotionPivot, motion:TileMotionParams,
 *   textureMotion:TileTextureMotion}} TileMotionConfig */

/**
 * @param {*} raw - a Tile document's own `tileMotion` flag payload.
 * @param {string} [tileId] - this tile's own id, so a self-referencing
 *   `parentId` (however it got there) is dropped rather than creating a
 *   trivial one-tile cycle.
 * @returns {TileMotionConfig}
 */
export function normalizeTileMotionConfig(raw, tileId = '') {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const mode = cfg.mode === 'texture' ? 'texture' : 'transform';
  const parentId = typeof cfg.parentId === 'string' && cfg.parentId && cfg.parentId !== tileId ? cfg.parentId : null;
  const pivot = cfg.pivot && typeof cfg.pivot === 'object' ? cfg.pivot : {};
  const motion = cfg.motion && typeof cfg.motion === 'object' ? cfg.motion : {};
  const textureMotion = cfg.textureMotion && typeof cfg.textureMotion === 'object' ? cfg.textureMotion : {};
  const motionType = MOTION_TYPE_SET.has(motion.type) ? motion.type : 'rotation';
  const loopMode = motion.loopMode === 'pingPong' ? 'pingPong' : 'loop';

  return {
    version: CURRENT_TILE_CONFIG_VERSION,
    enabled: !!cfg.enabled,
    shadowProjectionEnabled: !!cfg.shadowProjectionEnabled,
    renderAboveTokens: !!cfg.renderAboveTokens,
    mode,
    parentId,
    pivot: { x: num(pivot.x, 0), y: num(pivot.y, 0), snapToGrid: !!pivot.snapToGrid },
    motion: {
      type: motionType,
      speed: num(motion.speed, 0),
      phase: num(motion.phase, 0),
      rotationEasing: EASING_SET.has(motion.rotationEasing) ? motion.rotationEasing : 'linear',
      easeStrength: clampNum(motion.easeStrength, 0, 1, 1),
      clockworkSteps: Math.round(clampNum(motion.clockworkSteps, 1, 48, 8)),
      clockworkHold: clampNum(motion.clockworkHold, 0, 0.95, 0.55),
      clockworkJank: clampNum(motion.clockworkJank, 0, 1, 0),
      loopMode,
      radius: Math.max(0, num(motion.radius, 0)),
      pointA: point(motion.pointA, 0, 0),
      pointB: point(motion.pointB, 0, 0),
      amplitudeX: num(motion.amplitudeX, 0),
      amplitudeY: num(motion.amplitudeY, 0),
      amplitudeRot: num(motion.amplitudeRot, 0),
    },
    textureMotion: {
      scrollU: num(textureMotion.scrollU, 0),
      scrollV: num(textureMotion.scrollV, 0),
      rotateSpeed: num(textureMotion.rotateSpeed, 0),
      pivotU: clampNum(textureMotion.pivotU, 0, 1, 0.5),
      pivotV: clampNum(textureMotion.pivotV, 0, 1, 0.5),
    },
  };
}

/** @typedef {{version:number, playing:boolean, paused:boolean, pausedAtMs:number|null,
 *   anchorElapsedSec:number, anchorAtMs:number, speedPercent:number, timeFactorPercent:number,
 *   autoPlayEnabled:boolean}} TileMotionTransport */

/** @param {*} raw @returns {TileMotionTransport} */
export function normalizeTransportState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const pausedAtMs = Number(s.pausedAtMs);
  return {
    version: CURRENT_TRANSPORT_VERSION,
    playing: !!s.playing,
    paused: !!s.paused,
    pausedAtMs: Number.isFinite(pausedAtMs) ? pausedAtMs : null,
    anchorElapsedSec: Math.max(0, num(s.anchorElapsedSec, 0)),
    anchorAtMs: Math.max(0, num(s.anchorAtMs, 0)),
    speedPercent: clampNum(s.speedPercent, 0, 400, 100),
    timeFactorPercent: clampNum(s.timeFactorPercent, 0, 200, 100),
    autoPlayEnabled: s.autoPlayEnabled !== false,
  };
}

// ===========================================================================
// TRANSPORT CLOCK — anchor-based (NOT V2's per-client accumulator). V2's
// `update()` advances `_elapsedAccumSec` by scaled frame-delta, so a client
// joining AFTER a mid-session speed change computes a DIFFERENT pose than one
// present since start — there is no way to reconstruct accumulator history
// from the persisted flag alone. Fixed here: every rate/phase-affecting
// action re-anchors via `reanchorTransport`, so `computeElapsedSec` is a PURE
// function of the persisted blob + `nowMs` alone — any client, joining at any
// time, computes byte-identical poses.
// ===========================================================================

/**
 * @param {TileMotionTransport} transport - already normalized.
 * @param {number} nowMs - `game.time.serverTime` (shared clock across clients).
 * @returns {number} animation-seconds elapsed, >= 0.
 */
export function computeElapsedSec(transport, nowMs) {
  if (!transport?.playing) return 0;
  const speed = clampNum(transport.speedPercent, 0, 400, 100) * 0.01;
  const timeFactor = clampNum(transport.timeFactorPercent, 0, 200, 100) * 0.01;
  const effectiveNowMs = transport.paused
    ? (transport.pausedAtMs ?? transport.anchorAtMs)
    : num(nowMs, transport.anchorAtMs);
  const dtMs = Math.max(0, effectiveNowMs - transport.anchorAtMs);
  return Math.max(0, transport.anchorElapsedSec + dtMs * 0.001 * speed * timeFactor);
}

/**
 * Re-stamp the anchor at `nowMs`, freezing whatever `elapsedSec` currently is
 * as the new baseline. Call this from every transport mutation that could
 * otherwise retroactively rescale past playback (start, resume, a speed or
 * time-factor change) — NOT from pause (pausing sets `pausedAtMs` instead, so
 * `computeElapsedSec` keeps reporting the frozen value without needing a
 * fresh anchor) or stop (stopped playback reports 0 unconditionally).
 * @param {TileMotionTransport} transport @param {number} nowMs
 * @returns {TileMotionTransport}
 */
export function reanchorTransport(transport, nowMs) {
  return {
    ...transport,
    anchorElapsedSec: computeElapsedSec(transport, nowMs),
    anchorAtMs: num(nowMs, transport.anchorAtMs),
  };
}

// ===========================================================================
// EASING — direct ports of V2's per-curve math (tile-motion-manager.js
// `_easeByName01`/`_easeOutBounce01`/`_hash01`/`_getTileSeed`/`_applyJankWarp01`/
// `_computeClockworkProgress01`/`_computeRotationProgress01`).
// ===========================================================================

/** @param {number} u @returns {number} */
function easeOutBounce01(u) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (u < 1 / d1) return n1 * u * u;
  if (u < 2 / d1) {
    const t = u - 1.5 / d1;
    return n1 * t * t + 0.75;
  }
  if (u < 2.5 / d1) {
    const t = u - 2.25 / d1;
    return n1 * t * t + 0.9375;
  }
  const t = u - 2.625 / d1;
  return n1 * t * t + 0.984375;
}

/** @param {string} name @param {number} u @returns {number} 0..1 */
export function easeByName01(name, u) {
  const t = clampNum(u, 0, 1, 0);
  if (name === 'easeInSine') return 1 - Math.cos(t * Math.PI * 0.5);
  if (name === 'easeOutSine') return Math.sin(t * Math.PI * 0.5);
  if (name === 'easeInOutSine') return -(Math.cos(Math.PI * t) - 1) * 0.5;
  if (name === 'easeInOutCubic') return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) * 0.5;
  if (name === 'easeInOutBack') {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return t < 0.5
      ? Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2) * 0.5
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (2 * t - 2) + c2) + 2) * 0.5;
  }
  if (name === 'easeOutBounce') return easeOutBounce01(t);
  if (name === 'easeInOutElastic') {
    if (t === 0 || t === 1) return t;
    const c5 = (2 * Math.PI) / 4.5;
    return t < 0.5
      ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) * 0.5
      : Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5) * 0.5 + 1;
  }
  return t;
}

/** @param {number} value @returns {number} 0..1, deterministic. */
export function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453123;
  return x - Math.floor(x);
}

/** @param {string} tileId @returns {number} a stable per-tile seed (FNV-1a of the id string). */
export function tileSeed(tileId) {
  if (!tileId) return 1;
  let h = 2166136261;
  const s = String(tileId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) + 1;
}

/** @param {number} u @param {string} tileId @param {number} cycleIndex @param {number} jank @returns {number} 0..1 */
export function applyJankWarp01(u, tileId, cycleIndex, jank) {
  const t = clampNum(u, 0, 1, 0);
  const amount = clampNum(jank, 0, 1, 0);
  if (amount <= 0.0001) return t;
  const seed = tileSeed(tileId) + cycleIndex * 131.37;
  const phaseA = hash01(seed + 0.71);
  const phaseB = hash01(seed + 9.33);
  const freq = 2 + Math.floor(hash01(seed + 4.61) * 4); // 2..5
  const amp = 0.16 * amount;
  const envelope = t * (1 - t) * 4;
  const wobbleA = Math.sin((t * freq + phaseA) * TAU) * amp;
  const wobbleB = Math.sin((t * (freq + 1.5) + phaseB) * TAU) * amp * 0.45;
  return clampNum(t + (wobbleA + wobbleB) * envelope, 0, 1, t);
}

/**
 * @param {number} u @param {TileMotionParams} motion @param {string} tileId
 * @param {number} cycleIndex @param {number} [chaosScale=1]
 * @returns {number} 0..1
 */
export function computeClockworkProgress01(u, motion, tileId, cycleIndex, chaosScale = 1) {
  const t = clampNum(u, 0, 1, 0);
  const steps = Math.max(1, Math.round(clampNum(motion?.clockworkSteps, 1, 48, 8)));
  const holdBase = clampNum(motion?.clockworkHold, 0, 0.95, 0.55);
  const jank = clampNum(motion?.clockworkJank, 0, 1, 0);

  let scaled = t * steps;
  let stepIndex = Math.floor(scaled);
  if (stepIndex >= steps) {
    stepIndex = steps - 1;
    scaled = steps;
  }
  const localT = clampNum(scaled - stepIndex, 0, 1, 0);

  const seedBase = tileSeed(tileId) + cycleIndex * 97.17 + stepIndex * 23.59;
  const holdNoise = (hash01(seedBase + 0.23) - 0.5) * 2;
  const motionNoise = (hash01(seedBase + 1.83) - 0.5) * 2;
  const overshootNoise = (hash01(seedBase + 4.17) - 0.5) * 2;
  const microStopRoll = hash01(seedBase + 5.41);

  const hold = clampNum(holdBase + holdNoise * 0.35 * jank * chaosScale, 0, 0.98, holdBase);
  let stepU = 0;
  if (localT > hold) {
    stepU = clampNum((localT - hold) / Math.max(0.0001, 1 - hold), 0, 1, 0);
    const accel = 1 + Math.max(0, motionNoise) * (2.2 * jank * chaosScale);
    stepU = 1 - Math.pow(1 - stepU, accel);
    if (microStopRoll < 0.3 * jank * chaosScale) {
      const stopCenter = hash01(seedBase + 6.01) * 0.8 + 0.1;
      const stopWidth = 0.08 + hash01(seedBase + 6.89) * 0.12;
      const d = Math.abs(stepU - stopCenter);
      if (d < stopWidth) {
        const stall = 1 - d / stopWidth;
        stepU *= 1 - stall * 0.75;
      }
    }
    const overshoot = overshootNoise * (0.14 * jank * chaosScale);
    stepU += Math.sin(stepU * Math.PI) * overshoot;
    stepU = clampNum(stepU, 0, 1, 0);
  }

  const minU = stepIndex / steps;
  const maxU = (stepIndex + 1) / steps;
  return clampNum(minU + (maxU - minU) * stepU, minU, maxU, minU);
}

/** @param {TileMotionConfig} config @param {number} u @param {string} tileId @param {number} cycleIndex @returns {number} 0..1 */
export function computeRotationProgress01(config, u, tileId, cycleIndex) {
  const motion = config?.motion || {};
  const easing = EASING_SET.has(motion.rotationEasing) ? motion.rotationEasing : 'linear';
  const easeStrength = clampNum(motion.easeStrength, 0, 1, 1);
  const jank = clampNum(motion.clockworkJank, 0, 1, 0);
  const warpedU = applyJankWarp01(u, tileId, cycleIndex, jank);

  let easedU;
  if (easing === 'clockwork') easedU = computeClockworkProgress01(warpedU, motion, tileId, cycleIndex, 1);
  else if (easing === 'clockwork-chaos') easedU = computeClockworkProgress01(warpedU, motion, tileId, cycleIndex, 1.75);
  else easedU = easeByName01(easing, warpedU);

  return clampNum(warpedU + (easedU - warpedU) * easeStrength, 0, 1, warpedU);
}

/**
 * @param {TileMotionConfig} config @param {number} elapsedSec @param {string} tileId
 * @returns {number} radians — the tile's OWN rotation delta this frame (not
 *   including anything inherited from a parent).
 */
export function computeRotationDeltaRad(config, elapsedSec, tileId) {
  const motion = config?.motion || {};
  const rawDeg = num(motion.phase, 0) + num(motion.speed, 0) * elapsedSec;

  const easing = motion.rotationEasing || 'linear';
  const jank = motion.clockworkJank || 0;
  const easeStrength = motion.easeStrength ?? 1;

  // Fast path: plain linear rotation with no easing/jank shaping needed.
  if ((easing === 'linear' || easeStrength <= 0) && jank <= 0.0001) {
    return rawDeg * DEG_TO_RAD;
  }

  const rawTurns = rawDeg / 360;
  const sign = rawTurns < 0 ? -1 : 1;
  const absTurns = Math.abs(rawTurns);
  const cycleIndex = Math.floor(absTurns);
  const cycleU = absTurns - cycleIndex;
  const shapedU = computeRotationProgress01(config, cycleU, tileId, cycleIndex);
  const totalDeg = sign * (cycleIndex * 360 + shapedU * 360);
  return totalDeg * DEG_TO_RAD;
}

/** @param {number} rawDeg @param {'loop'|'pingPong'} loopMode @returns {number} 0..1 */
function loop01(rawDeg, loopMode) {
  const cycle = (((rawDeg / 360) % 1) + 1) % 1;
  if (loopMode === 'pingPong') return cycle <= 0.5 ? cycle * 2 : (1 - cycle) * 2;
  return cycle;
}

// ===========================================================================
// LOCAL -> WORLD ROTATION — the Y-flip-free port of V2's
// `_rotateFoundryLocalToWorld`. See this module's header.
// ===========================================================================

/** @param {number} lx @param {number} ly @param {number} rotationRad @returns {{x:number,y:number}} */
function rotateLocalToWorld(lx, ly, rotationRad) {
  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
}

/**
 * The exact inverse of `rotateLocalToWorld` — for the dialog's "Pick Pivot on
 * Canvas": a clicked WORLD point, converted to the LOCAL pivot offset that
 * reproduces that same world position when the tile is at rest.
 * @param {{x:number,y:number}} worldPoint
 * @param {{x:number,y:number,rotation:number}} restPose - `rotation` in DEGREES
 *   (a raw TileDocument's own field), matching `computeQuadCorners`'s convention.
 * @returns {{x:number,y:number}}
 */
export function worldPointToLocalPivot(worldPoint, restPose) {
  const rotationRad = num(restPose?.rotation, 0) * DEG_TO_RAD;
  const dx = num(worldPoint?.x, 0) - num(restPose?.x, 0);
  const dy = num(worldPoint?.y, 0) - num(restPose?.y, 0);
  const c = Math.cos(-rotationRad);
  const s = Math.sin(-rotationRad);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// ===========================================================================
// RIGID DELTA — a tile's own per-frame motion, BEFORE hierarchy composition.
// {deltaRotationRad, pivotWorldX/Y, translateWorldX/Y} such that any point
// `v` on the tile (its rest-pose world position) maps to
//   v' = pivot + Rot(deltaRotationRad)*(v - pivot) + translate
// One shape for all 4 motion types: `orbit`/`pingPong` are pure translations
// (delta=0, pivot irrelevant since Rot(0) cancels it), `rotation` is a pure
// pivot-rotation (translate=0), `sine` is both composed (translate computed
// first, then the pivot for the rotation half is anchored at the
// ALREADY-TRANSLATED position — ported exactly from V2's `_applySineTile`,
// which calls `_applyPivotRotation(baseX+off.x, baseY+off.y, ...)`, not the
// untranslated base).
// ===========================================================================

/** @typedef {{deltaRotationRad:number, pivotWorldX:number, pivotWorldY:number,
 *   translateWorldX:number, translateWorldY:number}} RigidDelta */

/** @param {number} x @param {number} y @returns {RigidDelta} identity — every vertex maps to itself. */
function identityDelta(x, y) {
  return { deltaRotationRad: 0, pivotWorldX: x, pivotWorldY: y, translateWorldX: 0, translateWorldY: 0 };
}

/**
 * @param {TileMotionConfig} config @param {{x:number,y:number,rotationRad:number}} inherited
 * @param {number} elapsedSec @param {string} tileId @returns {RigidDelta}
 */
export function resolveRotationDelta(config, inherited, elapsedSec, tileId) {
  const delta = computeRotationDeltaRad(config, elapsedSec, tileId);
  const pivotOff = rotateLocalToWorld(config.pivot.x, config.pivot.y, inherited.rotationRad);
  return {
    deltaRotationRad: delta,
    pivotWorldX: inherited.x + pivotOff.x,
    pivotWorldY: inherited.y + pivotOff.y,
    translateWorldX: 0,
    translateWorldY: 0,
  };
}

/** @param {TileMotionConfig} config @param {{x:number,y:number,rotationRad:number}} inherited @param {number} elapsedSec @returns {RigidDelta} */
export function resolveOrbitDelta(config, inherited, elapsedSec) {
  const motion = config.motion;
  const rawDeg = motion.phase + motion.speed * elapsedSec;
  const u = loop01(rawDeg, motion.loopMode);
  const angle = u * TAU;
  const off = rotateLocalToWorld(
    config.pivot.x + motion.radius * Math.cos(angle),
    config.pivot.y + motion.radius * Math.sin(angle),
    inherited.rotationRad
  );
  return identityDeltaWithTranslate(inherited, off);
}

/** @param {TileMotionConfig} config @param {{x:number,y:number,rotationRad:number}} inherited @param {number} elapsedSec @returns {RigidDelta} */
export function resolvePingPongDelta(config, inherited, elapsedSec) {
  const motion = config.motion;
  const rawDeg = motion.phase + motion.speed * elapsedSec;
  const u = loop01(rawDeg, motion.loopMode);
  const lx = motion.pointA.x + (motion.pointB.x - motion.pointA.x) * u;
  const ly = motion.pointA.y + (motion.pointB.y - motion.pointA.y) * u;
  const off = rotateLocalToWorld(lx, ly, inherited.rotationRad);
  return identityDeltaWithTranslate(inherited, off);
}

/** @param {{x:number,y:number}} inherited @param {{x:number,y:number}} off @returns {RigidDelta} */
function identityDeltaWithTranslate(inherited, off) {
  return {
    deltaRotationRad: 0,
    pivotWorldX: inherited.x,
    pivotWorldY: inherited.y,
    translateWorldX: off.x,
    translateWorldY: off.y,
  };
}

/** @param {TileMotionConfig} config @param {{x:number,y:number,rotationRad:number}} inherited @param {number} elapsedSec @returns {RigidDelta} */
export function resolveSineDelta(config, inherited, elapsedSec) {
  const motion = config.motion;
  const rawDeg = motion.phase + motion.speed * elapsedSec;
  const wave = Math.sin(rawDeg * DEG_TO_RAD);
  const off = rotateLocalToWorld(motion.amplitudeX * wave, motion.amplitudeY * wave, inherited.rotationRad);
  // Pivot is anchored at the TRANSLATED base (inherited + off), matching V2's
  // `_applyPivotRotation(baseX+off.x, baseY+off.y, ...)` exactly — the pivot
  // offset itself still rotates by the (unchanged) inherited rotation.
  const pivotOff = rotateLocalToWorld(config.pivot.x, config.pivot.y, inherited.rotationRad);
  return {
    deltaRotationRad: motion.amplitudeRot * wave * DEG_TO_RAD,
    pivotWorldX: inherited.x + off.x + pivotOff.x,
    pivotWorldY: inherited.y + off.y + pivotOff.y,
    translateWorldX: off.x,
    translateWorldY: off.y,
  };
}

/** @param {TileMotionConfig} config @param {number} elapsedSec
 * @returns {{offsetU:number, offsetV:number, rotCos:number, rotSin:number, pivotU:number, pivotV:number}}
 *   UV-space pose for `mode:'texture'`. No "base offset" to preserve (unlike
 *   V2, which layers scroll on top of whatever a live `THREE.Texture` already
 *   had) — V4's UV pipeline has no pre-existing arbitrary transform, so this
 *   is computed fresh from `elapsedSec` every frame with no accumulation and
 *   therefore no long-session drift.
 */
export function resolveTexturePose(config, elapsedSec) {
  const tm = config.textureMotion;
  const rotationRad = (config.motion.phase + tm.rotateSpeed * elapsedSec) * DEG_TO_RAD;
  return {
    offsetU: tm.scrollU * elapsedSec,
    offsetV: tm.scrollV * elapsedSec,
    rotCos: Math.cos(rotationRad),
    rotSin: Math.sin(rotationRad),
    pivotU: tm.pivotU,
    pivotV: tm.pivotV,
  };
}

/**
 * @param {TileMotionConfig} config @param {{x:number,y:number,rotationRad:number}} inherited
 * @param {number} elapsedSec @param {string} tileId @returns {RigidDelta}
 */
export function resolveMotionDelta(config, inherited, elapsedSec, tileId) {
  const type = config.motion.type;
  if (type === 'orbit') return resolveOrbitDelta(config, inherited, elapsedSec);
  if (type === 'pingPong') return resolvePingPongDelta(config, inherited, elapsedSec);
  if (type === 'sine') return resolveSineDelta(config, inherited, elapsedSec, tileId);
  return resolveRotationDelta(config, inherited, elapsedSec, tileId);
}

// ===========================================================================
// HIERARCHY COMPOSITION — `combineRigidDeltas(outer, inner)` composes two
// rigid deltas applied in sequence (outer FIRST, to the rest vertex; inner
// SECOND, to outer's result) into ONE equivalent rigid delta. This is NOT the
// same as summing angles and translations independently — a passenger tile
// (no own motion, `inner` = identity) must come out EXACTLY equal to `outer`
// so it rides its animated parent's full transform, including for vertices
// far from the tile's own origin (e.g. its own quad corners), which a naive
// per-origin-only computation would get wrong. Derived and numerically
// verified (see this module's own tests) by requiring
//   apply(v, combine(outer,inner)) === apply(apply(v,outer), inner)   for all v
// which forces:
//   pivot_c = outer.pivot
//   delta_c = outer.delta + inner.delta
//   T_c     = Rot(inner.delta)*(outer.pivot - inner.pivot) + Rot(inner.delta)*outer.T
//             + inner.T - (outer.pivot - inner.pivot)
// ===========================================================================

/** @param {RigidDelta} outer @param {RigidDelta} inner @returns {RigidDelta} */
export function combineRigidDeltas(outer, inner) {
  const c = Math.cos(inner.deltaRotationRad);
  const s = Math.sin(inner.deltaRotationRad);
  const rot = (x, y) => ({ x: x * c - y * s, y: x * s + y * c });
  const diff = { x: outer.pivotWorldX - inner.pivotWorldX, y: outer.pivotWorldY - inner.pivotWorldY };
  const rotDiff = rot(diff.x, diff.y);
  const rotOuterT = rot(outer.translateWorldX, outer.translateWorldY);
  return {
    deltaRotationRad: outer.deltaRotationRad + inner.deltaRotationRad,
    pivotWorldX: outer.pivotWorldX,
    pivotWorldY: outer.pivotWorldY,
    translateWorldX: rotDiff.x + rotOuterT.x + inner.translateWorldX - diff.x,
    translateWorldY: rotDiff.y + rotOuterT.y + inner.translateWorldY - diff.y,
  };
}

/** @param {number} x @param {number} y @param {RigidDelta} delta @returns {{x:number,y:number}} */
export function applyRigidDelta(x, y, delta) {
  const dx = x - delta.pivotWorldX;
  const dy = y - delta.pivotWorldY;
  const c = Math.cos(delta.deltaRotationRad);
  const s = Math.sin(delta.deltaRotationRad);
  return {
    x: delta.pivotWorldX + (dx * c - dy * s) + delta.translateWorldX,
    y: delta.pivotWorldY + (dx * s + dy * c) + delta.translateWorldY,
  };
}

// ===========================================================================
// MOTION GRAPH — near-verbatim port of V2's `_rebuildRuntimeGraph` (topological
// sort + cycle/missing-parent detection). This part of V2 was already
// well-designed; not redesigned here.
// ===========================================================================

/**
 * Whether a tile's OWN config would actually move it (V2's
 * `_isConfigEffectivelyAnimated`) — a tile with `enabled:true` but every
 * motion field at its zero default is a no-op and should not anchor a
 * traversal (though it can still be dragged along as someone else's passenger).
 * @param {TileMotionConfig} config @returns {boolean}
 */
export function isConfigEffectivelyAnimated(config) {
  if (!config?.enabled) return false;
  if (config.mode === 'texture') {
    const tm = config.textureMotion;
    return !!(tm.scrollU || tm.scrollV || tm.rotateSpeed || config.motion.phase);
  }
  const m = config.motion;
  if (m.type === 'rotation') return !!(m.speed || m.phase);
  if (m.type === 'sine') return !!(m.amplitudeX || m.amplitudeY || m.amplitudeRot);
  if (m.type === 'pingPong') return !!(m.pointA.x || m.pointA.y || m.pointB.x || m.pointB.y);
  if (m.type === 'orbit') return !!(m.radius || config.pivot.x || config.pivot.y);
  return true;
}

/**
 * @param {Map<string, TileMotionConfig>} configsById - every ENABLED tile's config.
 * @returns {{order:string[], invalidIds:Set<string>, missingParentIds:Set<string>}}
 *   `order` is topological (parent before child); a tile inside a parent
 *   cycle is fully excluded (in `invalidIds`, not `order`). A passenger with
 *   no own motion is still included in `order` (after its parent) so it can
 *   ride the parent's transform, matching V2's own child-collection pass.
 */
export function buildMotionGraph(configsById) {
  const order = [];
  const invalidIds = new Set();
  const missingParentIds = new Set();

  const enabledIds = [];
  const enabledSet = new Set(configsById.keys());
  const parentToChildren = new Map();

  for (const [tileId, cfg] of configsById) {
    if (cfg.parentId) {
      let children = parentToChildren.get(cfg.parentId);
      if (!children) {
        children = [];
        parentToChildren.set(cfg.parentId, children);
      }
      children.push(tileId);
    }
    if (isConfigEffectivelyAnimated(cfg)) enabledIds.push(tileId);
  }

  const visitState = new Map(); // 0=unseen(absent), 1=visiting, 2=done
  const stack = [];

  const visit = (tileId) => {
    const state = visitState.get(tileId) || 0;
    if (state === 2) return;
    if (state === 1) {
      const idx = stack.indexOf(tileId);
      if (idx >= 0) {
        for (let i = idx; i < stack.length; i++) invalidIds.add(stack[i]);
      } else {
        invalidIds.add(tileId);
      }
      return;
    }
    visitState.set(tileId, 1);
    stack.push(tileId);

    const cfg = configsById.get(tileId);
    const parentId = cfg?.parentId;
    if (parentId) {
      if (enabledSet.has(parentId)) visit(parentId);
      else missingParentIds.add(tileId);
    }

    stack.pop();
    visitState.set(tileId, 2);
    if (!invalidIds.has(tileId)) order.push(tileId);
  };

  for (const tileId of enabledIds) visit(tileId);

  const addedChildren = new Set();
  for (const tileId of [...order]) {
    const addChildrenRecursive = (parentId) => {
      const children = parentToChildren.get(parentId);
      if (!children) return;
      for (const childId of children) {
        if (!addedChildren.has(childId) && !invalidIds.has(childId)) {
          order.push(childId);
          addedChildren.add(childId);
          addChildrenRecursive(childId);
        }
      }
    };
    addChildrenRecursive(tileId);
  }

  return { order, invalidIds, missingParentIds };
}

// ===========================================================================
// MAIN ENTRY POINT
// ===========================================================================

/** @typedef {{x:number, y:number, width:number, height:number, rotation:number}} TileRestPlacement */
/** @typedef {RigidDelta & {texture: ReturnType<typeof resolveTexturePose>|null}} TileMotionFrameTransform */

/**
 * Resolve every enabled tile's per-frame GPU transform, one call per frame.
 * @param {Map<string, TileMotionConfig>} configsById - every ENABLED tile's
 *   normalized config (disabled tiles are the caller's job to filter out —
 *   this function does not need to know about a tile that isn't animated at
 *   all, and a disabled tile that's someone's parent degrades its children
 *   the same way a missing one does, matching V2's `enabledSet`).
 * @param {Map<string, TileRestPlacement>} restPosesById - the SAME tiles'
 *   rest placement (`tileDoc.x/y/rotation` — `computeTilePlacement`'s inputs,
 *   not its fitted output; motion operates on the document's own authored
 *   transform, not the art's fitted rect).
 * @param {TileMotionTransport} transport - already normalized.
 * @param {number} nowMs - `game.time.serverTime`.
 * @returns {{transforms: Map<string, TileMotionFrameTransform>, invalidIds: Set<string>, missingParentIds: Set<string>}}
 *   `transforms` is EMPTY when `!transport.playing` — "tile not in this map"
 *   means "apply identity," which is how stop() reproduces V2's
 *   `_restoreAllActiveTiles()` for free, with no restore code path needed.
 */
export function computeTileWorldTransforms(configsById, restPosesById, transport, nowMs) {
  const graph = buildMotionGraph(configsById);
  /** @type {Map<string, TileMotionFrameTransform>} */
  const transforms = new Map();
  if (!transport?.playing)
    return { transforms, invalidIds: graph.invalidIds, missingParentIds: graph.missingParentIds };

  const elapsedSec = computeElapsedSec(transport, nowMs);
  /** @type {Map<string, {x:number,y:number,rotationRad:number,totalDeltaRad:number}>} */
  const resolvedPoseById = new Map();
  /** @type {Map<string, RigidDelta>} */
  const resolvedDeltaById = new Map();

  for (const tileId of graph.order) {
    const config = configsById.get(tileId);
    const rest = restPosesById.get(tileId);
    if (!config || !rest) continue;
    const restRotationRad = num(rest.rotation, 0) * DEG_TO_RAD;

    // Inherited pose (V2's `_resolveInheritedTransform`): this tile's rest
    // origin, carried by however much its parent has ALREADY resolved this
    // frame (0 if no parent, or the parent is missing/invalid this frame —
    // degrading to the tile's own rest pose, same as V2's fallback).
    let inherited = { x: rest.x, y: rest.y, rotationRad: restRotationRad, totalDeltaRad: 0 };
    let outerDelta = identityDelta(rest.x, rest.y);
    if (config.parentId) {
      const parentPose = resolvedPoseById.get(config.parentId);
      const parentRest = restPosesById.get(config.parentId);
      const parentDelta = resolvedDeltaById.get(config.parentId);
      if (parentPose && parentRest && parentDelta) {
        const offX = rest.x - parentRest.x;
        const offY = rest.y - parentRest.y;
        const c = Math.cos(parentPose.totalDeltaRad);
        const s = Math.sin(parentPose.totalDeltaRad);
        inherited = {
          x: parentPose.x + (offX * c - offY * s),
          y: parentPose.y + (offX * s + offY * c),
          rotationRad: restRotationRad + parentPose.totalDeltaRad,
          totalDeltaRad: parentPose.totalDeltaRad,
        };
        outerDelta = parentDelta;
      }
    }

    const ownDelta =
      config.mode === 'texture'
        ? identityDelta(inherited.x, inherited.y) // texture mode never moves the quad itself
        : resolveMotionDelta(config, inherited, elapsedSec, tileId);
    const combined = combineRigidDeltas(outerDelta, ownDelta);
    const finalOrigin = applyRigidDelta(inherited.x, inherited.y, ownDelta);

    resolvedPoseById.set(tileId, {
      x: finalOrigin.x,
      y: finalOrigin.y,
      rotationRad: inherited.rotationRad + ownDelta.deltaRotationRad,
      totalDeltaRad: inherited.totalDeltaRad + ownDelta.deltaRotationRad,
    });
    resolvedDeltaById.set(tileId, combined);

    transforms.set(tileId, {
      ...combined,
      texture: config.mode === 'texture' ? resolveTexturePose(config, elapsedSec) : null,
    });
  }

  return { transforms, invalidIds: graph.invalidIds, missingParentIds: graph.missingParentIds };
}
