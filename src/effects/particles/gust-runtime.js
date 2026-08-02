/**
 * WIND GUSTS — runtime (the ribbon-trail engine for {@link WIND_GUSTS}).
 *
 * `createGustEngine(...)` turns the {@link ParticleSystemDecl} into a small
 * population of GPU-resident RIBBON TRAILS. Each trail is ONE arena particle
 * (its "head") that rides the wind field, plus a ring buffer of that head's
 * recent positions; the draw threads a thin, tapering strip THROUGH those
 * remembered points, so the ribbon curves exactly as the head's path curved —
 * snaking around walls and funnelling through gaps. A gust is visible only
 * where the local flow is genuinely fast (its head samples the real relaxed
 * flow magnitude — coherent wind PLUS turbulence, 2026-07-23, see checklist
 * item 6 — and fades to nothing in calm/sheltered air).
 *
 * ============================================================================
 * RELATIONSHIP TO THE DOT ENGINE (particle-runtime.js)
 * ============================================================================
 * This SHARES the real engine — the arena ({@link ParticleArena}) and the
 * same live wind uniforms + baked openness storage-buffer grid the dot
 * engine, candle and overlay all read — but it is a SEPARATE runtime because
 * a ribbon is a different draw primitive than a dot (history buffer + strip
 * mesh, not a billboard quad). See wind-gusts.js's own header for why a
 * sibling runtime, not a `drawStyle` branch, is the right call here. The
 * head-simulation math is a deliberately SIMPLER cousin of
 * particle-runtime.js's update kernel: gusts are flow-followers — coherent
 * `ambient × openness` PLUS turbulence (2026-07-23, see checklist item 6) —
 * with no per-particle chaos-boost/drift concept of their own (no seed-based
 * per-head static bias, no sealed-room "still visibly moving" allowance the
 * dot engine's `uIndoorChaosBoost` provides — a ribbon with nothing to
 * follow simply doesn't spawn a visible trail there, which is the intended
 * look for a WIND TRAIL specifically, unlike ambient dust). The grid-lookup
 * glue (a nearest-cell read of the openness buffer) is
 * duplicated from that file on purpose for this first slice; if a third
 * particle effect ever wants it too, THAT is the moment to extract a shared
 * helper, not before (two call sites is not yet a pattern).
 *
 * ============================================================================
 * TRANSITIONAL STATE — read this
 * ============================================================================
 * Wired DIRECTLY into vt-pan-viewer.js's render loop (the same "not yet a
 * registered pass" pattern the diagnostic particles / candle use). THREE is
 * INJECTED (never imported) so this module's top level stays Node-safe. The
 * arena bookkeeping is Node-tested; the kernels and the draw are browser-only
 * and can ONLY be verified LIVE (CONVENTIONS.md §4) — `npm run verify` proves
 * the JS glue + declaration, never that the snakes look right.
 *
 * THE WALLS force the split exactly as they do for the dot engine: this module
 * may NOT touch setRenderTarget/autoClear (renderer-state is graph/·vt/·diag/
 * only), so the guarded additive DRAW lives in the viewer; here we build the
 * scene + mesh + kernels and dispatch the sync `renderer.compute()`.
 *
 * LIVE-VERIFY CHECKLIST (the things untestable without your GPU):
 *   1. RIBBON ORIENTATION: positionNode places each strip vertex at a remembered
 *      head position offset perpendicular to the local trail tangent. Under the
 *      viewer's Y-flipped ortho camera the perpendicular's handedness is a
 *      coin-flip — if ribbons render inside-out or the taper points the wrong
 *      way, the `normal = (-t.y, t.x)` line is the suspect (the Y-flip class,
 *      feedback_y_flip_recurring_risk — it has bitten world-space quads here
 *      before). `side: DoubleSide` (set below) already sidesteps winding, so a
 *      wrong handedness shows as a mirrored taper, not an invisible ribbon.
 *   2. RING ORDER: the head vertex (seg=segments-1) must read the slot JUST
 *      written this frame (`uHeadSlot`); the tail (seg=0) the oldest. If the
 *      ribbon looks like it trails AHEAD of motion instead of behind, the ring
 *      formula `ringOf()` has its sign flipped.
 *   3. FRESH-SPAWN STREAK: a newly reborn trail collapses all history slots onto
 *      its spawn point, then grows as it moves — so for the first ~`segments`
 *      frames the tail sits at the birth point while the head pulls away. The
 *      fade-in envelope should hide the hard "line from birthplace" look; if it
 *      doesn't, raise fadeMs or seed history along the initial velocity instead.
 *   4. ENERGY GATE: with the scene wind at calm, NO ribbon should be visible; as
 *      you raise the wind, ribbons should appear first at funnels/open areas and
 *      multiply. If ribbons show in dead sealed rooms, the flow-magnitude gate
 *      (`gate` below, stored in custom.x) is reading openness wrong — check the
 *      grid is actually wired (`debugState().hasOpennessGrid`).
 *   5. FIXED (author-reported live: interior trails moving AGAINST the wind at
 *      near-outdoor speed, worse the higher the wind — this file's own
 *      `sampleFlow` used to scale the ambient term by exposure, leaving an
 *      uncancelled residual once a wall-structure grid built to cancel the
 *      FULL ambient was added on top; see world/wind-field.js's own header
 *      for the full account). Still true post-rethink: `sampleFlow` gates the
 *      whole ambient term by `openness` — 1 outdoors/at a doorway, fading with
 *      distance from the nearest open door once past it (2026-07-22, same-day
 *      door-distance falloff, `world/wind-enclosure.js#
 *      distanceFromDoorThreshold`), never damping the ambient FIRST — watch
 *      that a sealed room shows NO gust trails at any wind strength (not just
 *      fewer), and that a trail crossing from outdoors into shelter fades
 *      with distance from the door rather than reversing direction.
 *   6. DOOR-LOCAL CHAOS — DELETED (2026-07-22, THE RETHINK — docs/planning/
 *      Wind-Rethink.md §4), then REBUILT DIFFERENTLY, twice. First deleted:
 *      the old "DOOR CHAOS" was a genuine architecture exception where a
 *      time-varying random wobble near an open door could DOMINATE the
 *      target velocity's direction, layered on top of a separate
 *      `doorChaosGrid`/`windDoorChaosBuffer` (world/wind-enclosure.js#
 *      distanceFromExposedAir, itself seeded from the painted exposure mask
 *      — one of the mechanisms the rethink retired). For a while after that,
 *      gusts read NO turbulence at all — general curl-noise turbulence was
 *      built the SAME day (`world/wind-field.js#sampleWind`'s own organic
 *      term) but gusts never called it (`sampleFlow` below was its own
 *      simplified, coherent-only cousin). REBUILT (2026-07-23, author: "add
 *      turbulence to the wind gusts/ribbons too" — a direct follow-up to the
 *      dot engine's own turbulence rework the same day, `world/wind-field.js#
 *      computeWindTurbulence`'s own header has the full two-octave/
 *      amplitude/wind-speed-link design): `sampleFlow` now ALSO calls
 *      `computeWindTurbulence` directly (not the full `sampleWind` — that
 *      would bundle in the slow whole-scene dir/flutter breeze-lean term too,
 *      which ribbons were never asked to grow), passing this kernel's own
 *      real per-head `openness` (from the storage buffer) for BOTH the
 *      `openness` and `exteriorOpenness` arguments — see that function's own
 *      param doc for why this specific reuse produces a genuinely sensible
 *      curve (calm when sealed, PEAKING at the doorway transition, calmer
 *      once fully outdoors) rather than a flat ramp. The turbulence
 *      contribution is kept SEPARATE from the coherent `ambient × openness`
 *      term all the way through the target-velocity assembly (never
 *      multiplied by `uOutdoorGaleBoost`, which rides the coherent term
 *      only — the SAME coherent/chaos separation principle
 *      particle-runtime.js's own `chaosBoost`/`coherentVec` split already
 *      established) and folds into the visibility gate too (`flowMag` now
 *      includes it), so a ribbon can appear and snake chaotically right at
 *      an open doorway even where the coherent push alone would have been
 *      too weak to trigger the gate. LIVE-VERIFY that a gust still visibly
 *      appears the moment a door opens near fast-moving outdoor air (the
 *      coherent term alone, unchanged), AND that ribbons now show visible
 *      chaotic curvature/scatter near doorway transitions and (more subtly,
 *      larger-scale) outdoors, scaling up with overall wind speed.
 *
 * @module effects/particles/gust-runtime
 */

import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import {
  createWindHandle,
  packWindCells,
  WIND_CELL_VEC4_STRIDE,
  deflectAroundWalls,
  WALL_MOMENTUM_GUARD_LOW,
  WALL_MOMENTUM_GUARD_HIGH,
  WALL_IMPACT_CHAOS_GAIN,
} from '../../world/index.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('gust-runtime');

/** A bake-less handle — an un-wired engine still gets the organic field rather
 * than dead-still ribbons (see candle-flame-render.js's own identical constant). */
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * GALE-FORCE CALIBRATION — identical anchor to particle-runtime.js's own
 * `GALE_MPS` (Beaufort 8, `v ≈ 0.836 × B^1.5 m/s` ≈ 18.92 m/s, docs/reference/
 * wind-simulation-research.md §5.5). Kept as its own const rather than imported
 * so the two runtimes stay independently readable; if a third place needs it,
 * promote it to a shared constant then.
 */
const GALE_MPS = 0.836 * Math.pow(8, 1.5); // ≈ 18.92 m/s

/**
 * Build the ribbon-trail engine for a single declared gust system.
 *
 * @param {object} opts
 * @param {*} opts.THREE - the THREE namespace (injected; this file imports none).
 * @param {import('./particle-system-schema.js').ParticleSystemDecl} opts.system - WIND_GUSTS.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} opts.worldRect - where heads live (a head that drifts out respawns within it, so gusts stay present as the camera pans/zooms — the same exit-test the dot engine uses).
 * @param {number} [opts.zDepth] - world z for the ribbons (must be inside the camera frustum).
 * @param {object} [opts.windHandle] - THE wind handle (`world/wind-access.js`, Wind.md §5.1) — the live ambient uniform nodes AND the geometry-derived per-cell arrays, as one object. Its `kernel()` shape owns the nearest-cell lookup and the ambient-bias arithmetic this file used to carry its own copy of. Refresh on a later rebake via {@link updateWind}.
 * @param {number} [opts.pxPerMeter] - Foundry's real px-per-grid-distance-unit (construction-time only), turning windSpeed01 into a physical world-px/sec ceiling.
 * @returns {{scene:*, capacity:number, init:(r:*)=>void, step:(r:*, frame:object)=>void, setWorldRect:(rect:object)=>void, updateWind:(h:object|null)=>void, debugState:()=>object}}
 */
export function createGustEngine({
  THREE,
  system,
  worldRect,
  zDepth = 0,
  windHandle = TIER0_WIND_HANDLE,
  pxPerMeter = 100,
}) {
  const TSL = THREE.TSL;
  const {
    Fn,
    instanceIndex,
    int,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    sin,
    cos,
    fract,
    smoothstep,
    pow,
    attribute,
    Loop,
  } = TSL;

  const p = system?.params ?? {};
  const capacity = Math.max(1, Math.floor(p.capacity ?? 64));
  // Ring length per trail — a JS-time constant baked into the geometry vertex
  // count AND the kernel's history-buffer stride, so it must be read once here
  // and never change for the engine's life (same discipline as capacity).
  const SEG = Math.max(2, Math.floor(p.segments ?? 32));
  const respawnCandidates = Math.max(1, Math.floor(p.respawnCandidates ?? 2));
  const colorRGB = Array.isArray(p.colorRGB) && p.colorRGB.length === 3 ? p.colorRGB : [0.86, 0.92, 1.0];

  // --- the arena: ONE row per TRAIL (head = a normal particle) --------------
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position; // vec2 world — the head
  const velocity = buffers.velocity; // vec2 world px/s — the head's velocity (momentum)
  const age = buffers.age; // ms alive
  const seed = buffers.seed; // per-trail stable seed
  const custom = buffers.custom; // vec4: x=flow gate, y=flow magnitude, z=openness, w=head speed (readback)

  // --- the TRAIL HISTORY: a ring of `SEG` recent head positions per trail. A
  // --- separate storage buffer (capacity × SEG vec2), legal anywhere under
  // --- effects/particles/ (particles/allocator-only). NOT part of the arena's
  // --- per-particle SoA — it is per-trail-per-segment, its own thing, exactly
  // --- like particle-runtime.js's wind-structure grid buffer. ---------------
  const trailHistory = TSL.instancedArray(capacity * SEG, 'vec2');

  // --- the OPENNESS + WALL-AVOIDANCE grid (2026-07-22 openness, WIDENED
  // --- 2026-07-23 for wall-avoidance): nearest-cell storage lookup, NOT a
  // --- texture sample (the dot engine's own lesson applies identically
  // --- here: texture sampling was never proven from a compute kernel in
  // --- this renderer, storage-buffer reads are). ONE `vec4` buffer — x=
  // --- openness, y/z=wall-away direction, w=wall-proximity — rather than a
  // --- second buffer (see particle-runtime.js's own construction-site
  // --- comment for the full reasoning: this engine already sits at 8
  // --- storage buffers — 6 arena + trailHistory + this one — the WebGPU
  // --- spec-guaranteed floor per stage, and a 9th is a PREVIOUSLY-HIT real
  // --- failure, `vt/texture-limits.js`'s own doc). Uploaded once; refreshed
  // --- on rebake. `?? 1`/`?? 0` — an absent/missing sample defaults to
  // --- "fully open"/"no wall nearby," never a silent "everything is
  // --- sealed" or an invented deflection.
  let windOpennessBuffer = null;
  let opnCols = 1;
  let opnRows = 1;
  let windHandleVersion = windHandle?.version ?? -1;
  if (windHandle?.grid && windHandle?.cells) {
    const { cols, rows } = windHandle.grid;
    opnCols = cols;
    opnRows = rows;
    const n = Math.max(1, cols * rows);
    // × WIND_CELL_VEC4_STRIDE — one cell is more than one vec4 (see that
    // constant's own header). Allocating `n` here would silently truncate the
    // grid to its first half.
    windOpennessBuffer = TSL.instancedArray(n * WIND_CELL_VEC4_STRIDE, 'vec4');
    packWindCells(windOpennessBuffer.value, windHandle.cells, n);
  }

  // --- uniforms: built once, values updated per frame -----------------------
  const uDtSec = uniform(0);
  const uTimeMs = uniform(0);
  const uRectMin = uniform(vec2(worldRect.minX, worldRect.minY));
  const uRectSize = uniform(vec2(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  const uWindGain = uniform(float(p.windGain ?? 0.9));
  const uOutdoorGaleBoost = uniform(float(p.outdoorGaleBoost ?? 2));
  const uMaxSpeedAtGalePxPerSec = float(pxPerMeter * GALE_MPS);
  const uAccelToMaxSeconds = uniform(float(Math.max(0.05, p.accelToMaxSeconds ?? 1.2)));
  const uLifeMs = uniform(float(Math.max(1, p.lifeMs ?? 4000)));
  const uFadeMs = uniform(float(Math.min(p.fadeMs ?? 1200, (p.lifeMs ?? 4000) / 2)));
  const uFlowLo = uniform(float(p.flowLo ?? 0.12));
  const uFlowHi = uniform(float(Math.max((p.flowLo ?? 0.12) + 1e-3, p.flowHi ?? 0.35)));
  const uWidthPx = uniform(float(p.widthPx ?? 12));
  const uOpacityMax = uniform(float(p.opacityMax ?? 0.7));
  // Active-trail count (set from windSpeed01 each frame in step()) — a trail
  // whose index is >= this is forced invisible, giving "a few, more when
  // windier" independent of the per-trail flow gate.
  const uActiveTrails = uniform(float(Math.max(1, Math.floor(p.minTrails ?? 3))));
  // The ring write-head slot [0, SEG) — advanced by JS each frame in step(), so
  // the kernel appends this frame's head position at exactly one slot and the
  // draw reads the ring relative to it.
  const uHeadSlot = uniform(0);

  const color = vec3(colorRGB[0], colorRGB[1], colorRGB[2]);

  // A tiny self-contained hash → [0,1). Same fract(sin(·)) idiom the dot engine
  // uses (deliberately not depending on TSL.hash being exported).
  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  // --- SHARED FLOW SAMPLE (2026-07-22, THE RETHINK): the dimensionless
  // --- coherent flow vector + magnitude at a world position — ambient bias ×
  // --- openness, geometry-gated to exactly zero wherever a cell is sealed
  // --- off (no painted mask, no physics solve — see world/wind-enclosure.js#
  // --- floodFillOpenFromBoundary's own header). Reused by the head
  // --- integration AND the respawn bias. Not a TSL Fn (it closes over the
  // --- grid buffer/uniforms), just a JS helper returning nodes. -------------
  const sampleFlow = (pos) => {
    // THE ONE DOOR (Wind.md §5.1) — the nearest-cell lookup, the meteorological
    // ambient-bias arithmetic and the wall deflection all live in the handle's
    // `kernel()` shape now. This file used to carry its own copy of all three,
    // agreeing with `sampleWind` (and with particle-runtime.js's third copy)
    // only by a comment promising it did. A Node test asserts it now
    // (world/__tests__/wind-access.test.mjs).
    const w = windHandle.kernel(TSL, { centerXY: pos, time: uTimeMs, cellBuffer: windOpennessBuffer });
    const { openness, wallAwayDirX, wallAwayDirY, wallProximity } = w;
    // `coherent` comes back UNGATED — gate it by `openness` here (sealed → 0 →
    // dead calm; open → 1 → full ambient; no walls at all → openness 1
    // everywhere → wind everywhere). The handle deliberately does NOT gate for
    // us: particle-runtime.js gates the same term differently, and both are
    // right (see `kernel()`'s own doc).
    const flowVec = w.coherent.mul(openness);
    // TURBULENCE — kept as its OWN separate vector, not folded into `flowVec`:
    // the update kernel's target-velocity assembly applies `uOutdoorGaleBoost`
    // to the coherent term ONLY, never to chaos (the same coherent/chaos
    // separation principle particle-runtime.js's own split established).
    const turbulenceVec = w.turbulence;
    // `flowMag` is the TOTAL (coherent + turbulence) magnitude — both the
    // windiest-of-N respawn-candidate search and the visibility gate below
    // should prefer/reveal a spot that's chaotically alive even where the
    // coherent push alone is weak, e.g. right at an open doorway.
    return {
      flowVec,
      turbulenceVec,
      flowMag: flowVec.add(turbulenceVec).length(),
      openness,
      // The wall fields, passed straight through so the momentum guard below
      // can reuse THIS sample's own cell read instead of doing a second,
      // identical storage lookup at the same position (which is what it used
      // to do — a duplicated lookup that also duplicated the index arithmetic).
      wallAwayDirX,
      wallAwayDirY,
      wallProximity,
    };
  };

  // A random world point inside the current rect, from two hash salts.
  const randPointInRect = (sa, sb) =>
    vec2(uRectMin.x.add(uRectSize.x.mul(hash11(sa))), uRectMin.y.add(uRectSize.y.mul(hash11(sb))));

  // --- SEED kernel: spread heads across the rect; collapse each trail's whole
  // --- ring onto its head so a fresh trail has zero length until it moves. ---
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    const start = vec2(
      uRectMin.x.add(uRectSize.x.mul(hash11(fi.mul(2.17).add(11.3)))),
      uRectMin.y.add(uRectSize.y.mul(hash11(fi.mul(1.31).add(47.9))))
    );
    position.element(i).assign(start);
    velocity.element(i).assign(vec2(0, 0));
    seed.element(i).assign(fi);
    // Stagger ages across the FULL lifetime so the population starts mid-cycle,
    // not all fading in from birth in lockstep.
    age.element(i).assign(hash11(fi.mul(3.7)).mul(uLifeMs));
    custom.element(i).assign(vec4(0, 0, 1, 0));
    const base = int(i).mul(int(SEG));
    Loop(SEG, ({ i: k }) => {
      trailHistory.element(base.add(k)).assign(start);
    });
  })().compute(capacity);

  // --- UPDATE kernel: integrate the head along the flow, append to the ring --
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);

    // Only the flow VECTOR(s) are needed for the head's target here; the
    // visibility gate re-samples at the FINAL position below (so a
    // just-respawned head's gate reflects where it landed, not where it was).
    const flow = sampleFlow(pos);
    const { flowVec, turbulenceVec } = flow;
    // The PREVAILING strength, for this engine's own speed ceiling — a
    // different question from "what is the wind vector here", which is why the
    // handle exposes it (see its `ambient` field's own doc).
    const windSpeed01 = windHandle.ambient ? windHandle.ambient.speed01 : float(1);

    // TARGET velocity (real world px/sec): coherent flow PLUS turbulence, as
    // two SEPARATELY-scaled terms (2026-07-23, see this module's own header,
    // checklist item 6, for the full "add turbulence to ribbons" account —
    // this REPLACES the old door-proximity chaos wobble that used to live
    // here and was deleted 2026-07-22). `flowVec` is already openness-gated
    // inside `sampleFlow`, so the coherent term is zero by construction in a
    // sealed room; `turbulenceVec` has its OWN, separate sealed/doorway/
    // outdoor amplitude shape (`world/wind-field.js#computeWindTurbulence`)
    // and is NEVER multiplied by `uOutdoorGaleBoost` — that boost rides the
    // coherent term and the ceiling together, keeping the ceiling
    // location-independent (the same coherent/chaos separation
    // particle-runtime.js's own target-velocity assembly already uses).
    const targetRaw = flowVec
      .mul(uMaxSpeedAtGalePxPerSec)
      .mul(uWindGain)
      .mul(uOutdoorGaleBoost)
      .add(turbulenceVec.mul(uMaxSpeedAtGalePxPerSec).mul(uWindGain));
    const ceilingPxPerSec = uMaxSpeedAtGalePxPerSec.mul(windSpeed01).mul(uOutdoorGaleBoost).max(float(1));
    const targetSpeed = targetRaw.length();
    const overCeiling = targetSpeed.greaterThan(ceilingPxPerSec);
    const clamped = targetRaw.mul(ceilingPxPerSec.div(targetSpeed.max(float(1))));
    const targetVel = overCeiling.select(clamped, targetRaw);

    // Accelerate toward the target, bounded by accelToMaxSeconds (momentum —
    // what gives the ribbon its natural curved lag). Constant-magnitude ramp:
    // the ceiling is location-independent, so no braking-collapse pathology
    // (the dot engine's items 25-28 saga) is possible here.
    const maxAccelPxPerSec2 = ceilingPxPerSec.div(uAccelToMaxSeconds);
    const oldVel = velocity.element(i);
    const toTarget = targetVel.sub(oldVel);
    const toTargetDist = toTarget.length();
    const maxStep = maxAccelPxPerSec2.mul(uDtSec);
    const reaches = toTargetDist.lessThanEqual(maxStep);
    const step = toTarget.mul(maxStep.div(toTargetDist.max(float(0.0001))));
    const blendedVel = oldVel.add(reaches.select(toTarget, step));
    // WALL AVOIDANCE ON THE ACTUAL MOVE, NOT JUST THE TARGET (2026-07-23) —
    // see particle-runtime.js's own identical block for the full reasoning:
    // `flowVec` (targetVel's own ingredient) is already deflected, but this
    // head has MOMENTUM (`oldVel`), eased toward the target over
    // `uAccelToMaxSeconds` rather than snapping — a head already carrying
    // speed into a wall when it enters the deflection zone can still coast
    // forward on old momentum for a few frames while braking/turning catches
    // up. Deflecting `blendedVel` itself, at THIS frame's starting position
    // (the SAME wallAwayDirX/Y/wallProximity `sampleFlow` already read for
    // `flowVec` — its return now hands them straight through rather than this
    // block repeating the lookup, as it used to), cancels whatever into-wall
    // component survived the acceleration blend before it becomes a
    // displacement — and since
    // this IS what gets stored back into the velocity buffer below, the
    // head's own momentum is corrected too, not just this one frame's move.
    // The RIBBON follows automatically: it is drawn through the head's own
    // recorded positions (trailHistory below), so a head that curves around
    // a wall leaves a curving ribbon, with no separate fix needed for the
    // trail geometry itself.
    //
    // A NARROWER PROXIMITY, JUST FOR THIS PASS (2026-07-23) — see
    // particle-runtime.js's own identical block for the full "why a second,
    // narrower threshold" reasoning: this correction is applied INSTANTLY (a
    // direct reassignment, not eased through `maxAccelPxPerSec2` like every
    // other velocity change here), so across the FULL WIDTH of the wide
    // reach it read as an abrupt shove the instant a head crossed the
    // boundary, and every head entering that wide band got turned back
    // before it ever got near the wall — piling up at the band's own outer
    // edge. `flowVec` (above, feeding `targetVel`) already gives the wide,
    // gradual "curve as you approach" look, smoothed by this kernel's own
    // normal acceleration rate; THIS pass's job is narrower — a last-instant
    // guarantee against tunnelling — so it should only fire right before
    // contact.
    let vel = blendedVel;
    if (windOpennessBuffer) {
      // REUSES `sampleFlow`'s own cell read at this SAME position (see its
      // return value's own comment) — this block used to repeat the index
      // arithmetic and the buffer fetch verbatim, a third copy of the lookup
      // the handle now owns.
      const momentumGuardProximity = smoothstep(
        float(WALL_MOMENTUM_GUARD_LOW),
        float(WALL_MOMENTUM_GUARD_HIGH),
        flow.wallProximity
      );
      // CHAOTIC IMPACT KICK (2026-07-23) — see particle-runtime.js's own
      // identical block, and deflectAroundWalls's header in world/wind-field.js,
      // for the full "why a dead-on hit gets no redirect otherwise" reasoning.
      // Same hash11 idiom already used for spawn above, seeded from this
      // head's own stable seed `s` plus its current position plus a slow
      // time term.
      const chaosAngle = hash11(s.mul(11.7).add(pos.x.mul(0.023)).add(pos.y.mul(0.019)).add(uTimeMs.mul(0.0007))).mul(
        float(Math.PI * 2)
      );
      vel = deflectAroundWalls(TSL, {
        vector: blendedVel,
        awayDirX: flow.wallAwayDirX,
        awayDirY: flow.wallAwayDirY,
        proximity: momentumGuardProximity,
        chaosDirX: cos(chaosAngle),
        chaosDirY: sin(chaosAngle),
        chaosAmount: momentumGuardProximity.mul(float(WALL_IMPACT_CHAOS_GAIN)),
      });
    }
    const next = pos.add(vel.mul(uDtSec));

    // Respawn on leaving the rect OR ageing out (same visual: fresh random spot).
    const outOfBounds = next.x
      .lessThan(uRectMin.x)
      .or(next.x.greaterThan(uRectMin.x.add(uRectSize.x)))
      .or(next.y.lessThan(uRectMin.y))
      .or(next.y.greaterThan(uRectMin.y.add(uRectSize.y)));
    const ageExpired = age.element(i).greaterThanEqual(uLifeMs);
    const shouldRespawn = outOfBounds.or(ageExpired);

    // BIASED reseed: pick the windiest of `respawnCandidates` random points, so
    // the few trails concentrate into fast air. Bounded, position+seed-hashed
    // entropy (never the raw unbounded clock — the dot engine's fix-8 precision
    // trap). Unrolled at JS-build time (respawnCandidates is a small constant).
    let bestPos = randPointInRect(
      s.mul(0.61).add(next.x.mul(0.011)).add(7.0),
      s.mul(0.83).add(next.y.mul(0.013)).add(51.0)
    );
    let bestMag = sampleFlow(bestPos).flowMag;
    for (let c = 1; c < respawnCandidates; c++) {
      const cand = randPointInRect(
        s
          .mul(0.47)
          .add(next.y.mul(0.017))
          .add(13.0 + c * 7.13),
        s
          .mul(0.29)
          .add(next.x.mul(0.019))
          .add(29.0 + c * 3.71)
      );
      const mag = sampleFlow(cand).flowMag;
      const better = mag.greaterThan(bestMag);
      bestPos = better.select(cand, bestPos);
      bestMag = better.select(mag, bestMag);
    }
    const finalPos = shouldRespawn.select(bestPos, next);

    position.element(i).assign(finalPos);
    velocity.element(i).assign(shouldRespawn.select(vec2(0, 0), vel));

    // VISIBILITY GATE: how fast is the real flow here, relative to the scene's
    // wind dial? Below flowLo → invisible; above flowHi → full. This is the
    // whole "only where the flow is fast" behaviour, stored per-trail for the
    // draw (and for a debug readback). Recomputed at the FINAL position so a
    // just-respawned trail's gate already reflects where it landed.
    //
    // `finalFlow.flowMag` is already openness-gated inside `sampleFlow` (2026-
    // 07-22, THE RETHINK) — exactly 0 wherever the cell is sealed off, so a
    // gust simply does not appear there, by construction, not because a
    // relaxation happened to converge. No separate reach multiply or door-
    // chaos bonus needed here anymore (see this module's own header,
    // checklist item 6, for what used to be here).
    const finalFlow = sampleFlow(finalPos);
    const gate = smoothstep(uFlowLo, uFlowHi, finalFlow.flowMag.mul(windSpeed01));
    // x = gate (READ BY THE DRAW's opacityNode below — must stay this exact
    // slot); y/z/w are diagnostic-only (flowMag, openness, head speed).
    custom.element(i).assign(vec4(gate, finalFlow.flowMag, finalFlow.openness, vel.length()));

    // APPEND to the ring: write finalPos to the head slot; on respawn overwrite
    // EVERY slot (collapse the ribbon onto the new spawn point). One branchless
    // Loop — reading `cur` and writing it back unchanged is a harmless no-op
    // where neither condition selects. Each slot is independent (no in-buffer
    // shift), so there is no read-after-write hazard.
    const base = int(i).mul(int(SEG));
    const headSlotInt = int(uHeadSlot);
    Loop(SEG, ({ i: k }) => {
      const slot = base.add(k);
      const isHead = k.equal(headSlotInt);
      const write = shouldRespawn.or(isHead);
      const cur = trailHistory.element(slot);
      trailHistory.element(slot).assign(write.select(finalPos, cur));
    });

    // Age: reborn trails restart at 0 (fade in from nothing); others advance.
    const agedMs = age.element(i).add(uDtSec.mul(1000));
    age.element(i).assign(shouldRespawn.select(float(0), agedMs));
  })().compute(capacity);

  // ==========================================================================
  // THE DRAW: one InstancedBufferGeometry, one ribbon strip per trail.
  // ==========================================================================
  // Base geometry: a flat strip of SEG cross-sections, 2 vertices each (left/
  // right edge). Per-vertex attributes `aSeg` (which history point, 0..SEG-1)
  // and `aSide` (-1/+1, which edge) drive positionNode; the actual world
  // position comes from the history buffer, not this template's `position`
  // (which is a required-but-unused dummy). instanceCount = capacity (trails).
  const vertCount = SEG * 2;
  const positions = new Float32Array(vertCount * 3); // dummy; real pos from the node
  const aSeg = new Float32Array(vertCount);
  const aSide = new Float32Array(vertCount);
  for (let k = 0; k < SEG; k++) {
    for (let sdx = 0; sdx < 2; sdx++) {
      const vi = k * 2 + sdx;
      aSeg[vi] = k;
      aSide[vi] = sdx === 0 ? -1 : 1;
    }
  }
  // Two triangles per gap between adjacent cross-sections (SEG-1 gaps).
  const indices = [];
  for (let k = 0; k < SEG - 1; k++) {
    const a = k * 2; // left  @ k
    const b = k * 2 + 1; // right @ k
    const c = (k + 1) * 2; // left  @ k+1
    const d = (k + 1) * 2 + 1; // right @ k+1
    indices.push(a, b, c, c, b, d);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeg', new THREE.BufferAttribute(aSeg, 1));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
  geometry.setIndex(indices);
  geometry.instanceCount = capacity;

  const segNode = attribute('aSeg', 'float');
  const sideNode = attribute('aSide', 'float');
  const segMax = float(SEG - 1);

  // Ring slot for a given segment index (0=tail .. SEG-1=head). The head reads
  // the slot written THIS frame (uHeadSlot); older segments read progressively
  // earlier slots. +SEG*4 keeps the value positive before the modulo.
  const ringOf = (segF) =>
    segF
      .add(uHeadSlot)
      .sub(segMax)
      .add(float(SEG * 4))
      .mod(float(SEG))
      .floor();
  const readSeg = (segF) =>
    trailHistory.element(
      int(instanceIndex)
        .mul(int(SEG))
        .add(int(ringOf(segF)))
    );

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const center = readSeg(segNode);
    // Tangent from the neighbouring cross-sections (clamped at the ends).
    const prevSeg = segNode.sub(float(1)).max(float(0));
    const nextSeg = segNode.add(float(1)).min(segMax);
    const a = readSeg(prevSeg);
    const b = readSeg(nextSeg);
    const tan = b.sub(a);
    const tanLen = tan.length();
    // Degenerate (collapsed fresh trail): fall back to the head's velocity
    // direction, then to +x, so normalize never divides by zero.
    const vHead = velocity.element(instanceIndex);
    const vLen = vHead.length();
    const vDir = vLen.greaterThan(float(1e-4)).select(vHead.div(vLen.max(float(1e-4))), vec2(1, 0));
    const tDir = tanLen.greaterThan(float(1e-4)).select(tan.div(tanLen.max(float(1e-4))), vDir);
    const normal = vec2(tDir.y.negate(), tDir.x);
    // Comet taper: full width at the head (t01=1), → 0 at the tail (t01=0).
    const t01 = segNode.div(segMax);
    const halfW = uWidthPx.mul(pow(t01, float(0.7))).mul(float(0.5));
    const world = center.add(normal.mul(sideNode).mul(halfW));
    return vec3(world.x, world.y, float(zDepth));
  })();

  material.colorNode = color;

  // Per-vertex fade data carried to the fragment stage (storage/attribute reads
  // are vertex-stage only on this renderer — same reason the dot engine bundles
  // its `vFade`). x=taper t01, y=gate×active, z=lifeFade, w=side.
  const vGust = Fn(() => {
    const trail = instanceIndex;
    const gate = custom.element(trail).x;
    const active = float(trail).lessThan(uActiveTrails).select(float(1), float(0));
    const ageMs = age.element(trail);
    const fadeIn = ageMs.div(uFadeMs).clamp(float(0), float(1));
    const fadeOut = uLifeMs.sub(ageMs).div(uFadeMs).clamp(float(0), float(1));
    const lifeFade = fadeIn.min(fadeOut);
    const t01 = segNode.div(segMax);
    return vec4(t01, gate.mul(active), lifeFade, sideNode);
  })().toVarying('vGust');

  material.opacityNode = Fn(() => {
    const t01 = vGust.x;
    const gateActive = vGust.y;
    const lifeFade = vGust.z;
    const side = vGust.w;
    // Soft edges across the ribbon width: side interpolates -1..+1, so
    // |side| is 0 at the centre-line and 1 at the two edges.
    const edgeSoft = float(1).sub(side.abs());
    // Head brighter than tail (comet).
    const tailAlpha = pow(t01.clamp(float(0), float(1)), float(1.2));
    return gateActive.mul(lifeFade).mul(edgeSoft).mul(tailAlpha).mul(uOpacityMax);
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  // DoubleSide sidesteps winding under the flipped camera — the same fix the
  // candle billboard and the dot engine both needed (a wrong winding culls the
  // whole ribbon silently under FrontSide).
  material.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // world-space bounds vary per frame; the GPU gates it
  const scene = new THREE.Scene();
  scene.add(mesh);

  let seeded = false;
  let headSlot = 0;
  let lastRectArea = null;
  const minTrails = Math.max(1, Math.floor(p.minTrails ?? 3));
  const maxTrails = Math.max(minTrails, Math.floor(p.maxTrails ?? 24));

  return {
    scene,
    capacity,

    /** Seed the field once. Idempotent. Call after the world rect is set. */
    init(renderer) {
      if (seeded) return;
      renderer.compute(seedKernel);
      seeded = true;
      log.info(`seeded ${capacity} ${system.id} gust trails (${SEG} segments each)`);
    },

    /**
     * Advance one frame. Synchronous compute (never in-frame readback).
     * @param {*} renderer
     * @param {{dtSec:number, tMs:number, worldRect?:object}} frame
     */
    step(renderer, { dtSec, tMs, worldRect: rect }) {
      if (rect) this.setWorldRect(rect);
      uDtSec.value = Math.min(0.05, Math.max(0, dtSec || 0));
      uTimeMs.value = tMs || 0;
      // Advance the ring write-head BEFORE the kernel appends, so this frame's
      // head position lands in `headSlot` and the draw (later this frame) reads
      // the ring relative to the same value.
      headSlot = (headSlot + 1) % SEG;
      uHeadSlot.value = headSlot;
      // "A few, more when windier": active count follows windSpeed01 on a sqrt
      // curve (mid settings pulled up so a breeze already reads busier than calm).
      const w = Math.max(0, Math.min(1, windHandle.ambient?.speed01?.value ?? 1));
      uActiveTrails.value = Math.round(minTrails + (maxTrails - minTrails) * Math.sqrt(w));
      if (!seeded) this.init(renderer);
      renderer.compute(updateKernel);
    },

    /** Move the field's world rect (camera pan/zoom). Exit-test handles the rest. */
    setWorldRect(rect) {
      const area = Math.max(1, (rect.maxX - rect.minX) * (rect.maxY - rect.minY));
      lastRectArea = area;
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(rect.maxX - rect.minX, rect.maxY - rect.minY);
    },

    /**
     * Adopt a NEWER wind handle after a rebake (see the dot engine's twin).
     *
     * Unlike a material — which bakes the grid spec in as build-time constants
     * and must be torn down and rebuilt — this engine's storage buffer can be
     * refreshed IN PLACE, because cols/rows are stable across an ordinary
     * rebake. A genuine REGRID is refused loudly rather than hot-patched: the
     * buffer would need reallocating and the kernel's own index arithmetic was
     * baked against the old dimensions.
     *
     * The `version` check is the point of the handle's version field: a
     * consumer holding derived state compares what it built against and acts.
     * @param {object|null} nextHandle
     */
    updateWind(nextHandle) {
      if (!windOpennessBuffer || !nextHandle?.grid || !nextHandle?.cells) return;
      if (nextHandle.version === windHandleVersion) return; // nothing changed
      const { cols, rows } = nextHandle.grid;
      if (cols !== opnCols || rows !== opnRows) {
        log.error(
          `gust wind grid size changed (${opnCols}x${opnRows} -> ${cols}x${rows}) — ignoring this rebake ` +
            '(the storage buffer would need reallocating; other wind-reading materials still update).'
        );
        return;
      }
      packWindCells(windOpennessBuffer.value, nextHandle.cells, cols * rows);
      windHandleVersion = nextHandle.version;
    },

    /** For the debug panel: prove the engine is alive without a screenshot. */
    debugState() {
      return {
        system: system.id,
        capacity,
        segments: SEG,
        seeded,
        activeTrails: uActiveTrails.value,
        headSlot,
        lastRectArea,
        hasOpennessGrid: !!windOpennessBuffer,
      };
    },
  };
}
