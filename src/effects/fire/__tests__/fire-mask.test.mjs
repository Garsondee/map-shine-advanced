/**
 * fire-mask.test.mjs — THE PAINTED REGION BECOMES FIRES.
 *
 * The case that drives the whole design is the one an area-based
 * implementation gets wrong: a thin painted LINE along a burning wall has a
 * large area and a small width, so `2·√(area/π)` turns it into one enormous
 * slow-pulsing bonfire instead of the row of small fast flames it looks like.
 * The distance-transform tests below pin exactly that.
 */
import { chamferDistance, extractFiresFromMask, extractFiresWithLabels, fireMaskSignature } from '../fire-mask.js';

/** Build a MaskGrid from an ASCII picture. `#` = painted, `.` = not. */
function gridFrom(rows, { texel = 10, x = 0, y = 0 } = {}) {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      data[r * w + c] = ch === '#' ? 255 : ch === '+' ? 140 : 0;
    }
  }
  return {
    spec: { x, y, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel },
    data,
  };
}

/** Like `gridFrom`, but `o` paints a value between the SPAWN and PAINT
 * thresholds (the antialiased-fringe band `propagateLabels` exists for)
 * instead of `gridFrom`'s fixed `+` = 140. */
function labeledGrid(rows, { solid = 255, ring = 50, texel = 20 } = {}) {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      data[r * w + c] = ch === '#' ? solid : ch === 'o' ? ring : 0;
    }
  }
  return { spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel }, data };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

export function run(t) {
  // ── THE DISTANCE TRANSFORM ─────────────────────────────────────────────────

  {
    const g = gridFrom(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    const d = chamferDistance(g.data, g.spec.w, g.spec.h);
    t.ok('unpainted texels are at distance zero', d[0] === 0);
    // The centre of a 5×5 block is 3 texels from the outside (2 painted
    // neighbours plus the step onto the unpainted one).
    const centre = d[3 * 7 + 3];
    t.ok(`the block centre is the widest point (${centre.toFixed(2)})`, centre > 2.5 && centre < 3.5);
    // An edge texel of the block is one step from unpainted.
    t.ok('a border texel is one step out', near(d[1 * 7 + 1], 1, 0.5));
    t.ok('distance is highest at the centre', centre > d[1 * 7 + 1]);
  }

  {
    // ⚠️ THE BORDER COUNTS AS UNPAINTED. A region running off the grid edge
    // would otherwise measure as infinitely wide there and mint one absurd fire
    // pinned to the map boundary.
    const g = gridFrom(['####', '####', '####', '####']);
    const d = chamferDistance(g.data, 4, 4);
    t.ok(
      'a fully-painted grid still has finite distances',
      d.every((v) => Number.isFinite(v) && v < 10)
    );
    t.ok('...and the widest point is interior', Math.max(...d) <= 2.5);
  }

  {
    const empty = gridFrom(['....', '....']);
    const d = chamferDistance(empty.data, 4, 2);
    t.ok(
      'an unpainted grid is all zeros',
      d.every((v) => v === 0)
    );
  }

  // ── BLOBS ──────────────────────────────────────────────────────────────────

  {
    // One compact blob → exactly one fire, at its centre, sized by its width.
    const g = gridFrom(
      ['..........', '..######..', '..######..', '..######..', '..######..', '..######..', '..######..', '..........'],
      { texel: 20 }
    );
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok(`a single blob yields one fire (got ${fires.length})`, fires.length === 1);
    const f = fires[0];
    // Blob spans texels 2..7 in x (centre 5.0 in texel coords → world 100) and
    // rows 1..6 (centre 3.5+0.5 → world 80).
    t.ok(
      `the fire is at the blob centre (${Math.round(f.x)}, ${Math.round(f.y)})`,
      near(f.x, 100, 25) && near(f.y, 80, 25)
    );
    // 6 texels wide × 20 px = 120 px across; the inscribed diameter is ~3 texels
    // × 2 × 20 = a bit under that, which is correct for "how wide is it here".
    t.ok(
      `the diameter reflects the painted width (${Math.round(f.diameterPx)} px)`,
      f.diameterPx > 60 && f.diameterPx < 140
    );
  }

  {
    // Two separate blobs → two fires, not one averaged giant between them.
    const g = gridFrom(['..............', '.###......###.', '.###......###.', '.###......###.', '..............'], {
      texel: 20,
    });
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok(`two separated blobs yield two fires (got ${fires.length})`, fires.length === 2);
    const xs = fires.map((f) => f.x).sort((a, b) => a - b);
    t.ok('the two fires are far apart', xs[1] - xs[0] > 120);
    t.ok(
      'neither fire sits in the empty gap',
      fires.every((f) => f.x < 110 || f.x > 190)
    );
    // Cohesion's whole guarantee (`fire-spawn-points.js#applyCohesion`) rests
    // on two disconnected blobs carrying two DIFFERENT labels.
    t.ok('the two separate blobs carry different labels', fires[0].label !== fires[1].label);
  }

  {
    // ⚠️ THE LIVE BUG (cross-component suppression). A SMALL blob sitting near
    // a much LARGER, unrelated one used to get suppressed by the big blob's
    // already-placed peak — `PEAK_SEPARATION`'s radius scales with the LARGER
    // of the two, so a modest gap was enough to swallow a small neighbour
    // entirely, even though the two are fully disconnected components. This
    // is the exact promise this file's own header makes and the bug broke:
    // "SCOPED PER CONNECTED COMPONENT, not pooled across the whole grid."
    //
    // A 9×9 block (peak radius ~5 texels, so a suppression radius of ~8.5)
    // beside a 2×2 block (peak radius 1 texel) just one empty column away —
    // close enough in texel space to fall inside that 8.5-texel radius, but
    // a completely separate, validly-painted region.
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
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok(`a small blob near a big one still gets its own fire (got ${fires.length})`, fires.length === 2);
    const diameters = fires.map((f) => f.diameterPx).sort((a, b) => a - b);
    t.ok(
      `one fire is big and one is small, not two mediums (${diameters.map((d) => Math.round(d)).join(', ')})`,
      diameters[0] < 60 && diameters[1] > 150
    );
    // The fixture cohesion's own test reuses (fire-spawn-points.test.mjs) —
    // must carry different labels or cohesion's grouping has nothing to key on.
    t.ok('the small and big blob carry different labels', fires[0].label !== fires[1].label);
  }

  // ── THE LINE CASE — the reason this is a distance transform ────────────────

  {
    // A long thin line: large AREA, small WIDTH. An area-based implementation
    // would make this ONE fire of diameter 2·√(60/π)·20 ≈ 175 px. It must
    // instead be a ROW of small ones, each sized by the line's own width.
    const rows = ['....................'];
    rows.push('####################');
    rows.push('####################');
    rows.push('....................');
    const g = gridFrom(rows, { texel: 20 });
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });

    t.ok(`a painted line yields MANY fires, not one (got ${fires.length})`, fires.length >= 4);
    // Each is sized by the line's WIDTH (2 texels ⇒ ~1 texel inscribed radius
    // ⇒ ~40 px), nowhere near the ~175 px an area-based reading would give.
    t.ok(
      `each fire is line-WIDTH sized, not line-AREA sized (max ${Math.round(Math.max(...fires.map((f) => f.diameterPx)))} px)`,
      fires.every((f) => f.diameterPx < 90)
    );
    // They should lie along the line, not scatter off it.
    t.ok(
      'every fire sits on the painted line',
      fires.every((f) => f.y > 20 && f.y < 60)
    );
    // And they should be spread along it rather than piled at one end.
    const xs = fires.map((f) => f.x);
    t.ok('the fires are spread along the line', Math.max(...xs) - Math.min(...xs) > 120);
  }

  {
    // A WIDE region and a THIN one in the same mask must not be sized alike —
    // this is the whole promise of mask-driven sizing.
    const g = gridFrom(
      [
        '.....................',
        '.#######.............',
        '.#######......#######',
        '.#######.............',
        '.#######.............',
        '.#######.............',
        '.#######.............',
        '.....................',
      ],
      { texel: 20 }
    );
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok('both regions produce fire', fires.length >= 2);
    const widest = Math.max(...fires.map((f) => f.diameterPx));
    const narrowest = Math.min(...fires.map((f) => f.diameterPx));
    t.ok(
      `the wide blob makes a bigger fire than the thin strip (${Math.round(widest)} vs ${Math.round(narrowest)})`,
      widest > narrowest * 1.8
    );
  }

  // ── TALL BUT COMPACT — a blob is not a line just because it isn't round ────

  {
    // ⚠️ THE LIVE BUG. A hearth painted into a tall archway (author-reported,
    // 2026-08-08: "two blobs... looks like flames seen from the side") has the
    // IDENTICAL local ridge-spacing pattern as a genuine line — both are
    // regions of roughly constant width with a ridge running down the middle —
    // so before the elongation check this minted 3 same-size fires stacked
    // vertically. One paint region, no real neck anywhere in it, must be ONE
    // fire regardless of how tall it reads on screen.
    const rows = [
      '..........',
      '...####...',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '..######..',
      '...####...',
      '..........',
    ];
    const g = gridFrom(rows, { texel: 20 });
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok(`a tall-but-compact hearth yields ONE fire, not a stack (got ${fires.length})`, fires.length === 1);
    // Sized by the region's WIDTH (6 texels wide ⇒ ~3 texel inscribed radius ⇒
    // ~120 px), the same promise the wide-vs-thin test above makes.
    t.ok(
      `...sized by its width, not its height (${Math.round(fires[0]?.diameterPx ?? -1)} px)`,
      fires[0]?.diameterPx > 80 && fires[0]?.diameterPx < 160
    );
  }

  {
    // The control: stretch the SAME cross-section much further and it must go
    // back to being a row of many — elongation, not tallness alone, is the
    // discriminator. Same 6-texel width as the hearth above, ~4x its length.
    const rows = ['..........', '..######..'];
    for (let i = 0; i < 58; i++) rows.push('..######..');
    rows.push('..........');
    const g = gridFrom(rows, { texel: 20 });
    const fires = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok(`the SAME width, stretched long, goes back to a row of many (got ${fires.length})`, fires.length >= 4);
    // One painted region, one label — even though it seeds a whole ROW of
    // fires. Cohesion (`fire-spawn-points.js#applyCohesion`) relies on this:
    // a line's spaced peaks must all be reachable from the SAME label, then
    // told apart from each other by nearest-WITHIN-that-label, never by a
    // label difference that isn't really there.
    t.ok(
      'the whole spaced row shares one label',
      fires.every((f) => f.label === fires[0].label)
    );
  }

  // ── ROBUSTNESS ─────────────────────────────────────────────────────────────

  {
    t.ok('a null grid yields no fires', extractFiresFromMask(null).length === 0);
    t.ok('a grid with no data yields no fires', extractFiresFromMask({ spec: { w: 4, h: 4 } }).length === 0);
    t.ok('an empty paint yields no fires', extractFiresFromMask(gridFrom(['....', '....'])).length === 0);
  }

  {
    // ⚠️ THE SPECK RULE IS SCALE-AWARE, AND THE TEST THAT USED TO LIVE HERE WAS
    // NOT. It asserted "a one-texel speck yields no fire" and was satisfied by a
    // texel-COUNT filter — which, run against the author's real
    // `Tower_Bridge_Middle_Fire.webp`, deleted every fire on the map at the
    // resolution the mask authority actually derives at (512, `MASK_GRID_MAX_DIM`;
    // measured 2026-08-08: 61 painted texels → 12 fires with the filter removed,
    // 0 with it).
    //
    // Real authored fires ARE small dots. Whether a lone texel is a fire depends
    // entirely on how much WORLD it covers, so `minDiameterPx` is the guard and
    // the same picture must answer differently at two scales.
    const speck = ['...', '.#.', '...'];
    // Fine grid: one texel is 2 world px, so this dot is a 4 px "fire" — noise.
    t.ok(
      'a lone texel on a FINE grid is below the size floor',
      extractFiresFromMask(gridFrom(speck, { texel: 2 })).length === 0
    );
    // Coarse grid: one texel is 40 world px, so the same dot is a real brazier.
    const coarse = extractFiresFromMask(gridFrom(speck, { texel: 40 }));
    t.ok(`the SAME dot on a COARSE grid is a real fire (got ${coarse.length})`, coarse.length === 1);
    t.ok('...and it is sized by the world it covers', coarse[0]?.diameterPx >= 40);
  }

  {
    // Determinism: the light pool reuses meshes by sourceId, so an unstable id
    // or order silently rebuilds every light every frame.
    const g = gridFrom(['........', '.######.', '.######.', '.######.', '........'], { texel: 20 });
    const a = extractFiresFromMask(g, { minDiameterPx: 4 });
    const b = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok('extraction is deterministic', JSON.stringify(a) === JSON.stringify(b));
    t.ok(
      'every fire has a stable namespaced id',
      a.every((f) => f.id.startsWith('mask:'))
    );
  }

  {
    // The cap must bite, or a whole-map paint mints a thousand lights.
    const rows = [];
    for (let r = 0; r < 40; r++) rows.push('#'.repeat(40));
    const g = gridFrom(rows, { texel: 20 });
    const fires = extractFiresFromMask(g, { maxFires: 8, minDiameterPx: 4 });
    t.ok(`the fire cap is enforced (got ${fires.length})`, fires.length <= 8);
  }

  {
    // Paint brightness scales how hard a fire burns, so an author can shade a
    // region rather than only outline it.
    const bright = extractFiresFromMask(gridFrom(['......', '.####.', '.####.', '.####.', '......'], { texel: 20 }), {
      minDiameterPx: 4,
    });
    const dim = extractFiresFromMask(gridFrom(['......', '.++++.', '.++++.', '.++++.', '......'], { texel: 20 }), {
      minDiameterPx: 4,
    });
    t.ok('both paints produce fire', bright.length > 0 && dim.length > 0);
    t.ok('brighter paint burns harder', bright[0].intensity > dim[0].intensity);
    t.ok(
      'intensity stays in range',
      [...bright, ...dim].every((f) => f.intensity > 0 && f.intensity <= 2)
    );
  }

  {
    // World placement must respect the grid's own origin, or every mask-driven
    // fire on an offset floor lands in the wrong place.
    const g = gridFrom(['......', '.####.', '.####.', '.####.', '......'], { texel: 20, x: 1000, y: 2000 });
    const [f] = extractFiresFromMask(g, { minDiameterPx: 4 });
    t.ok('the fire is offset by the grid origin', f.x > 1000 && f.x < 1120 && f.y > 2000 && f.y < 2100);
  }

  // ── THE SIGNATURE ──────────────────────────────────────────────────────────

  {
    const a = gridFrom(['....', '.##.', '.##.', '....']);
    const b = gridFrom(['....', '.##.', '.##.', '....']);
    const c = gridFrom(['....', '.###', '.##.', '....']);
    t.ok('the same grid signs the same', fireMaskSignature(a) === fireMaskSignature(b));
    t.ok('a different paint signs differently', fireMaskSignature(a) !== fireMaskSignature(c));
    t.ok('a null grid signs zero', fireMaskSignature(null) === 0);
    // Moving the grid's world origin changes where every fire lands, so it must
    // change the signature.
    const moved = gridFrom(['....', '.##.', '.##.', '....'], { x: 500 });
    t.ok('a moved grid signs differently', fireMaskSignature(a) !== fireMaskSignature(moved));

    // A resized WORLD RECT with the SAME texel grid (w/h/x/y unchanged) must
    // also change the signature — this is what `w`/`h` alone cannot see:
    // `extractFiresFromMask` derives `texelW = spec.width / w`, so a resize
    // changes every fire's x/y/diameterPx while the texel dimensions and
    // origin this signature otherwise mixes stay identical.
    const resized = { spec: { ...a.spec, width: a.spec.width * 3, height: a.spec.height * 3 }, data: a.data };
    t.ok('a resized world rect (same w/h/x/y) signs differently', fireMaskSignature(a) !== fireMaskSignature(resized));
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE RESCUE PASS — "fire appears but its light doesn't" (2026-08-15)
  // ══════════════════════════════════════════════════════════════════════
  // Author-reported live, and named exactly by MapShine.getFireStatus():
  // ground floor {fires: 6, lights: 6, spawnPoints: 85}, upper floor
  // {fires: 0, lights: 0, spawnPoints: 2}. Paint whose alpha sits between the
  // SPAWN threshold (0.18) and the PAINT threshold (0.25) spawns flame
  // particles while producing zero fires — and a fire is the only thing that
  // ever becomes a light. See `extractFiresFromMask`'s own "⚠️ THE RESCUE PASS".
  {
    // 55/255 ≈ 0.216 — comfortably inside the dead band: above spawn's 0.18,
    // below fire's 0.25. This is the alpha that made flames with no light.
    const faint = (rows, alpha) => {
      const h = rows.length;
      const w = rows[0].length;
      const data = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) data[r * w + c] = rows[r][c] === '#' ? alpha : 0;
      }
      return { spec: { x: 0, y: 0, width: w * 10, height: h * 10, w, h, texelW: 10, texelH: 10 }, data };
    };
    const g = faint(['.....', '.###.', '.###.', '.###.', '.....'], 55);

    const strictOnly = extractFiresFromMask(g, { minDiameterPx: 4, paintThreshold: 0.25 });
    t.ok('THE BUG: faint-but-real paint yields ZERO fires at the strict threshold', strictOnly.length === 0);

    const rescued = extractFiresFromMask(g, { minDiameterPx: 4, paintThreshold: 0.25, rescueThreshold: 0.18 });
    t.ok('THE FIX: the rescue pass finds it, so a light can exist', rescued.length > 0);

    // ---- and the fix must be INERT wherever fires already exist -----------
    // Every scene that works today must be bit-identical, which is the whole
    // reason this is a rescue pass rather than a lowered threshold.
    const bold = gridFrom(['.....', '.###.', '.###.', '.###.', '.....']);
    const before = extractFiresFromMask(bold, { minDiameterPx: 4, paintThreshold: 0.25 });
    const after = extractFiresFromMask(bold, { minDiameterPx: 4, paintThreshold: 0.25, rescueThreshold: 0.18 });
    t.ok('bold paint is unaffected — same count', before.length === after.length && before.length > 0);
    t.ok(
      'bold paint is unaffected — same ids, positions and diameters',
      JSON.stringify(before) === JSON.stringify(after)
    );

    // ---- a rescue threshold at or above the strict one is a no-op ---------
    const noRescue = extractFiresFromMask(g, { minDiameterPx: 4, paintThreshold: 0.25, rescueThreshold: 0.25 });
    t.ok('an equal-or-higher rescue threshold runs no second pass', noRescue.length === 0);

    // ---- genuinely blank paint stays blank --------------------------------
    // The rescue pass must not mint fires out of nothing; it lowers the bar,
    // it does not remove it.
    const blank = faint(['.....', '.....', '.....'], 55);
    t.ok(
      'unpainted grid yields nothing, rescue pass or not',
      extractFiresFromMask(blank, { minDiameterPx: 4, rescueThreshold: 0.18 }).length === 0
    );
    const belowBoth = faint(['.....', '.###.', '.###.', '.....'], 20); // 20/255 ≈ 0.078
    t.ok(
      'paint below the SPAWN threshold too is still rejected — the bar moved, it did not vanish',
      extractFiresFromMask(belowBoth, { minDiameterPx: 4, paintThreshold: 0.25, rescueThreshold: 0.18 }).length === 0
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // LABEL PROPAGATION — the antialiased fringe between the SPAWN threshold
  // (fire-spawn-points.js, lower) and the PAINT threshold `labelComponents`
  // runs at (this file, higher). `fire-spawn-points.js#applyCohesion` needs
  // to know which confirmed blob a spawn point in that fringe belongs to —
  // see `propagateLabels`'s own header.
  // ══════════════════════════════════════════════════════════════════════

  {
    // A solid 5×5 core (clears PAINT threshold) ringed by paint at 50/255
    // (≈0.196 — between the spawn threshold 0.18 and the paint threshold
    // 0.25), with enough empty margin beyond the ring that a far corner is
    // genuinely unreachable within the propagation bound.
    const n = 17;
    const centre = 8;
    const rows = [];
    for (let r = 0; r < n; r++) {
      let row = '';
      for (let c = 0; c < n; c++) {
        const d = Math.max(Math.abs(r - centre), Math.abs(c - centre));
        row += d <= 2 ? '#' : d === 3 ? 'o' : '.';
      }
      rows.push(row);
    }
    const g = labeledGrid(rows);
    const { fires, labels, nearestLabel } = extractFiresWithLabels(g, { minDiameterPx: 4 });
    t.ok(`the solid core alone produces one fire (got ${fires.length})`, fires.length === 1);
    const w = g.spec.w;
    const label = fires[0].label;
    const ringIdx = (centre - 3) * w + centre; // directly above the core, in the ring band
    t.ok('raw labelComponents leaves the ring UNLABELLED (it never clears PAINT threshold)', labels[ringIdx] === -1);
    t.ok("propagation gives the ring texel the core's own label", nearestLabel[ringIdx] === label);
    const cornerIdx = 0; // far outside both the core and the ring's reach
    t.ok(
      'a texel with no nearby paint stays -1 in both the raw and the propagated field',
      labels[cornerIdx] === -1 && nearestLabel[cornerIdx] === -1
    );
  }

  {
    // Two confirmed blobs, each with its OWN fringe ring, separated by a gap
    // wider than either fringe could ever bridge. Each ring must resolve only
    // to its own blob's label — cross-blob fringe bleed would be exactly the
    // "pooled across the whole grid" bug this session already fixed once,
    // one layer up.
    const n = 19;
    const cA = 3;
    const cB = 15;
    const rows = [];
    for (let r = 0; r < n; r++) {
      let row = '';
      for (let c = 0; c < n; c++) {
        const dA = Math.max(Math.abs(r - cA), Math.abs(c - cA));
        const dB = Math.max(Math.abs(r - cB), Math.abs(c - cB));
        if (dA <= 1 || dB <= 1) row += '#';
        else if (dA === 2 || dB === 2) row += 'o';
        else row += '.';
      }
      rows.push(row);
    }
    const g = labeledGrid(rows);
    const { fires, labels, nearestLabel } = extractFiresWithLabels(g, { minDiameterPx: 4 });
    t.ok(`two separate cores with their own fringes yield two fires (got ${fires.length})`, fires.length === 2);
    t.ok('the two cores carry different labels', fires[0].label !== fires[1].label);
    const w = g.spec.w;
    const labelA = nearestLabel[cA * w + cA];
    const labelB = nearestLabel[cB * w + cB];
    t.ok("blob A's own ring resolves only to blob A", nearestLabel[cA * w + (cA + 2)] === labelA);
    t.ok("blob B's own ring resolves only to blob B", nearestLabel[cB * w + (cB - 2)] === labelB);
    // The genuine gap between the two rings — nowhere near either fringe.
    const midIdx = cA * w + 9;
    t.ok(
      'the real gap between them stays unresolved in both fields',
      labels[midIdx] === -1 && nearestLabel[midIdx] === -1
    );
  }
}
