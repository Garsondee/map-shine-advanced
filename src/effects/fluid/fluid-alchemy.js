/**
 * THE ALCHEMY — what the goo is DOING, beyond being pumped (2026-11-04). Pure: no THREE, no GPU, no DOM.
 *
 * The author: *"It needs to look like magical fluid rushing down glass pipes. It needs to be fun, dynamic,
 * animated and ideally it should be unpredictable, show 'reactions' where things suddenly change and generally
 * give the impression of strange alchemical magical non-sense. The fluid should be self illuminating and
 * illuminate the map around it with a subtle light."*
 *
 * `fluid-pump.js` already decides how hard each tube is driven and where its slugs and gaps are. This module adds
 * the REACTIONS, the REAGENT a tube is carrying, and the LIGHT the goo throws:
 *
 *   REACTIONS   a per-tube schedule of events — transmute (the reagent changes colour, and the new colour RUSHES
 *               DOWN THE PIPE as a reacting front), surge, stall (then a burp), pulse (a heartbeat of light waves),
 *               fizz, boil. Deterministic in `(t, tube)` like the pump (`fluid-pump.js`'s own header has the
 *               reasoning: no private RNG, no private clock), so it is a Node test, not a screenshot.
 *   TRANSPORT   what enters each tube's root this instant — `(reagent, energy, froth)` — is handed to the sim,
 *               which CARRIES it (`fluid-sim.js#buildFluidAdvectMaterial` transports all four state channels with
 *               the same backtrace it always used for φ). A colour change is therefore a front that travels, speeds
 *               up through a neck and stops when the pump stalls, not a uniform tint swap.
 *   TRAVEL      each tube's distance flowed so far (`x`, world px), integrated from the pump's REAL drive, so the
 *               streaks/bubbles the shader draws stop when the flow stalls and rush when it surges. Spatially
 *               constant per tube — the safe half of `water-field.js`'s per-pixel-time trap.
 *   LIGHT       light anchors along the tubes (baked once), and a CPU twin of the sim (`advectTubeStep` — the
 *               module that is already the sim's source of truth) so each light knows the colour, fill and energy
 *               of the goo beside it: a reaction front lights the floor as it passes.
 *   HOST GATE   which pixels of the host tile's painted glass HIDE the goo (dark ink lines, brass fittings,
 *               white highlights) and which only depict glass (the pale paint the goo should glow through).
 *
 * ⚠️ PHOTOSENSITIVITY (`fluid.js`'s manifest note): every change here is an envelope of at least ~0.18 s, a
 * pulse train runs at ≤ 1.4 Hz, and nothing repeats in the 3–30 Hz band. A reaction is a SURGE OF LIGHT, never a
 * strobe.
 *
 * @module effects/fluid/fluid-alchemy
 */

import { advectTubeStep, FLUID_SIM_MIN_CROSS_SECTION_PX } from './fluid-sim.js';
import { FLUID_PUMP_BASE_Q } from './fluid-pump.js';

/** The kinds of reaction, in the order the debug buttons list them. */
export const FLUID_REACTION_KINDS = Object.freeze(['transmute', 'surge', 'stall', 'pulse', 'fizz', 'boil']);

/** How likely each kind is when a slot holds an event (relative weights). */
const REACTION_WEIGHTS = Object.freeze({ transmute: 3, surge: 2, stall: 1.1, pulse: 1.6, fizz: 1.5, boil: 1.3 });

/** How long each kind lasts, seconds: [min, spread]. */
const REACTION_DURATION = Object.freeze({
  transmute: [1.6, 0.8],
  surge: [1.4, 2.0],
  stall: [1.8, 2.4],
  pulse: [2.6, 0.0],
  fizz: [2.0, 2.0],
  boil: [3.0, 3.0],
});

/** The reagent position wraps here (a multiple of 1..6 so every palette size stays continuous across the wrap
 * except for the single wrap front itself). Kept small because the state target is half-float: integers are exact
 * to 2,048 but the FRACTION a blending front needs only resolves to 1/16 below 128. */
export const FLUID_REAGENT_WRAP = 120;

/** Base froth/energy a calm tube carries, so a quiet stretch still sparkles a little. */
const BASE_ENERGY = 0.12;
const BASE_FROTH = 0.1;
const BASE_AGITATION = 0.18;

/** @param {number} n */
export function hash01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function gauss(x, w) {
  return Math.exp(-(x * x) / (w * w));
}

// ── PALETTE ───────────────────────────────────────────────────────────────────

/** RGB (0..1) → HSV (h 0..1). */
function rgbToHsv([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

function hsvToRgb([h, s, v]) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

function hueShift(rgb, dh) {
  const [h, s, v] = rgbToHsv(rgb);
  return hsvToRgb([(((h + dh) % 1) + 1) % 1, Math.max(s, 0.55), Math.max(v, 0.75)]);
}

/**
 * The reagents a tube cycles through: the authored colour, the authored accent, and two more found by turning
 * each round the colour wheel. `variety` decides how many are in play (0 → one reagent, the tint alone; 1 → all
 * four). Always returns FOUR entries (the shader's fixed uniform set) plus the live `count`.
 *
 * @param {number[]} tint - linear-ish RGB 0..1.
 * @param {number[]} accent
 * @param {number} variety - 0..1.
 * @returns {{colors: number[][], count: number}}
 */
export function fluidPalette(tint, accent, variety) {
  const a = Array.isArray(tint) ? tint : [0.15, 0.95, 0.7];
  const b = Array.isArray(accent) ? accent : hueShift(a, 0.5);
  const v = Number.isFinite(variety) ? clamp01(variety) : 0.5;
  const count = v < 0.12 ? 1 : v < 0.45 ? 2 : v < 0.8 ? 3 : 4;
  const colors = [a, b, hueShift(a, 0.36), hueShift(b, -0.3)];
  return { colors, count };
}

// ── REACTIONS ─────────────────────────────────────────────────────────────────

/**
 * One tube's schedule shape, derived from its index once per bake.
 * @param {number} tubeIndex
 */
export function fluidReactionPersonality(tubeIndex) {
  const k = Math.max(0, tubeIndex | 0);
  return { slotJitter: hash01(k * 11 + 1), phase01: hash01(k * 11 + 2), seed: 1000 + k * 7919 };
}

/** The slot length for a chaos level, seconds. Calm apparatus reacts every ~15 s, a mad one every ~4. */
function slotSeconds(chaos, personality) {
  const c = clamp01(chaos);
  return (15 - 10.5 * c) * (0.85 + 0.3 * personality.slotJitter);
}

/**
 * The event (if any) in slot `k`. Pure in `(k, personality, chaos)`.
 * @returns {null|{kind: string, start: number, end: number, k: number, roll: number}}
 */
export function fluidSlotEvent(k, personality, chaos) {
  const c = clamp01(chaos);
  if (!(c > 0)) return null;
  const len = slotSeconds(c, personality);
  const slotStart = k * len - personality.phase01 * len;
  const seed = personality.seed + k * 97;
  // Calm (chaos → 0) leaves most slots empty; a mad apparatus fills nearly all of them.
  if (hash01(seed + 1) > 0.25 + 0.72 * Math.pow(c, 0.8)) return null;
  let total = 0;
  for (const kind of FLUID_REACTION_KINDS) total += REACTION_WEIGHTS[kind];
  let roll = hash01(seed + 2) * total;
  let kind = FLUID_REACTION_KINDS[0];
  for (const kk of FLUID_REACTION_KINDS) {
    roll -= REACTION_WEIGHTS[kk];
    if (roll <= 0) {
      kind = kk;
      break;
    }
  }
  const [dMin, dSpread] = REACTION_DURATION[kind];
  const dur = Math.min(len * 0.85, dMin + hash01(seed + 3) * dSpread);
  const start = slotStart + hash01(seed + 4) * Math.max(0, len - dur) * 0.6;
  return { kind, start, end: start + dur, k, roll: hash01(seed + 5) };
}

/**
 * Mutable per-tube bookkeeping for the reaction clock — the running count of transmutes, kept so the reagent
 * position is O(1) per tick instead of a sum over every slot since t = 0. Deterministic regardless: it is exactly
 * the count a full recount would give (a backwards clock recounts from zero).
 */
export function createFluidReactionState(tubeCount) {
  return Array.from({ length: tubeCount }, (_, i) => ({
    personality: fluidReactionPersonality(i),
    lastK: null,
    transmutes: 0,
    chaos: null,
    x: 0,
    forced: null,
  }));
}

/** Count transmutes in slots [from, to] for one tube. */
function countTransmutes(from, to, personality, chaos) {
  let n = 0;
  for (let j = from; j <= to; j++) if (fluidSlotEvent(j, personality, chaos)?.kind === 'transmute') n++;
  return n;
}

/**
 * Everything a reaction does to one tube at time `tSec`.
 *
 * @param {number} tSec
 * @param {object} st - one entry of {@link createFluidReactionState}.
 * @param {number} chaos - 0..1.
 * @returns {{qMul: number, reagent: number, energy: number, froth: number, agitation: number, kind: string|null, env: number}}
 */
export function fluidReactionAt(tSec, st, chaos) {
  const c = clamp01(Number.isFinite(chaos) ? chaos : 0.5);
  const p = st.personality;
  const len = slotSeconds(c, p);
  const k = Math.floor((tSec + p.phase01 * len) / len);
  // Transmutes in all slots BEFORE k (incremental; a chaos change or a backwards clock recounts).
  const ORIGIN = 0;
  if (st.lastK === null || st.chaos !== c || k < st.lastK) {
    st.transmutes = k - 1 >= ORIGIN ? countTransmutes(ORIGIN, k - 1, p, c) : 0;
    st.lastK = k;
    st.chaos = c;
  } else if (k > st.lastK) {
    st.transmutes += countTransmutes(st.lastK, k - 1, p, c);
    st.lastK = k;
  }

  let qMul = 1;
  let energy = BASE_ENERGY;
  let froth = BASE_FROTH;
  let agitation = BASE_AGITATION;
  let reagentStep = 0;
  let kind = null;
  let env = 0;
  // MOOD — a tube-wide brightness the whole pipe shows at once (a stall holds its breath and dims, a surge
  // flares): what reads as "something just happened" before any front has had time to travel.
  let mood = 1;
  // A surge pours a SOLID stream (no slug gaps) while it lasts.
  let solid = 0;

  // The current slot's event, plus the tail of the previous slot's (a stall's burp can spill over).
  const events = [fluidSlotEvent(k, p, c), fluidSlotEvent(k - 1, p, c)];
  // A forced event (the debug buttons / a future Foundry hook) rides on top, same shapes.
  if (st.forced && tSec < st.forced.end + 1.5 && tSec >= st.forced.start - 0.01) events.push(st.forced);
  for (const ev of events) {
    if (!ev) continue;
    const { start, end } = ev;
    if (tSec < start - 0.01 || tSec > end + 1.5) {
      if (ev.kind === 'transmute' && ev !== st.forced && tSec > end && ev.k === k) reagentStep = 1;
      continue;
    }
    const e = smoothstep(start, start + 0.35, tSec) * (1 - smoothstep(end - 0.5, end, tSec));
    if (e > env) {
      env = e;
      kind = ev.kind;
    }
    const front = gauss(tSec - start - 0.45, 0.42);
    switch (ev.kind) {
      case 'transmute':
        // The new reagent enters over ~0.8 s: that ramp is the colour FRONT the sim carries down the pipe.
        // (a forced transmute's own step is `forcedStep` below — never counted twice)
        if (ev.k === k && ev !== st.forced) reagentStep = Math.max(reagentStep, smoothstep(start, start + 0.8, tSec));
        energy += 1.1 * front;
        froth += 0.9 * front;
        agitation += 0.5 * front;
        qMul *= 1 + 0.6 * front;
        break;
      case 'surge':
        qMul *= 1 + 2.4 * e;
        energy += 0.9 * e;
        froth += 0.6 * e;
        agitation += 0.35 * e;
        mood += 0.3 * e;
        solid = Math.max(solid, e);
        break;
      case 'stall': {
        qMul *= 1 - 0.96 * e;
        // The burp: it lets go all at once as the stall ends.
        const burp = gauss(tSec - end, 0.3);
        qMul *= 1 + 3.2 * burp;
        energy += 1.3 * burp - 0.08 * e;
        froth += 0.9 * burp;
        agitation += 0.8 * burp;
        mood *= 1 - 0.6 * e;
        mood += 0.45 * burp;
        solid = Math.max(solid, burp);
        break;
      }
      case 'pulse': {
        // A heartbeat of three light waves, 0.72 s apart (1.4 Hz — well under the photosensitive band).
        let beat = 0;
        for (let i = 0; i < 3; i++) beat += gauss(tSec - start - 0.3 - i * 0.72, 0.17);
        energy += 1.8 * beat;
        qMul *= 1 + 0.35 * e;
        froth += 0.25 * beat;
        mood += 0.22 * beat;
        break;
      }
      case 'fizz':
        froth += 1.0 * e;
        energy += 0.3 * e;
        agitation += 0.9 * e;
        mood += 0.1 * e;
        break;
      case 'boil':
        agitation += 1.4 * e;
        froth += 0.6 * e;
        energy += 0.3 * e;
        qMul *= 1 - 0.3 * e;
        mood += 0.12 * e;
        break;
      default:
        break;
    }
  }

  const forcedStep =
    st.forced?.kind === 'transmute' && tSec >= st.forced.start
      ? smoothstep(st.forced.start, st.forced.start + 0.8, tSec)
      : 0;
  const steps = st.transmutes + reagentStep + (st.forcedSteps ?? 0) + forcedStep;
  const reagent = ((steps % FLUID_REAGENT_WRAP) + FLUID_REAGENT_WRAP) % FLUID_REAGENT_WRAP;
  if (st.forced && tSec > st.forced.end + 1.5) {
    if (st.forced.kind === 'transmute') st.forcedSteps = (st.forcedSteps ?? 0) + 1;
    st.forced = null;
  }
  return {
    qMul: Math.max(0.02, qMul),
    reagent,
    energy: Math.max(0, energy),
    froth: clamp01(froth),
    agitation: Math.max(0, agitation),
    mood: Math.max(0.3, mood),
    solid: clamp01(solid),
    kind,
    env,
  };
}

/** Make a reaction happen NOW on one tube (debug buttons; a future Foundry hook). */
export function forceFluidReaction(st, kind, tSec) {
  if (!FLUID_REACTION_KINDS.includes(kind)) return false;
  const [dMin, dSpread] = REACTION_DURATION[kind];
  st.forced = { kind, start: tSec, end: tSec + dMin + dSpread * 0.5, k: -1, roll: 0.5 };
  return true;
}

// ── THE PER-TICK UPLOAD ───────────────────────────────────────────────────────

/** Texels per tube row of the tube texture: [0] = what enters the root, [1] = what the shader reads. */
export const FLUID_TUBE_TEXELS = 2;
/** What a gap between slugs still carries (φ). */
export const FLUID_TRICKLE = 0.18;
/** `x` wraps here (world px). Large, so the pattern jump it causes is rare (~half an hour of fast flow). */
export const FLUID_TRAVEL_WRAP_PX = 1e6;

/**
 * Write one tick of every tube's reaction into the tube texture buffer and scale the pump buffer's Q.
 *
 *   tube texel 0 = (reagent, energy, froth, 1)   — injected at the root by the sim
 *   tube texel 1 = (x, lengthPx, agitation, mood) — read by the surface shader
 *
 * and floors the pump's φ injection at {@link FLUID_TRICKLE} (a gap between slugs keeps a thin trickle, so the
 * pipes read as a rushing stream with surges in it rather than as a marquee of lit segments), raised to a solid
 * stream while a surge or a burp pours.
 *
 * @param {object} args
 * @param {Float32Array} args.tubeData - `tubeCount * 2 * 4`.
 * @param {Float32Array} args.pumpData - `writeFluidTubeConstantsBuffer`'s buffer (Q scaled in place).
 * @param {Array<{lengthPx:number, crossSectionProfile: Float64Array}>} args.tubes
 * @param {Array<object>} args.reactions - {@link createFluidReactionState}.
 * @param {number} args.tSec @param {number} args.dtSec
 * @param {number} args.chaos @param {number} args.flowSpeed
 * @returns {Array<object>} this tick's reaction per tube (for lights + status).
 */
export function writeFluidTubeTick({ tubeData, pumpData, tubes, reactions, tSec, dtSec, chaos, flowSpeed }) {
  const out = [];
  for (let row = 0; row < tubes.length; row++) {
    const st = reactions[row];
    const r = fluidReactionAt(tSec, st, chaos);
    const q = pumpData[row * 4] * flowSpeed * r.qMul;
    pumpData[row * 4] = q;
    const pumped = pumpData[row * 4 + 1];
    pumpData[row * 4 + 1] = Math.max(pumped, FLUID_TRICKLE + (1 - FLUID_TRICKLE) * r.solid);
    // Mean speed along this tube (world px/s) = Q / mean cross-section — the same `v = Q/A` the sim uses.
    const prof = tubes[row].crossSectionProfile;
    let sum = 0;
    for (let i = 0; i < prof.length; i++) sum += prof[i];
    const meanA = Math.max(FLUID_SIM_MIN_CROSS_SECTION_PX, prof.length ? sum / prof.length : 1);
    st.x = (st.x + (q / meanA) * Math.max(0, dtSec)) % FLUID_TRAVEL_WRAP_PX;
    const o = row * FLUID_TUBE_TEXELS * 4;
    tubeData[o] = r.reagent;
    tubeData[o + 1] = r.energy;
    tubeData[o + 2] = r.froth;
    tubeData[o + 3] = 1;
    tubeData[o + 4] = st.x;
    tubeData[o + 5] = Math.max(1, tubes[row].lengthPx);
    tubeData[o + 6] = r.agitation;
    tubeData[o + 7] = r.mood;
    out.push({ ...r, q, x: st.x });
  }
  return out;
}

// ── THE HOST GATE ─────────────────────────────────────────────────────────────

/**
 * Which pixels of the HOST tile's own painted glass hide the goo. 1 = the goo glows here (pale glass paint, or no
 * paint at all), 0 = it is behind something (an ink outline, a brass fitting, a bright highlight on the glass).
 *
 * WHY: the author paints the glass itself (Wizard's Lair: alpha 0.78 median over the tubes), and the goo used to
 * draw UNDER that paint, so 78% of it was covered by grey before anyone saw it — a big part of "pastel". The goo
 * now draws AFTER the light composite, over the painted glass, and this gate keeps the drawing's ink, metal and
 * glints on top of it.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - straight (not premultiplied) RGBA.
 * @param {number} w @param {number} h
 * @returns {Uint8Array} w*h, 0..255.
 */
export function computeFluidHostGate(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    if (a <= 0.004) {
      out[i] = 255;
      continue;
    }
    const r = rgba[o] / 255;
    const g = rgba[o + 1] / 255;
    const b = rgba[o + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
    const ink = smoothstep(0.3, 0.13, lum);
    const metal = smoothstep(0.3, 0.5, sat) * smoothstep(0.12, 0.28, lum);
    const glint = 0.55 * smoothstep(0.84, 0.97, lum);
    const occ = Math.max(ink, metal, glint);
    out[i] = Math.round(255 * (1 - a * occ));
  }
  // ERODE the open region by one texel (3×3 min): the gate is decoded smaller than the art (4,096 vs 6,750 on
  // Wizard's Lair), so its edges are softer than the ink they follow, and the glow speckled every ink line it
  // half-covered. Shrinking the open area by a texel keeps the glow just inside the lines.
  const eroded = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const v = out[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
          if (v < m) m = v;
        }
      }
      eroded[y * w + x] = m;
    }
  }
  return eroded;
}

// ── LIGHT ─────────────────────────────────────────────────────────────────────

/** How long a stretch of tube one light stands for (world px), and how far apart two clusters on the same
 * stretch must be to stay separate lights (two branches at the same arc length). */
const LIGHT_SEGMENT_PX = 420;
const LIGHT_CLUSTER_PX = 300;
/** Cap per masked item: lights are the expensive half of a glow (the point-light pool draws each one). */
export const FLUID_MAX_LIGHTS_PER_ITEM = 14;

/** Bilinear map of a quad's corners (TL, TR, BR, BL) at (u, v). */
function quadPoint(corners, u, v) {
  const [tl, tr, br, bl] = corners;
  const topX = tl.x + (tr.x - tl.x) * u;
  const topY = tl.y + (tr.y - tl.y) * u;
  const botX = bl.x + (br.x - bl.x) * u;
  const botY = bl.y + (br.y - bl.y) * u;
  return { x: topX + (botX - topX) * v, y: topY + (botY - topY) * v };
}

/**
 * Light anchors along the tube net: one per ~420 px of tube, split where two branches share an arc length, then
 * merged nearest-first down to the cap. Baked once per mask version.
 *
 * @param {object} net - `extractTubeNet`'s output.
 * @param {Array<{x:number,y:number}>} corners - the host quad's world corners (TL, TR, BR, BL).
 * @param {number} [maxLights]
 * @returns {Array<{x:number, y:number, row:number, s:number, sSpan:number, areaPx:number}>}
 */
export function fluidLightAnchors(net, corners, maxLights = FLUID_MAX_LIGHTS_PER_ITEM) {
  if (!net?.spec || !Array.isArray(corners) || corners.length !== 4) return [];
  const { w, h, texelW, texelH } = net.spec;
  const texelArea = texelW * texelH;
  const clusters = [];
  for (const tube of net.tubes) {
    const segs = Math.max(1, Math.round(tube.lengthPx / LIGHT_SEGMENT_PX));
    const bySeg = Array.from({ length: segs }, () => []);
    clusters.push(bySeg);
    tube._segs = segs;
  }
  // Walk every tube texel once; greedy spatial clustering inside each arc-length segment.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = net.tubeIdByTexel[i];
      if (!id) continue;
      const row = id - 1;
      const tube = net.tubes[row];
      if (!tube) continue;
      const seg = Math.min(tube._segs - 1, Math.floor(net.sByTexel[i] * tube._segs));
      const wx = (x + 0.5) * texelW;
      const wy = (y + 0.5) * texelH;
      const list = clusters[row][seg];
      let best = null;
      for (const c of list) {
        const dx = c.sx / c.n - wx;
        const dy = c.sy / c.n - wy;
        if (dx * dx + dy * dy < LIGHT_CLUSTER_PX * LIGHT_CLUSTER_PX) {
          best = c;
          break;
        }
      }
      if (!best) {
        best = { sx: 0, sy: 0, ss: 0, n: 0, row, seg };
        list.push(best);
      }
      best.sx += wx;
      best.sy += wy;
      best.ss += net.sByTexel[i];
      best.n++;
    }
  }
  let anchors = [];
  for (let row = 0; row < clusters.length; row++) {
    const tube = net.tubes[row];
    for (const list of clusters[row]) {
      for (const c of list) {
        if (c.n < 3) continue;
        anchors.push({
          lx: c.sx / c.n,
          ly: c.sy / c.n,
          row,
          s: c.ss / c.n,
          sSpan: 1 / tube._segs,
          areaPx: c.n * texelArea,
        });
      }
    }
    delete tube._segs;
  }
  // Merge nearest pairs (same tube preferred) until under the cap. Area-weighted.
  while (anchors.length > maxLights) {
    let bi = 0;
    let bj = 1;
    let bd = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i];
        const b = anchors[j];
        const d = Math.hypot(a.lx - b.lx, a.ly - b.ly) * (a.row === b.row ? 1 : 1.6);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    const a = anchors[bi];
    const b = anchors[bj];
    const wa = a.areaPx;
    const wb = b.areaPx;
    const m = {
      lx: (a.lx * wa + b.lx * wb) / (wa + wb),
      ly: (a.ly * wa + b.ly * wb) / (wa + wb),
      row: wa >= wb ? a.row : b.row,
      s: wa >= wb ? a.s : b.s,
      sSpan: Math.max(a.sSpan, b.sSpan) + Math.abs(a.s - b.s),
      areaPx: wa + wb,
    };
    anchors = anchors.filter((_, k) => k !== bi && k !== bj);
    anchors.push(m);
  }
  const spanW = net.spec.width ?? w * texelW;
  const spanH = net.spec.height ?? h * texelH;
  return anchors.map((a) => {
    const p = quadPoint(corners, a.lx / spanW, a.ly / spanH);
    return { x: p.x, y: p.y, row: a.row, s: a.s, sSpan: a.sSpan, areaPx: a.areaPx };
  });
}

/**
 * The CPU twin of the GPU sim, for the lights only: φ, reagent and energy per bin, advanced by the SAME
 * `advectTubeStep` (the sim's own source of truth) with the same Q and root values the GPU gets this tick.
 * @param {object} net
 */
export function createFluidLightTwin(net) {
  const n = net.samplesPerTube;
  return {
    tubes: net.tubes.map((t) => ({
      lengthPx: t.lengthPx,
      cross: t.crossSectionProfile,
      phi: new Float64Array(n),
      reagent: new Float64Array(n),
      energy: new Float64Array(n),
      scratch: new Float64Array(n),
    })),
    n,
  };
}

/** Energy and froth fade as they travel (seconds to fall to 1/e) — the GPU sim applies the same factor. */
export const FLUID_ENERGY_DECAY_S = 4.5;
export const FLUID_FROTH_DECAY_S = 3;

/**
 * Advance the twin one tick.
 * @param {ReturnType<typeof createFluidLightTwin>} twin
 * @param {Float32Array} pumpData - after {@link writeFluidTubeTick} (Q scaled, inject φ in G).
 * @param {Float32Array} tubeData
 * @param {number} dtSec
 */
export function stepFluidLightTwin(twin, pumpData, tubeData, dtSec) {
  const decay = Math.exp(-Math.max(0, dtSec) / FLUID_ENERGY_DECAY_S);
  twin.tubes.forEach((t, row) => {
    const Q = pumpData[row * 4];
    const injPhi = pumpData[row * 4 + 1];
    const o = row * FLUID_TUBE_TEXELS * 4;
    const common = { crossSectionProfile: t.cross, lengthPx: t.lengthPx, Q, dtSec };
    advectTubeStep({ ...common, prevPhi: t.phi, inject: injPhi, out: t.scratch });
    t.phi.set(t.scratch);
    advectTubeStep({ ...common, prevPhi: t.reagent, inject: tubeData[o], out: t.scratch });
    t.reagent.set(t.scratch);
    advectTubeStep({ ...common, prevPhi: t.energy, inject: tubeData[o + 1], out: t.scratch });
    for (let i = 0; i < t.scratch.length; i++) t.energy[i] = t.scratch[i] * decay;
  });
}

function sampleArr(arr, s) {
  const n = arr.length;
  const x = clamp01(s) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return arr[i] * (1 - f) + arr[Math.min(n - 1, i + 1)] * f;
}

/** The palette colour at a reagent position (cyclic, same blend as the shader). */
export function fluidReagentColor(palette, reagent) {
  const cnt = Math.max(1, palette.count);
  const i0 = ((Math.floor(reagent) % cnt) + cnt) % cnt;
  const i1 = (i0 + 1) % cnt;
  const f = smoothstep(0, 1, reagent - Math.floor(reagent));
  const a = palette.colors[i0];
  const b = palette.colors[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** A polygon circle for a light's naive shape (the pool replaces it with Foundry's wall-clipped sweep). */
function circlePolygon(x, y, r, n = 24) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return pts;
}

/**
 * This tick's light descriptors for one item, in the point-light pool's own shape (`fire-geometry.js#
 * buildFireLightSources` is the template: luminosity stays under 0.5 so the light tints instead of whitening).
 *
 * @param {object} args
 * @param {string} args.itemId
 * @param {Array<object>} args.anchors - {@link fluidLightAnchors}.
 * @param {ReturnType<typeof createFluidLightTwin>} args.twin
 * @param {{colors:number[][], count:number}} args.palette
 * @param {number} args.strength - the `light` param, 0..1+.
 * @param {number} args.radiusScale - the `lightRadius` param.
 * @param {number} [args.fade] - the host's own occlusion fade, 0..1.
 * @param {number} [args.elevation]
 * @param {Map<string, number>} [args.smooth] - per-light smoothing memory (mutated).
 * @param {number} [args.dtSec]
 * @returns {Array<object>}
 */
export function buildFluidLightSources({
  itemId,
  anchors,
  twin,
  palette,
  strength,
  radiusScale = 1,
  fade = 1,
  elevation = 0,
  smooth = null,
  dtSec = 1 / 60,
}) {
  const out = [];
  if (!(strength > 0) || !anchors?.length || !twin) return out;
  const k = 1 - Math.exp(-Math.max(0, dtSec) / 0.12);
  anchors.forEach((a, idx) => {
    const t = twin.tubes[a.row];
    if (!t) return;
    // Average three taps across the stretch this light stands for.
    let phi = 0;
    let en = 0;
    let rg = 0;
    for (const o of [-0.35, 0, 0.35]) {
      const s = a.s + o * a.sSpan;
      phi += sampleArr(t.phi, s) / 3;
      en += sampleArr(t.energy, s) / 3;
      rg += sampleArr(t.reagent, s) / 3;
    }
    const id = `fluid:${itemId}:${idx}`;
    let level = Math.min(1.6, phi * (0.45 + 0.75 * en));
    if (smooth) {
      const prev = smooth.get(id);
      level = prev === undefined ? level : prev + (level - prev) * k;
      smooth.set(id, level);
    }
    level *= fade;
    if (level < 0.02) return;
    const base = fluidReagentColor(palette, rg);
    const hot = Math.min(1, en * 0.18);
    const color = base.map((c) => Math.min(1, c + (1 - c) * hot));
    // Radius from how much goo the anchor stands for: a flask throws further than a capillary.
    const radius = Math.max(
      180,
      Math.min(900, (230 + Math.sqrt(a.areaPx) * 0.9) * Math.max(0.25, Math.min(3, radiusScale)))
    );
    const luminosity01 = Math.max(0.05, Math.min(0.46, 0.2 * strength * level));
    const alpha01 = Math.max(0.05, Math.min(1, 0.55 * strength * level));
    if (![a.x, a.y, radius, luminosity01, alpha01, ...color].every(Number.isFinite)) return;
    out.push({
      sourceId: id,
      ownerEffectId: 'fluid',
      x: a.x,
      y: a.y,
      elevation,
      radius,
      shapePoints: circlePolygon(a.x, a.y, radius),
      ratio: 0.18,
      attenuation01: 0.75,
      luminosity01,
      hasColor: true,
      alpha01,
      color,
      falloffModel: 'inverseSquareWide',
      animation: null,
    });
  });
  return out;
}

/** Re-exported so a caller can size a light against the pump's own scale without importing two modules. */
export { FLUID_PUMP_BASE_Q };
