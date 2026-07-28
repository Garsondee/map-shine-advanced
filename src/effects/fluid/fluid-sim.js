/**
 * THE SIM — semi-Lagrangian transport of one tube's fill state, per bin, per
 * tick (`docs/planning/Fluid.md` §5.3, the TRANSPORT mode). This is what
 * replaces tier `flow`'s analytic `fract(s·count − t·speed)` scroll with goo
 * that is genuinely CARRIED: it has identity, it speeds up through a narrow
 * neck (`v = Q/A`), and slugs can stretch, compress or catch up with one
 * another because they are the same transported field, never redrawn from a
 * formula each frame.
 *
 * ============================================================================
 * THE CPU TWIN IS THE SOURCE OF TRUTH — WRITTEN AND VERIFIED FIRST
 * ============================================================================
 * `feedback_smooth_output_hides_ported_bugs` is explicit about this exact
 * shape of work: *"write the CPU twin from the same primitives, diff against
 * brute force, assert the directional invariant. Run the twin BEFORE claiming
 * a fix, not after."* `advectTubeStep` below is that twin — pure, no THREE,
 * Node-tested against the one claim this whole rung exists to make (the
 * fluid visibly speeds up through a constriction, §17 asserts it numerically
 * on a two-region fixture) — and `buildFluidAdvectMaterial`'s TSL is the
 * SAME formula transcribed, never a second derivation that could quietly
 * disagree with the first (the exact shape `Water.md` §2.4 names as two
 * disagreeing GGX stacks).
 *
 * ============================================================================
 * WHY SEMI-LAGRANGIAN, AND WHY IT NEEDS NO CFL CLAMP
 * ============================================================================
 * An explicit Eulerian advection scheme blows up once a tick's flow would
 * cross more than one grid cell (the CFL condition) — which this effect
 * cannot rule out in advance, because `Q(t)` is deliberately allowed to gulp
 * and a narrow neck deliberately runs fast. Semi-Lagrangian advection
 * (Stam's "Stable Fluids": at each destination bin, compute the velocity
 * there, walk BACKWARD along it for one `dt`, and read the field by
 * INTERPOLATION at that traced-back position) is unconditionally stable
 * regardless of how far the backtrace travels — a huge `Q·dt` just walks
 * further back and clamps at the boundary, it never oscillates or diverges.
 * That is why `fluid-sim.test.mjs` can throw an absurd `Q` at it and assert
 * "still bounded, never NaN" rather than needing a substep loop.
 *
 * ============================================================================
 * THE BOUNDARY CONDITIONS, STATED PLAINLY
 * ============================================================================
 * ROOT (bin 0, `s=0`, the brightest end — `Fluid.md` §5.1's polarity): when a
 * bin's backtrace reaches OUTSIDE the tube on this end, its new value is
 * simply the PUMP's current `inject`, full stop — there is no "before the
 * root" state to blend with, because the root's OWN previous value is not a
 * source, the pump is. TIP (bin `n-1`): a backtrace reaching past the far end
 * finds nothing outside to pull from, so that bin HOLDS its previous value —
 * a closed/draining end, the simplest honest approximation for a decoration
 * that is not required to conserve mass in the strict physical sense (the
 * brief's own freedoms: never gameplay-integral, no persistence required).
 *
 * ⚠️ **Both boundary choices are load-bearing, not incidental — adversarially
 * confirmed.** Blending the root with the STALE previous value instead of the
 * pump's `inject` outright breaks the "Q=0 root reflects the pump instantly"
 * test. Swapping the interpolation from LINEAR to NEAREST-NEIGHBOUR does not
 * merely make the result blockier — at the velocities and tick rates this
 * effect actually runs at, `Math.round(srcBin)` can equal `i` every single
 * tick (the sub-bin fraction of a step gets rounded away), which STALLS the
 * whole field: it never advances at all, however many ticks run. Linear
 * interpolation is what lets a slow, steady flow accumulate its sub-bin
 * motion instead of losing it to rounding.
 *
 * @module effects/fluid/fluid-sim
 */

import { fluidPumpForTube, FLUID_PUMP_BASE_Q } from './fluid-pump.js';

/** The floor under `crossSectionProfile` before a division — stops a
 * degenerate (zero-width) bin from producing an infinite velocity. `1e-3`
 * world px is far below anything a real tube profile produces (the
 * extractor's own chamfer radius is bounded below by a texel size), so this
 * only ever engages on a pathological bake, never on ordinary geometry. */
export const FLUID_SIM_MIN_CROSS_SECTION_PX = 1e-3;

/**
 * How many seconds a tube of ANY length/width should take to fill from root
 * to tip at nominal pump drive (~1×) — the number `computeFluidLengthQScale`
 * solves for. Picked for "clearly alive within a few seconds," matching what
 * the author already confirmed felt right about the analytic scroll it
 * replaced (`Fluid.md`'s own live-confirmation quote), not derived from any
 * physical constant.
 */
export const FLUID_TARGET_TRAVERSAL_SECONDS = 8;

/**
 * ⚠️ **WHY THIS FUNCTION EXISTS — a real bug, found from a live report, not a
 * browser.** `FLUID_PUMP_BASE_Q` was calibrated (and tested, `fluid-pump.test.
 * mjs`) against `fluid-sim.test.mjs`'s own synthetic fixtures — tubes a few
 * hundred px long with an 8–32px cross-section. The author's actual map has
 * tubes 4,600–7,000 px long with a ~150px radius (~300px cross-section) — an
 * order of magnitude wider and several times longer than anything this rung
 * was ever measured against. `v = Q/A` is the CORRECT formula (`fluid-sim.
 * test.mjs`'s own "speeds up through a neck" test proves it), but a single
 * flat `Q` cannot look right on both scales at once: at the SAME `Q` a 10×
 * wider tube moves 10× slower, and a measurement against this exact author's
 * real numbers put the front at over 1,200 SECONDS to cross one tube —
 * invisible within any session anyone would sit and watch. This is
 * `feedback_measure_the_output_not_the_equation` again, one level up: the
 * equation was right, the CONSTANT was validated only in the wrong regime.
 *
 * The fix makes Q self-scale to EACH TUBE'S OWN geometry rather than rely on
 * one flat constant: solving `lengthPx / (Q·scale / meanCrossSection) =
 * targetSeconds` for `scale` gives a per-tube multiplier that makes a tube's
 * OWN traversal time approximately `targetSeconds` at nominal drive (~1),
 * regardless of whether that tube is a 500px capillary or a 7,000px main —
 * the SAME length/cross-section-invariance the old analytic scroll had by
 * accident (its `s` was already normalised 0..1), now achieved on purpose for
 * a sim whose native units are real world px.
 *
 * @param {{lengthPx: number, crossSectionProfile: Float64Array}} tube
 * @param {number} [targetTraversalSeconds]
 * @returns {number} multiply `fluidPumpForTube`'s own `Q` by this.
 */
export function computeFluidLengthQScale(tube, targetTraversalSeconds = FLUID_TARGET_TRAVERSAL_SECONDS) {
  const profile = tube.crossSectionProfile;
  let sum = 0;
  for (let i = 0; i < profile.length; i++) sum += profile[i];
  const meanCrossSection = Math.max(FLUID_SIM_MIN_CROSS_SECTION_PX, profile.length > 0 ? sum / profile.length : 0);
  const lengthPx = Math.max(1, tube.lengthPx);
  const scale = (lengthPx * meanCrossSection) / (Math.max(1e-3, targetTraversalSeconds) * FLUID_PUMP_BASE_Q);
  // A sane ceiling, not a tuned one: guards only the degenerate case (a
  // near-zero-width bake) from handing the sim an absurd Q — the scheme is
  // unconditionally stable either way (`fluid-sim.test.mjs`'s own "absurd Q"
  // test), so this is insurance against a strange-looking flood, not a crash.
  return Math.min(100000, Math.max(1e-6, scale));
}

/**
 * One tube, one tick: destination-sampled semi-Lagrangian advection of a
 * single scalar field (`φ`, fill 0..1) along the tube's own arc length.
 *
 * @param {object} args
 * @param {Float64Array|Float32Array} args.prevPhi - length `n`, the previous tick's state.
 * @param {Float64Array|Float32Array} args.crossSectionProfile - length `n`, world px per bin (`fluid-net.js`'s own `crossSectionProfile`).
 * @param {number} args.lengthPx - the tube's total geodesic length, world px.
 * @param {number} args.Q - this tick's flow rate, world px²/s. `Q >= 0`: flow always runs root → tip (`fluidPumpForTube` never returns a negative Q).
 * @param {number} args.inject - this tick's root-bin value, 0..1 (`fluidPumpForTube`'s own output).
 * @param {number} args.dtSec
 * @param {Float64Array} [args.out] - written in place if given (avoids an allocation per tube per tick in the real render loop); a fresh array is returned either way.
 * @returns {Float64Array} the next tick's state, length `n`.
 */
export function advectTubeStep({ prevPhi, crossSectionProfile, lengthPx, Q, inject, dtSec, out }) {
  const n = prevPhi.length;
  const next = out ?? new Float64Array(n);
  if (n === 0) return next;
  if (!(lengthPx > 0)) {
    // No measurable tube (a degenerate bake) — hold whatever was there rather
    // than divide by zero into a field of NaN.
    for (let i = 0; i < n; i++) next[i] = prevPhi[i];
    return next;
  }
  const binLengthPx = lengthPx / n;

  for (let i = 0; i < n; i++) {
    // Velocity sampled AT THE DESTINATION bin — the standard semi-Lagrangian
    // formulation (Stam), not a novel variant: `v = Q / crossSection`, so a
    // narrow neck (`crossSectionProfile[i]` small) gives a LARGE `v`, which
    // is the entire physical content of "the goo speeds up through a
    // constriction."
    const crossSection = Math.max(FLUID_SIM_MIN_CROSS_SECTION_PX, crossSectionProfile[i]);
    const v = Q / crossSection;
    const binsPerSec = v / binLengthPx;
    const srcBin = i - binsPerSec * dtSec;

    if (srcBin <= 0) {
      next[i] = inject;
      continue;
    }
    if (srcBin >= n - 1) {
      next[i] = prevPhi[n - 1];
      continue;
    }
    const i0 = Math.floor(srcBin);
    const frac = srcBin - i0;
    next[i] = prevPhi[i0] * (1 - frac) + prevPhi[i0 + 1] * frac;
  }
  return next;
}

/**
 * Lay out every tube's `crossSectionProfile` as one `samplesPerTube ×
 * tubeCount` buffer, row-major, row = tube index — the STATIC half of the
 * sim's inputs (baked once alongside the pack, never touched again until the
 * next rebake, unlike the pump buffer below which is rewritten every tick).
 *
 * ⚠️ **RGBA-INTERLEAVED (stride 4), not a flat single value per bin.** This is
 * a genuinely single-channel field, but `vt-pan-viewer.js#createFluidPackTexture`
 * — the one confirmed DataTexture recipe this codebase uses for a fluid
 * upload — is `RGBAFormat`; there is no confirmed single-channel format in
 * this project's vendored `three.webgpu.js` build, and inventing one here
 * would be the exact "unconfirmed API" risk `world/wind-sim-gpu.js`'s own
 * header explicitly avoids. G/B/A ride along unused (0) — `buildFluidAdvect
 * Material` only ever reads `.r` off this texture, so the waste is invisible
 * downstream and small in absolute terms (≤512×64 texels).
 *
 * @param {Array<{crossSectionProfile: Float64Array}>} tubes - `TubeNet.tubes`.
 * @param {number} samplesPerTube
 * @returns {Float32Array} length `samplesPerTube * tubes.length * 4`.
 */
export function buildFluidProfileBuffer(tubes, samplesPerTube) {
  const out = new Float32Array(samplesPerTube * tubes.length * 4);
  for (let row = 0; row < tubes.length; row++) {
    const profile = tubes[row].crossSectionProfile;
    const rowBase = row * samplesPerTube * 4;
    for (let col = 0; col < samplesPerTube; col++) out[rowBase + col * 4] = profile[col];
  }
  return out;
}

/**
 * Fill an interleaved RGBA buffer — `[Q0, inject0, lengthPx0, 1, Q1, inject1,
 * lengthPx1, 1, ...]` — ready to upload as a `1 × tubeCount` texture the sim
 * reads once per tube, per tick.
 *
 * ⚠️ **RGBA (stride 4), the SAME reason `buildFluidProfileBuffer` above gives**
 * — `createFluidPackTexture` is this codebase's one confirmed float-DataTexture
 * recipe and it is RGBA. The unused 4th channel is written as `1`, not left
 * at whatever the caller's buffer happened to hold, so an upload never
 * carries a stray NaN/garbage alpha into GPU memory for no reason.
 *
 * `lengthPx` rides in the SAME small texture as the pump's own `Q`/`inject`
 * rather than in a separate one, purely to cost one texture fetch instead of
 * two per fragment — it is not a pump quantity (it never changes without a
 * rebake), which is why {@link module:effects/fluid/fluid-pump} itself stays
 * unaware of tube geometry and this assembly step lives here, next to the
 * sim that actually needs both together.
 *
 * @param {Float32Array} out - length ≥ `tubes.length * 4`.
 * @param {number} tMs
 * @param {Array<{lengthPx: number}>} tubes - `TubeNet.tubes`.
 * @param {Array<object>} [personalities] - reuse {@link module:effects/fluid/fluid-pump.fluidPumpPersonality}
 *   per tube across ticks; recomputed fresh per tube if omitted.
 * @param {Array<number>} [qScales] - one {@link computeFluidLengthQScale} result
 *   per tube, baked once at bake time and reused across ticks (the same reuse
 *   discipline `personalities` already uses) — the per-tube fix for "this
 *   tube's own geometry is nothing like the fixture `FLUID_PUMP_BASE_Q` was
 *   tuned against" (see that function's own header). Omitted = scale 1,
 *   which is what every existing test that predates this parameter still
 *   exercises.
 */
export function writeFluidTubeConstantsBuffer(out, tMs, tubes, personalities, qScales) {
  for (let row = 0; row < tubes.length; row++) {
    const personality = personalities ? personalities[row] : undefined;
    const { Q, inject } = fluidPumpForTube(tMs, row, personality);
    const qScale = qScales ? qScales[row] : 1;
    out[row * 4] = Q * qScale;
    out[row * 4 + 1] = inject;
    out[row * 4 + 2] = Math.max(1, tubes[row].lengthPx);
    out[row * 4 + 3] = 1;
  }
}

/**
 * Build the advection material — ONE fragment pass, ping-ponged. Mirrors
 * `world/wind-sim-gpu.js#buildWindAdvectDissipateMaterial`'s exact shape: a
 * `NodeMaterial` + `QuadMesh` pair, and `prevTexNodes` naming the ONE texture
 * node whose `.value` the caller must re-point to the current ping-pong
 * source before each render — here, that is the single backtrace sample,
 * because (unlike wind) nothing in this pass ALSO needs the fragment's own
 * unmoved previous value.
 *
 * ⚠️ **THIS TRANSCRIBES `advectTubeStep` ABOVE, IN UV SPACE — same formula,
 * proven algebraically identical, not a second derivation.** Bin space and UV
 * space differ only by the constant factor `samplesPerTube`, which cancels:
 * `srcU = uv.x − (Q / (crossSection · lengthPx)) · dt` is `srcBin/n` for
 * `srcBin` as `advectTubeStep` computes it. Working directly in UV needs no
 * `samplesPerTube` uniform at all. (Named, not hidden: a QuadMesh's `uv()`
 * lands on a texel's CENTRE, `(i+0.5)/n`, while the CPU twin's `i/n` does not
 * carry the `+0.5` — a half-texel disagreement out of 512, far below anything
 * this decoration needs to notice.)
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.prevStateTexture - R = φ, ping-pong source (`samplesPerTube × tubeCount`).
 * @param {*} args.profileTexture - R = crossSectionProfile, world px, SAME size, baked once (`buildFluidProfileBuffer`).
 * @param {*} args.pumpTexture - RGB = (Q, inject, lengthPx), `1 × tubeCount`, rewritten every tick (`writeFluidTubeConstantsBuffer`).
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uDtSec:*}}
 */
export function buildFluidAdvectMaterial({ THREE, prevStateTexture, profileTexture, pumpTexture }) {
  const { texture, uv, vec2, vec4, float, uniform, max, clamp, step, mix } = THREE.TSL;

  const uv0 = uv();
  const uDtSec = uniform(float(0));

  const profileR = texture(profileTexture, uv0).r;
  const crossSection = max(profileR, float(FLUID_SIM_MIN_CROSS_SECTION_PX));

  const pumpSample = texture(pumpTexture, vec2(float(0.5), uv0.y));
  const Q = pumpSample.r;
  const injectValue = pumpSample.g;
  const lengthPx = max(pumpSample.b, float(1));

  const rawSrcU = uv0.x.sub(Q.div(crossSection.mul(lengthPx)).mul(uDtSec));
  const clampedSrcU = clamp(rawSrcU, float(0), float(1));
  // The ONE read of the ping-pong source — deliberately NOT also sampled at
  // `uv0` itself (this pass never needs the fragment's own unmoved value, so
  // there is nothing to fall back to there; the root boundary falls back to
  // the PUMP's `inject`, never to a stale self-sample — see the module header
  // for why that distinction is load-bearing, adversarially confirmed).
  const backtraceNode = texture(prevStateTexture, vec2(clampedSrcU, uv0.y));
  const sampledPrev = backtraceNode.r;

  // `atRoot`: 1 exactly where the backtrace fell at or before the root ( ==
  // TSL's function-form `step(edge, x)`, NEVER the `.step()` method receiver
  // — `reference_tsl_method_chaining_trap` is the identical shape of bug as
  // the banned `.mix()` receiver, for a different function).
  const atRoot = step(rawSrcU, float(0));
  // Function form ONLY (`reference_tsl_method_chaining_trap`): `a.mix(b,t)`
  // silently means `mix(b,t,a)`, not `mix(a,b,t)`.
  const result = mix(sampledPrev, injectValue, atRoot);

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(result, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes: [backtraceNode], uDtSec };
}
