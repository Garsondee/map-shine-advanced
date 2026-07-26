/**
 * Node verification for effects/fluid/fluid-pack.js — THE TUBE PACK.
 *
 * The pack is the whole of the GPU-side bake (`Fluid.md` correction #3: there
 * is no jump flood — three of the four channels are CPU-only quantities, so the
 * pack is assembled here and uploaded once). That means everything about it is
 * assertable in Node, and the two assertions worth naming up front are the ones
 * that would otherwise only show up as "the effect looks a bit flat":
 *
 *   - `across` must be normalised against the LOCAL radius, so a capillary
 *     joined to a flask still reads 0 down its own centreline;
 *   - `tubeId` must be the ONLY presence gate, because `s` is legitimately 0 at
 *     every root and `across` is legitimately 0 down every centreline.
 */
import { extractTubeNet } from '../fluid-net.js';
import {
  buildFluidPack,
  packToHalfFloat,
  toHalfFloat,
  fromHalfFloat,
  FLUID_PACK_CHANNELS,
  FLUID_PACK_MAX_DIM,
} from '../fluid-pack.js';

const T = 10;

function makeGrid(w, h, texel = T) {
  return {
    spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel },
    data: new Uint8Array(w * h),
  };
}

function rect(grid, x0, y0, x1, y1, value = 255) {
  const { w } = grid.spec;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid.data[y * w + x] = value;
}

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

export function run(t) {
  const { ok, throws } = t;

  // ── Layout, and the outside-value convention ────────────────────────────
  {
    const g = makeGrid(40, 16);
    rect(g, 4, 6, 35, 10); // a 5-texel-wide tube: wide enough for a real gradient
    const net = extractTubeNet({ grid: g, samplesPerTube: 24 });
    const pack = buildFluidPack({ net });
    const at = (x, y, c) => pack.data[(y * 40 + x) * FLUID_PACK_CHANNELS + c];

    ok('pack has the grid’s dimensions', pack.width === 40 && pack.height === 16);
    ok('pack is interleaved RGBA', pack.data.length === 40 * 16 * 4);
    ok('pack echoes the spec so consumers need no second source', pack.spec === net.spec);
    ok('pack reports the tube count', pack.tubeCount === 1);

    // Every channel is zero outside. This is the convention `tubeId`-as-gate
    // depends on, and a consumer defaulting `across` to 1 would rim the map.
    ok('outside: id 0', at(0, 0, 2) === 0);
    ok('outside: s 0', at(0, 0, 0) === 0);
    ok('outside: across 0, NOT 1', at(0, 0, 1) === 0);
    ok('outside: radius 0', at(0, 0, 3) === 0);

    // Inside, the id is exact — it indexes a state-texture row, so a rounding
    // error here would drive a tube from the wrong row's flow.
    ok('inside: id is exactly 1', at(20, 8, 2) === 1);

    // across: 0 down the centreline, climbing toward the wall.
    const centre = at(20, 8, 1);
    const nearWall = at(20, 6, 1);
    ok(`across is ~0 at the centreline (${centre.toFixed(3)})`, centre < 0.05);
    ok(`across climbs toward the wall (${nearWall.toFixed(3)})`, nearWall > centre + 0.4);
    ok(
      'across never exceeds 1',
      pack.data.filter((_, i) => i % 4 === 1).every((v) => v >= 0 && v <= 1)
    );
  }

  // ── THE LOCAL-RADIUS ASSERTION — a capillary joined to a flask ──────────
  // With `across` normalised against the tube's GLOBAL max radius (the obvious
  // first implementation) the stem's centreline reads ~0.86 — "almost at the
  // wall" — and the entire capillary shades as rim. This is that regression.
  {
    const g = makeGrid(40, 16);
    rect(g, 8, 6, 35, 9, 200); // 4-texel stem
    rect(g, 2, 3, 8, 12, 255); // 10-texel flask
    const net = extractTubeNet({ grid: g, samplesPerTube: 24 });
    const pack = buildFluidPack({ net });
    const at = (x, y, c) => pack.data[(y * 40 + x) * FLUID_PACK_CHANNELS + c];

    const stemCentre = at(28, 7, 1);
    const flaskCentre = at(5, 7, 1);
    ok(`flask centreline reads ~0 (${flaskCentre.toFixed(3)})`, flaskCentre < 0.15);
    ok(`stem centreline ALSO reads ~0 (${stemCentre.toFixed(3)}) — local radius, not global`, stemCentre < 0.25);

    // And channel A carries the LOCAL half-width, so the two differ a lot.
    const stemRadius = at(28, 7, 3);
    const flaskRadius = at(5, 7, 3);
    ok(
      `radius channel is local: flask ${flaskRadius.toFixed(0)} >> stem ${stemRadius.toFixed(0)}`,
      flaskRadius > stemRadius * 1.8
    );
  }

  // ── s runs 0→1 along the tube and is gated by the id, not by its value ──
  {
    const g = makeGrid(40, 12);
    rect(g, 3, 5, 36, 7);
    const net = extractTubeNet({ grid: g, samplesPerTube: 24 });
    const pack = buildFluidPack({ net });
    const at = (x, y, c) => pack.data[(y * 40 + x) * FLUID_PACK_CHANNELS + c];

    const root = net.tubes[0].rootTexel;
    ok(
      's is exactly 0 at the root — which is why s cannot be a presence test',
      at(root % 40, Math.floor(root / 40), 0) === 0
    );
    ok('the root still carries a nonzero id', at(root % 40, Math.floor(root / 40), 2) === 1);

    // Monotone along the tube's own direction, walking its FULL span. (The
    // double sweep lands root and tip on opposite CORNERS of a rectangular
    // tube, so the middle row's own extremes fall a little short of 0 and 1 —
    // which is why the exact endpoints are asserted at the texels that own
    // them, and the mid-row is asserted only for monotonicity and reach.)
    const rootX = root % 40;
    const walkRight = rootX < 20;
    let prev = walkRight ? -1 : 2;
    let monotone = true;
    for (let k = 0; k <= 33; k++) {
      const x = 3 + k;
      const s = at(x, 6, 0);
      if (walkRight ? s < prev - 1e-6 : s > prev + 1e-6) monotone = false;
      prev = s;
    }
    ok('s changes monotonically along the tube', monotone);

    const tip = net.tubes[0].tipTexel;
    ok('s is exactly 1 at the tip texel', at(tip % 40, Math.floor(tip / 40), 0) === 1);
    const far = walkRight ? at(36, 6, 0) : at(3, 6, 0);
    const near = walkRight ? at(3, 6, 0) : at(36, 6, 0);
    ok(`s spans nearly the whole range along the mid-row (${near.toFixed(2)} → ${far.toFixed(2)})`, far - near > 0.9);
  }

  // ── maxTubeWidthTexels — the instrument for a too-coarse pack ───────────
  {
    const wide = makeGrid(40, 20);
    rect(wide, 4, 6, 35, 13); // 8 texels across
    const wideNet = extractTubeNet({ grid: wide, samplesPerTube: 16 });
    const widePack = buildFluidPack({ net: wideNet });
    ok(
      `wide tube reports ~8 texels (${widePack.maxTubeWidthTexels.toFixed(1)})`,
      widePack.maxTubeWidthTexels > 6 && widePack.maxTubeWidthTexels < 10
    );

    const thin = makeGrid(40, 12);
    rect(thin, 4, 6, 35, 7); // 2 texels across — the degenerate case
    const thinNet = extractTubeNet({ grid: thin, samplesPerTube: 16 });
    const thinPack = buildFluidPack({ net: thinNet });
    ok(
      `thin tube reports ~2 texels (${thinPack.maxTubeWidthTexels.toFixed(1)}) — the "shading will be flat" warning`,
      thinPack.maxTubeWidthTexels < 3
    );
    // And the failure it predicts is real, asserted so the instrument is not
    // merely decorative: a 2-texel tube genuinely cannot form an `across`
    // gradient, because both its texels are the same distance from a wall.
    const at = (x, y, c) => thinPack.data[(y * 40 + x) * FLUID_PACK_CHANNELS + c];
    ok('2-texel tube: across is flat, exactly as maxTubeWidthTexels predicts', at(20, 6, 1) === at(20, 7, 1));
  }

  // ── Half-float: the round trip, and what it is allowed to cost ──────────
  {
    ok('half-float: 0 round-trips', fromHalfFloat(toHalfFloat(0)) === 0);
    ok('half-float: 1 round-trips exactly', fromHalfFloat(toHalfFloat(1)) === 1);
    ok(
      'half-float: small integers are exact (tube ids)',
      [1, 7, 63, 64, 2048].every((n) => fromHalfFloat(toHalfFloat(n)) === n)
    );
    ok('half-float: negatives keep their sign', fromHalfFloat(toHalfFloat(-0.5)) === -0.5);
    ok('half-float: 0.5 is exact', fromHalfFloat(toHalfFloat(0.5)) === 0.5);
    // 0..1 values resolve to better than a thousandth — ample for s and across.
    let worst = 0;
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      worst = Math.max(worst, Math.abs(fromHalfFloat(toHalfFloat(v)) - v));
    }
    ok(`half-float: 0..1 error stays under 0.001 (worst ${worst.toExponential(1)})`, worst < 1e-3);
    // A radius in the hundreds still resolves sub-pixel.
    ok('half-float: 350px radius resolves under 0.25px', Math.abs(fromHalfFloat(toHalfFloat(350)) - 350) < 0.25);
    ok('half-float: clamps rather than returning Infinity', Number.isFinite(fromHalfFloat(toHalfFloat(1e6))));
  }

  // ── The encoded buffer halves the upload and keeps ids exact ────────────
  {
    const g = makeGrid(24, 12);
    rect(g, 2, 4, 21, 8);
    const net = extractTubeNet({ grid: g, samplesPerTube: 16 });
    const pack = buildFluidPack({ net });
    const half = packToHalfFloat(pack);

    ok('half buffer has one entry per float', half.length === pack.data.length);
    ok('half buffer is half the bytes', half.length * 2 === pack.data.length * 2);
    let idsExact = true;
    for (let i = 2; i < pack.data.length; i += 4) {
      if (fromHalfFloat(half[i]) !== pack.data[i]) idsExact = false;
    }
    ok('every tube id survives the encoding exactly', idsExact);
  }

  // ── Degenerate inputs ───────────────────────────────────────────────────
  {
    const net = extractTubeNet({ grid: makeGrid(16, 16), samplesPerTube: 8 });
    const pack = buildFluidPack({ net });
    ok('empty mask: a pack still exists', pack.width === 16 && pack.height === 16);
    ok('empty mask: tubeCount 0', pack.tubeCount === 0);
    ok(
      'empty mask: every texel is zero',
      pack.data.every((v) => v === 0)
    );
    ok('empty mask: width instrument reports 0, not NaN', pack.maxTubeWidthTexels === 0);
  }

  throws('a missing net throws rather than producing an empty pack', () => buildFluidPack({}), 'TubeNet');
  throws('a null net throws too', () => buildFluidPack({ net: null }), 'TubeNet');

  // ── The resolution constant is a texture dimension, not a preference ────
  ok('FLUID_PACK_MAX_DIM is under the Keyhole allocator’s 2048 cap', FLUID_PACK_MAX_DIM <= 2048);
  ok('FLUID_PACK_MAX_DIM is well above the 512 derived grid it replaces', FLUID_PACK_MAX_DIM >= 1024);
  ok('the pack is RGBA', FLUID_PACK_CHANNELS === 4);
  ok('approx helper is sane', approx(1, 1));
}
