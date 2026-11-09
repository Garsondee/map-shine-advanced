/**
 * THE PIXEL PROBE (2026-07-19) — pure decode logic for a live GPU
 * pixel-readback diagnostic. Born from the region-darkness rendering audit:
 * `getRegionDarknessInfo()` proved a region's MATH was correct, but couldn't
 * answer whether that value actually reached the screen — `sampleIllumPixel`
 * (vt-pan-viewer.js) answers that by reading `buf:scene.illum` directly off
 * the GPU. This module holds the decode primitives worth Node-testing in
 * isolation: `decodeHalfFloatRgba` for the HalfFloatType targets (illum/lit/
 * albedo/coloration) so nobody has to hand-decode IEEE-754 half-float bit
 * patterns from a console readback again, and `decodeByteRgba` for the ONE
 * UnsignedByteType target (occlusion.mask) so that buffer's report reads in
 * the same 0..1-ish shape as every other, not a separate byte convention.
 * THIS TOOL FOUND [[keyhole-region-discard-noop-bug]] — a bug no amount of
 * code-reading or CPU-side diagnostics caught. It is the load-bearing
 * instrument for "the math is right but the picture is wrong": reach for it
 * before writing another CPU-side report.
 *
 * The author's own framing: V2 had a much larger "Scene Pixel Probe" tool
 * (legacy/utils/scene-pixel-probe.js, ~1600 lines) doing multi-point
 * brightness/lighting/mask attribution across V2's entire compositor stack
 * — explicitly NOT portable (coupled to V2's FloorCompositorV2/
 * WindowLightEffect/ColorCorrection internals that don't exist in V3), but
 * flagged as a genuinely useful CONCEPT worth a custom V3 rebuild later.
 * This module is the minimal seed of that rebuild: the decode primitive a
 * richer future probe (multi-point comparison, attribution, hypotheses)
 * would still need at its core, kept deliberately small and Node-tested now
 * rather than scoped up mid-investigation.
 *
 * @module diag/pixel-probe
 */

/**
 * Decode ONE 16-bit IEEE-754 half-float BIT PATTERN — exactly what a raw
 * GPU pixel readback of a `THREE.HalfFloatType` render target hands back
 * (verified live, 2026-07-19: `MapShine.sampleIllumPixel`'s first real call
 * returned `14780`, which THIS function decodes to ≈0.7168 — matching
 * `region-darkness.js`'s own computed `resultColor` of 0.7173 to within
 * half-float rounding, the exact number that confirmed a region WAS
 * correctly painting `buf:scene.illum` at that pixel). Standard IEEE-754
 * binary16: 1 sign bit, 5 exponent bits, 10 mantissa bits.
 *
 * @param {number} bits - 0..65535, a raw half-float bit pattern.
 * @returns {number} the decoded value (NaN/±Infinity handled per IEEE-754).
 */
export function halfFloatBitsToFloat32(bits) {
  const b = bits & 0xffff;
  const sign = b & 0x8000 ? -1 : 1;
  const exponent = (b >> 10) & 0x1f;
  const mantissa = b & 0x3ff;
  if (exponent === 0) {
    // Zero (mantissa 0) or a subnormal — both fall out of this one formula.
    return sign * mantissa * Math.pow(2, -24);
  }
  if (exponent === 0x1f) {
    return mantissa ? NaN : sign * Infinity;
  }
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
}

/**
 * Decode a raw RGBA readback (4 half-float bit patterns, as returned by
 * `renderer.readRenderTargetPixelsAsync` for a `HalfFloatType` target) into
 * normal 0..1-ish numbers.
 *
 * @param {ArrayLike<number>|null} raw - length-4 (or a multiple of 4 for a
 *   multi-pixel read; only the first 4 are decoded here — a probe reads one
 *   pixel at a time by design, see `sampleIllumPixel`'s own header).
 * @returns {[number,number,number,number]|null}
 */
export function decodeHalfFloatRgba(raw) {
  if (!raw || raw.length < 4) return null;
  return [
    halfFloatBitsToFloat32(raw[0]),
    halfFloatBitsToFloat32(raw[1]),
    halfFloatBitsToFloat32(raw[2]),
    halfFloatBitsToFloat32(raw[3]),
  ];
}

/**
 * Decode a raw RGBA readback from an `UnsignedByteType` target (plain 0..255
 * ints, e.g. `occlusion.mask` — see `describeOcclusionMask`'s own header for
 * why that buffer is a byte target, not half-float) into the same 0..1-ish
 * shape `decodeHalfFloatRgba` returns, so a probe report can treat every
 * buffer's `rgba` field uniformly regardless of its underlying GPU format.
 * Reference point: Foundry's occlusion clear colour is `[0,1,1,1]`
 * (`describeOcclusionMask`'s comment) — a genuinely CLEARED texel reads back
 * as raw bytes `[0,255,255,255]`, which this decodes to exactly `[0,1,1,1]`.
 *
 * @param {ArrayLike<number>|null} raw - length-4 (or a multiple of 4; only
 *   the first 4 are decoded, same one-pixel-at-a-time convention as
 *   `decodeHalfFloatRgba`).
 * @returns {[number,number,number,number]|null}
 */
export function decodeByteRgba(raw) {
  if (!raw || raw.length < 4) return null;
  return [(raw[0] & 0xff) / 255, (raw[1] & 0xff) / 255, (raw[2] & 0xff) / 255, (raw[3] & 0xff) / 255];
}

/** Channel labels, in `rgba` array order — used only for `diffProbeBuffers`' report shape. */
const RGBA_CHANNELS = ['r', 'g', 'b', 'a'];

/**
 * Diff two probe points' decoded buffers, per buffer, per channel —
 * automates the exact by-hand comparison that found
 * `keyhole-region-discard-noop-bug` and `keyhole-light-region-aware-ambient-fix`:
 * "a point just outside X reads one value, a point just inside reads
 * another — is that jump a real edge or a bug?" A big `biggestJump` between
 * two points that are close together in world space is the signature of a
 * hard seam (an unintended discontinuity); a big jump between two points on
 * opposite sides of an intentional boundary (a light's own falloff edge, a
 * region's authored edge) is expected and this alone can't tell the two
 * apart — it surfaces the number, the investigator still supplies the
 * context of where the points were placed.
 *
 * @param {object|null} prevBuffers - a probe result's `.buffers` (or null).
 * @param {object|null} currBuffers - a probe result's `.buffers` (or null).
 * @returns {{perBuffer: object, biggestJump: {buffer:string, channel:string,
 *   value:number, absValue:number}|null}|null} null if either side is
 *   missing (e.g. a point landed off-screen and was never read back).
 */
export function diffProbeBuffers(prevBuffers, currBuffers) {
  if (!prevBuffers || !currBuffers) return null;
  const perBuffer = {};
  let biggestJump = null;
  for (const name of Object.keys(currBuffers)) {
    const prevRgba = prevBuffers[name]?.rgba;
    const currRgba = currBuffers[name]?.rgba;
    if (!prevRgba || !currRgba) continue;
    const delta = currRgba.map((v, i) => +(v - prevRgba[i]).toFixed(4));
    perBuffer[name] = delta;
    for (let i = 0; i < delta.length; i++) {
      const absValue = Math.abs(delta[i]);
      if (!biggestJump || absValue > biggestJump.absValue) {
        biggestJump = { buffer: name, channel: RGBA_CHANNELS[i] ?? String(i), value: delta[i], absValue };
      }
    }
  }
  if (!Object.keys(perBuffer).length) return null;
  return { perBuffer, biggestJump };
}

// ============================================================================
// PROBE v2 PRIMITIVES (2026-11-08, mmp-78u.12) — the MSA Lab's main instrument.
// Born from the lab's friction log (tools/lab/FRICTION.md): the probe silently
// capped at 3 points, its readings mid-rebuild were garbage, and nothing compared
// the PRESENTED pixel with the lit buffer — the gap that hid the Lens freeze
// (mmp-78u.7: present kept reading a stale texture while "ready" said all good).
// ============================================================================

/** sRGB OETF: linear 0..1 → encoded 0..1 (the curve a screen byte is written in). */
export function srgbEncode(linear) {
  const c = Math.max(0, Math.min(1, Number(linear) || 0));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** A linear 0..1 value as the screen byte it would be with NO tone curve: round(255 · OETF). */
export function linearToSrgbByte(linear) {
  return Math.round(255 * srgbEncode(linear));
}

/**
 * The sRGB OETF WITHOUT the upper clamp (probe v2.1): the gamma-space value of a linear one, past 1 as well.
 * three's `sRGBTransferEOTF` is unclamped above 1, so a composite that sums past 1 in gamma (a lamp's hot
 * spot) lands in `lit` above 1.0, and this recovers that sum exactly. `srgbEncode` (clamped, for screen
 * bytes) would cap it at 1: on the lab's recorded readings the clamped version is off by up to 0.03 there.
 */
export function srgbEncodeUnclamped(linear) {
  const c = Math.max(0, Number(linear) || 0);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** The screen bytes `lit` would show with NO tone curve, per channel (probe v2.1's `expectedScreen`). */
export function expectedScreenBytes(lit) {
  if (!lit || typeof lit.length !== 'number' || lit.length < 3) return null;
  return [linearToSrgbByte(lit[0]), linearToSrgbByte(lit[1]), linearToSrgbByte(lit[2])];
}

/**
 * The first pixel of a canvas-texture copy as [r, g, b, a] bytes. The canvas format is
 * whatever `navigator.gpu.getPreferredCanvasFormat()` said — 'bgra8unorm' on most Windows
 * GPUs, so the bytes arrive B, G, R, A and must be swapped.
 * @param {ArrayLike<number>|null} bytes
 * @param {string} format
 * @returns {[number,number,number,number]|null}
 */
export function decodeCanvasPixel(bytes, format) {
  if (!bytes || bytes.length < 4) return null;
  const b = [bytes[0] & 0xff, bytes[1] & 0xff, bytes[2] & 0xff, bytes[3] & 0xff];
  return String(format).startsWith('bgra') ? [b[2], b[1], b[0], b[3]] : b;
}

/** Rec.709 luma weights (R, G, B), applied to gamma-encoded values (screen bytes), as luma is defined. */
export const REC709_LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

/** Rec.709 luma of [r, g, b] screen bytes, in levels (0..255). Null for a short or missing triple. */
export function luma709(rgb) {
  if (!rgb || typeof rgb.length !== 'number' || rgb.length < 3) return null;
  const [wr, wg, wb] = REC709_LUMA;
  return wr * (Number(rgb[0]) || 0) + wg * (Number(rgb[1]) || 0) + wb * (Number(rgb[2]) || 0);
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * How far the PRESENTED pixel sits from the lit buffer encoded straight to sRGB, judged on BRIGHTNESS.
 *
 * The present pass legitimately moves a pixel (tone curve, exposure, grade, bloom, lens), so a
 * small drift is normal: measured on the lab, noon Measure view moves 128 by ~-2, as-shipped by
 * ~-20. A drift of several dozen levels means the screen is not showing this frame's lit —
 * the Lens freeze moved a black wedge step (lit 0) to ~100.
 *
 * PROBE v2.1: the verdict reads LUMA (Rec.709, of the presented bytes against the expected bytes), not
 * the worst channel. Saturated colours legitimately move several dozen levels per channel in the present
 * pass while their brightness barely changes (the lab's cyan chip: red 43 -> 2), and the per-channel
 * verdict was tripping on that saturation. The thresholds are unchanged (check from 32, suspect from 64
 * levels). The per-channel `drift` and its worst `channelMaxAbs` (v2's `maxAbs`) stay, for information.
 *
 * @param {{lit:ArrayLike<number>|null, presented:ArrayLike<number>|null}} a - lit linear RGB, presented bytes.
 * @param {{check?:number, suspect?:number}} [t] - thresholds in screen levels of luma.
 * @returns {{expected:number[], drift:number[], channelMaxAbs:number, lumaExpected:number,
 *   lumaPresented:number, lumaDrift:number, verdict:'ok'|'check'|'suspect'}|null} `lumaDrift` is
 *   presented minus expected luma (from the unrounded lumas), one decimal.
 */
export function judgePresentedDrift({ lit, presented }, { check = 32, suspect = 64 } = {}) {
  const expected = expectedScreenBytes(lit);
  if (!expected || !presented || typeof presented.length !== 'number' || presented.length < 3) return null;
  const drift = expected.map((e, i) => Math.round((Number(presented[i]) || 0) - e));
  const channelMaxAbs = Math.max(...drift.map(Math.abs));
  const lumaExpected = luma709(expected);
  const lumaPresented = luma709(presented);
  const lumaDrift = round1(lumaPresented - lumaExpected);
  const size = Math.abs(lumaDrift);
  const verdict = size >= suspect ? 'suspect' : size >= check ? 'check' : 'ok';
  return {
    expected,
    drift,
    channelMaxAbs,
    lumaExpected: round1(lumaExpected),
    lumaPresented: round1(lumaPresented),
    lumaDrift,
    verdict,
  };
}

/** Art darker than this in gamma (sRGB 0..1) makes a light multiplier meaningless: light times nothing. */
export const GAIN_MIN_ALBEDO_SRGB = 0.02;

/**
 * THE GAMMA-SPACE LIGHT MULTIPLIER (probe v2.1, FRICTION #22). The composite multiplies in GAMMA space
 * (effects/lighting/environmental-light.js):
 *
 *     lit = EOTF( OETF(albedo) × illum + coloration )
 *
 * Checked against the lab's 3,468 recorded readings: it holds to 0.0002 typical (p99 0.006) in gamma
 * units. So per channel, OETF(lit) / OETF(albedo) = illum + coloration / OETF(albedo): the TOTAL light
 * the pixel got (daylight, Regions, lamps and their colour together) as one multiplier on the painted
 * art. 1 = shown as painted, 0.5 = half as bright in gamma, 2 = a lamp doubling it. Unlike `illum` it does
 * not stop at 1.0 and it includes the coloration term, so light is compared on the composite's own scale
 * (a ratio of linear `lit` understates a multiplier: toLinear is convex). A lamp's own share is still its
 * `coloration` (zero where it does not land); `gain - illum` is that share relative to the art.
 *
 * `lit` is encoded UNCLAMPED (srgbEncodeUnclamped): a hot spot past 1 in gamma keeps its real gain.
 *
 * @param {ArrayLike<number>|null} lit - linear RGB (scene.lit)
 * @param {ArrayLike<number>|null} albedo - linear RGB (scene.color)
 * @param {number} [minAlbedoSrgb] - a channel whose OETF(albedo) is at or below this reads null.
 * @returns {Array<number|null>|null} per channel, 4 decimals; null when an input is missing.
 */
export function gammaGain(lit, albedo, minAlbedoSrgb = GAIN_MIN_ALBEDO_SRGB) {
  if (!lit || !albedo || !(lit.length >= 3) || !(albedo.length >= 3)) return null;
  return [0, 1, 2].map((i) => {
    const art = srgbEncode(albedo[i]);
    return art > minAlbedoSrgb ? Math.round((srgbEncodeUnclamped(lit[i]) / art) * 1e4) / 1e4 : null;
  });
}

/**
 * Did a buffer read stay put between two frames? `eps` is in buffer units (linear light).
 * Used to wait out a rebuild: reads taken mid-swap return garbage (lab: lit 0.488 vs 0.184).
 * @param {object|null} a - a probe sample's `.buffers`
 * @param {object|null} b
 * @param {string[]} [names]
 * @param {number} [eps]
 */
export function buffersAgree(a, b, names = ['illum', 'lit', 'albedo'], eps = 0.004) {
  if (!a || !b) return false;
  for (const n of names) {
    const x = a[n]?.rgba;
    const y = b[n]?.rgba;
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (Math.abs(x[i] - y[i]) > eps) return false;
  }
  return true;
}

/**
 * One line of mask facts for a point on one floor, from `MapShine.probeMasks`' stack:
 * every mask kind's composited byte (null = no file / not painted) and the derived products.
 * @param {object|null} stack - probeStackAt(...) result
 * @param {number} floorIndex
 * @returns {{floor:string|null, masks:Record<string, number|null>, derived:object|null}|null}
 */
export function compactMaskStack(stack, floorIndex) {
  const f = stack?.floors?.find?.((x) => x.floorIndex === floorIndex) ?? stack?.floors?.[0];
  if (!f) return null;
  const masks = {};
  for (const [kind, v] of Object.entries(f.masks ?? {})) {
    if (v && (v.sourceCount ?? 0) > 0) masks[kind] = v.compositedByte ?? null;
  }
  return { floor: f.name ?? null, masks, derived: f.derived ?? null };
}

// ============================================================================
// PROBE v2.1 (2026-11-09, mmp-78u.12 follow-up) — from the lab's friction log:
//   #19 an OFF-SCREEN point read a clamped edge pixel and returned a confident wrong number;
//   #22 `illum` stops at 1.0 and leaves out coloration, and `lit` is not linear in the light
//       (the composite multiplies in gamma space), so claims were judged on the wrong scale;
//   #31 `foundry.lights` listed MSA's own vision-only door lights and Foundry's global light;
//   #3 / #18 readings minutes apart were not comparable: exposure, camera and forced effects moved;
//   and the drift verdict tripped on saturated colours whose brightness had not moved (luma now).
// ============================================================================

/**
 * One probe v2.1 result row from a `sampleOnePixel` sample and its presented bytes. Pure.
 *
 * An OFF-SCREEN point (or one with no view yet) has NOTHING read for it: every buffer-derived field is
 * null, `pixel` is null too (the old clamped edge pixel is not this point's pixel), and `reason` says why
 * ('off-screen' | 'no view' | 'bad point'). `itemsAtPoint` is a CPU registry lookup, so it stays.
 *
 * @param {object|null} sample - `{worldX, worldY, pixel, onScreen, reason?, buffers, itemsAtPoint}`
 * @param {{name?:string|null, presented?:ArrayLike<number>|null}} [o] - the point's name; its presented bytes.
 * @returns {object} `{name, worldX, worldY, pixel, onScreen, reason, floorIndex, outdoors01, albedo, illum,
 *   lit, coloration, gain, expectedScreen, presented, drift, itemsAtPoint}`
 */
export function buildProbeRow(sample, { name = null, presented = null } = {}) {
  const s = sample ?? {};
  const onScreen = s.onScreen === true;
  const b = onScreen ? (s.buffers ?? null) : null;
  const rgb = (buf) => (buf?.rgba && buf.rgba.length >= 3 ? Array.from(buf.rgba).slice(0, 3) : null);
  const attr = b?.attr?.rgba ?? null;
  const albedo = rgb(b?.albedo);
  const lit = rgb(b?.lit);
  const pres = onScreen && presented && presented.length >= 3 ? Array.from(presented).slice(0, 3) : null;
  return {
    name: name ?? null,
    worldX: s.worldX ?? null,
    worldY: s.worldY ?? null,
    pixel: onScreen ? (s.pixel ?? null) : null,
    onScreen,
    reason: onScreen ? null : (s.reason ?? 'off-screen'),
    floorIndex: attr ? Math.round(attr[0] * 255) : null,
    outdoors01: attr ? +Number(attr[1]).toFixed(3) : null,
    albedo,
    illum: rgb(b?.illum),
    lit,
    coloration: rgb(b?.coloration),
    gain: gammaGain(lit, albedo),
    expectedScreen: expectedScreenBytes(lit),
    presented: pres,
    drift: pres ? judgePresentedDrift({ lit, presented: pres }) : null,
    itemsAtPoint: s.itemsAtPoint ?? null,
  };
}

/**
 * Within this many stops of its target, the camera's metered light counts as settled: at most ~0.04 stops
 * of exposure still to come (dynamic-range.js#exposureFromIncident at full eye adaptation), 1-2 levels at
 * mid grey.
 */
export const EXPOSURE_SETTLED_STOPS = 0.02;

const finiteOrNull = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const roundOrNull = (v, digits) => {
  const n = finiteOrNull(v);
  return n === null ? null : +n.toFixed(digits);
};

/**
 * The camera's exposure state, from the viewer's Dynamic Range info (`getDynamicRangeInfo()`). Pure.
 *
 * `state`: 'off' (Dynamic Range disabled: no exposure), 'waiting' (enabled, no meter reading yet: the
 * present still runs no exposure), 'adapting' (the metered light is more than EXPOSURE_SETTLED_STOPS from
 * where it is heading: readings taken now drift as it eases), 'settled'. `ev` is what the present applies
 * (its live uniform when the info carries it), `multiplier` = 2^ev; both null unless exposing.
 * `held` = MapShine.camera.holdExposure is freezing the meter's target.
 *
 * @param {object|null} info
 * @returns {{enabled:boolean, state:'off'|'waiting'|'adapting'|'settled', ev:number|null,
 *   multiplier:number|null, meteredLog2:number|null, targetLog2:number|null, held:boolean}|null}
 *   null when there is no info (no viewer).
 */
export function summarizeExposure(info) {
  if (!info || typeof info !== 'object' || info.skipped) return null;
  const enabled = info.on === true;
  const applied = info.applied && typeof info.applied === 'object' ? info.applied : null;
  const exposing = enabled && (applied ? Number(applied.on) > 0.5 : !!info.curve);
  const ev = exposing ? finiteOrNull(applied ? applied.ev : (info.curve?.ev ?? info.ev)) : null;
  const metered = exposing ? finiteOrNull(info.logIllum) : null;
  const target = exposing ? finiteOrNull(info.gated) : null;
  const gate = info.gate;
  const held =
    enabled && !!gate && Number.isFinite(gate.t) && Number.isFinite(gate.holdUntil) && gate.t < gate.holdUntil;
  let state = 'settled';
  if (!enabled) state = 'off';
  else if (!exposing) state = 'waiting';
  else if (metered !== null && target !== null && Math.abs(target - metered) > EXPOSURE_SETTLED_STOPS) {
    state = 'adapting';
  }
  return {
    enabled,
    state,
    ev: roundOrNull(ev, 3),
    multiplier: ev === null ? null : roundOrNull(2 ** ev, 4),
    meteredLog2: roundOrNull(metered, 3),
    targetLog2: roundOrNull(target, 3),
    held,
  };
}

/** An ISO time for `at` (a Date, ms number or ISO string); undefined = now. Null when it is not a time. */
function isoTime(at) {
  try {
    const d = at === undefined ? new Date() : at instanceof Date ? at : new Date(at);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null; // a value Date cannot parse: the time is unknown, said as null
  }
}

/**
 * PROBE v2.1 CONTEXT — the state a reading was taken in, so readings minutes apart can be compared
 * (FRICTION #3 / #18: one spot read 110, 115, 117, 122 across a minute while exposure adapted). Pure and
 * total: every part is optional, anything malformed reads as null, and it never throws.
 *
 * @param {object} [parts]
 * @param {{x:number, y:number, scale:number, source?:string}|null} [parts.camera] - the view the reads
 *   mapped through (world px centre; scale = screen px per world px, like Foundry's stage scale).
 * @param {object|null} [parts.dynamicRange] - the viewer's getDynamicRangeInfo() (see summarizeExposure).
 * @param {Array<{id:string, enabled:boolean}>|null} [parts.forced] - the effect registry's forced ledger
 *   (MapShine.forceEffect); null = not available.
 * @param {number|null} [parts.todHour]
 * @param {string|null} [parts.sceneId]
 * @param {string|null} [parts.levelId]
 * @param {Date|number|string} [parts.at] - when; defaults to now.
 * @param {string[]} [parts.errors] - context reads that failed, each with its reason.
 * @returns {{camera:{x:number, y:number, scale:number, source:string|null}|null,
 *   exposure:ReturnType<typeof summarizeExposure>, forcedEffects:{on:string[], off:string[]}|null,
 *   todHour:number|null, sceneId:string|null, levelId:string|null, at:string|null, errors:string[]}}
 */
export function buildProbeContext(parts = {}) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const c = p.camera;
  const x = finiteOrNull(c?.x);
  const y = finiteOrNull(c?.y);
  const scale = finiteOrNull(c?.scale);
  const camera =
    x !== null && y !== null && scale !== null && scale > 0
      ? { x: +x.toFixed(1), y: +y.toFixed(1), scale: +scale.toFixed(4), source: c.source ?? null }
      : null;
  let forcedEffects = null;
  if (Array.isArray(p.forced)) {
    forcedEffects = { on: [], off: [] };
    for (const f of p.forced) {
      if (!f || typeof f.id !== 'string') continue;
      if (f.enabled === true) forcedEffects.on.push(f.id);
      else if (f.enabled === false) forcedEffects.off.push(f.id);
    }
  }
  const idOrNull = (v) => (typeof v === 'string' && v ? v : null);
  return {
    camera,
    exposure: summarizeExposure(p.dynamicRange ?? null),
    forcedEffects,
    todHour: roundOrNull(p.todHour, 3),
    sceneId: idOrNull(p.sceneId),
    levelId: idOrNull(p.levelId),
    at: isoTime(p.at),
    errors: Array.isArray(p.errors) ? p.errors.map(String) : [],
  };
}
