/**
 * The zone field is the whole "world" a GPU agent perceives, so its arithmetic is
 * proven in Node against brute force rather than trusted: the signed distance
 * must be EXACT Euclidean (a chamfer's 45° bias is visible as flies that prefer
 * diagonal headings along a rim), the gradient must point inward, the bilinear
 * twin must agree with the cells it reads, and homes must land inside their zone.
 */
import {
  ZONE_CELL_STRIDE,
  ZONE_HOME_STRIDE,
  ZONE_EDGE_CELLS,
  ZONE_FIELD_CELLS_MAX,
  STAMP_STEPS,
  buildZoneField,
  sampleZoneField,
  allocateZonePopulation,
  pickSlotHomes,
  createSlotStamper,
  packZoneBuffer,
  zoneBufferElementCount,
  zoneGridSignature,
} from '../critter-zone.js';

/** A MaskGrid whose texel (cx, cy) holds `paint(cx, cy)` (0..255). */
function makeGrid({ w, h, texelW, texelH, x = 0, y = 0, paint }) {
  const data = new Uint8Array(w * h);
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) data[cy * w + cx] = paint(cx, cy);
  return { spec: { x, y, width: w * texelW, height: h * texelH, w, h, texelW, texelH }, data };
}
const disc = (cx, cy, r) => (x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 255 : 0);

export function run(t) {
  // ---- degenerate input is a clean null, never a throw -----------------------------------------
  t.ok('null grid → no field', buildZoneField(null) === null);
  t.ok('grid with no data → no field', buildZoneField({ spec: { w: 4, h: 4, width: 4, height: 4 } }) === null);
  t.ok(
    'an all-zero grid → no field',
    buildZoneField(makeGrid({ w: 16, h: 16, texelW: 10, texelH: 10, paint: () => 0 })) === null
  );
  t.ok(
    'paint below the threshold does not count',
    buildZoneField(makeGrid({ w: 16, h: 16, texelW: 10, texelH: 10, paint: () => 20 }), { threshold: 0.18 }) === null
  );

  // ---- a disc: sizes, distances, gradient ------------------------------------------------------
  const grid = makeGrid({ w: 64, h: 48, texelW: 10, texelH: 10, x: 100, y: 200, paint: disc(32, 24, 10) });
  const f = buildZoneField(grid, { marginPx: 60 });
  t.ok('a disc builds a field', f !== null);
  t.ok('one painted blob is one zone', f.zones.length === 1);
  t.ok('signature is a non-zero uint32', Number.isInteger(f.signature) && f.signature > 0);
  t.ok('cells array is cols*rows*stride', f.cells.length === f.cols * f.rows * ZONE_CELL_STRIDE);
  // painted bounds are 21 cells wide; margin 60px = 6 cells + 2 → 21 + 2*8 = 37, never larger than the grid
  t.ok('the field is cropped to the paint plus margin', f.cols === 37 && f.rows === 37);
  t.ok('the crop keeps world alignment (origin = spec origin + cropped cells)', f.originX === 100 + (22 - 8) * 10);

  const centre = sampleZoneField(f, 100 + 32.5 * 10, 200 + 24.5 * 10);
  t.ok('centre of the disc reads full coverage', centre.coverage > 0.99);
  t.ok(
    `centre distance ≈ the disc radius (${centre.distance.toFixed(1)} px of ~100)`,
    centre.distance > 85 && centre.distance < 110
  );
  const outside = sampleZoneField(f, 100 + 32.5 * 10 + 150, 200 + 24.5 * 10);
  t.ok('outside the disc the signed distance is negative', outside.distance < -30);
  t.ok('outside the disc coverage is zero', outside.coverage === 0);
  t.ok('outside, the gradient points back INTO the zone (−x)', outside.gradX < -0.9 && Math.abs(outside.gradY) < 0.3);
  const west = sampleZoneField(f, 100 + 32.5 * 10 - 150, 200 + 24.5 * 10);
  t.ok('mirrored: west of the disc the gradient points +x', west.gradX > 0.9);
  const rim = sampleZoneField(f, 100 + 32.5 * 10 + 100, 200 + 24.5 * 10);
  t.ok(`the distance crosses zero near the rim (${rim.distance.toFixed(1)} px)`, Math.abs(rim.distance) < 12);

  // inward-gradient property over the whole interior ring where it is well-defined
  let radialOk = 0;
  let radialN = 0;
  for (let cy = 14; cy <= 34; cy++) {
    for (let cx = 22; cx <= 42; cx++) {
      const dx = cx - 32;
      const dy = cy - 24;
      const r = Math.hypot(dx, dy);
      if (r < 3 || r > 9) continue;
      const s = sampleZoneField(f, 100 + (cx + 0.5) * 10, 200 + (cy + 0.5) * 10);
      radialN++;
      if (s.gradX * (-dx / r) + s.gradY * (-dy / r) > 0.9) radialOk++;
    }
  }
  t.ok(`interior gradients point at the centre (${radialOk}/${radialN})`, radialN > 40 && radialOk / radialN > 0.95);

  // ---- exactness vs brute force on an awkward, blobby shape ------------------------------------
  const blobGrid = makeGrid({
    w: 40,
    h: 30,
    texelW: 8,
    texelH: 8,
    paint: (x, y) =>
      disc(12, 14, 6)(x, y) || disc(24, 12, 4)(x, y) || (x >= 18 && x <= 30 && y >= 20 && y <= 23) ? 255 : 0,
  });
  const bf = buildZoneField(blobGrid, { marginPx: 40 });
  const cut = Math.round(0.18 * 255);
  const bruteSdf = (gx, gy) => {
    const inside = blobGrid.data[gy * 40 + gx] >= cut;
    let best = Infinity;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 40; x++) {
        if (blobGrid.data[y * 40 + x] >= cut === inside) continue;
        best = Math.min(best, Math.hypot(x - gx, y - gy));
      }
    }
    return inside ? best - 0.5 : -(best - 0.5);
  };
  // field cell (i,j) corresponds to grid cell (x0+i, y0+j); recover x0/y0 from the origin
  const x0 = Math.round((bf.originX - blobGrid.spec.x) / 8);
  const y0 = Math.round((bf.originY - blobGrid.spec.y) / 8);
  let worst = 0;
  for (let j = 0; j < bf.rows; j++) {
    for (let i = 0; i < bf.cols; i++) {
      const gx = x0 + i;
      const gy = y0 + j;
      const got = bf.cells[(j * bf.cols + i) * ZONE_CELL_STRIDE + 1] / 8;
      const want = bruteSdf(gx, gy);
      // outside values are capped at twice the margin; compare only where uncapped
      if (want > -((40 * 2) / 8 + 3)) worst = Math.max(worst, Math.abs(got - want));
    }
  }
  t.ok(`signed distance equals brute-force Euclid (worst error ${worst.toExponential(2)} cells)`, worst < 1e-3);
  t.ok('the blobby shape splits into its 3 painted components', bf.zones.length === 3);

  // ---- non-square texels keep world alignment --------------------------------------------------
  const wide = makeGrid({ w: 20, h: 20, texelW: 10, texelH: 12.5, x: 50, y: 70, paint: disc(10, 10, 3) });
  const wf = buildZoneField(wide, { marginPx: 30 });
  const atPaint = sampleZoneField(wf, 50 + 10.5 * 10, 70 + 10.5 * 12.5);
  t.ok(
    'a non-square grid still reads its own paint at the right world point',
    atPaint.coverage > 0.99 && atPaint.distance > 0
  );
  const atEmpty = sampleZoneField(wf, 50 + 2 * 10, 70 + 2 * 12.5);
  t.ok('…and reads empty where it is empty', atEmpty.coverage === 0 && atEmpty.distance < 0);

  // ---- zones, areas, centroids -----------------------------------------------------------------
  const two = makeGrid({
    w: 80,
    h: 40,
    texelW: 10,
    texelH: 10,
    paint: (x, y) => (disc(15, 20, 5)(x, y) || disc(55, 20, 12)(x, y) ? 255 : 0),
  });
  const tf = buildZoneField(two, { marginPx: 50 });
  t.ok('two separate blobs are two zones', tf.zones.length === 2);
  const [za, zb] =
    tf.zones[0].centroid.x < tf.zones[1].centroid.x ? [tf.zones[0], tf.zones[1]] : [tf.zones[1], tf.zones[0]];
  t.ok('the bigger blob reports the bigger area', zb.areaPx2 > za.areaPx2 * 3);
  t.ok('centroids land at the blobs', Math.abs(za.centroid.x - 155) < 15 && Math.abs(zb.centroid.x - 555) < 15);
  t.ok('maxDepth ≈ the radius', Math.abs(zb.maxDepthPx - 120) < 15);

  // ---- population allocation -------------------------------------------------------------------
  const zones = [
    { index: 0, areaPx2: 40000 },
    { index: 1, areaPx2: 160000 },
  ];
  const flat = allocateZonePopulation(zones, { perZone: 10, areaScaling: 0 });
  t.ok('areaScaling 0 = V2: every zone gets the same count', flat.counts[0] === 10 && flat.counts[1] === 10);
  const prop = allocateZonePopulation(zones, { perZone: 10, areaScaling: 1 });
  t.ok('areaScaling 1 = proportional to area', prop.counts[0] === 10 && prop.counts[1] === 40);
  const half = allocateZonePopulation(zones, { perZone: 10, areaScaling: 0.5 });
  t.ok('areaScaling blends between the two', half.counts[1] > 10 && half.counts[1] < 40);
  t.ok('total is the sum of counts', prop.total === 50 && prop.slotZone.length === 50);
  t.ok(
    'slots are dealt ROUND-ROBIN (first slots alternate zones)',
    prop.slotZone[0] === 0 && prop.slotZone[1] === 1 && prop.slotZone[2] === 0 && prop.slotZone[3] === 1
  );
  const tail = Array.from(prop.slotZone.slice(20));
  t.ok(
    'once a small zone runs out the big one keeps going',
    tail.every((z) => z === 1)
  );
  const capped = allocateZonePopulation(zones, { perZone: 10, areaScaling: 1, capacity: 30 });
  t.ok('capacity is a hard ceiling', capped.total === 30);
  t.ok('…and the larger zone keeps the larger share', capped.counts[1] > capped.counts[0]);
  t.ok('perZone 0 → nobody', allocateZonePopulation(zones, { perZone: 0 }).total === 0);
  t.ok('no zones → nobody', allocateZonePopulation([], { perZone: 10 }).total === 0);
  const prefix = (n) => Array.from(prop.slotZone.slice(0, n)).filter((z) => z === 0).length;
  t.ok(
    'thinning by showing the first N slots thins BOTH zones (the twilight fade)',
    prefix(10) >= 4 && 10 - prefix(10) >= 4
  );
  const clone = allocateZonePopulation(zones, { perZone: 10, areaScaling: 1 });
  t.ok('allocation is deterministic', Array.from(clone.slotZone).join() === Array.from(prop.slotZone).join());

  // ---- homes -----------------------------------------------------------------------------------
  const pop = allocateZonePopulation(tf.zones, { perZone: 12, areaScaling: 0.5, refAreaPx2: 30000 });
  const homes = pickSlotHomes(tf, pop);
  t.ok('homes buffer has one record per slot', homes.length === pop.total * ZONE_HOME_STRIDE);
  let inZone = 0;
  for (let s = 0; s < pop.total; s++) {
    const hx = homes[s * ZONE_HOME_STRIDE];
    const hy = homes[s * ZONE_HOME_STRIDE + 1];
    const sample = sampleZoneField(tf, hx, hy);
    // the home must be inside the zone this slot was DEALT, not merely inside some zone: the zone's own
    // bounds (padded by a cell for the jitter) are the check that tells two blobs apart
    const b = tf.zones[pop.slotZone[s]].bounds;
    const within =
      hx >= b.minX - tf.cellW && hx <= b.maxX + tf.cellW && hy >= b.minY - tf.cellH && hy <= b.maxY + tf.cellH;
    if (within && sample.distance > -tf.cellW) inZone++;
  }
  t.ok(`every home sits inside (or on the rim of) its own zone (${inZone}/${pop.total})`, inZone === pop.total);
  t.ok(
    'without stamps the record carries 0 in its stamp slot, and the zone area in its last',
    Array.from({ length: pop.total }, (_, k) => k).every(
      (k) =>
        homes[k * ZONE_HOME_STRIDE + 2] === 0 && homes[k * ZONE_HOME_STRIDE + 3] === tf.zones[pop.slotZone[k]].areaPx2
    )
  );
  t.ok('homes are deterministic', Array.from(pickSlotHomes(tf, pop)).join() === Array.from(homes).join());
  // Z-order stratification: 4 homes in one square zone land in 4 different quadrants
  const sq = buildZoneField(
    makeGrid({
      w: 40,
      h: 40,
      texelW: 10,
      texelH: 10,
      paint: (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? 255 : 0),
    }),
    { marginPx: 30 }
  );
  const sqPop = allocateZonePopulation(sq.zones, { perZone: 4, areaScaling: 0 });
  const sqHomes = pickSlotHomes(sq, sqPop);
  const quadrants = new Set();
  for (let s = 0; s < 4; s++) {
    quadrants.add((sqHomes[s * 4] > 200 ? 1 : 0) + (sqHomes[s * 4 + 1] > 200 ? 2 : 0));
  }
  t.ok('four homes in one square cover all four quadrants (Z-order spread)', quadrants.size === 4);

  // ---- packing ---------------------------------------------------------------------------------
  const maxCells = tf.cols * tf.rows + 10;
  const flies = 64;
  const backing = new Float32Array(zoneBufferElementCount(maxCells, [flies]) * 4).fill(7);
  const r = packZoneBuffer(backing, tf, maxCells, [{ offset: maxCells, capacity: flies, homes }]);
  t.ok('pack reports the cells it wrote', r.cellsWritten === tf.cols * tf.rows && r.truncated === false);
  t.ok(
    'cells land at the front of the buffer',
    backing[0] === tf.cells[0] && backing[4 * 5 + 1] === tf.cells[4 * 5 + 1]
  );
  t.ok('the cell tail past the field is zeroed (stale data cleared)', backing[maxCells * 4 - 1] === 0);
  t.ok(
    'homes land at their section offset',
    backing[maxCells * 4] === homes[0] && backing[maxCells * 4 + 1] === homes[1]
  );
  t.ok('slots past the population are zeroed', backing[(maxCells + pop.total) * 4] === 0);
  const tiny = packZoneBuffer(backing, tf, 4, [{ offset: 4, capacity: 1, homes: null }]);
  t.ok(
    'a field bigger than the buffer is reported as truncated, never written',
    tiny.truncated === true && tiny.cellsWritten === 0
  );
  packZoneBuffer(backing, null, maxCells, [{ offset: maxCells, capacity: flies, homes: null }]);
  t.ok('a null field clears the buffer', backing[0] === 0 && backing[maxCells * 4] === 0);

  // ---- the allocator keeps its promises --------------------------------------------------------
  {
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i, areaPx2: 40000 }));
    const squeezed = allocateZonePopulation(many, { perZone: 100, areaScaling: 0, capacity: 100 });
    t.ok('capacity binds exactly', squeezed.total === 100);
    t.ok(
      'forty blobs and a hundred slots: every blob still has company',
      Array.from(squeezed.counts).every((c) => c >= 1 && c <= 3)
    );

    // [1, 1, 24] wants 26 slots from 10: proportional thinning empties the two small zones, and the floor
    // takes their one agent each from the fullest zone, not from nowhere
    const lopsided = [
      { index: 0, areaPx2: 10000 },
      { index: 1, areaPx2: 10000 },
      { index: 2, areaPx2: 240000 },
    ];
    const lop = allocateZonePopulation(lopsided, { perZone: 4, areaScaling: 1, capacity: 10 });
    t.ok(
      'the floor of one survives the thinning, paid for by the fullest zone',
      Array.from(lop.counts).join() === '1,1,8' && lop.total === 10
    );

    const crowded = Array.from({ length: 12 }, (_, i) => ({ index: i, areaPx2: 40000 * (i + 1) }));
    const crowd = allocateZonePopulation(crowded, { perZone: 10, areaScaling: 1, capacity: 5 });
    t.ok(
      'more blobs than slots: the budget is spent, never exceeded, and no count goes negative',
      crowd.total === 5 && Array.from(crowd.counts).every((c) => c >= 0) && crowd.counts.some((c) => c === 0)
    );
    t.ok(
      '…and it goes to the biggest zones',
      Array.from(crowd.counts.slice(0, 6)).every((c) => c === 0) && crowd.counts[11] >= 1
    );
  }

  // ---- a zone that runs to the edge of the map still has a rim ---------------------------------
  {
    const edgeGrid = makeGrid({ w: 30, h: 30, texelW: 10, texelH: 10, paint: (x, y) => (x < 12 && y < 12 ? 255 : 0) });
    const ef = buildZoneField(edgeGrid, { marginPx: 200 });
    t.ok(
      `the field extends ${ZONE_EDGE_CELLS} virtual cells past the grid on every side`,
      ef.originX === -ZONE_EDGE_CELLS * 10 &&
        ef.originY === -ZONE_EDGE_CELLS * 10 &&
        ef.cols === 30 + 2 * ZONE_EDGE_CELLS
    );
    const atCorner = sampleZoneField(ef, 5, 5);
    t.ok(
      `the corner cell is inside by half a cell, not buried (distance ${atCorner.distance.toFixed(1)})`,
      atCorner.distance > 0 && atCorner.distance < 16
    );
    t.ok(
      `…and its gradient points INTO the zone (${atCorner.gradX.toFixed(2)}, ${atCorner.gradY.toFixed(2)}) — it used to point off the map`,
      atCorner.gradX > 0.4 && atCorner.gradY > 0.4
    );
    const offMap = sampleZoneField(ef, -15, -15);
    t.ok(
      'past the map edge the zone is outside, and the way in is back across it',
      offMap.distance < 0 && offMap.gradX > 0.4 && offMap.gradY > 0.4
    );
    t.ok('the virtual cells carry no coverage', offMap.coverage === 0);

    // a grid painted solid has no interior ridge at the border any more: its gradient is a direction almost everywhere
    const solid = makeGrid({ w: 40, h: 40, texelW: 10, texelH: 10, paint: () => 255 });
    const sf = buildZoneField(solid, { marginPx: 100 });
    let directed = 0;
    for (let i = 0; i < sf.cols * sf.rows; i++) {
      const gx = sf.cells[i * ZONE_CELL_STRIDE + 2];
      const gy = sf.cells[i * ZONE_CELL_STRIDE + 3];
      if (Math.abs(Math.hypot(gx, gy) - 1) < 1e-4) directed++;
    }
    t.ok(
      `a fully painted grid has a unit gradient in ${directed} of ${sf.cols * sf.rows} cells (it had none)`,
      directed / (sf.cols * sf.rows) > 0.9
    );
    const inward = sampleZoneField(sf, 3, 200);
    t.ok('at the left border of a solid grid the way in is +x', inward.distance > 0 && inward.gradX > 0.9);
    const full = buildZoneField(makeGrid({ w: 512, h: 512, texelW: 20, texelH: 20, paint: () => 255 }), {
      marginPx: 128,
    });
    t.ok(
      `a full 512² grid fills the zone buffer's budget exactly (${full.cols}×${full.rows})`,
      full.cols * full.rows === ZONE_FIELD_CELLS_MAX && ZONE_FIELD_CELLS_MAX === 516 * 516
    );
  }

  // ---- a home changes hands: the stamp ---------------------------------------------------------
  {
    const stamper = createSlotStamper(64);
    const lopsided = [
      { index: 0, areaPx2: 40000 },
      { index: 1, areaPx2: 90000 },
    ];
    const deal = (perZone) => allocateZonePopulation(lopsided, { perZone, areaScaling: 1, refAreaPx2: 40000 });
    const first = deal(4);
    const a = stamper.stamp(first);
    t.ok(
      'the first deal stamps every slot (nothing was dealt before), with a value that is not 0',
      a.changed === first.total && Array.from(a.stamps).every((v) => v > 0 && v < 1)
    );
    t.ok(
      'stamps are whole steps of 1/STAMP_STEPS, so they survive a float32 trip through the seed exactly',
      Array.from(a.stamps).every((v) => Number.isInteger(v * STAMP_STEPS) && Math.fround(2049 + v) - 2049 === v)
    );
    const again = stamper.stamp(deal(4));
    t.ok(
      'dealing the same population again changes nothing',
      again.changed === 0 && Array.from(again.stamps).join() === Array.from(a.stamps).join()
    );

    const second = deal(6);
    const b = stamper.stamp(second);
    let moved = 0;
    let movedRight = true;
    for (let s = 0; s < Math.min(first.total, second.total); s++) {
      const changedZone = first.slotZone[s] !== second.slotZone[s];
      if (changedZone) moved++;
      // a stamp differs exactly when the slot's zone differs
      if (changedZone !== (b.stamps[s] !== a.stamps[s])) movedRight = false;
    }
    t.ok(`this re-deal moves ${moved} of ${first.total} slots to another zone — enough to matter`, moved >= 2);
    t.ok('…and exactly those slots get a new stamp (the rest keep theirs and carry on)', movedRight);
    t.ok(
      'slots that are new in this deal are stamped too',
      second.total > first.total && Array.from(b.stamps.slice(first.total)).every((v) => v > 0)
    );

    // shrink to nothing, grow back: every slot is a newcomer again
    const empty = stamper.stamp(allocateZonePopulation(lopsided, { perZone: 0 }));
    t.ok('a zero head-count stamps nothing', empty.stamps.length === 0);
    const back = stamper.stamp(deal(6));
    t.ok(
      'coming back from zero re-stamps every slot (a slot out of play has no position worth keeping)',
      back.changed === second.total && Array.from(back.stamps).every((v, s) => v !== b.stamps[s])
    );

    // a slot is bumped once per change, and the counter wraps without ever returning to 0
    const solo = createSlotStamper(1);
    const seen = new Set();
    let zero = false;
    for (let k = 0; k < 3 * STAMP_STEPS; k++) {
      // the slot alternates between zone 0 and zone 1, so every call is one change
      const v = solo.stamp({ total: 1, slotZone: Int32Array.of(k % 2) }).stamps[0];
      if (v === 0) zero = true;
      seen.add(v);
    }
    t.ok('the stamp cycles through every non-zero step and never lands on 0', !zero && seen.size === STAMP_STEPS - 1);

    // homes carry the stamp in their third float
    const field = buildZoneField(
      makeGrid({
        w: 40,
        h: 20,
        texelW: 10,
        texelH: 10,
        paint: (x, y) => (disc(8, 10, 5)(x, y) || disc(30, 10, 7)(x, y) ? 255 : 0),
      }),
      { marginPx: 30 }
    );
    const pop = allocateZonePopulation(field.zones, { perZone: 3, areaScaling: 0 });
    const st = createSlotStamper(16).stamp(pop);
    const stamped = pickSlotHomes(field, pop, st.stamps);
    t.ok(
      'pickSlotHomes writes each slot’s stamp into its record',
      Array.from({ length: pop.total }, (_, k) => k).every((k) => stamped[k * ZONE_HOME_STRIDE + 2] === st.stamps[k])
    );
  }

  // ---- signature -------------------------------------------------------------------------------
  const s0 = zoneGridSignature(grid);
  t.ok('signature of nothing is 0', zoneGridSignature(null) === 0);
  t.ok('signature is stable', zoneGridSignature(grid) === s0);
  const poked = { spec: grid.spec, data: Uint8Array.from(grid.data) };
  poked.data[5] ^= 1;
  t.ok('a single byte of paint changes the signature', zoneGridSignature(poked) !== s0);
  t.ok(
    'the build options are part of the field signature',
    buildZoneField(grid, { marginPx: 60 }).signature !== buildZoneField(grid, { marginPx: 90 }).signature
  );
}
