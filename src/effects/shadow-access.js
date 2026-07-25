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

import { projectShadowOffset, shadowPenumbraPx, shadowOffsetDirection, clamp01 } from './lighting/light-visibility.js';

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
 * The faint floor a shadow fades to at full night. Moonlight/skyglow still
 * casts SOMETHING under an open sky, and snapping shadows off at the horizon
 * would read as a bug (the same reasoning `world/sun.js`'s own eased
 * `dayFactor01` uses instead of a hard `aboveHorizon` branch).
 */
export const NIGHT_SURVIVING_STRENGTH = 0.12;

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
 * @property {number} dayFactor01 - 1 full day, 0 full night (eased across twilight).
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
  const dayFactor01 = clamp01(sun?.dayFactor01 ?? 1);
  const cloudCover01 = clamp01(weather?.cloudCover01 ?? 0);

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
 * @returns {Readonly<object>}
 */
export function createShadowHandle({ version = 0, sun = null, weather = null, maxOffsetPx = 4096 } = {}) {
  const atmosphere = shadowAtmosphere(sun, weather);

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
   * @param {number} [args.strength01=1] - the caster's own darkness, before
   *   atmospheric fading.
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
    const offset = projectShadowOffset({
      azimuthDeg: atmosphere.azimuthDeg,
      elevationDeg: atmosphere.elevationDeg,
      heightPx: h,
      // HEIGHT-RELATIVE and SOFT (2026-07-24) — see MAX_THROW_HEIGHT_RATIO.
      // The old behaviour here was a hard clamp at the handle's absolute
      // `maxOffsetPx` (4096 px by default), which is to say: no bound at all in
      // practice, so a tree at dawn threw its shadow most of a map away.
      maxOffsetPx: maxThrowForHeightPx(h, maxOffsetPx),
      offsetScale,
      softKnee: true,
    });
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
      strength01: clamp01(strength01) * atmosphere.strengthMul,
      directionX: dir.x,
      directionY: dir.y,
    };
  }

  return Object.freeze({ version, atmosphere, forCaster });
}
