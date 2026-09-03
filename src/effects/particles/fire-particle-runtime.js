/**
 * FIRE PARTICLES — the third runtime. Flame, ember and smoke, one factory,
 * `kind` selected at BUILD TIME.
 *
 * ============================================================================
 * RELATIONSHIP TO particle-runtime.js AND gust-runtime.js
 * ============================================================================
 *
 * A THIRD FILE, not a mode fork of either — `gust-runtime.js:11` set that
 * precedent deliberately ("bolting a second mode onto the heavily battle-scarred
 * particle-runtime.js would fork that file internally"), and this follows it.
 * Construction order, the uniform idiom, the arena call, the respawn hash and
 * the draw are all cloned from those two on purpose; the simulation is not.
 *
 * ⚠️ IT LIVES IN `effects/particles/`, NOT `effects/fire/`, AND THAT IS A WALL
 * RATHER THAN A PREFERENCE. `particles/allocator-only` (tools/verify-structure.mjs)
 * fails the build on `TSL.instancedArray` anywhere outside this directory, and
 * this runtime allocates its own spawn-point buffer. The fire-specific pure
 * math it consumes (the sprite shapes, the colour spec, the spawn extraction)
 * stays in `effects/fire/` and is imported.
 *
 * ⚠️ THIS IS NOW THE FOURTH CONSUMER OF THE SHARED WIND-GRID GLUE
 * (`world/wind-access.js#kernel`), 2026-09-04 — the extraction trigger
 * `gust-runtime.js:30` named ("two call sites is not yet a pattern... the
 * extraction trigger fires for the fourth consumer that genuinely needs a
 * per-particle field read") finally firing. Author, live, after a map with
 * both an indoor and an outdoor fire showed the map-wide CPU aggregate for
 * exactly what it was: *"the solution isn't to make all fires 50% wind, it's
 * to have the indoor/sheltered fires be low movement and the exposed/outdoors
 * fires be moved... shouldn't we be testing the actual location?"* Wind
 * MOTION (mobilisation + push) now samples `windHandle.kernel()`'s real,
 * geometry-derived per-cell openness LIVE, at each particle's own current
 * world position, every frame — the SAME mechanism vegetation and
 * `gust-runtime.js`/dust motes already use, not a second, bespoke one — see
 * "WIND" below for the construction-site wiring. Suppression (lifespan/
 * population/opacity) stays a CPU-computed, per-kind, map-wide value —
 * genuinely no per-particle home for it exists without storage this arena
 * does not have room for (the wind-cell buffer added below already spends
 * this arena's last free storage-buffer slot — see its own construction-site
 * comment), and that limitation is real and left honestly in place rather
 * than half-solved.
 *
 * ⚠️ PUSH MAGNITUDE IS NOW SELF-SCALED TO SPRITE SIZE, NOT GRID-CALIBRATED,
 * 2026-09-04, ROUND 6 — an audit of the original `pxPerMeter`-based formula
 * (the author, live: *"audit the wind grid and see if the values it produces
 * ... would be enough to move flames ... at least x5 their size"*) found it
 * landing anywhere from ~0.6× to ~6× a flame sprite's own size depending on
 * a Foundry grid setting this file cannot verify — a real magnitude
 * shortfall, independent of the openness grid entirely. See
 * `windAccelPerUnitSize`'s own construction-site note for the fix.
 *
 * ============================================================================
 * WHAT V2 GOT RIGHT THAT THIS COPIES EXACTLY
 * ============================================================================
 *
 * From the autopsy of `legacy/compositor-v2/` (memory:
 * `reference_v2_fire_look_autopsy`), two findings drive every constant here:
 *
 *  1. **95% of flame particles never move.** V2's `flameStationaryFraction`,
 *     and almost certainly a CPU dodge that became the signature: a top-down
 *     fire POOL should not translate. The flame flickers; embers and smoke do
 *     the moving.
 *  2. **~285 particles per floor, with huge sprites.** Flame 150-195 world
 *     units (about one grid square), smoke starting 151-400 and growing 10×.
 *     ⚠️ Scaling this to GPU-era counts without shrinking the sprites produces
 *     a solid glowing blob, not a better fire. The capacities here are map-wide
 *     rather than per-fire, so a busy scene still lands near V2's density.
 *
 * @module effects/particles/fire-particle-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import {
  createWindHandle,
  packWindCells,
  WIND_CELL_VEC4_STRIDE,
  deflectAroundWalls,
  windFlowVectorNode,
} from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import { packSpawnPoints } from '../fire/fire-spawn-points.js';
import { buildDepthHeightGateNode } from '../lighting/point-light-illumination.js';
import {
  buildFlameShapeAlpha,
  buildFlameShading,
  buildLifeFade,
  hueRotateNode,
  piecewiseLinear,
  piecewiseLinearRgb,
  EMBER_COLOR_STOPS,
  EMBER_EMISSION_STOPS,
  SMOKE_COLOR_STOPS,
  EMBER_EMISSION,
  EMBER_PEAK_OPACITY,
  FIRE_HDR_LINEAR_GAIN,
} from '../fire/fire-sprite.js';

const log = createLogger('fire-particle-runtime');
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * Per-kind build-time constants, all transcribed from V2's shipped params.
 * Lifetimes are V2's `startLife` already divided by its `timeScale: 3`.
 *
 * ⚠️ `stationaryFraction` IS THE SIGNATURE, NOT AN OPTIMISATION. See the header.
 * Raising flame's much above ~0.1 mobile is expected to destroy the look.
 */
const KINDS = Object.freeze({
  flame: Object.freeze({
    // ⚠️ 2.5× V2's 967-1667 ms. Author, 2026-08-09: *"I think I see puffs of
    // flame but they are very dispersed, very few of them and few short lived."*
    // V2's short lives worked against ~51 overlapping sprites constantly
    // replacing each other; at this build's density a one-second life reads as a
    // puff that vanishes before the eye settles on it.
    lifeMsMin: 2400,
    lifeMsMax: 4200,
    sizeMin: 150,
    sizeMax: 195,
    stationaryFraction: 0.95,
    // Turbulence: scale 150, strength (40,40) after fireCurlStrength 0.5, timeScale 1.5.
    curlScale: 150,
    curlStrength: 40,
    curlTimeScale: 1.5,
    // V2 damped `velocity.xy *= 0.85` PER UPDATE at 30 Hz — frame-rate dependent
    // and the only drag in the system. Solved honestly: 0.85 = exp(-k/30) ⇒ k ≈ 4.87.
    dampK: 4.87,
    buoyancyY: 0,
    // World units of HEIGHT gained per second — see PERSPECTIVE_CAMERA_HEIGHT.
    // A flame stays low: it is the fuel bed burning, not something ascending.
    // Halved alongside the count boost — with the perspective transform, height
    // pushes a sprite radially outward, and 48 rising flames on one hearth
    // splayed into exactly the dispersion the author reported.
    riseZ: 5,
    growth: 1,
    fadeIn: 0.14,
    fadeOut: 0.16,
    additive: true,
    // ⚠️ NEW (2026-09-03), AND DELIBERATELY NOT `buoyancyY` — author: *"at wind
    // 0 I'd like the flame particles and smoke to move upwards to give a
    // sense of depth and 3D"*. A screen-space up drift for flame was
    // previously rejected outright (this file's own header once warned
    // against it — "the side-view teardrop crawl V2 explicitly rejected"),
    // but that rejection was about translating the WHOLE stationary pool;
    // this only ever reaches the already-mobile fraction (`motionScale`),
    // and FADES OUT as wind rises (see `calmFade` in the update kernel) so a
    // gale reads as sideways, never as the fire body drifting up-screen.
    // Small on purpose relative to smoke's own 0.947×0.8 ≈ 0.76 — a wisp of
    // lift on the tips, not a current.
    calmRiseY: 0.35,
    // ⚠️ ADDED 2026-09-04, ROUND 6 — see `windAccelPerUnitSize`'s own
    // construction-site note for the full derivation. `windWorstCaseLifeS` is
    // flame's shortest REPRESENTATIVE life while genuinely windy: `lifeMsMin`
    // (2400ms) × `FLAME_GUTTER_LIFE_MUL` (0.3, `fire-geometry.js`) = 720ms —
    // not the absolute dimmest-particle floor (brightness can shorten a life
    // further still; solving for that outlier would fling every ordinary
    // particle absurdly far). `windSizesTarget` is the guaranteed MINIMUM
    // displacement within that life, in multiples of flame's own rendered
    // sprite size — the author's own explicit bar ("at least x5 their size or
    // more") plus headroom for curl/motionScale diluting the real-world
    // average below this idealised, curl-free solve.
    windWorstCaseLifeS: 0.72,
    windSizesTarget: 6,
  }),
  ember: Object.freeze({
    lifeMsMin: 367,
    lifeMsMax: 3767,
    // ⚠️ A THIRD OF V2's 7-26. Author, 2026-08-09: *"Embers are 3x too larger."*
    // V2's absolute sizes assume its own fires; on a 42-55 px painted hearth a
    // 26 px ember is half the width of the whole fire, which reads as a floating
    // lamp rather than a spark.
    sizeMin: 2.3,
    sizeMax: 8.7,
    // Embers are the ONLY layer that fully moves — V2 never set a motion scale
    // on them, so 100% integrate forces against the flame's 5%.
    stationaryFraction: 0,
    // ⚠️ CHAOS RAISED HARD, AND ONE PART OF IT IS NOT A CONSTANT AT ALL.
    // Author: *"embers need to move much more chaotically."* Two changes:
    //   • `curlTimeScale` 4 → 9, so the field itself churns faster.
    //   • `curlPhasePerSeed` — a PER-PARTICLE offset into the flow's time axis.
    //     This is the one that matters. V2's curl is a pure function of
    //     (position, time), so two embers at the same place moved IDENTICALLY —
    //     a swarm drifting in lockstep, which reads as orderly no matter how
    //     strong the field is. Offsetting each particle's own clock decorrelates
    //     neighbours while keeping the field itself divergence-free (it is still
    //     the same incompressible flow, just sampled at a different instant).
    curlScale: 30,
    curlStrength: 187.5,
    curlTimeScale: 9,
    curlPhasePerSeed: 37,
    // Less drag than the flame: an ember should keep the velocity the curl gave
    // it rather than being pulled back to rest between gusts.
    dampK: 2.2,
    buoyancyY: 0,
    // ⚠️ EMBERS CLIMB HARDEST, AND THIS GOES BEYOND V2. V2's embers sat at the
    // fire base (h ≈ 0.55) and had no perspective at all — only its smoke lifted
    // (12-30) and only its weather really flew. The author asked for more:
    // *"we need to make the particle system 3D... you can then make the fire and
    // smoke have perspective."* A spark that genuinely rises grows and splays
    // outward as it goes, which is the single most legible depth cue available
    // to a camera looking straight down.
    riseZ: 55,
    growth: 1,
    fadeIn: 0.16,
    fadeOut: 0.2,
    additive: true,
    // Already fully mobile with its own strong upward riseZ/chaos — no
    // separate calm-only term needed. See flame's own note above.
    calmRiseY: 0,
    // See flame's own note above for the derivation. Embers have NO wind-
    // driven life shortening at all (`fireWindParticleResponse` returns no
    // ember field), so the worst case is just their own shortest natural life
    // (`lifeMsMin`). `windSizesTarget` is set far higher than flame's:
    // embers are tiny (2.3-8.7px), and the author's repeated, explicit ask
    // was that embers be *"strongly"* wind-affected — a spark that only
    // crosses a few multiples of its own few-pixel size does not read as
    // windblown at any zoom level a GM actually plays at.
    windWorstCaseLifeS: 0.367,
    windSizesTarget: 18,
  }),
  smoke: Object.freeze({
    lifeMsMin: 1033,
    lifeMsMax: 4100,
    sizeMin: 151,
    sizeMax: 400,
    stationaryFraction: 0,
    curlScale: 100,
    curlStrength: 10,
    curlTimeScale: 0.85,
    // 0.992 per update at 30 Hz ⇒ k ≈ 0.24. Smoke barely slows down.
    dampK: 0.24,
    // ⚠️ THE ONLY LAYER THAT DRIFTS UP-SCREEN, and the reason the fire reads as
    // rising at all. V2 pushed flame and ember along +Z, which under a top-down
    // ortho camera with depthTest off is a visual no-op; smoke got
    // `(0, 0.82, 0.28)` — mostly +Y, i.e. up the SCREEN. Do not "fix" the other
    // two into screen-space up: that produces the side-view teardrop crawl V2
    // explicitly rejected.
    buoyancyY: 0.947 * 0.8,
    // V2 lifted smoke 12-30 units for ~1.2-3.1% growth and ~30 px of radial
    // drift at the screen edge. Sustained over a 4 s life this reaches a
    // comparable place, but continuously rather than as a one-off spawn offset.
    riseZ: 26,
    growth: 10,
    fadeIn: 0.16,
    fadeOut: 0.2,
    additive: false,
    // Already has its own unconditional buoyancyY, above — see that field's
    // own note on why it does NOT fade with wind the way flame's does.
    calmRiseY: 0,
    // See flame's own note above. Smoke's PARTICLE COUNT is what wind
    // suppresses (`smokeActiveCountMul`), not individual life, so the worst
    // case is its own shortest natural life (`lifeMsMin`). A modest target —
    // smoke is already fading toward zero count as wind climbs toward 1 (the
    // author's original "zero smoke at wind 1" ask), so how far a lone
    // survivor travels matters less at the extreme than at moderate wind,
    // where `effectiveWindMotion` self-throttles this anyway.
    windWorstCaseLifeS: 1.033,
    windSizesTarget: 4,
  }),
});

/** Map-wide spawn-point capacity. One buffer, shared by every fire on the map. */
const SPAWN_CAPACITY = 1024;

/**
 * How much stronger the wind push gets at full `uWindMotion01` than a flat
 * linear response would give (`fire-geometry.js#fireWindMotion01` already
 * folds the author's `windResponse` gain in before this ever runs, so this
 * is purely about SHAPE, not overall strength). Author, 2026-09-03: flame
 * should be *"pushed around in a huge way"* at wind 1. A flat multiply reads
 * as "more wind"; this makes the very top of the dial feel qualitatively
 * different from the middle, while `windMotion01=0` still passes through 0.
 *
 * ⚠️ RAISED 3.5 → 8, 2026-09-04, ROUND 2 — once the real per-position grid
 * (`particleOpenness`, above) started genuinely gating the push, the author
 * reported it reading weaker than before, not stronger: *"the flames aren't
 * responding to this new wind very much... considerably boost the
 * strength."* Real openness readings are rarely a clean 1.0 (see
 * `opennessGain`'s own note), so the ceiling this constant reaches needs to
 * cover that shortfall on top of its original job.
 *
 * ⚠️ ROLE NARROWED, 2026-09-04, ROUND 6 — since `windAccelPerUnitSize`
 * (construction site) took over the actual PUSH MAGNITUDE (self-scaled to
 * sprite size, replacing the old `pxPerMeter`-based `windPxPerSec`), this
 * constant is purely a SHAPE control again, exactly as its opening paragraph
 * always described: the update kernel divides `gustPush` by this same value
 * before scaling it against the real magnitude, so raising or lowering it
 * only changes how "front-loaded vs. dramatic-at-the-top" the curve feels
 * between calm and full wind — it no longer changes how far a particle
 * travels at `effectiveWindMotion = 1`.
 */
const WIND_GUST_MAX_MULT = 8;

/**
 * ⚠️ ADDED 2026-09-04, ROUND 4 — see `opennessGain`'s own note in the update
 * kernel for the full diagnostic story (a ×10 blunt multiplier on top of the
 * CPU-side gain's own ×2 maximum still produced no visible flame movement at
 * all, which rules out "under-tuned strength" and points at the real,
 * per-position wind-bake sample itself reading at or near 0 for typical
 * painted fire locations — routinely right against a wall, unlike where
 * `_Bush`/`_Tree` paint usually sits). The FLOOR this constant sets on
 * `opennessGain` — applied AFTER the sqrt curve, so it is a direct, easy-to-
 * reason-about minimum on the FINAL gain rather than the raw sample — is what
 * turns "a strict single-cell reading can crush wind response to literal
 * zero" into "the worst case is still a real, visible LOW response", which is
 * what the author actually asked for from the very first message in this
 * whole thread ("indoor/sheltered fires be low movement... exposed/outdoors
 * fires be moved" — never "no movement at all"). 0.3 means even a fully
 * "sealed" reading still reaches 30% of a fully-open location's gain; a
 * genuinely open reading (sqrt already close to 1) is barely touched by this
 * floor at all.
 */
const FIRE_OPENNESS_FLOOR_GAIN = 0.3;

/**
 * V2's camera-to-ground distance, and therefore the strength of the perspective
 * every particle applies to itself. Smaller = stronger parallax.
 * `legacy/scene/composer.js` put the camera at z=2000 over ground at z=1000.
 */
const PERSPECTIVE_CAMERA_HEIGHT = 1000;

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {'flame'|'ember'|'smoke'} deps.kind
 * @param {string} [deps.archetype] - flame only; one of `FLAME_ARCHETYPES`.
 *   ⚠️ BUILD-TIME (Effects.md Law 4). A uniform would compile all four shapes
 *   into every sprite and evaluate at least one per fragment for no benefit; a
 *   particle's archetype never changes during its life. A caller wanting
 *   variety builds one engine per archetype and splits the capacity.
 * @param {object} deps.system - the decl; `system.params.capacity` sizes the arena.
 * @param {object} deps.worldRect - `{minX,minY,maxX,maxY}`; a placeholder is fine,
 *   `step()` sets the real one each frame.
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0] - set on the actual MESH, not `scene`.
 *   THREE reads `renderOrder` off the renderable object being drawn, never off
 *   an ancestor container — `fire-subsystem.js` used to set it on the wrapper
 *   `engine.scene` it hands the caller, which has no geometry of its own and
 *   is never itself the thing rendered, so it was a silent no-op (smoke's
 *   "draws last" guarantee rested entirely on scene-graph insertion order by
 *   accident, not on this value). Taking it here, at the one place the mesh
 *   actually gets constructed, is what makes it real.
 * @param {object} [deps.windHandle]
 * @param {*} [deps.depthTexNode] - `buf:scene.depth`'s DEPTH attachment (the
 *   SAME node candle/lightning already read — see candle-flame-render.js's own
 *   depth-authority doc). Omitted → the occlusion gate compiles out entirely,
 *   byte-identical to before it existed.
 * @param {*} [deps.depthFlagsTexNode] - `buf:scene.depth`'s COLOUR attachment
 *   (B = flags byte, the Tile "Restrict Lighting" bit). Omitted → that ONE
 *   hard-block compiles out; the rank comparison alone still applies.
 * @returns {object} `{scene, capacity, init, step, setWorldRect, setSpawnPoints, updateWind, debugState}`
 */
export function createFireParticleEngine({
  THREE,
  kind = 'flame',
  archetype = 'plasmaCore',
  system,
  worldRect,
  zDepth = 0,
  renderOrder = 0,
  windHandle = TIER0_WIND_HANDLE,
  depthTexNode = null,
  depthFlagsTexNode = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, instanceIndex, float, vec2, vec3, vec4, uniform, sin, cos, fract, uv, mix, positionGeometry, screenUV } =
    TSL;

  const K = KINDS[kind] ?? KINDS.flame;
  const p = system?.params ?? {};
  const capacity = Math.max(1, Math.floor(p.capacity ?? 256));

  // ── ARENA ────────────────────────────────────────────────────────────────
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position; // vec2 world px
  const velocity = buffers.velocity; // vec2 world px/s
  const age = buffers.age; // float ms
  // ⚠️ `life` IS ALLOCATED BY THE ARENA AND UNUSED BY BOTH EXISTING RUNTIMES.
  // This is its first consumer, and it is exactly what it was named for: a
  // per-particle TOTAL lifespan, which here varies with the paint brightness the
  // particle was born on. Using it costs zero new buffers.
  const lifeBuf = buffers.life;
  const seed = buffers.seed;
  // x = brightness (paint value at birth), y = heat, z = base size px,
  // w = HEIGHT above the ground plane, in world units.
  //
  // ⚠️ `w` USED TO HOLD `motionScale` AND NOW HOLDS HEIGHT, because height is
  // the one thing that genuinely cannot be recomputed — it integrates. The
  // stationary flag can be: it is a per-LIFE constant, and the dot engine's own
  // `lifeRandomOf` idiom reconstructs a stable per-life random from
  // (seed, birth time) with no storage at all. Trading a derivable value for an
  // integrated one is what keeps this inside the arena's six buffers.
  const custom = buffers.custom;

  // ── THE SPAWN CLOUD — one extra buffer, seven total, inside the guaranteed 8 ─
  const spawnBuffer = TSL.instancedArray(SPAWN_CAPACITY, 'vec4');
  const spawnBacking = spawnBuffer.value.array ?? spawnBuffer.value;
  let spawnCount = 0;

  // ── THE WIND-CELL GRID (2026-09-04) — an EIGHTH buffer, and the LAST free
  // slot. Six arena buffers (position/velocity/age/life/seed/custom — `phase`
  // stays unreferenced, so it still doesn't bind) + spawnBuffer above = 7;
  // this makes 8, the WebGPU-guaranteed floor per stage. There is no room
  // left for anything else this runtime might want next without either
  // dropping one of these or widening an existing buffer's own stride
  // (`world/wind-access.js#WIND_CELL_VEC4_STRIDE`'s own trick) instead of
  // adding a ninth object — a real, previously-hit failure mode
  // (`fire-geometry.js`'s own "Vertex buffer count (12) exceeds..." history).
  //
  // Nearest-cell storage lookup, NOT a texture sample — the dot engine's own
  // lesson (`particle-runtime.js:749`) applies identically here: compute-stage
  // texture sampling has never been proven safe in this renderer. Mirrors
  // `gust-runtime.js`'s identical construction-site block exactly, including
  // its "no grid yet ⇒ stay null, kernel skips it" posture — an engine built
  // before the first wind bake completes (or with wind wholly unwired) gets
  // exactly today's ungated behaviour, not a crash.
  let windOpennessBuffer = null;
  let opnCols = 1;
  let opnRows = 1;
  let windHandleVersion = windHandle?.version ?? -1;
  if (windHandle?.grid && windHandle?.cells) {
    const { cols, rows } = windHandle.grid;
    opnCols = cols;
    opnRows = rows;
    const cellCount = Math.max(1, cols * rows);
    windOpennessBuffer = TSL.instancedArray(cellCount * WIND_CELL_VEC4_STRIDE, 'vec4');
    packWindCells(windOpennessBuffer.value, windHandle.cells, cellCount);
  }

  // ⚠️ SELF-SCALING WIND PUSH MAGNITUDE (2026-09-04, ROUND 6) — replaces the
  // old `pxPerMeter`-calibrated `windPxPerSec`. Audited live, on the author's
  // explicit ask ("audit the wind grid and see if the values it produces...
  // would be enough to move flames... at least x5 their size"): `pxPerMeter`
  // (fed from Foundry's `canvas.dimensions.distancePixels`, a GRID-DISTANCE
  // scale — pixels per one grid-square's configured distance, e.g. "per 5 ft"
  // — not a verified real-world "pixels per metre") could plausibly be
  // anywhere from ~20 to ~100 depending on the scene's own grid setup, and
  // running the exact closed-form solution for a damped particle under
  // constant acceleration (`x(t) = (a/k)·[t − (1/k)(1 − e^-kt)]`, `k` =
  // `K.dampK`) across that whole range showed flame's displacement landing
  // anywhere from ~0.6× to ~6× its own sprite size at full wind — genuinely
  // insufficient across a large share of the plausible range, and only
  // marginal even at the generous end. Not a rendering confound, not a
  // suppression-curve bug: an actual magnitude shortfall in the formula
  // itself, present regardless of anything the openness grid reads.
  //
  // The fix: stop depending on a grid constant this file has no way to
  // verify, and solve DIRECTLY for the acceleration that GUARANTEES
  // `K.windSizesTarget` × (this kind's own rendered sprite size) of
  // displacement within `K.windWorstCaseLifeS`, at full `effectiveWindMotion`
  // — self-scaling to what the particle actually looks like on screen,
  // correct regardless of the scene's grid configuration. Inverting the same
  // closed form for `a`:
  //   a = target·sizePx · k / [t − (1/k)(1 − e^-kt)]
  // Computed once here at construction (`K.dampK` and the two new KINDS
  // fields, `windWorstCaseLifeS`/`windSizesTarget`, are all static per kind),
  // leaving only the one genuinely LIVE part — `uSizeScale`, the author's own
  // size dial — to apply inside the kernel. See the update kernel's own
  // `windVec` for how `WIND_GUST_MAX_MULT` still shapes the curve on top of
  // this fixed ceiling.
  const windBracketS = K.windWorstCaseLifeS - (1 / K.dampK) * (1 - Math.exp(-K.dampK * K.windWorstCaseLifeS));
  const windAccelPerUnitSize = (K.windSizesTarget / windBracketS) * K.dampK;

  // ── UNIFORMS ─────────────────────────────────────────────────────────────
  const uDtSec = uniform(0);
  const uTimeMs = uniform(0);
  const uRectMin = uniform(vec2(worldRect.minX, worldRect.minY));
  const uRectSize = uniform(vec2(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  const uIntensity = uniform(float(p.intensity ?? 1));
  const uSizeScale = uniform(float(p.sizeScale ?? 1));
  const uTemperature = uniform(float(p.temperature ?? 0.85));
  /**
   * THE COLOUR-CORRECTION SET (2026-08-30). `uHueShiftRad` applies to every
   * kind uniformly (flame/ember/smoke recolour together — see `colorNode`'s
   * own final `hueRotateNode` call); `uPosterize`/`uBandCount`/`uTintMul`
   * only matter to `kind === 'flame'`'s `buildFlameShading` call and sit
   * inertly on ember/smoke engines, the same way `uColorAge` already does.
   */
  const uHueShiftRad = uniform(float(p.hueShiftRad ?? 0));
  const uPosterize = uniform(float(p.posterizeAmount ?? 0));
  const uBandCount = uniform(float(p.bandCount ?? 8));
  const uTintMul = uniform(vec3(1, 1, 1));
  /** How many spawn slots hold real paint. Zero = nothing painted; the kernel
   * then parks every particle dead rather than spawning at the origin. */
  const uSpawnCount = uniform(float(0));
  /**
   * How many of the arena's slots are actually alive this frame.
   *
   * ⚠️ WITHOUT THIS, A MAP WITH ONE HEARTH PUTS EVERY PARTICLE ON IT. Capacity
   * is map-wide by design (a constant ceiling regardless of fire count — the
   * whole performance argument for this rebuild), but V2's ~95 embers per FLOOR
   * were spread over every fire on it. Concentrate that budget on a single 50 px
   * hearth and it reads as a cluster of headlights, which is exactly what the
   * author saw: *"the flames are all dots which are wobbling around."*
   *
   * Same mechanism the gust engine already uses for its own count modulation:
   * over-count slots are forced invisible in the DRAW and still simulated. The
   * sim is the cheap half — a compute dispatch over the full capacity costs far
   * less than the fill rate of the sprites it would otherwise draw — and
   * skipping it would make a count change pop instead of fade.
   */
  const uActiveCount = uniform(float(capacity));
  /**
   * THE PERSPECTIVE PAIR — the whole of V2's 3D, reproduced per particle.
   *
   * ⚠️ MSA's CAMERA IS FLAT ORTHOGRAPHIC AND THIS DOES NOT CHANGE THAT. V2 ran a
   * real `PerspectiveCamera` fixed at height 2000 over a ground plane at 1000,
   * zero tilt, zooming by FOV so the distance never varied — its own comment
   * names the payoff: *"Perspective depth for particles (rain/snow look 3D)...
   * Parallax effects during pan"*. The magnification that produced is
   *
   *     M(h) = D / (D − h)
   *
   * for an object `h` above the ground, with D = 1000. Because V2 zoomed by
   * changing FOV rather than moving the camera, D was constant and **M is
   * zoom-invariant** — the same percentage at every zoom level.
   *
   * That is a per-object transform, so a particle can simply apply it to itself:
   * displace away from the view centre by M and scale by M. The result is
   * mathematically identical to what V2's camera did to that particle, while
   * MSA's orthographic camera — and with it the depth authority, the masks, the
   * lighting and every other effect — stays exactly as it is. Converting the
   * global camera would reproduce the same thing for everything at once, but it
   * is a far larger change than fire alone justifies, and V2's own numbers say
   * it buys nothing below h ≈ 1 (floors and fire bases moved &lt;0.1%).
   */
  const uCamCentre = uniform(vec2(0, 0));
  const uCamHeight = uniform(float(PERSPECTIVE_CAMERA_HEIGHT));
  /**
   * THE DEPTH-AUTHORITY OCCLUSION GATE's OWN INPUT — this engine's population is
   * one representative elevation per sync (`fire-subsystem.js`'s own doc on
   * `expectedDepth` explains why one value, not per-particle). Fed through
   * `computeTieSafeExpectedDepth` by the caller, exactly like every other
   * consumer of `buildDepthHeightGateNode`.
   */
  const uExpectedDepth = uniform(float(0));

  // ── THE AUTHOR'S DIALS ────────────────────────────────────────────────────
  // Every one is a MULTIPLIER over the V2-derived constant in `KINDS`, never a
  // replacement for it: 1.0 always means "exactly what V2 shipped", so a value
  // is always readable as a distance from the reference rather than an absolute
  // nobody can calibrate. Ranges are deliberately far wider than anything
  // plausible — the author asked to find the values, and a slider that cannot
  // reach the answer is worse than no slider.
  //
  // ⚠️ LIFE/CHAOS/RISE ARE WIND0/WIND1 PAIRS, 2026-09-04, ROUND 7 — author:
  // *"two separate controls for each element for Wind being 0 and wind being
  // 1, we blend between those two."* Each pair blends against
  // `effectiveWindMotion` — THIS PARTICLE'S OWN real, per-position wind
  // exposure (the ROUND 4-6 openness-gated signal), never the map-wide dial
  // directly — so a spawn point sheltered from wind keeps its Wind-0
  // character even while an exposed one on the SAME fire already reads its
  // Wind-1 value. See `effectiveWindMotionAt`, below, and each `mix(...)`
  // call site in the seed/update kernels.
  const uLifeAtWind0 = uniform(float(1));
  const uLifeAtWind1 = uniform(float(1));
  const uOpacityScale = uniform(float(1));
  const uEmissionScale = uniform(float(1));
  const uChaosAtWind0 = uniform(float(1));
  const uChaosAtWind1 = uniform(float(1));
  const uRiseAtWind0 = uniform(float(1));
  const uRiseAtWind1 = uniform(float(1));
  const uGrowthScale = uniform(float(1));
  const uColorAge = uniform(float(2.5));
  /**
   * How hard THIS kind's own particles get physically shoved by wind, layered
   * ON TOP of the self-scaled push magnitude `windAccelPerUnitSize` already
   * guarantees (construction site) — an author dial over that physics fix,
   * not a replacement for it. 1 = exactly the guarantee (`K.windSizesTarget`
   * × this kind's own rendered sprite size, within `K.windWorstCaseLifeS`, at
   * full `effectiveWindMotion`). See `accelAtMax` in the update kernel.
   */
  const uWindPushScale = uniform(float(1));
  /**
   * Playback rate for the field's own clock — how fast the turbulence churns
   * and, for flame, how fast its archetype silhouette boils. Deliberately
   * SEPARATE from chaos (how STRONG the push is) and life (how LONG a
   * particle survives, which happens to also pace flame's boil since its
   * phase runs over `t01 = age/life` — this multiplier decouples the two so
   * "faster boil" no longer requires "shorter-lived particles"). The param this
   * carries is `animationSpeed` ("Speed", fire.js) — see `fire-geometry.js`'s
   * `fireRuntimeFromParams` for why it is NOT `chain.puffHz`.
   */
  const uMotionSpeed = uniform(float(1));
  // 0 = uniform pick (the shipped default). Away from zero, warps WHICH spawn
  // point is chosen toward the bright (positive) or dark (negative) end of the
  // point list — see `spawnAt` below and the header of `fire-spawn-points.js`.
  const uSpawnBias = uniform(float(0));
  // Live by reference — a `setWindAmbient` change reaches the kernel with no
  // resync code, the same contract both existing runtimes rely on. Direction
  // only: magnitude comes from `uWindMotion01` below, not this raw speed —
  // see that uniform's own header for why.
  const uWindDirDeg = windHandle?.ambient ? windHandle.ambient.directionDeg : float(0);
  /**
   * THE PARTICLE WIND SIGNAL (fire-geometry.js#fireWindMotion01) — the raw
   * ambient speed already gained by the effect's own `windResponse` dial,
   * gated to exactly 0 when `weatherResponse=0`, and folded with the
   * representative fire's `windExposure`. Refreshed every frame through
   * `setParams`, exactly like the wind0/wind1 dial pairs above — NOT
   * live-by-reference like `uWindDirDeg` above, because unlike the shared
   * ambient vector this number is PER-EFFECT (an author's own dials feed
   * it), so it takes the same per-frame path every other author dial
   * already does rather than a second, parallel "live" contract.
   *
   * Drives three things in the update kernel: how much of flame's normally-
   * stationary pool gets mobilised, how hard the mobile fraction gets
   * shoved (a superlinear gust curve, not a flat multiply — see
   * WIND_GUST_MAX_MULT), and how far flame's own calm-air upward drift has
   * faded (see `calmRiseY`, KINDS.flame). Inert (0) until the first
   * `setParams` call, which matches "no wind" — a safe default.
   */
  const uWindMotion01 = uniform(float(0));

  /**
   * `effectiveWindMotion` AT AN ARBITRARY POSITION — the same openness-gated
   * signal the update kernel derives inline for the particle it is already
   * simulating (see that kernel's own note on `particleOpenness`), factored
   * out so the SEED kernel and the respawn branch below can roll a fresh
   * particle's LIFESPAN against real wind exposure AT ITS OWN SPAWN POINT,
   * not the map-wide dial — a spark born deep indoors gets its Wind-0
   * lifespan even while the map's dial reads full gale. Wall-deflection
   * direction is irrelevant to a scalar lifespan roll, so this reads
   * `cell.openness` alone rather than the full `kernel()` result the force
   * computation also needs.
   */
  const effectiveWindMotionAt = (posVec) => {
    const openness = windOpennessBuffer
      ? windHandle.kernel(TSL, { centerXY: posVec, time: uTimeMs, cellBuffer: windOpennessBuffer }).openness
      : float(1);
    const gain = openness.pow(float(0.5)).max(float(FIRE_OPENNESS_FLOOR_GAIN));
    return uWindMotion01.mul(gain);
  };

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  /**
   * A stable-per-LIFE random, with zero storage — the dot engine's idiom
   * (`particle-runtime.js#lifeRandomOf`). Reconstructs the particle's birth
   * timestamp as `now − age`, wraps it, and hashes that with the seed.
   *
   * ⚠️ THE WRAP IS NOT OPTIONAL. `uTimeMs` grows unbounded all session and
   * `sin()`'s float32 precision collapses at large arguments, so hashing the raw
   * clock makes distinct particles alias onto the same "random" value — the dot
   * engine's recorded fix-8. The wrap period comfortably exceeds any lifespan
   * here, so no single life straddles a boundary.
   */
  const BIRTH_WRAP_MS = 20000;
  const lifeRandomOf = (s, ageMs, salt) => {
    const birth = uTimeMs.sub(ageMs);
    const wrapped = birth.sub(float(BIRTH_WRAP_MS).mul(birth.div(float(BIRTH_WRAP_MS)).floor()));
    return hash11(
      s
        .mul(float(0.37))
        .add(wrapped.mul(float(0.011)))
        .add(float(salt))
    );
  };

  /**
   * V2's FAST FAKE CURL, ported verbatim (`fire-behaviors.js:64`).
   *
   * ⚠️ THIS IS EXACTLY DIVERGENCE-FREE, NOT AN APPROXIMATION OF ONE, and that is
   * why it is not "upgraded" to real 3D curl noise here. `vx` depends only on
   * `y` and `vy` only on `x`, so `∂vx/∂x = ∂vy/∂y = 0` — a genuinely
   * incompressible flow. Real simplex curl is also divergence-free but has
   * isotropic-blob character where this has crossed shear bands, so swapping it
   * is a LOOK change to be A/B'd, not a modernisation
   * (`feedback_port_faithfully_then_modernize_opportunistically`).
   *
   * V2 advanced the field's clock ONCE PER FRAME rather than per particle — a
   * recorded bug fix, since per-particle advance multiplied the noise speed by
   * the particle count. A compute kernel gets that for free: `uTimeMs` is one
   * uniform read shared by every invocation.
   */
  const fakeCurl = (pos, tSec) => {
    const px = pos.x.div(float(K.curlScale));
    const py = pos.y.div(float(K.curlScale));
    const vx = sin(py.mul(float(2.13)).add(tSec))
      .add(cos(py.mul(float(3.71)).sub(tSec)))
      .mul(float(0.5));
    const vy = cos(px.mul(float(2.27)).add(tSec))
      .add(sin(px.mul(float(3.43)).sub(tSec)))
      .mul(float(0.5));
    return vec2(vx, vy).mul(float(K.curlStrength));
  };

  /**
   * Pick a spawn point and write a fresh particle over the given slot.
   * Returns the new position; the caller assigns the rest.
   *
   * ⚠️ THE PICK IS UNIFORM AT `spawnBias = 0`, THE SHIPPED DEFAULT. Brightness
   * always scales the particle's life, size and heat once a point is picked
   * (V2's split — spawn density follows painted AREA, intensity follows painted
   * VALUE) — `fire-spawn-points.js` carries the same note at the other end.
   *
   * ⚠️ THE BIAS IS A POWER-CURVE WARP OF THE UNIFORM RANDOM, NOT A WEIGHTED
   * ALIAS TABLE. `spawnBuffer` arrives sorted ascending by brightness (dark → bright),
   * so "prefer a high index" and "prefer a bright point" are the same statement.
   * `u^k` for `k < 1` (a root) skews a Uniform(0,1) sample toward 1; for `k > 1`
   * (a power) it skews toward 0. Setting `k = 2^-bias` makes `bias > 0` skew
   * toward 1 → high index → BRIGHT, `bias < 0` skew toward 0 → DARK, and
   * `bias = 0` gives `k = 1` → untouched uniform. This costs one `pow()` and
   * zero extra storage; a true importance sample would need a second buffer
   * rebuilt on every mask edit for a difference nobody would see over the paint
   * granularity this runs at.
   */
  const spawnAt = (s, entropy) => {
    const u = hash11(entropy);
    const biasExponent = float(2).pow(float(0).sub(uSpawnBias));
    const biased = u.pow(biasExponent);
    const idx = biased
      .mul(uSpawnCount)
      .floor()
      .clamp(float(0), uSpawnCount.sub(float(1)));
    const pt = spawnBuffer.element(idx.toInt()).toVar();
    // Jitter inside the texel this point stands for — what makes a two- or
    // three-texel hearth spawn continuously instead of in a few columns.
    const jx = hash11(entropy.mul(float(1.7)).add(float(3.1)))
      .sub(float(0.5))
      .mul(float(2));
    const jy = hash11(entropy.mul(float(2.3)).add(float(9.7)))
      .sub(float(0.5))
      .mul(float(2));
    return {
      pos: vec2(pt.x.add(jx.mul(pt.w)), pt.y.add(jy.mul(pt.w))),
      brightness: pt.z,
    };
  };

  // ── SEED KERNEL ──────────────────────────────────────────────────────────
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    seed.element(i).assign(fi);
    velocity.element(i).assign(vec2(0, 0));
    const sp = spawnAt(fi.mul(float(1.37)).add(float(5.9)), fi.mul(float(0.61)).add(float(11.3)));
    position.element(i).assign(sp.pos);
    const bright = sp.brightness;
    // Life rolls against wind exposure AT THIS PARTICLE'S OWN SPAWN POINT
    // (`effectiveWindMotionAt`, above) — see its own note.
    const lifeMul = mix(uLifeAtWind0, uLifeAtWind1, effectiveWindMotionAt(sp.pos));
    // V2: `p.life *= (0.3 + 0.7 * brightness)` and `p.size *= (0.4 + 0.6 * brightness)`.
    const lifeSpan = mix(float(K.lifeMsMin), float(K.lifeMsMax), hash11(fi.mul(float(3.7))))
      .mul(float(0.3).add(bright.mul(float(0.7))))
      .mul(lifeMul)
      .max(float(1));
    lifeBuf.element(i).assign(lifeSpan);
    // Stagger ages across the FULL lifespan so the population starts already
    // spread across its fade envelope rather than every sprite igniting at once.
    age.element(i).assign(hash11(fi.mul(float(7.3)).add(float(2.2))).mul(lifeSpan));
    const heat = float(0.7).add(hash11(fi.mul(float(5.1))).mul(float(0.5)));
    const sizePx = mix(float(K.sizeMin), float(K.sizeMax), hash11(fi.mul(float(2.9)).add(float(17)))).mul(
      float(0.4).add(bright.mul(float(0.6)))
    );
    // w starts at 0: every particle is born on the ground.
    custom.element(i).assign(vec4(bright, heat, sizePx, float(0)));
  })().compute(capacity);

  // ── UPDATE KERNEL ────────────────────────────────────────────────────────
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const vel = velocity.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();
    const ageNow = age.element(i);

    // ── THE REAL WIND GRID, SAMPLED LIVE AT THIS PARTICLE'S OWN POSITION
    // (2026-09-04) — see the module header's own account of why. `openness`
    // is the wind bake's real, geometry-derived answer to "can moving air
    // reach exactly here" (walls/doors/enclosure — `world/wind-field.js`),
    // read fresh every frame off `pos`, so an ember drifting from a hearth
    // out through a doorway genuinely feels the transition rather than
    // carrying one map-wide number for its whole life. `windOpennessBuffer`
    // is null until a wind bake has actually produced one (see its own
    // construction-site comment) — every read below degrades to "fully
    // open", byte-identical to this runtime's pre-2026-09-04 behaviour.
    let particleOpenness = float(1);
    let wallAwayDirX = float(0);
    let wallAwayDirY = float(0);
    let wallProximity = float(0);
    // ROUND 5's isolation test (openness forced to 1, wall deflection
    // skipped, `hasOpennessGrid` still reporting true) shipped as a temporary
    // flag and its answer came back clean: even with sampling fully bypassed,
    // live-testing still found no reliable movement, so this code was never
    // the bug. ROUND 6's audit (see `windAccelPerUnitSize`, construction
    // site) found the real one — the old push MAGNITUDE was marginal-to-
    // insufficient by the numbers, regardless of openness. This gate is back
    // to doing exactly what its own header above describes, nothing more.
    if (windOpennessBuffer) {
      const cell = windHandle.kernel(TSL, { centerXY: pos, time: uTimeMs, cellBuffer: windOpennessBuffer });
      particleOpenness = cell.openness;
      wallAwayDirX = cell.wallAwayDirX;
      wallAwayDirY = cell.wallAwayDirY;
      wallProximity = cell.wallProximity;
    }
    // ⚠️ SQUARE-ROOTED, THEN FLOORED — NOT RAW (2026-09-04, ROUND 2, revised
    // ROUND 4 after the ×10 diagnostic). The diagnostic settled the question:
    // author, live, with the CPU-side "Wind response" dial already at its own
    // maximum (2×) AND a further ×10 blunt multiplier on top of that — STILL
    // "nothing in the way of sideways movement". Anything multiplied by
    // something genuinely at 0 stays 0 no matter how large the OTHER factor
    // is, which rules out "under-tuned strength" outright — a weak-but-real
    // signal would have visibly grown at either boost. It also rules out
    // `windOpennessBuffer` never being allocated at all: this file's own
    // fallback for that case is `particleOpenness = float(1)` (fully open),
    // which would have made the ×10 diagnostic read as DRAMATICALLY stronger
    // motion, not none. So the buffer IS wired and IS returning real sampled
    // data — data that reads at or near 0 at these particular painted spots.
    //
    // Leading theory, not fully provable without live access: fires are
    // routinely painted RIGHT AGAINST walls (a hearth built into a wall, a
    // brazier under an eave) in a way `_Bush`/`_Tree` paint typically is not —
    // and the wind bake's `openness` is a strict flood-fill from genuinely
    // outdoor cells, so a spot a human calls "outdoors" can still sit in a
    // cell the geometry calls enclosed. That is not necessarily a bug in the
    // shared mechanism itself (which the author confirms already looks right
    // for vegetation/gusts) — it is a mismatch between "looks outdoors" and
    // "flood-fill says open" for the SPECIFIC locations fire happens to be
    // painted at. `FIRE_OPENNESS_FLOOR_GAIN` makes the fix robust regardless
    // of which of these is the exact truth: it guarantees a real, visible
    // floor on wind response that NO reading — however strict — can crush to
    // literal zero, matching what the author actually asked for from the
    // start ("indoor/sheltered fires be LOW movement" — not none) without
    // touching `world/wind-field.js`/`wind-access.js` and risking the
    // vegetation/gust look the author confirmed already works.
    const opennessGain = particleOpenness.pow(float(0.5)).max(float(FIRE_OPENNESS_FLOOR_GAIN));
    // `uWindMotion01` is EXPOSURE-EXCLUDED now (fire-geometry.js#fireRuntimeFromParams's
    // own note) — multiplying it by this particle's own real openness is what
    // makes an indoor fire's flame stay calm while an outdoor one on the same
    // map genuinely gets shoved, instead of every fire on the floor sharing
    // one blended reading (the author's own "averaging is dumb" objection).
    const effectiveWindMotion = uWindMotion01.mul(opennessGain);
    // Chaos and rise blend the SAME way life does (`effectiveWindMotionAt`'s
    // own note, construction site) — real per-position exposure, not the
    // map-wide dial, so THIS particle's own local wind decides how much of
    // its Wind-0 vs. Wind-1 character shows.
    const chaosScaleNow = mix(uChaosAtWind0, uChaosAtWind1, effectiveWindMotion);
    const riseScaleNow = mix(uRiseAtWind0, uRiseAtWind1, effectiveWindMotion);

    // ⚠️ 95% of flame particles never move AT REST — V2's `flameStationaryFraction`,
    // and the signature of the whole look (a fire POOL should not translate).
    //
    // ⚠️ MOBILISED BY WIND (2026-09-03, now GATED BY REAL LOCAL OPENNESS
    // 2026-09-04) — the threshold SHRINKS toward 0 as `effectiveWindMotion`
    // rises, so a full gale pulls more of the pool loose rather than leaving
    // 95% welded down while only the original 5% gets shoved — but only for
    // particles whose OWN position genuinely feels that gale. Author: flame
    // should be *"pushed around in a huge way"* at wind 1 — and only "the
    // exposed/outdoors fires be moved". Ember/smoke already ship
    // `stationaryFraction: 0`, so this is an exact no-op for them (0 ×
    // anything is still 0) — only flame has a threshold to shrink.
    //
    // Derived per life rather than stored, so `custom.w` can hold height.
    const effectiveStationary = float(K.stationaryFraction)
      .mul(float(1).sub(effectiveWindMotion))
      .clamp(float(0), float(1));
    const motionScale = lifeRandomOf(s, ageNow, 29.0).step(effectiveStationary);

    // ── FORCES ──
    // ⚠️ Gated on `motionScale`, which is 0 for 95% of flame particles. V2
    // early-returned out of wind, buoyancy AND turbulence for those; multiplying
    // by zero is the same thing with no branch.
    // Per-particle offset into the flow's own time axis — see `curlPhasePerSeed`.
    // Zero for flame and smoke, which SHOULD move coherently as one body.
    const tSec = uTimeMs
      .mul(float(0.001))
      .mul(uMotionSpeed)
      .mul(float(K.curlTimeScale))
      .add(s.mul(float(K.curlPhasePerSeed ?? 0)));
    const curl = fakeCurl(pos, tSec).mul(motionScale).mul(chaosScaleNow);
    // Wind direction and MAGNITUDE-SHAPE stay a single ambient computation —
    // V2's own one frame-global wind scalar — but the STRENGTH that reaches
    // this particular particle is now real, per-position openness (above),
    // not a map-wide aggregate. See the module header's own account.
    //
    // ⚠️ FIRE USED TO CARRY ITS OWN PRIVATE COPY OF THIS FORMULA, and it was
    // right to at the time. `(sin, −cos)` was written here deliberately in
    // 2026-09-03 (author, live: "if I point wind north, they move east... 90
    // degree disagreement") because `wind-field.js` then read `directionDeg`
    // as 0°=EAST meteorological-FROM while the GM-facing compass dial read it
    // as 0°=NORTH pointing-TOWARD — and fire chose the dial, the one thing in
    // the scene the GM can verify by eye.
    //
    // RESOLVED 2026-09-04 (mythica-machina-press#487/#496, #497 Stage 0): the
    // author settled the convention as the dial's, so fire's reading was the
    // correct one all along and its VALUE here does not change. What changes
    // is that the formula is no longer fire's own — it comes from the single
    // shared helper every consumer now calls (`world/wind-bake.js#
    // windFlowVector` documents the convention; `windFlowVectorNode` is its
    // shader twin). One implementation to be right or wrong.
    //
    // ⚠️ THE GUST CURVE IS SUPERLINEAR, DELIBERATELY (2026-09-03) — a flat
    // multiply by `effectiveWindMotion` reads as merely "more wind"; passes
    // through exactly 0 at `effectiveWindMotion=0` and grows to
    // `WIND_GUST_MAX_MULT`× a flat-linear response at 1, so calm stays calm
    // and only the top of the dial gets dramatic. See WIND_GUST_MAX_MULT's
    // own header.
    const gustPush = effectiveWindMotion.mul(float(1).add(effectiveWindMotion.mul(float(WIND_GUST_MAX_MULT - 1))));
    let windDirVec = windFlowVectorNode(TSL, uWindDirDeg);
    // WALL DEFLECTION (2026-09-04) — a free bonus of sampling the real grid
    // above: `deflectAroundWalls` is a purely geometric push-away-from-the-
    // wall-surface operation on a raw world-space (x,y) vector, so it composes
    // correctly with OUR OWN compass-dial-matching direction regardless of
    // that vector's own angle convention (unlike `windHandle.kernel()`'s own
    // `coherent` term, which is NOT used here — see the mismatch note above;
    // taking its direction would silently re-break mythica-machina-press#485).
    // A particle's wind now genuinely curls around a nearby wall corner
    // instead of blowing straight through it.
    if (windOpennessBuffer) {
      windDirVec = deflectAroundWalls(TSL, {
        vector: windDirVec,
        awayDirX: wallAwayDirX,
        awayDirY: wallAwayDirY,
        proximity: wallProximity,
      });
    }
    // Self-scaled magnitude (see `windAccelPerUnitSize`'s construction-site
    // note) — `gustPush` still carries the superlinear "dramatic at the top"
    // SHAPE (`WIND_GUST_MAX_MULT`), normalised by its own ceiling so
    // `accelAtMax` (the guaranteed `K.windSizesTarget`×-sprite-size figure) is
    // what actually gets scaled by it, reached exactly at
    // `effectiveWindMotion = 1`. `referenceSizePx` reads the LIVE size dial
    // (`uSizeScale`) so a fire the author scales up or down keeps the same
    // sizes-per-second feel rather than a fixed pixel speed. `uWindPushScale`
    // (ROUND 7) is the author's own dial ON TOP of that guarantee — 1 leaves
    // it untouched, above/below asks for more/less than the guarantee alone.
    const referenceSizePx = float((K.sizeMin + K.sizeMax) * 0.5).mul(uSizeScale);
    const accelAtMax = referenceSizePx.mul(float(windAccelPerUnitSize)).mul(uWindPushScale);
    const windVec = windDirVec
      .mul(gustPush.div(float(WIND_GUST_MAX_MULT)))
      .mul(accelAtMax)
      .mul(motionScale);
    // Buoyancy: +Y (up-SCREEN) for smoke UNCONDITIONALLY — see the KINDS
    // note — plus flame's own CALM-ONLY rise (2026-09-03, `calmRiseY`): a
    // gentle upward drift on the already-mobile tips, strongest at rest for
    // depth/3D and fading out as wind rises so a gale reads as sideways, not
    // upward. Ember/smoke ship `calmRiseY: 0`, so the second term is an
    // exact no-op for them. Fades on THIS particle's own local wind, not the
    // map-wide ceiling, for the same reason `effectiveStationary` does above.
    // ⚠️ CLAMPED — `effectiveWindMotion` is naturally back in [0,1] now (the
    // product of two [0,1]-bounded terms, `uWindMotion01` and
    // `opennessGain`), so this is a defensive guard rather than a currently-
    // load-bearing one. Kept anyway: an unclamped `calmFade` would go
    // negative and FLIP the calm-rise term's sign the moment either factor's
    // own bound ever loosens (a future author dial, a future diagnostic),
    // shoving flame sharply downward instead of merely fading its upward
    // drift to zero — cheap insurance against a sharp, confusing regression.
    const calmFade = float(1).sub(effectiveWindMotion).clamp(float(0), float(1));
    const buoyancy = vec2(0, float(-K.buoyancyY * 60).sub(float((K.calmRiseY ?? 0) * 60).mul(calmFade))).mul(
      motionScale
    );

    const accel = curl.add(windVec).add(buoyancy);
    // Exponential damping, solved from V2's per-update 0.85 at 30 Hz.
    const damped = vel.add(accel.mul(uDtSec)).mul(float(Math.E).pow(float(-K.dampK).mul(uDtSec)));
    const next = pos.add(damped.mul(uDtSec));

    // ── AGE AND RESPAWN ──
    // HEIGHT — the only genuinely integrated state, and what drives perspective.
    // ⚠️ `riseScaleNow` FIXES A DEAD CONTROL, 2026-09-04, ROUND 7 — the old
    // single `uRiseScale` uniform was correctly SET by `setParams` but never
    // READ here at all (`feedback_unconsumed_api_rots_silently`): `emberRise`/
    // `smokeRise` moved the uniform's value and changed nothing on screen.
    // Multiplying it in properly, split into the wind0/wind1 blend besides,
    // is both the fix and the new feature at once.
    const risen = c.w.add(
      float(K.riseZ)
        .mul(riseScaleNow)
        .mul(uDtSec)
        .mul(motionScale.max(float(0.15)))
    );

    const lifeSpan = lifeBuf.element(i).toVar();
    const agedMs = age.element(i).add(uDtSec.mul(float(1000)));
    const expired = agedMs.greaterThanEqual(lifeSpan);
    // Bounded entropy — seed plus the particle's OWN position, never the raw
    // unbounded clock (the dot engine's fix-8 precision trap: sin()'s float32
    // precision collapses at large arguments and uTimeMs grows all session).
    const entropy = s
      .mul(float(0.61))
      .add(next.x.mul(float(0.011)))
      .add(next.y.mul(float(0.013)));
    const sp = spawnAt(entropy, entropy.mul(float(1.9)).add(float(4.4)));

    // A fire with no painted region has nothing to spawn from; park everything
    // dead rather than piling every particle on the world origin.
    const hasPaint = uSpawnCount.greaterThan(float(0.5));
    const respawn = expired.and(hasPaint);

    position.element(i).assign(respawn.select(sp.pos, next));
    velocity.element(i).assign(respawn.select(vec2(0, 0), damped));
    age.element(i).assign(respawn.select(float(0), agedMs));

    const bright = sp.brightness;
    // Same spawn-point wind roll the seed kernel uses — see
    // `effectiveWindMotionAt`'s own note.
    const newLifeMul = mix(uLifeAtWind0, uLifeAtWind1, effectiveWindMotionAt(sp.pos));
    const newLife = mix(float(K.lifeMsMin), float(K.lifeMsMax), hash11(entropy.mul(float(1.3))))
      .mul(float(0.3).add(bright.mul(float(0.7))))
      .mul(newLifeMul)
      .max(float(1));
    lifeBuf.element(i).assign(respawn.select(newLife, lifeSpan));
    const newHeat = float(0.7).add(hash11(entropy.mul(float(2.7))).mul(float(0.5)));
    const newSize = mix(float(K.sizeMin), float(K.sizeMax), hash11(entropy.mul(float(3.1)).add(float(13)))).mul(
      float(0.4).add(bright.mul(float(0.6)))
    );
    // A respawning particle starts back on the ground; everything else keeps
    // climbing.
    custom.element(i).assign(respawn.select(vec4(bright, newHeat, newSize, float(0)), vec4(c.x, c.y, c.z, risen)));
  })().compute(capacity);

  // ── THE DRAW ─────────────────────────────────────────────────────────────
  // InstancedBufferGeometry (not InstancedMesh) so there is no instanceMatrix to
  // reconcile with a positionNode that already returns world space.
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = capacity;

  /** Normalized age, per instance — every life curve reads it. */
  const vLife = Fn(() => {
    const i = instanceIndex;
    const t01 = age
      .element(i)
      .div(lifeBuf.element(i).max(float(1)))
      .clamp(float(0), float(1));
    const c = custom.element(i);
    // ⚠️ BUNDLED INTO ONE vec4 RATHER THAN FOUR VARYINGS — storage reads are
    // vertex-stage only on this renderer, so anything the fragment needs must
    // cross as a varying, and both existing runtimes pack rather than multiply.
    return vec4(t01, c.x, c.y, seed.element(i));
  })().toVarying('vFireLife');

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const i = instanceIndex;
    const corner = positionGeometry.xy;
    const centre = position.element(i);
    const c = custom.element(i);
    const t01 = age
      .element(i)
      .div(lifeBuf.element(i).max(float(1)))
      .clamp(float(0), float(1));
    // V2's SizeOverLife: born at zero, peaks around mid-life, returns to zero —
    // so a sprite grows into existence instead of popping. Smoke additionally
    // swells by `growth` across its life.
    // ⚠️ A PLATEAU, NOT A POINT. V2's SizeOverLife is a bezier peaking at
    // mid-life, so `4t(1−t)` is full size for a single instant and small either
    // side of it — which is most of why the author read these as brief "puffs"
    // even at their real lifespan. Overshooting and clamping holds a sprite at
    // full size for the middle ~70% of its life while keeping the grow-in and
    // shrink-out that stop it popping.
    const arc = t01.mul(float(1).sub(t01)).mul(float(4)).mul(float(1.9)).clamp(float(0), float(1));
    const grow = float(1).add(
      float(K.growth - 1)
        .mul(uGrowthScale)
        .mul(t01)
    );
    // Slots past the active count collapse to zero size — invisible, and
    // costing no fill rate, without needing a separate draw range.
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));

    // ── PERSPECTIVE — V2's `M(h) = D / (D − h)`, applied per particle ──
    // A particle `h` above the ground is nearer the camera, so it appears
    // larger AND displaced radially away from the view centre. Clamped well
    // short of D: a particle that reached the camera plane would divide by zero
    // and smear across the entire screen.
    const h = c.w.clamp(float(0), uCamHeight.mul(float(0.6)));
    const persp = uCamHeight.div(uCamHeight.sub(h));
    const parallaxed = uCamCentre.add(centre.sub(uCamCentre).mul(persp));

    const sizePx = c.z.mul(arc).mul(grow).mul(uSizeScale).mul(alive).mul(persp);
    return vec3(parallaxed.x.add(corner.x.mul(sizePx)), parallaxed.y.add(corner.y.mul(sizePx)), float(zDepth));
  })();

  material.colorNode = Fn(() => {
    const t01 = vLife.x;
    const bright = vLife.y;
    const heat = vLife.z;
    let rgb;
    if (kind === 'flame') {
      const shade = buildFlameShading(TSL, {
        t01,
        heat,
        brightness: bright,
        ageToTemperature: uColorAge,
        posterizeAmount: uPosterize,
        bandCount: uBandCount,
        tintMul: uTintMul,
      });
      rgb = shade.rgb.mul(uIntensity).mul(uEmissionScale);
    } else if (kind === 'ember') {
      const emberRgb = piecewiseLinearRgb(TSL, t01, EMBER_COLOR_STOPS);
      const em = piecewiseLinear(TSL, t01, EMBER_EMISSION_STOPS).mul(float(EMBER_EMISSION * FIRE_HDR_LINEAR_GAIN));
      rgb = emberRgb.mul(em).mul(heat).mul(uIntensity).mul(uEmissionScale);
    } else {
      // Smoke is born the colour the flame died — see SMOKE_COLOR_STOPS' own note.
      rgb = piecewiseLinearRgb(TSL, t01, SMOKE_COLOR_STOPS).mul(uIntensity).mul(uEmissionScale);
    }
    // ONE hue-rotate for all three kinds, post-emission — recolouring is a
    // linear operator (see hueRotateNode's own header), so it commutes with
    // the HDR gain above and this stays correct however bright the particle
    // is. This is what keeps a recoloured fire reading as ONE object instead
    // of a flame that changed colour while its own embers/smoke did not.
    return hueRotateNode(TSL, rgb, uHueShiftRad);
  })();

  material.opacityNode = Fn(() => {
    const t01 = vLife.x;
    const bright = vLife.y;
    const sd = vLife.w;
    const fade = buildLifeFade(TSL, t01, K.fadeIn, K.fadeOut);
    // THE DEPTH-AUTHORITY OCCLUSION GATE — the SAME node candle/lightning
    // already use (point-light-illumination.js#buildDepthHeightGateNode), so a
    // fire painted/anchored under a roof tile goes dark exactly like they do
    // (mythica-machina-press#469 — fire previously had no occlusion awareness
    // at all). Gated on opacity alone: AdditiveBlending's default SrcAlpha
    // source factor already scales flame/ember's contribution by alpha, and
    // smoke (NormalBlending) needs opacity gated regardless — no need to also
    // touch colorNode. `screenUV`, never the bare node — this is a WORLD-space
    // instanced batch, not a screen-space quad.
    let occlusionGate = float(1);
    if (depthTexNode) {
      const depthHere = depthTexNode.sample(screenUV);
      const flagsHere = depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null;
      occlusionGate = buildDepthHeightGateNode(TSL, { depthHere, flagsHere, uLightExpectedDepth: uExpectedDepth });
    }
    if (kind === 'flame') {
      // The archetype's own silhouette. Phase advances with the particle's age
      // (scaled by uMotionSpeed, so the boil itself can speed up or slow down
      // without shortening or lengthening the particle's actual life) and is
      // offset per particle so neighbours never flicker in unison.
      const phase = t01
        .mul(float(6.2832))
        .mul(uMotionSpeed)
        .add(sd.mul(float(97)));
      const shape = buildFlameShapeAlpha(TSL, { nx: uv().x, ny: uv().y, phase, seed: sd, archetype });
      const shade = buildFlameShading(TSL, { t01, heat: float(1), brightness: bright, ageToTemperature: uColorAge });
      return shape.mul(shade.alpha).mul(fade).mul(uOpacityScale).mul(occlusionGate);
    }
    // Ember and smoke are soft radial dots — V2's ember sprite is a 15×15
    // authored blur, which is what this is, minus the texture fetch.
    const d = uv().sub(0.5).length();
    const soft = d.mul(float(2)).oneMinus().clamp(float(0), float(1));
    const radial = soft.mul(soft);
    if (kind === 'ember')
      return radial.mul(float(EMBER_PEAK_OPACITY)).mul(fade).mul(bright).mul(uOpacityScale).mul(occlusionGate);
    return radial.mul(float(0.19)).mul(fade).mul(bright).mul(uOpacityScale).mul(occlusionGate);
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // ⚠️ DoubleSide or the whole batch is culled SILENTLY — the flipped camera
  // (`top = minY`) inverts winding and `FrontSide` renders nothing, with no error.
  material.side = THREE.DoubleSide;
  // Flame and ember EMIT; smoke OCCLUDES. V2 shipped exactly this split, and it
  // is why smoke can darken the map instead of only adding warm haze.
  material.blending = K.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.toneMapped = false;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // world-space bounds vary per frame; culling is the GPU's job
  mesh.renderOrder = renderOrder; // see the constructor param's own doc — must be on the mesh, not `scene`
  const scene = new THREE.Scene();
  scene.add(mesh);

  let seeded = false;

  return {
    scene,
    capacity,
    kind,
    archetype,
    init(renderer) {
      if (seeded) return;
      renderer.compute(seedKernel);
      seeded = true;
    },
    /**
     * Hand the engine this floor's painted spawn cloud. Cheap and idempotent —
     * call it when the mask version moves, never per frame.
     */
    setSpawnPoints(cloud) {
      spawnCount = packSpawnPoints(spawnBacking, cloud, SPAWN_CAPACITY);
      uSpawnCount.value = spawnCount;
      spawnBuffer.value.needsUpdate = true;
      // A cloud arriving AFTER the seed pass leaves every particle parked at
      // whatever the seed found (nothing). Re-seed once so the population is
      // distributed over the real paint rather than waiting out a full lifespan.
      seeded = false;
    },
    step(renderer, { dtSec, tMs, worldRect: rect }) {
      if (rect) this.setWorldRect(rect);
      uDtSec.value = Math.min(0.05, Math.max(0, dtSec || 0));
      uTimeMs.value = tMs || 0;
      if (!seeded) this.init(renderer);
      // Synchronous — never computeAsync in-frame, which awaits a readback and
      // would stall the render loop.
      renderer.compute(updateKernel);
    },
    setWorldRect(rect) {
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(rect.maxX - rect.minX, rect.maxY - rect.minY);
      // The perspective centre IS the view centre — that is where V2's camera
      // sat, and it is the point everything splays away from. Following the
      // rect is what makes the parallax move correctly when the GM pans.
      uCamCentre.value.set((rect.minX + rect.maxX) * 0.5, (rect.minY + rect.maxY) * 0.5);
    },
    setParams(p2 = {}) {
      const set = (u, v) => {
        if (Number.isFinite(v)) u.value = v;
      };
      set(uIntensity, p2.intensity);
      set(uSizeScale, p2.sizeScale);
      set(uTemperature, p2.temperature);
      set(uLifeAtWind0, p2.lifeAtWind0);
      set(uLifeAtWind1, p2.lifeAtWind1);
      set(uOpacityScale, p2.opacityScale);
      set(uEmissionScale, p2.emissionScale);
      set(uChaosAtWind0, p2.chaosAtWind0);
      set(uChaosAtWind1, p2.chaosAtWind1);
      set(uRiseAtWind0, p2.riseAtWind0);
      set(uRiseAtWind1, p2.riseAtWind1);
      set(uGrowthScale, p2.growthScale);
      set(uWindPushScale, p2.windPushScale);
      set(uColorAge, p2.colorAge);
      set(uSpawnBias, p2.spawnBias);
      set(uMotionSpeed, p2.motionSpeed);
      set(uHueShiftRad, p2.hueShiftRad);
      set(uPosterize, p2.posterizeAmount);
      set(uBandCount, p2.bandCount);
      set(uExpectedDepth, p2.expectedDepth);
      set(uWindMotion01, p2.windMotion01);
      if (Array.isArray(p2.tintMul) && p2.tintMul.length === 3) {
        uTintMul.value.set(p2.tintMul[0], p2.tintMul[1], p2.tintMul[2]);
      }
      // ⚠️ CLAMPED TO THE ARENA, not to the slider's range. The control is
      // allowed to ask for more particles than exist; it just cannot get them,
      // and silently capping is far better than indexing past the buffer.
      if (Number.isFinite(p2.activeCount)) uActiveCount.value = Math.max(0, Math.min(capacity, p2.activeCount));
      if (Number.isFinite(p2.cameraHeight)) uCamHeight.value = Math.max(1, p2.cameraHeight);
    },
    updateWind(nextHandle) {
      // `uWindDirDeg` is read BY REFERENCE, so a direction change needs no
      // push at all. Speed/response/gate no longer are (2026-09-03) — see
      // `uWindMotion01`'s own header — they arrive through `setParams` every
      // frame instead, driven by `fire-subsystem.js`'s own fresh read of this
      // same handle.
      //
      // ⚠️ THE WIND-CELL BUFFER'S CONTENTS DO NEED A REAL REFRESH NOW
      // (2026-09-04) — mirrors `gust-runtime.js#updateWind` exactly,
      // including its "refresh in place, refuse a genuine regrid" posture.
      // Unlike a material (which bakes the grid spec in as build-time
      // constants and must be rebuilt), this engine's storage buffer can be
      // overwritten IN PLACE, because cols/rows are stable across an
      // ordinary rebake — only a wall/door edit changing the CONTENTS, not
      // the scene/grid-size changing the SHAPE. A genuine regrid is refused
      // loudly rather than hot-patched: the buffer would need reallocating
      // and every particle-position→cell-index computation above was baked
      // against `windHandle`'s OWN grid-spec constants (`kernel()`'s own
      // closure, not reassigned here — see below).
      if (windOpennessBuffer && nextHandle?.grid && nextHandle?.cells && nextHandle.version !== windHandleVersion) {
        const { cols, rows } = nextHandle.grid;
        if (cols !== opnCols || rows !== opnRows) {
          log.error(
            `${kind}: wind grid size changed (${opnCols}x${opnRows} -> ${cols}x${rows}) — ignoring this rebake ` +
              '(the storage buffer would need reallocating; other wind-reading materials still update).'
          );
        } else {
          packWindCells(windOpennessBuffer.value, nextHandle.cells, cols * rows);
          windHandleVersion = nextHandle.version;
        }
      }
      // The closure's own `windHandle` is DELIBERATELY never reassigned —
      // same reason gust-runtime.js's isn't: its `.kernel()` method's
      // origin/cellSize/cols/rows are build-time constants baked at
      // CONSTRUCTION, and those stay valid across any rebake this branch
      // didn't just refuse. Only the DATA the buffer holds needed updating.
      if (nextHandle && nextHandle !== windHandle) {
        log.info(`${kind}: wind handle changed; direction is read by reference, no regrid needed`);
      }
    },
    debugState() {
      return {
        kind,
        archetype,
        capacity,
        spawnPoints: spawnCount,
        seeded,
        dtSec: uDtSec.value,
        intensity: uIntensity.value,
        activeCount: uActiveCount.value,
        camHeight: uCamHeight.value,
        windMotion01: uWindMotion01.value,
        hasOpennessGrid: !!windOpennessBuffer,
        // The guaranteed floor from ROUND 6's audit — at effectiveWindMotion=1,
        // a mobile particle's wind accel reaches referenceSizePx *
        // windAccelPerUnitSize px/s², independent of grid calibration. Exposed
        // here so a future audit can read it straight off getFireStatus()
        // instead of re-deriving it by hand.
        windAccelPerUnitSize,
        // ROUND 7's wind0/wind1 blend pairs, as currently live — useful for
        // confirming an author dial actually reached the kernel without
        // re-deriving the blend by hand.
        lifeAtWind0: uLifeAtWind0.value,
        lifeAtWind1: uLifeAtWind1.value,
        chaosAtWind0: uChaosAtWind0.value,
        chaosAtWind1: uChaosAtWind1.value,
        riseAtWind0: uRiseAtWind0.value,
        riseAtWind1: uRiseAtWind1.value,
        windPushScale: uWindPushScale.value,
      };
    },
  };
}
