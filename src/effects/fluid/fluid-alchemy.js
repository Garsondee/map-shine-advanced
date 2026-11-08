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
 *   LIGHT       a CPU twin of the sim (`advectTubeStep` — the module that is already the sim's source of truth)
 *               so the goo's light on the map (`fluid-light-field.js`) knows the colour, fill and energy of the goo
 *               it stands for: a reaction front lights the floor as it passes.
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

/** The kinds of reaction, in the order the debug buttons list them. */
export const FLUID_REACTION_KINDS = Object.freeze(['transmute', 'catalyst', 'surge', 'stall', 'pulse', 'fizz', 'boil']);

/** How likely each kind is when a slot holds an event (relative weights). */
const REACTION_WEIGHTS = Object.freeze({
  transmute: 3,
  catalyst: 1.6,
  surge: 1.6,
  stall: 1.1,
  pulse: 1.3,
  fizz: 1.3,
  boil: 1.2,
});

/** How long each kind lasts, seconds: [min, spread]. */
const REACTION_DURATION = Object.freeze({
  transmute: [1.6, 0.8],
  catalyst: [2.4, 1.0],
  surge: [1.4, 2.0],
  stall: [1.8, 2.4],
  pulse: [2.6, 0.0],
  fizz: [2.0, 2.0],
  boil: [3.0, 3.0],
});

/**
 * A CATALYST (round 3, 2026-11-04 — the author: "A better and more unpredictable colour range and response to
 * catalysts would be ideal"). A dose dropped in at the root sets off a CASCADE: {@link FLUID_CATALYST_STAGES}
 * colour changes in quick succession, each a jump of its own hashed size, each with its own flash of energy, so a
 * banded train of fronts runs down the pipe and the tube stays agitated for a while after. These are the spacing
 * of the stages (s) and how long the agitation lingers past the event's end (s).
 */
export const FLUID_CATALYST_STAGES = 3;
const CATALYST_STAGE_GAP_S = 0.55;
const CATALYST_AFTERSHOCK_S = 3.5;

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

/** How many reagent slots the shader carries (its fixed uniform set). */
export const FLUID_PALETTE_SLOTS = 8;

/** The palette sizes `variety` can pick — every one divides {@link FLUID_REAGENT_WRAP} (120), so the reagent
 * position stays continuous across its wrap at any size. 7 does not divide 120, which is why it is skipped. */
const PALETTE_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6, 8]);

/**
 * The reagents a tube cycles through. Slot 0 is the authored colour and slot 1 the authored accent; the rest are
 * WILD reagents (round 3, 2026-11-04 — "a better and more unpredictable colour range"): each a hashed turn round
 * the wheel from the tint, at its own saturation and its own depth, some deep and inky, some electric — so the
 * apparatus wanders well beyond its two authored colours. Seeded by the authored colours, so a given tint/accent
 * always brews the same set (no private RNG). `variety` decides how many are in play: 0 → the tint alone,
 * ~0.75 → six, 1 → all eight. Always returns {@link FLUID_PALETTE_SLOTS} entries plus the live `count`.
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
  const count = PALETTE_COUNTS[Math.min(PALETTE_COUNTS.length - 1, Math.floor(v * 7.2 + 0.15))];
  const seed = Math.round(a[0] * 251 + a[1] * 509 + a[2] * 757 + b[0] * 1013 + b[1] * 1531 + b[2] * 2039);
  const [h0] = rgbToHsv(a);
  const colors = [a, b];
  for (let i = 2; i < FLUID_PALETTE_SLOTS; i++) {
    // Golden-ratio turns spread the hues; the hash nudges each so no two palettes are the same wheel.
    const h = h0 + i * 0.618034 + (hash01(seed + i * 13) - 0.5) * 0.22;
    // Saturated, never pastel: under the night exposure (×2.8) and the white-hot core a pale reagent clips to white
    // (the lab's first wild set had a sky blue at value 0.98 that turned a whole flask ice-white).
    const s = 0.82 + 0.18 * hash01(seed + i * 17);
    // Depth: a third come out deep (0.4-0.55), the rest rich (0.68-0.86) — dark reagents make the bright ones read.
    const deep = hash01(seed + i * 19) < 0.34;
    const val = deep ? 0.4 + 0.15 * hash01(seed + i * 23) : 0.68 + 0.18 * hash01(seed + i * 29);
    colors.push(hsvToRgb([((h % 1) + 1) % 1, s, val]));
  }
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
 * How far one colour change jumps along the palette — hashed, so the next colour is never simply "the next one"
 * (round 3: the old +1 every time cycled A→B→C→D→A, which an eye learns in a minute). Never a multiple of the
 * palette size, so every jump changes the colour; a jump of 2-3 sweeps its front through the colours between,
 * a brief rainbow as it travels.
 * @param {number} seed @param {number} count - palette size in play.
 */
export function fluidReagentJump(seed, count) {
  const n = Math.max(1, Math.round(count) || 1);
  if (n <= 2) return 1;
  return 1 + Math.floor(hash01(seed) * Math.min(3, n - 1) * 0.9999);
}

/** The total reagent steps an event moves its tube by (0 for kinds that do not change colour). */
function eventSteps(ev) {
  return ev?.jumps ? ev.jumps.reduce((s, j) => s + j, 0) : 0;
}

/**
 * The event (if any) in slot `k`. Pure in `(k, personality, chaos, paletteCount)`.
 * @returns {null|{kind: string, start: number, end: number, k: number, roll: number, jumps?: number[]}}
 */
export function fluidSlotEvent(k, personality, chaos, paletteCount = 4) {
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
  const ev = { kind, start, end: start + dur, k, roll: hash01(seed + 5) };
  if (kind === 'transmute') ev.jumps = [fluidReagentJump(seed + 6, paletteCount)];
  else if (kind === 'catalyst') {
    ev.jumps = Array.from({ length: FLUID_CATALYST_STAGES }, (_, i) =>
      fluidReagentJump(seed + 7 + i * 3, paletteCount)
    );
  }
  return ev;
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

/** Sum the reagent steps of every colour-changing event in slots [from, to] for one tube. */
function countTransmutes(from, to, personality, chaos, paletteCount) {
  let n = 0;
  for (let j = from; j <= to; j++) n += eventSteps(fluidSlotEvent(j, personality, chaos, paletteCount));
  return n;
}

/** How far a catalyst's cascade has carried the reagent at `tSec` (0 → all its stages' jumps). */
function catalystProgress(ev, tSec) {
  let s = 0;
  ev.jumps.forEach((j, i) => {
    const t0 = ev.start + i * CATALYST_STAGE_GAP_S;
    s += j * smoothstep(t0, t0 + 0.45, tSec);
  });
  return s;
}

/**
 * Everything a reaction does to one tube at time `tSec`.
 *
 * @param {number} tSec
 * @param {object} st - one entry of {@link createFluidReactionState}.
 * @param {number} chaos - 0..1.
 * @param {number} [paletteCount] - reagents in play (decides how far a colour change may jump).
 * @returns {{qMul: number, reagent: number, energy: number, froth: number, agitation: number, kind: string|null, env: number}}
 */
export function fluidReactionAt(tSec, st, chaos, paletteCount = 4) {
  const c = clamp01(Number.isFinite(chaos) ? chaos : 0.5);
  const pc = Math.max(1, Math.round(paletteCount) || 1);
  const p = st.personality;
  const len = slotSeconds(c, p);
  const k = Math.floor((tSec + p.phase01 * len) / len);
  // Steps in all slots BEFORE k (incremental; a chaos/palette change or a backwards clock recounts).
  const ORIGIN = 0;
  if (st.lastK === null || st.chaos !== c || st.paletteCount !== pc || k < st.lastK) {
    st.transmutes = k - 1 >= ORIGIN ? countTransmutes(ORIGIN, k - 1, p, c, pc) : 0;
    st.lastK = k;
    st.chaos = c;
    st.paletteCount = pc;
  } else if (k > st.lastK) {
    st.transmutes += countTransmutes(st.lastK, k - 1, p, c, pc);
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
  const events = [fluidSlotEvent(k, p, c, pc), fluidSlotEvent(k - 1, p, c, pc)];
  // A forced event (the debug buttons / a future Foundry hook) rides on top, same shapes.
  if (st.forced && tSec < st.forced.end + eventTail(st.forced) && tSec >= st.forced.start - 0.01) {
    events.push(st.forced);
  }
  for (const ev of events) {
    if (!ev) continue;
    const { start, end } = ev;
    if (tSec < start - 0.01 || tSec > end + eventTail(ev)) {
      if (ev.jumps && ev !== st.forced && tSec > end && ev.k === k) reagentStep = eventSteps(ev);
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
        if (ev.k === k && ev !== st.forced) {
          reagentStep = Math.max(reagentStep, eventSteps(ev) * smoothstep(start, start + 0.8, tSec));
        }
        energy += 1.1 * front;
        froth += 0.9 * front;
        agitation += 0.5 * front;
        qMul *= 1 + 0.6 * front;
        break;
      case 'catalyst': {
        // The dose hits: a CASCADE of colour fronts, each with its own flash, and a tube that stays agitated
        // (more flares, more boiling, more froth) for a few seconds after — the apparatus answering.
        if (ev.k === k && ev !== st.forced) reagentStep = Math.max(reagentStep, catalystProgress(ev, tSec));
        let kick = 0;
        for (let i = 0; i < ev.jumps.length; i++) kick += gauss(tSec - start - 0.25 - i * CATALYST_STAGE_GAP_S, 0.2);
        const after = smoothstep(start, start + 0.6, tSec) * (1 - smoothstep(end, end + CATALYST_AFTERSHOCK_S, tSec));
        energy += 1.5 * kick;
        froth += 0.7 * kick + 0.5 * after;
        agitation += 0.6 * kick + 0.9 * after;
        qMul *= 1 + 0.9 * kick;
        mood += 0.25 * kick;
        break;
      }
      case 'surge':
        // A RUSH, not a floodlight (round 3): speed and a solid stream carry it; its energy stays near the line,
        // so it does not light the whole pipe at once (at 0.9 a surge lit 34% of the tube for seconds).
        qMul *= 1 + 2.4 * e;
        energy += 0.45 * e;
        froth += 0.6 * e;
        agitation += 0.35 * e;
        mood += 0.12 * e;
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

  const fv = st.forced;
  let forcedStep = 0;
  if (fv?.jumps && tSec >= fv.start) {
    forcedStep =
      fv.kind === 'catalyst' ? catalystProgress(fv, tSec) : eventSteps(fv) * smoothstep(fv.start, fv.start + 0.8, tSec);
  }
  const steps = st.transmutes + reagentStep + (st.forcedSteps ?? 0) + forcedStep;
  const reagent = ((steps % FLUID_REAGENT_WRAP) + FLUID_REAGENT_WRAP) % FLUID_REAGENT_WRAP;
  if (fv && tSec > fv.end + eventTail(fv)) {
    st.forcedSteps = (st.forcedSteps ?? 0) + eventSteps(fv);
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
  const ev = { kind, start: tSec, end: tSec + dMin + dSpread * 0.5, k: -1, roll: 0.5 };
  // A forced jump is hashed from the moment it was forced, so pressing the button twice does not repeat itself.
  const seed = Math.floor(tSec * 61) + 17;
  const pc = st.paletteCount ?? 4;
  if (kind === 'transmute') ev.jumps = [fluidReagentJump(seed, pc)];
  else if (kind === 'catalyst') {
    ev.jumps = Array.from({ length: FLUID_CATALYST_STAGES }, (_, i) => fluidReagentJump(seed + 7 + i * 3, pc));
  }
  st.forced = ev;
  return true;
}

/** How long an event keeps acting after its end (a stall's burp; a catalyst's aftershock). */
function eventTail(ev) {
  return ev.kind === 'catalyst' ? CATALYST_AFTERSHOCK_S : 1.5;
}

// ── DROUGHTS ──────────────────────────────────────────────────────────────────

/** The share of a tube's supply windows that run DRY, and how long a window is (s: min, spread). */
export const FLUID_DROUGHT_CHANCE = 0.3;
const DROUGHT_WINDOW_S = [3.5, 4.5];

/**
 * DROUGHTS (round 3, 2026-11-04 — the author: "too bright in all places at once ... more effective with more gaps
 * in the fluid pipe"). Each tube's supply is cut into windows of a few seconds of its own length; about
 * {@link FLUID_DROUGHT_CHANCE} of them run DRY — nothing enters the root at all, so a long run of empty glass
 * travels down the pipe behind the last slug. On top of the pump's own slug/gap duty cycle, that gives gaps of
 * every length, from a hand-span to most of a pipe. Deterministic in `(tSec, tubeIndex)`; edges ease over ~0.4 s
 * and two dry windows in a row join into one drought (no blip of liquid at their seam).
 *
 * @param {number} tSec @param {number} tubeIndex
 * @returns {number} 0 (supply on) .. 1 (dry).
 */
export function fluidDroughtAt(tSec, tubeIndex) {
  const t = Math.max(0, tubeIndex | 0);
  const win = DROUGHT_WINDOW_S[0] + DROUGHT_WINDOW_S[1] * hash01(t * 31 + 1);
  const u = tSec / win + hash01(t * 31 + 2) * 7;
  const w = Math.floor(u);
  const f = u - w;
  const dry = (j) => hash01(t * 31 + j * 7 + 3) < FLUID_DROUGHT_CHANCE;
  if (!dry(w)) return 0;
  const ease = 0.4 / win;
  const rise = dry(w - 1) ? 1 : smoothstep(0, ease, f);
  const fall = dry(w + 1) ? 1 : 1 - smoothstep(1 - ease, 1, f);
  return rise * fall;
}

// ── THE PER-TICK UPLOAD ───────────────────────────────────────────────────────

/** Texels per tube row of the tube texture: [0] = what enters the root, [1] = what the shader reads. */
export const FLUID_TUBE_TEXELS = 2;
/** What a gap between slugs still carries (φ). Round 3: nothing — a gap is empty glass (it was 0.18, which kept
 * every gap ~30% full and the whole pipe lit; the meter read 83-87% of the tube filled at every sample). */
export const FLUID_TRICKLE = 0;
/** `x` wraps here (world px). Large, so the pattern jump it causes is rare (~half an hour of fast flow). */
export const FLUID_TRAVEL_WRAP_PX = 1e6;

/**
 * Write one tick of every tube's reaction into the tube texture buffer and scale the pump buffer's Q.
 *
 *   tube texel 0 = (reagent, energy, froth, 1)   — injected at the root by the sim
 *   tube texel 1 = (x, lengthPx, agitation, mood) — read by the surface shader
 *
 * and shapes the pump's φ injection: cut to nothing while the tube is in a drought ({@link fluidDroughtAt}),
 * floored at {@link FLUID_TRICKLE}, and raised to a solid stream while a surge or a burp pours (a surge breaks a
 * drought — the reaction is the point).
 *
 * @param {object} args
 * @param {Float32Array} args.tubeData - `tubeCount * 2 * 4`.
 * @param {Float32Array} args.pumpData - `writeFluidTubeConstantsBuffer`'s buffer (Q scaled in place).
 * @param {Array<{lengthPx:number, crossSectionProfile: Float64Array}>} args.tubes
 * @param {Array<object>} args.reactions - {@link createFluidReactionState}.
 * @param {number} args.tSec @param {number} args.dtSec
 * @param {number} args.chaos @param {number} args.flowSpeed
 * @param {number} [args.paletteCount] - reagents in play.
 * @param {boolean} [args.droughts] - false keeps every supply window on (tests; a pre-round-3 look).
 * @returns {Array<object>} this tick's reaction per tube (for lights + status).
 */
export function writeFluidTubeTick({
  tubeData,
  pumpData,
  tubes,
  reactions,
  tSec,
  dtSec,
  chaos,
  flowSpeed,
  paletteCount = 4,
  droughts = true,
}) {
  const out = [];
  for (let row = 0; row < tubes.length; row++) {
    const st = reactions[row];
    const r = fluidReactionAt(tSec, st, chaos, paletteCount);
    const q = pumpData[row * 4] * flowSpeed * r.qMul;
    pumpData[row * 4] = q;
    const drought = droughts ? fluidDroughtAt(tSec, row) : 0;
    r.drought = drought;
    const pumped = pumpData[row * 4 + 1] * (1 - drought);
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

/** Linear read of a twin array at arc position `s` (0..1). */
export function sampleFluidTwin(arr, s) {
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
