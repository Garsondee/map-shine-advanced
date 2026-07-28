/**
 * THE MATERIAL DECODE — `_Specular`'s three channels read as a MATERIAL, plus
 * the BRDF scalars the lobes are built from. PURE: no THREE, no TSL, no
 * Foundry. `specular-render.js` is the TSL transcription of exactly this maths.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SHADER
 * ============================================================================
 * `feedback_smooth_output_hides_ported_bugs`: a shine effect produces a smooth,
 * plausible-looking result from almost ANY decode, correct or not. Gold that
 * comes out slightly green, or a mid-grey mask that comes out 30% metallic, is
 * invisible on screen and catastrophic to the authoring model — the author
 * would tune around it forever. So the decode is written ONCE here, in plain
 * JS, asserted against named cases in Node (`__tests__/specular.test.mjs`), and
 * the shader transcribes it. Same split as `lighting/sun-occlusion.js` (pure)
 * vs `lighting/sun-occlusion-render.js` (TSL).
 *
 * ============================================================================
 * ⚠️ V2 READ THREE CHANNELS AND USED ONE — the whole point of this module
 * ============================================================================
 * `legacy/compositor-v2/effects/specular-shader.js` did exactly this:
 *
 *     float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114));   // ← ONE scalar
 *     vec3 colored = maskRgb * (strength / maskLum);        // ← renormalised
 *     result = mix(neutral, colored, saturation);           // ← a global slider
 *
 * One degree of freedom, plus a hue that only ever multiplied the output. Every
 * property that would have made a highlight SPECIFIC to the thing it sits on —
 * how polished, how metallic, what the reflectance colour is — was a global
 * uniform, so a brass candlestick and a steel portcullis on one map shared a
 * single "grain angle" and a single "cluster density".
 *
 * That was not laziness, it was forced. The camera is orthographic and the map
 * is flat, so the half-vector `H = normalize(L + V)` is CONSTANT across the
 * whole screen and `N·H` — the entire angular content of every specular BRDF
 * ever written — is one number for every pixel. With no angular variation
 * available, `mask × light` is the only thing left, and V2's thirty shimmer
 * sliders are somebody building a normal map out of noise, by hand.
 * `docs/planning/Specular.md` §1.2 is that argument in full.
 *
 * ============================================================================
 * THE DECODE — glTF metallic-roughness, arrived at from the other end
 * ============================================================================
 * The mask is decomposed in HSV and each axis given a physical meaning:
 *
 *   HUE + SAT  → F0, the reflectance colour. This is LITERALLY what F0 is for a
 *                conductor: gold reflects gold, copper reflects copper, and a
 *                NEUTRAL grey reflects neutrally — which is steel, silver,
 *                pewter, chrome. An author who paints a coin gold gets a gold
 *                highlight because the painted colour IS the physical quantity.
 *   VALUE      → SMOOTHNESS. Brighter paint = more polished = tighter lobe.
 *                Dark grey is rough dark iron; near-white is chrome.
 *   VALUE≈0    → ABSENCE. The bottom of the range is the presence threshold.
 *
 * ⚠️ **SATURATION IS *NOT* METALNESS, AND BELIEVING IT WAS SHIPPED AN INVISIBLE
 * EFFECT (corrected 2026-07-26, on the author's first live report).**
 *
 * The first version read HSV saturation as metalness, on the reasoning that a
 * saturated reflectance is the defining optical property of a conductor. That
 * sentence is true and the inference from it is wrong, because it runs the
 * implication backwards: coloured ⇒ metal does not give uncoloured ⇒ dielectric.
 * **The commonest metal on any battlemap — steel — is GREY**, as are iron,
 * pewter, silver, chrome and lead. Under that decode every one of them landed at
 * `metalness = 0`, `F0 = 0.04`, and a 4% reflector viewed from directly above
 * returns essentially nothing. Measured end to end (`specular-lobes.test.mjs`):
 * grey steel came out at **0.016** of scene brightness — invisible — while gold
 * came out at 0.139 and looked fine. An effect that worked only for gold, and
 * a bug that a screenshot of a gold coin would have confirmed as working.
 *
 * So metalness is a SCENE-LEVEL choice (`SPECULAR_PARAMS.metalResponse`), not a
 * per-texel one, and that is the honest shape: the file is a METAL mask (the
 * catalog's own `meaning` says so), an author painting it is painting metal, and
 * "is the shiny thing on this map metal or wet glaze" is one statement about a
 * map rather than a property of each brushstroke. Nothing is lost — the mask's
 * chroma was never carrying metalness, it was carrying WHICH metal, and it still
 * does, through the hue.
 *
 * This is the glTF metallic-roughness workflow read backwards out of one file
 * instead of authored into three, and the compatibility with V2 is not luck:
 * V2's mask hue already multiplied the highlight, and a metal's F0 IS the
 * colour of its highlight, so the hue axis means the SAME THING in both
 * systems. The other two axes were free channels V2 collapsed. Nothing is
 * reinterpreted against its old meaning; two thirds of the signal is
 * un-discarded. A greyscale V2-era mask decodes to `metalness ≈ 0`,
 * `F0 ≈ 0.04` white, `roughness ≈ 0.4` — a modest neutral dielectric sheen,
 * which is what V2 drew.
 *
 * ⚠️ **COLOUR SPACE IS SPLIT ON PURPOSE, AND THE SPLIT IS THE DESIGN.**
 * `Effects.md` rule 7 says colour space is a property of the DATA. Here the one
 * file carries two KINDS of data:
 *
 *   F0 is RADIOMETRIC — it multiplies light — so the hue is sRGB-decoded to
 *   linear, exactly as glTF decodes a baseColor texture.
 *
 *   Metalness and roughness are AUTHORING CONTROLS, not radiometric
 *   quantities. They are read from the sRGB values as painted, because the S
 *   and V an author sets in a colour picker ARE these numbers. Linearising
 *   first would mean a 50% grey (0.216 linear) reads as 78% rough, and the
 *   author would spend the rest of their life compensating for a transfer
 *   function. glTF keeps metallic/roughness in linear non-colour channels for
 *   the same reason from the other direction: they are not colours.
 *
 * @module effects/specular/specular-material
 */

/**
 * Where the mask's VALUE is thresholded into presence, and over how wide a
 * ramp — both in mask value (0..1), not distance.
 *
 * ⚠️ **THE RAMP MUST BE WIDE ENOUGH TO ANTIALIAS.** Narrowing it to a
 * near-zero epsilon turns the test into a STEP FUNCTION: every interpolated
 * value above the edge reads fully present, the linear filter's whole
 * contribution is discarded, and the boundary lands hard on a texel edge. That
 * is jagged at any resolution and it is a real bug water shipped
 * (`WATER_PRESENCE_EDGE0/1` carries the same warning, learned the same way).
 *
 * The band is far NARROWER than water's (20/255 against 48/255) and the reason
 * is a genuine difference between the two masks, not a tuning preference:
 * water's R channel carries DEPTH, so a shallow shelf is legitimately painted
 * dark and should legitimately fade. Here a dark value already means "rough
 * dark iron" via `roughness` below — so a wide presence band would penalise
 * dark metal TWICE, once by fading it out and once by roughening it. 20/255
 * is enough to antialias an authored edge (the mask uploads at native
 * resolution, `MASK_IMAGE_SCALE = 1`) without eating the dark end of the
 * material range.
 */
export const SPECULAR_PRESENCE_EDGE0 = 1 / 255;
export const SPECULAR_PRESENCE_EDGE1 = 20 / 255;

/**
 * THE MASK IS A STRENGTH AND A TINT — V2's decode, and it is what the author
 * paints against.
 *
 * ⚠️ **THE ALPHA-MISSING FALLBACK IS LOAD-BEARING, NOT DEFENSIVE.** A greyscale
 * `_Specular` with no alpha channel is the common authoring case, and without
 * this branch every such map renders pure black — `strength = luma × 0`. V2
 * carried it (`specular-shader.js:247`) and so must this.
 */
export const SPECULAR_ALPHA_EPSILON = 1e-4;

/**
 * Rec.601 for STRENGTH, Rec.709 for the tint's own normalisation.
 *
 * Two different luma weightings in one decode looks like an oversight and is
 * not: 601 is what V2 measured strength with, so keeping it keeps every
 * existing `_Specular` file reading at the brightness its author saw; 709 is
 * the correct linear-light weighting for re-normalising a colour, which is what
 * the tint step does. Unifying them would silently re-expose every painted map.
 */
export const LUMA_601 = Object.freeze([0.299, 0.587, 0.114]);
export const LUMA_709 = Object.freeze([0.2126, 0.7152, 0.0722]);

/**
 * THE KEY LIGHT'S 3D DIRECTION, from the sky handle's own published fields.
 *
 * `effects/sky-access.js` publishes the key as a HORIZONTAL unit vector
 * (`dirX`, `dirY`) plus `elevationDeg`, because that is what its existing
 * consumer (shadow throw) needs. Lifting it to 3D is this one function so the
 * assembly exists ONCE — `wind-access.js`'s header names hand-assembly, not
 * wrong formulas, as the mechanism behind every field bug this project has had.
 *
 * Nothing here derives the sun from TIME; the handle already did that, once
 * (`world/sun.js`, the `env/one-sun` wall). This only changes coordinates.
 *
 * @param {{dirX: number, dirY: number, elevationDeg: number}} key
 * @returns {number[]} a unit 3-vector pointing FROM the surface TOWARD the key.
 */
export function keyLightDirection(key) {
  const el = ((Number(key?.elevationDeg) || 0) * Math.PI) / 180;
  const c = Math.cos(el);
  const s = Math.sin(el);
  const x = (Number(key?.dirX) || 0) * c;
  const y = (Number(key?.dirY) || 0) * c;
  const len = Math.hypot(x, y, s);
  return len > 1e-6 ? [x / len, y / len, s / len] : [0, 0, 1];
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Hermite smoothstep. Exported shape matches TSL's `smoothstep(e0, e1, x)`
 * argument order deliberately — the transcription is then line-for-line.
 * @param {number} e0 @param {number} e1 @param {number} x @returns {number} */
export function smoothstep(e0, e1, x) {
  const d = e1 - e0;
  if (Math.abs(d) < 1e-9) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / d);
  return t * t * (3 - 2 * t);
}

/**
 * THE COORDINATE TWIN — what `specular-render.js` computes for `maskU/maskV`
 * and `screenU/screenV`, in plain JS, at the quad's four corners.
 *
 * ============================================================================
 * WHY A TWIN AND NOT ANOTHER DEBUG CHANNEL
 * ============================================================================
 * The debug channels (`specular.js#SPECULAR_DEBUG_CHANNELS`) answer BINARY
 * questions superbly — "is this texture live at all" was settled in one glance
 * by channel 14. They are the wrong instrument for a MAGNITUDE: a UV ramp
 * cannot distinguish `viewSpanX = 8000` from `viewSpanX = 20000`, because 0.42
 * red and 1.0 red are the same impression on a screenshot, and a coordinate
 * being subtly offset looks exactly like one that is right.
 *
 * That is `feedback_measure_the_output_not_the_equation` arriving one level up:
 * having built a picture, the next thing needed was a NUMBER. This is the
 * number — the same arithmetic the shader does, run on the CPU where it can be
 * printed, diffed and asserted (`feedback_smooth_output_hides_ported_bugs`'s
 * "write the CPU twin from the same primitives").
 *
 * ⚠️ **`maskU` spans EXACTLY the content bounds, and that is provable rather
 * than hopeful — which is what makes a deviation diagnostic.** The subsystem
 * crops the quad to `rect.min + contentBounds × rect.size` and the shader maps
 * world back through the SAME rect, so the rect algebraically CANCELS: the
 * quad's left edge is `minU` and its right edge is `maxU`, whatever the rect
 * is. So a `maskUv` here that does NOT match `contentBoundsUv` (give or take
 * the AABB pad) means the two rects are not the same rect — the only way that
 * cancellation can fail — and that is a far sharper statement than "the mask
 * samples black".
 *
 * @param {object} args
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} args.maskRect
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} args.quadWorld -
 *   the cropped quad's own world AABB (`contentBoundsWorld`).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} args.viewRect
 * @returns {object} a printable mapping report.
 */
export function describeSpecularMapping({ maskRect, quadWorld, viewRect }) {
  const round = (n) => (Number.isFinite(n) ? +n.toFixed(4) : n);
  /** The shader's own two divisions, at one world point. @param {object} r
   * @param {number} x @param {number} y @returns {number[]|null} */
  const uvIn = (r, x, y) => {
    if (!r) return null;
    const w = r.maxX - r.minX;
    const h = r.maxY - r.minY;
    // Reported rather than guarded: a degenerate rect is exactly the failure
    // worth SEEING, and `Infinity` in the report says so louder than a 0 would.
    return [round((x - r.minX) / w), round((y - r.minY) / h)];
  };
  /** @param {object|null} r @param {object|null} q @returns {object|null} */
  const cornersIn = (r, q) =>
    r && q
      ? {
          bottomLeft: uvIn(r, q.minX, q.minY),
          topRight: uvIn(r, q.maxX, q.maxY),
        }
      : null;

  // `max(span, 1)` mirrors the shader's own floor on both spans — reporting the
  // raw subtraction would describe a quantity the GPU never actually uses.
  const viewSpanX = viewRect ? Math.max(viewRect.maxX - viewRect.minX, 1) : null;
  const viewSpanY = viewRect ? Math.max(viewRect.maxY - viewRect.minY, 1) : null;
  return {
    maskRect,
    quadWorld,
    viewRect,
    viewSpanX: round(viewSpanX),
    viewSpanY: round(viewSpanY),
    /** What the shader's `maskU/maskV` really are at the quad's corners. MUST
     * equal `contentBoundsUv` (± the AABB pad) — see this function's header. */
    maskUvAtQuadCorners: cornersIn(maskRect, quadWorld),
    /** What `screenU/screenV` are there. Anything outside 0..1 is CLAMPED in
     * the shader, which silently turns an off-screen read into a valid-looking
     * edge fetch — the illum/albedo/attr reads all go through this. */
    screenUvAtQuadCorners: cornersIn(viewRect, quadWorld),
  };
}

/**
 * THE MASK, DECODED — strength and tint, V2's algorithm.
 *
 * **"The darker the pixels in `_Specular`, the less shiny the surface is"** is
 * the author's own statement of the authoring contract, and this is it in code.
 * Nothing here is a material model: there is no F0, no metalness, no roughness.
 * A 2D top-down map has no angles for those to act on, and computing them
 * anyway is what made the previous version invisible four times over.
 *
 * The tint step is the part worth reading twice. A naive `rgb × strength` would
 * darken saturated paint twice — once for being dark, once for being coloured —
 * so instead the mask's RGB is **re-normalised to carry `strength` as its own
 * luma**. Gold and grey painted at the same brightness therefore return the
 * same amount of light, in different colours, which is exactly what "which
 * metal" should mean.
 *
 * @param {number} r @param {number} g @param {number} b - 0..1, RAW authored
 *   values. ⚠️ NOT sRGB-decoded: V2 uploaded this file `NoColorSpace` and every
 *   existing map was painted against that, so a "50% grey" texel means 0.5 and
 *   not 0.21. Applying a transfer curve here silently re-exposes every map.
 * @param {number} a - 0..1 alpha, or 0 when the file has no alpha channel.
 * @param {number} [saturation] - 0 = neutral white shine, 1 = the mask's own
 *   colour at full.
 * @returns {{strength: number, tint: number[]}}
 */
export function decodeSpecularMask(r, g, b, a, saturation = 1) {
  const luma601 = clamp01(r * LUMA_601[0] + g * LUMA_601[1] + b * LUMA_601[2]);
  const alpha = clamp01(a);
  const strength = alpha < SPECULAR_ALPHA_EPSILON ? luma601 : luma601 * alpha;

  const sat = Math.min(Math.max(saturation, 0), 2);
  // Guarded: a pure black texel has no hue to preserve and the divide would be
  // by zero. Its strength is 0 anyway, so the tint it returns is never seen —
  // but a NaN here would propagate through an additive blend into a permanent
  // black hole, which is the failure mode this codebase has paid for before.
  const luma709 = Math.max(r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2], 1e-4);
  const k = strength / luma709;
  const colored = [r * k, g * k, b * k];
  const t = Math.min(sat, 1);
  return {
    strength,
    tint: [
      strength + (colored[0] - strength) * t,
      strength + (colored[1] - strength) * t,
      strength + (colored[2] - strength) * t,
    ],
  };
}
