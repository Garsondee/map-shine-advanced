/**
 * @fileoverview vt/vt-pan-viewer.js — Keyhole Stage 1 part 4b: the real
 * residency-driven streaming loop, keyboard pan/zoom/floor-switch.
 *
 * Builds directly on the smoke test's now-PROVEN atlas + indirection + vtSample
 * pipeline (Stage 1 part 4a, three live-tested fixes: Y-flip, coordinate-space
 * mismatch, clamp-bound conflation) — reuses the EXACT same UV-remap formula
 * rather than inventing a new one, specifically to avoid re-debugging
 * orientation/coordinate issues that are already solved. What's NEW here is
 * making residency dynamic: pan/zoom/floor-switch recompute the needed page
 * set every time the view changes, diff against what's currently resident,
 * decode+upload only what's newly needed, and unpin what fell out of view.
 *
 * MULTI-MIP (the single-mip cut is gone — this is Stage 1's coarse-fallback
 * increment). On floor load, every floor pins its COARSE set (the top few mip
 * levels, residency.coarseTopMipsForCap) as 'coarse' — permanently resident,
 * so the whole world always renders soft and floor switches are instant. Each
 * residency update chooses a mip analytically (residency.planResidency /
 * chooseMip — top-down camera, no GPU feedback), requests the fine set + a
 * coarser prefetch set at THEIR real mips, and the shader (vt-sample.glsl.js)
 * walks requested→coarsest and samples the finest-resident level. Zooming out
 * now serves coarser mips (bounded working set) instead of piling up mip-0
 * pages; a still-streaming texel resolves through the coarse pins as blur,
 * never black, never magenta.
 *
 * Uses the REAL Keyhole Q2 default atlas (512 MB, 2048-page capacity) — the
 * smoke test's small test atlas already proved the concept; this is the step
 * toward the actual Stage 1 gate (torture scene pans at 60fps, 20-cycle soak,
 * zero context loss on the 3070).
 *
 * MULTI-FLOOR COMPOSITING (author-reported live bug, 2026-07-15: a real
 * multi-level scene's upper floor showed solid BLACK where a hole in its art
 * should reveal the floor below). Verified against the real Foundry source
 * before building anything: floors are NOT swapped on floor-switch in real
 * Foundry — `client/documents/scene.mjs#_configureLevelTextures` draws the
 * viewed floor PLUS every other floor listed in ITS OWN `visibility.levels`
 * set, simultaneously, elevation-sorted, alpha-composited (see
 * `foundry/active-scene-source.js`'s `computeVisibleFloorIndices()`, which
 * replicates that exact rule). This module now renders one quad PER
 * currently-visible floor (not one quad total, rebound per switch): each
 * floor gets its own persistent `{geometry,material,mesh}` layer, created
 * once and toggled `visible` per residency update; materials are
 * alpha-blended (`transparent:true`) and depth-test disabled with explicit
 * `renderOrder = floorIndex` (== elevation-ascending, since
 * `getActiveSceneFloors` already sorts that way) standing in for real depth —
 * a flat 2D layered composite is exactly what a top-down multi-floor stack
 * is, so no actual Z-buffer is needed. The torture-fixture button's default
 * `visibleFloorIndices` (`(i) => [i]`) preserves the exact old single-floor
 * behavior — this is purely additive for callers that don't opt in.
 *
 * @module vt/vt-pan-viewer
 */

import { PageCache } from './page-cache.js';
import { PageTable, computeIndirectionAtlasLayout } from './page-table.js';
import { computeAtlasLayout, PageAtlas } from './atlas.js';
import {
  acquirePages,
  acquirePackedPages,
  getSourceDimensions,
  getDecodeStats,
  shouldYieldByTime,
} from './decode-pool.js';
import { VT_SAMPLE_GLSL, VT_MAX_MIPS } from './vt-sample.glsl.js';
import {
  createInitialViewState,
  applyKey,
  applyPanByPixels,
  applyZoomAtPixel,
  viewToWorldRect,
  clampHalfSpan,
  computeTargetPanVelocity,
  easeVelocityTowardTarget,
  integratePan,
  easedZoomFactor,
} from './view-state.js';
import { planResidency, coarsePinSet, coarseTopMipsForCap, diffResidency } from './residency.js';
import { stopVtSmokeTest } from './vt-smoke-test.js'; // the two share screen space; starting one stops the other

/** Wall-clock budget per GPU-upload chunk before yielding a real frame — see
 * requestDecodeUpload's Pass 3 for the live-hitch evidence this fixes. */
const MAX_MS_PER_UPLOAD_CHUNK = 10;

/**
 * Where to mount the VT canvas so it BECOMES the scene display (author request,
 * 2026-07-15: "make this the only display... fill the scene viewing space so we
 * don't have PIXI and threejs alongside each other"). We mount into Foundry's
 * own `canvas#board` container and sit at a z-index ABOVE the board
 * (`--z-index-canvas: 0`, verified in foundry2.css) but BELOW Foundry's UI
 * (`--z-index-ui: 60`) — so the VT view opaquely OCCLUDES the PIXI canvas while
 * every Foundry UI panel (and the debug panel at z-index 90) stays clickable on
 * top. This is the VISUAL half of Stage 2's severance; the VRAM half (stopping
 * Foundry from decoding full-res duplicates into PIXI at all) is the separate
 * proxy-texture-interception step. Falls back to a full-window overlay on
 * document.body if the board isn't in the DOM yet (e.g. no scene active).
 *
 * @returns {{host: HTMLElement, fill: boolean}}
 */
function resolveMountHost() {
  const board = document.getElementById('board');
  if (board?.parentElement) return { host: board.parentElement, fill: true };
  return { host: document.body, fill: true };
}

/** The scene-area size to render at, from the mount host's live client box. */
function measureHost(host) {
  const w = Math.max(1, host.clientWidth || window.innerWidth);
  const h = Math.max(1, host.clientHeight || window.innerHeight);
  return { width: w, height: h };
}

let _active = null;

function disposeActive() {
  if (!_active) return;
  // { capture: true } MUST match the addEventListener call exactly — the two
  // are treated as distinct registrations otherwise, and removal silently no-ops.
  try {
    window.removeEventListener('keydown', _active.onKeyDown, { capture: true });
  } catch (_) {}
  try {
    if (_active.onKeyUp) window.removeEventListener('keyup', _active.onKeyUp, { capture: true });
  } catch (_) {}
  try {
    if (_active.clearHeldKeys) {
      window.removeEventListener('blur', _active.clearHeldKeys);
      document.removeEventListener('visibilitychange', _active.clearHeldKeys);
    }
  } catch (_) {}
  try {
    if (_active.onResize) window.removeEventListener('resize', _active.onResize);
  } catch (_) {}
  try {
    _active.renderer.setAnimationLoop(null);
  } catch (_) {}
  try {
    _active.atlas.dispose();
  } catch (_) {}
  for (const layer of _active.layers.values()) {
    try {
      layer.material.dispose();
    } catch (_) {}
    try {
      layer.geometry.dispose();
    } catch (_) {}
  }
  for (const entry of _active.floors.values()) {
    for (const pack of entry.packs.values()) {
      try {
        pack.indirectionTexture.dispose();
      } catch (_) {}
    }
  }
  try {
    _active.canvas.remove();
  } catch (_) {}
  _active = null;
}

export function stopVtPanViewer() {
  disposeActive();
  return { stopped: true, at: new Date().toISOString() };
}

/**
 * @param {object} options
 * @param {any} options.THREE
 * @param {(floorIndex:number) => string} options.imageUrlForFloor
 * @param {number} options.floorCount
 * @param {(viewedFloorIndex:number) => number[]} [options.visibleFloorIndices] -
 *   given the currently-viewed floor index, which floor indices should be
 *   rendered (composited) this frame. Default `(i) => [i]` — single-floor-only,
 *   the exact pre-existing behavior (used by the torture-fixture button, which
 *   has no real Levels-visibility data to draw from). Real-scene callers pass
 *   `foundry/active-scene-source.js`'s `computeVisibleFloorIndices` bound to
 *   the scene's actual floor list, replicating Foundry's own multi-floor
 *   compositing rule.
 * @param {number} [options.initialFloorIndex] - which floor the view opens on
 *   (default 0). MUST match whatever Foundry itself is currently viewing when
 *   called from an automatic re-sync (boot.js's `canvasReady` handler) — this
 *   was the root cause of a real live bug (2026-07-15): every call used to
 *   hardcode floor 0 regardless of caller intent, so switching floors via
 *   Foundry's own UI (which re-fires `canvasReady` and re-invoked this
 *   function wholesale) silently snapped the view back to floor 0 every time,
 *   AND repeatedly reallocating the full 512MB atlas + page cache on every
 *   ordinary floor switch (this function's own full teardown+rebuild, meant
 *   for a genuine scene change, not a same-scene floor toggle) caused a real
 *   crash after a few toggles. See boot.js's `canvasReady` handler — it now
 *   only calls this for an ACTUAL scene change; a same-scene floor switch
 *   uses the far cheaper `setVtPanViewerFloor()` below instead.
 * @param {(floorIndex:number) => Array<{name:string, url:string}|{name:string, channelUrls:{r:string,g:string,b:string}}>} [options.extraLayerUrlsForFloor] -
 *   MULTI-LAYER (Keyhole §4.1, the mask pile-up killer): the ADDITIONAL layer-
 *   packs beyond albedo that this floor streams — every painted mask (_Outdoors,
 *   _Fire, _Specular, _Tree, _Bush …). Each entry is either `{name, url}` (a
 *   single-file mask — the normal case) or `{name, channelUrls:{r,g,b}}`
 *   (CHANNEL-PACKING: 3 single-channel mask files composited into ONE RGBA
 *   virtual texture at decode time, per §4.1 and decode-pool.js's
 *   `acquirePackedPages` — the fix for the real GPU page-cache pressure the
 *   unpacked castle-scenario test showed live, 2026-07-16). Either shape
 *   becomes its OWN virtual texture (own PageTable → own namespaced page keys
 *   → own indirection texture), streamed through the SAME fixed atlas + page
 *   cache as albedo. This is what proves V2's actual cause of death —
 *   `O(world × floors × masks)` textures all held at world resolution at once
 *   — is architecturally impossible here: the masks page through the keyhole
 *   exactly like albedo, so the working set stays `O(screen)` no matter how
 *   many mask layers exist. Only albedo is DISPLAYED by default (masks are
 *   inputs, not pixels, until an effect consumes them — `setDisplayLayer` can
 *   bind a mask for visual verification against the fixture's known
 *   patterns). Default `() => []` — albedo-only, the exact pre-existing
 *   behavior (real scenes store masks as scene flags, not URLs, so their mask
 *   streaming is a later step; the torture fixture emits real mask PNGs on
 *   disk, so it's proven there first — hard case first).
 * @returns {Promise<object>} initial diagnostics (see getDiagnostics() for the shape).
 */
export async function startVtPanViewer({
  THREE,
  imageUrlForFloor,
  floorCount,
  visibleFloorIndices,
  initialFloorIndex = 0,
  extraLayerUrlsForFloor,
}) {
  visibleFloorIndices ??= (i) => [i];
  extraLayerUrlsForFloor ??= () => [];
  // Captured for runZoomThrashTest's "blank slate" restart (2026-07-16) —
  // the SAME fully-resolved params this call itself used, so a later restart
  // reproduces an identical fresh viewer without the caller needing to
  // remember/re-supply them.
  const startupParams = {
    THREE,
    imageUrlForFloor,
    floorCount,
    visibleFloorIndices,
    initialFloorIndex,
    extraLayerUrlsForFloor,
  };
  disposeActive();
  stopVtSmokeTest(); // avoid two renderers fighting over the same corner of the screen

  const diag0 = { errors: [] };
  try {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default
    const cache = new PageCache({ budgetBytes: 512 * 1024 * 1024 });

    const mount = resolveMountHost();
    let canvasW = measureHost(mount.host).width;
    let canvasH = measureHost(mount.host).height;
    const canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-pan-viewer-canvas';
    canvas.width = canvasW;
    canvas.height = canvasH;
    Object.assign(canvas.style, {
      // Fill the mount host (the board container) exactly, occluding the PIXI
      // canvas beneath. z-index 5: above board (0) + hud (1), below Foundry UI
      // (60) and the debug panel (90). pointer-events:auto so the view is a
      // solid display (clicks don't secretly drive the hidden Foundry canvas);
      // Foundry UI still gets its clicks because it paints above this.
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '5',
      display: 'block',
      background: '#000',
      pointerEvents: 'auto',
    });
    mount.host.appendChild(canvas);

    // preserveDrawingBuffer:true -- WITHOUT this, the browser is free to clear
    // the drawing buffer immediately after each frame composites, so
    // gl.readPixels() called later from a button click (not from inside the
    // render callback itself) can legitimately read back (0,0,0,0) regardless
    // of what was actually drawn -- confirmed live 2026-07-15: the
    // 'renderedPixels' diagnostic read all-zero even though the indirection
    // buffer (plain JS state, unaffected by this) showed correct, non-degenerate
    // data. A real WebGL behavior, not a rendering bug -- but it made the
    // diagnostic itself unreliable. Kept for the diagnostics to stay trustworthy.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(canvasW, canvasH, false);

    const atlas = new PageAtlas({ THREE, layout, renderer });
    const floors = new Map(); // floorIndex -> floor entry (see ensureFloorLoaded)
    let loopActive = false; // tracks whether the render loop is running (batch uploads pause/restore it)

    /**
     * Build ONE layer-pack — one virtual texture = one floor × one layer
     * (albedo, or a mask like _Outdoors/_Fire): its PageTable, flattened-pyramid
     * indirection texture, per-mip uniform arrays, coarse-pin set, cached source
     * bitmap — and stream its coarse pins in. Every pack goes through the SAME
     * shared atlas + page cache (its page keys are namespaced by the table id,
     * so albedo and each mask never collide), which is the entire mask-pile-up
     * proof: N mask layers cost N small page-tables + their visible pages, never
     * N world-resolution textures. Factored out of the old single-layer
     * ensureFloorLoaded so albedo and masks share one code path.
     *
     * `coarsePinMaxPages` lets a non-displayed mask keep a lighter permanent
     * soft-floor than the displayed albedo — a mask is an input, not the hero
     * image, so a blurrier always-resident floor for it is fine, and it keeps
     * the permanently-pinned page count healthy when many packs coexist.
     *
     * `source` is either `{ url }` (the normal, single-file case — albedo and
     * every unpackable mask) or `{ channelUrls: {r,g,b} }` (CHANNEL-PACKING,
     * §4.1: 3 single-channel mask files composited into one RGBA virtual
     * texture at decode time via decode-pool.js's `acquirePackedPages` — see
     * that function's header for why this halves+ the pack count without
     * touching a single line of atlas/cache/table code: a packed page is just
     * another 256² RGBA page as far as everything downstream is concerned).
     */
    async function buildPack(floorIndex, name, source, { coarsePinMaxPages } = {}) {
      const isPacked = !!source.channelUrls;
      // Read dimensions WITHOUT holding a full 576 MB bitmap (getSourceDimensions
      // parses the PNG header) — the pack keeps only the URL(s); pages are
      // sliced on demand through the bounded, IndexedDB-backed acquire path.
      // For a packed pack, the 3 channel sources are assumed to share
      // dimensions (they're masks of the same floor at the same resolution,
      // like the fixture's authored trio) — the 'r' source is the reference.
      const dimUrl = isPacked ? source.channelUrls.r : source.url;
      const { width: srcWidth, height: srcHeight } = await getSourceDimensions(dimUrl);

      // NON-SQUARE WORLDS AREN'T SUPPORTED YET — fail loud (doctrine #1).
      // PageTable takes ONE worldSizePx (square grid by construction, see
      // page-table.js); a rectangular image would silently corrupt every crop
      // along the ignored axis. Applies per-pack: albedo AND every mask must be
      // square. Packs are assumed to share the floor's world size (the fixture's
      // masks are all SIZE² by construction; updateResidency warns, never
      // crashes, on a real mismatch). Rectangular-world support is deliberately
      // deferred (page-table/residency/shader all assume square) — tracked, not
      // silently dropped.
      if (srcWidth !== srcHeight) {
        throw new Error(
          `vt-pan-viewer: non-square layer image isn't supported yet (floor ${floorIndex} layer "${name}" is ` +
            `${srcWidth}x${srcHeight}, not square) — PageTable's page grid assumes a square world.`
        );
      }

      const table = new PageTable({ id: `panviewer:floor${floorIndex}:${name}`, worldSizePx: srcWidth });

      // The indirection is a flattened mip pyramid (all mips in one small
      // texture) — see page-table.js's computeIndirectionAtlasLayout + the
      // shader header. buf/texture are sized to the packed pyramid, not just mip 0.
      const indirectionLayout = computeIndirectionAtlasLayout(table);
      const { width, height } = indirectionLayout;
      const buf = new Uint8Array(width * height * 4); // all-zero = not resident everywhere, initially
      const indirectionTexture = new THREE.DataTexture(buf, width, height, THREE.RGBAFormat);
      indirectionTexture.flipY = false;
      indirectionTexture.generateMipmaps = false;
      indirectionTexture.minFilter = THREE.NearestFilter;
      indirectionTexture.magFilter = THREE.NearestFilter;

      // Per-mip uniform arrays (flat, fixed VT_MAX_MIPS length; unused tail
      // stays 0 and is never indexed — the shader only touches [reqMip,maxMip]).
      const mipOriginArr = new Int32Array(VT_MAX_MIPS * 2);
      const mipPagesArr = new Int32Array(VT_MAX_MIPS);
      for (let m = 0; m < indirectionLayout.origins.length; m++) {
        mipOriginArr[m * 2] = indirectionLayout.origins[m].x;
        mipOriginArr[m * 2 + 1] = indirectionLayout.origins[m].y;
        mipPagesArr[m] = indirectionLayout.origins[m].pagesPerAxis;
      }

      // COARSE PINS (§4.1): the top few mip levels of THIS pack, pinned
      // permanently so the whole floor always renders (soft) and floor switches
      // are instant. Decode + upload + pin them once, now.
      const topMips = coarseTopMipsForCap(table, coarsePinMaxPages ? { maxPages: coarsePinMaxPages } : {});
      const coarsePages = coarsePinSet(table, { topMips });
      const coarseKeySet = new Set(coarsePages.map((p) => p.key));

      const pack = {
        name,
        table,
        // Pages are sliced/composited on demand via acquirePages/acquirePackedPages;
        // no full bitmap is ever held on the pack itself. `packId` is the
        // synthetic IndexedDB identity for a packed pack's COMPOSITED result
        // (distinct from any individual channel source URL).
        source: isPacked
          ? { kind: 'packed', channelUrls: source.channelUrls, packId: `packed://floor${floorIndex}/${name}` }
          : { kind: 'single', url: source.url },
        indirectionTexture,
        buf,
        width,
        height,
        indirectionLayout,
        mipOriginArr,
        mipPagesArr,
        coarsePages,
        coarseKeySet,
        coarseTopMips: topMips,
        residentViewKeys: new Set(),
        lastRequestedMip: 0,
        lastRequestedMipFraction: 0, // smooth mip-blend uniform companion (residency.chooseMipFraction)
      };
      await requestDecodeUpload(pack, coarsePages, 'coarse');
      return pack;
    }

    // Mask packs get a lighter permanent soft-floor than the displayed albedo
    // (see buildPack). 24 pages ≈ the top 3 mips (1+4+16) for the 12000px world,
    // vs albedo's ~70 (top 4). With N mask packs × M floors all pinned at once,
    // this keeps the permanently-resident page count well clear of capacity
    // while the active-view ring still streams every pack sharply where the
    // camera actually looks.
    const MASK_COARSE_PIN_MAX_PAGES = 24;

    async function ensureFloorLoaded(floorIndex) {
      if (floors.has(floorIndex)) return floors.get(floorIndex);

      const packs = new Map();
      const albedoPack = await buildPack(floorIndex, 'albedo', { url: imageUrlForFloor(floorIndex) });
      packs.set('albedo', albedoPack);

      // Per-pack load failures are collected here AND surfaced in diagnostics
      // (getDiagnostics.layerLoadErrors) — not just console — because the
      // author debugs by pasting reports, not reading the console
      // ([[keyhole-debug-panel]] protocol). A silent fallback-to-albedo (mask
      // 404 / not synced to the server) looks identical to "masks unsupported"
      // in the residency report; this makes the actual reason legible there.
      const layerErrors = [];
      for (const layerDesc of extraLayerUrlsForFloor(floorIndex)) {
        const { name } = layerDesc;
        // CHANNEL-PACKING: a layer descriptor is either { name, url } (single
        // source — the normal case) or { name, channelUrls: {r,g,b} } (packed
        // — see buildPack's header). errorUrl is just for a legible error log.
        const source = layerDesc.channelUrls ? { channelUrls: layerDesc.channelUrls } : { url: layerDesc.url };
        const errorUrl = layerDesc.channelUrls
          ? `r:${layerDesc.channelUrls.r} g:${layerDesc.channelUrls.g} b:${layerDesc.channelUrls.b}`
          : layerDesc.url;
        if (packs.has(name)) {
          console.warn(`[vt-pan-viewer] floor ${floorIndex}: duplicate layer name "${name}" ignored.`);
          continue;
        }
        try {
          packs.set(name, await buildPack(floorIndex, name, source, { coarsePinMaxPages: MASK_COARSE_PIN_MAX_PAGES }));
        } catch (err) {
          // A missing/broken mask must not take the whole floor (or albedo)
          // down — record it and carry on with the packs that did load. A
          // single absent mask is a data gap, not an architecture failure.
          const message = String(err?.message || err);
          layerErrors.push({ layer: name, url: errorUrl, error: message });
          console.error(`[vt-pan-viewer] floor ${floorIndex}: layer "${name}" failed to load (${errorUrl}):`, err);
        }
      }

      const entry = { packs, albedoPack, layerErrors };
      floors.set(floorIndex, entry);
      return entry;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // matches fullscreen-present.js's convention
    const layers = new Map(); // floorIndex -> {geometry, material, mesh, baseUV} — one persistent layer per LOADED floor

    /**
     * Create (once) the quad+shader layer for one floor. IDENTICAL shader
     * pattern to the proven smoke test (same vertex shader, same uniform
     * names, same v-flip in the UV remap) — see that file's comments for why
     * each piece is shaped the way it is. `transparent:true` +
     * `depthTest/depthWrite:false` + explicit `renderOrder` (set to
     * `floorIndex` in updateResidency — ascending == elevation-ascending,
     * since getActiveSceneFloors already sorts that way) is what makes
     * multi-floor compositing work: a real ALPHA HOLE in an upper floor's art
     * (resident atlas texel with a<1) now correctly blends against whatever a
     * LOWER floor's already-painted layer put there, instead of the single
     * fully-opaque quad this viewer used before — which is exactly the "black
     * where a hole should reveal the floor below" bug reported live 2026-07-15.
     * Added to `scene` immediately with `visible:false`; updateResidency()
     * toggles visibility per-floor every update rather than repeatedly
     * creating/destroying layers.
     */
    function ensureLayer(floorIndex) {
      let layer = layers.get(floorIndex);
      if (layer) return layer;

      const geometry = new THREE.PlaneGeometry(2, 2);
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uPageAtlas: { value: atlas.texture },
          uPageTable: { value: null }, // set per-floor in updateResidency()
          uPagesPerAxis: { value: layout.pagesPerAxis },
          uPagesPerLayer: { value: layout.pagesPerLayer },
          uPageSizePx: { value: layout.pageSizePx },
          uBorderPx: { value: 4 },
          uAtlasSizePx: { value: layout.atlasSizePx },
          uWorldSizePx: { value: 0 }, // set per-floor in updateResidency()
          // Multi-mip: the finest mip to TRY (analytic, per view) + the coarsest,
          // and the flattened-pyramid per-mip layout the shader walks. uMipOrigin
          // is a flat Int32Array (ivec2[VT_MAX_MIPS] == 2 ints/level) — THREE
          // uploads it via gl.uniform2iv directly; uMipPagesPerAxis via uniform1iv.
          uRequestedMip: { value: 0 },
          uRequestedMipFrac: { value: 0 }, // smooth mip blending (residency.chooseMipFraction) — see vt-sample.glsl.js
          uMaxMip: { value: 0 },
          uMipOrigin: { value: new Int32Array(VT_MAX_MIPS * 2) },
          uMipPagesPerAxis: { value: new Int32Array(VT_MAX_MIPS) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          precision highp sampler2DArray;
          varying vec2 vUv;
          ${VT_SAMPLE_GLSL}
          void main() {
            gl_FragColor = vtSample(vUv);
          }
        `,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);

      // Captured ONCE per layer, before any reframe — the TRUE base UV
      // (PlaneGeometry's original 0/1 corners), never touched again. THE
      // ACTUAL BUG (found live 2026-07-15, after resetState()/
      // preserveDrawingBuffer turned out to be real but insufficient fixes):
      // reframeQuad() used to read the geometry's CURRENT (already-remapped)
      // uv attribute as its "base" and remap THAT — so every call compounded
      // onto the PREVIOUS call's already-narrow range instead of the fixed
      // original span. Two calls (initial load, then one pan) was enough to
      // collapse the whole quad's UV range by ~17x toward a single point —
      // exactly matching the symptom: correct on first load, solid-color
      // after the very first pan, regardless of direction.
      const uvAttr = geometry.getAttribute('uv');
      const baseUV = [];
      for (let i = 0; i < uvAttr.count; i++) baseUV.push([uvAttr.getX(i), uvAttr.getY(i)]);

      layer = { geometry, material, mesh, baseUV };
      layers.set(floorIndex, layer);
      return layer;
    }

    let view = null; // set once the first floor is loaded (needs its worldSizePx)
    const frameTimes = [];
    let lastError = null;
    let lastFramedUV = null; // set by reframeLayer(), exposed in diagnostics for ground-truth debugging

    // --- HITCH INSTRUMENTATION (2026-07-16, author-reported: rapid full-range
    // zoom can "temporarily stop" — the fix for the confirmed no-yield-points
    // decode-burst bug didn't fully resolve it, and the author asked for a
    // dedicated stress test to pin down what's ACTUALLY happening instead of
    // guessing further). frameGapTimes is DIFFERENT from frameTimes above —
    // frameTimes only measures renderer.render()'s own synchronous duration;
    // it CANNOT see a stall happening elsewhere (updateContinuousInputs, or
    // an async decode/upload chain's own synchronous stretches between
    // yields) that delays the NEXT animation frame from running at all.
    // frameGapTimes measures the ACTUAL wall-clock time between successive
    // renderFrame invocations — the only signal that reveals a true freeze,
    // since JS is single-threaded and ANY long synchronous stretch anywhere
    // delays every rAF callback equally, wherever that code physically lives.
    const frameGapTimes = [];
    let lastFrameStartMs = null;
    const HITCH_THRESHOLD_MS = 50; // ~3 frames' worth at 60fps — a real, user-perceptible stall, not ordinary jitter
    const HITCH_LOG_MAX = 200; // capped so a long thrash run can't grow this unboundedly
    const hitchLog = []; // {atMs, gapMs, decodeStats, cacheStats} per hitch — full context AT THE MOMENT it happened

    /** Ground truth, not theory: actual rendered canvas pixels + one pack's actual indirection buffer contents. */
    function sampleDiagnostics(pack) {
      const out = {};
      try {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const points = {
          center: [Math.floor(canvasW / 2), Math.floor(canvasH / 2)],
          topLeft: [4, canvasH - 4], // GL readPixels Y is bottom-up; this is visual top-left
          bottomRight: [canvasW - 4, 4],
        };
        out.renderedPixels = {};
        for (const [label, [x, y]] of Object.entries(points)) {
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          out.renderedPixels[label] = [px[0], px[1], px[2], px[3]];
        }
      } catch (err) {
        out.renderedPixelsError = String(err?.message || err);
      }
      if (pack) {
        let nonZeroTexels = 0;
        const distinctSlots = new Set();
        for (let i = 0; i < pack.buf.length; i += 4) {
          if (pack.buf[i + 3] > 0) {
            nonZeroTexels++;
            distinctSlots.add(pack.buf[i] | (pack.buf[i + 1] << 8));
          }
        }
        out.indirectionBuffer = {
          totalTexels: pack.buf.length / 4,
          residentTexels: nonZeroTexels,
          distinctSlotCount: distinctSlots.size,
          distinctSlotsSample: Array.from(distinctSlots).slice(0, 10),
        };
      }
      out.framedWorldUV = lastFramedUV;
      return out;
    }

    function renderFrame(nowMs) {
      const now = nowMs ?? performance.now();

      // HITCH DETECTION — see this file's own header note on frameGapTimes
      // for why this is a DIFFERENT (and more revealing) measurement than
      // frameTimes below. Recorded FIRST, before any other work this frame,
      // so it reflects the true gap since the PREVIOUS frame actually ran.
      if (lastFrameStartMs !== null) {
        const gapMs = now - lastFrameStartMs;
        frameGapTimes.push(gapMs);
        if (frameGapTimes.length > 300) frameGapTimes.shift();
        if (gapMs > HITCH_THRESHOLD_MS) {
          hitchLog.push({
            atMs: Math.round(now),
            gapMs: Math.round(gapMs * 10) / 10,
            halfSpanPx: view?.halfSpanPx ?? null,
            decodeStats: getDecodeStats(),
            cacheStats: cache.stats(),
          });
          if (hitchLog.length > HITCH_LOG_MAX) hitchLog.shift();
        }
      }
      lastFrameStartMs = now;

      // Continuous-input easing (held-key pan, eased zoom) runs BEFORE the
      // timed render() call below, so its (small) CPU cost is never folded
      // into renderMsAvgLast120 — that diagnostic stays a clean measurement
      // of pure GPU-render cost, exactly as it was before this existed
      // (needed as-is for the Stage 1 gate's "60fps" evidence).
      updateContinuousInputs(now);
      const t0 = performance.now();
      renderer.render(scene, camera);
      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
    }

    function reframeLayer(layer, uvMin, uvMax) {
      const uvAttr = layer.geometry.getAttribute('uv');
      for (let i = 0; i < uvAttr.count; i++) {
        const [u, v] = layer.baseUV[i]; // ALWAYS the true original corner, never the live buffer
        // Same v-flip as the smoke test (live-verified 2026-07-15): v=1 (local
        // +Y, NDC top) must map to the SMALLER world-Y (the top of the source
        // image), so uvMax - v*(uvMax-uvMin), never uvMin + v*(...).
        uvAttr.setXY(i, uvMin.x + u * (uvMax.x - uvMin.x), uvMax.y - v * (uvMax.y - uvMin.y));
      }
      uvAttr.needsUpdate = true;
      lastFramedUV = { uvMin, uvMax };
    }

    /**
     * Decode + upload a set of pages (at each page's OWN mip) and pin them with
     * `pinClass`. Shared by the coarse-pin load and the per-view residency
     * update so there is exactly ONE decode/upload path.
     *
     * TWO PASSES ON PURPOSE (confirmed live 2026-07-15 — the actual cause of
     * "no texture bound to target" on every pan/zoom): the render loop runs
     * CONTINUOUSLY, so a render() can land between two separate upload calls
     * and desync THREE's texture-unit binding cache. Pass 1 does all the
     * (async, GL-free) decoding — safe to interleave. Pass 2 uploads
     * everything already-decoded in one tight SYNCHRONOUS loop (no `await`
     * between GL calls), with the loop paused and atlas.prepareForUploadBatch()
     * resetting the stale binding cache first (see atlas.js for the full root cause).
     */
    async function requestDecodeUpload(pack, pages, pinClass) {
      // Pass 1: reserve cache slots (pin) and collect the pages that actually
      // need decoding (not already resident). cache.request is sync + GL-free.
      const toDecode = []; // { page, slot }
      for (const page of pages) {
        const alreadyInCache = cache.isResident(page.key);
        const { resident, slot } = cache.request(page.key, { pin: pinClass });
        if (!resident) continue; // cache full — a structural miss, not a crash; coarse fallback covers it
        if (!alreadyInCache) toDecode.push({ page, slot });
      }
      if (toDecode.length === 0) return;

      // Pass 2: acquire the decoded page bitmaps — IndexedDB-first, else a
      // bounded slice from the (briefly-held, immediately-released) full source.
      // This is the decode-memory fix: no per-pack 576 MB bitmap is ever held.
      let decodedForUpload = [];
      try {
        const slotByKey = new Map(toDecode.map((t) => [t.page.key, t.slot]));
        const requestedPages = toDecode.map((t) => t.page);
        // CHANNEL-PACKING branch: a 'packed' pack composites 3 single-channel
        // sources into one RGBA page (acquirePackedPages); everything else
        // (albedo, unpackable masks) takes the original single-source path.
        // Both return the identical {page, bitmap} shape — the atlas upload
        // below doesn't know or care which path produced a page.
        const acquired =
          pack.source.kind === 'packed'
            ? await acquirePackedPages(pack.source.packId, pack.source.channelUrls, pack.table, requestedPages, {})
            : await acquirePages(pack.source.url, pack.table, requestedPages, {});
        decodedForUpload = acquired
          .map((a) => ({ slot: slotByKey.get(a.page.key), decoded: a.bitmap }))
          .filter((x) => x.slot !== undefined);
      } catch (err) {
        lastError = `decode failed for pack "${pack.name}": ${err?.message || err}`;
        console.error('[vt-pan-viewer]', lastError);
        return;
      }

      // Pass 3: upload everything decoded, in TIME-BUDGETED CHUNKS (2026-07-16
      // — the worker-decode fix moved the SOURCE-DECODE freeze off the main
      // thread, but a live zoom-thrash-test report then showed a NEW dominant
      // hitch (500ms) whose own snapshot had decode ALREADY FINISHED
      // (sourcesDecoded/idbSlices at their final values right at the hitch) —
      // pointing squarely at THIS loop instead: it used to upload an ENTIRE
      // batch (up to ~120 pages in that report) in one uninterrupted stretch
      // with the render loop explicitly paused for the whole duration. Each
      // individual GPU upload is cheap; 120 of them back-to-back at real
      // driver-call overhead is not. Fixed the same way the decode loop was —
      // yield by TIME BUDGET, not batch-or-nothing — except a chunk boundary
      // here means RESUMING the render loop briefly (a real frame paints)
      // before re-pausing for the next chunk, rather than just awaiting a
      // microtask. `atlas.prepareForUploadBatch()` is safe to call again at
      // the start of every chunk (it only resets the binding-cache staleness
      // the pause/resume dance itself protects against — see that function's
      // own doc); the pause/resume cost itself is cheap and already proven
      // safe (this is the exact same pause the code always did, just more of
      // them instead of one giant one).
      if (decodedForUpload.length > 0) {
        const wasActive = loopActive;
        let lastYieldMs = performance.now();
        renderer.setAnimationLoop(null);
        atlas.prepareForUploadBatch();
        for (const { slot, decoded } of decodedForUpload) {
          const srcTex = new THREE.Texture(decoded);
          srcTex.flipY = false;
          srcTex.generateMipmaps = false;
          srcTex.needsUpdate = true;
          atlas.uploadPage(slot, srcTex);
          srcTex.dispose();
          decoded.close?.();

          const now = performance.now();
          if (shouldYieldByTime(now - lastYieldMs, MAX_MS_PER_UPLOAD_CHUNK)) {
            if (wasActive) renderer.setAnimationLoop(renderFrame); // let a REAL frame paint between chunks
            await nextAnimationFrame();
            renderer.setAnimationLoop(null); // re-pause for the next upload chunk
            atlas.prepareForUploadBatch(); // re-prime the binding cache before resuming uploads
            lastYieldMs = performance.now();
          }
        }
        if (wasActive) renderer.setAnimationLoop(renderFrame); // final restore (never start prematurely at first load)
      }
    }

    /** Write one page's current cache slot into a pack's flattened-pyramid indirection buffer. */
    function writeIndirection(pack, page) {
      const slot = cache.slotOf(page.key);
      if (slot === null) return;
      const o = pack.indirectionLayout.origins[page.mip];
      const x = o.x + page.px;
      const y = o.y + page.py;
      const i = (y * pack.width + x) * 4;
      pack.buf[i] = slot & 0xff;
      pack.buf[i + 1] = (slot >> 8) & 0xff;
      pack.buf[i + 2] = 0;
      pack.buf[i + 3] = 255;
    }

    let lastVisibleFloors = new Set(); // floor indices composited after the PREVIOUS update
    let lastCompositedFloors = []; // exposed in diagnostics — see getDiagnostics()
    let worldSizeMismatchWarned = false; // one console.warn per distinct mismatch, not one per frame

    // Which layer-pack is DISPLAYED (albedo by default). Every pack STREAMS
    // regardless — this only changes which one is bound to the shader, so a mask
    // can be eyeballed against the fixture's known patterns for correctness.
    let displayLayerName = 'albedo';

    /**
     * Plan + stream one pack's view residency for the current worldRect, then
     * rebuild its indirection buffer fresh from the cache's own slot mapping.
     * This is the per-pack half of the old updateResidency, run for EVERY pack
     * of every visible floor — albedo and each mask alike — so the whole layer
     * stack pages through the one shared cache together (the pile-up proof).
     *
     * worldRect is in the shared (albedo) world units; packs are assumed to
     * share worldSizePx (see buildPack's note), so the same rect plans every
     * pack correctly.
     */
    async function streamPackResidency(pack, worldRect) {
      // Analytic mip selection (§4.1 — top-down camera, no GPU feedback): the
      // finest mip that resolves for this zoom, plus BOTH neighbor mips as a
      // prefetch — coarser (zoom-out insurance) AND finer (zoom-in insurance,
      // 2026-07-16, the fix for a real reported hitch — see planResidency's
      // own doc for the full mechanism). Larger canvas axis → conservative
      // (sharper) choice.
      const plan = planResidency(pack.table, worldRect, Math.max(canvasW, canvasH), { guardPages: 1 });
      pack.lastRequestedMip = plan.mip;
      pack.lastRequestedMipFraction = plan.mipFraction; // drives the shader's smooth mip blend

      // Needed = fine + both-direction prefetch, EXCLUDING pages already held
      // by this pack's permanent coarse pins (never downgrade a 'coarse' pin
      // to 'view').
      const neededViewPages = [...plan.fine, ...plan.prefetchCoarser, ...plan.prefetchFiner].filter(
        (p) => !pack.coarseKeySet.has(p.key)
      );
      const diff = diffResidency(pack.residentViewKeys, neededViewPages);

      await requestDecodeUpload(pack, diff.toRequest, 'view');
      for (const key of diff.toUnpin) cache.unpin(key);
      // GROUND TRUTH, not intent (same disease as the coarse-pin diagnostic
      // bug fixed 2026-07-16, found by comparing THIS field's own summed total
      // against cacheStats.pinnedView in a live report — a real, if quieter,
      // discrepancy). `diff.nextKeys` is every page WE ASKED FOR; under
      // pressure, `cache.request()` inside requestDecodeUpload can genuinely
      // miss (cache full, nothing evictable) — a normal, expected outcome
      // (coarse fallback covers it, see the indirection-write note below).
      // The bug was tracking the ASK, not the OUTCOME: a page whose request
      // missed still got recorded as "resident" in `residentViewKeys` — so on
      // every LATER residency update, `diffResidency` saw it as "already
      // handled" (present in prevKeys) and never re-added it to `toRequest`.
      // That page then stays permanently stuck on its coarse-fallback blur —
      // even once pressure relieves and a slot becomes free — for as long as
      // the camera keeps needing it without ever panning away (panning away
      // and back would coincidentally self-heal it, which is why this hid).
      // Fix: only keep keys that are ACTUALLY resident right now, so a missed
      // page stays eligible for a retry on every subsequent update — cheap
      // (a miss is O(1), no decode happens) and self-correcting.
      pack.residentViewKeys = new Set([...diff.nextKeys].filter((key) => cache.isResident(key)));

      // Rebuild the indirection buffer FRESH from the cache's own current slot
      // mapping every time (never a separately-tracked copy) — this keeps it
      // correct across evictions: an evicted-and-reassigned page must never
      // leave a stale pointer. Both the always-resident coarse pins AND the
      // current view pages are written, so the shader's coarse-fallback walk
      // always finds SOMETHING resident (blur, never magenta).
      pack.buf.fill(0);
      for (const page of pack.coarsePages) writeIndirection(pack, page);
      for (const page of neededViewPages) writeIndirection(pack, page);
      pack.indirectionTexture.needsUpdate = true;
    }

    /** Point the display layer's shader uniforms at a specific pack (albedo or a mask). */
    function bindLayerToPack(layer, pack) {
      const u = layer.material.uniforms;
      if (u.uPageTable.value !== pack.indirectionTexture) {
        // Bind: fresh array references (per pack) guarantee THREE re-uploads
        // them; within a pack they're constant.
        u.uPageTable.value = pack.indirectionTexture;
        u.uWorldSizePx.value = pack.table.worldSizePx;
        u.uMaxMip.value = pack.table.maxMip;
        u.uMipOrigin.value = pack.mipOriginArr;
        u.uMipPagesPerAxis.value = pack.mipPagesArr;
      }
      u.uRequestedMip.value = pack.lastRequestedMip; // re-read every update (mip changes with zoom)
      u.uRequestedMipFrac.value = pack.lastRequestedMipFraction; // smooth mip blend companion (see vt-sample.glsl.js)
    }

    async function updateResidency() {
      const visibleIndices = visibleFloorIndices(view.floorIndex);
      const visibleSet = new Set(visibleIndices);

      // Floors that dropped OUT of the composited set (not just "no longer
      // the current one" — a floor can stay composited across a switch if
      // it's visible-from BOTH the old and new viewed floor): unpin EVERY
      // pack's VIEW pages (never coarse pins — those stay resident for every
      // floor always, §4.1/§4.5) and hide their layer. Unpin never evicts
      // directly — PageCache's LRU decides that under real pressure — so a
      // quick switch-and-back is free.
      for (const idx of lastVisibleFloors) {
        if (visibleSet.has(idx)) continue;
        const prevEntry = floors.get(idx);
        if (prevEntry) {
          for (const pack of prevEntry.packs.values()) {
            for (const key of pack.residentViewKeys) cache.unpin(key);
            pack.residentViewKeys = new Set();
          }
        }
        const prevLayer = layers.get(idx);
        if (prevLayer) prevLayer.mesh.visible = false;
      }
      lastVisibleFloors = visibleSet;
      lastCompositedFloors = visibleIndices;

      // Aspect-correct framing: the canvas fills the (non-square) scene area,
      // so the world rect must match the canvas aspect or the map stretches
      // (view-state.js's aspect param). halfSpanPx is the vertical zoom;
      // horizontal widens by width/height. Shared across every composited
      // floor — they all represent the same on-screen view.
      const aspect = canvasW / canvasH;
      const worldRect = viewToWorldRect(view, aspect);

      let refWorldSizePx = null;

      // PHASE 1 — lock in every composited floor's COARSE pins FIRST, before
      // ANY floor's view-tier streaming begins (real live bug, 2026-07-16: the
      // whole screen went magenta under the castle-courtyard test — 3 floors ×
      // 8 packs composited at once). Root cause: the old single-pass loop did
      // coarse-load THEN view-stream PER FLOOR, in visibleIndices order. Since
      // PageCache treats 'coarse' and 'view' pins identically for eviction
      // (page-cache.js:_findLRUEvictable — neither is ever evicted), an EARLIER
      // floor's much-larger view-tier request (~1270 pages) could fill the
      // cache before a LATER floor's coarse-pin request (217 pages) even ran —
      // and a coarse-pin request that finds the cache already saturated with
      // protected pins simply FAILS (no valid eviction target), for pages
      // whose entire job is to GUARANTEE something is always resident. A page
      // with zero resident data at ANY mip has nothing to fall back to —
      // exactly the "broken pin invariant" magenta is reserved for. Fix:
      // ensureFloorLoaded (which requests only coarse pins) for every visible
      // floor FIRST — total coarse pages for the worst case (3 floors × 8
      // unpacked packs = 651) comfortably fits the 2048-page budget on its
      // own, so front-loading it guarantees every floor's soft-fallback floor
      // is real BEFORE the much larger, evictable view tier starts competing
      // for the remaining space.
      const entries = [];
      for (const floorIndex of visibleIndices) {
        entries.push([floorIndex, await ensureFloorLoaded(floorIndex)]);
      }

      // PHASE 2 — now stream view-tier detail for every floor. Coarse pins for
      // all of them are already locked in, so view-tier pressure (which DOES
      // evict, via the LRU pool of unpinned/previously-unpinned slots) can
      // never starve a coarse pin that hasn't been requested yet.
      for (const [floorIndex, entry] of entries) {
        const displayPack = entry.packs.get(displayLayerName) ?? entry.albedoPack;

        // Composited floors are assumed to share the same worldSizePx (all
        // Levels in one Foundry scene cover the same physical footprint) —
        // warn, don't crash, if a real scene's art disagrees (see this file's
        // header note: per-floor world-size reconciliation isn't built yet).
        if (refWorldSizePx === null) refWorldSizePx = displayPack.table.worldSizePx;
        else if (displayPack.table.worldSizePx !== refWorldSizePx && !worldSizeMismatchWarned) {
          worldSizeMismatchWarned = true;
          console.warn(
            `[vt-pan-viewer] floor ${floorIndex}'s worldSizePx (${displayPack.table.worldSizePx}) differs from ` +
              `another composited floor's (${refWorldSizePx}) — the multi-floor overlay may visually misalign.`
          );
        }

        // Stream EVERY pack — albedo AND every mask — through the one shared
        // cache. THIS is the mask-pile-up proof: all of a floor's layers are
        // resident at once, yet each costs only its visible pages, never a
        // world-resolution texture. Only the display pack is bound below.
        for (const pack of entry.packs.values()) {
          await streamPackResidency(pack, worldRect);
        }

        const layer = ensureLayer(floorIndex);
        bindLayerToPack(layer, displayPack);

        const worldSizePx = displayPack.table.worldSizePx;
        reframeLayer(
          layer,
          { x: worldRect.minX / worldSizePx, y: worldRect.minY / worldSizePx },
          { x: worldRect.maxX / worldSizePx, y: worldRect.maxY / worldSizePx }
        );

        layer.mesh.visible = true;
        // Ascending floorIndex == ascending elevation (getActiveSceneFloors
        // already sorts its output that way), so painting lower indices
        // first (Three.js: lower renderOrder draws first) puts the physically
        // LOWER floor beneath the higher one — exactly the paint order real
        // Foundry's own elevation-sorted `_configureLevelTextures` produces.
        layer.mesh.renderOrder = floorIndex;
      }
    }

    /**
     * Swap the DISPLAYED layer-pack (e.g. 'albedo' → 'Outdoors') — visual
     * verification that a mask actually streamed correctly, against the
     * fixture's known patterns. No-op re-stream: the pack is already resident,
     * this just rebinds + reframes on the next residency pass.
     * @param {string} name
     */
    async function setDisplayLayer(name) {
      displayLayerName = name;
      await updateResidency();
      return { displayLayer: displayLayerName };
    }

    // --- Mouse pan/zoom (native-Foundry feel) --------------------------------
    // Re-frame every currently-composited layer to the LATEST view state
    // synchronously — a cheap CPU-side UV rewrite, no GL upload — so a mouse
    // drag tracks the cursor at display rate. The heavier decode/upload of
    // newly-exposed pages is coalesced separately (scheduleResidencyUpdate);
    // coarse pins guarantee everything still renders (soft) until fresh pages
    // land, so the visual pan is never blocked on streaming.
    function reframeVisibleLayers() {
      const aspect = canvasW / canvasH;
      const worldRect = viewToWorldRect(view, aspect);
      for (const floorIndex of lastCompositedFloors) {
        const entry = floors.get(floorIndex);
        const layer = layers.get(floorIndex);
        if (!entry || !layer || !layer.mesh.visible) continue;
        // Match the DISPLAYED pack updateResidency bound to this layer (its
        // worldSizePx is what the UV normalization must use).
        const displayPack = entry.packs.get(displayLayerName) ?? entry.albedoPack;
        const ws = displayPack.table.worldSizePx;
        reframeLayer(
          layer,
          { x: worldRect.minX / ws, y: worldRect.minY / ws },
          { x: worldRect.maxX / ws, y: worldRect.maxY / ws }
        );
      }
    }

    // Coalesced residency: a fast drag fires far more pointermove events than a
    // decode/upload cycle can service, so overlapping updateResidency() runs
    // would stack up and thrash the atlas. Run at most one at a time; if the
    // view moved again meanwhile, run exactly once more. updateResidency() reads
    // the live `view` each run, so the final run always reflects the latest view.
    let residencyInFlight = false;
    let residencyDirty = false;
    async function scheduleResidencyUpdate() {
      if (residencyInFlight) {
        residencyDirty = true;
        return;
      }
      residencyInFlight = true;
      try {
        do {
          residencyDirty = false;
          await updateResidency();
        } while (residencyDirty);
      } finally {
        residencyInFlight = false;
      }
    }

    // Drag-to-pan with the primary (or middle) button — native Foundry's
    // canvas-drag pan. Pointer capture keeps the drag alive when the cursor
    // leaves the canvas or slips over a Foundry UI panel mid-drag.
    let dragging = false;
    let dragPointerId = null;
    let lastPointerX = 0;
    let lastPointerY = 0;

    function onPointerDown(e) {
      if (e.button !== 0 && e.button !== 1) return; // left or middle button only
      dragging = true;
      dragPointerId = e.pointerId;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging || e.pointerId !== dragPointerId) return;
      const dx = e.clientX - lastPointerX;
      const dy = e.clientY - lastPointerY;
      if (dx === 0 && dy === 0) return;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      const next = applyPanByPixels(view, dx, dy, canvasH, view.__lastWorldSizePx || 12000);
      if (next === view) return;
      view = next;
      reframeVisibleLayers(); // instant visual tracking; streaming catches up async
      scheduleResidencyUpdate().catch((err) => console.error('[vt-pan-viewer] pan residency failed:', err));
      e.preventDefault();
    }

    function endDrag(e) {
      if (!dragging || (e && e.pointerId !== dragPointerId)) return;
      dragging = false;
      dragPointerId = null;
      try {
        if (e) canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      canvas.style.cursor = 'grab';
    }

    // --- CAMERA SMOOTHING (2026-07-16 — see view-state.js's own header for the
    // full "why two different models for pan vs zoom" design note) ----------
    // Drag stays EXACTLY as above: 1:1, zero smoothing — direct manipulation
    // should never lag behind the cursor. Only DISCRETE inputs (held keys,
    // wheel ticks) are eased here.
    const heldPanKeys = new Set(); // raw KeyboardEvent.key values currently held
    let panVelocity = { x: 0, y: 0 }; // current, smoothed, world px/sec
    let targetHalfSpanPx = null; // set once the initial view exists; eased toward every frame
    let zoomAnchorSx = 0;
    let zoomAnchorSy = 0; // screen-space anchor for the in-flight eased zoom
    let lastFrameTimeMs = null;

    const PAN_SPEED_SCREENFULS_PER_SEC = 1.2; // matches the old discrete step's own halfSpanPx-proportional feel
    const PAN_RAMP_HALF_LIFE_SEC = 0.08; // ~80ms to close half the gap to full speed — responsive, not laggy
    const ZOOM_EASE_HALF_LIFE_SEC = 0.12; // ~120ms glide between zoom levels instead of a hard jump
    const MAX_DT_SEC = 0.1; // clamp after a stall (backgrounded tab, etc.) — avoid a huge catch-up jump

    /** Set a new eased-zoom TARGET (does not move the view itself — see updateContinuousInputs). */
    function setZoomTarget(factor, sx, sy) {
      const worldSizePx = view.__lastWorldSizePx || 12000;
      targetHalfSpanPx = clampHalfSpan((targetHalfSpanPx ?? view.halfSpanPx) * factor, worldSizePx);
      zoomAnchorSx = sx;
      zoomAnchorSy = sy;
    }

    /**
     * Runs once per animation frame, BEFORE render — eases held-key pan
     * velocity and any in-flight zoom target toward their goals, reusing the
     * EXACT SAME reframe + coalesced-residency pattern the drag/wheel paths
     * above already use (so continuous motion streams pages exactly as
     * proven-safe as a fast mouse drag, not a new mechanism).
     * @param {number} nowMs
     */
    function updateContinuousInputs(nowMs) {
      if (lastFrameTimeMs === null) {
        lastFrameTimeMs = nowMs;
        return;
      }
      const dtSec = Math.min(MAX_DT_SEC, Math.max(0, (nowMs - lastFrameTimeMs) / 1000));
      lastFrameTimeMs = nowMs;
      if (dtSec <= 0 || !view) return;

      let dirty = false;
      const worldSizePx = view.__lastWorldSizePx || 12000;

      // Continuous keyboard pan: ease velocity toward what the held keys
      // imply, then integrate position — replaces the old discrete per-
      // keydown jump with a smooth glide whose speed scales with the CURRENT
      // zoom (screenfuls/sec, matching the old step's own feel).
      const targetVelocity = computeTargetPanVelocity(heldPanKeys, view.halfSpanPx * PAN_SPEED_SCREENFULS_PER_SEC);
      panVelocity = easeVelocityTowardTarget(panVelocity, targetVelocity, dtSec, PAN_RAMP_HALF_LIFE_SEC);
      if (Math.abs(panVelocity.x) > 0.01 || Math.abs(panVelocity.y) > 0.01) {
        const nextView = integratePan(view, panVelocity, dtSec, worldSizePx);
        if (nextView !== view) {
          view = nextView;
          dirty = true;
        }
      }

      // Smoothed zoom: ease halfSpanPx toward the last input's target,
      // re-anchored around the SAME screen point every frame via the
      // existing, already-tested applyZoomAtPixel — never a new formula.
      if (targetHalfSpanPx !== null) {
        const factor = easedZoomFactor(view.halfSpanPx, targetHalfSpanPx, dtSec, ZOOM_EASE_HALF_LIFE_SEC);
        if (factor !== 1) {
          const nextView = applyZoomAtPixel(view, factor, zoomAnchorSx, zoomAnchorSy, canvasW, canvasH, worldSizePx);
          if (nextView !== view) {
            view = nextView;
            dirty = true;
          }
        }
      }

      if (dirty) {
        reframeVisibleLayers();
        scheduleResidencyUpdate().catch((err) =>
          console.error('[vt-pan-viewer] continuous-input residency failed:', err)
        );
      }
    }

    // Safety against a "stuck key" bug (a keyup that fires while this window
    // doesn't have focus can be missed entirely — a well-known class of issue
    // for any held-key input system, and this project has already hit the
    // adjacent "backgrounded tab" class of bug once, see tab-out load
    // protection in project memory): clear held keys whenever the window
    // loses focus or the tab is hidden, so a stray missed keyup can never
    // leave the camera panning forever.
    function clearHeldKeys() {
      heldPanKeys.clear();
    }

    function onWheel(e) {
      // Native Foundry: wheel up = zoom in, wheel down = zoom out, toward the
      // cursor. Anchor to the canvas's own client box so any page scroll offset
      // never skews the world-point-under-cursor math.
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Scale the per-event factor by the wheel's actual deltaY magnitude
      // (clamped) rather than a flat constant — a trackpad's fine-grained
      // continuous deltas used to get the SAME big jump as a single discrete
      // mouse-wheel notch, which read as much jumpier on a trackpad than a
      // wheel. A notch is typically |deltaY|~100; normalize against that.
      const magnitude = Math.min(2, Math.max(0.15, Math.abs(e.deltaY) / 100));
      const baseFactor = e.deltaY < 0 ? 0.8 : 1.25; // == applyZoomKey's in/out factors at magnitude 1
      setZoomTarget(Math.pow(baseFactor, magnitude), sx, sy);
      // Stop the page (and Foundry's own hidden canvas) from also scrolling/zooming.
      e.preventDefault();
      e.stopPropagation();
    }

    // Shared by the real keydown handler AND the soak harness (MapShine.soakHooks.pan)
    // — one code path applies a key, so a soak run exercises exactly what a real
    // user's keypress would, not a separate simulated approximation of it.
    async function applyKeyAndUpdate(key) {
      const ctx = { worldSizePx: view.__lastWorldSizePx || 12000, floorCount };
      const next = applyKey(view, key, ctx);
      if (next === view) return false;
      view = next;
      view.__lastWorldSizePx = ctx.worldSizePx;
      await updateResidency();
      return true;
    }

    /**
     * Set the floor index DIRECTLY (not via a synthetic keypress) and run
     * exactly one residency update — the SAME cheap path `applyKeyAndUpdate`
     * uses for an ordinary floor-switch keypress, deliberately NOT a call to
     * `startVtPanViewer` (a full teardown + fresh 512MB atlas + fresh page
     * cache). This is the fix for a real live bug (2026-07-15): the boot.js
     * `canvasReady` handler used to call `startVtPanViewer` on every floor
     * switch (since Foundry's own `Scene#view()` re-fires `canvasReady` on a
     * same-scene level change, confirmed in source) — which both reset the
     * view to floor 0 every time (silently ignoring the switch) AND, worse,
     * repeatedly reallocated the full GPU atlas on ordinary floor toggles,
     * which crashed after a few switches. A same-scene floor sync should cost
     * what a keypress costs, nothing more.
     * @param {number} floorIndex
     * @returns {Promise<boolean>} true if the floor actually changed.
     */
    async function setFloorIndex(floorIndex) {
      if (!view || view.floorIndex === floorIndex) return false;
      view = { ...view, floorIndex };
      await updateResidency();
      return true;
    }

    const ZOOM_IN_KEYS = new Set(['+', '=', 'PageUp']);
    const ZOOM_OUT_KEYS = new Set(['-', '_', 'PageDown']);

    function onKeyDown(e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable))
        return;
      // Decide SYNCHRONOUSLY whether this key does anything (applyKey itself is
      // pure/sync) so preventDefault() fires before the event finishes — calling
      // it after any async work below would be too late for the browser to
      // actually suppress e.g. arrow-key page scroll.
      const ctx = { worldSizePx: view.__lastWorldSizePx || 12000, floorCount };
      if (applyKey(view, e.key, ctx) === view) return; // no-op key, let the browser handle it normally
      // Foundry's own KeyboardManager binds arrow keys to core.panUp/Left/Down/Right
      // (repeat:true, always active — confirmed live 2026-07-15 by tracing
      // foundryvttsourcecode_v14/.../client-keybindings.mjs) and digit keys can
      // trigger hotbar slots — both listen on `window` in the bubble phase, same
      // as this handler was. Registered in the CAPTURE phase (below) so this
      // handler ALWAYS runs first regardless of registration order, and
      // stopImmediatePropagation() here stops Foundry's own handler (and
      // anyone else's) from also acting on a key this viewer has claimed —
      // without this, arrow-key presses were panning Foundry's own canvas
      // instead of (or as well as) this viewer's view, and the view state
      // never actually changed.
      e.stopImmediatePropagation();
      e.preventDefault();

      // CAMERA SMOOTHING (2026-07-16): pan keys go to the CONTINUOUS held-key
      // system (updateContinuousInputs, run every frame) instead of a discrete
      // per-keydown jump — this is the actual fix for "jerky" keyboard pan
      // (OS key-repeat timing made the old discrete path visibly steppy). "Is
      // this a pan key" is asked of view-state.js's own pan-velocity function
      // (rather than a second hardcoded key list here that could drift from
      // its internal one) — a key that produces zero velocity alone is, by
      // definition, not one it recognizes.
      // Zoom keys set an eased TARGET (screen-center anchor, matching
      // applyZoomKey's own "just changes halfSpan, center stays put" shape)
      // instead of jumping instantly; each OS key-repeat re-nudges the target
      // further, exactly like the old discrete path let holding '+' keep
      // zooming in, just arriving smoothed now instead of as instant jumps.
      // Floor-switch (digits/Tab) and anything else applyKey recognizes stays
      // on the EXACT original discrete path — `applyKeyAndUpdate` is
      // UNCHANGED and still the one MapShine.soakHooks.pan calls directly, so
      // the soak harness's contract is untouched by this.
      const velocityIfPanKey = computeTargetPanVelocity(new Set([e.key]), 1);
      if (velocityIfPanKey.x !== 0 || velocityIfPanKey.y !== 0) {
        heldPanKeys.add(e.key); // Set dedupes — OS key-repeat re-adding is a harmless no-op
        return;
      }
      if (ZOOM_IN_KEYS.has(e.key) || ZOOM_OUT_KEYS.has(e.key)) {
        setZoomTarget(ZOOM_IN_KEYS.has(e.key) ? 0.8 : 1.25, canvasW / 2, canvasH / 2);
        return;
      }
      applyKeyAndUpdate(e.key).catch((err) => console.error('[vt-pan-viewer] updateResidency failed:', err));
    }

    /** Release tracking for the continuous held-key pan system. */
    function onKeyUp(e) {
      heldPanKeys.delete(e.key);
    }

    // The scene area resizes (window resize, sidebar collapse, Foundry
    // relayout). Re-measure the host, resize the drawing buffer to match, and
    // recompute residency at the new aspect so the map never stretches. Debounced
    // to a rAF-ish microtask via a simple in-flight guard is overkill here — the
    // handler is cheap and resize events are coarse.
    let resizePending = false;
    function onResize() {
      if (resizePending || !_active) return;
      resizePending = true;
      queueMicrotask(async () => {
        resizePending = false;
        if (!_active) return;
        const { width, height } = measureHost(mount.host);
        if (width === canvasW && height === canvasH) return;
        canvasW = width;
        canvasH = height;
        renderer.setSize(canvasW, canvasH, false);
        await updateResidency().catch((err) => console.error('[vt-pan-viewer] resize residency failed:', err));
      });
    }

    // First floor load determines the initial view's world size. Opens on
    // `initialFloorIndex` (defaults to 0, but a real-scene auto-start passes
    // whatever Foundry itself is currently viewing — see this function's own
    // param doc for why that match matters). Frame a generous chunk of the
    // world initially (quarter-world half-span → ~half the map vertically) so
    // it immediately reads as "the map fills the display," not a tiny
    // zoomed-in patch — this view is served largely by coarse pins, so it's
    // instant. '-'/'+' zoom and arrows/WASD pan from there.
    const clampedInitialFloor = Math.max(0, Math.min(floorCount - 1, initialFloorIndex));
    const firstEntry = await ensureFloorLoaded(clampedInitialFloor);
    const firstWorldSizePx = firstEntry.albedoPack.table.worldSizePx;
    view = createInitialViewState({
      worldSizePx: firstWorldSizePx,
      floorIndex: clampedInitialFloor,
      halfSpanPx: firstWorldSizePx * 0.25,
    });
    view.__lastWorldSizePx = firstWorldSizePx;
    targetHalfSpanPx = view.halfSpanPx; // eased-zoom target starts equal to the actual value — no zoom-on-load
    await updateResidency();

    loopActive = true;
    renderer.setAnimationLoop(renderFrame);

    // Background prewarm (non-blocking, best-effort): stream every OTHER floor's
    // coarse pins so a floor switch is instant (§4.5 — coarse pins for every
    // floor always resident). Fire-and-forget so it never delays the initial
    // floor's first paint; a fetch failure on one floor can't take the viewer
    // down. Skips whichever floor was just loaded above as initial, not
    // hardcoded to skip floor 0 — the initial floor can be any index now.
    for (let f = 0; f < floorCount; f++) {
      if (f === clampedInitialFloor) continue;
      ensureFloorLoaded(f).catch((err) => console.warn(`[vt-pan-viewer] prewarm floor ${f} failed:`, err));
    }

    // capture:true — see onKeyDown's comment. Must run before Foundry's own
    // window-level keydown listener (registered at Foundry boot, bubble phase).
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    // Stuck-key safety (see clearHeldKeys' own doc) — a keyup missed while
    // this window/tab wasn't focused would otherwise leave the camera panning
    // forever once focus returns.
    window.addEventListener('blur', clearHeldKeys);
    document.addEventListener('visibilitychange', clearHeldKeys);
    window.addEventListener('resize', onResize);

    // Mouse pan/zoom lives on the canvas itself (topmost element over the map
    // area, so events land here, not on the occluded PIXI canvas beneath). They
    // die automatically when the canvas is removed in disposeActive(). `wheel`
    // must be passive:false so preventDefault() can suppress page scroll.
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    _active = {
      THREE,
      renderer,
      atlas,
      canvas,
      onResize,
      layers,
      floors,
      cache,
      layout,
      onKeyDown,
      onKeyUp,
      clearHeldKeys,
      floorCount,
      startupParams, // exposed so runZoomThrashTest can restart an identical fresh viewer ("blank slate")
      getView: () => view,
      applyKeyAndUpdate, // exposed so MapShine.soakHooks.pan drives the EXACT same path a real keypress does
      setFloorIndex, // exposed so an external (Foundry-driven) floor sync is as cheap as a keypress, never a full restart
      setDisplayLayer, // exposed so the debug panel can bind a mask for visual verification
      // --- runZoomThrashTest support (2026-07-16) ---------------------------
      /** Wipe frame-gap/hitch history for a clean measurement window. */
      resetHitchTracking() {
        frameGapTimes.length = 0;
        hitchLog.length = 0;
        lastFrameStartMs = null;
      },
      /**
       * Force the eased-zoom TARGET straight to an extreme, screen-center-
       * anchored — the same mechanism a held '+'/'-' key uses (setZoomTarget),
       * just driven programmatically instead of from a keydown. The NORMAL
       * per-frame render loop (updateContinuousInputs) does all the actual
       * easing/streaming work exactly as it would for a real input — this
       * does not bypass or special-case anything the real code path does.
       * `clampHalfSpan(Infinity/0, worldSizePx)` is a clean way to reach the
       * TRUE min/max without duplicating view-state.js's private constants.
       * @param {'in'|'out'} direction
       */
      forceZoomTarget(direction) {
        const worldSizePx = view?.__lastWorldSizePx || 12000;
        targetHalfSpanPx = clampHalfSpan(direction === 'in' ? 0 : Infinity, worldSizePx);
        zoomAnchorSx = canvasW / 2;
        zoomAnchorSy = canvasH / 2;
      },
      getDiagnostics() {
        const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
        const entry = floors.get(view.floorIndex);
        const albedo = entry?.albedoPack;
        const layer = layers.get(view.floorIndex);

        // THE MASK-PILE-UP PROOF, made legible: every loaded pack of every
        // loaded floor, with its permanently-pinned coarse pages and its live
        // view-resident pages. The whole stack (albedo + N masks × M floors)
        // shows here, yet cacheStats.residentPages stays a small fraction of
        // capacityPages — V2's `O(world × floors × masks)` textures replaced by
        // `O(screen)` pages. If any mask pack is missing from this list, its
        // source failed to load (see the console error ensureFloorLoaded logs).
        const layerResidency = [];
        const layerLoadErrors = [];
        let totalViewResident = 0;
        let totalCoarsePinned = 0;
        let totalCoarseIntended = 0;
        for (const [fIdx, fEntry] of floors) {
          for (const pack of fEntry.packs.values()) {
            // GROUND TRUTH, not intent (real bug, 2026-07-16: this used to
            // report `pack.coarsePages.length` — the SET SIZE ASKED for —
            // which stayed the same whether or not those pages actually landed
            // in the cache. A coarse-pin request CAN fail under pressure (see
            // updateResidency's phase-1/phase-2 fix comment for the exact
            // scenario) — this masked exactly that failure: a report showing
            // "651 coarse pinned" sat right next to `cacheStats.pinnedCoarse:
            // 434`, a live discrepancy nobody could see. Count actual cache
            // residency per coarse-page key instead.
            const coarseIntended = pack.coarsePages.length;
            let coarseResident = 0;
            for (const page of pack.coarsePages) if (cache.isResident(page.key)) coarseResident++;
            const viewN = pack.residentViewKeys.size;
            totalCoarsePinned += coarseResident;
            totalCoarseIntended += coarseIntended;
            totalViewResident += viewN;
            layerResidency.push({
              floor: fIdx,
              layer: pack.name,
              coarsePinned: coarseResident,
              coarseIntended,
              viewResident: viewN,
            });
          }
          for (const e of fEntry.layerErrors ?? []) layerLoadErrors.push({ floor: fIdx, ...e });
        }
        // Non-zero here means the "coarse pins are the guaranteed floor"
        // invariant is currently VIOLATED for at least one pack — a page with
        // no resident data at any mip renders magenta, not blur. Should always
        // be 0 after the phase-1/phase-2 ordering fix; kept as a tripwire.
        const coarsePinShortfall = totalCoarseIntended - totalCoarsePinned;

        return {
          view,
          layout,
          canvasSizePx: { width: canvasW, height: canvasH },
          mountedInBoard: mount.fill && mount.host !== document.body,
          cacheStats: cache.stats(),
          floorsLoaded: Array.from(floors.keys()),
          // Multi-LAYER (Keyhole §4.1, the mask pile-up killer): which layer is
          // currently displayed, the packs loaded on the viewed floor, and the
          // per-(floor×pack) residency breakdown + its totals — the evidence
          // that every mask coexists with albedo inside the ONE fixed cache.
          displayLayer: displayLayerName,
          currentFloorLayers: entry ? Array.from(entry.packs.keys()) : [],
          layerResidency,
          // Why any mask is missing from layerResidency — 404 (not synced to the
          // Foundry server) vs a decode/other error. Empty = every layer loaded.
          layerLoadErrors,
          layerResidencyTotals: {
            packs: layerResidency.length,
            coarsePinnedPages: totalCoarsePinned, // GROUND TRUTH — actually resident, not just requested
            coarseIntendedPages: totalCoarseIntended, // what was ASKED for (pack.coarsePages.length summed)
            // Must be 0 — any shortfall means a coarse-pin request failed under
            // pressure, i.e. some page has NO resident fallback at any mip
            // (renders magenta, not blur). See updateResidency's phase-1/
            // phase-2 comment for the exact bug this tripwire caught.
            coarsePinShortfall,
            viewResidentPages: totalViewResident,
            residentPages: cache.stats().residentPages,
            capacityPages: cache.stats().capacityPages,
          },
          // Decode-memory proof (the Bush-failure fix): heldSources is the peak
          // number of full 576MB source bitmaps alive at once — bounded by the
          // semaphore, NOT by layers×floors. idbHits climbing vs idbSlices means
          // pages are being served from IndexedDB (no source re-decode).
          decodeStats: getDecodeStats(),
          // Multi-floor compositing (§ header note): which OTHER floors are
          // ALSO being rendered alongside the current one this update, per
          // getActiveSceneFloors' visibility.levels-derived rule (or just
          // [view.floorIndex] for the default/torture-fixture single-floor
          // behavior).
          compositedFloors: lastCompositedFloors,
          currentFloorResidentCount: albedo?.residentViewKeys.size ?? 0,
          // Multi-mip state (coarse-fallback gate evidence): the finest mip
          // being tried this view, the floor's top-level, its coarse-pin depth
          // + page count, and the packed-pyramid indirection dimensions (all
          // for the DISPLAYED pack).
          mip: {
            requested: layer?.material.uniforms.uRequestedMip.value ?? null,
            // Smooth mip blending (2026-07-16): the fractional companion to
            // `requested` — its integer part MUST equal `requested`; its
            // fractional part is the blend weight toward `requested+1`. If
            // these ever disagree, the blend uniform desynced from the walk's
            // starting mip — flag it.
            requestedFraction: layer?.material.uniforms.uRequestedMipFrac.value ?? null,
            max: layer?.material.uniforms.uMaxMip.value ?? null,
            coarseTopMips: albedo?.coarseTopMips ?? null,
            coarsePinnedPages: albedo?.coarsePages.length ?? null,
            indirectionPyramid: albedo ? `${albedo.width}x${albedo.height}` : null,
          },
          renderMsAvgLast120: Math.round(avgMs * 100) / 100,
          // HITCH STATS (2026-07-16) — the true "did we freeze" signal,
          // distinct from renderMsAvgLast120 above (which only measures
          // render()'s own duration, never a stall elsewhere on the single JS
          // thread that delays the NEXT frame from running at all). Non-empty
          // recentHitches with a real gapMs is direct, ground-truth evidence
          // of an actual main-thread block — see runZoomThrashTest for a
          // dedicated, repeatable way to trigger and capture these.
          hitchStats: {
            frameGapAvgMs:
              frameGapTimes.length > 0
                ? Math.round((frameGapTimes.reduce((a, b) => a + b, 0) / frameGapTimes.length) * 10) / 10
                : null,
            frameGapMaxMs: frameGapTimes.length > 0 ? Math.round(Math.max(...frameGapTimes) * 10) / 10 : null,
            hitchThresholdMs: HITCH_THRESHOLD_MS,
            hitchCount: hitchLog.length,
            recentHitches: hitchLog.slice(-10),
          },
          lastError,
          ...sampleDiagnostics(entry?.packs.get(displayLayerName) ?? albedo),
          // Camera smoothing (2026-07-16): live state of the held-key pan /
          // eased-zoom system — the first thing to check if panning ever
          // seems stuck (heldPanKeys non-empty with no key actually held is
          // exactly the "stuck key" class clearHeldKeys guards against) or
          // zoom never settles (targetHalfSpanPx should converge toward
          // mip.requestedFraction's implied value, not sit far from it forever).
          continuousInput: {
            heldPanKeys: Array.from(heldPanKeys),
            panVelocity,
            targetHalfSpanPx,
            currentHalfSpanPx: view.halfSpanPx,
          },
          controls:
            'Drag to pan, wheel to zoom (native Foundry feel, now eased). Also: Arrow keys/WASD pan (continuous while held), +/- zoom, 0-2 or Tab floor-switch (keys work anywhere, not in a text field).',
        };
      },
    };

    console.log(
      '[vt-pan-viewer] started — filling the scene area (PIXI occluded). Drag to pan, wheel to zoom; ' +
        'Arrow keys/WASD pan, +/- zoom, 0-2/Tab floor-switch.'
    );
    return { ok: true, ..._active.getDiagnostics() };
  } catch (err) {
    diag0.ok = false;
    diag0.fatalError = `${err?.message || err}\n${err?.stack || ''}`;
    console.error('[vt-pan-viewer] fatal error:', err);
    return diag0;
  }
}

/** For the debug panel: current diagnostics without restarting anything. */
export function getVtPanViewerDiagnostics() {
  if (!_active) return { active: false };
  return { active: true, ..._active.getDiagnostics() };
}

/**
 * Sync the already-running viewer to a specific floor index — CHEAP (one
 * residency update, no atlas/page-cache reallocation), the fix for the real
 * live crash described in `startVtPanViewer`'s `initialFloorIndex` doc.
 * boot.js's `canvasReady` handler calls this for a same-scene floor switch
 * instead of `startVtPanViewer`. No-op `{skipped:true}` if nothing is running
 * — the caller (boot.js) is expected to call `startVtPanViewer` first in that
 * case, this never silently starts a viewer on its own.
 * @param {number} floorIndex
 */
export async function setVtPanViewerFloor(floorIndex) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const changed = await _active.setFloorIndex(floorIndex);
  return { changed, ..._active.getDiagnostics() };
}

/**
 * Bind a different layer-pack to the display (e.g. 'Outdoors', 'Fire', or back
 * to 'albedo') — visual verification that a mask actually streamed, against the
 * fixture's known patterns. The masks stream regardless of what's displayed;
 * this only changes what you SEE. No-op `{skipped:true}` if nothing is running.
 * @param {string} name
 */
export async function setVtPanViewerDisplayLayer(name) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const result = await _active.setDisplayLayer(name);
  return { ...result, ..._active.getDiagnostics() };
}

/** Await one real animation frame — used to drive the thrash test over the ACTUAL render loop, not a synchronous fake. */
function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * VT ZOOM THRASH TEST (2026-07-16, author-requested: "force the camera to
 * flush the caches, start with a blank slate, start zoomed out, and thrash it
 * in and out whilst tracking things" — a deterministic, instrumented
 * reproduction of the reported "rapid full-range zoom can temporarily stop"
 * hitch, so real data pins down the cause instead of further guessing).
 *
 * BLANK SLATE: restarts the viewer FRESH (fresh atlas, fresh page cache — the
 * SAME startup params the currently-active viewer was itself created with,
 * captured on every `startVtPanViewer` call), not just a cache-clear — matches
 * the author's own framing exactly.
 *
 * THRASH: flips the eased-zoom TARGET between fully-in and fully-out every
 * SINGLE animation frame for `cycles` frames — the most aggressive version of
 * "rapid thrashing," driven through `forceZoomTarget()` which uses the EXACT
 * SAME mechanism a real held zoom key does (`setZoomTarget`). The normal
 * per-frame render loop (`updateContinuousInputs`) does all the real easing/
 * streaming work exactly as it would for genuine input — nothing here
 * bypasses or special-cases the real code path; this is a driver, not a
 * simulation.
 *
 * INSTRUMENTATION: `resetHitchTracking()` clears frame-gap/hitch history
 * first for a clean measurement window; every frame's ACTUAL wall-clock gap
 * is recorded throughout (see `renderFrame`'s own header for why this is the
 * only signal that reveals a true main-thread freeze, as opposed to
 * `renderMsAvgLast120`, which only measures the render() call's own
 * duration). Each hitch's `decodeStats`/`cacheStats` snapshot is captured at
 * the EXACT moment it happened, not just at the end — this is what actually
 * lets a hitch be correlated with what the streaming system was doing when
 * it occurred (e.g. "was mid-decode of N new pages at mip 5").
 *
 * @param {object} [opts] @param {object} [opts.startupParams] - the fresh-
 *   viewer config to restart with (same shape as `startVtPanViewer`'s own
 *   params) — pass this explicitly so the test is self-contained and doesn't
 *   require a viewer to already be running (e.g. boot.js's debug-panel button
 *   passes the torture fixture's own config directly). Falls back to the
 *   CURRENTLY active viewer's own captured startup params if omitted (handy
 *   for ad-hoc console use against whatever's already loaded) — errors if
 *   neither is available.
 * @param {number} [opts.cycles] - animation frames to thrash across (default
 *   240 ≈ 4s at 60fps). @param {number} [opts.settleFrames] - frames to let
 *   residency catch up after the thrash before reporting (default 30).
 * @returns {Promise<object>} full report: cyclesRun, before/after decode+cache
 *   stats, and the hitch-stats block (count, frame-gap avg/max, recent hitches
 *   with full context).
 */
export async function runZoomThrashTest(opts = {}) {
  const startupParams = opts.startupParams ?? _active?.startupParams;
  if (!startupParams) {
    return {
      skipped: true,
      reason: 'no startup params available — pass opts.startupParams, or start a viewer first',
    };
  }

  const cycles = opts.cycles ?? 240;
  const settleFrames = opts.settleFrames ?? 30;

  // BLANK SLATE — a genuine restart (fresh atlas + fresh page cache), not
  // merely clearing residency state. startVtPanViewer's own disposeActive()
  // tears down the OLD instance; `_active` after this line is the NEW one.
  await startVtPanViewer(startupParams);
  if (!_active) return { ok: false, error: 'restart failed — see console for the fatal error' };

  _active.resetHitchTracking();
  _active.forceZoomTarget('out'); // start fully zoomed out, per the author's own request
  for (let i = 0; i < 10; i++) await nextAnimationFrame(); // let the starting zoom settle before measuring

  const beforeDiag = _active.getDiagnostics();

  let cyclesActuallyRun = 0;
  for (let i = 0; i < cycles; i++) {
    if (!_active) break; // stopped mid-run (e.g. "Stop/Clear" clicked) — bail cleanly, don't throw
    _active.forceZoomTarget(i % 2 === 0 ? 'in' : 'out'); // flip EVERY frame — the most aggressive thrash
    await nextAnimationFrame();
    cyclesActuallyRun++;
  }

  for (let i = 0; i < settleFrames && _active; i++) await nextAnimationFrame(); // let residency catch up before the final read

  if (!_active) return { ok: false, error: 'viewer was stopped mid-run', cyclesActuallyRun };

  const afterDiag = _active.getDiagnostics();
  return {
    cyclesRun: cyclesActuallyRun,
    stoppedEarly: cyclesActuallyRun < cycles,
    settleFramesRun: settleFrames,
    beforeThrash: { decodeStats: beforeDiag.decodeStats, cacheStats: beforeDiag.cacheStats },
    afterThrash: { decodeStats: afterDiag.decodeStats, cacheStats: afterDiag.cacheStats },
    hitchStats: afterDiag.hitchStats,
    interpretation:
      'hitchStats.hitchCount > 0 with real gapMs values in recentHitches is DIRECT evidence of an actual main-' +
      "thread freeze (not renderMsAvgLast120, which cannot see this). Each hitch entry's decodeStats/cacheStats " +
      'is a snapshot from THAT EXACT moment — compare sourcesDecoded/idbSlices across consecutive hitches to see ' +
      'whether a fresh decode was in flight when the freeze happened. hitchCount=0 after this deliberately-extreme ' +
      'thrash would mean the reported hitch needs an even more aggressive or differently-shaped repro.',
  };
}

const SOAK_PAN_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];

/**
 * MapShine.soakHooks.pan driver — cycles through the four pan directions so a
 * soak run actually exercises decode/upload/evict repeatedly, via the EXACT
 * same applyKeyAndUpdate() path a real keypress uses. No-op (not an error) if
 * the viewer was never started — `soak()` reports honestly which drivers ran.
 * @param {number} i - the soak cycle index.
 */
export async function soakPanStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const key = SOAK_PAN_KEYS[i % SOAK_PAN_KEYS.length];
  await _active.applyKeyAndUpdate(key);
  return { key, ..._active.getDiagnostics() };
}

/** MapShine.soakHooks.switchFloor driver — cycles floors 0,1,2,0,1,2,... */
export async function soakSwitchFloorStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const floorIndex = i % _active.floorCount;
  await _active.applyKeyAndUpdate(String(floorIndex));
  return { floorIndex, ..._active.getDiagnostics() };
}
