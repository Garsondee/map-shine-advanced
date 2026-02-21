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

/** Max output dimension for data masks (fire, water, outdoors, dust, ash).
 *  Raised from 4096 to 8192 to match the tile albedo resolution cap increase
 *  \u2014 6K\u20138K scenes were getting masks at only 68% resolution with the old cap. */
const DATA_MAX = 8192;

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
 *   uMode     — 0 = lighten (output luminance), 1 = source-over (output rgba),
 *               2 = alpha-extract (tile albedo alpha → greyscale, used by _composeFloorAlpha)
 */
const TILE_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tMask;
  uniform int uMode; // 0 = lighten, 1 = source-over, 2 = alpha-extract

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
      // Lighten: alpha-weighted luminance.
      // Convention: if a tile has an alpha channel, transparent pixels mean
      // "no effect here". Tiles without alpha have alpha=1 (THREE.js pads it),
      // so lum*1 = lum — no change for standard RGB masks.
      // Black-RGB tiles (floor-boundary markers) always output 0 regardless of
      // alpha: max(0,0,0)*anything = 0 → vec4(0,0,0,0). Readback RGB check
      // (unchanged) still correctly treats them as empty. ✓
      float lum = max(s.r, max(s.g, s.b)) * s.a;
      gl_FragColor = vec4(lum, lum, lum, lum);
    } else if (uMode == 2) {
      // Alpha-extract: output the tile albedo's alpha channel as greyscale.
      // Used by _composeFloorAlpha() to build world-space per-floor alpha RTs.
      // Fully opaque tiles (alpha=1 everywhere) fill their rect with white.
      // Tiles with transparent areas correctly encode the holes as black.
      float a = s.a;
      gl_FragColor = vec4(a, a, a, a);
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

/**
 * Fragment shader for floor ID texture composition.
 * Samples a floor's pre-composed world-space alpha texture (floorAlpha).
 * Where the floor has tile coverage (alpha ≥ threshold), writes the floor's
 * index (pre-scaled to 0..1 as index/255) with alpha=1 so NormalBlending
 * overwrites the previous floor's ID. Pixels below threshold are discarded,
 * preserving whatever lower floor ID was already in the render target.
 *
 * Uniforms:
 *   tFloorAlpha — floor alpha RT from _composeFloorAlpha() (scene-space [0..1])
 *   uFloorId    — floor index pre-divided by 255.0 (range 0..1)
 *   uAlphaThres — minimum alpha to count as tile coverage (default 0.1)
 */
const FLOOR_ID_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tFloorAlpha;
  uniform float uFloorId;     // index / 255.0 — use R channel to decode index
  uniform float uAlphaThres;  // default 0.1

  varying vec2 vSceneUv;

  void main() {
    float a = texture2D(tFloorAlpha, vSceneUv).r;
    if (a < uAlphaThres) discard;
    gl_FragColor = vec4(uFloorId, uFloorId, uFloorId, 1.0);
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
     * Floor key of the floor that was active just before the current floor.
     * Populated whenever a floor switch occurs (masksChanged=true).
     * Exposes the below-floor's cached RTs to effects via getBelowFloorTexture().
     * @type {string|null}
     */
    this._belowFloorKey = null;

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

    /** @type {THREE.RawShaderMaterial|null} Material for the floor ID composition pass. */
    this._floorIdMaterial = null;

    /** @type {THREE.Mesh|null} Full-screen quad mesh for the floor ID pass. */
    this._floorIdMesh = null;

    /** @type {THREE.Scene|null} Minimal scene for the floor ID pass. */
    this._floorIdScene = null;

    /**
     * Floor ID render target — a world-space texture where each pixel's R
     * channel encodes the index of the topmost visible floor (index/255.0).
     * Updated by buildFloorIdTexture() after floor composition.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._floorIdTarget = null;
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

    // Compose floor alpha from tile base textures (world-space, replaces screen-space
    // floor-presence passes). Each floor bundle gets a 'floorAlpha' mask entry whose
    // texture encodes where the floor has opaque tile coverage vs transparent gaps.
    // Effects and the floor ID builder consume this instead of floorPresenceTarget.
    const floorAlphaEntry = this._composeFloorAlpha(
      renderer, THREE, floorTargets, sortedEntries,
      sceneX, sceneY, sceneW, sceneH, maxTex
    );
    if (floorAlphaEntry) compositeMasks.push(floorAlphaEntry);

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
      // Pass cached masks through directly. The compositor's _readbackIsNonEmpty
      // check already strips empty masks (black-RGB floor-boundary alphas), so
      // cached.masks only contains valid non-empty data. transitionToFloor handles
      // the preserve/replace/clear logic correctly:
      //  - If a cached mask exists for a type → replace (even preserveAcrossFloors)
      //  - If no cached mask AND preserveAcrossFloors → preserve from registry
      //  - If no cached mask AND NOT preserveAcrossFloors → clear
      //
      // NOTE: baseBundleMasks (line 524) are still filtered to prevent shared
      // bundle masks from polluting floor-specific compositor results. But once
      // masks are cached, they represent the compositor's final floor-specific
      // output and should pass through unfiltered.

      if (cacheOnly) {
        return { masks: cached.masks, masksChanged: false, levelElevation, basePath: cached.basePath };
      }
      // masksChanged must be true whenever the active floor key changes, even if
      // basePath is the same. Two floors on the same tile set share a basePath but
      // have different per-floor masks — the old basePath comparison caused
      // transitionToFloor to be skipped entirely on same-tileset floor switches.
      const masksChanged = (floorKey !== this._activeFloorKey);
      if (masksChanged) {
        // Only treat the previous floor as "below" when navigating UPWARD.
        // If we go floor-1 → floor-0, floor-1 is above — _belowFloorKey must
        // be null so below-floor effects don't incorrectly activate on floor-0.
        const prevKey = this._activeFloorKey;
        const prevBandBottom = prevKey ? Number(prevKey.split(':')[0]) : -Infinity;
        this._belowFloorKey = (bandBottom > prevBandBottom) ? prevKey : null;
        // Fallback for first-load on an upper floor: if no below-floor was set
        // from a floor transition, scan the preloaded _floorCache for the
        // highest floor whose bandBottom is below the current one.
        if (!this._belowFloorKey) {
          this._belowFloorKey = this._findBestBelowFloorKey(bandBottom);
        }
        this._activeFloorBasePath = cached.basePath;
        this._activeFloorKey = floorKey;
        // Invalidate CPU pixel cache so getCpuPixels() reads from the new
        // floor's RTs instead of returning stale data from the previous floor.
        this._cpuPixelCache.clear();
      }
      log.info('composeFloor: cache hit', { floorKey, masksChanged, basePath: cached.basePath });
      return { masks: cached.masks, masksChanged, levelElevation, basePath: cached.basePath };
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
    // Prefer the path derived from the scene's background image over
    // lastMaskBasePath — lastMaskBasePath holds the active floor's path and
    // may point to an upper floor's tile when the user loaded on an upper floor.
    if (!newMasks && bandBottom <= 0) {
      let bgFallbackPath = null;
      try {
        const bgSrc = sc?.background?.src || sc?.img || null;
        if (bgSrc) bgFallbackPath = this._extractBasePath(bgSrc);
      } catch (_) {}
      const fallbackPath = bgFallbackPath || lastMaskBasePath;
      if (fallbackPath) {
        try {
          const r = await assetLoader.loadAssetBundle(fallbackPath, null, {
            skipBaseTexture: true, suppressProbeErrors: true
          });
          if (r?.bundle?.masks?.length) {
            newMasks = r.bundle.masks;
            primaryBasePath = fallbackPath;
            log.info('composeFloor: fell back to background basePath', {
              fallbackPath, fromScene: !!bgFallbackPath
            });
          }
        } catch (e) {
          log.warn('composeFloor: background basePath fallback failed', e);
        }
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
    if (masksChanged) {
      // Only treat the previous floor as "below" when navigating UPWARD.
      // Going floor-1 → floor-0 means floor-1 is above — reset to null.
      const prevKey = this._activeFloorKey;
      const prevBandBottom = prevKey ? Number(prevKey.split(':')[0]) : -Infinity;
      this._belowFloorKey = (bandBottom > prevBandBottom) ? prevKey : null;
      // Fallback for first-load on an upper floor: scan the preloaded cache
      // for the highest floor below the current one.
      if (!this._belowFloorKey) {
        this._belowFloorKey = this._findBestBelowFloorKey(bandBottom);
      }
    }
    this._activeFloorBasePath = primaryBasePath;
    this._activeFloorKey = floorKey;
    // Invalidate CPU pixel cache so getCpuPixels() reads from the new
    // floor's RTs instead of returning stale data from the previous floor.
    // (The cache-hit path clears this at line ~480; the miss path must also clear it.)
    if (masksChanged) this._cpuPixelCache.clear();

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

      // Derive the scene background image's basePath for ground-floor fallback.
      // lastMaskBasePath holds the ACTIVE floor's path — if the player loaded on
      // an upper floor, using it for floor 0 would load the upper floor's masks
      // as the ground-floor background, causing cross-floor mask bleed.
      let sceneBackgroundBasePath = null;
      try {
        const bgSrc = sc?.background?.src || sc?.img || null;
        if (bgSrc) sceneBackgroundBasePath = this._extractBasePath(bgSrc);
      } catch (_) {}

      // Track bands that were evicted and re-composed so we can push updated masks
      // to the registry for the active floor without requiring a floor re-transition.
      const _recomposedBands = new Set();

      for (const bandKey of bands) {
        const [bottom, top] = bandKey.split(':').map(Number);

        // Stale-cache detection MUST run before the _floorMeta skip guard.
        // Empty _tileEffectMasks entries can occur when preloadAllFloors (or an
        // early floor transition) ran before the tile's suffix files were ready,
        // causing masks like _Fire to be permanently absent from the bundle.
        // Only clear truly-empty results (size=0). Tiles with ≥1 mask found are
        // assumed correct; a missing fire on an otherwise healthy tile means the
        // _Fire file genuinely does not exist — don't hammer the filesystem.
        // Also evict the floor bundle when stale tiles are found: composeFloor
        // may have already cached a bundle that lacks fire, and without evicting
        // _floorMeta the skip guard below would prevent re-composition.
        try {
          const tm = window.MapShine?.tileManager;
          if (tm && typeof tm.clearTileEffectMasks === 'function') {
            const bandTiles = this._getActiveLevelTiles(sc, { bottom, top });
            let anyCleared = false;
            for (const { tileDoc } of bandTiles) {
              const tileId = tileDoc?.id;
              if (!tileId) continue;
              const cachedMasks = tm._tileEffectMasks?.get(tileId);
              if (cachedMasks && cachedMasks.size === 0) {
                log.debug('preloadAllFloors: clearing empty tile mask cache for tile', tileId, 'in band', bandKey);
                tm.clearTileEffectMasks(tileId);
                anyCleared = true;
              }
            }
            if (anyCleared && this._floorMeta.has(bandKey)) {
              log.debug('preloadAllFloors: evicting stale floor bundle for band', bandKey, 'to allow re-composition');
              this._floorMeta.delete(bandKey);
              _recomposedBands.add(bandKey);
            }
          }
        } catch (_clearErr) {}

        // Skip if the band is already correctly cached (nothing was evicted above).
        if (this._floorMeta.has(bandKey)) continue;

        // For ground-floor bands, prefer the scene background image's basePath
        // so step 4 in composeFloor loads the correct masks, not an upper floor's.
        const floorBasePath = (bottom <= 0 && sceneBackgroundBasePath)
          ? sceneBackgroundBasePath
          : lastMaskBasePath;
        try {
          await this.composeFloor({ bottom, top }, sc, { lastMaskBasePath: floorBasePath, cacheOnly: true });
          _recomposedBands.add(bandKey);
        } catch (e) {
          log.debug('preloadAllFloors: failed for band', bandKey, e);
        }
      }

      // If the currently-active floor's bundle was evicted and re-composed above,
      // push the updated masks to the registry immediately so effects like fire
      // appear without requiring the user to switch floors and back.
      try {
        const activeKey = this._activeFloorKey;
        if (activeKey && _recomposedBands.has(activeKey)) {
          const newBundle = this._floorMeta.get(activeKey);
          if (newBundle?.masks?.length) {
            const reg = window.MapShine?.effectMaskRegistry;
            if (reg && typeof reg.transitionToFloor === 'function') {
              log.info('preloadAllFloors: refreshing registry for active floor', activeKey, 'after re-composition');
              reg.transitionToFloor(activeKey, newBundle.masks);
            }
          }
        }
      } catch (_refreshErr) {}
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
   * Build (or rebuild) the floor ID texture from the supplied visible-floor bundles.
   *
   * The floor ID texture is a world-space render target at DATA_MAX resolution where
   * each pixel's R channel encodes the index of the topmost floor that has tile
   * coverage at that point: `floorIndex / 255.0`.
   *
   * Floor 0 (background / ground level) is represented by R=0 everywhere the no
   * higher floor has tiles. Higher floors overwrite lower floors using a painter's
   * algorithm (floors rendered lowest-index first with NormalBlending + discard
   * for sub-threshold pixels).
   *
   * Call this once after floor composition is complete (scene init / floor change).
   * The result is accessible via `compositor.floorIdTexture`.
   *
   * @param {Array<{index: number, bundle: {masks: Array}}>} visibleFloorBundles
   *   Ordered array of {index, bundle} from lowest floor index to highest.
   *   Each bundle must be the result of composeFloor() and should contain a
   *   'floorAlpha' mask entry (produced by _composeFloorAlpha()).
   * @returns {THREE.WebGLRenderTarget|null}
   */
  buildFloorIdTexture(visibleFloorBundles) {
    const renderer = window.MapShine?.renderer;
    const THREE = window.THREE;
    if (!THREE || !renderer || !visibleFloorBundles?.length) return null;

    this._ensureGpuResources(THREE);

    const d = canvas?.dimensions;
    const sr = d?.sceneRect;
    if (!sr?.width || !sr?.height) return null;

    const sceneW = sr.width;
    const sceneH = sr.height;
    const maxTex = renderer.capabilities?.maxTextureSize ?? 16384;
    const scale = Math.min(1.0, DATA_MAX / Math.max(1, sceneW), DATA_MAX / Math.max(1, sceneH),
                                maxTex / Math.max(1, sceneW), maxTex / Math.max(1, sceneH));
    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    // (Re)create RT if resolution changed.
    if (!this._floorIdTarget || this._floorIdTarget.width !== outW || this._floorIdTarget.height !== outH) {
      this._floorIdTarget?.dispose();
      this._floorIdTarget = new THREE.WebGLRenderTarget(outW, outH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false
      });
      this._floorIdTarget.texture.colorSpace = THREE.NoColorSpace ?? '';
    }

    const mat  = this._floorIdMaterial;
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._floorIdTarget);
    renderer.setClearColor(0x000000, 0); // R=0 = floor index 0 (background)
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;

    // NormalBlending: alpha=1 overwrites previous floor; discard preserves it.
    mat.blending = THREE.NormalBlending;

    for (const { index, bundle } of visibleFloorBundles) {
      const floorAlphaEntry = bundle?.masks?.find?.(m => m.id === 'floorAlpha');
      if (!floorAlphaEntry?.texture) continue;

      mat.uniforms.tFloorAlpha.value = floorAlphaEntry.texture;
      mat.uniforms.uFloorId.value    = Math.max(0, Math.min(255, index)) / 255.0;
      mat.needsUpdate = true;

      try {
        renderer.render(this._floorIdScene, this._orthoCamera);
      } catch (e) {
        log.debug(`buildFloorIdTexture: draw failed for floor ${index}`, e);
      }
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prev);

    log.debug('buildFloorIdTexture: built for', visibleFloorBundles.length, 'floors', outW, 'x', outH);
    return this._floorIdTarget;
  }

  /**
   * The most-recently built floor ID render target.
   * R channel encodes topmost-floor index as index/255.0 (world-space, scene coords).
   * Null until buildFloorIdTexture() has been called at least once.
   * @type {THREE.WebGLRenderTarget|null}
   */
  get floorIdTarget() { return this._floorIdTarget; }

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
   * Scan the preloaded floor cache and return the floor key with the highest
   * bandBottom that is still strictly below `currentBandBottom`.
   * Used when no explicit floor transition has set _belowFloorKey — e.g. when
   * the game first loads directly on an upper floor after preloadAllFloors().
   * Returns null when no suitable candidate exists.
   * @param {number} currentBandBottom
   * @returns {string|null}
   * @private
   */
  _findBestBelowFloorKey(currentBandBottom) {
    let bestKey = null;
    let bestBottom = -Infinity;
    for (const [key] of this._floorCache) {
      const kb = Number(key.split(':')[0]);
      if (Number.isFinite(kb) && kb < currentBandBottom && kb > bestBottom) {
        bestBottom = kb;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * Reset all floor-tracking state and dispose cached GPU render targets.
   * Call this when the scene changes so stale floor keys and mask textures
   * don't bleed into the next scene load. Floor keys are not scene-unique
   * (e.g. "0:5" can appear on any two-floor map), so the RT cache must be
   * flushed to prevent getBelowFloorTexture() returning data from the wrong scene.
   */
  clearFloorState() {
    this._activeFloorKey      = null;
    this._belowFloorKey       = null;
    this._activeFloorBasePath = null;
    this._cpuPixelCache.clear();

    // Clear the per-floor metadata cache so composeFloor() re-evaluates
    // masksChanged correctly on the first call after a scene switch.
    this._floorMeta.clear();

    // Dispose and clear cached GPU render targets. Floor keys (e.g. "0:5")
    // are not scene-unique, so keeping old RTs would cause getBelowFloorTexture()
    // to return stale mask data from the previous scene on the new scene.
    for (const maskMap of this._floorCache.values()) {
      for (const rt of maskMap.values()) {
        try { rt.dispose(); } catch (_) {}
      }
    }
    this._floorCache.clear();
    this._outputDims.clear();
    // Reset LRU order so eviction logic starts fresh on the new scene.
    this._lruOrder.length = 0;

    log.info('GpuSceneMaskCompositor: floor state cleared (RTs disposed)');
  }

  /**
   * Get the cached compositor RT texture for a specific floor key and mask type.
   * Returns null if that floor hasn't been composited yet or the mask type is absent.
   * @param {string} floorKey - e.g. "0:5" (the "${bottom}:${top}" string)
   * @param {string} maskType - e.g. 'water', 'fire', 'specular'
   * @returns {THREE.Texture|null}
   */
  getFloorTexture(floorKey, maskType) {
    // Primary: GPU render target produced by the compose() path.
    const rt = this._floorCache.get(floorKey)?.get(maskType);
    if (rt?.texture) return rt.texture;

    // Fallback: file-based bundle in _floorMeta produced by the cacheOnly
    // preload path. These floors never go through compose() so _floorCache
    // has no entry. getBelowFloorTexture relies on this path for the ground
    // floor when _floorCache["0:10"] is absent.
    const meta = this._floorMeta.get(floorKey);
    if (meta?.masks) {
      const entry = meta.masks.find(m => (m.id ?? m.type) === maskType);
      return entry?.texture ?? null;
    }
    return null;
  }

  /**
   * Get the cached compositor RT texture for the below-floor (previously active floor).
   * This returns the mask for the floor that was active before the current floor,
   * enabling effects to show lower-floor contributions through gaps in the current floor.
   * Returns null if no floor switch has occurred yet or the mask is not cached.
   * @param {string} maskType
   * @returns {THREE.Texture|null}
   */
  getBelowFloorTexture(maskType) {
    // Lazy resolution: _belowFloorKey may be null if composeFloor() fired before
    // preloadAllFloors() had a chance to populate _floorCache with lower floors.
    // Once the cache is warm we can derive the below-floor key on demand without
    // waiting for an explicit floor transition to set it.
    if (!this._belowFloorKey && this._activeFloorKey) {
      const bandBottom = Number(this._activeFloorKey.split(':')[0]);
      if (Number.isFinite(bandBottom)) {
        const found = this._findBestBelowFloorKey(bandBottom);
        if (found) this._belowFloorKey = found;
      }
    }
    if (!this._belowFloorKey) return null;
    return this.getFloorTexture(this._belowFloorKey, maskType);
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

    try { this._floorIdMaterial?.dispose(); } catch (_) {}
    this._floorIdMaterial = null;
    this._floorIdMesh = null;
    this._floorIdScene = null;

    try { this._floorIdTarget?.dispose(); } catch (_) {}
    this._floorIdTarget = null;

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

    if (!this._floorIdMaterial) {
      this._floorIdMaterial = new THREE.RawShaderMaterial({
        vertexShader: TILE_VERT,      // reuse — vSceneUv is the scene-space UV we need
        fragmentShader: FLOOR_ID_FRAG,
        uniforms: {
          tFloorAlpha: { value: null },
          uFloorId:    { value: 0.0 },
          uAlphaThres: { value: 0.1 },
          // TILE_VERT uniforms — set for identity (full-screen pass, no tile cropping)
          uTileRect:   { value: new THREE.Vector4(0, 0, 1, 1) },
          uScaleSign:  { value: new THREE.Vector2(1, 1) },
          uRotation:   { value: 0.0 },
        },
        depthTest:   false,
        depthWrite:  false,
        transparent: true,
        blending:    THREE.NormalBlending,
      });
    }

    if (!this._floorIdMesh) {
      this._floorIdMesh = new THREE.Mesh(this._quadGeo, this._floorIdMaterial);
      this._floorIdMesh.frustumCulled = false;
    }

    if (!this._floorIdScene) {
      this._floorIdScene = new THREE.Scene();
      this._floorIdScene.add(this._floorIdMesh);
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
   * Compose world-space per-floor alpha from the base textures of all tiles on
   * the floor. The result is a scene-sized render target where R=1 means a tile
   * exists at that pixel and R=0 means a transparent gap (no tile or fully transparent).
   *
   * This replaces the screen-space `floorPresenceTarget` system: the alpha is now
   * baked in world space at composition time rather than re-rendered every frame at
   * viewport resolution. Effects should prefer this over `floorPresenceTarget` when
   * they need to know the floor's spatial extent.
   *
   * Stored in the floor bundle as `{ id: 'floorAlpha', type: 'floorAlpha', ... }`.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} THREE
   * @param {Map<string, THREE.WebGLRenderTarget>} floorTargets - Per-floor RT cache
   * @param {Array} sortedEntries - Tiles sorted by Z-order
   * @param {number} sceneX
   * @param {number} sceneY
   * @param {number} sceneW
   * @param {number} sceneH
   * @param {number} maxTex - Renderer max texture dimension
   * @returns {{ id: string, type: string, texture: THREE.Texture, required: boolean }|null}
   * @private
   */
  _composeFloorAlpha(renderer, THREE, floorTargets, sortedEntries, sceneX, sceneY, sceneW, sceneH, maxTex) {
    const FLOOR_ALPHA_ID = 'floorAlpha';
    const tileManager = window.MapShine?.tileManager;

    // Collect tiles that have their base texture loaded.
    const alphaTiles = [];
    for (const entry of sortedEntries) {
      const tileDoc = entry.tileDoc;
      const tileId = tileDoc?.id;
      if (!tileId) continue;

      // Base texture lives on the sprite material map (loaded by TileManager).
      const baseTex = tileManager?.tileSprites?.get(tileId)?.sprite?.material?.map ?? null;
      if (!baseTex) continue;

      alphaTiles.push({ tileDoc, baseTex });
    }

    if (alphaTiles.length === 0) return null;

    // Use DATA_MAX resolution — the floor alpha is a binary-ish mask; no need for
    // visual-quality resolution. Half-res of DATA_MAX is sufficient but DATA_MAX
    // gives clean edges for tiles that have detailed alpha channels.
    const scale = Math.min(1.0, DATA_MAX / Math.max(1, sceneW), DATA_MAX / Math.max(1, sceneH));
    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    let rt = floorTargets.get(FLOOR_ALPHA_ID);
    if (!rt || rt.width !== outW || rt.height !== outH) {
      rt?.dispose();
      rt = this._createRenderTarget(THREE, outW, outH, FLOOR_ALPHA_ID);
      floorTargets.set(FLOOR_ALPHA_ID, rt);
    }

    const mat = this._tileMaterial;
    const prevTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();

    // MAX blending: accumulate the maximum alpha across overlapping tiles.
    // A pixel covered by any tile gets alpha=max(all tiles at that pixel).
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
    mat.blendEquationAlpha = THREE.MaxEquation ?? THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.uniforms.uMode.value = 2; // alpha-extract mode

    let anyDrawn = false;
    for (const { tileDoc, baseTex } of alphaTiles) {
      const tileX = Number(tileDoc?.x ?? 0);
      const tileY = Number(tileDoc?.y ?? 0);
      const tileW = Number(tileDoc?.width ?? 0);
      const tileH = Number(tileDoc?.height ?? 0);
      if (!tileW || !tileH) continue;

      const u0 = (tileX - sceneX) / sceneW;
      const v0_foundry = (tileY - sceneY) / sceneH;
      const uW = tileW / sceneW;
      const vH = tileH / sceneH;
      const v0 = 1.0 - (v0_foundry + vH); // Y-flip: Foundry Y-down → GL Y-up

      const scaleX = Number(tileDoc?.texture?.scaleX ?? 1);
      const scaleY = Number(tileDoc?.texture?.scaleY ?? 1);
      const rotRad = Number(tileDoc?.rotation ?? 0) * Math.PI / 180;

      mat.uniforms.tMask.value = baseTex;
      mat.uniforms.uTileRect.value.set(u0, v0, uW, vH);
      mat.uniforms.uScaleSign.value.set(Math.sign(scaleX) || 1, Math.sign(scaleY) || 1);
      mat.uniforms.uRotation.value = rotRad;
      mat.needsUpdate = true;

      try {
        renderer.render(this._quadScene, this._orthoCamera);
        anyDrawn = true;
      } catch (e) {
        log.debug(`_composeFloorAlpha: draw failed for tile ${tileDoc?.id}`, e);
      }
    }

    renderer.setRenderTarget(prevTarget);

    if (!anyDrawn) return null;

    // Floor alpha is linear data — no color space conversion.
    rt.texture.colorSpace = THREE.NoColorSpace ?? '';

    return {
      id: FLOOR_ALPHA_ID,
      type: FLOOR_ALPHA_ID,
      texture: rt.texture,
      required: false
    };
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
