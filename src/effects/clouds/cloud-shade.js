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

/** Where the rim's edge gate starts allowing it through (on `alpha`, 0..1) —
 * below this, alpha is close enough to true transparency that rim is judged
 * to be at a real silhouette, not an internal seam. MEASURED, not guessed —
 * see the edge gate's own long comment at its call site for how this was
 * found (a bench view rendering `rim` in total isolation, and a second
 * rendering `alpha` beside it, showed alpha barely registers internal cell
 * structure at all while rim traces every seam). */
export const CLOUD_RIM_EDGE_GATE_LO = 0.05;

/** Where the gate fully closes, as a FRACTION of the recipe's own
 * `thicknessCap` — not an absolute alpha, because a thin type (altocumulus,
 * cap 0.55) never reaches the same absolute alpha a thick type (cumulus,
 * cap 1.0) does. */
export const CLOUD_RIM_EDGE_GATE_FRACTION = 0.16;

/** The silver lining's strength, multiplied by the sun's own colour.
 *
 * ⚠️ MUCH SMALLER THAN IT LOOKS LIKE IT SHOULD BE. `4·T·(1-T)` peaks at
 * exactly 1, and at 0.85 the rim alone put the sum past white everywhere the
 * cloud was half-thick — the first lit render came back as a blown-out sheet
 * with no tonal range at all. The rim is a HIGHLIGHT on top of a lit surface,
 * not a second light. Lowered again, 0.32 → 0.22, once the second lit render
 * showed rim + full sun + ambient still coinciding near clipping at a
 * cumulus crown ({@link CLOUD_HIGHLIGHT_KNEE} is the safety net under this,
 * not a substitute for keeping this honest). */
export const CLOUD_RIM_GAIN = 0.22;

/** How bright a thick interior is lifted, standing in for multiple scattering
 * (Wrenninge's progressive-octave approximation, collapsed to one term). */
export const CLOUD_MS_GAIN = 0.06;

/** The fine surface-grain noise's frequency, as a fraction of `scalePx`
 * (the recipe's own feature wavelength) — small, so grain reads as fine
 * surface texture much finer than a single cell, never a second cellular
 * pattern of its own. */
export const CLOUD_GRAIN_FREQUENCY = 0.07;

/** How strongly grain perturbs brightness, +/- this fraction at full weight
 * (before `grainWeight` scales it down for already-soft types). */
export const CLOUD_GRAIN_STRENGTH = 0.14;

/**
 * Where the highlight roll-off begins, on the max-channel value. Below this,
 * the output is byte-identical to the raw sum — most of a cloud's midtones
 * sit well under it and are never touched. Above it, {@link CLOUD_HIGHLIGHT_SOFTNESS}
 * takes over. Same soft-knee IDIOM as `bloom-render.js`'s own bright-pass
 * threshold (a gentle roll-in beats a hard step, "the classic grainy bloom
 * source"), applied here for the same reason: a sun-facing crown genuinely
 * CAN sum past 1.0 (full key + ambient fill + multi-scatter + a rim
 * highlight, all real and all wanted at once), and a hard clamp turns that
 * into a flat white plateau with no shape in it at all.
 */
export const CLOUD_HIGHLIGHT_KNEE = 0.82;

/** How hard the roll-off compresses above the knee. Higher = a flatter,
 * more forgiving top end; lower = closer to a hard clip. */
export const CLOUD_HIGHLIGHT_SOFTNESS = 2.2;

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
  const { float, vec2, vec3, mix, clamp, exp, max, min, dot, normalize, smoothstep, mx_noise_float } = TSL;

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
  //
  // ⚠️ `cells: false`, UNCONDITIONALLY, ON BOTH — and this was found by
  // rendering, not by reading, the same day as the edge gate above. The
  // SILHOUETTE (`cov`/`alpha`, read from the MAIN sample below, still fully
  // cellular) is not the only thing a Voronoi cell partition touches — this
  // module's own `height` comes from `thickness`, which is gated by `cov`,
  // which the cell partition carves into a sharp valley at every wall. That
  // valley is a REAL bump in the height field the normal is built from, and
  // ordinary physically-based shading has no way to know a cell wall is not
  // "real" 3D relief the way a cumulus billow is — it just lights whatever
  // slope it is handed. Rendering `diffuse` and `normalZ` in total isolation
  // (`dbg-diffuse`/`dbg-normalz`) confirmed this directly: BOTH traced the
  // entire wall network on their own, independent of the rim edge gate above
  // (which only ever touched `rim`, and left this untouched) — the "double
  // distorted white lines" the author reported survived a fully-gated rim
  // because the diffuse term was drawing its own ridge at every seam the
  // whole time.
  //
  // `cells: false` makes `base` exactly `per01` (`world/cloud-field.js`'s own
  // `let base = per01; if (cells) { ... }` — a JS-time branch, so this also
  // SKIPS the Worley evaluation entirely, one fewer noise tap per height
  // sample, not just a correctness fix). Erosion still runs when `detail` is
  // true, because it modifies `cov` from a SMOOTH Perlin base now, not a
  // cellular one — the fine cauliflower grain survives, only the sharp
  // cell-wall valley is gone. A cloud's LIGHTING now responds to the same
  // macro undulation its author-facing SILHOUETTE was always built from,
  // with the cell pattern legible as a coverage texture rather than
  // relitigated as false relief.
  const cheapOct = Math.max(2, Math.min(octaves, 3));
  const heightAt = (p, detail) =>
    buildField(TSL, {
      worldXY: p,
      uniforms: u,
      octaves: detail ? octaves : cheapOct,
      erode: !!detail,
      cells: false,
    }).height;
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
  const rimRaw = T.mul(float(1).sub(T)).mul(float(4)).mul(facing);

  // ⭐ THE EDGE-ONLY GATE — and the reason it exists at all is worth stating
  // plainly, because it was found by RENDERING, not by reading.
  //
  // `T*(1-T)` peaks at T=0.5 REGARDLESS OF SPATIAL CONTEXT — it cannot tell
  // "a cloud thinning out toward open sky" (a true silhouette edge, where the
  // silver lining is a real, wanted effect) from "a dip between two solid
  // lobes of the SAME connected mass" (an internal cellular seam, where
  // cloud continues on both sides). `world/cloud-field.js`'s own wall-breach
  // fix (2026-09-06) makes this worse by construction: a partially-breached
  // seam sits EXACTLY in the T = 0.3-0.7 range rim is most sensitive to, so
  // the fix that broke the wall's closed OUTLINE simultaneously lit up its
  // whole length with a bright rim glow — confirmed by the author
  // ("cells look even more obvious now... double distorted white lines").
  //
  // Rendering `rim` in total isolation (`tools/shader-lab/cloud-lab.js`'s
  // `dbg-rim` view) showed it tracing the ENTIRE cell-wall network, almost
  // pixel-for-pixel matching the coverage mask's own cellular structure —
  // not just the true outer silhouette. Rendering `alpha` (already computed,
  // above) alongside it showed the opposite: alpha barely registers internal
  // seams at all, because it is built from `thickness`, which the field
  // derives from how far `base` clears its threshold (`excess`) rather than
  // from the coverage mask's own binary in/out decision — a seam sits close
  // to threshold on EITHER side of a breach, so its `excess`, and therefore
  // its thickness and alpha, stay LOW, while true interior points (genuinely
  // deep in a cloud mass) accumulate much more excess. Alpha is therefore
  // the working proxy for "how close is this point to true transparency",
  // and gating rim by it (rather than by T alone) suppresses the seam glow
  // while preserving it at the real outer edge, where alpha genuinely falls.
  //
  // `edgeGateHi` is NOT a fixed absolute — it is proportional to
  // `thicknessCap`, because a THIN type (altocumulus, cap 0.55) never
  // reaches the same absolute alpha a THICK type (cumulus, cap 1.0) does;
  // gating on a fixed alpha would over-suppress rim everywhere on thin types
  // and under-suppress it on thick ones.
  const edgeGateHi = u.thicknessCap.mul(float(CLOUD_RIM_EDGE_GATE_FRACTION));
  const edgeGate = float(1).sub(smoothstep(float(CLOUD_RIM_EDGE_GATE_LO), edgeGateHi, alpha));
  const rim = rimRaw.mul(edgeGate).toVar('topsRim');

  // ── ASSEMBLY ──────────────────────────────────────────────────────────────
  const sunLit = colors.keyRgb.mul(diff.mul(shadow).mul(powderTerm));
  // The dome is above, so a face tilted up sees more of it.
  // ⚠️ THE AMBIENT IS A FILL, NOT A SECOND KEY. At 0.6 the sky dome alone
  // contributed up to 0.6 of blue on every upward-facing texel, which together
  // with a ~0.7 wrap-diffuse term put the whole cloud past white before the rim
  // was even added. An overcast dome is bright, but it is bright BECAUSE the
  // sun is behind it, and here the sun is already accounted for separately.
  const ambient = colors.fillRgb.mul(N.z.mul(float(0.5)).add(float(0.5))).mul(float(0.16));
  const ms = vec3(1, 1, 1).mul(smoothstep(float(0.35), float(0.9), T).mul(float(CLOUD_MS_GAIN)));

  // ── SURFACE GRAIN ─────────────────────────────────────────────────────────
  // Author, 2026-09-06, after the wall-structure fixes above: cumulus and
  // stratocumulus read as too smooth/glossy ("a bit 'blobby' in terms of the
  // smoothness of the light and shadow"). The macro-only height fix above
  // (see `heightAt`'s own header) fixed the WALL-TRACING problem by making
  // the NORMAL ignore cell/erosion detail entirely — correct for that bug,
  // but it also means nothing FINE-GRAINED perturbs the shading at all any
  // more, so a solid billow now lights as a perfectly smooth gradient, which
  // reads as glossy/plastic rather than as a cloud's own fine, non-uniform
  // surface.
  //
  // ⚠️ DELIBERATELY NOT DERIVED FROM THE CELL/EROSION FIELD — reaching for
  // either again would reintroduce exactly the wall-tracing artefact the
  // macro-height fix just removed, since both are keyed to the SAME Voronoi
  // structure. This is an INDEPENDENT noise, sampled at its own fine
  // frequency, with no relationship to cell placement at all — it perturbs
  // brightness UNIFORMLY across the whole surface, cell interiors and true
  // edges alike, which is what real fine cloud texture (unrelated to the
  // macro cellular pattern) looks like.
  //
  // Weighted DOWN for types that are already soft (`edgeWidth` high — cirrus,
  // stratus) and UP for types that would otherwise read as smooth/glossy
  // blobs (`edgeWidth` low — cumulus especially) — reusing an existing
  // recipe value as the "does this type need it" signal rather than adding a
  // redundant new one.
  const grainFreq = u.scalePx.mul(float(CLOUD_GRAIN_FREQUENCY)).max(float(1e-3));
  const grainNoise = mx_noise_float(vec3(worldXY.x.div(grainFreq), worldXY.y.div(grainFreq), u.boil.mul(float(0.4))));
  const grainWeight = float(1).sub(smoothstep(float(0.15), float(0.45), u.edgeWidth));
  const grain = float(1).add(grainNoise.mul(float(CLOUD_GRAIN_STRENGTH)).mul(grainWeight));

  const rgbRaw = sunLit
    .add(ambient)
    .add(ms)
    .add(colors.keyRgb.mul(rim.mul(float(CLOUD_RIM_GAIN))))
    .mul(grain);

  // ── THE HIGHLIGHT ROLL-OFF ────────────────────────────────────────────────
  // Scale ALL THREE CHANNELS BY THE SAME FACTOR (derived from the max channel,
  // matching `bloom-render.js`'s own "brightness = max channel... does not
  // desaturate coloured highlights" rule) rather than clamping each channel
  // independently — an independent per-channel clamp would desaturate a warm
  // sunset highlight toward white exactly where it should be most colourful.
  //
  // `min(peak, knee) + over/(1+over*softness)` is the whole compressor: below
  // the knee, `over` is 0 and this equals `peak` exactly (an identity, so nothing
  // south of the knee is touched); above it, `over` grows without bound while
  // the second term asymptotes, giving the "flatter and flatter" roll-off a
  // photographic highlight has instead of a hard cutout.
  const peak = max(max(rgbRaw.r, rgbRaw.g), rgbRaw.b);
  const over = max(peak.sub(float(CLOUD_HIGHLIGHT_KNEE)), float(0));
  const compressed = min(peak, float(CLOUD_HIGHLIGHT_KNEE)).add(
    over.div(float(1).add(over.mul(float(CLOUD_HIGHLIGHT_SOFTNESS))))
  );
  const rgb = rgbRaw.mul(compressed.div(max(peak, float(1e-4))));

  return { rgb, alpha, normalZ: N.z, thickness: T, diffuse: diff, shadow, rim };
}
