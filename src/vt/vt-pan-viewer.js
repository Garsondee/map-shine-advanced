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
import { sortByLayer } from '../scene/layer-order.js';
import {
  computeCameraFrustum,
  buildQuadPositions,
  QUAD_UVS,
  QUAD_INDICES,
  viewRectToImageRect,
  computeItemViewportPx,
  rectsOverlap,
} from '../scene/world-quad.js';
import { computeQuadCorners, computeQuadBounds } from '../foundry/scene-geometry.js';
import { computeItemPlacement } from '../foundry/scene-layers.js';
import { engageFoundryFallback, clearFoundryFallback, describeRenderMode } from '../diag/render-fallback.js';
import { OCCLUSION_MODES, computeOcclusionState, createHoverFadeState, mapElevation } from '../scene/occlusion.js';

/** Wall-clock budget per GPU-upload chunk before yielding a real frame — see
 * requestDecodeUpload's Pass 3 for the live-hitch evidence this fixes. */
const MAX_MS_PER_UPLOAD_CHUNK = 10;

/**
 * How much of the page cache must remain unprotected before a pack is allowed to
 * pin its SPECULATIVE (prefetch) tier. Below this, prefetch is dropped and only
 * the pages the current view actually needs are pinned.
 *
 * THE BUG THIS FIXES (measured live, 2026-07-16, real 2-floor non-square scene —
 * 3 Level backgrounds + 2 foregrounds + 2 roof tiles = 7 packs):
 *
 *     cacheStats: { capacityPages: 2048, residentPages: 2048, freePages: 0,
 *                   pinnedCoarse: 574, pinnedView: 1320, misses: 215426 }
 *
 * Every pack reported `viewResident: 220` — which is EXACTLY its mip-1 grid
 * (22x10). With `mip.requested: 2` and `coarseTopMips: 5`, the coarse pins
 * already covered mips 2-6, so `plan.fine` (mip 2) and `plan.prefetchCoarser`
 * (mip 3) contributed ZERO new pages: **100% of the pinned view tier was
 * `prefetchFiner`** — insurance for a zoom-in that might never happen. Demand
 * was 7 x (82 + 220) = 2114 pages against a 2048 capacity, so the cache could
 * not satisfy it even in principle.
 *
 * It then never recovered, because of an interaction with the (correct) fix for
 * the "stuck view-miss" bug: a page whose request misses is deliberately NOT
 * recorded as resident, so it is retried on every residency update. Permanent
 * oversubscription therefore became permanent retry churn — the 215k misses.
 *
 * The principle that was violated: speculation was pinned at the same protection
 * level as necessity. `PageCache` never evicts ANY pinned slot ('coarse' and
 * 'view' are equally protected — page-cache.js's `_findLRUEvictable`), so a pack
 * pinning 220 speculative pages permanently denies those slots to pages some
 * other pack actually needs to render.
 *
 * Why admission control rather than simply leaving prefetch UNPINNED (which LRU
 * would then reclaim naturally, and was the first idea): an unpinned page can be
 * evicted by a LATER pack's request *within the same residency update*, after
 * this pack has already written its atlas slot into the indirection texture. The
 * indirection would then point at a slot holding a different page's pixels —
 * wrong content, not blur. Pinning is what makes the indirection trustworthy, so
 * the fix has to be "don't ask for what won't fit", not "ask and let it go".
 *
 * The check is per-pack and evaluated in draw order, so it self-limits: early
 * packs prefetch while there is room, later ones skip it. Order-dependent, but
 * BOUNDED and correct — and the fine tier is never the thing that loses.
 */
const PREFETCH_MIN_HEADROOM_FRACTION = 0.15;

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
  for (const state of _active.itemStates.values()) {
    try {
      state.material?.dispose();
    } catch (_) {}
    try {
      state.geometry?.dispose();
    } catch (_) {}
    for (const pack of state.packs.values()) {
      try {
        pack.indirectionTexture.dispose();
      } catch (_) {}
    }
  }
  try {
    _active.occlusionMask.texture.dispose();
  } catch (_) {}
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
 * Start the renderer.
 *
 * @param {object} options
 * @param {any} options.THREE
 * @param {(viewedFloorIndex:number) => Array<object>} options.buildItems - THE DRAW
 *   LIST for a given viewed floor: every drawable, as a `SceneLayerItem`
 *   (`foundry/scene-layers.js`) carrying a `key` for the sort law, an `id`, a
 *   `src`, and a `_placement`. Called fresh on every residency update, so the
 *   list follows the scene rather than being captured once.
 *
 *   Two callers, ONE path (doctrine #1): real scenes pass a closure over
 *   `collectSceneLayers(canvas.scene, …)` — Level backgrounds AND foregrounds
 *   (roof art) AND tiles; the torture fixture FABRICATES the same shapes, since
 *   it has no Foundry documents. Neither gets its own renderer.
 * @param {{width:number, height:number, sceneRect:object}} options.dimensions - the
 *   scene's canvas-space dimensions (`foundry/scene-geometry.js#computeSceneDimensions`).
 *   THE WORLD, in the coordinate sense: Foundry's padded canvas rect, +Y down.
 *   Art no longer defines the world — art is PLACED into it — which is why the
 *   view can be framed before any decode finishes.
 * @param {number} options.floorCount - how many floors the floor-switch keys cycle.
 * @param {number} [options.initialFloorIndex] - which floor the view opens on
 *   (default 0). MUST match whatever Foundry itself is currently viewing when
 *   called from an automatic re-sync (boot.js's `canvasReady` handler) — this
 *   was the root cause of a real live bug (2026-07-15): every call used to
 *   hardcode floor 0 regardless of caller intent, so switching floors via
 *   Foundry's own UI (which re-fires `canvasReady` and re-invoked this function
 *   wholesale) silently snapped the view back to floor 0 every time, AND
 *   repeatedly reallocating the full 512MB atlas + page cache on every ordinary
 *   floor switch caused a real crash after a few toggles. boot.js's
 *   `canvasReady` handler now only calls this for an ACTUAL scene change; a
 *   same-scene floor switch uses the far cheaper `setVtPanViewerFloor()`.
 * @param {(item:object) => Array<{name:string, url:string}|{name:string, channelUrls:{r:string,g:string,b:string}}>} [options.extraLayersForItem] -
 *   MULTI-LAYER (Keyhole §4.1, the mask pile-up killer): the ADDITIONAL layer-packs
 *   beyond albedo that an item streams — every painted mask (_Outdoors, _Fire,
 *   _Specular, _Tree, _Bush …). Each entry is either `{name, url}` (a single-file
 *   mask — the normal case) or `{name, channelUrls:{r,g,b}}` (CHANNEL-PACKING: 3
 *   single-channel mask files composited into ONE RGBA virtual texture at decode
 *   time, per decode-pool.js's `acquirePackedPages`).
 *
 *   Either shape becomes its OWN virtual texture (own PageTable → own namespaced
 *   page keys → own indirection texture), streamed through the SAME fixed atlas +
 *   page cache as albedo. That is what makes V2's actual cause of death —
 *   `O(world × floors × masks)` textures all held at world resolution at once —
 *   architecturally impossible: masks page through the keyhole exactly like
 *   albedo, so the working set stays `O(screen)` however many layers exist.
 *
 *   Only albedo is DISPLAYED (masks are inputs, not pixels, until an effect
 *   consumes them — `setDisplayLayer` can bind one for visual verification
 *   against the fixture's known patterns). Default `() => []`: real scenes store
 *   masks as scene flags rather than URLs, so their mask streaming is a later
 *   step; the fixture emits real mask PNGs on disk, so it is proven there first.
 * @param {() => {occluders:Array<object>, visionActive:boolean}} [options.getOcclusionInputs] -
 *   the occluder set for the occlusion mask. Currently unused: the mask PRODUCER
 *   isn't built (see `diag/render-fallback.js`'s sibling note and
 *   `scene/occlusion.js`) — the shader path is real, but its mask is an inert
 *   placeholder, so every item renders unoccluded.
 * @returns {Promise<object>} initial diagnostics (see getDiagnostics() for the shape).
 */
export async function startVtPanViewer({
  THREE,
  buildItems,
  dimensions,
  floorCount,
  initialFloorIndex = 0,
  extraLayersForItem,
  getOcclusionInputs,
}) {
  extraLayersForItem ??= () => [];
  getOcclusionInputs ??= () => ({ occluders: [], visionActive: false });
  // Captured for runZoomThrashTest's "blank slate" restart (2026-07-16) —
  // the SAME fully-resolved params this call itself used, so a later restart
  // reproduces an identical fresh viewer without the caller needing to
  // remember/re-supply them.
  const startupParams = {
    THREE,
    buildItems,
    dimensions,
    floorCount,
    initialFloorIndex,
    extraLayersForItem,
    getOcclusionInputs,
  };
  // World space IS Foundry canvas space (foundry/scene-geometry.js) — the padded
  // rect, +Y down. RECTANGULAR: `Scene#padding` defaults to 0.25 and the default
  // scene is 4000x3000, so a square world is the exception, not the rule.
  const world = { width: dimensions.width, height: dimensions.height };
  disposeActive();
  stopVtSmokeTest(); // avoid two renderers fighting over the same corner of the screen

  const diag0 = { errors: [] };
  // Hoisted so the catch can TEAR THE CANVAS DOWN. It is appended before any
  // risky work and is opaque (background:#000), so a failure that leaves it in
  // place puts a black rectangle over a perfectly healthy Foundry canvas — which
  // is what used to block the safety slide (diag/render-fallback.js).
  let canvas = null;
  try {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default
    const cache = new PageCache({ budgetBytes: 512 * 1024 * 1024 });

    const mount = resolveMountHost();
    let canvasW = measureHost(mount.host).width;
    let canvasH = measureHost(mount.host).height;
    canvas = document.createElement('canvas');
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

    // THE OCCLUSION MASK — currently an INERT 1x1 placeholder, deliberately.
    //
    // scene/occlusion.js has the full model ported and Node-tested, and the
    // shader in ensureItemMesh() implements Foundry's algorithm for real. What
    // is NOT built yet is the mask PRODUCER: rendering each occludable token's
    // vision polygon and radial disc into a screen-space RGBA target with MIN
    // blending, every time perception changes.
    //
    // The clear value is Foundry's own (`CanvasOcclusionMask#clearColor =
    // [0,1,1,1]`), which is exactly "nothing occludes anything":
    //   R = 0 -> Fade says "occlude everywhere", but the per-object fade WEIGHT
    //            is what gates it, and that stays 0 with no occluding token.
    //   G/B/A = 1 -> above every possible elevation index, so step() -> not occluded.
    // So every item renders unoccluded until the producer exists, and turning it
    // on is purely additive: build the producer, point this uniform at its
    // render texture, and feed real weights in updateResidency().
    const occlusionMask = (() => {
      const data = new Uint8Array([0, 255, 255, 255]);
      const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      texture.needsUpdate = true;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      return { texture, visionActive: false, elevationTable: [-Infinity] };
    })();
    // itemId -> item state (see ensureItemLoaded). ONE entry per DRAWABLE, not
    // per floor: a floor's background, its foreground (roof) art and every tile
    // are all just items, each with its own virtual texture, each placed in
    // world space by its own quad. That is what lets a roof and a rug sit at
    // different elevations on the same floor — the thing a per-floor model
    // structurally cannot express.
    const itemStates = new Map();
    const itemLoadErrors = [];
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
    async function buildPack(ownerId, name, source, { coarsePinMaxPages } = {}) {
      const isPacked = !!source.channelUrls;
      // Read dimensions WITHOUT holding a full 576 MB bitmap (getSourceDimensions
      // parses the PNG header) — the pack keeps only the URL(s); pages are
      // sliced on demand through the bounded, IndexedDB-backed acquire path.
      // For a packed pack, the 3 channel sources are assumed to share
      // dimensions (they're masks of the same floor at the same resolution,
      // like the fixture's authored trio) — the 'r' source is the reference.
      const dimUrl = isPacked ? source.channelUrls.r : source.url;
      const { width: srcWidth, height: srcHeight } = await getSourceDimensions(dimUrl);

      // RECTANGULAR SOURCES ARE SUPPORTED as of 2026-07-16 — the loud
      // non-square throw that used to stand here is gone, along with the
      // limitation behind it. `PageTable` now takes independent
      // worldWidthPx/worldHeightPx (see its header for why this was overdue:
      // square scene art is the exception, so most real scenes could not render
      // at all, and tiles — essentially never square — were blocked outright).
      const table = new PageTable({
        id: `panviewer:${ownerId}:${name}`,
        worldWidthPx: srcWidth,
        worldHeightPx: srcHeight,
      });

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
      const mipPagesArr = new Int32Array(VT_MAX_MIPS * 2); // ivec2[] since 2026-07-16 (rectangular grids)
      for (let m = 0; m < indirectionLayout.origins.length; m++) {
        mipOriginArr[m * 2] = indirectionLayout.origins[m].x;
        mipOriginArr[m * 2 + 1] = indirectionLayout.origins[m].y;
        mipPagesArr[m * 2] = indirectionLayout.origins[m].pagesX;
        mipPagesArr[m * 2 + 1] = indirectionLayout.origins[m].pagesY;
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
          ? { kind: 'packed', channelUrls: source.channelUrls, packId: `packed://${ownerId}/${name}` }
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

    /**
     * Load ONE drawable: its albedo virtual texture, any extra layer-packs
     * (masks) that ride along with it, and its world placement.
     *
     * The placement is what makes this different from the old per-floor loader:
     * an item is NOT the whole world any more. `computeItemPlacement` resolves
     * where this specific image lands in canvas space (a Level's art centred on
     * the padded `sceneRect`; a tile at its own x/y/rotation/anchor), and that
     * needs the texture's NATIVE size — which is why it happens here, after
     * buildPack has read the header, rather than in the pure collection step.
     */
    async function ensureItemLoaded(item) {
      const existing = itemStates.get(item.id);
      if (existing) {
        existing.item = item; // refresh (renderOrder/key change per update)
        return existing;
      }

      const packs = new Map();
      const albedoPack = await buildPack(item.id, 'albedo', { url: item.src });
      packs.set('albedo', albedoPack);

      // Per-pack load failures are collected here AND surfaced in diagnostics
      // (getDiagnostics.layerLoadErrors) — not just console — because the
      // author debugs by pasting reports, not reading the console
      // ([[keyhole-debug-panel]] protocol). A silent fallback-to-albedo (mask
      // 404 / not synced to the server) looks identical to "masks unsupported"
      // in the residency report; this makes the actual reason legible there.
      const layerErrors = [];
      for (const layerDesc of extraLayersForItem(item)) {
        const { name } = layerDesc;
        // CHANNEL-PACKING: a layer descriptor is either { name, url } (single
        // source — the normal case) or { name, channelUrls: {r,g,b} } (packed
        // — see buildPack's header). errorUrl is just for a legible error log.
        const source = layerDesc.channelUrls ? { channelUrls: layerDesc.channelUrls } : { url: layerDesc.url };
        const errorUrl = layerDesc.channelUrls
          ? `r:${layerDesc.channelUrls.r} g:${layerDesc.channelUrls.g} b:${layerDesc.channelUrls.b}`
          : layerDesc.url;
        if (packs.has(name)) {
          console.warn(`[vt-pan-viewer] ${item.id}: duplicate layer name "${name}" ignored.`);
          continue;
        }
        try {
          packs.set(name, await buildPack(item.id, name, source, { coarsePinMaxPages: MASK_COARSE_PIN_MAX_PAGES }));
        } catch (err) {
          // A missing/broken mask must not take the whole item (or its albedo)
          // down — record it and carry on with the packs that did load. A
          // single absent mask is a data gap, not an architecture failure.
          const message = String(err?.message || err);
          layerErrors.push({ item: item.id, layer: name, url: errorUrl, error: message });
          console.error(`[vt-pan-viewer] ${item.id}: layer "${name}" failed to load (${errorUrl}):`, err);
        }
      }

      const imageSize = { width: albedoPack.table.worldWidthPx, height: albedoPack.table.worldHeightPx };
      const state = {
        item,
        packs,
        albedoPack,
        layerErrors,
        imageSize,
        placement: null,
        placementKey: null,
        worldBounds: null,
        geometry: null,
        material: null,
        mesh: null,
        hoverFade: createHoverFadeState(),
        occluded: false,
      };
      refreshItemPlacement(state, item);
      itemStates.set(item.id, state);
      return state;
    }

    /**
     * (Re)resolve an item's world placement, rebuilding its quad only when the
     * placement actually changed.
     *
     * Recomputed every residency pass rather than cached at load, so a tile the
     * GM drags, rotates or resizes follows its document instead of freezing
     * where it first appeared. The `placementKey` compare keeps that cheap: the
     * common case is "nothing moved", which costs one string build and no GPU work.
     */
    function refreshItemPlacement(state, item) {
      const placement = computeItemPlacement(item, state.imageSize, dimensions);
      const key = `${placement.x},${placement.y},${placement.width},${placement.height},${placement.anchorX},${placement.anchorY},${placement.rotation}`;
      if (key === state.placementKey) return false;
      state.placement = placement;
      state.placementKey = key;
      state.worldBounds = computeQuadBounds(placement);
      if (state.geometry) {
        const pos = state.geometry.getAttribute('position');
        const corners = computeQuadCorners(placement);
        const buf = buildQuadPositions(corners);
        for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
        pos.needsUpdate = true;
        state.geometry.computeBoundingSphere();
      }
      return true;
    }

    const scene = new THREE.Scene();

    // THE WORLD-SPACE CAMERA. Frustum values are set per frame by updateCamera()
    // from the live view rect; the placeholder args just construct it.
    //
    // This replaces the old fullscreen-quad-with-remapped-UVs model, in which
    // the quad WAS the screen and its UV WAS the world position. That only
    // worked because those two spaces were conflated, which stops being true the
    // moment anything has to sit at a specific spot in a padded canvas.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    /**
     * Point the camera at the current view rect.
     *
     * THE Y-FLIP LIVES HERE AND NOWHERE ELSE (scene/world-quad.js explains why,
     * and Node-tests the orientation chain end to end): computeCameraFrustum
     * returns `top = minY`, INVERTED from the usual Y-up convention, so Three
     * maps the smallest world Y to NDC +1 = the top of the screen. That is what
     * lets every quad use raw Foundry coordinates with no conversion.
     *
     * Called every frame from renderFrame(), so a mouse drag tracks the cursor
     * at display rate without waiting on any streaming work — the job
     * reframeVisibleLayers() used to do by rewriting UVs, now done by moving the
     * camera, which is both cheaper and impossible to compound (the exact bug
     * class the deleted reframe path produced live on 2026-07-15).
     */
    function updateCamera() {
      if (!view) return;
      const rect = viewToWorldRect(view, canvasW / canvasH);
      const f = computeCameraFrustum(rect);
      camera.left = f.left;
      camera.right = f.right;
      camera.top = f.top;
      camera.bottom = f.bottom;
      camera.updateProjectionMatrix();
    }

    /**
     * Create (once) the world-space quad + shader for ONE draw item.
     *
     * Geometry is the item's four REAL world corners (computeQuadCorners →
     * buildQuadPositions), with static 0..1 UVs — no per-frame UV rewriting.
     *
     * `side: DoubleSide` is load-bearing, not defensive: Foundry flips a tile
     * horizontally with a NEGATIVE texture.scaleX (see scene-geometry.js
     * #computeTextureFit, which deliberately preserves the sign), and a mirrored
     * quad has reversed winding. Back-face culling would make every flipped tile
     * silently vanish.
     *
     * `transparent:true` + `depthTest/depthWrite:false` + explicit `renderOrder`
     * (from sortByLayer — THE law, scene/layer-order.js) is what makes the whole
     * composite work: a real ALPHA HOLE in an upper floor's art blends against
     * whatever a lower floor already painted, and a roof paints over the tokens
     * beneath it purely because its elevation sorts later.
     */
    function ensureItemMesh(state) {
      if (state.mesh) return state;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(buildQuadPositions(computeQuadCorners(state.placement)), 3)
      );
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));

      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide, // see this function's doc — negative scaleX flips winding
        uniforms: {
          uPageAtlas: { value: atlas.texture },
          uPageTable: { value: null }, // set per-item in bindMeshToPack()
          uPagesPerAxis: { value: layout.pagesPerAxis },
          uPagesPerLayer: { value: layout.pagesPerLayer },
          uPageSizePx: { value: layout.pageSizePx },
          uBorderPx: { value: 4 },
          uAtlasSizePx: { value: layout.atlasSizePx },
          uWorldSizePx: { value: new THREE.Vector2(1, 1) }, // this pack's image size; vec2 (rectangular)
          // Multi-mip: the finest mip to TRY (analytic, per view) + the coarsest,
          // and the flattened-pyramid per-mip layout the shader walks. uMipOrigin
          // is a flat Int32Array (ivec2[VT_MAX_MIPS] == 2 ints/level) — THREE
          // uploads it via gl.uniform2iv directly.
          uRequestedMip: { value: 0 },
          uRequestedMipFrac: { value: 0 }, // smooth mip blending (residency.chooseMipFraction)
          uMaxMip: { value: 0 },
          uMipOrigin: { value: new Int32Array(VT_MAX_MIPS * 2) },
          uMipPagesPerAxis: { value: new Int32Array(VT_MAX_MIPS * 2) }, // ivec2[] (rectangular)
          // Per-item appearance (Foundry document data).
          uTint: { value: new THREE.Vector3(1, 1, 1) },
          uAlpha: { value: 1 },
          // OCCLUSION (scene/occlusion.js has the model + the citations).
          uOcclusionMask: { value: occlusionMask.texture },
          uOcclusionElevation: { value: 0 },
          uOcclusionWeights: { value: new THREE.Vector4(0, 0, 0, 0) }, // fade, radial, vision, surface
          uUnoccludedAlpha: { value: 1 },
          uOccludedAlpha: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec2 vScreenCoord;
          void main() {
            vUv = uv;
            // Real world-space geometry through a real camera now — NOT the old
            // pass-position-straight-to-gl_Position fullscreen trick.
            vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = clip;
            // The occlusion mask is a SCREEN-space texture, so sample it in
            // screen space. Ortho projection means w == 1, but the divide is kept
            // for correctness rather than relying on that.
            vScreenCoord = (clip.xy / clip.w) * 0.5 + 0.5;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          precision highp sampler2DArray;
          varying vec2 vUv;
          varying vec2 vScreenCoord;
          uniform vec3 uTint;
          uniform float uAlpha;
          uniform sampler2D uOcclusionMask;
          uniform float uOcclusionElevation;
          uniform vec4 uOcclusionWeights;
          uniform float uUnoccludedAlpha;
          uniform float uOccludedAlpha;
          ${VT_SAMPLE_GLSL}
          void main() {
            vec4 c = vtSample(vUv);
            c.rgb *= uTint;
            c.a *= uAlpha;

            // OCCLUSION — Foundry's own algorithm (occlusion.mjs:16), verbatim in
            // shape. The mask's four channels each hold an ELEVATION INDEX
            // (R=Fade G=Radial B=Vision A=Surface); a channel says "occlude me"
            // where the occluder recorded there sits BELOW my own elevation.
            // step(edge,x) is 0 when x < edge, so 1-step is exactly that test.
            vec4 occluded = 1.0 - step(vec4(uOcclusionElevation), texture2D(uOcclusionMask, vScreenCoord));
            vec4 amounts = occluded * uOcclusionWeights;
            float occ = max(max(amounts.x, amounts.y), max(amounts.z, amounts.w));
            // Foundry multiplies the WHOLE fragColor because PIXI is
            // premultiplied-alpha; Three's default blending is not, so only
            // alpha is scaled here. Same visual result, correct for this blend.
            c.a *= mix(uUnoccludedAlpha, uOccludedAlpha, occ);

            gl_FragColor = c;
          }
        `,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false; // we cull explicitly against worldBounds; Three's sphere test is redundant here
      mesh.visible = false;
      scene.add(mesh);

      state.geometry = geometry;
      state.material = material;
      state.mesh = mesh;
      return state;
    }

    let view = null; // set once the first item is loaded
    const frameTimes = [];
    let lastError = null;

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
      // Re-derive the camera from the live view EVERY frame: this is what makes
      // a drag track the cursor at display rate without waiting on streaming,
      // and it is the single place the Y-flip is applied (see updateCamera).
      updateCamera();
      renderer.render(scene, camera);
      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
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
    /**
     * Plan + stream ONE pack's view residency, then rebuild its indirection
     * buffer fresh from the cache's own slot mapping.
     *
     * THE CHANGE THAT MATTERS: residency is planned in this pack's OWN IMAGE
     * space, not in world space. Those used to be the same thing (a floor's art
     * WAS the world), and they are not any more — a tile's texture covers a
     * small patch of canvas, and a Level's art is inset inside the padded rect.
     * `viewRectToImageRect` does the conversion (exactly inverting the item's
     * placement, so it stays correct for a rotated tile).
     *
     * `computeItemViewportPx` supplies the mip selector's screen extent. Passing
     * the canvas size here — the obvious-looking thing — would tell the planner
     * that a 1024px tile drawn 100px wide needs mip 0, i.e. every small tile
     * streams its full resolution: O(tiles) instead of O(screen), which is the
     * exact cost model this whole architecture exists to destroy.
     */
    async function streamPackResidency(pack, state, worldRect) {
      const imageSize = { width: pack.table.worldWidthPx, height: pack.table.worldHeightPx };
      const imageRect = viewRectToImageRect(worldRect, state.placement, imageSize);
      if (!imageRect) {
        // The view doesn't touch this item at all — release its view tier and
        // leave it on coarse pins (which are never evicted, so it stays instantly
        // available, soft, if the camera comes back).
        for (const key of pack.residentViewKeys) cache.unpin(key);
        pack.residentViewKeys = new Set();
        return;
      }

      const quadWorldSize = {
        width: state.worldBounds.maxX - state.worldBounds.minX,
        height: state.worldBounds.maxY - state.worldBounds.minY,
      };
      const viewportPx = computeItemViewportPx(worldRect, { width: canvasW, height: canvasH }, quadWorldSize);

      // Analytic mip selection (§4.1 — top-down camera, no GPU feedback): the
      // finest mip that resolves at this size, plus BOTH neighbour mips as a
      // prefetch — coarser (zoom-out insurance) AND finer (zoom-in insurance).
      const plan = planResidency(pack.table, imageRect, viewportPx, { guardPages: 1 });
      pack.lastRequestedMip = plan.mip;
      pack.lastRequestedMipFraction = plan.mipFraction; // drives the shader's smooth mip blend

      // RELEASE → MEASURE → REQUEST. The order is the whole point.
      //
      // THE BUG THIS FIXES (live evidence, 2026-07-16, real 2-floor scene, 7 packs):
      // this used to request (and therefore PIN) the new page set and only THEN
      // unpin the pages it no longer wanted. In a static view that is harmless —
      // both sets are identical. But any view change that shifts the page set (a
      // pan, or a zoom that crosses a mip boundary) pinned the OLD set and the NEW
      // set SIMULTANEOUSLY: peak ≈ 2x steady state per pack, ≈3000 pages against a
      // 2048 capacity. And because PageCache never evicts a PINNED slot, nothing
      // could be reclaimed to satisfy the shortfall — so the requests missed, and
      // the (correct) "stuck view-miss" retry re-asked for them on every single
      // update. That is the 215426-misses report: 67s of panning. The report taken
      // at a static default view showed misses: 0 with the identical pin counts
      // (574 coarse + 1320 view = 1894, comfortably inside 2048) — the steady
      // state was never oversubscribed at all, only the TRANSITIONS were.
      //
      // `cache.unpin()` merely clears the pin flag; it does NOT evict (page-cache.js
      // :119). So releasing first is strictly safe — the pages stay resident and
      // merely become LRU-eligible — and it caps peak pinned at max(old, new)
      // instead of old + new.
      const candidates = [...plan.fine, ...plan.prefetchCoarser, ...plan.prefetchFiner].filter(
        (pg) => !pack.coarseKeySet.has(pg.key)
      );
      const candidateKeys = new Set(candidates.map((pg) => pg.key));
      for (const key of pack.residentViewKeys) if (!candidateKeys.has(key)) cache.unpin(key);

      // ADMISSION CONTROL for the speculative tiers. `plan.fine` is what the
      // CURRENT view needs and is always admitted; the prefetch tiers are
      // insurance against a future zoom and are admitted only while the cache can
      // afford to pin them (see PREFETCH_MIN_HEADROOM_FRACTION). Measured AFTER
      // the release above, so pages this pack is already dropping cannot count
      // against its own budget. Headroom counts unprotected slots — PageCache
      // never evicts a pinned slot of either class, so PINNED pages are the real
      // budget, not `residentPages`.
      const cacheStats = cache.stats();
      const headroomPages = cache.capacityPages - (cacheStats.pinnedCoarse + cacheStats.pinnedView);
      const admitPrefetch = headroomPages > cache.capacityPages * PREFETCH_MIN_HEADROOM_FRACTION;
      if (!admitPrefetch) prefetchSkippedPacks++;

      const neededViewPages = admitPrefetch ? candidates : plan.fine.filter((pg) => !pack.coarseKeySet.has(pg.key));
      if (!admitPrefetch) {
        // Declining prefetch also means releasing any speculative pages still held
        // from a previous update — otherwise "declined" would only apply to new
        // ones and the pack would keep hoarding what it can no longer justify.
        const keep = new Set(neededViewPages.map((pg) => pg.key));
        for (const key of pack.residentViewKeys) if (!keep.has(key)) cache.unpin(key);
      }

      // `diff.toUnpin` is deliberately unused: the release above already covers it
      // (prevKeys not in the final needed set), and doing it here would be too late.
      const diff = diffResidency(pack.residentViewKeys, neededViewPages);
      await requestDecodeUpload(pack, diff.toRequest, 'view');
      // GROUND TRUTH, not intent (the "stuck view-miss" bug, 2026-07-16): a page
      // whose request MISSED (cache full, nothing evictable — a normal outcome
      // under pressure) must stay eligible for retry, so only keys that are
      // ACTUALLY resident are recorded. Tracking the ASK instead left a missed
      // page permanently stuck on its coarse-fallback blur even after pressure
      // relieved, self-healing only if you happened to pan away and back.
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

    /**
     * Point one item's shader at a specific pack (its albedo, or a mask when the
     * display layer is switched for visual verification), and push its per-item
     * appearance + occlusion uniforms.
     */
    function bindMeshToPack(state, pack) {
      const u = state.material.uniforms;
      if (u.uPageTable.value !== pack.indirectionTexture) {
        // Bind: fresh array references (per pack) guarantee THREE re-uploads
        // them; within a pack they're constant.
        u.uPageTable.value = pack.indirectionTexture;
        u.uWorldSizePx.value.set(pack.table.worldWidthPx, pack.table.worldHeightPx);
        u.uMaxMip.value = pack.table.maxMip;
        u.uMipOrigin.value = pack.mipOriginArr;
        u.uMipPagesPerAxis.value = pack.mipPagesArr;
      }
      u.uRequestedMip.value = pack.lastRequestedMip; // re-read every update (mip changes with zoom)
      u.uRequestedMipFrac.value = pack.lastRequestedMipFraction;

      const item = state.item;
      const tint = item.tint ?? 0xffffff;
      u.uTint.value.set(((tint >> 16) & 0xff) / 255, ((tint >> 8) & 0xff) / 255, (tint & 0xff) / 255);
      u.uAlpha.value = item.alpha ?? 1;

      // OCCLUSION weights (scene/occlusion.js — the model, with citations).
      // `occluded` stays false until the mask producer exists to identify which
      // items a token is actually standing under; the weights below are still
      // computed from real document data, so wiring the producer in is additive.
      const modes = item.occlusion?.modes ?? OCCLUSION_MODES.NONE;
      const st = computeOcclusionState({
        occlusionMode: modes,
        occluded: state.occluded,
        visionActive: occlusionMask.visionActive,
        hoverFadeAmount: state.hoverFade.occlusion,
      });
      u.uOcclusionWeights.value.set(st.fade, st.radial, st.vision, st.surface);
      u.uOcclusionElevation.value = mapElevation(occlusionMask.elevationTable, item.key.elevation);
      u.uUnoccludedAlpha.value = 1;
      u.uOccludedAlpha.value = item.occlusion?.alpha ?? 0;
    }

    let lastItems = []; // exposed in diagnostics — the current sorted draw list
    // How many packs had their speculative tier declined this update (see
    // PREFETCH_MIN_HEADROOM_FRACTION). Persistently non-zero means the scene's
    // REQUIRED working set is close to the cache budget — the honest signal that
    // the cache is genuinely full, as opposed to full of speculation.
    let prefetchSkippedPacks = 0;

    /**
     * THE FRAME'S WORK: resolve the draw list, stream what it needs, order it.
     *
     * Item-based, not floor-based. A floor's background, its foreground (roof)
     * art and every tile on it are peers here — each with its own virtual
     * texture and its own world quad — which is precisely what lets a roof sit
     * ABOVE the tokens on its floor and BELOW the floor above it. A per-floor
     * model has nowhere to put that.
     */
    async function updateResidency() {
      // sortByLayer stamps `renderOrder` on each item — THE law
      // (scene/layer-order.js). Rebuilt every update because the draw list
      // itself changes with the viewed floor.
      const items = sortByLayer(buildItems(view.floorIndex));
      const wantedIds = new Set(items.map((i) => i.id));
      prefetchSkippedPacks = 0;

      // Items that dropped OUT of the draw list: release their VIEW pages (never
      // their coarse pins — those stay resident always, §4.1/§4.5) and hide the
      // mesh. Unpin never evicts directly — PageCache's LRU decides that under
      // real pressure — so a quick switch-and-back is free.
      for (const [id, state] of itemStates) {
        if (wantedIds.has(id)) continue;
        for (const pack of state.packs.values()) {
          for (const key of pack.residentViewKeys) cache.unpin(key);
          pack.residentViewKeys = new Set();
        }
        if (state.mesh) state.mesh.visible = false;
      }

      const worldRect = viewToWorldRect(view, canvasW / canvasH);

      // PHASE 1 — lock in EVERY item's COARSE pins before ANY item's view-tier
      // streaming (real live bug, 2026-07-16: whole-screen MAGENTA under the
      // castle-courtyard test). PageCache protects 'coarse' and 'view' pins
      // identically, so an earlier item's large view-tier request could saturate
      // the cache before a later item's small coarse-pin request even ran — and a
      // coarse-pin request that finds nothing evictable simply FAILS, for pages
      // whose entire job is to GUARANTEE something is always resident. Front-
      // loading every coarse pin makes that structurally impossible.
      const states = [];
      for (const item of items) {
        try {
          states.push([item, await ensureItemLoaded(item)]);
        } catch (err) {
          // One broken item (404 art, undecodable file) must not take the scene
          // down. Recorded rather than thrown — the debug panel surfaces this,
          // since the author debugs by pasting reports, not reading the console.
          const message = String(err?.message || err);
          if (!itemLoadErrors.some((e) => e.id === item.id)) {
            itemLoadErrors.push({ id: item.id, src: item.src, error: message });
            console.error(`[vt-pan-viewer] item "${item.id}" failed to load (${item.src}):`, err);
          }
        }
      }

      // PHASE 2 — view-tier streaming + mesh update, now that every coarse pin
      // is locked in and can't be starved.
      for (const [item, state] of states) {
        refreshItemPlacement(state, item); // follow document moves/rotations/resizes
        const onScreen = rectsOverlap(state.worldBounds, worldRect);

        // Stream EVERY pack — albedo AND every mask — through the ONE shared
        // cache. This is the mask-pile-up proof: all of an item's layers are
        // resident at once, yet each costs only its visible pages, never a
        // world-resolution texture.
        for (const pack of state.packs.values()) {
          if (onScreen) {
            await streamPackResidency(pack, state, worldRect);
          } else {
            for (const key of pack.residentViewKeys) cache.unpin(key);
            pack.residentViewKeys = new Set();
          }
        }

        ensureItemMesh(state);
        const displayPack = state.packs.get(displayLayerName) ?? state.albedoPack;
        bindMeshToPack(state, displayPack);
        state.mesh.visible = onScreen;
        state.mesh.renderOrder = item.renderOrder; // from sortByLayer — THE law
      }

      lastItems = items;
    }

    /**
     * Swap the DISPLAYED layer-pack (e.g. 'albedo' → 'Outdoors') — visual
     * verification that a mask actually streamed correctly, against the
     * fixture's known patterns. The pack is already resident; this just rebinds
     * on the next residency pass.
     * @param {string} name
     */
    async function setDisplayLayer(name) {
      displayLayerName = name;
      await updateResidency();
      return { displayLayer: displayLayerName };
    }

    // --- Mouse pan/zoom (native-Foundry feel) --------------------------------
    // The camera is re-derived from the live view state every frame
    // (updateCamera, called from renderFrame), so a drag tracks the cursor at
    // display rate for free. This replaces reframeVisibleLayers(), which used to
    // rewrite every quad's UVs per pointermove — cheaper, and structurally immune
    // to the UV-compounding bug that path produced live on 2026-07-15.

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
      const next = applyPanByPixels(view, dx, dy, canvasH, world);
      if (next === view) return;
      view = next;
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
      targetHalfSpanPx = clampHalfSpan((targetHalfSpanPx ?? view.halfSpanPx) * factor, world);
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

      // Continuous keyboard pan: ease velocity toward what the held keys
      // imply, then integrate position — replaces the old discrete per-
      // keydown jump with a smooth glide whose speed scales with the CURRENT
      // zoom (screenfuls/sec, matching the old step's own feel).
      const targetVelocity = computeTargetPanVelocity(heldPanKeys, view.halfSpanPx * PAN_SPEED_SCREENFULS_PER_SEC);
      panVelocity = easeVelocityTowardTarget(panVelocity, targetVelocity, dtSec, PAN_RAMP_HALF_LIFE_SEC);
      if (Math.abs(panVelocity.x) > 0.01 || Math.abs(panVelocity.y) > 0.01) {
        const nextView = integratePan(view, panVelocity, dtSec, world);
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
          const nextView = applyZoomAtPixel(view, factor, zoomAnchorSx, zoomAnchorSy, canvasW, canvasH, world);
          if (nextView !== view) {
            view = nextView;
            dirty = true;
          }
        }
      }

      if (dirty) {
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
      const ctx = { world, floorCount };
      const next = applyKey(view, key, ctx);
      if (next === view) return false;
      view = next;
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
      const ctx = { world, floorCount };
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

    // The initial view. Opens on `initialFloorIndex` (defaults to 0, but a
    // real-scene auto-start passes whatever Foundry itself is currently viewing
    // — see this function's own param doc for why that match matters). Frames a
    // generous chunk of the world so it immediately reads as "the map fills the
    // display" rather than a tiny zoomed-in patch — that view is served largely
    // by coarse pins, so it's instant.
    //
    // The world is the SCENE's canvas rect now, not the first floor image's
    // size: art no longer defines the world (it's placed INTO it), so the view
    // no longer has to wait on a decode to know where it is.
    const clampedInitialFloor = Math.max(0, Math.min(floorCount - 1, initialFloorIndex));
    view = createInitialViewState({
      world,
      floorIndex: clampedInitialFloor,
      halfSpanPx: Math.max(world.width, world.height) * 0.25,
    });
    targetHalfSpanPx = view.halfSpanPx; // eased-zoom target starts equal to the actual value — no zoom-on-load
    await updateResidency();

    loopActive = true;
    renderer.setAnimationLoop(renderFrame);

    // Background prewarm (non-blocking, best-effort): stream every OTHER floor's
    // items' coarse pins so a floor switch is instant (§4.5 — coarse pins for
    // every floor always resident). Fire-and-forget so it never delays the
    // initial floor's first paint; a failure on one item can't take the viewer
    // down. Items are per-floor now, so this asks buildItems for each floor's
    // draw list rather than loading "a floor".
    for (let f = 0; f < floorCount; f++) {
      if (f === clampedInitialFloor) continue;
      Promise.resolve()
        .then(async () => {
          for (const item of buildItems(f)) await ensureItemLoaded(item);
        })
        .catch((err) => console.warn(`[vt-pan-viewer] prewarm floor ${f} failed:`, err));
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
      itemStates,
      occlusionMask,
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
        targetHalfSpanPx = clampHalfSpan(direction === 'in' ? 0 : Infinity, world);
        zoomAnchorSx = canvasW / 2;
        zoomAnchorSy = canvasH / 2;
      },
      /**
       * A CHEAP zoom read, for the thrash test's per-frame loop.
       *
       * Deliberately not `getDiagnostics()`: that does a `gl.readPixels`, scans the
       * whole indirection buffer and walks every cache slot. Polling it once per
       * frame would make the measuring instrument the dominant cost — the test
       * would be reporting hitches it caused itself.
       */
      getZoomState: () => ({ halfSpanPx: view?.halfSpanPx ?? 0, targetHalfSpanPx }),
      getDiagnostics() {
        const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
        // The viewed floor's first item, as the sample subject for the
        // pixel/indirection ground-truth probe below.
        const sampleState = lastItems.length ? itemStates.get(lastItems[0].id) : undefined;
        const albedo = sampleState?.albedoPack;
        const layerResidency = [];
        const layerLoadErrors = [];
        let totalViewResident = 0;
        let totalCoarsePinned = 0;
        let totalCoarseIntended = 0;
        for (const [itemId, state] of itemStates) {
          for (const pack of state.packs.values()) {
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
              item: itemId,
              kind: state.item.kind,
              layer: pack.name,
              coarsePinned: coarseResident,
              coarseIntended,
              viewResident: viewN,
            });
          }
          for (const e of state.layerErrors ?? []) layerLoadErrors.push({ item: itemId, ...e });
        }
        for (const e of itemLoadErrors) layerLoadErrors.push(e);
        // Non-zero here means the "coarse pins are the guaranteed floor"
        // invariant is currently VIOLATED for at least one pack — a page with
        // no resident data at any mip renders magenta, not blur. Should always
        // be 0 after the phase-1/phase-2 ordering fix; kept as a tripwire.
        const coarsePinShortfall = totalCoarseIntended - totalCoarsePinned;

        return {
          view,
          layout,
          // GROUND TRUTH: is MSA the thing on screen right now, or is Foundry?
          // This could NOT be answered from a report during the 2026-07-16
          // non-square incident — the diagnostics described MSA's internals in
          // detail while saying nothing about whether any of it reached the
          // display. Read from the DOM, not from intent.
          ...describeRenderMode({ canvas, loopActive }),
          // Non-zero = at least one pack could not afford its speculative tier this
          // update. A few is healthy self-limiting; ALL of them, every update,
          // means the required working set itself is at the budget.
          prefetchSkippedPacks,
          canvasSizePx: { width: canvasW, height: canvasH },
          mountedInBoard: mount.fill && mount.host !== document.body,
          cacheStats: cache.stats(),
          // THE DRAW LIST, in paint order — the direct answer to "why is this
          // on top of that". Each entry's renderOrder came from sortByLayer
          // (scene/layer-order.js) over its (elevation, sortLayer, sort, zIndex)
          // key, so this table IS the layering, not a summary of it.
          drawList: lastItems.map((i) => ({
            renderOrder: i.renderOrder,
            id: i.id,
            kind: i.kind,
            elevation: i.key.elevation,
            sortLayer: i.key.sortLayer,
            sort: i.key.sort,
            zIndex: i.key.zIndex,
            visible: itemStates.get(i.id)?.mesh?.visible ?? false,
            occlusionModes: i.occlusion?.modes ?? 0,
          })),
          itemsLoaded: itemStates.size,
          world,
          // Multi-LAYER (Keyhole §4.1, the mask pile-up killer): which layer is
          // currently displayed, the packs loaded on the viewed floor, and the
          // per-(floor×pack) residency breakdown + its totals — the evidence
          // that every mask coexists with albedo inside the ONE fixed cache.
          displayLayer: displayLayerName,
          sampleItemLayers: sampleState ? Array.from(sampleState.packs.keys()) : [],
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
          // ALSO being rendered alongside the current one this update. Derived
          // from the draw list rather than tracked separately: an item knows
          // which levels it is visible on, so the composited set is a fact about
          // the list, not a second piece of state that can disagree with it.
          compositedLevelIds: Array.from(new Set(lastItems.flatMap((i) => i.visibleOnLevelIds ?? []))),
          currentFloorResidentCount: albedo?.residentViewKeys.size ?? 0,
          // Multi-mip state (coarse-fallback gate evidence): the finest mip
          // being tried this view, the floor's top-level, its coarse-pin depth
          // + page count, and the packed-pyramid indirection dimensions (all
          // for the DISPLAYED pack).
          mip: {
            requested: sampleState?.material?.uniforms.uRequestedMip.value ?? null,
            // Smooth mip blending (2026-07-16): the fractional companion to
            // `requested` — its integer part MUST equal `requested`; its
            // fractional part is the blend weight toward `requested+1`. If
            // these ever disagree, the blend uniform desynced from the walk's
            // starting mip — flag it.
            requestedFraction: sampleState?.material?.uniforms.uRequestedMipFrac.value ?? null,
            max: sampleState?.material?.uniforms.uMaxMip.value ?? null,
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
          ...sampleDiagnostics(sampleState?.packs.get(displayLayerName) ?? albedo),
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

    // MSA is rendering again — a previous fallback notice must not outlive it.
    clearFoundryFallback();
    console.log(
      '[vt-pan-viewer] started — filling the scene area (PIXI occluded). Drag to pan, wheel to zoom; ' +
        'Arrow keys/WASD pan, +/- zoom, 0-2/Tab floor-switch.'
    );
    return { ok: true, ..._active.getDiagnostics() };
  } catch (err) {
    diag0.ok = false;
    diag0.fatalError = `${err?.message || err}\n${err?.stack || ''}`;
    console.error('[vt-pan-viewer] fatal error:', err);
    // THE SAFETY SLIDE (Keyhole.md §4.3): hand rendering back to Foundry so the
    // player keeps a working session, and say so unmissably. Reliability outranks
    // the visuals — an MSA that cannot draw must never be the reason a session is
    // unusable. Removing the canvas is the load-bearing part: left in place, it is
    // an opaque black rectangle sitting over a perfectly healthy Foundry canvas.
    engageFoundryFallback({
      reason: 'Its renderer threw while starting up.',
      detail: diag0.fatalError,
      canvas,
    });
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

  const maxFrames = opts.maxFrames ?? 480;
  const settleFrames = opts.settleFrames ?? 30;
  // A leg that hasn't arrived by now is stuck (or the ease was retuned) — flip
  // anyway rather than spend the whole budget on one leg.
  const maxFramesPerLeg = opts.maxFramesPerLeg ?? 150;

  // BLANK SLATE — a genuine restart (fresh atlas + fresh page cache), not
  // merely clearing residency state. startVtPanViewer's own disposeActive()
  // tears down the OLD instance; `_active` after this line is the NEW one.
  await startVtPanViewer(startupParams);
  if (!_active) return { ok: false, error: 'restart failed — see console for the fatal error' };

  // THE TOP FLOOR by default (author, 2026-07-16). The highest floor is the one
  // most likely to composite every floor beneath it through its own
  // `visibility.levels` — the castle-courtyard case — so it carries the most
  // simultaneous textures and is the honest worst case. Overridable.
  const floorCount = startupParams.floorCount ?? 1;
  const floorIndex = opts.floorIndex ?? Math.max(0, floorCount - 1);
  await _active.setFloorIndex(floorIndex);

  _active.resetHitchTracking();
  _active.forceZoomTarget('out'); // start fully zoomed out, per the author's own request
  for (let i = 0; i < 40 && _active; i++) await nextAnimationFrame(); // let the starting zoom ARRIVE before measuring

  const beforeDiag = _active.getDiagnostics();

  // LET THE ZOOM ACTUALLY TRAVEL — flip direction only once it has ARRIVED.
  //
  // THE BUG THIS FIXES (found from the author's own 2026-07-16 report, which came
  // back suspiciously perfect: hitchCount 0, frameGapMaxMs 16.6, and — the tell —
  // `pinnedView: 0` both before AND after, meaning not one view page was ever
  // pinned): the loop used to flip the zoom TARGET every single frame, described
  // in its own comment as "the most aggressive thrash". It is the opposite. Zoom
  // is EASED (~120ms half-life), so one frame closes only ~9% of the gap; flipping
  // the target every frame moves it 9% in, then 9% out, forever. The zoom never
  // went anywhere. It sat at the fully-zoomed-out extreme — where every page is
  // coarse-pinned, hence pinnedView: 0 — so no mip ever changed, no page set ever
  // changed, and the test could not possibly have exercised a residency transition,
  // which is the only thing it exists to stress.
  //
  // Flipping on ARRIVAL instead makes each leg a real full-range sweep across every
  // mip level, which is what actually churns the page set.
  let direction = 'in';
  _active.forceZoomTarget(direction);
  let framesRun = 0;
  let framesThisLeg = 0;
  let legsCompleted = 0;
  let minHalfSpanSeen = Infinity;
  let maxHalfSpanSeen = -Infinity;

  for (let i = 0; i < maxFrames; i++) {
    if (!_active) break; // stopped mid-run (e.g. "Stop/Clear" clicked) — bail cleanly, don't throw
    await nextAnimationFrame();
    framesRun++;
    framesThisLeg++;

    const z = _active.getZoomState(); // cheap on purpose — see getZoomState's doc
    if (z.halfSpanPx < minHalfSpanSeen) minHalfSpanSeen = z.halfSpanPx;
    if (z.halfSpanPx > maxHalfSpanSeen) maxHalfSpanSeen = z.halfSpanPx;

    // "Arrived" within 2% — the ease is asymptotic, so waiting for exact equality
    // would spend most of the budget crawling the last fraction of a pixel.
    const tolerance = Math.max(1, z.targetHalfSpanPx * 0.02);
    if (Math.abs(z.halfSpanPx - z.targetHalfSpanPx) <= tolerance || framesThisLeg >= maxFramesPerLeg) {
      direction = direction === 'in' ? 'out' : 'in';
      _active.forceZoomTarget(direction);
      legsCompleted++;
      framesThisLeg = 0;
    }
  }

  for (let i = 0; i < settleFrames && _active; i++) await nextAnimationFrame(); // let residency catch up before the final read

  if (!_active) return { ok: false, error: 'viewer was stopped mid-run', framesRun };

  const afterDiag = _active.getDiagnostics();
  return {
    floorThrashed: floorIndex,
    floorCount,
    framesRun,
    // THE PROOF THE TEST DID ANYTHING. legsCompleted 0, or a halfSpan range that
    // barely moves, means the zoom never swept and the run is worthless — exactly
    // the failure that made the previous version look like a clean pass.
    legsCompleted,
    halfSpanTraversed: {
      min: Math.round(minHalfSpanSeen),
      max: Math.round(maxHalfSpanSeen),
      ratio: minHalfSpanSeen > 0 ? Math.round((maxHalfSpanSeen / minHalfSpanSeen) * 10) / 10 : null,
    },
    settleFramesRun: settleFrames,
    beforeThrash: { decodeStats: beforeDiag.decodeStats, cacheStats: beforeDiag.cacheStats },
    afterThrash: { decodeStats: afterDiag.decodeStats, cacheStats: afterDiag.cacheStats },
    hitchStats: afterDiag.hitchStats,
    interpretation:
      'READ legsCompleted AND halfSpanTraversed FIRST — they say whether this run tested anything at all. ' +
      'legsCompleted 0, or a halfSpanTraversed.ratio near 1, means the zoom never swept the range and every other ' +
      'number below is meaningless (that exact false pass is why this loop was rewritten: it used to flip the ' +
      'eased zoom target every frame, which cancels itself out and parks the view at one extreme — the tell was ' +
      'pinnedView: 0). A real run shows a large ratio and several legs. THEN: afterThrash.cacheStats.misses is the ' +
      'headline — a residency transition that cannot fit its pages misses, and misses mean visible blur. ' +
      'hitchStats.hitchCount > 0 with real gapMs values in recentHitches is DIRECT evidence of a main-thread ' +
      "freeze (renderMsAvgLast120 cannot see this). Each hitch entry's decodeStats/cacheStats is a snapshot from " +
      'THAT EXACT moment — compare sourcesDecoded/idbSlices across consecutive hitches to see whether a fresh ' +
      'decode was in flight when the freeze happened.',
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
