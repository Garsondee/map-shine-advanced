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
 * ============================================================================
 * 2026-10-27 — REAL SPEED, AND A SECOND COSTUME (WIND TRAILS)
 * ============================================================================
 * The author: *"Almost nothing seemed to be reacting in time with these high
 * red large arrow waves"* and *"a grid space in Foundry in PF2E is 5ft x 5ft -
 * so you could try and find real world values"*. This engine used to turn the
 * field into px/s with `GALE_MPS × pxPerMeter × outdoorGaleBoost`, where
 * `pxPerMeter` was in fact Foundry's px per GRID DISTANCE UNIT — px per FOOT on
 * a 5 ft map — so every ribbon crawled at ~1/3.3 of the speed it claimed, and a
 * hand-set 2× boost sat on top. Now a head's target velocity is the field's own
 * vector converted at the scene's real px/m (`world/wind-field.js#
 * windFieldPxPerSecPerUnit`, the handle's live `ambient.pixelsPerMetre`): the
 * heads move EXACTLY as fast as the air the overlay draws, gusts included. The
 * visibility gate is in real m/s too.
 *
 * The same engine now also draws WIND TRAILS (`effects/wind-trails.js`) —
 * short-lived (1-2 s), fat, tapered white strokes that curl as they die. The
 * differences are all declaration params read below (all optional; WIND_GUSTS
 * omits them and keeps its own look): `profile: 'spindle'` (fat body, pointed
 * both ends), `swirl` + `swirlVariation` (some trails loop a whole number of
 * turns and rejoin the wind, `trail-swirl.js`), `sizeVariation` (per-trail
 * width and length),
 * `segmentSec` (the history is sampled on a fixed clock, so a trail's length is
 * seconds-of-path at any frame rate), `lifeJitter`, and `blending: 'normal'`.
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
  WIND_DEFAULT_PIXELS_PER_METRE,
  WIND_GUST_PEAK,
  windFieldPxPerSecPerUnit,
  windStrength01ForSpeed01,
  windTravelPxPerSec,
  windGridUvNode,
} from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import { buildWeatherShadeNode } from '../lighting/weather-shade.js';
import { buildTrailSwirlNodes, buildTrailSizeNodes } from './trail-swirl.js';

const log = createLogger('gust-runtime');

/**
 * A tracer's tightest turn, metres of radius (TRACER MODE). The 3-D air is one cell per grid square (~1.5 m) and its
 * swirl is metres across, so real air at 1-2 m never turns tighter than this; a heading that wants to (a kink in the
 * field, a wall straight ahead) eases round instead. Loops are drawn on top of it and keep their own size.
 */
export const TRACER_MIN_RADIUS_M = 0.8;

/** TRACER MODE births (2026-11-10): a gust's score (0..1, `gustScoreAt`) a trail needs to be born. */
export const TRACER_GUST_BIRTH = 0.3;
/** A dormant tracer slot rests this long (plus up to `TRACER_REST_SPAN_MS`, per seed) before it looks again. */
export const TRACER_REST_MIN_MS = 350;
export const TRACER_REST_SPAN_MS = 1400;
/** How far past the view a tracer may drift while it fades out (a share of the view size) before it is reborn. */
export const TRACER_EXIT_PAD = 0.35;

/** A bake-less handle — an un-wired engine still gets the organic field rather
 * than dead-still ribbons (see candle-flame-render.js's own identical constant). */
const TIER0_WIND_HANDLE = createWindHandle();

/** How many different lives (seeds) a trail slot cycles through before repeating. */
const LIFE_SEEDS = 29;

/** Field magnitude → m/s (the dial is linear to 70 m/s — `world/wind-scale.js`). */
const MPS_PER_FIELD_UNIT = windFieldPxPerSecPerUnit(1);

/**
 * Build the ribbon-trail engine for a single declared gust system.
 *
 * @param {object} opts
 * @param {*} opts.THREE - the THREE namespace (injected; this file imports none).
 * @param {import('./particle-system-schema.js').ParticleSystemDecl} opts.system - WIND_GUSTS.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} opts.worldRect - where heads live (a head that drifts out respawns within it, so gusts stay present as the camera pans/zooms — the same exit-test the dot engine uses).
 * @param {number} [opts.zDepth] - world z for the ribbons (must be inside the camera frustum).
 * @param {object} [opts.windHandle] - THE wind handle (`world/wind-access.js`, Wind.md §5.1) — the live ambient uniform nodes AND the geometry-derived per-cell arrays, as one object. Its `kernel()` shape owns the nearest-cell lookup and the ambient-bias arithmetic this file used to carry its own copy of. Refresh on a later rebake via {@link updateWind}.
 * @param {number} [opts.pxPerMeter] - RETIRED 2026-10-27 (it was px per grid-distance UNIT — feet on most maps — not per metre). Ignored when the handle carries `ambient.pixelsPerMetre`; otherwise a fallback.
 * @returns {{scene:*, capacity:number, init:(r:*)=>void, step:(r:*, frame:object)=>void, setWorldRect:(rect:object)=>void, updateWind:(h:object|null)=>void, debugState:()=>object}}
 */
export function createGustEngine({
  THREE,
  system,
  worldRect,
  zDepth = 0,
  windHandle = TIER0_WIND_HANDLE,
  pxPerMeter = WIND_DEFAULT_PIXELS_PER_METRE,
  /** `buf:scene.illum` — ribbons darken in a building's shadow like the ground. Absent ⇒ compiled out. */
  illumTexture = null,
  /** TRACER mode only: the floor's `_Outdoors` mask node + its world rect (vec4 minX,minY,maxX,maxY) — the wall. */
  outdoorsTexNode = null,
  uOutdoorsRect = null,
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
    mix,
    pow,
    attribute,
    Loop,
    max,
  } = TSL;

  const p = system?.params ?? {};
  const capacity = Math.max(1, Math.floor(p.capacity ?? 64));
  // Ring length per trail — a JS-time constant baked into the geometry vertex
  // count AND the kernel's history-buffer stride, so it must be read once here
  // and never change for the engine's life (same discipline as capacity).
  const SEG = Math.max(2, Math.floor(p.segments ?? 32));
  const respawnCandidates = Math.max(1, Math.floor(p.respawnCandidates ?? 2));
  const colorRGB = Array.isArray(p.colorRGB) && p.colorRGB.length === 3 ? p.colorRGB : [0.86, 0.92, 1.0];
  // The trail costume's switches (see this file's 2026-10-27 header). Each is
  // a JS-time choice — a different graph, never a uniform gate.
  const spindle = p.profile === 'spindle';
  const swirlOn = Number.isFinite(p.swirl) && p.swirl >= 0;
  // Per-trail SIZE (width × length) spread by `sizeVariation` — trails only.
  const sizeOn = Number.isFinite(p.sizeVariation);
  // Trails re-roll their seed every life (see the end of the update kernel);
  // the wind-gust ribbons keep their fixed per-slot seed.
  const varyPerLife = swirlOn || sizeOn;
  let segmentSec = Number.isFinite(p.segmentSec) && p.segmentSec > 0 ? p.segmentSec : 0;
  const lifeJitter = Number.isFinite(p.lifeJitter) ? Math.min(0.9, Math.max(0, p.lifeJitter)) : 0;
  const maxLengthM = Number.isFinite(p.maxLengthM) && p.maxLengthM > 0 ? p.maxLengthM : 0;

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
  // THE REAL SCALE — the handle's live px/m uniform (refreshed per scene by the
  // viewer), or a construction-time fallback for a handle-less engine.
  const pixelsPerMetreNode = windHandle?.ambient?.pixelsPerMetre ?? float(pxPerMeter);
  const pxPerSecPerFieldUnit = windFieldPxPerSecPerUnit(pixelsPerMetreNode);
  // Visibility thresholds in REAL m/s of local flow.
  const uGateLoMps = uniform(float(p.gateLoMps ?? 8));
  const uGateHiMps = uniform(float(Math.max((p.gateLoMps ?? 8) + 0.1, p.gateHiMps ?? 18)));
  const uSwirl = uniform(float(swirlOn ? p.swirl : 0));
  const uSwirlVar = uniform(float(Number.isFinite(p.swirlVariation) ? p.swirlVariation : 0));
  const uSizeVar = uniform(float(sizeOn ? p.sizeVariation : 0));
  const uAccelToMaxSeconds = uniform(float(Math.max(0.05, p.accelToMaxSeconds ?? 1.2)));
  const uLifeMs = uniform(float(Math.max(1, p.lifeMs ?? 4000)));
  const uFadeMs = uniform(float(Math.min(p.fadeMs ?? 1200, (p.lifeMs ?? 4000) / 2)));
  const uWidthPx = uniform(float(p.widthPx ?? 12));
  // TRACER MODE's visual top speed, m/s (0 = none): see `softSpeed`.
  const uSpeedCapMps = uniform(float(Number.isFinite(p.speedCapMps) ? p.speedCapMps : 0));
  const uOpacityMax = uniform(float(p.opacityMax ?? 0.7));
  // Active-trail count (set from windSpeed01 each frame in step()) — a trail
  // whose index is >= this is forced invisible, giving "a few, more when
  // windier" independent of the per-trail flow gate.
  const uActiveTrails = uniform(float(Math.max(1, Math.floor(p.minTrails ?? 3))));
  // The ring write-head slot [0, SEG) — advanced by JS each frame in step(), so
  // the kernel appends this frame's head position at exactly one slot and the
  // draw reads the ring relative to it.
  const uHeadSlot = uniform(0);
  // How many ring slots the strip is drawn over (≤ SEG−1). The ring can only
  // advance once a frame, so when the wanted history clock is faster than the
  // frame clock each slot holds MORE path than asked for; drawing over fewer
  // slots (interpolated) keeps the stroke the length it should be.
  const uSegSpan = uniform(float(SEG - 1));

  // A uniform (not a constant) so Wind Trails' colour control is live.
  const color = uniform(new THREE.Color(colorRGB[0], colorRGB[1], colorRGB[2]));
  // How lit the scene is (environmental-light.js#sceneLightLevel). Ribbons draw
  // after the lighting multiply, so they dim by it themselves.
  const uSceneLight = uniform(float(1));

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

  // ── TRACER MODE (Wind Trails, 2026-11-09) ───────────────────────────────────────────────────────────────────────
  // Ingram: trails "cutting corners of buildings" and "bent at angles rather than smoothly", and "adjust how Wind
  // Trails work to fit this system" (the 3-D air every other wind effect now reads). Three causes, measured in the
  // code: (1) the heads steered by the OLD analytic field (ambient × a nearest-cell openness grid), not the air;
  // (2) at a wall the momentum guard snapped the velocity in one frame and added a RANDOM impact kick — a kink
  // in the stroke; (3) a loop rotated the move with no idea a wall was there, so it swung through corners.
  // A tracer is a puff of AIR made visible, so it now behaves like one:
  //   - it rides the baked wind field (`wind.field.now` — the 3-D air's 1-2 m layer once the solver runs, turbulence
  //     included), integrated at the step's midpoint (RK2), with no momentum of its own;
  //   - its heading can turn no tighter than TRACER_MIN_RADIUS_M, so a stroke is always a smooth curve;
  //   - the floor's `_Outdoors` mask is the wall, at its own pixel size: a look-ahead slides the heading along it,
  //     and a swept step veto stops a head on the wall, where it fades out (it never crosses a roof);
  //   - a loop only starts where there is room for it (no wall within the loop's own size).
  const tracer = p.tracer === true;
  const fieldGrid =
    tracer && windHandle?.hasField && windHandle?.fieldTexture && windHandle?.grid ? windHandle.grid : null;
  let fieldTexture = fieldGrid ? windHandle.fieldTexture : null;
  const fieldTexNodes = [];
  /** The air at a point, in field units (× pxPerSecPerFieldUnit = world px/s). */
  const airAt = (pos) => {
    if (!fieldGrid) {
      const f = sampleFlow(pos);
      return f.flowVec.add(f.turbulenceVec);
    }
    const n = TSL.texture(fieldTexture, windGridUvNode(TSL, fieldGrid, pos)).level(float(0));
    fieldTexNodes.push(n);
    return n.xy;
  };
  const hasOutdoors = tracer && !!(outdoorsTexNode && uOutdoorsRect);
  /** 1 outdoors, 0 under a roof — a texel LOAD (a wall is where the paint is), as Leaf Shed reads it. */
  const outdoorsAt = (q) => {
    if (!hasOutdoors) return float(1);
    const size = vec2(TSL.textureSize(outdoorsTexNode, int(0)));
    const uvn = q
      .sub(uOutdoorsRect.xy)
      .div(uOutdoorsRect.zw.sub(uOutdoorsRect.xy).max(vec2(1, 1)))
      .clamp(0, 0.9999);
    return outdoorsTexNode.load(TSL.ivec2(uvn.mul(size).floor())).r;
  };
  /** How much of a step stays outdoors, walked in samples spaced under a mask texel (Leaf Shed's veto). */
  const TRACER_SWEEP_N = 6;
  const clearFraction = (from, delta) => {
    let f = float(1);
    for (let k = 1; k <= TRACER_SWEEP_N; k++) {
      const m = outdoorsAt(from.add(delta.mul(k / TRACER_SWEEP_N)));
      f = f.min(m.lessThan(0.5).select(float((k - 1) / TRACER_SWEEP_N), float(1)));
    }
    return f;
  };
  const RING8 = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  /** 1 when every tap on a ring of radius `r` round `c` is outdoors. */
  const ringClear = (c, r) => {
    let all = float(1);
    for (const [cx, cy] of RING8)
      all = all.min(
        outdoorsAt(c.add(vec2(cx, cy).mul(r)))
          .greaterThanEqual(0.5)
          .select(float(1), float(0))
      );
    return all;
  };

  // Each trail's own lifetime — `lifeJitter` spreads them so a population never
  // pulses in step. Seed-hashed, so it is stable for a trail's whole life.
  const lifeOf = (seedF) =>
    lifeJitter > 0
      ? uLifeMs.mul(float(1 - lifeJitter).add(hash11(seedF.mul(5.31).add(2.9)).mul(float(2 * lifeJitter))))
      : uLifeMs;

  // Each trail's own size multipliers {width, length} — seed-hashed, stable for
  // its life, shared by the kernel (a long stroke loops lazier) and the draw.
  const sizeOf = (seedF) =>
    buildTrailSizeNodes(TSL, {
      hash: (k) => hash11(seedF.mul(float(1.37 + 0.71 * k)).add(float(61.3 + 5.9 * k))),
      uSizeVar,
    });

  // A random world point inside the current rect, from two hash salts.
  const randPointInRect = (sa, sb) =>
    vec2(uRectMin.x.add(uRectSize.x.mul(hash11(sa))), uRectMin.y.add(uRectSize.y.mul(hash11(sb))));
  /** True when `q` is outside the rect grown by `pad` × its size on every side (pad 0 = the rect itself). */
  const outsideRect = (q, pad) => {
    const lo = uRectMin.sub(uRectSize.mul(pad));
    const hi = uRectMin.add(uRectSize.mul(1 + pad));
    return q.x.lessThan(lo.x).or(q.x.greaterThan(hi.x)).or(q.y.lessThan(lo.y)).or(q.y.greaterThan(hi.y));
  };

  // ── BORN ON A GUST (TRACER MODE, 2026-11-10) ────────────────────────────────────────────────────────────────────
  // Ingram: "a lot less of them … elegant … never suddenly vanish … chunkier … perhaps tracking gusts more than just
  // the average wind speed and direction." So a trail decides at BIRTH whether it shows, and how strongly:
  //   - it is born only where a travelling gust front is passing (the wind's own gust envelope, `kernel().gust`),
  //     outdoors, in air past the m/s gate, and only in a slot the count allows;
  //   - that strength is LATCHED for its life. Nothing that happens to the air later (a lull, a gust passing on) can
  //     switch it off; only its own life fade, a wall, or leaving the view fade it, and those always fade over
  //     `uFadeMs` (the old gate followed the air speed at the head every frame, and the count and the view edge cut a
  //     trail in one frame: the "suddenly vanish");
  //   - a slot that finds no gust stays DORMANT (strength 0, invisible) and looks again after a random rest, so a gust
  //     arriving wakes a few slots one by one, never all of them in one frame.
  /** A gust's score 0..1 at a point: how far the envelope is above the mean, as a share of the most it can be. */
  const gustiness01Node = windHandle?.ambient?.gustiness01;
  const gustScoreAt = (q) => {
    if (!gustiness01Node) return float(1); // no gusts to follow: any spot in the wind will do
    const g = windHandle.kernel(TSL, { centerXY: q, time: uTimeMs, cellBuffer: windOpennessBuffer }).gust;
    if (g === undefined) return float(1);
    const score = g
      .sub(1)
      .div(float(WIND_GUST_PEAK - 1).mul(gustiness01Node.max(0.05)))
      .clamp(0, 1);
    // dead-calm gustiness has no gusts at all: trails follow the mean wind instead of never showing
    return gustiness01Node.lessThan(0.05).select(float(1), score);
  };
  /** How long a dormant slot rests before it looks for a gust again, ms (seed-hashed: births never come in step). */
  const restOf = (seedF) => float(TRACER_REST_MIN_MS).add(hash11(seedF.mul(7.13).add(3.3)).mul(TRACER_REST_SPAN_MS));

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
    age.element(i).assign(hash11(fi.mul(3.7)).mul(lifeOf(fi)));
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
    // A var: the seed is rewritten at the end of this kernel on rebirth, and
    // everything above must read THIS life's seed.
    const s = seed.element(i).toVar();

    // Only the flow VECTOR(s) are needed for the head's target here; the
    // visibility gate re-samples at the FINAL position below (so a
    // just-respawned head's gate reflects where it landed, not where it was).
    const flow = sampleFlow(pos);
    const { flowVec, turbulenceVec } = flow;
    // The PREVAILING strength, for this engine's own speed ceiling — a
    // different question from "what is the wind vector here", which is why the
    // handle exposes it (see its `ambient` field's own doc).
    const windSpeed01 = windHandle.ambient ? windHandle.ambient.speed01 : float(1);
    const lifeMs = lifeOf(s);

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
    //
    // ⭐ 2026-10-27: REAL SPEED. The field's own vector × the scene's px/s per
    // unit — the air's actual velocity here, gust included, so a head keeps
    // pace with the overlay's waves. The ceiling is the strongest a gust can
    // make the prevailing wind (plus headroom for turbulence on top of it).
    const targetRaw = flowVec.add(turbulenceVec).mul(pxPerSecPerFieldUnit).mul(uWindGain);
    const ceilingPxPerSec = windSpeed01
      .mul(pxPerSecPerFieldUnit)
      .mul(float(WIND_GUST_PEAK * 1.6))
      .max(float(1));
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
    //
    // THE CURL (swirl). Each trail runs with the air, LOOPS a whole number of
    // turns somewhere in its life, then runs with the air again. The heading
    // offset is a function of the trail's AGE (`trail-swirl.js`, header there),
    // applied to the MOVE only — the stored velocity keeps following the field,
    // so the momentum maths above never fights the curl. A turn takes a fraction
    // of a second, so faster air draws a bigger loop.
    //
    // ⭐ 2026-10-31 (author: "the end point leaves the wind trail headed in a
    // direction which ISN'T in line with the wind"): the previous curl turned at
    // `|v| / R` until it had turned `swirl × 2π` — 432° at swirl 1.2, so every
    // looper left 72° off the wind. Now it is 0 before the loop and exactly 2πn
    // after it; loop shape, size and timing are spread per trail by Swirl
    // variation. (An earlier cut still: rotating the TARGET by an angle growing
    // with age drew long straight sticks at random angles.)
    let moveVel = vel;
    let swirlTheta = float(0);
    if (swirlOn) {
      const curl = buildTrailSwirlNodes(TSL, {
        hash: (k) => hash11(s.mul(float(2.71 + 1.913 * k)).add(float(4.1 + 7.37 * k))),
        uSwirl,
        uSwirlVar,
        lifeMs,
        ageMs: age.element(i),
        sizeLen: sizeOn ? sizeOf(s).length : float(1),
      });
      swirlTheta = curl.theta;
      const ct = cos(swirlTheta).mul(curl.speed);
      const st = sin(swirlTheta).mul(curl.speed);
      moveVel = vec2(vel.x.mul(ct).sub(vel.y.mul(st)), vel.x.mul(st).add(vel.y.mul(ct)));
    }
    let next = pos.add(moveVel.mul(uDtSec));

    // THE TRACER (see "TRACER MODE" above): replaces the heading, the curl and the step for Wind Trails.
    let tracerGone = null;
    let tracerFade = null;
    let tracerLatch = null;
    if (tracer) {
      const dt = uDtSec;
      const ppm = pixelsPerMetreNode;
      const rMinPx = ppm.mul(float(TRACER_MIN_RADIUS_M));
      // RK2: the air at the step's midpoint, so a curving stream is followed, not cut across
      const F0 = airAt(pos).mul(pxPerSecPerFieldUnit).mul(uWindGain);
      const F = airAt(pos.add(F0.mul(dt.mul(0.5))))
        .mul(pxPerSecPerFieldUnit)
        .mul(uWindGain);
      const fLen = F.length();
      // VISUAL SPEED (2026-11-10, "it shouldn't be about a realistic / accurate depiction of wind speed"): the head runs
      // at the air's speed squeezed through v / (1 + v / cap), so a gale's 30-70 m/s crosses the view in seconds, not in
      // a tenth of one (the trail used to be reborn ten times a second). The air's DIRECTION is untouched.
      const rawSpeed = fLen.min(ceilingPxPerSec);
      const capPx = ppm.mul(uSpeedCapMps);
      const speed = uSpeedCapMps
        .greaterThan(0)
        .select(rawSpeed.div(float(1).add(rawSpeed.div(capPx.max(1)))), rawSpeed);
      const want0 = fLen.greaterThan(1e-3).select(F.div(fLen.max(1e-3)), vec2(1, 0));
      const oldV = velocity.element(i);
      const oLen = oldV.length();
      const cur = oLen.greaterThan(1e-3).select(oldV.div(oLen.max(1e-3)), want0);
      // the wall ahead: slide the wanted heading along it, harder the nearer it is (three taps down the heading)
      let want = want0;
      if (hasOutdoors) {
        const L = rMinPx.mul(2.5).max(speed.mul(dt).mul(3));
        const m0 = outdoorsAt(pos);
        let g = vec2(0, 0);
        for (const [cx, cy] of RING8) {
          const dir = vec2(cx, cy);
          g = g.add(dir.mul(outdoorsAt(pos.add(dir.mul(L.mul(0.6)))).sub(m0)));
        }
        const gl = g.length();
        const nOut = gl.greaterThan(0.05).select(g.div(gl.max(1e-4)), cur.negate());
        const blockW = float(1)
          .sub(outdoorsAt(pos.add(cur.mul(L.div(3)))))
          .add(
            float(1)
              .sub(outdoorsAt(pos.add(cur.mul(L.mul(2 / 3)))))
              .mul(0.6)
          )
          .add(
            float(1)
              .sub(outdoorsAt(pos.add(cur.mul(L))))
              .mul(0.35)
          )
          .clamp(0, 1);
        const into = want0.dot(nOut).negate().max(0);
        // slide along the wall, and stand a little off it: a gentle push out while any tap is under a roof, so a trail
        // that has been turned to run with a wall runs beside it (not grazing the paint line, a pixel either way)
        const near = smoothstep(float(0), float(2), gl);
        const slid = want0.add(nOut.mul(into.mul(blockW))).add(nOut.mul(near.mul(0.35)));
        const tan = vec2(nOut.y.negate(), nOut.x);
        const tanS = cur.dot(tan).greaterThanEqual(0).select(tan, tan.negate());
        const sl = slid.length();
        want = sl.greaterThan(0.2).select(slid.div(sl.max(1e-3)), tanS);
      }
      if (windOpennessBuffer) {
        // THE WALL CELLS TOO (Foundry's own walls, incl. a courtyard's or a fence's, where the `_Outdoors` mask is
        // outdoors on BOTH sides and so cannot stop a trail): a wide, gentle turn along the wall, eased by the turn
        // limit below and WITHOUT the random impact kick (that kick was a kink)
        const flowW = sampleFlow(pos);
        want = deflectAroundWalls(TSL, {
          vector: want,
          awayDirX: flowW.wallAwayDirX,
          awayDirY: flowW.wallAwayDirY,
          proximity: smoothstep(float(0.35), float(WALL_MOMENTUM_GUARD_HIGH), flowW.wallProximity),
          chaosDirX: float(0),
          chaosDirY: float(0),
          chaosAmount: float(0),
        });
        const wl = want.length();
        want = wl.greaterThan(0.05).select(want.div(wl.max(1e-4)), cur);
      }
      // SMOOTH: the heading turns toward the wanted one at most |v| dt / R_min a step — never a corner
      const maxTurn = speed.mul(dt).div(rMinPx.max(1e-3)).min(float(Math.PI));
      const cA = cur.dot(want).clamp(-1, 1);
      const sA = cur.x.mul(want.y).sub(cur.y.mul(want.x));
      const cT = cos(maxTurn);
      const sT = sin(maxTurn).mul(sA.greaterThanEqual(0).select(float(1), float(-1)));
      const turned = vec2(cur.x.mul(cT).sub(cur.y.mul(sT)), cur.x.mul(sT).add(cur.y.mul(cT)));
      const heading = cA.greaterThanEqual(cT).select(want, turned);
      vel = heading.mul(speed);
      // the curl, only where it has room: decided as the loop starts (θ is still 0 then, so no kink), held after
      let move = vel;
      tracerLatch = float(1);
      if (swirlOn) {
        const curl = buildTrailSwirlNodes(TSL, {
          hash: (k) => hash11(s.mul(float(2.71 + 1.913 * k)).add(float(4.1 + 7.37 * k))),
          uSwirl,
          uSwirlVar,
          lifeMs,
          ageMs: age.element(i),
          sizeLen: sizeOn ? sizeOf(s).length : float(1),
        });
        const latchOld = custom.element(i).z;
        const started = age.element(i).greaterThanEqual(curl.startMs);
        const D = speed
          .mul(curl.turnSec)
          .mul(1.3 / Math.PI)
          .clamp(ppm.mul(0.5), ppm.mul(6));
        const room = hasOutdoors ? ringClear(pos, D).min(ringClear(pos, D.mul(0.5))) : float(1);
        const latch = started.and(latchOld.greaterThanEqual(0)).select(latchOld, room);
        // store -1 ("not decided") until the loop starts, then the decision
        tracerLatch = started.select(latch, float(-1));
        const th = curl.theta.mul(latch);
        const sp = float(1).add(curl.speed.sub(1).mul(latch));
        const ct = cos(th).mul(sp);
        const st = sin(th).mul(sp);
        move = vec2(vel.x.mul(ct).sub(vel.y.mul(st)), vel.x.mul(st).add(vel.y.mul(ct)));
        swirlTheta = th;
      }
      // THE WALL IS A WALL: the step stops on it, and the trail fades out there
      const delta = move.mul(dt);
      const frac = hasOutdoors
        ? outdoorsAt(pos).greaterThanEqual(0.5).select(clearFraction(pos, delta), float(1))
        : float(1);
      next = pos.add(delta.mul(frac));
      // a wall stops it, and leaving the view (or the view leaving it, on a pan) fades it too: never a cut
      const hit = frac.lessThan(0.9999).or(outsideRect(next, 0));
      const fadeOld = custom.element(i).y;
      tracerFade = hit
        .or(fadeOld.greaterThan(0))
        .select(fadeOld.add(dt.mul(1000).div(uFadeMs.max(1))), float(0))
        .min(1);
      tracerGone = tracerFade.greaterThanEqual(1);
    }

    // Respawn on leaving the rect OR ageing out (same visual: fresh random spot).
    const outOfBounds = outsideRect(next, 0);
    const ageExpired = age.element(i).greaterThanEqual(lifeMs);
    let shouldRespawn = outOfBounds.or(ageExpired);
    // A TRACER (BORN ON A GUST, above) is never cut: a living one leaving the view fades (`tracerFade`) and is reborn
    // only once faded, or once far past the view (a big pan); a dormant one is reborn whenever its rest is up.
    const strengthOld = custom.element(i).x;
    if (tracer) {
      const dormant = strengthOld.lessThanEqual(0);
      const restDone = age.element(i).greaterThanEqual(restOf(s));
      shouldRespawn = outsideRect(next, TRACER_EXIT_PAD)
        .or(ageExpired)
        .or(tracerGone)
        .or(dormant.and(restDone.or(outOfBounds)));
    }

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
    // A TRACER is born on a GUST, outdoors: the first of four random points that is not under a roof and that a gust
    // front is passing over now. None found → the slot stays dormant this round (strength 0).
    let birthStrength = null;
    if (tracer) {
      let pick = bestPos;
      let pickScore = float(0);
      let found = null;
      for (let c = 0; c < 4; c++) {
        const cand = randPointInRect(
          s
            .mul(0.53)
            .add(next.y.mul(0.021))
            .add(83.0 + c * 5.17),
          s
            .mul(0.37)
            .add(next.x.mul(0.023))
            .add(97.0 + c * 2.93)
        );
        const score = gustScoreAt(cand);
        const ok = outdoorsAt(cand)
          .greaterThanEqual(0.5)
          .and(score.greaterThanEqual(float(TRACER_GUST_BIRTH)));
        const take = found ? found.not().and(ok) : ok;
        pick = take.select(cand, pick);
        pickScore = take.select(score, pickScore);
        found = found ? found.or(ok) : ok;
      }
      bestPos = pick;
      // how bold a stroke this gust earns: stronger gusts and faster air draw a surer line, latched for its life
      const speedGate = smoothstep(uGateLoMps, uGateHiMps, airAt(pick).length().mul(float(MPS_PER_FIELD_UNIT)));
      const born = found.and(float(i).lessThan(uActiveTrails)).and(speedGate.greaterThan(0.25));
      birthStrength = born.select(
        mix(float(0.6), float(1), pickScore).mul(mix(float(0.55), float(1), speedGate)),
        float(0)
      );
    } else if (hasOutdoors) {
      let pick = bestPos;
      let pickOk = outdoorsAt(bestPos).greaterThanEqual(0.5);
      for (let c = 1; c < 4; c++) {
        const cand = randPointInRect(
          s
            .mul(0.53)
            .add(next.y.mul(0.021))
            .add(83.0 + c * 5.17),
          s
            .mul(0.37)
            .add(next.x.mul(0.023))
            .add(97.0 + c * 2.93)
        );
        const ok = outdoorsAt(cand).greaterThanEqual(0.5);
        const take = pickOk.not().and(ok);
        pick = take.select(cand, pick);
        pickOk = pickOk.or(ok);
      }
      bestPos = pick;
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
    // In REAL m/s of local flow (2026-10-27) — was `flowMag × windSpeed01`,
    // which squared the dial and meant nothing physical.
    let gate = smoothstep(uGateLoMps, uGateHiMps, finalFlow.flowMag.mul(float(MPS_PER_FIELD_UNIT)));
    if (tracer) {
      // LATCHED (BORN ON A GUST, above): the strength it was born with, for its whole life. The draw multiplies in the
      // fade-out (`custom.y`) itself, so nothing here can drop a living trail in one frame.
      gate = shouldRespawn.select(birthStrength, strengthOld);
    }
    // x = gate (READ BY THE DRAW's opacityNode below — must stay this exact
    // slot); y/z/w are diagnostic-only (flowMag, openness, head speed).
    // w = the curl's heading offset for a swirling engine (0 on respawn), the
    // head speed otherwise.
    const wSlot = swirlOn ? shouldRespawn.select(float(0), swirlTheta) : vel.length();
    // (a tracer keeps its own state in y/z: y = how far through its fade-out at a wall, z = loop room -1|0|1)
    if (tracer) {
      custom
        .element(i)
        .assign(
          vec4(gate, shouldRespawn.select(float(0), tracerFade), shouldRespawn.select(float(-1), tracerLatch), wSlot)
        );
    } else {
      custom.element(i).assign(vec4(gate, finalFlow.flowMag, finalFlow.openness, wSlot));
    }

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

    // A NEW SEED EACH LIFE (trails, 2026-10-31). The seed used to be the slot
    // index forever, so a slot relived the SAME swirl, size and lifetime every
    // time — and at a low density only a handful of slots are ever active, so
    // the whole map showed the same few loops on repeat (author: "they all have
    // the same exact swirl"). A reborn trail steps its seed on by `capacity`,
    // wrapping after LIFE_SEEDS lives: every slot cycles through that many
    // different plans, and seeds stay small enough for the fract(sin) hash.
    if (varyPerLife) {
      const nextSeed = s.add(float(capacity)).mod(float(capacity * LIFE_SEEDS));
      seed.element(i).assign(shouldRespawn.select(nextSeed, s));
    }
  })().compute(capacity);

  // ==========================================================================
  // THE DRAW: one InstancedBufferGeometry, one ribbon strip per trail.
  // ==========================================================================
  // Base geometry: a flat strip of SEG cross-sections, 2 vertices each (left/
  // right edge). Per-vertex attributes `aSeg` (which history point, 0..SEG-1)
  // and `aSide` (-1/+1, which edge) drive positionNode; the actual world
  // position comes from the history buffer, not this template's `position`
  // (which is a required-but-unused dummy). instanceCount = capacity (trails).
  //
  // The strip's cross-section count (`MESH`) is its own number, NOT the history
  // ring's `SEG`: the ring holds recorded head positions (one per frame at best),
  // the strip is how many points the line is DRAWN through, read off a
  // Catmull-Rom curve fitted through those recordings. A fast trail's recordings
  // are far apart and a straight lerp between them draws corners; a denser strip
  // over a spline draws the curve the head really took. `meshSegments` therefore
  // scales with the graphics profile (wind-trails.js), the ring does not need to.
  const MESH = Math.max(2, Math.floor(p.meshSegments ?? SEG));
  const vertCount = MESH * 2;
  const positions = new Float32Array(vertCount * 3); // dummy; real pos from the node
  const aSeg = new Float32Array(vertCount);
  const aSide = new Float32Array(vertCount);
  for (let k = 0; k < MESH; k++) {
    for (let sdx = 0; sdx < 2; sdx++) {
      const vi = k * 2 + sdx;
      aSeg[vi] = k;
      aSide[vi] = sdx === 0 ? -1 : 1;
    }
  }
  // Two triangles per gap between adjacent cross-sections (SEG-1 gaps).
  const indices = [];
  for (let k = 0; k < MESH - 1; k++) {
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
  const segMax = float(SEG - 1); // last RING slot
  const meshMax = float(MESH - 1); // last strip cross-section

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

  // A strip vertex's position along the drawn span, in (fractional) ring slots
  // (strip index 0..MESH-1 maps onto the drawn span's tail..head).
  // A sized trail draws over its own share of the ring (never past its end).
  const drawSpan = () => (sizeOn ? uSegSpan.mul(sizeOf(seed.element(instanceIndex)).length).min(segMax) : uSegSpan);
  const spanSeg = (segF) => segMax.sub(meshMax.sub(segF).mul(drawSpan().div(meshMax)));
  // The ring read through a uniform Catmull-Rom spline between the two slots
  // either side of the vertex, with the exact curve tangent. Returns
  // vec4(position.xy, tangent.xy). Neighbour slots clamp at the ring ends.
  const readSegCurve = (segF) => {
    const f = spanSeg(segF).clamp(float(0), segMax);
    const lo = f.floor();
    const k = f.sub(lo);
    const at = (j) => readSeg(j.clamp(float(0), segMax));
    const p0 = at(lo.sub(float(1)));
    const p1 = at(lo);
    const p2 = at(lo.add(float(1)));
    const p3 = at(lo.add(float(2)));
    const b = p2.sub(p0);
    const c = p0
      .mul(float(2))
      .sub(p1.mul(float(5)))
      .add(p2.mul(float(4)))
      .sub(p3);
    const d = p1
      .mul(float(3))
      .sub(p0)
      .sub(p2.mul(float(3)))
      .add(p3);
    const k2 = k.mul(k);
    const k3 = k2.mul(k);
    const pos = p1.mul(float(2)).add(b.mul(k)).add(c.mul(k2)).add(d.mul(k3)).mul(float(0.5));
    const tn = b.add(c.mul(k.mul(float(2)))).add(d.mul(k2.mul(float(3))));
    return vec4(pos.x, pos.y, tn.x, tn.y);
  };

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const curve = readSegCurve(segNode);
    const center = curve.xy;
    const tan = curve.zw;
    const tanLen = tan.length();
    // Degenerate (collapsed fresh trail): fall back to the head's velocity
    // direction, then to +x, so normalize never divides by zero.
    const vHead = velocity.element(instanceIndex);
    const vLen = vHead.length();
    const vDir = vLen.greaterThan(float(1e-4)).select(vHead.div(vLen.max(float(1e-4))), vec2(1, 0));
    const tDir = tanLen.greaterThan(float(1e-4)).select(tan.div(tanLen.max(float(1e-4))), vDir);
    const normal = vec2(tDir.y.negate(), tDir.x);
    // Comet taper: full width at the head (t01=1), → 0 at the tail (t01=0).
    // SPINDLE (trails): pointed at BOTH ends like an anime wind line —
    // `sin(πt)^0.85`, symmetric, so the head is as sharp as the tail (author,
    // 2026-10-27: "Those lines aren't tapered at both ends") — and thinning
    // as the trail fades.
    const t01 = segNode.div(meshMax);
    let halfW;
    if (spindle) {
      const body = pow(sin(t01.mul(float(Math.PI))).max(float(0)), float(0.85));
      const ageMs = age.element(instanceIndex);
      const lifeMsDraw = lifeOf(seed.element(instanceIndex));
      const fadeIn = ageMs.div(uFadeMs).clamp(float(0), float(1));
      const fadeOut = lifeMsDraw.sub(ageMs).div(uFadeMs).clamp(float(0), float(1));
      // a tracer fading at a wall or the view's edge thins as it goes, the same as at the end of its life
      const exitFade = tracer ? float(1).sub(custom.element(instanceIndex).y) : float(1);
      const thin = pow(fadeIn.min(fadeOut).min(exitFade), float(0.6));
      const widthMul = sizeOn ? sizeOf(seed.element(instanceIndex)).width : float(1);
      halfW = uWidthPx.mul(widthMul).mul(body).mul(thin).mul(float(0.5));
    } else {
      halfW = uWidthPx.mul(pow(t01, float(0.7))).mul(float(0.5));
    }
    const world = center.add(normal.mul(sideNode).mul(halfW));
    return vec3(world.x, world.y, float(zDepth));
  })();

  const shade = buildWeatherShadeNode(TSL, {
    illumTexNode: illumTexture ? TSL.texture(illumTexture) : null,
    uSceneLight,
  });
  material.colorNode = shade ? color.mul(uSceneLight).mul(shade) : color.mul(uSceneLight);

  // Per-vertex fade data carried to the fragment stage (storage/attribute reads
  // are vertex-stage only on this renderer — same reason the dot engine bundles
  // its `vFade`). x=taper t01, y=gate×active, z=lifeFade, w=side.
  const vGust = Fn(() => {
    const trail = instanceIndex;
    const gate = custom.element(trail).x;
    // A tracer's count only decides BIRTHS (BORN ON A GUST): a living trail outlives a count that drops, and its own
    // exit fade (y) is the only other thing that dims it. Other engines keep the hard per-index cut.
    const active = tracer
      ? float(1).sub(custom.element(trail).y)
      : float(trail).lessThan(uActiveTrails).select(float(1), float(0));
    const ageMs = age.element(trail);
    const fadeIn = ageMs.div(uFadeMs).clamp(float(0), float(1));
    const fadeOut = lifeOf(seed.element(trail)).sub(ageMs).div(uFadeMs).clamp(float(0), float(1));
    const lifeFade = fadeIn.min(fadeOut);
    const t01 = segNode.div(meshMax);
    return vec4(t01, gate.mul(active), lifeFade, sideNode);
  })().toVarying('vGust');

  material.opacityNode = Fn(() => {
    const t01 = vGust.x;
    const gateActive = vGust.y;
    const lifeFade = vGust.z;
    const side = vGust.w;
    // Soft edges across the ribbon width: side interpolates -1..+1, so
    // |side| is 0 at the centre-line and 1 at the two edges.
    // A spindle's edge is a smooth round falloff (sleek), a comet's linear.
    const edgeSoft = spindle ? max(float(1).sub(side.mul(side)), float(0)) : float(1).sub(side.abs());
    // Head brighter than tail (comet); a spindle only fades its last stretch.
    const tailAlpha = spindle
      ? smoothstep(float(0), float(0.2), t01.clamp(float(0), float(1)))
      : pow(t01.clamp(float(0), float(1)), float(1.2));
    return gateActive.mul(lifeFade).mul(edgeSoft).mul(tailAlpha).mul(uOpacityMax);
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // Trails are WHITE strokes and must read as white over a bright map too, so
  // they composite normally; the gust ribbons stay additive light.
  material.blending = p.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
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
  // Fixed-clock history (segmentSec): time since the ring last advanced.
  let segmentAccSec = 0;
  let slotSecEma = 1 / 60;
  let lastRectArea = null;
  const minTrails = Math.max(0, Math.floor(p.minTrails ?? 3));
  const maxTrails = Math.max(minTrails, Math.min(capacity, Math.floor(p.maxTrails ?? 24)));
  // Live look controls (Wind Trails' Studio card) — see `setLook`.
  let densityMul = 1;

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
     * @param {{dtSec:number, tMs:number, worldRect?:object, sceneLight01?:number}} frame
     */
    step(renderer, { dtSec, tMs, worldRect: rect, sceneLight01 }) {
      if (rect) this.setWorldRect(rect);
      if (Number.isFinite(sceneLight01)) uSceneLight.value = Math.min(1, Math.max(0, sceneLight01));
      uDtSec.value = Math.min(0.05, Math.max(0, dtSec || 0));
      uTimeMs.value = tMs || 0;
      // Advance the ring write-head BEFORE the kernel appends, so this frame's
      // head position lands in `headSlot` and the draw (later this frame) reads
      // the ring relative to the same value.
      //
      // With `segmentSec` the ring advances on a fixed clock instead of every
      // frame; between advances the kernel keeps overwriting the SAME head slot,
      // so the head still moves smoothly and the trail spans
      // `SEG × segmentSec` seconds of path at any frame rate.
      if (segmentSec > 0) {
        // `maxLengthM` caps how long a trail can be on the MAP: at hurricane
        // speed a fixed seconds-of-path would draw strokes many squares long.
        // Past the cap the history clock runs faster instead.
        let segDt = segmentSec;
        if (maxLengthM > 0) {
          const ppm = Number(windHandle.ambient?.pixelsPerMetre?.value ?? pxPerMeter);
          let pxs = Math.max(1, windTravelPxPerSec(windHandle.ambient?.speed01?.value ?? 0, ppm));
          if (tracer && uSpeedCapMps.value > 0) pxs /= 1 + pxs / Math.max(1, uSpeedCapMps.value * ppm); // as the kernel squeezes it
          segDt = Math.min(segmentSec, (maxLengthM * ppm) / (pxs * SEG));
        }
        segmentAccSec += uDtSec.value;
        if (segmentAccSec >= segDt) {
          segmentAccSec = Math.min(segmentAccSec - segDt, segDt);
          headSlot = (headSlot + 1) % SEG;
        }
        // Each slot really spans max(segDt, frame dt) of path — draw only as
        // many as make up the wanted `SEG × segDt` seconds.
        slotSecEma += (Math.max(segDt, uDtSec.value) - slotSecEma) * 0.1;
        uSegSpan.value = Math.max(2, Math.min(SEG - 1, ((SEG - 1) * segDt) / Math.max(1e-4, slotSecEma)));
      } else {
        headSlot = (headSlot + 1) % SEG;
      }
      uHeadSlot.value = headSlot;
      // "A few, more when windier": active count follows the wind's Beaufort
      // strength on a sqrt curve (mid settings pulled up so a breeze already
      // reads busier than calm). Strength, not the raw dial, so the count at a
      // given real speed is what it was tuned to (`windStrength01ForSpeed01`).
      const w = windStrength01ForSpeed01(windHandle.ambient?.speed01?.value ?? 1);
      uActiveTrails.value = Math.min(
        capacity,
        Math.round((minTrails + (maxTrails - minTrails) * Math.sqrt(w)) * densityMul)
      );
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
      // a tracer's air texture is re-allocated with its grid: same grid → rebind in place
      if (fieldGrid && nextHandle?.hasField && nextHandle.fieldTexture && nextHandle.fieldTexture !== fieldTexture) {
        fieldTexture = nextHandle.fieldTexture;
        for (const n of fieldTexNodes) n.value = fieldTexture;
      }
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

    /**
     * Live look controls (Wind Trails' Studio card) — uniforms only, so a
     * slider never rebuilds a kernel. Every field optional.
     * @param {{density?:number, widthPx?:number, opacity?:number, swirl?:number,
     *   swirlVariation?:number, sizeVariation?:number, lifeSec?:number,
     *   minSpeedMps?:number, colorRGB?:number[], lengthSec?:number}} look
     */
    setLook(look = {}) {
      if (Number.isFinite(look.density)) densityMul = Math.max(0, look.density);
      if (Number.isFinite(look.widthPx)) uWidthPx.value = Math.max(0, look.widthPx);
      if (Number.isFinite(look.speedCapMps)) uSpeedCapMps.value = Math.max(0, look.speedCapMps);
      if (Number.isFinite(look.opacity)) uOpacityMax.value = Math.max(0, Math.min(1, look.opacity));
      if (Number.isFinite(look.swirl) && swirlOn) uSwirl.value = Math.max(0, look.swirl);
      if (Number.isFinite(look.swirlVariation)) uSwirlVar.value = Math.min(1, Math.max(0, look.swirlVariation));
      if (Number.isFinite(look.sizeVariation) && sizeOn) uSizeVar.value = Math.min(1, Math.max(0, look.sizeVariation));
      if (Number.isFinite(look.lifeSec) && look.lifeSec > 0) {
        uLifeMs.value = look.lifeSec * 1000;
        uFadeMs.value = Math.min(uFadeMs.value, uLifeMs.value / 2);
      }
      if (Number.isFinite(look.minSpeedMps)) {
        uGateLoMps.value = Math.max(0, look.minSpeedMps);
        uGateHiMps.value = uGateLoMps.value * 1.8 + 1;
      }
      if (Array.isArray(look.colorRGB) && look.colorRGB.length === 3) color.value.setRGB(...look.colorRGB);
      // Trail LENGTH in seconds of path — only for a fixed-clock engine.
      if (Number.isFinite(look.lengthSec) && look.lengthSec > 0 && segmentSec > 0) segmentSec = look.lengthSec / SEG;
    },

    /**
     * The MSA Lab's meter: every trail's remembered path (oldest to newest, world px) and its visibility gate, read
     * back from the GPU. Stalls the queue for a frame: console and lab only.
     * @param {*} renderer
     * @returns {Promise<{trails: {gate:number, fade:number, loop:number, pts:number[][]}[], seg:number, headSlot:number}>}
     */
    async readTrails(renderer) {
      const hist = new Float32Array(await renderer.getArrayBufferAsync(trailHistory.value));
      const cus = new Float32Array(await renderer.getArrayBufferAsync(custom.value));
      // ages too (2026-11-10): an age that went DOWN is a rebirth, so a meter can tell a fade from a cut
      const ages = new Float32Array(await renderer.getArrayBufferAsync(age.value));
      const trails = [];
      for (let t = 0; t < capacity; t++) {
        const pts = [];
        // the ring's oldest slot is the one after the head
        for (let k = 1; k <= SEG; k++) {
          const slot = (headSlot + k) % SEG;
          const o = (t * SEG + slot) * 2;
          pts.push([hist[o], hist[o + 1]]);
        }
        trails.push({ gate: cus[t * 4], fade: cus[t * 4 + 1], loop: cus[t * 4 + 2], ageMs: ages[t], pts });
      }
      return { trails, seg: SEG, headSlot, tracer, fadeMs: uFadeMs.value, activeTrails: uActiveTrails.value };
    },

    /** For the debug panel: prove the engine is alive without a screenshot. */
    debugState() {
      return {
        system: system.id,
        capacity,
        segments: SEG,
        meshSegments: MESH,
        seeded,
        activeTrails: uActiveTrails.value,
        headSlot,
        lastRectArea,
        hasOpennessGrid: !!windOpennessBuffer,
      };
    },
  };
}
