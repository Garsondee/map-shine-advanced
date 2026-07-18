/**
 * Node verification for vt/texture-limits.js — the pure arithmetic behind the
 * "load whole images like PIXI" direction (raise the WebGPU texture cap so a
 * 12000² floor fits in ONE texture instead of thousands of streamed pages).
 */
import {
  chooseTextureLimit,
  planImageTiles,
  WEBGPU_SPEC_MIN_TEXTURE_DIM,
  DESIRED_TEXTURE_DIM,
} from '../texture-limits.js';

export function run(t) {
  const { ok, throws } = t;

  /** Assert a plan tiles [0,width)×[0,height) EXACTLY, with every tile ≤ maxDim. */
  function tilesTheImage(name, plan, width, height, maxDim) {
    const { tiles, cols, rows } = plan;
    let area = 0;
    let maxRight = 0;
    let maxBottom = 0;
    let allFit = true;
    let allPositive = true;
    for (const tt of tiles) {
      area += tt.sw * tt.sh;
      maxRight = Math.max(maxRight, tt.sx + tt.sw);
      maxBottom = Math.max(maxBottom, tt.sy + tt.sh);
      if (tt.sw > maxDim || tt.sh > maxDim) allFit = false;
      if (tt.sw <= 0 || tt.sh <= 0 || tt.sx < 0 || tt.sy < 0) allPositive = false;
    }
    ok(
      `${name}: tiles exactly cover ${width}×${height}, all ≤ ${maxDim}`,
      tiles.length === cols * rows &&
        area === width * height && // even split + last-clamp ⇒ a partition ⇒ areas sum to the whole
        maxRight === width &&
        maxBottom === height &&
        allFit &&
        allPositive
    );
  }

  ok(
    'constants: spec floor is 8192, desired is 16384',
    WEBGPU_SPEC_MIN_TEXTURE_DIM === 8192 && DESIRED_TEXTURE_DIM === 16384
  );

  // The live case: a desktop adapter (RTX 3070) reports 16384 → we get 16384,
  // enough for a 12000² floor whole. THIS is the whole point.
  ok('adapter 16384 → 16384 (a 12000² floor fits whole)', chooseTextureLimit(16384) === 16384);

  // Adapter offers MORE than we need → we still only ask for what we target
  // (16384), keeping the device request conservative.
  ok('adapter 32768 → clamps to the 16384 target, not the adapter max', chooseTextureLimit(32768) === 16384);

  // Weak hardware capped at the 8192 spec floor → we stay at 8192 (asking for
  // more would make requestDevice throw); the loader's tile-split handles the
  // oversized image under this cap.
  ok('adapter 8192 → stays 8192 (never exceed what the adapter supports)', chooseTextureLimit(8192) === 8192);

  // An adapter that (implausibly) reports BELOW the spec floor, or a bogus/
  // undefined value, must never drag us under 8192 — every adapter grants 8192.
  ok('adapter 4096 (below floor) → clamped up to 8192', chooseTextureLimit(4096) === 8192);
  ok('adapter undefined → 8192 (safe default)', chooseTextureLimit(undefined) === 8192);
  ok('adapter NaN → 8192 (safe default)', chooseTextureLimit(NaN) === 8192);
  ok('adapter 0 → 8192 (safe default)', chooseTextureLimit(0) === 8192);

  // A caller can lower the target (e.g. a deliberately conservative build), but
  // never below the spec floor.
  ok('desired below floor is ignored → 8192', chooseTextureLimit(16384, 4096) === 8192);
  ok('desired 12288 honored when adapter allows', chooseTextureLimit(16384, 12288) === 12288);
  ok('desired 12288 but adapter only 8192 → 8192', chooseTextureLimit(8192, 12288) === 8192);

  // --- planImageTiles: the "quarter-split" (author's idea) generalized -------

  // THE live case: a 12000² floor at the 16384 cap is ONE whole texture.
  {
    const p = planImageTiles(12000, 12000, 16384);
    ok(
      'planImageTiles: 12000² @ 16384 → ONE whole tile (PIXI-style, no split)',
      p.whole === true &&
        p.cols === 1 &&
        p.rows === 1 &&
        p.tiles.length === 1 &&
        p.tiles[0].sx === 0 &&
        p.tiles[0].sy === 0 &&
        p.tiles[0].sw === 12000 &&
        p.tiles[0].sh === 12000
    );
    tilesTheImage('12000² @ 16384', p, 12000, 12000, 16384);
  }

  // The fallback the author proposed: hardware stuck at 8192 → an EVEN 2×2 of
  // 6000² tiles (four uploads, not thousands of streamed pages).
  {
    const p = planImageTiles(12000, 12000, 8192);
    ok(
      'planImageTiles: 12000² @ 8192 → even 2×2 of 6000² tiles (the quarter-split)',
      p.whole === false &&
        p.cols === 2 &&
        p.rows === 2 &&
        p.tiles.length === 4 &&
        p.tiles.every((tt) => tt.sw === 6000 && tt.sh === 6000)
    );
    tilesTheImage('12000² @ 8192', p, 12000, 12000, 8192);
  }

  // Weaker still: below 6000 per tile → 3×3 of 4000² tiles, all ≤ 4096.
  {
    const p = planImageTiles(12000, 12000, 4096);
    ok(
      'planImageTiles: 12000² @ 4096 → 3×3 of 4000² tiles',
      p.cols === 3 && p.rows === 3 && p.tiles.length === 9 && p.tiles.every((tt) => tt.sw === 4000 && tt.sh === 4000)
    );
    tilesTheImage('12000² @ 4096', p, 12000, 12000, 4096);
  }

  // Non-square (a wide foreground strip): splits per-axis independently.
  {
    const p = planImageTiles(12000, 6000, 8192);
    ok(
      'planImageTiles: 12000×6000 @ 8192 → 2×1 (per-axis split)',
      p.cols === 2 && p.rows === 1 && p.tiles.length === 2
    );
    tilesTheImage('12000×6000 @ 8192', p, 12000, 6000, 8192);
  }

  // Uneven division still partitions exactly (last tile clamped, no sliver
  // overflow, no gap): 10001 across 3 cols → 3334+3334+3333.
  {
    const p = planImageTiles(10001, 7000, 5000);
    ok('planImageTiles: 10001×7000 @ 5000 → 3×2, last column clamped to 3333', p.cols === 3 && p.rows === 2);
    ok(
      'planImageTiles: uneven split has no tile exceeding maxDim',
      p.tiles.every((tt) => tt.sw <= 5000 && tt.sh <= 5000)
    );
    tilesTheImage('10001×7000 @ 5000', p, 10001, 7000, 5000);
  }

  // A tiny image is one whole tile.
  {
    const p = planImageTiles(1, 1, 16384);
    ok('planImageTiles: 1×1 → one whole tile', p.whole === true && p.tiles.length === 1 && p.tiles[0].sw === 1);
  }

  // An image EXACTLY at the limit stays whole (boundary, not off-by-one split).
  {
    const p = planImageTiles(8192, 8192, 8192);
    ok(
      'planImageTiles: exactly-at-limit stays ONE whole tile (no off-by-one split)',
      p.whole === true && p.tiles.length === 1
    );
    tilesTheImage('8192² @ 8192', p, 8192, 8192, 8192);
  }

  // Degenerate inputs throw (a bad dimension must never yield a silent 0-tile plan).
  throws('planImageTiles: width 0 throws', () => planImageTiles(0, 100, 8192), 'width');
  throws('planImageTiles: negative height throws', () => planImageTiles(100, -5, 8192), 'height');
  throws('planImageTiles: maxDim 0 throws', () => planImageTiles(100, 100, 0), 'maxDim');
  throws('planImageTiles: NaN width throws', () => planImageTiles(NaN, 100, 8192), 'width');
}
