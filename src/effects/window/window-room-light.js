/**
 * SUN & ROOMS — window light that moves and smears with the sun, and never leaves its room.
 *
 * Author, 2026-10-28: *"As the sun tracks across the sky we get lovely movement of shadows from buildings but what
 * would be really nice is if the _Window light also moved and smeared at different times of day. HOWEVER, what we
 * never want is for that light to move accidentally into another room or outside the building. You want a sort of AO
 * around each Foundry wall to create soft transitions … You could use this information to make the _Window effect
 * brighter on one side of the house at dawn and darker on the other and vice versa."*
 *
 * Built on the ROOM MAP (`scene/room-map.js`): every room on the floor, numbered, with distance-to-wall and, per cell,
 * the outward direction of the window nearest to it (reached through the room only). The painted light at every
 * point is split by how squarely THAT window faces the sun, `f`:
 *
 *   - the DIRECT share, `f · cookie`, is a beam: it DRIFTS away from the sun by the building-shadow throw
 *     (`height / tan(elevation)` along `marchDirectionToSun` reversed — long at dawn and dusk, short at noon), SMEARS
 *     back toward where it was painted over {@link WINDOW_ROOM_TAPS} taps, and brightens with the sun low ('Sunny
 *     side boost');
 *   - the DIFFUSE share, `(1 − f) · cookie`, is skylight through glass facing away: it stays exactly where it is
 *     painted and darkens with the sun low ('Shaded side dim').
 *
 * So at dawn the east windows' light streams west across their rooms and glows, the west windows go quiet and stay
 * put, and at dusk it turns around — window by window, not room by room.
 *
 * THE BEAM STAYS IN ITS ROOM, AND ONLY GOES WHERE IT CAN SEE: a tap only counts when its point is in the SAME room
 * as the pixel it lights AND the straight path between them is clear — the taps are walked outward from the pixel and
 * a clearance read from the distance field only ever drops, so once the path touches a wall everything beyond is
 * shaded, with a soft penumbra. (2026-10-28, the Compound: with the room test alone, light from one half of a room
 * reached the other half AROUND a wall stub — the greenhouse doorway — and every wall corner threw a hard,
 * cell-stepped line along the sun.) Both ends also fade near any wall over 'Wall fade' — the "AO" — so the beam thins
 * out against a wall. The fade grows in only as the beam actually moves, so with the sun overhead the light is as
 * painted. Everything soft is read from the room map's FILTERED field, never per cell, so nothing steps.
 *
 * THE SMEAR FADES OUT, AND BLURS AS IT GOES (author, 2026-11-01: *"the smeared version of the light [should be]
 * brightest at one end and gradually blur and become dimmer till it hits 0% brightness at the extreme end of the
 * smear"*). Each tap carries a weight that falls linearly along the smear — 1 at the painted end, 0 at the far end
 * ({@link roomTapRamp}) — and the sum is divided by the weights' nominal total, so a wide patch keeps its brightness
 * where it is painted and a narrow one spreads the same light. A tap also reads its cookie blurred, more so the further
 * along the smear it sits ({@link roomTapFootprint}): the far end of the streak is a soft haze, not a hard copy of the
 * glass.
 *
 * EVERY TAP READS A FILTERED FOOTPRINT, NEVER A POINT (author, 2026-11-04: *"when it stretches and smears, we get quite
 * a noisy grainy effect, is there no smoother way"*). Eight point reads along a 150 px throw sit ~19 px apart; the
 * gaps used to be hidden by shifting each pixel's taps by its own noise value and spinning its blur disc by another,
 * which traded stripes for grain — and nothing in the window pass averages grain away. Now each tap reads the mask
 * through its mip chain with explicit gradients: a footprint as long as the tap spacing along the throw (so the eight
 * footprints tile the line with no gaps: no stripes) and as wide as its blur across it (so a glazing bar that runs
 * along the sun's line stays crisp near the window). The GPU's anisotropic filter does the averaging; every pixel
 * reads the same smooth field as its neighbours, so there is no grain. The mask is uploaded with mips for this
 * (`loadMaskImageTexture({ mipmaps: true })`); every other read of it is pinned to level 0, unchanged.
 *
 * THE SMEAR IS LIGHT-WEIGHTED, NOT MAX: five max-blended copies of a patch read as five stripes (found on the bench,
 * 2026-10-28). The taps are folded as a mean (energy kept: a longer patch is a dimmer one) blended toward a
 * light-weighted mean, `Σ cᵢ·aᵢ / Σ aᵢ` with aᵢ the tap's own peak (brightness kept, and smooth: one tap's edge is
 * the streak's edge), by 'Smear brightness'.
 *
 * This file is the CPU spec (`evalRoomLightPixel`, Node-tested, and what the bench renders screenshots with) and its
 * TSL port (`createWindowRoomLight`), THREE injected. The room term is a JS-time branch in `window-render.js`: the
 * bare `cookie` rung compiles none of it.
 *
 * @module effects/window/window-room-light
 */

import { marchDirectionToSun } from '../lighting/sun-occlusion.js';

/** Beam taps along the throw (single-tap decodes; the undrifted full glass decode is the diffuse share's). */
export const WINDOW_ROOM_TAPS = 8;
/**
 * Clearance samples on the path between the pixel and the first tap (distance-field reads only). The clearance is
 * then also read at each tap's UNJITTERED position — never the jittered one: the shadow a wall throws on the beam must
 * be a smooth function of the pixel, and jittered samples let neighbouring pixels test the wall at different points
 * (bench, 2026-10-28: a grainy, hard edge).
 */
export const WINDOW_ROOM_GAP_SAMPLES = 4;
/** Below this sun elevation the throw stops growing (the cot() would run off to infinity). */
export const WINDOW_ROOM_MIN_ELEVATION_DEG = 4;
/** Mirrors `scene/room-map.js#ROOM_DIST_PX_PER_UNIT` (one-way zone layering keeps it a copy; pinned by test). */
export const WINDOW_ROOM_DIST_PX_PER_UNIT = 2;

/** The author's dials, defaulted — mirrored by `WINDOW_PARAMS`' 'Sun & rooms' section. */
export const WINDOW_ROOM_DEFAULTS = Object.freeze({
  drift: 1,
  throwHeightPx: 120,
  maxDriftPx: 150,
  smear: 1,
  smearKeep: 0.18,
  smearBlurPx: 24,
  wallFadePx: 48,
  wallFadeStrength: 1,
  sideBoost: 0.5,
  sideDim: 0.45,
  lowSunDeg: 50,
  wallThicknessPx: 10,
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * The author's dials from the render state's params, defaults standing in for anything missing.
 * @param {object} p
 */
export function resolveRoomLook(p = {}) {
  const D = WINDOW_ROOM_DEFAULTS;
  const n = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    drift: Math.max(0, n(p.sunDrift, D.drift)),
    throwHeightPx: Math.max(0, n(p.sunThrowHeightPx, D.throwHeightPx)),
    maxDriftPx: Math.max(0, n(p.sunMaxDriftPx, D.maxDriftPx)),
    smear: clamp01(n(p.sunSmear, D.smear)),
    smearKeep: clamp01(n(p.sunSmearKeep, D.smearKeep)),
    smearBlurPx: Math.max(0, n(p.sunSmearBlurPx, D.smearBlurPx)),
    wallFadePx: Math.max(0, n(p.roomWallFadePx, D.wallFadePx)),
    wallFadeStrength: clamp01(n(p.roomWallFadeStrength, D.wallFadeStrength)),
    sideBoost: Math.max(0, n(p.sunSideBoost, D.sideBoost)),
    sideDim: clamp01(n(p.sunSideDim, D.sideDim)),
    lowSunDeg: Math.min(90, Math.max(1, n(p.sunLowDeg, D.lowSunDeg))),
    wallThicknessPx: Math.max(2, n(p.roomWallThicknessPx, D.wallThicknessPx)),
  };
}

/**
 * The sun, resolved once per frame on the CPU: the throw (world px, AWAY from the sun — the way the beam lands), the
 * unit vector toward the sun (what a window's outlook is compared against), and how low the sun is (the sun-side
 * weight). At night nothing moves and nothing faces anything: the throw, the side weight and `toSun` all fade with
 * `dayFactor01`.
 * @param {{elevationDeg?:number, azimuthDeg?:number, dayFactor01?:number}|null} sun
 * @param {ReturnType<typeof resolveRoomLook>} look
 */
export function resolveRoomSunFrame(sun, look) {
  const elev = Number.isFinite(sun?.elevationDeg) ? sun.elevationDeg : 90;
  const az = Number.isFinite(sun?.azimuthDeg) ? sun.azimuthDeg : 180;
  const day = clamp01(Number.isFinite(sun?.dayFactor01) ? sun.dayFactor01 : 1);
  const toSun = marchDirectionToSun(az);
  const e = (Math.max(elev, WINDOW_ROOM_MIN_ELEVATION_DEG) * Math.PI) / 180;
  const len = Math.min(look.maxDriftPx, look.throwHeightPx / Math.tan(e)) * look.drift * day;
  return {
    throwX: -toSun.x * len,
    throwY: -toSun.y * len,
    throwLenPx: len,
    toSunX: toSun.x * day,
    toSunY: toSun.y * day,
    lowSun01: (1 - smoothstep(0, look.lowSunDeg, elev)) * day,
  };
}

/**
 * THE STRIKE'S FRAME (mmp-63o.2): a lightning flash is, for a window, a second sun — low, cold and brief, standing
 * where the strike is. `toLight` is the unit vector from the scene toward the strike; the beam is thrown away from
 * it the full `maxDriftPx · drift` (a flash comes in low), and every window facing it counts as sunward.
 * @param {{toLightX:number, toLightY:number}} flash
 * @param {ReturnType<typeof resolveRoomLook>} look
 */
export function resolveRoomFlashFrame(flash, look) {
  const x = Number.isFinite(flash?.toLightX) ? flash.toLightX : 0;
  const y = Number.isFinite(flash?.toLightY) ? flash.toLightY : 0;
  const l = Math.hypot(x, y);
  const ux = l > 1e-6 ? x / l : 0;
  const uy = l > 1e-6 ? y / l : -1;
  const len = look.maxDriftPx * look.drift;
  return { throwX: -ux * len, throwY: -uy * len, throwLenPx: len, toSunX: ux, toSunY: uy, lowSun01: 1 };
}

/**
 * The sun's frame and the strike's, mixed by how much of the light at this moment is the flash (`w`, 0..1). At
 * w = 0 it is exactly the sun's frame (byte-identical uniforms); at night a strike's w is near 1. Pure.
 * @param {ReturnType<typeof resolveRoomSunFrame>} sun @param {ReturnType<typeof resolveRoomFlashFrame>} flash
 * @param {number} w
 */
export function blendRoomFrames(sun, flash, w) {
  const k = clamp01(Number.isFinite(w) ? w : 0);
  if (!(k > 0) || !flash) return sun;
  const m = (a, b) => a + (b - a) * k;
  const throwX = m(sun.throwX, flash.throwX);
  const throwY = m(sun.throwY, flash.throwY);
  return {
    throwX,
    throwY,
    throwLenPx: Math.hypot(throwX, throwY),
    toSunX: m(sun.toSunX, flash.toSunX),
    toSunY: m(sun.toSunY, flash.toSunY),
    lowSun01: m(sun.lowSun01, flash.lowSun01),
  };
}

/** Where along the throw tap `k` reads: from `1 − smear` of the way back to the full drift. */
export function roomTapT(k, smear) {
  return 1 - smear * (1 - (k + 0.5) / WINDOW_ROOM_TAPS);
}

/**
 * Tap `k`'s weight: 1 at the painted end of the smear, falling linearly to `1 − smear` at the far end — so with the
 * full smear the light reaches 0 exactly where the streak ends, and with no smear every tap counts the same.
 */
export function roomTapRamp(k, smear) {
  return 1 - smear * ((k + 0.5) / WINDOW_ROOM_TAPS);
}

/** The ramp's total over the taps: what the weighted sum is divided by. */
export function roomRampNorm(smear) {
  return WINDOW_ROOM_TAPS * (1 - smear / 2);
}

/** The gap between neighbouring taps along the throw, world px. */
export function roomTapSpacingPx(throwLenPx, smear) {
  return (Math.max(throwLenPx, 0) * clamp01(smear)) / WINDOW_ROOM_TAPS;
}

/**
 * The blur's footprint across the throw per px of `smearBlurPx · smear · (k + ½)/taps` (the old disc's radius). A
 * filtered read spreads about half its footprint either way (σ ≈ ½ · footprint); 1.4 matches the spread of the old
 * per-pixel disc (a ring of that radius, σ ≈ 0.71 r), so the far-end haze keeps its measured width (the lab,
 * 2026-11-04: a footprint of 2 r washed a glazing bar along the throw from 0.21 contrast to 0.08).
 */
export const WINDOW_ROOM_BLUR_FOOTPRINT = 1.4;

/**
 * The patch of cookie tap `k` averages — the read's footprint, world px: `across` the throw it is the blur, growing
 * from nothing at the painted end of the smear to {@link WINDOW_ROOM_BLUR_FOOTPRINT}` · blurPx · smear` at the far
 * end; `along` the throw it is never shorter than the tap spacing, so the eight footprints tile the smear's line end
 * to end (see the header: no stripes, no noise).
 * @returns {{along:number, across:number}}
 */
export function roomTapFootprint(k, smear, blurPx, throwLenPx) {
  const across = WINDOW_ROOM_BLUR_FOOTPRINT * Math.max(blurPx, 0) * clamp01(smear) * ((k + 0.5) / WINDOW_ROOM_TAPS);
  return { along: Math.max(roomTapSpacingPx(throwLenPx, smear), across), across };
}

/** Sub-samples per footprint side in the CPU twin. */
const TWIN_STEPS = 7;

/**
 * The cookie averaged over a footprint centred on (x, y), its `along` side on the unit vector (ux, uy) — the CPU
 * twin of the shader's anisotropic mip read: tent weights reaching one footprint either way, as a filtered read's do
 * (and tents a spacing wide tile a line exactly, as the footprints along the throw must). The twin is the spec of
 * WHERE the light is averaged; the GPU's exact filter shape is its own.
 */
function footprintCookie(sampleCookie, x, y, ux, uy, along, across) {
  if (along < 0.5 && across < 0.5) return sampleCookie(x, y);
  const out = [0, 0, 0];
  let wsum = 0;
  const half = (TWIN_STEPS - 1) / 2;
  for (let i = 0; i < TWIN_STEPS; i++) {
    const fa = (i - half) / (half + 1);
    for (let j = 0; j < TWIN_STEPS; j++) {
      const fc = (j - half) / (half + 1);
      const w = (1 - Math.abs(fa)) * (1 - Math.abs(fc));
      const a = fa * along;
      const c = fc * across;
      const v = sampleCookie(x + ux * a - uy * c, y + uy * a + ux * c);
      out[0] += v[0] * w;
      out[1] += v[1] * w;
      out[2] += v[2] * w;
      wsum += w;
    }
  }
  return [out[0] / wsum, out[1] / wsum, out[2] / wsum];
}

/** Where gap clearance sample `j` (0..{@link WINDOW_ROOM_GAP_SAMPLES}−1) sits: evenly up to the first tap, unjittered. */
export function roomGapT(j, smear) {
  return (1 - smear) * ((j + 0.5) / WINDOW_ROOM_GAP_SAMPLES);
}

/**
 * How squarely the windows behind an outlook vector face the sun, 0..1 (`toSun` already fades at night). The vector is
 * unnormalised (`scene/room-map.js#computeRoomOutlook`): between two windows facing opposite ways it is short, and the
 * facing goes to nothing smoothly instead of flipping.
 * @param {{x:number,y:number}|null} v @param {{toSunX:number,toSunY:number}} frame
 */
export function windowSunFacing(v, frame) {
  if (!v) return 0;
  return smoothstep(0, 1, v.x * frame.toSunX + v.y * frame.toSunY);
}

/**
 * THE CPU TWIN of the shader, one pixel. `sampleCookie(x,y)` is the painted light (rgb, 0 off the mask); `room(x,y)`
 * returns `{id, distPx, vec}` — the id of the cell (walls carry their room's), and the filtered distance to the nearest
 * wall and outlook vector there. `cellSize` is the room map's, for the penumbra ({@link roomOcclusionSoftPx}).
 * @returns {{rgb:number[], direct:number[], diffuse:number[], facing:number, weight:number}}
 */
export function evalRoomLightPixel({ x, y, sampleCookie, room, frame, look, cellSize = 12.5 }) {
  const occSoftPx = roomOcclusionSoftPx(cellSize, frame.throwLenPx, look.smear);
  const P = room(x, y);
  const fP = windowSunFacing(P.vec, frame);
  const tx = frame.throwX;
  const ty = frame.throwY;
  const fade = Math.max(look.wallFadePx, 1);
  const aoW = look.wallFadeStrength * smoothstep(0, fade, Math.hypot(tx, ty));
  const tLen = Math.hypot(tx, ty);
  const ux = tLen > 1e-6 ? tx / tLen : 1;
  const uy = tLen > 1e-6 ? ty / tLen : 0;
  // THE WAY MUST BE CLEAR: the light at a tap reaches P only if nothing on the path between blocks it. The clearance is
  // a running minimum outward from P — over the gap before the first tap, then at each tap's UNJITTERED position — so
  // once the path touches a wall everything beyond it is shaded.
  const clearAt = (t) => smoothstep(0, occSoftPx, room(x - tx * t, y - ty * t).distPx);
  let vis = 1;
  for (let j = 0; j < WINDOW_ROOM_GAP_SAMPLES; j++) vis = Math.min(vis, clearAt(roomGapT(j, look.smear)));
  const sum = [0, 0, 0];
  const wsum = [0, 0, 0];
  let asum = 0;
  let gate = 0;
  for (let k = 0; k < WINDOW_ROOM_TAPS; k++) {
    const t = roomTapT(k, look.smear);
    const qx = x - tx * t;
    const qy = y - ty * t;
    const Q = room(qx, qy);
    const same = Q.id === P.id ? 1 : 0;
    const w = same * vis * (1 + (smoothstep(0, fade, Q.distPx) - 1) * aoW);
    // A tap's OWN clearance shades only the taps beyond it, never itself: the light it reads is painted right against
    // its window wall, and counting that wall shut every beam off at its source (bench, 2026-10-28: the patch stopped
    // moving at all). What lies past it — out through the glass — is shaded.
    vis = Math.min(vis, clearAt(roomTapT(k, look.smear)));
    const fp = roomTapFootprint(k, look.smear, look.smearBlurPx, tLen);
    const c = footprintCookie(sampleCookie, qx, qy, ux, uy, fp.along, fp.across);
    const f = windowSunFacing(Q.vec, frame);
    const ramp = roomTapRamp(k, look.smear);
    const d = c.map((v) => v * w * f * ramp);
    const a = Math.max(d[0], d[1], d[2]);
    for (let i = 0; i < 3; i++) {
      sum[i] += d[i];
      wsum[i] += d[i] * a;
    }
    asum += a;
    gate += w;
  }
  const destFade = 1 + (smoothstep(0, fade, P.distPx) - 1) * aoW;
  const boost = 1 + frame.lowSun01 * look.sideBoost;
  const dim = Math.max(0, 1 - frame.lowSun01 * look.sideDim);
  const here = sampleCookie(x, y);
  const direct = sum.map((s, i) => {
    const avg = s / roomRampNorm(look.smear);
    const wmean = wsum[i] / Math.max(asum, 1e-5);
    return (avg + (wmean - avg) * look.smearKeep) * destFade * boost;
  });
  const diffuse = here.map((v) => v * (1 - fP) * dim);
  return {
    rgb: direct.map((v, i) => v + diffuse[i]),
    direct,
    diffuse,
    facing: fP,
    weight: gate / WINDOW_ROOM_TAPS,
  };
}

/**
 * The penumbra a wall corner throws on the beam, world px: never sharper than 1.5 room-map cells, and never sharper
 * than the gap between the clearance samples — the clearance is only known AT them, so a narrower penumbra would step
 * as each sample crosses a wall. As wide as the spacing, the shadow edge is a smooth ramp.
 * @param {number} cellSize @param {number} [throwLenPx] @param {number} [smear]
 */
export function roomOcclusionSoftPx(cellSize, throwLenPx = 0, smear = WINDOW_ROOM_DEFAULTS.smear) {
  const cell = 1.5 * (Number.isFinite(cellSize) ? cellSize : 12.5);
  const len = Number.isFinite(throwLenPx) ? throwLenPx : 0;
  const s = Number.isFinite(smear) ? Math.min(Math.max(smear, 0), 1) : WINDOW_ROOM_DEFAULTS.smear;
  return Math.max(12, cell, len * Math.max(s / WINDOW_ROOM_TAPS, (1 - s) / WINDOW_ROOM_GAP_SAMPLES));
}

/**
 * The TSL port. One handle per built material (a tier rebuild makes a new one), like `window-rain.js`'s.
 *
 * ⚠️ The gated build in `window-render.js` constructs its nodes LATER, inside a TSL `Fn` — so texture nodes built after
 * a `setRoomMap` must start from the CURRENT textures, not the construction-time placeholders. `liveIds`/`liveRoomData`
 * are what every fetch reads, and `setRoomMap` also updates every node already built.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.roomTexture - the id texture; a placeholder until a room map exists (every pixel in one room).
 * @param {*} args.fieldTexture - the distance + outlook texture; a placeholder until then (an outlook of (0,0) faces
 *   nothing, so all of the light is the static share and nothing moves).
 */
export function createWindowRoomLight({ THREE, roomTexture, fieldTexture }) {
  const TSL = THREE.TSL;
  const {
    float,
    vec2,
    vec3,
    uniform,
    texture,
    floor,
    max,
    min,
    abs,
    step,
    mix,
    smoothstep: ss,
    length,
    fract,
    dot,
    int,
    Loop,
    Fn,
  } = TSL;

  const D = WINDOW_ROOM_DEFAULTS;
  /** (minX, minY, 1/width, 1/height) of the room grid, world px. */
  const uRoomRect = uniform(TSL.vec4(0, 0, 1, 1));
  /** (cols, rows) of the room grid. */
  const uRoomSize = uniform(vec2(1, 1));
  const uOccSoft = uniform(float(roomOcclusionSoftPx(12.5)));
  const uThrow = uniform(vec2(0, 0));
  const uToSun = uniform(vec2(0, 0));
  const uSmear = uniform(float(D.smear));
  const uKeep = uniform(float(D.smearKeep));
  /** The far end's blur radius, world px: `smearBlurPx · smear`. */
  const uBlur = uniform(float(D.smearBlurPx * D.smear));
  const uFadePx = uniform(float(D.wallFadePx));
  const uFadeStrength = uniform(float(D.wallFadeStrength));
  const uBoost = uniform(float(D.sideBoost));
  const uDim = uniform(float(D.sideDim));
  const uLowSun = uniform(float(0));

  /** CPU copies the penumbra is resolved from each frame (`roomOcclusionSoftPx`). */
  let cellNow = 12.5;
  let liveIds = roomTexture;
  let liveRoomData = fieldTexture;
  const idNodes = [];
  const fieldNodes = [];

  const roomUv = (P) => P.sub(uRoomRect.xy).mul(uRoomRect.zw);
  /** The room id under P, read at its texel's centre: exact. */
  const fetchId = (P) => {
    const cell = floor(roomUv(P).mul(uRoomSize));
    const node = texture(liveIds, cell.add(0.5).div(uRoomSize));
    idNodes.push(node);
    const s = node.toVar();
    return floor(s.r.mul(255).add(0.5)).add(floor(s.g.mul(255).add(0.5)).mul(256));
  };
  /** The distance to the nearest wall and the facing of the outlook at P, linearly filtered: no cell steps. */
  const fetchField = (P) => {
    const node = texture(liveRoomData, roomUv(P));
    fieldNodes.push(node);
    const s = node.toVar();
    const v = vec2(s.g, s.b).mul(255).sub(127.5).div(127.5);
    return {
      distPx: s.r.mul(255 * WINDOW_ROOM_DIST_PX_PER_UNIT),
      facing: ss(float(0), float(1), dot(v, uToSun)),
      outlook: length(v),
    };
  };

  return {
    /**
     * Everything about the pixel P that does not depend on a tap: its room, its facing, the fades, the path clearance
     * up to the first tap.
     * @param {*} P - `positionWorld.xy`.
     */
    prepare(P) {
      const idP = fetchId(P).toVar('winRoomIdP');
      const here = fetchField(P);
      const distP = here.distPx.toVar('winRoomDistP');
      const facingP = here.facing.toVar('winRoomFacingP');
      const fade = max(uFadePx, float(1));
      const aoW = uFadeStrength.mul(ss(float(0), fade, length(uThrow))).toVar('winRoomAoW');
      const destFade = float(1).add(ss(float(0), fade, distP).sub(1).mul(aoW));
      // `k` is a JS number OR a shader int (the loop in `combine`): every helper below takes either, through
      // `float(k)`, so one tap's arithmetic is written once whichever way it is emitted.
      // The throw's unit direction and the tap spacing (`roomTapSpacingPx`), per frame but per pixel constant.
      const throwLen = length(uThrow).toVar('winRoomThrowLen');
      const dir = uThrow.div(max(throwLen, float(1e-6))).toVar('winRoomDir');
      const spacing = throwLen.mul(uSmear).div(WINDOW_ROOM_TAPS).toVar('winRoomSpacing');
      /**
       * `roomTapFootprint` as two world-px vectors — the read's gradients: `dx` along the throw (at least the tap
       * spacing), `dy` across it (the blur). The caller scales them to mask UV.
       */
      const footprintAt = (k) => {
        const across = uBlur.mul(float(WINDOW_ROOM_BLUR_FOOTPRINT)).mul(float(k).add(0.5).div(WINDOW_ROOM_TAPS));
        const along = max(spacing, across);
        return { dx: dir.mul(along), dy: vec2(dir.y.negate(), dir.x).mul(across) };
      };
      /** `roomTapRamp`: 1 at the painted end of the smear, 1 − smear at the far end. */
      const rampAt = (k) => float(1).sub(uSmear.mul(float(k).add(0.5).div(WINDOW_ROOM_TAPS)));
      /** World px tap `k` reads back from P (the sample point is P − this). */
      const offsetAt = (k) =>
        uThrow.mul(float(1).sub(uSmear.mul(float(1).sub(float(k).add(0.5).div(WINDOW_ROOM_TAPS)))));
      // THE WAY MUST BE CLEAR — the running-minimum clearance (`evalRoomLightPixel`): over the gap before the first
      // tap here, then at each tap's own position in `combine`.
      const clearAt = (t) => ss(float(0), uOccSoft, fetchField(P.sub(uThrow.mul(t))).distPx);
      let vis = float(1);
      for (let j = 0; j < WINDOW_ROOM_GAP_SAMPLES; j++) {
        vis = min(
          vis,
          clearAt(
            float(1)
              .sub(uSmear)
              .mul((j + 0.5) / WINDOW_ROOM_GAP_SAMPLES)
          )
        );
      }
      const visGap = vis.toVar('winRoomVisGap');
      const clearAtTap = (k) =>
        clearAt(float(1).sub(uSmear.mul(float(1).sub(float(k).add(0.5).div(WINDOW_ROOM_TAPS)))));
      // A stable colour per room for the debug view.
      const hue = vec3(
        fract(idP.mul(0.618034)),
        fract(idP.mul(0.414214).add(0.33)),
        fract(idP.mul(0.732051).add(0.67))
      );
      return {
        idP,
        aoW,
        fade,
        visGap,
        offsetAt,
        footprintAt,
        rampAt,
        clearAtTap,
        destFade,
        facingP,
        debugRooms: hue.mul(0.75).add(0.25),
        debugWallDist: vec3(1, 1, 1).mul(distP.div(200).min(1)),
        debugSun: vec3(facingP, here.outlook.min(1), uLowSun),
      };
    },
    /**
     * Fold the beam taps (each shaded by the path clearance at its own t) and add the static share. `beamAt(k)` is
     * the light read at tap k (already gated to the mask file); `here` is the undrifted light at P (the full glass
     * decode).
     *
     * ONE TAP, IN A REAL SHADER LOOP (2026-11-02, the author: "Loading / Shader compilation times just exploded").
     * The taps used to be a JS `for` here AND in the caller's beam, so the whole tap — a cookie decode, two room-map
     * reads and the clearance read — was pasted into the shader once per tap: the window light measured ~238,000
     * characters, the largest render pipeline in a Big Bank load, and the one a first load after an update waited
     * on. The fold is unchanged, order included (each tap's weight uses the clearance up to the tap BEFORE it).
     * @param {ReturnType<ReturnType<typeof createWindowRoomLight>['prepare']>} prep
     * @param {(k: *) => *} beamAt - the beam's light at tap `k` (a shader int). @param {*} here
     * @param {*} P - `positionWorld.xy`, the same node `prepare` got.
     */
    combine(prep, beamAt, here, P) {
      // ⚠️ INSIDE ITS OWN `Fn`: a TSL `Loop` is emitted only into a function body being built, and the window
      // material is assembled outside one on some paths — there the loop vanished from the shader without a word
      // (caught by the shader-lab A/B: an 8,960-character "window" with no taps in it). A parameterless `Fn` is
      // inlined, so this costs no call.
      const folded = Fn(() => {
        const sum = vec3(0, 0, 0).toVar('winRoomSum');
        const wsum = vec3(0, 0, 0).toVar('winRoomWSum');
        const asum = float(0).toVar('winRoomASum');
        const gate = float(0).toVar('winRoomGate');
        const vis = float(prep.visGap).toVar('winRoomVis');
        Loop({ start: int(0), end: int(WINDOW_ROOM_TAPS), type: 'int', condition: '<' }, ({ i: k }) => {
          const Q = P.sub(prep.offsetAt(k));
          const f = fetchField(Q);
          const dQ = f.distPx.toVar('winRoomDQ');
          const same = float(1).sub(step(float(0.5), abs(fetchId(Q).sub(prep.idP))));
          // ⚠️ AN ASSIGNMENT, NOT `expr.toVar()`: a `toVar` is emitted where it is first READ — after the `vis`
          // update below — so it would see the clearance INCLUDING this tap. `assign` is a statement, in order.
          const w = float(0).toVar('winRoomW');
          w.assign(same.mul(vis).mul(float(1).add(ss(float(0), prep.fade, dQ).sub(1).mul(prep.aoW))));
          // The tap's own clearance shades only the taps beyond it (see `evalRoomLightPixel`).
          vis.assign(min(vis, prep.clearAtTap(k)));
          const d = beamAt(k).mul(w).mul(f.facing).mul(prep.rampAt(k)).toVar('winRoomD');
          const a = max(max(d.r, d.g), d.b);
          sum.addAssign(d);
          wsum.addAssign(d.mul(a));
          asum.addAssign(a);
          gate.addAssign(w);
        });
        const avg = sum.div(float(WINDOW_ROOM_TAPS).mul(float(1).sub(uSmear.mul(0.5))));
        const wmean = wsum.div(max(asum, float(1e-5)));
        const direct = mix(avg, wmean, uKeep)
          .mul(prep.destFade)
          .mul(float(1).add(uLowSun.mul(uBoost)));
        return TSL.vec4(direct, gate.div(float(WINDOW_ROOM_TAPS)));
      })().toVar('winRoomFolded');
      const diffuse = here.mul(float(1).sub(prep.facingP)).mul(max(float(0), float(1).sub(uLowSun.mul(uDim))));
      return {
        cookie: folded.xyz.add(diffuse).toVar('winRoomCookie'),
        debugGate: vec3(1, 1, 1).mul(folded.w),
      };
    },
    setLook(look) {
      uSmear.value = look.smear;
      uKeep.value = look.smearKeep;
      uBlur.value = look.smearBlurPx * look.smear;
      uFadePx.value = look.wallFadePx;
      uFadeStrength.value = look.wallFadeStrength;
      uBoost.value = look.sideBoost;
      uDim.value = look.sideDim;
    },
    /** @param {ReturnType<typeof resolveRoomSunFrame>} frame */
    setFrame(frame) {
      uThrow.value.set(frame.throwX, frame.throwY);
      uToSun.value.set(frame.toSunX, frame.toSunY);
      uLowSun.value = frame.lowSun01;
      uOccSoft.value = roomOcclusionSoftPx(cellNow, frame.throwLenPx);
    },
    /**
     * Point every fetch at a room map.
     * @param {{roomTexture:*, fieldTexture:*, spec:{minX:number,minY:number,cols:number,rows:number,cellSize:number}}} m
     */
    setRoomMap({ roomTexture: rt, fieldTexture: ft, spec }) {
      liveIds = rt;
      liveRoomData = ft;
      for (const n of idNodes) n.value = rt;
      for (const n of fieldNodes) n.value = ft;
      const w = spec.cols * spec.cellSize;
      const h = spec.rows * spec.cellSize;
      uRoomRect.value.set(spec.minX, spec.minY, 1 / Math.max(w, 1e-6), 1 / Math.max(h, 1e-6));
      uRoomSize.value.set(spec.cols, spec.rows);
      cellNow = spec.cellSize;
    },
    /** TEST/DIAGNOSTIC: what is pushed, and how many texture nodes exist. */
    snapshot: () => ({
      throw: [uThrow.value.x, uThrow.value.y],
      toSun: [uToSun.value.x, uToSun.value.y],
      lowSun: uLowSun.value,
      occSoftPx: uOccSoft.value,
      idNodes: idNodes.length,
      fieldNodes: fieldNodes.length,
      roomSize: [uRoomSize.value.x, uRoomSize.value.y],
    }),
  };
}
