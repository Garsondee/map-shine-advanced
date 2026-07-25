/**
 * GPU texture-size limits — the foundation of the "load whole images like
 * PIXI" direction (2026-07-17, the 12000² mansion device-loss investigation).
 *
 * THE BACKGROUND. MSA's virtual-texture page-streaming (atlas + page cache +
 * indirection) exists for one reason: WebGPU's DEFAULT `maxTextureDimension2D`
 * is 8192, and the author's Level art is 12000² — too big for a single GPU
 * texture, so it was sliced into thousands of 256px pages and streamed. That
 * streaming (evict + re-upload under a 512MB cap far too small for a multifloor
 * view) is what backed the GPU command queue up until Chrome's TDR watchdog
 * killed the device — measured live: ~3360 page-uploads and a 551ms queue
 * drain to display what PIXI draws with ~7 whole-image textures. PIXI never
 * hit this: it runs WebGL, whose limit on the same 3070 is 16384, so it
 * uploads each 12000² floor whole.
 *
 * THE FIX. three.js's WebGPURenderer accepts `requiredLimits`, forwarded
 * straight to `adapter.requestDevice` (vendored `three.webgpu.js`). So we
 * request a higher `maxTextureDimension2D` and load images whole (or, on
 * hardware that can't, in the smallest tile grid that fits — see
 * `planImageTiles`). This module is the pure, Node-testable arithmetic behind
 * both halves; the browser wiring lives in `vt-pan-viewer.js` (renderer
 * creation) and the loader.
 *
 * @module vt/texture-limits
 */

/** WebGPU's spec-guaranteed floor for `maxTextureDimension2D` — every adapter
 * supports at least this. We never request below it, never assume above it. */
export const WEBGPU_SPEC_MIN_TEXTURE_DIM = 8192;

/** The cap we AIM for: the author's largest planned map is 12000², and 16384 is
 * the widely-supported next tier above the 8192 default — it clears 12K with
 * headroom and "just works" on the overwhelming majority of desktop GPUs.
 * Requesting exactly what's needed (rather than the adapter's absolute maximum)
 * keeps the device request conservative. */
export const DESIRED_TEXTURE_DIM = 16384;

/**
 * Choose the `maxTextureDimension2D` to request from the WebGPU device. Pure.
 *
 * - Never asks for MORE than the adapter reports (that makes `requestDevice`
 *   throw — a self-inflicted device-creation failure).
 * - Never asks for LESS than the 8192 spec floor (which every adapter grants),
 *   even if a bogus/small `adapterMax` is passed.
 * - Otherwise targets `desired` (16384) — enough for any planned map whole.
 *
 * Hardware whose adapter caps at 8192 simply stays at 8192 here; the loader's
 * `planImageTiles` then splits any oversized image into a grid that fits under
 * whatever limit we actually ended up with.
 *
 * @param {number} adapterMax - `adapter.limits.maxTextureDimension2D`.
 * @param {number} [desired=DESIRED_TEXTURE_DIM]
 * @returns {number} the value to pass as `requiredLimits.maxTextureDimension2D`.
 */
export function chooseTextureLimit(adapterMax, desired = DESIRED_TEXTURE_DIM) {
  const supported =
    Number.isFinite(adapterMax) && adapterMax > WEBGPU_SPEC_MIN_TEXTURE_DIM ? adapterMax : WEBGPU_SPEC_MIN_TEXTURE_DIM;
  const want =
    Number.isFinite(desired) && desired > WEBGPU_SPEC_MIN_TEXTURE_DIM ? desired : WEBGPU_SPEC_MIN_TEXTURE_DIM;
  return Math.min(supported, want);
}

/** WebGPU's spec-guaranteed floor for `maxStorageBuffersPerShaderStage` — every
 * adapter supports at least this (it is also the DEFAULT the renderer already
 * requests implicitly, hence "8" being the number in a real, live error: "The
 * number of storage buffers (9) in the Compute stage exceeds the maximum
 * per-stage limit (8)", 2026-07-22 — the wind-gust compute kernel's arena
 * buffers + trail history + wall-structure/exposure/door-chaos grids added up
 * to 9, one over this floor). We never request below it, never assume above. */
export const WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE = 8;

/** The cap we AIM for — double the spec floor, the same "widely-supported next
 * tier" reasoning as `DESIRED_TEXTURE_DIM`'s own 2×. The adapter that hit the
 * live error above reported supporting 16 (the error message states this
 * itself); more particle/wind-field storage buffers are a plausible future
 * ask (this codebase already has two compute-heavy effects sharing the arena
 * + up to three optional wind grids each), so targeting real headroom now
 * avoids re-diagnosing the identical error again after the next one lands. */
export const DESIRED_STORAGE_BUFFERS_PER_STAGE = 16;

/**
 * Choose the `maxStorageBuffersPerShaderStage` to request from the WebGPU
 * device. Pure — same shape and same safety discipline as
 * {@link chooseTextureLimit}: never ask for more than the adapter reports
 * (that makes `requestDevice` throw), never ask for less than the 8-buffer
 * spec floor every adapter grants, otherwise target `desired` (16).
 *
 * @param {number} adapterMax - `adapter.limits.maxStorageBuffersPerShaderStage`.
 * @param {number} [desired=DESIRED_STORAGE_BUFFERS_PER_STAGE]
 * @returns {number} the value to pass as `requiredLimits.maxStorageBuffersPerShaderStage`.
 */
export function chooseStorageBufferLimit(adapterMax, desired = DESIRED_STORAGE_BUFFERS_PER_STAGE) {
  const supported =
    Number.isFinite(adapterMax) && adapterMax > WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE
      ? adapterMax
      : WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE;
  const want =
    Number.isFinite(desired) && desired > WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE
      ? desired
      : WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE;
  return Math.min(supported, want);
}

/**
 * Browser glue around {@link chooseTextureLimit} + {@link chooseStorageBufferLimit}:
 * query the WebGPU adapter and build the `requiredLimits` object to hand
 * `new THREE.WebGPURenderer({...})`, so its device is created with BOTH raised
 * caps. Query the adapter for its real max FIRST and clamp to each
 * independently — requesting more than the adapter supports makes
 * `requestDevice` throw (a self-inflicted device-creation failure), whereas
 * clamping degrades gracefully (weak hardware just keeps the spec floor, and
 * the loader/particle engines degrade to fit — see each limit's own doc).
 * The two limits are resolved INDEPENDENTLY (one query failing/reporting
 * falsy never skips the other) — a compute-shader storage-buffer ceiling and
 * a texture-size ceiling are unrelated GPU resources.
 *
 * Returns `undefined` when there's no adapter at all (WebGL2 path, or WebGPU
 * unavailable) — pass that straight through and three keeps its defaults.
 *
 * MUST be applied to EVERY WebGPURenderer whose device we care about — both the
 * boot heartbeat (what the flight recorder reports) and the VT viewer (what
 * actually draws the map) — or the two disagree and the report lies.
 *
 * Not unit-tested (it touches `navigator.gpu`); the arithmetic it delegates to
 * (`chooseTextureLimit`/`chooseStorageBufferLimit`) is the part with the Node
 * tests.
 *
 * @returns {Promise<{maxTextureDimension2D?:number, maxStorageBuffersPerShaderStage?:number}|undefined>}
 */
export async function resolveRendererRequiredLimits() {
  try {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter?.();
    if (!adapter) return undefined;
    const limits = {};
    const adapterMaxTexture = adapter.limits?.maxTextureDimension2D;
    if (adapterMaxTexture) limits.maxTextureDimension2D = chooseTextureLimit(adapterMaxTexture);
    // STORAGE BUFFERS (2026-07-22, a live "9 exceeds limit 8" GPUValidationError
    // — see WEBGPU_SPEC_MIN_STORAGE_BUFFERS_PER_STAGE's own doc for the exact
    // error). A compute-heavy effect (Wind Gusts: 5 arena buffers + trail
    // history + up to 3 optional wind grids) can genuinely need more than the
    // WebGPU default's 8-per-stage floor; raise it the SAME safe, adapter-
    // clamped way as the texture cap above.
    const adapterMaxStorageBuffers = adapter.limits?.maxStorageBuffersPerShaderStage;
    if (adapterMaxStorageBuffers) {
      limits.maxStorageBuffersPerShaderStage = chooseStorageBufferLimit(adapterMaxStorageBuffers);
    }
    return Object.keys(limits).length > 0 ? limits : undefined;
  } catch (_) {
    // No adapter / WebGPU unavailable / query threw — let three pick its
    // default limits; a device that genuinely can't be created trips the
    // renderer's own safety slide, not here.
  }
  return undefined;
}

/**
 * @typedef {object} ImageTile
 * @property {number} sx - source-pixel left of this tile.
 * @property {number} sy - source-pixel top.
 * @property {number} sw - source-pixel width (always ≤ maxDim).
 * @property {number} sh - source-pixel height (always ≤ maxDim).
 * @property {number} col - grid column (0-based).
 * @property {number} row - grid row (0-based).
 */

/**
 * @typedef {object} ImageTilePlan
 * @property {number} cols @property {number} rows
 * @property {number} tileW - even per-column width (last column may be smaller).
 * @property {number} tileH - even per-row height (last row may be smaller).
 * @property {boolean} whole - true when the image fits in ONE texture (1×1).
 * @property {ImageTile[]} tiles - row-major; together they tile the image
 *   EXACTLY (no gaps, no overlap) and every tile is ≤ maxDim on both axes.
 */

/**
 * Split an image into the SMALLEST grid of sub-rectangles that each fit within
 * `maxDim` (the texture limit we actually got — see `chooseTextureLimit`).
 * Pure. This is the author's "quarter-split" idea generalized: at 16384 a
 * 12000² floor is ONE whole tile; on hardware capped at 8192 it becomes an even
 * 2×2 of ~6000² tiles; below that, 3×3; etc. Each tile is uploaded ONCE and
 * kept resident — a handful of static textures, exactly how PIXI draws these,
 * NOT the per-256px page streaming that killed the device.
 *
 * The grid is the minimum that fits (`ceil(size / maxDim)` per axis) and splits
 * EVENLY (balanced tiles well under the limit) rather than packing max-size
 * tiles with a tiny remainder — even tiles keep every upload a similar,
 * predictable size and avoid a sliver tile at the edge.
 *
 * Source rects only; mapping each tile to its slice of the item's world quad is
 * the loader/renderer's job (proportional to sx/sy/sw/sh).
 *
 * @param {number} width - source image width in pixels.
 * @param {number} height - source image height in pixels.
 * @param {number} maxDim - max texture dimension (both axes).
 * @returns {ImageTilePlan}
 */
export function planImageTiles(width, height, maxDim) {
  if (!(Number.isFinite(width) && width > 0)) throw new Error(`planImageTiles: width must be > 0 (got ${width})`);
  if (!(Number.isFinite(height) && height > 0)) throw new Error(`planImageTiles: height must be > 0 (got ${height})`);
  if (!(Number.isFinite(maxDim) && maxDim > 0)) throw new Error(`planImageTiles: maxDim must be > 0 (got ${maxDim})`);

  const cols = Math.ceil(width / maxDim);
  const rows = Math.ceil(height / maxDim);
  // Even per-axis split. tileW = ceil(width/cols) ≤ maxDim by construction
  // (cols ≥ width/maxDim ⇒ width/cols ≤ maxDim), so every tile fits.
  const tileW = Math.ceil(width / cols);
  const tileH = Math.ceil(height / rows);

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    const sy = row * tileH;
    const sh = Math.min(tileH, height - sy);
    for (let col = 0; col < cols; col++) {
      const sx = col * tileW;
      const sw = Math.min(tileW, width - sx);
      tiles.push({ sx, sy, sw, sh, col, row });
    }
  }
  return { cols, rows, tileW, tileH, whole: cols === 1 && rows === 1, tiles };
}
