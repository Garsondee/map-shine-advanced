/**
 * Node verification for foundry/pixi-proxy-textures.js's pure part
 * (computeProxyDimensions), PLUS registerPixiProxy's three EARLY-RETURN
 * branches (unavailable/already-cached/too-small), which resolve before
 * touching OffscreenCanvas/createImageBitmap and so ARE reachable with an
 * injected fake `PIXI` (the function's own `opts.PIXI` seam). The actual
 * seed path (OffscreenCanvas draw + createImageBitmap + real PIXI.Assets)
 * stays browser-only -- verified live via the debug panel, per this
 * codebase's own convention -- so getPixiProxyStats().registered is proven
 * to exist and start at a sane baseline here, not to actually increment.
 */
import {
  computeProxyDimensions,
  DEFAULT_MAX_PROXY_DIMENSION_PX,
  registerPixiProxy,
  getPixiProxyStats,
} from '../pixi-proxy-textures.js';

export async function run(t) {
  const { ok } = t;

  ok(
    "DEFAULT_MAX_PROXY_DIMENSION_PX matches Keyhole.md §4.3's stated ceiling (1024)",
    DEFAULT_MAX_PROXY_DIMENSION_PX === 1024
  );

  // --- the real case: the author's actual 12000x12000 mansion map ------------
  {
    const d = computeProxyDimensions(12000, 12000);
    ok('computeProxyDimensions: 12000x12000 needs proxying', d.needed === true);
    ok(
      'computeProxyDimensions: 12000x12000 scales to exactly 1024x1024 (square, both hit the cap)',
      d.width === 1024 && d.height === 1024
    );
  }

  // --- non-square: aspect ratio must be preserved -----------------------------
  {
    const d = computeProxyDimensions(8000, 4000, 1024);
    ok('computeProxyDimensions: 2:1 aspect scales width to the cap', d.width === 1024);
    ok('computeProxyDimensions: 2:1 aspect scales height proportionally (512, not also capped)', d.height === 512);
    ok('computeProxyDimensions: 8000x4000 needs proxying', d.needed === true);
  }

  {
    const d = computeProxyDimensions(4000, 8000, 1024); // tall, not wide
    ok('computeProxyDimensions: tall aspect scales HEIGHT to the cap', d.height === 1024);
    ok('computeProxyDimensions: tall aspect scales width proportionally (512)', d.width === 512);
  }

  // --- already small enough: no proxy needed, and dimensions pass through
  // UNCHANGED (a real, load-bearing distinction -- registerPixiProxy uses
  // `needed:false` to skip seeding the cache entirely, not to seed an
  // identical-size no-op proxy) -------------------------------------------------
  {
    const d = computeProxyDimensions(800, 600, 1024);
    ok('computeProxyDimensions: already-small source is not flagged as needing a proxy', d.needed === false);
    ok(
      'computeProxyDimensions: already-small source dimensions pass through unchanged',
      d.width === 800 && d.height === 600
    );
  }

  // --- exact boundary: largest dimension == the cap is NOT "needed" (<=, not <) --
  {
    const d = computeProxyDimensions(1024, 768, 1024);
    ok('computeProxyDimensions: largest dimension exactly at the cap does not need proxying', d.needed === false);
  }

  // --- one pixel over the boundary DOES need proxying -------------------------
  {
    const d = computeProxyDimensions(1025, 768, 1024);
    ok('computeProxyDimensions: one pixel over the cap DOES need proxying', d.needed === true);
    ok('computeProxyDimensions: barely-over source scales down to exactly the cap', d.width === 1024);
  }

  // --- never produces a zero/negative dimension (defensive against a
  // pathological tiny custom maxDimensionPx or an extreme aspect ratio) --------
  {
    const d = computeProxyDimensions(100000, 1, 1024);
    ok(
      'computeProxyDimensions: extreme aspect ratio never rounds a dimension down to 0',
      d.width >= 1 && d.height >= 1
    );
  }

  // ==========================================================================
  // registerPixiProxy's three EARLY-RETURN branches, via an injected fake
  // PIXI — none of these reach OffscreenCanvas/createImageBitmap.
  // ==========================================================================
  const before = getPixiProxyStats();

  // --- PIXI unavailable ------------------------------------------------------
  {
    const r = await registerPixiProxy('foo.webp', { width: 4000, height: 4000 }, { PIXI: {} });
    ok('no PIXI.Assets.cache: registered:false', r.registered === false);
    ok('no PIXI.Assets.cache: reason names the actual cause', /unavailable/.test(r.reason));
  }

  // --- already cached under this exact src ------------------------------------
  {
    const fakePIXI = { Assets: { cache: new Map([['already.webp', {}]]) } };
    const r = await registerPixiProxy('already.webp', { width: 4000, height: 4000 }, { PIXI: fakePIXI });
    ok('already-cached src: registered:false', r.registered === false);
    ok('already-cached src: reason names the actual cause', /already registered/.test(r.reason));
  }

  // --- source already small enough: proxying would not help ------------------
  {
    const fakePIXI = { Assets: { cache: new Map() } };
    const r = await registerPixiProxy(
      'small.webp',
      { width: 800, height: 600 },
      { PIXI: fakePIXI, maxDimensionPx: 1024 }
    );
    ok('already-small source: registered:false', r.registered === false);
    ok('already-small source: reason names the actual cause', /would not help/.test(r.reason));
  }

  // --- getPixiProxyStats reflects exactly those three outcomes, and no other -
  const after = getPixiProxyStats();
  ok('unavailable incremented by exactly 1', after.unavailable - before.unavailable === 1);
  ok('alreadyCached incremented by exactly 1', after.alreadyCached - before.alreadyCached === 1);
  ok('skippedTooSmall incremented by exactly 1', after.skippedTooSmall - before.skippedTooSmall === 1);
  ok(
    'registered did NOT increment — none of the three branches above reach the real seed path',
    after.registered === before.registered
  );
}
