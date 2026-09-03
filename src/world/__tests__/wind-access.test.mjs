/**
 * wind-access.test.mjs — THE WIND HANDLE, and the parity claim it makes.
 *
 * The load-bearing test here is `node ↔ kernel parity`: `world/wind-access.js`
 * offers two GPU shapes over ONE field (a texture sample for materials, a
 * storage-buffer lookup for compute kernels), and the ONLY thing that used to
 * guarantee they agreed was a source comment saying the kernels "replicate
 * sampleWind's own ambient-bias formula byte-for-byte". Both particle kernels
 * carried their own hand-written copy of that arithmetic. This asserts it
 * instead of promising it.
 *
 * Read `tsl-numeric-stub.mjs`'s own header for exactly what a green run here
 * does and does not prove — in short: it proves the two PATHS agree, not that
 * the GPU produces any particular number.
 */
import { createWindHandle } from '../wind-access.js';
import { TSL_STUB as T, values, storageBuffer, gridTexture } from './tsl-numeric-stub.mjs';

const GRID = { originX: -100, originY: -50, cellSize: 25, cols: 8, rows: 6 };
const CELLS = GRID.cols * GRID.rows;

/** A deliberately non-uniform field: openness varies, some cells are sealed, walls near the left edge. */
function makeCells() {
  const openness = new Float32Array(CELLS);
  const wallAvoidDirX = new Float32Array(CELLS);
  const wallAvoidDirY = new Float32Array(CELLS);
  const wallProximity = new Float32Array(CELLS);
  const windShadow = new Float32Array(CELLS);
  const solid = new Uint8Array(CELLS);
  for (let y = 0; y < GRID.rows; y++) {
    for (let x = 0; x < GRID.cols; x++) {
      const i = y * GRID.cols + x;
      openness[i] = x < 2 ? 0 : Math.min(1, (x - 1) / 4);
      solid[i] = x === 2 && y > 2 ? 1 : 0;
      // A wall face along x=2: "away" points +X, proximity falls off eastward.
      wallProximity[i] = Math.max(0, 1 - Math.abs(x - 2) / 3);
      wallAvoidDirX[i] = wallProximity[i] > 0 ? 1 : 0;
      wallAvoidDirY[i] = 0;
      // A non-uniform, deliberately NON-ZERO shadow that does not correlate with
      // openness or proximity — a field that happened to be zero everywhere
      // would let the two paths agree while both ignored it entirely.
      windShadow[i] = ((x * 3 + y * 5) % 7) / 7;
    }
  }
  return { openness, wallAvoidDirX, wallAvoidDirY, wallProximity, windShadow, solid };
}

/**
 * The same cells, packed the way both compute kernels pack their storage buffer
 * — WIND_CELL_VEC4_STRIDE vec4s per cell. Mirrors `packWindCells`' own layout;
 * a drift between the two shows up as a parity failure, which is the point.
 */
function packVec4(cells) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    out.push([cells.openness[i], cells.wallAvoidDirX[i], cells.wallAvoidDirY[i], cells.wallProximity[i]]);
    out.push([cells.windShadow[i], 0, 0, 0]);
  }
  return out;
}

function makeHandle(cells, { ambient = true, speed01 = 0.6 } = {}) {
  return createWindHandle({
    version: 7,
    ambientWind: ambient ? { directionDeg: T.float(135), speed01: T.float(speed01) } : null,
    grid: GRID,
    // B = openness, A = exteriorOpenness — the real channel contract.
    opennessTexture: gridTexture(GRID, (i) => [0, 0, cells.openness[i], cells.openness[i]]),
    // R/G = wall-away direction, B = proximity, A = the wind shadow. A was a
    // constant 1 here until 2026-08-01, when the shadow claimed that channel;
    // the node path MUST read the same per-cell value the kernel's buffer
    // carries or the parity test is comparing two different fields.
    wallAvoidTexture: gridTexture(GRID, (i) => [
      cells.wallAvoidDirX[i],
      cells.wallAvoidDirY[i],
      cells.wallProximity[i],
      cells.windShadow[i],
    ]),
    cells,
    cpuExposureAt: (x) => (x < 0 ? 0 : 1),
  });
}

/** World position at the CENTRE of cell (cx, cy) — no bilinear ambiguity. */
function cellCentre(cx, cy) {
  return [GRID.originX + (cx + 0.5) * GRID.cellSize, GRID.originY + (cy + 0.5) * GRID.cellSize];
}

export function run(t) {
  const { ok } = t;
  const cells = makeCells();
  const buffer = storageBuffer(packVec4(cells));

  // --- the handle is frozen, versioned, and honest about having a bake ------
  {
    const h = makeHandle(cells);
    ok('handle is frozen (a rebake makes a NEW one, never mutates)', Object.isFrozen(h));
    ok('handle carries its version', h.version === 7);
    ok('handle reports hasBake when a texture was supplied', h.hasBake === true);
    ok('handle copies the grid rather than aliasing the caller’s object', h.grid !== GRID && h.grid.cols === 8);
    const bare = createWindHandle();
    ok('an un-baked handle is still usable and says so', bare.hasBake === false && bare.grid === null);
  }

  // --- ⭐ WIND 0 IS EXACTLY ZERO (Stage 1, mythica-machina-press#498) --------
  // The acceptance criterion, evaluated through the REAL graph rather than by
  // reading the source and reasoning about it. Before this, the organic
  // drift/flutter term was scaled by `exposure` ALONE and never referenced
  // `speed01`, so a dead calm still produced motion of raw magnitude ~0..1.4
  // at every exposed cell — the author's *"0 wind is not no wind"*.
  //
  // "Exactly" is meant literally: `=== 0`, not "small". A tolerance here would
  // pass just as happily on a residual floor, which is precisely the thing
  // being removed.
  {
    const calm = makeHandle(cells, { speed01: 0 });
    let worstCalm = 0;
    let sampled = 0;
    for (let cy = 0; cy < GRID.rows; cy++) {
      for (let cx = 0; cx < GRID.cols; cx++) {
        const [wx, wy] = cellCentre(cx, cy);
        // Sample at FULL exposure — the outdoor case, where the old floor was
        // at its strongest and any surviving term would show up largest.
        const v = values(calm.node(T, { centerXY: T.vec2(wx, wy), time: T.float(4321), exposure: T.float(1) }));
        worstCalm = Math.max(worstCalm, Math.abs(v[0]), Math.abs(v[1]));
        sampled++;
      }
    }
    ok(`⭐ at speed01=0 the field is exactly zero at all ${sampled} cells (worst |v| ${worstCalm})`, worstCalm === 0);

    // Sampled across TIME too — the organic term is time-varying, so a single
    // instant could be zero by coincidence of where the noise happened to sit.
    let worstOverTime = 0;
    for (let ms = 0; ms < 20000; ms += 977) {
      const v = values(calm.node(T, { centerXY: T.vec2(12, -7), time: T.float(ms), exposure: T.float(1) }));
      worstOverTime = Math.max(worstOverTime, Math.abs(v[0]), Math.abs(v[1]));
    }
    ok('⭐ ...and stays exactly zero across a 20s sweep, not just at one instant', worstOverTime === 0);

    // ⚠️ THE NEGATIVE CONTROL. Without it this block would pass just as happily
    // if the field had been broken to zero at every speed, which is the one
    // failure a "wind 0 is zero" test cannot otherwise distinguish from success.
    const blowing = makeHandle(cells, { speed01: 1 });
    let strongest = 0;
    for (let cy = 0; cy < GRID.rows; cy++) {
      for (let cx = 0; cx < GRID.cols; cx++) {
        const [wx, wy] = cellCentre(cx, cy);
        const v = values(blowing.node(T, { centerXY: T.vec2(wx, wy), time: T.float(4321), exposure: T.float(1) }));
        strongest = Math.max(strongest, Math.hypot(v[0], v[1]));
      }
    }
    ok(`the same field at speed01=1 is emphatically NOT zero (max |v| ${strongest.toFixed(3)})`, strongest > 0.1);
  }

  // --- THE PARITY TEST: node() and kernel() agree on the coherent term ------
  // The coherent (ambient × wall-deflection) term is the one both paths compute
  // independently — the texture path inside sampleWind, the buffer path inside
  // kernel(). It is also the one that was only ever guaranteed by a comment.
  {
    const h = makeHandle(cells);
    let worst = 0;
    let checked = 0;
    for (let cy = 0; cy < GRID.rows; cy++) {
      for (let cx = 0; cx < GRID.cols; cx++) {
        const [wx, wy] = cellCentre(cx, cy);
        const i = cy * GRID.cols + cx;
        const pos = T.vec2(wx, wy);

        // KERNEL path: coherent is returned ungated; gate it by openness the
        // way every kernel caller does, to match what sampleWind folds in.
        const k = h.kernel(T, { centerXY: pos, time: T.float(1234), cellBuffer: buffer });
        const kCoherent = values(k.coherent.mul(k.openness));

        // NODE path: sampleWind's total minus its organic term isolates the
        // same coherent contribution (organic is computed identically in both,
        // from the same openness, so it cancels exactly).
        const total = values(h.node(T, { centerXY: pos, time: T.float(1234), exposure: k.openness }));
        const organic = values(k.organic);
        const nCoherent = [total[0] - organic[0], total[1] - organic[1]];

        worst = Math.max(worst, Math.abs(kCoherent[0] - nCoherent[0]), Math.abs(kCoherent[1] - nCoherent[1]));
        checked++;
        // Sanity: the openness the two paths read must itself match.
        if (Math.abs(values(k.openness)[0] - cells.openness[i]) > 1e-9) worst = Infinity;
      }
    }
    ok(
      `node ↔ kernel coherent-term parity across all ${checked} cells (worst Δ ${worst.toExponential(2)})`,
      worst < 1e-9
    );
  }

  // --- THE WIND SHADOW ACTUALLY BITES --------------------------------------
  // The parity test above proves the two paths AGREE about the shadow. It would
  // keep passing if the term were deleted from both of them, so this asserts
  // separately that a shadowed cell genuinely loses coherent wind. Same cell,
  // same everything, one field changed.
  {
    const lit = makeCells();
    const shaded = makeCells();
    lit.windShadow = new Float32Array(CELLS); // no shadow anywhere
    shaded.windShadow = new Float32Array(CELLS).fill(1); // fully occluded everywhere

    const speedAt = (cellsIn, cx, cy) => {
      const h = makeHandle(cellsIn);
      const buf = storageBuffer(packVec4(cellsIn));
      const k = h.kernel(T, { centerXY: T.vec2(...cellCentre(cx, cy)), time: T.float(0), cellBuffer: buf });
      return Math.hypot(...values(k.coherent));
    };
    // An OPEN cell well clear of the wall, so neither openness nor deflection
    // is what moves the number.
    const exposed = speedAt(lit, 7, 0);
    const sheltered = speedAt(shaded, 7, 0);
    ok('a fully shadowed cell carries less coherent wind than an exposed one', sheltered < exposed);
    ok(
      'the shadow attenuates but never fully kills the wind (a lee is slack air, not a vacuum)',
      sheltered > 0 && sheltered < exposed * 0.5
    );
  }

  // --- a sealed cell gets ZERO coherent wind, by construction ---------------
  {
    const h = makeHandle(cells);
    const [wx, wy] = cellCentre(0, 0); // openness 0 — sealed
    const k = h.kernel(T, { centerXY: T.vec2(wx, wy), time: T.float(0), cellBuffer: buffer });
    const gated = values(k.coherent.mul(k.openness));
    ok('sealed cell: coherent wind is exactly zero', gated[0] === 0 && gated[1] === 0);
    const open = h.kernel(T, { centerXY: T.vec2(...cellCentre(7, 0)), time: T.float(0), cellBuffer: buffer });
    const openGated = values(open.coherent.mul(open.openness));
    ok('open cell: coherent wind is non-zero', Math.hypot(...openGated) > 1e-6);
  }

  // --- the deflection is real: it never ADDS speed (the energy cap) ---------
  {
    const h = makeHandle(cells);
    for (let cx = 0; cx < GRID.cols; cx++) {
      const [wx, wy] = cellCentre(cx, 1);
      const k = h.kernel(T, { centerXY: T.vec2(wx, wy), time: T.float(0), cellBuffer: buffer });
      const speed = Math.hypot(...values(k.coherent));
      // The undeflected ambient's own speed is speed01 = 0.6.
      if (speed > 0.6 + 1e-9) {
        ok(`deflection never adds energy (cell x=${cx} produced ${speed})`, false);
        return;
      }
    }
    ok('deflection never adds energy at any cell (the wall energy cap holds)', true);
  }

  // --- no ambient wind at all → no coherent term, both paths ----------------
  {
    const h = makeHandle(cells, { ambient: false });
    const k = h.kernel(T, { centerXY: T.vec2(...cellCentre(6, 2)), time: T.float(500), cellBuffer: buffer });
    const c = values(k.coherent);
    ok('windless scene: kernel coherent term is exactly zero', c[0] === 0 && c[1] === 0);
  }

  // --- kernel() without a buffer behaves as "open outdoors", never "sealed" -
  {
    const h = makeHandle(cells);
    const k = h.kernel(T, { centerXY: T.vec2(0, 0), time: T.float(0) });
    ok('no cell buffer ⇒ openness reads 1 (open), never a silent 0', values(k.openness)[0] === 1);
    ok('no cell buffer ⇒ wall proximity reads 0 (no wall)', values(k.wallProximity)[0] === 0);
  }

  // --- organic and turbulence are memoized, not rebuilt per access ----------
  {
    const h = makeHandle(cells);
    const k = h.kernel(T, { centerXY: T.vec2(10, 10), time: T.float(9), cellBuffer: buffer });
    ok('kernel parts are memoized (same node object on repeat access)', k.organic === k.organic);
    ok('turbulence is memoized too', k.turbulence === k.turbulence);
  }

  // --- cpuAt: the third shape, and its honest out-of-grid answer ------------
  {
    const h = makeHandle(cells);
    const inside = h.cpuAt(...cellCentre(0, 0));
    ok('cpuAt reports a sealed cell as openness 0', inside.openness === 0 && inside.inGrid === true);
    const open = h.cpuAt(...cellCentre(7, 5));
    ok('cpuAt reports an open cell as openness 1', open.openness === 1);
    const outside = h.cpuAt(99999, 99999);
    ok('cpuAt flags an out-of-grid query rather than pretending', outside.inGrid === false);
    ok('cpuAt forwards the injected exposure query', h.cpuAt(-500, 0).exposure === 0 && h.cpuAt(500, 0).exposure === 1);
    const bare = createWindHandle();
    ok('cpuAt on an un-baked handle answers "open", never throws', bare.cpuAt(0, 0).openness === 1);
  }

  // --- solid cells are reported (the CPU shape's own geometry answer) -------
  {
    const h = makeHandle(cells);
    ok('cpuAt reports a solid cell', h.cpuAt(...cellCentre(2, 4)).solid === true);
    ok('cpuAt reports a non-solid cell', h.cpuAt(...cellCentre(7, 0)).solid === false);
  }
}
