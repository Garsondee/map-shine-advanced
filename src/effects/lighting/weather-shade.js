/**
 * WEATHER SHADE — weather lit by the same light as the ground beneath it.
 *
 * Rain, splashes, the veil, storm fog, the torrent, gust ribbons, wind trails
 * and dust all draw AFTER the lighting multiply, into `scene.lit`. The scene's
 * own pixels are `colour × illum`; these are not, so a building's shadow (or a
 * cloud's, or a darkness region) darkened the cobbles and left the rain over
 * them glowing (author, 2026-10-27: "make weather particles, shader and wind be
 * darkened by building shadows").
 *
 * The global level is already handled: `environmental-light.js#sceneLightLevel`
 * dims every weather body by the outdoor ambient. This adds the LOCAL part —
 * how much darker this pixel's illumination is than that ambient — read from
 * `buf:scene.illum`, which already holds `ambient × sunVis × cloudVis + lights`.
 * So building shadows, cloud shadows and darkness regions all arrive through
 * the one buffer the ground uses, with no second shadow lookup to drift.
 *
 * ⚠️ DARKENS ONLY. A torch's pool reads as > 1 and clamps to 1 here: lighting
 * weather UP is the rain glint's job (`precip-glint.js`), and a second
 * brightening term would double it.
 *
 * @module effects/lighting/weather-shade
 */

/** The darkest a shade ever goes — a building's full shadow leaves ~15% of the sun, and rain in it is still rain. */
export const WEATHER_SHADE_MIN = 0.12;

/** Guards the division: below this the scene is pitch dark and `sceneLightLevel` already floors it. */
const SCENE_LIGHT_EPSILON = 0.02;

/**
 * The pure form, for Node tests and for anyone checking a probe by hand.
 * @param {number} illumLum - luminance of `buf:scene.illum` at the pixel.
 * @param {number} sceneLight01 - `sceneLightLevel` of the outdoor ambient.
 * @returns {number} WEATHER_SHADE_MIN..1; 1 when either input is unusable.
 */
export function weatherShade(illumLum, sceneLight01) {
  if (!Number.isFinite(illumLum) || !Number.isFinite(sceneLight01)) return 1;
  const s = illumLum / Math.max(SCENE_LIGHT_EPSILON, sceneLight01);
  return Math.min(1, Math.max(WEATHER_SHADE_MIN, s));
}

/**
 * The same, as a fragment-stage TSL node: one `screenUV` fetch of the illum
 * buffer (the same screen-sized target `scene.lit` is, which is why the bare
 * screen UV indexes it — `critter-surface.js` reads it identically).
 *
 * Returns `null` when there is no illum texture, so a caller compiles the term
 * OUT rather than multiplying by a one.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {{illumTexNode: *|null, uSceneLight: *}} args - the illum texture node,
 *   and a float uniform carrying this frame's `sceneLight01`.
 * @returns {*|null} float node, WEATHER_SHADE_MIN..1.
 */
export function buildWeatherShadeNode(TSL, { illumTexNode, uSceneLight }) {
  if (!illumTexNode) return null;
  const { float, screenUV } = TSL;
  const illum = illumTexNode.sample(screenUV).rgb;
  const lum = illum.x
    .mul(float(0.2126))
    .add(illum.y.mul(float(0.7152)))
    .add(illum.z.mul(float(0.0722)));
  return lum.div(uSceneLight.max(float(SCENE_LIGHT_EPSILON))).clamp(float(WEATHER_SHADE_MIN), float(1));
}
