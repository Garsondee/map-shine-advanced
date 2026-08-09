/**
 * fire-spawn-points.test.mjs — THE PAINTED REGION BECOMES SPAWN POINTS.
 *
 * Two properties here are the whole design and both are easy to break silently:
 *
 *  - OVER-CAP MUST SUBSAMPLE, NEVER TRUNCATE. V2 broke out of its scan loop at
 *    the cap, so on a busy map every fire below the cut-off row got no spawn
 *    points and simply did not burn, with nothing reporting it. The test drives
 *    a paint pattern at both ends of the raster and asserts both still spawn.
 *  - THE JITTER RADIUS MUST MATCH THE TEXEL. It is what turns a 2-3 texel hearth
 *    into a continuous distribution instead of two or three sprite columns, so
 *    it has to track the grid's own resolution rather than being a constant.
 */
import {
  extractFireSpawnPoints,
  fireSpawnSignature,
  packSpawnPoints,
  applyCohesion,
  SPAWN_POINT_STRIDE,
} from '../fire-spawn-points.js';

/** Build a MaskGrid from an ASCII picture. `#` = full paint, `+` = mid, `.` = none. */
function gridFrom(rows, { texel = 20, x = 0, y = 0 } = {}) {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      data[r * w + c] = ch === '#' ? 255 : ch === '+' ? 120 : 0;
    }
  }
  return { spec: { x, y, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel }, data };
}

const pointAt = (res, i) => ({
  x: res.points[i * SPAWN_POINT_STRIDE],
  y: res.points[i * SPAWN_POINT_STRIDE + 1],
  brightness: res.points[i * SPAWN_POINT_STRIDE + 2],
  jitter: res.points[i * SPAWN_POINT_STRIDE + 3],
});

export function run(t) {
  // ── THE BASICS ─────────────────────────────────────────────────────────────

  {
    const g = gridFrom(['....', '.##.', '.##.', '....']);
    const res = extractFireSpawnPoints(g);
    t.ok(`four painted texels yield four points (got ${res.count})`, res.count === 4);
    t.ok('the buffer is stride-sized', res.points.length === res.count * SPAWN_POINT_STRIDE);
    t.ok('paintedTexels is reported', res.paintedTexels === 4);
    t.ok('every value is finite', res.points.every(Number.isFinite));
    // Painted block spans texels 1..2 in both axes → world 20..60, centres at 30/50.
    const xs = [...Array(res.count)].map((_, i) => pointAt(res, i).x);
    t.ok(
      `points sit on texel centres (${xs.join(', ')})`,
      xs.every((v) => v === 30 || v === 50)
    );
  }

  {
    // World placement must respect the grid's own origin, or every fire on an
    // offset floor spawns in the wrong place.
    const g = gridFrom(['..', '.#'], { texel: 50, x: 1000, y: 2000 });
    const p = pointAt(extractFireSpawnPoints(g), 0);
    t.ok(`the point is offset by the grid origin (${p.x}, ${p.y})`, p.x === 1075 && p.y === 2075);
  }

  {
    // Brightness rides through as 0..1 — it becomes the particle's life/size/heat.
    const res = extractFireSpawnPoints(gridFrom(['#+']));
    const bs = [pointAt(res, 0).brightness, pointAt(res, 1).brightness].sort();
    t.ok(`both paint levels spawn (got ${res.count})`, res.count === 2);
    t.ok(`brightness is normalized 0..1 (${bs.map((b) => b.toFixed(2)).join(', ')})`, bs[1] === 1 && bs[0] < 0.6);
  }

  {
    // Unpainted and degenerate inputs.
    t.ok('a null grid yields nothing', extractFireSpawnPoints(null).count === 0);
    t.ok('a grid with no data yields nothing', extractFireSpawnPoints({ spec: { w: 4, h: 4 } }).count === 0);
    t.ok('unpainted yields nothing', extractFireSpawnPoints(gridFrom(['..', '..'])).count === 0);
    const zeroTexel = { spec: { x: 0, y: 0, width: 0, height: 0, w: 2, h: 2 }, data: new Uint8Array([255, 0, 0, 0]) };
    t.ok('a zero-sized grid yields nothing rather than NaN', extractFireSpawnPoints(zeroTexel).count === 0);
  }

  // ── THE JITTER RADIUS TRACKS THE GRID ──────────────────────────────────────

  {
    // ⚠️ This is what makes a 2-3 texel hearth spawn continuously instead of in
    // two or three columns. It must scale with the texel, not be a constant.
    const coarse = extractFireSpawnPoints(gridFrom(['.#.'], { texel: 40 }));
    const fine = extractFireSpawnPoints(gridFrom(['.#.'], { texel: 4 }));
    t.ok(`a coarse grid jitters wide (${pointAt(coarse, 0).jitter})`, pointAt(coarse, 0).jitter === 20);
    t.ok(`a fine grid jitters tight (${pointAt(fine, 0).jitter})`, pointAt(fine, 0).jitter === 2);
    // Half a texel exactly — so neighbouring points tile without gaps or overlap.
    t.ok('the jitter radius is half a texel', pointAt(coarse, 0).jitter * 2 === 40);
  }

  // ── OVER-CAP SUBSAMPLES, NEVER TRUNCATES — V2's real bug ──────────────────

  {
    // A fully-painted grid, far over cap, painted at BOTH ends of the raster.
    // V2's `break outer` would keep only the first N and drop the whole bottom
    // of the map; even subsampling must keep both.
    const rows = [];
    for (let r = 0; r < 40; r++) rows.push('#'.repeat(40));
    const g = gridFrom(rows, { texel: 10 });
    const res = extractFireSpawnPoints(g, { maxPoints: 64 });
    t.ok(`the cap is respected (got ${res.count})`, res.count <= 64 && res.count > 0);
    t.ok('paintedTexels still reports the TRUE total, not the capped one', res.paintedTexels === 1600);

    const ys = [...Array(res.count)].map((_, i) => pointAt(res, i).y);
    const gridBottom = 40 * 10;
    t.ok(`points reach the TOP of the region (min y ${Math.min(...ys)})`, Math.min(...ys) < gridBottom * 0.15);
    t.ok(`points reach the BOTTOM of the region (max y ${Math.max(...ys)})`, Math.max(...ys) > gridBottom * 0.85);
    // The distribution should be roughly even across the raster, not clumped.
    const half = ys.filter((v) => v < gridBottom / 2).length;
    t.ok(
      `the halves are evenly served (${half} of ${res.count} in the top half)`,
      half > res.count * 0.3 && half < res.count * 0.7
    );
  }

  {
    // Two separated fires, one near the raster start and one near its end, with
    // a cap far below the painted count — the exact shape of V2's bug.
    const rows = [];
    for (let r = 0; r < 30; r++) rows.push(r < 4 || r > 25 ? '#'.repeat(30) : '.'.repeat(30));
    const res = extractFireSpawnPoints(gridFrom(rows, { texel: 10 }), { maxPoints: 20 });
    const ys = [...Array(res.count)].map((_, i) => pointAt(res, i).y);
    t.ok(
      'the FIRST fire spawns',
      ys.some((v) => v < 100)
    );
    t.ok(
      'the SECOND fire also spawns — V2 dropped this one entirely',
      ys.some((v) => v > 250)
    );
  }

  // ── ASCENDING-BY-BRIGHTNESS ORDER — load-bearing for the spawn-bias control ─

  {
    // `fire-particle-runtime.js#spawnAt` warps a uniform index pick into a
    // brightness bias by assuming high index = bright. If this ever stops
    // being sorted, the bias control silently reverses or scrambles.
    const g = gridFrom(['+#.+#', '#.+.#'], { texel: 10 });
    const res = extractFireSpawnPoints(g, { threshold: 0.01 });
    const bs = [...Array(res.count)].map((_, i) => pointAt(res, i).brightness);
    t.ok(
      `points are sorted ascending by brightness (${bs.map((b) => b.toFixed(2)).join(', ')})`,
      bs.every((v, i) => i === 0 || v >= bs[i - 1])
    );
  }

  // ── COHESION — pulling points toward their fire's centre of mass ──────────

  {
    const cloud = extractFireSpawnPoints(gridFrom(['#...#', '.....', '#...#'], { texel: 10 }));
    t.ok('the fixture has points to move', cloud.count > 0);

    t.ok('amount 0 is a no-op (same object back)', applyCohesion(cloud, [{ x: 100, y: 100 }], 0) === cloud);
    t.ok('no fires is a no-op', applyCohesion(cloud, [], 1) === cloud);
    t.ok('a null cloud is a no-op', applyCohesion(null, [{ x: 0, y: 0 }], 1) === null);

    const centre = { x: 25, y: 15 };
    const points = (res) => [...Array(res.count)].map((_, i) => pointAt(res, i));

    const full = applyCohesion(cloud, [centre], 1);
    t.ok(
      'amount 1 collapses every point exactly onto the fire centre',
      points(full).every((p) => Math.abs(p.x - centre.x) < 1e-6 && Math.abs(p.y - centre.y) < 1e-6)
    );

    const before = points(cloud);
    const half = points(applyCohesion(cloud, [centre], 0.5));
    t.ok(
      'amount 0.5 moves every point exactly halfway toward the centre',
      half.every((p, i) => {
        const expectedX = before[i].x + (centre.x - before[i].x) * 0.5;
        const expectedY = before[i].y + (centre.y - before[i].y) * 0.5;
        return Math.abs(p.x - expectedX) < 1e-6 && Math.abs(p.y - expectedY) < 1e-6;
      })
    );

    const negative = points(applyCohesion(cloud, [centre], -1));
    t.ok(
      'a negative amount pushes every point FARTHER from the centre instead',
      negative.every((p, i) => {
        const dBefore = (before[i].x - centre.x) ** 2 + (before[i].y - centre.y) ** 2;
        const dAfter = (p.x - centre.x) ** 2 + (p.y - centre.y) ** 2;
        return dAfter > dBefore;
      })
    );

    t.ok(
      'the input cloud is never mutated',
      points(cloud).every((p, i) => p.x === before[i].x && p.y === before[i].y)
    );

    // Two fires: a point must move toward its NEAREST one, not always the first.
    const twoFires = [
      { x: 25, y: 15 }, // near every point in this fixture
      { x: 5025, y: 15 }, // far away — nothing should be pulled toward this one
    ];
    t.ok(
      'every point is pulled toward its NEAREST fire, not the far one',
      points(applyCohesion(cloud, twoFires, 1)).every((p) => p.x < 1000)
    );
  }

  // ── DETERMINISM ────────────────────────────────────────────────────────────

  {
    const g = gridFrom(['.##.', '.##.']);
    const a = extractFireSpawnPoints(g);
    const b = extractFireSpawnPoints(g);
    t.ok('extraction is deterministic', a.points.every((v, i) => v === b.points[i]) && a.count === b.count);
  }

  // ── THE SIGNATURE ──────────────────────────────────────────────────────────

  {
    const a = gridFrom(['.#.', '...']);
    const b = gridFrom(['.#.', '...']);
    const c = gridFrom(['.##', '...']);
    t.ok('the same paint signs the same', fireSpawnSignature(a) === fireSpawnSignature(b));
    t.ok('different paint signs differently', fireSpawnSignature(a) !== fireSpawnSignature(c));
    t.ok('a null grid signs zero', fireSpawnSignature(null) === 0);
    const moved = gridFrom(['.#.', '...'], { x: 700 });
    t.ok(
      'a moved grid signs differently — the points would land elsewhere',
      fireSpawnSignature(a) !== fireSpawnSignature(moved)
    );
  }

  // ── PACKING INTO THE GPU BUFFER ────────────────────────────────────────────

  {
    const cloud = extractFireSpawnPoints(gridFrom(['.##.']));
    const capacity = 8;
    const dest = new Float32Array(capacity * SPAWN_POINT_STRIDE);
    dest.fill(999); // stale data from a previous scene
    const written = packSpawnPoints(dest, cloud, capacity);
    t.ok(`it reports what it wrote (${written})`, written === cloud.count && written === 2);
    t.ok('the real points land at the front', dest[0] === cloud.points[0] && dest[1] === cloud.points[1]);
    // ⚠️ The kernel picks across the FULL capacity, so unused slots must be
    // legal-but-inert, never stale. Brightness 0 = zero life = never drawn.
    const padStart = written * SPAWN_POINT_STRIDE;
    t.ok(
      'every unused slot is zeroed, not left stale',
      dest.slice(padStart).every((v) => v === 0)
    );
    t.ok('...which reads as zero brightness', dest[padStart + 2] === 0);
  }

  {
    // A cloud bigger than the buffer must fill it rather than overflow.
    const rows = [];
    for (let r = 0; r < 10; r++) rows.push('#'.repeat(10));
    const cloud = extractFireSpawnPoints(gridFrom(rows));
    const dest = new Float32Array(4 * SPAWN_POINT_STRIDE);
    t.ok('a too-small buffer takes what fits', packSpawnPoints(dest, cloud, 4) === 4);
    t.ok('an undersized dest is refused rather than overflowing', packSpawnPoints(new Float32Array(3), cloud, 4) === 0);
    t.ok('a null cloud pads the whole buffer', packSpawnPoints(dest, null, 4) === 0 && dest.every((v) => v === 0));
  }
}
