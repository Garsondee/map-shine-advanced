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
 * Dielectric F0 — the ~4% every non-metal reflects at normal incidence. The
 * standard value for the whole dielectric range (water 0.02, glass 0.04, most
 * stone/plastic 0.04–0.05); a single constant is correct within the precision
 * anyone can paint.
 */
export const DIELECTRIC_F0 = 0.04;

/**
 * The roughness floor. **0.089, not 0 and not 0.045.**
 *
 * At `roughness = 0` the GGX distribution's denominator collapses and `D → ∞`
 * at `N·H = 1`, which on a HALF-FLOAT target is not a bright highlight, it is
 * `Inf` — and `Inf × 0` downstream is `NaN`, which propagates to a black or
 * white pixel that no amount of parameter tuning explains. Filament's own
 * analysis gives 0.045 as the floor for fp32 and **0.089 for fp16**, and every
 * target in this renderer is `HalfFloatType` (`describeSceneColor`). Taking the
 * fp32 number on an fp16 pipeline is the exact kind of nearly-right constant
 * that produces sparkling white pixels on some hardware and not others.
 */
export const MIN_ROUGHNESS = 0.089;

/**
 * Default metalness — how far a painted texel behaves like a conductor rather
 * than a dielectric. High, because **the file is a metal mask** (see
 * `scene/mask-catalog.js`'s own `meaning` for this kind) and because a top-down
 * view of a 4% dielectric returns almost nothing (§ the header's correction).
 *
 * Exposed to the author as `SPECULAR_PARAMS.metalResponse` so a map whose shiny
 * things are genuinely glaze, glass or wet stone can dial the whole scene toward
 * dielectric. At 0.85 a neutral grey texel reaches `F0 ≈ 0.87`, which sits
 * between real steel (0.56) and real silver (0.97) — a bright, believable metal.
 */
export const DEFAULT_METALNESS = 0.85;

/**
 * How much of the physically-implied diffuse suppression is actually applied.
 *
 * ⚠️ **DELIBERATELY UNDER-PHYSICAL, and this is a product decision stated as
 * one.** A conductor has essentially NO diffuse albedo, so a texel at
 * `metalness = 0.85` should have its underlying colour cut by ~85%. That is
 * correct and it is not what we want: the map art IS the product, a GM painted
 * that gold filigree by hand, and replacing it wholesale with a reflection of a
 * flat sky trades authored detail for physics nobody asked for. Worse, the
 * arithmetic goes the wrong way on a mid-tone — `0.5×0.15 + 0.2 = 0.35` is
 * DARKER than the 0.5 it replaced, so full suppression makes painting the mask
 * dim the map.
 *
 * At 0.35 the metal still visibly stops being flat paint (the underlying art
 * loses about a third of its contribution where the reflection takes over) while
 * the net effect of painting the mask is always brighter, never darker.
 * The physical link between the two is real and is why they share one param; the
 * discount is why they are not the same number.
 */
export const METAL_DIFFUSE_SHARE = 0.35;

/** sRGB transfer decode, one channel. The IEC 61966-2-1 curve, not the 2.2
 * approximation — the linear toe matters at the dark end, which is exactly
 * where dark metals live.
 * @param {number} c 0..1 @returns {number} */
export function srgbToLinear01(c) {
  const x = clamp01(c);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * THE DECODE. One mask texel → one material.
 *
 * @param {number} r sRGB 0..1, as painted.
 * @param {number} g sRGB 0..1, as painted.
 * @param {number} b sRGB 0..1, as painted.
 * @param {number} [metalnessIn] - the SCENE's metalness, not a per-texel value.
 *   See {@link DEFAULT_METALNESS} and this module's own correction for why it
 *   is an argument rather than something read off the mask's saturation — that
 *   read is what made grey steel invisible.
 * @returns {{presence: number, metalness: number, roughness: number, alpha: number, f0: number[]}}
 *   `presence` 0..1 (antialiased coverage), `metalness` 0..1, `roughness`
 *   0..1 (already floored), `alpha` = roughness² (the GGX parameter), `f0`
 *   LINEAR RGB reflectance at normal incidence.
 */
export function decodeSpecularMaterial(r, g, b, metalnessIn = DEFAULT_METALNESS) {
  const rr = clamp01(r);
  const gg = clamp01(g);
  const bb = clamp01(b);

  const value = Math.max(rr, gg, bb);

  const presence = smoothstep(SPECULAR_PRESENCE_EDGE0, SPECULAR_PRESENCE_EDGE1, value);
  const roughness = Math.min(1, Math.max(MIN_ROUGHNESS, 1 - value));

  // ⚠️ **METALNESS IS SCALED BY VALUE, AND WITHOUT THAT THE AUTHORING MODEL
  // INVERTS.** Measured on the first pass at a flat scene metalness: dark grey
  // paint (value 0.3) came out at 1.06 of scene brightness while near-white
  // polished paint came out at 0.217 — **darker paint producing a FIVE TIMES
  // BRIGHTER result.** An author reaching for dark grey to say "dull, tarnished
  // iron" would have painted the single hottest thing on the map.
  //
  // The mechanism is not a bug in either term: `roughness = 1 − value` gives
  // dark paint a very BROAD lobe, and a broad lobe catches an off-mirror sun
  // that a polished razor lobe misses entirely. Both halves are correct physics.
  // What was missing is that a dark metal is dark BECAUSE it is tarnished or
  // oxidised, and an oxide layer is a dielectric — so its F0 genuinely falls.
  // Scaling metalness by value says exactly that, restores monotonicity with
  // what the author meant, and costs one multiply.
  const metalness = clamp01(metalnessIn) * value;

  // THE HUE AT FULL BRIGHTNESS, then linearised — glTF's baseColor→F0 step.
  // Dividing by `value` first is what separates hue from polish: without it a
  // dark copper would get a dark F0 AND a high roughness, double-counting the
  // same painted darkness. The author painted one thing; it means one thing.
  const inv = value > 1e-5 ? 1 / value : 0;
  const hueLinear = [srgbToLinear01(rr * inv), srgbToLinear01(gg * inv), srgbToLinear01(bb * inv)];

  const f0 = [
    DIELECTRIC_F0 + (hueLinear[0] - DIELECTRIC_F0) * metalness,
    DIELECTRIC_F0 + (hueLinear[1] - DIELECTRIC_F0) * metalness,
    DIELECTRIC_F0 + (hueLinear[2] - DIELECTRIC_F0) * metalness,
  ];

  return { presence, metalness, roughness, alpha: roughness * roughness, f0 };
}

/**
 * GGX / Trowbridge-Reitz normal distribution. The `α²` numerator form, so the
 * function is already normalised and needs no separate `1/π` bookkeeping at the
 * call site.
 * @param {number} nDotH @param {number} alpha roughness²
 * @returns {number}
 */
export function ggxDistribution(nDotH, alpha) {
  const a2 = Math.max(alpha * alpha, 1e-8);
  const c = clamp01(nDotH);
  const d = c * c * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

/**
 * Height-correlated Smith visibility (the `G / (4·N·L·N·V)` combination, so the
 * BRDF is `D · Vis · F` with no trailing division). Heitz 2014 via Filament.
 * @param {number} nDotL @param {number} nDotV @param {number} alpha roughness²
 * @returns {number}
 */
export function smithVisibility(nDotL, nDotV, alpha) {
  const l = Math.max(clamp01(nDotL), 1e-4);
  const v = Math.max(clamp01(nDotV), 1e-4);
  const a2 = alpha * alpha;
  const gv = l * Math.sqrt(v * v * (1 - a2) + a2);
  const gl = v * Math.sqrt(l * l * (1 - a2) + a2);
  return 0.5 / Math.max(gv + gl, 1e-6);
}

/**
 * Schlick's Fresnel, per channel.
 *
 * ⚠️ **At normal incidence this returns F0 — the MINIMUM — and a top-down
 * camera looks at normal incidence everywhere.** That is not a flaw in the
 * approximation, it is the physics of the shot, and it is precisely why
 * `specular-render.js` synthesises a finite eye height: with a genuinely
 * orthographic V, `1 − N·V` is 0 across the entire screen and this term is a
 * constant. See `docs/planning/Specular.md` §3.2.
 *
 * @param {number[]} f0 @param {number} cosTheta @returns {number[]}
 */
export function schlickFresnel(f0, cosTheta) {
  const c = clamp01(1 - clamp01(cosTheta));
  const c5 = c * c * c * c * c;
  return [f0[0] + (1 - f0[0]) * c5, f0[1] + (1 - f0[1]) * c5, f0[2] + (1 - f0[2]) * c5];
}

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
