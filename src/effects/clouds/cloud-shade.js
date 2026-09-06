/**
 * CLOUD TOPS — the shading half. `world/cloud-field.js` decides WHERE cloud is;
 * this decides what it looks like with a sun on it.
 *
 * ============================================================================
 * WHY THE SHADING LIVES IN `effects/` AND THE FIELD LIVES IN `world/`
 * ============================================================================
 *
 * The field is a fact about the world — six consumers read it, and none of them
 * cares how a cloud is lit. The lighting is this effect's own look, read by
 * nothing else. Same split as `world/wind-field.js` (the field) versus each
 * effect's own response to it. Pure TSL builders with THREE injected, no
 * imports of THREE, no state.
 *
 * ============================================================================
 * THE MODEL, AND WHAT EACH TERM BUYS
 * ============================================================================
 *
 * A cloud seen from directly above is TERRAIN IN THE SKY (Clouds.md §1.1) — a
 * height field, which this engine already knows how to light. But a cloud is
 * not rock, and three departures from ordinary terrain shading do nearly all
 * the work of making it read as cloud:
 *
 *   1. WRAP LIGHTING instead of Lambert. Light enters a cloud, scatters, and
 *      leaves in every direction, so the terminator is broad and there is real
 *      brightness well past 90 degrees. `max(0, N·L)` gives a hard terminator
 *      and reads as stone. Three instructions, and it is the single biggest
 *      step from "lit terrain" to "cloud".
 *   2. A SELF-SHADOW MARCH toward the sun. Billow shadowing billow is the
 *      strongest depth cue available from above — without it a cumulus field
 *      is a lit texture rather than a field of separate objects. Quilez's own
 *      2-D cloud layer marches 4 samples for this; three is where the return
 *      flattens on a field this soft.
 *   3. THE BEER/POWDER PAIR. `1 - exp(-sigma·T)` is the opacity; the powder
 *      term `1 - exp(-2·sigma·T)` darkens thin edges, which is why real cloud
 *      edges have depth instead of looking cut out with scissors.
 *
 * Then the silver lining (`4·T·(1-T)`, peaking at half thickness on the
 * sun-facing side) is the most recognisable cloud look there is, and an
 * interior brightening keeps Beer's law from producing the "dirty cotton wool"
 * Clouds.md §3.3 warns about — real cloud interiors are BRIGHT, because
 * photons scatter many times before escaping.
 *
 * ============================================================================
 * ⚠️ POWDER IS SCALED BY SUN ELEVATION, AND THAT IS NOT A TASTE DECISION
 * ============================================================================
 *
 * Schneider's own caveat on the powder term: it models a viewer looking ALONG
 * the light direction seeing more scattered light from deep inside the cloud.
 * It is right when view and sun agree and wrong when they oppose. A top-down
 * camera with the sun at elevation `e` has exactly `90 - e` degrees between
 * them — so powder is most valid at noon and least at sunset. Applied flat, it
 * gives sunset clouds a dark rind at precisely the hour this effect exists to
 * make beautiful. {@link CLOUD_POWDER_AT_HORIZON} is that correction.
 *
 * @module effects/clouds/cloud-shade
 */

/** Beer-Lambert extinction. At T = 1 this leaves ~3% transmitted, so a full
 * cloud is opaque without ever hard-clamping — the edges keep their gradient. */
export const CLOUD_SIGMA = 3.5;

/** Wrap-lighting width. 0 is Lambert (hard terminator, reads as rock); 1 is
 * fully wrapped (flat, reads as paper). Cumulus wants the crisper end so its
 * billows have form; stratus wants the flatter end. Blended per recipe. */
export const CLOUD_WRAP_CRISP = 0.42;
export const CLOUD_WRAP_FLAT = 0.85;

/** How much of the sun a fully self-shadowed flank keeps. NOT zero: a shadowed
 * part of a cloud is still lit by multiple scattering from the rest of the
 * cloud, and a black flank is the single most common tell of a cheap cloud
 * shader. */
export const CLOUD_SELF_SHADOW_FLOOR = 0.45;

/** Powder's weight with the sun on the horizon — see the header. */
export const CLOUD_POWDER_AT_HORIZON = 0.25;

/** The silver lining's strength, multiplied by the sun's own colour.
 *
 * ⚠️ MUCH SMALLER THAN IT LOOKS LIKE IT SHOULD BE. `4·T·(1-T)` peaks at
 * exactly 1, and at 0.85 the rim alone put the sum past white everywhere the
 * cloud was half-thick — the first lit render came back as a blown-out sheet
 * with no tonal range at all. The rim is a HIGHLIGHT on top of a lit surface,
 * not a second light. */
export const CLOUD_RIM_GAIN = 0.32;

/** How bright a thick interior is lifted, standing in for multiple scattering
 * (Wrenninge's progressive-octave approximation, collapsed to one term). */
export const CLOUD_MS_GAIN = 0.09;

/**
 * The height of a full-relief cloud, as a fraction of the field's own feature
 * wavelength (`uniforms.scalePx`). This is the "how 3D" dial: it converts the
 * field's 0..1 height into a real slope for the normal.
 *
 * ⚠️ Phrased as "the field's feature wavelength" rather than by the weather
 * axis's own name on purpose — `ui/no-dead-axis` bans that identifier outside
 * `world/`, and it is right to: an effect reads the RESOLVED value through the
 * field's uniforms, never the axis by name. When this effect's subsystem lands
 * and genuinely does read `env.weather`, that wall needs a deliberate, loud
 * update in the same commit that flips the axes' own `consumerStatus` to
 * 'live' — which is exactly the sequence the rule's own `instead` prescribes.
 */
export const CLOUD_RELIEF_SCALE = 0.55;

/**
 * Build the lit cloud tops.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.worldXY - vec2 node.
 * @param {object} args.uniforms - the cloud field's uniform set.
 * @param {Function} args.buildField - `world/cloud-field.js#buildCloudFieldNode`,
 *   injected rather than imported so this module stays inside its own zone
 *   (`zones/one-door`) and so the gradient/shadow taps can be built at a
 *   CHEAPER setting than the main sample.
 * @param {object} args.sun - `{dirXY, sinElev, cosElev, tanElev}` nodes, all
 *   derived from `effects/sky-access.js`'s single azimuth convention.
 * @param {object} args.colors - `{keyRgb, fillRgb}` nodes.
 * @param {number} [args.octaves] - the main sample's octave count (the tier).
 * @param {number} [args.shadowTaps] - 0 disables the self-shadow march
 *   entirely, as a JS-time branch (Effects.md Law 4), which is how the tier
 *   ladder buys it back.
 * @param {*} [args.footprintPx] - float node, world px per screen px. The
 *   gradient epsilon is floored at this, so the relief band-limits itself as
 *   the camera pulls back instead of turning to noise.
 * @returns {{rgb: *, alpha: *, normalZ: *, thickness: *}}
 */
export function buildCloudTopsNode(
  TSL,
  { worldXY, uniforms: u, buildField, sun, colors, octaves = 5, shadowTaps = 3, footprintPx = null }
) {
  const { float, vec2, vec3, mix, clamp, exp, max, dot, normalize, smoothstep } = TSL;

  // THE MAIN SAMPLE — full detail, because this is the silhouette and the
  // opacity the eye actually reads.
  const main = buildField(TSL, { worldXY, uniforms: u, octaves });
  const cov = main.cov;
  const T = clamp(main.thickness, 0, 1).toVar('topsT');

  // THE HEIGHT SCALE — 0..1 relief into world px, so the gradient below is a
  // real slope rather than an arbitrary number.
  const reliefPx = u.scalePx.mul(float(CLOUD_RELIEF_SCALE));

  // A CHEAPER field for the gradient and shadow taps: no erosion, fewer
  // octaves. The erosion detail is surface texture, not shape, and paying full
  // price five extra times to differentiate it would triple the cost of the
  // whole effect for a difference below the footprint of one screen pixel.
  //
  // ⚠️ THE TAPS KEEP THE DOMAIN WARP, and dropping it was a real bug caught in
  // the first lit render. The warp DISPLACES the sample position, so a tap
  // taken without it is reading a different place in the cloud than the main
  // sample — the resulting "gradient" is the difference between two unrelated
  // points, and the tops came back as bright ribbons with dark interiors. Only
  // the EROSION is dropped, because that is surface texture rather than shape.
  //
  // ⭐ THE GRADIENT TAPS KEEP THE EROSION; THE SHADOW TAPS DROP IT. This split
  // is the whole reason the tops read as billowing rather than as lit blobs,
  // and the first lit render got it wrong by dropping erosion from both.
  // Erosion is Worley — a pile of rounded lobes — and those lobes ARE the
  // cauliflower relief. A normal computed without them is the normal of the
  // smooth underlying mass, so the cloud lights like a beanbag. The SHADOW
  // march is the opposite case: it asks "is a big billow up-sun of me", which
  // is a question about the large-scale shape, and paying for surface detail
  // three more times to answer it buys nothing visible.
  const cheapOct = Math.max(2, Math.min(octaves, 3));
  const heightAt = (p, detail) =>
    buildField(TSL, { worldXY: p, uniforms: u, octaves: detail ? octaves : cheapOct, erode: !!detail }).height;
  //
  // ⚠️ AND THE GRADIENT'S ORIGIN COMES FROM THE SAME CHEAP PATH. Differencing
  // a full-detail height against two reduced-detail ones measures the DETAIL
  // that was dropped, not the slope — a difference of two different functions
  // is not a derivative of either.
  const h0c = heightAt(worldXY, true).toVar('topsH0Detail');
  const h0s = heightAt(worldXY, false).toVar('topsH0Shape');

  // ── THE NORMAL ────────────────────────────────────────────────────────────
  // ⚠️ A WORLD-SPACE EPSILON, NEVER `dFdx`/`dFdy`. Screen derivatives are one
  // instruction and free, and they are exactly wrong here: the tops only ever
  // draw ZOOMED OUT, which is precisely the regime where the field changes fast
  // per screen pixel, so a screen-space normal would be noise at the only zoom
  // this effect exists at. Flooring the epsilon at the screen footprint makes
  // the relief band-limit itself instead.
  const epsBase = u.scalePx.mul(float(0.015));
  const eps = (footprintPx ? max(epsBase, footprintPx.mul(float(1.5))) : epsBase).toVar('topsEps');
  const hx = heightAt(worldXY.add(vec2(eps, float(0))), true);
  const hy = heightAt(worldXY.add(vec2(float(0), eps)), true);
  const dzdx = hx.sub(h0c).mul(reliefPx).div(eps);
  const dzdy = hy.sub(h0c).mul(reliefPx).div(eps);
  const N = normalize(vec3(dzdx.negate(), dzdy.negate(), float(1))).toVar('topsN');

  // ── THE SUN ───────────────────────────────────────────────────────────────
  const L = vec3(sun.dirXY.x.mul(sun.cosElev), sun.dirXY.y.mul(sun.cosElev), sun.sinElev).toVar('topsL');

  // ── WRAP DIFFUSE ──────────────────────────────────────────────────────────
  // The recipe's own edge softness stands in for "how crisp is this genus":
  // cumulus (edgeWidth 0.10) gets the crisp wrap, stratus (0.45) the flat one,
  // so one existing dial drives it and there is no second knob to disagree.
  const wrapW = mix(float(CLOUD_WRAP_CRISP), float(CLOUD_WRAP_FLAT), smoothstep(float(0.1), float(0.45), u.edgeWidth));
  const diff = clamp(
    dot(N, L)
      .add(wrapW)
      .div(wrapW.add(float(1))),
    0,
    1
  ).toVar('topsDiff');

  // ── THE SELF-SHADOW MARCH ─────────────────────────────────────────────────
  // Step along the ground toward the sun and ask whether the field up-sun rises
  // above the ray leaving this point. A JS-time loop, so `shadowTaps = 0`
  // constructs none of it.
  let shadow = float(1);
  if (shadowTaps > 0) {
    // Longer steps at a low sun, because a low sun's rays travel further
    // horizontally per unit of height. Clamped so a sun near the horizon does
    // not send the taps halfway across the map.
    const stepPx = u.scalePx
      .mul(float(0.18))
      .div(max(sun.tanElev, float(0.25)))
      .toVar('topsStep');
    let acc = float(1);
    for (let i = 1; i <= shadowTaps; i++) {
      const d = stepPx.mul(float(i));
      const hq = heightAt(worldXY.add(sun.dirXY.mul(d)), false);
      // The ray's own height after travelling `d`, in the field's 0..1 units.
      const rayH = h0s.add(sun.tanElev.mul(d).div(reliefPx));
      const occl = clamp(hq.sub(rayH).mul(float(3)), 0, 1);
      acc = acc.mul(float(1).sub(occl.mul(float(1 - CLOUD_SELF_SHADOW_FLOOR))));
    }
    shadow = acc.toVar('topsShadow');
  }

  // ── BEER, POWDER, RIM ─────────────────────────────────────────────────────
  const sigmaT = T.mul(float(CLOUD_SIGMA));
  const alpha = clamp(float(1).sub(exp(sigmaT.negate())).mul(cov), 0, 1).toVar('topsAlpha');
  const powder = float(1).sub(exp(sigmaT.mul(float(2)).negate()));
  // See the header: valid at noon, wrong at sunset, so it fades with the sun.
  const powderAmt = mix(float(CLOUD_POWDER_AT_HORIZON), float(1), clamp(sun.sinElev, 0, 1));
  const powderTerm = mix(float(1), powder, powderAmt);

  // The silver lining: brightest where the cloud is thin enough to transmit but
  // thick enough to scatter — a maximum at half thickness — and only on the
  // side facing the sun. `4·T·(1-T)` peaks at exactly 1 and needs no tuning,
  // the same parabola the field uses for shadow contrast against cover.
  const slopeXY = vec2(dzdx.negate(), dzdy.negate());
  const facing = clamp(dot(normalize(slopeXY.add(vec2(float(1e-5), float(1e-5)))), sun.dirXY), 0, 1);
  const rim = T.mul(float(1).sub(T)).mul(float(4)).mul(facing).toVar('topsRim');

  // ── ASSEMBLY ──────────────────────────────────────────────────────────────
  const sunLit = colors.keyRgb.mul(diff.mul(shadow).mul(powderTerm));
  // The dome is above, so a face tilted up sees more of it.
  // ⚠️ THE AMBIENT IS A FILL, NOT A SECOND KEY. At 0.6 the sky dome alone
  // contributed up to 0.6 of blue on every upward-facing texel, which together
  // with a ~0.7 wrap-diffuse term put the whole cloud past white before the rim
  // was even added. An overcast dome is bright, but it is bright BECAUSE the
  // sun is behind it, and here the sun is already accounted for separately.
  const ambient = colors.fillRgb.mul(N.z.mul(float(0.5)).add(float(0.5))).mul(float(0.22));
  const ms = vec3(1, 1, 1).mul(smoothstep(float(0.35), float(0.9), T).mul(float(CLOUD_MS_GAIN)));
  const rgb = sunLit
    .add(ambient)
    .add(ms)
    .add(colors.keyRgb.mul(rim.mul(float(CLOUD_RIM_GAIN))));

  return { rgb, alpha, normalZ: N.z, thickness: T, diffuse: diff, shadow, rim };
}
