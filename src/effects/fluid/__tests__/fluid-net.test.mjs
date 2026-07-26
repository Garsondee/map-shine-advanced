/**
 * Node verification for effects/fluid/fluid-net.js — THE TUBE NET.
 *
 * ============================================================================
 * WHY THIS SUITE IS THE PHASE'S REAL DELIVERABLE
 * ============================================================================
 * A wrong arc length does not crash and does not look broken. It produces goo
 * that flows at a slightly odd speed, or from the wrong end, over a smooth and
 * entirely plausible field — `feedback_smooth_output_hides_ported_bugs`, which
 * this project has now paid for twice. Water's own jump flood shipped a bug of
 * exactly this shape (it understated distance near the map border by up to 2√2
 * texels) and the ONLY instrument that could see it was a brute-force
 * comparison in Node.
 *
 * So `geodesic matches brute force` below is not a smoke test. It runs a
 * SECOND, DELIBERATELY DIFFERENT Dijkstra — linear-scan O(V²), no heap, no
 * shared code — against the shipping one on every fixture. A bug in the heap,
 * the neighbour table, or the step costs shows up as a numeric disagreement
 * rather than as a map that looks a bit off in three months.
 */
import {
  extractTubeNet,
  geodesicFrom,
  labelComponents,
  chamferRadius,
  interiorness,
  weightedCorrelation,
  fillEmptyBins,
  FLUID_HINT_MIN_CORRELATION,
} from '../fluid-net.js';

const TEXEL = 10;

/** @returns {{spec: object, data: Uint8Array}} */
function makeGrid(w, h, texelW = TEXEL, texelH = TEXEL) {
  return {
    spec: { x: 0, y: 0, width: w * texelW, height: h * texelH, w, h, texelW, texelH },
    data: new Uint8Array(w * h),
  };
}

/** Paint an inclusive rect with a constant byte. */
function rect(grid, x0, y0, x1, y1, value = 255) {
  const { w } = grid.spec;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid.data[y * w + x] = value;
}

/** Paint an inclusive rect with a left→right bright→dim ramp over [x0,x1]. */
function rampX(grid, x0, y0, x1, y1, hi = 255, lo = 35) {
  const { w } = grid.spec;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      grid.data[y * w + x] = Math.round(hi - f * (hi - lo));
    }
  }
}

/**
 * THE INDEPENDENT IMPLEMENTATION. Plain Dijkstra with a linear scan for the
 * minimum — O(V²), no priority queue, no shared helper, written out separately
 * on purpose. If this and `geodesicFrom` agree to 1e-9 on every fixture, both
 * are almost certainly right; if they disagree, one of them is definitely
 * wrong and the diff says where.
 */
function bruteForceGeodesic(present, tubeId, label, source, w, h, texelW, texelH) {
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const diag = Math.sqrt(texelW * texelW + texelH * texelH);
  dist[source] = 0;
  for (;;) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i] || !present[i] || tubeId[i] !== label) continue;
      if (dist[i] < bestD) {
        bestD = dist[i];
        best = i;
      }
    }
    if (best < 0 || bestD === Infinity) break;
    done[best] = 1;
    const x = best % w;
    const y = (best - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!present[j] || tubeId[j] !== label) continue;
        const step = dx !== 0 && dy !== 0 ? diag : dx !== 0 ? texelW : texelH;
        if (bestD + step < dist[j]) dist[j] = bestD + step;
      }
    }
  }
  return dist;
}

/** Presence + labels for a grid, the way extractTubeNet derives them. */
function presenceAndLabels(grid) {
  const { w, h } = grid.spec;
  const present = new Uint8Array(w * h);
  for (let i = 0; i < present.length; i++) present[i] = grid.data[i] >= 1 ? 1 : 0;
  const { tubeId } = labelComponents(present, w, h);
  return { present, tubeId };
}

const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/**
 * A stand-in with every field present and inert, handed back when the expected
 * tube is missing.
 *
 * Reaching for `net.tubes[0]` unguarded turns a real regression into
 * `TypeError: Cannot read properties of undefined`, which names nothing and
 * kills the remaining suites in the same process. That is not hypothetical: it
 * is what this file did when the extractor was deliberately sabotaged to
 * 4-connectivity, and the whole point of the diagonal fixture is to make THAT
 * failure legible. A test that crashes instead of reporting is an instrument
 * that lies by omission.
 */
const BLANK_TUBE = Object.freeze({
  id: -1,
  row: -1,
  texelCount: -1,
  lengthPx: -1,
  rootTexel: -1,
  tipTexel: -1,
  orientedBy: 'missing',
  hintCorrelation: NaN,
  binAreaProfile: new Float64Array(1),
  crossSectionProfile: new Float64Array(1),
  radiusProfile: new Float64Array(1),
  maxRadiusPx: -1,
  filledBins: -1,
  offPathFraction: -1,
});

/** @returns {typeof BLANK_TUBE} the tube at `index`, or a blank that fails loudly. */
function tubeAt(t, net, index, label) {
  const tube = net.tubes[index];
  t.ok(`${label}: tube ${index} exists (got ${net.tubeCount} tube(s))`, Boolean(tube));
  return tube ?? BLANK_TUBE;
}

export function run(t) {
  const { ok, throws } = t;

  // ── The straight tube: every headline number, by hand ────────────────────
  {
    const g = makeGrid(40, 12);
    rampX(g, 2, 5, 37, 7); // 3 rows tall, 36 columns, bright at x=2
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });

    ok('straight: one tube', net.tubeCount === 1);
    ok('straight: no warnings', net.warnings.length === 0);

    const tube = tubeAt(t, net, 0, 'straight');
    ok('straight: 108 texels (3 rows x 36 cols)', tube.texelCount === 108);

    // Corner (2,5) to corner (37,7): 33 orthogonal steps + 2 diagonal.
    const expected = 33 * TEXEL + 2 * Math.hypot(TEXEL, TEXEL);
    ok(`straight: lengthPx is ${expected.toFixed(2)}`, approx(tube.lengthPx, expected, 1e-6));

    ok('straight: oriented by the painted hint', tube.orientedBy === 'hint');
    ok('straight: a clean ramp correlates near -1', tube.hintCorrelation < -0.98);
    ok('straight: root is the BRIGHT end (x=2)', tube.rootTexel % 40 === 2);
    ok('straight: tip is the dim end (x=37)', tube.tipTexel % 40 === 37);

    // The half-texel correction in chamferRadius is what makes this exact.
    ok('straight: maxRadiusPx is the true half-width (15)', approx(tube.maxRadiusPx, 15, 1e-9));

    // CONSERVATION. Every texel's area lands in exactly one bin, once.
    const areaSum = tube.binAreaProfile.reduce((a, b) => a + b, 0);
    ok('straight: binArea sums to texelCount x texelArea', approx(areaSum, 108 * TEXEL * TEXEL, 1e-6));

    // The cross-check between two quantities derived different ways.
    const mid = 8;
    ok(
      'straight: crossSection ~= 2 x radius at mid-tube',
      Math.abs(tube.crossSectionProfile[mid] - 2 * tube.radiusProfile[mid]) < 0.12 * 2 * tube.radiusProfile[mid]
    );
    ok('straight: crossSection ~= the painted 30px width', Math.abs(tube.crossSectionProfile[mid] - 30) < 3);

    ok('straight: no empty bins to fill', tube.filledBins === 0);
    ok('straight: nothing off the corridor', tube.offPathFraction === 0);

    // s spans the full range and is 0 at the root.
    ok('straight: s at the root is 0', net.sByTexel[tube.rootTexel] === 0);
    ok('straight: s at the tip is 1', approx(net.sByTexel[tube.tipTexel], 1, 1e-6));
  }

  // ── The geodesic vs brute force, on every fixture shape ──────────────────
  {
    /** @type {{name: string, grid: object}[]} */
    const fixtures = [];

    {
      const g = makeGrid(40, 12);
      rect(g, 2, 5, 37, 7);
      fixtures.push({ name: 'straight', grid: g });
    }

    // U-BEND — the fixture that separates geodesic from Euclidean. The two tips
    // sit 11 texels apart in a straight line and 22 texels apart along the tube.
    {
      const g = makeGrid(20, 12);
      rect(g, 2, 2, 3, 8);
      rect(g, 12, 2, 13, 8);
      rect(g, 2, 7, 13, 8);
      fixtures.push({ name: 'u-bend', grid: g });
    }

    // Y-JUNCTION — a stem with two arms.
    {
      const g = makeGrid(24, 20);
      rect(g, 11, 10, 12, 18);
      rect(g, 4, 8, 12, 9);
      rect(g, 12, 8, 20, 9);
      fixtures.push({ name: 'y-junction', grid: g });
    }

    // DIAGONAL, one texel wide — 19 separate components under 4-connectivity.
    {
      const g = makeGrid(26, 26);
      for (let i = 2; i <= 20; i++) g.data[i * 26 + i] = 200;
      fixtures.push({ name: 'diagonal-1px', grid: g });
    }

    // BULB — a straight tube with a reservoir on one end.
    {
      const g = makeGrid(40, 16);
      rect(g, 8, 7, 35, 8);
      rect(g, 2, 5, 8, 11);
      fixtures.push({ name: 'bulbed', grid: g });
    }

    for (const { name, grid } of fixtures) {
      const { w, h, texelW, texelH } = grid.spec;
      const { present, tubeId } = presenceAndLabels(grid);
      let source = -1;
      for (let i = 0; i < present.length && source < 0; i++) if (tubeId[i] === 1) source = i;

      const mine = geodesicFrom({ present, tubeId, label: 1, source, w, h, texelW, texelH });
      const theirs = bruteForceGeodesic(present, tubeId, 1, source, w, h, texelW, texelH);

      let worst = 0;
      let checked = 0;
      for (let i = 0; i < present.length; i++) {
        if (tubeId[i] !== 1) continue;
        checked++;
        worst = Math.max(worst, Math.abs(mine.dist[i] - theirs[i]));
      }
      ok(`${name}: brute force agrees on every texel (max diff ${worst.toExponential(1)})`, worst < 1e-9);
      ok(`${name}: the sweep actually visited texels`, checked > 4);
    }
  }

  // ── The U-bend must go AROUND, never across ─────────────────────────────
  // The fixture is deliberately DEEP: the two open tips sit ~11 texels apart in
  // a straight line but ~40 apart along the tube, so a Euclidean or a
  // corner-cutting distance would be off by more than 3x and no tolerance
  // choice could hide it.
  {
    const g = makeGrid(20, 22);
    rect(g, 2, 2, 3, 18);
    rect(g, 12, 2, 13, 18);
    rect(g, 2, 17, 13, 18);
    const net = extractTubeNet({ grid: g, samplesPerTube: 32 });

    ok('u-bend: still one connected tube', net.tubeCount === 1);
    const tube = tubeAt(t, net, 0, 'u-bend');
    const rx = tube.rootTexel % 20;
    const ry = Math.floor(tube.rootTexel / 20);
    const tx = tube.tipTexel % 20;
    const ty = Math.floor(tube.tipTexel / 20);
    const euclid = Math.hypot(rx - tx, ry - ty) * TEXEL;
    ok('u-bend: the two tips are the two open ends (both near the top)', ry <= 3 && ty <= 3);
    ok(
      `u-bend: geodesic (${tube.lengthPx.toFixed(0)}) is far longer than euclidean (${euclid.toFixed(0)})`,
      tube.lengthPx > euclid * 3
    );
    // s must climb DOWN one leg and UP the other, so the midpoint of the arc
    // lands in the bottom bar — not across the empty middle.
    let midY = 0;
    let midN = 0;
    for (let i = 0; i < net.sByTexel.length; i++) {
      if (net.tubeIdByTexel[i] !== 1) continue;
      const s = net.sByTexel[i];
      if (s > 0.45 && s < 0.55) {
        midY += Math.floor(i / 20);
        midN++;
      }
    }
    ok('u-bend: arc-length midpoint is in the BOTTOM bar, not across the gap', midN > 0 && midY / midN > 14);
  }

  // ── The diagonal tube: 8-connectivity is load-bearing ────────────────────
  {
    const g = makeGrid(26, 26);
    for (let i = 2; i <= 20; i++) g.data[i * 26 + i] = 200;
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });

    ok('diagonal: ONE tube, not 19 speckles (8-connectivity)', net.tubeCount === 1);
    const tube = tubeAt(t, net, 0, 'diagonal');
    ok('diagonal: all 19 texels kept', tube.texelCount === 19);
    const expected = 18 * Math.hypot(TEXEL, TEXEL);
    ok(`diagonal: length is 18 diagonal steps (${expected.toFixed(1)})`, approx(tube.lengthPx, expected, 1e-6));
    ok('diagonal: flat paint gives no usable hint', tube.orientedBy === 'geometry');
  }

  // ── The bulb: cross-section really is bigger there ───────────────────────
  {
    const g = makeGrid(40, 16);
    rect(g, 8, 7, 35, 8); // 2-texel-wide stem
    rect(g, 2, 5, 8, 11); // 7x7 bulb at the low-x end
    const net = extractTubeNet({ grid: g, samplesPerTube: 24 });
    const tube = tubeAt(t, net, 0, 'bulb');

    // Whichever end the geometry picked as the root, the bulb is at one of them.
    const first = tube.crossSectionProfile[1];
    const last = tube.crossSectionProfile[22];
    const bulbEnd = Math.max(first, last);
    const stemEnd = Math.min(first, last);
    ok(
      `bulb: cross-section at the bulb (${bulbEnd.toFixed(0)}) exceeds the stem (${stemEnd.toFixed(0)})`,
      bulbEnd > stemEnd * 1.8
    );
    ok('bulb: max radius reflects the wide end', tube.maxRadiusPx > 25);
    ok('bulb: some texels sit off the root-tip corridor', tube.offPathFraction > 0);
  }

  // ── Orientation: the hint decides, and a REVERSED ramp flips it ──────────
  {
    const g = makeGrid(40, 10);
    // Bright at the RIGHT this time: the root must move to x=37.
    const { w } = g.spec;
    for (let y = 4; y <= 6; y++) {
      for (let x = 2; x <= 37; x++) {
        const f = (x - 2) / 35;
        g.data[y * w + x] = Math.round(35 + f * 220);
      }
    }
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });
    const tube = tubeAt(t, net, 0, 'reversed hint');
    ok('reversed hint: oriented by the hint', tube.orientedBy === 'hint');
    ok('reversed hint: root moved to the BRIGHT (right) end', tube.rootTexel % 40 === 37);
    ok(
      'reversed hint: reported correlation is against the FINAL root, so still negative',
      tube.hintCorrelation <= -FLUID_HINT_MIN_CORRELATION
    );
  }

  // ── Orientation: flat paint must NOT fabricate a direction ───────────────
  {
    const g = makeGrid(40, 10);
    rect(g, 2, 4, 37, 6, 180); // uniform — no ramp at all
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });
    const tube = tubeAt(t, net, 0, 'flat hint');
    ok('flat hint: falls back to geometry', tube.orientedBy === 'geometry');
    ok('flat hint: correlation is reported near zero, not invented', Math.abs(tube.hintCorrelation) < 0.05);
    ok('flat hint: still produces a usable arc length', tube.lengthPx > 300);
  }

  // ── Two disjoint tubes are two independent systems ───────────────────────
  {
    const g = makeGrid(40, 20);
    rampX(g, 2, 3, 30, 4);
    rampX(g, 6, 14, 37, 16);
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });
    ok('disjoint: two tubes', net.tubeCount === 2);
    const a = tubeAt(t, net, 0, 'disjoint');
    const b = tubeAt(t, net, 1, 'disjoint');
    ok('disjoint: rows are 0 and 1', a.row === 0 && b.row === 1);
    ok('disjoint: ids are dense 1..n', a.id === 1 && b.id === 2);
    ok('disjoint: different lengths measured independently', a.lengthPx !== b.lengthPx);
    // The larger component must be first — both filters rank by size.
    ok('disjoint: sorted largest first', a.texelCount >= b.texelCount);
  }

  // ── Speckle is dropped AND reported ──────────────────────────────────────
  {
    const g = makeGrid(40, 20);
    rect(g, 2, 3, 30, 5);
    g.data[10 * 40 + 35] = 255; // a lone stray texel
    g.data[12 * 40 + 20] = 255;
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });
    ok('speckle: only the real tube survives', net.tubeCount === 1);
    ok('speckle: two components were dropped', net.dropped.small === 2);
    ok(
      'speckle: a warning says so',
      net.warnings.some((s) => s.includes('speckle'))
    );
    ok('speckle: the stray texel has no tube id', net.tubeIdByTexel[10 * 40 + 35] === 0);
  }

  // ── The cap drops the SMALLEST and says exactly what it lost ─────────────
  {
    const g = makeGrid(40, 40);
    for (let k = 0; k < 5; k++) rect(g, 2, k * 6 + 1, 10 + k * 5, k * 6 + 2);
    const net = extractTubeNet({ grid: g, maxTubes: 3, samplesPerTube: 16 });
    ok('cap: exactly maxTubes kept', net.tubeCount === 3);
    ok('cap: two dropped', net.dropped.overCap === 2);
    ok(
      'cap: the warning names the cap',
      net.warnings.some((s) => s.includes('FLUID_MAX_TUBES'))
    );
    ok(
      'cap: the warning states the texel loss',
      net.warnings.some((s) => /\d+ texels/.test(s))
    );
    ok('cap: kept tubes are the LARGEST', tubeAt(t, net, 0, 'cap').texelCount >= tubeAt(t, net, 2, 'cap').texelCount);
    ok('cap: ids stay dense after dropping', net.tubes.map((x) => x.id).join() === '1,2,3');
  }

  // ── A short tube: gaps are filled, and NOTHING is left at zero ───────────
  {
    const g = makeGrid(20, 10);
    rect(g, 2, 4, 9, 5); // 16 texels into 64 bins
    const net = extractTubeNet({ grid: g, samplesPerTube: 64 });
    const tube = tubeAt(t, net, 0, 'short tube');
    ok('short tube: bins outnumber texels, so gaps exist', tube.filledBins > 0);
    let zeroArea = 0;
    for (const v of tube.binAreaProfile) if (v <= 0) zeroArea++;
    // A zero bin is a division singularity in v = Q/A — the whole reason
    // fillEmptyBins exists.
    ok('short tube: no bin has zero area', zeroArea === 0);
    let zeroCross = 0;
    for (const v of tube.crossSectionProfile) if (v <= 0) zeroCross++;
    ok('short tube: no bin has zero cross-section', zeroCross === 0);
  }

  // ── Anisotropic texels: length must use REAL world distance ──────────────
  {
    const g = makeGrid(20, 20, 10, 40); // texels 4x taller than wide
    rect(g, 2, 5, 17, 5); // one row, 16 texels across
    const net = extractTubeNet({ grid: g, samplesPerTube: 8 });
    const tube = tubeAt(t, net, 0, 'anisotropic');
    ok('anisotropic: horizontal run uses texelW, not a hop count', approx(tube.lengthPx, 15 * 10, 1e-6));
  }

  // ── The pure helpers, directly ───────────────────────────────────────────
  {
    // 4x4 grid, two staggered horizontal runs. idx5 = (1,1); of its eight
    // neighbours only (0,1), (2,1), (1,2) and (2,2) are present.
    const present = new Uint8Array([0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
    const inner = interiorness(present, 4, 4);
    ok('interiorness: counts exactly the present 8-neighbours', inner[5] === 4);
    ok('interiorness: a run-end texel scores lower than its middle', inner[4] === 2 && inner[5] === 4);
    ok('interiorness: absent texels stay 0', inner[0] === 0);
  }
  {
    // A 3x3 grid entirely present, so every absent neighbour is OUT OF BOUNDS —
    // which is exactly the case chamferRadius treats as "not tube", so a tube
    // running off the map edge ends there rather than fabricating width.
    const r = chamferRadius(new Uint8Array(9).fill(1), 3, 3, 10, 10);
    // Centre: nearest absent is two texels out (20px), less the half-texel.
    ok('chamferRadius: centre is 15px from the boundary', approx(r[4], 15, 1e-9));
    // Corner: nearest absent is one texel out (10px), less the half-texel.
    ok('chamferRadius: a corner is 5px from the boundary', approx(r[0], 5, 1e-9));
  }
  {
    ok(
      'correlation: perfectly opposed is -1',
      approx(weightedCorrelation([1, 0.5, 0], [0, 1, 2], [1, 1, 1]), -1, 1e-9)
    );
    ok('correlation: no variance returns 0, never NaN', weightedCorrelation([1, 1, 1], [0, 1, 2], [1, 1, 1]) === 0);
    ok('correlation: zero weight returns 0', weightedCorrelation([1, 0], [0, 1], [0, 0]) === 0);
  }
  {
    const area = new Float64Array([0, 5, 0, 0, 9, 0]);
    const rad = new Float64Array([0, 2, 0, 0, 3, 0]);
    const pop = new Uint8Array([0, 1, 0, 0, 1, 0]);
    const filled = fillEmptyBins(area, rad, pop);
    ok('fillEmptyBins: reports every bin it filled', filled === 4);
    ok('fillEmptyBins: leading gap takes the first populated value', area[0] === 5);
    ok('fillEmptyBins: nearest wins on the left of the midpoint', area[2] === 5);
    ok('fillEmptyBins: nearest wins on the right of the midpoint', area[3] === 9);
    ok('fillEmptyBins: trailing gap takes the last populated value', area[5] === 9);
    ok('fillEmptyBins: radius is filled from the same source', rad[3] === 3);
  }

  // ── An empty mask is "no tubes", not a crash ─────────────────────────────
  {
    const net = extractTubeNet({ grid: makeGrid(16, 16), samplesPerTube: 8 });
    ok('empty mask: zero tubes', net.tubeCount === 0);
    ok('empty mask: no warnings (nothing was lost)', net.warnings.length === 0);
    ok('empty mask: tubes array is empty, not null', Array.isArray(net.tubes) && net.tubes.length === 0);
  }

  // ── A missing grid is a WIRING fault and must be loud ────────────────────
  throws('no grid: throws rather than reporting "no tubes"', () => extractTubeNet({}), 'MaskGrid');
  throws('null grid: throws too', () => extractTubeNet({ grid: null }), 'MaskGrid');
}
