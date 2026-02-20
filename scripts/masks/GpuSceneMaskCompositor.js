/**
 * @fileoverview GPU Scene Mask Compositor — composites per-tile suffix masks into
 * scene-space WebGL render targets for effect consumption.
 *
 * Replaces the CPU canvas-based SceneMaskCompositor with a GPU pipeline:
 * 1. One WebGLRenderTarget per mask type, sized by resolution class
 * 2. A tile-to-scene UV transform shader that maps each tile's mask texture
 *    into scene space, respecting tile position, scale, and rotation
 * 3. Additive (lighten) or replace (source-over) blending per mask type
 * 4. Per-floor render target cache with LRU eviction (max 8 floors)
 * 5. CPU readback via getCpuPixels() for particle spawn point scanning
 *
 * Falls back to the CPU SceneMaskCompositor when the WebGL renderer is not
 * available (e.g. during background preload before canvas initialization).
 *
 * @module masks/GpuSceneMaskCompositor
 */

import { createLogger } from '../core/log.js';
import * as assetLoader from '../assets/loader.js';
import { getEffectMaskRegistry } from '../assets/loader.js';
import { SceneMaskCompositor } from './scene-mask-compositor.js';
import { isLevelsEnabledForScene, tileHasLevelsRange, readTileLevelsFlags, readSceneLevelsFlag } from '../foundry/levels-scene-flags.js';
import { isTileOverhead } from '../scene/tile-manager.js';

const log = createLogger('GpuSceneMaskCompositor');

// ── Resolution classes ────────────────────────────────────────────────────────

/** Max output dimension for data masks (fire, water, outdoors, dust, ash). */
const DATA_MAX = 4096;

/** Max output dimension for visual/color masks (specular, normal, bush, tree). */
const VISUAL_MAX = 8192;

/** Mask types that use the higher visual resolution budget. */
const VISUAL_MASK_IDS = new Set([
  'specular', 'roughness', 'normal', 'iridescence', 'prism', 'bush', 'tree'
]);

/** Mask types that should NOT receive sRGB color space (linear data). */
const DATA_ENCODED_MASKS = new Set(['normal', 'roughness', 'water']);

/** Mask types that use sRGB color space (color textures). */
const COLOR_TEXTURE_IDS = new Set(['bush', 'tree']);

// ── Composite modes ───────────────────────────────────────────────────────────

/**
 * Per-mask-type composite mode.
 * - 'lighten': max blend — union of regions (fire, water, dust, ash)
 * - 'source-over': upper tile replaces lower (outdoors, windows, PBR, etc.)
 */
const COMPOSITE_MODES = {
  fire:         'lighten',
  water:        'lighten',
  dust:         'lighten',
  ash:          'lighten',
  outdoors:     'source-over',
  windows:      'source-over',
  structural:   'source-over',
  specular:     'source-over',
  roughness:    'source-over',
  normal:       'source-over',
  fluid:        'source-over',
  iridescence:  'source-over',
  prism:        'source-over',
  bush:         'source-over',
  tree:         'source-over',
};

// ── Shaders ───────────────────────────────────────────────────────────────────

/**
 * Vertex shader: outputs a full-screen quad UV and a per-tile UV that maps
 * the tile's mask texture into scene space.
 *
 * Uniforms:
 *   uTileRect  — (x, y, w, h) in normalized scene UV space [0..1]
 *   uScaleSign — (signX, signY) for flip: +1 or -1
 *   uRotation  — tile rotation in radians (clockwise positive, Foundry convention)
 */
const TILE_VERT = /* glsl */`
  precision highp float;

  attribute vec3 position;

  uniform vec4 uTileRect;   // (x, y, w, h) in scene UV space
  uniform vec2 uScaleSign;  // flip: +1 or -1 per axis
  uniform float uRotation;  // radians, clockwise

  varying vec2 vSceneUv;    // scene UV [0..1] for this fragment
  varying vec2 vTileUv;     // tile-local UV [0..1] for sampling mask texture

  void main() {
    // Full-screen quad: position.xy is in [-1..1] NDC.
    // Map to scene UV [0..1].
    vSceneUv = position.xy * 0.5 + 0.5;

    // Compute tile-local UV by inverting the tile-to-scene transform.
    // Step 1: scene UV → tile UV (before flip/rotation).
    vec2 tileUv = (vSceneUv - uTileRect.xy) / uTileRect.zw;

    // Step 2: apply rotation (around tile center 0.5, 0.5).
    vec2 centered = tileUv - 0.5;
    float cosR = cos(-uRotation); // invert rotation to go from scene→tile space
    float sinR = sin(-uRotation);
    centered = vec2(
      centered.x * cosR - centered.y * sinR,
      centered.x * sinR + centered.y * cosR
    );
    tileUv = centered + 0.5;

    // Step 3: apply flip (scale sign).
    // scaleSign < 0 means flipped: remap [0..1] → [1..0].
    if (uScaleSign.x < 0.0) tileUv.x = 1.0 - tileUv.x;
    if (uScaleSign.y < 0.0) tileUv.y = 1.0 - tileUv.y;

    vTileUv = tileUv;

    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Fragment shader: samples the tile mask texture and outputs it into the
 * scene-space render target.
 *
 * Fragments outside the tile rect (tileUv outside [0..1]) are discarded.
 * For 'lighten' mode the caller sets THREE blending to MaxEquation.
 * For 'source-over' the caller uses normal alpha blending.
 *
 * Uniforms:
 *   tMask     — tile mask texture
 *   uMode     — 0 = lighten (output luminance), 1 = source-over (output rgba)
 */
const TILE_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tMask;
  uniform int uMode; // 0 = lighten, 1 = source-over

  varying vec2 vSceneUv;
  varying vec2 vTileUv;

  void main() {
    // Discard fragments outside the tile footprint.
    if (vTileUv.x < 0.0 || vTileUv.x > 1.0 ||
        vTileUv.y < 0.0 || vTileUv.y > 1.0) {
      discard;
    }

    vec4 s = texture2D(tMask, vTileUv);

    if (uMode == 0) {
      // Lighten: output RGB luminance in all channels so MAX blending works.
      // Do NOT include alpha — some tiles (e.g. upper-floor _Water) use alpha
      // as a floor-boundary cutout with black RGB. Including alpha would make
      // those tiles appear as valid water masks, overriding the preserved
      // ground-floor water. Water coverage is always encoded in RGB.
      float lum = max(s.r, max(s.g, s.b));
      gl_FragColor = vec4(lum, lum, lum, lum);
    } else {
      // Source-over: output full RGBA as-is.
      // Do NOT promote alpha into RGB — upper-floor tiles use alpha as a
      // floor-boundary cutout with black RGB. Promoting it would make the
      // entire floor appear as outdoors/windows. The 4x4 readback (RGB-only)
      // will correctly detect these as empty and trigger preserveAcrossFloors.
      gl_FragColor = s;
    }
  }
`;

// ── GpuSceneMaskCompositor ────────────────────────────────────────────────────

export class GpuSceneMaskCompositor {
  constructor() {
    /**
     * Per-floor render target cache.
     * Key: floorKey ("${bottom}:${top}"), Value: Map<maskType, WebGLRenderTarget>
     * @type {Map<string, Map<string, THREE.WebGLRenderTarget>>}
     */
    this._floorCache = new Map();

    /**
     * LRU order: most-recently-used floor key is last.
     * @type {string[]}
     */
    this._lruOrder = [];

    /** Maximum number of floors to keep in the render target cache. */
    this._maxCachedFloors = 8;

    /**
     * CPU pixel readback cache: maskType → Uint8Array.
     * Populated lazily by getCpuPixels(). Cleared on compose.
     * @type {Map<string, Uint8Array>}
     */
    this._cpuPixelCache = new Map();

    /**
     * Dimensions of the last composed output, per mask type.
     * @type {Map<string, {width: number, height: number}>}
     */
    this._outputDims = new Map();

    /**
     * Floor key of the currently active floor ("${bottom}:${top}").
     * Used by getCpuPixels lookups and to detect actual floor changes so
     * masksChanged is true whenever the floor key changes, regardless of
     * whether basePath is the same.
     * @type {string|null}
     */
    this._activeFloorKey = null;

    /**
     * BasePath of the tile whose masks are currently active.
     * @type {string|null}
     */
    this._activeFloorBasePath = null;

    /**
     * Per-floor mask metadata cache: floorKey → {masks, basePath}.
     * Stores the resolved mask array + basePath for each floor so that
     * composeFloor() can return masksChanged without re-compositing.
     * @type {Map<string, {masks: Array, basePath: string|null}>}
     */
    this._floorMeta = new Map();

    /**
     * Fallback CPU compositor used when the WebGL renderer is unavailable.
     * @type {SceneMaskCompositor}
     */
    this._cpuFallback = new SceneMaskCompositor();

    /** @type {THREE.BufferGeometry|null} Shared full-screen quad geometry (two triangles, NDC [-1..1]). */
    this._quadGeo = null;

    /** @type {THREE.RawShaderMaterial|null} Shared tile compositing material. */
    this._tileMaterial = null;

    /** @type {THREE.Mesh|null} Shared quad mesh (reused per draw call, frustumCulled=false). */
    this._quadMesh = null;

    /** @type {THREE.Scene|null} Minimal scene containing just the quad mesh. */
    this._quadScene = null;

    /** @type {THREE.OrthographicCamera|null} Shared ortho camera covering NDC [-1..1]. */
    this._orthoCamera = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Compose per-tile masks into scene-space render targets.
   * Drop-in replacement for SceneMaskCompositor.compose().
   *
   * @param {Array<{tileDoc: object, masks: Map<string, {url: string, texture: THREE.Texture}>}>} tileMaskEntries
   * @param {object} scene - Foundry scene (canvas.scene)
   * @param {object} [options]
   * @param {object} [options.levelContext] - Active level band {bottom, top}
   * @param {string} [options.floorKey] - Override floor key (default: derived from levelContext)
   * @returns {{masks: Array<{id, suffix, type, texture, required}>, width: number, height: number}|null}
   */
  compose(tileMaskEntries, scene, options = {}) {
    const renderer = window.MapShine?.renderer;
    if (!renderer) {
      // No GPU renderer available — fall back to CPU compositor.
      log.debug('compose: no renderer, falling back to CPU compositor');
      return this._cpuFallback.compose(tileMaskEntries, scene, options);
    }

    const THREE = window.THREE;
    if (!THREE || !tileMaskEntries || tileMaskEntries.length === 0) return null;

    const d = canvas?.dimensions;
    const sr = d?.sceneRect;
    if (!sr || !sr.width || !sr.height) return null;

    const sceneX = sr.x ?? 0;
    const sceneY = sr.y ?? 0;
    const sceneW = sr.width;
    const sceneH = sr.height;

    // Derive floor key.
    const ctx = options.levelContext;
    const floorKey = options.floorKey ??
      (ctx ? `${ctx.bottom}:${ctx.top}` : 'ground');

    // Collect all mask types present across all tiles.
    const allMaskTypes = new Set();
    for (const entry of tileMaskEntries) {
      if (!entry.masks) continue;
      for (const key of entry.masks.keys()) allMaskTypes.add(key);
    }
    if (allMaskTypes.size === 0) return null;

    // Sort tiles by Z-order: lowest elevation/sort first, upper tiles composite on top.
    const sortedEntries = [...tileMaskEntries].sort((a, b) => {
      const eA = Number(a.tileDoc?.elevation ?? 0);
      const eB = Number(b.tileDoc?.elevation ?? 0);
      if (eA !== eB) return eA - eB;
      return Number(a.tileDoc?.sort ?? 0) - Number(b.tileDoc?.sort ?? 0);
    });

    // Ensure GPU resources are ready.
    this._ensureGpuResources(THREE);

    const registry = getEffectMaskRegistry();
    const maxTex = renderer.capabilities?.maxTextureSize ?? 16384;

    // Get or create the per-floor render target map.
    const floorTargets = this._getOrCreateFloorTargets(floorKey);

    const compositeMasks = [];

    for (const maskType of allMaskTypes) {
      const def = registry[maskType];
      if (!def) continue;

      const isVisual = VISUAL_MASK_IDS.has(maskType);
      const targetMax = Math.min(isVisual ? VISUAL_MAX : DATA_MAX, maxTex);
      const scale = Math.min(1.0, targetMax / Math.max(1, sceneW), targetMax / Math.max(1, sceneH));
      const outW = Math.max(1, Math.round(sceneW * scale));
      const outH = Math.max(1, Math.round(sceneH * scale));

      // Get or create render target for this mask type on this floor.
      let rt = floorTargets.get(maskType);
      if (!rt || rt.width !== outW || rt.height !== outH) {
        rt?.dispose();
        rt = this._createRenderTarget(THREE, outW, outH, maskType);
        floorTargets.set(maskType, rt);
      }

      const mode = COMPOSITE_MODES[maskType] ?? 'source-over';
      const isLighten = (mode === 'lighten');

      // Compose all tiles for this mask type into the render target.
      const anyDrawn = this._composeMaskType(
        renderer, THREE, rt, sortedEntries, maskType,
        sceneX, sceneY, sceneW, sceneH, isLighten
      );

      if (!anyDrawn) continue;

      // Verify the composited result has non-zero RGB via a cheap GPU readback.
      // Upper-floor tiles commonly have black-RGB masks with alpha=floor-shape
      // (a floor-boundary cutout, not actual coverage data). The compositor
      // draws these tiles (anyDrawn=true), but the RGB result is all-zero.
      //
      // Including such empty masks in the output causes two problems:
      //  - preserveAcrossFloors types (water, windows, specular, etc.):
      //    transitionToFloor would 'replace' with the black mask instead of
      //    preserving the valid ground-floor mask.
      //  - Non-preserve types (outdoors, fire, dust, etc.):
      //    the black mask is applied as valid coverage data. For outdoors,
      //    R=0 everywhere means "fully indoors", suppressing caustics and
      //    cloud shadows in the water shader.
      //
      // Skipping empty masks lets transitionToFloor either preserve (if
      // preserveAcrossFloors) or clear (falling back to default behavior,
      // e.g. no outdoors mask → treat everything as outdoors → caustics work).
      try {
        const isNonEmpty = this._readbackIsNonEmpty(renderer, rt);
        if (!isNonEmpty) {
          log.debug(`compose: skipping all-zero '${maskType}' mask`);
          continue;
        }
      } catch (_) {}

      // The render target texture is the compositor output.
      const outTex = rt.texture;

      // Apply correct color space.
      if (COLOR_TEXTURE_IDS.has(maskType) && THREE.SRGBColorSpace) {
        outTex.colorSpace = THREE.SRGBColorSpace;
      } else if (DATA_ENCODED_MASKS.has(maskType)) {
        outTex.colorSpace = THREE.NoColorSpace ?? '';
      } else if (THREE.SRGBColorSpace) {
        outTex.colorSpace = THREE.SRGBColorSpace;
      }

      this._outputDims.set(maskType, { width: outW, height: outH });

      compositeMasks.push({
        id: maskType,
        suffix: def.suffix,
        type: maskType,
        texture: outTex,
        required: !!def.required
      });
    }

    if (compositeMasks.length === 0) return null;

    // Invalidate CPU pixel cache — the RT contents just changed.
    // NOTE: Do NOT update _activeFloorKey here. composeFloor() is the sole
    // owner of _activeFloorKey and updates it only on non-cacheOnly calls.
    // Setting it here caused preloadAllFloors (which calls compose via
    // composeFloor with cacheOnly=true) to prematurely advance the floor key,
    // making the first real floor transition report masksChanged=false and
    // skip all mask redistribution. On the second transition the masks WERE
    // redistributed, applying the upper floor's black-RGB outdoors mask and
    // breaking caustics/cloud shadows in the water shader.
    this._cpuPixelCache.clear();

    // Touch LRU order.
    this._touchLru(floorKey);

    const firstDims = this._outputDims.get(compositeMasks[0]?.id);
    const outW = firstDims?.width ?? 0;
    const outH = firstDims?.height ?? 0;

    log.info(`Composed ${compositeMasks.length} mask types from ${tileMaskEntries.length} tiles (${outW}×${outH}) [GPU]`);

    return { masks: compositeMasks, width: outW, height: outH };
  }

  // ── Orchestration API (replaces SceneComposer.rebuildMasksForActiveLevel) ──

  /**
   * Full async pipeline: load per-tile masks, GPU-composite them into scene-space
   * render targets, fall back to bundle load if needed, cache results.
   *
   * Drop-in replacement for SceneComposer.rebuildMasksForActiveLevel().
   *
   * @param {object|null} levelContext - {bottom, top} or null for ground floor
   * @param {object|null} scene - Foundry scene document
   * @param {object} [options]
   * @param {string|null} [options.lastMaskBasePath] - Background basePath fallback
   * @param {boolean} [options.cacheOnly=false] - Preload mode: warm cache without activating
   * @returns {Promise<{masks: Array, masksChanged: boolean, levelElevation: number, basePath: string|null}|null>}
   */
  async composeFloor(levelContext, scene, options = {}) {
    const { lastMaskBasePath = null, cacheOnly = false } = options;
    const ctx = levelContext || window.MapShine?.activeLevelContext;
    if (!ctx) return null;

    const sc = scene || canvas?.scene;
    if (!sc || !isLevelsEnabledForScene(sc)) return null;

    const bandBottom = Number(ctx.bottom);
    const bandTop = Number(ctx.top);
    if (!Number.isFinite(bandBottom) || !Number.isFinite(bandTop)) return null;

    const floorKey = `${bandBottom}:${bandTop}`;
    const levelElevation = bandBottom;

    // Fast path: floor already composited — return cached metadata.
    const cached = this._floorMeta.get(floorKey);
    if (cached?.masks?.length) {
      // Strip preserveAcrossFloors mask types from cached entries. These masks
      // belong to a different floor's registry slot and must never be included in
      // the new floor's mask set — doing so would trigger a replace action in
      // transitionToFloor instead of the correct preserve action. This also
      // handles stale cache entries populated before the policy was set.
      const emr = window.MapShine?.effectMaskRegistry;
      const filteredMasks = cached.masks.filter(m => {
        const type = m?.type || m?.id;
        if (!type) return true;
        const policy = emr?.getPolicy?.(type);
        return !policy?.preserveAcrossFloors;
      });

      if (cacheOnly) {
        return { masks: filteredMasks, masksChanged: false, levelElevation, basePath: cached.basePath };
      }
      // masksChanged must be true whenever the active floor key changes, even if
      // basePath is the same. Two floors on the same tile set share a basePath but
      // have different per-floor masks — the old basePath comparison caused
      // transitionToFloor to be skipped entirely on same-tileset floor switches.
      const masksChanged = (floorKey !== this._activeFloorKey);
      if (masksChanged) {
        this._activeFloorBasePath = cached.basePath;
        this._activeFloorKey = floorKey;
      }
      log.info('composeFloor: cache hit', { floorKey, masksChanged, basePath: cached.basePath });
      return { masks: filteredMasks, masksChanged, levelElevation, basePath: cached.basePath };
    }

    log.info('composeFloor: cache miss, compositing floor', { floorKey, bandBottom, bandTop });

    let newMasks = null;
    let primaryBasePath = null;

    // Step 1: Collect active-floor tiles.
    const allActiveTiles = this._getActiveLevelTiles(sc, ctx);
    const tileCandidates = this._getLargeSceneMaskTiles(sc, ctx);
    primaryBasePath = tileCandidates[0]?.basePath || null;
    if (!primaryBasePath && allActiveTiles.length > 0) {
      const firstSrc = allActiveTiles[0]?.tileDoc?.texture?.src;
      if (typeof firstSrc === 'string' && firstSrc.trim()) {
        primaryBasePath = this._extractBasePath(firstSrc.trim());
      }
    }

    // Step 2: GPU compositor pipeline.
    const tileManager = window.MapShine?.tileManager;
    if (tileManager && allActiveTiles.length > 0) {
      try {
        const tileMaskEntries = [];
        for (const { tileDoc } of allActiveTiles) {
          const masks = await tileManager.loadAllTileMasks(tileDoc);
          if (masks && masks.size > 0) tileMaskEntries.push({ tileDoc, masks });
        }
        if (tileMaskEntries.length > 0) {
          const compositorResult = this.compose(tileMaskEntries, sc, { levelContext: ctx, floorKey });
          if (compositorResult?.masks?.length) {
            // Merge with bundle masks for types the per-tile compositor didn't cover.
            // IMPORTANT: Strip preserveAcrossFloors mask types (e.g. 'water') from
            // baseBundleMasks before merging. Bundle masks are keyed by basePath which
            // is shared across all floors of the same map — they are NOT floor-specific.
            // Including them for preserveAcrossFloors types would cause the ground-floor
            // water mask to appear in the upper floor's mask set, triggering a replace
            // action in transitionToFloor and rebuilding the SDF from the wrong floor.
            let baseBundleMasks = [];
            if (primaryBasePath) {
              try {
                const r = await assetLoader.loadAssetBundle(primaryBasePath, null, {
                  skipBaseTexture: true, suppressProbeErrors: true
                });
                if (r?.bundle?.masks?.length) {
                  const emr = window.MapShine?.effectMaskRegistry;
                  baseBundleMasks = r.bundle.masks.filter(m => {
                    const type = m?.type || m?.id;
                    if (!type) return true;
                    const policy = emr?.getPolicy?.(type);
                    return !policy?.preserveAcrossFloors;
                  });
                }
              } catch (_) {}
            }
            newMasks = this.mergeMasks(baseBundleMasks, compositorResult.masks);
            log.info('composeFloor: GPU compositor produced masks', {
              gpuCount: compositorResult.masks.length,
              mergedTotal: newMasks.length
            });
          }
        }
      } catch (e) {
        log.warn('composeFloor: GPU compositor failed, falling back', e);
      }
    }

    // Step 3: Fallback — single-tile bundle load.
    // Strip preserveAcrossFloors mask types (e.g. 'water') — bundle masks are
    // shared across all floors and must not override the registry's preserved slot.
    if (!newMasks && primaryBasePath) {
      try {
        const r = await assetLoader.loadAssetBundle(primaryBasePath, null, {
          skipBaseTexture: true, suppressProbeErrors: true
        });
        if (r?.bundle?.masks?.length) {
          const emr = window.MapShine?.effectMaskRegistry;
          newMasks = r.bundle.masks.filter(m => {
            const type = m?.type || m?.id;
            if (!type) return true;
            const policy = emr?.getPolicy?.(type);
            return !policy?.preserveAcrossFloors;
          });
          if (!newMasks.length) newMasks = null;
          log.info('composeFloor: fell back to single-tile bundle', { primaryBasePath });
        }
      } catch (e) {
        log.warn('composeFloor: single-tile bundle load failed', e);
      }
    }

    // Step 4: Background basePath fallback for ground-floor bands.
    if (!newMasks && lastMaskBasePath && bandBottom <= 0) {
      try {
        const r = await assetLoader.loadAssetBundle(lastMaskBasePath, null, {
          skipBaseTexture: true, suppressProbeErrors: true
        });
        if (r?.bundle?.masks?.length) {
          newMasks = r.bundle.masks;
          primaryBasePath = lastMaskBasePath;
          log.info('composeFloor: fell back to background basePath', { lastMaskBasePath });
        }
      } catch (e) {
        log.warn('composeFloor: background basePath fallback failed', e);
      }
    }

    if (!newMasks || newMasks.length === 0) return null;

    // Normalize flipY to match base plane convention.
    for (const m of newMasks) {
      const tex = m?.texture;
      if (tex && tex.flipY !== false) { tex.flipY = false; tex.needsUpdate = true; }
    }

    // Store in per-floor metadata cache.
    this._floorMeta.set(floorKey, { masks: newMasks, basePath: primaryBasePath });

    if (cacheOnly) {
      log.info('composeFloor: preloaded (cacheOnly)', { floorKey, maskCount: newMasks.length });
      return { masks: newMasks, masksChanged: false, levelElevation, basePath: primaryBasePath };
    }

    // masksChanged is true whenever the floor key changes, not just basePath.
    // Two floors on the same tile set share a basePath but need separate transitions.
    const masksChanged = (floorKey !== this._activeFloorKey);
    this._activeFloorBasePath = primaryBasePath;
    this._activeFloorKey = floorKey;

    log.info('composeFloor: done', {
      floorKey, maskCount: newMasks.length,
      maskTypes: newMasks.map(m => m.type),
      levelElevation, masksChanged
    });

    return { masks: newMasks, masksChanged, levelElevation, basePath: primaryBasePath };
  }

  /**
   * Pre-warm the floor cache for all level bands in the scene.
   * Replaces SceneComposer.preloadMasksForAllLevels().
   * Runs in the background; does not block.
   *
   * @param {object|null} scene - Foundry scene document
   * @param {object} [options]
   * @param {string|null} [options.lastMaskBasePath] - Background basePath fallback
   * @param {Array|null} [options.initialMasks] - Already-loaded masks for the current floor
   * @param {object|null} [options.activeLevelContext] - Current active level context
   * @returns {Promise<void>}
   */
  async preloadAllFloors(scene, options = {}) {
    const { lastMaskBasePath = null, initialMasks = null, activeLevelContext = null } = options;
    try {
      const sc = scene || canvas?.scene;
      if (!sc || !isLevelsEnabledForScene(sc)) return;

      // Seed the current floor's masks so switching back is instant.
      try {
        const activeLvl = activeLevelContext || window.MapShine?.activeLevelContext;
        if (activeLvl && initialMasks?.length) {
          const ab = Number(activeLvl.bottom);
          const at = Number(activeLvl.top);
          if (Number.isFinite(ab) && Number.isFinite(at)) {
            const initKey = `${ab}:${at}`;
            if (!this._floorMeta.has(initKey)) {
              this._floorMeta.set(initKey, { masks: initialMasks, basePath: lastMaskBasePath });
              if (!this._activeFloorBasePath) this._activeFloorBasePath = lastMaskBasePath;
              log.debug('preloadAllFloors: seeded current floor', { initKey });
            }
          }
        }
      } catch (_) {}

      // Collect all unique level bands.
      const bands = new Set();
      try {
        const sceneLevels = readSceneLevelsFlag(sc);
        if (Array.isArray(sceneLevels)) {
          for (const entry of sceneLevels) {
            const b = Number(entry?.bottom ?? entry?.[0]);
            const t = Number(entry?.top ?? entry?.[1]);
            if (Number.isFinite(b) && Number.isFinite(t)) bands.add(`${b}:${t}`);
          }
        }
      } catch (_) {}
      try {
        const tiles = sc?.tiles;
        const iter = Array.isArray(tiles) ? tiles
          : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? []));
        for (const tileDoc of iter) {
          if (!tileDoc) continue;
          if (tileHasLevelsRange(tileDoc)) {
            const flags = readTileLevelsFlags(tileDoc);
            const b = Number(flags.rangeBottom);
            const t = Number(flags.rangeTop);
            if (Number.isFinite(b) && Number.isFinite(t)) bands.add(`${b}:${t}`);
          }
        }
      } catch (_) {}

      if (bands.size <= 1) return;

      log.info('preloadAllFloors: warming cache for', bands.size, 'level bands');
      for (const bandKey of bands) {
        if (this._floorMeta.has(bandKey)) continue;
        const [bottom, top] = bandKey.split(':').map(Number);
        try {
          await this.composeFloor({ bottom, top }, sc, { lastMaskBasePath, cacheOnly: true });
        } catch (e) {
          log.debug('preloadAllFloors: failed for band', bandKey, e);
        }
      }
      log.info('preloadAllFloors: done,', this._floorMeta.size, 'floors cached');
    } catch (e) {
      log.debug('preloadAllFloors: error', e);
    }
  }

  /**
   * Compose and cache masks for a floor without activating them.
   * Used by preloadMasksForAllLevels to warm the cache in the background.
   *
   * @param {string} floorKey
   * @param {Array<{tileDoc: object, masks: Map<string, {url: string, texture: THREE.Texture}>}>} tileMaskEntries
   * @param {object} scene
   * @returns {{masks: Array, width: number, height: number}|null}
   */
  preloadFloor(floorKey, tileMaskEntries, scene) {
    return this.compose(tileMaskEntries, scene, { floorKey });
  }

  /**
   * Get CPU pixel data for a mask type (for particle spawn point scanning).
   * Performs a GPU readback on first call; subsequent calls return cached data.
   * The cache is invalidated on each compose() call.
   *
   * @param {string} maskType
   * @returns {Uint8Array|null} RGBA pixel data, or null if not available
   */
  getCpuPixels(maskType) {
    if (this._cpuPixelCache.has(maskType)) {
      return this._cpuPixelCache.get(maskType);
    }

    const renderer = window.MapShine?.renderer;
    if (!renderer) return null;

    const floorKey = this._activeFloorKey;
    if (!floorKey) return null;

    const floorTargets = this._floorCache.get(floorKey);
    if (!floorTargets) return null;

    const rt = floorTargets.get(maskType);
    if (!rt) return null;

    const w = rt.width;
    const h = rt.height;
    const buf = new Uint8Array(w * h * 4);

    try {
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      this._cpuPixelCache.set(maskType, buf);
      return buf;
    } catch (e) {
      log.warn(`getCpuPixels: readback failed for '${maskType}'`, e);
      return null;
    }
  }

  /**
   * Get the output dimensions for a mask type.
   * @param {string} maskType
   * @returns {{width: number, height: number}|null}
   */
  getOutputDims(maskType) {
    return this._outputDims.get(maskType) ?? null;
  }

  /**
   * Merge compositor output masks with an existing bundle's masks.
   * Compositor masks take priority; any mask type not produced by the
   * compositor is preserved from the original bundle.
   * (Same interface as SceneMaskCompositor.mergeMasks)
   *
   * @param {Array} originalMasks
   * @param {Array} compositorMasks
   * @returns {Array}
   */
  mergeMasks(originalMasks, compositorMasks) {
    if (!compositorMasks?.length) return originalMasks || [];
    if (!originalMasks?.length) return compositorMasks;
    const compositorIds = new Set(compositorMasks.map(m => m.id));
    const kept = originalMasks.filter(m => !compositorIds.has(m.id));
    return [...kept, ...compositorMasks];
  }

  /**
   * Dispose all GPU resources and clear all caches.
   */
  dispose() {
    this._floorMeta.clear();
    this._activeFloorBasePath = null;
    this._activeFloorKey = null;
    for (const floorTargets of this._floorCache.values()) {
      for (const rt of floorTargets.values()) {
        try { rt.dispose(); } catch (_) {}
      }
    }
    this._floorCache.clear();
    this._lruOrder.length = 0;
    this._cpuPixelCache.clear();
    this._outputDims.clear();
    this._activeFloorKey = null;

    try { this._quadGeo?.dispose(); } catch (_) {}
    this._quadGeo = null;

    try { this._tileMaterial?.dispose(); } catch (_) {}
    this._tileMaterial = null;

    this._quadMesh = null;
    this._quadScene = null;
    this._orthoCamera = null;

    this._cpuFallback.dispose();

    log.info('GpuSceneMaskCompositor disposed');
  }

  /**
   * Find the WebGLRenderTarget that owns the given texture.
   * Used by WaterSurfaceModel to perform GPU readback on compositor-produced textures.
   * Searches all cached floor targets across all floors.
   *
   * @param {THREE.Texture} texture
   * @returns {THREE.WebGLRenderTarget|null}
   */
  _findRenderTargetForTexture(texture) {
    if (!texture) return null;
    for (const floorTargets of this._floorCache.values()) {
      for (const rt of floorTargets.values()) {
        if (rt.texture === texture) return rt;
      }
    }
    return null;
  }

  // ── Private: GPU resource management ────────────────────────────────────────

  /**
   * Ensure the shared quad geometry and shader material are created.
   * @param {object} THREE
   * @private
   */
  _ensureGpuResources(THREE) {
    if (!this._quadGeo) {
      // Full-screen quad: two triangles covering NDC [-1..1].
      const geo = new THREE.BufferGeometry();
      // Three.js requires 3-component positions for computeBoundingSphere.
      // Z=0 for all vertices since this is a flat NDC quad.
      const positions = new Float32Array([
        -1, -1, 0,
         1, -1, 0,
        -1,  1, 0,
         1, -1, 0,
         1,  1, 0,
        -1,  1, 0,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this._quadGeo = geo;
    }

    if (!this._tileMaterial) {
      this._tileMaterial = new THREE.RawShaderMaterial({
        vertexShader: TILE_VERT,
        fragmentShader: TILE_FRAG,
        uniforms: {
          tMask:      { value: null },
          uTileRect:  { value: new THREE.Vector4(0, 0, 1, 1) },
          uScaleSign: { value: new THREE.Vector2(1, 1) },
          uRotation:  { value: 0.0 },
          uMode:      { value: 1 },
        },
        depthTest:  false,
        depthWrite: false,
        transparent: true,
      });
    }

    if (!this._quadMesh) {
      this._quadMesh = new THREE.Mesh(this._quadGeo, this._tileMaterial);
      this._quadMesh.frustumCulled = false;
    }

    if (!this._quadScene) {
      this._quadScene = new THREE.Scene();
      this._quadScene.add(this._quadMesh);
    }

    if (!this._orthoCamera) {
      this._orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
  }

  /**
   * Create a WebGLRenderTarget for a mask type.
   * @param {object} THREE
   * @param {number} width
   * @param {number} height
   * @param {string} maskType
   * @returns {THREE.WebGLRenderTarget}
   * @private
   */
  _createRenderTarget(THREE, width, height, maskType) {
    const rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.flipY = false;
    rt.texture.name = `SceneMask_${maskType}`;
    return rt;
  }

  /**
   * Get or create the render target map for a floor, enforcing LRU eviction.
   * @param {string} floorKey
   * @returns {Map<string, THREE.WebGLRenderTarget>}
   * @private
   */
  _getOrCreateFloorTargets(floorKey) {
    if (this._floorCache.has(floorKey)) {
      return this._floorCache.get(floorKey);
    }

    // Evict oldest floor if at capacity.
    if (this._floorCache.size >= this._maxCachedFloors) {
      const oldest = this._lruOrder.shift();
      if (oldest && this._floorCache.has(oldest)) {
        const targets = this._floorCache.get(oldest);
        for (const rt of targets.values()) {
          try { rt.dispose(); } catch (_) {}
        }
        this._floorCache.delete(oldest);
        log.debug(`GpuSceneMaskCompositor: evicted floor cache for '${oldest}'`);
      }
    }

    const targets = new Map();
    this._floorCache.set(floorKey, targets);
    return targets;
  }

  /**
   * Touch the LRU order for a floor key (move to end = most recently used).
   * @param {string} floorKey
   * @private
   */
  _touchLru(floorKey) {
    const idx = this._lruOrder.indexOf(floorKey);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
    this._lruOrder.push(floorKey);
  }

  // ── Private: tile discovery helpers (mirrors SceneComposer) ─────────────────

  /**
   * Strip the file extension from a texture src path to get the base path
   * used for suffix-mask discovery (e.g. "maps/dungeon.webp" → "maps/dungeon").
   * @param {string} src
   * @returns {string}
   * @private
   */
  _extractBasePath(src) {
    const lastDot = src.lastIndexOf('.');
    return lastDot > 0 ? src.substring(0, lastDot) : src;
  }

  /**
   * Check whether a tile's elevation range overlaps a given level band.
   * Uses EXCLUSIVE boundaries to match updateSpriteVisibility in tile-manager.js.
   * @param {object} tileDoc
   * @param {object} levelContext - {bottom, top}
   * @returns {boolean}
   * @private
   */
  _isTileInLevelBand(tileDoc, levelContext) {
    const bandBottom = Number(levelContext.bottom);
    const bandTop = Number(levelContext.top);
    if (!Number.isFinite(bandBottom) || !Number.isFinite(bandTop)) return true;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      if (Number.isFinite(tileBottom) && Number.isFinite(tileTop)) {
        // Exclusive boundaries: tile whose rangeBottom == bandTop belongs to the floor above.
        return !(tileTop <= bandBottom || tileBottom >= bandTop);
      } else if (Number.isFinite(tileBottom)) {
        // Roof tile: belongs to its originating floor.
        return tileBottom >= bandBottom && tileBottom < bandTop;
      }
    }

    const elev = Number(tileDoc?.elevation);
    if (Number.isFinite(elev)) return elev >= bandBottom && elev < bandTop;
    return true; // No elevation data — include by default.
  }

  /**
   * Get ALL visible tiles on the active level band (no size minimum).
   * @param {object|null} foundryScene
   * @param {object|null} levelContext - {bottom, top}
   * @returns {Array<{tileDoc: object}>}
   * @private
   */
  _getActiveLevelTiles(foundryScene = null, levelContext = null) {
    try {
      let tiles = canvas?.scene?.tiles ?? null;
      if (!tiles || (typeof tiles.size === 'number' && tiles.size === 0)) {
        tiles = foundryScene?.tiles ?? null;
      }
      if (!tiles) return [];

      const hasLevelFilter = levelContext &&
        Number.isFinite(Number(levelContext.bottom)) &&
        Number.isFinite(Number(levelContext.top));

      const out = [];
      const tileIter = Array.isArray(tiles)
        ? tiles
        : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? tiles));

      for (const tileDoc of tileIter) {
        if (!tileDoc) continue;
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;
        if (tileDoc.hidden) continue;
        try { if (tileDoc.getFlag?.('map-shine-advanced', 'bypassEffects')) continue; } catch (_) {}

        if (hasLevelFilter) {
          try { if (!this._isTileInLevelBand(tileDoc, levelContext)) continue; } catch (_) {}
        } else {
          try { if (isTileOverhead(tileDoc)) continue; } catch (_) {}
        }

        const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
        const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
        if (!w || !h) continue;
        out.push({ tileDoc });
      }

      out.sort((a, b) => {
        const eA = Number(a.tileDoc?.elevation ?? 0);
        const eB = Number(b.tileDoc?.elevation ?? 0);
        if (eA !== eB) return eA - eB;
        return Number(a.tileDoc?.sort ?? 0) - Number(b.tileDoc?.sort ?? 0);
      });
      return out;
    } catch (e) {
      log.debug('_getActiveLevelTiles: error', e);
    }
    return [];
  }

  /**
   * Get large scene-spanning tiles suitable for basePath discovery.
   * Tiles must cover ≥20% of scene area and be Y-aligned to the scene rect.
   * @param {object|null} foundryScene
   * @param {object|null} levelContext - {bottom, top}
   * @returns {Array<{tileDoc, src, basePath, rect}>}
   * @private
   */
  _getLargeSceneMaskTiles(foundryScene = null, levelContext = null) {
    try {
      let tiles = canvas?.scene?.tiles ?? null;
      if (!tiles || (typeof tiles.size === 'number' && tiles.size === 0)) {
        tiles = foundryScene?.tiles ?? null;
      }
      const d = canvas?.dimensions ?? foundryScene?.dimensions;
      if (!tiles || !d) return [];

      const sr = d.sceneRect ?? {
        x: Number.isFinite(d.sceneX) ? d.sceneX : 0,
        y: Number.isFinite(d.sceneY) ? d.sceneY : 0,
        width: d.sceneWidth ?? d.width ?? 0,
        height: d.sceneHeight ?? d.height ?? 0
      };
      if (!sr || !Number.isFinite(sr.width) || !Number.isFinite(sr.height)) return [];

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return [];

      const hasLevelFilter = levelContext &&
        Number.isFinite(Number(levelContext.bottom)) &&
        Number.isFinite(Number(levelContext.top));

      const tol = 1;
      const minArea = sceneW * sceneH * 0.2;
      const out = [];

      const tileIter = Array.isArray(tiles)
        ? tiles
        : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? tiles));

      for (const tileDoc of tileIter) {
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        if (hasLevelFilter) {
          try { if (!this._isTileInLevelBand(tileDoc, levelContext)) continue; } catch (_) {}
        } else {
          try { if (isTileOverhead(tileDoc)) continue; } catch (_) {}
        }

        const x = Number.isFinite(tileDoc?.x) ? tileDoc.x : 0;
        const y = Number.isFinite(tileDoc?.y) ? tileDoc.y : 0;
        const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
        const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
        if (!w || !h) continue;
        if (w * h < minArea) continue;
        if (Math.abs(y - sceneY) > tol || Math.abs(h - sceneH) > tol) continue;

        out.push({ tileDoc, src: src.trim(), basePath: this._extractBasePath(src.trim()), rect: { x, y, w, h } });
      }

      out.sort((a, b) => a.rect.x - b.rect.x);
      return out;
    } catch (_) {}
    return [];
  }

  // ── Private: GPU compositing ─────────────────────────────────────────────────

  /**
   * Composite all tile contributions for one mask type into a render target.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} THREE
   * @param {THREE.WebGLRenderTarget} rt - Destination render target
   * @param {Array} sortedEntries - Tile entries sorted by elevation/sort
   * @param {string} maskType
   * @param {number} sceneX - Scene rect origin X (Foundry coords)
   * @param {number} sceneY - Scene rect origin Y (Foundry coords)
   * @param {number} sceneW - Scene rect width
   * @param {number} sceneH - Scene rect height
   * @param {boolean} isLighten - True for lighten/max blend, false for source-over
   * @returns {boolean} Whether any tile was drawn
   * @private
   */
  _composeMaskType(renderer, THREE, rt, sortedEntries, maskType,
                   sceneX, sceneY, sceneW, sceneH, isLighten) {
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();

    const mat = this._tileMaterial;
    const geo = this._quadGeo;

    // Configure blend mode.
    if (isLighten) {
      // MAX blending: output = max(src, dst) per channel.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
      mat.blendEquationAlpha = THREE.MaxEquation ?? THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    } else {
      // Normal alpha blending (source-over).
      mat.blending = THREE.NormalBlending;
    }

    mat.uniforms.uMode.value = isLighten ? 0 : 1;

    let anyDrawn = false;

    for (const entry of sortedEntries) {
      const maskEntry = entry.masks?.get(maskType);
      const tex = maskEntry?.texture;
      if (!tex) continue;

      const tileDoc = entry.tileDoc;
      const tileX = Number(tileDoc?.x ?? 0);
      const tileY = Number(tileDoc?.y ?? 0);
      const tileW = Number(tileDoc?.width ?? 0);
      const tileH = Number(tileDoc?.height ?? 0);
      if (!tileW || !tileH) continue;

      // Compute tile rect in normalized scene UV space [0..1].
      // Foundry uses Y-down (top-left origin); the WebGL render target uses Y-up.
      // Flip V so the tile is placed at the correct vertical position in the RT.
      const u0 = (tileX - sceneX) / sceneW;
      const v0_foundry = (tileY - sceneY) / sceneH;
      const uW = tileW / sceneW;
      const vH = tileH / sceneH;
      const v0 = 1.0 - (v0_foundry + vH);

      // Read tile transform.
      const scaleX = Number(tileDoc?.texture?.scaleX ?? 1);
      const scaleY = Number(tileDoc?.texture?.scaleY ?? 1);
      // Foundry rotation is clockwise degrees; convert to radians.
      const rotDeg = Number(tileDoc?.rotation ?? 0);
      const rotRad = rotDeg * Math.PI / 180;

      // Update shared material uniforms for this tile.
      mat.uniforms.tMask.value = tex;
      mat.uniforms.uTileRect.value.set(u0, v0, uW, vH);
      mat.uniforms.uScaleSign.value.set(Math.sign(scaleX) || 1, Math.sign(scaleY) || 1);
      mat.uniforms.uRotation.value = rotRad;
      mat.needsUpdate = true;

      // Render the shared quad mesh into the active render target.
      try {
        renderer.render(this._quadScene, this._orthoCamera);
        anyDrawn = true;
      } catch (e) {
        log.debug(`_composeMaskType: draw failed for tile ${tileDoc?.id} mask ${maskType}`, e);
      }
    }

    renderer.setRenderTarget(prevTarget);
    return anyDrawn;
  }

  /**
   * Perform a cheap 1×1 GPU readback on the centre pixel of a render target.
   * Returns true if any RGBA channel is non-zero, false if the target is all black.
   * Used to detect all-zero compositor outputs for preserveAcrossFloors masks.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} rt
   * @returns {boolean}
   */
  _readbackIsNonEmpty(renderer, rt) {
    try {
      // Sample a 4×4 grid of pixels spread evenly across the render target.
      // A single centre-pixel check would miss water regions that don't overlap
      // the centre, so we spread samples to reduce false negatives while keeping
      // the readback cheap (16 pixels total).
      const GRID = 4;
      const buf = new Uint8Array(4);
      for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
          const px = Math.floor(rt.width  * (gx + 0.5) / GRID);
          const py = Math.floor(rt.height * (gy + 0.5) / GRID);
          renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
          // Check RGB only — alpha may be non-zero on tiles that use alpha as a
          // floor-boundary cutout (black RGB, alpha=floor-shape). Those tiles
          // contain no actual mask coverage data and must be treated as empty.
          if ((buf[0] | buf[1] | buf[2]) !== 0) return true;
        }
      }
      return false;
    } catch (_) {
      // If readback fails (e.g. context loss), assume non-empty to avoid
      // incorrectly discarding a valid mask.
      return true;
    }
  }

}
