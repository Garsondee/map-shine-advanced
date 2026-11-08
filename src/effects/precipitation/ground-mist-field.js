/**
 * THE GROUND MIST FIELD — what the `fogDensity01` weather axis draws (mmp-63o.1, 2026-11-07).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The Fog mood used to set a low stratus cloud and nothing else: there was no fog axis, and the only fog renderer
 * left (`storm-fog-render.js`) is rain's and snow's, zero below precip 0.6-0.7. The fog the author remembers looking
 * good was V2's `AtmosphericFogEffectV2` (deleted c328c9bd): macro banks with clear gaps between them, domain-warped
 * swirls, fog that hugs walls in its banks and pulls away from them in its gaps, thinning in wind. This is that
 * INTENT rebuilt in TSL as ground-level mist; none of V2's numbers survive (its GLSL is gone).
 *
 * ============================================================================
 * THE SHAPE: THREE SCALES, NO LOOPS OF OUR OWN
 * ============================================================================
 *
 *   BANKS  (~3400 px) where the fog lies and where the air is clear. At a low density only the banks show.
 *   BODY   (~1150 px) the roll of the fog inside a bank, domain-warped so it reads as fluid, never as a grid.
 *   WISPS  (~420 px)  torn strands stretched along the wind: the brush texture that keeps it from being a flat
 *                     grey overlay.
 *
 * All 2-D MaterialX fBm (`load-shader-pass-2026-11-02`: 3-D noise and JS-unrolled loops were what made shaders
 * explode). The octave loops are three's own WGSL loops.
 *
 * Density never reaches full opacity ({@link MIST_MAX_ALPHA}): a token standing in the fog must stay readable.
 * Never a vision input: this returns a picture, nothing reads it but the mist quad.
 *
 * @module effects/precipitation/ground-mist-field
 */
import { windFlowVectorNode, windStrength01Node, windAdvectionDtSecNode } from '../../world/index.js';

/** World-px wavelengths of the three scales (see the header). */
export const MIST_BANK_PX = 3400;
export const MIST_BODY_PX = 1150;
export const MIST_WISP_PX = 420;
/** How far (world px) the body field is pushed around by its own warp. */
export const MIST_WARP_PX = 650;
/** Wisps are this many times longer along the wind than across it. */
export const MIST_WISP_STRETCH = 2.6;

/** World px/s the mist creeps at a dead calm (fog is never quite still), and per unit of wind strength on top. */
export const MIST_CALM_DRIFT_PX_PER_SEC = 9;
export const MIST_WIND_DRIFT_PX_PER_SEC = 55;
/** How fast the fog's own shape evolves, in field units per second (independent of drift). */
export const MIST_EVOLVE_PER_SEC = 0.012;

/** Wind clears fog: at full strength the optical depth is cut to this share. */
export const MIST_WIND_THIN_FLOOR = 0.3;

/** The thickest the mist ever gets on screen. Short of 1 on purpose: tokens stay readable inside it. */
export const MIST_MAX_ALPHA = 0.78;
/** Optical depth per unit of density at the core of a bank. */
export const MIST_DEPTH_GAIN = 1.7;

/**
 * The coverage threshold for a density: the share of the field that is fog. Pure, Node-tested. At 0.2 only the tops
 * of the banks show (scattered patches), at 0.7 the banks join with clear gaps left, at 1 almost everything is fog.
 * @param {number} density01
 * @returns {number} the field value above which a pixel is fog.
 */
export function mistCoverThreshold(density01) {
  const d = Math.min(1, Math.max(0, Number(density01) || 0));
  return 0.78 - 0.7 * d;
}

/**
 * The thin, even haze laid under the banks — none at low density, a soft floor at high density so a dense fog has
 * no fully clear holes. Pure, Node-tested.
 * @param {number} density01
 * @returns {number} optical depth of the haze.
 */
export function mistHazeDepth(density01) {
  const d = Math.min(1, Math.max(0, Number(density01) || 0));
  return 0.38 * d * d;
}

/**
 * The mist's opacity for a field value and density, as the shader computes it (JS twin for tests and probes).
 * @param {number} field01 - the combined field, 0..1.
 * @param {number} density01
 * @param {number} [wind01=0] - wind strength 0..1 (already Beaufort-shaped).
 * @returns {number} 0..MIST_MAX_ALPHA
 */
export function mistAlpha(field01, density01, wind01 = 0) {
  const d = Math.min(1, Math.max(0, Number(density01) || 0));
  if (!(d > 0)) return 0;
  const f = Math.min(1, Math.max(0, Number(field01) || 0));
  const thr = mistCoverThreshold(d);
  const lo = thr - 0.16;
  const hi = thr + 0.24;
  const t = Math.min(1, Math.max(0, (f - lo) / (hi - lo)));
  const cover = t * t * (3 - 2 * t);
  const thin = 1 - (1 - MIST_WIND_THIN_FLOOR) * Math.min(1, Math.max(0, wind01));
  // (The shader also multiplies by its wisp strand, 0.72..1.27; this twin takes the strand's middle, 1.)
  const tau = (cover * (0.55 + 0.6 * f) + mistHazeDepth(d)) * d * MIST_DEPTH_GAIN * thin;
  return (1 - Math.exp(-tau)) * MIST_MAX_ALPHA;
}

/**
 * Build the mist as TSL nodes: its OPACITY and a 0..1 THICKNESS (for the shading). Takes TSL and nodes, holds no
 * uniforms or clock (the storm-fog field's contract, for the same reason: the caller owns world position, time and
 * the wind).
 *
 * @param {object} TSL
 * @param {object} inputs
 * @param {*} inputs.worldXY - vec2 node, world px.
 * @param {*} inputs.timeMs - float node.
 * @param {*} inputs.density01 - float node, the eased `fogDensity01` axis.
 * @param {*} inputs.windDirDeg - float node, compass bearing the wind blows TOWARD.
 * @param {*} inputs.windSpeed01 - float node, the dial 0..1.
 * @param {object} [inputs.advection] - the wind's integrated advection uniforms (see `storm-fog-field.js`).
 * @returns {{alpha: *, field: *, cover: *, strand: *}} float nodes (`strand` = the wisps, 0..1).
 */
export function buildGroundMistField(TSL, { worldXY, timeMs, density01, windDirDeg, windSpeed01: dial01, advection }) {
  const { float, vec2, clamp, smoothstep, exp, mx_fractal_noise_float: fbm, mx_fractal_noise_vec2: fbm2 } = TSL;
  const wind01 = windStrength01Node(TSL, dial01);
  const toward = windFlowVectorNode(TSL, windDirDeg);
  const t = timeMs.mul(float(0.001));
  const drift = advection
    ? advection.flowSec
        .mul(float(MIST_CALM_DRIFT_PX_PER_SEC))
        .add(advection.strengthFlowSec.mul(float(MIST_WIND_DRIFT_PX_PER_SEC)))
        .add(
          toward
            .mul(float(MIST_CALM_DRIFT_PX_PER_SEC).add(wind01.mul(float(MIST_WIND_DRIFT_PX_PER_SEC))))
            .mul(windAdvectionDtSecNode(TSL, timeMs, advection))
        )
    : toward.mul(t.mul(float(MIST_CALM_DRIFT_PX_PER_SEC).add(wind01.mul(float(MIST_WIND_DRIFT_PX_PER_SEC)))));
  const p = worldXY.sub(drift);
  const ev = t.mul(float(MIST_EVOLVE_PER_SEC));

  // BANKS — two octaves, slow. Signed fBm (about -1..1) to 0..1 with a soft band, so a bank has a wide shoulder.
  const bankN = fbm(p.div(float(MIST_BANK_PX)).add(vec2(ev, ev.mul(float(-0.7)))), 1, 2.0, 0.5, 1.0);
  const bank = smoothstep(float(-0.5), float(0.55), bankN);

  // BODY — domain-warped: the warp is its own vec2 fBm on a separate phase, so warp and body never lock.
  const warp = fbm2(p.div(float(MIST_BODY_PX * 1.6)).add(vec2(ev.mul(float(1.3)), float(3.7))), 1, 2.0, 0.5, 1.0);
  const bodyN = fbm(
    p
      .add(warp.mul(float(MIST_WARP_PX)))
      .div(float(MIST_BODY_PX))
      .add(vec2(float(11.3), ev.mul(float(-1.1)))),
    3,
    2.0,
    0.5,
    1.0
  );
  const body = clamp(bodyN.mul(float(0.55)).add(float(0.5)), float(0), float(1));

  // WISPS — stretched along the wind, sampled through the same warp so a strand follows the roll of the body.
  const across = vec2(toward.y.negate(), toward.x);
  const q = p.add(warp.mul(float(MIST_WARP_PX * 0.5)));
  const wispN = fbm(
    vec2(q.dot(toward).div(float(MIST_WISP_PX * MIST_WISP_STRETCH)), q.dot(across).div(float(MIST_WISP_PX))).add(
      vec2(ev.mul(float(2.0)), float(-5.1))
    ),
    2,
    2.0,
    0.5,
    1.0
  );

  const field = clamp(
    body
      .mul(float(0.62))
      .add(bank.mul(float(0.38)))
      .add(wispN.mul(float(0.17))),
    float(0),
    float(1)
  );

  const d = clamp(density01, float(0), float(1));
  const thr = float(0.78).sub(d.mul(float(0.7)));
  const cover = smoothstep(thr.sub(float(0.16)), thr.add(float(0.24)), field);
  const haze = d.mul(d).mul(float(0.38));
  const thin = float(1).sub(wind01.mul(float(1 - MIST_WIND_THIN_FLOOR)));
  // STRANDS STAY VISIBLE INSIDE A BANK: the wisps modulate the depth directly, not only through the coverage, so a
  // saturated bank still shows its brush texture instead of going flat grey.
  const strand = smoothstep(float(-0.55), float(0.55), wispN);
  const tau = cover
    .mul(field.mul(float(0.6)).add(float(0.55)))
    .add(haze)
    .mul(d)
    .mul(float(MIST_DEPTH_GAIN))
    .mul(thin)
    .mul(strand.mul(float(0.55)).add(float(0.72)));
  const alpha = float(1).sub(exp(tau.negate())).mul(float(MIST_MAX_ALPHA));
  return { alpha, field, cover, strand };
}
