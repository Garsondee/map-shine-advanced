/**
 * Node verification for foundry/pixi-proxy-textures.js's pure parts
 * (computeProxyDimensions, urlsToEvictOnSceneChange), PLUS registerPixiProxy's
 * three EARLY-RETURN branches (unavailable/already-cached/too-small), which
 * resolve before touching OffscreenCanvas/createImageBitmap and so ARE
 * reachable with an injected fake `PIXI` (the function's own `opts.PIXI`
 * seam). The actual seed path (OffscreenCanvas draw + createImageBitmap +
 * real PIXI.Assets) stays browser-only -- verified live via the debug panel,
 * per this codebase's own convention -- so getPixiProxyStats().registered is
 * proven to exist and start at a sane baseline here, not to actually increment.
 */
import {
  computeProxyDimensions,
  DEFAULT_MAX_PROXY_DIMENSION_PX,
  registerPixiProxy,
  getPixiProxyStats,
  urlsToEvictOnSceneChange,
  planProxySeeding,
  isPixiSrcCached,
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

  // ==========================================================================
  // urlsToEvictOnSceneChange (added 2026-08-12) — the decision boot.js's
  // registerFloorProxies uses to release decode-pool.js's `_sourceCache`
  // entries for a scene that's been left behind, WITHOUT ever evicting a
  // same-scene floor switch's still-needed URLs (canvasInit fires for both;
  // only the scene id actually changing may evict anything).
  // ==========================================================================

  // --- same scene id (a floor switch, or a redundant canvasInit for the
  // scene already showing) -> NEVER evicts, regardless of what the URL lists
  // look like. This is the invariant that keeps a floor switch cheap. -------
  {
    const r = urlsToEvictOnSceneChange('scene-A', ['a.webp', 'b.webp'], 'scene-A', ['a.webp']);
    ok('same sceneId: returns [] even though the URL lists differ', Array.isArray(r) && r.length === 0);
  }
  {
    const r = urlsToEvictOnSceneChange(null, [], null, []);
    ok('both null sceneId (e.g. two blank-canvas calls in a row): treated as "same scene", returns []', r.length === 0);
  }

  // --- genuine scene change, no shared URLs: everything the old scene had
  // pinned is released. ------------------------------------------------------
  {
    const r = urlsToEvictOnSceneChange('scene-A', ['a.webp', 'b.webp'], 'scene-B', ['c.webp']);
    ok(
      'genuine scene change, no overlap: releases every previous URL',
      r.length === 2 && r.includes('a.webp') && r.includes('b.webp')
    );
    ok('genuine scene change, no overlap: does not release the incoming scene’s own URL', !r.includes('c.webp'));
  }

  // --- genuine scene change, ONE shared URL (two scenes legitimately reusing
  // the same background image, or a revisit): the shared URL must be KEPT
  // pinned, not closed and immediately re-fetched. ---------------------------
  {
    const r = urlsToEvictOnSceneChange('scene-A', ['shared.webp', 'a-only.webp'], 'scene-B', [
      'shared.webp',
      'b-only.webp',
    ]);
    ok('shared URL across scenes: kept (not returned for eviction)', !r.includes('shared.webp'));
    ok('non-shared previous URL: still released', r.includes('a-only.webp') && r.length === 1);
  }

  // --- incoming scene has no usable Level art (getActiveSceneFloors not ok)
  // -> nextUrls is [], so every previous URL is released; nothing left to keep. --
  {
    const r = urlsToEvictOnSceneChange('scene-A', ['a.webp', 'b.webp'], 'scene-B', []);
    ok('incoming scene has no floors: releases everything the previous scene had', r.length === 2);
  }

  // --- first-ever call: nothing was previously proxied, so there is nothing
  // to release, even though prevSceneId (null) !== nextSceneId. -------------
  {
    const r = urlsToEvictOnSceneChange(null, [], 'scene-A', ['a.webp']);
    ok('first call (no previous scene): returns [] (nothing was ever pinned yet)', r.length === 0);
  }

  // --- defensive: a stray falsy entry in prevUrls (should never happen --
  // registerFloorProxies filters with .filter(Boolean) -- but must not crash
  // or be handed back as something to "release"). ---------------------------
  {
    const r = urlsToEvictOnSceneChange('scene-A', ['a.webp', '', null, 'b.webp'], 'scene-B', []);
    ok('falsy entries in prevUrls are never returned for release', r.every(Boolean) && r.length === 2);
  }
  // --- seeding ORDER (loading audit C-01, 2026-10-25): the hook this runs from is
  // not awaited by Foundry, so it races Foundry's own texture loader; whatever is
  // seeded first is likeliest to win. The viewed floor goes first. -----------
  {
    const floors = [
      { index: 0, url: 'f0.webp' },
      { index: 1, url: 'f1.webp' },
      { index: 2, url: 'f2.webp' },
    ];
    const none = () => false;
    const r = planProxySeeding(floors, 1, none);
    ok('the VIEWED floor is seeded first', r.todo[0].index === 1);
    ok('…the rest keep their elevation order', r.todo[1].index === 0 && r.todo[2].index === 2);
    ok('nothing cached => nothing in the cached list', r.cached.length === 0);

    const r2 = planProxySeeding(floors, 2, (u) => u === 'f0.webp');
    ok('a floor PIXI already holds is listed as cached, not todo', r2.cached.length === 1 && r2.cached[0].index === 0);
    ok('…and the viewed floor still leads the todo list', r2.todo[0].index === 2 && r2.todo.length === 2);

    const r3 = planProxySeeding([{ index: 0, url: 'a' }, { index: 1, url: '' }, { index: 2 }, null], 0, none);
    ok('floors without a url (and junk entries) are ignored, never thrown on', r3.todo.length === 1);
    ok(
      'an unknown viewed floor leaves the order alone',
      planProxySeeding(floors, 9, none)
        .todo.map((f) => f.index)
        .join() === '0,1,2'
    );
    ok('undefined floors => empty plan', planProxySeeding(undefined, 0, none).todo.length === 0);
  }

  // --- isPixiSrcCached: a Map lookup, safe without PIXI ----------------------
  {
    const PIXI = { Assets: { cache: { has: (u) => u === 'seeded.webp' } } };
    ok('isPixiSrcCached: true for a seeded src', isPixiSrcCached('seeded.webp', PIXI) === true);
    ok('isPixiSrcCached: false for an unseen src', isPixiSrcCached('other.webp', PIXI) === false);
    ok('isPixiSrcCached: false (not a throw) when PIXI is unavailable', isPixiSrcCached('x', {}) === false);
  }
}
