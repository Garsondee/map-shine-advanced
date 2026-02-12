# Persistent Asset Cache — Planning Document

## Problem Statement

MapShine's current asset cache is **in-memory only** (`Map` objects on the JS heap). It is destroyed on every page reload. In real usage, most scenes are loaded **once** by the GM during prep and **once** by each player — there is never a "return visit" within the same browser session. The cache has a **0% hit rate** in practice.

### Current Loading Cost (from profiler)

| Stage | Time | What Happens |
|---|---|---|
| `al.discover` | 52ms | FilePicker browse for directory listing |
| `al.fetch` × 5 masks | 58–1776ms each | Network download of WebP blobs (5.7MB total) |
| `al.decode` × 5 masks | 265–1514ms each | `createImageBitmap` off-thread decode |
| `gpu.textureWarmup` | 247ms | `renderer.initTexture()` upload to GPU |
| **Total mask pipeline** | **~3634ms** | |
| `tile.fetch` (Glassware) | **56000ms+** | Large tile from slow server — times out |

A persistent cache that eliminates network fetches would cut the mask pipeline to ~2s (decode + GPU upload only). Caching decoded pixel data in IndexedDB could further cut it to ~250ms (GPU upload only).

---

## Current Architecture

### 1. Asset Bundle Cache (`assetCache` — `loader.js`)
- **Type**: `Map<string, MapAssetBundle>`
- **Key**: `${basePath}::masks` or `${basePath}::full`
- **Value**: `{ basePath, baseTexture, masks: [{id, texture, path, ...}], isMapShineCompatible }`
- **Lifetime**: Page session only. Was previously cleared on every `destroyThreeCanvas()` — fixed to persist across scene transitions.
- **Validation**: Checks for critical masks (`specular`, `outdoors`), stale textures (disposed image data), re-uploads on hit (`needsUpdate = true`).

### 2. Tile Texture Cache (`textureCache` — `tile-manager.js`)
- **Type**: `Map<string, THREE.Texture>` on TileManager instance
- **Key**: Full texture URL path
- **Lifetime**: Cleared on `dispose(clearCache=true)` — every scene transition.
- **Also caches**: Water mask textures, specular mask textures, directory file listings.

### 3. Generic Texture Cache (`textureCache` — `loader.js`)
- **Type**: `Map<string, THREE.Texture>` (module-level)
- **Key**: Normalized path
- **For**: Light cookies, gobos — non-map singleton textures.

### 4. Foundry's TextureLoader (PIXI — not used by MapShine)
- TTL: 15 minutes. Memory limits: 1.7–10.2GB.
- MapShine bypasses this entirely (loads THREE.Texture via fetch + createImageBitmap).
- Foundry does pre-load scene tile textures via PIXI before MapShine runs.

### Why the Cache Fails Today

1. **Page reload destroys all JS heap data** — Map objects are gone.
2. **Scene transitions destroy TileManager** — tile texture cache cleared.
3. **GPU disposal invalidates texture objects** — even if JS references survive, the image data may be stale after `sceneComposer.dispose()`.
4. **No persistent storage used** — nothing written to IndexedDB, Cache API, or localStorage.

---

## Proposed Architecture: Three-Tier Persistent Cache

### Tier 1: Cache API — Raw Blob Storage (eliminates network fetch)

**What**: Intercept all `fetch()` calls for mask and tile images. Store the raw HTTP `Response` in the browser's [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache).

**Why**: The Cache API is designed exactly for this — storing HTTP responses by URL. It's available in all modern browsers, has virtually unlimited storage (browser-managed), and requires no serialization. A cache hit is a local disk read (~1-5ms) instead of a network round-trip (58–56000ms).

**Implementation**:
```js
const CACHE_NAME = 'map-shine-assets-v1';

async function cachedFetch(url, options = {}) {
  const cache = await caches.open(CACHE_NAME);
  
  // Check cache first
  const cached = await cache.match(url);
  if (cached) {
    // Validate: check if server has a newer version (conditional request)
    // Only do this if we have an ETag or Last-Modified from the cached response
    const etag = cached.headers.get('ETag');
    const lastMod = cached.headers.get('Last-Modified');
    if (etag || lastMod) {
      try {
        const headers = {};
        if (etag) headers['If-None-Match'] = etag;
        if (lastMod) headers['If-Modified-Since'] = lastMod;
        const revalidate = await fetch(url, { method: 'HEAD', headers });
        if (revalidate.status === 304) return cached; // Not modified — cache is valid
        if (revalidate.ok) {
          // Server has a newer version — re-download
          // (fall through to fresh fetch below)
        }
      } catch (_) {
        // Network error during revalidation — use cached version
        return cached;
      }
    } else {
      return cached; // No validation headers — trust the cache
    }
  }
  
  // Cache miss or stale — fresh fetch
  const response = await fetch(url, options);
  if (response.ok) {
    // Clone before consuming body (response can only be read once)
    cache.put(url, response.clone());
  }
  return response;
}
```

**Cache Key**: The full URL (Cache API uses Request/URL matching natively).

**Invalidation**:
- **Module version bump**: Change `CACHE_NAME` to `map-shine-assets-v2` → old cache auto-expires.
- **File change detection**: Use conditional requests (`If-None-Match` / `If-Modified-Since`) for revalidation.
- **Manual clear**: Expose a "Clear MapShine Cache" button in module settings.
- **Size limit**: Browser manages storage quotas automatically. We can also implement LRU eviction based on `cache.keys()` count.

**What it caches**:
- Mask WebP/PNG files (5 files × 86KB–2.4MB = ~5.7MB per scene)
- Tile textures (Glassware.webp — potentially large, 10MB+)
- Discovery results (as a JSON response — see Tier 3)

**Expected savings**: Eliminates network fetch for masks (~1.5–3.5s) and tiles (up to 56s for slow servers).

---

### Tier 2: IndexedDB — Decoded ImageData Storage (eliminates decode)

**What**: After `createImageBitmap` decodes a mask, extract the pixel data (`ImageData`) and store it in IndexedDB. On cache hit, create a `THREE.Texture` directly from the stored `ImageData` — skipping both fetch and decode.

**Why**: `createImageBitmap` decode takes 265–1514ms per mask (off-thread but still wall-clock time the user waits). For 5 masks, that's ~3s of decode time. Storing pre-decoded pixel data eliminates this entirely.

**Implementation**:
```js
const DB_NAME = 'map-shine-decoded-masks';
const DB_VERSION = 1;
const STORE_NAME = 'masks';

// Store decoded mask data after first load
async function storeDecodedMask(url, imageData, metadata) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put({
    url,
    width: imageData.width,
    height: imageData.height,
    // Store as ArrayBuffer (transferable, compact)
    data: imageData.data.buffer,
    colorSpace: metadata.colorSpace,
    isColor: metadata.isColor,
    moduleVersion: MODULE_VERSION,
    storedAt: Date.now()
  });
  await tx.done;
}

// Retrieve decoded mask data
async function getDecodedMask(url) {
  const db = await openDB();
  const entry = await db.transaction(STORE_NAME).objectStore(STORE_NAME).get(url);
  if (!entry || entry.moduleVersion !== MODULE_VERSION) return null;
  
  // Reconstruct ImageData from stored ArrayBuffer
  const pixels = new Uint8ClampedArray(entry.data);
  const imageData = new ImageData(pixels, entry.width, entry.height);
  return { imageData, metadata: entry };
}
```

**Storage format**: Raw RGBA pixel data as `ArrayBuffer`. For a 4096×4096 mask, that's 64MB uncompressed. This is large but IndexedDB handles it well (it's backed by disk, not RAM).

**Compression option**: Store the original WebP blob instead (much smaller: ~1MB vs 64MB). Then on cache hit, only `createImageBitmap` is needed (no network). This is essentially Tier 1 but via IndexedDB instead of Cache API. **Recommendation: Use Tier 1 (Cache API) for blobs and skip raw pixel storage** — the decode cost (~1.5s total) is acceptable and the storage savings are enormous.

**When Tier 2 makes sense**: Only for masks that are decoded at very high resolution (4096×4096) and where the 300–600ms decode time per mask is a bottleneck. Consider this a Phase 2 optimization if Tier 1 + Tier 3 don't achieve acceptable load times.

---

### Tier 3: IndexedDB — Discovery Manifest Cache (eliminates FilePicker browse)

**What**: Cache the FilePicker directory listing results per scene base path. Store which mask suffixes exist and their resolved URLs.

**Why**: 
- FilePicker browse takes 52ms and requires a server round-trip.
- Player clients often lack FilePicker permissions, forcing expensive HEAD-request probing.
- The manifest rarely changes (only when the GM re-exports the map with different masks).

**Implementation**:
```js
// After successful discovery + mask loading, store the manifest
async function storeDiscoveryManifest(basePath, masks, moduleVersion) {
  const db = await openDB();
  const manifest = {
    basePath,
    masks: masks.map(m => ({
      id: m.id,
      path: m.path,
      suffix: m.suffix
    })),
    moduleVersion,
    storedAt: Date.now()
  };
  await db.transaction('manifests', 'readwrite')
    .objectStore('manifests').put(manifest, basePath);
}

// On load, check manifest first — skip FilePicker entirely
async function getDiscoveryManifest(basePath, moduleVersion) {
  const db = await openDB();
  const manifest = await db.transaction('manifests')
    .objectStore('manifests').get(basePath);
  if (!manifest || manifest.moduleVersion !== moduleVersion) return null;
  return manifest;
}
```

**Invalidation**:
- Module version change invalidates all manifests.
- Manual "re-scan" button for GMs who re-export maps.
- Optional: background revalidation (check FilePicker after loading from manifest, update if different).

**Expected savings**: 52ms + eliminates player client FilePicker permission issues.

---

## Integration Points

### Where to intercept in the existing code

| File | Function | Change |
|---|---|---|
| `loader.js` | `loadMaskTextureDirect()` | Replace `fetch()` with `cachedFetch()` from Tier 1 |
| `loader.js` | `loadAssetBundle()` | Check Tier 3 manifest before calling `discoverAvailableFiles()` |
| `loader.js` | `loadAssetBundle()` | After successful load, store manifest to Tier 3 |
| `loader.js` | `probeMaskUrl()` | Replace `fetch()` HEAD requests with `cachedFetch()` |
| `tile-manager.js` | `loadTileTexture()` | Replace `fetch()` with `cachedFetch()` from Tier 1 |
| `canvas-replacement.js` | Cache stats diagnostic | Report persistent cache stats (Tier 1 + 3 sizes) |
| Module settings | New setting | "Clear MapShine Cache" button |

### New file: `scripts/assets/persistent-cache.js`

Single module responsible for all persistent cache operations:
- `cachedFetch(url)` — Cache API wrapper (Tier 1)
- `storeManifest(basePath, masks)` / `getManifest(basePath)` — IndexedDB manifest (Tier 3)
- `getCacheSizeEstimate()` — Report total persistent cache size
- `clearAll()` — Wipe both Cache API and IndexedDB stores
- `clearScene(basePath)` — Wipe cache for a specific scene

---

## Cache Lifecycle

```
Page Load (first visit to scene)
├── Check Tier 3 manifest (IndexedDB) → MISS
├── FilePicker browse (52ms) → discover mask files
├── For each mask:
│   ├── Check Tier 1 (Cache API) → MISS
│   ├── Network fetch (58–1776ms) → download WebP blob
│   ├── Store in Tier 1 (Cache API)
│   ├── createImageBitmap decode (265–1514ms)
│   └── Create THREE.Texture → store in memory cache
├── Store discovery manifest in Tier 3 (IndexedDB)
├── GPU warmup (247ms)
└── Total: ~3634ms

Page Load (second visit — same scene, different session)
├── Check Tier 3 manifest (IndexedDB) → HIT (skip FilePicker)
├── For each mask:
│   ├── Check Tier 1 (Cache API) → HIT (~1-5ms disk read)
│   ├── createImageBitmap decode (265–1514ms)
│   └── Create THREE.Texture → store in memory cache
├── GPU warmup (247ms)
└── Total: ~1800ms (50% reduction)

Scene Transition (same session, return to cached scene)
├── Check memory cache → HIT
├── Mark textures needsUpdate = true
├── GPU re-upload (247ms)
└── Total: ~300ms (92% reduction)
```

---

## Profiler Integration

The debug loading profiler should report persistent cache status:

```
Asset Cache Stats:
  Memory cache: HIT (5 masks, re-upload)
  Persistent cache (Cache API): 12 entries, ~18.2 MB
  Discovery manifest: HIT (scene manifest found)
  Cache strategy: Tier 1 blob + Tier 3 manifest
```

New event log entries:
```
[+0.002s] cache.manifest: HIT for mythica-machina-wizards-lair-laboratory_Ground (5 masks)
[+0.003s] cache.tier1: HIT for _Specular.webp (1017556 bytes, 2ms)
[+0.005s] cache.tier1: HIT for _Fire.webp (86520 bytes, 1ms)
...
```

---

## Invalidation Matrix

| Trigger | Tier 1 (Cache API) | Tier 2 (future) | Tier 3 (Manifest) |
|---|---|---|---|
| Module version bump | New cache name → old expires | New DB version | moduleVersion mismatch → skip |
| GM re-exports map | Conditional request (ETag/Last-Modified) | N/A | Background revalidation |
| User clicks "Clear Cache" | `caches.delete(CACHE_NAME)` | `indexedDB.deleteDatabase()` | Same DB wipe |
| Browser storage pressure | Browser auto-evicts (origin-scoped) | Browser auto-evicts | Browser auto-evicts |
| File URL changes (different map) | Different URL = different cache key | Different key | Different basePath |

---

## Implementation Phases

### Phase 1: Cache API for Blobs (highest impact, simplest)
- Create `persistent-cache.js` with `cachedFetch()`.
- Wire into `loadMaskTextureDirect()` and `loadTileTexture()`.
- Add "Clear MapShine Cache" module setting.
- Add profiler diagnostics for persistent cache stats.
- **Expected result**: Mask loading drops from ~3.5s to ~1.8s on revisit. Tile loading from 56s+ to ~1-5ms on revisit.

### Phase 2: Discovery Manifest (medium impact, easy)
- Add IndexedDB manifest store.
- Wire into `loadAssetBundle()` to skip `discoverAvailableFiles()`.
- Add background revalidation so stale manifests self-correct.
- **Expected result**: Additional 52ms saved + player client reliability improved.

### Phase 3: Decoded Pixel Cache (lower impact, more complex)
- Store decoded `ImageData` in IndexedDB for highest-cost masks.
- Only for masks where decode time > 500ms (bush, tree, specular).
- **Expected result**: Additional ~1.5s saved (decode eliminated for large masks).

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Cache grows unbounded | Module version in cache name rotates on update; browser manages quotas; manual clear button |
| Stale cache serves wrong data | Conditional requests (ETag/Last-Modified); module version mismatch check |
| IndexedDB unavailable (private browsing) | Graceful fallback to in-memory only; log warning |
| Cache API unavailable (rare) | Feature-detect `caches` global; fallback to network-only |
| Large IndexedDB entries slow to read | Phase 3 only stores pixel data for masks > 500ms decode; blobs (Phase 1) are small |
| Conflict with Foundry's PIXI cache | MapShine uses separate THREE.Texture pipeline — no overlap with Foundry's TextureLoader |

---

## Size Estimates

For the Wizards Lair / Laboratory scene:

| Asset | Raw Size | Cache API Entry | IndexedDB Pixel Data |
|---|---|---|---|
| `_Specular.webp` | 1.0 MB | 1.0 MB | 64 MB (4096²×4) |
| `_Fire.webp` | 84 KB | 84 KB | 16 MB (2048²×4) |
| `_Outdoors.webp` | 92 KB | 92 KB | 16 MB (2048²×4) |
| `_Bush.webp` | 2.1 MB | 2.1 MB | 64 MB (4096²×4) |
| `_Tree.webp` | 2.3 MB | 2.3 MB | 64 MB (4096²×4) |
| Glassware tile | ~10 MB | ~10 MB | N/A (tile, not mask) |
| **Total** | **~15.6 MB** | **~15.6 MB** | **~224 MB** |

**Recommendation**: Phase 1 (Cache API blobs) adds ~15.6 MB per scene — very reasonable. Phase 3 (decoded pixels) adds ~224 MB per scene — only worth it for frequently-visited scenes with large masks.

---

## Module Settings

```js
game.settings.register('map-shine-advanced', 'persistentCache', {
  name: 'Persistent Asset Cache',
  hint: 'Cache mask textures and tile images to disk for faster loading on revisits. Disable if you experience stale textures.',
  scope: 'client',
  config: true,
  type: Boolean,
  default: true
});

game.settings.register('map-shine-advanced', 'clearPersistentCache', {
  name: 'Clear Persistent Cache',
  hint: 'Remove all cached mask and tile data. Use this after re-exporting maps or if you see visual artifacts.',
  scope: 'client',
  config: true,
  type: Boolean,
  default: false,
  onChange: async (value) => {
    if (value) {
      await clearAllPersistentCaches();
      game.settings.set('map-shine-advanced', 'clearPersistentCache', false);
      ui.notifications.info('MapShine cache cleared.');
    }
  }
});
```
