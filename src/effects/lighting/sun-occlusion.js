/**
 * SUN OCCLUSION — the pure core of the cast-shadow march (docs/planning/Sun-Shadows.md).
 *
 * ============================================================================
 * THE ONE SENTENCE
 * ============================================================================
 *
 * Building shadows, overhead-tile shadows and sky-reach shadows are not three
 * systems. They are three answers to ONE question — *"how tall is the thing
 * standing between this ground pixel and the sun?"* — so they are three
 * producers into one height field (`scene/mask-derive.js`'s `casterHeight`),
 * read by one ray march. This file is that march's maths, in plain JS, so it
 * can be asserted rather than admired.
 *
 * V2 spent 7,763 lines across `BuildingShadowsEffectV2`, `SkyReachShadowsEffectV2`
 * and `OverheadStampEffectV2` on three models of the same physics — each with
 * its own `length`, `softness`, `smear`, `penumbra`, `shadowCurve` and
 * `blurRadius` sliders, tuned against one another through a shared combine.
 * There is not one of those knobs here, and their absence is the design:
 *
 *   LENGTH   is `height / tan(elevation)` — it falls out of the march, so dawn
 *            elongates and noon collapses without anyone authoring a curve.
 *   SMEAR    is what a march IS: the shadow is the union of every blocked step
 *            between the caster's foot and its tip, not a stamped copy pushed
 *            sideways.
 *   SOFTNESS contact-hardens because {@link marchPenumbraPx} grows with the
 *            distance the ray has travelled — crisp at the wall, diffuse at the
 *            tip. That is the real behaviour, and it is one function.
 *
 * Everything atmospheric — direction, cloud softening, night fading — arrives
 * pre-computed from `effects/shadow-access.js`. **This system adds ZERO
 * atmospheric knobs**, which is the whole point of that handle existing.
 *
 * ============================================================================
 * WHY THE REFERENCE MARCH LIVES HERE IN JS
 * ============================================================================
 *
 * The GPU version (`sun-occlusion-render.js`) is TSL and cannot be Node-tested.
 * {@link marchVisibility} below is the same algorithm over a plain sampler
 * callback, so the suite can assert the things that actually matter and are
 * actually easy to get wrong: that a caster shadows the side AWAY from the sun
 * and not toward it, that a taller caster reaches further, that a hole in the
 * field lets light through, that the receiver gate is respected, and that a
 * grazing sun cannot produce an infinite or NaN throw. The shader is then a
 * transcription of a proven function rather than an original composition.
 *
 * @module effects/lighting/sun-occlusion
 */

import { clamp01, shadowOffsetDirection } from './light-visibility.js';

/**
 * How many samples the march takes along the ray. Not a quality slider that
 * changes the LOOK — the step length is derived from the field's own longest
 * possible shadow (see {@link marchStepPx}), so more steps means fewer missed
 * thin casters, never a longer or darker shadow.
 */
export const DEFAULT_MARCH_STEPS = 32;

/**
 * The shortest shadow a caster casts before the sun is treated as overhead.
 * Below ~1 px of throw there is nothing to march and the result is "lit"; this
 * exists so the noon case is an early exit rather than a loop that divides by a
 * vanishing tangent.
 */
export const MIN_THROW_PX = 1;

/**
 * How wide the penumbra grows per unit of distance travelled from the caster.
 * The sun's angular diameter is about half a degree, which gives a real
 * penumbra of roughly `0.009 × distance`; this is deliberately ~4× that,
 * because a battlemap's shadows read better slightly softer than physics and
 * because the height field's own texels are coarse enough that a physically
 * tight penumbra would show the grid. Tuned by eye, stated as such.
 */
export const PENUMBRA_PER_PX = 0.035;

/**
 * Convert a compass azimuth into the world-space unit vector pointing TOWARD
 * the light — the direction the march walks.
 *
 * ⚠️ THE Y-FLIP CLASS (memory: feedback_y_flip_recurring_risk — it bit the
 * UI-shadow twice and vegetation twice). `shadowOffsetDirection` returns the
 * direction a shadow is THROWN, in a +y-DOWN space. Foundry's canvas is also
 * +y down, so the vector transfers with no flip; and the march walks the
 * OPPOSITE way (from the lit pixel back toward the sun to find what blocks it),
 * hence the negation. Both facts are asserted in this module's test on all four
 * quadrants rather than trusted to this comment.
 *
 * @param {number} azimuthDeg - the light's compass azimuth (cw from world-up).
 * @returns {{x: number, y: number}} unit vector toward the light, +y down.
 */
export function marchDirectionToSun(azimuthDeg) {
  const away = shadowOffsetDirection(azimuthDeg);
  return { x: -away.x, y: -away.y };
}

/**
 * The longest horizontal distance any caster in this field can throw a shadow:
 * `maxHeightPx / tan(elevation)`, clamped. This is what sizes the march — the
 * loop must be able to reach the tip of the tallest shadow or that shadow ends
 * in mid-air with a hard edge.
 *
 * @param {object} args
 * @param {number} args.maxCasterHeightPx - the field's tallest caster.
 * @param {number} args.elevationDeg - the sun's elevation, clamped to [0, 90].
 * @param {number} [args.maxThrowPx=8192] - a hard ceiling so a sun ON the
 *   horizon asks for a finite march rather than an infinite one.
 * @returns {number} px, >= 0.
 */
export function maxThrowPx({ maxCasterHeightPx, elevationDeg, maxThrowPx: cap = 8192 }) {
  const h = Number.isFinite(maxCasterHeightPx) && maxCasterHeightPx > 0 ? maxCasterHeightPx : 0;
  if (h === 0) return 0;
  const elev = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
  const t = Math.tan((elev * Math.PI) / 180);
  const lim = Number.isFinite(cap) && cap > 0 ? cap : 8192;
  if (!(t > 1e-6)) return lim; // grazing: saturate at the cap, never Infinity
  return Math.min(lim, h / t);
}

/**
 * Distance between march samples. Derived from {@link maxThrowPx}, never
 * authored: the march must span the tallest possible shadow in `steps` samples,
 * so the step is simply that span divided by the step count. A caller that
 * raises `steps` gets a finer march over the SAME distance — quality, not reach.
 *
 * @param {object} args
 * @param {number} args.maxCasterHeightPx
 * @param {number} args.elevationDeg
 * @param {number} [args.steps]
 * @param {number} [args.maxThrowPx]
 * @returns {number} px per step, >= 0.
 */
export function marchStepPx({ maxCasterHeightPx, elevationDeg, steps = DEFAULT_MARCH_STEPS, maxThrowPx: cap }) {
  const n = Math.max(1, Math.floor(steps));
  const span = maxThrowPx({ maxCasterHeightPx, elevationDeg, maxThrowPx: cap });
  return span / n;
}

/**
 * The soft-edge radius, in HEIGHT units, for a blocker found `distancePx` away.
 *
 * Contact hardening: the same wall casts a knife edge where it meets the ground
 * and a diffuse smudge at the far tip, because the further the light has
 * travelled past an occluder the more its angular size blurs the boundary. The
 * atmospheric multiplier (cloud, night — `effects/shadow-access.js`) scales the
 * whole curve, so an overcast dusk is soft everywhere and a clear noon is tight
 * everywhere, without either being a separate model.
 *
 * @param {object} args
 * @param {number} args.distancePx - how far along the ray the blocker sits.
 * @param {number} [args.basePx=2] - the minimum feather; no shadow is a perfect cutout.
 * @param {number} [args.softnessMul=1] - `shadowAtmosphere().softnessMul`.
 * @returns {number} feather radius in the same units as the height comparison.
 */
export function marchPenumbraPx({ distancePx, basePx = 2, softnessMul = 1 }) {
  const d = Number.isFinite(distancePx) && distancePx > 0 ? distancePx : 0;
  const base = Number.isFinite(basePx) && basePx > 0 ? basePx : 0;
  const mul = Number.isFinite(softnessMul) && softnessMul > 0 ? softnessMul : 1;
  return (base + d * PENUMBRA_PER_PX) * mul;
}

/**
 * THE MARCH — walk from a lit point toward the sun and report how much of the
 * sun still reaches it.
 *
 * Returns 1 (fully lit) when nothing is tall enough to block, falling toward
 * `1 - strength` as blockers rise above the ray. Absence of data reads as LIT,
 * never as shadow — a producer that fails to report must not manufacture
 * darkness (the same fail-safe `combineVisibility` states one level up).
 *
 * @param {object} args
 * ============================================================================
 * COVERAGE DECIDES DARKNESS; HEIGHT DECIDES LENGTH (2026-07-26 rethink)
 * ============================================================================
 *
 * This used to return `smoothstep(0, feather, casterHeight − rayHeight)` — so
 * how DARK a shadow came out depended on how far the caster overtopped the ray,
 * and a low awning was permanently fainter than a tall wall. That is not what
 * shadows do: height sets a shadow's LENGTH, never its darkness. Now the
 * blocked-ness at a station is the occluder's own COVERAGE (the art's
 * antialiased alpha, a genuinely soft silhouette) and the height comparison is a
 * near-binary "is the ray under it", softened only enough to fade the shadow's
 * TIP. See docs/planning/Sun-Shadows-Rethink.md §2b.
 *
 * @param {number} args.x - world position, +y down (Foundry canvas space).
 * @param {number} args.y
 * @param {(x: number, y: number) => {heightPx: number, coverage: number, floating: number}} args.sampleField -
 *   the caster field at a world point. `heightPx` is px above THIS floor;
 *   `coverage` and `floating` are 0..1. `floating` is narrower than
 *   `coverage`: it is ONLY a structure on a genuinely DIFFERENT floor (sky-
 *   reach) — see the `d = 0` note below for why this floor's own overhead
 *   items must never appear here. Out of bounds reads zero.
 * @param {number} args.azimuthDeg - the sun's compass azimuth.
 * @param {number} args.elevationDeg - the sun's elevation above the horizon.
 * @param {number} args.maxCasterHeightPx - the field's tallest caster (sizes the march).
 * @param {number} [args.steps]
 * @param {number} [args.strength=1] - how dark a fully-blocked pixel goes, 0..1.
 * @param {number} [args.softnessMul=1] - `shadowAtmosphere().softnessMul`.
 * @param {number} [args.receiverGate=1] - 0..1; the shadow is scaled by this
 *   (the `_Outdoors` white). 0 = this pixel cannot receive a cast shadow at all.
 * @returns {number} sun visibility 0..1 at that point.
 */
export function marchVisibility({
  x,
  y,
  sampleField,
  azimuthDeg,
  elevationDeg,
  maxCasterHeightPx,
  steps = DEFAULT_MARCH_STEPS,
  strength = 1,
  softnessMul = 1,
  receiverGate = 1,
}) {
  const gate = clamp01(receiverGate);
  if (gate <= 0) return 1;
  const s = clamp01(strength) * gate;

  // ⚠️ d = 0 — THE STATION THAT WAS MISSING, then OVER-WIDENED (both
  // 2026-07-26). Missing: the loop used to start at i = 1, so the field was
  // never asked the one question that matters directly beneath a bridge, a
  // walkway or an upper floor: *is something standing over ME?* ("sky reach
  // shadows were always damn near impossible to get working.") Everything the
  // old code did to compensate — a whole separate `skyOcclusion` term with its
  // own strength — was papering over a loop bound.
  //
  // Over-widened: `floating` first shipped as "overhead ∪ sky-reach", but an
  // OVERHEAD item lives on THIS SAME floor — Foundry elevation is a draw-order
  // key, not a spatial offset, so a raised tile's own sprite occupies the
  // IDENTICAL (x,y) as whatever it would "shade" beneath it. There is no
  // separate, visible ground there to darken — only the item's own opaque art
  // — so a balcony or a lantern-on-a-plinth read its own footprint as
  // "something floating overhead" and shadowed ITSELF. `floating` is sky-reach
  // ONLY now: a genuinely different floor, whose art this floor never draws,
  // so darkening this pixel darkens real ground, never a caster's own surface
  // (docs/planning/Sun-Shadows-Rethink.md §4b). Overhead's own coverage still
  // marches normally through `coverage` below — only the zero-distance
  // self-check excludes it.
  let occlusion = clamp01(sampleField(x, y).floating ?? 0);

  const span = maxThrowPx({ maxCasterHeightPx, elevationDeg });
  if (span >= MIN_THROW_PX) {
    const elev = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
    const tanElev = Math.tan((elev * Math.PI) / 180);
    const dir = marchDirectionToSun(azimuthDeg);
    const n = Math.max(1, Math.floor(steps));
    const step = span / n;

    for (let i = 1; i <= n && occlusion < 1; i++) {
      const d = i * step;
      // The sun ray's height above the ground plane at this distance. A blocker
      // must be TALLER than this to be between the pixel and the sun.
      const rayHeight = d * tanElev;
      const at = sampleField(x + dir.x * d, y + dir.y * d);
      const coverage = clamp01(at.coverage ?? 0);
      if (coverage <= 0) continue;
      const over = (at.heightPx ?? 0) - rayHeight;
      if (over <= 0) continue;
      const feather = marchPenumbraPx({ distancePx: d, softnessMul });
      // The TIP fade only: a caster whose top is level with the ray casts
      // nothing, one clearly above it casts its full coverage. The silhouette's
      // softness comes from `coverage`, not from this curve.
      const t = feather > 0 ? Math.min(1, over / feather) : 1;
      const blocked = coverage * t * t * (3 - 2 * t);
      if (blocked > occlusion) occlusion = blocked; // MAX: the deepest blocker wins, once
    }
  }
  return 1 - clamp01(occlusion) * s;
}

/**
 * Resolve everything the GPU march needs to know about the sky, ONCE per bake.
 *
 * The shader takes these four numbers as a single uniform rather than deriving
 * them per texel — `tan()` and a normalised direction are constant across the
 * whole draw, and this is also what guarantees the CPU reference march
 * ({@link marchVisibility}) and the shader walk the SAME ray. Two derivations of
 * "where is the sun" is how V2 ended up with eight of them.
 *
 * TWO LENGTH CONTROLS (2026-07-24, author: *"the number one most important
 * control is going to be a single control for shadow offset at dawn / dusk. We
 * need to make the shadows a lot shorter, 1/2 of what it is right now."*). Both
 * act on the ONE tangent the whole march uses, so they cost nothing at bake
 * time and cannot disagree with each other:
 *
 *   - `lengthScale` scales EVERY shadow's throw (`length ∝ 1/tan`, so a shorter
 *     shadow is a STEEPER effective sun). Default 0.5 = half, at every hour.
 *   - `maxLengthMul` caps the throw at `maxLengthMul × the caster's own height`
 *     — a floor on the tangent, so it only bites at low sun. This is the
 *     dawn/dusk control: it stops the `1/tan → ∞` blow-up near the horizon
 *     without touching midday shadows at all.
 *
 * @param {object} args
 * @param {number} args.azimuthDeg
 * @param {number} args.elevationDeg
 * @param {number} args.maxCasterHeightPx
 * @param {number} [args.steps]
 * @param {number} [args.lengthScale=1] - global throw multiplier (<1 = shorter).
 * @param {number} [args.maxLengthMul=0] - throw cap as a multiple of caster
 *   height; 0/absent = uncapped (the pre-control behaviour).
 * @returns {{dirX:number, dirY:number, tanElev:number, stepPx:number, spanPx:number}}
 */
export function resolveSunMarch({
  azimuthDeg,
  elevationDeg,
  maxCasterHeightPx,
  steps = DEFAULT_MARCH_STEPS,
  lengthScale = 1,
  maxLengthMul = 0,
}) {
  const dir = marchDirectionToSun(azimuthDeg);
  const elev = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
  const realTan = Math.tan((elev * Math.PI) / 180);
  const scale = Number.isFinite(lengthScale) && lengthScale > 0 ? lengthScale : 1;
  // length ∝ 1/tan, so scaling the length by `scale` divides the tangent by it.
  const scaledTan = realTan / scale;
  // The dawn/dusk cap: a tangent floor. length = h/tan ≤ h·maxLengthMul ⇔
  // tan ≥ 1/maxLengthMul, applied to EVERY caster via its own per-texel height.
  const tanFloor = Number.isFinite(maxLengthMul) && maxLengthMul > 0 ? 1 / maxLengthMul : 0;
  const effTan = Math.max(scaledTan, tanFloor);
  const h = Number.isFinite(maxCasterHeightPx) && maxCasterHeightPx > 0 ? maxCasterHeightPx : 0;
  const HARD_CAP_PX = 8192; // the sanity ceiling maxThrowPx also uses
  const spanPx = h === 0 ? 0 : Math.min(HARD_CAP_PX, effTan > 1e-6 ? h / effTan : HARD_CAP_PX);
  const n = Math.max(1, Math.floor(steps));
  return { dirX: dir.x, dirY: dir.y, tanElev: effTan, stepPx: spanPx / n, spanPx };
}

/**
 * Should the shadow field be re-baked for this sun?
 *
 * A continuously-animated sun (the day clock) would otherwise turn "rebake when
 * the sun changes" into "rebake every frame", which is the cost model this whole
 * design exists to avoid. Quantising the sun means the bake happens a few times
 * a minute instead of sixty times a second, and the visual difference over half
 * a degree of azimuth is nil.
 *
 * Returns true when nothing has been baked yet (`last` null), so the first frame
 * always produces a field.
 *
 * @param {{azimuthDeg: number, elevationDeg: number}|null} last - the sun the current bake used.
 * @param {{azimuthDeg: number, elevationDeg: number}} next - this frame's sun.
 * @param {number} [quantizeDeg=0.5]
 * @returns {boolean}
 */
export function sunNeedsRebake(last, next, quantizeDeg = 0.5) {
  if (!last) return true;
  const q = Number.isFinite(quantizeDeg) && quantizeDeg > 0 ? quantizeDeg : 0.5;
  const dAz = Math.abs(angleDeltaDeg(next?.azimuthDeg ?? 0, last.azimuthDeg ?? 0));
  const dEl = Math.abs((next?.elevationDeg ?? 0) - (last.elevationDeg ?? 0));
  return dAz >= q || dEl >= q;
}

/**
 * Shortest signed angular difference in degrees, wrapped to (-180, 180] — so
 * 359° and 1° are 2° apart, not 358°. Without this a sun crossing north would
 * trigger a rebake storm.
 * @param {number} a @param {number} b @returns {number}
 */
export function angleDeltaDeg(a, b) {
  const d = (((((Number(a) || 0) - (Number(b) || 0)) % 360) + 540) % 360) - 180;
  return d;
}

/**
 * THE RECEIVER-GATE SHARPENING CURVE (author, live report: *"Building shadows
 * have a brighter area next to the actual building… the shadow should be
 * strongest next to the building and brighter as you move away."*).
 *
 * ROOT CAUSE, confirmed by reading the whole chain rather than guessed: the
 * receiver gate is the `_Outdoors` mask sampled at the coarse caster-field
 * resolution (≤512 texels a side, `vt/coarse-alpha.js`'s own cap) — meaning a
 * wall's true, crisp boundary is smeared across roughly one grid texel (tens
 * of world px) by the grid's own box-filtered downsample plus its LINEAR
 * texture filter. `vis = 1 - occlusion·strength·GATE·ramp` multiplies the
 * shadow by that same blurred value — so immediately outside a wall, where the
 * grid is still reading a PARTIAL "40% outdoor" texel, the shadow is
 * proportionally weakened, exactly where contact-hardening (this module's own
 * `marchPenumbraPx`) says it should be strongest. A bright halo hugging every
 * building is the visible result.
 *
 * The fix does not touch the mask (shared with the sky light's own doorway-
 * softness use, which legitimately wants that blur — Sky.md). It sharpens
 * ONLY how the SUN-SHADOW reads the SAME value: a `smoothstep` that treats
 * anything past {@link GATE_SHARPEN_HIGH} as fully outdoor (gate 1) and
 * anything below {@link GATE_SHARPEN_LOW} as still-indoors (gate 0, and
 * correctly so — nothing needs a cast shadow where the sun never reaches
 * anyway), collapsing the ambiguous middle band the coarse grid invents. This
 * is a contrast stretch on data that already exists, not a new mask, and not a
 * second, disagreeing copy of the shared gate (`buildOutdoorsGate`'s own
 * doctrine) — every OTHER consumer of `_Outdoors` is untouched.
 *
 * Applied in the GPU march (`sun-occlusion-render.js`), which is the ONE place
 * the sun-shadow reads the gate — point lights consume the marched FIELD, not
 * the gate, so there is no second reader to disagree with.
 */
export const GATE_SHARPEN_LOW = 0.12;
export const GATE_SHARPEN_HIGH = 0.35;

/** @param {number} e0 @param {number} e1 @param {number} x @returns {number} */
function smoothstep01(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Apply the sharpening curve to a raw 0..1 receiver-gate reading.
 * @param {number} rawGate01
 * @returns {number} 0..1.
 */
export function sharpenReceiverGate01(rawGate01) {
  return smoothstep01(GATE_SHARPEN_LOW, GATE_SHARPEN_HIGH, clamp01(rawGate01));
}

/**
 * THE MAP-EDGE RAMP (author, 2026-07-24: *"we need to address how these shadows
 * interact with the edge of the map to avoid producing a gap in the shadow as it
 * moves around the edge of the scene. I don't mind if we have a gradient at the
 * edge of the scene which prevents the shadow being offset"*).
 *
 * The gap is real and unfixable at its source: a caster standing just outside
 * the scene rect does not exist in any of our data, so the shadow it should
 * throw INTO the map cannot be computed. What we can control is what the
 * boundary looks like — and a shadow that simply stops at a straight line reads
 * as a bug, while one that fades out over a band reads as haze.
 *
 * Returns 1 well inside the map, easing to 0 at the border. Applied to the
 * shadow's STRENGTH (and, for vegetation, to the OFFSET as the author suggested,
 * which parks a shadow under its own plant rather than letting it slide off the
 * edge).
 *
 * @param {object} args
 * @param {number} args.x - world position.
 * @param {number} args.y
 * @param {{x: number, y: number, width: number, height: number}} args.rect - the scene rect.
 * @param {number} [args.bandPx=256] - how wide the ramp is.
 * @returns {number} 0..1.
 */
export function edgeRamp01({ x, y, rect, bandPx = 256 }) {
  if (!rect) return 1;
  const band = Number.isFinite(bandPx) && bandPx > 0 ? bandPx : 0;
  if (band === 0) return 1;
  const dx = Math.min(x - rect.x, rect.x + rect.width - x);
  const dy = Math.min(y - rect.y, rect.y + rect.height - y);
  const d = Math.min(dx, dy);
  if (d <= 0) return 0;
  if (d >= band) return 1;
  const t = d / band;
  return t * t * (3 - 2 * t);
}
