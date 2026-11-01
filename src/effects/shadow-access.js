/**
 * THE SHADOW HANDLE — one object every shadow CASTER receives, so the sky is
 * described once and nobody re-derives it.
 *
 * ============================================================================
 * WHY THIS EXISTS (the V2 disease it is aimed at, named by the author)
 * ============================================================================
 *
 * Author, 2026-07-23, on adding shadows to vegetation: *"the old V2 had a
 * separate slider for every different aspect of scene shadows and we don't need
 * that, only different offsets and the ability to simulate different heights
 * from the ground (which will have a separate impact on shadow sharpness)."*
 *
 * That is the whole design brief, and it is a STRUCTURAL statement, not a
 * preference about UI clutter. V2 gave each shadow system its own softness
 * slider, its own offset slider, its own strength slider — so nothing in the
 * scene agreed about where the sun was, and every new caster added three more
 * knobs that could disagree with the other thirty. The cure is the same shape
 * as `world/wind-access.js`'s: the SKY is described ONCE, in one place, and a
 * caster contributes only what is genuinely its own.
 *
 * A caster therefore declares exactly TWO things:
 *
 *   heightPx    — how far above the ground it sits. Drives the offset length
 *                 AND the penumbra, both, automatically. A tree is tall (long,
 *                 soft shadow); a bush is short (tight, crisp one). ONE honest
 *                 physical property, TWO derived behaviours — this is precisely
 *                 what replaces V2's separate offset and softness sliders.
 *   offsetScale — a cosmetic "throw it further" multiplier that deliberately
 *                 does NOT touch softness (see `projectShadowOffset`'s own
 *                 param doc — the decoupling already exists there).
 *
 * Everything else — direction, dawn/dusk elongation, cloud softening, night
 * fading — is atmospheric, derived here, and SHARED by every caster. A future
 * caster (a token, a wall, a structure) adds ZERO new sliders.
 *
 * ============================================================================
 * WHAT WAS ALREADY BUILT, AND IS DELIBERATELY NOT REBUILT HERE
 * ============================================================================
 *
 * `lighting/light-visibility.js` already owns the projection geometry, already
 * Node-tested, built for the UI-shadow:
 *
 *   projectShadowOffset  →  height / tan(elevation)   — the throw
 *   shadowPenumbraPx     →  base + height × (heightFactor + grazing × …)
 *
 * Both are ALREADY driven by height + sun elevation, which is exactly the model
 * the brief above asks for. So two of the four atmospheric behaviours the
 * author described are not implemented in this file at all — they are EMERGENT
 * from feeding a real sun into maths that already handles it:
 *
 *   "the angle changes with the sun"        → `shadowOffsetDirection(azimuth)`
 *   "elongates at dawn and dusk"            → `height / tan(elevation)`; as the
 *                                             sun nears the horizon tan → 0 and
 *                                             the throw grows without bound
 *                                             (clamped by `maxOffsetPx`).
 *
 * Recording that as a FINDING matters more than the code saved: the temptation
 * was to write a "dawn elongation" term, which would have been a second,
 * disagreeing model layered over a correct one — the exact V2 failure mode.
 *
 * THE GENUINELY NEW PART is {@link shadowAtmosphere} below: cloud cover and
 * day/night, which nothing modelled before.
 *
 * ============================================================================
 * ⚠ THE INPUTS EXIST BUT ARE NOT YET LIVE-SOURCED — stated plainly
 * ============================================================================
 *
 * `world/environment.js#buildEnvSnapshot` already computes and carries
 * everything this file needs (`sun.elevationDeg/azimuthDeg/dayFactor01`,
 * `weather.cloudCover01`, `darkness01`). But as of 2026-07-23 the viewer's own
 * `updateEnvSnapshot` has no calendar to read (its own comment says so) and no
 * weather owner at all. So in a live scene this handle produces a CORRECT
 * shadow for the inputs it is given, and those inputs are currently a fixed
 * noon under a clear sky, until a real source lands.
 *
 * That is why the debug overrides (`MapShine.setSunHour`/`setCloudCover`) ship
 * alongside this: an atmospheric model nobody can SEE working is a model nobody
 * can trust, and this project has a standing rule about instruments that cannot
 * measure what they claim (`feedback_instruments_must_not_lie`). The overrides
 * are labelled as debug levers in the env report, never as a calendar.
 *
 * NOT MIGRATED — the UI-shadow. It reads `DEFAULT_WORKSPACE_LIGHT`, a fixed
 * decorative key, ON PURPOSE (that constant's own doc: tying UI chrome to
 * `env.sun` would make character-sheet shadows vanish at noon and rake at
 * dusk — "reads as a bug, not a feature"). Different light, correctly a
 * different system. Sharing the projection maths without sharing the SKY is the
 * right seam, and it already is the seam.
 *
 * @module effects/shadow-access
 */

import { shadowPenumbraPx, shadowOffsetDirection, clamp01 } from './lighting/light-visibility.js';
import { layerThrowPx, softShadowCeilingPx } from './lighting/layer-smear.js';

/**
 * How much overcast softens a shadow's edge. At full cloud the penumbra is
 * (1 + this) × its clear-sky value — a heavily diffused sky turns a crisp edge
 * into a broad smudge. Tuned by eye, same posture as every other look constant
 * in this codebase.
 */
export const CLOUD_SOFTEN = 3.0;

/**
 * How much overcast FADES a shadow. At full cloud only this fraction of the
 * clear-sky strength survives — under a properly overcast sky there is barely a
 * shadow at all, which is the real-world observation the author is after
 * ("softer as cloud increases"). Not zero: even overcast leaves a faint
 * ambient-occlusion-ish darkening under a dense canopy.
 */
export const CLOUD_SURVIVING_STRENGTH = 0.15;

/**
 * The floor a SUN shadow fades to at full night: none.
 *
 * ⚠️ WAS 0.12 UNTIL 2026-11-01 (the shadow consistency pass, author: "the goal is
 * consistency of visual appearance between all shadow producers"). The residual
 * was meant as moonlight/skyglow, but it was a SUN shadow — thrown at full
 * dawn/dusk length along the azimuth of a sun already below the horizon — while
 * the cloud shadow (which keys off the sky's own key light) went to exactly 0, so
 * buildings and trees still cast a faint sunset-direction shadow all night and the
 * clouds did not. Measured on the shadow bench: 11–16% at 18:06, after sunset.
 * The fade still never snaps: `shadowAtmosphere`'s disc ramp eases across 3° of
 * elevation. Moonlight is added AFTER every sun shadow (`environmental-light.js`'s
 * `uMoonAdd`), so a moon shadow, if one is ever wanted, is its own light's term.
 */
export const NIGHT_SURVIVING_STRENGTH = 0;

/**
 * ============================================================================
 * THE SHARED SHADOW LOOK (2026-11-01, the shadow consistency pass)
 * ============================================================================
 *
 * Every producer — buildings, overhead tiles and storeys above (the sun bake),
 * clouds, trees, bushes, ropes, flies, falling leaves, smoke — takes its
 * DARKNESS and its LENGTH from here, so one shadow never disagrees with the next
 * about how strong the sun is or how far it throws.
 *
 * THE REFERENCE IS THE BUILDING SHADOW. Every one of its look numbers is the
 * author's own live-tuned value: core 0.665 ("make the shadow 30% less strong",
 * 2026-10-16), strength 0.85 (2026-08-02, River Town Bridge), length ×0.5 ("make
 * the shadows a lot shorter, 1/2 of what it is"), the dawn/dusk cap 4 ("the number
 * one most important" control, 2026-07-24), and the golden-hour gains ("very strong
 * and very long at the golden hour", 2026-10-27). Before this pass the other
 * producers each had their own: trees cast at strength 1.0 (measured 0.97 —
 * black — at noon against the building's 0.34), with a softer throw cap (2.5×
 * height, soft knee) and their OWN copy of the golden gains; ropes 0.6, flies
 * 0.15, leaves 0.2 of the ambient level, smoke a fixed down-right offset.
 *
 * So the building's Sun Shadows card IS the shadow look: its sliders arrive here
 * as `look` (`createShadowHandle`'s spec), and a producer contributes only its own
 * HEIGHT (how far it throws) and OPACITY (how much of the sun it blocks — a tree
 * canopy and a wall both 1, a thin rope or a fly less).
 */
export const SHADOW_CORE_STRENGTH = 0.665;
/** Golden hour: up to ×1.6 darker at the bell's peak, capped at the ceiling below.
 * (Moved here from the building bake and the vegetation subsystem, which each carried
 * the same three.) 0.45 → 0.6 on 2026-11-01: the bake's layers now UNION instead of
 * each applying the darkness again (`layer-smear.js#layerSmearVisibility`), which on its
 * own would have lightened golden-hour buildings from the 0.87–0.90 the author has been
 * looking at to ~0.72; at 0.6 every producer reaches ~0.82 at the golden peak — the
 * author's "very strong and very long at the golden hour", for trees as well as walls. */
export const GOLDEN_SHADOW_STRENGTH_GAIN = 0.6;
export const GOLDEN_SHADOW_STRENGTH_CEIL = 0.97;
/** Golden hour: up to ×2 longer at the bell's peak — on the length scale AND the cap. */
export const GOLDEN_SHADOW_LENGTH_GAIN = 1;

/** The Sun Shadows card's own defaults (`effects/sun-shadows.js`), for a handle built without one. */
export const DEFAULT_SHADOW_LOOK = Object.freeze({
  strength01: 0.85,
  lengthScale: 0.5,
  dawnDuskLength: 4,
  softnessBias: 0.25,
  longestShadowSquares: 10,
});

/**
 * The scene's longest shadow in world px: the card's "Longest shadow" (grid squares) × the grid.
 * See `layer-smear.js#softShadowCeilingPx` for the rule every producer's throw eases into.
 * @param {object} [look] @param {number} [gridSizePx] - px per grid square; invalid → 100.
 * @returns {number} px, > 0.
 */
export function longestShadowPx(look, gridSizePx) {
  const g = Number.isFinite(gridSizePx) && gridSizePx > 0 ? gridSizePx : 100;
  return resolveShadowLook(look).longestShadowSquares * g;
}

/**
 * The look with every value made finite (a missing or junk slider falls back to its default).
 * @param {object} [look]
 * @returns {Readonly<{strength01:number, lengthScale:number, dawnDuskLength:number, softnessBias:number,
 *   longestShadowSquares:number}>}
 */
export function resolveShadowLook(look) {
  const pick = (k, lo, hi) => {
    const v = Number(look?.[k]);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_SHADOW_LOOK[k];
  };
  return Object.freeze({
    strength01: pick('strength01', 0, 1),
    lengthScale: pick('lengthScale', 0.05, 4),
    dawnDuskLength: pick('dawnDuskLength', 0.5, 12),
    softnessBias: pick('softnessBias', 0.05, 4),
    longestShadowSquares: pick('longestShadowSquares', 1, 60),
  });
}

/** An opaque caster's core strength before the slider and the sky: 0.665, darker at golden hour. */
export function shadowCoreStrength(golden01) {
  return Math.min(
    GOLDEN_SHADOW_STRENGTH_CEIL,
    SHADOW_CORE_STRENGTH * (1 + GOLDEN_SHADOW_STRENGTH_GAIN * clamp01(golden01 ?? 0))
  );
}

/**
 * THE DARKNESS: how much light an OPAQUE caster's shadow core removes, 0..1.
 * Core × the slider × the sky (`strengthMul`: disc above the horizon, cloud).
 * Every producer's own darkness is this × its opacity.
 * @param {object} atmosphere - {@link shadowAtmosphere}'s result.
 * @param {object} [look]
 */
export function shadowDepth01(atmosphere, look) {
  const l = resolveShadowLook(look);
  return clamp01(shadowCoreStrength(atmosphere?.golden01) * l.strength01 * (atmosphere?.strengthMul ?? 1));
}

/**
 * THE LENGTH: world px of throw per px of caster height — the building bake's own
 * `layerThrowPx` (`h × min(L / tan e, cap)`), with the golden-hour gain on both L and
 * the cap. Multiply by a caster's height for its throw. Below the horizon this is the
 * cap (the elevation clamps at 0) — harmless, because the darkness is 0 there.
 * @param {object} atmosphere
 * @param {object} [look]
 */
export function shadowThrowPerPx(atmosphere, look) {
  const l = resolveShadowLook(look);
  const lengthGain = 1 + GOLDEN_SHADOW_LENGTH_GAIN * clamp01(atmosphere?.golden01 ?? 0);
  return layerThrowPx({
    heightPx: 1,
    elevationDeg: atmosphere?.elevationDeg ?? 90,
    lengthScale: l.lengthScale * lengthGain,
    maxLengthMul: l.dawnDuskLength * lengthGain,
  });
}

/** The darkness an opaque caster has at clear noon under the card's DEFAULT look (0.565). */
export const SHADOW_NOON_REFERENCE_DEPTH = SHADOW_CORE_STRENGTH * DEFAULT_SHADOW_LOOK.strength01;

/**
 * The opacity that reproduces a darkness the author tuned AT NOON (a fly's 0.15, a leaf's
 * 0.2, smoke's 0.26) — so that look is kept exactly at clear noon, and from there follows
 * the shared sky like every other producer: darker and longer at golden hour, none at night.
 * @param {number} noonStrength01
 * @returns {number} 0..1
 */
/**
 * THE TWO STAGES A SHADOW CAN BE DRAWN AT (2026-11-01, shadow consistency round 6).
 *
 * Buildings, overhead tiles and clouds remove LIGHT: the bake's visibility multiplies the scene's
 * ambient (`environmental-light.js`: illum = ambient × sunVis), and the light-to-colour step then
 * raises that ratio to a power. Vegetation and ropes darken the ground COLOUR, which passes through
 * linearly. So the same darkness D read as D on a tree and as 1 − (1 − D)^γ on a building: equal
 * while shadows are short and soft, apart at golden hour when a building's long shadow shows its
 * full core. Measured on the shadow bench (linear luminance, full cores): D = 0.565 → building 0.76
 * and D = 0.77 → building 0.92, both γ = 1.72. A constant gain cannot close that (it overshoots at
 * noon); this transfer can, because it is the light stage's own curve.
 *
 * Feed it what the LIGHT stage would have been handed (opacity × the shared depth) and draw the
 * result on the colour stage.
 */
export const SHADOW_LIGHT_STAGE_GAMMA = 1.72;

/**
 * A light-stage darkness, re-expressed for a shadow drawn on the ground colour.
 * @param {number} lightStageDarkness01 - 0..1 (`forCaster(...).strength01`).
 * @returns {number} 0..1, never lighter than the input.
 */
export function colourStageDarkness(lightStageDarkness01) {
  const d = clamp01(Number(lightStageDarkness01) || 0);
  return 1 - Math.pow(1 - d, SHADOW_LIGHT_STAGE_GAMMA);
}

export function opacityForNoonStrength(noonStrength01) {
  const s = Number(noonStrength01);
  return Number.isFinite(s) && s > 0 ? Math.min(1, s / SHADOW_NOON_REFERENCE_DEPTH) : 0;
}

/** The longest throw per px of height this look can ever produce (the golden-hour cap) —
 * for consumers that size GEOMETRY around a shadow at build time. */
export function shadowMaxThrowPerPx(look) {
  return resolveShadowLook(look).dawnDuskLength * (1 + GOLDEN_SHADOW_LENGTH_GAIN);
}

/**
 * How much softer a night shadow is than the same shadow at noon. Night light
 * is dominated by scattered skyglow rather than a single small disc, so edges
 * diffuse. Compounds with {@link CLOUD_SOFTEN} — night UNDER cloud is the
 * softest case, which is exactly the ordering the author specified.
 */
export const NIGHT_SOFTEN = 2.0;

/** Default minimum feather, px — no shadow is ever a perfectly hard cutout. */
export const BASE_SOFTNESS_PX = 4;

/**
 * How far a world caster's shadow may be thrown, as a multiple of its own
 * height, before the throw starts saturating ({@link softenThrowPx}).
 *
 * Author, 2026-07-24: *"the offset means that the tree shadows are already too
 * far away from their producers at dawn and dusk… we need to lower the offset so
 * that shadows don't become too detached from their producers."*
 *
 * 2.5× is a sun about 22° above the horizon. Beyond that the physical throw
 * keeps growing and this keeps compressing it, so shadows still lengthen right
 * through sunset without any caster's shadow ever running away from the thing
 * casting it.
 *
 * Was 5× until 2026-07-24, halved on the author's *"make the shadows a lot
 * shorter, 1/2 of what it is right now"* — and it pays twice, because a
 * vegetation shadow's quad is PADDED by this distance
 * (`vegetationShadowPadPx`), so halving the throw also halves that pad's
 * contribution to a very expensive overdraw bill.
 *
 * ⚠️ HEIGHT-RELATIVE, not a flat pixel cap, on purpose: a flat cap makes a bush
 * and a cathedral throw the SAME distance at dusk, which destroys the one cue
 * that tells the viewer how tall things are. This preserves the ratio between
 * casters while bounding all of them.
 */
export const MAX_THROW_HEIGHT_RATIO = 2.5;

/**
 * The furthest a caster of this height will ever throw, after compression.
 * Exposed because a consumer that must size GEOMETRY around its own shadow (the
 * vegetation shadow quad's padding) needs a build-time constant, not a
 * per-frame number — a quad rebuilt every time the sun moved would be the
 * `BufferAttribute has no dispose()` trap wearing a hat.
 *
 * @param {number} heightPx
 * @param {number} [maxOffsetPx] - the handle's absolute ceiling.
 * @returns {number} px — an upper bound the actual throw approaches but never reaches.
 */
export function maxThrowForHeightPx(heightPx, maxOffsetPx = 4096) {
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 0;
  const abs = Number.isFinite(maxOffsetPx) && maxOffsetPx > 0 ? maxOffsetPx : 4096;
  return Math.min(abs, h * MAX_THROW_HEIGHT_RATIO);
}

/**
 * @typedef {object} ShadowAtmosphere
 * @property {number} azimuthDeg - where the light is (compass, cw from up).
 * @property {number} elevationDeg - light elevation above the horizon.
 * @property {number} cloudCover01
 * @property {number} dayFactor01 - 1 sun disc up, 0 sun down (a quick ramp across the horizon — NOT the ambient `dayFactor01`).
 * @property {number} golden01 - 0..1 golden-hour bell; 0 when the sun carries none.
 * @property {number} softnessMul - multiplier applied to every caster's penumbra.
 * @property {number} strengthMul - multiplier applied to every caster's strength.
 */

/**
 * THE ATMOSPHERIC MODEL — the one genuinely new piece (see this module's own
 * header for what was already built and is not re-derived here).
 *
 * Both returned multipliers are SHARED by every caster: that is what makes a
 * tree's shadow and a future token's shadow agree about the sky without either
 * declaring a sky of its own.
 *
 * @param {{elevationDeg?: number, azimuthDeg?: number, dayFactor01?: number}} [sun]
 * @param {{cloudCover01?: number}} [weather]
 * @returns {Readonly<ShadowAtmosphere>}
 */
export function shadowAtmosphere(sun, weather) {
  const elevationDeg = Number.isFinite(sun?.elevationDeg) ? sun.elevationDeg : 90;
  const azimuthDeg = Number.isFinite(sun?.azimuthDeg) ? sun.azimuthDeg : 180;
  // ⚠️ THE SHADOW'S OWN DAYLIGHT, NOT `dayFactor01` (2026-10-27, author: "building
  // shadows should be very strong and very long at the golden hour but … aren't
  // even visible"). `dayFactor01` eases in over −6°…+10° of elevation because it
  // drives the AMBIENT level, so at golden hour (0–6°) it is only ~0.3–0.6 and
  // the night fade below cut every shadow to half strength and double softness
  // exactly when the sun is a hard, low, raking disc. A shadow only needs the
  // DISC to be above the horizon, so it keys off a much quicker ramp: gone at
  // the horizon, full by ~+3°. Falls back to `dayFactor01` when no elevation is
  // given, so a caller that never supplied one behaves as before.
  const hasElevation = Number.isFinite(sun?.elevationDeg);
  const dayFactor01 = hasElevation
    ? ((t) => t * t * (3 - 2 * t))(clamp01((elevationDeg + 0.5) / 3))
    : clamp01(sun?.dayFactor01 ?? 1);
  const golden01 = clamp01(sun?.golden01 ?? 0);
  // THE COVER SHADOWS SEE (2026-11-01): `shadowCloudCover01` when the owner supplies
  // it — the cover capped at the cloud field's own visual cap, the SAME number the
  // cloud shadow's depth already reads (vt-pan-viewer.js, `cloudSkyHandle`: past
  // the cap the silhouette stops changing, and a depth that kept draining would hide
  // the very clouds the author raised cover to see). Before this pass buildings and
  // trees faded with the RAW cover (0.15× at full overcast) while the cloud patches
  // over them stayed deep. Under partial cover the cloud FIELD does the overcast
  // work spatially (patches darken, gaps keep full sun, producers min-combine).
  const cloudCover01 = clamp01(weather?.shadowCloudCover01 ?? weather?.cloudCover01 ?? 0);

  // CLOUD — softens and fades, independently. A diffuse sky both blurs the edge
  // and lifts the shadow's floor toward the ambient level.
  const cloudSoften = 1 + CLOUD_SOFTEN * cloudCover01;
  const cloudStrength = 1 - (1 - CLOUD_SURVIVING_STRENGTH) * cloudCover01;

  // NIGHT — same two effects, keyed off the eased day factor rather than a hard
  // horizon test, so shadows fade THROUGH twilight instead of popping.
  const nightSoften = 1 + NIGHT_SOFTEN * (1 - dayFactor01);
  const nightStrength = NIGHT_SURVIVING_STRENGTH + (1 - NIGHT_SURVIVING_STRENGTH) * dayFactor01;

  return Object.freeze({
    azimuthDeg,
    elevationDeg,
    cloudCover01,
    dayFactor01,
    /** How golden-hour the light is, 0..1 (`world/sun.js#golden01`). The sun-shadow
     * bake reads it to stretch and darken shadows at low raking sun. */
    golden01,
    // Multiplicative, so night UNDER cloud compounds to the softest/faintest
    // case — the explicit ordering the author asked for ("during night shadows
    // will be softer too and softest if there are clouds").
    softnessMul: cloudSoften * nightSoften,
    strengthMul: cloudStrength * nightStrength,
  });
}

/**
 * Build the shadow handle. Called by whoever owns the frame's env snapshot,
 * with the sky it just resolved; frozen on return.
 *
 * Immutable + versioned, for the same reason `world/wind-access.js` is: a
 * consumer that caches anything derived from a handle (a built material, a
 * uniform it only writes on change) stores the `version` it built against and
 * refreshes when it moves. A new sky makes a NEW handle, never a mutated one.
 *
 * @param {object} [spec]
 * @param {number} [spec.version] - bumped by the owner whenever the sky changes.
 * @param {{elevationDeg?: number, azimuthDeg?: number, dayFactor01?: number}} [spec.sun] - `env.sun`.
 * @param {{cloudCover01?: number}} [spec.weather] - `env.weather`.
 * @param {number} [spec.maxOffsetPx] - cap on any caster's throw (world px).
 * @param {number} [spec.gridSizePx] - px per grid square, for the longest shadow ({@link longestShadowPx}).
 * @returns {Readonly<object>}
 */
export function createShadowHandle({
  version = 0,
  sun = null,
  weather = null,
  maxOffsetPx = 4096,
  look = null,
  gridSizePx = 100,
} = {}) {
  const atmosphere = shadowAtmosphere(sun, weather);
  // THE SHARED LOOK (see SHADOW_CORE_STRENGTH): resolved once per sky, read by every caster.
  const shadowLook = resolveShadowLook(look);
  const depth01 = shadowDepth01(atmosphere, shadowLook);
  const throwPerPx = shadowThrowPerPx(atmosphere, shadowLook);
  // THE LONGEST SHADOW every caster's throw eases into — the bake reads this same number off the handle.
  const longestPx = longestShadowPx(shadowLook, gridSizePx);

  /**
   * Everything one caster needs, in world px. Plain JS (not TSL nodes) — a
   * shadow's geometry changes only when the SKY does, which is orders of
   * magnitude slower than per-frame, so this is resolved on the CPU and written
   * into a handful of uniforms rather than recomputed per-vertex on the GPU.
   *
   * @param {object} args
   * @param {number} args.heightPx - how far above the ground the caster sits.
   *   The ONE physical property that drives both throw and softness.
   * @param {number} [args.offsetScale=1] - cosmetic throw multiplier; does NOT
   *   affect softness (see this module's own header).
   * @param {number} [args.strength01=1] - the caster's own OPACITY: how much of the sun
   *   it blocks (a canopy or a wall 1). Its darkness is this × the shared `depth01`.
   * @param {number} [args.baseSoftnessPx]
   * @returns {{offsetX:number, offsetY:number, offsetPx:number, penumbraPx:number,
   *   strength01:number, directionX:number, directionY:number}}
   */
  function forCaster({ heightPx, offsetScale = 1, strength01 = 1, baseSoftnessPx = BASE_SOFTNESS_PX }) {
    const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 0;
    // THE THROW + THE RAW PENUMBRA — both from the already-built, already-tested
    // projection maths. Sun angle, and therefore dawn/dusk elongation, is fully
    // handled in here; see this module's own header for why no elongation term
    // is (or should be) added on top.
    // THE SHARED LENGTH (2026-11-01): the building bake's own throw per px of
    // height, so a tree and a wall of the same height throw the same distance at
    // every hour. Was `projectShadowOffset` with its own soft knee at 2.5× height
    // (and a separate golden ×2 in the vegetation subsystem): measured on the bench,
    // trees threw 2.2× further than buildings, relative to height, at noon.
    const scale = Number.isFinite(offsetScale) && offsetScale > 0 ? offsetScale : 1;
    const length = Math.min(
      Number.isFinite(maxOffsetPx) && maxOffsetPx > 0 ? maxOffsetPx : 4096,
      softShadowCeilingPx(h * throwPerPx, longestPx) * scale
    );
    const dir0 = shadowOffsetDirection(atmosphere.azimuthDeg);
    const offset = { x: dir0.x * length, y: dir0.y * length, length };
    const rawPenumbra = shadowPenumbraPx({
      heightPx: h,
      elevationDeg: atmosphere.elevationDeg,
      baseSoftnessPx,
    });
    const dir = shadowOffsetDirection(atmosphere.azimuthDeg);
    return {
      offsetX: offset.x,
      offsetY: offset.y,
      offsetPx: offset.length,
      // The atmospheric layer, applied last — the ONLY place cloud/night touch
      // a caster, so every caster receives the identical sky treatment.
      penumbraPx: rawPenumbra * atmosphere.softnessMul,
      // THE SHARED DARKNESS × this caster's opacity (2026-11-01; was × strengthMul alone).
      strength01: clamp01(strength01) * depth01,
      directionX: dir.x,
      directionY: dir.y,
    };
  }

  return Object.freeze({ version, atmosphere, look: shadowLook, depth01, throwPerPx, longestPx, forCaster });
}
