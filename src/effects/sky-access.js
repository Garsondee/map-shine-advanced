/**
 * THE SKY HANDLE — the outdoor light, described ONCE.
 *
 * ============================================================================
 * WHY THIS EXISTS (docs/planning/Sky.md — the design this implements)
 * ============================================================================
 *
 * Author directive, 2026-07-23: *"The previous V2 did this by using CCs to
 * change the look of the world but we want to make it so that it's the light
 * itself which is bringing these properties, the outdoors light."*
 *
 * V2 made atmosphere with a full-screen colour corrector at the END of the
 * pipe, and paid for it twice, both documented in its own params reference:
 *
 *   1. The outdoor-only gate had to be bolted INSIDE the colourist
 *      (*"procedural weather/golden-hour offsets on sky-eligible outdoor
 *      pixels… Requires `_Outdoors` for interior vs outdoor timeline splits"*).
 *      A full-screen grade is global by nature.
 *   2. It needed a WHOLE SECOND SYSTEM to undo itself — the "Local ToD
 *      override", *"blends from the timeline grade toward a bright neutral
 *      local grade — cancels midnight tint/exposure in lit pools"*. Because the
 *      grade ran after lighting, it tinted the inside of torch pools too, and a
 *      torch pool should not be blue at midnight.
 *
 * That second one is the same compensator shape as `DynamicLightShadowLift.js`
 * (an entire module for un-darkening shadows near lights). **The compensator
 * was the cost of grading after lighting.** Moving the atmosphere upstream,
 * into the light itself, refunds it: a torch is simply brighter than the night
 * sky, and there is nothing to cancel.
 *
 * ============================================================================
 * THE ONE DIVISION OF LABOUR — the sky owns COLOUR, darkness owns LEVEL
 * ============================================================================
 *
 * `ambientMultiplierRgb` below is **luminance-normalised by construction**: it
 * shifts the hue of the outdoor light without changing how much of it there is.
 *
 * That is not a detail, it is the whole reason this can coexist with what is
 * already built. `world/environment.js` already derives ONE `darkness01`, and
 * `effects/lighting/environmental-light.js` already turns it into an ambient
 * level on Foundry's own ladder. If the sky light ALSO dimmed, two systems
 * would own "how bright is it outside" — which is exactly the four-colourists-
 * on-unlabelled-layers problem (Environment.md §0.5) reintroduced one layer
 * down. So: darkness answers *how much light*, the sky answers *what colour it
 * is*, and neither can dilute the other.
 *
 * The desaturation an overcast sky needs is NOT here — a light cannot drain
 * chroma (Grade.md §2). It is the environmental grade's job. This module owns
 * only the directional warm/cool COLOUR of the outdoor light.
 *
 * ============================================================================
 * SHIPS NEUTRAL — `realism01 = 0` is a mathematical no-op
 * ============================================================================
 *
 * `environmental-light.js` holds the strongest parity check this project has:
 * at `background = white` the sRGB round-trip is the identity and MSA's lit map
 * is PIXEL-IDENTICAL to Foundry's. A sky light that altered the frame by
 * default would destroy that silently, so `realism01` defaults to 0, at which
 * `ambientMultiplierRgb` is exactly `[1,1,1]`. Same proven pattern as
 * `darknessRealism01`
 * (memory: keyhole-darkness-realism-lever): one scalar, two honest modes,
 * default is the one that cannot surprise anybody.
 *
 * A deliberate, logged exception to `feedback_default_on_new_features` — the
 * same exception the day clock's zero drift rate takes, for the same reason: it
 * changes how EXISTING scenes look.
 *
 * Pure — no TSL, no Foundry, no THREE. Node-tested against named cases.
 *
 * @module effects/sky-access
 */

import { shadowAtmosphere } from './shadow-access.js';
// The ONE azimuth→XY convention in this codebase, and it already has the exact
// name of the thing wanted here. See `key.dirX`'s own note below for why this
// is an import rather than two lines of trigonometry that looked right.
import { marchDirectionToSun } from './lighting/sun-occlusion.js';

// ---------------------------------------------------------------------------
// THE COLOUR ENDPOINTS — a cinematic ramp, not an ephemeris.
//
// Same doctrine world/sun.js states for position ("stage lighting for a top-down
// map, not an ephemeris"). These are normalised HUES: each is scaled to unit
// luminance before use, so changing one changes the colour of the light and
// never its level. Values are linear-ish sRGB primaries.
// ---------------------------------------------------------------------------

/** The sun at the horizon — deep warm, roughly 1900 K. Golden hour's own colour. */
export const KEY_HORIZON_RGB = Object.freeze([1.0, 0.52, 0.22]);
/** The sun overhead — near-neutral daylight, roughly 5500 K. */
export const KEY_ZENITH_RGB = Object.freeze([1.0, 0.97, 0.94]);
/** Elevation at which the key has finished warming up. */
export const KEY_NEUTRAL_ELEVATION_DEG = 30;

/** Clear daytime sky dome — the blue that fills shadows on a sunny day. */
export const FILL_DAY_RGB = Object.freeze([0.46, 0.63, 1.0]);
/** The twilight dome — the blue hour's own colour, cooler and deeper. */
export const FILL_TWILIGHT_RGB = Object.freeze([0.32, 0.42, 0.86]);
/** Night sky — a cold, nearly colourless blue. */
export const FILL_NIGHT_RGB = Object.freeze([0.24, 0.3, 0.62]);
/** Overcast — the flat neutral both key and fill collapse toward. */
export const OVERCAST_RGB = Object.freeze([0.86, 0.88, 0.92]);

/** How much of the outdoor light the sky DOME contributes versus the sun disc,
 * at full clear day. A real clear-sky fill is a substantial fraction of total
 * irradiance; this is what makes shadowed ground read blue rather than black. */
export const FILL_SHARE = 0.42;

/** Cloud raises the dome's share — an overcast sky is one enormous softbox. */
export const CLOUD_FILL_GAIN = 0.6;

/**
 * How far the outdoor light is allowed to rotate the map's hue, 0..1 of the
 * full luminance-normalised sky colour. **0.35, and deliberately not 1.**
 *
 * Two reasons, both found by measurement rather than taste:
 *
 *  1. **Foundry's ambient ladder ALREADY makes night blue.** Its own
 *     `ambientDarkness` default is `#242448`, and
 *     `effects/lighting/environmental-light.js` already mixes toward it as
 *     darkness rises. A sky light at full strength would apply a SECOND night
 *     blue on top of that one — double-counting, and the exact "two systems
 *     answering the same question" shape this file's header is about.
 *  2. **Luminance normalisation is violently non-linear in blue.** Blue carries
 *     only 0.0722 of Rec.709 luminance, so normalising a saturated night-sky
 *     blue to unit luminance yields a multiplier of ~2.0 on the blue channel —
 *     measured, not estimated. Doubling a map's blue at night is not "subtle
 *     recoloration"; it is a colour cast.
 *
 * Mixing toward `[1,1,1]` preserves unit luminance exactly (both endpoints have
 * it), so this dial changes ONLY how far the hue moves — never the level. The
 * sky-owns-colour/darkness-owns-level split survives it untouched.
 */
export const TINT_STRENGTH = 0.35;

/**
 * THE GOLDEN TINT A POINT LIGHT'S OWN AMBIENT TONES CARRY (2026-10-27, author: fire
 * light "bleaching the colour of light towards white" at golden hour).
 *
 * The ground's fill is multiplied by the sky's colour (`ambientMultiplierRgb`) but a
 * point light's illumination is built from UNTINTED ambient tones and MAX-blended
 * over that fill — so inside a fire's glow the neutral light beat the golden fill on
 * green and blue and the golden hour washed to white. Tinting the light's tones by the
 * same multiplier, where the light stands outdoors, keeps it in the same colour world.
 * Only during the golden grade, so night and noon are untouched.
 *
 * @param {{multiplierRgb?: readonly number[], golden01?: number, outdoors01?: number}} a
 * @returns {number[]|null} per-channel multiplier, or null when there is nothing to apply.
 */
export function lightGoldenTint({ multiplierRgb, golden01 = 0, outdoors01 = 1 } = {}) {
  const g = Number.isFinite(golden01) ? golden01 : 0;
  const o = Number.isFinite(outdoors01) ? Math.min(1, Math.max(0, outdoors01)) : 0;
  if (!(g > 0) || !(o > 0)) return null;
  if (!Array.isArray(multiplierRgb) || multiplierRgb.length !== 3 || !multiplierRgb.every(Number.isFinite)) return null;
  return multiplierRgb.map((m) => 1 + (m - 1) * o);
}

/**
 * THE GOLDEN-HOUR GRADE (2026-10-27, author: "the lighting at dusk and dawn
 * golden hour is not very golden at all. Make it strong and exagerated").
 *
 * Why the existing key/fill model could not do this on its own: it ships at
 * `realism01 = 0` (a no-op), and even at 1 it rotates the hue by only
 * `TINT_STRENGTH` (0.35) — with the BLUE sky-dome fill (weighted 0.38 at the
 * horizon) pulling the blend straight back toward neutral. Golden hour is the
 * one time of day that wants the opposite: the key is the whole story.
 *
 * So this is a SECOND, independent multiplier, keyed off the sun's own
 * `golden01` bell (`world/sun.js` — the same bell the long shadows read), NOT
 * gated by `realism01`. It is exactly `[1,1,1]` whenever `golden01 = 0`
 * (midday, night), so the noon parity check this module's header guards is
 * untouched. Like everything here it is luminance-normalised: it moves HUE,
 * and `darkness01` still owns how bright it is.
 */
export const GOLDEN_RGB = Object.freeze([1.0, 0.46, 0.14]);
/** The deepest the golden grade rotates the outdoor light at the bell's peak. */
export const GOLDEN_MAX_AMOUNT = 0.8;
/**
 * The whole golden grade, scaled (2026-10-28, author: *"golden hour lighting is just a bit too strong, could you make
 * it about 20% less strong as an effect"*). A scale on the EFFECT rather than a lower default, so it reaches scenes
 * already saved with a tuned Golden lever. Everything normalised by {@link GOLDEN_MAX_AMOUNT} — the low-sun dimming
 * (`GOLDEN_LEVEL`) and the `golden01` other effects read — follows it down by the same 20%.
 */
export const GOLDEN_EFFECT_SCALE = 0.8;
/** Cloud mutes golden light (a sunset behind overcast is dull) — but not to
 * nothing: broken cloud is exactly when it lights up. 1 = cloud fully mutes. */
export const GOLDEN_CLOUD_MUTE = 0.55;
/**
 * THE GOLDEN LIGHT IS DIMMER THAN NOON (2026-10-27, author: *"Golden hour in
 * general is too bright"*). A luminance-normalised orange runs its red channel
 * at ~1.65× noon to hold luminance, which on pale stone reads as a blown-out
 * yellow-white, not a low sun. Real low sun is weaker as well as warmer, so at
 * the bell's peak the outdoor light sits at this fraction of its noon level.
 * The one deliberate exception to "the sky owns colour, darkness owns level":
 * darkness keys off the SKY dome, which is still at full strength at +2°.
 */
export const GOLDEN_LEVEL = 0.72;

/**
 * THE AFTERGLOW → BLUE HOUR (2026-10-27, author: *"immediately after golden
 * hour the colouration returns to normal long before it gets dark which looks
 * very strange"*). Keyed off `world/sun.js#afterglow01`/`blueHour01`, it takes
 * over as the golden bell lets go: a rose glow as the sun goes, deepening into
 * the blue hour, held until the sky is genuinely dark — no white-light gap
 * between sunset and night. Rides the same Golden lever (both are "how
 * dramatic is the sun going down") and is muted by cloud the same way.
 */
export const AFTERGLOW_RGB = Object.freeze([1.0, 0.5, 0.5]);
export const BLUE_HOUR_RGB = Object.freeze([0.42, 0.54, 1.0]);
export const AFTERGLOW_MAX_AMOUNT = 0.75;

/**
 * THE MOON (2026-10-27, author: "at night I want the option to make the scene
 * cool colours as if it were moonlight illuminating the scene through gaps in
 * the clouds"). An OPTION — `moonlight01 = 0` ships it off.
 *
 * Two parts, and they are deliberately different mechanisms:
 *   - a cool, luminance-normalised multiplier (the whole outdoor night goes
 *     blue-silver instead of Foundry's flat violet), and
 *   - an ADDITIVE cool light (`moonAddRgb`), which `environmental-light.js`
 *     multiplies by the cloud field's own clear-sky visibility. A light that is
 *     added, and then killed under cloud, is what makes shafts of moonlight
 *     appear only in the gaps — a multiplier alone can only darken the gaps' neighbours.
 */
export const MOON_RGB = Object.freeze([0.5, 0.68, 1.0]);
/** The additive moon level at full strength, gamma-space ambient units. */
export const MOON_ADD_LEVEL = 0.2;
/** How far the night multiplier rotates toward the moon's blue at full strength. */
export const MOON_TINT_AMOUNT = 0.65;

/**
 * Build the sky handle. Pure: same inputs → same frozen value.
 *
 * @param {object} [spec]
 * @param {number} [spec.version] - bumped by the owner whenever the sky moves,
 *   so a consumer caching anything derived from this can tell (the same
 *   contract `windHandle.version` and `shadowHandle.version` already carry).
 * @param {object} [spec.sun] - `env.sun` (world/sun.js).
 * @param {object} [spec.weather] - `env.weather` (needs `cloudCover01`).
 * @param {number} [spec.realism01] - 0 = exact Foundry parity (a no-op), 1 =
 *   the full atmospheric model. See the header.
 * @returns {Readonly<object>} the handle.
 */
export function createSkyHandle({
  version = 0,
  sun = null,
  weather = null,
  realism01 = 0,
  goldenHour01 = 1,
  moonlight01 = 0,
} = {}) {
  const elevationDeg = Number.isFinite(sun?.elevationDeg) ? sun.elevationDeg : 90;
  const azimuthDeg = Number.isFinite(sun?.azimuthDeg) ? sun.azimuthDeg : 180;
  const dayFactor01 = clamp01(sun?.dayFactor01 ?? 1);
  const skyFactor01 = clamp01(sun?.skyFactor01 ?? 1);
  const twilight01 = clamp01(sun?.twilight01 ?? 0);
  const cloud01 = clamp01(weather?.cloudCover01 ?? 0);
  const realism = clamp01(realism01);
  const golden = clamp01(sun?.golden01 ?? 0);
  const afterglow = clamp01(sun?.afterglow01 ?? 0);
  const blueHour = clamp01(sun?.blueHour01 ?? 0);
  const goldenLever = clamp01(goldenHour01);
  const moonLever = clamp01(moonlight01);

  // --- KEY: the sun disc ---------------------------------------------------
  // Warm at the horizon, neutral overhead — this is where "subtle recoloration
  // based on time of day" actually lives, as ONE curve rather than V2's eight
  // hand-placed anchors that could disagree with the sun that drove them.
  const warmth = 1 - smoothstep01(elevationDeg / KEY_NEUTRAL_ELEVATION_DEG);
  const keyHue = mixRgb(KEY_ZENITH_RGB, KEY_HORIZON_RGB, warmth);
  // Cloud is the key light's first casualty — that is what "overcast" MEANS.
  const keyStrength = dayFactor01 * (1 - cloud01);

  // --- FILL: the sky dome --------------------------------------------------
  // Day blue → twilight blue → night blue, then pulled toward flat grey by
  // cloud. The key/fill COLOUR SPLIT is what makes a clear day read as a clear
  // day: two differently-coloured lights across a frame produce far more chroma
  // variety than one flat one, which is the author's *"increase saturation
  // during cloudless middays"* arriving with no saturation term in sight.
  const nightToTwilight = mixRgb(FILL_NIGHT_RGB, FILL_TWILIGHT_RGB, twilight01);
  const fillHue = mixRgb(nightToTwilight, FILL_DAY_RGB, dayFactor01);
  const fillStrength = skyFactor01 * FILL_SHARE * (1 + CLOUD_FILL_GAIN * cloud01);

  // Under overcast BOTH collapse toward the same neutral, which is the other
  // half of why an overcast frame has less colour in it than a clear one.
  const key = mixRgb(keyHue, OVERCAST_RGB, cloud01);
  const fill = mixRgb(fillHue, OVERCAST_RGB, cloud01 * 0.75);

  // --- the combined hue of the outdoor light -------------------------------
  const total = keyStrength + fillStrength;
  // A sky with no light at all (deep night, no moon term yet) has no colour to
  // report — fall back to neutral rather than dividing by zero. The scene is
  // already dark by then; darkness owns that, not this.
  const blended =
    total > 1e-6
      ? [
          (key[0] * keyStrength + fill[0] * fillStrength) / total,
          (key[1] * keyStrength + fill[1] * fillStrength) / total,
          (key[2] * keyStrength + fill[2] * fillStrength) / total,
        ]
      : [1, 1, 1];

  // --- THE VEIL IS GONE (2026-07-23) --------------------------------------
  // This used to add a neutral "veiling luminance" term to desaturate overcast.
  // It was the WRONG MECHANISM and the author caught it live: an additive term
  // lifts blacks, so it read as "the scene just got brighter and greyish", not
  // "the colour drained out". A light literally cannot desaturate — it can only
  // add or multiply. Desaturation is now a luminance-PRESERVING grade
  // (effects/grade/grade-ops.js, the environmental grade), which greys the
  // image WITHOUT changing brightness. See docs/planning/Grade.md §2. The sky
  // light keeps only what a light genuinely does: the directional warm/cool
  // colour split below.

  // --- THE MULTIPLIER: chroma only ----------------------------------------
  // Normalised to unit luminance (the sky owns colour, not level — see header),
  // so a fully-lit outdoor surface keeps its brightness and "how bright is it
  // outside" still has exactly one owner (`darkness01`).
  const blendedLuma = luminance(blended);
  const chromaOnly = blendedLuma > 1e-6 ? scaleRgb(blended, 1 / blendedLuma) : [1, 1, 1];

  // THE TINT FADES OUT WITH THE SKY'S OWN LIGHT — and this is load-bearing, not
  // a polish pass. Without the `skyFactor01` term the hue rotation stayed at
  // FULL strength no matter how faint the sky got, then dropped to neutral the
  // instant the light hit exactly zero: a measured 0.998 jump in the blue
  // channel between 19:10 and 19:11, i.e. a visible hue POP at precisely the
  // hour the author cares about. It read as continuous in every test that swept
  // a step-function fixture, and was only caught by sweeping the REAL sun.
  //
  // Multiplying `TINT_STRENGTH` by `skyFactor01` makes it continuous BY
  // CONSTRUCTION: the "no light at all" fallback above can only trigger where
  // `skyFactor01` is 0, and there this term is 0 too, so both paths meet at
  // exactly `[1,1,1]`. There is no boundary left to pop across.
  const tintAmount = TINT_STRENGTH * skyFactor01;
  const tinted = mixRgb([1, 1, 1], chromaOnly, tintAmount);

  const realismMultiplier = mixRgb([1, 1, 1], tinted, realism);

  // --- THE GOLDEN GRADE: independent of `realism01` (see GOLDEN_RGB) ---------
  const goldenAmount =
    GOLDEN_MAX_AMOUNT * GOLDEN_EFFECT_SCALE * golden * goldenLever * (1 - GOLDEN_CLOUD_MUTE * cloud01);
  const goldenMultiplier = mixRgb([1, 1, 1], unitLuminance(GOLDEN_RGB), goldenAmount);

  // --- THE AFTERGLOW → BLUE HOUR (see AFTERGLOW_RGB) -------------------------
  const afterglowAmount = AFTERGLOW_MAX_AMOUNT * afterglow * goldenLever * (1 - GOLDEN_CLOUD_MUTE * cloud01);
  const afterglowHue = mixRgb(unitLuminance(AFTERGLOW_RGB), unitLuminance(BLUE_HOUR_RGB), blueHour);
  const afterglowMultiplier = mixRgb([1, 1, 1], afterglowHue, afterglowAmount);

  // --- THE MOON: only once the sky dome has gone dark ------------------------
  // `skyFactor01` is the sky's own light, 0 at the end of astronomical
  // twilight. (1 − it) is "how night it is", already eased by the sun model.
  const moonAmount = moonLever * (1 - skyFactor01);
  const moonMultiplier = mixRgb([1, 1, 1], unitLuminance(MOON_RGB), MOON_TINT_AMOUNT * moonAmount);
  const moonAddRgb = scaleRgb(MOON_RGB, MOON_ADD_LEVEL * moonAmount);

  // The three multipliers are each unit-luminance; their PRODUCT is not (the
  // channels multiply unevenly), so it is renormalised — the sky still owns
  // colour only, and `darkness01` still owns level.
  const product = [
    realismMultiplier[0] * goldenMultiplier[0] * moonMultiplier[0] * afterglowMultiplier[0],
    realismMultiplier[1] * goldenMultiplier[1] * moonMultiplier[1] * afterglowMultiplier[1],
    realismMultiplier[2] * goldenMultiplier[2] * moonMultiplier[2] * afterglowMultiplier[2],
  ];
  const productLuma = luminance(product);
  // …then the ONE level term the sky owns: the low sun's own weakness.
  const goldenLevel = 1 - (1 - GOLDEN_LEVEL) * (goldenAmount / GOLDEN_MAX_AMOUNT);
  // Skipped when no extra grade is live, so the realism-0 handle stays
  // EXACTLY [1,1,1] (a luminance of 1.0000000000000002 would otherwise nudge it).
  const ambientMultiplierRgb =
    goldenAmount === 0 && moonAmount === 0 && afterglowAmount === 0
      ? realismMultiplier
      : productLuma > 1e-6
        ? scaleRgb(product, goldenLevel / productLuma)
        : [1, 1, 1];

  return Object.freeze({
    version,
    /** The lever's own value, so a diagnostic can report parity vs. model. */
    realism01: realism,
    /** True when this handle is a mathematical no-op (parity mode). */
    neutral: realism === 0 && goldenAmount === 0 && moonAmount === 0 && afterglowAmount === 0,

    /** The sun disc: where it is, what colour, how strong. */
    key: Object.freeze({
      /**
       * THE HORIZONTAL UNIT VECTOR FROM A SURFACE **TOWARD** THE KEY LIGHT,
       * in world/screen axes. Pair it with `elevationDeg` for the 3-vector.
       *
       * ⚠️ **THIS WAS `(cos az, sin az)` UNTIL 2026-07-26, AND THAT WAS WRONG
       * — the comment above it was already making the claim the code did not
       * keep.** It said "derived from the SAME azimuth the shadow handle
       * throws shadows along, so a highlight can never point away from its own
       * shadow", while `shadowOffsetDirection` (the live, Node-tested, on-screen
       * -verified one) is `(−sin az, cos az)` — Foundry's compass convention,
       * clockwise from up. The two differ by a 90° rotation AND a reflection,
       * so a consumer of this field would have put every highlight roughly
       * perpendicular to the shadow cast by the same sun.
       *
       * It never rendered wrong because it never had a consumer: `grep dirX`
       * across `src/` found this declaration, one finiteness assertion in
       * `__tests__/sky-access.test.mjs`, and nothing else. The first real
       * consumer (`effects/specular`, the sun glint) is what surfaced it —
       * which is `env/one-sun`'s whole thesis arriving on schedule: a term
       * derived twice is N−1 needless chances to disagree, and prose asserting
       * they agree is not a mechanism. Delegating removes the second
       * derivation entirely, so the claim is now true BY CONSTRUCTION rather
       * than by comment.
       */
      dirX: marchDirectionToSun(azimuthDeg).x,
      dirY: marchDirectionToSun(azimuthDeg).y,
      colorRgb: Object.freeze(key),
      strength: keyStrength,
      elevationDeg,
      azimuthDeg,
    }),
    /** The sky dome. */
    fill: Object.freeze({ colorRgb: Object.freeze(fill), strength: fillStrength }),

    /**
     * THE PRODUCT THE RENDERER ACTUALLY USES, so no consumer recombines
     * key/fill by hand (the assembly drift `wind-access.js`'s header is about).
     * Gated by the `_Outdoors` mask at the point of use — indoors is not lit by
     * the sky, which as a LIGHT needs no special case at all. Multiplies
     * `buf:scene.illum`; `[1,1,1]` at realism 0. (The desaturation that was a
     * second additive product here is gone — it is the environmental grade's
     * job now, docs/planning/Grade.md.)
     */
    ambientMultiplierRgb: Object.freeze(ambientMultiplierRgb),

    /**
     * THE MOON's additive light (see MOON_RGB) — `[0,0,0]` unless the option is
     * on AND it is night. NOT cloud-attenuated here: the cloud field lives in
     * the shader, which multiplies this by the clear-sky visibility so the
     * light appears only through gaps. `strength` is its scalar for diagnostics.
     */
    moonAddRgb: Object.freeze(moonAddRgb),
    moon: Object.freeze({ colorRgb: MOON_RGB, strength: moonAmount }),
    /** How golden the grade is right now, 0..1 (lever × bell × cloud). */
    golden01: goldenAmount / GOLDEN_MAX_AMOUNT || 0,
    /** How far into the afterglow/blue-hour grade the light is right now, 0..1. */
    afterglow01: afterglowAmount / AFTERGLOW_MAX_AMOUNT || 0,

    /**
     * The shadow character for this same sky — NOT recomputed here, delegated
     * to the module that already owns it and already has a consumer
     * (`effects/shadow-access.js`, vegetation). Two derivations of one sky is
     * `env/one-sun`'s failure re-run in the colour domain; carrying it through
     * means a caster's softness and the light's colour are guaranteed to be
     * describing the same afternoon.
     */
    shadow: shadowAtmosphere(sun, weather),
  });
}

/**
 * Rec. 709 luminance. Used to normalise the sky's colour to unit brightness and
 * to make the veil pay for itself — both of which depend on ONE agreed
 * definition of "how bright is this colour".
 * @param {readonly number[]} rgb @returns {number}
 */
export function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Saturation as `(max − min) / max`, 0..1. Exported because the veil's whole
 * justification is a claim about this number, and a claim the tests can measure
 * is worth more than a paragraph asserting it.
 * @param {readonly number[]} rgb @returns {number}
 */
export function saturation(rgb) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  return mx > 1e-6 ? (mx - mn) / mx : 0;
}

/** @param {readonly number[]} a @param {readonly number[]} b @param {number} t @returns {number[]} */
function mixRgb(a, b, t) {
  const s = clamp01(t);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** A hue scaled to unit Rec.709 luminance — colour with no level. */
function unitLuminance(rgb) {
  const l = luminance(rgb);
  return l > 1e-6 ? scaleRgb(rgb, 1 / l) : [1, 1, 1];
}

/** @param {readonly number[]} rgb @param {number} k @returns {number[]} */
function scaleRgb(rgb, k) {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** @param {number} x @returns {number} */
function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
