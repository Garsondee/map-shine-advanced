/**
 * @fileoverview ROPE & CHAIN — THE PURE HALF (mythica-machina-press#1; read
 * that issue and its 2026-09-20 design comment for the full rationale behind
 * every number and decision below). Anchor pairing, the rope/chain preset
 * table, the static parabolic sag, the modal wind-sway math, a reference
 * spring integrator, the two-probe modal-forcing decomposition, the wind-
 * probe geometry Phase 2's GPU integrator samples from, and the batched
 * ribbon vertex-array bake. NONE of it touches THREE or TSL — mirrors
 * lightning-geometry.js's own "pure half carries the whole Node test suite"
 * split exactly.
 *
 * PHASE 1 (authoring + everything in this file) shipped 2026-09-20, `d7bda013`.
 * PHASE 2 (a separate pass, by a separate agent, same day) built ON TOP of
 * this file: the render-target ping-pong spring integrator
 * (`rope-chain-spring-gpu.js`), the ribbon material (`rope-chain-render.js`)
 * and the per-instance CPU subsystem (`rope-chain-subsystem.js`) — see each
 * file's own header. This module gained exactly one new pure export for
 * Phase 2 ({@link computeRopeChainWindProbes}) and is otherwise unchanged.
 * PHASE 3 (shadow twin, same day) added exactly one more pure export,
 * {@link impliedHeightFraction01} — the normalized 0..1 "how far above the
 * ground is this point of the curve" shape the shadow's vertex shader scales
 * its throw by (see `rope-chain-render.js#buildRopeChainShadowMaterial`'s own
 * header for the full argument for why ONE `forCaster()` call at the anchor's
 * own `elevation`, scaled per-vertex by this function, is exact rather than
 * approximate). Still nothing GPU-shaped lives here, on purpose. The Studio
 * UI card remains unbuilt (out of Phase 3's own scope — shadow-casting only).
 *
 * ============================================================================
 * WHY THIS MIRRORS lightning-geometry.js SO CLOSELY
 * ============================================================================
 *
 * `scene/anchor-catalog.js`'s own module header names "the endpoints of a
 * rope" as an anticipated anchor kind, and `lightning` already proved the
 * exact authoring shape a rope/chain span needs: two ordinary single-point
 * anchors (`role:'start'`/`role:'end'` sharing a `params.linkId`), paired
 * back into one SOURCE entirely above the core anchor schema. So this file
 * reuses lightning-geometry.js's own shapes wherever the underlying problem
 * is the same one — anchor pairing (`groupRopeChainAnchorsIntoSources`
 * mirrors `groupLightningAnchorsIntoSources` structurally) and the ribbon
 * vertex-array bake (`buildRopeChainRibbonArrays` mirrors
 * `computeLightningStrandArrays`'s position/prevPos/nextPos/side/uvOffset
 * quad-strip shape) — and only diverges where the physics genuinely differs.
 *
 * ============================================================================
 * THE V2 PREDECESSOR, AND WHY THE PHYSICS IS NOT PORTED THE SAME WAY THE
 * PATH/BRANCH MATH IN lightning-geometry.js WAS
 * ============================================================================
 *
 * V2's rope/chain simulation (`legacy/scene/physics-rope-manager.js` — frozen
 * out of the working tree along with the rest of `legacy/`, but its exact
 * shape is retrievable from history: `git show
 * c328c9bd~1:legacy/scene/physics-rope-manager.js`) was a Verlet-integrated
 * point chain with iterated distance constraints, gravity on a physics-space
 * Z axis, and uniform wind force applied to every free particle with NO
 * special treatment near the two locked endpoints — stability there came only
 * from the constraint solver pulling an overshot near-anchor particle back
 * AFTER the fact. That is almost certainly the shape of "wind pushing the
 * rope into its origin harder than would be plausible" (issue #1's own
 * design comment): a stiff iterated correction after an uncontrolled
 * displacement, right where tension should be highest and motion smallest.
 *
 * The design below avoids that failure mode BY CONSTRUCTION, not by damping
 * it after the fact: static droop is a parabolic sag that is a mathematical
 * zero at both anchors (`parabolicSag`), and dynamic wind sway is a sum of
 * damped-string eigenmodes that are ALSO an exact mathematical zero at both
 * anchors for any amplitude (`modalDisplacement`) — see that function's own
 * doc. Because the underlying simulation method is completely different (a
 * few modal oscillators vs. a whole Verlet particle chain), V2's own preset
 * numbers are ported here as RATIOS, not reused literally — see
 * `ROPE_CHAIN_PRESETS`'s own doc.
 *
 * @module effects/rope-chain-geometry
 */

import { hashStringToSeed } from './lightning-geometry.js';

// ============================================================================
// ANCHOR PAIRING — two `ropeChain` anchors sharing a `linkId` (one `role:
// 'start'`, one `role:'end'`) form one span SOURCE. Structurally identical to
// lightning-geometry.js#groupLightningAnchorsIntoSources: same Map-by-linkId
// bucketing, same start/end/waypoint role handling, same orphan reporting. A
// `role:'waypoint'` anchor (imported from a hypothetical V2 3+-point group,
// or a second anchor wrongly claiming an already-taken role) is collected as
// orphaned, never silently dropped or guessed at.
// ============================================================================

/**
 * @param {Array<{id:string, x:number, y:number, params?:object, elevation?:number}>} anchors
 * @returns {{
 *   sources: Array<{linkId:string, seed:number, startId:string, endId:string, startX:number, startY:number, endX:number, endY:number, preset:('rope'|'chain'), sagPx:number, thicknessPx:number, windAffected:number, color:string, elevation:number}>,
 *   orphaned: Array<{id:string, linkId:string, role:string}>,
 * }}
 */
export function groupRopeChainAnchorsIntoSources(anchors) {
  const byLink = new Map();
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const linkId = typeof a?.params?.linkId === 'string' ? a.params.linkId : '';
    if (!linkId) continue;
    let bucket = byLink.get(linkId);
    if (!bucket) {
      bucket = { start: null, end: null, waypoints: [] };
      byLink.set(linkId, bucket);
    }
    const role = a.params?.role;
    if (role === 'start' && !bucket.start) bucket.start = a;
    else if (role === 'end' && !bucket.end) bucket.end = a;
    else if (role === 'waypoint') bucket.waypoints.push(a);
    else if (role === 'start' || role === 'end') {
      // A second anchor claiming the same role for this linkId — reported as
      // orphaned rather than silently overwriting the first (never guess
      // which one the author meant) — same policy as lightning's own.
      bucket.waypoints.push(a);
    }
  }

  const sources = [];
  const orphaned = [];
  for (const [linkId, bucket] of byLink) {
    if (bucket.start && bucket.end) {
      // preset/sagPx/thicknessPx/windAffected/color: ALL read from the START
      // anchor's own `params` ONLY — a span has one preset, one sag, one
      // thickness, one wind response and one tint, not a per-endpoint pair
      // of each (the schema comment in scene/anchor-catalog.js says so per
      // field). Defensive Number.isFinite/typeof fallbacks match the style
      // groupLightningAnchorsIntoSources already uses for `intensity`: a
      // hand-built fixture (or a raw anchor that predates one of these
      // fields) gets the same sane value an author who never touched that
      // control would get, never NaN/undefined leaking into the geometry.
      const startParams = bucket.start.params ?? {};

      const presetRaw = startParams.preset;
      const preset = presetRaw === 'rope' || presetRaw === 'chain' ? presetRaw : 'rope';

      const sagPxRaw = Number(startParams.sagPx);
      const sagPx = Number.isFinite(sagPxRaw) ? sagPxRaw : 40;

      const thicknessPxRaw = Number(startParams.thicknessPx);
      const thicknessPx = Number.isFinite(thicknessPxRaw) ? thicknessPxRaw : 20;

      const windAffectedRaw = Number(startParams.windAffected);
      const windAffected = Number.isFinite(windAffectedRaw) ? windAffectedRaw : 1;

      const colorRaw = startParams.color;
      const color = typeof colorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : '#8a8378';

      // THE SPAN'S OWN DEPTH-AUTHORITY INPUT — same field, same "read off the
      // START anchor only, default to 0 (an ordinary, low, real elevation,
      // never a magic sentinel) if absent" convention as
      // groupLightningAnchorsIntoSources's own `elevation`. Deliberately
      // reads `bucket.start.elevation` (a TOP-LEVEL field), not
      // `bucket.start.params.elevation` (the raw 0-50 "height off floor"
      // param) — mirroring lightning exactly: boot.js's own render-state seam
      // is what turns the raw param into a real absolute world elevation
      // (`resolveAnchorElevationWorldUnits`, floorBinding.bottom + the
      // param) before an array of anchors ever reaches a grouping function
      // like this one (see getLightningRenderState in boot.js for the
      // existing precedent) — a Phase-2 equivalent seam for rope/chain does
      // the same, entirely outside this pure module's concern.
      const elevationRaw = Number(bucket.start.elevation);

      sources.push({
        linkId,
        seed: hashStringToSeed(linkId),
        // The anchor ids themselves, for the SAME reason lightning's own
        // source carries them: line-drawing UI (ui/anchor-mode.js's
        // linePairs) is keyed by anchor id, not world position, and this
        // function already has bucket.start/bucket.end in hand — inventing a
        // second matcher elsewhere risks two matchers quietly disagreeing.
        startId: bucket.start.id,
        endId: bucket.end.id,
        startX: bucket.start.x,
        startY: bucket.start.y,
        endX: bucket.end.x,
        endY: bucket.end.y,
        preset,
        sagPx,
        thicknessPx,
        windAffected,
        color,
        elevation: Number.isFinite(elevationRaw) ? elevationRaw : 0,
      });
    } else {
      if (bucket.start) orphaned.push({ id: bucket.start.id, linkId, role: 'start' });
      if (bucket.end) orphaned.push({ id: bucket.end.id, linkId, role: 'end' });
      for (const w of bucket.waypoints) orphaned.push({ id: w.id, linkId, role: w.params?.role ?? 'waypoint' });
    }
  }
  return { sources, orphaned };
}

// ============================================================================
// THE ROPE/CHAIN PRESET TABLE — V2's own preset numbers, carried forward as
// RATIOS rather than reused literally, because the simulation method
// underneath is completely different (V2: a Verlet-integrated particle chain
// with iterated distance constraints; here: a couple of damped eigenmode
// oscillators — see this file's own header). Real V2 numbers, for reference
// (confirmed 2026-09-20 against `legacy/scene/physics-rope-manager.js`'s own
// history, cited in this file's header):
//   rope:  windForce 1.2, damping 0.98, tapering 0.55, width 22
//   chain: windForce 0.25, damping 0.92, tapering 0.15, width 18
// ============================================================================

/**
 * The physically-meaningful multipliers a Phase-2 TSL spring integrator
 * consumes, one set per preset. Two fields are DIRECT ports of a V2 ratio
 * (a pure, simulation-method-independent fact); two are DELIBERATE STARTING
 * POINTS for live tuning, not derived from anything — read each field's own
 * comment before trusting its precision.
 *
 * - `windCoupling` — DIRECTLY PORTED ratio. V2's `windForce` was rope 1.2 vs
 *   chain 0.25, a ~4.8x (“~5x”) difference. Rope is normalized to 1.0 here
 *   and chain keeps the same ratio: `1.2 / 0.25 ≈ 4.8` ⇒ `1 / 4.8 ≈ 0.21`.
 * - `taper` — DIRECTLY PORTED ratio. V2's `tapering` (rope 0.55, chain 0.15)
 *   is a pure SHAPE ratio (how much the ribbon narrows along its length),
 *   entirely unaffected by the simulation-method change underneath, so it
 *   carries straight across with no reinterpretation needed.
 * - `modeDamping` — a damping ratio (0..1) for the spring's own `damping`
 *   term (the same `damping` argument {@link springChase} takes). NOT
 *   derived from V2's own `damping` (0.98/0.92) — that number meant "how
 *   much of a Verlet particle's velocity survives one step," the opposite
 *   sense from a spring-chase `damping` (higher here means MORE friction,
 *   i.e. settles FASTER). What IS carried over is the qualitative fact V2's
 *   numbers imply — chain (0.92, more velocity lost per step) settles
 *   faster than rope (0.98) — so chain's `modeDamping` is set HIGHER than
 *   rope's. The actual values (rope 0.35, chain 0.6) are a reasonable
 *   starting point for live tuning, not a derived number.
 * - `modeStiffness` — chain reads as stiffer/higher-frequency than rope (a
 *   taut chain vs. a slack rope), so chain's is set higher. Again a starting
 *   point for live tuning (rope 6, chain 10), not derived from V2 (which had
 *   no equivalent concept at all — its "stiffness" was the distance
 *   constraint's own iteration count/rigidity, not a spring term).
 *
 * @type {Readonly<Record<'rope'|'chain', Readonly<{windCoupling:number, modeDamping:number, modeStiffness:number, taper:number}>>>}
 */
export const ROPE_CHAIN_PRESETS = Object.freeze({
  rope: Object.freeze({
    windCoupling: 1.0,
    modeDamping: 0.35,
    modeStiffness: 6,
    taper: 0.55,
  }),
  chain: Object.freeze({
    windCoupling: 0.21,
    modeDamping: 0.6,
    modeStiffness: 10,
    taper: 0.15,
  }),
});

// ============================================================================
// STATIC DROOP — the cheap stand-in for a true catenary.
// ============================================================================

/**
 * The standard cheap parabolic stand-in for a true catenary — visually
 * indistinguishable from one at the sag ratios this effect targets. Exactly
 * zero at `s=0` and `s=1`, peak `sagPx` at `s=0.5`.
 * @param {number} s - arclength fraction along the span, 0..1.
 * @param {number} sagPx - peak sag (at the midpoint), in world px.
 * @returns {number} the sag offset at `s`, in world px.
 */
export function parabolicSag(s, sagPx) {
  return 4 * sagPx * s * (1 - s);
}

/**
 * PHASE 3 — the normalized 0..1 "implied height above the ground" along the
 * span's own arclength, for the shadow twin's per-vertex throw scale (see
 * `rope-chain-render.js#buildRopeChainShadowMaterial`'s own header for the
 * full design).
 *
 * A rope has only ONE authored height (`elevation`, at the anchors — the
 * candle/lightning "height off floor" convention: `scene/anchor-catalog.js`'s
 * own `ropeChain.elevation` doc). There is no separate, authored per-point
 * height curve, and there cannot be one from a real vertical sag either: the
 * visible droop is a LATERAL bow standing in for a true vertical sag (this
 * file's own header, and `buildRopeChainRibbonArrays`'s "GRAVITY SAG READS AS
 * A LATERAL BOW" comment — a top-down view of a real vertical sag would be
 * invisible from directly overhead, which is why the sag is faked sideways in
 * the first place). So there is no per-point Z-height to read anywhere in
 * this effect's data model.
 *
 * Instead, this reuses the SAME parabolic shape family that already models
 * the sag, at UNIT amplitude: `1 - parabolicSag(s, 1)`. That is 1 (full
 * anchor height) at `s=0` and `s=1`, and 0 (ground level) at `s=0.5` — the
 * sag's own lowest point — matching a real hanging chain's shadow, which sits
 * tight to the chain at its lowest point and is most offset near the
 * elevated mounts.
 *
 * @param {number} s - arclength fraction along the span, 0..1.
 * @returns {number} 1 at the anchors (s=0, s=1), 0 at the sag's lowest point (s=0.5).
 */
export function impliedHeightFraction01(s) {
  return 1 - parabolicSag(s, 1);
}

// ============================================================================
// DYNAMIC WIND SWAY — a damped, wind-forced vibrating string, modelled as a
// sum of a couple of eigenmodes. See issue #1's own design comment for the
// physical argument (a string fixed at both ends really does have mode
// shapes that taper to zero at the supports, matching how tension — and thus
// stiffness against lateral deflection — is highest right at a real hanging
// chain's mounts).
// ============================================================================

/**
 * `d(s) = sum over n (1-indexed) of modeAmplitudes[n-1] * sin(n*pi*s)` — a
 * damped-string eigenmode sum.
 *
 * ⚠️ THIS IS THE TETHER-POINT SAFETY GUARANTEE, AND IT IS A MATHEMATICAL
 * IDENTITY, NOT A CLAMP. `sin(n*pi*0) = 0` and `sin(n*pi*1) = 0` for EVERY
 * integer `n`, for ANY amplitude — so this sum is exactly zero at `s=0` and
 * `s=1` no matter what `modeAmplitudes` contains, including huge or
 * pathological values. That is what makes wind-driven sway structurally
 * INCAPABLE of displacing the two tether anchors: not a value that happens
 * to clamp to zero there (which could always have an edge case — see V2's
 * own failure mode, this file's header), but a basis function that IS zero
 * there by construction. This is issue #1's own answer to "prevent physics
 * bugs at the tether points": *"Every mode is exactly zero at s=0 and s=1
 * for all time, by construction... not because of a clamp that could have an
 * edge case, but because the basis functions themselves vanish there."*
 *
 * @param {number} s - arclength fraction along the span, 0..1.
 * @param {number[]} modeAmplitudes - amplitude of mode `n` at index `n-1`.
 * @returns {number} the wind-driven lateral offset at `s`, in world px.
 */
export function modalDisplacement(s, modeAmplitudes) {
  const amps = Array.isArray(modeAmplitudes) ? modeAmplitudes : [];
  let total = 0;
  for (let i = 0; i < amps.length; i++) {
    const n = i + 1;
    total += amps[i] * Math.sin(n * Math.PI * s);
  }
  return total;
}

// ============================================================================
// THE REFERENCE SPRING INTEGRATOR — a Node-tested oracle a Phase-2 TSL port
// can check itself against, the same relationship lightning-render.js's TSL
// has to lightning-geometry.js's pure functions.
// ============================================================================

/**
 * A driven damped-oscillator "spring-chase" step — Euler-integrated, the
 * EXACT SAME formula as `effects/vegetation-render.js#springChase`
 * (`accel = stiffness*(target-value) - damping*velocity; newVelocity =
 * velocity + accel*dt; newValue = value + newVelocity*dt`). Deliberately
 * DUPLICATED here rather than imported — this effect's own modal integrator
 * should not depend on vegetation's for a generic driven spring, the same
 * "duplicate a small generic helper across effects rather than cross-import"
 * precedent `lightning-geometry.js#lightningCirclePolygon`'s own header sets
 * ("this effect's own light-source builder should not depend on candle's for
 * a generic N-gon"). This one is here so Phase 2's TSL modal integrator has a
 * Node-tested oracle to check itself against, the same relationship
 * lightning-render.js's TSL has to this file's own pure functions.
 *
 * ⚠️ EULER-INTEGRATED, NOT UNCONDITIONALLY STABLE — same warning
 * `vegetation-render.js#springChase`'s own doc carries, word for word in
 * spirit: unlike a closed-form exponential, this can blow up for a large
 * enough `dt` at a high enough `stiffness`. The CALLER must clamp `dt` to a
 * small ceiling before calling this (a code constant, not a live param —
 * mirroring vegetation's own `VEG_SPRING_MAX_DT_SEC`), never pass a raw,
 * unclamped frame delta straight through.
 *
 * @param {number} value - current channel value (world px lateral offset).
 * @param {number} velocity - current channel rate.
 * @param {number} target - where the spring is being driven toward THIS step.
 * @param {number} stiffness - pull-toward-target gain. Higher = faster, higher-frequency response.
 * @param {number} damping - velocity drag. Higher = less overshoot, settles faster.
 * @param {number} dt - seconds, already clamped by the caller.
 * @returns {{value: number, velocity: number}}
 */
export function springChase(value, velocity, target, stiffness, damping, dt) {
  const v = Number.isFinite(value) ? value : 0;
  const vel = Number.isFinite(velocity) ? velocity : 0;
  const tgt = Number.isFinite(target) ? target : 0;
  const k = Number.isFinite(stiffness) ? stiffness : 0;
  const c = Number.isFinite(damping) ? damping : 0;
  const dtSafe = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const accel = k * (tgt - v) - c * vel;
  const newVelocity = vel + accel * dtSafe;
  const newValue = v + newVelocity * dtSafe;
  return { value: newValue, velocity: newVelocity };
}

// ============================================================================
// MODAL FORCING FROM TWO WIND PROBES — the same sum/difference decomposition
// `effects/vegetation-spring-gpu.js` already uses for its own two wind
// probes (torque from the probes' DIFFERENCE, lift from their SUM), applied
// here to a different pair of modes (the fundamental sway vs. its S-curve
// secondary) instead of vegetation's (rotation torque vs. lift magnitude).
// ============================================================================

/**
 * Two wind samples taken perpendicular to the span, at arclength fractions
 * 1/3 and 2/3, decomposed into how much each drives the fundamental sway
 * (mode 1) vs. the S-curve secondary sway (mode 2).
 *
 * WHY 1/3 AND 2/3, AND WHY SUM/DIFFERENCE ISOLATES EACH MODE: `sin(n*pi*s)`
 * at `s=1/3` and `s=2/3` gives mode 1 (`n=1`) the SAME sign at both points —
 * `sin(pi/3) = sin(2*pi/3) = +0.866...`, a symmetric bump — so SUMMING the
 * two samples isolates it. Mode 2 (`n=2`) gives OPPOSITE signs —
 * `sin(2*pi/3) = +0.866...`, `sin(4*pi/3) = -0.866...`, an antisymmetric
 * S-shape — so DIFFERENCING the two samples isolates it instead. This is the
 * exact same trick `effects/vegetation-spring-gpu.js` already uses for its
 * own two wind-differential probe points (the CROSS PRODUCT of their
 * difference is torque — an antisymmetric, side-to-side signal; the
 * MAGNITUDE of their sum is lift — a symmetric, overall-gust signal), just
 * applied to a different pair of modes here. As with vegetation's own torque/
 * lift, the result is left un-normalized (no `/sin(pi/3)` factor) — any
 * missing constant scale folds into whatever live gain a Phase-2 integrator
 * applies before feeding this into {@link springChase}'s own `target`,
 * exactly as vegetation's `torqueGain`/`liftGain` absorb their own signals'
 * leftover scale.
 *
 * @param {number} windPerpAtOneThird - wind component perpendicular to the
 *   span, sampled at arclength fraction 1/3.
 * @param {number} windPerpAtTwoThirds - the same, sampled at 2/3.
 * @returns {{mode1Forcing:number, mode2Forcing:number}}
 */
export function computeModalForcing(windPerpAtOneThird, windPerpAtTwoThirds) {
  const a = Number.isFinite(windPerpAtOneThird) ? windPerpAtOneThird : 0;
  const b = Number.isFinite(windPerpAtTwoThirds) ? windPerpAtTwoThirds : 0;
  return {
    mode1Forcing: (a + b) / 2,
    mode2Forcing: (a - b) / 2,
  };
}

// ============================================================================
// PHASE 2 ADDITION — THE LIVE WIND-PROBE GEOMETRY. Pure (a handful of scalar
// ops from a source's own start/end), so it belongs here rather than inlined
// in rope-chain-subsystem.js — this codebase's own "anything that CAN be pure
// gets Node-tested, nothing GPU-shaped forces a fake test" split
// (CONVENTIONS.md §4).
// ============================================================================

/**
 * The wind-sampling geometry for ONE span's live spring integrator: the
 * chord's own perpendicular unit normal, and the two wind-probe world
 * positions at arclength fractions 1/3 and 2/3 that {@link computeModalForcing}'s
 * own doc explains the choice of (sum isolates mode 1, difference isolates
 * mode 2).
 *
 * The perpendicular is computed BYTE-IDENTICALLY to
 * {@link buildRopeChainRibbonArrays}'s own `-dy/len, dx/len` chord normal —
 * deliberately duplicated rather than factored into one shared internal
 * helper the two would both call, because the two call sites want it for
 * different reasons (one to bow the baked sag/sway shape sideways, this one
 * to know which direction the GPU integrator's wind sample should project
 * onto) and this project's own established precedent
 * (`lightning-geometry.js#lightningCirclePolygon`'s header) is to accept a
 * few duplicated lines of generic math over a cross-couping import when the
 * two uses are conceptually independent. What matters is that the FORMULA
 * stays identical, which this doc comment pins: the static droop and the
 * dynamic wind sway must agree about which way "sideways" is, or a rope
 * would sag one way and swing in an unrelated one.
 *
 * Cheap enough (a realistic scene has single digits to a few dozen spans,
 * never more) that Phase 2's CPU subsystem calls this on every sync rather
 * than caching it — recomputing unconditionally is simpler than tracking
 * "did start/end actually change" and the cost is negligible at this scale.
 *
 * @param {{startX:number, startY:number, endX:number, endY:number}} source -
 *   as produced by {@link groupRopeChainAnchorsIntoSources} (or any object
 *   shape carrying those four fields).
 * @returns {{perpX:number, perpY:number, probeAX:number, probeAY:number, probeBX:number, probeBY:number}}
 *   `perpX`/`perpY` — the chord's unit sideways direction. `probeA`/`probeB`
 *   — world positions at s=1/3 and s=2/3 along the chord, for the GPU
 *   integrator's own two wind samples.
 */
export function computeRopeChainWindProbes(source) {
  const startX = Number.isFinite(source?.startX) ? source.startX : 0;
  const startY = Number.isFinite(source?.startY) ? source.startY : 0;
  const endX = Number.isFinite(source?.endX) ? source.endX : 0;
  const endY = Number.isFinite(source?.endY) ? source.endY : 0;

  const dx = endX - startX;
  const dy = endY - startY;
  const chordLen = Math.max(1e-4, Math.hypot(dx, dy));
  const perpX = -dy / chordLen;
  const perpY = dx / chordLen;

  return {
    perpX,
    perpY,
    probeAX: startX + dx * (1 / 3),
    probeAY: startY + dy * (1 / 3),
    probeBX: startX + dx * (2 / 3),
    probeBY: startY + dy * (2 / 3),
  };
}

// ============================================================================
// THE BATCHED RIBBON VERTEX-ARRAY BAKE — mirrors lightning-geometry.js#
// computeLightningStrandArrays's own position/prevPos/nextPos/side/uvOffset
// quad-strip shape, packed across every source into one pooled buffer set —
// the same "one draw call, not N" outcome, reached here across a pool of
// GM-placed spans rather than lightning's pool of independently-timed
// strikes.
// ============================================================================

/**
 * @param {Array<{startX:number, startY:number, endX:number, endY:number, sagPx:number}>} sources
 *   - as produced by {@link groupRopeChainAnchorsIntoSources}.
 * @param {number} pointsPerSpan - samples per span (>= 2; coerced up if not).
 * @param {(s: number) => number} evalModalDisplacement - the LIVE wind-driven
 *   lateral offset at arclength fraction `s`, supplied by the CALLER. Phase 2
 *   will back this with a per-frame read of live modal amplitudes (typically
 *   via {@link modalDisplacement}); a Node test passes a trivial stub such as
 *   `(s) => 0`, or a fixed-amplitude closure over {@link modalDisplacement}.
 *   ONE callback covers every source in a single call — a caller that needs
 *   independent per-source modal state (the real Phase-2 case: each span
 *   sways on its own live phase) calls this once per source and concatenates
 *   the resulting typed arrays, the same way it would concatenate any other
 *   per-instance bake.
 * @returns {{
 *   positions: Float32Array, prevPos: Float32Array, nextPos: Float32Array,
 *   side: Float32Array, uvOffset: Float32Array, indices: Uint32Array,
 *   sourcePointCounts: number[], vertexCount: number, indexCount: number,
 * }}
 */
export function buildRopeChainRibbonArrays(sources, pointsPerSpan, evalModalDisplacement) {
  const list = Array.isArray(sources) ? sources : [];
  const pts = Math.max(2, Math.floor(pointsPerSpan) || 0);
  const evalMode = typeof evalModalDisplacement === 'function' ? evalModalDisplacement : () => 0;

  const vertCapacity = list.length * pts * 2;
  const positions = new Float32Array(vertCapacity * 3);
  const prevPos = new Float32Array(vertCapacity * 3);
  const nextPos = new Float32Array(vertCapacity * 3);
  const side = new Float32Array(vertCapacity);
  const uvOffset = new Float32Array(vertCapacity);

  const maxIndices = list.length * Math.max(0, pts - 1) * 6;
  const indices = new Uint32Array(maxIndices);

  let vBase = 0;
  let iBase = 0;
  const sourcePointCounts = [];

  for (const source of list) {
    sourcePointCounts.push(pts);

    const startX = Number.isFinite(source?.startX) ? source.startX : 0;
    const startY = Number.isFinite(source?.startY) ? source.startY : 0;
    const endX = Number.isFinite(source?.endX) ? source.endX : 0;
    const endY = Number.isFinite(source?.endY) ? source.endY : 0;
    const sagPx = Number.isFinite(source?.sagPx) ? source.sagPx : 0;

    const dx = endX - startX;
    const dy = endY - startY;
    // The unit normal of the start->end chord — same `-dy/len, dx/len` idiom
    // lightning-geometry.js#generateBoltPath uses for its own bow direction.
    const chordLen = Math.max(1e-4, Math.hypot(dx, dy));
    const nx = -dy / chordLen;
    const ny = dx / chordLen;

    // PASS 1 — every point's FINAL curve position: a straight chord lerp,
    // bowed sideways by the sag + live modal sway, both applied along the
    // chord's own perpendicular. GRAVITY SAG READS AS A LATERAL BOW HERE ON
    // PURPOSE (issue #1's own design comment): this is a top-down projection,
    // and a true top-down view of pure VERTICAL sag would be invisible from
    // directly overhead — so this engine fakes the droop as a lateral bow
    // instead, the same "faked but visually correct" trade this effect's
    // whole shape model makes.
    const xs = new Array(pts);
    const ys = new Array(pts);
    for (let i = 0; i < pts; i++) {
      const s = pts <= 1 ? 0 : i / (pts - 1);
      const baseX = startX + dx * s;
      const baseY = startY + dy * s;
      const perpOffset = parabolicSag(s, sagPx) + evalMode(s);
      xs[i] = baseX + nx * perpOffset;
      ys[i] = baseY + ny * perpOffset;
    }

    for (let i = 0; i < pts; i++) {
      const s = pts <= 1 ? 0 : i / (pts - 1);
      const v0 = vBase + i * 2;
      const v1 = v0 + 1;
      positions[v0 * 3 + 0] = xs[i];
      positions[v0 * 3 + 1] = ys[i];
      positions[v0 * 3 + 2] = 0;
      positions[v1 * 3 + 0] = xs[i];
      positions[v1 * 3 + 1] = ys[i];
      positions[v1 * 3 + 2] = 0;
      // side -1/+1 pairs, and uvOffset per point — for the ribbon-thickness
      // expansion a later TSL vertex shader does. Thickness itself is NOT
      // baked into these arrays, exactly as lightning's own arrays carry
      // `side` for the material to multiply by half-width rather than a
      // pre-widened position — `source.thicknessPx` stays on the source
      // object for that future material to read directly.
      side[v0] = -1;
      side[v1] = 1;
      uvOffset[v0] = s;
      uvOffset[v1] = s;
    }

    // PASS 2 — prevPos/nextPos: the SAME clamp-at-the-ends neighbour lookup
    // computeLightningStrandArrays uses, against the FINAL (post-sag/sway)
    // xs/ys above, not the straight chord — the ribbon-thickness expansion a
    // later TSL vertex shader does needs the curve's own local tangent, not
    // the chord's.
    for (let i = 0; i < pts; i++) {
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(pts - 1, i + 1);
      const vCurr = vBase + i * 2;
      for (let k = 0; k < 2; k++) {
        const v = vCurr + k;
        prevPos[v * 3 + 0] = xs[iPrev];
        prevPos[v * 3 + 1] = ys[iPrev];
        nextPos[v * 3 + 0] = xs[iNext];
        nextPos[v * 3 + 1] = ys[iNext];
      }
    }

    for (let i = 0; i < pts - 1; i++) {
      const a0 = vBase + i * 2;
      const a1 = a0 + 1;
      const b0 = vBase + (i + 1) * 2;
      const b1 = b0 + 1;
      indices[iBase++] = a0;
      indices[iBase++] = a1;
      indices[iBase++] = b0;
      indices[iBase++] = a1;
      indices[iBase++] = b1;
      indices[iBase++] = b0;
    }

    vBase += pts * 2;
  }

  return {
    positions,
    prevPos,
    nextPos,
    side,
    uvOffset,
    indices,
    sourcePointCounts,
    vertexCount: vBase,
    indexCount: iBase,
  };
}
