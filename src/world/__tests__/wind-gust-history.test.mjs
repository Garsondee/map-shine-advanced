/**
 * wind-gust-history.test.mjs — the wind's recorded past (2026-10-27, epic mmp-fpu).
 *
 * The candle's memory used to be 14 evaluations of the gust envelope inside each candle shader (~5.5 s of
 * compile apiece on the author's card). It is now 14 texture fetches from a ring the baker fills as the moments
 * happen. This pins the three things that could make that swap wrong without anyone noticing:
 *
 *   1. THE SCHEDULER records exactly the moments a consumer can read — all of them on the first frame or after
 *      a clock jump, one at a boundary, none in between and none while the world is held — and never lets the
 *      ring overwrite a moment that is still inside the look-back.
 *   2. THE MAPPING from (position, moment) to an atlas texel lands on the right tile and never bleeds across a
 *      tile's edge.
 *   3. THE SWAP IS INVISIBLE: given the same past, the candle state built from the recorded history equals the one
 *      built from the analytic ladder — the same `alive01` at every moment — while containing no noise at all.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import {
  GUST_HISTORY_STEP_S,
  GUST_HISTORY_TAPS,
  GUST_HISTORY_TILES,
  GUST_HISTORY_SLOTS,
  gustHistorySlotFor,
  gustHistoryTileOf,
  gustHistoryAtlasSize,
  gustHistoryMomentAt,
  planGustHistoryBakes,
  sampleGustHistoryTap,
} from '../wind-gust-history.js';
import { createWindHandle } from '../wind-access.js';
import { createWindAdvectionUniforms } from '../wind-field.js';
import { TSL_STUB as S, values } from './tsl-numeric-stub.mjs';
import { census, censusMaterial } from '../../core/__tests__/tsl-census.mjs';
import {
  buildCandleWindState,
  scaleCandleHistory,
  CANDLE_HISTORY_STEP_S,
  CANDLE_HISTORY_TAPS,
} from '../../effects/candle-wind-state.js';

const T = THREE.TSL;
const GRID = { originX: 100, originY: -50, cellSize: 25, cols: 8, rows: 4 };

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  // ── 0. ONE SET OF NUMBERS ────────────────────────────────────────────────
  ok(
    'the candle ladder and the recorded history agree on the step and the tap count',
    GUST_HISTORY_STEP_S === CANDLE_HISTORY_STEP_S && GUST_HISTORY_TAPS === CANDLE_HISTORY_TAPS
  );
  ok(
    'the ring is larger than the look-back, so a readable moment is never overwritten',
    GUST_HISTORY_SLOTS > GUST_HISTORY_TAPS
  );
  ok('the atlas is a 4×4 grid of tiles', GUST_HISTORY_TILES === 4 && GUST_HISTORY_SLOTS === 16);

  // ── 1. THE SCHEDULER ─────────────────────────────────────────────────────
  {
    ok(
      'moment indices change exactly at the step boundary',
      gustHistoryMomentAt(599.9) === 0 && gustHistoryMomentAt(600) === 1 && gustHistoryMomentAt(1199) === 1
    );
    ok('a non-finite clock reads as moment 0', gustHistoryMomentAt(NaN) === 0);

    const first = planGustHistoryBakes({ lastMoment: null }, 60_000);
    ok('the first frame records the whole look-back', first.bakes.length === GUST_HISTORY_TAPS && first.moment === 100);
    ok(
      '...oldest first, ending on the latest',
      first.bakes[0].moment === 100 - (GUST_HISTORY_TAPS - 1) && first.bakes.at(-1).moment === 100
    );
    ok(
      'each recorded moment carries the time it describes, not the time it was recorded',
      first.bakes.every((b) => near(b.timeMs, b.moment * 600))
    );
    ok(
      'the look-back occupies 14 DISTINCT ring slots',
      new Set(first.bakes.map((b) => b.slot)).size === GUST_HISTORY_TAPS
    );

    const same = planGustHistoryBakes(first.state, 60_400);
    ok('within the same step nothing is recorded', same.bakes.length === 0 && same.moment === 100);
    const next = planGustHistoryBakes(same.state, 60_000 + 600);
    ok('crossing a boundary records exactly one moment', next.bakes.length === 1 && next.bakes[0].moment === 101);
    const paused = planGustHistoryBakes(next.state, 60_600);
    ok('a held clock (paused world) records nothing, however many frames pass', paused.bakes.length === 0);

    const stalled = planGustHistoryBakes(next.state, 60_600 + 90_000);
    ok(
      'a long stall records at most the look-back (older moments could not be read anyway)',
      stalled.bakes.length === GUST_HISTORY_TAPS
    );
    const skipped = planGustHistoryBakes(next.state, 60_600 + 3 * 600);
    ok('a few skipped frames catch up in order', skipped.bakes.map((b) => b.moment).join() === '102,103,104');

    const rewound = planGustHistoryBakes(next.state, 5_000);
    ok(
      'a clock that jumped BACK re-records the look-back, so no slot holds a stale future',
      rewound.bakes.length === GUST_HISTORY_TAPS
    );
    const young = planGustHistoryBakes({ lastMoment: null }, 1_000);
    ok(
      'a world younger than the look-back records negative moments into valid slots',
      young.bakes.every((b) => b.slot >= 0 && b.slot < GUST_HISTORY_SLOTS)
    );

    // The ring never overwrites a moment a consumer can still read: moments g and g-k for k < TAPS never share a slot.
    let collides = false;
    for (let g = -40; g < 40; g++) {
      for (let k = 1; k < GUST_HISTORY_TAPS; k++)
        if (gustHistorySlotFor(g) === gustHistorySlotFor(g - k)) collides = true;
    }
    ok('no two moments inside one look-back share a slot', !collides);
  }

  // ── 2. THE MAPPING ───────────────────────────────────────────────────────
  {
    const tiles = new Set();
    for (let s = 0; s < GUST_HISTORY_SLOTS; s++) {
      const { tx, ty } = gustHistoryTileOf(s);
      tiles.add(`${tx},${ty}`);
    }
    ok('the 16 slots occupy 16 distinct tiles of the 4×4 atlas', tiles.size === 16);
    ok(
      'slot 5 is column 1, row 1; slot 15 is the bottom-right tile',
      gustHistoryTileOf(5).tx === 1 &&
        gustHistoryTileOf(5).ty === 1 &&
        gustHistoryTileOf(15).tx === 3 &&
        gustHistoryTileOf(15).ty === 3
    );
    ok(
      'slots wrap and tolerate negatives',
      gustHistoryTileOf(16).tx === 0 && gustHistoryTileOf(-1).tx === 3 && gustHistorySlotFor(-1) === 15
    );
    const size = gustHistoryAtlasSize(512, 512);
    ok(
      "at the 512-cell grid cap the atlas is exactly the allocator's 2048 px limit",
      size.width === 2048 && size.height === 2048
    );

    // Two stub atlases that answer with their own coordinates — one with u, one with v — so where a read
    // lands is the number it returns (a tap is a single float: one coordinate per atlas).
    const atlasU = { sample: (u) => [u * 1000, 0, 0, 1] };
    const atlasV = { sample: (u, v) => [v * 1000, 0, 0, 1] };
    const cellCentre = (c, r) =>
      S.vec2(GRID.originX + (c + 0.5) * GRID.cellSize, GRID.originY + (r + 0.5) * GRID.cellSize);
    const tapOf = (atlas, slot, centerXY) =>
      values(sampleGustHistoryTap(S, { texture: atlas, grid: GRID, centerXY, momentIndex: S.float(slot) }))[0];
    const u = tapOf(atlasU, 6, cellCentre(3, 2)); // slot 6 → tile (2, 1)
    const v = tapOf(atlasV, 6, cellCentre(3, 2));
    ok(
      'a tap lands in the right tile and the right texel within it',
      near(u, ((2 + 3.5 / 8) / 4) * 1000, 1e-6) && near(v, ((1 + 2.5 / 4) / 4) * 1000, 1e-6)
    );
    const farOut = S.vec2(GRID.originX + GRID.cols * GRID.cellSize + 999, GRID.originY);
    const ue = tapOf(atlasU, 0, farOut);
    ok(
      'a position past the grid edge reads inside its own tile — it cannot bleed into the next',
      ue < 1000 / 4 && ue > ((1 - 1 / 8) / 4) * 1000 - 1e-6
    );
    const uNeg = tapOf(atlasU, -1, cellCentre(0, 0)); // moment -1 → slot 15 → tile (3, 3)
    ok('a negative moment index resolves to the last slot, not NaN', Number.isFinite(uNeg) && uNeg > 0.75 * 1000);
  }

  // ── 3. THE HANDLE ────────────────────────────────────────────────────────
  {
    const ambient = {
      directionDeg: T.uniform(T.float(90)),
      speed01: T.uniform(T.float(0.3)),
      gustiness01: T.uniform(T.float(1)),
      pixelsPerMetre: T.uniform(T.float(65.6)),
      advection: createWindAdvectionUniforms(T),
    };
    const tex = () => {
      const d = new THREE.DataTexture(
        new Uint16Array(GRID.cols * GRID.rows * 4),
        GRID.cols,
        GRID.rows,
        THREE.RGBAFormat,
        THREE.HalfFloatType
      );
      d.needsUpdate = true;
      return d;
    };
    const atlasTex = new THREE.DataTexture(
      new Uint16Array(4 * GRID.cols * 4 * GRID.rows),
      4 * GRID.cols,
      4 * GRID.rows,
      THREE.RedFormat,
      THREE.HalfFloatType
    );
    atlasTex.needsUpdate = true;
    const gridIndex = T.uniform(T.float(100));
    const make = (extra = {}) =>
      createWindHandle({
        version: 1,
        ambientWind: ambient,
        grid: GRID,
        opennessTexture: tex(),
        wallAvoidTexture: tex(),
        liveTexture: tex(),
        ...extra,
      });
    const centerXY = T.vec2(T.float(300), T.float(20));

    const withHistory = make({ gustHistoryTexture: atlasTex, gustHistoryGridIndex: gridIndex });
    ok(
      "a handle given the atlas and the baker's index says it records a history",
      withHistory.hasGustHistory === true && withHistory.gustHistoryTexture === atlasTex
    );
    const h = withHistory.gustHistory(T, { centerXY });
    ok(
      '...and hands out taps, the index and the step',
      typeof h.tap === 'function' &&
        h.gridIndex === gridIndex &&
        h.stepSec === GUST_HISTORY_STEP_S &&
        h.taps === GUST_HISTORY_TAPS
    );

    ok(
      'a handle with no atlas records none (the caller keeps the analytic ladder)',
      make().gustHistory(T, { centerXY }) === null && make().hasGustHistory === false
    );
    ok(
      '...nor one given an atlas but no baker index',
      make({ gustHistoryTexture: atlasTex }).gustHistory(T, { centerXY }) === null
    );
    ok('...nor a bake-less, ambient-less handle', createWindHandle().gustHistory(T, { centerXY }) === null);

    const taps = Array.from({ length: GUST_HISTORY_TAPS }, (_, k) => h.tap(k));
    const readCost = census(...taps);
    const analyticCost = census(
      ...Array.from({ length: GUST_HISTORY_TAPS }, (_, k) =>
        withHistory.gustMagnitudeAt(T, { centerXY })(T.float(k * 600))
      )
    );
    ok(
      `14 recorded taps contain NO noise (the analytic ladder: ${analyticCost.noise})`,
      readCost.noise === 0 && analyticCost.noise >= GUST_HISTORY_TAPS * 2
    );
    ok(`...and read one texture, not fourteen (${readCost.textures})`, readCost.textures === 1);

    const built = withHistory.buildGustHistoryBake(THREE);
    ok(
      'the handle builds the bake pass: the real gust magnitude over the grid',
      !!built?.material && !!built?.uBakeTimeMs && built.material.name === 'wind.gust.history.bake'
    );
    ok(
      "...which carries the gust envelope's noise (the one place it still lives)",
      censusMaterial(built.material).noise >= 2
    );
    ok(
      'a handle with nothing to record cannot build the pass',
      createWindHandle().buildGustHistoryBake(THREE) === null
    );
  }

  // ── 4. THE SWAP IS INVISIBLE ─────────────────────────────────────────────
  // A fake wind with a known past: calm, a strong gust from 10.0 s to 11.2 s, a weaker one from 14.0 to 14.6 s.
  {
    const magOf = (sec) => (sec >= 10 && sec <= 11.2 ? 0.5 : sec >= 14 && sec <= 14.6 ? 0.3 : 0.02);
    const STEP = GUST_HISTORY_STEP_S;
    const stateAt = (tSec, mode) => {
      const timeMs = S.float(tSec * 1000);
      const moment = Math.floor((tSec * 1000) / (STEP * 1000));
      const common = { magNow: S.float(magOf(tSec)), timeMs, seed: S.float(0.3), memory: true };
      const analytic = {
        // the OLD ladder: a function of absolute time
        magAt: (timeMsNode) => S.float(magOf(values(timeMsNode)[0] / 1000)),
      };
      const recorded = {
        // the NEW ladder: the baker recorded each moment as it passed
        history: {
          gridIndex: S.float(moment),
          stepSec: STEP,
          taps: GUST_HISTORY_TAPS,
          tap: (k) => S.float(magOf((moment - k) * STEP)),
        },
      };
      return buildCandleWindState(S, { ...common, ...(mode === 'recorded' ? recorded : analytic) });
    };
    let worst = 0;
    let sawSnuff = false;
    for (let tSec = 8; tSec < 24; tSec += 0.17) {
      const a = values(stateAt(tSec, 'analytic').alive01)[0];
      const r = values(stateAt(tSec, 'recorded').alive01)[0];
      worst = Math.max(worst, Math.abs(a - r));
      if (a < 0.5) sawSnuff = true;
    }
    ok('(sanity) the fake past really snuffs the candle', sawSnuff);
    ok(
      `the recorded history gives the analytic ladder's alive01 at every sampled moment (worst Δ ${worst.toExponential(1)})`,
      worst < 1e-9
    );

    // The candle's own wind response multiplies every tap before it meets the snuff threshold.
    const scaled = scaleCandleHistory(
      { tap: (k) => S.float(0.1 * (k + 1)), gridIndex: S.float(5), stepSec: STEP },
      S.float(2)
    );
    ok(
      'scaleCandleHistory folds the response into each tap',
      near(values(scaled.tap(2))[0], 0.6) && scaled.stepSec === STEP
    );
    ok('...and passes nothing through when there is no history', scaleCandleHistory(null, S.float(2)) === undefined);

    // The point of it, on real TSL: the shader's noise falls to the candle's own two struggle octaves.
    const history = {
      gridIndex: T.uniform(T.float(100)),
      stepSec: STEP,
      taps: GUST_HISTORY_TAPS,
      tap: (k) => T.float(0.1).add(T.float(k * 0.01)),
    };
    const args = { magNow: T.float(0.2), timeMs: T.uniform(T.float(5000)), seed: T.float(0.5) };
    const fromHistory = census(...Object.values(buildCandleWindState(T, { ...args, history, memory: true })));
    const fromLadder = census(
      ...Object.values(
        buildCandleWindState(T, { ...args, magAt: (tm) => T.mx_noise_float(T.vec2(tm, T.float(0))), memory: true })
      )
    );
    const forgetful = census(...Object.values(buildCandleWindState(T, { ...args, history, memory: false })));
    ok(
      `recorded memory leaves only the struggle's noise (${fromHistory.noise}); the analytic ladder carries ${fromLadder.noise}`,
      fromHistory.noise === 2 && fromLadder.noise === 2 + GUST_HISTORY_TAPS
    );
    ok('memory off builds no ladder of either kind', forgetful.noise === 2 && forgetful.unique < fromHistory.unique);
  }
}
