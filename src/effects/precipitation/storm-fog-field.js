/**
 * THE STORM-FOG FIELD — flat atmospheric mist, deliberately NOT the curtain's
 * structured squall bands.
 *
 * ============================================================================
 * ⭐ WHY A SECOND FIELD, AND WHY IT MUST STAY UNBANDED
 * ============================================================================
 *
 * `squall-field.js`'s own header draws the line this module is on the other
 * side of: *"Sandstorm fronts, blizzard whiteout, hurricane rain sheets: the
 * same field at high amplitude and near-horizontal anisotropy. `fogDensity01`
 * and the grade stay upstream (the manager's axes) — the curtain is
 * *structured* obscuration; flat mist belongs to the mist axis."* (§3.4).
 * `curtain-render.js`'s own header repeats it for the vision boundary: *"flat
 * mist that hides things belongs to the manager's axis"*.
 *
 * So this field carries NO directional anisotropy and NO squall banding — it
 * is drifting, organic, domain-warped noise with one job: read as "the air
 * itself has gone hazy," not "a front of weather is passing over there." If
 * this field ever grows a `CELL_ANISOTROPY`-style stretch, it has become a
 * second squall field and the design boundary above has been violated.
 *
 * ============================================================================
 * NOISE SUBSTITUTION
 * ============================================================================
 *
 * Same substitution `effects/lighting/animations/fog.js` already documents:
 * `mx_fractal_noise_float` (MaterialX fBm) stands in for a bespoke value-noise
 * fBm — Foundry's own `fog.mjs` shader (client/canvas/rendering/shaders/
 * weather/fog.mjs) is the reference this ports, and its `mist()` function is
 * exactly this shape (domain-warped fBm, animated by scrolling the sample
 * position over time).
 *
 * ============================================================================
 * ⚠️ CONSTANTS BELOW ARE A REASONED FIRST PASS, NOT BENCH-MEASURED
 * ============================================================================
 *
 * `squall-field.js`'s own `CELL_FREQ` was wrong by 5× until rendered and
 * measured; the same discipline applies here and has not yet been done (no
 * `tools/shader-lab` bench exists for this field yet — see
 * mythica-machina-press#34/#314's own tracking for the follow-up). Treat
 * these as a defensible starting point, not an authority.
 *
 * @module effects/precipitation/storm-fog-field
 */
import { windFlowVectorNode } from '../../world/index.js';

/** World-px wavelength of the base mist bank, before domain warp. Roughly
 * midway between the squall field's own band width (~900px) and the cloud
 * field's deck scale (~1100px default) — mist banks read as bigger than a
 * squall band, smaller than a whole cloud deck. */
export const MIST_FREQ = 1 / 2200;

/** How strongly the base noise warps its own sample position — organic
 * roiling rather than a rigid grid, same technique `fog.js`'s `mist()` uses
 * (`p + mv`, `mv` itself an fBm of `p`). */
export const MIST_WARP_STRENGTH = 0.6;

/** World px/s the mist creeps downwind at a dead calm — mist drifts even in
 * still air (it is buoyant/diffusive, not blown), so this is never zero. */
export const MIST_CALM_DRIFT_PX_PER_SEC = 14;

/** Additional world px/s of drift per unit of `windSpeed01`, on top of the
 * calm floor above — a real gale visibly pushes mist banks across the map. */
export const MIST_WIND_DRIFT_PX_PER_SEC = 70;

/** ⭐ #314's own behaviour: *"thinning or clearing as wind speed rises."* At
 * `windSpeed01 = 1` the field is cut to this fraction of its calm density —
 * short of zero, so a genuine gale thins the mist without making "windy"
 * indistinguishable from "no fog axis at all". */
export const MIST_WIND_THIN_FLOOR = 0.15;

/**
 * Build the storm-fog density field as a TSL node, 0..1.
 *
 * ⚠️ TAKES `TSL` AND NODES, RETURNS A NODE — no uniforms, no state, no clock,
 * matching `buildSquallField`'s own contract for the identical reason: every
 * consumer already owns a world position, a time and the wind uniforms, and a
 * module that held its own copies would be a second place the wind could go
 * stale.
 *
 * @param {object} TSL
 * @param {object} inputs
 * @param {*} inputs.worldXY - vec2 node, world px.
 * @param {*} inputs.timeMs - float node.
 * @param {*} inputs.windDirDeg - float node, a compass bearing naming where
 *   the wind blows TOWARD (`world/wind-bake.js#windFlowVector`'s convention).
 * @param {*} inputs.windSpeed01 - float node, 0..1.
 * @returns {*} float node, 0..1 — 1 means "the air here is as thick as this
 *   field ever gets"; the caller's own intensity uniform is what decides how
 *   opaque that reads.
 */
export function buildStormFogField(TSL, { worldXY: rawXY, timeMs, windDirDeg, windSpeed01 }) {
  const { float, mx_fractal_noise_float: fbm, clamp } = TSL;

  const toward = windFlowVectorNode(TSL, windDirDeg);
  const t = timeMs.mul(float(0.001));
  const driftPxPerSec = float(MIST_CALM_DRIFT_PX_PER_SEC).add(windSpeed01.mul(float(MIST_WIND_DRIFT_PX_PER_SEC)));
  const drift = toward.mul(t.mul(driftPxPerSec));

  const p = rawXY.sub(drift).mul(float(MIST_FREQ));

  // Domain-warped fBm — the warp itself drifts on a SEPARATE slow time
  // offset so the warp and the base field never lock into a fixed relative
  // phase (the same "independent phase" idea `fbmVec3` exists for, applied
  // by hand here since only one channel is needed).
  const warp = fbm(p.add(t.mul(float(0.04))), 4, 2.0, 0.5, 1.0);
  const n = fbm(p.add(warp.mul(float(MIST_WARP_STRENGTH))), 4, 2.0, 0.5, 1.0);

  // mx_fractal_noise_float is signed (roughly -1..1, same convention
  // `squall-field.js#cell01` already remaps from its own single-octave
  // sibling) — remap to a density.
  const density01 = clamp(n.mul(float(0.5)).add(float(0.5)), float(0), float(1));

  const windThin = clamp(
    float(1).sub(windSpeed01.mul(float(1 - MIST_WIND_THIN_FLOOR))),
    float(MIST_WIND_THIN_FLOOR),
    float(1)
  );
  return density01.mul(windThin);
}
