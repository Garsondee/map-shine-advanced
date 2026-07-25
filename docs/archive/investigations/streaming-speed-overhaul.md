# Tile Streaming Speed Overhaul

## Problem

The runtime pyramid sliced each cell by re-decoding the full source PNG/JPEG on every IndexedDB miss, serialized one decode at a time per source URL on the main thread. On a 12000×12000 map this meant ~144 full-image decodes before the cache warmed, producing blank cells during pan and very slow LOD upgrades.

## Solution

### Decode-once worker pool

- `scripts/streaming/tile-decode-worker.js` — module worker that decodes each source **once** to a master `ImageBitmap`, then slices cells with cheap sub-rect `createImageBitmap` calls.
- `scripts/streaming/tile-decode-pool.js` — 2–4 worker pool (by `hardwareConcurrency` / `deviceMemory`), priority queue, source affinity.
- WebP persistence to IndexedDB happens in the worker **after** the bitmap is returned to the main thread (tile appears immediately).
- Legacy main-thread path remains when workers or `OffscreenCanvas` are unavailable.

### Never-blank coverage

- Huge scenes eagerly mount a coarse per-cell fallback grid (LOD 3–4) on mount.
- `warmPyramidForManifest()` bakes coarse-first, then finer LODs during idle (`requestIdleCallback` from `TileStreamingManager`).

### Scheduler tuning

- Raised concurrent load caps (6–16 inflight depending on budget/pan).
- Removed LOD-0 inflight cap (worker pool is the throttle).
- Focal cells load target LOD directly when coarse base is ready (no double-pass coarse→sharp for first resident).

### Effect culling

- `scripts/streaming/streaming-detail-api.js` — focal LOD, detail tier (`full|medium|coarse|minimal`), particle scale.
- `TileStreamingManager.getFocalLod()`, `getDetailTier()`, `isCellResident()`, `getVisibleCellKeys()`.
- Weather particles scale emission by detail tier; roof drips skip at `coarse`/`minimal`.

## Diagnostics

Streaming minimap dashboard and `buildTileStreamingReport()` show decode pool queue depth, worker count, and pyramid bake progress.

## Verification checklist

1. **Cold IDB** — clear `map-shine-streaming` in DevTools → Application → IndexedDB; reload scene. Coarse fallback should load visible cells first (lazy on 12×12+ grids); pan should not show blank cells or WebGL context loss.
2. **Performance** — Performance panel: no multi-second main-thread tasks during pan; GPU uploads throttled to 3 concurrent bitmap transfers.
3. **Warm IDB** — second load should show near-instant cell residency.
4. **Minimap** — decode workers active, bake progress advancing on first visit (IDB-only idle warm).

## WebGL context loss fix (2026-06)

Initial worker rollout caused GPU/VRAM exhaustion from:

- `Promise.all` on 144+ coarse fallback cells uploading textures simultaneously
- `warmPyramid` on mount baking all LODs and leaking ImageBitmaps on main thread
- Full 12k master bitmap held in worker + 4 parallel workers on huge scenes

Mitigations applied:

- Lazy coarse fallback restored for grids > 36 cells; batched eager mount (4–6 concurrency) for smaller grids
- Idle warm is IDB-only (`bake-tile-idb`) — no GPU upload during background bake
- Coarse LOD only during idle warm; worker source released after warm
- Max 3 concurrent bitmap→GPU transfers; pool size capped at 1–2 on huge/low-memory scenes
- LOD-0 inflight cap restored; conservative grid concurrency restored

## Files touched

- `scripts/streaming/tile-decode-worker.js` (new)
- `scripts/streaming/tile-decode-pool.js` (new)
- `scripts/streaming/texture-pyramid-builder.js`
- `scripts/streaming/streamed-background-grid.js`
- `scripts/streaming/tile-streaming-manager.js`
- `scripts/streaming/streaming-detail-api.js` (new)
- `scripts/particles/WeatherParticles.js`
- `scripts/ui/streaming-minimap.js`
- `scripts/ui/tile-streaming-report.js`
