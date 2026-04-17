/**
 * @fileoverview Bespoke Zone Manager for Map Shine stair/elevator zones.
 *
 * Zones are stored entirely in scene flags (`flags.map-shine-advanced.zones`)
 * rather than as Foundry Region documents. This gives Map Shine full control
 * over zone rendering, token-enter detection, and elevator dialogs without
 * relying on Foundry's Region/ExecuteScript system.
 *
 * Features:
 * - CRUD for zone polygon data in scene flags
 * - Interactive polygon drawing tool with grid snapping (Shift to disable)
 * - Token-enter detection via `updateToken` hook
 * - Stair elevation toggling and elevator floor-picker dialog
 * - Three.js overlay rendering for zone polygons
 *
 * @module foundry/zone-manager
 */
import { canPersistSceneDocument, isGmLike } from '../core/gm-parity.js';

import { createLogger } from '../core/log.js';
import { moveTrace } from '../core/movement-trace-log.js';
import { scheduleTokenLevelSwitch } from '../scene/level-interaction-service.js';
import { hasV14NativeLevels } from './levels-scene-flags.js';

const log = createLogger('ZoneManager');
const STAIR_TRANSITION_PAUSE_MS = 1000;
const STAIR_FLOOR_FOLLOW_SUPPRESSION_BUFFER_MS = 1800;

// ---------------------------------------------------------------------------
//  Zone type constants
// ---------------------------------------------------------------------------

/** @enum {string} */
export const ZONE_TYPES = Object.freeze({
  STAIR: 'stair',
  STAIR_UP: 'stairUp',
  STAIR_DOWN: 'stairDown',
  ELEVATOR: 'elevator',
  SLIDE: 'slide',
});

const ZONE_TYPE_LABELS = Object.freeze({
  [ZONE_TYPES.STAIR]: 'Stair',
  [ZONE_TYPES.STAIR_UP]: 'Stair Up',
  [ZONE_TYPES.STAIR_DOWN]: 'Stair Down',
  [ZONE_TYPES.ELEVATOR]: 'Elevator',
  [ZONE_TYPES.SLIDE]: 'Slide',
});

const MS_FLAG_SCOPE = 'map-shine-advanced';
const ZONES_FLAG_KEY = 'zones';

// ---------------------------------------------------------------------------
//  Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Point-in-polygon test using ray casting algorithm.
 * @param {number} px - Test point X (Foundry coords)
 * @param {number} py - Test point Y (Foundry coords)
 * @param {Array<{x:number, y:number}>} polygon - Polygon vertices (Foundry coords)
 * @returns {boolean}
 */
function pointInPolygon(px, py, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Generate a simple unique ID for a zone.
 * @returns {string}
 */
function generateZoneId() {
  return `zone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

// ---------------------------------------------------------------------------
//  ZoneManager class
// ---------------------------------------------------------------------------

export class ZoneManager {
  constructor() {
    /** @type {object|null} Reference to the scene composer for Three.js rendering */
    this._sceneComposer = null;

    /** @type {object|null} Reference to the interaction manager */
    this._interactionManager = null;

    /** @type {Set<string>} Tracks which token::zone pairs are currently active (token entered zone) */
    this._tokenZonePresence = new Set();

    /** @type {number|null} Foundry hook ID for updateToken */
    this._updateTokenHookId = null;

    /** @type {number|null} Foundry hook ID for updateScene (zone flag changes) */
    this._updateSceneHookId = null;

    /** @type {THREE.Group|null} Three.js group containing zone overlay meshes */
    this._overlayGroup = null;

    // -- Drawing tool state --

    /** @type {boolean} Whether the drawing tool is currently active */
    this._drawing = false;

    /** @type {Array<{x:number, y:number}>} Vertices collected so far (Foundry coords) */
    this._drawVertices = [];

    /** @type {object|null} Zone configuration for the polygon being drawn */
    this._drawConfig = null;

    /** @type {THREE.Line|null} Preview line mesh for the polygon being drawn */
    this._previewLine = null;

    /** @type {THREE.Mesh|null} Preview vertex dot meshes */
    this._previewDots = [];

    /** @type {HTMLElement|null} Drawing mode banner overlay */
    this._drawBanner = null;

    /** @type {boolean} Tracks whether Shift is held during drawing */
    this._shiftHeld = false;

    /** @type {(e: KeyboardEvent) => void} Bound keydown handler for drawing mode */
    this._onDrawKeydown = this._handleDrawKeydown.bind(this);

    /** @type {(e: MouseEvent) => void} Bound mousemove handler for preview cursor */
    this._onDrawMousemove = this._handleDrawMousemove.bind(this);

    /** @type {{x:number, y:number}|null} Current cursor position in Foundry coords */
    this._cursorFoundry = null;

    /** @type {Function|null} Callback fired when drawing completes or cancels */
    this._drawCallback = null;

    /** @type {Map<string, {center:{x:number,y:number}|null, fillMesh:any|null, lineMesh:any|null, iconMesh:any|null}>} */
    this._zoneVisuals = new Map();

    /** @type {any|null} Cached THREE.Texture for stair icon */
    this._stairIconTexture = null;
    /** @type {boolean} */
    this._stairIconTextureLoading = false;

    /** @type {any|null} Cached THREE.Texture for lift/elevator icon */
    this._liftIconTexture = null;
    /** @type {boolean} */
    this._liftIconTextureLoading = false;

    /** @type {Array<{hook:string,id:number}>} */
    this._hookIds = [];
  }

  _getThreeOverlayScene() {
    try {
      // V2 renders the FloorRenderBus scene, not SceneComposer.scene.
      // Runtime owner is EffectComposer._floorCompositorV2.
      const v2Scene = window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
        ?? window.MapShine?.floorCompositor?._renderBus?._scene
        ?? null;
      if (v2Scene) return v2Scene;
    } catch (_) {
    }
    return this._sceneComposer?.scene ?? null;
  }

  _polygonCentroid(points) {
    const pts = Array.isArray(points) ? points : [];
    if (pts.length < 3) return null;

    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const p0 = pts[j];
      const p1 = pts[i];
      const x0 = Number(p0?.x);
      const y0 = Number(p0?.y);
      const x1 = Number(p1?.x);
      const y1 = Number(p1?.y);
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      const a = x0 * y1 - x1 * y0;
      area += a;
      cx += (x0 + x1) * a;
      cy += (y0 + y1) * a;
    }

    area *= 0.5;
    if (!Number.isFinite(area) || Math.abs(area) < 1e-6) {
      // Fallback: average points
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const p of pts) {
        const x = Number(p?.x);
        const y = Number(p?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sx += x;
        sy += y;
        count += 1;
      }
      if (!count) return null;
      return { x: sx / count, y: sy / count };
    }

    cx /= (6 * area);
    cy /= (6 * area);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return { x: cx, y: cy };
  }

  _ensureIconTexture(path, loadedFlagKey, loadingFlagKey) {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this[loadedFlagKey]) return this[loadedFlagKey];
    if (this[loadingFlagKey]) return null;

    this[loadingFlagKey] = true;
    try {
      const loader = new THREE.TextureLoader();
      loader.load(
        path,
        (tex) => {
          this[loadingFlagKey] = false;
          this[loadedFlagKey] = tex;
          try {
            tex.colorSpace = THREE.SRGBColorSpace;
          } catch (_) {
          }
          this._rebuildOverlays();
          this._updateZoneVisualsVisibility();
        },
        undefined,
        () => {
          this[loadingFlagKey] = false;
        }
      );
    } catch (_) {
      this[loadingFlagKey] = false;
    }
    return null;
  }

  _resolveZoneDirection(zone) {
    const type = String(zone?.type || '').toLowerCase();
    if (type === ZONE_TYPES.STAIR_DOWN.toLowerCase()) return 'down';
    if (type === ZONE_TYPES.STAIR_UP.toLowerCase()) return 'up';
    if (type !== ZONE_TYPES.STAIR.toLowerCase()) return 'up';

    const from = zone?.fromLevel || null;
    const to = zone?.toLevel || null;
    const centerOf = (lvl) => {
      if (!lvl) return NaN;
      const b = Number(lvl.bottom);
      const t = Number(lvl.top);
      if (Number.isFinite(b) && Number.isFinite(t)) return (b + t) * 0.5;
      if (Number.isFinite(b)) return b;
      if (Number.isFinite(t)) return t;
      return NaN;
    };

    const fromC = centerOf(from);
    const toC = centerOf(to);
    if (!Number.isFinite(fromC) || !Number.isFinite(toC)) return 'up';

    const activeCenter = Number(window.MapShine?.activeLevelContext?.center);
    if (Number.isFinite(activeCenter)) {
      const dFrom = Math.abs(activeCenter - fromC);
      const dTo = Math.abs(activeCenter - toC);
      if (dFrom <= dTo) return toC > fromC ? 'up' : 'down';
      return fromC > toC ? 'up' : 'down';
    }

    // Fallback: default direction from fromLevel to toLevel.
    return toC > fromC ? 'up' : 'down';
  }

  _updateZoneVisualsVisibility() {
    try {
      const visuals = this._zoneVisuals;
      if (!visuals || visuals.size === 0) return;

      const controlled = canvas?.tokens?.controlled || [];
      const token = controlled[0] || null;
      const canTest = !!canvas?.visibility?.testVisibility;
      const defaultVisible = (isGmLike());

      const applyVisible = (entry, visible) => {
        if (!entry) return;
        if (entry.fillMesh) entry.fillMesh.visible = visible;
        if (entry.lineMesh) entry.lineMesh.visible = visible;
        if (entry.iconMesh) entry.iconMesh.visible = visible;
      };

      if (!token || !canTest) {
        for (const entry of visuals.values()) applyVisible(entry, defaultVisible);
        this._sceneComposer?.requestRender?.();
        return;
      }

      const tolerance = Math.max(0, (Number(canvas?.dimensions?.size) || 100) * 0.15);
      for (const entry of visuals.values()) {
        const center = entry?.center || null;
        if (!center) {
          applyVisible(entry, defaultVisible);
          continue;
        }
        let visible = false;
        try {
          visible = !!canvas.visibility.testVisibility({ x: center.x, y: center.y }, { tolerance });
        } catch (_) {
          visible = defaultVisible;
        }
        applyVisible(entry, visible);
      }
      this._sceneComposer?.requestRender?.();
    } catch (_) {
    }
  }

  _updateZoneIconsVisibility() {
    // Back-compat shim: call the generalized zone visuals visibility updater.
    this._updateZoneVisualsVisibility();
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the zone manager with references to the scene composer and
   * interaction manager.
   * @param {object} sceneComposer
   * @param {object} interactionManager
   */
  initialize(sceneComposer, interactionManager) {
    this._sceneComposer = sceneComposer;
    this._interactionManager = interactionManager;

    // Keep icon visibility in sync with vision, controlled token changes, and movement.
    // Similar to Foundry door controls: only show interactive cues if there's LOS.
    this._hookIds.push({ hook: 'sightRefresh', id: Hooks.on('sightRefresh', () => this._updateZoneVisualsVisibility()) });
    this._hookIds.push({ hook: 'controlToken', id: Hooks.on('controlToken', () => this._updateZoneVisualsVisibility()) });
    this._hookIds.push({ hook: 'mapShineLevelContextChanged', id: Hooks.on('mapShineLevelContextChanged', () => this._rebuildOverlays()) });

    // Hook: detect token movement into zones
    this._updateTokenHookId = Hooks.on('updateToken', (tokenDoc, changes, options, userId) => {
      if (!('x' in changes || 'y' in changes)) return;
      this._onTokenPositionChanged(tokenDoc, changes, options, userId);
    });

    // Also refresh icon visibility when the controlled token moves.
    this._hookIds.push({
      hook: 'updateToken',
      id: Hooks.on('updateToken', (tokenDoc, changes) => {
        if (!('x' in (changes || {})) && !('y' in (changes || {})) && !('elevation' in (changes || {}))) return;
        const controlled = canvas?.tokens?.controlled || [];
        if (!controlled.some((t) => t?.document?.id === tokenDoc?.id)) return;
        this._updateZoneVisualsVisibility();
      })
    });

    // Hook: re-render overlays when scene zone flags change
    this._updateSceneHookId = Hooks.on('updateScene', (scene, changes) => {
      if (scene?.id !== canvas?.scene?.id) return;
      const zonesChanged = changes?.flags?.[MS_FLAG_SCOPE]?.[ZONES_FLAG_KEY] !== undefined;
      if (zonesChanged) {
        this._rebuildOverlays();
      }
    });

    this._rebuildOverlays();
    this._updateZoneVisualsVisibility();
    log.info('ZoneManager initialized');
  }

  dispose() {
    this.cancelDrawing();

    for (const entry of this._hookIds) {
      try {
        if (entry?.hook && entry?.id != null) Hooks.off(entry.hook, entry.id);
      } catch (_) {
      }
    }
    this._hookIds = [];

    if (this._updateTokenHookId !== null) {
      Hooks.off('updateToken', this._updateTokenHookId);
      this._updateTokenHookId = null;
    }
    if (this._updateSceneHookId !== null) {
      Hooks.off('updateScene', this._updateSceneHookId);
      this._updateSceneHookId = null;
    }

    this._removeOverlays();
    this._zoneVisuals.clear();
    this._tokenZonePresence.clear();
    this._sceneComposer = null;
    this._interactionManager = null;

    log.info('ZoneManager disposed');
  }

  // -------------------------------------------------------------------------
  //  Zone data CRUD (scene flags)
  // -------------------------------------------------------------------------

  /**
   * Read all zones from the current scene.
   * @returns {Array<object>}
   */
  getZones() {
    const scene = canvas?.scene;
    if (!scene) return [];
    const raw = scene.flags?.[MS_FLAG_SCOPE]?.[ZONES_FLAG_KEY];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Get a single zone by ID.
   * @param {string} zoneId
   * @returns {object|null}
   */
  getZone(zoneId) {
    return this.getZones().find(z => z.id === zoneId) || null;
  }

  /**
   * Add a new zone to the current scene.
   * @param {object} zoneData - Zone object (must include `points` array)
   * @returns {Promise<object>} The created zone
   */
  async addZone(zoneData) {
    const scene = canvas?.scene;
    if (!scene || !isGmLike()) throw new Error('Cannot add zone: no scene or not GM');

    const zone = {
      id: zoneData.id || generateZoneId(),
      type: zoneData.type || ZONE_TYPES.STAIR,
      name: zoneData.name || 'Zone',
      points: zoneData.points || [],
      fromLevel: zoneData.fromLevel || null,
      toLevel: zoneData.toLevel || null,
      oneWay: zoneData.oneWay === true,
      locked: zoneData.locked === true,
      color: zoneData.color || '#fe6c0b',
      createdAt: Date.now(),
    };

    const zones = [...this.getZones(), zone];
    await scene.setFlag(MS_FLAG_SCOPE, ZONES_FLAG_KEY, zones);
    log.info(`Added zone "${zone.name}" (${zone.type})`, zone.id);
    return zone;
  }

  /**
   * Update an existing zone.
   * @param {string} zoneId
   * @param {object} changes - Partial zone data to merge
   * @returns {Promise<void>}
   */
  async updateZone(zoneId, changes) {
    const scene = canvas?.scene;
    if (!scene || !canPersistSceneDocument()) return;

    const zones = this.getZones().map(z => {
      if (z.id !== zoneId) return z;
      return { ...z, ...changes };
    });
    await scene.setFlag(MS_FLAG_SCOPE, ZONES_FLAG_KEY, zones);
  }

  /**
   * Delete a zone by ID.
   * @param {string} zoneId
   * @returns {Promise<void>}
   */
  async deleteZone(zoneId) {
    const scene = canvas?.scene;
    if (!scene || !canPersistSceneDocument()) return;

    const zones = this.getZones().filter(z => z.id !== zoneId);
    await scene.setFlag(MS_FLAG_SCOPE, ZONES_FLAG_KEY, zones);
    log.info(`Deleted zone ${zoneId}`);
  }

  // -------------------------------------------------------------------------
  //  Interactive polygon drawing tool
  // -------------------------------------------------------------------------

  /** @returns {boolean} Whether drawing mode is currently active */
  get isDrawing() { return this._drawing; }

  /**
   * Enter polygon drawing mode. The user clicks on the map to place vertices.
   * Grid snapping is active by default; hold Shift to disable.
   * Double-click to complete the polygon. Escape to cancel.
   *
   * @param {object} config - Zone configuration (type, name, fromLevel, toLevel, etc.)
   * @param {(zone: object|null) => void} [callback] - Called when drawing completes (zone) or cancels (null)
   */
  startDrawing(config, callback) {
    // Cancel any existing drawing first
    if (this._drawing) this.cancelDrawing();

    this._drawing = true;
    this._drawVertices = [];
    this._drawConfig = config;
    this._drawCallback = callback || null;
    this._cursorFoundry = null;

    // Register the first pending world pick (chained — each pick registers the next)
    this._registerNextPick();

    // Listen for keyboard (Escape/Enter) and mousemove (preview cursor)
    document.addEventListener('keydown', this._onDrawKeydown, true);
    document.addEventListener('mousemove', this._onDrawMousemove, true);
    document.addEventListener('dblclick', this._onDrawDblClick ??= this._handleDrawDblClick.bind(this), true);

    // Show drawing mode banner
    this._showDrawBanner();

    log.info('Drawing mode started', config);
  }

  /**
   * Register the next pending world pick. Each pick consumes the click event
   * so normal interaction (token selection, etc.) is suppressed during drawing.
   */
  _registerNextPick() {
    const im = this._interactionManager;
    if (!im || !this._drawing) return;

    im.setPendingWorldPick((worldPos) => {
      if (!this._drawing) return;
      this._handleDrawClick(worldPos);
      // Chain: register the next pick for the following click
      this._registerNextPick();
    });
  }

  /**
   * Cancel the current drawing session without saving.
   */
  cancelDrawing() {
    if (!this._drawing) return;

    this._drawing = false;
    this._drawVertices = [];
    this._drawConfig = null;
    this._cursorFoundry = null;

    // Clear any pending world pick so normal interaction resumes
    const im = this._interactionManager;
    if (im) {
      im.clearPendingWorldPick();
    }

    document.removeEventListener('keydown', this._onDrawKeydown, true);
    document.removeEventListener('mousemove', this._onDrawMousemove, true);
    if (this._onDrawDblClick) {
      document.removeEventListener('dblclick', this._onDrawDblClick, true);
    }

    this._removePreview();
    this._hideDrawBanner();

    const cb = this._drawCallback;
    this._drawCallback = null;
    if (cb) cb(null);
  }

  /**
   * Complete the current drawing and save the zone.
   * @returns {Promise<object|null>} The created zone, or null if invalid
   */
  async completeDrawing() {
    if (!this._drawing || this._drawVertices.length < 3) {
      if (this._drawVertices.length < 3) {
        ui?.notifications?.warn?.('At least 3 vertices are required to define a zone polygon.');
      }
      return null;
    }

    const config = this._drawConfig;
    const points = [...this._drawVertices];

    // Exit drawing mode
    this._drawing = false;
    const im = this._interactionManager;
    if (im) {
      im.clearPendingWorldPick();
    }
    document.removeEventListener('keydown', this._onDrawKeydown, true);
    document.removeEventListener('mousemove', this._onDrawMousemove, true);
    if (this._onDrawDblClick) {
      document.removeEventListener('dblclick', this._onDrawDblClick, true);
    }

    this._removePreview();
    this._hideDrawBanner();

    // Save the zone
    try {
      const zone = await this.addZone({
        ...config,
        points,
      });

      ui?.notifications?.info?.(`Created ${ZONE_TYPE_LABELS[config?.type] || 'zone'} "${zone.name}".`);

      const cb = this._drawCallback;
      this._drawCallback = null;
      if (cb) cb(zone);
      return zone;
    } catch (err) {
      log.warn('Failed to save zone', err);
      ui?.notifications?.error?.(`Failed to create zone: ${err?.message || 'unknown error'}`);
      const cb = this._drawCallback;
      this._drawCallback = null;
      if (cb) cb(null);
      return null;
    }
  }

  // -- Drawing event handlers --

  /**
   * Handle a world pick while drawing. Adds a vertex.
   * Called via chained setPendingWorldPick — the click event is consumed.
   * @param {object} worldPos - {x:number, y:number} in Three.js world coords
   */
  _handleDrawClick(worldPos) {
    if (!this._drawing) return;

    // Convert Three.js world coords to Foundry coords
    const h = canvas?.dimensions?.height || 1000;
    let fx = worldPos.x;
    let fy = h - worldPos.y;

    // Grid snap unless Shift is held
    if (!this._shiftHeld) {
      const snapped = this._snapToGrid(fx, fy);
      fx = snapped.x;
      fy = snapped.y;
    }

    // Reject duplicate vertex (guards against double-click adding two points)
    const last = this._drawVertices[this._drawVertices.length - 1];
    if (last && Math.abs(last.x - fx) < 1 && Math.abs(last.y - fy) < 1) return;

    this._drawVertices.push({ x: fx, y: fy });
    this._updatePreview();
    this._updateDrawBanner();
  }

  /**
   * Handle double-click to complete the polygon.
   * @param {MouseEvent} e
   */
  _handleDrawDblClick(e) {
    if (!this._drawing) return;
    if (this._drawVertices.length >= 3) {
      e.preventDefault();
      e.stopPropagation();
      this.completeDrawing();
    }
  }

  /**
   * Handle keyboard events during drawing mode.
   * @param {KeyboardEvent} e
   */
  _handleDrawKeydown(e) {
    if (!this._drawing) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelDrawing();
      ui?.notifications?.info?.('Drawing cancelled.');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this._drawVertices.length >= 3) {
        this.completeDrawing();
      } else {
        ui?.notifications?.warn?.('At least 3 vertices needed. Keep clicking to add more.');
      }
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      // Undo last vertex
      e.preventDefault();
      e.stopPropagation();
      if (this._drawVertices.length > 0) {
        this._drawVertices.pop();
        this._updatePreview();
        this._updateDrawBanner();
      }
    }
  }

  /**
   * Handle mousemove during drawing mode to update the preview cursor line.
   * @param {MouseEvent} e
   */
  _handleDrawMousemove(e) {
    if (!this._drawing) return;

    this._shiftHeld = e.shiftKey;

    const im = this._interactionManager;
    if (!im) return;

    const world = im.screenToWorld(e.clientX, e.clientY);
    if (!world) return;

    const h = canvas?.dimensions?.height || 1000;
    let fx = world.x;
    let fy = h - world.y;

    if (!e.shiftKey) {
      const snapped = this._snapToGrid(fx, fy);
      fx = snapped.x;
      fy = snapped.y;
    }

    this._cursorFoundry = { x: fx, y: fy };
    this._updatePreview();
  }

  // -- Grid snapping --

  /**
   * Snap a Foundry coordinate to the nearest grid intersection.
   * @param {number} fx - Foundry X
   * @param {number} fy - Foundry Y
   * @returns {{x: number, y: number}}
   */
  _snapToGrid(fx, fy) {
    // Try Foundry's native grid snapping first
    try {
      const im = this._interactionManager;
      if (im?.snapToGrid) {
        return im.snapToGrid(fx, fy, CONST?.GRID_SNAPPING_MODES?.VERTEX ?? 0, 1);
      }
    } catch (_) {}

    // Fallback: manual grid intersection snap
    const gridSize = Number(canvas?.scene?.grid?.size ?? canvas?.grid?.size ?? 100);
    return {
      x: Math.round(fx / gridSize) * gridSize,
      y: Math.round(fy / gridSize) * gridSize,
    };
  }

  // -- Drawing preview (Three.js) --

  _updatePreview() {
    const THREE = window.THREE;
    const scene = this._getThreeOverlayScene();
    if (!THREE || !scene) return;

    const h = canvas?.dimensions?.height || 1000;
    const groundZ = this._sceneComposer.groundZ ?? 1000;
    const previewZ = groundZ + 5; // Slightly above ground

    // Build vertex array: existing vertices + cursor position
    const verts = [...this._drawVertices];
    if (this._cursorFoundry && this._drawing) {
      verts.push(this._cursorFoundry);
    }

    if (verts.length < 1) {
      this._removePreview();
      return;
    }

    // -- Line preview --
    const positions = [];
    for (const v of verts) {
      // Convert Foundry → Three.js world
      positions.push(v.x, h - v.y, previewZ);
    }
    // Close the loop back to the first vertex
    if (verts.length >= 2) {
      positions.push(verts[0].x, h - verts[0].y, previewZ);
    }

    if (!this._previewLine) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: 0xfe6c0b,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      this._previewLine = new THREE.Line(geometry, material);
      this._previewLine.renderOrder = 99999;
      this._previewLine.frustumCulled = false;
      this._previewLine.userData = { ...(this._previewLine.userData || {}), type: 'interactionOverlay' };
      scene.add(this._previewLine);
    } else {
      const geo = this._previewLine.geometry;
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.attributes.position.needsUpdate = true;
    }

    // -- Vertex dots --
    // Remove old dots
    for (const dot of this._previewDots) {
      scene.remove(dot);
      dot.geometry?.dispose?.();
      dot.material?.dispose?.();
    }
    this._previewDots = [];

    const dotGeo = new THREE.CircleGeometry(4, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });

    for (let i = 0; i < this._drawVertices.length; i++) {
      const v = this._drawVertices[i];
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(v.x, h - v.y, previewZ + 0.1);
      dot.renderOrder = 100000;
      dot.frustumCulled = false;
      dot.userData = { ...(dot.userData || {}), type: 'interactionOverlay' };
      scene.add(dot);
      this._previewDots.push(dot);
    }

    // Request a render frame to show the preview
    this._sceneComposer?.requestRender?.();
  }

  _removePreview() {
    const scene = this._getThreeOverlayScene();
    if (this._previewLine) {
      scene?.remove?.(this._previewLine);
      this._previewLine.geometry?.dispose?.();
      this._previewLine.material?.dispose?.();
      this._previewLine = null;
    }
    for (const dot of this._previewDots) {
      scene?.remove?.(dot);
      dot.geometry?.dispose?.();
      dot.material?.dispose?.();
    }
    this._previewDots = [];
    this._sceneComposer?.requestRender?.();
  }

  // -- Drawing banner UI --

  _showDrawBanner() {
    this._hideDrawBanner();
    const banner = document.createElement('div');
    banner.id = 'map-shine-zone-draw-banner';
    banner.className = 'map-shine-zone-draw-banner';
    banner.innerHTML = `
      <div class="ms-draw-banner__content">
        <span class="ms-draw-banner__icon">✏️</span>
        <span class="ms-draw-banner__text">Drawing zone — click to place vertices (Shift = free placement)</span>
        <span class="ms-draw-banner__count">0 vertices</span>
        <span class="ms-draw-banner__hint">Double-click or Enter to finish · Escape to cancel · Ctrl+Z to undo</span>
      </div>`;
    document.body.appendChild(banner);
    this._drawBanner = banner;
  }

  _updateDrawBanner() {
    if (!this._drawBanner) return;
    const countEl = this._drawBanner.querySelector('.ms-draw-banner__count');
    if (countEl) {
      const n = this._drawVertices.length;
      countEl.textContent = `${n} ${n === 1 ? 'vertex' : 'vertices'}`;
    }
  }

  _hideDrawBanner() {
    if (this._drawBanner) {
      this._drawBanner.remove();
      this._drawBanner = null;
    }
  }

  // -------------------------------------------------------------------------
  //  Token-enter detection (runtime)
  // -------------------------------------------------------------------------

  _sceneHasLevelsRegionScriptStairs(scene) {
    const regions = Array.isArray(scene?.regions?.contents)
      ? scene.regions.contents
      : (Array.isArray(scene?.regions) ? scene.regions : []);
    if (!regions.length) return false;

    for (const region of regions) {
      const behaviors = Array.isArray(region?.behaviors?.contents)
        ? region.behaviors.contents
        : (Array.isArray(region?.behaviors) ? region.behaviors : []);
      for (const behavior of behaviors) {
        const source = String(
          behavior?.source
          ?? behavior?.script
          ?? behavior?.data?.source
          ?? behavior?.data?.script
          ?? ''
        );
        if (!source) continue;
        if (!source.includes('RegionHandler.')) continue;
        if (
          /\bRegionHandler\.(stair|stairUp|stairDown|elevator)\s*\(/i.test(source)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  _sceneHasLegacyDrawingStairs(scene) {
    const drawings = Array.isArray(scene?.drawings?.contents)
      ? scene.drawings.contents
      : (Array.isArray(scene?.drawings) ? scene.drawings : []);
    if (!drawings.length) return false;

    for (const drawing of drawings) {
      const mode = Number(drawing?.flags?.levels?.drawingMode ?? 0);
      if (mode === 2 || mode === 3 || mode === 21 || mode === 22) return true;
    }
    return false;
  }

  _shouldSuspendZoneStairRuntime() {
    const scene = canvas?.scene;
    if (!scene) return false;
    if (!hasV14NativeLevels(scene)) return false;

    // Single-source-of-truth policy:
    // If imported Levels stair engines exist in the scene, suspend bespoke zone
    // stair runtime to prevent duplicate triggers.
    return this._sceneHasLevelsRegionScriptStairs(scene) || this._sceneHasLegacyDrawingStairs(scene);
  }

  /**
   * Compute the elevation span covered by a zone's connected levels.
   * Tokens outside this range are ignored (e.g. a floor-3 token shouldn't
   * trigger a ground↔first stair).
   * @param {object} zone
   * @returns {{min: number, max: number}|null}
   */
  _zoneElevationRange(zone) {
    const from = zone.fromLevel;
    const to = zone.toLevel;
    if (!from && !to) return null;

    const min = Math.min(from?.bottom ?? Infinity, to?.bottom ?? Infinity);
    const max = Math.max(from?.top ?? -Infinity, to?.top ?? -Infinity);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max };
  }

  /**
   * Called when a token's position changes. Checks if the token has entered
   * or exited any zone polygon and triggers the appropriate behavior.
   *
   * Key design decisions:
   * - Uses the NEW position from `changes` (post-update) so the point-in-polygon
   *   test reflects where the token actually is now.
   * - Reads `tokenDoc.id` from the original Foundry Document (not a spread copy)
   *   because getter-based properties like `id` aren't copied by object spread.
   * - Filters by elevation range so tokens on unrelated floors are ignored.
   * - Tracks presence via `Set<"tokenId::zoneId">` to distinguish entry vs. re-move.
   */
  _onTokenPositionChanged(tokenDoc, changes, _options, _userId) {
    if (this._shouldSuspendZoneStairRuntime()) return;

    const zones = this.getZones();
    if (!zones.length) return;

    // Read the token's canonical ID from the live Foundry Document (getter-based)
    const tokenId = tokenDoc?.id ?? tokenDoc?._id;
    if (!tokenId) {
      log.debug('Zone check skipped: no token id');
      return;
    }

    // Build effective position from changes (the hook fires post-update, but
    // reading from `changes` is safest to avoid any stale-document edge cases)
    const newX = 'x' in changes ? changes.x : tokenDoc.x;
    const newY = 'y' in changes ? changes.y : tokenDoc.y;
    const currentElev = Number(
      'elevation' in changes ? changes.elevation : (tokenDoc.elevation ?? 0)
    );
    const width = Number(tokenDoc.width ?? 1);
    const height = Number(tokenDoc.height ?? 1);

    // Compute token center in Foundry coords (top-left origin, Y-down)
    const gridSize = Number(canvas?.scene?.grid?.size ?? canvas?.grid?.size ?? 100);
    const cx = Number(newX) + (width * gridSize) / 2;
    const cy = Number(newY) + (height * gridSize) / 2;

    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      log.debug(`Zone check skipped: non-finite center (${cx}, ${cy}) for token ${tokenId}`);
      return;
    }

    for (const zone of zones) {
      if (!zone.points || zone.points.length < 3) continue;

      const presenceKey = `${tokenId}::${zone.id}`;

      // 2D point-in-polygon test (Foundry coord space)
      const isInside = pointInPolygon(cx, cy, zone.points);
      const wasInside = this._tokenZonePresence.has(presenceKey);

      if (isInside && !wasInside) {
        // -- Elevation range filter --
        // Only trigger the zone if the token's elevation falls within the
        // range spanned by the zone's connected levels. This prevents tokens
        // on unrelated floors from triggering stairs/elevators.
        const range = this._zoneElevationRange(zone);
        if (range && (currentElev < range.min || currentElev > range.max)) {
          log.debug(
            `Token ${tokenId} entered zone "${zone.name}" polygon but elevation ` +
            `${currentElev} is outside zone range [${range.min}..${range.max}] — skipped`
          );
          // Still mark presence so we don't spam this log on every move
          this._tokenZonePresence.add(presenceKey);
          continue;
        }

        // Token entered this zone and is within the valid elevation range
        this._tokenZonePresence.add(presenceKey);
        log.info(
          `Token ${tokenId} entered zone "${zone.name}" (${zone.type}) ` +
          `at elevation ${currentElev}, center=(${cx.toFixed(0)}, ${cy.toFixed(0)})`
        );

        this._onTokenEnterZone(tokenId, zone, currentElev).catch((err) => {
          log.warn(`Zone trigger error for "${zone.name}":`, err);
        });
      } else if (!isInside && wasInside) {
        // Token left this zone — clear presence so it can re-trigger on next entry
        this._tokenZonePresence.delete(presenceKey);
      }
    }
  }

  /**
   * Handle a token entering a zone. Triggers the zone's behavior
   * (elevation change for stairs, dialog for elevators).
   *
   * @param {string} tokenId - The token document ID (from the live Foundry Document)
   * @param {object} zone - The zone data object
   * @param {number} currentElev - The token's current elevation
   */
  async _onTokenEnterZone(tokenId, zone, currentElev) {
    if (zone.locked) {
      ui?.notifications?.warn?.('This passage is locked.');
      return;
    }

    switch (zone.type) {
      case ZONE_TYPES.STAIR:
      case ZONE_TYPES.STAIR_UP:
      case ZONE_TYPES.STAIR_DOWN:
      case ZONE_TYPES.SLIDE:
        await this._handleStairZone(tokenId, zone, currentElev);
        break;
      case ZONE_TYPES.ELEVATOR:
        await this._handleElevatorZone(tokenId, zone, currentElev);
        break;
      default:
        log.warn(`Unknown zone type: ${zone.type}`);
    }
  }

  /**
   * Resolve a live TokenDocument from the current scene by ID.
   * @param {string} tokenId
   * @returns {object|null}
   */
  _resolveTokenDoc(tokenId) {
    return canvas?.scene?.tokens?.get?.(tokenId) ?? null;
  }

  /**
   * Follow a controlled token's floor transition by switching the viewed floor
   * to the band that owns the token's target elevation.
   *
   * @param {object|null} tokenDoc
   * @param {number} targetElev
   * @param {string} reason
   */
  async _followControlledTokenFloorTransition(tokenDoc, targetElev, reason) {
    if (!tokenDoc || !Number.isFinite(Number(targetElev))) return;
    const controlled = Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [];
    const tokenId = String(tokenDoc?.id || tokenDoc?._id || '');
    if (!tokenId) return;

    const isControlled = controlled.some((t) => String(t?.document?.id || t?.id || '') === tokenId);
    if (!isControlled) return;

    try {
      window.MapShine?.tokenManager?.movementManager?.resyncSpriteToDocument?.(
        tokenId,
        tokenDoc,
        { reason: `${reason}:pre-switch` }
      );
      await _sleep(20);
      window.MapShine?.tokenManager?.movementManager?.resyncSpriteToDocument?.(
        tokenId,
        tokenDoc,
        { reason: `${reason}:pre-switch-retry` }
      );
    } catch (_) {
    }

    await scheduleTokenLevelSwitch(tokenDoc, Number(targetElev) + 0.001, {
      reason,
      dwellMs: 0,
      dedupeMs: 1200,
      requireControlled: true
    });
  }

  _beginStairFloorFollowSuppression(tokenDoc, reason = 'zone-transition') {
    const tokenId = String(tokenDoc?.id || tokenDoc?._id || '');
    if (!tokenId) return false;
    try {
      window.MapShine?.cameraFollower?.beginFloorFollowSuppression?.(tokenId, {
        durationMs: STAIR_TRANSITION_PAUSE_MS + STAIR_FLOOR_FOLLOW_SUPPRESSION_BUFFER_MS,
        reason,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  _endStairFloorFollowSuppression(tokenDoc) {
    const tokenId = String(tokenDoc?.id || tokenDoc?._id || '');
    if (!tokenId) return;
    try {
      window.MapShine?.cameraFollower?.endFloorFollowSuppression?.(tokenId);
    } catch (_) {
    }
  }

  async _applyStairChoreographedElevationTransition(tokenDoc, targetElev, floorFollowReason = 'zone-floor-follow') {
    if (!tokenDoc || !Number.isFinite(Number(targetElev))) return false;
    const tokenId = String(tokenDoc?.id || tokenDoc?._id || '');
    moveTrace('zoneStair.transition.start', {
      tokenId,
      targetElev,
      floorFollowReason,
      docBefore: { x: tokenDoc?.x, y: tokenDoc?.y, elevation: tokenDoc?.elevation }
    });
    await _sleep(STAIR_TRANSITION_PAUSE_MS);
    const hasSuppression = this._beginStairFloorFollowSuppression(tokenDoc, floorFollowReason);
    try {
      await tokenDoc.update({ elevation: targetElev });
      try {
        window.MapShine?.tokenManager?.movementManager?.resyncSpriteToDocument?.(
          tokenId,
          tokenDoc,
          { reason: `zone-stair:${floorFollowReason}` }
        );
      } catch (_) {
      }
      moveTrace('zoneStair.transition.done', {
        tokenId,
        targetElev,
        docAfter: {
          x: tokenDoc?.x,
          y: tokenDoc?.y,
          elevation: tokenDoc?.elevation
        }
      });
      await this._followControlledTokenFloorTransition(tokenDoc, targetElev, floorFollowReason);
      return true;
    } finally {
      if (hasSuppression) this._endStairFloorFollowSuppression(tokenDoc);
    }
  }

  /**
   * Handle stair zone behavior: toggle token elevation between two levels.
   * Uses inclusive range checks `[bottom, top]` so tokens exactly at a
   * boundary aren't excluded.
   */
  async _handleStairZone(tokenId, zone, currentElev) {
    const from = zone.fromLevel;
    const to = zone.toLevel;
    if (!from || !to) {
      log.debug(`Stair zone "${zone.name}" missing fromLevel/toLevel — skipped`);
      return;
    }

    // Inclusive range: bottom <= elevation <= top
    const onFromLevel = currentElev >= from.bottom && currentElev <= from.top;
    const onToLevel = currentElev >= to.bottom && currentElev <= to.top;

    let targetElev = null;

    if (zone.type === ZONE_TYPES.STAIR_DOWN || zone.type === ZONE_TYPES.STAIR_UP) {
      // For directional stair types, determine lower/upper by actual elevation so the
      // logic is independent of which connected level is labelled "from" vs "to".
      // This prevents the stair from breaking when the zone author assigns fromLevel/toLevel
      // in reverse order relative to the stair's physical direction.
      const lowerLevel = from.bottom <= to.bottom ? from : to;
      const upperLevel = from.bottom <= to.bottom ? to : from;
      const onLower = currentElev >= lowerLevel.bottom && currentElev <= lowerLevel.top;
      const onUpper = currentElev >= upperLevel.bottom && currentElev <= upperLevel.top;

      if (zone.type === ZONE_TYPES.STAIR_DOWN) {
        if (onLower && !onUpper) {
          // Token is strictly on the lower level — nowhere further to descend.
          log.debug(
            `Stair-down zone "${zone.name}": token already on lower level (${currentElev}), blocked`
          );
          return;
        }
        // Token is on the upper level, or at the shared boundary — descend to lower level.
        targetElev = lowerLevel.bottom;
      } else {
        // STAIR_UP
        if (onUpper && !onLower) {
          // Token is strictly on the upper level — can't ascend further.
          log.debug(
            `Stair-up zone "${zone.name}": token already on upper level (${currentElev}), blocked`
          );
          return;
        }
        // Token is on the lower level, or at the shared boundary — ascend to upper level.
        targetElev = upperLevel.bottom;
      }
    } else if (onFromLevel && onToLevel) {
      // Shared boundary with a bidirectional stair (e.g. Ground=[0,10], First=[10,20],
      // elevation=10). The token was most likely sent here by a previous stair trigger.
      // Reverse direction back to from.bottom, unless the zone is one-way.
      if (zone.oneWay) {
        log.debug(
          `Stair zone "${zone.name}": token at shared boundary ${currentElev}, one-way blocked`
        );
        return;
      }
      targetElev = from.bottom;
    } else if (onFromLevel) {
      // Token is on the "from" level — move to "to" level.
      targetElev = to.bottom;
    } else if (onToLevel) {
      if (zone.oneWay) return;
      // Bidirectional: go back to "from" level.
      targetElev = from.bottom;
    } else {
      // Token elevation is outside both level ranges — go to whichever level is closer.
      const distFrom = Math.abs(currentElev - (from.bottom + from.top) / 2);
      const distTo = Math.abs(currentElev - (to.bottom + to.top) / 2);
      targetElev = distFrom <= distTo ? to.bottom : from.bottom;
    }

    if (targetElev === null || !Number.isFinite(targetElev) || targetElev === currentElev) {
      log.debug(
        `Stair zone "${zone.name}": no elevation change needed ` +
        `(current=${currentElev}, target=${targetElev})`
      );
      return;
    }

    const doc = this._resolveTokenDoc(tokenId);
    if (!doc) {
      log.warn(`Stair zone "${zone.name}": token ${tokenId} not found in scene`);
      return;
    }

    log.info(
      `Stair zone "${zone.name}": moving token ${tokenId} from elevation ` +
      `${currentElev} → ${targetElev}`
    );
    await this._applyStairChoreographedElevationTransition(doc, targetElev, 'zone-stair-floor-follow');
  }

  /**
   * Handle elevator zone behavior: show a floor picker dialog.
   */
  async _handleElevatorZone(tokenId, zone, currentElev) {
    const from = zone.fromLevel;
    const to = zone.toLevel;

    // Collect the connected floors
    const floors = [];
    if (from) floors.push({ label: from.label || 'Lower', bottom: from.bottom, top: from.top });
    if (to && to.bottom !== from?.bottom) {
      floors.push({ label: to.label || 'Upper', bottom: to.bottom, top: to.top });
    }

    if (floors.length < 2) {
      log.debug(`Elevator zone "${zone.name}": fewer than 2 floors — skipped`);
      return;
    }

    // Determine current floor (inclusive range)
    let currentFloorIdx = -1;
    for (let i = 0; i < floors.length; i++) {
      if (currentElev >= floors[i].bottom && currentElev <= floors[i].top) {
        currentFloorIdx = i;
        break;
      }
    }

    // Build dialog content
    const buttonRows = floors.map((f, i) => {
      const isCurrent = i === currentFloorIdx;
      const label = `${f.label}${isCurrent ? ' (current)' : ''} — ${f.bottom}..${f.top}`;
      return `<button type="button" class="ms-elevator-btn" data-floor-idx="${i}"
        ${isCurrent ? 'disabled style="opacity:0.5"' : ''}>${label}</button>`;
    }).join('');

    const content = `<div class="ms-elevator-floor-list">${buttonRows}</div>`;

    // Show dialog
    const result = await new Promise((resolve) => {
      const d = new Dialog({
        title: zone.name || 'Elevator',
        content,
        buttons: {
          cancel: { icon: '<i class="fas fa-times"></i>', label: 'Cancel', callback: () => resolve(null) },
        },
        default: 'cancel',
        close: () => resolve(null),
        render: (html) => {
          const el = html instanceof jQuery ? html[0] : html;
          el.querySelectorAll('.ms-elevator-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              resolve(Number(btn.dataset.floorIdx));
              d.close();
            });
          });
        },
      }, {
        width: 280,
        classes: ['map-shine-elevator-dialog'],
      });
      d.render(true);
    });

    if (result === null || !Number.isFinite(result)) return;
    const target = floors[result];
    if (!target) return;

    const targetElev = target.bottom;
    if (!Number.isFinite(targetElev) || targetElev === currentElev) return;

    const doc = this._resolveTokenDoc(tokenId);
    if (!doc) {
      log.warn(`Elevator zone "${zone.name}": token ${tokenId} not found in scene`);
      return;
    }

    log.info(
      `Elevator zone "${zone.name}": moving token ${tokenId} from elevation ` +
      `${currentElev} → ${targetElev}`
    );
    await this._applyStairChoreographedElevationTransition(doc, targetElev, 'zone-elevator-floor-follow');
  }

  // -------------------------------------------------------------------------
  //  Three.js zone overlay rendering
  // -------------------------------------------------------------------------

  /**
   * Rebuild the Three.js zone polygon overlays from scene flag data.
   */
  _rebuildOverlays() {
    this._removeOverlays();

    const THREE = window.THREE;
    const scene3 = this._getThreeOverlayScene();
    if (!THREE || !scene3) return;

    const zones = this.getZones();
    if (!zones.length) return;

    const h = canvas?.dimensions?.height || 1000;
    const groundZ = this._sceneComposer.groundZ ?? 1000;
    const overlayZ = groundZ + 3;

    const stairIconTex = this._ensureIconTexture('/icons/svg/thrust.svg', '_stairIconTexture', '_stairIconTextureLoading');
    const liftIconTex = this._ensureIconTexture('/icons/svg/ladder.svg', '_liftIconTexture', '_liftIconTextureLoading');
    this._zoneVisuals.clear();

    this._overlayGroup = new THREE.Group();
    this._overlayGroup.name = 'MapShineZoneOverlays';
    this._overlayGroup.renderOrder = 50000;
    this._overlayGroup.userData = { ...(this._overlayGroup.userData || {}), type: 'interactionOverlay' };

    for (const zone of zones) {
      if (!zone.points || zone.points.length < 3) continue;

      const color = new THREE.Color(zone.color || '#fe6c0b');

      // Filled polygon
      const shape = new THREE.Shape();
      const first = zone.points[0];
      shape.moveTo(first.x, h - first.y);
      for (let i = 1; i < zone.points.length; i++) {
        shape.lineTo(zone.points[i].x, h - zone.points[i].y);
      }
      shape.lineTo(first.x, h - first.y);

      const fillGeo = new THREE.ShapeGeometry(shape);
      const fillColor = color.clone().lerp(new THREE.Color(0xffffff), 0.25);
      const fillMat = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: 0.05,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const fillMesh = new THREE.Mesh(fillGeo, fillMat);
      fillMesh.position.z = overlayZ;
      fillMesh.renderOrder = 50000;
      fillMesh.frustumCulled = false;
      fillMesh.userData = { ...(fillMesh.userData || {}), type: 'interactionOverlay' };
      this._overlayGroup.add(fillMesh);

      // Outline
      const linePositions = [];
      for (const p of zone.points) {
        linePositions.push(p.x, h - p.y, overlayZ + 0.5);
      }
      // Close the loop
      linePositions.push(zone.points[0].x, h - zone.points[0].y, overlayZ + 0.5);

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: fillColor,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.28,
      });
      const lineMesh = new THREE.Line(lineGeo, lineMat);
      lineMesh.renderOrder = 50001;
      lineMesh.frustumCulled = false;
      lineMesh.userData = { ...(lineMesh.userData || {}), type: 'interactionOverlay' };
      this._overlayGroup.add(lineMesh);

      const center = this._polygonCentroid(zone.points);
      let iconMesh = null;
      const zoneType = String(zone.type || '').toLowerCase();
      const isStairLike = zoneType === ZONE_TYPES.STAIR.toLowerCase()
        || zoneType === ZONE_TYPES.STAIR_UP.toLowerCase()
        || zoneType === ZONE_TYPES.STAIR_DOWN.toLowerCase();
      const isLiftLike = zoneType === ZONE_TYPES.ELEVATOR.toLowerCase() || zoneType === 'lift';
      const iconTex = isLiftLike ? liftIconTex : (isStairLike ? stairIconTex : null);
      if (iconTex && center) {
        const gridSize = Number(canvas?.dimensions?.size ?? canvas?.scene?.grid?.size ?? 100);
        const size = Math.max(16, gridSize * 0.35);
        const iconGeo = new THREE.PlaneGeometry(size, size);
        const iconMat = new THREE.MeshBasicMaterial({
          map: iconTex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          opacity: 0.82,
          side: THREE.DoubleSide,
        });
        iconMesh = new THREE.Mesh(iconGeo, iconMat);
        iconMesh.position.set(center.x, h - center.y, overlayZ + 1.25);
        if (isStairLike && this._resolveZoneDirection(zone) === 'down') {
          iconMesh.scale.y *= -1;
        }
        iconMesh.renderOrder = 50002;
        iconMesh.frustumCulled = false;
        iconMesh.userData = {
          ...(iconMesh.userData || {}),
          type: 'interactionOverlay',
          zoneId: zone.id,
          zoneCenterFoundry: center,
        };
        this._overlayGroup.add(iconMesh);
      }

      if (zone.id) {
        this._zoneVisuals.set(String(zone.id), {
          center,
          fillMesh,
          lineMesh,
          iconMesh,
        });
      }
    }

    scene3.add(this._overlayGroup);
    this._sceneComposer?.requestRender?.();
    this._updateZoneVisualsVisibility();
  }

  _removeOverlays() {
    if (!this._overlayGroup) return;
    const scene3 = this._getThreeOverlayScene();

    // Dispose all children
    this._overlayGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });

    scene3?.remove?.(this._overlayGroup);
    this._overlayGroup = null;
    this._sceneComposer?.requestRender?.();
  }
}
