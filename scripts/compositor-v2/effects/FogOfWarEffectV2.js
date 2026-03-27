/**
 * @fileoverview World-Space Fog of War Effect
 * 
 * Renders fog of war as a world-space plane mesh instead of a screen-space
 * post-processing effect. This eliminates coordinate system conversion issues
 * and ensures the fog is always correctly pinned to the map.
 * 
 * Architecture:
 * - Creates a plane mesh covering the full canvas (including padding)
 * - Renders vision polygons to a world-space render target
 * - Uses Foundry's exploration texture directly (it's already world-space)
 * - Composites vision + exploration in the fog plane's shader
 * 
 * @module compositor-v2/effects/FogOfWarEffectV2
 */

// NOTE: FogOfWarEffectV2 must NOT import from EffectComposer.js.
// EffectComposer imports the V2 FloorCompositor, which imports FogOfWarEffectV2
// for V2 fog support. Importing EffectComposer here creates a circular module
// dependency that can trigger a TDZ crash:
//   "can't access lexical declaration 'EffectBase' before initialization"
//
// To avoid this, FogOfWarEffectV2 is implemented as a standalone effect-like
// class that exposes the same public fields used by the engine (`id`, `layer`,
// `enabled`, `floorScope`, etc.) without extending EffectBase.
const OVERLAY_THREE_LAYER = 31;

// Minimal layer descriptor matching EffectComposer.RenderLayers.ENVIRONMENTAL.
const ENVIRONMENTAL_LAYER = { order: 400, name: 'Environmental', requiresDepth: false };
import { isGmLike } from '../../core/gm-parity.js';
import { createLogger } from '../../core/log.js';
import { frameCoordinator } from '../../core/frame-coordinator.js';
import { VisionSDF } from '../../vision/VisionSDF.js';
import { VisionPolygonComputer } from '../../vision/VisionPolygonComputer.js';
import { debugLoadingProfiler } from '../../core/debug-loading-profiler.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../../foundry/levels-compatibility.js';
import { isLevelsEnabledForScene, readTileLevelsFlags, tileHasLevelsRange, readWallHeightFlags } from '../../foundry/levels-scene-flags.js';
import { getPerspectiveElevation, isLightVisibleForPerspective } from '../../foundry/elevation-context.js';
import Coordinates from '../../utils/coordinates.js';
import { flattenWallUpdateChanges } from '../../utils/wall-update-classify.js';
import {
  getActiveElevationBandKey,
  buildFogStoreContextKey,
  getRelevantActorIdsForFog,
  loadUnionExplorationForActors,
  saveExplorationForActors,
  tokenIsOwnedByActiveUser,
} from '../../fog/fog-exploration-store.js';

const log = createLogger('FogOfWarEffectV2');

function getFogPersistenceMaxDim() {
  try {
    const n = Number(game?.settings?.get?.('map-shine-advanced', 'fogPersistenceMaxDim'));
    return Number.isFinite(n) ? n : 1024;
  } catch (_) {
    return 1024;
  }
}

function easeInOutCosine(t) {
  return (1 - Math.cos(Math.max(0, Math.min(1, t)) * Math.PI)) / 2;
}

/** Match DoorMeshManager / Foundry wall door `animation.type` strings (UI may vary casing). */
function normalizeWallDoorAnimationType(raw) {
  if (raw === undefined || raw === null) return 'swing';
  const s = String(raw).trim().toLowerCase();
  if (!s) return 'swing';
  if (s === 'sliding') return 'slide';
  return s;
}

/**
 * Foundry passes `updateWall` hooks with a `changes` object; sometimes `ds` is
 * nested under `diff` (see Document#update). Without this, door fog transitions
 * never start and no door-sync logic runs.
 */
function wallChangesIncludeDoorState(changes) {
  if (!changes || typeof changes !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(changes, 'ds')) return true;
  const d = changes.diff;
  return !!(d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, 'ds'));
}

/**
 * Z offset for the fog plane above groundZ.
 *
 * We want the fog plane to sit just above all world content that can be
 * occluded by fog (ground, tiles, tokens, environmental meshes) while
 * remaining as close as possible to the canonical ground plane to avoid
 * any unintended parallax or depth-related artifacts.
 *
 * NOTE:
 * - depthTest: false  ->-> fog does not participate in depth testing
 * - renderOrder: 9999 ->-> fog renders after everything else regardless of Z
 *
 * The small offset here is only to keep the plane numerically above other
 * meshes that may also sit near groundZ; visually, ordering is controlled
 * by renderOrder + disabled depth test.
 */
const FOG_PLANE_Z_OFFSET = 0.05; // Nearly coplanar with the ground plane to avoid parallax/perspective peeking

export class FogOfWarEffectV2 {
  constructor() {
    /** @type {string} */
    this.id = 'fog';
    /** @type {object} */
    this.layer = ENVIRONMENTAL_LAYER;
    /** @type {string} */
    this.requiredTier = 'low';
    /** @type {boolean} */
    this.enabled = true;
    /** @type {number} */
    this.priority = 10;
    /** @type {boolean} */
    this.alwaysRender = false;

    // The fog plane is a global overlay ->-> it covers the fully-accumulated floor
    // image rather than any individual floor. Running it per-floor would
    // multiply the fog darkening N times. The fog plane is placed on
    // OVERLAY_THREE_LAYER (31) so it is excluded from per-floor scene renders
    // (EffectComposer disables OVERLAY_THREE_LAYER during each floor pass) and
    // is presented exactly once per frame via _renderOverlayToScreen().
    this.floorScope = 'global';
    
    this.params = {
      enabled: true,
      unexploredColor: '#000000',
      exploredColor: '#000000',
      exploredOpacity: 0.5,
      softness: 6.0,
      noiseStrength: 6.0,
      noiseSpeed: 0.2,
      revealTokenInFogEnabled: false,
      doorFogSyncEnabled: true,
      doorFogSyncThickness: 0.08,
      doorFogSyncDefaultDurationMs: 500
    };

    // Scene reference
    this.mainScene = null;
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // The fog overlay plane mesh
    this.fogPlane = null;
    this.fogMaterial = null;
    
    // World-space vision render target
    this.visionRenderTarget = null;
    this.visionScene = null;
    this.visionCamera = null;
    this.visionMaterial = null;

    this._visionRTWidth = 1;
    this._visionRTHeight = 1;
    
    // Self-maintained exploration render target
    // We accumulate vision into this each frame: explored = max(explored, vision)
    // This gives us proper "explored but not visible" without relying on Foundry's
    // pre-populated exploration texture which marks outdoors as explored by default.
    this.explorationRenderTarget = null;
    this.explorationScene = null;
    this.explorationCamera = null;
    this.explorationMaterial = null;

    this._explorationRTWidth = 1;
    this._explorationRTHeight = 1;
    
    // Ping-pong targets for accumulation
    this._explorationTargetA = null;
    this._explorationTargetB = null;
    this._currentExplorationTarget = 'A';
    
    // Scene dimensions
    this.sceneRect = { x: 0, y: 0, width: 1, height: 1 };
    this.sceneDimensions = { width: 1, height: 1 };
    
    // Fallback textures
    this._fallbackWhite = null;
    this._fallbackBlack = null;
    
    this._initialized = false;

    // Track MapShine selection changes to know when to recompute vision
    this._lastSelectionVersion = '';
    
    // Track whether we have valid vision data (LOS polygons computed)
    // Used to hide fog plane until Foundry's async perception update completes
    this._hasValidVision = false;

    // Safety: count consecutive frames where we're stuck waiting for vision.
    // After a threshold we fall back to showing fog with whatever data we have
    // (prevents the fog plane being permanently hidden).
    this._visionRetryFrames = 0;
    this._maxVisionRetryFrames = 30; // ~0.5s at 60fps (GM / parity)
    // Players wait longer for Foundry perception; never use full-scene GI fallback (see token loop).
    this._maxVisionRetryFramesPlayer = 120; // ~2s at 60fps
    // True when the vision mask contains a full-scene white rect (global
    // illumination fallback) instead of a real LOS polygon. When set,
    // exploration accumulation is skipped to avoid polluting it past walls.
    this._visionIsFullSceneFallback = false;
    
    this._explorationLoadedFromFoundry = false;
    // Non-GM only: false while persisted exploration is decoding/uploading to GPU.
    // Prevents a frame where accumulation is allowed but explored RT is still stale/blank.
    this._explorationPlayerGpuReady = true;
    this._explorationLoadAttempts = 0;
    this._explorationDirty = false;
    this._lastFogStoreContextKey = '';
    this._lastFogStoreLoadKey = '';
    this._lastFogStoreSaveKey = '';
    this._lastFogStoreLoadFoundData = false;
    // Generation counter: incremented on every reset/re-init to detect stale
    // async TextureLoader callbacks that should no longer overwrite exploration.
    this._explorationLoadGeneration = 0;
    // Tracks when vision was rendered but exploration wasn't ready to accumulate.
    // When exploration finishes loading, we do one catch-up accumulation.
    this._pendingAccumulation = false;
    this._explorationCommitCount = 0;
    this._saveExplorationDebounced = null;
    this._isSavingExploration = false;
    this._isLoadingExploration = false;

    // Scene-transition guard: Foundry fog extraction/compression can run
    // during canvas teardown; avoid writing FogExploration while tearing down.
    this._isSceneTransitioning = false;
    // Increments to invalidate in-flight save/encode work.
    this._explorationSaveGeneration = 0;

    // PERF: Saving fog exploration requires a GPU->CPU readback + image encode.
    // On large scenes, this can stall the renderer for ~1s. Rate-limit saves so
    // they cannot happen repeatedly and create periodic hitching.
    this._lastExplorationSaveMs = 0;
    this._minExplorationSaveIntervalMs = 4000;

    // PERF: Reuse buffers for fog exploration saves to reduce GC pressure.
    // Note: this does NOT eliminate the GPU->CPU stall from readRenderTargetPixels,
    // but it does avoid repeated large allocations.
    this._explorationSaveBuffer = null; // Uint8Array
    this._explorationReadbackTileBuffer = null; // Uint8Array
    this._explorationReadbackTileSize = 256;
    this._explorationEncodeCanvas = null; // OffscreenCanvas | HTMLCanvasElement
    this._explorationEncodeCtx = null; // OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
    this._explorationEncodeImageData = null; // ImageData

    this._fullResTargetsReady = false;
    this._fullResTargetsQueued = false;
    this._loggedExplorationState = false;

    // SDF generator for smooth fog edges (eliminates polygon scalloping)
    /** @type {VisionSDF|null} */
    this._visionSDF = null;
    this._loggedSDFState = false;
    this._sdfUpdateFailed = false;

    // Elevation-aware LOS polygon computer used for fog vision rendering.
    // This gives us explicit wall-height filtering in levels-enabled scenes.
    this._visionPolygonComputer = new VisionPolygonComputer();

    // MS-LVL-060: Elevation band tracking for per-floor fog exploration.
    // When the active elevation band changes (e.g. navigating to a different
    // floor), the exploration accumulation buffer is reset so the new floor
    // starts with fresh fog ->-> matching Levels' behavior where changing floors
    // reveals only what the token can currently see on the new floor.
    /** @type {number|null} Last known elevation band bottom (null = not yet set) */
    this._lastElevationBandBottom = null;
    /** @type {number|null} Last known elevation band top */
    this._lastElevationBandTop = null;
    /**
     * Levels: after a floor/band change, keep an opaque fog hold until the new
     * band's exploration mask is on the GPU (or confirmed empty). Prevents a
     * one-frame composite with cleared RT + live vision (peek).
     */
    this._levelBandFogHold = false;
    /**
     * Levels: {@link getActiveElevationBandKey} for which exploration RT pixels
     * are authoritative (cleared black or loaded texture). If the live band
     * key differs, we must sync GPU before compositing — otherwise one frame can
     * show the previous floor's explored mask on the new floor.
     * @type {string|null}
     */
    this._explorationGpuBandKey = null;

    // Door->fog transition sync: keep fog reveal/occlusion temporally aligned
    // with door visual opening/closing rather than snapping instantly on ds.
    // Keyed by wallId.
    this._doorFogTransitions = new Map();
    this._doorStateCache = new Map();
    this._doorFogDefaultDurationMs = 500;
    this._doorFogThicknessGrid = 0.35;

    // Socket listener for the authoritative fog reset broadcast from Foundry's
    // server. canvas.fog.reset() emits 'resetFog' via socket; the server then
    // calls _handleReset() on every client. That path does NOT fire a
    // deleteFogExploration hook, so we listen to the socket directly to ensure
    // V2 exploration buffers are always cleared on reset regardless of whether
    // the user has a persisted FogExploration document.
    /** @type {Function|null} */
    this._fogResetSocketHandler = null;
  }

  /**
   * Door leaf segments from wall `doc` + `openFactor`, matching DoorMeshManager math and
   * the same eased openFactor produced by `_getDoorFogTransitionState` (LOS stays time-synced
   * with fog transitions). Foundry canvas coordinates.
   *
   * @param {object} doc
   * @param {number} openFactor
   * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
   * @private
   */
  _computeDoorLeafSegmentsDocMath(doc, openFactor) {
    const segs = [];
    const c = doc?.c;
    if (!Array.isArray(c) || c.length < 4) return segs;

    const ax = Number(c[0]);
    const ay = Number(c[1]);
    const bx = Number(c[2]);
    const by = Number(c[3]);
    if (![ax, ay, bx, by].every(Number.isFinite)) return segs;

    const wallDx = bx - ax;
    const wallDy = by - ay;
    const wallLen = Math.hypot(wallDx, wallDy);
    if (wallLen <= 0.001) return segs;

    const anim = doc.animation || {};
    const animationType = normalizeWallDoorAnimationType(anim.type);
    const strength = Number.isFinite(anim.strength) ? Number(anim.strength) : 1;
    const baseDirection = Number.isFinite(anim.direction) ? Number(anim.direction) : 1;
    const isDouble = !!anim.double;

    const a = Coordinates.toWorld(ax, ay);
    const b = Coordinates.toWorld(bx, by);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0.001) return segs;

    const angle = Math.atan2(dy, dx);
    const styles = isDouble ? ['doubleL', 'doubleR'] : ['single'];
    const t = Math.max(0, Math.min(1, Number(openFactor) || 0));

    for (const styleKey of styles) {
      let direction = baseDirection;
      if (styleKey === 'doubleR') direction *= -1;

      const isMidpoint =
        animationType === 'ascend' || animationType === 'descend' || animationType === 'swivel';

      let pivot;
      if (styleKey === 'doubleR') {
        pivot = isMidpoint
          ? { x: a.x + dx * 0.75, y: a.y + dy * 0.75 }
          : { x: b.x, y: b.y };
      } else if (styleKey === 'doubleL') {
        pivot = isMidpoint
          ? { x: a.x + dx * 0.25, y: a.y + dy * 0.25 }
          : { x: a.x, y: a.y };
      } else {
        pivot = isMidpoint
          ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          : { x: a.x, y: a.y };
      }

      const width = styleKey === 'single' ? distance : distance * 0.5;
      const baseRotation = styleKey === 'doubleR' ? (angle - Math.PI) : angle;

      let wx = pivot.x;
      let wy = pivot.y;
      let rotation = baseRotation;
      let len = width;

      switch (animationType) {
        case 'swing':
        case 'swivel':
          rotation = baseRotation + (Math.PI / 2) * direction * strength * t;
          break;
        case 'slide': {
          const m = styleKey === 'single' ? strength : strength * 0.5;
          wx = pivot.x + (a.x - b.x) * direction * m * t;
          wy = pivot.y + (a.y - b.y) * direction * m * t;
          break;
        }
        case 'ascend': {
          const scaleIncrease = 0.1 * strength * t;
          len = width * (1 + scaleIncrease);
          break;
        }
        case 'descend': {
          const scaleDecrease = 0.05 * strength * t;
          len = Math.max(width * (1 - scaleDecrease), width * 0.05);
          break;
        }
        default:
          rotation = baseRotation + (Math.PI / 2) * direction * strength * t;
      }

      const endWx = wx + Math.cos(rotation) * len;
      const endWy = wy + Math.sin(rotation) * len;
      const pF = Coordinates.toFoundry(wx, wy);
      const eF = Coordinates.toFoundry(endWx, endWy);
      if (![pF.x, pF.y, eF.x, eF.y].every(Number.isFinite)) continue;
      segs.push({ x0: pF.x, y0: pF.y, x1: eF.x, y1: eF.y });
    }

    return segs;
  }

  /**
   * Fallback: derive segments from live Three door meshes (bbox × matrixWorld).
   * Only used when doc math yields nothing (degenerate wall, etc.).
   *
   * @param {object} doc
   * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
   * @private
   */
  _computeDoorLeafSegmentsMeshBbox(doc) {
    const segs = [];
    const c = doc?.c;
    if (!Array.isArray(c) || c.length < 4) return segs;

    const dm = window.MapShine?.doorMeshManager;
    const wid = doc?.id;
    const meshSet = dm?.doorMeshes?.get(String(wid ?? ''))
      ?? dm?.doorMeshes?.get(wid);
    if (!meshSet || typeof meshSet[Symbol.iterator] !== 'function') return segs;

    const THREE = window.THREE;
    if (!THREE) return segs;

    for (const doorMesh of meshSet) {
      const mesh = doorMesh?.mesh;
      if (!mesh) continue;
      const geom = mesh.geometry;
      if (!geom) continue;

      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (!bb || !(bb.max.x - bb.min.x > 0.001)) continue;

      mesh.updateMatrixWorld(true);
      const yMid = (bb.min.y + bb.max.y) * 0.5;
      const v0 = new THREE.Vector3(bb.min.x, yMid, 0);
      const v1 = new THREE.Vector3(bb.max.x, yMid, 0);
      v0.applyMatrix4(mesh.matrixWorld);
      v1.applyMatrix4(mesh.matrixWorld);

      const pF = Coordinates.toFoundry(v0.x, v0.y);
      const eF = Coordinates.toFoundry(v1.x, v1.y);
      if (![pF.x, pF.y, eF.x, eF.y].every(Number.isFinite)) continue;
      segs.push({ x0: pF.x, y0: pF.y, x1: eF.x, y1: eF.y });
    }

    return segs;
  }

  /**
   * Each door leaf as a segment in Foundry canvas coordinates (matches VisionPolygonComputer).
   * Prefers **doc + openFactor** math so LOS uses the same eased progress as fog transitions;
   * mesh bbox is a last resort only.
   *
   * @param {object} doc - Wall document
   * @param {number} openFactor - 0 closed .. 1 open
   * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
   */
  _getDoorTransitionLeafSegmentsFoundry(doc, openFactor) {
    const math = this._computeDoorLeafSegmentsDocMath(doc, openFactor);
    if (math.length) return math;
    return this._computeDoorLeafSegmentsMeshBbox(doc);
  }

  /**
   * Build temporary LOS blocker wall-like entries for animated door leaves.
   * These are injected into VisionPolygonComputer so door transitions cast
   * proper visibility shadows instead of only masking a thin strip.
   *
   * @param {number} nowMs
   * @returns {{ blockers: Array<object>, transitioningWallIds: Set<string> }}
   * @private
   */
  _buildDoorTransitionBlockingWalls(nowMs) {
    const empty = { blockers: [], transitioningWallIds: new Set() };
    if (!this.params?.doorFogSyncEnabled) return empty;
    if (!this._doorFogTransitions.size) return empty;

    const out = [];
    const transitioningWallIds = new Set();
    const walls = canvas?.walls?.placeables;
    if (!Array.isArray(walls) || !walls.length) return empty;

    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;
      if (!(Number(doc.door ?? 0) > 0)) continue;

      const state = this._getDoorFogTransitionState(doc.id, nowMs);
      if (!state) continue;
      const wallId = String(doc.id || '');

      const segments = this._getDoorTransitionLeafSegmentsFoundry(doc, state.openFactor);
      for (const seg of segments) {
        if (![seg.x0, seg.y0, seg.x1, seg.y1].every(Number.isFinite)) continue;
        out.push({
          document: {
            c: [seg.x0, seg.y0, seg.x1, seg.y1],
            sight: CONST.WALL_SENSE_TYPES?.NORMAL ?? 20,
            light: CONST.WALL_SENSE_TYPES?.NORMAL ?? 20,
            door: CONST.WALL_DOOR_TYPES?.NONE ?? 0,
            dir: CONST.WALL_DIRECTIONS?.BOTH ?? 0,
            // Match real wall vertical bounds (Levels / wall-height) so door leaves
            // don't block or pass wrong floors during transitions.
            ...(doc.flags && typeof doc.flags === 'object' ? { flags: doc.flags } : {}),
          },
        });
      }
      // Only strip the real wall from the LOS polygon list when we have at least
      // one synthetic leaf segment. Otherwise we remove the wall line but inject
      // nothing — vision treats the open door as no edge (wrong during animation).
      if (wallId && segments.length > 0) transitioningWallIds.add(wallId);
    }

    return { blockers: out, transitioningWallIds };
  }

  resetExploration({ markLoaded = true } = {}) {
    if (!this._initialized) return;
    if (!this.renderer) return;
    if (!this._explorationTargetA || !this._explorationTargetB) return;

    const THREE = window.THREE;

    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();

    this.renderer.setClearColor(0x000000, 1);

    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.clear();

    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();

    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);

    this._currentExplorationTarget = 'A';
    this._needsVisionUpdate = true;
    this._hasValidVision = false;

    this._explorationDirty = false;
    this._explorationCommitCount = 0;

    // Mark exploration loaded for explicit resets; callers can opt out when
    // they are about to load a different actor/floor context.
    this._explorationLoadedFromFoundry = !!markLoaded;
    // Cleared targets are a valid synchronous state for non-GM clients.
    this._explorationPlayerGpuReady = true;
    // Bump generation so any in-flight async TextureLoader callbacks from a
    // prior _ensureExplorationLoadedFromStore() call are silently ignored.
    this._explorationLoadGeneration++;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'fog',
          label: 'Fog of War',
          type: 'inline',
          parameters: ['unexploredColor', 'exploredColor', 'exploredOpacity', 'softness', 'noiseStrength', 'noiseSpeed', 'revealTokenInFogEnabled', 'doorFogSyncEnabled', 'doorFogSyncThickness', 'doorFogSyncDefaultDurationMs']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        unexploredColor: { type: 'color', default: '#000000', label: 'Unexplored' },
        exploredColor: { type: 'color', default: '#000000', label: 'Explored Tint' },
        exploredOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Explored Opacity' },
        softness: { type: 'slider', min: 0, max: 12, step: 0.5, default: 3.0, label: 'Edge Softness' },
        noiseStrength: { type: 'slider', min: 0, max: 12, step: 0.5, default: 2.0, label: 'Edge Distortion (px)' },
        noiseSpeed: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.2, label: 'Distortion Speed' },
        revealTokenInFogEnabled: { type: 'boolean', default: false, label: 'Reveal Token Bubbles' },
        doorFogSyncEnabled: { type: 'boolean', default: true, label: 'Door Sync' },
        doorFogSyncThickness: { type: 'slider', min: 0.01, max: 0.5, step: 0.01, default: 0.08, label: 'Door Sync Thickness' },
        doorFogSyncDefaultDurationMs: { type: 'slider', min: 50, max: 2500, step: 25, default: 500, label: 'Door Sync Duration (ms)' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    if (this._initialized) return;
    
    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;

    this.renderer = renderer;
    this.mainScene = scene;
    const THREE = window.THREE;

    // Get scene dimensions from Foundry
    if (_isDbg) _dlp.begin('fog.sceneDimensions', 'effect');
    this._updateSceneDimensions();
    if (_isDbg) _dlp.end('fog.sceneDimensions');

    // Respect Foundry scene fog colors if provided
    try {
      const colors = canvas?.scene?.fog?.colors;
      if (colors?.unexplored) this.params.unexploredColor = colors.unexplored;
      if (colors?.explored) this.params.exploredColor = colors.explored;
    } catch (_) {
      // Ignore
    }
    
    // Create fallback textures
    if (_isDbg) _dlp.begin('fog.createTargets', 'effect');
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(whiteData, 1, 1, THREE.RGBAFormat);
    this._fallbackWhite.needsUpdate = true;
    
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;

    this._createMinimalTargets();

    try {
      const maxAniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 0;
      if (maxAniso > 0) {
        if (this.visionRenderTarget?.texture) this.visionRenderTarget.texture.anisotropy = maxAniso;
        if (this._explorationTargetA?.texture) this._explorationTargetA.texture.anisotropy = maxAniso;
        if (this._explorationTargetB?.texture) this._explorationTargetB.texture.anisotropy = maxAniso;
      }
    } catch (_) {
    }
    if (_isDbg) _dlp.end('fog.createTargets');

    this._saveExplorationDebounced = foundry.utils.debounce(
      this._saveExplorationToFoundry.bind(this),
      2000
    );
    
    // Create the fog overlay plane
    if (_isDbg) _dlp.begin('fog.createPlane', 'effect');
    this._createFogPlane();
    if (_isDbg) _dlp.end('fog.createPlane');
    
    // Register Foundry hooks for vision updates
    if (_isDbg) _dlp.begin('fog.registerHooks', 'effect');
    this._registerHooks();
    if (_isDbg) _dlp.end('fog.registerHooks');
    
    this._initialized = true;

    // One-shot diagnostic: confirm fog plane setup
    const fp = this.fogPlane;
    log.info(`FogOfWarEffectV2 initialized - fogPlane: ${!!fp}, layer: ${fp?.layers?.mask}, renderOrder: ${fp?.renderOrder}, visible: ${fp?.visible}, pos: (${fp?.position?.x?.toFixed(0)}, ${fp?.position?.y?.toFixed(0)}, ${fp?.position?.z?.toFixed(2)}), sceneRect: (${this.sceneRect.x}, ${this.sceneRect.y}, ${this.sceneRect.width}x${this.sceneRect.height}), tokenVision: ${canvas?.scene?.tokenVision}, globalIllum: ${this._isGlobalIlluminationActive()}`);

    this._queueUpgradeTargets();
  }

  /**
   * Console-callable diagnostic ->-> run `MapShine.fogEffect.diagnose()` in the
   * browser console to get a snapshot of all relevant fog state.
   */
  diagnose() {
    const fp = this.fogPlane;
    const isGM = isGmLike();
    const controlled = canvas?.tokens?.controlled || [];
    const msSelection = window.MapShine?.interactionManager?.selection;
    const info = {
      initialized: this._initialized,
      enabled: this.enabled,
      paramsEnabled: this.params.enabled,
      fogPlaneExists: !!fp,
      fogPlaneVisible: fp?.visible,
      fogPlaneLayer: fp?.layers?.mask,
      fogPlaneRenderOrder: fp?.renderOrder,
      fogPlanePosition: fp ? `(${fp.position.x.toFixed(0)}, ${fp.position.y.toFixed(0)}, ${fp.position.z.toFixed(2)})` : 'N/A',
      fogPlaneInScene: fp ? this.mainScene?.children?.includes(fp) : false,
      fullResTargetsReady: this._fullResTargetsReady,
      visionRTSize: `${this._visionRTWidth}x${this._visionRTHeight}`,
      explorationRTSize: `${this._explorationRTWidth}x${this._explorationRTHeight}`,
      needsVisionUpdate: this._needsVisionUpdate,
      hasValidVision: this._hasValidVision,
      visionRetryFrames: this._visionRetryFrames,
      bypassFog: this._shouldBypassFog(),
      tokenVision: canvas?.scene?.tokenVision ?? 'undefined',
      globalIllumination: this._isGlobalIlluminationActive(),
      isGM,
      foundryControlled: controlled.map(t => t.name),
      mapShineSelection: msSelection ? Array.from(msSelection) : [],
      explorationEnabled: canvas?.scene?.fog?.exploration ?? false,
      explorationLoaded: this._explorationLoadedFromFoundry,
      explorationPlayerGpuReady: this._explorationPlayerGpuReady,
      levelBandFogHold: this._levelBandFogHold,
      explorationGpuBandKey: this._explorationGpuBandKey,
      liveBandKey: (() => {
        try {
          return getActiveElevationBandKey();
        } catch (_) {
          return null;
        }
      })(),
      explorationLoadGeneration: this._explorationLoadGeneration,
      realUserIsGM: !!game?.user?.isGM,
      fogStoreContextResolved: this._computeFogStoreContext().resolved,
      fogStoreContextKey: this._lastFogStoreContextKey,
      fogStoreLoadKey: this._lastFogStoreLoadKey,
      fogStoreSaveKey: this._lastFogStoreSaveKey,
      fogStoreLoadFoundData: this._lastFogStoreLoadFoundData,
      visionIsFullSceneFallback: this._visionIsFullSceneFallback,
      pendingAccumulation: this._pendingAccumulation,
      explorationDirty: this._explorationDirty,
    };

    // Also check token vision data
    const allTokens = [...controlled];
    if (msSelection && window.MapShine?.tokenManager?.tokenSprites) {
      const placeables = canvas?.tokens?.placeables || [];
      for (const id of msSelection) {
        if (!window.MapShine.tokenManager.tokenSprites.has(id)) continue;
        const t = placeables.find(p => p.document?.id === id);
        if (t && !allTokens.includes(t)) allTokens.push(t);
      }
    }
    info.tokenDiag = allTokens.map(t => {
      const vs = t.vision;
      const shape = vs?.los || vs?.shape || vs?.fov;
      return {
        name: t.name,
        sightEnabled: t.document?.sight?.enabled ?? false,
        hasVision: !!vs,
        visionActive: vs?.active ?? 'N/A',
        hasLos: !!vs?.los,
        losPoints: vs?.los?.points?.length || 0,
        hasShape: !!vs?.shape,
        shapePoints: vs?.shape?.points?.length || 0,
        hasFov: !!vs?.fov,
        fovPoints: vs?.fov?.points?.length || 0,
      };
    });

    console.table(info);
    if (info.tokenDiag.length > 0) {
      console.table(info.tokenDiag);
    }
    return info;
  }

  _computeFogStoreContext() {
    const bandKey = getActiveElevationBandKey();
    const actorIds = getRelevantActorIdsForFog();
    const key = buildFogStoreContextKey(actorIds, bandKey);
    const realGm = !!game?.user?.isGM;
    let resolved = false;
    if (bandKey) {
      if (realGm) {
        resolved = Array.isArray(actorIds) && actorIds.length === 1;
      } else {
        // Players: band resolved; zero owned tokens still yields a stable empty key
        // (no persistence) without spinning forever.
        resolved = true;
      }
    }
    return { bandKey, actorIds, key, resolved };
  }

  _handleFogStoreContextChange() {
    const { key } = this._computeFogStoreContext();
    if (key === this._lastFogStoreContextKey) return;
    this._lastFogStoreContextKey = key;
    this._explorationLoadAttempts = 0;
    this._pendingAccumulation = false;
    // Prevent leaking previous token exploration while we wait for the new key.
    this.resetExploration({ markLoaded: false });
    this._needsVisionUpdate = true;
    this._hasValidVision = false;
    void this._ensureExplorationLoadedFromStore();
  }

  _createMinimalTargets() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._visionRTWidth = 1;
    this._visionRTHeight = 1;
    this._explorationRTWidth = 1;
    this._explorationRTHeight = 1;

    try {
      if (this.visionRenderTarget) {
        this.visionRenderTarget.dispose();
        this.visionRenderTarget = null;
      }
    } catch (_) {
    }

    try {
      if (this._explorationTargetA) {
        this._explorationTargetA.dispose();
        this._explorationTargetA = null;
      }
      if (this._explorationTargetB) {
        this._explorationTargetB.dispose();
        this._explorationTargetB = null;
      }
    } catch (_) {
    }

    this.visionRenderTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    });

    this.visionScene = new THREE.Scene();

    const w = Math.max(1, this.sceneRect?.width ?? 1);
    const h = Math.max(1, this.sceneRect?.height ?? 1);
    this.visionCamera = new THREE.OrthographicCamera(
      0, w,
      h, 0,
      0, 100
    );
    this.visionCamera.position.set(0, 0, 10);

    this.visionMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    const rtOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    };

    this._explorationTargetA = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this._explorationTargetB = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this._currentExplorationTarget = 'A';

    this.explorationScene = new THREE.Scene();
    this.explorationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.explorationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPreviousExplored: { value: null },
        tCurrentVision: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tPreviousExplored;
        uniform sampler2D tCurrentVision;
        varying vec2 vUv;
        
        void main() {
          float prev = texture2D(tPreviousExplored, vUv).r;
          float curr = texture2D(tCurrentVision, vUv).r;
          float explored = max(prev, curr);
          gl_FragColor = vec4(explored, explored, explored, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.explorationMaterial);
    this.explorationScene.add(quad);

    this._fullResTargetsReady = false;
  }

  _queueUpgradeTargets() {
    if (this._fullResTargetsQueued) return;
    this._fullResTargetsQueued = true;

    setTimeout(() => {
      this._fullResTargetsQueued = false;
      this._upgradeTargetsToFullRes();
    }, 0);
  }

  _upgradeTargetsToFullRes() {
    if (!this._initialized) return;
    if (!this.renderer) return;
    const THREE = window.THREE;
    if (!THREE) return;

    try {
      if (this.visionRenderTarget) {
        this.visionRenderTarget.dispose();
        this.visionRenderTarget = null;
      }
      if (this._explorationTargetA) {
        this._explorationTargetA.dispose();
        this._explorationTargetA = null;
      }
      if (this._explorationTargetB) {
        this._explorationTargetB.dispose();
        this._explorationTargetB = null;
      }
    } catch (_) {
    }

    this._createVisionRenderTarget();
    this._createExplorationRenderTarget();

    // Create or resize the SDF generator to match the vision RT resolution
    if (this._visionSDF) {
      this._visionSDF.resize(this._visionRTWidth, this._visionRTHeight);
    } else {
      this._visionSDF = new VisionSDF(this.renderer, this._visionRTWidth, this._visionRTHeight);
      this._visionSDF.initialize();
    }

    try {
      if (this.fogMaterial?.uniforms?.tVision && this.visionRenderTarget?.texture) {
        this.fogMaterial.uniforms.tVision.value = this.visionRenderTarget.texture;
      }
    } catch (_) {
    }

    this._fullResTargetsReady = true;
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
    this._explorationGpuBandKey = null;
    this._needsVisionUpdate = true;
    this._hasValidVision = false;

    log.info(`Full-res render targets ready ->-> vision: ${this._visionRTWidth}x${this._visionRTHeight}, exploration: ${this._explorationRTWidth}x${this._explorationRTHeight}, SDF: ${!!this._visionSDF}`);
  }

  /**
   * Update scene dimensions from Foundry
   * @private
   */
  _updateSceneDimensions() {
    if (canvas?.dimensions) {
      this.sceneDimensions = {
        width: canvas.dimensions.width || 1,
        height: canvas.dimensions.height || 1
      };
      
      const rect = canvas.dimensions.sceneRect;
      if (rect) {
        this.sceneRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      } else {
        this.sceneRect = {
          x: 0,
          y: 0,
          width: this.sceneDimensions.width,
          height: this.sceneDimensions.height
        };
      }
    }
  }

  /**
   * Create the world-space vision render target
   * @private
   */
  _createVisionRenderTarget() {
    const THREE = window.THREE;
    const { width, height } = this.sceneRect;
    
    // Use a reasonable resolution (can be lower than scene for performance)
    const maxTexSize = this.renderer?.capabilities?.maxTextureSize ?? 2048;
    // PERF: Keep fog RT size modest. 4096^2 readbacks (exploration persistence)
    // can be extremely expensive and cause long-task hitches.
    const maxSize = Math.min(2048, maxTexSize);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);

    this._visionRTWidth = rtWidth;
    this._visionRTHeight = rtHeight;
    
    this.visionRenderTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
      // No MSAA ->-> unnecessary for a binary white/black vision mask.
      // LinearFilter already smooths edges. MSAA would add 4x fragment
      // cost and can cause texture-resolve issues when this RT is sampled
      // in the exploration accumulation shader on some drivers.
    });
    
    // Create a scene for rendering vision polygons
    this.visionScene = new THREE.Scene();
    
    // Orthographic camera covering the scene rect in Foundry coordinates
    // Foundry: origin top-left, Y-down, but the polygon point data we get from
    // PointVisionSource is in the same pixel space as canvas (0..width, 0..height).
    // Use a standard orthographic frustum that spans this box so our shapes are
    // fully inside the render volume.
    this.visionCamera = new THREE.OrthographicCamera(
      0, width,    // left, right
      height, 0,   // top, bottom
      0, 100
    );
    this.visionCamera.position.set(0, 0, 10);
    
    // Material for drawing vision polygons (white = visible)
    this.visionMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    // Material for drawing darkness source shapes (black = not visible).
    // Rendered AFTER vision/light shapes to subtract darkness areas.
    this.darknessMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.DoubleSide
    });
    
    log.debug(`Vision render target created: ${rtWidth}x${rtHeight}`);
  }

  /**
   * Create the self-maintained exploration render target
   * We use ping-pong rendering to accumulate: explored = max(explored, vision)
   * @private
   */
  _createExplorationRenderTarget() {
    const THREE = window.THREE;
    const { width, height } = this.sceneRect;
    
    // Use same resolution as vision target
    const maxTexSize = this.renderer?.capabilities?.maxTextureSize ?? 2048;
    // PERF: Match vision target cap. This directly impacts the cost of
    // readRenderTargetPixels when persisting exploration.
    const maxSize = Math.min(2048, maxTexSize);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const rtWidth = Math.ceil(width * scale);
    const rtHeight = Math.ceil(height * scale);

    this._explorationRTWidth = rtWidth;
    this._explorationRTHeight = rtHeight;
    
    const rtOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    };
    
    // Create two targets for ping-pong rendering
    this._explorationTargetA = new THREE.WebGLRenderTarget(rtWidth, rtHeight, rtOptions);
    this._explorationTargetB = new THREE.WebGLRenderTarget(rtWidth, rtHeight, rtOptions);
    this._currentExplorationTarget = 'A';
    
    // Scene and camera for accumulation pass
    this.explorationScene = new THREE.Scene();
    this.explorationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Material that does: output = max(previousExplored, currentVision)
    this.explorationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPreviousExplored: { value: null },
        tCurrentVision: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tPreviousExplored;
        uniform sampler2D tCurrentVision;
        varying vec2 vUv;
        
        void main() {
          float prev = texture2D(tPreviousExplored, vUv).r;
          float curr = texture2D(tCurrentVision, vUv).r;
          float explored = max(prev, curr);
          gl_FragColor = vec4(explored, explored, explored, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
    
    // Full-screen quad for accumulation
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.explorationMaterial);
    this.explorationScene.add(quad);
    
    // Clear both targets to black initially
    const currentTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();
    this.renderer.setRenderTarget(currentTarget);
    
    log.debug(`Exploration render targets created: ${rtWidth}x${rtHeight}`);
  }

  /**
   * Get the current exploration texture (the one we read from)
   * @private
   */
  _getExplorationReadTarget() {
    return this._currentExplorationTarget === 'A' 
      ? this._explorationTargetA 
      : this._explorationTargetB;
  }

  /**
   * Get the exploration texture to write to (the other one)
   * @private
   */
  _getExplorationWriteTarget() {
    return this._currentExplorationTarget === 'A' 
      ? this._explorationTargetB 
      : this._explorationTargetA;
  }

  /**
   * Swap exploration targets after accumulation
   * @private
   */
  _swapExplorationTargets() {
    this._currentExplorationTarget = this._currentExplorationTarget === 'A' ? 'B' : 'A';
  }

  /**
   * Accumulate current vision into exploration texture
   * explored = max(explored, vision)
   * @private
   */
  _accumulateExploration() {
    if (!this.explorationMaterial || !this._explorationTargetA) return;
    
    const readTarget = this._getExplorationReadTarget();
    const writeTarget = this._getExplorationWriteTarget();
    
    // Set up uniforms
    this.explorationMaterial.uniforms.tPreviousExplored.value = readTarget.texture;
    this.explorationMaterial.uniforms.tCurrentVision.value = this.visionRenderTarget.texture;
    
    // Render accumulation pass
    const currentTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(writeTarget);
    this.renderer.render(this.explorationScene, this.explorationCamera);
    this.renderer.setRenderTarget(currentTarget);
    
    // Swap targets so next frame reads from the one we just wrote
    this._swapExplorationTargets();
  }

  /**
   * Create the fog overlay plane mesh
   * @private
   */
  _createFogPlane() {
    const THREE = window.THREE;
    const { x, y, width, height } = this.sceneRect;
    
    // Create shader material for fog compositing.
    // Vision edges use a Signed Distance Field (SDF) generated by VisionSDF
    // via Jump Flood Algorithm, producing perfectly smooth edges regardless
    // of the input polygon's vertex density. Falls back to the legacy
    // sampleSoft() multi-tap blur when the SDF is unavailable.
    this.fogMaterial = new THREE.ShaderMaterial({
      extensions: {
        derivatives: true
      },
      uniforms: {
        tVision: { value: this.visionRenderTarget.texture },
        tVisionSDF: { value: this._fallbackBlack },
        tExplored: { value: this._fallbackBlack },
        uUnexploredColor: { value: new THREE.Color(0x000000) },
        uExploredColor: { value: new THREE.Color(0x000000) },
        uExploredOpacity: { value: 0.5 },
        uBypassFog: { value: 0.0 },
        uSoftnessPx: { value: 2.0 },
        uTime: { value: 0.0 },
        uNoiseStrengthPx: { value: 0.0 },
        uNoiseSpeed: { value: 0.0 },
        uNoiseScale: { value: 3.0 },
        uVisionTexelSize: { value: new THREE.Vector2(1, 1) },
        uExploredTexelSize: { value: new THREE.Vector2(1, 1) },
        uUseSDF: { value: 0.0 },
        uSDFMaxDistance: { value: 32.0 },
        // Maps full-canvas plane UVs to the scene rect sub-region
        // vec4(uOffset.x, uOffset.y, uScale.x, uScale.y)
        // sceneUv = (planeUv - offset) / scale
        uSceneUVRect: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tVision;
        uniform sampler2D tVisionSDF;
        uniform sampler2D tExplored;
        uniform vec3 uUnexploredColor;
        uniform vec3 uExploredColor;
        uniform float uExploredOpacity;
        uniform float uBypassFog;
        uniform float uSoftnessPx;
        uniform float uTime;
        uniform float uNoiseStrengthPx;
        uniform float uNoiseSpeed;
        uniform float uNoiseScale;
        uniform vec2 uVisionTexelSize;
        uniform vec2 uExploredTexelSize;
        uniform float uUseSDF;
        uniform float uSDFMaxDistance;
        // Maps full-canvas plane UVs to scene rect sub-region:
        // xy = offset, zw = scale. sceneUv = (planeUv - offset) / scale
        uniform vec4 uSceneUVRect;

        varying vec2 vUv;

        // --- Noise for edge distortion ---
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        // --- Legacy multi-tap blur for exploration edges (and SDF fallback) ---
        float sampleSoft(sampler2D tex, vec2 uv, vec2 texel, float radiusPx) {
          float r = clamp(radiusPx, 0.0, 32.0);
          if (r <= 0.01) return texture2D(tex, uv).r;

          vec2 d1 = texel * max(1.0, r * 0.5);
          vec2 d2 = texel * max(1.0, r);

          float c = texture2D(tex, uv).r * 0.25;

          float cross = 0.0;
          cross += texture2D(tex, uv + vec2(d1.x, 0.0)).r;
          cross += texture2D(tex, uv + vec2(-d1.x, 0.0)).r;
          cross += texture2D(tex, uv + vec2(0.0, d1.y)).r;
          cross += texture2D(tex, uv + vec2(0.0, -d1.y)).r;

          float diag = 0.0;
          diag += texture2D(tex, uv + vec2(d2.x, d2.y)).r;
          diag += texture2D(tex, uv + vec2(-d2.x, d2.y)).r;
          diag += texture2D(tex, uv + vec2(d2.x, -d2.y)).r;
          diag += texture2D(tex, uv + vec2(-d2.x, -d2.y)).r;

          return c + cross * 0.125 + diag * 0.0625;
        }

        // --- SDF-based vision sampling ---
        // The SDF texture stores normalized signed distance:
        //   0.5 = on edge, >0.5 = inside (visible), <0.5 = outside (fog)
        // We convert back to pixel distance and apply a smooth edge.
        //
        // Key insight: fwidth(signedDist) tells us how many SDF pixels
        // correspond to one screen pixel. Using this as the minimum edge
        // width ensures the anti-aliased transition is always ~1 screen
        // pixel wide ->-> producing clean sharp lines at any zoom level,
        // without the staircase pattern from low-res texture sampling.
        float sampleVisionSDF(vec2 uv, float softnessPx) {
          float sdfVal = texture2D(tVisionSDF, uv).r;

          // Convert from normalized [0,1] back to signed pixel distance
          // (positive = inside visible area, negative = outside)
          float signedDist = (sdfVal - 0.5) * 2.0 * uSDFMaxDistance;

          // Screen-adaptive anti-aliasing: fwidth gives the rate of change
          // of signedDist per screen pixel. For a smooth SDF this is ~1.0
          // at edges. Using it as minimum edge width ensures a 1-screen-pixel
          // anti-aliased transition regardless of zoom level.
          float screenAA = fwidth(signedDist) * 0.75;
          float edgeWidth = max(softnessPx, max(screenAA, 0.5));
          return smoothstep(-edgeWidth, edgeWidth, signedDist);
        }
        
        void main() {
          if (uBypassFog > 0.5) {
            discard;
          }
          
          // --- Noise-based UV warp for organic edge distortion ---
          float t = uTime * uNoiseSpeed;
          vec2 nUv = vUv * uNoiseScale + vec2(t * 0.11, t * 0.07);
          float n0 = noise2(nUv);
          float n1 = noise2(nUv + 17.31);
          vec2 n = vec2(n0, n1) - 0.5;
          float noiseUvScale = max(max(uVisionTexelSize.x, uVisionTexelSize.y), max(uExploredTexelSize.x, uExploredTexelSize.y));
          vec2 uvWarp = n * (uNoiseStrengthPx * noiseUvScale);

          // Remap from full-canvas plane UVs to scene rect sub-region UVs.
          // The fog plane covers the entire canvas (including padding), but
          // vision/exploration textures only cover the scene rect.
          vec2 sceneUv = (vUv - uSceneUVRect.xy) / uSceneUVRect.zw;

          // Anything outside the scene rect [0,1] is fully fogged (padded region)
          bool outsideScene = sceneUv.x < 0.0 || sceneUv.x > 1.0 || sceneUv.y < 0.0 || sceneUv.y > 1.0;
          if (outsideScene) {
            gl_FragColor = vec4(uUnexploredColor, 1.0);
            return;
          }

          // UV needs Y-flip because Three.js plane UVs are bottom-left origin
          // but our vision camera renders with top-left origin (Foundry coords)
          vec2 visionUv = vec2(sceneUv.x, 1.0 - sceneUv.y) + uvWarp;

          // --- Sample vision: SDF path (smooth) or legacy path (multi-tap blur) ---
          float visible;
          if (uUseSDF > 0.5) {
            // SDF path: perfectly smooth edges from the JFA distance field
            visible = sampleVisionSDF(visionUv, uSoftnessPx);
          } else {
            // Legacy fallback: multi-tap blur + fwidth threshold
            float vision = sampleSoft(tVision, visionUv, uVisionTexelSize, uSoftnessPx);
            float softnessPx = max(uSoftnessPx, 0.0);
            float dv = max(fwidth(vision), 1e-4);
            float dVisPx = (vision - 0.5) / dv;
            visible = (softnessPx <= 0.01)
              ? step(0.5, vision)
              : smoothstep(-softnessPx, softnessPx, dVisPx);
          }
          
          // --- Exploration: keep sampling in stable world-space UVs ---
          // Do NOT apply animated uvWarp here. Exploration represents persistent
          // discovered world state, so warping it causes the semi-transparent
          // explored tint to appear to drift/swim over the map.
          vec2 exploredUv = vec2(sceneUv.x, 1.0 - sceneUv.y);
          float explored = sampleSoft(tExplored, exploredUv, uExploredTexelSize, uSoftnessPx);
          float softnessPxE = max(uSoftnessPx, 0.0);
          float de = max(fwidth(explored), 1e-4);
          float dExpPx = (explored - 0.5) / de;
          float exploredMask = (softnessPxE <= 0.01)
            ? step(0.5, explored)
            : smoothstep(-softnessPxE, softnessPxE, dExpPx);

          // --- Compose fog ---
          float fogAlpha = 1.0 - visible;
          float exploredAlpha = mix(1.0, uExploredOpacity, exploredMask);
          vec3 fogColor = mix(uUnexploredColor, uExploredColor, exploredMask);
          float outAlpha = fogAlpha * exploredAlpha;

          if (outAlpha <= 0.001) {
            discard;
          }

          gl_FragColor = vec4(fogColor, outAlpha);
        }
      `,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // Keep framebuffer alpha unchanged (opaque) so explored-opacity fog does
      // not reveal underlying canvases as a camera-locked ghost image.
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,  // Disable depth test - fog always renders on top via renderOrder
      side: THREE.DoubleSide
    });
    
    // Create plane geometry covering the FULL canvas (including padding)
    // so fog darkness extends into the padded region around the scene.
    const fullW = this.sceneDimensions.width;
    const fullH = this.sceneDimensions.height;
    const geometry = new THREE.PlaneGeometry(fullW, fullH);
    
    this.fogPlane = new THREE.Mesh(geometry, this.fogMaterial);
    this.fogPlane.name = 'FogOverlayPlane';
    
    // Ensure fog renders on top of everything in the scene
    this.fogPlane.renderOrder = 9999;
    this.fogPlane.layers.set(OVERLAY_THREE_LAYER);
    
    // Position the plane in Three.js world space, centered on the full canvas.
    // Three.js: origin bottom-left, Y-up.
    const centerX = fullW / 2;
    const centerY = fullH / 2;
    
    // Position fog plane relative to groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.fogPlane.position.set(centerX, centerY, groundZ + FOG_PLANE_Z_OFFSET);
    
    // Frustum culling off - always render
    this.fogPlane.frustumCulled = false;
    
    // Compute UV rect mapping: the plane covers the full canvas [0,1] in UV,
    // but vision/exploration textures only cover the scene rect sub-region.
    // sceneUv = (planeUv - offset) / scale
    // PlaneGeometry UV Y=0 is bottom (Three.js), but sceneRect.y is top-down
    // (Foundry). Flip the Y offset so the scene rect maps correctly.
    const uvOffsetX = x / fullW;
    const uvOffsetY = (fullH - y - height) / fullH;
    const uvScaleX = width / fullW;
    const uvScaleY = height / fullH;
    this.fogMaterial.uniforms.uSceneUVRect.value.set(uvOffsetX, uvOffsetY, uvScaleX, uvScaleY);
    
    // Add to main scene
    this.mainScene.add(this.fogPlane);
    
    log.debug(`Fog plane created at (${centerX}, ${centerY}, ${groundZ + FOG_PLANE_Z_OFFSET}), size ${fullW}x${fullH} (full canvas incl. padding), sceneUVRect=(${uvOffsetX.toFixed(3)}, ${uvOffsetY.toFixed(3)}, ${uvScaleX.toFixed(3)}, ${uvScaleY.toFixed(3)})`);
  }

  /**
   * Register Foundry hooks for vision updates
   * @private
   */
  _registerHooks() {
    // Vision needs to be re-rendered when:
    // - Token moves
    // - Token is controlled/released
    // - Lighting changes
    // - Walls change
    
    // We'll trigger updates on these hooks
    this._hookIds.push(['controlToken', Hooks.on('controlToken', (token, controlled) => {
      log.debug(`controlToken hook: ${token?.name} controlled=${controlled}`);
      this._needsVisionUpdate = true;
      this._hasValidVision = false; // Reset until we get valid LOS polygons
      this._handleFogStoreContextChange();
    })]);
    this._hookIds.push(['updateToken', Hooks.on('updateToken', (_doc, changes) => {
      this._needsVisionUpdate = true;
    })]);
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => { this._needsVisionUpdate = true; })]);
    this._hookIds.push(['lightingRefresh', Hooks.on('lightingRefresh', () => { this._needsVisionUpdate = true; })]);
    this._hookIds.push(['createWall', Hooks.on('createWall', () => {
      this._primeDoorStateCache();
      this._needsVisionUpdate = true;
      try {
        if (!window.MapShine?.__debugSkipForcePerceptionOnWall) {
          frameCoordinator.forcePerceptionUpdate();
        }
      } catch (_) {}
    })]);
    this._hookIds.push(['updateWall', Hooks.on('updateWall', (doc, changes) => {
      this._onDoorWallUpdated(doc, changes);
      this._needsVisionUpdate = true;
      try {
        if (!window.MapShine?.__debugSkipForcePerceptionOnWall) {
          frameCoordinator.forcePerceptionUpdate();
        }
      } catch (_) {}
    })]);
    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', (doc) => {
      this._doorFogTransitions.delete(String(doc?.id || ''));
      this._doorStateCache.delete(String(doc?.id || ''));
      this._needsVisionUpdate = true;
      try {
        if (!window.MapShine?.__debugSkipForcePerceptionOnWall) {
          frameCoordinator.forcePerceptionUpdate();
        }
      } catch (_) {}
    })]);

    // MS-LVL-060: When the active level context changes (floor navigation),
    // check if the elevation band has changed. If so, reset exploration so
    // the new floor starts with fresh fog ->-> matching Levels' per-floor fog
    // reveal behavior. Also force a vision update since wall-height filtering
    // may produce a different LOS polygon for the new elevation.
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', (ctx) => {
      this._needsVisionUpdate = true;
      this._checkElevationBandChange();
    })]);

    // Keep local exploration in sync with Foundry's authoritative FogExploration
    // document lifecycle. This ensures reset/sync events from core UI and sockets
    // are reflected immediately in the V2 fog accumulation buffers.
    this._hookIds.push(['deleteFogExploration', Hooks.on('deleteFogExploration', (doc) => {
      this._onFoundryFogExplorationDeleted(doc);
    })]);
    this._hookIds.push(['createFogExploration', Hooks.on('createFogExploration', (doc) => {
      this._onFoundryFogExplorationChanged(doc);
    })]);
    this._hookIds.push(['updateFogExploration', Hooks.on('updateFogExploration', (doc) => {
      this._onFoundryFogExplorationChanged(doc);
    })]);
    
    // Directly intercept the Foundry fog-reset socket broadcast so V2 exploration
    // buffers are cleared even when no FogExploration document existed for the
    // current user (which means deleteFogExploration hook would never fire).
    // The server emits 'resetFog' with { sceneId } to all clients.
    try {
      if (game?.socket) {
        this._fogResetSocketHandler = ({ sceneId } = {}) => {
          try {
            if (!sceneId || sceneId !== canvas?.scene?.id) return;
            log.info('[FOG] resetFog socket received — clearing V2 exploration buffers');
            this.resetExploration();
            this._needsVisionUpdate = true;
          } catch (_) {}
        };
        game.socket.on('resetFog', this._fogResetSocketHandler);
      }
    } catch (_) {}

    // Pause V2 persistence writes during Foundry canvas teardown / scene switch.
    // However: if the user reloads Foundry quickly after exploring, cancelling
    // the pending save can prevent the latest explored mask from ever being
    // written to FogExploration. So we do a best-effort flush BEFORE
    // suspending/cancelling.
    this._hookIds.push(['canvasTearDown', Hooks.on('canvasTearDown', () => {
      try {
        // Best-effort only (async). We intentionally do not await: teardown
        // should not be blocked by GPU readbacks or encoding stalls.
        void this._flushExplorationSaveOnTearDown('canvasTearDown');
      } catch (_) {}
      try { this._suspendExplorationSaves('canvasTearDown'); } catch (_) {}
    })]);
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      try { this._resumeExplorationSaves(); } catch (_) {}
    })]);

    // Initial render: force perception so that any starting
    // controlled token (or vision source) has a valid LOS
    // polygon before the first fog mask is drawn.
    this._primeDoorStateCache();
    frameCoordinator.forcePerceptionUpdate();
    this._needsVisionUpdate = true; // Initial render
  }

  _primeDoorStateCache() {
    const walls = canvas?.walls?.placeables;
    if (!Array.isArray(walls)) return;
    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;
      if (!(Number(doc.door ?? 0) > 0)) continue;
      this._doorStateCache.set(String(doc.id), Number(doc.ds ?? 0));
    }
  }

  /**
   * @private
   */
  _isActiveUserSceneFogDoc(doc) {
    const sceneId = canvas?.scene?.id;
    const userId = game?.user?.id;
    if (!doc || !sceneId || !userId) return false;

    const docSceneId = doc.scene ?? doc._source?.scene ?? doc.parent?.id ?? null;
    const docUserId = doc.user ?? doc._source?.user ?? null;
    return (docSceneId === sceneId) && (docUserId === userId);
  }

  /**
   * @private
   */
  _onFoundryFogExplorationDeleted(doc) {
    if (!this._isActiveUserSceneFogDoc(doc)) return;
    this.resetExploration();
    this._needsVisionUpdate = true;
    this._hasValidVision = false;
    this._pendingAccumulation = false;
  }

  /**
   * @private
   */
  _onFoundryFogExplorationChanged(doc) {
    if (!this._isActiveUserSceneFogDoc(doc)) return;

    // Reload from Foundry doc so external sync/corrections are reflected in V2.
    this._explorationLoadedFromFoundry = false;
    if (!game?.user?.isGM) this._explorationPlayerGpuReady = false;
    this._explorationLoadAttempts = 0;
    this._pendingAccumulation = false;
    this._lastFogStoreContextKey = '';
    this._explorationLoadGeneration++;
    void this._ensureExplorationLoadedFromStore();
  }

  async _ensureExplorationLoadedFromStore() {
    if (this._explorationLoadedFromFoundry) return;
    if (this._isLoadingExploration) return;

    const tokenVisionEnabled = canvas?.scene?.tokenVision ?? false;
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    if (!tokenVisionEnabled || !explorationEnabled) {
      this._explorationLoadedFromFoundry = true;
      this._explorationPlayerGpuReady = true;
      return;
    }

    // Must match scene-sized exploration RTs; loading into 1x1 minimal targets corrupts the mask.
    if (!this._fullResTargetsReady) {
      setTimeout(() => {
        try {
          void this._ensureExplorationLoadedFromStore();
        } catch (_) {}
      }, 100);
      return;
    }

    this._isLoadingExploration = true;
    const loadGeneration = this._explorationLoadGeneration;
    const nonGm = !game?.user?.isGM;
    let asyncDecodePlayer = false;

    try {
      const { bandKey, actorIds, key, resolved } = this._computeFogStoreContext();
      this._lastFogStoreLoadKey = key;
      if (!resolved) {
        // Floor/token context not fully resolved yet; retry shortly without committing to blank.
        setTimeout(() => {
          try {
            if (loadGeneration !== this._explorationLoadGeneration) return;
            void this._ensureExplorationLoadedFromStore();
          } catch (_) {}
        }, 120);
        return;
      }
      const base64 = await loadUnionExplorationForActors({ actorIds, bandKey });

      // Stale?
      if (loadGeneration !== this._explorationLoadGeneration) return;

      // No data -> treat as successful blank load.
      if (typeof base64 !== 'string' || base64.length === 0) {
        this._lastFogStoreLoadFoundData = false;
        this._explorationLoadedFromFoundry = true;
        if (nonGm) this._explorationPlayerGpuReady = true;
        this._levelBandFogHold = false;
        return;
      }

      this._lastFogStoreLoadFoundData = true;
      const THREE = window.THREE;
      const loader = new THREE.TextureLoader();

      const endPlayerAsyncLoad = () => {
        this._isLoadingExploration = false;
      };

      // Non-GM: do not mark exploration "loaded" until pixels are uploaded — avoids
      // accumulating vision onto a stale/blank RT for one or more frames.
      if (nonGm) {
        this._explorationPlayerGpuReady = false;
        asyncDecodePlayer = true;
        loader.load(
          base64,
          (texture) => {
            try {
              if (loadGeneration !== this._explorationLoadGeneration) {
                try { texture.dispose?.(); } catch (_) {}
                return;
              }
              texture.flipY = false;
              texture.needsUpdate = true;
              this._renderLoadedExplorationTexture(texture);
              this._explorationLoadedFromFoundry = true;
              this._explorationPlayerGpuReady = true;
            } catch (e) {
              log.warn('Failed to apply stored fog exploration texture', e);
              this._explorationLoadedFromFoundry = true;
              this._explorationPlayerGpuReady = true;
              this._levelBandFogHold = false;
            } finally {
              try { texture.dispose?.(); } catch (_) {}
              endPlayerAsyncLoad();
            }
          },
          undefined,
          (err) => {
            log.warn('Failed to load stored fog exploration texture', err);
            this._explorationLoadedFromFoundry = true;
            this._explorationPlayerGpuReady = true;
            this._levelBandFogHold = false;
            endPlayerAsyncLoad();
          }
        );
        return;
      }

      this._explorationLoadedFromFoundry = true;
      loader.load(
        base64,
        (texture) => {
          try {
            if (loadGeneration !== this._explorationLoadGeneration) {
              try { texture.dispose?.(); } catch (_) {}
              return;
            }
            texture.flipY = false;
            texture.needsUpdate = true;
            this._renderLoadedExplorationTexture(texture);
          } catch (e) {
            log.warn('Failed to apply stored fog exploration texture', e);
            this._levelBandFogHold = false;
          } finally {
            try { texture.dispose?.(); } catch (_) {}
          }
        },
        undefined,
        (err) => {
          log.warn('Failed to load stored fog exploration texture', err);
          this._levelBandFogHold = false;
        }
      );
    } catch (e) {
      log.warn('[FOG] Exploration store load failed', e);
      this._explorationLoadAttempts++;
      this._explorationLoadedFromFoundry = true;
      if (nonGm) this._explorationPlayerGpuReady = true;
      this._levelBandFogHold = false;
    } finally {
      if (!asyncDecodePlayer) {
        this._isLoadingExploration = false;
      }
    }
  }

  /**
   * MS-LVL-060: Check if the active elevation band has changed since last
   * check. If so, reset the exploration accumulation buffer so the new
   * floor starts with fresh fog.
   *
   * @private
   */
  _checkElevationBandChange() {
    if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return;

    const scene = canvas?.scene;
    if (!scene || !isLevelsEnabledForScene(scene)) return;

    const levelCtx = window.MapShine?.activeLevelContext;
    if (!levelCtx) return;

    const bandBottom = Number.isFinite(levelCtx.bottom) ? levelCtx.bottom : null;
    const bandTop = Number.isFinite(levelCtx.top) ? levelCtx.top : null;

    // First time ->-> just record the band, don't reset
    if (this._lastElevationBandBottom === null && this._lastElevationBandTop === null) {
      this._lastElevationBandBottom = bandBottom;
      this._lastElevationBandTop = bandTop;
      return;
    }

    // Band unchanged ->-> nothing to do
    if (bandBottom === this._lastElevationBandBottom && bandTop === this._lastElevationBandTop) {
      return;
    }

    // Band changed ->-> load persisted exploration for this floor (Map Shine store).
    log.info(`[MS-LVL-060] Elevation band changed: [${this._lastElevationBandBottom}, ${this._lastElevationBandTop}] -> [${bandBottom}, ${bandTop}]`);
    this._lastElevationBandBottom = bandBottom;
    this._lastElevationBandTop = bandTop;

    this.resetExploration({ markLoaded: false });
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
    this._pendingAccumulation = false;
    this._explorationGpuBandKey = getActiveElevationBandKey();
    this._levelBandFogHold = true;
    void this._ensureExplorationLoadedFromStore();
    this._needsVisionUpdate = true;
    this._hasValidVision = false;
  }

  /**
   * Keep fog LOS occlusion scoped to the active Levels elevation band.
   * Walls fully outside the current band cannot block vision for this floor.
   *
   * @param {Array<object>} walls
   * @returns {Array<object>}
   * @private
   */
  _filterWallsForActiveElevationBand(walls) {
    const list = Array.isArray(walls) ? walls : [];
    if (!list.length) return list;
    if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return list;
    if (!isLevelsEnabledForScene(canvas?.scene)) return list;

    const levelCtx = window.MapShine?.activeLevelContext;
    const rawBottom = Number(levelCtx?.bottom);
    const rawTop = Number(levelCtx?.top);
    if (!Number.isFinite(rawBottom) || !Number.isFinite(rawTop)) return list;

    const bandBottom = Math.min(rawBottom, rawTop);
    const bandTop = Math.max(rawBottom, rawTop);

    // Degenerate bands should not suppress all walls; keep original list.
    if (!(bandTop > bandBottom)) return list;

    return list.filter((wallLike) => {
      const doc = wallLike?.document || wallLike;
      if (!doc) return false;

      const bounds = readWallHeightFlags(doc);
      let wallBottom = Number(bounds?.bottom);
      let wallTop = Number(bounds?.top);
      wallBottom = Number.isFinite(wallBottom) ? wallBottom : -Infinity;
      wallTop = Number.isFinite(wallTop) ? wallTop : Infinity;
      if (wallTop < wallBottom) {
        const swap = wallBottom;
        wallBottom = wallTop;
        wallTop = swap;
      }

      // Top-exclusive overlap test, matching Levels-style wall range handling.
      return (wallTop === Infinity || wallTop > bandBottom)
        && (wallBottom < bandTop);
    });
  }

  _onDoorWallUpdated(doc, changes) {
    const doorType = Number(doc?.door ?? 0);
    if (!(doorType > 0)) return;
    const flat = flattenWallUpdateChanges(changes);
    if (!Object.prototype.hasOwnProperty.call(flat, 'ds')) return;

    const wallId = String(doc?.id || '');
    if (!wallId) return;

    const nextState = Number(flat.ds ?? doc?.ds ?? 0);
    const cachedPrevState = this._doorStateCache.get(wallId);
    const prevState = Number.isFinite(cachedPrevState)
      ? cachedPrevState
      : (nextState === CONST.WALL_DOOR_STATES.OPEN
        ? CONST.WALL_DOOR_STATES.CLOSED
        : CONST.WALL_DOOR_STATES.OPEN);
    this._doorStateCache.set(wallId, nextState);
    if (prevState === nextState) return;

    const durationMs = Math.max(
      1,
      Number(doc?.animation?.duration)
      || Number(doc?._source?.animation?.duration)
      || Number(this.params?.doorFogSyncDefaultDurationMs)
      || this._doorFogDefaultDurationMs
    );

    this._doorFogTransitions.set(wallId, {
      wallId,
      startTimeMs: performance.now(),
      durationMs,
      fromState: prevState,
      toState: nextState,
    });

    try {
      const loop = window.MapShine?.renderLoop;
      loop?.requestRender?.();
      loop?.requestContinuousRender?.(Math.min(3000, durationMs + 120));
    } catch (_) {
      // Best effort only.
    }
  }

  _getDoorFogTransitionState(wallId, nowMs) {
    const key = String(wallId || '');
    if (!key) return null;

    const entry = this._doorFogTransitions.get(key);
    if (!entry) return null;

    const elapsedMs = Math.max(0, nowMs - entry.startTimeMs);
    const t = entry.durationMs > 0 ? (elapsedMs / entry.durationMs) : 1;
    if (t >= 1) {
      this._doorFogTransitions.delete(key);
      return null;
    }

    const eased = easeInOutCosine(t);
    const fromOpen = entry.fromState === CONST.WALL_DOOR_STATES.OPEN ? 1 : 0;
    const toOpen = entry.toState === CONST.WALL_DOOR_STATES.OPEN ? 1 : 0;
    const openFactor = fromOpen + (toOpen - fromOpen) * eased;

    return {
      openFactor,
      isOpening: toOpen > fromOpen,
      isClosing: toOpen < fromOpen,
    };
  }

  _addDoorTransitionVisionOverlays(THREE, nowMs) {
    if (!this.params?.doorFogSyncEnabled) return;
    if (!this._doorFogTransitions.size) return;

    const walls = canvas?.walls?.placeables;
    if (!Array.isArray(walls) || !walls.length) return;

    const gridSize = Number(canvas?.dimensions?.size ?? 100);
    const thicknessGrid = Number(this.params?.doorFogSyncThickness ?? this._doorFogThicknessGrid);
    const halfThickness = Math.max(0.75, gridSize * Math.max(0.01, thicknessGrid)) * 0.5;
    const offsetX = this.sceneRect.x;
    const offsetY = this.sceneRect.y;

    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;
      if (!(Number(doc.door ?? 0) > 0)) continue;

      const state = this._getDoorFogTransitionState(doc.id, nowMs);
      if (!state) continue;
      // Opening: no raster overlay — only animated LOS segments (avoids vision=0 → solid fog).
      if (!state.isClosing) continue;

      const segments = this._getDoorTransitionLeafSegmentsFoundry(doc, state.openFactor);
      for (const seg of segments) {
        const leafPx = seg.x0 - offsetX;
        const leafPy = seg.y0 - offsetY;
        const ex = seg.x1 - offsetX;
        const ey = seg.y1 - offsetY;
        if (![leafPx, leafPy, ex, ey].every(Number.isFinite)) continue;

        const segDx = ex - leafPx;
        const segDy = ey - leafPy;
        const segLen = Math.hypot(segDx, segDy);
        if (segLen <= 0.001) continue;

        const nx = -segDy / segLen;
        const ny = segDx / segLen;
        const ox = nx * halfThickness;
        const oy = ny * halfThickness;

        const shape = new THREE.Shape();
        shape.moveTo(leafPx + ox, leafPy + oy);
        shape.lineTo(ex + ox, ey + oy);
        shape.lineTo(ex - ox, ey - oy);
        shape.lineTo(leafPx - ox, leafPy - oy);
        shape.closePath();

        const opener = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: false,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
          })
        );
        opener.renderOrder = 5;
        this.visionScene.add(opener);
      }
    }
  }

  /**
   * Render vision polygons to the world-space render target
   * @private
   */
  _renderVisionMask() {
    if (!this.visionRenderTarget || !this.visionScene || !this.visionCamera) return;
    
    const THREE = window.THREE;
    
    // Clear the vision scene
    while (this.visionScene.children.length > 0) {
      const child = this.visionScene.children[0];
      this.visionScene.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material && child.material !== this.visionMaterial && child.material !== this.darknessMaterial) {
        child.material.dispose();
      }
    }
    
    // Resolve vision tokens:
    // 1) Prefer MapShine's interactionManager selection (Three.js-driven UI)
    // 2) Fallback to Foundry's canvas.tokens.controlled
    // 3) For real non-GM clients only: if nothing is selected/controlled, use all owned tokens
    let controlledTokens = [];
    const ms = window.MapShine;
    const interactionManager = ms?.interactionManager;
    const tokenManager = ms?.tokenManager;
    const selection = interactionManager?.selection;
    const realGm = !!game?.user?.isGM;
    const user = game?.user;

    if (selection && tokenManager?.tokenSprites) {
      const placeables = canvas?.tokens?.placeables || [];
      const selectedIds = Array.from(selection);
      for (const id of selectedIds) {
        if (!tokenManager.tokenSprites.has(id)) continue;
        const token = placeables.find(t => t.document?.id === id);
        if (token) controlledTokens.push(token);
      }
    }

    // Fallback: use Foundry's native controlled tokens if MapShine selection is empty
    if (!controlledTokens.length) {
      controlledTokens = canvas?.tokens?.controlled || [];
    }

    // Non-GM trust boundary: never rasterize vision for tokens the user does not own.
    if (!realGm && user) {
      controlledTokens = controlledTokens.filter((t) => tokenIsOwnedByActiveUser(t, user));
    }

    // Player default: when nothing is selected/controlled, show combined vision of owned tokens.
    if (!realGm && user && !controlledTokens.length) {
      try {
        const placeables = canvas?.tokens?.placeables || [];
        if (placeables.length) {
          controlledTokens = placeables.filter((t) => tokenIsOwnedByActiveUser(t, user));
        }
      } catch (_) {
        // Ignore ownership resolution errors
      }
    }

    // Always log when we have controlled tokens but no vision yet (state transition diagnostic)
    if (controlledTokens.length > 0 && !this._hasValidVision) {
      const visionSources = canvas?.effects?.visionSources;
      log.debug(`[FOG DIAG] Vision sources: ${visionSources?.size || 0}, controlled: ${controlledTokens.length}, retryFrame: ${this._visionRetryFrames}`);
      for (const token of controlledTokens) {
        const vs = token.vision;
        const hasSight = this._tokenHasVisionCapability(token);
        const shape = vs?.los || vs?.shape || vs?.fov;
        log.debug(`  [FOG DIAG] Token "${token.name}": sight.enabled=${hasSight}, vision=${!!vs}, active=${vs?.active ?? 'N/A'}, los=${!!vs?.los}, shape=${!!vs?.shape}, fov=${!!vs?.fov}, points=${shape?.points?.length || 0}`);
      }
    }
    
    // Global illumination means the token can see in the dark ->-> but it does
    // NOT bypass walls or sight range. Foundry's LOS polygon already accounts
    // for global illumination when computing visibility. We should always use
    // the token's actual LOS polygon when it exists.
    //
    // For tokens whose LOS is degenerate (e.g. sight.range=0), global
    // illumination can use a full-scene rect on **GM clients only** so they
    // aren't briefly blind while perception catches up. Real players never
    // get that rect — it ignores walls in the vision mask. Exploration skips
    // the GM GI fallback via _visionIsFullSceneFallback when accumulating.
    const globalIllumActive = this._isGlobalIlluminationActive();
    this._visionIsFullSceneFallback = false;

    const levelsActive = getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
      && isLevelsEnabledForScene(canvas?.scene);
    const baseWalls = canvas?.walls?.placeables ?? [];
    const levelWalls = levelsActive ? this._filterWallsForActiveElevationBand(baseWalls) : null;
    const nowMs = performance.now();
    const doorTransitionData = this._buildDoorTransitionBlockingWalls(nowMs);
    const doorTransitionBlockers = levelsActive
      ? this._filterWallsForActiveElevationBand(doorTransitionData.blockers)
      : doorTransitionData.blockers;
    const transitioningDoorWallIds = doorTransitionData.transitioningWallIds;
    const hasDoorTransitionLOSBlockers = doorTransitionBlockers.length > 0;
    const polygonWalls = (levelsActive ? (levelWalls ?? []) : baseWalls).filter((w) => {
      const wallId = String(w?.document?.id || '');
      return !transitioningDoorWallIds.has(wallId);
    });
    const polygonWallsWithDoors = hasDoorTransitionLOSBlockers
      ? polygonWalls.concat(doorTransitionBlockers)
      : polygonWalls;
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneBounds = sceneRect
      ? { x: sceneRect.x, y: sceneRect.y, width: sceneRect.width, height: sceneRect.height }
      : null;

    // Categorize tokens into three groups:
    // - tokensWithValidLOS: have a vision source with a valid polygon
    // - tokensWaitingForLOS: have sight enabled and a vision source, but LOS hasn't computed yet
    // - tokensWithoutSight: don't have sight enabled or have no vision source at all
    // Only tokensWaitingForLOS should trigger retries. tokensWithoutSight are simply skipped.
    let polygonsRendered = 0;
    let tokensWaitingForLOS = 0;
    let tokensWithoutSight = 0;

    for (const token of controlledTokens) {
      const visionSource = token.vision;
      const hasSight = this._tokenHasVisionCapability(token);

      // Prefer MapShine's custom LOS polygon for all sight-capable 360-vision
      // tokens. This keeps fog behavior consistent across token types/systems
      // (PC/NPC, PF2e bestiary imports, etc.) even when Foundry visionSource
      // objects are missing or delayed. Non-360 cones still use Foundry fallback.
      if (hasSight) {
        const sightAngle = Number(token.document?.sight?.angle ?? 360);
        const useCustomPolygon = !Number.isFinite(sightAngle) || sightAngle >= 360;
        if (useCustomPolygon) {
          const customPoints = this._computeTokenVisionPolygonPoints(token, polygonWallsWithDoors, sceneBounds);
          if (customPoints && customPoints.length >= 6) {
            this._addPolygonPointsToVisionScene(customPoints, THREE);
            polygonsRendered++;
            continue;
          }
        }
      }

      // Token has no vision source at all. If vision isn't enabled on the
      // token, this is expected ->-> skip it without triggering retries.
      if (!visionSource) {
        if (!hasSight) {
          tokensWithoutSight++;
        } else if (globalIllumActive && realGm && !this._levelBandFogHold) {
          // GM-only: full-scene rect spares a blind frame while perception spins up.
          // Never for real players — it ignores walls and reads as "see everything".
          // Never during a floor/band hold — LOS is often invalid for a frame on swap.
          this._addFullSceneRect(THREE);
          this._visionIsFullSceneFallback = true;
          polygonsRendered++;
        } else {
          // Real players (or no global illum): wait for a real vision source / LOS.
          tokensWaitingForLOS++;
          log.debug(`[FOG DIAG] Token "${token.name}" has sight enabled but no vision source yet ->-> waiting`);
        }
        continue;
      }

      // Vision source exists ->-> check if the LOS polygon has been computed.
      let shape = visionSource.los || visionSource.shape || visionSource.fov;

      if (!shape || !shape.points || shape.points.length < 6) {
        if (!hasSight) {
          // Sight disabled ->-> token has a default/inactive vision source.
          tokensWithoutSight++;
        } else if (globalIllumActive && realGm && !this._levelBandFogHold) {
          // GM-only full-scene GI fallback (see !visionSource branch above).
          this._addFullSceneRect(THREE);
          this._visionIsFullSceneFallback = true;
          polygonsRendered++;
        } else {
          // Sight enabled but polygon not ready yet (required for real players).
          tokensWaitingForLOS++;
          log.debug(`[FOG DIAG] Token "${token.name}" sight enabled, LOS not ready (points=${shape?.points?.length || 0})`);
        }
        continue;
      }

      // Valid LOS polygon ->-> always use it, regardless of global illumination.
      // Global illumination affects lighting, not wall occlusion.
      const points = shape.points;
      this._addPolygonPointsToVisionScene(points, THREE);
      polygonsRendered++;
    }

    // Phase 2: Light-Grants-Vision
    // Light sources with data.vision === true grant visibility within their area.
    // Draw their shapes into the vision mask alongside token LOS polygons.
    // MS-LVL-070: Skip lights outside the viewer's elevation range so lights
    // on other floors don't grant vision through the fog mask.
    try {
      const lightSources = canvas?.effects?.lightSources;
      if (lightSources) {
        const levelsActive = getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene);

        for (const lightSource of lightSources) {
          if (!lightSource.active || !lightSource.data?.vision) continue;
          // Skip GlobalLightSource ->-> handled separately via _isGlobalIlluminationActive
          if (lightSource.constructor?.name === 'GlobalLightSource') continue;

          // MS-LVL-070: Elevation-filter vision-granting lights
          if (levelsActive) {
            try {
              const lightDoc = lightSource.object?.document;
              if (lightDoc && !isLightVisibleForPerspective(lightDoc)) continue;
            } catch (_) {
              // Fail-open: if elevation check errors, keep the light
            }
          }

          const shape = lightSource.shape;
          if (!shape?.points || shape.points.length < 6) continue;

          const pts = shape.points;
          const lightShape = new THREE.Shape();
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;

          lightShape.moveTo(pts[0] - offsetX, pts[1] - offsetY);
          for (let i = 2; i < pts.length; i += 2) {
            lightShape.lineTo(pts[i] - offsetX, pts[i + 1] - offsetY);
          }
          lightShape.closePath();

          const geo = new THREE.ShapeGeometry(lightShape);
          const lightMesh = new THREE.Mesh(geo, this.visionMaterial);
          this.visionScene.add(lightMesh);
          polygonsRendered++;
        }
      }
    } catch (e) {
      log.warn('Failed to render light-grants-vision shapes:', e);
    }

    // Phase 3: Detection Mode Wall-Ignoring Radii
    // Senses such as tremorsense, wavesense, and scent bypass walls entirely.
    // For each controlled token that has such senses, draw a circle in the
    // vision mask at the token's position, regardless of LOS or wall geometry.
    // This matches Foundry's DetectionMode behaviour where `walls === false`
    // allows detection through any obstacle.
    try {
      const gsm = window.MapShine?.gameSystem;
      if (gsm?.getTokenDetectionRadii && controlledTokens.length > 0) {
        const gridSize = Number(canvas?.dimensions?.size ?? 100);
        const distance = Number(canvas?.dimensions?.distance ?? 5);
        const pixelsPerUnit = gridSize / distance;
        const offsetX = this.sceneRect.x;
        const offsetY = this.sceneRect.y;

        for (const token of controlledTokens) {
          let radii;
          try { radii = gsm.getTokenDetectionRadii(token); } catch (_) { radii = []; }
          if (!radii || radii.length === 0) continue;

          const doc = token?.document;
          if (!doc) continue;

          // Token center in scene-local coordinates
          let cx, cy;
          if (Number.isFinite(token?.center?.x) && Number.isFinite(token?.center?.y)) {
            cx = token.center.x - offsetX;
            cy = token.center.y - offsetY;
          } else {
            const tGridSize = Number(canvas?.dimensions?.size ?? 100);
            cx = Number(doc.x ?? 0) + Number(doc.width  ?? 1) * tGridSize * 0.5 - offsetX;
            cy = Number(doc.y ?? 0) + Number(doc.height ?? 1) * tGridSize * 0.5 - offsetY;
          }
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

          for (const { range } of radii) {
            const radiusPx = Number(range) * pixelsPerUnit;
            if (!(radiusPx > 0) || !Number.isFinite(radiusPx)) continue;

            // 32 segments gives a smooth circle at typical vision distances
            const circleGeo = new THREE.CircleGeometry(radiusPx, 32);
            const circleMesh = new THREE.Mesh(circleGeo, this.visionMaterial);
            circleMesh.position.set(cx, cy, 0);
            this.visionScene.add(circleMesh);
          }
          if (radii.length > 0) polygonsRendered++;
        }
      }
    } catch (e) {
      log.warn('Failed to render detection-mode wall-ignoring radii:', e);
    }

    // Phase 5: Darkness Source Integration
    // Darkness-emitting lights (PointDarknessSource) suppress vision within their area.
    // Draw their shapes in black AFTER vision/light shapes to subtract those zones.
    // Foundry stores these in canvas.effects.darknessSources (v12+).
    try {
      const darknessSources = canvas?.effects?.darknessSources;
      if (darknessSources) {
        for (const darknessSource of darknessSources) {
          if (!darknessSource.active) continue;

          const shape = darknessSource.shape;
          if (!shape?.points || shape.points.length < 6) continue;

          const pts = shape.points;
          const darkShape = new THREE.Shape();
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;

          darkShape.moveTo(pts[0] - offsetX, pts[1] - offsetY);
          for (let i = 2; i < pts.length; i += 2) {
            darkShape.lineTo(pts[i] - offsetX, pts[i + 1] - offsetY);
          }
          darkShape.closePath();

          const geo = new THREE.ShapeGeometry(darkShape);
          const darkMesh = new THREE.Mesh(geo, this.darknessMaterial);
          // Render darkness shapes slightly in front of vision shapes so they
          // overwrite (subtract) the white areas in the same render pass.
          darkMesh.renderOrder = 1;
          this.visionScene.add(darkMesh);
        }
      }
    } catch (e) {
      log.warn('Failed to render darkness source shapes:', e);
    }

    // Phase 6: MS-LVL-034 ->-> noFogHide tile fog suppression.
    // Tiles with the Levels `noFogHide` flag punch through the fog mask:
    // their bounds are rendered as white rectangles in the vision mask so
    // they remain visible even outside the token's LOS polygon.
    try {
      if (getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene)) {
        const tiles = canvas?.scene?.tiles;
        if (tiles) {
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;
          for (const tileDoc of tiles) {
            if (!tileDoc || !tileHasLevelsRange(tileDoc)) continue;
            const flags = readTileLevelsFlags(tileDoc);
            if (!flags.noFogHide) continue;

            // Only punch through fog for tiles visible at the current elevation
            // (no point revealing a tile on a different floor)
            const perspective = getPerspectiveElevation();
            if (perspective.source !== 'background') {
              const inRange = perspective.losHeight >= flags.rangeBottom
                && (flags.rangeTop === Infinity || perspective.losHeight < flags.rangeTop);
              if (!inRange) continue;
            }

            const tx = Number(tileDoc.x ?? 0) - offsetX;
            const ty = Number(tileDoc.y ?? 0) - offsetY;
            const tw = Number(tileDoc.width ?? 0);
            const th = Number(tileDoc.height ?? 0);
            if (tw <= 0 || th <= 0) continue;

            const tileShape = new THREE.Shape();
            tileShape.moveTo(tx, ty);
            tileShape.lineTo(tx + tw, ty);
            tileShape.lineTo(tx + tw, ty + th);
            tileShape.lineTo(tx, ty + th);
            tileShape.closePath();

            const geo = new THREE.ShapeGeometry(tileShape);
            const tileMesh = new THREE.Mesh(geo, this.visionMaterial);
            // Render after darkness sources but below normal LOS priority
            tileMesh.renderOrder = 2;
            this.visionScene.add(tileMesh);
          }
        }
      }
    } catch (e) {
      log.warn('Failed to render noFogHide tile shapes:', e);
    }

    // Phase 7: MS-LVL-061 ->-> revealTokenInFog equivalent.
    // When enabled, visible tokens on the current floor reveal a small area
    // of fog around themselves, even if they're outside the viewer's LOS.
    // This draws small circles at each visible token's position in the
    // vision mask. Uses Three.js CircleGeometry for efficient rendering.
    try {
      if (this.params?.revealTokenInFogEnabled
          && getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene)) {
        const tokens = canvas?.tokens?.placeables;
        if (tokens && tokens.length > 0) {
          const gridSize = Number(canvas?.scene?.grid?.size ?? canvas?.scene?.dimensions?.size ?? 100);
          // Bubble radius: roughly half a grid square, matching Levels' visual approach
          const bubbleRadius = gridSize * 0.6;
          const offsetX = this.sceneRect.x;
          const offsetY = this.sceneRect.y;
          const perspective = getPerspectiveElevation();
          const visibilityController = window.MapShine?.visibilityController;

          for (const token of tokens) {
            if (!token) continue;
            const doc = token.document;
            if (!doc) continue;

            // In Three-token mode, PIXI token.visible is intentionally kept true
            // for hit-testing. Use VisibilityController's computed LOS state (or
            // token.isVisible fallback) so unseen tokens do NOT punch fog holes.
            const tokenId = doc.id;
            const vcState = tokenId ? visibilityController?.getDetectionState?.(tokenId) : null;
            const isVisibleToVision = (vcState && typeof vcState.visible === 'boolean')
              ? vcState.visible
              : !!token?.isVisible;
            if (!isVisibleToVision) continue;

            // Only reveal tokens on the same floor as the viewer
            if (perspective.source !== 'background') {
              const tokenElev = Number(doc.elevation ?? 0);
              if (!Number.isFinite(tokenElev)) continue;
              // Skip tokens more than 1 level band away
              const delta = Math.abs(tokenElev - perspective.elevation);
              if (delta > 30) continue; // Generous threshold for "same floor"
            }

            const tw = Number(doc.width ?? 1) * gridSize;
            const th = Number(doc.height ?? 1) * gridSize;
            const cx = Number(doc.x ?? 0) + tw / 2 - offsetX;
            const cy = Number(doc.y ?? 0) + th / 2 - offsetY;

            const circleGeo = new THREE.CircleGeometry(bubbleRadius, 16);
            const circleMesh = new THREE.Mesh(circleGeo, this.visionMaterial);
            circleMesh.position.set(cx, cy, 0);
            circleMesh.renderOrder = 3;
            this.visionScene.add(circleMesh);
          }
        }
      }
    } catch (e) {
      log.warn('Failed to render revealTokenInFog bubbles:', e);
    }

    // Door-fog transition overlays (closing only): white strip softens re-occlusion.
    // Opening intentionally has no raster overlay — black quads zero vision and
    // read as solid fog through the doorway (especially with vision SDF).
    try {
      this._addDoorTransitionVisionOverlays(THREE, nowMs);
    } catch (e) {
      log.warn('Failed to render door transition fog overlays:', e);
    }
    
    // Render to the vision target (always render, even if no polygons ->->
    // that gives us a black texture = "nothing visible" = full fog)
    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();
    
    this.renderer.setRenderTarget(this.visionRenderTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.visionScene, this.visionCamera);
    
    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);
    
    // Determine result state.
    //
    // Key distinction: tokens without sight are NOT "invalid" ->-> they simply
    // don't contribute vision. Only tokens that SHOULD have LOS (sight enabled)
    // but DON'T yet should trigger retries.
    //
    // tokensWithSightRequirement = total tokens that should have LOS
    const tokensWithSightRequirement = controlledTokens.length - tokensWithoutSight;

    if (controlledTokens.length === 0) {
      // No controlled tokens at all ->-> mark complete, bypass handles visibility
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
    } else if (tokensWithSightRequirement === 0) {
      // All controlled tokens lack sight ->-> vision RT is intentionally black
      // (full fog). This is valid; don't retry.
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
      log.debug(`[FOG DIAG] All ${controlledTokens.length} controlled tokens lack sight ->-> full fog`);
    } else if (tokensWaitingForLOS > 0 && polygonsRendered === 0) {
      // Some tokens should have LOS but none are ready yet ->-> keep retrying
      frameCoordinator.forcePerceptionUpdate();
      this._hasValidVision = false;
      log.debug(`[FOG DIAG] Waiting for LOS: ${tokensWaitingForLOS} tokens pending, ${polygonsRendered} rendered`);
    } else {
      // We rendered at least some polygons, or all sight-enabled tokens were
      // handled. Mark as valid ->-> partial vision is better than no fog at all.
      this._needsVisionUpdate = false;
      this._hasValidVision = true;
      if (tokensWaitingForLOS > 0) {
        // Some tokens still waiting but we have at least partial vision.
        // Trigger another perception update but don't block fog display.
        frameCoordinator.forcePerceptionUpdate();
        this._needsVisionUpdate = true;
        log.debug(`[FOG DIAG] Partial vision: ${polygonsRendered} rendered, ${tokensWaitingForLOS} still waiting`);
      }
    }
  }


  /**
   * Check if fog should be bypassed (GM with no tokens selected)
   * @private
   */
  _tokenHasVisionCapability(token) {
    try {
      const gsm = window.MapShine?.gameSystem;
      if (gsm?.hasTokenVision) return !!gsm.hasTokenVision(token);
    } catch (_) {
      // Fall through to core token flags.
    }

    return !!(token?.hasSight || token?.document?.sight?.enabled);
  }

  _shouldBypassFog() {
    const fogEnabled = canvas?.scene?.tokenVision ?? false;

    if (!fogEnabled) return true;
    // During a Levels floor/band transition hold, never bypass — controlled tokens
    // are often empty for a frame and would otherwise hide the fog plane (full map flash).
    if (this._levelBandFogHold) return false;
    // Real GM only — debug GM parity must not disable fog for actual players.
    if (game?.user?.isGM) {
      // If GM and NO tokens are controlled, bypass fog
      const controlled = canvas?.tokens?.controlled || [];
      if (controlled.length === 0) return true;

      // If GM and ALL controlled tokens lack sight capability, bypass fog.
      const hasSightCapability = controlled.some((t) => this._tokenHasVisionCapability(t));
      if (!hasSightCapability) return true;
    }
    return false;
  }

  /**
   * Add a full-scene white rectangle to the vision scene.
   * Used as a fallback when global illumination is active and a token's
   * LOS polygon is unavailable or too small (e.g. sight.range = 0).
   * IMPORTANT: callers must set _visionIsFullSceneFallback = true so that
   * exploration accumulation is skipped ->-> otherwise the full-scene white
   * would be max()'d into the exploration texture permanently, marking
   * areas behind walls as explored.
   * @param {object} THREE - Three.js namespace
   * @private
   */
  _addFullSceneRect(THREE) {
    const w = Math.max(1, this.sceneRect.width);
    const h = Math.max(1, this.sceneRect.height);
    const fullShape = new THREE.Shape();
    fullShape.moveTo(0, 0);
    fullShape.lineTo(w, 0);
    fullShape.lineTo(w, h);
    fullShape.lineTo(0, h);
    fullShape.closePath();
    const geometry = new THREE.ShapeGeometry(fullShape);
    const mesh = new THREE.Mesh(geometry, this.visionMaterial);
    this.visionScene.add(mesh);
  }

  /**
   * Add a flat [x,y,...] polygon to the vision scene in scene-local space.
   * @param {number[]} points
   * @param {object} THREE
   * @private
   */
  _addPolygonPointsToVisionScene(points, THREE) {
    if (!Array.isArray(points) || points.length < 6) return;

    const threeShape = new THREE.Shape();
    const offsetX = this.sceneRect.x;
    const offsetY = this.sceneRect.y;

    threeShape.moveTo(points[0] - offsetX, points[1] - offsetY);
    for (let i = 2; i < points.length; i += 2) {
      threeShape.lineTo(points[i] - offsetX, points[i + 1] - offsetY);
    }
    threeShape.closePath();

    const geometry = new THREE.ShapeGeometry(threeShape);
    const mesh = new THREE.Mesh(geometry, this.visionMaterial);
    this.visionScene.add(mesh);
  }

  /**
   * Compute a token LOS polygon using VisionPolygonComputer.
   * This path is elevation-aware via wall-height filtering.
   *
   * @param {Token} token
   * @param {Wall[]} walls
   * @param {{x:number,y:number,width:number,height:number}|null} sceneBounds
   * @returns {number[]|null}
   * @private
   */
  _computeTokenVisionPolygonPoints(token, walls, sceneBounds) {
    try {
      const doc = token?.document;
      if (!doc) return null;

      // Prefer the active vision source radius when available.
      let radiusPixels = Number(
        token?.vision?.radius
        ?? token?.vision?.data?.radius
        ?? token?.vision?._radius
        ?? 0
      );

      // Use system adapter vision radius for systems where doc.sight.range is
      // not authoritative (e.g. PF2e often stores unlimited vision as range=0).
      if (!(radiusPixels > 0)) {
        try {
          const gsm = window.MapShine?.gameSystem;
          const distRadius = Number(gsm?.getTokenVisionRadius?.(token) ?? 0);
          if (distRadius > 0) {
            const px = Number(gsm?.distanceToPixels?.(distRadius) ?? 0);
            if (px > 0 && Number.isFinite(px)) radiusPixels = px;
          }
        } catch (_) {
          // Keep fallback chain below.
        }
      }

      if (!(radiusPixels > 0)) {
        const sightRange = Number(doc?.sight?.range ?? token?.sightRange ?? 0);
        const distance = Number(canvas?.dimensions?.distance ?? 0);
        const size = Number(canvas?.dimensions?.size ?? 0);
        if (sightRange > 0 && distance > 0 && size > 0) {
          radiusPixels = (sightRange / distance) * size;
        }
      }

      // Final fallback for implicit/unlimited vision: use scene diagonal so we
      // still compute a custom levels-aware polygon instead of falling back to
      // Foundry LOS polygons that may include cross-floor blockers.
      if (!(radiusPixels > 0)) {
        const rect = canvas?.dimensions?.sceneRect;
        const width = Number(rect?.width ?? canvas?.dimensions?.width ?? 0);
        const height = Number(rect?.height ?? canvas?.dimensions?.height ?? 0);
        if (width > 0 && height > 0) {
          radiusPixels = Math.hypot(width, height);
        }
      }

      if (!(radiusPixels > 0) || !Number.isFinite(radiusPixels)) return null;

      let centerX = Number(token?.center?.x);
      let centerY = Number(token?.center?.y);
      if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
        const gridSize = Number(canvas?.dimensions?.size ?? 100);
        const tokenWidth = Number(doc.width ?? 1) * gridSize;
        const tokenHeight = Number(doc.height ?? 1) * gridSize;
        centerX = Number(doc.x ?? 0) + tokenWidth * 0.5;
        centerY = Number(doc.y ?? 0) + tokenHeight * 0.5;
      }

      const viewerElevation = Number(token?.losHeight ?? doc?.elevation ?? 0);
      const options = Number.isFinite(viewerElevation)
        ? { sense: 'sight', elevation: viewerElevation }
        : { sense: 'sight' };

      const computed = this._visionPolygonComputer.compute(
        { x: centerX, y: centerY },
        radiusPixels,
        walls,
        sceneBounds,
        options
      );

      return Array.isArray(computed) && computed.length >= 6 ? computed : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Check if Foundry's global illumination is active. Used to decide whether
   * tokens with degenerate LOS polygons (sight.range=0) should get a
   * full-scene vision rect. Exploration accumulation is guarded separately
   * by _visionIsFullSceneFallback.
   * @returns {boolean}
   * @private
   */
  _isGlobalIlluminationActive() {
    try {
      const gls = canvas?.environment?.globalLightSource;
      if (gls?.active) {
        const darknessLevel = canvas.environment.darknessLevel ?? 0;
        const { min = 0, max = 1 } = gls.data?.darkness ?? {};
        if (darknessLevel >= min && darknessLevel <= max) return true;
      }
    } catch (_) {}
    try {
      const globalLight = canvas?.scene?.environment?.globalLight?.enabled
                       ?? canvas?.scene?.globalLight ?? false;
      if (globalLight) {
        const darkness = canvas?.scene?.environment?.darknessLevel
                      ?? canvas?.scene?.darkness ?? 0;
        if (darkness < 0.5) return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * V2 renders fog in Three.js; Foundry's native PIXI fog/visibility draw
   * must stay visually suppressed or it can appear as a camera-locked overlay.
   * Keep this idempotent and cheap since it may run every frame.
   * @private
   */
  _suppressNativeFogVisuals() {
    try {
      const nativeFog = canvas?.fog;
      if (nativeFog) {
        nativeFog.visible = false;
        if (nativeFog.sprite) {
          nativeFog.sprite.visible = false;
          nativeFog.sprite.alpha = 0;
        }
      }

      const vis = canvas?.visibility;
      if (vis) {
        vis.visible = false;
        if (vis.filter) vis.filter.enabled = false;
        if (vis.vision) vis.vision.visible = false;
      }
    } catch (_) {
      // Ignore Foundry-version-specific layer structure differences.
    }
  }

  /**
   * Strict no-reveal guard.
   * While waiting for a fresh vision mask (e.g. floor transition), keep the fog
   * plane visible and force fully opaque fallback textures so no frame can show
   * revealed map content.
   * @private
   */
  /**
   * Levels + exploration: if the active band key does not match what was last
   * written to exploration RTs, clear them synchronously before any composite.
   * Runs at the start of {@link update} (after full-res targets exist) so we
   * never draw one frame with a stale per-floor mask after `activeLevelContext`
   * has already changed — even if `mapShineLevelContextChanged` has not fired yet.
   * @returns {boolean} true if this frame must end after an opaque hold (caller returns)
   * @private
   */
  _syncLevelsExplorationBandBeforeComposite() {
    if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
    if (!isLevelsEnabledForScene(canvas?.scene)) return false;
    if (!(canvas?.scene?.fog?.exploration ?? false)) return false;

    const bk = getActiveElevationBandKey();
    if (bk == null) return false;

    if (this._explorationGpuBandKey === bk) return false;

    // Arm hold before full-res exists so _shouldBypassFog / GI cannot reveal for a frame.
    this._levelBandFogHold = true;

    if (!this._fullResTargetsReady || !this.renderer) return false;

    this.resetExploration({ markLoaded: false });
    this._explorationLoadedFromFoundry = false;
    if (!game?.user?.isGM) this._explorationPlayerGpuReady = true;
    this._pendingAccumulation = false;
    this._explorationGpuBandKey = bk;
    this._levelBandFogHold = true;
    void this._ensureExplorationLoadedFromStore();
    return true;
  }

  _holdOpaqueFogFrame() {
    if (!this.fogPlane || !this.fogMaterial?.uniforms) return;
    this.fogPlane.visible = true;
    if (this.fogMaterial.uniforms.tExplored) {
      this.fogMaterial.uniforms.tExplored.value = this._fallbackBlack;
    }
    if (this.fogMaterial.uniforms.tVision) {
      this.fogMaterial.uniforms.tVision.value = this._fallbackBlack;
    }
    if (this.fogMaterial.uniforms.uBypassFog) {
      this.fogMaterial.uniforms.uBypassFog.value = 0.0;
    }
    this.fogMaterial.uniformsNeedUpdate = true;
  }

  update(timeInfo) {
    if (!this._initialized || !this.fogPlane) return;

    // Keep the vision mask refreshing while any door transition is active.
    // Without this, we only render one frame at transition start and the door
    // sync overlay cannot progress over time.
    if (this._doorFogTransitions.size > 0) {
      this._needsVisionUpdate = true;
    }

    // Hard guard against native PIXI fog visuals resurfacing after Foundry
    // refresh hooks. Any resurfaced native fog appears camera-locked.
    this._suppressNativeFogVisuals();

    // 1. Band sync first (arms _levelBandFogHold when key is stale, even before full-res).
    const syncRequired = this._syncLevelsExplorationBandBeforeComposite();

    // 2. Bypass respects hold — avoids GM "no controlled token" flash during floor swaps.
    const bypassFog = this._shouldBypassFog();
    this.fogMaterial.uniforms.uBypassFog.value = bypassFog ? 1.0 : 0.0;

    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    if (!this.params.enabled || bypassFog) {
      this.fogPlane.visible = false;
      this._visionRetryFrames = 0;
      return;
    }

    // Don't attempt vision rendering until full-res render targets are ready.
    // The 1x1 minimal targets created during init produce garbage results.
    if (!this._fullResTargetsReady) {
      this._holdOpaqueFogFrame();
      return;
    }

    // 3. Opaque hold until exploration for this band is on GPU (or store empty).
    if (syncRequired || this._levelBandFogHold) {
      const levelsBandHoldActive = explorationEnabled
        && getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
        && isLevelsEnabledForScene(canvas?.scene);
      if (!levelsBandHoldActive) {
        this._levelBandFogHold = false;
      } else {
        void this._ensureExplorationLoadedFromStore();
        this._holdOpaqueFogFrame();
        return;
      }
    }

    // Non-GM + exploration memory: fail-closed until persisted exploration is
    // decoded and copied into GPU RTs (no vision frame may precede that).
    if (!game?.user?.isGM && explorationEnabled) {
      void this._ensureExplorationLoadedFromStore();
      if (!this._explorationLoadedFromFoundry || !this._explorationPlayerGpuReady) {
        this._holdOpaqueFogFrame();
        return;
      }
    }
    
    // Detect MapShine selection changes (Three.js-driven UI) and trigger
    // a vision recompute when the set of selected token IDs changes.
    // IMPORTANT: This must run BEFORE _renderVisionMask() so we don't
    // render once, then immediately reset _hasValidVision and render again.
    try {
      const ms = window.MapShine;
      const interactionManager = ms?.interactionManager;
      const selection = interactionManager?.selection;
      let selectionVersion = '';
      if (selection && selection.size > 0) {
        const ids = Array.from(selection);
        ids.sort();
        selectionVersion = ids.join('|');
      }
      if (selectionVersion !== this._lastSelectionVersion) {
        this._lastSelectionVersion = selectionVersion;
        log.debug(`Selection changed ->-> forcing perception update and vision recompute`);
        frameCoordinator.forcePerceptionUpdate();
        this._needsVisionUpdate = true;
        this._hasValidVision = false;
        this._visionRetryFrames = 0;
        this._handleFogStoreContextChange();
      }
    } catch (_) {
      // Ignore MapShine selection errors
    }

    // Render vision mask if needed (single call per frame, after all
    // invalidation checks above have had a chance to set _needsVisionUpdate).
    let visionRenderedThisFrame = false;
    if (this._needsVisionUpdate) {
      this._renderVisionMask();
      visionRenderedThisFrame = true;

      // Recompute the SDF from the freshly rendered vision mask.
      // This converts the hard-edged polygon raster into a smooth distance
      // field, eliminating scallop artifacts from low-density circle arcs.
      if (this._visionSDF && this.visionRenderTarget?.texture) {
        try {
          this._visionSDF.update(this.visionRenderTarget.texture);
          this._sdfUpdateFailed = false;
          if (!this._loggedSDFState) {
            this._loggedSDFState = true;
            log.info(`[SDF] Vision SDF active: size=${this._visionSDF.width}x${this._visionSDF.height}, maxDist=${this._visionSDF.maxDistance}, outputType=HalfFloat`);
          }
        } catch (e) {
          // If SDF fails (e.g. shader compile error), fall back to legacy path
          if (!this._sdfUpdateFailed) {
            log.warn('[SDF] Vision SDF update failed ->-> falling back to legacy softening', e);
            this._sdfUpdateFailed = true;
          }
        }
      }
    }
    
    // Determine if we're stuck waiting for valid vision data.
    // After _maxVisionRetryFrames, give up and show fog anyway - this
    // prevents the fog plane from being permanently hidden when tokens
    // lack sight or Foundry's perception never provides valid LOS.
    const waitingForVision = this._needsVisionUpdate && !this._hasValidVision;
    const visionRetryLimit = game?.user?.isGM
      ? this._maxVisionRetryFrames
      : Math.max(this._maxVisionRetryFrames, Number(this._maxVisionRetryFramesPlayer) || 120);
    if (waitingForVision) {
      this._visionRetryFrames++;
      if (this._visionRetryFrames >= visionRetryLimit) {
        log.warn(`Vision retry limit reached (${visionRetryLimit} frames). Forcing fog visible with current data.`);
        this._needsVisionUpdate = false;
        this._hasValidVision = true;
        this._visionRetryFrames = 0;
      } else {
        // Still waiting ->-> NEVER hide fog plane. Hold an opaque fallback so no
        // reveal frame can occur while perception/vision catches up.
        this._holdOpaqueFogFrame();
        return;
      }
    } else {
      this._visionRetryFrames = 0;
    }

    // Fog plane is visible
    this.fogPlane.visible = true;
    
    // Accumulate exploration if enabled and prior state has been loaded.
    // Don't accumulate before loading ->-> otherwise we'd start from black,
    // mark dirty, and overwrite the existing FogExploration document.
    // PERF: Only accumulate when vision was actually re-rendered this frame,
    // OR when we have a pending catch-up accumulation from a frame where
    // vision rendered but exploration wasn't loaded yet.
    void this._ensureExplorationLoadedFromStore();
    const canAccumulate = explorationEnabled
      && this._explorationLoadedFromFoundry
      && this._computeFogStoreContext().resolved;

    if (visionRenderedThisFrame && !canAccumulate) {
      // Vision rendered but exploration not ready ->-> remember to catch up later
      this._pendingAccumulation = true;
    }

    // CRITICAL: Never accumulate when the vision mask is a full-scene fallback
    // (from global illumination + degenerate LOS). The full-scene white rect
    // covers areas behind walls, and max() accumulation would permanently
    // mark them as explored. Only accumulate from real LOS polygons.
    const shouldAccumulate = canAccumulate
      && (visionRenderedThisFrame || this._pendingAccumulation)
      && !this._visionIsFullSceneFallback;
    if (shouldAccumulate) {
      this._accumulateExploration();
      this._markExplorationDirty();
      this._pendingAccumulation = false;
    }

    // One-shot diagnostic: log exploration accumulation state on first opportunity
    if (!this._loggedExplorationState) {
      this._loggedExplorationState = true;
      log.info(`[FOG DIAG] Exploration state: enabled=${explorationEnabled}, loaded=${this._explorationLoadedFromFoundry}, canAccumulate=${canAccumulate}, shouldAccumulate=${shouldAccumulate}, explorationRTSize=${this._explorationRTWidth}x${this._explorationRTHeight}`);
    }
    
    // Use our self-maintained exploration texture (NOT Foundry's pre-populated one)
    const exploredTex = explorationEnabled
      ? (this._getExplorationReadTarget()?.texture || this._fallbackBlack)
      : this._fallbackBlack;

    // --- Always update all uniforms when the fog plane is visible ---
    this.fogMaterial.uniforms.tExplored.value = exploredTex;

    // Bind the SDF texture for smooth vision edges (falls back to raw vision mask).
    // If the SDF update failed (shader compile error, GPU issue), force legacy path.
    const sdfTex = this._sdfUpdateFailed ? null : this._visionSDF?.getTexture();
    if (sdfTex) {
      this.fogMaterial.uniforms.tVisionSDF.value = sdfTex;
      this.fogMaterial.uniforms.uUseSDF.value = 1.0;
      this.fogMaterial.uniforms.uSDFMaxDistance.value = this._visionSDF.maxDistance;
    } else {
      this.fogMaterial.uniforms.uUseSDF.value = 0.0;
    }

    const vtW = Math.max(1, this._visionRTWidth);
    const vtH = Math.max(1, this._visionRTHeight);
    const etW = Math.max(1, this._explorationRTWidth);
    const etH = Math.max(1, this._explorationRTHeight);
    this.fogMaterial.uniforms.uVisionTexelSize.value.set(1.0 / vtW, 1.0 / vtH);
    this.fogMaterial.uniforms.uExploredTexelSize.value.set(1.0 / etW, 1.0 / etH);
    this.fogMaterial.uniforms.uSoftnessPx.value = this.params.softness;
    this.fogMaterial.uniforms.uTime.value = timeInfo?.elapsed ?? 0.0;
    this.fogMaterial.uniforms.uNoiseStrengthPx.value = this.params.noiseStrength ?? 0.0;
    this.fogMaterial.uniforms.uNoiseSpeed.value = this.params.noiseSpeed ?? 0.0;
    
    this.fogMaterial.uniforms.uUnexploredColor.value.set(this.params.unexploredColor);
    this.fogMaterial.uniforms.uExploredColor.value.set(this.params.exploredColor);
    
    // If exploration is disabled, force explored opacity to 0 so only
    // current vision reveals the map.
    this.fogMaterial.uniforms.uExploredOpacity.value = explorationEnabled
      ? this.params.exploredOpacity
      : 0.0;

  }

  /**
   * Force an immediate fog sync for a movement step.
   *
   * Path-walk can emit authoritative token updates faster than the normal fog
   * render cadence. This helper lets movement sequencing explicitly render LOS
   * and accumulate exploration per step so fog reveal does not collapse to the
   * final endpoint.
   */
  syncMovementStepFog() {
    if (!this._initialized || !this.params?.enabled) return false;
    if (!this._fullResTargetsReady) return false;

    try {
      this._needsVisionUpdate = true;
      this._renderVisionMask();

      const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
      void this._ensureExplorationLoadedFromStore();
      const canAccumulate = explorationEnabled && this._explorationLoadedFromFoundry;
      if (canAccumulate && !this._visionIsFullSceneFallback) {
        this._accumulateExploration();
        this._markExplorationDirty();
      }

      this._pendingAccumulation = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Render is handled by the main scene render (fog plane is in the scene)
   */
  render(renderer, scene, camera) {
    // No-op - the fog plane is rendered as part of the main scene
  }

  /**
   * Handle scene resize
   */
  resize(width, height) {
    if (!this._initialized) return;
    
    // Update dimensions
    this._updateSceneDimensions();
    
    // Recreate vision render target at new size
    if (this.visionRenderTarget) {
      this.visionRenderTarget.dispose();
    }
    this._createVisionRenderTarget();
    
    // Resize the SDF generator to match new vision RT dimensions
    if (this._visionSDF) {
      this._visionSDF.resize(this._visionRTWidth, this._visionRTHeight);
    }

    // Recreate exploration render targets at new size
    if (this._explorationTargetA) {
      this._explorationTargetA.dispose();
    }
    if (this._explorationTargetB) {
      this._explorationTargetB.dispose();
    }
    this._createExplorationRenderTarget();

    try {
      const maxAniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 0;
      if (maxAniso > 0) {
        if (this.visionRenderTarget?.texture) this.visionRenderTarget.texture.anisotropy = maxAniso;
        if (this._explorationTargetA?.texture) this._explorationTargetA.texture.anisotropy = maxAniso;
        if (this._explorationTargetB?.texture) this._explorationTargetB.texture.anisotropy = maxAniso;
      }
    } catch (_) {
    }
    
    // Update fog plane geometry and position
    if (this.fogPlane) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
    }
    this._createFogPlane();
    
    this._needsVisionUpdate = true;
    this._explorationLoadedFromFoundry = false;
    this._explorationLoadAttempts = 0;
    this._explorationGpuBandKey = null;
    this._lastFogStoreContextKey = '';

    try {
      void this._ensureExplorationLoadedFromStore();
    } catch (_) {}
  }

  _markExplorationDirty() {
    if (this._isSceneTransitioning) return;
    this._explorationDirty = true;
    this._explorationCommitCount++;
    // Always schedule a debounced save; save() still rate-limits expensive IO.
    if (this._saveExplorationDebounced) this._saveExplorationDebounced();
  }

  /**
   * Suspend V2 FogExploration persistence during Foundry canvas teardown.
   * @private
   */
  _suspendExplorationSaves(reason = 'unknown') {
    this._isSceneTransitioning = true;
    this._explorationSaveGeneration++;
    this._explorationDirty = false;
    this._explorationCommitCount = 0;
    if (this._saveExplorationDebounced?.cancel) {
      try { this._saveExplorationDebounced.cancel(); } catch (_) {}
    }
    log.debug('[FOG] Exploration saves suspended:', reason);
  }

  /**
   * Best-effort fog persistence flush during canvas teardown.
   * @private
   */
  async _flushExplorationSaveOnTearDown(reason = 'unknown') {
    if (!this._initialized) return;
    if (!this.renderer) return;
    if (!this._explorationDirty) return;
    if (this._isSavingExploration) return;

    try {
      await this._saveExplorationToFoundry({ force: true, reason });
      // If flush succeeded, _saveExplorationToFoundry will clear dirty.
    } catch (e) {
      // Best-effort only; teardown should proceed.
      try { log.warn('[FOG] Failed to flush exploration on tearDown', e); } catch (_) {}
    }
  }

  /**
   * Resume V2 FogExploration persistence after canvas is ready.
   * @private
   */
  _resumeExplorationSaves() {
    this._isSceneTransitioning = false;
  }

  _renderLoadedExplorationTexture(texture) {
    if (!this.renderer || !this._explorationTargetA || !this._explorationTargetB) {
      this._levelBandFogHold = false;
      return;
    }

    const THREE = window.THREE;

    const copyMat = new THREE.MeshBasicMaterial({
      map: texture,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      transparent: false
    });
    const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat);
    const copyScene = new THREE.Scene();
    copyScene.add(copyQuad);

    const currentTarget = this.renderer.getRenderTarget();
    const currentClearColor = this.renderer.getClearColor(new THREE.Color());
    const currentClearAlpha = this.renderer.getClearAlpha();

    this.renderer.setClearColor(0x000000, 1);

    this.renderer.setRenderTarget(this._explorationTargetA);
    this.renderer.clear();
    this.renderer.render(copyScene, this.explorationCamera);

    this.renderer.setRenderTarget(this._explorationTargetB);
    this.renderer.clear();
    this.renderer.render(copyScene, this.explorationCamera);

    this.renderer.setRenderTarget(currentTarget);
    this.renderer.setClearColor(currentClearColor, currentClearAlpha);

    copyQuad.geometry.dispose();
    copyMat.dispose();

    this._currentExplorationTarget = 'A';
    this._levelBandFogHold = false;
    try {
      this._explorationGpuBandKey = getActiveElevationBandKey();
    } catch (_) {
      this._explorationGpuBandKey = null;
    }
  }

  async _saveExplorationToFoundry({ force = false, reason = 'unknown' } = {}) {
    if (!this._initialized) return;
    if (this._isSceneTransitioning && !force) return;

    const saveGeneration = this._explorationSaveGeneration;

    const tokenVisionEnabled = canvas?.scene?.tokenVision ?? false;
    const explorationEnabled = canvas?.scene?.fog?.exploration ?? false;
    if (!tokenVisionEnabled || !explorationEnabled) return;
    if (!this._explorationDirty) return;
    if (this._isSavingExploration) return;
    if (!this.renderer) return;

    const sceneIdAtStart = canvas?.scene?.id;
    if (!sceneIdAtStart) return;

    // PERF: Rate-limit saves to avoid regular long-task stalls.
    // Keep exploration dirty so it will eventually persist.
    const nowMs = Date.now();
    const minInterval = Number(this._minExplorationSaveIntervalMs) || 0;
    if (!force && minInterval > 0 && (nowMs - (Number(this._lastExplorationSaveMs) || 0)) < minInterval) {
      return;
    }

    const explorationTarget = this._getExplorationReadTarget();
    if (!explorationTarget) return;

    this._isSavingExploration = true;

    // Mark save attempt time up-front so back-to-back triggers don't queue
    // multiple expensive readbacks.
    this._lastExplorationSaveMs = nowMs;

    try {
      const targetWidth = Number(
        explorationTarget?.width
        ?? explorationTarget?.texture?.image?.width
        ?? explorationTarget?.texture?.width
        ?? this._explorationRTWidth
      );
      const targetHeight = Number(
        explorationTarget?.height
        ?? explorationTarget?.texture?.image?.height
        ?? explorationTarget?.texture?.height
        ?? this._explorationRTHeight
      );
      const width = Math.max(1, Math.floor(targetWidth));
      const height = Math.max(1, Math.floor(targetHeight));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      const required = Math.max(0, Math.floor(width * height * 4));
      if (!Number.isFinite(required) || required <= 0) return;
      if (!this._explorationSaveBuffer || this._explorationSaveBuffer.length !== required) {
        this._explorationSaveBuffer = new Uint8Array(required);
      }
      const buffer = this._explorationSaveBuffer;

      // PERF: Large single-call readbacks can cause long stalls.
      // Read the render target in smaller tiles and yield between batches.
      const readbackOk = await this._readRenderTargetPixelsTiled(explorationTarget, width, height, buffer);
      if (!readbackOk) return;

      // Scene transition invalidated this save before persistence is invoked.
      if (saveGeneration !== this._explorationSaveGeneration) return;

      // Scene changed while reading back -> skip persistence for stale scene data.
      if (sceneIdAtStart !== canvas?.scene?.id) return;

      const base64 = await this._encodeExplorationBase64(buffer, width, height);
      if (!base64) return;

      // Scene changed while encoding -> avoid writing stale data to the new scene.
      if (sceneIdAtStart !== canvas?.scene?.id) return;

      // Extra guard in case teardown began during encoding.
      if (saveGeneration !== this._explorationSaveGeneration) return;

      const context = this._computeFogStoreContext();
      this._lastFogStoreSaveKey = context.key;
      if (!context.resolved) {
        // Keep dirty; we'll persist once floor/token context is resolved.
        return;
      }
      const maxDim = getFogPersistenceMaxDim();
      const ok = await saveExplorationForActors({
        actorIds: context.actorIds,
        bandKey: context.bandKey,
        exploredDataUrl: base64,
        maxDim
      });
      if (!ok) {
        log.warn('[FOG] saveExplorationForActors returned false (permission or encode failure)');
        return;
      }
      this._explorationDirty = false;
    } catch (e) {
      log.warn('Failed to save fog exploration', e);
    } finally {
      this._isSavingExploration = false;
    }
  }

  async _readRenderTargetPixelsTiled(renderTarget, width, height, outBuffer) {
    if (!this._initialized || !this.renderer) return false;
    if (!renderTarget) return false;
    if (!outBuffer) return false;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

    const rtWidth = Number(
      renderTarget?.width
      ?? renderTarget?.texture?.image?.width
      ?? renderTarget?.texture?.width
      ?? width
    );
    const rtHeight = Number(
      renderTarget?.height
      ?? renderTarget?.texture?.image?.height
      ?? renderTarget?.texture?.height
      ?? height
    );
    const safeWidth = Math.min(width, Math.max(1, Math.floor(rtWidth)));
    const safeHeight = Math.min(height, Math.max(1, Math.floor(rtHeight)));
    if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) return false;

    const tileSize = Math.max(32, Math.min(1024, Math.floor(this._explorationReadbackTileSize || 256)));
    const maxBytes = tileSize * tileSize * 4;
    if (!this._explorationReadbackTileBuffer || this._explorationReadbackTileBuffer.byteLength !== maxBytes) {
      this._explorationReadbackTileBuffer = new Uint8Array(maxBytes);
    }
    const tileBuf = this._explorationReadbackTileBuffer;

    let tilesSinceYield = 0;
    const yieldEvery = 8;

    for (let y0 = 0; y0 < safeHeight; y0 += tileSize) {
      const th = Math.min(tileSize, safeHeight - y0);
      for (let x0 = 0; x0 < safeWidth; x0 += tileSize) {
        const tw = Math.min(tileSize, safeWidth - x0);
        const needed = tw * th * 4;
        const view = tileBuf.subarray(0, needed);

        // This call is synchronous; keeping tw/th small reduces worst-case stall.
        try {
          this.renderer.readRenderTargetPixels(renderTarget, x0, y0, tw, th, view);
        } catch (e) {
          // Scene switches can dispose/replace RTs mid-save; abort this attempt silently.
          log.debug('Skipping fog exploration readback after render target became invalid', e);
          return false;
        }

        // Copy into the final packed buffer.
        // Render target data is bottom-left origin in WebGL space; the encoding path
        // already expects the raw buffer in the same orientation as readRenderTargetPixels.
        for (let row = 0; row < th; row++) {
          const srcOff = row * tw * 4;
          const dstOff = ((y0 + row) * width + x0) * 4;
          outBuffer.set(view.subarray(srcOff, srcOff + tw * 4), dstOff);
        }

        tilesSinceYield++;
        if (tilesSinceYield >= yieldEvery) {
          tilesSinceYield = 0;
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!this._initialized || !this.renderer) return false;
        }
      }
    }

    return true;
  }

  async _encodeExplorationBase64(buffer, width, height) {
    try {
      if (!buffer) return null;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      width = Math.max(1, Math.floor(width));
      height = Math.max(1, Math.floor(height));
      if (width <= 0 || height <= 0) return null;

      const useOffscreen = (typeof OffscreenCanvas !== 'undefined');

      if (!this._explorationEncodeCanvas || !this._explorationEncodeCtx) {
        if (useOffscreen) {
          this._explorationEncodeCanvas = new OffscreenCanvas(width, height);
          this._explorationEncodeCtx = this._explorationEncodeCanvas.getContext('2d');
        } else {
          const canvasEl = document.createElement('canvas');
          canvasEl.width = width;
          canvasEl.height = height;
          this._explorationEncodeCanvas = canvasEl;
          this._explorationEncodeCtx = canvasEl.getContext('2d');
        }
      }

      const canvasEl = this._explorationEncodeCanvas;
      const ctx = this._explorationEncodeCtx;
      if (!canvasEl || !ctx) return null;

      // Ensure correct canvas size.
      if (canvasEl.width !== width) canvasEl.width = width;
      if (canvasEl.height !== height) canvasEl.height = height;

      // Ensure ImageData is correct size.
      if (!this._explorationEncodeImageData || this._explorationEncodeImageData.width !== width || this._explorationEncodeImageData.height !== height) {
        this._explorationEncodeImageData = ctx.createImageData(width, height);
      }

      const imgData = this._explorationEncodeImageData;
      const pixels = imgData.data;

      const CHUNK_SIZE = 262144;
      let yieldCounter = 0;
      for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, buffer.length);
        for (let j = i; j < end; j += 4) {
          const val = buffer[j];
          pixels[j] = val;
          pixels[j + 1] = val;
          pixels[j + 2] = val;
          pixels[j + 3] = 255;
        }
        // Yield occasionally to keep UI responsive, but avoid allocating a Promise for every chunk.
        if (end < buffer.length) {
          yieldCounter++;
          if ((yieldCounter % 8) === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      if (useOffscreen && typeof canvasEl.convertToBlob === 'function') {
        const blob = await canvasEl.convertToBlob({ type: 'image/webp', quality: 0.8 });
        return await this._blobToDataURL(blob);
      }

      return await new Promise((resolve) => {
        canvasEl.toBlob((blob) => {
          if (blob) {
            this._blobToDataURL(blob).then(resolve).catch(() => resolve(null));
          } else {
            try {
              resolve(canvasEl.toDataURL('image/webp', 0.8));
            } catch (_) {
              resolve(null);
            }
          }
        }, 'image/webp', 0.8);
      });
    } catch (_) {
      return null;
    }
  }

  _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  dispose() {
    // Unregister Foundry hooks using correct two-argument signature
    try {
      if (this._hookIds && this._hookIds.length) {
        for (const [hookName, hookId] of this._hookIds) {
          try {
            Hooks.off(hookName, hookId);
          } catch (e) {
          }
        }
      }
    } catch (e) {
    }
    this._hookIds = [];

    // Unregister the resetFog socket listener
    try {
      if (this._fogResetSocketHandler && game?.socket) {
        game.socket.off('resetFog', this._fogResetSocketHandler);
        this._fogResetSocketHandler = null;
      }
    } catch (_) {}
    
    if (this.fogPlane && this.mainScene) {
      this.mainScene.remove(this.fogPlane);
      this.fogPlane.geometry.dispose();
      this.fogMaterial.dispose();
    }

    if (this.visionMaterial) this.visionMaterial.dispose();
    if (this.darknessMaterial) this.darknessMaterial.dispose();

    // Dispose the SDF generator and its GPU resources
    if (this._visionSDF) {
      this._visionSDF.dispose();
      this._visionSDF = null;
    }
    
    if (this.visionRenderTarget) {
      this.visionRenderTarget.dispose();
    }
    
    // Dispose exploration render targets
    if (this._explorationTargetA) {
      this._explorationTargetA.dispose();
    }
    if (this._explorationTargetB) {
      this._explorationTargetB.dispose();
    }
    if (this.explorationMaterial) {
      this.explorationMaterial.dispose();
    }
    
    if (this._fallbackWhite) this._fallbackWhite.dispose();
    if (this._fallbackBlack) this._fallbackBlack.dispose();

    try {
      if (this._saveExplorationDebounced?.cancel) this._saveExplorationDebounced.cancel();
    } catch (_) {
    }
    this._saveExplorationDebounced = null;

    // Release reusable save buffers
    this._explorationSaveBuffer = null;
    this._explorationReadbackTileBuffer = null;
    this._explorationEncodeCanvas = null;
    this._explorationEncodeCtx = null;
    this._explorationEncodeImageData = null;

    // Prevent stale async save callbacks from using disposed resources.
    this.renderer = null;
    this.mainScene = null;

    this._initialized = false;
    log.info('FogOfWarEffectV2 disposed');
  }
}
