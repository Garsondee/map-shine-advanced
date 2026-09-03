/**
 * THE WIND HANDLE — one object every consumer receives, so nobody assembles
 * the wind field by hand ever again.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS (the bug CLASS it closes — docs/planning/Wind.md §5.1)
 * ============================================================================
 *
 * `world/wind-field.js#sampleWind` is already THE one wind formula, and every
 * consumer genuinely calls it. That half worked. What rotted is the
 * ASSEMBLY: `sampleWind` needs five separate inputs, and until this file
 * existed every consumer hand-assembled them from closure locals living in
 * `vt/vt-pan-viewer.js`:
 *
 *     ambientWind: { directionDeg: uWindDirectionDeg, speed01: uWindSpeed01 },
 *     bakedField:  windBakedField,
 *     wallAvoidField: windWallAvoidField,
 *     liveField:   windLiveField,
 *
 * That block was copy-pasted VERBATIM at four sites (light illumination, light
 * coloration, candle flame, debug overlay), and two further consumers
 * (`effects/particles/particle-runtime.js`, `effects/particles/gust-runtime.js`)
 * took a DIFFERENT shape entirely — raw arrays uploaded as a storage buffer,
 * because a WebGPU compute kernel here is never proven safe to sample a
 * texture from. Seven consumers, two incompatible access shapes, six
 * hand-written wirings, nothing checking that they agreed.
 *
 * THREE PROOFS THAT ROTS, all from this project's own history, none invented:
 *
 *   1. A consumer silently omitted an input for an entire phase.
 *      `particle-runtime.js`'s `sampleWind` call never passed `bakedField`, so
 *      the door-boosted turbulence built days earlier never reached the
 *      visible dust motes AT ALL — only candles, lights and the overlay ever
 *      saw it. Found by accident, while building something unrelated.
 *   2. A consumer silently FROZE an input forever. `windOverlayMesh` kept
 *      pointing at whatever material object it was constructed with, so after
 *      a rebake it still held the STARTUP (windless) bake's texture. Symptom
 *      as reported: "rebaking never visibly changes anything." Fixed by hand,
 *      in that one consumer; nothing checked the other five.
 *   3. Shared math had to be RESCUED after the copies existed.
 *      `computeWindTurbulence` was extracted only once two divergent copies
 *      were already live. Extraction-after-the-fact is the tax manual
 *      assembly charges.
 *
 * THE FIX IS A HANDLE, NOT ANOTHER SHARED HELPER. More helpers do not stop
 * drift — proof 3 IS a shared helper, and it arrived late because nothing
 * forced it to arrive early. What stops drift is making the malformed call
 * UNWRITEABLE: this handle is built in exactly one place (the thing that owns
 * the bake), it takes every input at once, and a consumer holding one never
 * spells `bakedField`. Proof 1 stops being a mistake anyone can make, rather
 * than a mistake anyone is merely warned about.
 *
 * Backed by the `wind/handle-only` tripwire (tools/verify-structure.mjs) —
 * outside `world/`, those input names may not appear. Same shape and the same
 * enforcement as the already-proven `masks/authority-only` wall. A comment
 * cannot fail a build; that rule can.
 *
 * ============================================================================
 * THE THREE SHAPES, AND WHY THERE ARE THREE
 * ============================================================================
 *
 *   `node(TSL, …)`   — any ordinary TSL material (candle flame, light
 *                      illumination/coloration, the debug overlay, vegetation
 *                      when it lands). Wraps `sampleWind` and forwards every
 *                      ref ITSELF.
 *   `kernel(TSL, …)` — a compute kernel, which reads a STORAGE BUFFER rather
 *                      than a texture. Same maths, different fetch. Returns
 *                      the field DECOMPOSED (see that method's own doc) — the
 *                      two kernels compose the parts differently and must keep
 *                      being allowed to.
 *   `cpuAt(x, y)`    — plain JS, for placement-time questions ("how sheltered
 *                      is this spot?") asked before any shader exists.
 *
 * They are three fetch strategies over ONE field, not three fields. The
 * node↔kernel pair is held honest by a real Node test
 * (`__tests__/wind-access.test.mjs`) that evaluates both through a numeric TSL
 * stub and asserts they agree — replacing the previous guarantee, which was a
 * source comment promising the kernels "replicate sampleWind's own ambient-bias
 * formula byte-for-byte". A comment is not a test
 * (`feedback_instruments_must_not_lie`).
 *
 * ============================================================================
 * IMMUTABLE, VERSIONED, REBUILT — never mutated
 * ============================================================================
 *
 * Every consumer bakes `originX`/`originY`/`cellSize`/`cols`/`rows` into its
 * node graph as build-time CONSTANTS, and whether a field is present at all is
 * a JS-time branch inside `sampleWind` (`tsl/no-uniform-gates`) — so a rebake
 * genuinely requires consumers to REBUILD, not merely to re-read. That is what
 * proof 2 above actually is.
 *
 * So a handle is frozen at construction and a rebake makes a NEW one, with
 * `version` incremented. A consumer that caches anything derived from a handle
 * stores the `version` it built against and rebuilds when it moves. That turns
 * proof 2 from "a bug found by hand in one consumer" into "a rule every
 * consumer can be checked against mechanically".
 *
 * TSL is passed IN, never imported — this module stays importable from Node
 * (CONVENTIONS §4), the same discipline `world/wind-field.js` already keeps.
 *
 * @module world/wind-access
 */

import {
  sampleWind,
  computeWindTurbulence,
  computeGustEnvelope,
  deflectAroundWalls,
  windFlowVectorNode,
  WIND_SHADOW_DEPTH,
} from './wind-field.js';

/**
 * @typedef {object} WindGridSpec
 * @property {number} originX - world x of cell (0,0)'s corner.
 * @property {number} originY - world y of cell (0,0)'s corner.
 * @property {number} cellSize - world px per cell.
 * @property {number} cols
 * @property {number} rows
 */

/**
 * @typedef {object} WindCellArrays - the raw per-cell data, for consumers that
 *   upload it as a storage buffer instead of sampling a texture. Same grid,
 *   same cell order (row-major, `y * cols + x`) as the textures.
 * @property {Uint8Array} [solid] - 1 where a wall occupies the cell.
 * @property {ArrayLike<number>} [openness] - 0..1 connectivity to open air.
 * @property {ArrayLike<number>} [wallAvoidDirX]
 * @property {ArrayLike<number>} [wallAvoidDirY]
 * @property {ArrayLike<number>} [wallProximity]
 * @property {ArrayLike<number>} [windShadow] - 0..1 upwind occlusion
 *   (`wind-enclosure.js#upwindShelter`), RAW — the geometry's own answer,
 *   before `wind-field.js#WIND_SHADOW_DEPTH` scales it for looks. Unlike every
 *   other array here this one is DIRECTION-DEPENDENT: it is only valid for the
 *   wind direction the bake that produced it was run with, which is why
 *   `setWindAmbient` re-bakes on a direction change.
 */

/**
 * Build the wind handle. Called by the ONE thing that owns the bake, with
 * everything it just produced; frozen on return.
 *
 * Every argument is optional and every omission is honest: a handle built with
 * no textures at all produces byte-identical output to calling `sampleWind`
 * with those arguments omitted (Tier 0 behaviour), because it forwards
 * `undefined` rather than a null it would have to branch on per-pixel. So a
 * consumer written against a handle behaves correctly before the first bake
 * has ever completed, with no null-checking of its own.
 *
 * @param {object} [spec]
 * @param {number} [spec.version] - bumped by the owner on every rebake.
 * @param {{directionDeg: *, speed01: *, gustiness01?: *}} [spec.ambientWind] -
 *   live TSL uniform NODES (not numbers) for the prevailing breeze. Passed by
 *   reference, so a direction/speed/gustiness change is picked up with no
 *   rebuild. `gustiness01` (2026-08-15) drives the discrete travelling gust
 *   envelope — see `world/wind-field.js#computeGustEnvelope`. Omitting it is
 *   byte-identical to before gusts existed, and it is the ONE input here whose
 *   change genuinely needs no rebake either: unlike `directionDeg` (which the
 *   wind SHADOW is baked against), gustiness touches nothing on the CPU side.
 * @param {WindGridSpec} [spec.grid]
 * @param {*} [spec.opennessTexture] - RGBA half-float; B = `openness`,
 *   A = `exteriorOpenness`, R/G reserved zeros (see `sampleWind`'s own
 *   `bakedField` param doc for the full channel contract — Tier 2's advect
 *   pass reads `.xy` as a transport velocity, so they must stay well-defined).
 * @param {*} [spec.wallAvoidTexture] - RGBA half-float; R/G = the "away from
 *   nearest wall" unit vector, B = proximity 0..1, A = the wind shadow (0..1
 *   upwind occlusion, `wind-enclosure.js#upwindShelter` — A was an unused
 *   constant 1 before 2026-08-01).
 * @param {*} [spec.liveTexture] - Tier 2's published D_live target texture.
 * @param {WindCellArrays} [spec.cells]
 * @param {(x: number, y: number) => number} [spec.cpuExposureAt] - the CPU
 *   point query for sky/shelter exposure at a world position.
 * @returns {Readonly<object>} the handle.
 */
export function createWindHandle({
  version = 0,
  ambientWind = null,
  grid = null,
  opennessTexture = null,
  wallAvoidTexture = null,
  liveTexture = null,
  cells = null,
  cpuExposureAt = null,
} = {}) {
  // The `sampleWind`-shaped ref objects, assembled HERE and nowhere else.
  // `undefined` (not null) when absent — `sampleWind` branches on presence at
  // JS time, and the whole "byte-identical when omitted" guarantee in its own
  // header depends on the argument genuinely not being there.
  const bakedFieldRef = grid && opennessTexture ? { texture: opennessTexture, ...gridOf(grid) } : undefined;
  const wallAvoidFieldRef = grid && wallAvoidTexture ? { texture: wallAvoidTexture, ...gridOf(grid) } : undefined;
  const liveFieldRef = grid && liveTexture ? { texture: liveTexture, ...gridOf(grid) } : undefined;
  const ambientRef = ambientWind ?? undefined;

  /**
   * THE TSL SHAPE — for any ordinary material. Every field ref is forwarded by
   * this function; the caller supplies only what is genuinely its own (where
   * it is, what time it is, and how sheltered that spot is).
   *
   * @param {*} TSL - THREE.TSL.
   * @param {object} args
   * @param {*} args.centerXY - vec2 node, the WORLD position being sampled.
   * @param {*} args.time - the shared clock node (uGlobalTimeMs, ms).
   * @param {*} args.exposure - float node 0..1, sky/shelter exposure here.
   * @returns {*} a vec2 node — a lean direction × strength, exactly as
   *   `sampleWind` returns (each caller scales it into its own space).
   */
  function node(TSL, { centerXY, time, exposure }) {
    return sampleWind(TSL, {
      centerXY,
      time,
      exposure,
      wind: ambientRef,
      bakedField: bakedFieldRef,
      wallAvoidField: wallAvoidFieldRef,
      liveField: liveFieldRef,
    });
  }

  /**
   * THE COMPUTE-KERNEL SHAPE — same field, fetched from a storage buffer.
   *
   * Returns the field DECOMPOSED rather than summed, deliberately: the two
   * kernels that consume it compose the parts DIFFERENTLY and both are right
   * to. `particle-runtime.js` gates the coherent term by its own `coherentGate`
   * while BOOSTING the chaotic term in the opposite direction (a sheltered spot
   * should feel like wandering air, not a quiet breeze); `gust-runtime.js`
   * applies its outdoor gale boost to the coherent term ONLY, never to chaos.
   * Handing back one pre-summed vector would silently delete both behaviours,
   * so this returns parts and lets each caller assemble.
   *
   * Each part is built LAZILY (a memoized getter) — `organic` alone costs ~13
   * noise evaluations, and the two callers want different subsets. Touching
   * only what you use is the difference between a free abstraction and a tax.
   *
   * @param {*} TSL - THREE.TSL.
   * @param {object} args
   * @param {*} args.centerXY - vec2 node, the world position (a particle's own).
   * @param {*} args.time - the shared clock node (ms).
   * @param {*} [args.cellBuffer] - the storage buffer node holding {@link
   *   WindCellArrays}, {@link WIND_CELL_VEC4_STRIDE} vec4s per cell — see
   *   {@link packWindCells} for the exact layout. Omitted → the whole lookup is
   *   skipped and the field reads fully open, with no wall nearby and no
   *   shadow, which is the same "no geometry data ⇒ behave like the open
   *   outdoors" convention `sampleWind` itself uses.
   * @returns {object} `{ openness, wallAwayDirX, wallAwayDirY, wallProximity,
   *   coherent, turbulence, organic }`. `coherent` is the ambient bias
   *   DEFLECTED off nearby walls but NOT yet gated by openness — gating is the
   *   caller's, for the reason above. `organic` is `sampleWind` WITHOUT its
   *   ambient term (drift + flutter + turbulence); `turbulence` is the swirl
   *   alone. Ask for one or the other, not both — `organic` already contains
   *   `turbulence`.
   */
  function kernel(TSL, { centerXY, time, cellBuffer }) {
    const { float, vec2, int } = TSL;

    // --- THE CELL LOOKUP, owned once ---------------------------------------
    // Was duplicated verbatim in both kernels (nearest-cell, floor+clamp, one
    // packed vec4). Reads the handle's OWN grid spec, so a regrid can never
    // leave one kernel indexing at the old cell size.
    let openness = float(1);
    let wallAwayDirX = float(0);
    let wallAwayDirY = float(0);
    let wallProximity = float(0);
    let windShadow = float(0);
    if (cellBuffer && grid) {
      const cx = centerXY.x
        .sub(float(grid.originX))
        .div(float(grid.cellSize))
        .floor()
        .clamp(float(0), float(grid.cols - 1));
      const cy = centerXY.y
        .sub(float(grid.originY))
        .div(float(grid.cellSize))
        .floor()
        .clamp(float(0), float(grid.rows - 1));
      // TWO vec4s per cell — see WIND_CELL_VEC4_STRIDE. The base index is built
      // in FLOAT and converted once per element read (the same shape this line
      // always had), rather than doing integer arithmetic on an int node, which
      // is not uniformly supported across the two backends.
      const flatIndex = cy.mul(float(grid.cols)).add(cx).mul(float(WIND_CELL_VEC4_STRIDE));
      const cell = cellBuffer.element(int(flatIndex));
      openness = cell.x;
      wallAwayDirX = cell.y;
      wallAwayDirY = cell.z;
      wallProximity = cell.w;
      windShadow = cellBuffer.element(int(flatIndex.add(float(1)))).x;
    }

    const memo = {};
    const once = (key, build) => (key in memo ? memo[key] : (memo[key] = build()));

    /**
     * THE GUST ENVELOPE, resolved ONCE for this kernel (2026-08-15) — three of
     * the four things below need it (`coherent` scales by it, `turbulence` and
     * `organic` cap against it), and it is four noise-ish ops. Memoized through
     * the SAME `once` the parts use, so a kernel that touches only `organic`
     * still pays for it exactly once and a kernel that touches none pays
     * nothing.
     *
     * `undefined` — never a `float(1)` — when there is no gustiness to read, so
     * every consumer below can branch at JS time and emit the identical graph
     * it emitted before this existed (`tsl/no-uniform-gates`).
     */
    const gustEnvelope = () =>
      ambientRef && ambientRef.gustiness01 !== undefined
        ? once('gust', () =>
            computeGustEnvelope(TSL, {
              centerXY,
              time,
              directionDeg: ambientRef.directionDeg,
              gustiness01: ambientRef.gustiness01,
              // Kept in step with `sampleWind`'s own call by the node↔kernel
              // parity test — omitting this here would have particles gusting on
              // a calm-weather rate while every material around them followed
              // the wind.
              speed01: ambientRef.speed01,
            })
          )
        : undefined;

    /** The wind speed the turbulence cap measures against — GUSTED, matching
     *  `sampleWind`'s own `cappedSpeed01`. See that function's "THE CAP GUSTS
     *  WITH THE WIND" note for why the un-gusted dial is the wrong ceiling. */
    const cappedSpeed01 = () => {
      if (!ambientRef) return undefined;
      const g = gustEnvelope();
      return g === undefined ? ambientRef.speed01 : ambientRef.speed01.mul(g);
    };

    return {
      openness,
      wallAwayDirX,
      wallAwayDirY,
      wallProximity,
      /**
       * The ambient bias, deflected off nearby walls and attenuated by the wind
       * shadow, UNGATED by openness. The angle convention is METEOROLOGICAL
       * (the direction the wind blows FROM, hence the negate) — the same one
       * `sampleWind` and `world/wind-bake.js#ambientVectorFromWind` use. It
       * exists here exactly ONCE now; the two kernels used to each carry their
       * own copy of this arithmetic, guaranteed to match only by a comment
       * saying so.
       *
       * THE SHADOW IS APPLIED HERE, NOT HANDED BACK SEPARATELY (2026-08-01).
       * Openness gating is deliberately the caller's (the two kernels compose
       * it differently and both are right to), but a shadow term returned as
       * its own field would be one every caller had to remember to multiply in
       * — and this project has watched an unconsumed API rot silently before.
       * It is part of "how much directional wind is actually here", so it rides
       * with the term it modifies. Kept in step with `sampleWind`'s own
       * application by the node↔kernel parity test.
       */
      get coherent() {
        return once('coherent', () => {
          if (!ambientRef) return vec2(0, 0);
          let bias = windFlowVectorNode(TSL, ambientRef.directionDeg).mul(ambientRef.speed01);
          // THE GUST ENVELOPE (2026-08-15) — the kernel's own copy of
          // `sampleWind`'s identical step, in the identical PLACE in the chain
          // (raw bias → gust → deflect → shadow). Both are held to that by the
          // node↔kernel parity test, which is exactly why this term could not
          // simply be left out of the compute path "for now": particles and
          // gust ribbons would have gone on riding a wind that never gusted
          // while every material around them did, and the test would have said
          // so immediately. See `computeGustEnvelope`'s own header.
          const gust = gustEnvelope();
          if (gust !== undefined) bias = bias.mul(gust);
          const deflected = deflectAroundWalls(TSL, {
            vector: bias,
            awayDirX: wallAwayDirX,
            awayDirY: wallAwayDirY,
            proximity: wallProximity,
          });
          return deflected.mul(float(1).sub(windShadow.mul(float(WIND_SHADOW_DEPTH))));
        });
      },
      /** The curl-noise swirl alone (no drift/flutter, no ambient). */
      get turbulence() {
        return once('turbulence', () =>
          computeWindTurbulence(TSL, {
            centerXY,
            time,
            // This kernel's own real per-cell openness, passed for BOTH slots:
            // there is no spare storage-buffer channel here for a genuine third
            // `exteriorOpenness` signal (both kernels sit at or near the WebGPU
            // 8-storage-buffer-per-stage limit). See `computeWindTurbulence`'s
            // own param doc for why that reuse is not a shortcut — it produces
            // a curve that is calm when sealed, PEAKS at the doorway
            // transition, and settles to the outdoor baseline once genuinely
            // open, which is the shape actually wanted.
            openness,
            exteriorOpenness: openness,
            windSpeed01: cappedSpeed01(),
          })
        );
      },
      /**
       * `sampleWind` WITHOUT its ambient term — the organic drift + flutter
       * (damped by `openness` as its `exposure`) plus turbulence. Callers that
       * want the ambient too must take `coherent` and gate it themselves; that
       * split is the whole point of this shape.
       */
      get organic() {
        return once('organic', () =>
          sampleWind(TSL, {
            centerXY,
            time,
            exposure: openness,
            openness,
            exteriorOpenness: openness,
            windSpeed01: cappedSpeed01(),
          })
        );
      },
    };
  }

  /**
   * THE CPU SHAPE — plain numbers, for questions asked before any shader
   * exists (where to place something, how sheltered a spot is, what a probe
   * should report). Never throws: an un-baked handle answers "fully open",
   * the same convention the GPU shapes use, so a caller polling this during
   * startup gets a usable answer rather than an exception.
   *
   * @param {number} x @param {number} y - world position.
   * @returns {{exposure: number, openness: number, solid: boolean, inGrid: boolean}}
   */
  function cpuAt(x, y) {
    const exposure = cpuExposureAt ? clamp01(cpuExposureAt(x, y)) : 1;
    if (!grid || !cells) return { exposure, openness: 1, solid: false, inGrid: false };
    const cx = Math.floor((x - grid.originX) / grid.cellSize);
    const cy = Math.floor((y - grid.originY) / grid.cellSize);
    const inGrid = cx >= 0 && cy >= 0 && cx < grid.cols && cy < grid.rows;
    const i = clampInt(cy, 0, grid.rows - 1) * grid.cols + clampInt(cx, 0, grid.cols - 1);
    return {
      exposure,
      openness: cells.openness ? clamp01(Number(cells.openness[i] ?? 1)) : 1,
      solid: cells.solid ? !!cells.solid[i] : false,
      inGrid,
    };
  }

  return Object.freeze({
    version,
    /** True once a real bake has happened — before that every shape answers "open outdoors". */
    hasBake: !!bakedFieldRef,
    /**
     * The live ambient uniform NODES (`{directionDeg, speed01}`), or null in a
     * windless scene. Exposed because a consumer legitimately needs the raw
     * PREVAILING STRENGTH for its own scaling — the gust ribbons derive their
     * speed ceiling and active-trail count from it — which is a different
     * question from "what is the wind vector here". Reading these is fine;
     * re-deriving a wind vector from them by hand is what `wind/handle-only`
     * exists to stop.
     */
    ambient: ambientRef ?? null,
    /** @type {WindGridSpec|null} the grid every shape agrees on (Tier 2 + diagnostics read this). */
    grid: grid ? Object.freeze(gridOf(grid)) : null,
    /** @type {WindCellArrays|null} raw arrays, for whoever uploads the storage buffer. */
    cells,
    /**
     * D_rest's own texture — Tier 2's advect pass transports ON the resting
     * field, so the sim (itself part of the wind system, not a consumer of it)
     * legitimately needs the texture rather than a sample of it. Deliberately
     * NOT named `bakedField`: this is the sim's internal input, not the
     * consumer-facing shape, and conflating them is how the two would drift.
     */
    restFieldTexture: opennessTexture ?? null,
    node,
    kernel,
    cpuAt,
  });
}

/**
 * HOW MANY `vec4`s ONE CELL OCCUPIES in the compute kernels' storage buffer.
 *
 * WAS 1, WIDENED TO 2 (2026-08-01) when the wind shadow needed a home and all
 * four original slots were already spoken for (x=openness, y/z=wall-away
 * direction, w=wall-proximity). The alternatives were both worse: a SECOND
 * storage buffer would spend one of the WebGPU 8-per-stage slots that both
 * kernels are already close to (keyhole-storage-buffer-limit-fix), and folding
 * the shadow into `openness` would pack two different quantities into one
 * number — this project's own "one byte, two quantities" failure, which cannot
 * be tuned back out afterwards.
 *
 * Widening costs buffer MEMORY (2× — ~8 MB at the 512×512 worst-case grid) but
 * no buffer COUNT, which is the constraint that actually bites. Slots 5-7 are
 * free; `computeWindTurbulence`'s own docs already record wanting one of them
 * for a genuine `exteriorOpenness` (it currently passes `openness` twice).
 *
 * ⚠️ EVERY allocator of this buffer must multiply by this — `TSL.instancedArray(
 * n * WIND_CELL_VEC4_STRIDE, 'vec4')`. Both particle runtimes do.
 */
export const WIND_CELL_VEC4_STRIDE = 2;

/**
 * Pack a handle's cell arrays into the storage-buffer layout BOTH compute
 * kernels use, in place. Lives here, next to the `kernel()` shape that READS
 * that layout, so the writer and the reader of the packing can never drift —
 * they used to be two hand-written copies in two files, agreeing by
 * coincidence.
 *
 * Layout, {@link WIND_CELL_VEC4_STRIDE} vec4s per cell:
 *
 *     vec4 0: x=openness  y=wallAwayDirX  z=wallAwayDirY  w=wallProximity
 *     vec4 1: x=windShadow  y/z/w=reserved (written as 0)
 *
 * `?? 1` / `?? 0` — a missing sample defaults to "fully open" / "no wall
 * nearby" / "no shadow", never a silent "everything is sealed" or an invented
 * deflection.
 *
 * @param {{array: Float32Array, needsUpdate: boolean}} attr - the buffer's own attribute.
 * @param {WindCellArrays} cells
 * @param {number} n - cell count (cols × rows).
 */
export function packWindCells(attr, cells, n) {
  const { openness, wallAvoidDirX, wallAvoidDirY, wallProximity, windShadow } = cells ?? {};
  const stride = WIND_CELL_VEC4_STRIDE * 4;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    attr.array[o + 0] = openness?.[i] ?? 1;
    attr.array[o + 1] = wallAvoidDirX?.[i] ?? 0;
    attr.array[o + 2] = wallAvoidDirY?.[i] ?? 0;
    attr.array[o + 3] = wallProximity?.[i] ?? 0;
    attr.array[o + 4] = windShadow?.[i] ?? 0;
    // Slots 5-7 are RESERVED, explicitly zeroed rather than left as whatever
    // the allocation happened to contain — an undefined value read by a future
    // consumer is a bug that only shows up on one backend.
    attr.array[o + 5] = 0;
    attr.array[o + 6] = 0;
    attr.array[o + 7] = 0;
  }
  attr.needsUpdate = true;
}

/** Grid spec, copied field-by-field so a handle can never alias a caller's mutable object. */
function gridOf(g) {
  return { originX: g.originX, originY: g.originY, cellSize: g.cellSize, cols: g.cols, rows: g.rows };
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v | 0));
}
