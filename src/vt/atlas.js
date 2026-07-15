/**
 * @fileoverview vt/atlas.js — the physical page atlas: one `THREE.DataArrayTexture`,
 * allocated once, holding every resident page for every layer-pack of every
 * floor (Keyhole.md §4.1).
 *
 * Split the same way `graph/three-allocator.js` splits `describe()` (pure) from
 * `create()` (THREE-touching): `computeAtlasLayout()` and `slotToAtlasPosition()`
 * are plain arithmetic, Node-testable without WebGL; `PageAtlas` is the thin
 * wrapper that actually owns the GPU resource and performs uploads via
 * `renderer.copyTextureToTexture()` — verified against the vendored Three
 * source rather than assumed: the older `copyTextureToTexture3D` is
 * deprecated in favor of the unified `copyTextureToTexture(src, dst,
 * srcRegion, dstPosition, ...level)`, which dispatches on `dst.isDataArrayTexture`
 * and uses `dstPosition.z` as the array layer — exactly the shape this module
 * is built around.
 *
 * RE-VERIFIED 2026-07-15 on upgrade r170→r185 (author confirmed r185 is
 * current stable; re-checked rather than assumed compatibility): the
 * `copyTextureToTexture` signature grew a second level param
 * (`srcLevel, dstLevel` replacing one shared `level`) and gained a new
 * routing condition (`properties.has(srcTexture)`) that sends ALREADY-TOUCHED
 * source textures through a framebuffer-blit path instead of the direct
 * texSubImage path — traced: `properties` auto-populates a WeakMap entry on
 * first `.get()`, and nothing before that check ever calls `.get()` on a
 * fresh, never-rendered `THREE.Texture` (exactly what `uploadPage()`'s
 * `srcTexture` always is — one built fresh, uploaded, disposed, never
 * reused), so this project's call shape should still take the same direct
 * path as before. Reasoned from source, not yet re-confirmed live at r185 —
 * treat as the first thing to check if uploads regress after this upgrade.
 * The `uploadTexture()`/`resetState()`/`bindTexture()` mechanics the rest of
 * this file's fixes depend on are byte-for-byte unchanged between r170
 * and r185.
 *
 * @module vt/atlas
 */

/** Bytes per texel for RGBA8 (Keyhole Q1: 256x256 RGBA8 pages). */
export const BYTES_PER_TEXEL_RGBA8 = 4;

/**
 * Pure geometry: how many atlas layers a fixed VRAM budget buys, and the
 * resulting exact page capacity. Quantized to whole layers (floor, never
 * rounds up) so the physical allocation NEVER exceeds the budget — the same
 * "floor, never grow" discipline as `PageCache`'s own capacity math.
 *
 * At the Keyhole Q2 default (512 MB @ 8 GB tier) this reproduces Keyhole.md
 * §4.1's own worked example exactly: 4096x4096 atlas, 16x16=256 pages/layer,
 * 8 layers, 2048 pages, 512 MB — see the anchor test in __tests__.
 *
 * @param {object} options
 * @param {number} options.budgetBytes - fixed VRAM budget for the whole atlas.
 * @param {number} [options.pageSizePx] - full page size incl. border (default 256).
 * @param {number} [options.atlasSizePx] - one layer's width/height (default 4096;
 *   must be an exact multiple of pageSizePx).
 * @returns {{pageSizePx:number, atlasSizePx:number, pagesPerAxis:number,
 *   pagesPerLayer:number, layerBytes:number, layers:number,
 *   capacityPages:number, totalBytes:number}}
 */
export function computeAtlasLayout({ budgetBytes, pageSizePx = 256, atlasSizePx = 4096 }) {
  if (!(budgetBytes > 0)) throw new Error('computeAtlasLayout: budgetBytes must be > 0');
  if (atlasSizePx % pageSizePx !== 0) {
    throw new Error(
      `computeAtlasLayout: atlasSizePx (${atlasSizePx}) must be a multiple of pageSizePx (${pageSizePx})`
    );
  }
  const pagesPerAxis = atlasSizePx / pageSizePx;
  const pagesPerLayer = pagesPerAxis * pagesPerAxis;
  const pageBytes = pageSizePx * pageSizePx * BYTES_PER_TEXEL_RGBA8;
  const layerBytes = pagesPerLayer * pageBytes;
  const layers = Math.max(1, Math.floor(budgetBytes / layerBytes));
  const capacityPages = layers * pagesPerLayer;
  return {
    pageSizePx,
    atlasSizePx,
    pagesPerAxis,
    pagesPerLayer,
    layerBytes,
    layers,
    capacityPages,
    totalBytes: layers * layerBytes,
  };
}

/**
 * Pure mapping: a flat slot index (what `PageCache` hands out) -> its pixel
 * offset within the atlas array texture. Slots fill layer 0 fully before
 * layer 1 begins, row-major within a layer.
 *
 * @param {number} slot
 * @param {{pagesPerAxis:number, pagesPerLayer:number, pageSizePx:number}} layout
 * @returns {{x:number, y:number, layer:number}} pixel-space x/y (top-left of
 *   the page's slot) and the array layer.
 */
export function slotToAtlasPosition(slot, layout) {
  const { pagesPerAxis, pagesPerLayer, pageSizePx } = layout;
  if (slot < 0) throw new Error(`slotToAtlasPosition: negative slot ${slot}`);
  const layer = Math.floor(slot / pagesPerLayer);
  const withinLayer = slot % pagesPerLayer;
  const tileX = withinLayer % pagesPerAxis;
  const tileY = Math.floor(withinLayer / pagesPerAxis);
  return { x: tileX * pageSizePx, y: tileY * pageSizePx, layer };
}

/**
 * The physical GPU atlas. Allocated once at boot from a fixed `layout`
 * (see `computeAtlasLayout`), never resized, never exceeded — the law made
 * concrete for the virtual-texture cache specifically (parallel to
 * `graph/ThreeAllocator`'s law for frame-graph RTs).
 */
export class PageAtlas {
  /**
   * @param {object} options
   * @param {any} options.THREE - THREE namespace.
   * @param {ReturnType<typeof computeAtlasLayout>} options.layout
   * @param {any} [options.renderer] - a live THREE.WebGLRenderer; required
   *   before `uploadPage()` can be called (see `setRenderer`).
   */
  constructor({ THREE, layout, renderer = null }) {
    if (!THREE || typeof THREE.DataArrayTexture !== 'function') {
      throw new Error('PageAtlas: THREE.DataArrayTexture unavailable');
    }
    this._THREE = THREE;
    this.layout = layout;
    this._renderer = renderer;

    const { atlasSizePx, layers } = layout;
    // MUST be a real (non-null) buffer, not `null` — confirmed live 2026-07-15
    // by tracing the actual GL errors against the vendored r170 source
    // (three.module.js's uploadTexture(), ~line 25291): the texture's FIRST
    // real use always calls texSubImage3D(..., image.data) unconditionally,
    // and `null` there is exactly what produced "no bound PIXEL_UNPACK_BUFFER"
    // / "no texture bound to target" — the atlas was never properly
    // established, so every subsequent per-page upload failed too. A zeroed
    // buffer at the atlas's own FIXED size is NOT a law violation (the law
    // forbids WORLD-resolution allocations — this is the atlas's
    // already-budgeted size, identical to what's already committed on the
    // GPU side; individual pages still arrive one at a time via uploadPage(),
    // this only supplies the required one-time initial-clear buffer).
    const initialData = new Uint8Array(atlasSizePx * atlasSizePx * layers * BYTES_PER_TEXEL_RGBA8);
    this.texture = new THREE.DataArrayTexture(initialData, atlasSizePx, atlasSizePx, layers);
    this.texture.name = 'vt:pageAtlas';
    this.texture.needsUpdate = true;
  }

  /** @param {any} renderer */
  setRenderer(renderer) {
    this._renderer = renderer;
  }

  /**
   * Call ONCE before a batch of `uploadPage()` calls (not once per page —
   * this is real, if modest, GL state-setting work).
   *
   * WHY THIS EXISTS (root-caused live 2026-07-15 after several wrong
   * theories — interleaving, render-loop pausing — that didn't fix it):
   * `renderer.copyTextureToTexture()` binds the atlas via THREE's internal
   * `WebGLState` texture-unit CACHE (`currentTextureSlot` / `currentBoundTextures`,
   * verified directly in the vendored r170 source, `state.bindTexture()`) at a
   * HARDCODED unit (0). Normal material rendering (`renderer.render()`) ALSO
   * uses that exact cache for the shader's OWN sampler uniforms (`uPageAtlas`/
   * `uPageTable`), via THREE's own `allocateTextureUnit()` counter — a
   * COMPLETELY SEPARATE allocation scheme from `copyTextureToTexture`'s
   * hardcoded 0. After at least one render() has run, the cache's belief
   * about what's bound to unit 0 can end up inconsistent with what
   * `copyTextureToTexture` needs next, and its "already bound, skip the real
   * GL call" fast path goes stale — producing `texSubImage3D: no texture
   * bound to target`, reliably, on every upload after the first render.
   *
   * `renderer.resetState()` is THREE's own sanctioned fix for exactly this
   * class of problem (manual/external WebGL calls need to invalidate the
   * renderer's cached assumptions) — confirmed via source
   * (`WebGLState.reset()`) that it clears `currentTextureSlot`/
   * `currentBoundTextures` and otherwise resets to plain default GL state
   * (blend/depth-test/cull all OFF) — which is everything a simple, unblended
   * fullscreen-quad material like this project's VT viewers already assume,
   * so nothing needs restoring afterward. Safe and cheap to call once per
   * residency update.
   */
  prepareForUploadBatch() {
    this._renderer?.resetState?.();
  }

  /**
   * Upload one decoded page's pixels into its assigned slot.
   *
   * @param {number} slot - the PageCache-assigned slot index.
   * @param {any} srcTexture - a THREE.Texture (e.g. a DataTexture or
   *   CanvasTexture) holding exactly one decoded page's pixels
   *   (`layout.pageSizePx` square). Decode/slicing is the decode-pool's job
   *   (vt/decode-pool.js, part 2 of Stage 1) — this method only places
   *   already-decoded pixels into the atlas.
   */
  uploadPage(slot, srcTexture) {
    if (!this._renderer) throw new Error('PageAtlas.uploadPage: no renderer set — call setRenderer() first');
    const { x, y, layer } = slotToAtlasPosition(slot, this.layout);
    const dstPosition = new this._THREE.Vector3(x, y, layer);
    this._renderer.copyTextureToTexture(srcTexture, this.texture, null, dstPosition, 0);
  }

  dispose() {
    try {
      this.texture?.dispose?.();
    } catch (_) {}
  }
}
