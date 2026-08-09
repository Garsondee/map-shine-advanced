/**
 * Node verification for vt/texture-limits.js — the pure arithmetic behind the
 * "load whole images like PIXI" direction (raise the WebGPU texture cap so a
 * 12000² floor fits in ONE texture instead of thousands of streamed pages).
 */
import {
  chooseTextureLimit,
  chooseStorageBufferLimit,
  chooseBufferSizeLimit,
  planImageTiles,
  WEBGPU_SPEC_MIN_TEXTURE_DIM,
  DESIRED_TEXTURE_DIM,
  WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE,
  DESIRED_STORAGE_BUFFERS_PER_STAGE,
  WEBGPU_SPEC_MIN_BUFFER_SIZE,
  DESIRED_BUFFER_SIZE,
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

  // --- chooseStorageBufferLimit: same safety discipline, a different resource
  // --- (2026-07-22, the live "9 exceeds limit 8" GPUValidationError this fixes) ---

  ok(
    'constants: storage-buffer spec floor is 8, desired is 16',
    WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE === 8 && DESIRED_STORAGE_BUFFERS_PER_STAGE === 16
  );

  // The live case: the adapter that hit the real error reported supporting 16
  // — a compute kernel needing 9 (Wind Gusts: 5 arena + trail history + 3
  // optional wind grids) now fits comfortably under the raised cap.
  ok('adapter 16 → 16 (a 9-buffer compute kernel fits)', chooseStorageBufferLimit(16) === 16);

  // Adapter offers MORE than we target → clamp to the desired cap, keeping the
  // device request conservative (same posture as the texture limit above).
  ok('adapter 32 → clamps to the 16 target, not the adapter max', chooseStorageBufferLimit(32) === 16);

  // Weak hardware capped at the 8-buffer spec floor → stays 8 (asking for more
  // would make requestDevice throw); a kernel needing 9+ storage buffers on
  // this hardware is a genuine "reduce buffer count" problem, not one this
  // function can paper over.
  ok('adapter 8 → stays 8 (never exceed what the adapter supports)', chooseStorageBufferLimit(8) === 8);

  // Implausible/bogus adapter values never drag us under the 8-buffer floor
  // every real adapter grants.
  ok('adapter 4 (below floor) → clamped up to 8', chooseStorageBufferLimit(4) === 8);
  ok('adapter undefined → 8 (safe default)', chooseStorageBufferLimit(undefined) === 8);
  ok('adapter NaN → 8 (safe default)', chooseStorageBufferLimit(NaN) === 8);
  ok('adapter 0 → 8 (safe default)', chooseStorageBufferLimit(0) === 8);

  // A caller can lower the target, but never below the spec floor.
  ok('desired below floor is ignored → 8', chooseStorageBufferLimit(16, 4) === 8);
  ok('desired 12 honored when adapter allows', chooseStorageBufferLimit(16, 12) === 12);
  ok('desired 12 but adapter only 8 → 8', chooseStorageBufferLimit(8, 12) === 8);

  // --- chooseBufferSizeLimit: same safety discipline, a different resource --
  // --- (2026-08-08, the live "Buffer size (324863904) exceeds the max buffer
  // --- size limit (268435456)" GPUValidationError this fixes) ---

  ok(
    'constants: buffer-size spec floor is 256MiB, desired is 1GiB',
    WEBGPU_SPEC_MIN_BUFFER_SIZE === 268435456 && DESIRED_BUFFER_SIZE === 1073741824
  );

  // The live case: the adapter that hit the real error reported supporting 2GiB
  // — a ~324MB single-buffer upload (a _Specular mask on a 12000² map) now
  // fits comfortably under the raised 1GiB cap.
  ok('adapter 2GiB → clamps to the 1GiB target, not the adapter max', chooseBufferSizeLimit(2147483648) === 1073741824);

  // Adapter offers exactly what we target → that value.
  ok('adapter 1GiB → 1GiB', chooseBufferSizeLimit(1073741824) === 1073741824);

  // Weak hardware capped at the 256MiB spec floor → stays there (asking for
  // more would make requestDevice throw); an upload bigger than this on this
  // hardware needs its own byte-budget cap, not a higher requiredLimits ask.
  ok(
    'adapter 256MiB → stays at the floor (never exceed what the adapter supports)',
    chooseBufferSizeLimit(268435456) === 268435456
  );

  // Implausible/bogus adapter values never drag us under the spec floor every
  // real adapter grants.
  ok('adapter 100MiB (below floor) → clamped up to 256MiB', chooseBufferSizeLimit(100 * 1024 * 1024) === 268435456);
  ok('adapter undefined → 256MiB (safe default)', chooseBufferSizeLimit(undefined) === 268435456);
  ok('adapter NaN → 256MiB (safe default)', chooseBufferSizeLimit(NaN) === 268435456);
  ok('adapter 0 → 256MiB (safe default)', chooseBufferSizeLimit(0) === 268435456);

  // A caller can lower the target, but never below the spec floor.
  ok('desired below floor is ignored → 256MiB', chooseBufferSizeLimit(2147483648, 100 * 1024 * 1024) === 268435456);
  ok('desired 512MiB honored when adapter allows', chooseBufferSizeLimit(2147483648, 536870912) === 536870912);
  ok('desired 512MiB but adapter only 256MiB → 256MiB', chooseBufferSizeLimit(268435456, 536870912) === 268435456);

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
