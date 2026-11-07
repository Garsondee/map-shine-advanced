/**
 * effects/lighting/ambience-filter.js — Foundry's scene ENVIRONMENT adjustments on the map art (2026-11-07, mmp-ynr.4).
 *
 * Foundry v14's Scene → Environment tab has two blocks, BASE and DARK, each with hue/intensity (a tint), luminosity,
 * saturation and shadows. They are not light: they are a colour filter on the primary group — the map art, tiles and
 * tokens, BEFORE lighting multiplies it (`PrimaryCanvasGroupAmbienceFilter`, client/canvas/rendering/filters/
 * environment.mjs, configured in client/canvas/groups/environment.mjs#configureAmbienceFilter). DARK is blended in by
 * the darkness level when the day/night `cycle` is on.
 *
 * MSA never read them. Every v14 scene ships `dark.luminosity = -0.25`, which Foundry turns into ×0.8 on the art at
 * full darkness: on the light matrix at darkness 1, MSA's bare floor read 24.9 against Foundry's 18.9 and every light
 * cell sat ~25% brighter (tools/test-world/foundry-parity.mjs, 2026-11-07). 128 × 0.8 × 48/255 = 19.3.
 *
 * PORTED LINE FOR LINE. One difference: Foundry samples the darkness level PER PIXEL (its illumination texture, so a
 * darkness Region shifts it locally); MSA passes one scene darkness per frame, so the per-pixel blend in
 * `computeAmbienceParameters` runs here once on the CPU and the shader receives its five results. Darkness Regions
 * do not yet shift the filter (noted on mmp-ynr.4).
 *
 * Pure (no THREE import): `deriveAmbienceUniforms` + `ambienceParamsAt` + `applyAmbienceCpu` are the reference the
 * tests hold the TSL node (`buildAmbienceNode`) to.
 *
 * @module effects/lighting/ambience-filter
 */

/** Foundry's `BT709` luminance weights (base-shader-mixin.mjs CONSTANTS). */
export const BT709 = Object.freeze([0.2126, 0.7152, 0.0722]);

/** Foundry `Color.fromRGB` stores 8 bits per channel, truncating: `(r * 255) << 16`, `b * 255 | 0`. */
function quantize8(c) {
  return (Math.trunc(c * 255) & 0xff) / 255;
}

/** Foundry `Color#linear` (exact sRGB → linear), then stored again through `fromRGB` (8 bits). */
function colorLinear(rgb) {
  const toLinear = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  return rgb.map((c) => quantize8(toLinear(c)));
}

/** Foundry `Color.fromHSL([h, s, l])`, quantised to 8 bits as `fromRGB` does. */
export function colorFromHsl([h, s, l]) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hue = h * 6;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = l - chroma / 2;
  let rgb;
  switch (Math.floor(hue)) {
    case 0:
      rgb = [chroma, x, 0];
      break;
    case 1:
      rgb = [x, chroma, 0];
      break;
    case 2:
      rgb = [0, chroma, x];
      break;
    case 3:
      rgb = [0, x, chroma];
      break;
    case 4:
      rgb = [x, 0, chroma];
      break;
    case 5:
    case 6:
      rgb = [chroma, 0, x];
      break;
    default:
      rgb = [0, 0, 0];
  }
  return rgb.map((c) => quantize8(c + m));
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * The filter's uniforms from a scene's `environment` (`{cycle, base, dark}`), as `#configureAmbienceFilter` sets them.
 * @param {*} environment - `scene.environment` (or a plain copy of it).
 * @returns {{cycle: boolean, enabled: boolean, base: object, dark: object}}
 */
export function deriveAmbienceUniforms(environment) {
  const cycle = environment?.cycle !== false;
  const side = (e) => ({
    tint: colorLinear(colorFromHsl([num(e?.hue), 1, 0.5])),
    intensity: num(e?.intensity),
    luminosity: num(e?.luminosity),
    saturation: num(e?.saturation),
    shadows: num(e?.shadows),
  });
  const base = side(environment?.base);
  const dark = side(environment?.dark);
  const has = (e) => e.luminosity !== 0 || e.shadows > 0 || e.intensity > 0 || e.saturation !== 0;
  return { cycle, enabled: has(base) || (has(dark) && cycle), base, dark };
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Foundry's `computeAmbienceParameters()` at one darkness level `dl` (0..1): the five numbers the shader applies.
 * @param {ReturnType<typeof deriveAmbienceUniforms>} u @param {number} dl
 * @returns {{tint: number[], intensity: number, luminosity: number, saturation: number, shadows: number}}
 */
export function ambienceParamsAt(u, dl) {
  const { cycle, base, dark } = u;
  let tint;
  if (base.intensity > 0)
    tint = cycle && dark.intensity > 0 ? base.tint.map((c, i) => lerp(c, dark.tint[i], dl)) : base.tint;
  else if (dark.intensity > 0 && cycle) tint = dark.tint;
  else tint = [1, 1, 1];
  const luminosityBase = cycle ? lerp(base.luminosity, dark.luminosity, dl) : base.luminosity;
  const luminosity = luminosityBase * (luminosityBase >= 0 ? 1.2 : 0.8);
  const shadows = (cycle ? lerp(base.shadows, dark.shadows, dl) : base.shadows) * 0.15;
  const intensity = cycle
    ? lerp(base.intensity * base.intensity, dark.intensity * dark.intensity, dl)
    : base.intensity * base.intensity;
  const saturation = cycle ? lerp(base.saturation, dark.saturation, dl) : base.saturation;
  return { tint: tint.slice(), intensity, luminosity, saturation, shadows };
}

const srgb2linear = (c) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linear2srgb = (c) => (c < 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const luminance = (c) => BT709[0] * c[0] + BT709[1] * c[1] + BT709[2] * c[2];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Foundry `tintColorLinear(color, tint, intensity)`. */
function tintColorLinear(color, tint, intensity) {
  const t = luminance(tint);
  const c = luminance(color);
  const below = c <= t; // GLSL step(c, t) = 1 when c <= t
  const target = color.map((ci, i) => (below ? tint[i] * (c / t) : lerp(tint[i], 1, (c - t) / (1 - t))));
  return color.map((ci, i) => lerp(ci, target[i], intensity));
}

/**
 * The filter's `main()` on one opaque sRGB colour — the CPU reference for the shader.
 * @param {number[]} rgb - sRGB 0..1. @param {ReturnType<typeof ambienceParamsAt>} p @returns {number[]} sRGB 0..1.
 */
export function applyAmbienceCpu(rgb, p) {
  let c = rgb.slice();
  if (p.shadows > 0) {
    const l = luminance(c.map((v) => v * v));
    const k = Math.min(l / p.shadows, 1);
    c = c.map((v) => v * k);
  }
  if (p.luminosity !== 0) c = c.map((v) => v * (1 + p.luminosity));
  c = c.map(srgb2linear);
  if (p.saturation !== 0) {
    const g = luminance(c);
    c = c.map((v) => lerp(g, v, 1 + p.saturation));
  }
  c = p.intensity > 0 ? tintColorLinear(c.map(clamp01), p.tint, p.intensity) : c.map(clamp01);
  return c.map(linear2srgb);
}

/**
 * The live uniforms for {@link buildAmbienceNode}. `enabled` 0 returns the input exactly.
 * @param {*} TSL
 */
export function createAmbienceUniforms(TSL) {
  const { uniform, float, vec3 } = TSL;
  return {
    enabled: uniform(float(0)),
    tint: uniform(vec3(1, 1, 1)),
    intensity: uniform(float(0)),
    luminosity: uniform(float(0)),
    saturation: uniform(float(0)),
    shadows: uniform(float(0)),
  };
}

/**
 * Push one frame's filter: the scene's environment at MSA's darkness `dl`.
 * @param {ReturnType<typeof createAmbienceUniforms>} u
 * @param {ReturnType<typeof deriveAmbienceUniforms>} derived @param {number} dl
 */
export function setAmbienceUniforms(u, derived, dl) {
  const p = ambienceParamsAt(derived, Math.min(1, Math.max(0, num(dl))));
  u.enabled.value = derived.enabled ? 1 : 0;
  u.tint.value.set(p.tint[0], p.tint[1], p.tint[2]);
  u.intensity.value = p.intensity;
  u.luminosity.value = p.luminosity;
  u.saturation.value = p.saturation;
  u.shadows.value = p.shadows;
}

/**
 * The filter on an sRGB colour node (opaque art: MSA's albedo is not premultiplied). Each step is a no-op at its
 * identity value, as in Foundry's `if`s; `enabled` 0 returns `srgb` itself.
 * @param {*} TSL @param {*} srgb - vec3 node, sRGB. @param {ReturnType<typeof createAmbienceUniforms>} u
 * @returns {*} vec3 node, sRGB.
 */
export function buildAmbienceNode(TSL, srgb, u) {
  const { vec3, float, dot, min, max, mix, pow, select, step, clamp } = TSL;
  const bt = vec3(...BT709);
  const toLinear = (c) => select(c.lessThan(vec3(0.04045)), c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)));
  const toSrgb = (c) =>
    select(
      c.lessThan(vec3(0.0031308)),
      c.mul(12.92),
      pow(c, vec3(1 / 2.4))
        .mul(1.055)
        .sub(0.055)
    );
  // shadows (sRGB): rgb *= min(luminance(rgb²) / shadows, 1)
  const lum2 = dot(bt, srgb.mul(srgb));
  const shadowK = select(u.shadows.greaterThan(0), min(lum2.div(max(u.shadows, float(1e-6))), float(1)), float(1));
  const lit = srgb.mul(shadowK).mul(float(1).add(u.luminosity));
  // saturation (linear): mix(grey, rgb, 1 + saturation)
  let c = toLinear(lit);
  c = mix(vec3(dot(bt, c)), c, float(1).add(u.saturation));
  c = clamp(c, vec3(0), vec3(1));
  // tint (linear): tintColorLinear(c, tint, intensity)
  const t = dot(bt, u.tint);
  const l = dot(bt, c);
  const above = mix(u.tint, vec3(1), l.sub(t).div(max(float(1).sub(t), float(1e-6))));
  const below = u.tint.mul(l.div(max(t, float(1e-6))));
  const tinted = mix(c, mix(above, below, step(l, t)), u.intensity);
  c = select(u.intensity.greaterThan(0), tinted, c);
  return select(u.enabled.greaterThan(0.5), toSrgb(c), srgb);
}
