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

import { createLogger } from '../core/log.js';

const log = createLogger('ZoneManager');

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

    // Hook: detect token movement into zones
    this._updateTokenHookId = Hooks.on('updateToken', (tokenDoc, changes, options, userId) => {
      if (!('x' in changes || 'y' in changes)) return;
      this._onTokenPositionChanged(tokenDoc, changes, options, userId);
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
    log.info('ZoneManager initialized');
  }

  dispose() {
    this.cancelDrawing();

    if (this._updateTokenHookId !== null) {
      Hooks.off('updateToken', this._updateTokenHookId);
      this._updateTokenHookId = null;
    }
    if (this._updateSceneHookId !== null) {
      Hooks.off('updateScene', this._updateSceneHookId);
      this._updateSceneHookId = null;
    }

    this._removeOverlays();
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
    if (!scene || game.user?.isGM !== true) throw new Error('Cannot add zone: no scene or not GM');

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
    if (!scene || game.user?.isGM !== true) return;

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
    if (!scene || game.user?.isGM !== true) return;

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
    if (!THREE || !this._sceneComposer?.scene) return;

    const scene = this._sceneComposer.scene;
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
      scene.add(dot);
      this._previewDots.push(dot);
    }

    // Request a render frame to show the preview
    this._sceneComposer?.requestRender?.();
  }

  _removePreview() {
    const scene = this._sceneComposer?.scene;
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

    if (onFromLevel && onToLevel) {
      // Shared boundary: token elevation sits in both levels (e.g. Ground=[0,10],
      // First=[10,20], elevation=10). The token was most likely sent here by the
      // stair previously (to to.bottom). Reverse direction back to from.bottom,
      // unless the zone is one-way or stair-down.
      if (zone.oneWay || zone.type === ZONE_TYPES.STAIR_DOWN) {
        log.debug(
          `Stair zone "${zone.name}": token at shared boundary ${currentElev}, ` +
          `reverse blocked (oneWay=${zone.oneWay}, type=${zone.type})`
        );
        return;
      }
      targetElev = from.bottom;
    } else if (onFromLevel) {
      // Token is on the "from" level — move to "to" level
      targetElev = to.bottom;
    } else if (onToLevel && !zone.oneWay) {
      // Bidirectional: go back to "from" level
      if (zone.type === ZONE_TYPES.STAIR_DOWN) {
        // stairDown is one-direction down only — can't go back up
        log.debug(`Stair-down zone "${zone.name}": token on toLevel, reverse blocked`);
        return;
      }
      targetElev = from.bottom;
    } else if (onToLevel && zone.oneWay) {
      // One-way: token on destination level, can't reverse
      return;
    } else if (zone.type === ZONE_TYPES.STAIR_UP) {
      targetElev = Math.max(from.bottom, to.bottom);
    } else if (zone.type === ZONE_TYPES.STAIR_DOWN) {
      targetElev = Math.min(from.bottom, to.bottom);
    } else {
      // Default bidirectional: go to whichever level is further from current
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
    await doc.update({ elevation: targetElev });
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
    await doc.update({ elevation: targetElev });
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
    if (!THREE || !this._sceneComposer?.scene) return;

    const zones = this.getZones();
    if (!zones.length) return;

    const scene3 = this._sceneComposer.scene;
    const h = canvas?.dimensions?.height || 1000;
    const groundZ = this._sceneComposer.groundZ ?? 1000;
    const overlayZ = groundZ + 3;

    this._overlayGroup = new THREE.Group();
    this._overlayGroup.name = 'MapShineZoneOverlays';
    this._overlayGroup.renderOrder = 50000;

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
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.15,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const fillMesh = new THREE.Mesh(fillGeo, fillMat);
      fillMesh.position.z = overlayZ;
      fillMesh.renderOrder = 50000;
      fillMesh.frustumCulled = false;
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
        color,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
      });
      const lineMesh = new THREE.Line(lineGeo, lineMat);
      lineMesh.renderOrder = 50001;
      lineMesh.frustumCulled = false;
      this._overlayGroup.add(lineMesh);
    }

    scene3.add(this._overlayGroup);
    this._sceneComposer?.requestRender?.();
  }

  _removeOverlays() {
    if (!this._overlayGroup) return;
    const scene3 = this._sceneComposer?.scene;

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
