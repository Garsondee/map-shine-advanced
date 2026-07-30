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
 * How many samples the march spreads PERPENDICULAR to the sun at each station —
 * what turns the ray into a thin cone and lets a silhouette's SIDE edges soften
 * with distance (`sun-occlusion-render.js`'s own "LATERAL SOFTENING" note has
 * the physics). Fixed at shader-BUILD time, like the step count: the loop is
 * unrolled either way, so this is a cost decision, never a live-tunable knob.
 */
export const DEFAULT_LATERAL_TAPS = 3;

// ===========================================================================
// THE PERFORMANCE LADDER — how MUCH sun shadow, per profile
// ===========================================================================
//
// `sun-shadows.js`'s manifest declares WHICH profile buys which rung in prose;
// this is the same ladder as arithmetic, index-aligned, and it lives HERE (the
// pure module) rather than in the subsystem for the reason `vegetationTierPlan`
// and `candleTierPlan` do: a rung table nothing can assert is a rung table that
// drifts. Three of these four numbers are shader-BUILD-time or allocation-time
// decisions, so they are exactly the kind of thing that silently stops matching
// its own documentation.
//
// ⚠️ WHY THE BAKE IS THE ONLY THING THAT MOVES. The PER-FRAME cost of this
// effect is one texture fetch in the ambient fill plus one per point light, and
// that is the same single fetch at every rung — a 1280² field is not a more
// expensive read than a 512² one. What the ladder actually buys and sells is
// the BAKE, which runs a few times a minute (`sunNeedsRebake`) and costs
// `fieldDim² × marchSteps × lateralTaps` texture samples. That product is what
// {@link sunShadowBakeSamples} reports, and it is the only honest cost figure
// this system has: the bakes have never fired inside a profiling window, so
// there is no measured millisecond number for any rung (Performance-Insights.md
// — "Bake costs are still unmeasured"), and inventing one here would be exactly
// the instrument that lies.
//
// The four axes, and what each is actually for:
//   fieldDim     — the marched field's resolution. Buys a smoother PENUMBRA
//                  RAMP, NOT a crisper contact edge: the silhouette comes from
//                  the caster grid, which `scene/mask-derive.js` caps at 512 a
//                  side, so past ~1024 this is resolving the soft gradient
//                  rather than finding new detail. Costs quadratically, which
//                  is why it climbs the least.
//   marchSteps   — samples along the ray. Fewer missed thin casters and a finer
//                  tip fade, over the SAME distance (`marchStepPx` derives the
//                  step from the span, so this is quality, never reach).
//   lateralTaps  — the width of the cone. THE axis the author actually notices
//                  ("the edges of a building shadow are currently pixel perfect
//                  lines… blur the shadow to make it more diffuse the further
//                  away from the building"), and the only one that can soften a
//                  silhouette the coarse caster grid cannot describe.
//   quantizeDeg  — how far the sun must move before re-marching. Smaller = the
//                  shadow sweeps instead of stepping, and MORE bakes — so it
//                  multiplies the per-bake cost above rather than adding to it.

/**
 * The rung an ABSENT or malformed tier falls back to — deliberately TODAY'S
 * shipped look (1024² / 24 steps / 3 taps / 0.5°), never the cheapest rung and
 * never the dearest. Both alternatives are dangerous in opposite directions:
 * falling back to 0 would silently coarsen every existing scene the moment an
 * unwired caller touched it, and falling back to the top would hand a weak
 * machine a 5×-costlier bake it never asked for.
 *
 * NOT a hardcoded 1 in spirit, only in value: `effect-tier.test.mjs` asserts
 * this equals what the DEFAULT performance profile resolves the real
 * `SUN_SHADOWS` ladder to, so re-tuning a rung's `fromProfile` cannot leave this
 * constant pointing at a different look than the ladder does.
 */
export const SUN_SHADOW_DEFAULT_TIER = 1;

/**
 * The rungs, as data, index === tier. Kept beside {@link sunShadowTierPlan} so
 * the table and its clamp cannot disagree about how many rungs exist.
 *
 * Tier 0 is the coarse pin — a REAL shadow, in the right place, at the cheapest
 * march this system draws (Effects.md Law 1: tier 0 is the admission price, not
 * a step). It is what a player who forces the effect ON below the `performance`
 * profile gets, which is why it is a working shadow rather than nothing: "I
 * turned it on and nothing happened" is not a tier, it is a bug report. WHETHER
 * the effect runs at all is the profile GATE's question
 * (`SUN_SHADOWS.enabledFromProfile`), answered one layer up.
 */
const SUN_SHADOW_TIER_PLANS = Object.freeze([
  // 0 coarse-march — 1:1 with the caster grid, a single ray, half the bakes.
  //   ~4.2M samples: 1/18th of today's bake.
  Object.freeze({ fieldDim: 512, marchSteps: 16, lateralTaps: 1, quantizeDeg: 1, casterGridDim: 512 }),
  // 1 soft-cone — TODAY, EXACTLY. ~75.5M samples.
  Object.freeze({
    fieldDim: 1024,
    marchSteps: 24,
    lateralTaps: DEFAULT_LATERAL_TAPS,
    quantizeDeg: 0.5,
    casterGridDim: 512,
  }),
  // 2 wide-cone — a 5-tap cone and a finer tip fade. ~147M samples, ~1.9× today.
  //   casterGridDim 768 (2.25× the shared grid's texel COUNT) is the first rung
  //   that buys a genuinely crisper SILHOUETTE, not just a smoother penumbra —
  //   see casterGridDim's own doc below for why fieldDim alone never could.
  Object.freeze({ fieldDim: 1024, marchSteps: 28, lateralTaps: 5, quantizeDeg: 0.5, casterGridDim: 768 }),
  // 3 fine-cone — the widest cone this system draws, over a supersampled field,
  //   sweeping rather than stepping. ~367M samples, ~4.9× today. The ceiling is
  //   deliberate: a bake is a HITCH, not a frame cost, so the top rung is
  //   bounded by what a player will tolerate as a stutter a few times a minute.
  Object.freeze({ fieldDim: 1280, marchSteps: 32, lateralTaps: 7, quantizeDeg: 0.4, casterGridDim: 1024 }),
]);

/**
 * ⚠️ `casterGridDim` IS A DIFFERENT AXIS FROM `fieldDim`, ANSWERING A DIFFERENT
 * QUESTION (found live, 2026-07-30 — author, on the `extreme` preset: *"shadows
 * are still very low resolution... I asked for shadows to have different
 * resolutions based on the graphics tier."*). `fieldDim` sizes the MARCH's own
 * OUTPUT — a smoother penumbra ramp over whatever silhouette it is given, never
 * a crisper one (this file's own tier-ladder header already said so: "past
 * ~1024 this is resolving the soft gradient rather than finding new detail").
 * The SILHOUETTE itself comes from a wholly different, upstream input: the
 * coarse caster grid `scene/mask-derive.js#deriveFloorProducts` rasterizes art
 * INTO, hard-capped at `MASK_GRID_MAX_DIM` (512) because that grid is SHARED
 * with water/specular/coarse-alpha and was never meant to resolve fine
 * architectural detail (crenellations, thin trim) at battlemap scale. Raising
 * `fieldDim` alone — which is all the ladder did before this axis existed —
 * cannot touch that ceiling; it just upsamples the same blocky silhouette more
 * smoothly. `casterGridDim` sizes a SECOND, sun-shadow-ONLY grid, independent
 * of the shared one (`mask-derive.js#deriveFloorProducts`'s own `casterGridSpec`
 * param), so raising it here costs nothing extra for water/specular/wind and
 * cannot destabilize their own 512-tuned budgets. Tiers 0-1 stay at the shared
 * 512 deliberately — tier 1 must still reproduce today's exact shipped look,
 * which today's silhouette comes from the shared grid.
 */

/**
 * Resolve a rung into the numbers the bake is built from. PURE + TOTAL: a
 * stale, absent or wildly out-of-range tier clamps into the ladder rather than
 * returning `undefined` and building a field of `NaN`.
 *
 * @param {number} tier - a resolved rung (effect-cascade.js#resolveEffectTier).
 * @returns {{fieldDim: number, marchSteps: number, lateralTaps: number, quantizeDeg: number, casterGridDim: number}}
 */
export function sunShadowTierPlan(tier) {
  const n = Number.isFinite(tier)
    ? Math.max(0, Math.min(SUN_SHADOW_TIER_PLANS.length - 1, Math.floor(tier)))
    : SUN_SHADOW_DEFAULT_TIER;
  return SUN_SHADOW_TIER_PLANS[n];
}

/** How many rungs the ladder has (so a status report can say "1 of 3"). */
export const SUN_SHADOW_MAX_TIER = SUN_SHADOW_TIER_PLANS.length - 1;

/**
 * Texture samples ONE bake of this plan costs — `fieldDim² × marchSteps ×
 * lateralTaps`, the whole cost model of this effect in one number.
 *
 * Reported rather than converted to milliseconds ON PURPOSE. It is a count, and
 * counts are true on every GPU; a millisecond figure derived from it would be a
 * guess dressed as a measurement, and this system's bakes have never once fired
 * inside a profiling window (memory: feedback_instruments_must_not_lie). Ratio
 * it against another rung's and the answer IS meaningful — that is the reading
 * this number is for.
 *
 * @param {{fieldDim: number, marchSteps: number, lateralTaps: number}} plan
 * @returns {number}
 */
export function sunShadowBakeSamples(plan) {
  const dim = Number.isFinite(plan?.fieldDim) && plan.fieldDim > 0 ? plan.fieldDim : 0;
  const steps = Number.isFinite(plan?.marchSteps) && plan.marchSteps > 0 ? plan.marchSteps : 0;
  const taps = Number.isFinite(plan?.lateralTaps) && plan.lateralTaps > 0 ? plan.lateralTaps : 0;
  return dim * dim * steps * taps;
}

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
 * ============================================================================
 * ROUND SEVEN (2026-07-30) — BUILDINGS ARE COLUMNS; EVERYTHING ELSE IS A SLAB
 * ============================================================================
 *
 * Every round before this one modelled EVERY caster the same way: a solid
 * COLUMN standing on the ground, height h, blocking the ray for every distance
 * where `d·tanElev < h`. That is exactly what a building is — a wall really
 * does occupy every height from 0 to its own top. It is NOT what an overhead
 * tile or a sky-reach structure is: a lamp bracket, a balcony floor, a bridge
 * deck are THIN, ELEVATED things, occupying a narrow band of height around
 * wherever they actually sit, with open air both above and below.
 *
 * Modelling them as columns anyway produced a shadow measured, with the
 * author's own real numbers (a 570px-elevation lamp bracket, sun at 57°), to
 * be a SOLID SMEAR 184px long and fully opaque for all but its last ~9px —
 * fourteen times longer than the true, physically correct shadow (a ~13px
 * translated band, offset ~171px from the bracket). That length is exactly
 * "much darker, much larger than they deserve to be" (author, live) — the
 * bracket's own THINNESS was never represented; only its (correct) height was.
 *
 * THE MODEL, per producer type:
 *
 *   BUILDING (column) — unchanged physics. A blocker at buildingHeightPx
 *   blocks every distance where the ray hasn't yet risen above it:
 *     over = buildingHeightPx − max(d·tanElev, receiverBuildingHeight)
 *   `receiverBuildingHeight` is Round Six's unconditional floor (a receiver
 *   who is ALSO indoors cannot be shadowed by something no taller than the
 *   building it is already inside).
 *
 *   FLOATING (band) — overhead + sky-reach. A thin thing AT height h blocks
 *   only near the ONE distance where the ray's own height crosses h — the
 *   width of "near" is the SAME feather that already contact-hardens the
 *   column case, so there is no second softness knob:
 *     over = feather − |stationFloatingHeight − d·tanElev|
 *   gated by a SMOOTH "must be taller than the receiver's own floating height"
 *   term (Round Six's insight, generalised): a receiver standing ON a floating
 *   slab cannot be shadowed by ANY part of that SAME slab, because no part of
 *   a uniform-height object is taller than itself. This is what makes a wide
 *   canopy immune to self-shadow without an identity test, and immune to the
 *   linear-filter bleed ghost (Round Five's failure) for the same reason
 *   Round Six was: the ghost reads roughly HALF the real height, and half is
 *   never taller than whole.
 *
 * WHY THE BAND NEEDS NO AUTHORED THICKNESS. The band's WIDTH comes entirely
 * from `feather`, which already grows with distance — a dusk sun (long march,
 * wide feather) softens and can dissolve a thin caster's shadow on its own;
 * a noon sun (short march, narrow feather) keeps it crisp. That is the
 * "buildings reliably dark, small things soften and vanish at distance"
 * behaviour asked for, falling out of the ONE existing softness curve rather
 * than a second, per-item authored size nobody would paint correctly anyway.
 *
 * WHY "DARK UNDER A WIDE BRIDGE" SURVIVES UNTOUCHED. That guarantee has never
 * come from the column/band choice at all — it is the `d = 0` seed below,
 * asking "is something directly overhead, right here" before the march even
 * starts. A bridge spanning half the map is dark under its own footprint via
 * that seed regardless of this section; the band model only changes how FAR
 * its shadow reaches BEYOND its own edge, which is exactly the "smaller,
 * less noticeable, never absent" outcome asked for.
 *
 * @param {object} args
 * @param {number} args.x - world position, +y down (Foundry canvas space).
 * @param {number} args.y
 * @param {(x: number, y: number) => {
 *   buildingCoverage?: number,
 *   floatingHeightPx?: number,
 *   floatingCoverage?: number,
 *   skyReachCoverage?: number,
 * }} args.sampleField - the caster field at a world point, split by PHYSICAL
 *   MODEL rather than by producer identity:
 *     `buildingCoverage` (0..1) — indoors-ness; drives the COLUMN test at the
 *       uniform `buildingHeightPx` below. There is no per-texel building
 *       height — a building's height is one scene-wide number, never derived
 *       per pixel (unlike overhead/sky-reach, whose height genuinely varies
 *       item to item).
 *     `floatingHeightPx` — this texel's own overhead-∪-sky-reach height
 *       (world px above this floor). Drives the BAND test.
 *     `floatingCoverage` (0..1) — overhead-∪-sky-reach coverage; how dark the
 *       band's contribution is, away from d = 0.
 *     `skyReachCoverage` (0..1) — sky-reach ALONE, narrower than
 *       `floatingCoverage`: see the `d = 0` note below for why this floor's
 *       own overhead items must never appear here.
 *   Out-of-bounds / absent reads as zero for every field.
 * @param {number} args.azimuthDeg - the sun's compass azimuth.
 * @param {number} args.elevationDeg - the sun's elevation above the horizon.
 * @param {number} args.maxCasterHeightPx - the field's tallest caster of
 *   EITHER kind (sizes the march span so it reaches the longest possible
 *   shadow from either model).
 * @param {number} [args.buildingHeightPx=0] - the scene-wide building height
 *   (0 = no buildings active this bake — the column term compiles to a no-op).
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
  buildingHeightPx = 0,
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
  // Over-widened: `skyReachCoverage` is narrower than `floatingCoverage` on
  // purpose — an OVERHEAD item lives on THIS SAME floor — Foundry elevation is
  // a draw-order key, not a spatial offset, so a raised tile's own sprite
  // occupies the IDENTICAL (x,y) as whatever it would "shade" beneath it.
  // There is no separate, visible ground there to darken — only the item's
  // own opaque art — so a balcony or a lantern-on-a-plinth read its own
  // footprint as "something floating overhead" and shadowed ITSELF. Sky-reach
  // is a genuinely different floor, whose art this floor never draws, so
  // darkening this pixel darkens real ground, never a caster's own surface
  // (docs/planning/Sun-Shadows-Rethink.md §4b). Overhead's own coverage still
  // marches normally through `floatingCoverage` below — only the
  // zero-distance self-check excludes it.
  const here0 = sampleField(x, y);
  let occlusion = clamp01(here0.skyReachCoverage ?? 0);

  // THE RECEIVER'S OWN STATE — read once, used by both sub-tests' self-guards.
  //
  // ⚠️ ROUND TWO (2026-07-28, author: building AND overhead shadows both
  // render on top of the overhead tile producing them) is WHY either of these
  // exists at all — see the identical comment in sun-occlusion-render.js, the
  // GPU transcription of this exact function. `occlusion`'s own d=0 seed above
  // only ever excluded `skyReachCoverage` at the exact starting point; nothing
  // else was excluded at ANY station, so a caster wider than a few march steps
  // read its own body again a few steps in and shadowed its own downstream
  // half out to its own natural throw distance. A later station only counts
  // as a genuinely NEW blocker if it exceeds THIS pixel's OWN state at d=0,
  // not just the ray height — open ground (both readings 0) is unaffected,
  // `Math.max(rayHeight, 0) === rayHeight`.
  //
  // ⚠️ ROUND SIX (2026-07-30), GENERALISED BY ROUND SEVEN into two floors, one
  // per physical model, applied as an UNCONDITIONAL bound at every station. No
  // confidence test, no scaling: see the self-shadow guard's own header
  // further down for why two successive attempts to decide "is that station
  // really part of me" both failed on the linear-filter bleed ghost, and why
  // the plain comparison never needed to ask.
  //
  // `buildingCoverage` is read as a BINARY (matching the exterior-gate's own
  // precedent, mask-derive.js#OVERHEAD_EXTERIOR_THRESHOLD): "indoors" is a
  // classification, not a continuous quantity, so there is no partial
  // building-floor to speak of.
  const receiverBuildingHeight = clamp01(here0.buildingCoverage ?? 0) >= 0.5 ? buildingHeightPx : 0;
  const receiverFloatingHeight = here0.floatingHeightPx ?? 0;

  const span = maxThrowPx({ maxCasterHeightPx, elevationDeg });
  if (span >= MIN_THROW_PX) {
    const elev = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
    const tanElev = Math.tan((elev * Math.PI) / 180);
    const dir = marchDirectionToSun(azimuthDeg);
    const n = Math.max(1, Math.floor(steps));
    const step = span / n;

    for (let i = 1; i <= n && occlusion < 1; i++) {
      const d = i * step;
      const at = sampleField(x + dir.x * d, y + dir.y * d);
      const buildingCoverage = clamp01(at.buildingCoverage ?? 0);
      const floatingCoverage = clamp01(at.floatingCoverage ?? 0);
      if (buildingCoverage <= 0 && floatingCoverage <= 0) continue;

      const rayHeight = d * tanElev;
      const feather = marchPenumbraPx({ distancePx: d, softnessMul });

      // ⚠️ THE MARCH'S OWN RESOLUTION FLOORS EVERY FEATHER (measured, live
      // numbers: a dawn/dusk-shortened sun — `lengthScale`/`maxLengthMul`
      // steepen the EFFECTIVE elevation well past the real one — combined
      // with a thin overhead caster produced a shadow that vanished into the
      // cracks between march stations almost everywhere, not merely a
      // discretisation ripple: `crossingOver` needs `stationHeight` within one
      // `feather` of `d·tanElev`, but between two consecutive stations the ray
      // climbs by `step·tanElev`, and here that was ~33px against a feather of
      // ~8px — the true crossing sat in the gap between samples far more often
      // than it landed near one).
      //
      // PROOF the floor is sufficient, not just plausible: if the true
      // crossing sits at distance d* between stations at d and d+step, the two
      // stations' height-gaps to the ray are |d*−d|·tanElev and
      // |d*−(d+step)|·tanElev, and those two distances along the ray sum to
      // exactly `step`— so the SMALLER of the two gaps can never exceed half of
      // `step·tanElev`. Flooring the tolerance at the full `step·tanElev`
      // therefore guarantees at least one of the two bracketing stations
      // registers the crossing, every time. Harmless wherever the march is
      // already fine relative to the sun angle: `feather` already exceeds this
      // floor there, so `Math.max` is a no-op (every existing clean-geometry
      // test in this module's suite sits in that regime, unaffected).
      //
      // Applied to BOTH sub-tests below, not just the floating one — the same
      // gap can turn a building's own TIP fade into a hard cliff instead of a
      // smooth one when the march is coarse relative to the sun angle, and
      // it's the identical resolution limit either way.
      const marchFeather = Math.max(feather, step * tanElev);

      // ---- BUILDING: COLUMN physics, unchanged since Round Six. -----------
      // A blocker occupies EVERY height from 0 up to buildingHeightPx, so it
      // blocks for every distance where the ray — floored at the receiver's
      // own building height, so a building cannot shadow its own interior —
      // hasn't yet climbed above it.
      let buildingBlocked = 0;
      if (buildingCoverage > 0 && buildingHeightPx > 0) {
        const buildingOver = buildingHeightPx - Math.max(rayHeight, receiverBuildingHeight);
        if (buildingOver > 0) {
          const t = marchFeather > 0 ? Math.min(1, buildingOver / marchFeather) : 1;
          buildingBlocked = buildingCoverage * t * t * (3 - 2 * t);
        }
      }

      // ---- FLOATING: BAND physics (Round Seven). ---------------------------
      // A thin caster occupies only a narrow band AT its own height, so it
      // blocks only near the ONE distance where the ray's height crosses that
      // band — not everywhere beneath it, the way a column does. `heightGate`
      // is what keeps a wide slab from shadowing itself: nothing at the SAME
      // height as the receiver's own floating surface is taller than it, so no
      // part of a uniform canopy can ever count as "a new blocker" for a
      // receiver standing on that same canopy — the bleed-ghost immunity
      // Round Six found, generalised past a single unconditional floor.
      let floatingBlocked = 0;
      const stationFloatingHeight = at.floatingHeightPx ?? 0;
      if (floatingCoverage > 0 && stationFloatingHeight > 0 && marchFeather > 0) {
        const heightGate = smoothstep01(0, marchFeather, stationFloatingHeight - receiverFloatingHeight);
        if (heightGate > 0) {
          const crossingOver = marchFeather - Math.abs(stationFloatingHeight - rayHeight);
          if (crossingOver > 0) {
            const t = Math.min(1, crossingOver / marchFeather);
            floatingBlocked = floatingCoverage * heightGate * t * t * (3 - 2 * t);
          }
        }
      }

      const blocked = Math.max(buildingBlocked, floatingBlocked);
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
 * ============================================================================
 * THE SELF-SHADOW GUARD — ONE PHYSICAL RULE, NO CONFIDENCE HEURISTICS
 * (2026-07-30, ROUND SIX — and the round that finally MEASURED instead of
 * reasoning. Rounds four and five each invented a "is this station really
 * part of me" confidence test; a CPU-twin simulation of the author's own
 * wall-mounted lamp, with the real reported sun/grid numbers, showed both
 * were wrong in opposite directions and the truth needed neither.)
 * ============================================================================
 *
 * THE RULE: **you cannot be shadowed by something that is not taller than you
 * are.** That is not a heuristic, an approximation, or a tuned threshold — it
 * is what "in shadow" means. A receiver standing on a 570px balcony is lit by
 * any sun ray that clears 570px, whatever else the field happens to contain
 * at that height or below it. So the ray's height at each station is floored
 * by the RECEIVER's own height, unconditionally:
 *
 *     over = stationHeight − max(rayHeight, receiverHeight)
 *
 * WHAT THIS REPLACED, AND WHY BOTH ATTEMPTS FAILED. The problem both rounds
 * were circling is real: the caster texture is deliberately LINEAR-filtered
 * (a silhouette edge must read as a ramp — `bakeCasterTexture`'s own header),
 * so one texel outside any caster there is a BLED reading: a smeared,
 * half-height, half-coverage GHOST of that caster. It is not a separate
 * object; it is the same object, blurred. Every attempt to identify "self" by
 * measuring a CONFIDENCE and then scaling the floor by it got eaten by that
 * ghost:
 *
 *   ROUND FOUR scaled the floor by the RECEIVER'S COVERAGE, reasoning that a
 *   receiver truly inside a caster reads coverage ≈1. False for overhead and
 *   sky-reach casters, whose coverage IS the art's own alpha
 *   (`compositeItemMax(coverOverhead, item.alpha, …)`, mask-derive.js): a
 *   greenhouse roof's semi-transparent window pane reads 0.4 and was demoted
 *   to "not really self", so the roof's own opaque metal frame shadowed its
 *   own glass — dark where the art is transparent, absent where it is opaque.
 *   Exactly backwards, and reported live.
 *
 *   ROUND FIVE replaced coverage with a HEIGHT-MATCH (does this station read
 *   the same height as me?), which fixes the greenhouse — but the bleed ghost
 *   reads HALF the caster's height, so the match says "different object", the
 *   floor drops to zero, and the ghost casts a real shadow back onto the very
 *   caster that produced it. Measured: the lamp's own body sat at 63% darkness
 *   while the ground beyond it sat at 100%, which is precisely the "lighter at
 *   the end where the shadow is generated" the author reported twice.
 *
 * THE UNCONDITIONAL FLOOR IS IMMUNE TO THE GHOST BY CONSTRUCTION, because it
 * never asks what the station IS. The ghost is half the caster's height, and
 * half is not taller than whole, so it cannot shadow the caster — no identity
 * test required. Walk the same cases:
 *
 *   lamp body (570) vs its own bleed ghost (285)  → 285 − 570 < 0, no shadow ✓
 *   greenhouse glass (300) vs own frame (300)     → 300 − 300 = 0,  no shadow ✓
 *   open ground (0) vs the lamp (570)             → 570 − ray,      shadow   ✓
 *   low item (50) vs a taller neighbour (500)     → 500 − 50,       shadow   ✓
 *   bleed ring (285) vs the solid wall (570)      → 570 − 285,      shadow   ✓
 *
 * That last row is round four's original complaint (a gap between a building
 * and its own shadow) and it survives: the floor merely REDUCES `over` there
 * from 570 to 285, and 285 still vastly exceeds the feather, so the contact
 * point stays fully dark. The gap round four was chasing came from scaling the
 * floor, not from having one.
 *
 * ⚠️ DO NOT REINTRODUCE A CONFIDENCE TEST HERE. Three rounds now have tried to
 * decide "is this me?" from a blurred field that cannot answer it. The height
 * comparison never needed to know.
 */

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
