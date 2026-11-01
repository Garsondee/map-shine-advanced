/**
 * mask-ops.js — the painter's world-space history and its replay at any size.
 *
 * The load-bearing claim: replaying the ops onto the painter's own grid gives
 * the bytes live painting gave, and replaying them onto a finer grid gives a
 * sharper picture of the SAME thing — not a scaled-up staircase.
 */
import {
  applyOp,
  replayOps,
  stampStroke,
  specForRect,
  bandSpec,
  compactOps,
  seedFromGrid,
  isValidOpList,
  rectPoints,
  cellOps,
  roomCoverFromWalls,
  fileByteToPainted,
  fileSeed,
  fileSeedUrlOf,
} from '../mask-ops.js';
import { createPaintLayer, stampBrushWorld, rasterizePolygon } from '../paint-mask.js';
import { createMaskGrid } from '../mask-derive.js';

const RECT = { x: 0, y: 0, width: 1000, height: 800 };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Count texels in a row whose value differs from both neighbours' midpoint
 * by being neither 0 nor 255 — a crude "how soft is this edge" measure. */
function partialCount(data) {
  let n = 0;
  for (const v of data) if (v > 0 && v < 255) n++;
  return n;
}

export function run(t) {
  // --- the live/replay invariant -------------------------------------------
  {
    const live = createPaintLayer(RECT, 512);
    const pts = [100, 100, 300, 140, 520, 400, 700, 420];
    // The painter's live path: one dab, then interpolated dabs per move.
    stampBrushWorld(live, 100, 100, 40, { value: 200, hardness: 0.5, mode: 'paint' });
    for (let k = 2; k < pts.length; k += 2) {
      const px = pts[k - 2];
      const py = pts[k - 1];
      const dx = pts[k] - px;
      const dy = pts[k + 1] - py;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, 40 * 0.25)));
      for (let i = 1; i <= steps; i++)
        stampBrushWorld(live, px + (dx * i) / steps, py + (dy * i) / steps, 40, {
          value: 200,
          hardness: 0.5,
          mode: 'paint',
        });
    }
    rasterizePolygon(
      live,
      [
        { x: 600, y: 100 },
        { x: 900, y: 100 },
        { x: 900, y: 300 },
      ],
      { value: 255, mode: 'paint' }
    );

    const ops = [
      { t: 'stroke', pts, r: 40, v: 200, h: 0.5, m: 'paint' },
      { t: 'poly', pts: [600, 100, 900, 100, 900, 300], v: 255, m: 'paint' },
    ];
    const replay = replayOps(createPaintLayer(RECT, 512), ops);
    t.ok('replay at the painter grid = the live bytes', same(live.data, replay.data));
    t.ok(
      'ops survive a JSON round trip',
      same(replayOps(createPaintLayer(RECT, 512), JSON.parse(JSON.stringify(ops))).data, live.data)
    );
  }

  // --- full size is sharper, not a staircase --------------------------------
  {
    // A diagonal polygon edge. At 4x the texels, the picture covers the same
    // fraction of the rect, and the fraction of partially-covered... the edge is
    // binary (polygon fill), so check coverage agreement instead.
    const ops = [{ t: 'poly', pts: [0, 0, 1000, 0, 0, 800], v: 255, m: 'paint' }];
    const small = replayOps(createMaskGrid(specForRect(RECT, 250, 200)), ops);
    const big = replayOps(createMaskGrid(specForRect(RECT, 1000, 800)), ops);
    const frac = (g) => g.data.reduce((s, v) => s + (v ? 1 : 0), 0) / g.data.length;
    t.ok('same shape at both sizes (coverage within 1%)', Math.abs(frac(small) - frac(big)) < 0.01);
    // Exactly half the rect is under the diagonal.
    t.ok('full-size polygon covers half the rect', Math.abs(frac(big) - 0.5) < 0.005);
  }

  // --- a coverage op upsizes smoothly ---------------------------------------
  {
    // 4x4 coverage, a 2x2 block lit in the middle.
    const cover = new Uint8Array(16);
    for (const i of [5, 6, 9, 10]) cover[i] = 255;
    const rle = [];
    for (const v of cover) rle.push(v, 1);
    const op = { t: 'cover', rect: { x: 0, y: 0, width: 400, height: 400 }, w: 4, h: 4, rle, v: 255, m: 'paint' };
    const big = applyOp(createMaskGrid(specForRect({ x: 0, y: 0, width: 400, height: 400 }, 400, 400)), op);
    const at = (x, y) => big.data[y * 400 + x];
    t.ok('coverage centre filled', at(200, 200) === 255);
    t.ok('coverage outside the block empty', at(20, 20) === 0 && at(380, 380) === 0);
    // The block spans world 100..300; the ½ threshold of a bilinear ramp lands at the block boundary.
    t.ok('coverage edge sits at the block boundary (±2px)', at(103, 200) === 255 && at(97, 200) === 0);
  }

  // --- seed ops ------------------------------------------------------------
  {
    const g = createPaintLayer(RECT, 256);
    g.data.fill(0);
    rasterizePolygon(
      g,
      [
        { x: 0, y: 0 },
        { x: 500, y: 0 },
        { x: 500, y: 800 },
        { x: 0, y: 800 },
      ],
      { value: 180 }
    );
    const seed = seedFromGrid(g);
    const back = applyOp(createPaintLayer(RECT, 256), seed);
    t.ok('a seed of a grid replays to the same grid', same(back.data, g.data));
    const other = createPaintLayer(RECT, 256);
    other.data.fill(50);
    applyOp(other, { ...seed, over: true });
    t.ok('an over-seed keeps what was there where it is empty', other.data[other.data.length - 1] === 50);
    t.ok('an over-seed writes where it has content', other.data[0] === 180);
    const repl = createPaintLayer(RECT, 256);
    repl.data.fill(50);
    applyOp(repl, seed);
    t.ok('a plain seed replaces everything', repl.data[repl.data.length - 1] === 0);
    // readSeed lets an exporter read the full-size file instead of the stored raster.
    const viaFile = applyOp(createPaintLayer(RECT, 64), { ...seed, url: 'x' }, { readSeed: () => () => 77 });
    t.ok(
      'readSeed overrides the stored raster',
      viaFile.data.every((v) => v === 77)
    );
    const fs0 = fileSeed('maps/m.png', RECT);
    const kept = createPaintLayer(RECT, 64);
    kept.data.fill(9);
    applyOp(kept, fs0);
    t.ok(
      'a file seed with no reader leaves the layer alone',
      kept.data.every((v) => v === 9)
    );
    t.ok(
      'a file seed with a reader draws the file',
      applyOp(createPaintLayer(RECT, 64), fs0, { readSeed: () => () => 200 }).data.every((v) => v === 200)
    );
    t.ok(
      'fileSeedUrlOf finds it',
      fileSeedUrlOf([fs0, { t: 'fill', v: 0 }]) === 'maps/m.png' && fileSeedUrlOf([]) === null
    );
  }

  // --- bands tile the picture exactly -----------------------------------------
  {
    const ops = [
      { t: 'fill', v: 255 },
      { t: 'stroke', pts: [100, 100, 900, 700], r: 60, v: 255, h: 0.3, m: 'erase' },
    ];
    const whole = replayOps(createMaskGrid(specForRect(RECT, 500, 400)), ops);
    const stitched = new Uint8Array(500 * 400);
    for (let r0 = 0; r0 < 400; r0 += 64) {
      const r1 = Math.min(400, r0 + 64);
      const band = replayOps(createMaskGrid(bandSpec(RECT, 500, 400, r0, r1)), ops);
      stitched.set(band.data, r0 * 500);
    }
    t.ok('bands stitched = one whole render', same(whole.data, stitched));
    t.ok('the erase stroke is soft (has partial texels)', partialCount(whole.data) > 0);
  }

  // --- compaction, validation, helpers ----------------------------------------
  {
    const g = createPaintLayer(RECT, 128);
    stampStroke(g, [10, 10, 900, 700], 30, { value: 255, hardness: 0.5, mode: 'paint' });
    const many = Array.from({ length: 50 }, () => ({
      t: 'stroke',
      pts: [10, 10, 900, 700],
      r: 30,
      v: 255,
      h: 0.5,
      m: 'paint',
    }));
    const kept = compactOps(many, g, 1e9);
    t.ok('under budget: ops kept', !kept.compacted && kept.ops === many);
    const flat = compactOps(many, g, 100);
    t.ok('over budget: one seed', flat.compacted && flat.ops.length === 1 && flat.ops[0].t === 'seed');
    t.ok(
      'the flattened seed reproduces the grid',
      same(applyOp(createPaintLayer(RECT, 128), flat.ops[0]).data, g.data)
    );
    t.ok('valid op list accepted', isValidOpList([{ t: 'fill', v: 0 }, ...many]));
    t.ok('junk op list rejected', !isValidOpList([{ t: 'nope' }]) && !isValidOpList('x') && !isValidOpList([null]));
    t.ok('unknown op is skipped, not thrown', applyOp(createPaintLayer(RECT, 16), { t: 'future' }) !== null);
    t.ok(
      'rectPoints orders the corners',
      rectPoints({ x: 50, y: 60 }, { x: 10, y: 20 }).join() === '10,20,50,20,50,60,10,60'
    );
    t.ok(
      'cellOps drops degenerate cells',
      cellOps(
        [
          [0, 0, 1, 0, 1, 1],
          [0, 0],
        ],
        255,
        'paint'
      ).length === 1
    );
  }

  // --- rooms from walls ---------------------------------------------------------
  {
    // A 1000x800 scene with one closed 300x300 room at (200,200)..(500,500),
    // and an open courtyard wall that does not enclose anything.
    const walls = [
      { x1: 200, y1: 200, x2: 500, y2: 200 },
      { x1: 500, y1: 200, x2: 500, y2: 500 },
      { x1: 500, y1: 500, x2: 200, y2: 500 },
      { x1: 200, y1: 500, x2: 200, y2: 200 },
      { x1: 700, y1: 100, x2: 700, y2: 400 },
    ];
    const all = roomCoverFromWalls({ walls, sceneRect: RECT, gridSize: 100 });
    t.ok('start-from-walls finds the one closed room', all.op && all.rooms === 1);
    const g = applyOp(createMaskGrid(specForRect(RECT, 1000, 800)), { ...all.op, v: 255, m: 'paint' });
    const at = (x, y) => g.data[y * 1000 + x];
    t.ok('inside the room is covered', at(350, 350) === 255);
    t.ok('outside the room is not', at(100, 100) === 0 && at(800, 600) === 0);
    t.ok('cover reaches the wall line (within 6px)', at(204, 350) === 255 && at(496, 350) === 255);
    t.ok('cover does not cross the wall (beyond 8px)', at(190, 350) === 0 && at(510, 350) === 0);
    const one = roomCoverFromWalls({ walls, sceneRect: RECT, at: { x: 800, y: 600 } });
    t.ok('fill-room at an outdoor point picks the open space', one.op && one.rooms === 1);
    const onWall = roomCoverFromWalls({ walls, sceneRect: RECT, at: { x: 200, y: 350 } });
    t.ok('fill-room on a wall explains itself', !onWall.op && /wall/.test(onWall.reason));
    // A walled-in EDGE (how real maps keep tokens on the board): the yard is
    // sealed too, but it runs along the edge — it must stay outdoors, and a
    // small room set against the edge must still come out indoors.
    const edge = [
      { x1: 0, y1: 0, x2: 1000, y2: 0 },
      { x1: 1000, y1: 0, x2: 1000, y2: 800 },
      { x1: 1000, y1: 800, x2: 0, y2: 800 },
      { x1: 0, y1: 800, x2: 0, y2: 0 },
    ];
    const corner = [
      { x1: 800, y1: 600, x2: 1000, y2: 600 },
      { x1: 800, y1: 600, x2: 800, y2: 800 },
    ];
    const sealed = roomCoverFromWalls({ walls: [...walls, ...edge, ...corner], sceneRect: RECT, gridSize: 100 });
    const gs = applyOp(createMaskGrid(specForRect(RECT, 1000, 800)), { ...sealed.op, v: 255, m: 'paint' });
    const sat = (x, y) => gs.data[y * 1000 + x];
    t.ok('walled edge: the yard stays outdoors', sat(100, 100) === 0 && sat(650, 700) === 0);
    t.ok('walled edge: the closed room is indoors', sat(350, 350) === 255);
    t.ok('walled edge: a small room against the edge is indoors', sat(900, 700) === 255 && sealed.rooms === 2);
    const none = roomCoverFromWalls({ walls: [walls[4]], sceneRect: RECT });
    t.ok('no closed rooms explains itself', !none.op && /no closed rooms/.test(none.reason));
  }

  // --- file pixels to painted bytes ----------------------------------------------
  {
    t.ok('opaque grey is itself', fileByteToPainted(100, 255, 1) === 100);
    t.ok('transparent outdoors reads white', fileByteToPainted(0, 0, 1) === 255);
    t.ok('transparent fire reads empty', fileByteToPainted(200, 0, 0) === 0);
  }
}
