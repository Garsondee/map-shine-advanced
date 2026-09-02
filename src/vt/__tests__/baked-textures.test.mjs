/**
 * Node verification for vt/baked-textures.js — the pre-baked-texture manifest
 * walk-up + freshness check + sidecar fetch (mythica-machina-press#439). No
 * real server: `fetchFn` is injected (the same pattern
 * foundry/active-scene-source.js already uses for `getRouteFn`), backed here
 * by a small in-memory route table, so this exercises the REAL manifest
 * lookup, walk-up, and freshness logic against REAL sidecar bytes produced by
 * this module's own `encodeSidecar` — not a hand-built fixture that could
 * silently drift from what the codec actually emits.
 */
import { fetchBakedTexture, _clearBakedManifestCacheForTests } from '../baked-textures.js';
import { encodeSidecar } from '../baked-format.js';
import { encodeBC1 } from '../block-compress.js';

/** A tiny fake HTTP layer: `routes` maps an exact URL to either
 * `{json: obj}`, `{bytes: Uint8Array}`, `{headers: {...}}` (for a HEAD), or
 * `undefined` (404). Records every request made, for order-independent
 * assertions ("was the sidecar ever fetched", not "was it the 3rd call"). */
function makeFakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Map() };
    if (init.method === 'HEAD') {
      const headers = route.headers || {};
      return {
        ok: true,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      };
    }
    if (route.json !== undefined) {
      return { ok: true, json: async () => route.json };
    }
    if (route.bytes !== undefined) {
      return {
        ok: true,
        arrayBuffer: async () =>
          route.bytes.buffer.slice(route.bytes.byteOffset, route.bytes.byteOffset + route.bytes.byteLength),
      };
    }
    return { ok: false, status: 500, headers: new Map() };
  };
  return { fetchFn, calls };
}

function makeBc1Sidecar(w, h) {
  const rgba = new Uint8Array(w * h * 4).fill(200);
  const blocks = encodeBC1(rgba, w, h);
  const padW = Math.ceil(w / 4) * 4;
  const padH = Math.ceil(h / 4) * 4;
  return encodeSidecar({
    format: 'bc1',
    width: w,
    height: h,
    levels: [{ width: padW, height: padH, blocks }],
    alphaStats: { min: 255, max: 255, mean: 255 },
  });
}

export async function run(t) {
  const { ok } = t;

  // --- the direct hit: manifest sits right next to the asset --------------
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(16, 16);
    const { fetchFn, calls } = makeFakeFetch({
      '/modules/mythica-machina-mansion/assets/msa-baked/manifest.json': {
        json: {
          entries: {
            'ground_floor_150.webp': { file: 'ground_floor_150.webp.msabc', format: 'bc1', sourceBytes: 12345 },
          },
        },
      },
      '/modules/mythica-machina-mansion/assets/ground_floor_150.webp': { headers: { 'content-length': '12345' } },
      '/modules/mythica-machina-mansion/assets/msa-baked/ground_floor_150.webp.msabc': { bytes: sidecar },
    });
    const result = await fetchBakedTexture('/modules/mythica-machina-mansion/assets/ground_floor_150.webp', {
      fetchFn,
    });
    ok('a fresh, correctly-named bake resolves the decoded shape', result && result.format === 'bc1');
    ok('the returned shape says cached:false (this was not an IndexedDB hit)', result?.cached === false);
    ok(
      'levels/width/height/alphaStats all arrive',
      result?.levels?.length === 1 && result?.width === 16 && result?.alphaStats?.min === 255
    );
    ok(
      'the HEAD freshness check actually ran',
      calls.some((c) => c.method === 'HEAD')
    );
  }

  // --- walk-up: asset lives one directory below the manifest ---------------
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(8, 8);
    const { fetchFn } = makeFakeFetch({
      '/modules/mythica-machina-mansion/assets/msa-baked/manifest.json': {
        json: { entries: { 'scenes/thumb.webp': { file: 'scenes/thumb.webp.msabc', format: 'bc1', sourceBytes: 99 } } },
      },
      '/modules/mythica-machina-mansion/assets/scenes/thumb.webp': { headers: { 'content-length': '99' } },
      '/modules/mythica-machina-mansion/assets/msa-baked/scenes/thumb.webp.msabc': { bytes: sidecar },
    });
    const result = await fetchBakedTexture('/modules/mythica-machina-mansion/assets/scenes/thumb.webp', { fetchFn });
    ok('a nested asset finds a manifest one directory up', result && result.format === 'bc1');
  }

  // --- a query string on the source URL does not break the lookup ---------
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(8, 8);
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'x.webp': { file: 'x.webp.msabc', format: 'bc1', sourceBytes: 1 } } },
      },
      '/modules/m/assets/x.webp?v=7': { headers: { 'content-length': '1' } },
      '/modules/m/assets/msa-baked/x.webp.msabc': { bytes: sidecar },
    });
    const result = await fetchBakedTexture('/modules/m/assets/x.webp?v=7', { fetchFn });
    ok('a cache-busting query string on the source URL does not defeat the lookup', result && result.format === 'bc1');
  }

  // --- no manifest at all: a module that was never baked -------------------
  {
    _clearBakedManifestCacheForTests();
    const { fetchFn, calls } = makeFakeFetch({});
    const result = await fetchBakedTexture('/modules/unbaked-module/assets/floor.webp', { fetchFn });
    ok('no manifest anywhere ⇒ null (fall through to the runtime encode)', result === null);
    const manifestCalls = calls.filter((c) => c.url.endsWith('manifest.json'));
    ok('it actually tried (this is a real miss, not a silent no-op)', manifestCalls.length >= 1);
  }

  // --- a manifest exists but has no entry for this specific file ----------
  {
    _clearBakedManifestCacheForTests();
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'other.webp': { file: 'other.webp.msabc', format: 'bc1', sourceBytes: 1 } } },
      },
    });
    const result = await fetchBakedTexture('/modules/m/assets/floor.webp', { fetchFn });
    ok('a manifest that does not list this file resolves null, not an error', result === null);
  }

  // --- STALE bake: the source file's size has changed since baking --------
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(8, 8);
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'floor.webp': { file: 'floor.webp.msabc', format: 'bc1', sourceBytes: 500 } } },
      },
      '/modules/m/assets/floor.webp': { headers: { 'content-length': '999' } }, // author re-exported the art after baking
      '/modules/m/assets/msa-baked/floor.webp.msabc': { bytes: sidecar },
    });
    const result = await fetchBakedTexture('/modules/m/assets/floor.webp', { fetchFn });
    ok('a size mismatch against the live source is treated as stale ⇒ null', result === null);
  }

  // --- HEAD fails (network hiccup): trust the bake rather than penalize it -
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(8, 8);
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'floor.webp': { file: 'floor.webp.msabc', format: 'bc1', sourceBytes: 500 } } },
      },
      // no route for the HEAD target ⇒ 404
      '/modules/m/assets/msa-baked/floor.webp.msabc': { bytes: sidecar },
    });
    const result = await fetchBakedTexture('/modules/m/assets/floor.webp', { fetchFn });
    ok(
      'an inconclusive freshness check trusts the bake (same posture as isSameResource)',
      result && result.format === 'bc1'
    );
  }

  // --- the sidecar file itself 404s (manifest lied, or a partial deploy) --
  {
    _clearBakedManifestCacheForTests();
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'floor.webp': { file: 'floor.webp.msabc', format: 'bc1', sourceBytes: 500 } } },
      },
      '/modules/m/assets/floor.webp': { headers: { 'content-length': '500' } },
      // no route for the .msabc file itself
    });
    const result = await fetchBakedTexture('/modules/m/assets/floor.webp', { fetchFn });
    ok('a missing sidecar file resolves null, never throws', result === null);
  }

  // --- a corrupt sidecar (bad magic) degrades to null, not a crash --------
  {
    _clearBakedManifestCacheForTests();
    const { fetchFn } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: { entries: { 'floor.webp': { file: 'floor.webp.msabc', format: 'bc1', sourceBytes: 500 } } },
      },
      '/modules/m/assets/floor.webp': { headers: { 'content-length': '500' } },
      '/modules/m/assets/msa-baked/floor.webp.msabc': { bytes: new Uint8Array(64) }, // garbage, not a real sidecar
    });
    const result = await fetchBakedTexture('/modules/m/assets/floor.webp', { fetchFn });
    ok('a corrupt sidecar file resolves null rather than throwing out of the caller', result === null);
  }

  // --- N assets in one directory share ONE manifest fetch -----------------
  {
    _clearBakedManifestCacheForTests();
    const sidecar = await makeBc1Sidecar(8, 8);
    const { fetchFn, calls } = makeFakeFetch({
      '/modules/m/assets/msa-baked/manifest.json': {
        json: {
          entries: {
            'a.webp': { file: 'a.webp.msabc', format: 'bc1', sourceBytes: 1 },
            'b.webp': { file: 'b.webp.msabc', format: 'bc1', sourceBytes: 1 },
          },
        },
      },
      '/modules/m/assets/a.webp': { headers: { 'content-length': '1' } },
      '/modules/m/assets/b.webp': { headers: { 'content-length': '1' } },
      '/modules/m/assets/msa-baked/a.webp.msabc': { bytes: sidecar },
      '/modules/m/assets/msa-baked/b.webp.msabc': { bytes: sidecar },
    });
    await fetchBakedTexture('/modules/m/assets/a.webp', { fetchFn });
    await fetchBakedTexture('/modules/m/assets/b.webp', { fetchFn });
    const manifestCalls = calls.filter((c) => c.url.endsWith('manifest.json'));
    ok('two assets in the same baked directory cost exactly one manifest fetch', manifestCalls.length === 1);
  }
}
