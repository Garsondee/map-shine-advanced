/**
 * CANDLE FLICKER — an MSA-NATIVE animation type (NOT a Foundry registry
 * key), the default animation for MSA's own candle lights
 * (effects/candle-flame-render.js's anchor-placed props). Deliberately its
 * OWN registry entry rather than reusing `torch` verbatim: candle lights
 * are meant to keep evolving (per the author's own direction) — a distinct
 * type means future candle-specific tuning never drags real Foundry Torch-
 * animated lights along with it, and vice versa. This file IS that
 * evolution — see the QUALITY TIERS section.
 *
 * ============================================================================
 * QUALITY TIERS — a PHYSICAL candle model (2026-07-20, author's own
 * direction: "much more chaotic… brighter for a little bit then dying down,
 * flickering, guttering, the light source itself not circular but oval and
 * shifting in size and lean")
 * ============================================================================
 *
 * `quality` is a graph-BUILD-time integer (0..2) chosen by a JS `if`, so a
 * higher tier's extra nodes are NEVER CONSTRUCTED at a lower tier — the
 * `tsl/no-uniform-gates` wall's own rule (tier selection is a JS branch at
 * build time, never a runtime uniform toggle that still pays the compiled
 * cost). Changing the tier live rebuilds the light's materials (vt-pan-
 * viewer.js's animation-rebuild path, keyed on quality too).
 *
 *   TIER 0 ("low") — the ORIGINAL shader, byte-for-byte: a single-octave
 *     perlin flicker + a smaller bright core. A regression anchor — "low"
 *     always reads exactly as it did before this ladder existed.
 *
 *   TIER 1 ("standard") — TEMPORAL life, round pool:
 *       • CHAOTIC GUTTERING BRIGHTNESS — the single biggest fix. NOT one
 *         gentle sine: a SLOW (seconds-long) swell so the flame visibly
 *         brightens for a while then dies down, a MID and FAST jitter riding
 *         on top, AND a separate "gutter" term that briefly, sharply DIPS
 *         the flame (a draft catching it). Brightness swings ~0.35→1.18, not
 *         the old timid 0.55→1.0.
 *       • WARM↔COOL TEMPERATURE SHIFT — a real candle goes near-WHITE when
 *         it flares and deep EMBER-ORANGE when it dies down. Coloration-only
 *         (illumination is luminance on the floor — tinting it would wrongly
 *         colour the stones).
 *
 *   TIER 2 ("lavish") — SPATIAL life on top of tier 1. The light stops being
 *     a circle:
 *       • WANDERING LEAN — a slowly-drifting lean vector (with GUSTS) offsets
 *         the pool's body off the wick, like a flame bending in a draught.
 *       • OVAL STRETCH — the pool ELONGATES along the lean axis and narrows
 *         across it: an ellipse that leans, not a disc.
 *       • SIZE SHIFT — the pool's size breathes AND couples to brightness, so
 *         a gutter dip visibly SHRINKS the pool and a flare swells it.
 *       • BOILING EDGE — the pool edge is perturbed by POSITION-based 2D noise
 *         that drifts over time, so it churns and licks. (The old version used
 *         ANGULAR noise, which just rotated a fixed star in place — the exact
 *         "fluff ball gently rotating" the author flagged; position-based
 *         noise boils instead of spins.)
 *     Both channels share `candleLife`/`candleShape` so their footprints agree.
 *
 * @module effects/lighting/animations/candle-flicker
 */

import { buildFlickerRatioNode } from './light-animation-clock.js';

/**
 * The SAME windowed inverse-square curve the overall candle light uses
 * (point-light-illumination.js#inverseSquareFalloff — kept as a tiny local
 * copy rather than a cross-directory import so animations/ stays self-
 * contained; identical formula, K matched to the candle's own steepness).
 * Used to make the bright CENTRE a fine POINT that fades exactly like the
 * pool around it (the author's "finer point with the same falloff as the
 * overall light"), instead of a flat smoothstep plateau.
 * @param {*} TSL @param {*} d - a float node (0 at the point's centre).
 * @returns {*} a float node in [0,1], 1 at d=0, 0 at d≥1.
 */
function coreInverseSquare(TSL, d) {
  const { float, clamp } = TSL;
  const d2 = d.mul(d);
  const windowTerm = clamp(float(1).sub(d2.mul(d2)), float(0), float(1));
  return windowTerm.mul(windowTerm).div(d2.mul(float(8)).add(float(1)));
}

// ── Tier ≥1: chaotic guttering brightness (multi-timescale + brief dips) ────
// A VERY-slow octave dominates the envelope so each candle RANDOMLY WANDERS up
// and down over ~20s (the author's ask), with faster octaves as fine texture
// and a separate gutter term for brief sharp dips. Desynced per candle because
// `time` already carries the light's own seed (buildAnimationTimeNode).
const FLICK_VERYSLOW_RATE = 0.045; // ~20s wander — the dominant "up and down"
const FLICK_SLOW_RATE = 0.13; // seconds-long swell
const FLICK_MID_RATE = 0.9;
const FLICK_FAST_RATE = 3.7;
const FLICK_VERYSLOW_W = 0.24; // weights into the [0,1] envelope (veryslow dominates)
const FLICK_SLOW_W = 0.16;
const FLICK_MID_W = 0.1;
const FLICK_FAST_W = 0.05;
const GUTTER_RATE = 1.9; // the brief sharp dips (a draft catching the flame)
const GUTTER_DEPTH = 0.7; // how deep a gutter dip cuts (0..1)
const BRIGHT_FLOOR = 0.4; // guttered-low brightness multiplier
const BRIGHT_CEIL = 1.2; // flare-high brightness multiplier

// ── Tier 2: lean / oval / size / boiling edge ───────────────────────────────
// Deliberately GENTLE (author: "the drifting central core needs to be smaller
// and less drifty") — a small, slow lean, not a big swing.
// WIND.MD TIER 0 (2026-07-21): the lean is now the SHARED wind field
// (world/wind-field.js's `sampleWind`) when the scaffold provides one — see
// `candleShape`'s own `wind` param below. LEAN_RATE/LEAN_BASE/LEAN_GUST/
// GUST_RATE are the FALLBACK path only (an older/未wired caller with no
// `wind` node) — kept, not deleted, so nothing regresses for a caller that
// doesn't yet carry a world position + exposure.
const LEAN_RATE = 0.24; // how fast the lean direction wanders (slower now)
const LEAN_BASE = 0.05; // resting lean magnitude (fraction of radius) — halved
const LEAN_GUST = 0.13; // extra lean during a gust — roughly halved
const GUST_RATE = 0.6;
// The shared field's raw magnitude (roughly [0, ~1.4], exposure-scaled) tuned
// down to land in the SAME rough visual range the old LEAN_BASE/LEAN_GUST
// pair produced ([0.05, 0.18]) at full outdoor exposure — a first-pass
// constant (this becomes a real WIND_PARAMS knob per Wind.md §8, not a final
// tuning), picked by eye against the pre-existing lean's own feel.
const SHARED_WIND_LEAN_SCALE = 0.35;

/**
 * WIND-DRIVEN GUTTER + SNUFF (2026-07-21, `effects/candle-flame.js`'s
 * `windResponse` param, Wind.md §6). MUST match `effects/candle-flame-
 * render.js`'s OWN identical constants exactly — both files sample the SAME
 * shared field (`world/wind-field.js#sampleWind`) at the SAME world position
 * (the light's `windCenter` and the flame's baked `center` attribute are the
 * same wick), so a single gust needs the SAME raw-magnitude thresholds to
 * gutter/snuff the flame and its own cast light together, never one before
 * the other. See that file's own header for the full reasoning (magnitude
 * ranges, why snuff is stateless) — not repeated here.
 */
const WIND_GUTTER_MAG_THRESHOLD = 1.3;
const WIND_GUTTER_MAG_RANGE = 1.0;
const WIND_SNUFF_MAG_LOW = 2.2;
const WIND_SNUFF_MAG_HIGH = 3.2;
const STRETCH_ALONG = 1.15; // elongation along the lean axis, per unit lean (gentler)
const STRETCH_PERP = 0.4; // perpendicular squash, per unit lean
const PERP_MIN = 0.6; // never narrower than this (guards a degenerate sliver)
const SIZE_BASE = 0.85;
const SIZE_LIFE = 0.25; // pool grows with brightness (flare = bigger pool)
const SIZE_BREATHE = 0.1;
const BREATHE_RATE = 0.7;
const EDGE_CHURN_SCALE = 4.0; // noise cells across the pool
const EDGE_CHURN_RATE = 1.2; // how fast the edge boils
const EDGE_CHURN_AMP = 0.07; // radial wobble of the edge (fraction of radius)

// ── The bright-core size + tier-1 temperature tints ─────────────────────────
const CORE_SCALE = 0.32; // bright core — a FINE point now (author: "finer point")
const CORE_POINT_SPAN = 0.75; // the coloration warm point dies by this fraction of the radius
// Cool = a dim ember (green/blue pulled down hard); warm = a flaring near-
// white tip. At the candle default colour #ffaa00 = (1, 0.667, 0) these read
// as a red ember ↔ yellow-white swing — a temperature change, not a hue spin.
const COOL_TINT = [1.0, 0.5, 0.16];
const WARM_TINT = [1.0, 0.96, 0.82];

/**
 * The candle's own life signal — tier 0 is Foundry's `animateFlickering`
 * primitive verbatim (single perlin); tier ≥1 is a chaotic multi-timescale
 * guttering envelope. Returns `{n, brightnessPulse, warmth, life}`: `n` feeds
 * the scaffold's ratio-jitter (kept bounded), `brightnessPulse` is the big
 * brightness swing (wind-driven gutter/snuff already folded in — see below),
 * `warmth` (~[-1,1]) drives the temperature shift, `life` (~[0,1]) is the raw
 * envelope the shape's size couples to.
 *
 * @param {*} TSL @param {*} time @param {*} amplification - float node, uIntensityRaw/5.
 * @param {number} quality
 * @param {*} [wind] - the scaffold's already-sampled shared wind vec2 (same
 *   node `candleShape` receives) — OPT-IN: absent → byte-identical to before
 *   wind-driven gutter/snuff existed.
 * @param {*} [windResponse] - the effect's `windResponse` float node/uniform
 *   (default 1 when `wind` is present but this is omitted).
 * @returns {{n: *, brightnessPulse: *, warmth: *, life: *}}
 */
function candleLife(TSL, time, amplification, quality, wind, windResponse) {
  // mx_noise_float, NOT mx_perlin_noise_float — the latter is internal-only in
  // the vendored three build (see light-animation-clock.js#buildFlickerNode).
  const { float, vec2, mx_noise_float: perlin, clamp, smoothstep, mix, length, max } = TSL;
  const amplitude = amplification.mul(float(0.45));
  const remap = (raw) => raw.add(float(1)).mul(float(0.5)); // perlin [-1,1] → [0,1]

  // VERTEX-STAGE HOIST (Performance-Audit-2026-08.md §3.5, CONFIRMED) — every
  // input reaching this function (time/amplitude/wind/windResponse) is a
  // per-light UNIFORM, so `n`/`brightnessPulse`/`warmth`/`life` are all
  // constant across a light's whole mesh for this frame. Left as plain nodes
  // they get compiled into `material.fragmentNode` and re-evaluate up to 5
  // mx_noise_float calls at EVERY fragment the light covers (up to ~785,000
  // for a large light, per this file's own sibling `point-light-pool.js`
  // comment on fire's radii) instead of once at each of the mesh's own
  // <=192 fan vertices. `.toVarying(name)` (three.webgpu.js's `VaryingNode`,
  // already load-bearing elsewhere in this codebase —
  // `particles/particle-runtime.js`'s `vFade`, `effects/lightning-render.js`'s
  // strand varyings) computes the wrapped node ONCE in the vertex stage and
  // interpolates the result into the fragment stage — lossless by
  // construction, since a value that is constant across the primitive
  // interpolates to itself exactly at every fragment.
  const hoist = (node, name) => node.toVarying(name);

  if (quality < 1) {
    // TIER 0 — byte-identical to light-animation-clock.js#buildFlickerNode.
    // No wind coupling at this tier, matching the flame's own tier-0 "no
    // wind, no gutter" design (candle-flame-render.js's own header). Hoisted
    // too (harmless: hoisting changes WHERE a uniform value is computed,
    // never WHAT it computes to) so tier 0 gets the identical win.
    const unit = remap(perlin(vec2(time, float(0))));
    const n = unit.mul(amplitude);
    return {
      n: hoist(n, 'vCandleLifeN'),
      brightnessPulse: hoist(float(0.55).add(n), 'vCandleBrightnessPulse'),
      warmth: hoist(unit.sub(float(0.5)).mul(float(2)), 'vCandleWarmth'),
      life: hoist(unit, 'vCandleLife'),
    };
  }

  // TIER ≥1 — chaotic guttering. FOUR decorrelated octaves summed around a
  // 0.5 baseline (each perlin is [-1,1]), then a brief sharp dip carved out.
  // The very-slow octave dominates → each candle wanders up and down over ~20s.
  const veryslow = perlin(vec2(time.mul(float(FLICK_VERYSLOW_RATE)), float(89)));
  const slow = perlin(vec2(time.mul(float(FLICK_SLOW_RATE)), float(0)));
  const mid = perlin(vec2(time.mul(float(FLICK_MID_RATE)), float(7)));
  const fast = perlin(vec2(time.mul(float(FLICK_FAST_RATE)), float(17)));
  const flick = clamp(
    float(0.5)
      .add(veryslow.mul(float(FLICK_VERYSLOW_W)))
      .add(slow.mul(float(FLICK_SLOW_W)))
      .add(mid.mul(float(FLICK_MID_W)))
      .add(fast.mul(float(FLICK_FAST_W))),
    float(0),
    float(1)
  );
  // Guttering: a separate noise, thresholded so it's near-0 MOST of the time
  // and only occasionally rises — a brief, sharp dip, not a constant droop.
  // WIND-DRIVEN GUTTER (see WIND_GUTTER_MAG_* header) — a strong local gust
  // ADDS its own dip pressure on top of the atmospheric random one (`max`,
  // never suppressing the random dips a real candle also has).
  const gutterN = perlin(vec2(time.mul(float(GUTTER_RATE)), float(31)));
  const noiseDip = smoothstep(float(0.5), float(0.9), gutterN);
  const windMag = wind ? length(wind).mul(windResponse ?? float(1)) : float(0);
  const windDip = wind
    ? clamp(windMag.sub(float(WIND_GUTTER_MAG_THRESHOLD)).div(float(WIND_GUTTER_MAG_RANGE)), float(0), float(1))
    : float(0);
  const dip = max(noiseDip, windDip);
  const life = clamp(flick.mul(float(1).sub(dip.mul(float(GUTTER_DEPTH)))), float(0), float(1));

  const n = life.mul(amplitude);
  // SNUFF (see WIND_SNUFF_MAG_* header) — applied AFTER the gutter-driven
  // brightness, not folded into `life` itself: a gutter dip still floors at
  // BRIGHT_FLOOR (a real but dim ember), while snuff must be able to reach
  // TRUE zero — a distinct, stronger wind event, not just "very cold".
  const snuff = wind ? smoothstep(float(WIND_SNUFF_MAG_LOW), float(WIND_SNUFF_MAG_HIGH), windMag) : float(0);
  const brightnessPulse = mix(float(BRIGHT_FLOOR), float(BRIGHT_CEIL), life).mul(float(1).sub(snuff));
  const warmth = life.sub(float(0.5)).mul(float(2));
  return {
    n: hoist(n, 'vCandleLifeN'),
    brightnessPulse: hoist(brightnessPulse, 'vCandleBrightnessPulse'),
    warmth: hoist(warmth, 'vCandleWarmth'),
    life: hoist(life, 'vCandleLife'),
  };
}

/**
 * The pool SHAPE — a warped distance replacing plain `dist` for the core/edge
 * fades, SHARED by both channels so their footprints agree. Tier 0/1: plain
 * circular `dist`. Tier 2: a wandering LEAN offsets the pool, an OVAL stretch
 * elongates it along the lean, and its SIZE couples to `life` (dim → shrink)
 * plus its own breath. Reads the injected `localPosition` for the
 * fragment's true 2D position — NEVER `positionLocal` directly (fixed
 * 2026-08-11: that global is the mesh's raw vertex-position attribute,
 * which for S2's BATCHED mesh is a world-baked coordinate, not the
 * unit-circle local space this function's math assumes — see
 * docs/planning/Point-Light-Batching-Design.md §3.6).
 *
 * @param {*} TSL @param {*} time @param {*} dist @param {*} localPosition -
 *   the SAME local-space vec2 `dist` was derived from
 *   (`length(localPosition) === dist`), injected by the shading core.
 * @param {*} life @param {number} quality
 * @param {*} [wind] - a vec2 node, the scaffold's already-sampled shared wind
 *   (world/wind-field.js's `sampleWind`, Wind.md Tier 0) — present whenever
 *   this light carries a world position + exposure. Absent → falls back to
 *   this function's OWN self-contained noise (below), unchanged from before
 *   this param existed.
 * @param {*} [windResponse] - the effect's `windResponse` float node/uniform
 *   (Wind.md §8.1) — scales the shared-field lean; ignored on the fallback
 *   noise path (that path predates windResponse and stays its own thing).
 *   Default 1 when `wind` is present but this is omitted.
 * @returns {{flameDist: *}}
 */
function candleShape(TSL, time, dist, localPosition, life, quality, wind, windResponse) {
  if (quality < 2) return { flameDist: dist };
  const { float, vec2, mx_noise_float: perlin, length, dot, max } = TSL;

  const P = localPosition;

  // Wandering lean — THE SHARED FIELD when provided (Wind.md Tier 0: this is
  // the fix for "the light used to lean in its OWN wind, different from the
  // flame's"). Falls back to the original two-decorrelated-noises-plus-gust
  // lean otherwise.
  let leanRaw;
  if (wind) {
    leanRaw = wind.mul(float(SHARED_WIND_LEAN_SCALE)).mul(windResponse ?? float(1));
  } else {
    const leanX = perlin(vec2(time.mul(float(LEAN_RATE)), float(41)));
    const leanY = perlin(vec2(time.mul(float(LEAN_RATE)), float(53)));
    const gust = perlin(vec2(time.mul(float(GUST_RATE)), float(61)))
      .mul(float(0.5))
      .add(float(0.5));
    const leanMag = float(LEAN_BASE).add(gust.mul(float(LEAN_GUST)));
    leanRaw = vec2(leanX, leanY).mul(leanMag);
  }

  // Elliptical metric setup: decompose into along/across the lean axis,
  // elongate along, squash across. Lean magnitude drives how oval it gets, so
  // a resting flame is nearly round and a gusting one is a long tongue.
  const leanLenRaw = length(leanRaw);
  const axisRaw = leanRaw.div(max(leanLenRaw, float(0.001))); // safe: tiny lean → ~round anyway
  const aRaw = float(1).add(leanLenRaw.mul(float(STRETCH_ALONG))); // reaches further along the lean
  const bRaw = max(float(1).sub(leanLenRaw.mul(float(STRETCH_PERP))), float(PERP_MIN)); // narrower across

  // Size: couples to brightness (a gutter dip shrinks the pool) + own breath.
  const breathe = perlin(vec2(time.mul(float(BREATHE_RATE)), float(71)));
  const sizeRaw = max(
    float(SIZE_BASE)
      .add(life.mul(float(SIZE_LIFE)))
      .add(breathe.mul(float(SIZE_BREATHE))),
    float(0.3)
  );

  // VERTEX-STAGE HOIST (same reasoning as candleLife's own, above) —
  // lean/axis/a/b/size all derive purely from wind/windResponse/time/life,
  // every one a per-light uniform (`life` arrives already hoisted from
  // candleLife), so none of them need the per-fragment `P` this function was
  // called for. Only the combination with `P` just below genuinely needs the
  // fragment stage.
  const lean = leanRaw.toVarying('vCandleLean');
  const axis = axisRaw.toVarying('vCandleAxis');
  const a = aRaw.toVarying('vCandleStretchA');
  const b = bRaw.toVarying('vCandleStretchB');
  const size = sizeRaw.toVarying('vCandleSize');

  // Shift the pool body toward the lean (the flame bends off the wick) — the
  // first point in this function that actually needs the fragment's own P.
  const centered = P.sub(lean);
  const along = dot(centered, axis);
  const across = dot(centered, vec2(axis.y.negate(), axis.x));

  const flameDist = length(vec2(along.div(a), across.div(b))).div(size);
  return { flameDist };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDimColor - the scaffold's own per-light dim ambient colour.
 * @param {*} args.uRatio - the scaffold's own BASE ratio uniform.
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist
 * @param {*} args.localPosition - the local-space vec2 `dist` was derived
 *   from — forwarded to `candleShape`, NEVER read via `positionLocal`
 *   directly (see that function's own header for why).
 * @param {*} args.computeSwitchColorBand - the scaffold's own band-rebuild closure.
 * @param {number} [args.quality=0] - graph-build-time tier (see this module's header).
 * @param {*} [args.wind] - the scaffold's shared wind sample (Wind.md Tier 0
 *   — see `candleShape`'s own param). Forwarded from point-light-
 *   illumination.js's own `wind` seed arg.
 * @param {*} [args.windResponse] - `effects/candle-flame.js`'s `windResponse`
 *   param (Wind.md §8.1) — scales lean AND the wind-driven gutter/snuff
 *   pressure in `candleLife`/`candleShape`. Default 1 when `wind` is present
 *   but this is omitted.
 * @returns {{finalColor: *}}
 */
export function buildCandleFlickerIlluminationSeed({
  THREE,
  uDimColor,
  uRatio,
  uIntensityRaw,
  time,
  dist,
  localPosition,
  computeSwitchColorBand,
  quality = 0,
  wind,
  windResponse,
}) {
  const { float, mix, smoothstep, max } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { n, brightnessPulse, life } = candleLife(THREE.TSL, time, amplification, quality, wind, windResponse);
  const jitteredRatio = buildFlickerRatioNode(THREE.TSL, uRatio, n);
  const seed = computeSwitchColorBand(jitteredRatio);

  // The bright core rides the SHARED warped distance, so at tier 2 the hot
  // centre leans and elongates with the rest of the pool.
  const { flameDist } = candleShape(THREE.TSL, time, dist, localPosition, life, quality, wind, windResponse);
  const compressedRatio = jitteredRatio.mul(float(CORE_SCALE));
  const upperEdge = max(jitteredRatio, compressedRatio.add(float(0.0001)));
  const extraCompress = smoothstep(compressedRatio, upperEdge, flameDist);
  const compressed = mix(seed, uDimColor, extraCompress);

  // brightnessPulse multiplies the WHOLE contribution — the guttering reads
  // across the pool (MAX-blend with the scene ambient means a dip below
  // ambient simply keeps the ambient, so the candle can't darken the floor).
  const finalColor = compressed.mul(brightnessPulse);
  return { finalColor };
}

/**
 * FIRE's own illumination seed — same guttering `brightnessPulse` as
 * {@link buildCandleFlickerIlluminationSeed}, but WITHOUT that function's
 * own `extraCompress`/`candleShape` narrowing.
 *
 * ⚠️ WHY THIS IS A SEPARATE FUNCTION (mythica-machina-press#475, round 2 —
 * the coloration-only fix, and three rounds of falloff/luminosity tuning
 * downstream of it, still left "a LOT of white light" live). Fire's
 * `firePuff` entry (`registry.js`) originally left `buildIlluminationSeed`
 * pointed at candle's own function on the stated assumption that
 * "brightness/guttering was never the reported problem, only the hue's
 * reach was" (`registry.js`'s own now-corrected header) — WRONG, confirmed
 * by re-reading this function with that assumption specifically in
 * question. `extraCompress` (`compressedRatio = jitteredRatio * CORE_SCALE
 * (0.32)`) forces the ENTIRE seed to flat `uDimColor` from roughly 11% of
 * the light's own ratio outward — a MUCH smaller "distinctly bright" zone
 * than `ratio` alone implies, deliberately, for a candle's "fine point at
 * the wick." That is a SECOND, independent narrowing living in the
 * ILLUMINATION channel, parallel to (and undiscovered by) the coreFade
 * narrowing already removed from fire's COLORATION channel — illumination
 * was never actually touched by any of this issue's earlier fixes, despite
 * being colour-agnostic ambient brightness that MULTIPLIES the map's own
 * albedo (`environmental-light.js`'s composite): a large flat-`uDimColor`
 * zone reads as a flat, neutral brightening of whatever's underneath,
 * competing with — and on a fire's much bigger radius, often winning
 * against — the additive orange coloration's own, comparatively modest
 * contribution. Dropping the extra narrowing here lets illumination follow
 * `computeSwitchColorBand`'s own natural ratio-driven falloff instead of a
 * candle-scaled hot-point on top of it. No `candleShape` either, for the
 * same reason `buildFirePuffColorationSeed` has none — fire's own particle
 * system already authors the flame's silhouette.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uRatio
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {(ratio: *) => *} args.computeSwitchColorBand - the scaffold's own
 *   band-rebuild closure (bright/dim pick by ratio vs. `dist`).
 * @param {number} [args.quality=0] - graph-build-time tier (see this
 *   module's header) — `candleLife`'s own tier ladder still applies to the
 *   guttering pulse; only the SHAPE narrowing above it is removed.
 * @param {*} [args.wind] @param {*} [args.windResponse] - forwarded to
 *   `candleLife` for the wind-driven gutter/snuff term only.
 * @returns {{finalColor: *}}
 */
export function buildFirePuffIlluminationSeed({
  THREE,
  uRatio,
  uIntensityRaw,
  time,
  computeSwitchColorBand,
  quality = 0,
  wind,
  windResponse,
}) {
  const { float } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { n, brightnessPulse } = candleLife(THREE.TSL, time, amplification, quality, wind, windResponse);
  const jitteredRatio = buildFlickerRatioNode(THREE.TSL, uRatio, n);
  const seed = computeSwitchColorBand(jitteredRatio);

  // Same guttering multiply as candle's own — see that function's identical
  // comment for why brightnessPulse applies to the WHOLE contribution.
  const finalColor = seed.mul(brightnessPulse);
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist
 * @param {*} args.localPosition - see `buildCandleFlickerIlluminationSeed`'s
 *   identical param — NEVER read via `positionLocal` directly.
 * @param {number} [args.quality=0] - graph-build-time tier (see this module's header).
 * @param {*} [args.wind] - the scaffold's shared wind sample (Wind.md Tier 0
 *   — see `candleShape`'s own param). Forwarded from point-light-
 *   coloration.js's own `wind` seed arg.
 * @param {*} [args.windResponse] - see `buildCandleFlickerIlluminationSeed`'s
 *   identical param — the SAME value the illumination channel gets, so both
 *   channels gutter/snuff together.
 * @returns {{finalColor: *}}
 */
export function buildCandleFlickerColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  uIntensityRaw,
  time,
  dist,
  localPosition,
  quality = 0,
  wind,
  windResponse,
}) {
  const { float, vec2, vec3, mix, clamp, mx_noise_float: perlin } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { brightnessPulse, warmth, life } = candleLife(THREE.TSL, time, amplification, quality, wind, windResponse);

  // TIER ≥1 — warm↔cool temperature shift on the authored light colour.
  let tinted = uLightColor;
  if (quality >= 1) {
    const tempMix = clamp(float(0.5).add(warmth.mul(float(0.5))), float(0), float(1));
    const cool = vec3(COOL_TINT[0], COOL_TINT[1], COOL_TINT[2]);
    const warm = vec3(WARM_TINT[0], WARM_TINT[1], WARM_TINT[2]);
    tinted = uLightColor.mul(mix(cool, warm, tempMix));
  }

  // The saturated flame-glow footprint: the SHARED warped distance (oval/
  // leaning/sizing at tier 2), then a BOILING edge — position-based 2D noise
  // that drifts over time, so the rim churns and licks instead of rotating.
  const { flameDist } = candleShape(THREE.TSL, time, dist, localPosition, life, quality, wind);
  let edge = flameDist;
  if (quality >= 2) {
    const P = localPosition;
    const churn = perlin(
      vec2(
        P.x.mul(float(EDGE_CHURN_SCALE)).add(time.mul(float(EDGE_CHURN_RATE))),
        P.y.mul(float(EDGE_CHURN_SCALE)).sub(time.mul(float(EDGE_CHURN_RATE * 0.75)))
      )
    );
    edge = flameDist.add(churn.mul(float(EDGE_CHURN_AMP)));
  }
  // A FINE central POINT with the SAME (inverse-square) falloff as the overall
  // light (author's ask) — replaces the old flat smoothstep plateau. The warm
  // glow now peaks sharply at the wick and drops off like the pool around it.
  const coreFade = coreInverseSquare(THREE.TSL, clamp(edge.div(float(CORE_POINT_SPAN)), float(0), float(0.999)));

  const finalColor = tinted.mul(brightnessPulse).mul(uColorationAlpha).mul(coreFade);
  return { finalColor };
}

/**
 * FIRE's own coloration seed — the same warm↔cool temperature swing as
 * {@link buildCandleFlickerColorationSeed}, but WITHOUT that function's own
 * `coreFade` narrowing.
 *
 * ⚠️ WHY THIS IS A SEPARATE FUNCTION (mythica-machina-press#475, author-
 * reported: "the light a fire throws is white"). `buildCandleFlickerColoration
 * Seed`'s `coreFade` (`coreInverseSquare`, `CORE_POINT_SPAN`) is a SECOND,
 * steep falloff, MULTIPLIED on top of the ordinary `falloff` every light
 * already gets downstream (`point-light-coloration.js`'s `outputColor =
 * finalColor.mul(falloff)`). Two compounded falloffs squeeze the visible tint
 * into roughly the inner half of the light's radius, while illumination — ONE
 * falloff, softening outward to `uDimColor` rather than to nothing — still
 * reaches the full radius. For a candle (small, always seen close up) that
 * reads as the intended "fine bright point at the wick." Fire's radii are
 * documented elsewhere as substantially larger (`fire-geometry.js#cluster
 * FireSources`'s own header: "Fire's radii are LARGER"), so the SAME
 * fraction-of-radius core spans enough screen space that the un-tinted outer
 * band — full brightness, zero hue — becomes the dominant thing a viewer
 * actually sees: a big pool of white light with a small warm dot in the
 * middle, not a fire-lit room. Dropping the extra narrowing here lets the
 * warm↔cool tint ride the SAME single falloff illumination already uses, so
 * the colour fills the whole glow a viewer actually sees.
 *
 * No `candleShape` either — fire's own particle system already authors the
 * flame's silhouette; the CAST LIGHT has no wick to lean/oval/boil around.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {number} [args.quality=0] - graph-build-time tier (see this
 *   module's header) — `quality >= 1` is what turns the temperature swing on;
 *   fire reaches this at its default effect tier (`fire-geometry.js`'s
 *   `FIRE_DEFAULT_TIER`).
 * @param {*} [args.wind] - the scaffold's shared wind sample, forwarded to
 *   `candleLife` for the wind-driven gutter/snuff term only — there is no
 *   lean to compute here.
 * @param {*} [args.windResponse]
 * @returns {{finalColor: *}}
 */
export function buildFirePuffColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  uIntensityRaw,
  time,
  quality = 0,
  wind,
  windResponse,
}) {
  const { float, vec3, clamp, mix } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { brightnessPulse, warmth } = candleLife(THREE.TSL, time, amplification, quality, wind, windResponse);

  // TIER ≥1 — the identical warm↔cool swing candle's own coloration uses
  // (see buildCandleFlickerColorationSeed above); just never narrowed to a core.
  let tinted = uLightColor;
  if (quality >= 1) {
    const tempMix = clamp(float(0.5).add(warmth.mul(float(0.5))), float(0), float(1));
    const cool = vec3(COOL_TINT[0], COOL_TINT[1], COOL_TINT[2]);
    const warm = vec3(WARM_TINT[0], WARM_TINT[1], WARM_TINT[2]);
    tinted = uLightColor.mul(mix(cool, warm, tempMix));
  }

  const finalColor = tinted.mul(brightnessPulse).mul(uColorationAlpha);
  return { finalColor };
}
