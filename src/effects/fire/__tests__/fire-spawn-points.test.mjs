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
import { extractFiresWithLabels } from '../fire-mask.js';

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

  // ── NO DENSITY CLIFF AT THE CAP BOUNDARY (2026-08-13) ──────────────────────
  // The original subsample picked an INTEGER stride via `Math.ceil(painted /
  // cap)`, which jumps by whole numbers: at painted===cap it kept everything
  // (stride 1), but ONE more painted texel pushed the stride to 2 and roughly
  // HALVED the spawned count outright — a real, sudden visual density drop
  // from a single extra painted pixel, repeating at every multiple of cap.
  {
    const capAt20 = (paintedCount) => {
      const cols = 10;
      const rowsNeeded = Math.ceil(paintedCount / cols);
      const rows = [];
      let remaining = paintedCount;
      for (let r = 0; r < rowsNeeded; r++) {
        const thisRow = Math.min(cols, remaining);
        rows.push('#'.repeat(thisRow) + '.'.repeat(cols - thisRow));
        remaining -= thisRow;
      }
      return extractFireSpawnPoints(gridFrom(rows, { texel: 10 }), { maxPoints: 20 }).count;
    };
    const atCap = capAt20(20);
    const oneOver = capAt20(21);
    t.ok('painted exactly at the cap keeps every eligible texel', atCap === 20);
    t.ok(
      `one MORE painted texel than the cap does not crater the count (cap=20 got ${oneOver}, was ~10 under the old integer-stride bug)`,
      oneOver === 20
    );
  }

  {
    // The general property the fix promises: count tracks min(cap, painted)
    // smoothly across a whole range of caps against a FIXED painted total —
    // no cap value should see a sudden drop relative to its neighbours.
    const rows = [];
    for (let r = 0; r < 10; r++) rows.push('#'.repeat(10)); // 100 painted texels
    const g = gridFrom(rows, { texel: 10 });
    const counts = [90, 91, 99, 100, 101, 150].map((cap) => extractFireSpawnPoints(g, { maxPoints: cap }).count);
    t.ok(
      `count exactly matches min(cap, painted) at every sampled cap (${counts.join(', ')})`,
      counts[0] === 90 &&
        counts[1] === 91 &&
        counts[2] === 99 &&
        counts[3] === 100 &&
        counts[4] === 100 &&
        counts[5] === 100
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

  // ══════════════════════════════════════════════════════════════════════
  // LABEL-SCOPED COHESION (2026-08-16) — the rebuild. The tests above pin
  // the LEGACY nearest-of-all-fires path (omitting the 4th argument) byte-
  // for-byte; everything below exercises the NEW path a real caller
  // (`fire-subsystem.js`) now always supplies.
  // ══════════════════════════════════════════════════════════════════════

  {
    // ⚠️ THE CORE ASK: "no risk of accidentally moving fires associated with
    // other fires' spawn points." Same fixture `fire-mask.test.mjs` uses for
    // the cross-component-suppression fix — a small 2×2 blob one empty column
    // away from a much bigger 9×9 one, close enough that the OLD nearest-of-
    // all-fires cohesion would happily pull the small blob's points toward
    // the big one.
    const rows = [
      '................',
      '..#########.....',
      '..#########.....',
      '..#########.....',
      '..#########.##..',
      '..#########.##..',
      '..#########.....',
      '..#########.....',
      '..#########.....',
      '..#########.....',
      '................',
    ];
    const g = gridFrom(rows, { texel: 20 });
    const { fires, nearestLabel, spec } = extractFiresWithLabels(g, { minDiameterPx: 4 });
    t.ok('the fixture yields the expected big+small pair', fires.length === 2);
    const bigFire = fires.find((f) => f.diameterPx > 100);
    const smallFire = fires.find((f) => f.diameterPx < 100);
    const cloud = extractFireSpawnPoints(g, { threshold: 0.5 });
    const labelGrid = { nearestLabel, spec };
    const cohesed = applyCohesion(cloud, fires, 1, labelGrid);

    let smallOriginToSmallTarget = 0;
    let smallOriginToBigTarget = 0;
    let bigOriginToBigTarget = 0;
    let bigOriginToSmallTarget = 0;
    for (let i = 0; i < cloud.count; i++) {
      const o = i * SPAWN_POINT_STRIDE;
      const originX = cloud.points[o];
      const targetX = cohesed.points[o];
      const targetY = cohesed.points[o + 1];
      const dBig = Math.hypot(targetX - bigFire.x, targetY - bigFire.y);
      const dSmall = Math.hypot(targetX - smallFire.x, targetY - smallFire.y);
      // The small blob sits at world x ~250-290 (columns 12-13); the big one
      // spans x ~40-210 (columns 2-10) — a point's OWN origin unambiguously
      // says which blob painted it.
      if (originX > 240) {
        if (dSmall < dBig) smallOriginToSmallTarget++;
        else smallOriginToBigTarget++;
      } else {
        if (dBig < dSmall) bigOriginToBigTarget++;
        else bigOriginToSmallTarget++;
      }
    }
    t.ok(
      `every small-blob point converges on the small blob's own centroid (${smallOriginToSmallTarget} of ${smallOriginToSmallTarget + smallOriginToBigTarget})`,
      smallOriginToBigTarget === 0 && smallOriginToSmallTarget > 0
    );
    t.ok(
      `every big-blob point converges on the big blob's own centroid (${bigOriginToBigTarget} of ${bigOriginToBigTarget + bigOriginToSmallTarget})`,
      bigOriginToSmallTarget === 0 && bigOriginToBigTarget > 0
    );

    // The LEGACY 3-arg path (no label grid) is a DIFFERENT algorithm, not
    // merely a relaxed version of this one — see the "two fires" legacy test
    // above for its own pinned nearest-of-all-fires behaviour. What matters
    // here is only that supplying a label grid is what changes the outcome;
    // omitting it must keep running unchanged.
    const legacy = applyCohesion(cloud, fires, 1);
    t.ok('the legacy 3-arg call still runs (no label grid required)', legacy.points.length === cloud.points.length);
  }

  {
    // Cohesion's OTHER promise: pull toward the BRIGHTEST part of the blob,
    // not its geometric ridge peak. A uniform 7×7 blob (so the geometric peak
    // sits at its exact centre regardless of paint VALUE) with one corner
    // painted much brighter than the rest.
    const w = 9;
    const h = 9;
    const texel = 20;
    const data = new Uint8Array(w * h);
    for (let r = 1; r <= 7; r++) {
      for (let c = 1; c <= 7; c++) data[r * w + c] = r <= 3 && c <= 3 ? 255 : 90;
    }
    const grid = {
      spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel },
      data,
    };
    const { fires, nearestLabel, spec } = extractFiresWithLabels(grid, { minDiameterPx: 4 });
    t.ok(`the uneven blob still yields one fire (got ${fires.length})`, fires.length === 1);
    const peak = fires[0];
    const cloud = extractFireSpawnPoints(grid, { threshold: 0.3 });
    const cohesed = applyCohesion(cloud, fires, 1, { nearestLabel, spec });
    // Bright 3×3 sub-block occupies texels (1..3, 1..3) → world 20..80 both
    // axes, centred around (40, 40) — well off the blob's own centre (90, 90).
    const brightCentre = { x: 40, y: 40 };
    const dPeak = Math.hypot(peak.x - brightCentre.x, peak.y - brightCentre.y);
    const dTarget = Math.hypot(cohesed.points[0] - brightCentre.x, cohesed.points[1] - brightCentre.y);
    t.ok(
      `the cohesion target sits closer to the bright corner than the ridge peak does (peak ${Math.round(dPeak)}px, target ${Math.round(dTarget)}px)`,
      dTarget < dPeak
    );
  }

  {
    // Anchor safety: a fire with no confirmed label (an author-placed anchor,
    // not mask-derived) sitting right on top of real mask spawn points must
    // never attract them — there is nothing to key the match on. Proved by
    // comparing WITH vs WITHOUT the anchor present: identical output means
    // the anchor is completely inert.
    const g = gridFrom(['....', '.##.', '.##.', '....'], { texel: 20 });
    const { fires, nearestLabel, spec } = extractFiresWithLabels(g, { minDiameterPx: 4 });
    const cloud = extractFireSpawnPoints(g);
    const anchor = { x: cloud.points[0], y: cloud.points[1] }; // no `.label` — sits exactly on a real point
    const labelGrid = { nearestLabel, spec };
    const withAnchor = applyCohesion(cloud, [...fires, anchor], 1, labelGrid);
    const withoutAnchor = applyCohesion(cloud, fires, 1, labelGrid);
    t.ok(
      'adding a label-less anchor changes nothing — every point still targets only its own labelled fire',
      withAnchor.points.every((v, i) => v === withoutAnchor.points[i])
    );
  }

  {
    // Unconfirmed point stays put: a spawn point that clears the SPAWN
    // threshold but sits far from ANY confirmed paint (`propagateLabels`
    // gives up on it) must be returned bit-identical, never assigned an
    // invented target.
    const n = 17;
    const centre = 8;
    const w = n;
    const h = n;
    const texel = 20;
    const data = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const d = Math.max(Math.abs(r - centre), Math.abs(c - centre));
        data[r * w + c] = d <= 2 ? 255 : 0;
      }
    }
    // ONE isolated far-corner texel at 55/255 (~0.216) — clears the default
    // SPAWN threshold (0.18) but not the PAINT threshold (0.25), and sits at
    // Chebyshev distance 8 from the core: far outside LABEL_FRINGE_TEXELS.
    data[0] = 55;
    const grid = {
      spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel },
      data,
    };
    const { fires, nearestLabel, spec } = extractFiresWithLabels(grid, { minDiameterPx: 4 });
    const cloud = extractFireSpawnPoints(grid);
    const cornerWorld = { x: 0.5 * texel, y: 0.5 * texel };
    let cornerIdx = -1;
    for (let i = 0; i < cloud.count; i++) {
      const o = i * SPAWN_POINT_STRIDE;
      if (Math.abs(cloud.points[o] - cornerWorld.x) < 1 && Math.abs(cloud.points[o + 1] - cornerWorld.y) < 1) {
        cornerIdx = i;
        break;
      }
    }
    t.ok('the fixture produced the isolated far-corner spawn point', cornerIdx >= 0);
    const cohesed = applyCohesion(cloud, fires, 1, { nearestLabel, spec });
    const o = cornerIdx * SPAWN_POINT_STRIDE;
    t.ok(
      'an unconfirmed point is untouched, never assigned to the nearest surviving fire',
      cohesed.points[o] === cloud.points[o] && cohesed.points[o + 1] === cloud.points[o + 1]
    );
  }

  {
    // Label without a live fire: a real, confirmed label whose only fire was
    // dropped (simulating `maxFires`/`minDiameterPx`) must leave its points
    // alone rather than reassigning them to whatever fire IS still standing.
    const rows = ['..............', '.###......###.', '.###......###.', '.###......###.', '..............'];
    const g = gridFrom(rows, { texel: 20 });
    const { fires, nearestLabel, spec } = extractFiresWithLabels(g, { minDiameterPx: 4 });
    t.ok('the fixture yields two fires to start', fires.length === 2);
    const cloud = extractFireSpawnPoints(g, { threshold: 0.5 });
    const survivingOnly = [fires[0]]; // simulate fires[1] getting dropped upstream
    const cohesed = applyCohesion(cloud, survivingOnly, 1, { nearestLabel, spec });
    let untouched = 0;
    let reassigned = 0;
    for (let i = 0; i < cloud.count; i++) {
      const o = i * SPAWN_POINT_STRIDE;
      const origX = cloud.points[o];
      const isDroppedBlob = fires[1] && Math.abs(origX - fires[1].x) < 60;
      if (!isDroppedBlob) continue;
      const moved = Math.abs(cohesed.points[o] - origX) > 1e-6;
      if (moved) reassigned++;
      else untouched++;
    }
    t.ok(
      `the dropped label's points stay put rather than joining the survivor (${untouched} untouched, ${reassigned} reassigned)`,
      untouched > 0 && reassigned === 0
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
    // ⚠️ AN OVERSIZED (pooled) DEST BUFFER MUST BE FULLY CLEARED PAST THE REAL
    // POINTS, NOT JUST UP TO `capacity * STRIDE` (2026-08-13). The docs only
    // ever promise `dest` is "capacity * SPAWN_POINT_STRIDE long", but nothing
    // above enforces that beyond a minimum-length check — a caller handing in
    // a genuinely LARGER buffer (a pooled allocation, say) would previously
    // leave whatever it held past the declared capacity uncleared: a stale
    // point from a prior scene's paint, sitting inside the real buffer a
    // shader could still read even though it is past `capacity`.
    const cloud = extractFireSpawnPoints(gridFrom(['.#.']));
    const capacity = 2;
    const oversized = new Float32Array(6 * SPAWN_POINT_STRIDE); // 3x larger than capacity needs
    oversized.fill(999);
    const written = packSpawnPoints(oversized, cloud, capacity);
    t.ok(`it still reports what it wrote (${written})`, written === 1);
    t.ok(
      'EVERYTHING past the real points is cleared, including past the declared capacity',
      oversized.slice(written * SPAWN_POINT_STRIDE).every((v) => v === 0)
    );
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
