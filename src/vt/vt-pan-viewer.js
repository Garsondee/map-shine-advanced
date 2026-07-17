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
  pageWorldRect,
  computePagePlacement,
} from './decode-pool.js';
import { createLogger } from '../core/log.js';

/** Log door for the onPageDecoded ingest seam's containment guard — the one
 * place this file reports a CONSUMER's failure rather than its own. */
const ingestLog = createLogger('vt-ingest');
import { createVtSampler } from './vt-sample.tsl.js';
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
import {
  planResidency,
  coarsePinSet,
  coarseTopMipsForCap,
  diffResidency,
  computeCoarsePinBudget,
} from './residency.js';
import { ThreeAllocator } from '../graph/index.js';
import { PROBE_CORNERS, classifyPixel, diagnoseOrientation } from '../diag/orientation-probe.js';
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
import { computeQuadCorners, computeQuadBounds, computeItemPlacement, tokenFootprint } from '../foundry/index.js';
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

/**
 * THE BISECT (2026-07-16). Three guesses into a black screen, stop guessing.
 *
 * My sampler CANNOT return alpha 0: every path yields alpha 1 — a real texel, the
 * magenta tripwire, or the out-of-world guard's opaque black. Yet the readback says
 * alpha 0 at centre. So exactly one of these is true, and they need opposite fixes:
 *
 *   A. the fragment shader NEVER RUNS (geometry / camera / material never draws)
 *      and we are reading the render target's transparent clear, or
 *   B. it runs and something AFTER the sampler zeroes the alpha.
 *
 * A hardcoded constant separates them in one click: if solid red appears, the
 * geometry+camera+material pipeline is fine and the bug is inside my node graph
 * (case B). If it stays black, nothing is drawing and the graph is innocent
 * (case A) — and I have been debugging the wrong file entirely.
 */

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
  // buf:scene.color — a screen-sized RGBA16F target. Leaking one per
  // Stop/Restart cycle is exactly the VRAM bleed this project exists to end,
  // and the debug panel's Stop/Start buttons make that cycle one click.
  // `allocator.dispose()` reports rather than swallows (see its own note).
  try {
    _active.disposeSceneColor?.();
  } catch (err) {
    console.error('[vt-pan-viewer] scene.color dispose failed — VRAM may be leaked:', err);
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
 * @param {(p:{done:number, total:number, detail:string|null}) => void} [options.onLoadProgress] -
 *   called once per item during the INITIAL load only (never per frame), so a
 *   loading screen can show honest counts. The item TOTAL is known immediately
 *   from buildItems; page totals are not known until each item's header is read,
 *   which is why progress is reported per item rather than per page.
 * @param {() => {occluders:Array<object>, visionActive:boolean}} [options.getOcclusionInputs] -
 *   the occluder set for the occlusion mask. Currently unused: the mask PRODUCER
 *   isn't built (see `diag/render-fallback.js`'s sibling note and
 *   `scene/occlusion.js`) — the shader path is real, but its mask is an inert
 *   placeholder, so every item renders unoccluded.
 * @param {(info:{ownerId:string, layerName:string, table:object, page:{mip:number,px:number,py:number},
 *   contentWindow:{dx:number,dy:number,dw:number,dh:number}, bitmap:ImageBitmap}) => void} [options.onPageDecoded] -
 *   THE INGEST SEAM (scene/mask-authority.js's input): called SYNCHRONOUSLY for
 *   each decoded COARSEST-mip page (`page.mip === table.maxMip` — one page, the
 *   whole item) right after decode, before upload. The bitmap is closed after
 *   the upload loop — do not retain it; read pixels during the call. boot.js
 *   wires this to the mask authority so derived masks (skyReach/coverAbove)
 *   distill from the pager's own traffic: no second fetch, no second decode, no
 *   GPU readback, no cache pressure. Injected exactly like extraLayersForItem —
 *   the viewer stays authority-ignorant. A throwing callback is contained and
 *   loudly logged; it can never break streaming.
 * @returns {Promise<object>} initial diagnostics (see getDiagnostics() for the shape).
 */
export async function startVtPanViewer({
  THREE,
  followFoundryCamera = false,
  buildItems,
  dimensions,
  floorCount,
  initialFloorIndex = 0,
  extraLayersForItem,
  getOcclusionInputs,
  onLoadProgress,
  onPageDecoded,
}) {
  extraLayersForItem ??= () => [];
  getOcclusionInputs ??= () => ({ occluders: [], visionActive: false });
  onPageDecoded ??= () => {};
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
    onPageDecoded,
  };
  // World space IS Foundry canvas space (foundry/scene-geometry.js) — the padded
  // rect, +Y down. RECTANGULAR: `Scene#padding` defaults to 0.25 and the default
  // scene is 4000x3000, so a square world is the exception, not the rule.
  const world = { width: dimensions.width, height: dimensions.height };
  disposeActive();

  const diag0 = { errors: [] };
  // Hoisted so the catch can TEAR THE CANVAS DOWN. It is appended before any
  // risky work and is opaque (background:#000), so a failure that leaves it in
  // place puts a black rectangle over a perfectly healthy Foundry canvas — which
  // is what used to block the safety slide (diag/render-fallback.js).
  let canvas = null;
  try {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default

    /**
     * THE DANGLING-INDIRECTION FIX (author-reported 2026-07-17, under a
     * zoom/floor thrash test: "tiles of textures at the wrong scale and in the
     * wrong place appearing across the scene"). Full mechanism in
     * page-cache.js's `onEvict` header — the short version: an evicted slot's
     * identity changes, and any indirection texel still pointing at it now
     * resolves to a DIFFERENT page's pixels (wrong mip = wrong scale, wrong
     * coords = wrong place, or another pack's texture entirely). It renders as
     * confident garbage, never as blur.
     *
     * `pageOwners` is what makes an evicted KEY resolvable back to the exact
     * texel that references it. Bounded by construction: an entry is added only
     * when a texel is actually written (writeIndirection, which itself only
     * runs for a verifiably-resident page) and removed the instant that page is
     * evicted — so it can never hold more than the cache's own resident set.
     * @type {Map<string, {pack: object, page: {mip:number, px:number, py:number}}>}
     */
    const pageOwners = new Map();

    /**
     * Zero the one indirection texel that points at `key`, if any still does.
     *
     * SAFE EVEN FOR A STALE ENTRY, and this is the load-bearing reason it can
     * be this simple: within one pack, texel address and page key are a
     * BIJECTION — `pageKey(mip,px,py)` encodes exactly the `(mip, px, py)` this
     * texel's address is derived from, so no key other than `key` can ever
     * write this texel. A `pageOwners` entry left behind by a `buf.fill(0)`
     * rebuild therefore cannot clear someone else's live pointer; the worst it
     * can do is re-clear an already-clear texel, which the alpha guard below
     * skips outright.
     */
    function clearIndirectionForKey(key) {
      const owner = pageOwners.get(key);
      if (!owner) return; // never written to any indirection, or already cleared
      pageOwners.delete(key);
      const { pack, page } = owner;
      const o = pack.indirectionLayout.origins[page.mip];
      const i = ((o.y + page.py) * pack.width + (o.x + page.px)) * 4;
      if (pack.buf[i + 3] === 0) return; // already reads "not resident" — nothing to clear
      // All-zero reads as "not resident" to the sampler, which then walks up to
      // the coarse pin — blur, the §4.1 guarantee, instead of another page's
      // pixels. Alpha included: writeIndirection sets it to 255 to mean
      // resident, so leaving it set would keep the texel "live" while its RG
      // slot bits read 0 — i.e. confidently pointing at slot 0.
      pack.buf[i] = 0;
      pack.buf[i + 1] = 0;
      pack.buf[i + 2] = 0;
      pack.buf[i + 3] = 0;
      pack.indirectionTexture.needsUpdate = true;
    }

    const cache = new PageCache({
      budgetBytes: 512 * 1024 * 1024,
      onEvict: clearIndirectionForKey,
    });

    const mount = resolveMountHost();
    let canvasW = measureHost(mount.host).width;
    let canvasH = measureHost(mount.host).height;
    canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-pan-viewer-canvas';
    canvas.width = canvasW;
    canvas.height = canvasH;
    // THE INTERFACE SEAM (2026-07-17) — on a real scene MSA now sits UNDERNEATH
    // Foundry's PIXI canvas, not on top of it. See foundry/canvas-compositing.js
    // for the full finding; the short version:
    //
    // Foundry's `interface` group holds EVERY interactive layer (tokens, tiles,
    // walls, grid, controls, notes, drawings, templates — CONFIG.Canvas.layers)
    // and draws all the chrome: selection borders, control icons, rulers,
    // target reticles, drag previews. It renders into `canvas#board`. MSA used
    // to mount at z-index 5 with an OPAQUE background, which meant input worked
    // (pointer-events:none let clicks through) while every one of those was
    // invisible behind us. Selection worked; you just could not see it.
    //
    // So: MSA draws the ART underneath, Foundry's PIXI canvas goes transparent
    // and draws only its CHROME on top. They render DISJOINT sets — which is
    // what keeps this from being V2's two-authoritative-renderers blunder
    // (Engine-Postmortem.md §1). There is no shared picture, so there is
    // nothing to synchronise.
    const boardEl = followFoundryCamera ? document.getElementById('board') : null;
    const stackUnderBoard = !!boardEl && boardEl.parentElement === mount.host;
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      // z-index 0 and inserted BEFORE #board in tree order (see below), which
      // is what actually puts us under it. Deliberately NOT z-index:-1 — a
      // negative z-index paints behind the stacking context's background, and
      // our mount host is <body> (canvas#board's parent, game.hbs:31). Equal
      // z-index + tree order is well-defined CSS; negative z-index depends on
      // who forms the stacking context.
      //
      // The torture fixture (followFoundryCamera:false) has NO Foundry scene
      // and owns its own camera and input, so it stays on top at 5: above board
      // (0) + hud (1), below Foundry UI (60) and the debug panel (90).
      zIndex: stackUnderBoard ? '0' : '5',
      display: 'block',
      // Stays OPAQUE, and now that is correct rather than destructive: we are
      // the bottom of the stack, so this is the "nothing here" backdrop.
      background: '#000',
      // FOUNDRY OWNS ALL INPUT when following its camera (author decision
      // 2026-07-16). This is now BELT AND BRACES rather than the load-bearing
      // fix — a canvas underneath #board cannot swallow a click anyway. It is
      // kept precisely because it WAS load-bearing: with 'auto' on top, this
      // canvas swallowed every click, drag and drop aimed at Foundry's board.
      // Dropping tokens silently created no documents at all (diagnoseTokens:
      // tokenDocsFound: 1 on a scene the author had dropped many tokens onto)
      // and marquee select did nothing. It looked for hours like a rendering
      // bug and was an input bug. If the stacking ever regresses, this keeps
      // that catastrophe from coming back with it.
      pointerEvents: followFoundryCamera ? 'none' : 'auto',
      // NOT 'grab'. The cursor was permanently a hand, which promises a drag
      // that is not always what a click does (author-reported). It becomes
      // 'grabbing' only for the duration of an actual pan, then reverts.
      cursor: 'default',
    });
    // Tree order IS the stacking order at equal z-index: earlier paints lower.
    if (stackUnderBoard) mount.host.insertBefore(canvas, boardEl);
    else mount.host.appendChild(canvas);

    // WebGPURenderer — the NODE renderer, which picks WebGPU or WebGL2 itself
    // (docs/planning/Shaders.md). NOT "the WebGPU renderer": its WebGLBackend is
    // the WebGL2 rung of §4.3's ladder, from this same TSL source.
    //
    // preserveDrawingBuffer is GONE — it is not a WebGPU concept (0 hits in the
    // node build). It existed so a button-click gl.readPixels() could read the
    // last frame; that diagnostic now renders into an explicit RenderTarget
    // instead (see sampleDiagnostics), which is the readback path both backends
    // actually implement.
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init(); // REQUIRED before any use — the backend is chosen here
    renderer.setPixelRatio(1);
    renderer.setSize(canvasW, canvasH, false);

    // ========================================================================
    // buf:scene.color — THE FIRST REAL RENDER TARGET (2026-07-17)
    // ========================================================================
    //
    // Until now `renderFrame` drew straight to the canvas backbuffer, so there
    // was NOWHERE for an effect to draw: `graph/passes.js` declares nine effect
    // seams that all `modifies: ['buf:scene.color']`, and the buffer they all
    // name did not exist. This is that buffer. It is the unblocking step for
    // every effect (Keyhole.md §4.2's RT inventory starts here).
    //
    // It is ALSO the first real caller of `ThreeAllocator` — Keyhole's own law
    // (§0, §4.6: "nothing is ever allocated at world resolution, ever"), which
    // until this line was a unit-tested function nothing called. It is not
    // optional: `gpu/allocator-only` fails the build on `new *RenderTarget(`
    // anywhere but the allocator, so this is the only door and it is now open.
    //
    // ⚠️ COLOUR SPACE — the one thing most likely to make this look wrong, and
    // this project has already lost a session to exactly this class of bug (the
    // washed-out map). The chain, stated so it can be checked rather than hoped:
    //   scene → RT   : RT texture is NoColorSpace, so three applies NO transfer
    //                  function. Linear values land in the buffer untouched.
    //   RT → canvas  : the present material samples it (no decode — the node
    //                  system only decodes an SRGBColorSpace texture), and the
    //                  renderer applies the sRGB OETF once, at the canvas,
    //                  exactly as it does today for the direct draw.
    // Net: ONE OETF, same as before. Set NoColorSpace EXPLICITLY rather than
    // relying on a default — an implied colour space is how these bugs are born
    // (Params.md §3.6 finding #1, same disease).
    //
    // RGBA16F per §4.2 ("scene.color (RGBA16F)"): effects need HDR headroom
    // (bloom has nothing to bloom from in 8-bit). Costs 2 bytes/channel, and
    // §4.2's whole inventory is budgeted on that.
    const allocator = new ThreeAllocator({ THREE });
    const describeSceneColor = () => ({
      resolvedW: canvasW,
      resolvedH: canvasH,
      // O(screen), not O(world) — sized from the drawing buffer, so it scales
      // with the player's monitor and never with the map. See the allocator's
      // own note on why this is NOT `allowWorldScale`.
      screenSized: true,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      filter: 'linear',
      depth: false, // the draw list is already depth-sorted by the layering law
    });
    let sceneColor = allocator.create('scene.color', describeSceneColor());

    // ------------------------------------------------------------------
    // present.composite — buf:scene.color → the canvas.
    // ------------------------------------------------------------------
    //
    // Written fresh in TSL, NOT harvested from graph/fullscreen-present.js:
    // that module is GLSL (ShaderMaterial + gl_Position), was the last GLSL in
    // src/, and cannot run under WebGPURenderer at all. Two things from it are
    // worth carrying forward, and are recorded here because the file itself is
    // now deleted:
    //
    // 1. IT HAND-APPLIED THE sRGB OETF, and we must NOT. It did that because a
    //    raw ShaderMaterial bypasses three's colour management. A NodeMaterial
    //    does not — the node system applies output colour space at the canvas.
    //    Hand-applying it here would DOUBLE the gamma. That is the trap.
    //
    // 2. ⬜ ITS HDR TONE-MAP IS A REAL DESIGN DECISION, DEFERRED, NOT DROPPED.
    //    `passes.js` gives present.composite "tonemap + present" as its job.
    //    There is no tone map here yet — correct, because nothing is HDR-lit
    //    yet (light.accumulate is still a seam; the scene is albedo only, all
    //    ≤1.0, so any curve would be a no-op that only costs ALU). When
    //    lighting lands, the decision to restore is V3's, and it was
    //    deliberate: a HUE-PRESERVING HIGHLIGHT ROLLOFF, **not global ACES**.
    //    A global ACES curve desaturates the whole image and bleaches
    //    saturated light cores toward white. Instead: everything below a knee
    //    (default 0.9) stays pixel-identical to the linear input — so
    //    Foundry-matched midtones and light bodies are untouched — and only
    //    the over-knee "filament" compresses toward 1.0, scaling RGB uniformly
    //    so a hot core keeps its colour. Rebuild that in TSL at that point;
    //    do not reach for a stock tone-mapping node.
    // 3. ⚠️ Y-FLIP — USE THREE'S OWN QuadMesh, NEVER A HAND-ROLLED ONE.
    //    The first cut of this pass used `new THREE.Mesh(new THREE.PlaneGeometry(2,2))`
    //    and the whole map came out upside down (author-caught, 2026-07-17).
    //    Read from the vendored source rather than guessed, so it stays true:
    //
    //      three.webgpu.js:56350  NodeBuilder.isFlipY() { return false }  ← WebGPU
    //      three.webgpu.js:64344  NodeBuilder.isFlipY() { return true  }  ← WebGL
    //
    //    Three inserts a compensating flip into `texture()` ONLY when isFlipY()
    //    is true, normalising BOTH backends to one rule: **v=0 is the TOP of a
    //    render-target texture.** Its own fullscreen geometry agrees —
    //    `QuadGeometry` (three.webgpu.js:49443) is a fullscreen TRIANGLE whose
    //    uvs `[0,-1, 0,1, 2,1]` put **v=0 at the screen TOP**:
    //
    //      PlaneGeometry:  v=0 at the screen BOTTOM   ← what I used. Inverted.
    //      QuadGeometry:   v=0 at the screen TOP      ← matches the RT rule.
    //
    //    So a PlaneGeometry fullscreen quad samples the image's top at the
    //    screen's bottom. Exactly upside down, and BACKEND-DEPENDENT — the one
    //    thing `keyhole-webgpu-tsl-decision` says must never happen ("ONE source
    //    per effect, never a WebGL2 twin").
    //
    //    THE FIX IS NOT A COMPENSATING FLIP. Two flips that cancel is how you
    //    end up with four (feedback_y_flip_recurring_risk). `QuadMesh` bundles
    //    three's geometry AND its camera, so the vendor owns the convention on
    //    both backends — and they must get it right, because every three user
    //    would notice if they didn't. `zones/no-handrolled-fullscreen-quad` in
    //    tools/verify-structure.mjs now fails the build on the mistake I made.
    const presentMaterial = new THREE.NodeMaterial();
    presentMaterial.depthTest = false;
    presentMaterial.depthWrite = false;
    // No uv argument: `texture()` defaults to the mesh's own uv attribute,
    // which on a QuadMesh is QuadGeometry's — the one three guarantees against
    // its own render-target convention. Passing `uv()` explicitly would be the
    // same thing; passing anything else re-opens the bug.
    const presentTexNode = THREE.TSL.texture(sceneColor.texture);
    presentMaterial.fragmentNode = presentTexNode;
    const presentQuad = new THREE.QuadMesh(presentMaterial);

    /** Re-point the present material at a freshly-allocated target (resize). */
    function rebindPresent() {
      presentTexNode.value = sceneColor.texture;
      presentMaterial.needsUpdate = true;
    }

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
    /**
     * Items whose source is permanently broken (404, undecodable) — never
     * re-attempted. See the skip in updateResidency's phase 1 for the full
     * finding and the deliberate trade-off. Kept beside `itemLoadErrors`
     * because they are two halves of one thing: that array is what the author
     * SEES, this set is what the loader DOES, and letting them drift apart is
     * how "the report says one broken item" coexisted with "we re-fetch it
     * seventy-seven times".
     * @type {Set<string>}
     */
    const failedItemIds = new Set();

    /**
     * THE SHARED COARSE-PIN BUDGET (item 1b, 2026-07-17) — see
     * `residency.js#computeCoarsePinBudget`'s header for the full finding and
     * why an equal per-pack share, not a priority tier, is the fix. Read by
     * `ensureItemLoaded`/`buildPack` every time a NEW pack is created (an
     * already-loaded pack's coarse pin, once granted, is never re-evaluated —
     * this only governs pack CREATION, matching how the budget itself only
     * needs to be a reasonable bound, not perfectly live).
     *
     * Initialized to a conservative non-zero default (matches the mask cap
     * this replaces) rather than 0/uncapped — if `refreshCoarsePinBudget()`
     * were ever somehow skipped, falling back to UNCAPPED would silently
     * reopen exactly the bug this exists to close. There is no code path that
     * skips it (see its two call sites below), but the safe direction on an
     * uncomputed value is always the bounded one, not the dangerous one.
     */
    let currentCoarseBudget = { totalBudgetPages: 0, perPackMaxPages: 24, packCount: 1 };

    /**
     * Recompute the shared budget from the WHOLE scene's current pack count —
     * every floor, not just the viewed one (a background-prewarmed floor's
     * packs compete for the SAME budget). Deduplicated by item id: a token
     * visible from two floors is ONE pack (loaded once, `itemStates` keyed by
     * id), not two — counting it twice would UNDER-allocate everyone else for
     * no reason.
     *
     * Recomputed fresh on every call rather than cached — a cached pack count
     * is exactly the staleness class that just cost a session on token
     * placement (a snapshot outliving the thing it snapshotted). This is
     * comparatively cheap (pure document reads via `buildItems`, no I/O, no
     * GPU) and only runs on hook-driven passes, never per frame.
     */
    function refreshCoarsePinBudget() {
      const seen = new Set();
      for (let f = 0; f < floorCount; f++) {
        for (const item of buildItems(f)) seen.add(item.id);
      }
      // cache.capacityPages, not cache.stats() — a plain constant field, no
      // reason to pay for stats()'s full diagnostic scan just to read it.
      currentCoarseBudget = computeCoarsePinBudget(cache.capacityPages, seen.size);
      // THE RESERVE (item 1b, reservation half, 2026-07-17) — kept in lockstep
      // with the SAME totalBudgetPages the per-pack cap is computed from, so
      // "how big is the coarse budget" has exactly one source of truth. See
      // page-cache.js's header for why capping the ASK alone (the first cut)
      // wasn't enough: 'view' and 'coarse' competed for the same slots on
      // equal footing, so a busy viewport could pin the WHOLE cache before a
      // background-prewarmed floor's coarse request ever got a turn — and
      // that request is made exactly once, at pack creation, never retried.
      cache.coarseReservePages = currentCoarseBudget.totalBudgetPages;
    }
    let loopActive = false; // tracks whether the render loop is running (batch uploads pause/restore it)
    let onPageDecodedFailures = 0; // ingest-seam containment counter (first 3 logged, all counted)

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

      // NO PER-MIP UNIFORM ARRAYS ANY MORE. The TSL sampler derives every mip's
      // page grid and pyramid origin from `pages0` alone (two integers) — see
      // vt-sample.tsl.js's header for why that is exact, and vt-core.test.mjs for
      // the proof against this very PageTable. `indirectionLayout` still sizes the
      // texture above; it just no longer has to be marshalled into the shader.

      // COARSE PINS (§4.1): the top few mip levels of THIS pack, pinned
      // permanently so the whole floor always renders (soft) and floor switches
      // are instant. Decode + upload + pin them once, now.
      const topMips = coarseTopMipsForCap(table, coarsePinMaxPages ? { maxPages: coarsePinMaxPages } : {});
      const coarsePages = coarsePinSet(table, { topMips });
      const coarseKeySet = new Set(coarsePages.map((p) => p.key));

      const pack = {
        name,
        ownerId, // the owning item — carried so the onPageDecoded ingest seam can attribute pages
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

    // Mask packs get a lighter permanent soft-floor than the displayed albedo —
    // a mask is an input, not the hero image. HALF of the item's own dynamic
    // share (`currentCoarseBudget.perPackMaxPages`, item 1b), capped at 24 —
    // the ORIGINAL fixed value, kept as an upper ceiling because it was
    // empirically fine for masks; the new part is that it can now go LOWER
    // than 24 too, when the scene's total pack count demands it, instead of
    // being a flat number blind to how many packs exist.
    function maskCoarsePinMaxPages() {
      return Math.max(1, Math.min(24, Math.floor(currentCoarseBudget.perPackMaxPages / 2)));
    }

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
      // The item's fair share of the SCENE-WIDE coarse budget (item 1b) — was
      // uncapped (up to ~96 pages) before this, with nothing coordinating the
      // total across however many packs the scene actually has.
      const albedoPack = await buildPack(
        item.id,
        'albedo',
        { url: item.src },
        { coarsePinMaxPages: currentCoarseBudget.perPackMaxPages }
      );
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
          packs.set(name, await buildPack(item.id, name, source, { coarsePinMaxPages: maskCoarsePinMaxPages() }));
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

    /**
     * TOKEN PLACEMENT: TRACKED EVERY FRAME, NOT ONLY ON A DOCUMENT HOOK
     * (2026-07-17 — "the token stops just short of the final position").
     *
     * The root cause was two-layered, and neither layer alone would have been
     * enough to fix live: (1) `computeItemPlacement` was trusting a footprint
     * CACHED at collection time instead of re-deriving it (fixed above, in
     * `foundry/scene-layers.js`) — but (2) even a perfectly fresh derivation
     * only runs when something calls `refreshItemPlacement`, and until now that
     * was EXCLUSIVELY a document-hook-triggered `updateResidency()` pass.
     *
     * The live evidence for why hooks alone are not enough: `documentSync
     * .passLog` showed FOUR CONSECUTIVE real passes reading the exact same
     * (stale) token position, no new pass triggered after, while a fresh read
     * of the SAME live document — moments later — had already moved on by
     * 670px. Something in Foundry keeps `TokenDocument#x/y` settling toward its
     * final value without firing another `updateToken`/`moveToken` we can hook
     * — real-time-paced waypoint commits, client-side prediction, or something
     * this environment cannot single-step to confirm. Rather than keep
     * chasing which exact hook is missing (this is the third round on this
     * exact bug), this makes the RENDERER converge regardless of hook
     * completeness — the same way Foundry's OWN Token placeable stays in sync:
     * by sampling the live document continuously, every tick, not by reacting
     * to discrete write events that may not describe a continuously-settling
     * field.
     *
     * Deliberately NOT routed through `updateResidency()` — that pass does
     * real GPU/streaming work (this scene's cache is already oversubscribed,
     * see item 1b) and must stay event-driven, not run every frame. This
     * touches ONLY pure JS geometry: `refreshItemPlacement` compares a
     * placementKey and returns early when nothing moved, so the steady-state
     * cost is one string build and a `!==` per token, every frame. Visibility
     * and streaming are untouched here — still owned by `updateResidency()`.
     */
    function syncTokenPlacements() {
      for (const state of itemStates.values()) {
        if (state.item?._placement?.kind !== 'token') continue;
        refreshItemPlacement(state, state.item);
      }
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

      // ONE sampler graph per item — each drawable samples its own page table with
      // its own image size, exactly as each had its own ShaderMaterial uniforms.
      // The atlas is the one shared thing.
      const vt = createVtSampler(THREE.TSL, {
        atlasTexture: atlas.texture,
        // THE PAGE TABLE'S REAL TEXTURE, not a placeholder — and this line was the
        // black screen (2026-07-16). It used to pass `atlas.texture` "to be rebound
        // later", which is wrong in a way GLSL uniforms are not: a TextureNode bakes
        // its TYPE into the graph at build time. Seeded with the atlas (a
        // DataArrayTexture) it compiles array-texture sampling; swapping `.value` to
        // a 2D DataTexture afterwards cannot change the emitted shader, so the
        // binding is invalid and WebGPU silently SKIPS THE DRAW. Hence: black,
        // alpha 0, no error, a healthy cache — and a solid-colour test that drew
        // perfectly, because it bound no textures at all.
        //
        // A node graph is not a uniform block. What a uniform lets you swap freely,
        // a node bakes.
        initialPageTable: state.albedoPack.indirectionTexture,
        pagesPerAxis: layout.pagesPerAxis,
        pagesPerLayer: layout.pagesPerLayer,
        pageSizePx: layout.pageSizePx,
        borderPx: 4,
        atlasSizePx: layout.atlasSizePx,
      });
      const { Fn, uniform, vec3, float, vec2, uv, positionGeometry } = THREE.TSL;

      // Per-item appearance + occlusion, as live uniform handles.
      const uTint = uniform(vec3(1, 1, 1));
      const uAlpha = uniform(float(1));
      const uOcclusionElevation = uniform(float(0));
      const uOcclusionWeights = uniform(THREE.TSL.vec4(0, 0, 0, 0));
      const uUnoccludedAlpha = uniform(float(1));
      const uOccludedAlpha = uniform(float(0));

      const material = new THREE.NodeMaterial();
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide; // see this function's doc — negative scaleX flips winding

      // THE OCCLUSION CHAIN, factored out so a debug stage can feed it a CONSTANT
      // mask instead of the texture. That is the whole experiment: the diagnostics
      // print occlusionWeights [0,0,0,0], occlusionElevation 1, unoccludedAlpha 1,
      // occludedAlpha 0 -- with those numbers this block provably multiplies alpha by
      // exactly 1 and does nothing. Yet removing it un-blacks the screen. So it was
      // never the arithmetic, and the only non-arithmetic thing here is the TEXTURE
      // BINDING itself.
      //
      // @param {any} maskSample - vec4 node: the mask's four elevation indices.
      const occlusionAlphaFactor = (maskSample) => {
        // Foundry's algorithm (occlusion.mjs:16): each channel holds an ELEVATION
        // INDEX (R=Fade G=Radial B=Vision A=Surface), and a channel says "occlude me"
        // where the occluder recorded there sits BELOW my own elevation.
        const occluded = float(1).sub(THREE.TSL.step(uOcclusionElevation, maskSample));
        const amounts = occluded.mul(uOcclusionWeights);
        const occ = amounts.x.max(amounts.y).max(amounts.z).max(amounts.w);
        // mix(a, b, t) -- the FUNCTION form. See the warning in vt-sample.tsl.js: the
        // .mix() METHOD takes its receiver as the INTERPOLANT, and this exact line,
        // written as uUnoccludedAlpha.mix(uOccludedAlpha, occ), compiled to
        // mix(0, occ, 1) == 0 and blacked out the entire map for a whole session.
        return { occ, factor: THREE.TSL.mix(uUnoccludedAlpha, uOccludedAlpha, occ) };
      };
      const maskUV = () => positionGeometry.xy; // placeholder space; real screen UV lands with the producer
      const sampleMask = () => THREE.TSL.texture(occlusionMask.texture, maskUV());

      const realChain = (maskSample) =>
        Fn(() => {
          const c = vt.sample(uv()).toVar();
          c.rgb.mulAssign(uTint);
          c.a.mulAssign(uAlpha);
          c.a.mulAssign(occlusionAlphaFactor(maskSample()).factor);
          return c;
        })();

      material.colorNode = realChain(sampleMask);

      // Stash the live uniform handles on the item state: bindMeshToPack writes
      // through these every update, and getDiagnostics reads them back. Losing these
      // two lines is what threw "Cannot read properties of undefined (reading
      // 'uniforms')" and tripped the fallback (2026-07-16) -- a factoring edit ate
      // them along with the code they sat next to.
      state.vt = vt;
      state.appearance = { uTint, uAlpha, uOcclusionElevation, uOcclusionWeights, uUnoccludedAlpha, uOccludedAlpha };

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
    /** Wall-clock cost of the pre-first-draw shader precompile; null if it failed. */
    let shaderCompileMs = null;
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
    /** The cheap, synchronous half: one pack's indirection buffer (plain JS state). */
    function sampleDiagnostics(pack) {
      const out = {};
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
      // Also a small, per-frame CPU-only cost — kept OUT of the `t0` GPU-render
      // timing window below for the same reason updateContinuousInputs is, per
      // the comment above it. See syncTokenPlacements' own header for why this
      // runs every frame rather than only on a document hook.
      syncTokenPlacements();
      const t0 = performance.now();
      // Re-derive the camera from the live view EVERY frame: this is what makes
      // a drag track the cursor at display rate without waiting on streaming,
      // and it is the single place the Y-flip is applied (see updateCamera).
      updateCamera();

      // TWO PASSES, FOR REAL (2026-07-17). `graph/passes.js` has always declared
      // these as separate nodes — `geometry.world` creates buf:scene.color,
      // `present.composite` reads buf:final — and until now BOTH resolved to
      // this one function, honestly recorded as `fusedWith` in pass-impls.js
      // because a single renderer.render() straight to the canvas is not two
      // passes however you label it.
      //
      //   geometry.world    : the whole sorted draw list → buf:scene.color
      //   present.composite : buf:scene.color → the canvas
      //
      // The gap between them is where every effect goes. Nine seams in
      // passes.js declare `modifies: ['buf:scene.color']`; this is the first
      // frame in which that buffer is a real thing they could modify.
      renderer.setRenderTarget(sceneColor);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      presentQuad.render(renderer); // three's own fullscreen path — carries its own camera

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
        // A miss here for pinClass:'view' is ordinary pressure — the coarse
        // fallback covers it, never a crash. A miss for pinClass:'coarse'
        // (item 1b) is DIFFERENT: there is no fallback BELOW the coarse pin
        // itself — it IS the fallback. `cache.coarseReservePages` (page-
        // cache.js) exists specifically to make this branch structurally
        // unreachable for 'coarse'; `cacheStats.coarseReserveMisses` in
        // diagnostics is the tripwire if that guarantee is ever wrong.
        if (!resident) continue;
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

        // THE INGEST SEAM (see startVtPanViewer's onPageDecoded doc): offer
        // each COARSEST-mip page — one page, the whole item — to the injected
        // consumer while its bitmap is still alive (Pass 3 closes them).
        // Fine-mip pages never reach the callback, so the pan/zoom hot path
        // pays one integer compare per decoded page and nothing else. Own
        // guard, deliberately NOT the enclosing catch: a consumer bug must
        // read as "ingest failed", never as "decode failed" (which would
        // poison lastError and look like a streaming defect).
        for (const a of acquired) {
          if (a.page.mip !== pack.table.maxMip) continue;
          try {
            const rect = pageWorldRect(pack.table, a.page.mip, a.page.px, a.page.py, {});
            onPageDecoded({
              ownerId: pack.ownerId,
              layerName: pack.name,
              table: pack.table,
              page: a.page,
              // bitmap.width IS this page's pageSizePx (the acquire calls above
              // use the same default) — deriving it from the bitmap itself
              // means the two can never drift.
              contentWindow: computePagePlacement(rect, rect.unclamped, a.bitmap.width),
              bitmap: a.bitmap,
            });
          } catch (err) {
            onPageDecodedFailures++;
            if (onPageDecodedFailures <= 3) {
              ingestLog.error(
                `onPageDecoded consumer threw for ${pack.ownerId}/${pack.name} (failure ${onPageDecodedFailures}):`,
                err
              );
            }
          }
        }
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
      // This texel now points at `page.key`'s slot. Record it so the cache's
      // onEvict can find and clear THIS texel the instant that slot is
      // reassigned — see clearIndirectionForKey. Registering HERE (rather than
      // at request time) is what keeps the map honest: it maps exactly the
      // texels that actually exist, never the ones we merely asked for.
      pageOwners.set(page.key, { pack, page });
    }

    // Which layer-pack is DISPLAYED (albedo by default). Every pack STREAMS
    // regardless — this only changes which one is bound to the shader, so a mask
    // can be eyeballed against the fixture's known patterns for correctness.
    let displayLayerName = 'albedo';

    /**
     * ISOLATE ONE DRAW ITEM — `''` shows the whole draw list (normal).
     *
     * WHY THIS EXISTS (2026-07-17): the ghost artefact has now had FIVE
     * diagnoses from me. Every one found a real bug — an impossible one I had
     * recorded in the plan doc, a genuine release/await race, a scene-wide
     * coarse-pin starvation, a six-caller pin leak, a fallback-vs-non-fallback
     * mip blend — and none of them was the ghost. Each cost the author a
     * round-trip to disprove.
     *
     * The asymmetry is the point: the author can SEE the artefact and I cannot.
     * Reasoning from aggregate counters about a visual bug is what produced
     * five plausible-and-wrong answers. This turns "which of the 11 items is
     * the ghost?" into eleven clicks the author can do in half a minute, and
     * the answer is a FACT rather than my sixth theory.
     *
     * Deliberately gates VISIBILITY only, at the very end of the pass —
     * residency, streaming and placement all run exactly as normal, so
     * isolating cannot itself change what the pager does and mask the bug.
     */
    let isolateItemId = '';

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
      const u = state.vt.uniforms;
      // NO page-table swap. The texture is baked into the node graph at build time
      // (see vt-sample.tsl.js) — a TextureNode is not a uniform handle, which is
      // the mistake that produced the 2026-07-16 black screen. Switching the
      // displayed pack now requires rebuilding the material; setDisplayLayer is a
      // debug-only mask view, so it is a tracked gap rather than a hot path.
      u.worldSizePx.value.set(pack.table.worldWidthPx, pack.table.worldHeightPx);
      // Only the albedo pack is a PICTURE; every other pack is a mask, i.e. data that
      // must reach the shader byte-exact. See the sampler's srgbDecode.
      u.srgbDecode.value = pack.name === 'albedo' ? 1 : 0;
      // THE WHOLE MIP LAYOUT, in two integers. The shader derives every level's
      // grid and origin from these (vt-sample.tsl.js's header explains why that is
      // exact, and vt-core.test.mjs proves it against the real PageTable).
      u.pages0.value.set(pack.table.pagesX(0), pack.table.pagesY(0));
      u.maxMip.value = pack.table.maxMip;
      u.requestedMip.value = pack.lastRequestedMip; // re-read every update (mip changes with zoom)
      u.requestedMipFrac.value = pack.lastRequestedMipFraction;

      const a = state.appearance;
      const item = state.item;
      const tint = item.tint ?? 0xffffff;
      a.uTint.value.set(((tint >> 16) & 0xff) / 255, ((tint >> 8) & 0xff) / 255, (tint & 0xff) / 255);
      a.uAlpha.value = item.alpha ?? 1;

      // OCCLUSION weights (scene/occlusion.js — the ported model, with citations).
      // `occluded` stays false until the mask producer exists to identify which
      // items a token actually stands under; the weights are still computed from
      // real document data, so wiring the producer in is purely additive.
      const modes = item.occlusion?.modes ?? OCCLUSION_MODES.NONE;
      const st = computeOcclusionState({
        occlusionMode: modes,
        occluded: state.occluded,
        visionActive: occlusionMask.visionActive,
        hoverFadeAmount: state.hoverFade.occlusion,
      });
      a.uOcclusionWeights.value.set(st.fade, st.radial, st.vision, st.surface);
      a.uOcclusionElevation.value = mapElevation(occlusionMask.elevationTable, item.key.elevation);
      a.uUnoccludedAlpha.value = 1;
      a.uOccludedAlpha.value = item.occlusion?.alpha ?? 0;
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
    /**
     * Adopt Foundry's camera. Foundry's stage is the ONE source of truth for the
     * view — MSA does not have a camera on a real scene, it reads this one
     * (keyhole-input-model-decision).
     *
     * Read from the v14 source rather than assumed (board.mjs:1703-1715):
     *   this.stage.pivot.set(constrained.x, constrained.y);   // world CENTRE
     *   this.stage.scale.set(constrained.scale, constrained.scale);  // uniform
     *   Hooks.callAll("canvasPan", this, constrained);
     *
     * `scale` is screen-px per world-px, so half the viewport in WORLD px is
     * (viewportPx / 2) / scale. The axis matters and cost a live round-trip:
     * **halfSpanPx is the half-VERTICAL span**, not the horizontal one --
     * viewToWorldRect derives `halfX = halfSpanPx * aspect` from it and says so in
     * its own doc, which I did not read. Computing it from canvasW over-spanned by
     * the aspect ratio (2239/1271 ≈ 1.76x), so MSA rendered ~1.76x more zoomed out
     * than Foundry believed. Everything downstream inherited that: a token dropped
     * at the top-right landed short and toward the centre, because Foundry mapped
     * the click with ITS scale and MSA drew the result with a wider view. Foundry's
     * hit boxes were right the whole time; the picture the author was aiming at was
     * the thing that lied.
     *
     * @returns {boolean} did the view actually change?
     */
    /**
     * The view as of the last residency update — the baseline the sub-pixel
     * threshold below measures against, so a slow drift cannot creep past it
     * one under-threshold step at a time. See syncFoundryCamera.
     * @type {{cx:number, cy:number, halfSpan:number}|null}
     */
    let lastResidencyView = null;

    function syncFoundryCamera() {
      const stage = globalThis.canvas?.stage;
      if (!stage) return false;
      const scale = stage.scale?.x;
      // Guard the degenerate cases explicitly: a zero/NaN scale would make
      // halfSpanPx Infinity/NaN and silently take the whole view with it.
      if (!Number.isFinite(scale) || scale <= 0) return false;
      const cx = stage.pivot?.x;
      const cy = stage.pivot?.y;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;

      const halfSpan = canvasH / 2 / scale; // VERTICAL — see above; canvasW here was the bug

      // THE CAMERA ALWAYS TRACKS EXACTLY. Never debounce this half: a camera
      // that lags is a camera that disagrees, which is the whole reason this
      // reads canvas.stage per frame in the first place.
      view.centerXPx = cx;
      view.centerYPx = cy;
      view.halfSpanPx = halfSpan;

      // RESIDENCY IS A DIFFERENT QUESTION, AND IT USED TO BE ASKED WITH `!==`.
      //
      // Exact float equality against FOUNDRY'S OWN EASED camera: it asymptotes
      // toward its target, so for seconds after the user stops it is still
      // moving by thousandths of a pixel — and every one of those reported
      // `changed`, which scheduled a FULL residency pass (11 packs replanned,
      // released, re-requested). Caught in the author's own report, 2026-07-17,
      // on a view they had stopped touching: panVelocity {0,0}, halfSpanPx
      // IDENTICAL across five consecutive hitches, and yet 236 passes with
      // `misses` climbing 662 -> 1908 and `evictions` 4448 -> 5897 across half
      // a pixel of residual zoom. With the cache at its cap that is ~25
      // evictions per pass, forever, for a view that is not moving.
      //
      // The threshold is ONE SCREEN PIXEL of world distance, which is the
      // honest bound: a camera move too small to change any rendered pixel
      // cannot change which pages are needed, so a pass over it is pure churn.
      // Measured against the view at the LAST RESIDENCY UPDATE, not the last
      // frame — comparing to the last frame would let a slow drift accumulate
      // forever, each step under the bar, and never re-stream at all.
      const worldPerScreenPx = (2 * halfSpan) / Math.max(1, canvasH);
      if (!lastResidencyView) {
        lastResidencyView = { cx, cy, halfSpan };
        return true;
      }
      const changed =
        Math.abs(lastResidencyView.cx - cx) >= worldPerScreenPx ||
        Math.abs(lastResidencyView.cy - cy) >= worldPerScreenPx ||
        Math.abs(lastResidencyView.halfSpan - halfSpan) >= worldPerScreenPx;
      if (changed) lastResidencyView = { cx, cy, halfSpan };
      // NOTE there is deliberately no eased-target assignment here. `view` has no
      // targetHalfSpanPx — the eased target is a CLOSURE variable of that name
      // (see renderFrame), and setting the field on `view` created a property
      // nothing reads while the real target sat untouched at its load-time value.
      // The whole easing path is skipped when following Foundry anyway: Foundry
      // has already eased this pan, and easing an eased value lags the real
      // camera. A camera that lags is a camera that disagrees.
      return changed;
    }

    /**
     * ONE RESIDENCY PASS. **Never call this directly — call
     * `scheduleResidencyUpdate()`.** It is named `unguarded` so a direct call
     * reads as the mistake it is (`zones/one-door`'s logic, at function scope:
     * if the safe path is not the obvious one, the unsafe one gets used).
     *
     * THE PIN LEAK THIS ISOLATION FIXES (found 2026-07-17 in the author's own
     * thrash report, not by reasoning): SIX call sites invoked this directly,
     * bypassing `scheduleResidencyUpdate`'s in-flight guard — `setFloorIndex`,
     * `applyKeyAndUpdate`, `setDisplayLayer`, resize, the initial load. The
     * thrash test does BOTH at once: eased zoom schedules a guarded pass every
     * frame while `setFloorIndex` fires an unguarded one. Two concurrent runs.
     *
     * This function mutates shared per-pack state ACROSS AWAITS, so two runs
     * interleave on `pack.residentViewKeys`:
     *
     *   run A: unpin (keys not in A's candidates) -> await -> residentViewKeys = A's set
     *   run B: unpin (keys not in B's candidates) -> await -> residentViewKeys = B's set
     *
     * Whichever assigns last WINS, and every page the loser pinned is now
     * ORPHANED: still pinned, tracked by nobody, so no future pass can ever
     * unpin it. The view tier fills with pins for pages nothing is looking at.
     *
     * THE DATA THAT PROVED IT, from the author's report — `pinnedView` against
     * `halfSpanPx` in the hitch log:
     *   halfSpan 6705 (fully zoomed OUT) -> pinnedView 1536  <- the exact cap
     *   halfSpan   86 (fully zoomed IN)  -> pinnedView 1097
     * At full zoom-out the coarse pins cover the world and the view tier should
     * be near EMPTY. 1536 is not pressure; it is leakage. Those orphans then
     * jam the cache (`misses: 1062`) so real requests get refused — which is
     * blur at best, and starves everything else at worst.
     */
    async function updateResidencyUnguarded() {
      // Refreshed every pass, not cached — the scene's total pack count
      // changes as documents are created/deleted, and a NEW item created since
      // the last pass must see the CURRENT count when it first requests its
      // coarse pin a few lines below (item 1b). See refreshCoarsePinBudget's
      // own header for why staleness here is the exact bug class this exists
      // to prevent.
      refreshCoarsePinBudget();
      // sortByLayer stamps `renderOrder` on each item — THE law
      // (scene/layer-order.js). Rebuilt every update because the draw list
      // itself changes with the viewed floor.
      const items = sortByLayer(buildItems(view.floorIndex));
      const wantedIds = new Set(items.map((i) => i.id));
      prefetchSkippedPacks = 0;
      lastUpdate.placementChanges = 0;
      lastUpdate.itemCount = items.length;
      passSeq++;
      const thisPass = passSeq;

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
        // A PERMANENTLY-BROKEN ITEM IS NOT RETRIED (item 1d, 2026-07-17). Found
        // in the author's own thrash report: ten identical `HTTP 404` entries
        // for one token image, and `mainThreadFallbackSourceDecodes: 12`.
        // `ensureItemLoaded` throws for a broken source, so `itemStates` never
        // gets an entry, so it was re-attempted on EVERY residency pass —
        // seventy-seven of them in that session — each paying a ranged fetch, a
        // worker dimensions round-trip, AND a main-thread fallback decode
        // attempt (the last of which is the operation this file elsewhere calls
        // "a giant-image decode the render loop could feel"). `itemLoadErrors`
        // deduped the REPORT; nothing deduped the WORK, so the report looked
        // tidy while the cost repeated forever.
        //
        // The trade, stated because it IS a real one: a source that starts
        // working later (a server hiccup, an asset uploaded mid-session) now
        // needs a reload rather than fixing itself on the next pass. That is
        // the right way round — an asset that 404s is overwhelmingly gone, not
        // late, and paying an unbounded per-frame cost forever on the chance it
        // returns is exactly the "reactive mechanism" shape Keyhole exists to
        // delete. The failure stays LOUD either way: it is in `layerLoadErrors`
        // in every report, permanently, not silently skipped.
        if (failedItemIds.has(item.id)) continue;
        try {
          states.push([item, await ensureItemLoaded(item)]);
        } catch (err) {
          // One broken item (404 art, undecodable file) must not take the scene
          // down. Recorded rather than thrown — the debug panel surfaces this,
          // since the author debugs by pasting reports, not reading the console.
          const message = String(err?.message || err);
          failedItemIds.add(item.id);
          if (!itemLoadErrors.some((e) => e.id === item.id)) {
            itemLoadErrors.push({ id: item.id, src: item.src, error: message });
            console.error(`[vt-pan-viewer] item "${item.id}" failed to load (${item.src}):`, err);
          }
        }
      }

      // PHASE 2 — view-tier streaming + mesh update, now that every coarse pin
      // is locked in and can't be starved.
      for (const [item, state] of states) {
        // Counted, not just done. A document-driven refresh that runs and moves
        // NOTHING is indistinguishable from a hook that never fired — and those
        // two need opposite fixes. See `lastUpdate`'s declaration.
        const changed = refreshItemPlacement(state, item);
        if (changed) {
          lastUpdate.placementChanges++;
          lastUpdate.placementChangesTotal++;
        }
        if (item.kind === 'token') {
          tokenPassLog.push({
            pass: thisPass,
            id: item.id,
            x: state.placement.x,
            y: state.placement.y,
            changed,
          });
          if (tokenPassLog.length > TOKEN_PASS_LOG_MAX) tokenPassLog.shift();
        }
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
        // Isolation is applied HERE, after every streaming decision above, so a
        // hidden item still pages exactly as it would normally — see
        // isolateItemId. `''` is the normal case and costs one string compare.
        state.mesh.visible = onScreen && (isolateItemId === '' || item.id === isolateItemId);
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
      await scheduleResidencyUpdate();
      return { displayLayer: displayLayerName };
    }

    /**
     * Show ONLY one draw item (`''` = show all). See isolateItemId's header for
     * why this exists rather than a sixth theory.
     * @param {string} id
     */
    async function setIsolateItem(id) {
      isolateItemId = id ?? '';
      await scheduleResidencyUpdate();
      return {
        isolateItemId,
        showing: isolateItemId === '' ? 'ALL items (normal)' : isolateItemId,
        drawListIds: lastItems.map((i) => i.id),
      };
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
    /**
     * THE DOCUMENT-REFRESH DISCRIMINATOR (2026-07-17, author-reported: "when I
     * move a token it clearly moves in the document but it only updates the
     * token's new position in threejs once I pan the camera or zoom").
     *
     * The whole read path — the `updateToken` hook, refreshVtPanViewerItems,
     * updateResidency, buildItems' live document reads, refreshItemPlacement's
     * geometry rewrite — was re-read line by line and is CORRECT. Which is
     * exactly the point at which this project stops guessing: six rounds of
     * theory→live-test cost a session in 2026-07-15, and the thing that ended it
     * was instrumentation, not a seventh theory.
     *
     * These three counters make the three candidate causes DISTINGUISHABLE in
     * one report, which is the only property that matters here:
     *
     *   docRefreshes === 0        -> the hook never reached us. Fix boot.js.
     *   docRefreshes > 0 but
     *     placementChanges === 0  -> we ran and read the SAME position. The doc
     *                                read is stale/mis-timed. Fix the source.
     *   docRefreshes > 0 and
     *     placementChanges > 0    -> we ran AND moved the geometry, and the
     *                                screen still disagrees. Fix the upload
     *                                (BufferAttribute -> GPU under WebGPU).
     *
     * `placementChanges` counts items whose placementKey ACTUALLY changed, so a
     * zero here means "nothing moved", never "I did not look" — every pass
     * writes all three fields (doctrine #5, feedback_instruments_must_not_lie).
     *
     * COUNTERS, NOT TIMESTAMPS, and that was the `time/one-clock` wall's doing:
     * the first cut stamped `performance.now()` on each field and the wall
     * (correctly) failed the build. It asked the right question — does a
     * diagnostic need its own private clock? — and the answer was no. The three
     * counters discriminate all three causes on their own; the timestamps were
     * decoration that would have added two private clock reads to a codebase
     * whose predecessor died partly of 41 of them.
     *
     * ROUND 2 (2026-07-17) — the first cut of this ANSWERED ONE QUESTION AND
     * NOT THE ONE THAT MATTERED, which is worth recording because it is this
     * project's most expensive recurring mistake in miniature:
     *
     *   documentSync: { docRefreshes: 1, placementChanges: 0 }
     *
     * That says *a* hook fired. It does NOT say WHICH — and "did `updateToken`
     * fire at all?" was the entire open question. `docRefreshes: 1` is equally
     * consistent with "updateToken fired and the read was stale" and with
     * "updateToken never fired and this 1 came from some other document" — two
     * causes needing opposite fixes, collapsed onto one number. Hence
     * `byHook`: the count keyed by the hook NAME that drove it.
     *
     * `placementChangesTotal` is cumulative for the same reason: `placementChanges`
     * describes only the LAST pass, so any later no-op pass silently erases the
     * evidence of the one that mattered. A number that a later event can reset
     * to a value meaning "nothing happened" is not a measurement.
     */
    const lastUpdate = {
      itemCount: 0,
      placementChanges: 0,
      placementChangesTotal: 0,
      docRefreshes: 0,
      byHook: {},
    };

    /**
     * ROUND 3 — the same author move, a DIFFERENT symptom: liveVsRendered showed
     * a REAL 807.8px gap, docRefreshes:4 (2 updateToken + 2 moveToken, matching
     * two movement segments) but placementChangesTotal:1. That is one report;
     * it does not say whether the gap is STRUCTURAL (a hook genuinely missed) or
     * TRANSIENT (the async residency pass legitimately had not caught up yet —
     * plausible given item 1b's finding, the SAME scene's cache is already at
     * `freePages:0` with 246 coarse pins short, so streaming a token's freshly-
     * moved-to pages can be slow). Those need OPPOSITE next actions — more hook
     * plumbing vs the cache-budget work already tracked as 1b — so guessing is
     * exactly the six-rounds trap this project already paid for once.
     *
     * `passLog`: one entry per token item per REAL updateResidency() PASS (not
     * per hook — hooks that fire synchronously back-to-back coalesce into ONE
     * pass via `scheduleResidencyUpdate`'s do-while, so `docRefreshes` and
     * "actual passes" are NOT the same count; conflating them is how the last
     * report read stranger than it was). `pass` is a plain incrementing
     * counter, not a timestamp — `time/one-clock` again.
     *
     * A second report, taken a few seconds after the FIRST without touching
     * anything, is what actually distinguishes the two causes: if `passLog`
     * shows a LATER pass converging on the live position, it was transient; if
     * `totalPasses` stops advancing for that item while `liveVsRendered` still
     * disagrees, no further pass is even being attempted and the hook is the gap.
     */
    let passSeq = 0;
    const TOKEN_PASS_LOG_MAX = 24;
    const tokenPassLog = [];

    let residencyInFlight = false;
    let residencyDirty = false;
    /**
     * THE ONLY WAY TO RUN A RESIDENCY PASS. The sole caller of
     * `updateResidencyUnguarded` — see its header for the pin leak that six
     * direct callers caused, and the live numbers that proved it.
     *
     * Nothing is dropped: a request arriving mid-pass sets `residencyDirty` and
     * the in-flight run loops again, so the LAST state always wins and exactly
     * one pass touches shared per-pack state at a time. Callers that used to
     * `await updateResidency()` for its completion still get it whenever no
     * pass is running (the common case — startup, a lone floor switch): the
     * do-while runs inline and this await resolves after it. When a pass IS
     * running, returning early is the point.
     */
    async function scheduleResidencyUpdate() {
      if (residencyInFlight) {
        residencyDirty = true;
        return;
      }
      residencyInFlight = true;
      try {
        do {
          residencyDirty = false;
          await updateResidencyUnguarded();
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
      // RIGHT-DRAG PANS — verified in the vendored source, not remembered
      // (author caught this): Canvas#_onDragRightMove (board.mjs:2278) is literally
      // `this.pan(...)`, and mouse-handler.mjs:462 routes `button === 2` to the
      // right-drag handler. LEFT-drag in Foundry is the SELECT box, so panning on
      // it would fight every placeable layer the moment tokens land.
      // Middle (1) is kept as a common convenience that collides with nothing.
      if (e.button !== 2 && e.button !== 1) return;
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
      canvas.style.cursor = 'default';
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

      // FOLLOW FOUNDRY'S CAMERA, per frame. Reading canvas.stage is a couple of
      // property reads, so doing it every frame is cheaper than the alternative and
      // cannot drift: there is no event to miss and no ordering to get wrong.
      //
      // It was driven off the canvasPan hook, which AWAITED a full residency
      // rebuild — sort the draw list, re-request pages — on every event of a drag.
      // That is what made pan/zoom "a bit laggy and awkward, not smooth any more"
      // (author-reported). The camera must move at frame rate; residency is
      // debounced behind scheduleResidencyUpdate, which already exists for exactly
      // this and is what MSA's own input used.
      if (followFoundryCamera && syncFoundryCamera()) dirty = true;

      // MSA'S OWN CAMERA INTEGRATION — skipped entirely when following Foundry.
      //
      // Gating the input LISTENERS was not enough (author-reported live: "it keeps
      // trying to push the camera back to the same position and zoom every
      // frame"). This block runs per-frame regardless of input: it eases
      // view.halfSpanPx toward targetHalfSpanPx — still holding the value captured
      // at load — and REPLACES `view` wholesale via integratePan/applyZoomAtPixel.
      // So every frame it overwrote whatever syncFoundryCamera had just adopted and
      // dragged the view back to the load-time camera. Two cameras fighting: the
      // precise failure this model exists to prevent, reproduced by my own loop.
      if (!followFoundryCamera) {
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
      await scheduleResidencyUpdate();
      return true;
    }

    /**
     * ONE realistic zoom step — exposed for `MapShine.soakHooks.zoom`
     * (2026-07-17, author-directed: the burst-mode thrash test reaches states a
     * real user genuinely cannot produce — confirmed live, the author could not
     * reproduce its ghost artefact through deliberate aggressive manual
     * scroll-zooming for 15-20s). SAME factor and anchor as a real keyboard
     * zoom key (`ZOOM_IN_KEYS`/`ZOOM_OUT_KEYS` above, and `onWheel`'s own
     * magnitude-1 case) — NOT a new formula, and NOT the thrash's
     * `clampHalfSpan(0/Infinity, world)` full-range jump. `setZoomTarget` only
     * moves the EASED target; the glide itself happens in
     * `updateContinuousInputs` on subsequent real animation frames, exactly as
     * it does for a real keypress or wheel notch — this function does not
     * shortcut that.
     * @param {'in'|'out'} direction
     */
    function zoomStep(direction) {
      setZoomTarget(direction === 'in' ? 0.8 : 1.25, canvasW / 2, canvasH / 2);
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
      await scheduleResidencyUpdate();
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
        // buf:scene.color tracks the drawing buffer — that IS what screenSized
        // means. `allocator.resize()` re-enforces the law on the new size
        // (its own doc: "a resize storm can't smuggle a world-res target past
        // the law that create() already enforced").
        allocator.resize(sceneColor, canvasW, canvasH, describeSceneColor());
        rebindPresent();
        await scheduleResidencyUpdate().catch((err) => console.error('[vt-pan-viewer] resize residency failed:', err));
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

    // THE INITIAL LOAD, walked explicitly so it can be REPORTED.
    //
    // updateResidency() would load these items anyway (its phase-1 loop calls the
    // same idempotent ensureItemLoaded), but it runs on every residency update and
    // has no business knowing about a loading screen. Doing the first pass here
    // keeps the progress feed out of the per-frame path entirely, and gives honest
    // per-item counts (§4.5's "pages resident / pages needed", at the granularity
    // we actually know before anything is decoded: the item count is known
    // immediately from buildItems, the page totals are not).
    //
    // ensureItemLoaded is idempotent, so updateResidency's own loop below is then
    // a no-op for these — one path, walked twice, not two paths.
    //
    // THE COARSE-PIN BUDGET, computed BEFORE the first ensureItemLoaded call of
    // the session — this loop (and prewarm, started further below) is where
    // NEW packs first request their coarse pin, and that request reads
    // `currentCoarseBudget` (item 1b). Must happen before either.
    refreshCoarsePinBudget();
    const initialItems = buildItems(view.floorIndex);
    onLoadProgress?.({ done: 0, total: initialItems.length, detail: null });
    for (let i = 0; i < initialItems.length; i++) {
      const item = initialItems[i];
      try {
        await ensureItemLoaded(item);
      } catch (err) {
        // A single broken item must not take the scene down — updateResidency
        // records it properly below; here we only keep the count honest.
        console.error(`[vt-pan-viewer] initial load: item "${item.id}" failed:`, err);
      }
      onLoadProgress?.({ done: i + 1, total: initialItems.length, detail: item.kind });
    }

    // Through the guard like every other caller (nothing else is running yet,
    // so this executes inline and the await genuinely resolves after it).
    await scheduleResidencyUpdate();

    // PRECOMPILE BEFORE THE FIRST DRAW. Until now every program compiled lazily
    // inside the first render() — an unbounded synchronous stall in the one frame
    // the user is already waiting on, and invisible because it hid inside the
    // load. See docs/planning/Shaders.md for the full reasoning; the short version:
    //
    //   * compileAsync's NAME IS MISLEADING. `this.compile()` inside it is
    //     SYNCHRONOUS (three.module.js:42011) — createShader/compileShader/
    //     linkProgram all run now, on this thread. Only the WAIT is a promise.
    //   * What makes that wait worth anything is KHR_parallel_shader_compile: the
    //     DRIVER compiles on its own threads and linkProgram returns immediately.
    //     WITHOUT the extension, `programReady` is initialised to TRUE
    //     (three.module.js:36061), isReady() lies at once, this resolves instantly
    //     — and the compile still blocks, just later, at first useProgram.
    //
    // So this is not "make compilation async". It is: do the compile HERE, where
    // the loading screen is watching and its worstStallMs will report the cost,
    // rather than in the first frame where it is invisible. On a GPU with the
    // extension it is genuinely parallel; on one without, it is at least MEASURED.
    // A worker cannot help with either — GL programs belong to the context that
    // made them, so a worker's program is unusable here (Shaders.md §2).
    try {
      const t0 = performance.now();
      await renderer.compileAsync(scene, camera);
      shaderCompileMs = Math.round(performance.now() - t0);
    } catch (err) {
      // Precompiling is an optimisation; failing to precompile must never cost a
      // scene. The programs will compile lazily on first draw exactly as before.
      console.warn('[vt-pan-viewer] shader precompile failed — falling back to lazy compile:', err);
      shaderCompileMs = null;
    }

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
    // Keyboard camera controls are MSA's own, so they go with the rest of them
    // when Foundry owns input — and these are on WINDOW, so pointer-events:none
    // could never have stopped them stealing WASD from Foundry.
    if (!followFoundryCamera) {
      window.addEventListener('keydown', onKeyDown, { capture: true });
      window.addEventListener('keyup', onKeyUp, { capture: true });
    }
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
    canvas.style.cursor = 'default';
    // MSA's OWN camera controls exist only for the standalone torture-fixture
    // viewer, which has no Foundry scene to follow. On a real scene they must not
    // exist at all: a second camera is a second source of truth, and the moment it
    // disagrees with Foundry's stage every drop lands at the wrong world point.
    if (!followFoundryCamera) {
      canvas.addEventListener('pointerdown', onPointerDown);
      // Right-drag pans, so the browser context menu must not fire on release.
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      canvas.addEventListener('wheel', onWheel, { passive: false });
    }

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
      /** Tear down buf:scene.color + the present chain (see disposeActive). */
      disposeSceneColor() {
        allocator.dispose(sceneColor);
        presentMaterial.dispose();
        // NOT presentQuad.geometry — QuadMesh shares ONE module-level
        // QuadGeometry across every QuadMesh in the process
        // (three.webgpu.js:49456, `var _geometry2 = new QuadGeometry()`).
        // Disposing it would break every other fullscreen pass three runs.
      },
      /**
       * ORIENTATION SELF-TEST — real pixels, through the real chain.
       *
       * Renders diag/orientation-probe's asymmetric four-corner pattern into
       * the SAME buf:scene.color the map uses, presents it through the SAME
       * QuadMesh, then reads the actual pixels back off the target and asks
       * `diagnoseOrientation` what it sees. Not "does it look right to you" —
       * a named expectation and a measured value.
       *
       * Reads back from the RT rather than the canvas on purpose: a canvas
       * readback needs `preserveDrawingBuffer` and can legitimately return all
       * zero when called from a click handler (that exact false alarm cost a
       * debugging round on 2026-07-15). The RT is stable and readable on both
       * backends — which is why §"the readback path both backends implement".
       */
      async runOrientationSelfTest() {
        // ⚠️ ROUND 2 REDESIGN (2026-07-17) — read this before touching the
        // pattern-generation code below.
        //
        // Round 1 built the pattern as ONE fullscreen quad with a branching
        // TSL shader (nested `select()`/`.and()`/`.lessThan()` picking a
        // colour per screen quadrant). The result: one corner read an EXACT,
        // fully-saturated hit — but the WRONG colour, not a clean permutation
        // — and the other three read faint, muddy values matching none of the
        // four defined colours. That shape (one clean hit + mush, not a clean
        // swap) does not fit a single coordinate bug; it is consistent with
        // TWO things going wrong at once, and blind shader-branching is
        // exactly the code this project's own standing warning
        // (memory: reference_tsl_method_chaining_trap — the `.mix()` bug that
        // cost a session) says to distrust until checked against source.
        // `select()`'s argument order and `.and()`'s semantics WERE checked
        // (three.webgpu.js:35276 ConditionalNode, :34860/34899 `and`) and
        // both are correct — so that specific trap is ruled out, but a
        // branching shader is still more moving parts than this diagnostic
        // needs, and "more moving parts than needed" is itself the risk.
        //
        // Redesigned to remove everything not load-bearing: FOUR SEPARATE
        // quads, one flat, unbranched colour each, positioned by explicit NDC
        // vertex coordinates under the SAME orthographic camera convention
        // QuadMesh itself uses (-1,1,1,-1,0,1 — NDC y=+1 is top BY
        // DEFINITION of that camera, not by interpretation of a shared
        // geometry's uv scheme). A flat `fragmentNode = vec4(r,g,b,1)` is
        // about as low-risk as GPU code gets: one node, no chaining, no
        // per-pixel branching to get subtly backwards.
        //
        // ALSO ADDED: the defensive renderer-state reset the deleted
        // graph/fullscreen-present.js's own header called out as necessary
        // ("scissor off, viewport to logical size, opaque clear... to avoid
        // stale-underlay artifacts") and which this file's fresh TSL present
        // pass never carried over. Cheap, safe, and exactly the kind of stale
        // GL/GPU state this project has been bitten by before (the
        // texture-unit-cache staleness bug from the original VT viewer
        // build — see keyhole-stage-status memory, Round 5).
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, sceneColor.width, sceneColor.height);

        const probeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const probeScene = new THREE.Scene();
        const probeMats = [];
        for (const c of PROBE_CORNERS) {
          const mat = new THREE.NodeMaterial();
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.fragmentNode = THREE.TSL.vec4(c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, 1);
          probeMats.push(mat);
          // NDC mapping, stated so it can be checked: NDC y=+1 is the TOP of
          // this camera's frustum by definition (top param = 1). v=0 (this
          // corner's OWN stated "top" convention) must therefore map to
          // ndcY=+1, and v=1 to ndcY=-1 — i.e. ndcY = 1 - v*2.
          const ndcX = c.u * 2 - 1;
          const ndcY = 1 - c.v * 2;
          const half = 0.18; // a visible box, comfortably clear of every other corner's box
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(
              [
                ndcX - half,
                ndcY + half,
                0,
                ndcX - half,
                ndcY - half,
                0,
                ndcX + half,
                ndcY - half,
                0,
                ndcX - half,
                ndcY + half,
                0,
                ndcX + half,
                ndcY - half,
                0,
                ndcX + half,
                ndcY + half,
                0,
              ],
              3
            )
          );
          probeScene.add(new THREE.Mesh(geo, mat));
        }

        // 1. Draw the pattern into buf:scene.color — the geometry.world slot.
        renderer.setRenderTarget(sceneColor);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, true, true);
        renderer.render(probeScene, probeCamera);
        renderer.setRenderTarget(null);

        // 2. Read the REAL pixels back out of it.
        const w = sceneColor.width;
        const h = sceneColor.height;
        const found = {};
        const measured = {};
        for (const c of PROBE_CORNERS) {
          // ⚠️ ROUND 2 CORRECTION. This used to be `(1 - c.v) * (h-1)`,
          // reasoning "readRenderTargetPixels' buffer is bottom-left-origin
          // like classic OpenGL". Round 1's live result contradicted that: one
          // corner read an EXACT hit at the diagonally-opposite-in-Y position.
          //
          // `readRenderTargetPixelsAsync` is NOT one of three's own
          // texture-SAMPLING calls (those go through the `isFlipY()`
          // mechanism this file already cites) — it is a raw GPU memory copy
          // (`encoder.copyTextureToBuffer`, three.webgpu.js:70950-71012).
          // WebGPU's copy origin follows the SAME top-left fragment-coordinate
          // convention as Vulkan/D3D12/Metal (its own backends): row 0 is the
          // TOP of the rendered image, not the bottom. That is the OPPOSITE of
          // classic OpenGL, which is what the original comment assumed.
          //
          // Confidence note, stated honestly rather than presented as another
          // certainty: this is documented WebGPU/Vulkan/D3D12 API behaviour,
          // not a single line grep'd from this vendored bundle the way the
          // isFlipY()/QuadGeometry findings were — but it is corroborated by
          // the actual Round 1 failure pattern, which is exactly what
          // inverting this ONE line predicts. If this is STILL wrong, the
          // improved probe (four solid, well-separated boxes, no shader
          // branching) will now say so as a CLEAN Y-flip rather than mush —
          // the diagnosis logic already knows how to name that.
          const px = Math.round(c.u * (w - 1));
          const py = Math.round(c.v * (h - 1));
          // ⚠️ readRenderTargetPixelsAsync RETURNS the pixel data — it does NOT
          // write into a passed-in buffer. Verified against source after this
          // first read every corner as black (three.webgpu.js:62303, and its
          // real WebGPU-path implementation at 70950: `return new
          // typedArrayType(buffer3)`). The first cut of this probe passed an
          // 8th `buf` argument that the signature does not have — silently
          // ignored — then read that never-written buffer back as the result.
          // The render was correct the whole time; only the readback was blind.
          const raw = await renderer.readRenderTargetPixelsAsync(sceneColor, px, py, 1, 1, 0, 0);
          // ⚠️ AND: an RGBA16F target's real bytes are raw half-float bit
          // patterns, returned as a Uint16Array (WebGPUTextureUtils.
          // _getTypedArrayType: `RGBA16Float -> Uint16Array`) — not something a
          // 0..1 read can use directly. Decoded with THREE.DataUtils.
          // fromHalfFloat rather than a hand-rolled bit-twiddle: three already
          // has this exact, tested function; writing a second one is how a
          // decode bug becomes two decode bugs that disagree.
          const r = THREE.DataUtils.fromHalfFloat(raw[0]);
          const g = THREE.DataUtils.fromHalfFloat(raw[1]);
          const b = THREE.DataUtils.fromHalfFloat(raw[2]);
          const r8 = Math.round(Math.min(1, Math.max(0, r)) * 255);
          const g8 = Math.round(Math.min(1, Math.max(0, g)) * 255);
          const b8 = Math.round(Math.min(1, Math.max(0, b)) * 255);
          measured[c.name] = { rgb: [r8, g8, b8], readAt: { x: px, y: py } };
          found[c.name] = classifyPixel(r8, g8, b8);
        }

        // Each corner built its OWN geometry (unlike the QuadMesh present
        // pass, these are NOT three's shared module-level QuadGeometry — safe
        // to dispose every one of them).
        for (const obj of probeScene.children) {
          obj.geometry?.dispose();
        }
        for (const mat of probeMats) mat.dispose();
        const verdict = diagnoseOrientation(found);

        // 3. Put the map back. The probe scribbled over buf:scene.color; the
        // next renderFrame redraws it, but do not leave the screen showing a
        // test pattern if the loop happens to be paused.
        renderer.setRenderTarget(sceneColor);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        presentQuad.render(renderer);

        return {
          ok: verdict.ok,
          diagnosis: verdict.diagnosis,
          expected: Object.fromEntries(PROBE_CORNERS.map((c) => [c.name, c.label])),
          found,
          measured,
          note: 'Rendered through the REAL buf:scene.color + the REAL present QuadMesh. If this says ok, the geometry.world -> present.composite chain is upright.',
        };
      },

      /** buf:scene.color's live shape — for the diagnostics report. */
      getSceneColorInfo: () => ({
        allocated: !!sceneColor,
        name: sceneColor?.name ?? null,
        width: sceneColor?.width ?? 0,
        height: sceneColor?.height ?? 0,
        // Proof the law is genuinely in the path, not just imported.
        throughAllocator: true,
        screenSized: true,
        megapixels: sceneColor ? +((sceneColor.width * sceneColor.height) / 1e6).toFixed(2) : 0,
        // RGBA16F = 8 bytes/texel. §4.2 budgets ~24MB at 3MP; this is the real number.
        estMB: sceneColor ? +((sceneColor.width * sceneColor.height * 8) / 1048576).toFixed(1) : 0,
      }),
      onKeyDown,
      onKeyUp,
      clearHeldKeys,
      floorCount,
      startupParams, // exposed so runZoomThrashTest can restart an identical fresh viewer ("blank slate")
      getView: () => view,
      applyKeyAndUpdate, // exposed so MapShine.soakHooks.pan drives the EXACT same path a real keypress does
      zoomStep, // exposed so MapShine.soakHooks.zoom drives one real, bounded, eased zoom step (see its own doc)
      setFloorIndex, // exposed so an external (Foundry-driven) floor sync is as cheap as a keypress, never a full restart
      // Re-ask buildItems and reconcile. The draw list is derived from live
      // Foundry documents, but NOTHING here watches them — updateResidency only
      // runs when the VIEW changes, so creating a token while the camera sits
      // still changed the document and never reached the screen (author-reported
      // 2026-07-16: "I drag a token into the scene area but nothing appears").
      // boot.js drives this from the document CRUD hooks.
      //
      // THROUGH scheduleResidencyUpdate, NOT updateResidency DIRECTLY (fixed
      // 2026-07-17). It used to call updateResidency() straight, which BYPASSES
      // the residencyInFlight guard — so a document change landing mid-update
      // started a SECOND concurrent updateResidency over the same itemStates,
      // cache and atlas. That is the interleaving class this file already lost
      // Rounds 4 and 5 to (see prepareForUploadBatch's history): every `await`
      // in updateResidency is a yield point where the other run can act on
      // half-updated shared state. The guard already handles this correctly —
      // it sets residencyDirty and the in-flight run loops again, so a refresh
      // is never dropped, only merged. Nothing was gained by going around it.
      refreshItems: (hookName = '(unnamed)') => {
        lastUpdate.docRefreshes++;
        lastUpdate.byHook[hookName] = (lastUpdate.byHook[hookName] ?? 0) + 1;
        return scheduleResidencyUpdate();
      },
      setDisplayLayer, // exposed so the debug panel can bind a mask for visual verification
      setIsolateItem, // "show only this draw item" — see isolateItemId's header
      getIsolateItemId: () => isolateItemId,
      getDrawListIds: () => lastItems.map((i) => ({ id: i.id, kind: i.kind, renderOrder: i.renderOrder })),
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

        // THE DRAW LIST, in paint order — the direct answer to "why is this
        // on top of that". Each entry's renderOrder came from sortByLayer
        // (scene/layer-order.js) over its (elevation, sortLayer, sort, zIndex)
        // key, so this table IS the layering, not a summary of it.
        const drawList = lastItems.map((i) => {
          const state = itemStates.get(i.id);
          return {
            renderOrder: i.renderOrder,
            id: i.id,
            kind: i.kind,
            elevation: i.key.elevation,
            sortLayer: i.key.sortLayer,
            sort: i.key.sort,
            zIndex: i.key.zIndex,
            visible: state?.mesh?.visible ?? false,
            occlusionModes: i.occlusion?.modes ?? 0,
            // GROUND TRUTH vs RENDERED, for tokens only (2026-07-17 — "stops
            // slightly short" after the moveToken fix). `state.placement` is
            // what refreshItemPlacement last actually wrote to the mesh — a
            // SNAPSHOT from whenever the last residency pass ran. `i._placement
            // .tokenDoc` is the SAME live document reference `lastItems` was
            // built from, re-read HERE, at report-generation time, which can be
            // LATER than the last pass. Re-deriving the footprint fresh from it
            // (not trusting any cached footprint) answers the only question that
            // matters: is MSA's rendered position CURRENTLY behind Foundry's
            // live document, or does it already match right now?
            //   liveVsRendered: null  -> not a token, or not placed yet.
            //   deltaPx ~0            -> MSA matches Foundry AT REPORT TIME. The
            //                            "short" stop was transient (report taken
            //                            mid-movement) or is a rendering/geometry
            //                            issue, not a sync gap.
            //   deltaPx > 0, and a SECOND report taken later still shows the SAME
            //   nonzero delta -> MSA is genuinely stuck behind the live document.
            // WHERE THIS QUAD ACTUALLY IS, and what its page grid was built from
            // (2026-07-17 — the "very large, wrong position, partially
            // transparent, never evicted" ghost). Those four properties together
            // do NOT describe a virtual-texture fault: the sampler's two failure
            // colours are both OPAQUE (magenta = broken pin invariant, black =
            // out-of-world), and a page-level lie would still be confined to that
            // page's own world area rather than appearing "very large". A
            // MISPLACED/MIS-SIZED QUAD explains all four at once — including
            // "never evicted", because a mesh is not a page and zooming can never
            // reclaim it. These two fields tell those apart from ONE report,
            // instead of a fourth round of theory.
            //
            //   placementPx wildly larger than the scene, or origin far outside
            //   world{} -> the quad is wrong: computeItemPlacement / imageSizePx.
            //   placementPx sane, artefact still on screen -> genuinely the
            //   sampler, and the pyramid/mip math is next.
            //
            // imageSizePx is included because it is placement's hidden INPUT
            // (`state.imageSize`, read once from getSourceDimensions at load) and
            // a wrong value there silently mis-sizes the quad forever after —
            // exactly the "never evicted" signature. It is also the field that
            // would expose a regression in readLeadingBytes' PNG-header parse.
            placementPx: state?.placement
              ? {
                  x: Math.round(state.placement.x),
                  y: Math.round(state.placement.y),
                  width: Math.round(state.placement.width),
                  height: Math.round(state.placement.height),
                  rotation: state.placement.rotation ?? 0,
                }
              : null,
            imageSizePx: state?.imageSize ?? null,
            liveVsRendered: (() => {
              if (i.kind !== 'token' || !i._placement?.tokenDoc) return null;
              if (!state?.placement) return null;
              const live = tokenFootprint(i._placement.tokenDoc, i._placement.gridSize);
              const dx = live.centerX - state.placement.x;
              const dy = live.centerY - state.placement.y;
              return {
                liveX: live.centerX,
                liveY: live.centerY,
                renderedX: state.placement.x,
                renderedY: state.placement.y,
                deltaPx: Math.round(Math.hypot(dx, dy) * 10) / 10,
              };
            })(),
            // THE ACTUAL UNIFORM VALUES the shader is running on, read straight off the
            // JS side -- exact, and involving no shader at all. Kept after the bisect
            // scaffolding was stripped because it earned it: printing these is what
            // proved the occlusion weights were clean zeros, which is what forced the
            // search onto the OPERATION rather than the values and found the .mix()
            // trap (reference_tsl_method_chaining_trap).
            uniforms: (() => {
              const a = state?.appearance;
              if (!a) return null;
              return {
                occlusionWeights: a.uOcclusionWeights.value.toArray(),
                occlusionElevation: a.uOcclusionElevation.value,
                alpha: a.uAlpha.value,
                unoccludedAlpha: a.uUnoccludedAlpha.value,
                occludedAlpha: a.uOccludedAlpha.value,
                tint: a.uTint.value.toArray(),
                srgbDecode: state?.vt?.uniforms.srgbDecode.value ?? null,
              };
            })(),
          };
        });

        // A scan of drawList so a token desync doesn't require reading the
        // whole (potentially long) table by eye. Empty array = every token
        // currently matches its live document — the good state.
        const tokenSyncSummary = drawList
          .filter((e) => e.liveVsRendered && e.liveVsRendered.deltaPx > 1)
          .map((e) => ({ id: e.id, deltaPx: e.liveVsRendered.deltaPx }));

        return {
          view,
          layout,
          // buf:scene.color — the first real render target, and the proof that
          // Keyhole's law is IN THE PATH rather than merely imported. If
          // `throughAllocator` is ever false, the law has been routed around.
          sceneColor: _active?.getSceneColorInfo?.() ?? { allocated: false },
          // SHADERS (docs/planning/Shaders.md).  is the fork
          // in the road, not a detail: WITH it, compileAsync hands work to driver
          // threads; WITHOUT it, compileAsync resolves instantly having done
          // nothing and the compile stalls the first useProgram instead. This
          // project does not guess about extensions on the design-floor GPU.
          shaders: {
            parallelShaderCompile: !!renderer.backend?.extensions?.get?.('KHR_parallel_shader_compile'),
            precompileMs: shaderCompileMs,
            // Program COUNT is the thing that explodes as effects land (N effects x
            // M variants), so it is watched from the start. Identical ShaderMaterial
            // source shares ONE program (three.module.js:36407 keys the cache on
            // source identity), so today every item mesh costs 1 program between them.
            // renderer.info.programs is WebGLRenderer-only; the node renderer
            // reports differently. Left null rather than guessing a number.
            programCount: renderer.info?.programs?.length ?? null,
            backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
          },
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
          // DOES A DOCUMENT CHANGE REACH THE SCREEN? Three counters that make
          // the three candidate causes distinguishable in ONE report — see
          // `lastUpdate`'s declaration for the decision table. Move a token,
          // do NOT pan, then read this.
          documentSync: {
            ...lastUpdate,
            totalPasses: passSeq,
            // Newest last. `docRefreshes` counts HOOK FIRINGS; `totalPasses`
            // counts REAL updateResidency() executions — hooks firing back-to-
            // back synchronously (exactly what two movement segments' paired
            // updateToken+moveToken do) coalesce into fewer passes via
            // scheduleResidencyUpdate's do-while. The two numbers disagreeing is
            // NORMAL, not a bug on its own.
            passLog: tokenPassLog,
            interpretation:
              'Move a token WITHOUT panning, then read these. `byHook` names WHICH hooks drove a ' +
              'refresh. `passLog` is the decisive one for a REMAINING mismatch: it is one row per ' +
              'token per REAL pass (not per hook — see totalPasses vs docRefreshes above). Find the ' +
              "moved token's id in passLog: if its LAST row already equals liveVsRendered.live{X,Y} " +
              'for that item in drawList, MSA is caught up and any on-screen lag is the render not ' +
              'having painted a new frame yet, not a stale read. If its last row does NOT match, and ' +
              'a SECOND report (taken a few seconds later, nothing else touched) shows no NEW row for ' +
              'that id, no further pass is even being attempted — Foundry is not telling us. If a ' +
              'later report DOES add a new, correct row, this is TRANSIENT lag under cache pressure ' +
              '(cross-reference cacheStats.freePages and layerResidencyTotals.coarsePinShortfall — ' +
              'both nonzero means the cache is already oversubscribed and streaming the moved-to ' +
              'position can legitimately take a beat).',
          },
          canvasSizePx: { width: canvasW, height: canvasH },
          mountedInBoard: mount.fill && mount.host !== document.body,
          cacheStats: cache.stats(),
          drawList,
          // Empty = every token matches its live document right now (the good
          // state). Non-empty names exactly which tokens are behind and by how
          // much, without reading the full (potentially long) drawList by eye.
          tokenSyncSummary,
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
          // THE SCENE-WIDE COARSE BUDGET (item 1b, 2026-07-17) — what every
          // pack's coarse-pin request is capped against, and why. Fixes a
          // real 3-floor scene that measured coarseIntendedPages:808 against a
          // 246-page shortfall, freePages:0, and a 2.6s frame freeze — nothing
          // was dividing "~tens of pages total" (§4.1) by how many packs the
          // scene actually had.
          coarsePinBudget: {
            ...currentCoarseBudget,
            // GROUND TRUTH for whether the reserve is actually holding —
            // check THESE two, not the interpretation text below. The first
            // cut (capping what each pack ASKS for) landed alone and still
            // measured a real 81-page shortfall on the author's scene: it
            // capped the ask but never reserved the ROOM, so a busy viewport
            // could still pin the whole cache with 'view' pages before a
            // background pack's coarse request got a turn. cacheStats below
            // is where that second half (page-cache.js's coarseReservePages)
            // actually lives.
            cacheReserveCheck: {
              coarseReservePages: cache.stats().coarseReservePages,
              coarseReserveMisses: cache.stats().coarseReserveMisses,
              interpretation:
                'coarseReserveMisses should read 0 — the reserve is specifically what makes a coarse-pin ' +
                'miss structurally impossible (page-cache.js). If nonzero, the reserve itself is undersized ' +
                'or was not set before some pack requested its coarse pin — a real bug, not routine pressure.',
            },
            interpretation:
              `Every new pack's coarse pin is capped at perPackMaxPages (currently ` +
              `${currentCoarseBudget.perPackMaxPages}), so the SUM across all ${currentCoarseBudget.packCount} ` +
              `packs in the scene stays at or under totalBudgetPages (${currentCoarseBudget.totalBudgetPages}) — ` +
              `a fixed fraction of capacityPages, not a per-pack allowance nobody was adding up. That caps the ` +
              'ASK; cacheReserveCheck (above) covers the ROOM — page-cache.js reserves totalBudgetPages worth ' +
              "of slots that 'view' requests may never claim, so a busy viewport can't fill the whole cache " +
              "before a background pack's coarse request gets a turn. The tradeoff: a pack that would have " +
              'gotten more (a big Level background, previously ~82 pages) now gets less when many packs share ' +
              'the scene, AND the view tier itself now has less room at its OWN peak (it can no longer ever ' +
              'claim the pages reserved for coarse) — both a softer coarse/blurred fallback and slightly less ' +
              'peak view-tier sharpness under heavy pan/zoom, traded for the shortfall/freeze going away. Tune ' +
              'coarseBudgetFraction (residency.js, default 0.25) if that tradeoff feels wrong.',
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
            requested: sampleState?.vt?.uniforms.requestedMip.value ?? null,
            // 1 = the sRGB decode is live. Still-washed-out + 0 here = the fix never bound.
            srgbDecode: sampleState?.vt?.uniforms.srgbDecode.value ?? null,
            // Smooth mip blending (2026-07-16): the fractional companion to
            // `requested` — its integer part MUST equal `requested`; its
            // fractional part is the blend weight toward `requested+1`. If
            // these ever disagree, the blend uniform desynced from the walk's
            // starting mip — flag it.
            requestedFraction: sampleState?.vt?.uniforms.requestedMipFrac.value ?? null,
            max: sampleState?.vt?.uniforms.maxMip.value ?? null,
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
/**
 * Re-read the scene's documents and reconcile the draw list.
 *
 * Cheap and idempotent: the same reconcile updateResidency already does on every
 * view change, so an unchanged scene costs one buildItems call and no GPU work.
 * No-op `{skipped:true}` if nothing is running.
 */
/**
 * Re-read the live Foundry documents and reconcile the draw list.
 *
 * @param {string} [hookName] - the hook that drove this, recorded in
 *   diagnostics' `documentSync.byHook`. Not decoration: "which hook fired" was
 *   the open question a refresh COUNT could not answer (2026-07-17).
 */
export async function refreshVtPanViewerItems(hookName) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  await _active.refreshItems(hookName);
  return { refreshed: true };
}

/**
 * ORIENTATION SELF-TEST — is the geometry.world -> present.composite chain
 * upright? Real pixels, real chain, named expectations. See
 * diag/orientation-probe.js for why this exists rather than "look at it".
 *
 * Run it after ANY new screen-space or world->texture mapping lands.
 */
export async function runOrientationSelfTest() {
  if (!_active) return { skipped: true, reason: 'viewer not started — start it, then run this' };
  return _active.runOrientationSelfTest();
}

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

/**
 * Show ONLY one draw item (`''` = all). The ghost-hunting tool: see
 * `isolateItemId`'s header inside startVtPanViewer for why it exists.
 * @param {string} id
 */
export async function setVtPanViewerIsolateItem(id) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setIsolateItem(id);
}

/** The current draw list's ids — what the isolate dropdown is built from. */
export function getVtPanViewerDrawListIds() {
  if (!_active) return [];
  return _active.getDrawListIds();
}

/** @returns {string} the isolated item id, or `''` when showing everything. */
export function getVtPanViewerIsolateItemId() {
  if (!_active) return '';
  return _active.getIsolateItemId();
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
      'ADVERSARIAL MAX-STRESS, NOT A PLAY PROXY (confirmed 2026-07-17): this legs the zoom back and forth at ' +
      'maximum programmatic rate with zero settle time between direction flips — several full-range sweeps in ' +
      'the time it takes to read this sentence. The RANGE it reaches is real (the same clampHalfSpan() bounds a ' +
      "real scroll wheel or +/- key hits), but the RATE is not: the author could not reproduce this run's own " +
      'ghost-artefact finding through 15-20s of deliberate, aggressive manual scroll-zooming. Anything this run ' +
      'finds is a REAL bug in the system (worth understanding — an hours-long real session eventually produces ' +
      'bursts too), but treat it as "found under adversarial load," not "will happen to a GM." For "does this ' +
      'survive a realistic extended session," use MapShine.soak(n) instead — its zoom driver (soakZoomStep) ' +
      'takes one bounded, eased step per cycle through the SAME code path a real zoom key uses. ' +
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

/** One real animation frame's worth of settle, in the same units the eased
 * zoom actually uses: `ZOOM_EASE_HALF_LIFE_SEC` (0.12s) is roughly 7-8 frames
 * at 60fps. Waiting a couple of half-lives per soak step is enough for the
 * glide to make real, visible progress (and for `updateContinuousInputs` to
 * fire `scheduleResidencyUpdate` at least once) without ballooning an n-cycle
 * soak into a multi-second wait per step — a real user's NEXT wheel notch
 * during continuous scrolling usually lands before the previous one fully
 * settles anyway. */
const SOAK_ZOOM_SETTLE_FRAMES = 12;
/** A real zoom gesture is several notches in one direction, not a flip every
 * notch (the exact mistake `runZoomThrashTest`'s own header describes fixing
 * for its OWN legs — "flipping the target every frame... never went
 * anywhere"). A short leg here for the same reason, at soak scale. */
const SOAK_ZOOM_LEG_STEPS = 4;

/**
 * MapShine.soakHooks.zoom driver (2026-07-17) — ONE bounded, eased zoom step
 * per cycle via `zoomStep()`, the exact factor/anchor a real keyboard zoom
 * key uses (see `zoomStep`'s own doc). Alternates direction every
 * `SOAK_ZOOM_LEG_STEPS` cycles rather than every cycle, so a soak run
 * exercises a real zoom-in-then-zoom-out GESTURE, not an instant full-range
 * jump — the thing `runZoomThrashTest` does that the author could not
 * reproduce by hand. No-op (not an error) if the viewer was never started.
 * @param {number} i - the soak cycle index.
 */
export async function soakZoomStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const leg = Math.floor(i / SOAK_ZOOM_LEG_STEPS) % 2;
  const direction = leg === 0 ? 'in' : 'out';
  _active.zoomStep(direction);
  for (let f = 0; f < SOAK_ZOOM_SETTLE_FRAMES && _active; f++) await nextAnimationFrame();
  if (!_active) return { skipped: true, reason: 'viewer stopped mid-step' };
  return { direction, ..._active.getDiagnostics() };
}
