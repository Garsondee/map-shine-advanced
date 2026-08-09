/**
 * FIRE — THE TSL MATERIAL. The column integral, built as a graph.
 *
 * THREE is INJECTED, never imported: this module sits under `effects/`, which
 * may not reach into `vt/`, and the viewer owns the GPU lifecycle. Same split
 * `candle-flame-render.js` and `lightning-render.js` already use.
 *
 * ============================================================================
 * WHY FIRES ARE GROUPED INTO SIZE CLASSES
 * ============================================================================
 *
 * Every shape term the slab integral needs — each slice's radius, temperature,
 * softness, absorption, billow amplitude, smoke mix — is a function of the
 * fire's own scale chain. There were two ways to get them into the shader:
 *
 *   (a) carry them as per-vertex attributes and combine them with the slice's
 *       height at runtime, so ONE draw call covers every fire; or
 *   (b) bake them as JS literals and give each SIZE CLASS its own material.
 *
 * (a) needs seven vertex buffers of the eight WebGPU guarantees, leaving one
 * spare for the rest of this effect's life, and moves ~10 float ops per slice
 * from compile time to every fragment. (b) needs one draw call per size class
 * — and a real map has one to three, because the classes are octaves of
 * diameter — while letting the compiler fold every slice constant.
 *
 * (b) wins on both axes, and it is the same trade `candle-flame-render.js`
 * makes when it bakes tier decisions as build-time `if`s. Per-fire variation
 * that genuinely differs WITHIN a class (colour, intensity, wind exposure,
 * floor, and a small in-class size correction) still rides on attributes, and
 * the packing stays at five buffers with three spare.
 *
 * ⚠️ If an eighth thing ever needs to reach a fragment, WIDEN AN EXISTING VEC,
 * do not add a buffer. `lightning-render.js` widened `strandBakeB` from vec3 to
 * vec4 for exactly this reason after a real compile failure at 12 buffers
 * ("Vertex buffer count (12) exceeds the maximum number of vertex buffers (8)")
 * that every Node test passed straight through while nothing drew.
 *
 * @module effects/fire/fire-render
 */
import { fbmFloat, fbmVec3, rotate2d } from '../lighting/animations/tsl-noise-toolkit.js';
import { fireRampStops, FIRE_SMOKE_RAMP, hexToRgb01, fireShearSeconds } from './fire-geometry.js';

/**
 * Size classes are OCTAVES of diameter: a class covers [d, 2d), so an in-class
 * size correction is at most ×2 and the shape terms baked from the class's
 * representative diameter stay visually right across it.
 */
export function fireSizeClass(diameterPx) {
  const d = Number.isFinite(diameterPx) && diameterPx > 0 ? diameterPx : 1;
  return Math.round(Math.log2(d) * 2) / 2;
}

/** The representative diameter a class bakes its shape terms from. */
export function fireSizeClassDiameter(sizeClass) {
  return 2 ** (Number.isFinite(sizeClass) ? sizeClass : 0);
}

/**
 * Roughly how many billow lobes fit around the fire's own circumference at
 * `lobeFreq` 1.
 *
 * ⚠️ THIS IS PER FIRE RADIUS, NOT PER QUAD. The first version multiplied the
 * quad-fraction coordinate directly, and since the quad is ~5× the fire radius
 * (it has to contain the sheared plume) the noise ran at ~26 cycles across the
 * fire instead of ~3. The result was a spiky sea-urchin silhouette rather than
 * cauliflower — the noise was fine, the frame of reference was wrong
 * (`feedback_normalization_erased_the_compared_axis`).
 *
 * ⚠️ RAISED 1.6 → 3.2, 2026-08-08, against the FIRST correctly-anchored live
 * render (the wobble/spike fixes earlier the same day) — author: "the spikey
 * bending exterior... doesn't really look like flames seen from above, it more
 * looks like flames seen from the side." At 1.6 the correct frame of reference
 * still left only a HANDFUL of lobes at typical fuel-bed turbulence, so octave
 * 1 (the lowest, largest-scale one — see `BILLOW_DIMINISH` below) drew a few
 * big rounded points radiating from a disc: a side-view cartoon-flame
 * silhouette, not a mottled cauliflower cloud. Doubling the base frequency
 * makes even octave 1 alone produce many small lobes instead of few large
 * ones — and, as a side effect, fixes the reported "moves very slowly" too:
 * marching a Z-phase through a coarse field visually reshapes a few big
 * features slowly no matter how fast the phase itself advances, while the
 * same phase rate reshapes many small features noticeably every frame.
 */
const LOBES_PER_RADIUS = 1.05;

/**
 * Octave falloff for the SILHOUETTE field. Deliberately below fBm's usual 0.5:
 * high octaves on a displacement term become thin tendrils, and the reference
 * image's lobes are fat and rounded. Lower diminish keeps the lobe COUNT while
 * killing the fringe.
 *
 * ⚠️ Nudged 0.22 → 0.28 alongside the `LOBES_PER_RADIUS` change above. At the
 * old base frequency, 0.22 was carrying almost the entire silhouette on octave
 * 1 alone (higher octaves were nearly invisible), which is the OTHER half of
 * why the shape read as a few big points rather than cauliflower texture. Now
 * that octave 1 itself is finer-grained, a little more of octaves 2-4 can
 * survive without reintroducing the thin-tendril fringe this constant exists
 * to suppress.
 */
const BILLOW_DIMINISH = 0.2;

/**
 * Domain-warp strength, in the SAME (already frequency-scaled) units as `sp`
 * — so this is a fraction of one noise "cycle" of displacement, not a pixel
 * count. 0 is a no-op (the plain single-fold field); ~1 is roughly a full
 * cycle of push, enough to visibly stretch/merge/split lobes rather than just
 * jitter their edges. Not yet measured against the reference image at
 * multiple values — read the PNGs before trusting this number.
 */
const DOMAIN_WARP_STRENGTH = 0.4;

/**
 * How far each warp level may ROTATE the domain, in radians at full noise
 * amplitude. This is the term that turns domain warping into visible swirl —
 * see the `swirl()` helper's own note. Around a third of a turn is enough to
 * read as a vortex overturning; much past a half turn the field starts to
 * shear through itself and the lobes tear into filaments.
 */
const SWIRL_RADIANS = 0.85;

/**
 * How fast the curl flow carries a parcel sideways, in world px per second of
 * flight. Sized against the plume's own rise: a campfire rises at ~215 px/s and
 * takes ~1 s to reach the top of its flame, so ~45 px/s of lateral swirl bends a
 * tongue noticeably over its life without tearing it off the fuel.
 */
const CURL_ADVECT_PX_PER_SEC = 45;

/**
 * How aggressively the billow field erodes the advected footprint, at the fuel
 * bed and at the flame tip. This is what turns one continuous burning sheet into
 * separate licking tongues as it rises — see the slice loop's own note.
 *
 * ⚠️ THE BASE VALUE IS NEGATIVE ON PURPOSE. `billow` is `1 − |fbm|`, so a
 * threshold below zero passes the entire field: the fuel bed burns across its
 * whole painted footprint with no holes punched in it. Anything above ~0 starts
 * eating into the base itself, and a fire that is already patchy where it meets
 * its own fuel never reads as roaring.
 */
const EROSION_AT_BASE = -0.15;
const EROSION_AT_TIP = 0.78;
const EROSION_SOFTNESS = 0.5;

/**
 * Wind lean (a roughly ±1.5 vec2) → px/s, so shear seconds land on real pixels.
 *
 * ⚠️ SIZED AGAINST THE PLUME'S OWN RISE SPEED, not picked, and lowered TWICE
 * against live evidence:
 *   420 — a full gust pushed the plume sideways ~630 px/s against a campfire's
 *         ~218 px/s of rise. The top slices sheared clean off and rendered as a
 *         detached ghost blob.
 *   120 — the plume stayed connected, but the author, watching it on a real
 *         map: *"fire shouldn't wobble sideways like this."*
 *    55 — with the quadratic shear and the organic damp below, a full gust now
 *         leans the TOP of the plume without the base moving at all.
 *   180 — 55 turned out to be an OVERCORRECTION. It was chosen while the base
 *         was still sliding, so it had to be small enough to hide that; once
 *         the h=0 anchor and the h² shear actually fixed the root cause, the
 *         effective lean (55 × 0.35 ≈ 19 px/s) was too weak to read as a plume
 *         bending at all. Author, 2026-08-09: *"you then have the plume get
 *         more effected by wind as it goes up so that the fire bends as it gets
 *         pushed by the wind."* The h² profile is what makes this safe to
 *         raise — every pixel of extra lean lands at the TOP of the plume, and
 *         the fuel bed is multiplied by h²=0 no matter how hard the wind blows.
 */
const WIND_PX_PER_SEC = 180;

/**
 * How much of the wind sample survives at ZERO ambient wind.
 *
 * ⚠️ `sampleWind` always returns a large ORGANIC gust term — it is a living
 * field, not a still one, and that is correct for grass and leaves. A FIRE in
 * still air must not wander: it is anchored to burning fuel. Damping the lean
 * hard means the plume responds to real wind while still air leaves it
 * standing, which is what the author saw was wrong live.
 */
const WIND_ORGANIC_DAMP = 0.35;
/** How fast the field is advected along its own vertical axis, in turns per
 * puff cycle. With the advecting sign in the sheet loop this is a RISE rate,
 * not a boil rate — raised from 0.55 because a fire that only simmers reads as
 * slow no matter how much structure it has. */
const BOIL_RATE = 1.15;

/**
 * How far apart in the noise's own third axis two sheets sit, per unit of
 * normalized height. Together with `BOIL_RATE`'s advecting sign this sets how
 * far a feature travels up the slab before it decorrelates — too small and the
 * whole column moves as one rigid block, too large and features die before they
 * visibly climb anywhere.
 */
const VERTICAL_ADVECT = 1.8;
/**
 * Stipple CELL SIZE in world px. The grain is a hash of a quantized cell, not a
 * per-pixel hash: at 0.42 cycles/px the first version was white noise, which
 * reads as sensor grain rather than as the reference image's dry-brush speckle.
 */
const STIPPLE_CELL_PX = 9;

/**
 * How much smoke density survives on the plume's own axis. A real plume's core
 * is hot, fast and optically thin; the thick opaque smoke is at the periphery.
 * Without this the smoke reads as an opaque lid over every fire seen from
 * above — see the slice loop's own note.
 */
const SMOKE_CORE_CLEAR = 0.16;

/**
 * Flame radiance gain. Fire is EMISSIVE and far brighter than the smoke around
 * it; combining the two by share alone made a physically-thin flame lose to a
 * physically-broad plume on area, which is not how looking at a fire works.
 *
 * ⚠️ IT ALSO DESTROYS THE BANDING IF IT IS TOO HIGH, which is the whole look.
 * At 2.4 every temperature above ~0.42 clipped to 255 and the core rendered as
 * one flat saturated yellow disc — the posterized isotherms were being computed
 * correctly and then thrown away by the clamp. The bands are the reference
 * image's defining feature, so the gain has to leave headroom for them; "bright"
 * is bloom's job downstream, not this term's.
 */
const FLAME_RADIANCE_GAIN = 1.8;

/**
 * THE HOT CORE, AND THE ONLY REASON FIRE CAN TRIP BLOOM.
 *
 * ⚠️ BLOOM'S DEFAULT THRESHOLD IS 4.0 (`BLOOM_PARAMS.threshold`, and the scene
 * is HDR precisely so light can exceed 1). Fire's core peaked at ~1.25 before
 * this, so it was not close — *"fires need a hot glow that is bright enough to
 * trigger bloom"* (author, 2026-08-09) was not a tuning request, it was a
 * report that the effect could never have bloomed at any setting.
 *
 * A flat multiply big enough to clear 4.0 would drag the whole ramp up with it
 * and flatten the posterized bands back into one hot smear — the failure the
 * gain was lowered to 1.25 to escape in the first place. So the boost is
 * STEEP IN TEMPERATURE instead: emission from a hot body goes as roughly T⁴
 * (Stefan-Boltzmann), which means the pale core screams past the threshold
 * while everything cooler than it barely moves.
 *
 *     radiance = ramp(T) × GAIN × (1 + BOOST × T^EXPONENT)
 *
 * The gate opens at T=0.72 and is full at T=1, so a white-hot core reaches
 * 1.8 × 6.5 ≈ 11.7 (a genuine highlight) while anything cooler keeps the ramp
 * colour it was given, untouched. And because
 * `T` here is the ALREADY-POSTERIZED scalar, the boost is quantized with it —
 * the bands stay hard-edged rather than being smeared by a smooth exponential.
 */
const FLAME_CORE_BOOST = 5.5;

/**
 * How strongly the billow field modulates TEMPERATURE, not just the silhouette.
 * Without this the interior of a flame is a smooth radial gradient with no
 * structure — every lobe reads as the same temperature as the gap beside it,
 * which is neither true nor what the reference image shows. Real lobes are
 * hotter at their cores.
 */
const NOISE_TEMP_INFLUENCE = 0.3;

/**
 * Cheap 2-D value noise: hash four cell corners and bilerp with a smoothstep
 * fade. Four hashes and ~20 ALU, against `mx_worley_noise_float`'s 27 lattice
 * hashes — this is the grain term, the fourth in a stack, and it does not get
 * to cost more than a whole fBm octave.
 *
 * ⚠️ THE INTERPOLATION IS THE POINT. The first version hashed `floor(p)`
 * directly with no fade, so every cell was a flat value and the soot flecks
 * rendered as hard SQUARES — the render read as JPEG blocking rather than as
 * the reference image's dry-brush speckle. A cell hash is not noise until
 * something smooths between cells.
 */
function cheapValueNoise(TSL, p) {
  const { vec2, float, floor, fract, dot, sin, mix } = TSL;
  const i = floor(p);
  const f = fract(p);
  // Smoothstep fade, the standard value-noise weighting.
  const u = f.mul(f).mul(float(3).sub(f.mul(float(2))));
  const h = (ox, oy) =>
    fract(sin(dot(i.add(vec2(float(ox), float(oy))), vec2(float(12.9898), float(78.233)))).mul(float(43758.5453)));
  return mix(mix(h(0, 0), h(1, 0), u.x), mix(h(0, 1), h(1, 1), u.x), u.y);
}

/**
 * Build the flame ramp as a nested `mix` chain over the sampled reference
 * stops. Generated from {@link fireRampStops} rather than hand-written so the
 * colour spec has exactly one home — the reference image's values live in
 * `fire-geometry.js` and this reads them.
 */
function buildFlameRamp(TSL, t, uHueShift) {
  const { vec3, float, smoothstep, mix } = TSL;
  const stops = fireRampStops();
  // Coldest stop is the base; mix upward toward each hotter stop in turn.
  let col = vec3(...stops.at(-1).rgb);
  for (let i = stops.length - 2; i >= 0; i--) {
    const lo = stops[i + 1].t;
    const hi = stops[i].t;
    col = mix(col, vec3(...stops[i].rgb), smoothstep(float(lo), float(hi), t));
  }
  // A hue nudge for non-wood fuels. Cheap: rotate green/blue against red rather
  // than a full RGB→HSV→RGB round trip, which would cost more than the ramp.
  return vec3(col.r, col.g.add(uHueShift.mul(float(0.35))), col.b.add(uHueShift));
}

/**
 * The smoke ramp. `t` is the same temperature scalar the flame ramp reads, so
 * hotter smoke (nearer the fire) is brighter and warmer — that single coupling
 * is most of why the reference image's smoke sits on the orange without a seam.
 * `grain` is the stipple; `whiteness` is rain making steam.
 */
function buildSmokeRamp(TSL, t, grain, uWhiteness, uSootGain, firelight) {
  const { vec3, float, smoothstep, mix, clamp } = TSL;
  const hi = vec3(...hexToRgb01(FIRE_SMOKE_RAMP.highlight));
  const mid = vec3(...hexToRgb01(FIRE_SMOKE_RAMP.mid));
  const lo = vec3(...hexToRgb01(FIRE_SMOKE_RAMP.shadow));
  const soot = vec3(...hexToRgb01(FIRE_SMOKE_RAMP.sootDark));

  // Cool smoke is grey; smoke still close to the flame is lit from below by it.
  let col = mix(lo, mid, smoothstep(float(0), float(0.25), t));
  col = mix(col, hi, smoothstep(float(0.22), float(0.5), t));

  // ⚠️ SMOKE NEAR A FIRE IS LIT ORANGE BY IT, and in an ADDITIVE pass that is
  // not a nicety — it is what makes smoke legible at all. Adding neutral grey
  // to a dark map produces a dirty smudge that reads as a stain rather than as
  // smoke (measured: the first sheared render put a brown-grey blob beside the
  // flame that looked like scorching). Adding WARM light reads as glow, which
  // is both what the reference image shows and what a real plume does above a
  // fire. `firelight` falls off away from the flame, so distant smoke still
  // goes cool and simply fades out.
  if (firelight) {
    col = mix(col, vec3(...hexToRgb01('#F79420')), clamp(firelight, float(0), float(0.72)));
  }
  // Sparse dark soot flecks, concentrated where the grain spikes — the reference
  // image's speckle. A threshold on cheap hash noise, NOT a Worley cell (which
  // is 27 lattice hashes, more than a whole 3-octave fBm — measured).
  const fleck = smoothstep(float(0.78), float(0.94), grain).mul(uSootGain);
  col = mix(col, soot, clamp(fleck, float(0), float(0.85)));
  // Rain turns smoke to steam, which is white.
  return mix(col, hi, uWhiteness);
}

/**
 * BUILD ONE FIRE MATERIAL.
 *
 * Everything in `slabPlan` and `sliceTable` is consumed by a JS-time `for`/`if`
 * here — never a uniform, never a TSL `Loop()`. Effects.md Law 4: if turning a
 * feature off does not shrink the compiled shader, it is not off. That is also
 * why a coverage-rung change is a material REBUILD rather than a uniform write.
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.uGlobalTimeMs - the shared clock. `time/one-clock`: never `performance.now()`.
 * @param {object} args.slabPlan - `fireSlabPlan(tier, coverageRung)`.
 * @param {Array} args.sliceTable - `fireSliceTable(plan, chain)`, TOP SLICE FIRST.
 * @param {object} args.chain - `fireScaleChain(classDiameter, mPerPx)` for this size class.
 * @param {number} args.quadHalfPx - this class's quad half-extent, for normalising.
 * @param {object} [args.windHandle] - `world/wind-access.js`. Omit for a wind-inert fire.
 * @param {*} [args.depthTexNode] - `buf:scene.depth`, UNSAMPLED. Omit for no occlusion.
 * @param {*} [args.depthFlagsTexNode] - the depth pass's flag payload.
 * @param {*} [args.maskTexNode] - the baked `_Fire` mask (`texture(fireMaskTexture)`,
 *   unbound). Omit and no fire in this batch is ever clipped — the same
 *   fail-open shape `depthTexNode` already uses.
 * @param {*} [args.uMaskRect] - vec4 uniform `(minX,minY,maxX,maxY)`, the world
 *   rect `maskTexNode` covers. Required if `maskTexNode` is given.
 * @returns {{material:*, uIntensity:*, uPosterize:*, uWindResponse:*, uWeather:*, uHueShift:*, uSootGain:*}}
 */
export function buildFireMaterial({
  THREE,
  uGlobalTimeMs,
  slabPlan,
  sliceTable,
  chain,
  quadHalfPx,
  windHandle = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  maskTexNode = null,
  uMaskRect = null,
}) {
  const TSL = THREE.TSL;
  const {
    Fn,
    uv,
    uniform,
    attribute,
    vec2,
    vec3,
    vec4,
    float,
    length,
    clamp,
    mix,
    abs,
    floor,
    sin,
    fract,
    dot,
    smoothstep,
    max,
    screenUV,
  } = TSL;

  const uIntensity = uniform(float(1));
  /** 0 = smooth realistic ramp, 1 = hard cel bands. The reference wants high. */
  const uPosterize = uniform(float(0.85));
  const uWindResponse = uniform(float(1));
  /** (tempScale, heightScale, whiteness, alive01) — `fireWeatherResponse`'s output. */
  const uWeather = uniform(vec4(1, 1, 0, 1));
  const uHueShift = uniform(float(chain.hueShift ?? 0));
  const uSootGain = uniform(float(clamp01(chain.soot01 ?? 0.4)));
  /**
   * How loudly smoke reads in THIS pass.
   *
   * ⚠️ SMOKE IS IN THE WRONG BLEND MODE HERE AND THIS VALUE IS THE INTERIM.
   * Smoke does not emit — it occludes and scatters — but an ADDITIVE pass can
   * only ever add light, so drawing smoke grey adds grey and reads as glowing
   * fog over a dark map. Most of smoke's real job here is done by
   * transmittance (it genuinely dims the flame beneath it); what is left is a
   * faint scatter of firelight, hence a gain well under 1.
   *
   * The correct fix is a SECOND, alpha-blended pass for smoke, which is what
   * V2 did (flame additive, smoke NormalBlending) and what lets smoke actually
   * darken and desaturate the map beneath it. Recorded as the next structural
   * step rather than faked with a bigger number here.
   */
  const uSmokeGain = uniform(float(0.3));

  // ── PER-VERTEX, FIVE BUFFERS TOTAL (position, uv, center, colorIntensity, fireParams) ──
  const aCenter = attribute('center', 'vec2');
  const aColorIntensity = attribute('colorIntensity', 'vec4');
  /** (diameterPx, windExposure, expectedDepth, maskClip) */
  const aFireParams = attribute('fireParams', 'vec4');

  const material = new THREE.NodeMaterial();

  material.fragmentNode = Fn(() => {
    // Quad-fraction coordinate, −1..1, centred on the fire. The quad is CENTRED
    // on the fire by construction (`computeFireQuadArrays`), so the plume spine
    // has no uniform that could move its root off the fuel — the same hard
    // guarantee the candle's baked-in wick gives.
    const q = uv().sub(vec2(0.5, 0.5)).mul(float(2)).toVar();

    // In-class size correction. A class spans one octave of diameter, so this
    // lands in roughly [0.71, 1.41] and never distorts the baked shape terms
    // beyond what a same-class fire should look like.
    const sizeFix = aFireParams.x.div(float(Math.max(chain.diameterPx, 1e-3))).toVar();

    // A stable per-fire phase so neighbouring fires never puff in unison.
    const seed = fract(sin(dot(aCenter, vec2(float(12.9898), float(78.233)))).mul(float(43758.5453))).toVar();
    const puffPhase = uGlobalTimeMs
      ? uGlobalTimeMs.mul(float(chain.puffHz / 1000)).add(seed.mul(float(97)))
      : seed.mul(float(97));

    // ── WIND, SAMPLED ONCE PER FRAGMENT, NOT PER SLICE ──
    // The lean is a per-FIRE quantity; every slice scales the same vector by its
    // own time-of-flight. Sampling inside the slice loop would multiply the wind
    // field's cost by N for no additional information.
    let leanFrac = vec2(0, 0);
    if (windHandle && slabPlan.hasShear) {
      const gust = windHandle.node(TSL, {
        centerXY: aCenter,
        time: uGlobalTimeMs,
        exposure: aFireParams.y,
      });
      // gust → px/s → (× shear seconds, per slice) → px → quad fraction.
      leanFrac = gust.mul(uWindResponse).mul(float((WIND_PX_PER_SEC * WIND_ORGANIC_DAMP) / Math.max(quadHalfPx, 1e-3)));
    }

    // ── THE M SHEETS — the only expensive nodes in this graph ──
    // `.toVar()` is mandatory: without it a sheet read by two slices is
    // re-evaluated per read, and the M/N split silently becomes an N/N one
    // (Effects.md §3.2 — the whole point of this design would evaporate with
    // no error and no visual difference, only cost).
    // Frequency is expressed PER FIRE RADIUS and then converted into the quad's
    // frame — see LOBES_PER_RADIUS for the frame-of-reference bug this avoids.
    const radiusFrac = Math.max(chain.diameterPx / 2 / Math.max(quadHalfPx, 1e-3), 1e-3);
    const noiseFreq = float((LOBES_PER_RADIUS * (chain.lobeFreq ?? 1)) / radiusFrac);
    // ==========================================================================
    // CURL UPON CURL — TWO NESTED ROTATE-AND-DISPLACE WARPS, HOISTED
    // ==========================================================================
    //
    // ⚠️ DISPLACEMENT ALONE WAS NOT ENOUGH, AND THE MISSING INGREDIENT IS
    // ROTATION. The previous version warped the sample coordinate by a single
    // noise vector — real domain warping, and it did break up the radial
    // symmetry — but a pure translation field stretches and pinches lobes
    // without ever turning them, so the result still read as wobbling tendrils
    // rather than fire. Author, 2026-08-09: *"we need an organic morphing moving
    // distorting and curl noise upon curl noise swirling shape."*
    //
    // SWIRL is what a curl (divergence-free) field has and a displacement field
    // does not. True curl noise costs three fbm samples per level (a
    // finite-difference gradient of a potential, rotated 90°). This gets the
    // same READ for one call: the noise's own channels drive a ROTATION of the
    // domain about the plume's axis. A spatially- and time-varying rotation
    // about the axis IS a vortex — and a vortex is the one thing unambiguously
    // legible from directly overhead, which is this camera's whole problem.
    //
    // Applied TWICE, the second fed by the first — the classic iterated warp
    // (`fbm(p + fbm(p + fbm(p)))`) that makes a field churn and fold into itself.
    //
    // ⚠️ HOISTED OUT OF THE SHEET LOOP, AND THAT IS A 10× COST DIFFERENCE, NOT A
    // TIDY-UP. The first version computed both warp levels INSIDE the per-sheet
    // loop with `fbmVec3` (three channels × two octaves = six noise evaluations
    // per level), so a 3-sheet plan paid 36 evaluations per fragment for what is
    // physically ONE flow field. Measured on the reference machine: 0.11 ms →
    // **1.52 ms** for a single 300 px fire, against a 2.5 ms budget for every
    // effect on screen — which is exactly the *"lots of fires across a large map
    // ... horrible performance loss"* the author warned about. The swirl is a
    // property of the COLUMN, not of a sheet: the sheets already decorrelate
    // vertically through their own `sz` offset when they sample the main field,
    // so they can all share one warped coordinate. Hoisted, and with the cheap
    // scalar `fbmFloat` doing the broad level (rotation needs ONE channel, not
    // three), this is 5 noise evaluations per fragment instead of 36.
    //
    // ⚠️ EVERY LEVEL ADVANCES ON `puffPhase`, WHICH IS WIND-INDEPENDENT. A fire
    // in a sealed room must still be alive: *"Even in zero wind environments you
    // need to make them move."* Wind BENDS the plume (`leanFrac`); it is not
    // what makes it churn.
    const warpTime = puffPhase.mul(float(BOIL_RATE * 0.75));
    const baseP = q.mul(noiseFreq);
    // Level 1 — broad, slow, ROTATION ONLY. A scalar fbm is a third the cost of
    // the vec3 and an angle is all this level needs; the displacement it would
    // have added is indistinguishable once level 2 displaces anyway.
    const spinA = fbmFloat(TSL, vec3(baseP.x.mul(float(0.55)), baseP.y.mul(float(0.55)), warpTime.add(float(19.7))), {
      octaves: 2,
      diminish: 0.5,
    });
    const p1 = rotate2d(TSL, baseP, spinA.mul(float(SWIRL_RADIANS)));
    // Level 2 — finer, faster, fed by level 1, and the one that both turns AND
    // displaces. `.z` is the angle, `.xy` the offset: one call, three channels,
    // no wasted work.
    const w2 = fbmVec3(
      TSL,
      vec3(p1.x.mul(float(1.9)), p1.y.mul(float(1.9)), warpTime.mul(float(1.7)).add(float(51.3))),
      {
        octaves: 1,
        diminish: 0.5,
      }
    );
    const p2r = rotate2d(TSL, p1, w2.z.mul(float(SWIRL_RADIANS * 0.6)));
    const warpedBase = vec2(
      p2r.x.add(w2.x.mul(float(DOMAIN_WARP_STRENGTH))),
      p2r.y.add(w2.y.mul(float(DOMAIN_WARP_STRENGTH)))
    ).toVar();

    const sheets = [];
    for (let m = 0; m < slabPlan.M; m++) {
      const sheetH = (m + 0.5) / slabPlan.M;
      // Squared, matching the slice table's own shear — see `shearK`'s note in
      // fire-geometry.js. A sheet that sheared linearly while its slices
      // sheared quadratically would slide the NOISE against the SHAPE.
      // Applied in the already-frequency-scaled space the warp works in, since
      // the warp is now shared rather than recomputed per sheet.
      const sheetShearSec = fireShearSeconds(sheetH * sheetH, chain.heightPx, chain.riseSpeedPx);
      const sp = warpedBase.sub(leanFrac.mul(float(sheetShearSec)).mul(noiseFreq));
      // ⚠️ THE SIGN HERE IS WHAT MAKES THE FIRE PULL UPWARD, and it used to be
      // wrong. `+ h·K + t·rate` boils the field in place: every height churns,
      // but nothing ever travels between heights, so from above the fire seethes
      // without ever reading as FLOW. Advecting instead — `h·K − t·rate` — means
      // the field a slice sees at time t is the one the slice BELOW it saw a
      // moment ago, so a feature is handed upward through the stack. Under this
      // camera that is exactly the "pulling upwards" cue: a lick appears at the
      // base, brightens and widens as it climbs the slices, then erodes into
      // smoke at the top. Same cost, one operator.
      const sz = float(sheetH * VERTICAL_ADVECT).sub(puffPhase.mul(float(BOIL_RATE)));
      sheets.push(
        fbmFloat(TSL, vec3(sp.x, sp.y, sz), {
          octaves: slabPlan.octaves,
          diminish: BILLOW_DIMINISH,
        }).toVar()
      );
    }
    // A zero-sheet plan (rung 0) still needs a field expression; a constant 0
    // makes the billow fold degenerate to a clean disc, which IS rung 0's look.
    if (sheets.length === 0) sheets.push(float(0).toVar());

    // Stipple grain in WORLD space (so it does not stretch with quad size) and
    // quantized to CELLS (so it reads as dry-brush speckle rather than sensor
    // noise). Two ops, not a Worley cell — Worley is 27 lattice hashes, more
    // than an entire 3-octave fBm, and this is the 4th term in a stack.
    const worldP = q.mul(float(quadHalfPx)).add(aCenter);
    const grain = cheapValueNoise(TSL, worldP.div(float(STIPPLE_CELL_PX))).toVar();

    // ── THE MASK CLIP — the footprint respects the PAINTED SHAPE ──
    // ⚠️ WHY THIS EXISTS. Until now `_Fire` only ever set a fire's CENTRE and
    // DIAMETER (`fire-mask.js`'s chamfer ridge extraction) — the silhouette
    // itself was pure procedural noise with no idea what shape was painted.
    // Author, live, 2026-08-08, a half-circle fireplace opening: "the shape of
    // the fire in the fireplace doesn't conform to the shape of the actual
    // mask... it's always been a perfect circle." This samples the SAME coarse
    // `_Fire` grid boot.js already extracts fires from, as a texture, at this
    // fragment's WORLD position — `buildWorldSpaceOutdoorsGate`'s own pattern
    // (environmental-light.js), mirrored rather than imported because
    // `effects/fire/` cannot reach `effects/lighting/` for a private helper any
    // more than it can reach `vt/`.
    //
    // ⚠️ FAILS OPEN, TWICE OVER. `maskTexNode` is null for any caller that has
    // not wired one (every existing Shader Lab scenario before this change,
    // and any future caller that forgets). `aFireParams.w` is 0 for an
    // anchor-placed fire — no painted shape to conform to at all, and clipping
    // it against whatever the mask happens to read at that point would be
    // `feedback_gate_polarity_must_fail_open`'s exact mistake in a new outfit.
    // ==========================================================================
    // THE FOOTPRINT — WHERE THE FUEL IS, SAMPLED AT AN ARBITRARY WORLD POINT
    // ==========================================================================
    //
    // ⚠️ THIS IS THE SHAPE SOURCE NOW, NOT A CLIP. The previous design built a
    // circle (`d = r − radius − noise·amp·radius`, a radial SDF with a
    // noise-perturbed radius) and multiplied the mask in afterwards. That can
    // never conform to a painted region, and not because of tuning: a radial SDF
    // IS a circle by construction, and where the circle is SMALLER than the
    // paint — the ordinary case — the mask multiply changes nothing at all.
    // Author, after the clip shipped: *"The fires still do not conform to the
    // masks... it's a circle, why is it a circle?"* Correct, and it would have
    // stayed one through any amount of further noise tuning.
    //
    // So the flame's base is now the PAINTED COVERAGE ITSELF, read at whatever
    // world point a slice back-traces to (see the slice loop). Paint brightness
    // carries through as density, which is exactly the author's stated model:
    // *"very dark grey being very low opacity and low heat and fully white being
    // a blaze."*
    //
    // An ANCHOR fire has no painted region by definition, so it falls back to a
    // soft disc of its own diameter — the old behaviour, kept for the one source
    // that genuinely has no footprint to follow.
    const halfDiaPx = float(Math.max(chain.diameterPx / 2, 1e-3));
    const footprintAt = (wxy) => {
      const rel = wxy.sub(aCenter).div(halfDiaPx.mul(sizeFix));
      const disc = float(1).sub(smoothstep(float(0.45), float(1), length(rel)));
      if (!maskTexNode || !uMaskRect) return disc;
      const mu = wxy.x.sub(uMaskRect.x).div(uMaskRect.z.sub(uMaskRect.x)).clamp(0, 1);
      const mv = wxy.y.sub(uMaskRect.y).div(uMaskRect.w.sub(uMaskRect.y)).clamp(0, 1);
      const painted = maskTexNode.sample(vec2(mu, mv)).r;
      // `aFireParams.w` is 1 for a mask-derived fire, 0 for an anchor — the same
      // per-vertex flag the old clip used, now selecting the shape SOURCE.
      return mix(disc, painted, aFireParams.w);
    };

    // ── THE N SLICES, FRONT TO BACK ──
    // ⚠️ `sliceTable` is emitted TOP FIRST because the camera is ABOVE the fire.
    // Front-to-back compositing therefore starts at the top of the plume, which
    // is what lets cool smoke occlude the hot core. Iterating it in reverse
    // would draw the smoke behind the flame and no tuning would recover it.
    //
    // ============================================================================
    // WHY THIS INTEGRATES TEMPERATURE AND COLOURS ONCE, RATHER THAN COLOURING
    // EACH SLICE AND SUMMING
    // ============================================================================
    //
    // The first version evaluated the posterized ramp PER SLICE and accumulated
    // the resulting colours. It rendered a smooth gradient with no bands at all,
    // and the reason is arithmetic rather than tuning: banding each of ten
    // slices and then summing them AVERAGES THE BANDS BACK OUT. Ten staircases
    // at ten different offsets add up to a ramp. (Measured 2026-08-08 in
    // `bench-fire.js#draws-at-all`: `uPosterize` at 0.85 was visually
    // indistinguishable from 0.)
    //
    // So the integral accumulates a density-weighted TEMPERATURE and a
    // density-weighted SMOKE FRACTION, and the ramp is evaluated exactly ONCE
    // on the result. That is:
    //   - correct — posterizing the final isotherm is what produces the
    //     reference image's concentric bands, and they now survive;
    //   - cheaper — one ramp evaluation instead of N (the ramp is seven nested
    //     smoothsteps, so at N=10 this removes ~63 of them);
    //   - still volumetric — the weighting IS the column integral, and
    //     transmittance still makes cool smoke hide the hot core.
    //
    // ============================================================================
    // FLAME AND SMOKE ARE ACCUMULATED SEPARATELY, BECAUSE THEY ARE NOT THE SAME
    // KIND OF THING
    // ============================================================================
    //
    // The second render put grey smoke over the entire fire and left no orange
    // anywhere. The cause was not a tuning value: flame and smoke were being
    // averaged into ONE weighted colour, as though a fire were a single
    // substance whose colour happens to vary. It is two — an EMITTER and an
    // ABSORBER — and a weighted mean of "glowing" and "not glowing" is just
    // "dimmer", which is why the smoke won everywhere its coverage was larger
    // (and its coverage is always larger: the plume spreads to 2.1× the fuel
    // bed while the flame tapers to 0.34×).
    //
    // So flame accumulates EMISSION weighted by transmittance, smoke
    // accumulates COVERAGE and a grey it was lit into, and the two are combined
    // by share at the end. Transmittance still does the physical work — smoke
    // overhead genuinely dims the flame beneath it — but it can no longer
    // replace it.
    const accumT = float(0).toVar();
    const accumW = float(0).toVar();
    const smokeCol = vec3(0, 0, 0).toVar();
    const smokeW = float(0).toVar();
    const trans = float(1).toVar();
    const bands = float(slabPlan.bands);
    const radiusScale = chain.diameterPx / 2 / Math.max(quadHalfPx, 1e-3);

    for (const S of sliceTable) {
      // Time-of-flight to this height — the shear costs zero art constants.
      const shearSec = fireShearSeconds(S.shearK, chain.heightPx, chain.riseSpeedPx);
      const p = q.sub(leanFrac.mul(float(shearSec)));
      const r = length(p);

      // Sheet blend. SDF-space, not value-space: blending the noise VALUE
      // between two sheets mushes contrast at intermediate heights, while
      // blending after the fold keeps lobe edges crisp.
      const nz = slabPlan.M > 1 ? mix(sheets[S.sheetLo], sheets[S.sheetHi], float(S.sheetBlend)) : sheets[0];

      // THE CAULIFLOWER. `1 − |fbm|` folds ordinary Perlin into rounded lobes
      // with creases at the zero crossings — the billow/pyroclastic trick — at
      // ZERO extra cost. Worley would read similarly and costs 27 lattice
      // hashes, more than an entire 3-octave fBm (measured 2026-08-08).
      const billow = float(1).sub(abs(nz));
      const radius = float(S.radiusK * radiusScale)
        .mul(sizeFix)
        .toVar();

      // ======================================================================
      // BACK-TRACE TO THE FUEL BED — WHERE DID THIS PARCEL COME FROM?
      // ======================================================================
      //
      // A parcel sitting at this fragment, at height h, left the fuel a
      // time-of-flight ago and has been carried since. Undo that carriage and
      // the question "is there fire here" becomes "was there FUEL where this
      // parcel started" — which the painted mask answers exactly.
      //
      // Forward, a parcel goes:  p = centre + (source − centre)·spread(h) + drift
      // so the inverse is:       source = centre + (p − centre − drift)/spread(h)
      //
      // Three consequences fall straight out of that, and they are the three
      // things the old radial-SDF construction could never do:
      //
      //   • AT h = 0 THE SHAPE IS THE MASK, EXACTLY. Both `spread` (radiusK=1)
      //     and `drift` (shear ∝ h² and flight time both vanish) are identities
      //     at the fuel bed, so the base samples the footprint at the fragment's
      //     own position. *"The shape of the bottom of the flame to match the
      //     footprint of the white pixels precisely."* — by construction, not
      //     by tuning.
      //   • THE CONE COMES FREE. `radiusK` already tapers 1.0 → 0.34 through the
      //     flame and re-expands to 1.35 through the smoke. Dividing by it means
      //     a high flame slice samples a WIDER ring of the footprint (so only
      //     fuel near the middle still reaches that height — a taper) while a
      //     smoke slice samples a tighter one (so the plume spreads). Squashed
      //     cone into a spreading plume, from the same two numbers.
      //   • THE FLAME LICKS. Drift includes the curl flow, scaled by REAL time
      //     of flight, so the higher a slice is the further its parcels have
      //     been swirled — the sheet stretches into tongues that trail the flow.
      const flightSec = fireShearSeconds(S.hK, chain.heightPx, chain.riseSpeedPx);
      const driftWorld = leanFrac
        .mul(float(shearSec))
        .mul(float(quadHalfPx))
        .add(vec2(w2.x, w2.y).mul(float(CURL_ADVECT_PX_PER_SEC * flightSec * (0.5 + S.ampK))));
      const srcWorld = aCenter.add(
        worldP
          .sub(aCenter)
          .sub(driftWorld)
          .div(float(Math.max(S.radiusK, 0.05)))
      );
      const foot = footprintAt(srcWorld);

      // ⚠️ SOFTNESS IS A FRACTION OF THE SLICE RADIUS, NOT OF THE QUAD.
      // The first version divided by a raw quad fraction, so the top smoke
      // slice's 0.48 became 360 px of gradient on a 292 px blob — the entire
      // volume was one soft edge, which is why nothing had a silhouette and
      // nothing could band. Softness has to scale with the thing it is
      // softening.
      //
      // ── EROSION: THE SHEET BREAKS INTO TONGUES AS IT RISES ──
      // At the fuel bed nothing is eroded — the fire covers its whole footprint,
      // which is what "roaring" looks like from above. Higher up, only the
      // strongest peaks of the billow field survive, so the continuous sheet
      // tears into separate licks that thin out with height. That progression IS
      // the visual of flames licking upward under a top-down camera: not a
      // silhouette that points up (there is no "up" on screen here), but a
      // coherent base resolving into discrete tongues that stretch, break away
      // and cool.
      //
      // ⚠️ THE EROSION PEAKS AT THE FLAME TIP AND THEN HOLDS, rather than
      // climbing all the way to h=1. Smoke should inherit the broken-up shape
      // the flame handed it and then simply disperse — eroding it further would
      // dissolve the plume into disconnected specks exactly where it should be
      // merging into a continuous column.
      // ⚠️ SQUARE-ROOTED, so erosion bites EARLY. Linear in height left the
      // whole lower half of the flame unbroken, and since the bottom slices
      // carry most of the column's density the integral came out a solid slab
      // with a few nicks near the tip — no tongues at all. A flame starts
      // separating into licks close to the fuel; only the very base is a
      // continuous sheet.
      const hRel = Math.sqrt(Math.min(S.hK / Math.max(chain.flameFrac, 1e-3), 1));
      const erodeAt = EROSION_AT_BASE + (EROSION_AT_TIP - EROSION_AT_BASE) * hRel;
      const tongues = smoothstep(float(erodeAt), float(erodeAt + EROSION_SOFTNESS), billow);
      const dens = clamp(foot.mul(tongues), float(0), float(1)).toVar();

      // Temperature: the slice's own baked value, cooled outward from the
      // spine, modulated by the SAME billow field that shaped the silhouette
      // (so a lobe is hotter at its core than the crease beside it), wobbled by
      // the puff, and scaled by weather.
      // ⚠️ SQUARED, so the hot zone is a small CENTRE rather than most of the
      // disc. A linear falloff to 0.45 leaves the majority of the flame body
      // above the ramp's yellow stops, which is why the render read amber all
      // over and the reference image's orange had nowhere to live. Squaring
      // keeps the peak temperature at the spine (the white-hot core the author
      // asked for) while dropping the bulk into the orange band fast.
      const rN = clamp(r.div(max(radius, float(1e-4))), float(0), float(1));
      const radial = mix(float(1), float(0.32), rN.mul(rN));
      const wobble = sin(puffPhase.mul(float(6.2832)).sub(float(S.hK * 4))).mul(float(0.07));
      const lobeHeat = billow.sub(float(0.5)).mul(float(NOISE_TEMP_INFLUENCE));
      const T = clamp(float(S.tempK).mul(radial).add(lobeHeat).add(wobble).mul(uWeather.x), float(0), float(1));

      // ⚠️ THE PLUME AXIS STAYS CLEAR, and this is why you can see a fire from
      // directly overhead at all. A real plume's core is hot, fast and thin —
      // it has not had time to spread or cool — while the thick, cool, opaque
      // smoke is at the PERIPHERY and higher up. Modelling smoke as uniformly
      // dense inside its radius put an opaque grey lid over every fire when
      // viewed from above (measured: the fire's own core rendered (60,56,52)),
      // which is exactly the top-down mistake this effect exists to avoid.
      //
      // ⚠️ MEASURED AGAINST THE FLAME'S RADIUS, NOT THE SLICE'S OWN. The first
      // attempt divided by `radius` — the CURRENT slice's radius, which for a
      // high smoke slice is ~2× the fuel bed. That put the clear zone at ~50 px
      // on a 137 px flame, so the flame rendered as a bright dot inside an
      // opaque grey disc. The clear channel is punched by the FLAME, so it is
      // the flame's size that sets it. Third instance of this frame-of-reference
      // bug in one file (`feedback_normalization_erased_the_compared_axis`).
      const axisClear = slabPlan.hasSmoke
        ? mix(
            float(SMOKE_CORE_CLEAR),
            float(1),
            smoothstep(float(0.55), float(1.7), r.div(float(Math.max(radiusScale, 1e-4))))
          )
        : float(1);

      const w = dens.mul(trans).toVar();
      // A slice is part flame, part smoke; the split is baked per slice.
      if (slabPlan.hasSmoke && S.smokeMix > 0) {
        const sw = w.mul(float(S.smokeMix)).mul(axisClear);
        // How strongly the fire below lights this parcel: bright right over the
        // flame, falling off with distance from the axis and with height.
        const firelight = float(1 - S.hK * 0.55).mul(
          float(1).sub(smoothstep(float(0.5), float(2.6), r.div(float(Math.max(radiusScale, 1e-4)))))
        );
        smokeCol.addAssign(buildSmokeRamp(TSL, T, grain, uWeather.z, uSootGain, firelight).mul(sw));
        smokeW.addAssign(sw);
      }
      const fw = w.mul(float(1 - (slabPlan.hasSmoke ? S.smokeMix : 0)));
      accumT.addAssign(T.mul(fw));
      accumW.addAssign(fw);
      // Smoke over the axis also occludes less, or the flame beneath it is
      // still dimmed by a lid that is no longer being drawn.
      const occl = slabPlan.hasSmoke && S.smokeMix > 0 ? dens.mul(axisClear) : dens;
      trans.mulAssign(float(1).sub(occl.mul(float(S.absorbK))));
    }

    const Tavg = clamp(accumT.div(max(accumW, float(1e-4))), float(0), float(1));

    // ⚠️ POSTERIZE THE TEMPERATURE, NEVER THE RGB. Quantizing this scalar
    // BEFORE the ramp gives clean isotherm bands — concentric contours of equal
    // temperature, which is the reference image's whole structure. Quantizing
    // the ramp's OUTPUT instead gives posterized noise: the same palette
    // scattered by whatever the field was doing. One line apart in a shader,
    // and nothing about the code says which you meant.
    const Tq = mix(Tavg, floor(Tavg.mul(bands)).add(float(0.5)).div(bands), uPosterize);

    // ⚠️ THE PER-FIRE TINT APPLIES TO THE FLAME ONLY.
    // An earlier version multiplied the FINAL colour by `aColorIntensity.xyz`,
    // which tinted the smoke orange along with everything else and made grey
    // smoke invisible against an orange fire. Smoke is lit BY the fire (which
    // the smoke ramp already models through its shared temperature input); it
    // is not made OF the fire's colour.
    const flame = buildFlameRamp(TSL, Tq, uHueShift).mul(aColorIntensity.xyz);

    // ============================================================================
    // PREMULTIPLIED ALPHA — THE EMITTER *AND* THE OCCLUDER, IN ONE PASS
    // ============================================================================
    //
    // ⚠️ THIS USED TO BE PURE ADDITIVE, AND THAT IS WHY THE LIVE FIRE LOOKED
    // NOTHING LIKE THE LAB'S. Author, comparing the two, 2026-08-09: *"The fire
    // in Foundry looks very pale and uninteresting. The shader lab looks much
    // stronger and brighter and more opaque."* Same shader, same uniforms — the
    // difference is entirely the BACKGROUND. The lab renders on black, where
    // additive `bg + fire` IS the fire's own colour. Production draws into
    // `buf:scene.lit` AFTER the composite, over a lit stone fireplace, where
    // `bg + fire` drives every channel toward white: a saturated orange over a
    // mid-grey floor reads as pale yellow-white with the floor still visible
    // through it. Additive light can only ever ADD, so a blaze could never look
    // optically THICK — and a real blaze is: you cannot see the hearth floor
    // through the middle of it.
    //
    // The fix is the volumetric rendering equation this integral was already
    // computing and then throwing half of away:
    //
    //     L = emission + L_background × transmittance
    //
    // which is exactly premultiplied-alpha "over" (`src + dst × (1 − a)`) with
    // `a = 1 − transmittance`. `trans` is already tracked through the slice loop
    // for the flame/smoke occlusion, so this costs nothing new to compute.
    //
    // ⚠️ IT CANNOT REGRESS ANY LAB RESULT ALREADY VERIFIED. Over a BLACK
    // background the two blends are algebraically identical (`dst = 0` kills the
    // `dst × (1 − a)` term), so every existing scenario renders pixel-for-pixel
    // what it did before — while the live look gains the occlusion it needs.
    //
    // It also, for free, fixes the thing recorded as the top deferred item in
    // Fire.md §9: smoke can finally DARKEN the map. A dark smoke fragment now
    // contributes little emission but a real alpha, so it hides what is behind
    // it instead of only ever adding warm haze.
    //
    // ⚠️ The version before this normalised BOTH terms by the total column
    // weight, so the flame's brightness depended on how much smoke happened to
    // be around it. Since a plume spreads to 2.1× the fuel bed while the flame
    // tapers to 0.34×, smoke's share was ~0.9 everywhere and the flame rendered
    // as a single bright dot at the one point the axis-clear term suppressed
    // the smoke. Radiometrically that average was defensible; as a picture it
    // was wrong, because a flame is INCANDESCENT and a plume is merely lit.
    // Each term now carries its own coverage and its own gain, and neither can
    // dim the other by being large.
    // The core boost — see FLAME_CORE_BOOST. `Tq`, not `Tavg`: boosting the
    // posterized scalar keeps the band edges hard instead of smearing an
    // exponential across them.
    //
    // ⚠️ SMOOTHSTEP-GATED, NOT A BARE POWER, AND THE DIFFERENCE IS THE COLOUR OF
    // THE WHOLE FIRE. `pow(Tq, 4)` still returns 0.41 at Tq=0.8 — so with a 5.5×
    // boost the ENTIRE flame body was being multiplied by ~3, not just its core,
    // and once the tone-mapped present pass compressed that back down every band
    // above mid-temperature converged on the ramp's palest stop. The render went
    // uniformly yellow and lost the orange that is most of the reference image.
    // A power curve has no zero: it boosts everything, just unequally. The gate
    // does — below 0.72 the multiplier is exactly 1 and the ramp is untouched,
    // so the orange survives and only a genuinely white-hot core blooms.
    const coreBoost = float(1).add(smoothstep(float(0.72), float(1), Tq).mul(float(FLAME_CORE_BOOST)));
    const flameVis = clamp(accumW, float(0), float(1));
    let col = flame.mul(flameVis).mul(float(FLAME_RADIANCE_GAIN)).mul(coreBoost);
    if (slabPlan.hasSmoke) {
      const smokeAvg = smokeCol.div(max(smokeW, float(1e-4)));
      col = col.add(smokeAvg.mul(clamp(smokeW, float(0), float(1))).mul(uSmokeGain));
    }

    // Per-fire brightness, the master param, and whether weather snuffed it.
    col = col.mul(aColorIntensity.w).mul(uIntensity).mul(uWeather.w);

    // ⚠️ OPACITY TRACKS THE COLUMN'S REAL TRANSMITTANCE, NOT ITS BRIGHTNESS.
    // `1 − trans` is how much of the background this column of fire and smoke
    // actually hides. The master controls scale it too, and they MUST: an
    // opacity that survived `uIntensity → 0` or a snuffed-out fire would leave
    // a black disc punched in the map where the flame used to be — the failure
    // mode is not "too dim", it is a hole. `uIntensity` is clamped to 1 for
    // this purpose only, so pushing brightness past 1 overdrives the GLOW
    // without making the fire more solid than it physically is.
    const opacity = clamp(float(1).sub(trans), float(0), float(1))
      .mul(uWeather.w)
      .mul(clamp(uIntensity, float(0), float(1)))
      .toVar();

    // ── OCCLUSION ──
    // The DEPTH AUTHORITY, not the old `buf:scene.attr` gate. `buildHeightGate
    // Node` reconstructs a rank from a lossy, per-floor-relative, quantized-to-
    // 16-levels byte that a live pixel probe caught reading alpha=0 over real
    // visible floor art (Depth-Buffer.md), and open Bug 8 ("candle flames go
    // transparent at low elevation") is very likely its symptom. Fire starts on
    // the ordinal compare instead.
    if (depthTexNode) {
      const depthHere = depthTexNode.sample(screenUV).r;
      // ⚠️ `screenUV`, NEVER the bare node. `buf:scene.depth` is a SCREEN-space
      // buffer and this is a WORLD-space billboard whose own `uv()` is the local
      // quad coordinate — a bare `texture()` would sample the wrong thing just
      // as surely as no uv at all. Three consecutive "fixed it" rounds on the
      // light/elevation gate died on exactly this
      // (feedback_shared_texture_node_carries_the_wrong_uv).
      const gate = buildFireDepthGate(TSL, {
        depthHere,
        flagsHere: depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null,
        expectedDepth: aFireParams.z,
      });
      // ⚠️ THE GATE MULTIPLIES BOTH THE COLOUR AND THE OPACITY, and under
      // premultiplied alpha that is not optional. Gating only the colour would
      // leave an occluded fire contributing `col = 0, alpha = 1` — which is not
      // "invisible", it is a BLACK DISC punched through the map exactly where
      // the hidden flame is. (Under the old additive blend, alpha was ignored
      // and colour-only was correct; the blend change makes this line load-
      // bearing.)
      col = col.mul(gate);
      opacity.mulAssign(gate);
    }

    return vec4(col, opacity);
  })();

  // ── THE BLEND: PREMULTIPLIED ALPHA "OVER" ──
  // `src.rgb + dst.rgb × (1 − src.a)` — the volumetric rendering equation the
  // slice integral above already computes (see its own note for why this
  // replaced plain AdditiveBlending, and why it is a provable no-op on the
  // black backgrounds every Shader Lab scenario renders against).
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // ⚠️ DoubleSide is not cosmetic. The camera's flipped `top = minY` frustum
  // reverses effective winding, and `FrontSide` culls the whole batch SILENTLY.
  // Live-confirmed on the particle engine and on the candle.
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor; // the colour is ALREADY premultiplied
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  // ⚠️ LEAVE THE DESTINATION ALPHA ALONE. `buf:scene.lit`'s alpha channel is
  // not this effect's to spend — the candle and the bolt draw into the same
  // target — so the alpha equation is "keep dst" (`0 × src + 1 × dst`) rather
  // than the RGB one. Only the RGB blend consumes `src.a`, which is exactly
  // the occlusion this change exists for.
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.toneMapped = false;

  return { material, uIntensity, uPosterize, uWindResponse, uWeather, uHueShift, uSootGain, uSmokeGain };
}

/**
 * The depth-authority gate, mirrored rather than imported.
 *
 * ⚠️ `depth/authority-only` forbids calling `buildHeightGateNode` and friends,
 * and `effects/` cannot reach `vt/` for the flag constants — the same reason
 * `point-light-illumination.js:622` mirrors them instead of importing. The
 * comparison itself is a bare ordinal test: a fragment whose stored scene depth
 * is NEARER than this fire's own expected depth has something drawn over the
 * fire, so the fire is hidden there.
 */
function buildFireDepthGate(TSL, { depthHere, flagsHere, expectedDepth }) {
  const { float, select, floor, mod } = TSL;
  const rankGate = select(depthHere.lessThan(expectedDepth), float(0), float(1));
  if (!flagsHere) return rankGate;
  // DEPTH_FLAG_RESTRICTS_LIGHT = 1, DEPTH_FLAG_IS_TILE = 16 (mirrored from
  // vt/scene-depth.js — one-way layering, see above).
  const flagsByte = floor(flagsHere.b.mul(float(255)).add(float(0.5)));
  const restrictsLight = mod(floor(flagsByte.div(float(1))), float(2));
  const isTile = mod(floor(flagsByte.div(float(16))), float(2));
  return rankGate.mul(float(1).sub(restrictsLight.mul(isTile)));
}

/**
 * Build the batched quad geometry from `computeFireQuadArrays`' typed arrays.
 *
 * ⚠️ `BufferAttribute` has NO `dispose()` (`reference_bufferattribute_no_dispose_trap`
 * — a real WebGPU device loss in ~30 s). The caller REUSES this geometry and
 * re-uploads via `needsUpdate` where it can; a full rebuild disposes the
 * GEOMETRY, which is what actually releases the GPU buffers.
 */
export function buildFireGeometry({ THREE, arrays }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(arrays.uv, 2));
  geometry.setAttribute('center', new THREE.BufferAttribute(arrays.center, 2));
  geometry.setAttribute('colorIntensity', new THREE.BufferAttribute(arrays.colorIntensity, 4));
  geometry.setAttribute('fireParams', new THREE.BufferAttribute(arrays.fireParams, 4));
  geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));
  geometry.setDrawRange(0, arrays.quadCount * 6);
  return { geometry, quadCount: arrays.quadCount };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
