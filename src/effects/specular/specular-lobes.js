/**
 * THE LOBES — the composed specular response, in plain JS. PURE: no THREE, no
 * TSL. `specular-render.js` transcribes this; `__tests__/specular-lobes.test.mjs`
 * MEASURES it.
 *
 * ============================================================================
 * WHY THIS EXISTS: "NOTHING IS VERY VISIBLE" IS A NUMBER, NOT AN OPINION
 * ============================================================================
 * Tiers 0-2 shipped physically-correct and radiometrically UNMEASURED, and the
 * author's first live report was *"nothing is very visible about it right now."*
 * The decode had a CPU twin (`specular-material.js`) and 73 assertions; the
 * COMPOSITION — what those numbers actually add to a pixel — had none. So the
 * one question that mattered ("how bright is this, in scene units?") was the one
 * question nothing could answer, and the honest move is to make it answerable
 * before touching the shader again.
 *
 * That is `feedback_smooth_output_hides_ported_bugs` applied one layer up: a
 * plausible-looking BRDF that returns 0.008 and a plausible-looking BRDF that
 * returns 0.4 are indistinguishable in code review and differ by "invisible"
 * versus "the product". Only a number tells them apart.
 *
 * ============================================================================
 * WHAT THE MEASUREMENT FOUND — the top-down specular problem, quantified
 * ============================================================================
 * Evaluating the shipped tier-2 chain for a polished surface under a noon sun:
 *
 *   THE SUN LOBE IS ~2000× OFF ITS OWN PEAK, EVERYWHERE.
 *   GGX peaks where `N·H = 1`, which needs the light at the mirror angle of the
 *   view. Top-down, V is ~straight up, so the peak needs the sun at the ZENITH.
 *   At the default 60° max elevation the half-vector sits ~15° off vertical, and
 *   for a polished α the lobe has already fallen from `1/(πα²) ≈ 199` to `≈0.11`.
 *   The shipped result was a fraction of a percent of scene brightness.
 *
 *   AND THE ONLY SURVIVING TERM IS SPATIALLY FLAT.
 *   The dome reflection is `envBRDF(F0, roughness, N·V) × domeRadiance`, and
 *   with a flat +Z normal `N·V` barely varies across the screen. So what little
 *   the pass produced was a uniform wash — the exact failure mode water hit, in
 *   a different quantity.
 *
 * Both are consequences of ONE fact, which this effect's own design doc proves
 * in §1.2: with a flat normal, `N·H` is a single number for the whole screen.
 * **No amount of gain fixes that** — turning it up makes the flat wash brighter,
 * which is V2's additive glow rebuilt at greater expense. The fix is per-pixel
 * NORMAL variation (the `relief` rung), which is what puts some pixels into the
 * lobe peak and leaves others dark. That is what a highlight IS.
 *
 * @module effects/specular/specular-lobes
 */

import { ggxDistribution, smithVisibility, schlickFresnel } from './specular-material.js';

/**
 * The multiplier applied to `skyHandle.key.strength` so the sun drives a
 * specular lobe with the irradiance it actually has relative to the sky dome.
 *
 * Derived, and the derivation matters because the first attempt got the
 * DENOMINATOR wrong. A clear midday sun delivers roughly 100 klx of direct
 * illuminance against roughly 20 klx from the whole sky dome — a ratio near 5.
 * `effects/sky-access.js` reports `key.strength` and `fill.strength` as
 * COMPOSITION weights, not radiometry: at clear noon those are `1` and
 * `FILL_SHARE = 0.42`. So the target is
 *
 *     key.strength · RATIO  =  5 · fill.strength
 *     1 · RATIO             =  5 · 0.42          ⇒  RATIO ≈ 2.1
 *
 * Setting it to 5 outright — which is what "the sun is 5× the sky" reads like
 * if you skip the algebra — actually drives the sun at 5/0.42 ≈ 12× the dome,
 * and measured as a 2.4× over-bright result. The number that looks like the
 * physical constant is not the number the code needs.
 *
 * ⚠️ This is a UNIT CONVERSION, not a gain knob. It exists because the handle's
 * numbers answer a different question from the one a BRDF asks, and the correct
 * place to reconcile that is once, here, named — not by an author discovering
 * that "sun glint" needs to sit at 4.
 */
export const SUN_IRRADIANCE_RATIO = 2.1;

/**
 * The same unit conversion for an INDOOR lamp: `buf:scene.illum` is a 0..1
 * illumination LEVEL, not irradiance, and a BRDF asks for the latter.
 *
 * Derived against the sun so the two worlds are on one scale: a fully-lit
 * outdoor surface receives `key·SUN_IRRADIANCE_RATIO + fill = 2.1 + 0.42`, and
 * `illum = 1` means exactly "as lit as this renderer gets" — Foundry's own
 * ladder tops out there whether the source is the sky or a torch. So a lamp at
 * full illumination should drive a lobe at the same ~2.5.
 *
 * Without it, measured, indoor metal under a torch came out at 0.054 against
 * outdoor metal's 0.39 — a sevenfold gap that is not physics, just two
 * quantities being fed to one equation in different units.
 */
export const LAMP_IRRADIANCE_SCALE = 2.5;

/**
 * THE SOURCE'S ANGULAR SIZE, added to `α` for PUNCTUAL lights only.
 *
 * ⚠️ **Without this a top-down highlight is a razor-thin contour that is both
 * invisible and aliased.** Measured on a polished surface: the sun lobe returns
 * 0.1 across the whole map and then **191** on the exact locus where the normal
 * bisects the light and the view — a one-pixel line, blown out, crawling as the
 * camera moves. That is what a delta light on a mirror physically IS. Real metal
 * escapes it by being CURVED, so the locus sweeps across a surface; a flat map
 * has no curvature to sweep with.
 *
 * Widening `α` is the standard area-light treatment and it needs NO extra energy
 * normalisation, because GGX's own `D` is already normalised (`∫D(h)(n·h)dh = 1`).
 * Widening therefore REDISTRIBUTES rather than adds: measured on the same
 * surface, the peak drops ~150× and the off-peak tail rises ~120×, which is
 * precisely the trade wanted — a readable band instead of a spike.
 *
 * 0.09 is a STYLISED size, not the real sun (whose angular radius is ~0.0047 rad
 * and would change nothing). It is quoted in α-space rather than degrees because
 * that is where it is used, and because pretending to a physical angle we then
 * ignore would be worse than naming the stylisation. Applies to the lamp lobe
 * too: a torch flame is a genuinely large, close source.
 */
export const SOURCE_ANGULAR_ALPHA = 0.09;

/**
 * The `α` a punctual lobe should actually use. Never below the material's own —
 * a source can only make a highlight broader, never tighter.
 * @param {number} alpha @returns {number}
 */
export function broadenedAlpha(alpha) {
  return Math.min(1, Math.max(alpha, alpha + SOURCE_ANGULAR_ALPHA));
}

/**
 * Karis's analytic fit to the split-sum environment BRDF ("Mobile" form, SIGGRAPH
 * 2013 course notes). Returns the scale/bias pair such that the reflectance of a
 * uniform environment is `F0 · scale + bias`.
 *
 * Used INSTEAD of a bare `schlickFresnel(F0, N·V)` for the dome, and the reason
 * is worth stating because the first version got it wrong in the interesting
 * direction: a rough surface does not reflect a uniform environment by its
 * normal-incidence Fresnel. Its microfacets present a spread of angles, some
 * grazing, and the correct integral accounts both for the grazing gain AND for
 * the single-scatter energy a rough lobe LOSES. Measured at `roughness = 0.4`,
 * `N·V = 0.99`, `F0 = 0.04`, this returns 0.034 where bare Schlick returns
 * 0.040 — i.e. it makes a rough dielectric slightly DIMMER, not brighter.
 *
 * That is a genuinely useful negative result: it rules out "the dome integral
 * was wrong" as the explanation for the invisible pass, and leaves the real
 * cause (a flat normal) with nowhere to hide.
 *
 * @param {number} roughness @param {number} nDotV
 * @returns {{scale: number, bias: number}}
 */
export function envBrdfApprox(roughness, nDotV) {
  const r = clamp01(roughness);
  const v = clamp01(nDotV);
  const rx = -r + 1;
  const ry = -0.0275 * r + 0.0425;
  const rz = -0.572 * r + 1.04;
  const rw = 0.022 * r - 0.04;
  const a004 = Math.min(rx * rx, Math.pow(2, -9.28 * v)) * rx + ry;
  return { scale: -1.04 * a004 + rz, bias: 1.04 * a004 + rw };
}

/**
 * The SUN lobe — one punctual light, the standard `D · Vis · F · N·L` product.
 *
 * @param {object} args
 * @param {number[]} args.normal - unit.
 * @param {number[]} args.viewDir - unit, surface → eye.
 * @param {number[]} args.lightDir - unit, surface → light.
 * @param {number[]} args.f0
 * @param {number} args.alpha - roughness².
 * @param {number[]} args.radiance - the light's own colour × strength.
 * @returns {number[]} additive RGB.
 */
export function sunLobe({ normal, viewDir, lightDir, f0, alpha, radiance }) {
  const h = normalize3(add3(lightDir, viewDir));
  const nDotH = dot3(normal, h);
  const nDotL = Math.max(0, dot3(normal, lightDir));
  const nDotV = Math.max(1e-4, dot3(normal, viewDir));
  const vDotH = Math.max(0, dot3(viewDir, h));
  if (nDotL <= 0) return [0, 0, 0];
  // The SOURCE's angular size, not the material's roughness — see
  // `SOURCE_ANGULAR_ALPHA`. The dome term deliberately does NOT get this: a
  // hemisphere is already as wide as a source can be.
  const a = broadenedAlpha(alpha);
  const brdf = ggxDistribution(nDotH, a) * smithVisibility(nDotL, nDotV, a) * nDotL;
  const f = schlickFresnel(f0, vDotH);
  return [f[0] * brdf * radiance[0], f[1] * brdf * radiance[1], f[2] * brdf * radiance[2]];
}

/**
 * The SKY DOME term — a uniform hemisphere, through the split-sum fit.
 *
 * @param {object} args
 * @param {number[]} args.f0 @param {number} args.roughness @param {number} args.nDotV
 * @param {number[]} args.radiance - the dome's colour × strength.
 * @param {number} [args.directional] - the clear-sky azimuthal gradient, 1 = flat.
 * @returns {number[]} additive RGB.
 */
export function domeTerm({ f0, roughness, nDotV, radiance, directional = 1 }) {
  const { scale, bias } = envBrdfApprox(roughness, nDotV);
  return [
    (f0[0] * scale + bias) * radiance[0] * directional,
    (f0[1] * scale + bias) * radiance[1] * directional,
    (f0[2] * scale + bias) * radiance[2] * directional,
  ];
}

/**
 * THE WHOLE COMPOSED RESPONSE for one pixel — what the shader adds to
 * `buf:scene.color`. This is the function the measurement suite drives.
 *
 * @param {object} args
 * @param {{f0: number[], roughness: number, alpha: number, presence: number, metalness: number}} args.material
 * @param {number[]} args.normal @param {number[]} args.viewDir
 * @param {number[]} args.keyDir @param {number[]} args.keyColor @param {number} args.keyStrength
 * @param {number[]} args.fillColor @param {number} args.fillStrength
 * @param {number} args.outdoors - 0..1.
 * @param {number[]} [args.lampDir] @param {number[]} [args.lampRadiance] @param {number} [args.lampGate]
 * @param {number} [args.strength] @param {number} [args.sunGlint] @param {number} [args.skySheen]
 * @param {number} [args.lampGlint] @param {number} [args.ambientSheen]
 * @returns {{rgb: number[], sun: number[], dome: number[], ambient: number[], lamp: number[], luma: number}}
 *   Broken out per term ON PURPOSE: "the total is too dim" is not actionable,
 *   "the sun lobe is 0.4% of the dome" is.
 */
export function composeSpecular({
  material,
  normal,
  viewDir,
  keyDir,
  keyColor,
  keyStrength,
  fillColor,
  fillStrength,
  outdoors,
  lampDir = [0, 0, 1],
  lampRadiance = [0, 0, 0],
  lampGate = 0,
  strength = 1,
  sunGlint = 1,
  skySheen = 1,
  lampGlint = 1,
  ambientSheen = 1,
}) {
  const nDotV = Math.max(0, dot3(normal, viewDir));
  const sun = scale3(
    sunLobe({
      normal,
      viewDir,
      lightDir: keyDir,
      f0: material.f0,
      alpha: material.alpha,
      radiance: scale3(keyColor, keyStrength * SUN_IRRADIANCE_RATIO),
    }),
    sunGlint
  );
  const dome = scale3(
    domeTerm({
      f0: material.f0,
      roughness: material.roughness,
      nDotV,
      radiance: scale3(fillColor, fillStrength),
    }),
    skySheen
  );
  // ⚠️ **THE TERM THAT WAS MISSING, AND THE REASON A GOLD ASTROLABE SHOWED
  // NOTHING** (found live, 2026-07-26 — the author's own screenshot). The
  // indoor branch had ONLY the directional lamp lobe below, gated on the
  // MAGNITUDE of illum's gradient. A room lit by nothing but ambient/global
  // fill — no torch placed close enough to the metal to create a local
  // gradient — has a gradient of essentially zero EVERYWHERE, so the entire
  // indoor branch measured to EXACTLY 0 regardless of the mask, the material,
  // or how bright the room actually was (`illum` can be 0.6 and the composite
  // is still 0 — asserted in `specular-lobes.test.mjs`).
  //
  // The fix is the ambient half indoors ALREADY has an exact outdoor twin:
  // `dome` above answers "how much does a rough/smooth F0 surface reflect of
  // a uniformly-lit environment this bright", for the sky. A room's ambient
  // fill IS such an environment — `illumHere` (passed as `lampRadiance`,
  // pre-`LAMP_IRRADIANCE_SCALE`; see that constant for the 0..1-level vs
  // irradiance unit fix) is exactly the "how bright is it here" scalar the
  // SAME split-sum integral wants, so this reuses `domeTerm` with NO
  // azimuthal bias (`directional` left at its default 1) — an ambient field
  // has no defined "toward the light" the way a clear sky does. UNGATED by
  // `lampGate`: a shiny surface in a lit room shows a flat sheen even with no
  // nearby point source to catch a sharp highlight FROM, exactly as real
  // metal does under diffuse light. The directional lamp lobe below is
  // additive ON TOP when a gradient exists, never a replacement for this.
  const ambient = scale3(
    domeTerm({
      f0: material.f0,
      roughness: material.roughness,
      nDotV,
      radiance: scale3(lampRadiance, LAMP_IRRADIANCE_SCALE),
    }),
    ambientSheen
  );
  const lamp = scale3(
    sunLobe({
      normal,
      viewDir,
      lightDir: lampDir,
      f0: material.f0,
      alpha: material.alpha,
      radiance: scale3(lampRadiance, LAMP_IRRADIANCE_SCALE),
    }),
    lampGlint * lampGate
  );

  const indoorPart = add3(ambient, lamp);
  const outdoorPart = add3(sun, dome);
  const rgb = [0, 1, 2].map(
    (i) => (indoorPart[i] + (outdoorPart[i] - indoorPart[i]) * clamp01(outdoors)) * material.presence * strength
  );
  return {
    rgb,
    sun: scale3(sun, material.presence * strength * clamp01(outdoors)),
    dome: scale3(dome, material.presence * strength * clamp01(outdoors)),
    ambient: scale3(ambient, material.presence * strength * (1 - clamp01(outdoors))),
    lamp: scale3(lamp, material.presence * strength * (1 - clamp01(outdoors))),
    luma: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
  };
}

/**
 * THE WORLD BASELINE over which the map art's own luminance is differenced to
 * find its painted slope (the `relief` rung).
 *
 * 8 world px — roughly the width of a mortar line between cobbles, which is the
 * scale of detail that reads as relief rather than as noise.
 *
 * ⚠️ **Fixed in WORLD px, and the zoom behaviour that falls out is a feature.**
 * The art is sampled from a SCREEN-sized buffer, so as the author zooms out this
 * baseline shrinks below one screen pixel, all four taps land in the same texel,
 * the gradient goes to zero and the relief fades cleanly back to the flat
 * tier-2 look. Zoom in and it returns. That is exactly the right behaviour —
 * detail you cannot see should not be shaded, let alone aliased — and it costs
 * nothing because it is what the sampling does anyway.
 */
export const RELIEF_BASELINE_PX = 8;

/**
 * The steepest slope the painted relief is allowed to imply, as `tan(θ)`.
 *
 * A hard-edged art boundary — the black outline around a tile, a wall edge —
 * has an enormous luminance gradient and would otherwise tip the normal past
 * the horizon, which both looks wrong and lets `N·L` flip sign. 0.6 is ~31°,
 * comfortably past the ~15° that catches a noon sun, so the clamp bounds the
 * artifact without preventing a highlight.
 */
export const RELIEF_MAX_SLOPE = 0.6;

/**
 * THE PAINTED RELIEF, as a normal. The artist has already painted every cobble,
 * plank, rivet and fold — including its lighting — so the luminance gradient of
 * the map art is an excellent proxy for surface slope, and a better one than a
 * generated normal map would be, because it is the relief the artist INTENDED.
 *
 * This is why the effect needs no `_Normal` mask: nothing is authored here that
 * was not already authored.
 *
 * @param {number} dLumaDx - Δ luminance across the world baseline, +x.
 * @param {number} dLumaDy - Δ luminance across the world baseline, +y.
 * @param {number} strength
 * @returns {number[]} a unit normal.
 */
export function reliefNormal(dLumaDx, dLumaDy, strength) {
  const k = Number.isFinite(strength) ? strength : 0;
  let sx = -dLumaDx * k;
  let sy = -dLumaDy * k;
  const len = Math.hypot(sx, sy);
  if (len > RELIEF_MAX_SLOPE) {
    sx = (sx / len) * RELIEF_MAX_SLOPE;
    sy = (sy / len) * RELIEF_MAX_SLOPE;
  }
  return normalize3([sx, sy, 1]);
}

/**
 * THE SYNTHESISED VIEW VECTOR, as `specular-render.js` builds it: an eye at
 * `heightRatio × visibleWidth` above the view centre.
 * @param {object} args
 * @param {number} args.offsetX - world px from the view centre.
 * @param {number} args.offsetY
 * @param {number} args.viewWidth @param {number} args.heightRatio
 * @returns {number[]} unit, surface → eye.
 */
export function synthesizedViewDir({ offsetX, offsetY, viewWidth, heightRatio }) {
  return normalize3([-offsetX, -offsetY, Math.max(1, viewWidth) * Math.max(0.05, heightRatio)]);
}

/** @param {number[]} a @param {number[]} b @returns {number} */
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** @param {number[]} a @param {number[]} b @returns {number[]} */
function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
/** @param {number[]} a @param {number} k @returns {number[]} */
function scale3(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}
/** @param {number[]} a @returns {number[]} */
function normalize3(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}
/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
