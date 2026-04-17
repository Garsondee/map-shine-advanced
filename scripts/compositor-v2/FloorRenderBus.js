/**
 * @fileoverview FloorRenderBus — simple albedo-only tile renderer for V2.
 *
 * Milestone 1 design: dead simple, no intermediate render targets.
 *
 * Previous approach (ABANDONED — see planning doc Attempts 1-4):
 *   Copied textures from TileManager sprites into bus meshes. This was broken
 *   because TileManager's pipeline routes through canvas 2D drawImage(), which
 *   premultiplies alpha internally. Bus meshes used NormalBlending (straight
 *   alpha), so premultiplied data produced white halos and corrupted edges.
 *   Switching WebP→PNG changed the corruption shape, confirming the root cause.
 *
 * New approach (Attempt 5):
 *   1. Read tile documents directly from `canvas.scene.tiles.contents`.
 *   2. Load textures via `THREE.TextureLoader` — uses an HTML <img> element,
 *      which delivers straight-alpha data with no canvas 2D intermediary.
 *   3. One THREE.Scene. Tiles Z-ordered by floor index (floor 0 at Z=1000,
 *      floor 1 at Z=1001, etc.) so standard depth sorting handles layering.
 *   4. MeshBasicMaterial with transparent:true, NormalBlending — correct for
 *      straight-alpha textures rendered directly to the screen framebuffer.
 *   5. No intermediate RTs, no compositor shaders, no premultiplied conventions.
 *
 * @module compositor-v2/FloorRenderBus
 */

import { createLogger } from '../core/log.js';
import { TILE_FEATURE_LAYERS } from '../core/render-layers.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  getViewedLevelBackgroundSrc,
  getVisibleLevelBackgroundSrcs,
  getVisibleLevelBackgroundLayers,
  hasV14NativeLevels,
} from '../foundry/levels-scene-flags.js';
import { isTileOverhead } from '../scene/tile-manager.js';
import {
  RENDER_ORDER_PER_FLOOR,
  GROUND_Z,
  Z_PER_FLOOR,
  MAX_INTRA_ROLE_OFFSET,
  tileAlbedoOrder,
  tileOverheadOrder,
  motionAboveTokensOrder,
  formatRenderOrder,
} from './LayerOrderPolicy.js';

const log = createLogger('FloorRenderBus');

const MAX_SORT_WITHIN_FLOOR_GROUP = MAX_INTRA_ROLE_OFFSET;
const UPPER_FLOOR_ALPHA_CUTOFF = 0.4;

/**
 * Strip query/hash for stable asset URL comparison (Foundry / CDN may append tokens).
 * @param {string} s
 * @returns {string}
 */
function _normalizeBgUrlKey(s) {
  if (!s || typeof s !== 'string') return '';
  try {
    const u = new URL(s, globalThis.location?.origin || 'http://localhost');
    let p = `${u.pathname || ''}`.toLowerCase();
    const q = u.searchParams;
    const v = q.get('v');
    if (v) p += `?v=${v}`;
    return p;
  } catch (_) {
    return s.split('?')[0].split('#')[0].trim().toLowerCase();
  }
}

/**
 * True if we should trust sceneComposer._albedoTexture for the current viewed level.
 * @param {import('three').Texture|null} bgTexture
 * @param {string} bgSrc trimmed viewed-level background src (may be empty)
 */
function _composerAlbedoMatchesViewedBg(bgTexture, bgSrc) {
  if (!bgTexture) return false;
  if (!bgSrc) return true;
  try {
    const stamped = bgTexture.userData?.mapShineBackgroundSrc;
    if (typeof stamped === 'string' && stamped.trim()) {
      return _normalizeBgUrlKey(stamped) === _normalizeBgUrlKey(bgSrc);
    }
  } catch (_) {}
  try {
    const img = bgTexture.image;
    if (img && typeof img.src === 'string' && img.src.trim()) {
      return _normalizeBgUrlKey(img.src) === _normalizeBgUrlKey(bgSrc);
    }
  } catch (_) {}
  return false;
}

// ─── FloorRenderBus ──────────────────────────────────────────────────────────

export class FloorRenderBus {
  constructor() {
    /**
     * Single scene containing ALL floor tiles, Z-ordered by floor index.
     * Standard Three.js depth sorting handles layering when rendered to screen.
     * @type {import('three').Scene|null}
     */
    this._scene = null;

    /**
     * Per-tile entries. Key: tileId (string).
     * Value: { mesh, material, floorIndex, root?, attachedToTileId? }
     * @type {Map<string, {mesh: import('three').Object3D, material: any, floorIndex: number, root?: import('three').Object3D|null, attachedToTileId?: string|null}>}
     */
    this._tiles = new Map();

    /**
     * Tile-albedo loader. `THREE.TextureLoader` is fine for tiles because
     * `_configureTileAlbedoTexture` explicitly sets `tex.premultiplyAlpha = true`
     * and the tile compositor uses premultiplied blending.
     * Background images use `this._bgImageLoader` instead — see its
     * JSDoc for why.
     * @type {import('three').TextureLoader|null}
     */
    this._loader = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {number} */
    this._visibleMaxFloorIndex = Infinity;

    /** @type {boolean} */
    this._suppressTileAlbedoForEditing = false;

    // Visibility telemetry for diagnostics.
    this._setVisibleFloorsCalls = 0;
    this._applyTileVisibilityCalls = 0;
    this._lastSetVisibleMaxFloorIndex = null;
    this._lastApplyVisibilityAtMs = null;
    this._lastPreApplyLeakCount = 0;
    this._lastPreApplyLeakKeys = [];
    this._renderToCalls = 0;
    this._lastRenderToAtMs = null;
    this._lastPreRenderLeakCount = 0;
    this._lastPreRenderLeakKeys = [];

    log.debug('FloorRenderBus created');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Initialize the bus. Call once after Three.js is available.
   */
  initialize() {
    if (!window.THREE) {
      log.warn('FloorRenderBus.initialize: THREE not available');
      return;
    }
    const THREE = window.THREE;
    this._scene = new THREE.Scene();
    this._scene.name = 'FloorBusScene';
    /**
     * Primary loader for TILE albedo textures. Tiles go through
     * `_configureTileAlbedoTexture` which expects an HTMLImageElement-backed
     * texture and sets `premultiplyAlpha = true` on the texture itself —
     * that path is unchanged.
     */
    this._loader = new THREE.TextureLoader();
    // Background images do NOT use `this._loader` — see `_loadBgImageStraightAlpha`
    // for the canvas → getImageData → DataTexture decode path used for
    // `__bg_image__*` entries. That path guarantees straight-alpha RGBA data
    // regardless of browser image-decode quirks.
    this._initialized = true;
    log.info('FloorRenderBus initialized');
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Build the scene from Foundry tile documents and the scene background.
   * Loads all textures independently via THREE.TextureLoader (straight alpha,
   * no canvas 2D corruption). Safe to call multiple times — clears first.
   *
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   */
  populate(sceneComposer) {
    if (!this._initialized) return;
    this.clear();

    const fd = sceneComposer?.foundrySceneData;
    if (!fd) { log.warn('FloorRenderBus.populate: no foundrySceneData'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];

    // Solid background colour plane (full world canvas, lowest Z).
    this._addSolidBackground(fd);

    // Scene background image — reuse SceneComposer's already-loaded texture
    // when GPU pixels exist, otherwise fall back to TextureLoader or a short
    // rAF wait. SceneComposer often assigns `_albedoTexture` before the
    // underlying image has non-zero dimensions; using it immediately skips
    // `_addBackgroundImage` (sceneW/H from image) and never schedules a load,
    // leaving only the solid #999999 bus plane (grey "empty" map under PIXI).
    const bgTexture = sceneComposer?._albedoTexture ?? null;
    // V14: prefer the viewed level's background; deprecated scene.background.src
    // always returns the first level's image.
    const scene = canvas?.scene ?? null;
    const bgSrcRaw = getViewedLevelBackgroundSrc(scene) ?? scene?.background?.src ?? '';
    const bgSrc = (bgSrcRaw && String(bgSrcRaw).trim()) ? String(bgSrcRaw).trim() : '';
    const visibleBgLayers = getVisibleLevelBackgroundLayers(scene);
    const visibleBgSrcs = visibleBgLayers.map((l) => l.src);
    const albedoImageReady = !!(bgTexture?.image && bgTexture.image.width > 0 && bgTexture.image.height > 0);
    // V14 multi-floor: never reuse SceneComposer._albedoTexture for the bus.
    // Foundry can transiently show another level's composite in canvas.primary while URLs
    // still match; TextureLoader reads the viewed level file directly.
    //
    // IMPORTANT: first populate() often runs before FloorStack is attached to MapShine,
    // so `floors` is [] — still treat native multi-level scenes as multi-floor here.
    const nativeLevelCount = scene?.levels?.size ?? 0;
    const multiFloorV14 = !!(hasV14NativeLevels(scene) && (floors.length > 1 || nativeLevelCount > 1));
    const reuseComposerAlbedo = !multiFloorV14
      && albedoImageReady
      && _composerAlbedoMatchesViewedBg(bgTexture, bgSrc);

    if (reuseComposerAlbedo) {
      this._addBackgroundImage(fd, bgTexture, 0, '__bg_image__');
      if (visibleBgSrcs.length > 1) {
        // Composer albedo only matches the viewed level texture; load other visible
        // background layers explicitly so upper-floor views include lower levels.
        this._loadVisibleBackgroundStack(visibleBgSrcs, fd, { skipFirst: true });
      }
    } else if (visibleBgSrcs.length > 0) {
      this._loadVisibleBackgroundStack(visibleBgSrcs, fd);
    } else if (bgSrc) {
      // Route legacy single-background load through the same
      // `_loadVisibleBackgroundStack` path used for multi-level stacks.
      // Keeps straight-alpha decode (ImageBitmap + premultiplyAlpha: 'none')
      // consistent across every `__bg_image__*` entry so authored alpha
      // holes survive to the GPU. Previously this fell back to
      // `TextureLoader`, which silently flattens WebP alpha in browsers
      // that decode HTMLImageElement with premultiplied RGB.
      this._loadVisibleBackgroundStack([bgSrc], fd);
      log.info('FloorRenderBus: bg image load routed through ImageBitmap stack loader');
    } else if (bgTexture) {
      let frames = 0;
      const maxFrames = 120;
      const tick = () => {
        frames += 1;
        try {
          const img = bgTexture?.image;
          if (img && img.width > 0 && img.height > 0) {
            if (!this._tiles.has('__bg_image__')) {
              this._addBackgroundImage(fd, bgTexture, 0, '__bg_image__');
            }
            return;
          }
        } catch (_) {}
        if (frames < maxFrames) requestAnimationFrame(tick);
        else log.warn('FloorRenderBus.populate: _albedoTexture never gained pixel dimensions (no bgSrc fallback)');
      };
      requestAnimationFrame(tick);
    }

    // Tile planes — read directly from Foundry, no TileManager dependency.
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    let tileCount = 0;
    const floorCounts = {};

    // Pre-sort tiles by Foundry sort field so visual stacking is correct.
    // Lower sort = behind, higher sort = in front.  Stable sort preserves
    // document order for tiles with identical sort values.
    const sortedTileDocs = [...tileDocs].sort((a, b) => {
      const sa = this._getTileSortValue(a);
      const sb = this._getTileSortValue(b);
      return sa - sb;
    });

    for (const tileDoc of sortedTileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const alpha = typeof tileDoc.alpha === 'number' ? tileDoc.alpha : 1;
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Foundry tile x/y = top-left in canvas space (Y-down).
      // Three world Y-up: worldY = worldH - foundryY.
      const worldH = fd.height;
      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const z = GROUND_Z + floorIndex * Z_PER_FLOOR;
      const tileId = tileDoc.id ?? tileDoc._id ?? `tile_${tileCount}`;

      const isOverhead = this._isOverheadForBusTile(tileDoc, tileId);
      const roofShadowCaster = this._usesRoofShadowCaptureLayer(tileDoc, floorIndex, isOverhead);
      const cloudShadowBlockerEnabled = this._shouldTileBlockCloudShadows(tileDoc, roofShadowCaster);
      const motionRenderAboveTokens = !!window.MapShine?.tileMotionManager?.getTileConfig?.(tileId)?.renderAboveTokens;
      floorCounts[floorIndex] = floorCounts[floorIndex] ?? { regular: 0, overhead: 0 };
      const groupCounts = floorCounts[floorIndex];
      if (isOverhead) groupCounts.overhead += 1;
      else groupCounts.regular += 1;
      const sortWithinFloor = this._computeSortWithinFloor(tileDoc);
      let renderOrder;
      if (motionRenderAboveTokens) {
        const sort01 = Math.max(0, Math.min(1, sortWithinFloor / MAX_SORT_WITHIN_FLOOR_GROUP));
        renderOrder = motionAboveTokensOrder(floorIndex, Math.round(sort01 * 49));
      } else if (isOverhead) {
        renderOrder = tileOverheadOrder(floorIndex, sortWithinFloor);
      } else {
        renderOrder = tileAlbedoOrder(floorIndex, sortWithinFloor);
      }

      // Create mesh immediately with null texture (invisible until loaded).
      this._addTileMesh(tileId, floorIndex, null, centerX, centerY, z, tileW, tileH, rotation, alpha, renderOrder, isOverhead, roofShadowCaster, cloudShadowBlockerEnabled);

      // Load texture via THREE.TextureLoader — HTML <img>, straight alpha.
      this._loader.load(src, (tex) => {
        this._configureTileAlbedoTexture(tex);
        const entry = this._tiles.get(tileId);
        if (entry) {
          entry.material.map = tex;
          entry.material.needsUpdate = true;
          log.debug(`FloorRenderBus: texture loaded for tile ${tileId} (floor ${floorIndex})`);
        }
      }, undefined, (err) => {
        log.warn(`FloorRenderBus: failed to load texture for tile ${tileId}: ${src}`, err);
      });

      tileCount++;
    }

    // Diagnostic: log overhead tile assignment so we can spot mis-classified tiles.
    const overheadDiag = sortedTileDocs
      .filter(td => this._isOverheadForBusTile(td, td?.id ?? td?._id))
      .map(td => {
        const fi = this._resolveFloorIndex(td, floors);
        return { id: td.id, floor: fi, src: (td.texture?.src ?? td.img ?? '').split('/').pop() };
      });
    if (overheadDiag.length > 0) {
      log.info(`FloorRenderBus: ${overheadDiag.length} overhead tiles:`, overheadDiag);
    }
    // Ensure any entries created during populate() respect the current floor slice.
    // setVisibleFloors() may have been called before populate completed.
    this._applyTileVisibility();
    log.info(`FloorRenderBus populated: ${tileCount} tiles (${floors.length} floors)`, floorCounts);
  }

  /**
   * Render the bus scene to the given target (or screen if null).
   * Uses the main perspective camera for correct world-space projection.
   *
   * Saves and restores renderer state (autoClear, clearColor, renderTarget)
   * so the rest of the render loop is not affected.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {import('three').WebGLRenderTarget|null} [target=null] - Render target, or null for screen.
   */
  renderTo(renderer, camera, target = null) {
    if (!this._initialized || !this._scene) return;
    const THREE = window.THREE;

    // FINAL GUARD: enforce floor-slice visibility immediately before draw.
    // Some async/runtime paths can flip node.visible after earlier floor updates.
    this._applyTileVisibility();
    this._renderToCalls += 1;
    this._lastRenderToAtMs = Date.now();
    const preRenderLeakKeys = [];
    let preRenderLeakCount = 0;
    for (const [tileId, entry] of this._tiles) {
      if (String(tileId).startsWith('__')) continue;
      const fi = Number(entry?.floorIndex);
      if (!Number.isFinite(fi) || fi <= this._visibleMaxFloorIndex) continue;
      const node = entry?.root || entry?.mesh;
      if (node?.visible === true) {
        preRenderLeakCount += 1;
        if (preRenderLeakKeys.length < 40) preRenderLeakKeys.push(String(tileId));
      }
    }
    this._lastPreRenderLeakCount = preRenderLeakCount;
    this._lastPreRenderLeakKeys = preRenderLeakKeys;

    // Save renderer state.
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor     = renderer.getClearColor(new THREE.Color());
    const prevAlpha     = renderer.getClearAlpha();

    // Save camera layer mask and enable all floor layers + layer 0.
    // Tokens and tiles are assigned to floor layers (1-19) by FloorLayerManager,
    // so we must enable those layers to render them. Layer 0 is kept for legacy
    // compatibility. OVERLAY_THREE_LAYER is rendered in a late pass by
    // FloorCompositor so UI can bypass post-processing.
    const prevLayerMask = camera.layers.mask;
    camera.layers.enable(0);
    // Enable all floor layers (1-19) so tokens/tiles assigned to floors are visible.
    for (let i = 1; i <= 19; i++) {
      camera.layers.enable(i);
    }

    // Render with a black clear so no white flash while textures load.
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this._scene, camera);

    // Restore camera layer mask and renderer state.
    camera.layers.mask = prevLayerMask;
    renderer.autoClear = prevAutoClear;
    // CRITICAL (V2): Do not restore a transparent clearAlpha.
    // A clearAlpha of 0 makes the Three canvas effectively transparent and can
    // reveal underlying stale content as a camera-locked "ghost" overlay.
    renderer.setClearColor(prevColor, 1);
    if (typeof renderer.setClearAlpha === 'function') {
      try { renderer.setClearAlpha(1); } catch (_) {}
    }
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Convenience: render the bus scene directly to the screen framebuffer.
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   */
  renderToScreen(renderer, camera) {
    this.renderTo(renderer, camera, null);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /**
   * Remove all meshes and dispose GPU resources. Does not destroy the bus.
   */
  clear() {
    if (!this._scene) return;
    
    log.info(`[V2 DEBUG] FloorRenderBus.clear() called - scene has ${this._scene.children.length} children before clear`);
    
    for (const { mesh, material, root } of this._tiles.values()) {
      try {
        if (mesh?.parent) {
          mesh.parent.remove(mesh);
        } else {
          this._scene.remove(mesh);
        }
      } catch (_) {}
      try {
        if (root?.parent) {
          root.parent.remove(root);
        }
      } catch (_) {}

      // Tiles and some overlays are Mesh instances with materials/geometries.
      // Others (e.g. quarks BatchedRenderer) are Object3D renderers with no
      // `material` or `geometry`. Treat those as effect-owned and only detach.
      try {
        const mat = material ?? mesh?.material ?? null;
        if (mat) {
          // Support arrays for multi-material meshes.
          const mats = Array.isArray(mat) ? mat : [mat];
          for (const m of mats) {
            if (!m) continue;
            try { m.map?.dispose?.(); } catch (_) {}
            try { m.alphaMap?.dispose?.(); } catch (_) {}
            try { m.dispose?.(); } catch (_) {}
          }
        }
      } catch (_) {}

      try {
        const geom = mesh?.geometry ?? null;
        if (geom && typeof geom.dispose === 'function') {
          geom.dispose();
        }
      } catch (_) {}
    }
    this._tiles.clear();
    
    // Remove background meshes and effect overlays, but preserve tokens/doors.
    // Tokens are added by TokenManager and should not be destroyed when
    // repopulating tiles. Only remove objects with tileId starting with '__'
    // (background planes, effect overlays) that are not tracked in _tiles.
    const childrenToRemove = [];
    let tokenCount = 0;
    let otherCount = 0;
    
    for (const child of this._scene.children) {
      const userData = child?.userData;
      const type = userData?.type;
      const name = child?.name || 'unnamed';

      // Preserve long-lived, effect-owned objects that explicitly opt out
      // of bus clear (for example PlayerLightEffectV2 batch/group objects).
      if (userData?.preserveOnBusClear === true) {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving persistent effect object: ${name}`);
        continue;
      }
      
      // Preserve tokens (type === 'token')
      if (type === 'token') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving token: ${name} (type=${type})`);
        continue;
      }
      // Preserve door meshes managed by DoorMeshManager.
      if (type === 'doorMesh') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving door mesh: ${name} (type=${type})`);
        continue;
      }
      // Preserve transient interaction overlays (path previews, gizmos, etc.)
      // managed by InteractionManager.
      if (type === 'interactionOverlay') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving interaction overlay: ${name} (type=${type})`);
        continue;
      }
      // Preserve particle systems and other effect objects
      if (child.name?.startsWith('Token_')) {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving token by name: ${name}`);
        continue;
      }
      // Remove everything else (background planes, old effect overlays)
      otherCount++;
      childrenToRemove.push(child);
    }
    
    for (const child of childrenToRemove) {
      this._scene.remove(child);
    }
    
    log.info(`[V2 DEBUG] FloorRenderBus.clear() complete - preserved ${tokenCount} tokens, removed ${otherCount} other objects, ${this._scene.children.length} children remain`);
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    this.clear();
    this._scene = null;
    this._loader = null;
    this._initialized = false;
    log.info('FloorRenderBus disposed');
  }

  // ── Visibility ─────────────────────────────────────────────────────────────────

  /**
   * Temporarily show upper-floor roof shadow casters that are normally hidden
   * while the camera is on a lower floor (`floorIndex > _visibleMaxFloorIndex`),
   * so OverheadShadowsEffectV2 can render them into ROOF_LAYER RTs.
   * Always pair with {@link #endOverheadShadowCaptureReveal} (e.g. try/finally).
   *
   * @returns {Array<{node: import('three').Object3D, wasVisible: boolean}>} snapshot
   */
  beginOverheadShadowCaptureReveal() {
    const snapshot = [];
    if (!this._initialized) return snapshot;
    const maxV = Number.isFinite(Number(this._visibleMaxFloorIndex))
      ? Number(this._visibleMaxFloorIndex)
      : Infinity;
    for (const [tileId, entry] of this._tiles) {
      if (String(tileId).startsWith('__')) continue;
      if (!entry?.roofShadowCaster) continue;
      if (!(entry.floorIndex > maxV)) continue;
      const node = entry.root || entry.mesh;
      if (!node) continue;
      // Capture current state before forcing visible
      snapshot.push({ node, wasVisible: node.visible });
      node.visible = true;
    }
    return snapshot;
  }

  /**
   * Restore bus tile visibility after overhead shadow capture.
   *
   * @param {Array<{node: import('three').Object3D, wasVisible: boolean}>} snapshot
   */
  endOverheadShadowCaptureReveal(snapshot = []) {
    if (!this._initialized) return;
    // Restore each node to its captured state
    for (const entry of snapshot) {
      if (entry?.node) entry.node.visible = entry.wasVisible;
    }
  }

  _applyTileVisibility() {
    if (!this._initialized) return;
    this._applyTileVisibilityCalls += 1;
    this._lastApplyVisibilityAtMs = Date.now();
    let preApplyLeakCount = 0;
    const preApplyLeakKeys = [];

    for (const [tileId, entry] of this._tiles) {
      const node = entry?.root || entry?.mesh;
      if (!node) continue;

      // Background planes and internal effect overlays stay visible.
      if (tileId.startsWith('__')) {
        node.visible = true;
        continue;
      }

      const inVisibleFloorSlice = entry.floorIndex <= this._visibleMaxFloorIndex;
      if (!tileId.startsWith('__') && !inVisibleFloorSlice && node.visible === true) {
        preApplyLeakCount += 1;
        if (preApplyLeakKeys.length < 40) preApplyLeakKeys.push(String(tileId));
      }
      node.visible = inVisibleFloorSlice && !this._suppressTileAlbedoForEditing;
    }
    this._lastPreApplyLeakCount = preApplyLeakCount;
    this._lastPreApplyLeakKeys = preApplyLeakKeys;
  }

  /**
   * Compute whether a bus entry should currently be visible for floor slicing.
   * Internal/background entries (`__*`) always remain visible.
   *
   * @param {string} key
   * @param {{floorIndex:number}|null} entry
   * @returns {boolean}
   * @private
   */
  _computeEntryVisibleForSlice(key, entry) {
    if (String(key || '').startsWith('__')) return true;
    const floorIndex = Number(entry?.floorIndex);
    if (!Number.isFinite(floorIndex)) return !this._suppressTileAlbedoForEditing;
    return floorIndex <= this._visibleMaxFloorIndex && !this._suppressTileAlbedoForEditing;
  }

  /**
   * Hide/show bus tile albedo during native tile editing.
   *
   * When true, only PIXI tile visuals should be visible to avoid mixed
   * renderer contention (PIXI selection box vs Three albedo mesh).
   * @param {boolean} suppressed
   */
  setTileEditingSuppressed(suppressed) {
    const next = suppressed === true;
    if (this._suppressTileAlbedoForEditing === next) return;
    this._suppressTileAlbedoForEditing = next;
    this._applyTileVisibility();
  }

  /**
   * Show tile meshes up to and including `maxFloorIndex`, hide the rest.
   * Background planes (solid colour + scene image) are always visible.
   *
   * Call this whenever the active floor changes so upper-floor tiles are
   * hidden when the player is on a lower floor.
   *
   * @param {number} maxFloorIndex - Highest floor index to show (inclusive).
   *   Pass Infinity to show all floors.
   */
  setVisibleFloors(maxFloorIndex) {
    if (!this._initialized) return;
    this._visibleMaxFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : Infinity;
    this._setVisibleFloorsCalls += 1;
    this._lastSetVisibleMaxFloorIndex = this._visibleMaxFloorIndex;
    this._applyTileVisibility();
    log.debug(`FloorRenderBus: showing floors 0–${maxFloorIndex}`);
  }

  /**
   * Sync runtime tile visual state from TileManager into bus tile materials.
   *
   * V2 renders tile albedo from FloorRenderBus meshes, while hover/occlusion
   * fade animation is currently authored on TileManager sprites. Mirror the
   * effective sprite opacity onto bus materials each frame so overhead hover-hide
   * is visible in the final V2 render.
   */
  syncRuntimeTileState() {
    if (!this._initialized) return;
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager || typeof tileManager.getTileSpriteData !== 'function') return;

    for (const [tileId, entry] of this._tiles) {
      if (!entry?.material) continue;
      // Skip internal background/effect entries.
      if (tileId.startsWith('__')) continue;
      // Tree/Bush V2 shaders output premultiplied RGB + manage their own fringes; do not
      // force floor-based premultipliedAlpha (would break ground-floor blending).
      if (tileId.endsWith('_tree') || tileId.endsWith('_bush')) continue;

      const sourceTileId = entry.attachedToTileId || tileId;
      const data = tileManager.getTileSpriteData(sourceTileId);
      const spriteOpacity = Number(data?.sprite?.material?.opacity);
      const fallbackAlpha = Number.isFinite(data?.tileDoc?.alpha) ? data.tileDoc.alpha : 1.0;
      const targetOpacity = Number.isFinite(spriteOpacity) ? spriteOpacity : fallbackAlpha;

      const currentOpacity = Number(entry.material.opacity);
      if (!Number.isFinite(currentOpacity) || Math.abs(currentOpacity - targetOpacity) > 0.0005) {
        entry.material.opacity = targetOpacity;
      }
      // premultipliedAlpha and alphaTest are structural material properties that
      // trigger a full shader recompile when changed (needsUpdate = true). They
      // must only be set during tile creation/upsert, NOT per-frame. Flipping
      // alphaTest between 0 and UPPER_FLOOR_ALPHA_CUTOFF each frame (when
      // opacity oscillates near 0.95 during hover fades) causes visible flicker
      // from repeated shader recompilation. The values are stable by floorIndex,
      // which never changes for a given tile.

      // Shader overlays (e.g. FluidEffectV2) can carry their own tile-opacity
      // uniform path. Keep it in sync with the same runtime tile fade.
      const uniforms = entry.material.uniforms;
      if (uniforms?.uTileOpacity) {
        uniforms.uTileOpacity.value = targetOpacity;
      }
    }
  }

  /**
   * Incrementally create/update a single bus tile from a TileDocument.
   *
   * This is used by TileManager's live refresh/update hooks so V2 albedo tiles
   * track manual Foundry tile edits (drag/create/update) without requiring a
   * full bus repopulate.
   *
   * @param {object} tileDoc
   * @param {object} [options]
   * @param {object|null} [options.foundrySceneData]
   * @returns {boolean}
   */
  upsertTileFromDocument(tileDoc, options = {}) {
    if (!this._initialized || !this._scene || !tileDoc) return false;

    const tileId = tileDoc.id ?? tileDoc._id;
    if (!tileId) return false;

    const sceneData = options.foundrySceneData
      ?? window.MapShine?.sceneComposer?.foundrySceneData
      ?? null;
    if (!sceneData) return false;

    const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const worldH = Number(sceneData?.height) || 0;
    const tileW = Number(tileDoc?.width) || 0;
    const tileH = Number(tileDoc?.height) || 0;
    const centerX = (Number(tileDoc?.x) || 0) + tileW / 2;
    const centerY = worldH - ((Number(tileDoc?.y) || 0) + tileH / 2);
    const z = GROUND_Z + floorIndex * Z_PER_FLOOR;
    const alpha = typeof tileDoc.alpha === 'number' ? tileDoc.alpha : 1;
    const rotation = typeof tileDoc.rotation === 'number'
      ? (tileDoc.rotation * Math.PI) / 180
      : 0;
    const isOverhead = this._isOverheadForBusTile(tileDoc, tileId);
    const roofShadowCaster = this._usesRoofShadowCaptureLayer(tileDoc, floorIndex, isOverhead);
    const cloudShadowBlockerEnabled = this._shouldTileBlockCloudShadows(tileDoc, roofShadowCaster);
    const motionRenderAboveTokens = !!window.MapShine?.tileMotionManager?.getTileConfig?.(tileId)?.renderAboveTokens;

    const sortWithinFloor = this._computeSortWithinFloor(tileDoc);
    let renderOrder;
    if (motionRenderAboveTokens) {
      const sort01 = Math.max(0, Math.min(1, sortWithinFloor / MAX_SORT_WITHIN_FLOOR_GROUP));
      renderOrder = motionAboveTokensOrder(floorIndex, Math.round(sort01 * 49));
    } else if (isOverhead) {
      renderOrder = tileOverheadOrder(floorIndex, sortWithinFloor);
    } else {
      renderOrder = tileAlbedoOrder(floorIndex, sortWithinFloor);
    }

    let entry = this._tiles.get(tileId);
    if (!entry) {
      this._addTileMesh(tileId, floorIndex, null, centerX, centerY, z, tileW, tileH, rotation, alpha, renderOrder, isOverhead, roofShadowCaster, cloudShadowBlockerEnabled);
      entry = this._tiles.get(tileId);
      if (!entry) return false;
    }

    const root = entry.root || entry.mesh?.parent || null;
    if (root) {
      root.position.set(centerX, centerY, z);
      if (root.rotation) root.rotation.z = rotation;
      root.userData = root.userData || {};
      root.userData.isOverhead = isOverhead;
      root.userData.floorIndex = floorIndex;
    }

    if (entry.mesh) {
      const params = entry.mesh.geometry?.parameters || {};
      const currentW = Number(params.width);
      const currentH = Number(params.height);
      if (!Number.isFinite(currentW) || !Number.isFinite(currentH)
          || Math.abs(currentW - tileW) > 0.001 || Math.abs(currentH - tileH) > 0.001) {
        try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
        entry.mesh.geometry = new window.THREE.PlaneGeometry(tileW, tileH);
      }

      entry.mesh.renderOrder = renderOrder;
      entry.mesh.layers.set(0);
      if (roofShadowCaster) {
        entry.mesh.layers.enable(20);
        if (cloudShadowBlockerEnabled) entry.mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        else entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        entry.mesh.layers.disable(20);
        entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
      entry.mesh.updateMatrix?.();
    }

    if (root) {
      root.layers.set(0);
      if (roofShadowCaster) {
        root.layers.enable(20);
        if (cloudShadowBlockerEnabled) root.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        else root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        root.layers.disable(20);
        root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
      root.updateMatrix?.();
    }

    entry.roofShadowCaster = !!roofShadowCaster;

    if (entry.material) {
      entry.material.opacity = alpha;
      entry.material.alphaTest = (floorIndex > 0 && Number(alpha) >= 0.95)
        ? UPPER_FLOOR_ALPHA_CUTOFF
        : 0.0;
      entry.material.transparent = true;
      entry.material.premultipliedAlpha = floorIndex > 0;
      entry.material.needsUpdate = true;
    }

    entry.floorIndex = floorIndex;
    const prevSrc = entry.textureSrc || '';
    entry.textureSrc = src;
    this._tiles.set(tileId, entry);

    // IMPORTANT: upserts can happen after setVisibleFloors() (live edits, hooks).
    // Enforce floor-slice visibility immediately so upper-floor tiles do not leak
    // into lower-floor views until the next floor-change event.
    const node = entry.root || entry.mesh || null;
    if (node) {
      node.visible = this._computeEntryVisibleForSlice(tileId, entry);
    }

    if (src && prevSrc !== src) {
      this._loadTileTextureIntoEntry(tileId, src, floorIndex);
    }

    return true;
  }

  /**
   * Remove one bus tile entry (incremental path used by TileManager delete).
   * @param {string} tileId
   */
  removeTile(tileId) {
    if (!tileId) return;
    const entry = this._tiles.get(tileId);
    if (!entry) return;

    try {
      if (entry.root?.parent) entry.root.parent.remove(entry.root);
      else if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
      else this._scene?.remove?.(entry.mesh);
    } catch (_) {
    }

    try { entry.mesh?.geometry?.dispose?.(); } catch (_) {}
    try { entry.material?.map?.dispose?.(); } catch (_) {}
    try { entry.material?.dispose?.(); } catch (_) {}

    this._tiles.delete(tileId);
  }

  /**
   * Sync bus tile/overlay opacity to static tile document alpha.
   *
   * Used before overhead shadow capture so shadow masks remain stable even when
   * runtime hover-hide fades are active on the visible albedo/effect pass.
   */
  syncStaticTileAlphaState() {
    if (!this._initialized) return;
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager || typeof tileManager.getTileSpriteData !== 'function') return;

    for (const [tileId, entry] of this._tiles) {
      if (!entry?.material) continue;
      if (tileId.startsWith('__')) continue;
      if (tileId.endsWith('_tree') || tileId.endsWith('_bush')) continue;

      const sourceTileId = entry.attachedToTileId || tileId;
      const data = tileManager.getTileSpriteData(sourceTileId);
      const staticAlphaRaw = Number(data?.tileDoc?.alpha);
      const staticAlpha = Number.isFinite(staticAlphaRaw) ? staticAlphaRaw : 1.0;

      const currentOpacity = Number(entry.material.opacity);
      if (!Number.isFinite(currentOpacity) || Math.abs(currentOpacity - staticAlpha) > 0.0005) {
        entry.material.opacity = staticAlpha;
      }
      const desiredAlphaTest = (entry.floorIndex > 0 && staticAlpha >= 0.95)
        ? UPPER_FLOOR_ALPHA_CUTOFF
        : 0.0;
      const desiredPremultipliedAlpha = entry.floorIndex > 0;
      if (entry.material.premultipliedAlpha !== desiredPremultipliedAlpha) {
        entry.material.premultipliedAlpha = desiredPremultipliedAlpha;
        entry.material.needsUpdate = true;
      }
      if (Math.abs(Number(entry.material.alphaTest ?? 0) - desiredAlphaTest) > 0.0001) {
        entry.material.alphaTest = desiredAlphaTest;
        entry.material.needsUpdate = true;
      }

      const uniforms = entry.material.uniforms;
      if (uniforms?.uTileOpacity) {
        uniforms.uTileOpacity.value = staticAlpha;
      }
    }
  }

  // ── Floor Mask Rendering ────────────────────────────────────────────────────

  /**
   * Render only tiles at `floorIndex >= minFloorIndex` to a target RT.
   * Used to generate an upper-floor occlusion mask for the water effect:
   * wherever the mask has non-zero alpha, ground-floor water is hidden.
   *
   * Temporarily toggles tile visibility, renders, then restores the original
   * visibility state so the main render loop is unaffected.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {number} minFloorIndex - Minimum floor index to include in the mask
   * @param {import('three').WebGLRenderTarget} target - Render target for the mask
   * @param {object} [options]
   * @param {boolean} [options.includeHiddenAboveFloors=false] - When true, temporarily
   *   include tiles hidden only by floor slicing (`floorIndex > _visibleMaxFloorIndex`).
   *   Useful for cross-floor occlusion masks (e.g. cloud shadows under upper floors).
   * @param {boolean} [options.roofCastersOnly=false] - When true, include only tiles
   *   flagged as roof/overhead occluders (`entry.roofShadowCaster`). This avoids
   *   full-screen occlusion from non-occluding upper-floor albedo layers.
   * @param {boolean} [options.includeBackground=false] - When true, include
   *   `__bg_image__*` entries using their stored floorIndex.
   * @param {boolean} [options.backgroundOnly=false] - When true, include only
   *   `__bg_image__*` entries (upper-level background alpha) and exclude tiles.
   */
  renderFloorMaskTo(renderer, camera, minFloorIndex, target, options = {}) {
    if (!this._initialized || !this._scene) return;
    const THREE = window.THREE;
    const includeHiddenAboveFloors = options?.includeHiddenAboveFloors === true;
    const roofCastersOnly = options?.roofCastersOnly === true;
    const includeBackground = options?.includeBackground === true;
    const backgroundOnly = options?.backgroundOnly === true;

    // Save each tile's current visibility so we can restore it after.
    const savedVisibility = new Map();
    const savedMaterialState = new Map();
    for (const [tileId, entry] of this._tiles) {
      const node = entry?.root || entry?.mesh;
      if (!node) continue;
      savedVisibility.set(tileId, node.visible);

      // Background planes are optional contributors. Internal effect overlays
      // (`__*`, except `__bg_image__*` when includeBackground=true) stay hidden.
      if (tileId.startsWith('__')) {
        const isBgImage = tileId.startsWith('__bg_image__');
        if (!isBgImage || !includeBackground) {
          node.visible = false;
          continue;
        }
        const mat = entry.material;
        const hasMap = !!mat?.map;
        const isBelowFloor = entry.floorIndex < minFloorIndex;
        if (isBelowFloor || !hasMap) {
          node.visible = false;
          continue;
        }
        node.visible = true;
        savedMaterialState.set(tileId, {
          transparent: mat.transparent,
          opacity: mat.opacity,
          color: mat.color ? mat.color.clone() : null,
          map: mat.map,
          depthTest: mat.depthTest,
          depthWrite: mat.depthWrite,
          blending: mat.blending,
        });
        if (mat.color) mat.color.set(1, 1, 1);
        mat.transparent = true;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.blending = THREE.NormalBlending;
        mat.needsUpdate = true;
        continue;
      }

      // Only tiles AT or ABOVE minFloorIndex should contribute to the occluder.
      // This mask is used to suppress ground-floor water under the currently
      // viewed floor (upper-floor) geometry. Including lower floors here would
      // make the occluder alpha become 1 everywhere (because floor 0 typically
      // covers the entire map), which would incorrectly suppress ALL water.

      const mat = entry.material;
      const hasMap = !!mat?.map;
      const isBelowFloor = entry.floorIndex < minFloorIndex;
      const includeAsOccluder = !roofCastersOnly || !!entry.roofShadowCaster;

      if (backgroundOnly || isBelowFloor || !includeAsOccluder) {
        // Below minFloorIndex: do not render into the occluder mask.
        node.visible = false;
      } else {
        // At or above minFloorIndex: skip tiles without textures (avoid opaque black).
        if (!hasMap) {
          node.visible = false;
          continue;
        }
        // Respect the node's current visibility by default. Optionally reveal
        // tiles hidden ONLY by floor slicing so above-floor geometry can still
        // contribute to cross-floor occlusion masks.
        const wasVisible = savedVisibility.get(tileId) === true;
        const hiddenByFloorSlice = entry.floorIndex > this._visibleMaxFloorIndex;
        const forceRevealForMask = includeHiddenAboveFloors && hiddenByFloorSlice;
        node.visible = wasVisible || forceRevealForMask;
        if (!node.visible) continue;
        // Render with real texture alpha so transparent areas are genuine openings.
        savedMaterialState.set(tileId, {
          transparent: mat.transparent,
          opacity: mat.opacity,
          color: mat.color ? mat.color.clone() : null,
          map: mat.map,
          depthTest: mat.depthTest,
          depthWrite: mat.depthWrite,
          blending: mat.blending,
        });
        if (mat.color) mat.color.set(1, 1, 1);
        mat.transparent = true;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.blending = THREE.NormalBlending;
        mat.needsUpdate = true;
      }
    }

    // Save and configure renderer state.
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevLayerMask = camera.layers.mask;
    camera.layers.enable(0);

    // Clear to transparent black — alpha=0 means "no upper floor coverage".
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(this._scene, camera);

    // Restore camera layer mask and renderer state.
    camera.layers.mask = prevLayerMask;
    renderer.autoClear = prevAutoClear;
    // CRITICAL (V2): Do not restore a transparent clearAlpha.
    // This pass intentionally clears its TARGET to alpha=0, but the renderer's
    // default clear alpha must remain opaque for subsequent screen blits.
    renderer.setClearColor(prevColor, 1);
    if (typeof renderer.setClearAlpha === 'function') {
      try { renderer.setClearAlpha(1); } catch (_) {}
    }
    renderer.setRenderTarget(prevTarget);

    // Restore original tile visibility.
    for (const [tileId, wasVisible] of savedVisibility) {
      const entry = this._tiles.get(tileId);
      const node = entry?.root || entry?.mesh;
      if (node) node.visible = wasVisible;
    }

    // Restore original material state.
    for (const [tileId, st] of savedMaterialState) {
      const entry = this._tiles.get(tileId);
      const mat = entry?.material;
      if (!mat) continue;
      mat.transparent = st.transparent;
      mat.opacity = st.opacity;
      if (st.color && mat.color) mat.color.copy(st.color);
      if ('map' in st) mat.map = st.map;
      mat.depthTest = st.depthTest;
      mat.depthWrite = st.depthWrite;
      mat.blending = st.blending;
      mat.needsUpdate = true;
    }
  }

  /**
   * Render only tiles with `minFloorIndex <= floorIndex <= maxFloorIndex` to a target RT.
   * Used by FloorDepthBlurEffect to render below-active floors separately from
   * the active floor so per-floor blur can be applied before compositing.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {number} minFloorIndex - Minimum floor index to include (inclusive)
   * @param {number} maxFloorIndex - Maximum floor index to include (inclusive). Pass Infinity for no upper cap.
   * @param {import('three').WebGLRenderTarget} target - Render target
   * @param {object} [options]
   * @param {boolean} [options.includeBackground=true] - Whether to include __bg_* background planes
   * @param {boolean} [options.filterBackgroundByFloor=false] - When true, __bg_image__* planes
   *   are culled by `floorIndex` vs `[minFloorIndex,maxFloorIndex]` and `__bg_solid__` is
   *   always skipped so per-level slices preserve authored transparency holes for
   *   LevelCompositePass (solid underlay would force blended alpha to 1).
   * @param {boolean} [options.clearBeforeRender=true] - Whether to clear target before rendering this range
   * @param {number} [options.clearAlpha=1] - Clear alpha (0 for transparent, 1 for opaque)
   * @param {number} [options.clearColor=0x000000] - Clear colour hex
   */
  renderFloorRangeTo(renderer, camera, minFloorIndex, maxFloorIndex, target, options = {}) {
    if (!this._initialized || !this._scene) return;
    const THREE = window.THREE;
    const {
      includeBackground = true,
      clearBeforeRender = true,
      clearAlpha = 1,
      clearColor = 0x000000,
      filterBackgroundByFloor = false,
    } = options;

    // Save each tile's current visibility so we can restore it after.
    //
    // IMPORTANT — visibility is set by floor-range membership here, NOT by
    // ANDing with the tile's current `wasVisible`. The per-level pipeline
    // renders EVERY level's RT in a loop, but the bus's slice state
    // (`setVisibleFloors`) reflects only the currently-viewed floor: entries
    // on non-viewed floors are sliced to `visible=false`. If we ANDed with
    // that, every per-level RT except the viewed one would end up empty —
    // the exact "lower floor RT is entirely transparent" symptom we were
    // chasing. Render visibility per-call must depend only on:
    //   1. floor-range membership vs [minFloorIndex, maxFloorIndex]
    //   2. per-call `includeBackground` / `filterBackgroundByFloor` policy
    //   3. the global tile-albedo editing suppression flag
    // All other "wasVisible" state (user toggles, effect gating, warmups)
    // is a view-slice concern and is faithfully restored after the render.
    const savedVisibility = new Map();
    for (const [tileId, entry] of this._tiles) {
      const node = entry?.root || entry?.mesh;
      if (!node) continue;
      savedVisibility.set(tileId, node.visible === true);

      if (tileId.startsWith('__')) {
        if (tileId === '__bg_solid__') {
          // Include the opaque world-fill only when floor 0 is in range so
          // upper-floor RTs preserve authored transparency.
          const showSolid = includeBackground
            && (!filterBackgroundByFloor || minFloorIndex <= 0);
          node.visible = showSolid;
          continue;
        }
        if (filterBackgroundByFloor && tileId.startsWith('__bg_image__')) {
          const bgFloorIdx = Number(entry.floorIndex);
          const inRange = Number.isFinite(bgFloorIdx) && bgFloorIdx >= minFloorIndex && bgFloorIdx <= maxFloorIndex;
          node.visible = includeBackground && inRange;
        } else {
          // Legacy path (single-RT draw): all bg planes follow includeBackground.
          node.visible = includeBackground;
        }
        continue;
      }

      const inRange = entry.floorIndex >= minFloorIndex && entry.floorIndex <= maxFloorIndex;
      node.visible = inRange && !this._suppressTileAlbedoForEditing;
    }

    // Save and configure renderer state.
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor     = renderer.getClearColor(new THREE.Color());
    const prevAlpha     = renderer.getClearAlpha();
    const prevLayerMask = camera.layers.mask;
    camera.layers.enable(0);
    for (let i = 1; i <= 19; i++) camera.layers.enable(i);

    renderer.setRenderTarget(target);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.autoClear = !!clearBeforeRender;
    renderer.render(this._scene, camera);

    // Restore camera and renderer state.
    camera.layers.mask = prevLayerMask;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevColor, prevAlpha);
    if (typeof renderer.setClearAlpha === 'function') {
      try { renderer.setClearAlpha(prevAlpha); } catch (_) {}
    }
    renderer.setRenderTarget(prevTarget);

    // Restore original tile visibility.
    for (const [tileId, wasVisible] of savedVisibility) {
      const entry = this._tiles.get(tileId);
      const node = entry?.root || entry?.mesh;
      if (node) node.visible = wasVisible;
    }
  }

  // ── Effect Overlay API ──────────────────────────────────────────────────────

  /**
   * Add an effect overlay mesh to the bus scene. The mesh participates in the
   * same floor visibility system as albedo tiles — setVisibleFloors() will
   * automatically show/hide it based on floorIndex.
   *
   * @param {string} key - Unique key for this overlay (e.g. `${tileId}_specular`)
   * @param {import('three').Mesh} mesh - The overlay mesh (already configured with material, position, etc.)
   * @param {number} floorIndex - Floor this overlay belongs to
   */
  addEffectOverlay(key, mesh, floorIndex) {
    if (!this._initialized || !this._scene) return;
    // Remove existing overlay with the same key to avoid duplicates.
    if (this._tiles.has(key)) {
      this.removeEffectOverlay(key);
    }
    this._scene.add(mesh);
    const entry = { mesh, material: mesh.material, floorIndex, root: null, attachedToTileId: null };
    this._tiles.set(key, entry);
    mesh.visible = this._computeEntryVisibleForSlice(key, entry);
    log.debug(`FloorRenderBus: added effect overlay '${key}' (floor ${floorIndex})`);
  }

  /**
   * Attach an overlay mesh under a tile's transform root so it inherits runtime
   * tile motion (rotation/orbit/etc.) automatically.
   *
   * @param {string} tileId
   * @param {string} key - Unique overlay key (e.g. `${tileId}_specular`)
   * @param {import('three').Object3D} mesh
   * @param {number} floorIndex
   * @returns {boolean}
   */
  addTileAttachedOverlay(tileId, key, mesh, floorIndex) {
    if (!this._initialized || !this._scene || !tileId || !key || !mesh) return false;

    const tileEntry = this._tiles.get(tileId);
    if (!tileEntry) return false;

    if (this._tiles.has(key)) {
      this.removeEffectOverlay(key);
    }

    const parent = tileEntry.root || tileEntry.mesh?.parent || this._scene;
    if (!parent) return false;
    parent.add(mesh);
    const entry = {
      mesh,
      material: mesh.material,
      floorIndex,
      root: null,
      attachedToTileId: tileId
    };
    this._tiles.set(key, entry);
    mesh.visible = this._computeEntryVisibleForSlice(key, entry);
    log.debug(`FloorRenderBus: added tile-attached overlay '${key}' -> ${tileId} (floor ${floorIndex})`);
    return true;
  }

  /**
   * Remove an effect overlay mesh from the bus scene and dispose its resources.
   *
   * @param {string} key - The key used when the overlay was added
   */
  removeEffectOverlay(key) {
    if (!this._scene) return;
    const entry = this._tiles.get(key);
    if (!entry) return;
    if (entry.mesh?.parent) {
      entry.mesh.parent.remove(entry.mesh);
    } else {
      this._scene.remove(entry.mesh);
    }
    // Don't dispose material/geometry here — the effect owns those resources
    // and disposes them in its own clear()/dispose() methods.
    this._tiles.delete(key);
    log.debug(`FloorRenderBus: removed effect overlay '${key}'`);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve overhead classification for bus tiles.
   *
   * In addition to native/levels overhead docs, tile-motion can force tiles into
   * roof-style draw ordering via renderAboveTokens. Mirror that flag here so V2
   * bus renderOrder/layers stay aligned with TileManager behavior.
   *
   * @param {object} tileDoc
   * @param {string|null} tileId
   * @returns {boolean}
   * @private
   */
  _getMsaLevelRole(tileDoc) {
    return String(tileDoc?.flags?.['map-shine-advanced']?.levelRole ?? '')
      .trim()
      .toLowerCase();
  }

  /**
   * Upper-floor walkable art (Levels `levelRole: floor`) is not "overhead" for
   * token sorting, but it should still stamp ROOF_LAYER for overhead shadows
   * when it reads as the deck above a lower view. Opt-in without levelRole via
   * tile flag `floorCastsOverheadShadow`.
   * @param {object} tileDoc
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _isUpperFloorSlabRoofCaster(tileDoc, floorIndex) {
    if (!(floorIndex > 0)) return false;
    if (this._getMsaLevelRole(tileDoc) === 'floor') return true;
    const moduleId = 'map-shine-advanced';
    const raw = tileDoc?.getFlag?.(moduleId, 'floorCastsOverheadShadow')
      ?? tileDoc?.flags?.[moduleId]?.floorCastsOverheadShadow;
    return raw === true;
  }

  /**
   * @param {object} tileDoc
   * @param {number} floorIndex
   * @param {boolean} isOverheadForBus
   * @returns {boolean}
   * @private
   */
  _usesRoofShadowCaptureLayer(tileDoc, floorIndex, isOverheadForBus) {
    return !!isOverheadForBus || this._isUpperFloorSlabRoofCaster(tileDoc, floorIndex);
  }

  _isOverheadForBusTile(tileDoc, tileId = null) {
    // Keep in sync with TileManager naturalOverhead / levelRole overrides so V2
    // bus renderOrder bands (FLOOR_OVERHEAD) match sprite-side classification.
    // Otherwise ceiling-tagged tiles stay in the albedo band and door meshes
    // draw on top of roofs.
    const msaRole = this._getMsaLevelRole(tileDoc);
    if (msaRole === 'ceiling') return true;
    if (msaRole === 'floor') return false;

    const resolvedTileId = tileId ?? tileDoc?.id ?? tileDoc?._id ?? null;
    const motionConfig = resolvedTileId
      ? window.MapShine?.tileMotionManager?.getTileConfig?.(resolvedTileId)
      : null;
    const renderAboveTokens = !!motionConfig?.renderAboveTokens;
    return isTileOverhead(tileDoc) || renderAboveTokens;
  }

  /**
   * Determine whether this tile should clip cloud shadows in CloudEffect.
   *
   * @param {object} tileDoc
   * @param {boolean} isOverhead
   * @returns {boolean}
   * @private
   */
  _shouldTileBlockCloudShadows(tileDoc, isOverhead) {
    if (!isOverhead || !tileDoc) return false;
    const moduleId = 'map-shine-advanced';
    const getFlag = (key) => tileDoc.getFlag?.(moduleId, key) ?? tileDoc.flags?.[moduleId]?.[key];
    const isWeatherRoof = !!getFlag('overheadIsRoof');
    if (isWeatherRoof) return false;
    const cloudShadowsEnabledRaw = getFlag('cloudShadowsEnabled');
    const cloudShadowsEnabled = (cloudShadowsEnabledRaw === undefined) ? true : !!cloudShadowsEnabledRaw;
    return !cloudShadowsEnabled;
  }

  /**
   * Add a solid-colour plane covering the full world canvas at the lowest Z.
   * Ensures no transparent black shows in padding areas.
   * @param {object} fd - foundrySceneData
   * @private
   */
  _addSolidBackground(fd) {
    const THREE = window.THREE;
    const worldW = fd.width ?? 0;
    const worldH = fd.height ?? 0;
    if (worldW <= 0 || worldH <= 0) return;

    let bgColorInt = 0x999999;
    try {
      bgColorInt = parseInt((fd.backgroundColor || '#999999').replace('#', ''), 16) || 0x999999;
    } catch (_) {}

    const mat = new THREE.MeshBasicMaterial({
      color: bgColorInt,
      depthTest: false,
      depthWrite: false,
    });
    const geom = new THREE.PlaneGeometry(worldW, worldH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_solid';
    mesh.frustumCulled = false;
    // Center of world canvas in Three Y-up space.
    mesh.position.set(worldW / 2, worldH / 2, GROUND_Z - 2);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    this._tiles.set('__bg_solid__', { mesh, material: mat, floorIndex: 0 });
    log.debug(`FloorRenderBus: solid bg plane (${worldW}x${worldH}, #${bgColorInt.toString(16)})`);
  }

  /**
   * Add the scene background image plane at Z just above the solid colour plane.
   * Uses the texture already loaded by SceneComposer — no extra network fetch.
   *
   * The background image is opaque and covers only the scene rect (not padding).
   * SceneComposer's basePlaneMesh uses scale.y=-1 to flip Y; we mirror that here
   * with DoubleSide so the back-face isn't culled.
   *
   * @param {object} fd - foundrySceneData
   * @param {import('three').Texture} texture
   * @private
   */
  _addBackgroundImage(fd, texture, zIndex = 0, key = '__bg_image__') {
    const THREE = window.THREE;
    const sceneW = fd.sceneWidth ?? fd.width ?? 0;
    const sceneH = fd.sceneHeight ?? fd.height ?? 0;
    const worldH = fd.height ?? 0;
    if (sceneW <= 0 || sceneH <= 0) return;

    // Scene rect center in Three Y-up world space.
    const sceneX = fd.sceneX ?? 0;
    const sceneY = fd.sceneY ?? 0;
    const centerX = sceneX + sceneW / 2;
    const centerY = worldH - (sceneY + sceneH / 2);

    // Ensure flipY=false to match SceneComposer's UV convention (Y-flip via
    // scale.y=-1 on the mesh instead of on the texture).
    texture.flipY = false;
    texture.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      // V14 visible-level stacks rely on texture alpha so upper level art can
      // reveal lower levels through cutouts/openings.
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Rely on authored albedo alpha only (Foundry level alphaThreshold is not
      // applied here). alphaTest would fight RGBA holes for per-level composite.
      alphaTest: 0,
      // DoubleSide because scale.y=-1 reverses face winding.
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(sceneW, sceneH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_image';
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, GROUND_Z - 1 + (Number(zIndex) || 0) * 0.01);
    // Negative Y scale to flip the image right-side up (matches basePlaneMesh).
    mesh.scale.set(1, -1, 1);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    // Preserve stack order as floor index so floor-aware mask passes (water occluder)
    // can include only upper visible background layers.
    const bgFloorIndex = Number.isFinite(Number(zIndex)) ? Number(zIndex) : 0;
    this._tiles.set(key, { mesh, material: mat, floorIndex: bgFloorIndex });
    log.info(`FloorRenderBus: bg image plane [${key}] (${sceneW}x${sceneH} at ${centerX},${centerY})`);
  }

  /**
   * Replace the background image texture with a new one (e.g. when switching
   * between V14 levels that have different per-level backgrounds).
   *
   * @param {string} src - New image path to load
   * @param {object} fd  - foundrySceneData (for dimensions)
   */
  swapBackgroundImage(src, fd) {
    if (!this._initialized || !fd) return;
    const scene = globalThis.canvas?.scene ?? null;
    const visibleLayers = getVisibleLevelBackgroundLayers(scene);
    const stack = visibleLayers.map((l) => l.src);
    if (stack.length > 0) {
      this.swapVisibleLevelBackgroundImages(stack, fd);
      return;
    }
    if (!src) return;
    this.swapVisibleLevelBackgroundImages([src], fd);
  }

  /**
   * Replace the entire visible-level background stack.
   *
   * @param {string[]} srcs
   * @param {object} fd
   */
  swapVisibleLevelBackgroundImages(srcs, fd, options = {}) {
    if (!this._initialized || !fd || !Array.isArray(srcs) || srcs.length === 0) return;
    this._removeBackgroundImageEntries();
    this._loadVisibleBackgroundStack(srcs, fd, options);
  }

  /**
   * Remove all background image entries (`__bg_image__*`).
   * @private
   */
  _removeBackgroundImageEntries() {
    const keys = [];
    for (const key of this._tiles.keys()) {
      if (String(key).startsWith('__bg_image__')) keys.push(String(key));
    }
    for (const key of keys) {
      const existing = this._tiles.get(key);
      if (existing?.mesh) {
        existing.mesh.removeFromParent();
        existing.mesh.geometry?.dispose?.();
        existing.material?.dispose?.();
      }
      this._tiles.delete(key);
    }
  }

  /**
   * Load and add all visible background layers in order.
   * @param {string[]} srcs
   * @param {object} fd
   * @param {{skipFirst?: boolean}} [options]
   * @private
   */
  _loadVisibleBackgroundStack(srcs, fd, options = {}) {
    const list = Array.isArray(srcs) ? srcs : [];
    const { skipFirst = false } = options;
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 1) {
      if (skipFirst && i === 0) continue;
      const raw = list[i];
      const src = (typeof raw === 'string') ? raw.trim() : '';
      if (!src) continue;
      const key = i === 0 ? '__bg_image__' : `__bg_image__${i}`;
      this._loadBgImageStraightAlpha(src, fd, i, key);
    }
  }

  /**
   * Load a `__bg_image__*` background layer and upload it to the GPU with
   * *straight-alpha* pixel data, bypassing every browser-decode path that
   * could premultiply alpha into RGB.
   *
   * ## Why this elaborate path exists
   *
   * Straight-alpha `WebP` backgrounds (authored with non-zero RGB under
   * `alpha=0` texels — the normal case for maps painted in Photoshop /
   * Affinity) lose their alpha channel at the GPU when decoded through
   * the "normal" paths used across three.js:
   *
   *   - `THREE.TextureLoader` → wraps `HTMLImageElement`. Browsers decode
   *     `<img>` into a premultiplied internal buffer as an optimisation.
   *     `gl.texImage2D` then uploads premultiplied RGB tagged as
   *     straight-alpha, producing sampled alpha = 1 wherever authored
   *     RGB was non-zero but alpha was 0.
   *   - `THREE.ImageBitmapLoader` + `premultiplyAlpha: 'none'` → *should*
   *     produce straight-alpha data, but in practice the behaviour
   *     depends on the browser's WebP decoder honouring that option. On
   *     Firefox in particular, some WebP files still come through as
   *     effectively premultiplied. We cannot rely on this path to fix
   *     the alpha bug deterministically.
   *
   * ## How this path works
   *
   *   1. Load the source into an `HTMLImageElement` (uses the browser's
   *      WebP decoder — same as before).
   *   2. Draw it into a 2D canvas. The canvas backing store may or may
   *      not premultiply internally — **we do not care**.
   *   3. Call `CanvasRenderingContext2D.getImageData`. By W3C spec, this
   *      *always* returns straight-alpha RGBA in `Uint8ClampedArray`,
   *      regardless of the backing store's internal representation. Any
   *      browser-side premultiply is undone here.
   *   4. Wrap the byte buffer in a `THREE.DataTexture` with
   *      `premultiplyAlpha: false`. `DataTexture` uploads the raw bytes
   *      to the GPU via `gl.texImage2D(… , pixels)`, and with
   *      `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` the GPU sees the
   *      exact straight-alpha bytes we assembled in step 3.
   *
   * ## Memory cost
   *
   * One transient `Uint8ClampedArray` of size `4 * width * height`
   * (~211 MB for a 10650×4950 map). That allocation is released after
   * the DataTexture is constructed — the GPU keeps its own copy. Peak
   * memory during load is higher than with `TextureLoader` but steady
   * state is identical.
   *
   * @param {string} src
   * @param {object} fd
   * @param {number} zIndex
   * @param {string} key
   * @private
   */
  _loadBgImageStraightAlpha(src, fd, zIndex, key) {
    const THREE = window.THREE;
    if (!THREE) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!(w > 0 && h > 0)) {
          log.warn('FloorRenderBus: bg image has no dimensions after load:', src);
          return;
        }

        // Decode → straight-alpha RGBA via 2D canvas.
        // `willReadFrequently: false` is correct here — we read once then
        // throw the canvas away. `colorSpaceConversion: 'none'` avoids
        // the browser applying any display colour profile to the decoded
        // pixels; our downstream pipeline does its own colour management
        // via `tex.colorSpace = SRGBColorSpace`.
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const cx = cv.getContext('2d', {
          willReadFrequently: false,
          colorSpace: 'srgb',
        });
        if (!cx) {
          log.warn('FloorRenderBus: could not acquire 2D context for bg decode:', src);
          return;
        }
        cx.clearRect(0, 0, w, h);
        cx.drawImage(img, 0, 0);
        const imageData = cx.getImageData(0, 0, w, h);

        // Copy into a plain Uint8Array — three.js's DataTexture path
        // rejects Uint8ClampedArray in some builds because `instanceof
        // Uint8Array` fails.
        const bytes = new Uint8Array(imageData.data.buffer.slice(
          imageData.data.byteOffset,
          imageData.data.byteOffset + imageData.data.byteLength,
        ));

        const tex = new THREE.DataTexture(
          bytes,
          w,
          h,
          THREE.RGBAFormat,
          THREE.UnsignedByteType,
        );
        tex.colorSpace = THREE.SRGBColorSpace;
        // `DataTexture` defaults to `flipY = false`. Keep it that way —
        // the mesh's `scale.y = -1` already handles the Y flip. Setting
        // `flipY = true` on a DataTexture triggers a `[.WebGL-xxx] GL_INVALID_OPERATION`
        // warning in three.js since r160.
        tex.flipY = false;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // Bytes written to `tex.image.data` are straight-alpha RGBA.
        // Tell WebGL not to premultiply during upload so the GPU stores
        // the exact same values. Combined with NormalBlending on the
        // material (non-premultiplied), the per-level sceneRT receives
        // `outA = srcA`, preserving authored holes.
        tex.premultiplyAlpha = false;
        tex.needsUpdate = true;
        tex.userData = tex.userData || {};
        tex.userData.mapShineBackgroundSrc = src;
        // Mark the decode path so diagnostics can distinguish this from
        // legacy TextureLoader uploads.
        tex.userData.mapShineBgDecodePath = 'canvas-getImageData';
        log.info(
          `FloorRenderBus: bg image decoded via canvas (straight-alpha) `
          + `[${key}] (${w}x${h}, src=${src.split('/').pop()})`,
        );
        this._addBackgroundImage(fd, tex, zIndex, key);
        this._applyTileVisibility();
      } catch (err) {
        log.warn('FloorRenderBus: straight-alpha bg decode failed:', { src, key }, err);
      }
    };
    img.onerror = (err) => {
      log.warn('FloorRenderBus: bg image load failed:', { src, key }, err);
    };
    img.src = src;
  }

  /**
   * Create a tile mesh and add it to the single bus scene.
   * Texture starts null and is filled in by the TextureLoader callback.
   *
   * @param {string} tileId
   * @param {number} floorIndex
   * @param {import('three').Texture|null} texture
   * @param {number} cx - world-space center X
   * @param {number} cy - world-space center Y (Three Y-up)
   * @param {number} z  - world-space Z
   * @param {number} w  - tile width in world units
   * @param {number} h  - tile height in world units
   * @param {number} rotation - radians around Z
   * @param {number} alpha
   * @param {boolean} isOverhead - draw-order / userData (PIXI parity), not necessarily ROOF_LAYER
   * @param {boolean} roofShadowCaster - ROOF_LAYER + optional cloud blocker (overhead or upper-floor slab)
   * @private
   */
  _addTileMesh(tileId, floorIndex, texture, cx, cy, z, w, h, rotation, alpha, renderOrder = 0, isOverhead = false, roofShadowCaster = false, cloudShadowBlockerEnabled = false) {
    const THREE = window.THREE;
    const mat = new THREE.MeshBasicMaterial({
      map: texture || null,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: alpha,
      alphaTest: (floorIndex > 0 && Number(alpha) >= 0.95) ? UPPER_FLOOR_ALPHA_CUTOFF : 0.0,
      premultipliedAlpha: floorIndex > 0,
    });

    const geom = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `BusTile_${tileId}`;
    mesh.frustumCulled = false;
    mesh.userData = mesh.userData || {};
    mesh.userData.foundryTileId = tileId;
    mesh.userData.mapShineBusTile = true;
    const root = new THREE.Group();
    root.name = `BusTileRoot_${tileId}`;
    root.frustumCulled = false;
    root.userData = root.userData || {};
    root.userData.foundryTileId = tileId;
    root.userData.mapShineBusTile = true;
    root.userData.isOverhead = isOverhead;
    root.userData.floorIndex = floorIndex;

    // Layer conventions:
    // - Layer 0: normal bus rendering (FloorCompositor camera enables it)
    // - Layer 20: roof capture pass for OverheadShadowsEffectV2
    root.layers.set(0);
    mesh.layers.set(0);
    if (roofShadowCaster) {
      root.layers.enable(20);
      // IMPORTANT: camera layer tests are evaluated on renderable objects
      // (the mesh), not only parent groups. Keep ROOF_LAYER on the mesh so
      // OverheadShadowsEffectV2 roof capture pass can actually see overhead tiles.
      mesh.layers.enable(20);
      // Cloud shadow blocker layer — CloudEffectV2 renders only this layer
      // to build the blocker mask, avoiding per-frame full-scene traversal.
      if (cloudShadowBlockerEnabled) {
        root.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
    }

    root.position.set(cx, cy, z);
    root.rotation.z = rotation;
    mesh.position.set(0, 0, 0);
    mesh.rotation.z = 0;
    // renderOrder controls visual stacking: lower = behind, higher = in front.
    // Three.js sorts transparent objects by renderOrder first, then by distance.
    mesh.renderOrder = renderOrder;

    root.add(mesh);
    this._scene.add(root);
    this._tiles.set(tileId, {
      mesh,
      material: mat,
      floorIndex,
      root,
      attachedToTileId: null,
      textureSrc: '',
      roofShadowCaster: !!roofShadowCaster,
    });

    // New entries must immediately honor current visible floor slice.
    root.visible = this._computeEntryVisibleForSlice(tileId, { floorIndex });
  }

  /**
   * Load/replace the tile albedo texture for an existing bus tile entry.
   * @param {string} tileId
   * @param {string} src
   * @param {number} floorIndex
   * @private
   */
  _loadTileTextureIntoEntry(tileId, src, floorIndex) {
    if (!this._loader || !src || !tileId) return;

    this._loader.load(src, (tex) => {
      const current = this._tiles.get(tileId);
      if (!current || current.textureSrc !== src) return;

      this._configureTileAlbedoTexture(tex);

      try { current.material?.map?.dispose?.(); } catch (_) {}
      current.material.map = tex;
      current.material.needsUpdate = true;
      log.debug(`FloorRenderBus: texture loaded for tile ${tileId} (floor ${floorIndex})`);
    }, undefined, (err) => {
      log.warn(`FloorRenderBus: failed to load texture for tile ${tileId}: ${src}`, err);
    });
  }

  /**
   * Configure tile albedo texture sampling to reduce alpha fringe growth.
   *
   * Transparent tile textures can show stepped dark halos when mipmaps are
   * generated from dark RGB in fully-transparent texels. Disable mipmaps for
   * bus tile albedo and clamp edge sampling to keep silhouettes stable.
   *
   * @param {import('three').Texture|null} tex
   * @private
   */
  _configureTileAlbedoTexture(tex) {
    if (!tex) return;
    const THREE = window.THREE;
    tex.colorSpace = THREE?.SRGBColorSpace ?? tex.colorSpace;
    tex.flipY = true;
    tex.generateMipmaps = false;
    tex.minFilter = THREE?.LinearFilter ?? tex.minFilter;
    tex.magFilter = THREE?.LinearFilter ?? tex.magFilter;
    tex.wrapS = THREE?.ClampToEdgeWrapping ?? tex.wrapS;
    tex.wrapT = THREE?.ClampToEdgeWrapping ?? tex.wrapT;
    tex.premultiplyAlpha = true;
    tex.needsUpdate = true;
  }

  /**
   * Resolve Foundry tile sort with cross-version fallback.
   * @param {object} tileDoc
   * @returns {number}
   * @private
   */
  _getTileSortValue(tileDoc) {
    const rawSort = Number(tileDoc?.sort ?? tileDoc?.z);
    return Number.isFinite(rawSort) ? rawSort : 0;
  }

  /**
   * Map Foundry sort values into the floor-local render-order slot range.
   * @param {object} tileDoc
   * @returns {number}
   * @private
   */
  _computeSortWithinFloor(tileDoc) {
    const rawSort = this._getTileSortValue(tileDoc);
    return Math.max(
      0,
      Math.min(MAX_SORT_WITHIN_FLOOR_GROUP, Math.round(rawSort + (MAX_SORT_WITHIN_FLOOR_GROUP / 2)))
    );
  }

  /**
   * Resolve which floor index a tile belongs to by reading its Levels elevation
   * flags directly. No FloorLayerManager wiring required.
   *
   * @param {object} tileDoc - Foundry TileDocument
   * @param {Array} floors - Ordered floor bands from FloorStack
   * @returns {number} Floor index (0-based)
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop    = Number(flags.rangeTop);
      const tileMid    = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  // ── Layer Order Diagnostics ────────────────────────────────────────────────

  /**
   * Dump all bus scene children sorted by renderOrder with decoded role info.
   * Call from console: `MapShine.renderBus.dumpLayerOrder()`
   * @returns {Array<{name: string, renderOrder: number, floor: number, role: string, intraOffset: number, visible: boolean}>}
   */
  dumpLayerOrder() {
    if (!this._scene) {
      log.warn('dumpLayerOrder: no scene');
      return [];
    }
    const entries = [];
    this._scene.traverse((obj) => {
      if (obj.renderOrder === undefined) return;
      const decoded = formatRenderOrder(obj.renderOrder);
      entries.push({
        name: obj.name || obj.uuid?.slice(0, 8) || '(anon)',
        renderOrder: obj.renderOrder,
        decoded,
        visible: obj.visible,
        layerMask: obj.layers?.mask,
      });
    });
    entries.sort((a, b) => a.renderOrder - b.renderOrder);
    const lines = entries.map(e =>
      `${String(e.renderOrder).padStart(8)} | ${e.decoded} | vis=${e.visible} | layers=0x${(e.layerMask ?? 0).toString(16)} | ${e.name}`
    );
    log.info(`Layer order dump (${entries.length} objects):\n` + lines.join('\n'));
    return entries;
  }

}

